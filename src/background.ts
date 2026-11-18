/// <reference types="chrome" />

// Preserves captured requests per-tab so logs survive in-tab navigations
// (e.g. login → redirect, logout → redirect). Backed by chrome.storage.session
// so the data survives MV3 service-worker eviction; the in-memory map is just
// a write-through cache.

// NOTE: keep PreservedRequest in sync with ApiRequest in src/content.ts —
// the fields below are the subset that crosses the messaging boundary.
// (Bg-prefixed names exist because tsconfig uses module: "None", so top-level
// declarations share a global namespace with content.ts. Don't drop the prefix.)
interface BgWsMessage { dir: 'sent' | 'recv'; body: string; ts: number; }

interface PreservedRequest {
  id: number;
  url: string;
  method: string;
  kind: 'fetch' | 'xhr' | 'ws' | 'sse' | 'beacon' | 'nav';
  status: number | 'pending' | 'error' | 'closed' | 'sent';
  element?: unknown;
  ts: number;
  reqBody?: string | null;
  resBody?: string | null;
  reqHeaders?: Array<[string, string]> | null;
  resHeaders?: Array<[string, string]> | null;
  messages?: BgWsMessage[];
  ms?: number;
  pageUrl?: string;
  note?: string;
}

const BG_MAX_REQUESTS_PER_TAB = 1000;
const BG_MAX_WS_MESSAGES_PER_CONN = 500;

const STORAGE_PREFIX = 'ovTab_';
const storageKey = (tabId: number): string => `${STORAGE_PREFIX}${tabId}`;

// In-memory cache. Lost on SW eviction, then rebuilt lazily from storage.session.
const preservedByTab = new Map<number, Map<number, PreservedRequest>>();

async function getTabStore(tabId: number): Promise<Map<number, PreservedRequest>> {
  let store = preservedByTab.get(tabId);
  if (store) return store;
  store = new Map();
  preservedByTab.set(tabId, store);
  try {
    const key = storageKey(tabId);
    const result = await chrome.storage.session.get(key);
    const list = result[key] as PreservedRequest[] | undefined;
    if (Array.isArray(list)) {
      for (const r of list) {
        if (typeof r?.id === 'number') store.set(r.id, r);
      }
    }
  } catch {
    // storage.session unavailable — fall back to in-memory only for this SW lifetime.
  }
  return store;
}

function trimStore(store: Map<number, PreservedRequest>): void {
  if (store.size <= BG_MAX_REQUESTS_PER_TAB) return;
  const overflow = store.size - BG_MAX_REQUESTS_PER_TAB;
  const iter = store.keys();
  for (let i = 0; i < overflow; i++) {
    const k = iter.next().value;
    if (k === undefined) break;
    store.delete(k);
  }
}

async function persistTabStore(tabId: number, store: Map<number, PreservedRequest>): Promise<void> {
  try {
    await chrome.storage.session.set({ [storageKey(tabId)]: Array.from(store.values()) });
  } catch {
    // Quota exceeded or session storage unavailable. In-memory copy still serves
    // requests until the SW is evicted; nothing else we can do.
  }
}

async function handlePreserve(
  tabId: number,
  reqs: PreservedRequest[],
  wsDeltas: Record<string, BgWsMessage[]>,
): Promise<void> {
  const store = await getTabStore(tabId);

  for (const r of reqs) {
    if (typeof r?.id !== 'number') continue;
    store.set(r.id, r);
  }

  for (const [idStr, deltas] of Object.entries(wsDeltas)) {
    if (!Array.isArray(deltas) || !deltas.length) continue;
    const id = Number(idStr);
    const existing = store.get(id);
    if (!existing) continue; // delta for an unknown ws — drop (full record will arrive later)
    if (!existing.messages) existing.messages = [];
    existing.messages.push(...deltas);
    if (existing.messages.length > BG_MAX_WS_MESSAGES_PER_CONN) {
      existing.messages.splice(0, existing.messages.length - BG_MAX_WS_MESSAGES_PER_CONN);
    }
  }

  trimStore(store);
  await persistTabStore(tabId, store);
}

async function handleGetPreserved(tabId: number): Promise<PreservedRequest[]> {
  const store = await getTabStore(tabId);
  return Array.from(store.values());
}

async function handleClear(tabId: number): Promise<void> {
  preservedByTab.delete(tabId);
  try {
    await chrome.storage.session.remove(storageKey(tabId));
  } catch {
    // ignore — see persistTabStore
  }
}

// ── Site-map background scan ─────────────────────────────────────────────────
//
// Loads one page in an inactive tab so that tab's content script can capture the
// calls it really makes, then harvests the result and closes it. This is the only
// part of the site map that navigates anywhere, which is why it runs one page at
// a time and only when the user clicks "scan" on that page.

const SM_SCAN_LOAD_TIMEOUT_MS = 20_000;
const SM_SCAN_SETTLE_MS = 2_500;

// Normalized origin+pathname of the scan currently in flight. The scanned tab's
// content script asks whether it matches and, if so, suppresses its overlay.
// Keyed by URL rather than tab id because the content script runs at
// document_start — before chrome.tabs.create() has resolved with an id.
const smPendingScanUrls = new Set<string>();
let smScanInFlight = false;

function smNormUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}

function smWaitForLoad(tabId: number): Promise<void> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo): void => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const timer = setTimeout(finish, SM_SCAN_LOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(onUpdated);
    // The page may already have finished loading before the listener attached.
    chrome.tabs.get(tabId)
      .then(t => { if (t.status === 'complete') finish(); })
      .catch(() => finish());
  });
}

async function smHandleScan(url: string): Promise<PreservedRequest[]> {
  const norm = smNormUrl(url);
  if (!norm || smScanInFlight) return [];
  smScanInFlight = true;
  smPendingScanUrls.add(norm);

  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    if (typeof tabId !== 'number') return [];
    await smWaitForLoad(tabId);
    // Load-time XHRs fire after 'complete'; give them a moment to land.
    await new Promise(r => setTimeout(r, SM_SCAN_SETTLE_MS));
    // Harvest *before* the tab is removed — onRemoved wipes its store. The
    // page's own document load is not a call the page makes.
    const store = await getTabStore(tabId);
    return Array.from(store.values()).filter(r => r.kind !== 'nav');
  } catch {
    return [];
  } finally {
    smPendingScanUrls.delete(norm);
    smScanInFlight = false;
    if (typeof tabId === 'number') {
      preservedByTab.delete(tabId);
      try { await chrome.storage.session.remove(storageKey(tabId)); } catch { /* see persistTabStore */ }
      try { await chrome.tabs.remove(tabId); } catch { /* already closed */ }
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Asked before the overlay decides whether to build any UI, so it has to be
  // answered even for a frame we have no tab id for.
  if (msg?.action === 'sm-is-scan-tab') {
    sendResponse({ scan: smPendingScanUrls.has(smNormUrl(sender.url ?? '')) });
    return false;
  }

  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') {
    sendResponse({ ok: false });
    return false;
  }

  switch (msg?.action) {
    case 'ov-preserve': {
      const reqs = Array.isArray(msg.reqs) ? (msg.reqs as PreservedRequest[]) : [];
      const wsDeltas = (msg.wsDeltas && typeof msg.wsDeltas === 'object')
        ? (msg.wsDeltas as Record<string, BgWsMessage[]>)
        : {};
      handlePreserve(tabId, reqs, wsDeltas)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true; // async sendResponse
    }
    case 'ov-get-preserved': {
      handleGetPreserved(tabId)
        .then(reqs => sendResponse({ ok: true, reqs }))
        .catch(() => sendResponse({ ok: false, reqs: [] }));
      return true;
    }
    case 'ov-clear-preserved': {
      handleClear(tabId)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    case 'sm-scan': {
      const url = typeof msg.url === 'string' ? msg.url : '';
      smHandleScan(url)
        .then(reqs => sendResponse({ ok: true, reqs }))
        .catch(() => sendResponse({ ok: false, reqs: [] }));
      return true;
    }
    default:
      return false;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [rid, f] of bgNavFlights) if (f.tabId === tabId) bgNavFlights.delete(rid);
  preservedByTab.delete(tabId);
  chrome.storage.session.remove(storageKey(tabId)).catch(() => { /* see persistTabStore */ });
});

// ── Navigation capture (chrome.webRequest) ───────────────────────────────────
//
// The page hook only sees requests the page's own JS makes. A document load, a
// classic <form> submit and the redirects that follow go through the browser's
// navigation instead, so they are observed here and written straight into the
// tab's preserve store — the page that started a navigation is about to unload,
// and the next one restores the rows from the store. MV3 webRequest cannot read
// response bodies, so a row has URL, method, form body, headers, status, timing.
//
// Only navigations to or from an allowlisted host are recorded, matching the
// overlay, which is dormant everywhere else.

// Keep in sync with NAV_ID_BASE in src/content.ts. Row id = base + requestId *
// hops + hop: unique for the browser session, which is as long as
// storage.session (and so the preserve store) lives.
const BG_NAV_ID_BASE = 1e12;
const BG_NAV_MAX_HOPS = 32;
const BG_NAV_MAX_BODY = 256_000;
const BG_NAV_NOTE = "The browser loaded this document itself; extensions can't read a page's HTML response.";

interface BgNavFlight { tabId: number; base: number; hop: number; rec: PreservedRequest; }

// Keyed by webRequest's requestId, which stays the same across redirects.
const bgNavFlights = new Map<string, BgNavFlight>();
let bgNavFallbackSeq = 0;

let bgAllowedHosts: Promise<string[]> | null = null;

function bgGetAllowedHosts(): Promise<string[]> {
  bgAllowedHosts ??= chrome.storage.local.get('ovAllowedHosts')
    .then(r => (Array.isArray(r.ovAllowedHosts) ? r.ovAllowedHosts as string[] : []))
    .catch(() => []);
  return bgAllowedHosts;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.ovAllowedHosts) bgAllowedHosts = null;
});

// Same rule as hostAllowed in content.ts, applied to a URL or an origin.
function bgHostAllowed(hosts: string[], url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try { host = new URL(url).hostname; } catch { return false; }
  return !!host && hosts.some(h => h === host || host.endsWith('.' + h));
}

function bgNavBody(body: chrome.webRequest.WebRequestBody | null | undefined): string | null {
  if (!body) return null;
  if (body.error) return `[${body.error}]`;
  if (body.formData) {
    const params = new URLSearchParams();
    for (const [name, values] of Object.entries(body.formData)) {
      for (const v of values) params.append(name, String(v));
    }
    return params.toString().slice(0, BG_NAV_MAX_BODY);
  }
  if (body.raw?.length) {
    const decoder = new TextDecoder('utf-8', { fatal: false });
    return body.raw
      .map(part => (part.bytes ? decoder.decode(part.bytes) : part.file ? `[file ${part.file}]` : ''))
      .join('')
      .slice(0, BG_NAV_MAX_BODY) || null;
  }
  return null;
}

function bgHeaderPairs(headers: chrome.webRequest.HttpHeader[] | undefined): Array<[string, string]> | null {
  return headers?.length ? headers.map(h => [h.name, h.value ?? ''] as [string, string]) : null;
}

function bgNavRecord(f: BgNavFlight, url: string, method: string, ts: number, reqBody: string | null): PreservedRequest {
  return {
    id: f.base + f.hop, url, method: method.toUpperCase(), kind: 'nav', status: 'pending',
    element: null, ts: Math.round(ts), reqBody, pageUrl: url, note: BG_NAV_NOTE,
  };
}

// Store first, then tell the page: a page that loads in between restores the row
// from the store, and a live update is never older than what it restored.
async function bgNavSave(f: BgNavFlight): Promise<void> {
  const rec = { ...f.rec };
  const store = await getTabStore(f.tabId);
  store.set(rec.id, rec);
  trimStore(store);
  await persistTabStore(f.tabId, store);
  chrome.tabs.sendMessage(f.tabId, { action: 'ov-nav', value: rec }, { frameId: 0 })
    .catch(() => { /* no content script in the frame (yet, or ever) */ });
}

function bgNavFinish(f: BgNavFlight, ts: number, patch: Partial<PreservedRequest>): void {
  Object.assign(f.rec, patch, { ms: Math.max(0, Math.round(ts - f.rec.ts)) });
}

async function bgNavOnBeforeRequest(d: chrome.webRequest.WebRequestBodyDetails): Promise<void> {
  if (d.tabId < 0) return;
  // A prerendered page may never be shown; it would leave a phantom row.
  if ((d as { documentLifecycle?: string }).documentLifecycle === 'prerender') return;
  const reqBody = bgNavBody(d.requestBody);
  const f = bgNavFlights.get(d.requestId);
  if (f) {
    // The redirect hop was already opened in onBeforeRedirect; fill in what
    // the browser actually sent.
    if (f.rec.status === 'pending' && f.rec.url === d.url) {
      f.rec.method = d.method.toUpperCase();
      if (reqBody != null) f.rec.reqBody = reqBody;
      await bgNavSave(f);
    }
    return;
  }
  const hosts = await bgGetAllowedHosts();
  if (!bgHostAllowed(hosts, d.url) && !bgHostAllowed(hosts, d.initiator)) return;
  const n = Number(d.requestId);
  const seq = Number.isSafeInteger(n) && n >= 0 ? n : 1e9 + ++bgNavFallbackSeq;
  const flight: BgNavFlight = { tabId: d.tabId, base: BG_NAV_ID_BASE + seq * BG_NAV_MAX_HOPS, hop: 0, rec: null as unknown as PreservedRequest };
  flight.rec = bgNavRecord(flight, d.url, d.method, d.timeStamp, reqBody);
  bgNavFlights.set(d.requestId, flight);
  await bgNavSave(flight);
}

async function bgNavOnSendHeaders(d: chrome.webRequest.WebRequestHeadersDetails): Promise<void> {
  const f = bgNavFlights.get(d.requestId);
  if (!f) return;
  f.rec.reqHeaders = bgHeaderPairs(d.requestHeaders);
  await bgNavSave(f);
}

// 307/308 resend the same method and body; 303 (and, by long-standing browser
// behaviour, 301/302 after a POST) turn it into a GET without a body.
function bgRedirectMethod(status: number, method: string): string {
  if (status === 307 || status === 308) return method;
  if (status === 303 && method !== 'HEAD') return 'GET';
  if ((status === 301 || status === 302) && method === 'POST') return 'GET';
  return method;
}

async function bgNavOnBeforeRedirect(d: chrome.webRequest.WebRedirectionResponseDetails): Promise<void> {
  const f = bgNavFlights.get(d.requestId);
  if (!f) return;
  bgNavFinish(f, d.timeStamp, {
    status: d.statusCode,
    resHeaders: bgHeaderPairs(d.responseHeaders),
    note: `Redirected to ${d.redirectUrl}`,
  });
  await bgNavSave(f);
  if (f.hop + 1 >= BG_NAV_MAX_HOPS) { bgNavFlights.delete(d.requestId); return; }
  const prev = f.rec;
  const method = bgRedirectMethod(d.statusCode, prev.method);
  f.hop++;
  f.rec = bgNavRecord(f, d.redirectUrl, method, d.timeStamp, method === prev.method ? prev.reqBody ?? null : null);
  await bgNavSave(f);
}

async function bgNavOnCompleted(d: chrome.webRequest.WebResponseCacheDetails): Promise<void> {
  const f = bgNavFlights.get(d.requestId);
  if (!f) return;
  bgNavFlights.delete(d.requestId);
  bgNavFinish(f, d.timeStamp, { status: d.statusCode, resHeaders: bgHeaderPairs(d.responseHeaders) });
  await bgNavSave(f);
}

async function bgNavOnError(d: chrome.webRequest.WebResponseErrorDetails): Promise<void> {
  const f = bgNavFlights.get(d.requestId);
  if (!f) return;
  bgNavFlights.delete(d.requestId);
  bgNavFinish(f, d.timeStamp, { status: 'error', note: d.error });
  await bgNavSave(f);
}

// Listeners are async (the allowlist read), so run every event through one
// queue: onSendHeaders must not overtake the onBeforeRequest that opened the row.
let bgNavQueue: Promise<void> = Promise.resolve();

function bgNavEnqueue<T>(handler: (d: T) => Promise<void>): (d: T) => void {
  return d => { bgNavQueue = bgNavQueue.then(() => handler(d)).catch(() => { /* keep the queue alive */ }); };
}

if (chrome.webRequest) {
  const filter: chrome.webRequest.RequestFilter = { urls: ['<all_urls>'], types: ['main_frame'] };
  chrome.webRequest.onBeforeRequest.addListener(bgNavEnqueue(bgNavOnBeforeRequest), filter, ['requestBody']);
  chrome.webRequest.onSendHeaders.addListener(bgNavEnqueue(bgNavOnSendHeaders), filter, ['requestHeaders']);
  chrome.webRequest.onBeforeRedirect.addListener(bgNavEnqueue(bgNavOnBeforeRedirect), filter, ['responseHeaders']);
  chrome.webRequest.onCompleted.addListener(bgNavEnqueue(bgNavOnCompleted), filter, ['responseHeaders']);
  chrome.webRequest.onErrorOccurred.addListener(bgNavEnqueue(bgNavOnError), filter);
}
