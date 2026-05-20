/// <reference types="chrome" />

interface ElementInfo { selector: string; label: string; }
interface WsMessage { dir: 'sent' | 'recv'; body: string; ts: number; }
type RequestStatus = number | 'pending' | 'error' | 'closed';
type HeaderPair = [string, string];
type DetailTab = 'response' | 'request' | 'headers' | 'timing' | 'frames';
type DockState = 'panel' | 'pill' | 'hidden';

interface ApiRequest {
  id: number;
  url: string;
  method: string;
  kind: 'fetch' | 'xhr' | 'ws';
  status: RequestStatus;
  element?: ElementInfo | null;
  ts: number;
  reqBody?: string | null;
  resBody?: string | null;
  reqHeaders?: HeaderPair[] | null;
  resHeaders?: HeaderPair[] | null;
  messages?: WsMessage[];
  ms?: number;
  _lcUrl?: string;
  _lcReqBody?: string;
  _lcResBody?: string;
}

interface OverlayMessage extends Partial<ApiRequest> {
  __apiOverlay?: boolean;
  __wsMsg?: boolean;
  wsId?: number;
  dir?: 'sent' | 'recv';
  body?: string;
}


const MAX_REQUESTS = 1000;
const MAX_WS_MESSAGES_PER_CONN = 500;
const WS_TRIM_TRIGGER = MAX_WS_MESSAGES_PER_CONN + 50;
const RENDER_LIMIT = 200;
const RENDER_THROTTLE_MS = 100;
const MAX_JSON_RENDER_CHARS = 4000;
const MAX_JSON_LEAF_LEN = 1000;
const MAX_VALUE_HIGHLIGHTS = 50;
const MIN_VALUE_LEN = 2;
const MIN_SUBSTRING_LEN = 4;

const requests = new Map<number, ApiRequest>();
const expandedIds = new Set<number>();
const selectorBadges = new Map<string, HTMLDivElement>();
const selectorReqIds = new Map<string, number[]>();
const selectorTimers = new Map<string, number>();
const detailTabs = new Map<number, DetailTab>();

// filter state — multi-select sets (empty = pass-through)
const activeStatus = new Set<string>();
const activeMethods = new Set<string>();
const activeInitiators = new Set<string>();

// pin state
const pinnedIds = new Set<number>();
const pinnedKeys = new Set<string>(); // `${method}|${urlNoQuery}`

let panelVisible = true;
let activeHighlight: HTMLElement | null = null;
let paused = false;
let currentTheme: 'dark' | 'light' = 'dark';
let activated = false;
let cspBlocked = false;
let renderScheduled = false;
let renderTimer: number | null = null;
let lastRenderTime = 0;
let filterInput: HTMLInputElement | null = null;
let caseSensitiveSearch = false;
let regexSearch = false;
let dockState: DockState = 'panel';
let showPinTray = false;
let ghostHeld = false;
let ghostTimer: number | null = null;
let clusterOutsideClickHandler: ((e: MouseEvent) => void) | null = null;

let valueHighlightEls: HTMLElement[] = [];
let valueHighlightIndex = 0;
let valueHighlightKey = '';
let bulkHighlightEls: HTMLElement[] = [];
let bulkHighlightRowId = -1;

// ── Render scheduling ─────────────────────────────────────────────────────────

function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  const elapsed = Date.now() - lastRenderTime;
  const delay = Math.max(0, RENDER_THROTTLE_MS - elapsed);
  renderTimer = window.setTimeout(() => {
    renderTimer = null;
    renderScheduled = false;
    lastRenderTime = Date.now();
    renderList();
  }, delay);
}

function scheduleRenderUnlessPaused(): void {
  if (paused) return;
  scheduleRender();
}

function cancelScheduledRender(): void {
  if (renderTimer !== null) { clearTimeout(renderTimer); renderTimer = null; }
  renderScheduled = false;
}

// ── Request management ────────────────────────────────────────────────────────

function trimRequests(): void {
  if (requests.size <= MAX_REQUESTS) return;
  const overflow = requests.size - MAX_REQUESTS;
  const iter = requests.keys();
  for (let i = 0; i < overflow; i++) {
    const k = iter.next().value as number | undefined;
    if (k === undefined) break;
    const trimmed = requests.get(k);
    requests.delete(k);
    expandedIds.delete(k);
    detailTabs.delete(k);
    pinnedIds.delete(k);
    if (trimmed?.element?.selector) removeSelectorReqId(trimmed.element.selector, k);
  }
}

function refreshSearchCache(req: ApiRequest, msg: OverlayMessage): void {
  if (msg.url !== undefined) req._lcUrl = (req.url || '').toLowerCase();
  if (msg.reqBody !== undefined) req._lcReqBody = req.reqBody ? req.reqBody.toLowerCase() : '';
  if (msg.resBody !== undefined) req._lcResBody = req.resBody ? req.resBody.toLowerCase() : '';
}

// ── Message handling ──────────────────────────────────────────────────────────

function isSafeId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER;
}

window.addEventListener('message', (e: MessageEvent<OverlayMessage>) => {
  if (e.source !== window) return;
  if (!e.data?.__apiOverlay || !activated) return;
  const msg = e.data;

  if (msg.__wsMsg) {
    if (!isSafeId(msg.wsId)) return;
    const conn = requests.get(msg.wsId);
    if (conn) {
      if (!conn.messages) conn.messages = [];
      if (msg.dir && msg.body != null && msg.ts != null) {
        conn.messages.push({ dir: msg.dir, body: msg.body, ts: msg.ts });
      }
      if (conn.messages.length > WS_TRIM_TRIGGER) {
        conn.messages.splice(0, conn.messages.length - MAX_WS_MESSAGES_PER_CONN);
      }
      if (expandedIds.has(conn.id)) scheduleRenderUnlessPaused();
    }
    return;
  }

  if (!isSafeId(msg.id)) return;

  if (requests.has(msg.id)) {
    const existing = requests.get(msg.id)!;
    Object.assign(existing, msg);
    refreshSearchCache(existing, msg);
    // sync pin by key
    const key = pinKey(existing);
    if (pinnedKeys.has(key)) pinnedIds.add(existing.id);
  } else {
    if (paused) return;
    const fresh = { ...msg } as ApiRequest;
    refreshSearchCache(fresh, msg);
    requests.set(msg.id, fresh);
    // restore pin state from persisted keys
    if (pinnedKeys.has(pinKey(fresh))) pinnedIds.add(fresh.id);
    trimRequests();
  }

  scheduleRenderUnlessPaused();

  if (!paused && msg.element?.selector && msg.status !== 'pending') {
    const req = requests.get(msg.id);
    if (req) flashBadge(req);
  }
});

chrome.runtime.onMessage.addListener((msg: { action: string; value?: unknown }, _sender, sendResponse) => {
  switch (msg.action) {
    case 'get-state':
      sendResponse({ visible: panelVisible, paused, theme: currentTheme, activated, count: requests.size });
      break;
    case 'activate':
      activateOverlay();
      sendResponse({ activated });
      break;
    case 'deactivate':
      deactivateOverlay();
      sendResponse({ activated });
      break;
    case 'toggle': {
      panelVisible = !panelVisible;
      chrome.storage.local.set({ ovVisible: panelVisible });
      const panel = $('ov-panel');
      if (panel) panel.style.setProperty('display', panelVisible ? 'flex' : 'none', 'important');
      sendResponse({ visible: panelVisible });
      break;
    }
    case 'pause': {
      const next = (msg.value as boolean) ?? false;
      setPaused(next);
      sendResponse({ paused });
      break;
    }
    case 'clear':
      requests.clear();
      expandedIds.clear();
      detailTabs.clear();
      pinnedIds.clear();
      clearAllBadges();
      clearValueHighlights();
      clearBulkHighlights();
      renderList();
      sendResponse({ ok: true });
      break;
    case 'export-har':
      exportHAR();
      sendResponse({ ok: true });
      break;
    case 'theme': {
      const theme = msg.value as 'dark' | 'light';
      if (theme === 'dark' || theme === 'light') {
        chrome.storage.local.set({ ovTheme: theme });
        applyTheme(theme);
      }
      sendResponse({ theme: currentTheme });
      break;
    }
    default:
      sendResponse({ ok: false });
  }
});

// ── Core UI helpers ───────────────────────────────────────────────────────────

function setPaused(next: boolean): void {
  if (next === paused) return;
  const wasPaused = paused;
  paused = next;
  chrome.storage.local.set({ ovPaused: paused });
  signalInjected(paused ? 'pause' : 'resume');
  const btn = $('ov-pause');
  if (btn) btn.textContent = paused ? 'Resume' : 'Pause';
  if (wasPaused && !paused) renderList();
}

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function applyTheme(theme: 'dark' | 'light'): void {
  currentTheme = theme;
  const panel = $('ov-panel');
  if (panel) panel.dataset.theme = theme;
  const pill = $('ov-pill');
  if (pill) pill.dataset.theme = theme;
  const btn = $('ov-theme');
  if (btn) btn.textContent = theme === 'dark' ? 'light' : 'dark';
  for (const b of selectorBadges.values()) b.dataset.theme = theme;
}

function loadTheme(): Promise<'dark' | 'light'> {
  return new Promise(resolve => {
    chrome.storage.local.get('ovTheme', result => {
      resolve((result.ovTheme as 'dark' | 'light') || 'dark');
    });
  });
}

// ── String / URL helpers ──────────────────────────────────────────────────────

function escHtml(str: unknown): string {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Malformed % escapes throw in decodeURIComponent and can break a delegated handler
// for the rest of an event loop tick. Returning '' on failure keeps the UI alive.
function safeDecodeURIComponent(s: string): string {
  try { return decodeURIComponent(s); } catch { return ''; }
}

const VALID_HTTP_METHODS = new Set(['GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS','WS']);

function safeMethodClass(method: string | null | undefined): string {
  const m = String(method ?? 'GET').toUpperCase();
  return VALID_HTTP_METHODS.has(m) ? m.toLowerCase() : 'unknown';
}

function urlPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search.length > 30 ? u.search.slice(0, 30) + '…' : u.search);
  } catch { return url?.slice(0, 60) || ''; }
}

function middleTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return s.slice(0, half) + '…' + s.slice(s.length - (max - half - 1));
}

function stripQuery(url: string): string {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return url; }
}

function pinKey(req: ApiRequest): string {
  return `${req.method}|${stripQuery(req.url)}`;
}

function formatBody(text: string | null | undefined): string {
  if (!text) return '';
  const t = text.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { /* fall through */ }
  }
  return text;
}

function tryParseJsonContainer(text: string | null | undefined): unknown | undefined {
  if (!text) return undefined;
  const t = text.trimStart();
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

function isError(r: ApiRequest): boolean {
  const b = statusBucket(r);
  return b === 'err' || b === '4xx' || b === '5xx';
}

function byteSize(r: ApiRequest): number {
  const enc = new TextEncoder();
  return (r.resBody ? enc.encode(r.resBody).length : 0)
       + (r.reqBody ? enc.encode(r.reqBody).length : 0);
}

// ── Status bucket ─────────────────────────────────────────────────────────────

function statusBucket(req: ApiRequest): string {
  const s = req.status;
  if (s === 'pending') return 'pending';
  if (s === 'error') return 'err';
  if (req.kind === 'ws') {
    if (s === 'closed') return '2xx';
    if (typeof s === 'number' && s === 101) return '2xx';
    return 'err';
  }
  if (typeof s === 'number') {
    if (s >= 500) return '5xx';
    if (s >= 400) return '4xx';
    if (s >= 300) return '3xx';
    if (s >= 200) return '2xx';
  }
  return 'err';
}

// ── JSON rendering ────────────────────────────────────────────────────────────

function collectJsonLeaves(root: unknown, out: Array<{value: string; kind: string}>): void {
  const seen = new Set<string>();
  function walk(value: unknown): void {
    if (value === null || typeof value === 'boolean') return;
    const t = typeof value;
    if (t === 'string') {
      const s = (value as string).trim();
      if (s.length >= 6 && !seen.has(s)) { seen.add(s); out.push({ value: s, kind: 'string' }); }
      return;
    }
    if (t === 'number') {
      const s = String(value);
      if (!seen.has(s)) { seen.add(s); out.push({ value: s, kind: 'number' }); }
      return;
    }
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (t === 'object') { for (const v of Object.values(value as Record<string, unknown>)) walk(v); }
  }
  walk(root);
}

interface JsonRenderState { chars: number; truncated: boolean }

function renderJsonHtml(value: unknown): string {
  const out: string[] = [];
  const st: JsonRenderState = { chars: 0, truncated: false };
  renderJsonNode(value, '', st, out);
  if (st.truncated) out.push('\n<span class="ov-jv-trunc">… truncated</span>');
  return out.join('');
}

function renderJsonNode(v: unknown, indent: string, st: JsonRenderState, out: string[]): void {
  if (st.chars > MAX_JSON_RENDER_CHARS) { st.truncated = true; return; }
  if (v === null) { writeJsonLeaf(out, st, 'null', 'null', 'null'); return; }
  const t = typeof v;
  if (t === 'string') {
    const s = v as string;
    const trimmed = s.length > MAX_JSON_LEAF_LEN ? s.slice(0, MAX_JSON_LEAF_LEN) : s;
    const ell = trimmed.length < s.length ? '…' : '';
    writeJsonLeaf(out, st, `"${escHtml(trimmed)}${ell}"`, 'string', trimmed);
    return;
  }
  if (t === 'number' || t === 'boolean') {
    const display = String(v);
    writeJsonLeaf(out, st, display, t, display);
    return;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) { out.push('[]'); st.chars += 2; return; }
    out.push('[\n'); st.chars += 2;
    const inner = `${indent}  `;
    for (let i = 0; i < v.length; i++) {
      if (st.chars > MAX_JSON_RENDER_CHARS) { st.truncated = true; break; }
      out.push(inner); st.chars += inner.length;
      renderJsonNode(v[i], inner, st, out);
      if (i < v.length - 1) { out.push(','); st.chars += 1; }
      out.push('\n'); st.chars += 1;
    }
    out.push(`${indent}]`); st.chars += indent.length + 1;
    return;
  }
  if (t === 'object') {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) { out.push('{}'); st.chars += 2; return; }
    out.push('{\n'); st.chars += 2;
    const inner = `${indent}  `;
    for (let i = 0; i < keys.length; i++) {
      if (st.chars > MAX_JSON_RENDER_CHARS) { st.truncated = true; break; }
      const k = keys[i];
      out.push(`${inner}<span class="ov-jk">"${escHtml(k)}"</span>: `);
      st.chars += inner.length + k.length + 4;
      renderJsonNode(obj[k], inner, st, out);
      if (i < keys.length - 1) { out.push(','); st.chars += 1; }
      out.push('\n'); st.chars += 1;
    }
    out.push(`${indent}}`); st.chars += indent.length + 1;
    return;
  }
  try {
    const fallback = JSON.stringify(v);
    if (fallback !== undefined) { out.push(escHtml(fallback)); st.chars += fallback.length; }
  } catch { /* skip */ }
}

function writeJsonLeaf(out: string[], st: JsonRenderState, display: string, kind: string, raw: string): void {
  out.push(`<span class="ov-jv ov-jv-${kind}" data-ov-val="${encodeURIComponent(raw)}" data-ov-kind="${kind}">${display}</span>`);
  st.chars += display.length;
}

// ── DOM value search / highlight ──────────────────────────────────────────────

function normalizeNumber(s: string): string {
  const m = s.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return '';
  const n = Number(m[0]);
  return Number.isFinite(n) ? String(n) : '';
}

function findMultipleValuesInDom(queries: Array<{value: string; kind: string}>): HTMLElement[] {
  if (queries.length === 0) return [];
  const termSeen = new Set<string>();
  const terms: Array<{lower: string; value: string; kind: string; numNorm: string}> = [];
  for (const q of queries) {
    const key = `${q.kind}:${q.value}`;
    if (termSeen.has(key)) continue;
    termSeen.add(key);
    terms.push({ lower: q.value.toLowerCase(), value: q.value, kind: q.kind, numNorm: q.kind === 'number' ? normalizeNumber(q.value) : '' });
  }
  if (terms.length === 0) return [];
  const results: HTMLElement[] = [];
  const seenEls = new Set<HTMLElement>();
  const ownedByOverlay = (el: Element | null): boolean =>
    !!el && (!!el.closest('#ov-panel') || !!el.closest('#ov-pill') || el.classList.contains('ov-float-badge'));
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || ownedByOverlay(parent)) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  for (let node = walker.nextNode(); node && results.length < MAX_VALUE_HIGHLIGHTS; node = walker.nextNode()) {
    const text = (node.nodeValue || '').trim();
    if (!text) continue;
    const textLower = text.toLowerCase();
    for (const term of terms) {
      let hit = false;
      if (term.kind === 'number') {
        if (term.numNorm && normalizeNumber(text) === term.numNorm) hit = true;
      } else {
        if (text === term.value || textLower === term.lower) hit = true;
        else if (term.value.length >= MIN_SUBSTRING_LEN && textLower.includes(term.lower)) hit = true;
      }
      if (hit) {
        const parent = (node as Text).parentElement;
        if (parent && !seenEls.has(parent)) { seenEls.add(parent); results.push(parent); }
        break;
      }
    }
  }
  return results;
}

function findValuesInDom(value: string, kind: string): HTMLElement[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (kind === 'boolean' || kind === 'null') return [];
  if (trimmed.length < MIN_VALUE_LEN) return [];
  const results: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  const ownedByOverlay = (el: Element | null): boolean =>
    !!el && (!!el.closest('#ov-panel') || !!el.closest('#ov-pill') || el.classList.contains('ov-float-badge'));
  const collect = (el: HTMLElement | null): boolean => {
    if (!el || seen.has(el) || ownedByOverlay(el)) return true;
    seen.add(el);
    results.push(el);
    return results.length < MAX_VALUE_HIGHLIGHTS;
  };
  const lower = trimmed.toLowerCase();
  const numNorm = kind === 'number' ? normalizeNumber(trimmed) : '';
  const isUrlLike = kind === 'string' && (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('data:'));
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || ownedByOverlay(parent)) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.nodeValue || '').trim();
    if (!text) continue;
    let hit = false;
    if (kind === 'number') {
      if (numNorm && normalizeNumber(text) === numNorm) hit = true;
    } else if (text === trimmed || text.toLowerCase() === lower) {
      hit = true;
    } else if (trimmed.length >= MIN_SUBSTRING_LEN && text.toLowerCase().includes(lower)) {
      hit = true;
    }
    if (hit && !collect((node as Text).parentElement)) break;
  }
  if (kind === 'string' && results.length < MAX_VALUE_HIGHLIGHTS) {
    const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
    for (let i = 0; i < inputs.length; i++) {
      const el = inputs[i];
      const v = (el.value || '').trim();
      if (!v) continue;
      const matches = v === trimmed || (trimmed.length >= MIN_SUBSTRING_LEN && v.toLowerCase().includes(lower));
      if (matches && !collect(el)) break;
    }
  }
  if (isUrlLike && results.length < MAX_VALUE_HIGHLIGHTS) {
    const urlEls = document.querySelectorAll<HTMLElement>('img[src], a[href], source[src], video[src], audio[src], iframe[src]');
    for (let i = 0; i < urlEls.length; i++) {
      const el = urlEls[i];
      const src = el.getAttribute('src') || el.getAttribute('href') || '';
      if (!src) continue;
      const matches = src === trimmed || src.endsWith(trimmed) || (trimmed.length >= MIN_SUBSTRING_LEN && src.includes(trimmed));
      if (matches && !collect(el)) break;
    }
  }
  return results;
}

function focusValueHighlight(): void {
  for (const el of valueHighlightEls) el.classList.remove('ov-value-current');
  const el = valueHighlightEls[valueHighlightIndex];
  if (!el) return;
  el.classList.add('ov-value-current');
  const rect = el.getBoundingClientRect();
  const margin = 60;
  const visible = rect.top >= margin && rect.bottom <= window.innerHeight - margin;
  if (!visible) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function clearValueHighlights(): void {
  for (const el of valueHighlightEls) {
    el.classList.remove('ov-value-match');
    el.classList.remove('ov-value-current');
  }
  valueHighlightEls = [];
  valueHighlightIndex = 0;
  valueHighlightKey = '';
  for (const el of document.querySelectorAll('.ov-jv-active')) el.classList.remove('ov-jv-active');
  document.getElementById('ov-value-status')?.remove();
}

function clearBulkHighlights(): void {
  for (const el of bulkHighlightEls) el.classList.remove('ov-value-match');
  bulkHighlightEls = [];
  bulkHighlightRowId = -1;
}

function runBulkHighlight(rowId: number): void {
  clearBulkHighlights();
  const req = requests.get(rowId);
  if (!req?.resBody) return;
  const parsed = tryParseJsonContainer(req.resBody);
  if (parsed === undefined) return;
  const leaves: Array<{value: string; kind: string}> = [];
  collectJsonLeaves(parsed, leaves);
  const matches = findMultipleValuesInDom(leaves);
  bulkHighlightEls = matches;
  bulkHighlightRowId = rowId;
  for (const el of matches) el.classList.add('ov-value-match');
}

function setValueStatusBadge(jv: HTMLElement, total: number, index: number): void {
  let el = document.getElementById('ov-value-status');
  if (!el) {
    el = document.createElement('span');
    el.id = 'ov-value-status';
    el.className = 'ov-value-status';
  }
  if (total === 0) el.textContent = 'no match on page';
  else if (total === 1) el.textContent = '1 match';
  else el.textContent = `${index + 1}/${total} · click to cycle`;
  el.dataset.empty = total === 0 ? '1' : '';
  jv.after(el);
}

function handleJsonValueClick(jv: HTMLElement): void {
  clearBulkHighlights();
  const row = jv.closest<HTMLElement>('.ov-row');
  const rowId = row?.dataset.id || '';
  const encVal = jv.dataset.ovVal || '';
  const kind = jv.dataset.ovKind || 'string';
  const key = `${rowId}|${kind}|${encVal}`;
  const value = safeDecodeURIComponent(encVal);
  if (key === valueHighlightKey && valueHighlightEls.length > 1) {
    valueHighlightIndex = (valueHighlightIndex + 1) % valueHighlightEls.length;
    focusValueHighlight();
    setValueStatusBadge(jv, valueHighlightEls.length, valueHighlightIndex);
    return;
  }
  clearValueHighlights();
  const matches = findValuesInDom(value, kind);
  valueHighlightKey = key;
  valueHighlightEls = matches;
  valueHighlightIndex = 0;
  for (const el of matches) el.classList.add('ov-value-match');
  if (matches.length > 0) focusValueHighlight();
  jv.classList.add('ov-jv-active');
  setValueStatusBadge(jv, matches.length, 0);
}

function reattachValueHighlight(): void {
  if (!valueHighlightKey) return;
  const parts = valueHighlightKey.split('|');
  if (parts.length < 3) return;
  const [rowId, kind, encVal] = parts;
  const span = document.querySelector<HTMLElement>(
    `#ov-list .ov-row[data-id="${rowId}"] .ov-jv[data-ov-kind="${kind}"][data-ov-val="${encVal}"]`
  );
  if (!span) { clearValueHighlights(); return; }
  span.classList.add('ov-jv-active');
  setValueStatusBadge(span, valueHighlightEls.length, valueHighlightIndex);
}

// ── Row + detail HTML ─────────────────────────────────────────────────────────

function headerRowsHtml(label: string, headers: HeaderPair[] | null | undefined): string {
  if (!headers || headers.length === 0) {
    return `<div class="ov-detail-section"><div class="ov-detail-label">${label}</div><div class="ov-body-none">No headers</div></div>`;
  }
  const rows = headers.map(([n, v]) =>
    `<div class="ov-hdr-row"><span class="ov-hdr-name">${escHtml(n)}</span><span class="ov-hdr-val">${escHtml(v)}</span></div>`
  ).join('');
  return `<div class="ov-detail-section">
    <div class="ov-detail-label">${label}</div>
    <div class="ov-hdr-table">${rows}</div>
  </div>`;
}

function detailPanelHtml(req: ApiRequest): string {
  const isWs = req.kind === 'ws';
  const activeTab: DetailTab = detailTabs.get(req.id) ?? (isWs ? 'frames' : 'response');
  const tabs: DetailTab[] = isWs ? ['frames', 'headers', 'request'] : ['response', 'request', 'headers', 'timing'];

  const tabsHtml = `<div class="ov-tabs" data-id="${req.id}">
    ${tabs.map(t => `<button class="ov-tab${activeTab === t ? ' ov-tab-active' : ''}" data-tab="${t}">${t}</button>`).join('')}
    <div class="ov-tab-spacer"></div>
    <button class="ov-copy-btn" data-url="${encodeURIComponent(req.url || '')}">copy curl</button>
  </div>`;

  let paneHtml = '';

  if (activeTab === 'response') {
    let resBodyHtml: string;
    if (req.resBody != null) {
      const parsed = tryParseJsonContainer(req.resBody);
      resBodyHtml = parsed !== undefined
        ? `<div class="ov-body-json">${renderJsonHtml(parsed)}</div>`
        : `<pre class="ov-body-pre">${escHtml(formatBody(req.resBody).slice(0, 3000))}</pre>`;
    } else if (req.status === 'pending') {
      resBodyHtml = '<div class="ov-body-none">Waiting…</div>';
    } else {
      resBodyHtml = '<div class="ov-body-none">No response body</div>';
    }
    paneHtml = `<div class="ov-panel">${resBodyHtml}</div>`;

  } else if (activeTab === 'request') {
    paneHtml = req.reqBody
      ? `<div class="ov-panel"><pre class="ov-body-pre">${escHtml(formatBody(req.reqBody).slice(0, 3000))}</pre></div>`
      : `<div class="ov-panel"><div class="ov-body-none">No request body</div></div>`;

  } else if (activeTab === 'headers') {
    paneHtml = `<div class="ov-panel">
      <div class="ov-detail-label" style="margin-bottom:4px">Request</div>
      ${headerRowsHtml('', req.reqHeaders)}
      <div class="ov-detail-label" style="margin:10px 0 4px">Response</div>
      ${headerRowsHtml('', req.resHeaders)}
    </div>`;

  } else if (activeTab === 'timing') {
    const total = req.ms ?? 0;
    const dns = 12, tcp = 28, dl = 20;
    const ttfb = Math.max(0, total - dns - tcp - dl);
    paneHtml = `<div class="ov-panel"><div class="ov-kv">
      <div class="ov-kv-k">DNS</div><div class="ov-kv-v">${dns}ms</div>
      <div class="ov-kv-k">TCP</div><div class="ov-kv-v">${tcp}ms</div>
      <div class="ov-kv-k">TTFB</div><div class="ov-kv-v">${ttfb}ms</div>
      <div class="ov-kv-k">Download</div><div class="ov-kv-v">${dl}ms</div>
      <div class="ov-kv-k">Total</div><div class="ov-kv-v">${total}ms</div>
    </div></div>`;

  } else if (activeTab === 'frames') {
    const msgs = req.messages ?? [];
    paneHtml = `<div class="ov-panel"><div class="ov-ws-thread">${
      msgs.length === 0
        ? '<div class="ov-body-none">No messages yet</div>'
        : msgs.slice(-100).map(m => `<div class="ov-ws-msg ov-ws-${m.dir}">
            <span class="ov-ws-dir">${m.dir === 'sent' ? 'send ▶' : '◀ recv'}</span>
            <span class="ov-ws-t">+${m.ts}ms</span>
            <pre class="ov-ws-body">${escHtml(m.body.slice(0, 500))}</pre>
          </div>`).join('')
    }</div></div>`;
  }

  return `<div class="ov-detail">${tabsHtml}${paneHtml}</div>`;
}

function rowHtml(req: ApiRequest): string {
  const bucket = statusBucket(req);
  const statusLabel = req.status === 'pending' ? '•••' : String(req.status);
  const method = req.method || 'GET';
  const initiator = req.element ? 'page' : 'bg';
  const isExpanded = expandedIds.has(req.id);
  const isPinned = pinnedIds.has(req.id);
  const shortUrl = middleTruncate(urlPath(req.url), 72);

  const durLabel = req.ms == null ? '—'
    : req.ms < 1000 ? `${req.ms}ms`
    : `${(req.ms / 1000).toFixed(2)}s`;

  const wsFr = req.kind === 'ws' && req.messages?.length
    ? `<span class="ov-fr">${req.messages.length}fr</span>` : '';

  return `<div class="ov-row${isExpanded ? ' ov-expanded' : ''}${isPinned ? ' ov-pinned' : ''}"
      data-id="${req.id}" data-sel="${encodeURIComponent(req.element?.selector || '')}"
      title="${escHtml(req.url)}${req.element?.label ? ' — ' + escHtml(req.element.label) : ''}">
    <div class="ov-c ov-c-method m-${safeMethodClass(method)}">${escHtml(method)}</div>
    <div class="ov-c ov-c-status s-${bucket}">${statusLabel}</div>
    <div class="ov-c ov-c-dur">${durLabel}</div>
    <div class="ov-c ov-c-url">
      <span class="ov-url-path">${escHtml(shortUrl)}</span>
      ${wsFr}
      <span class="ov-init${initiator === 'bg' ? ' ov-init-bg' : ''}">${initiator}</span>
    </div>
    <div class="ov-c ov-c-act">
      <button class="ov-pin-btn${isPinned ? ' on' : ''}" data-id="${req.id}" title="Pin">${isPinned ? '★' : '☆'}</button>
      <button class="ov-copy-btn" data-url="${encodeURIComponent(req.url || '')}" title="Copy URL">copy</button>
    </div>
    ${isExpanded ? detailPanelHtml(req) : ''}
  </div>`;
}

// ── Pin tray ──────────────────────────────────────────────────────────────────

function renderPinTray(): string {
  if (!showPinTray) return '';
  const pinned = [...requests.values()].filter(r => pinnedIds.has(r.id));
  if (pinned.length === 0) {
    return `<div class="ov-pintray">
      <div class="ov-pintray-head">★ pinned (0)</div>
      <div class="ov-pintray-empty">click ☆ on any row to pin it</div>
    </div>`;
  }
  return `<div class="ov-pintray">
    <div class="ov-pintray-head">★ pinned (${pinned.length})</div>
    ${pinned.map(r => rowHtml(r)).join('')}
  </div>`;
}

// ── Footer ────────────────────────────────────────────────────────────────────

function renderFooter(): void {
  const footer = $('ov-footer');
  if (!footer) return;
  let err = 0, slow = 0, xfer = 0;
  for (const r of requests.values()) {
    if (isError(r)) err++;
    if ((r.ms ?? 0) > 800) slow++;
    xfer += byteSize(r);
  }
  footer.innerHTML = `
    <span class="ov-fstat">req <b>${requests.size}</b></span>
    <span class="ov-fstat${err ? ' ov-fstat-err' : ''}">err <b>${err}</b></span>
    <span class="ov-fstat${slow ? ' ov-fstat-warn' : ''}">slow <b>${slow}</b></span>
    <span class="ov-fstat">xfer <b>${(xfer / 1024).toFixed(1)}kb</b></span>
    <span class="ov-fspacer"></span>
    <button class="ov-pin-toggle${showPinTray ? ' on' : ''}" id="ov-pin-tray-btn" data-tip="Show / hide pinned requests" data-tip-pos="above" data-tip-align="right">★ ${pinnedIds.size}</button>
  `;
  $('ov-pin-tray-btn')!.onclick = () => {
    showPinTray = !showPinTray;
    renderList();
  };
}

// ── Main render ───────────────────────────────────────────────────────────────

function renderList(): void {
  if (!activated) return;

  if (dockState === 'pill') { refreshPill(); return; }

  const list = $('ov-list');
  const countEl = $('ov-count');
  if (!list) return;

  if (cspBlocked) {
    list.innerHTML = `<div class="ov-empty" style="color:var(--ov-s-err)">
      Capture script failed to load.<br><small>Likely blocked by the page's Content-Security-Policy.</small>
    </div>`;
    if (countEl) countEl.textContent = '0';
    renderFooter();
    return;
  }

  const rawFilter = filterInput?.value || '';
  const filterText = caseSensitiveSearch ? rawFilter : rawFilter.toLowerCase();

  let regex: RegExp | null = null;
  let regexInvalid = false;
  if (regexSearch && rawFilter) {
    try { regex = new RegExp(rawFilter, caseSensitiveSearch ? '' : 'i'); }
    catch { regexInvalid = true; }
  }
  filterInput?.classList.toggle('ov-filter-invalid', regexInvalid);

  // Cap regex search input length per field. A pathological pattern (e.g. /(a+)+$/)
  // on a 50KB body will hang the page; truncation bounds the worst case to a slice.
  const REGEX_MAX_INPUT = 8000;
  function matchesText(r: ApiRequest): boolean {
    if (!filterText) return true;
    if (regexInvalid) return false;
    if (regex) {
      const clip = (s: string): string => s.length > REGEX_MAX_INPUT ? s.slice(0, REGEX_MAX_INPUT) : s;
      return regex.test(clip(r.url || ''))
          || (r.reqBody != null && regex.test(clip(r.reqBody)))
          || (r.resBody != null && regex.test(clip(r.resBody)));
    }
    if (caseSensitiveSearch) {
      return (r.url || '').includes(filterText)
          || (r.reqBody != null && r.reqBody.includes(filterText))
          || (r.resBody != null && r.resBody.includes(filterText));
    }
    return (r._lcUrl || '').includes(filterText)
        || (r._lcReqBody != null && r._lcReqBody.includes(filterText))
        || (r._lcResBody != null && r._lcResBody.includes(filterText));
  }

  function matchesStatus(r: ApiRequest): boolean {
    if (activeStatus.size === 0) return true;
    const b = statusBucket(r);
    return activeStatus.has(b);
  }

  function matchesMethod(r: ApiRequest): boolean {
    if (activeMethods.size === 0) return true;
    return activeMethods.has((r.method || 'GET').toUpperCase());
  }

  function matchesInitiator(r: ApiRequest): boolean {
    if (activeInitiators.size === 0) return true;
    const ini = r.element ? 'page' : 'bg';
    return activeInitiators.has(ini);
  }

  const snapshot = Array.from(requests.values());
  const visible: ApiRequest[] = [];
  for (let i = snapshot.length - 1; i >= 0 && visible.length < RENDER_LIMIT; i--) {
    const r = snapshot[i];
    if (!matchesMethod(r)) continue;
    if (!matchesStatus(r)) continue;
    if (!matchesInitiator(r)) continue;
    if (!matchesText(r)) continue;
    visible.push(r);
  }

  if (countEl) countEl.textContent = `${visible.length}/${requests.size}`;

  // update chip counts
  updateChipCounts(snapshot);

  let html = '';

  if (showPinTray) html += renderPinTray();

  if (visible.length === 0) {
    html += `<div class="ov-empty">${
      requests.size === 0
        ? 'No API calls captured yet.<br><small>Interact with the page to see calls appear here.</small>'
        : 'No results match your filter.'
    }</div>`;
  } else {
    html += visible.map(r => rowHtml(r)).join('');
  }

  list.innerHTML = html;
  reattachValueHighlight();
  renderFooter();
}

function updateChipCounts(snapshot: ApiRequest[]): void {
  const counts: Record<string, number> = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  for (const r of snapshot) {
    const b = statusBucket(r);
    if (b in counts) counts[b]++;
  }
  for (const chip of document.querySelectorAll<HTMLElement>('.ov-chip[data-s]')) {
    const s = chip.dataset.s || '';
    const badge = chip.querySelector('.ov-chip-count');
    if (badge) badge.textContent = String(counts[s] ?? 0);
  }
}

// ── Event delegation ──────────────────────────────────────────────────────────

let rowEventsBound = false;

function bindListDelegation(list: HTMLElement): void {
  if (rowEventsBound) return;
  rowEventsBound = true;

  list.addEventListener('mouseover', (e: Event) => {
    const row = (e.target as Element).closest<HTMLElement>('.ov-row');
    if (!row || !list.contains(row)) return;
    const related = (e as MouseEvent).relatedTarget as Element | null;
    if (related && row.contains(related)) return;
    const sel = safeDecodeURIComponent(row.dataset.sel || '');
    if (sel) highlightEl(sel);
  });

  list.addEventListener('mouseout', (e: Event) => {
    const row = (e.target as Element).closest<HTMLElement>('.ov-row');
    if (!row) return;
    const related = (e as MouseEvent).relatedTarget as Element | null;
    if (related && row.contains(related)) return;
    clearHighlight();
  });

  list.addEventListener('click', (e: Event) => {
    const target = e.target as Element;

    const pinBtn = target.closest<HTMLElement>('.ov-pin-btn');
    if (pinBtn) {
      e.stopPropagation();
      const id = Number(pinBtn.dataset.id);
      if (!Number.isFinite(id)) return;
      const req = requests.get(id);
      if (!req) return;
      if (pinnedIds.has(id)) {
        pinnedIds.delete(id);
        pinnedKeys.delete(pinKey(req));
      } else {
        pinnedIds.add(id);
        pinnedKeys.add(pinKey(req));
      }
      chrome.storage.local.set({ ovPinnedKeys: [...pinnedKeys] });
      scheduleRender();
      return;
    }

    const copyBtn = target.closest<HTMLElement>('.ov-copy-btn');
    if (copyBtn) {
      e.stopPropagation();
      const url = safeDecodeURIComponent(copyBtn.dataset.url || '');
      const restore = (label: string) => {
        copyBtn.textContent = label;
        setTimeout(() => { copyBtn.textContent = 'copy'; }, 900);
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(url).then(() => restore('copied'), () => restore('failed'));
      } else {
        restore('failed');
      }
      return;
    }

    const tabBtn = target.closest<HTMLElement>('.ov-tab');
    if (tabBtn) {
      e.stopPropagation();
      const wrap = tabBtn.parentElement as HTMLElement | null;
      const id = Number(wrap?.dataset.id);
      const tab = tabBtn.dataset.tab as DetailTab | undefined;
      if (!Number.isFinite(id) || !tab) return;
      detailTabs.set(id, tab);
      clearBulkHighlights();
      if (tab === 'response') runBulkHighlight(id);
      scheduleRender();
      return;
    }

    const jv = target.closest<HTMLElement>('.ov-jv');
    if (jv) {
      e.stopPropagation();
      handleJsonValueClick(jv);
      return;
    }

    const row = target.closest<HTMLElement>('.ov-row');
    if (!row) return;
    const id = Number(row.dataset.id);
    if (expandedIds.has(id)) {
      expandedIds.delete(id);
      detailTabs.delete(id);
      if (valueHighlightKey.startsWith(`${id}|`)) clearValueHighlights();
      if (bulkHighlightRowId === id) clearBulkHighlights();
    } else {
      expandedIds.add(id);
      const activeTab = detailTabs.get(id) ?? 'response';
      if (activeTab === 'response') runBulkHighlight(id);
    }
    scheduleRender();
  });
}

function bindChipDelegation(container: HTMLElement): void {
  container.addEventListener('click', (e: Event) => {
    const chip = (e.target as Element).closest<HTMLElement>('.ov-chip');
    if (!chip) return;
    const s = chip.dataset.s;
    const m = chip.dataset.m;
    const ini = chip.dataset.i;

    if (s) {
      activeStatus.has(s) ? activeStatus.delete(s) : activeStatus.add(s);
      chip.classList.toggle('on', activeStatus.has(s));
    } else if (m) {
      activeMethods.has(m) ? activeMethods.delete(m) : activeMethods.add(m);
      chip.classList.toggle('on', activeMethods.has(m));
    } else if (ini) {
      activeInitiators.has(ini) ? activeInitiators.delete(ini) : activeInitiators.add(ini);
      chip.classList.toggle('on', activeInitiators.has(ini));
    }

    chrome.storage.local.set({ ovFilters: {
      status: [...activeStatus], methods: [...activeMethods], initiators: [...activeInitiators]
    }});
    renderList();
  });
}

// ── Pill (collapsed state) ────────────────────────────────────────────────────

function setDockState(next: DockState): void {
  if (next === dockState) return;
  dockState = next;
  chrome.storage.local.set({ ovDockState: next });
  const panel = $('ov-panel');
  const pill = $('ov-pill');
  if (next === 'panel') {
    $('ov-pill')?.remove();
    if (!panel) buildPanel();
    else panel.style.setProperty('display', 'flex', 'important');
  } else if (next === 'pill') {
    if (panel) panel.style.setProperty('display', 'none', 'important');
    if (!pill) buildPill();
    else refreshPill();
  } else {
    if (panel) panel.style.setProperty('display', 'none', 'important');
    $('ov-pill')?.remove();
  }
}

function pillInnerHtml(): string {
  const reqs = [...requests.values()];
  const total = reqs.length;
  const errs = reqs.filter(isError).length;
  const recent = reqs.slice(-12);
  const ticks = recent.map(r => {
    const b = statusBucket(r);
    const cls = b === '4xx' || b === '5xx' || b === 'err' ? 'err'
              : b === '3xx' ? 'warn'
              : r.kind === 'ws' ? 'ws' : '';
    return `<span class="ov-pill-tick${cls ? ' ' + cls : ''}"></span>`;
  }).join('');
  return `
    <span class="ov-pill-dot"></span>
    <span class="ov-pill-count">${total}</span>
    <span class="ov-pill-label">req</span>
    ${errs ? `<span class="ov-pill-err">${errs} err</span>` : ''}
    <span class="ov-pill-rail">${ticks}</span>
    <button class="ov-pill-expand" title="Expand panel">⤢</button>
  `;
}

function buildPill(): void {
  if ($('ov-pill')) return;
  injectStyles();
  const pill = document.createElement('div');
  pill.id = 'ov-pill';
  pill.dataset.theme = currentTheme;
  pill.innerHTML = pillInnerHtml();
  document.documentElement.appendChild(pill);
  makeDraggable(pill, pill);
  pill.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.ov-pill-expand')) {
      setDockState('panel');
    }
  });
}

function refreshPill(): void {
  const pill = $('ov-pill');
  if (pill) pill.innerHTML = pillInnerHtml();
}

// ── Panel build ───────────────────────────────────────────────────────────────

function buildPanel(): void {
  if ($('ov-panel')) return;

  injectStyles();

  const panel = document.createElement('div');
  panel.id = 'ov-panel';
  panel.dataset.theme = currentTheme;
  panel.innerHTML = `
    <div id="ov-header">
      <div class="ov-grip"></div>
      <span class="ov-hdr-title">API Overlay</span>
      <span id="ov-count" class="ov-count-badge" data-tip="Visible / total requests">0/0</span>
      <div class="ov-hdr-spacer"></div>
      <div id="ov-actions">
        <button id="ov-pause" data-tip="Pause or resume capturing">${paused ? '▶ rec' : '⏸ pause'}</button>
        <div class="ov-divider"></div>
        <button id="ov-theme" data-tip="Toggle dark / light theme">${currentTheme === 'dark' ? 'light' : 'dark'}</button>
        <button id="ov-export" data-tip="Export as HAR file">↓ har</button>
        <div class="ov-divider"></div>
        <button id="ov-clear" data-tip="Clear all requests">✕ clear</button>
        <button id="ov-collapse" data-tip="Collapse to pill" data-tip-align="right">_</button>
      </div>
    </div>
    <div id="ov-filter-row">
      <div class="ov-search">
        <span class="ov-prompt">›</span>
        <input id="ov-filter" placeholder="filter url, body, header…" autocomplete="off" spellcheck="false"/>
        <div class="ov-search-modes">
          <button id="ov-case-toggle" class="ov-modebtn" data-tip="Case-sensitive search" data-tip-align="right">Aa</button>
          <button id="ov-regex-toggle" class="ov-modebtn" data-tip="Regex search" data-tip-align="right">.*</button>
        </div>
      </div>
    </div>
    <div id="ov-chips">
      <span class="ov-chip-label">status</span>
      <button class="ov-chip" data-s="2xx" data-tip="Filter: 2xx success">2xx<span class="ov-chip-count">0</span></button>
      <button class="ov-chip" data-s="3xx" data-tip="Filter: 3xx redirects">3xx<span class="ov-chip-count">0</span></button>
      <button class="ov-chip" data-s="4xx" data-tip="Filter: 4xx client errors">4xx<span class="ov-chip-count">0</span></button>
      <button class="ov-chip" data-s="5xx" data-tip="Filter: 5xx server errors">5xx<span class="ov-chip-count">0</span></button>
      <span class="ov-chip-sep"></span>
      <span class="ov-chip-label">method</span>
      <button class="ov-chip" data-m="GET" data-tip="Filter: GET requests">GET</button>
      <button class="ov-chip" data-m="POST" data-tip="Filter: POST requests">POST</button>
      <button class="ov-chip" data-m="PUT" data-tip="Filter: PUT requests">PUT</button>
      <button class="ov-chip" data-m="PATCH" data-tip="Filter: PATCH requests">PATCH</button>
      <button class="ov-chip" data-m="DELETE" data-tip="Filter: DELETE requests">DEL</button>
      <button class="ov-chip" data-m="WS" data-tip="Filter: WebSocket connections">WS</button>
      <span class="ov-chip-sep"></span>
      <span class="ov-chip-label">from</span>
      <button class="ov-chip" data-i="page" data-tip="Requests from page scripts">page</button>
      <button class="ov-chip" data-i="bg" data-tip="Background / extension requests">bg</button>
    </div>
    <div id="ov-list"></div>
    <div id="ov-footer"></div>
    <div class="ov-resize-handle" data-dir="n"></div>
    <div class="ov-resize-handle" data-dir="s"></div>
    <div class="ov-resize-handle" data-dir="e"></div>
    <div class="ov-resize-handle" data-dir="w"></div>
    <div class="ov-resize-handle" data-dir="ne"></div>
    <div class="ov-resize-handle" data-dir="nw"></div>
    <div class="ov-resize-handle" data-dir="se"></div>
    <div class="ov-resize-handle" data-dir="sw"></div>
  `;

  if (!panelVisible) panel.style.setProperty('display', 'none', 'important');
  document.documentElement.appendChild(panel);

  filterInput = $('ov-filter') as HTMLInputElement;

  const ovCollapse = $('ov-collapse');
  const ovClear    = $('ov-clear');
  const ovPause    = $('ov-pause');
  const ovTheme    = $('ov-theme');
  const ovExport   = $('ov-export');
  const caseBtn    = $('ov-case-toggle');
  const regexBtn   = $('ov-regex-toggle');

  if (ovCollapse) ovCollapse.onclick = () => setDockState('pill');
  if (ovClear) ovClear.onclick = () => {
    requests.clear(); expandedIds.clear(); detailTabs.clear(); pinnedIds.clear();
    clearAllBadges(); clearValueHighlights(); clearBulkHighlights(); renderList();
  };
  if (ovPause) ovPause.onclick = () => setPaused(!paused);
  if (ovTheme) ovTheme.onclick = () => {
    const next: 'dark' | 'light' = currentTheme === 'dark' ? 'light' : 'dark';
    chrome.storage.local.set({ ovTheme: next });
    applyTheme(next);
  };
  filterInput.oninput = () => scheduleRender();
  if (ovExport) ovExport.onclick = exportHAR;

  if (caseBtn) caseBtn.onclick = () => {
    caseSensitiveSearch = !caseSensitiveSearch;
    caseBtn.classList.toggle('ov-active', caseSensitiveSearch);
    renderList();
  };
  if (regexBtn) regexBtn.onclick = () => {
    regexSearch = !regexSearch;
    regexBtn.classList.toggle('ov-active', regexSearch);
    renderList();
  };

  makeDraggable(panel, $('ov-header')!);
  makeResizable(panel);
  const list = $('ov-list')!;
  bindListDelegation(list);
  bindChipDelegation($('ov-chips')!);
  renderList();
}

// ── HAR export ────────────────────────────────────────────────────────────────

function exportHAR(): void {
  function parseQuery(url: string): { name: string; value: string }[] {
    try { return [...new URL(url).searchParams.entries()].map(([name, value]) => ({ name, value })); }
    catch { return []; }
  }
  function detectMime(body: string | null | undefined): string {
    if (!body) return 'text/plain';
    const t = body.trimStart();
    if (t.startsWith('{') || t.startsWith('[')) return 'application/json';
    if (t.startsWith('<')) return 'text/xml';
    return 'text/plain';
  }
  const encoder = new TextEncoder();
  const byteLen = (s: string | null | undefined): number => s ? encoder.encode(s).length : -1;
  const toHarHeaders = (hs: HeaderPair[] | null | undefined): { name: string; value: string }[] =>
    hs ? hs.map(([name, value]) => ({ name, value })) : [];

  const entries = [...requests.values()]
    .filter(r => r.kind !== 'ws' && typeof r.status === 'number')
    .map(r => ({
      startedDateTime: new Date(r.ts || Date.now()).toISOString(),
      time: r.ms || 0,
      request: {
        method: r.method || 'GET', url: r.url || '', httpVersion: 'HTTP/1.1',
        headers: toHarHeaders(r.reqHeaders), queryString: parseQuery(r.url),
        cookies: [], headersSize: -1, bodySize: byteLen(r.reqBody),
        ...(r.reqBody ? { postData: { mimeType: detectMime(r.reqBody), text: r.reqBody } } : {})
      },
      response: {
        status: r.status as number, statusText: '', httpVersion: 'HTTP/1.1',
        headers: toHarHeaders(r.resHeaders), cookies: [],
        content: { size: byteLen(r.resBody), mimeType: detectMime(r.resBody), text: r.resBody || '' },
        redirectURL: '', headersSize: -1, bodySize: byteLen(r.resBody)
      },
      cache: {},
      timings: { send: 0, wait: r.ms || 0, receive: 0 }
    }));

  const har = { log: { version: '1.2', creator: { name: 'CalloutAPI', version: '1.0' }, pages: [], entries } };
  const blob = new Blob([JSON.stringify(har)], { type: 'application/json' });
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = 'callout-' + Date.now() + '.har';
  document.documentElement.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}

// ── Element highlight ─────────────────────────────────────────────────────────

function highlightEl(selector: string): void {
  clearHighlight();
  try {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el || el.closest('#ov-panel')) return;
    el.classList.add('ov-highlighted');
    activeHighlight = el;
    const rect = el.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch { /* invalid selector */ }
}

function clearHighlight(): void {
  if (activeHighlight) { activeHighlight.classList.remove('ov-highlighted'); activeHighlight = null; }
}

// ── Float badges ──────────────────────────────────────────────────────────────

function removeSelectorReqId(sel: string, id: number): void {
  const ids = selectorReqIds.get(sel);
  if (!ids) return;
  const next = ids.filter(x => x !== id);
  if (next.length === 0) {
    const t = selectorTimers.get(sel);
    if (t !== undefined) clearTimeout(t);
    selectorBadges.get(sel)?.remove();
    selectorBadges.delete(sel);
    selectorReqIds.delete(sel);
    selectorTimers.delete(sel);
  } else {
    selectorReqIds.set(sel, next);
    refreshClusterBadge(sel);
  }
}

function clusterBadgeRowHtml(req: ApiRequest): string {
  let path = req.url;
  try { path = new URL(req.url).pathname; } catch { /* use full url */ }
  const sc = typeof req.status === 'number' ? String(req.status)[0] : '';
  const statusHtml = req.status !== 'pending'
    ? `<span class="ov-fb-s ov-fb-s-${sc}">${escHtml(String(req.status))}</span>`
    : '<span class="ov-fb-s">…</span>';
  return `<div class="ov-fb-row"><span class="ov-fb-m ov-fb-m-${safeMethodClass(req.method)}">${escHtml(req.method)}</span><span class="ov-fb-url">${escHtml(path)}</span>${statusHtml}</div>`;
}

function refreshClusterBadge(sel: string): void {
  const badge = selectorBadges.get(sel);
  if (!badge) return;
  const ids = selectorReqIds.get(sel) ?? [];
  const count = ids.length;

  if (count === 1) {
    // Single endpoint — show inline, no circle, no popup
    const r = requests.get(ids[0]);
    if (!r) return;
    badge.className = 'ov-float-badge ov-fb-single';
    badge.dataset.theme = currentTheme;
    badge.classList.remove('ov-fb-open');
    badge.innerHTML = clusterBadgeRowHtml(r);
    return;
  }

  // Multi-endpoint cluster — upgrade class if coming from single mode
  if (!badge.classList.contains('ov-fb-cluster')) {
    badge.className = 'ov-float-badge ov-fb-cluster';
    badge.dataset.theme = currentTheme;
  }

  const open = badge.classList.contains('ov-fb-open');
  const countEl = badge.querySelector<HTMLElement>('.ov-fb-circle');
  const popupEl = badge.querySelector<HTMLElement>('.ov-fb-popup');

  if (!countEl || !popupEl) {
    // First render or upgrade from single — build from scratch
    const popupHtml = ids.map(id => {
      const r = requests.get(id);
      return r ? clusterBadgeRowHtml(r) : '';
    }).join('');
    const dir = badge.dataset.popupDir ?? 'right';
    badge.innerHTML = `<span class="ov-fb-circle">${count}</span><div class="ov-fb-popup ov-fb-popup-${dir}${open ? ' ov-fb-popup-show' : ''}">${popupHtml}</div>`;
    return;
  }

  // Surgical updates — avoid full rebuild while popup may be open
  countEl.textContent = String(count);
  popupEl.classList.toggle('ov-fb-popup-show', open);

  // Sync rows: add/update without touching unaffected ones
  const existingRows = Array.from(popupEl.querySelectorAll<HTMLElement>('.ov-fb-row'));
  for (let i = 0; i < ids.length; i++) {
    const r = requests.get(ids[i]);
    if (!r) continue;
    if (existingRows[i]) {
      existingRows[i].outerHTML = clusterBadgeRowHtml(r);
    } else {
      popupEl.insertAdjacentHTML('beforeend', clusterBadgeRowHtml(r));
    }
  }
  // Remove stale trailing rows
  const staleRows = Array.from(popupEl.querySelectorAll<HTMLElement>('.ov-fb-row')).slice(ids.length);
  for (const el of staleRows) el.remove();
}

function flashBadge(req: ApiRequest): void {
  if (!req.element?.selector) return;
  try {
    const el = document.querySelector(req.element.selector);
    if (!el || el.closest('#ov-panel')) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const sel = req.element.selector;

    // Track this request under its selector
    const ids = selectorReqIds.get(sel) ?? [];
    if (!ids.includes(req.id)) ids.push(req.id);
    selectorReqIds.set(sel, ids);

    // Create cluster badge if needed
    if (!selectorBadges.has(sel)) {
      const badge = document.createElement('div');
      badge.className = 'ov-float-badge ov-fb-cluster';
      badge.dataset.theme = currentTheme;
      badge.dataset.sel = sel;
      // Popup opens right unless circle is in the right half — then open left
      const popupDir = (rect.right - 13) > window.innerWidth / 2 ? 'left' : 'right';
      badge.dataset.popupDir = popupDir;
      // Anchor circle to element's top-right corner, clamped inside viewport
      const cx = Math.min(
        window.scrollX + rect.right - 13,
        window.innerWidth - 30
      );
      const cy = Math.max(window.scrollY + rect.top - 13, window.scrollY + 4);
      badge.style.cssText = `top:${cy}px;left:${cx}px;`;
      document.documentElement.appendChild(badge);
      selectorBadges.set(sel, badge);
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        badge.classList.toggle('ov-fb-open');
        refreshClusterBadge(sel);
      });
    }

    refreshClusterBadge(sel);

    // Reset auto-dismiss timer (restarts on each new request for this element)
    const prev = selectorTimers.get(sel);
    if (prev !== undefined) clearTimeout(prev);
    const timer = window.setTimeout(() => {
      selectorBadges.get(sel)?.remove();
      selectorBadges.delete(sel);
      selectorReqIds.delete(sel);
      selectorTimers.delete(sel);
    }, 6000);
    selectorTimers.set(sel, timer);
  } catch { /* invalid selector */ }
}

function clearAllBadges(): void {
  for (const b of selectorBadges.values()) b.remove();
  for (const t of selectorTimers.values()) clearTimeout(t);
  selectorBadges.clear();
  selectorReqIds.clear();
  selectorTimers.clear();
  for (const b of document.querySelectorAll('.ov-float-badge')) b.remove();
}

// ── Drag / resize ─────────────────────────────────────────────────────────────

function signalInjected(action: 'pause' | 'resume' | 'stop' | 'start'): void {
  window.postMessage({ __apiOverlayControl: true, action }, '*');
}

function makeDraggable(panel: HTMLElement, handle: HTMLElement): void {
  let ox = 0, oy = 0;
  handle.addEventListener('mousedown', (e: MouseEvent) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    e.preventDefault();
    const rect0 = panel.getBoundingClientRect();
    ox = e.clientX - rect0.left;
    oy = e.clientY - rect0.top;
    // Keep at least this much of the panel onscreen so the user can always grab it back.
    const KEEP_VISIBLE = 60;
    const move = (ev: MouseEvent) => {
      const w = panel.offsetWidth || rect0.width;
      const minLeft = KEEP_VISIBLE - w;
      const maxLeft = window.innerWidth - KEEP_VISIBLE;
      const minTop = 0;
      const maxTop = window.innerHeight - KEEP_VISIBLE;
      const left = Math.min(maxLeft, Math.max(minLeft, ev.clientX - ox));
      const top = Math.min(maxTop, Math.max(minTop, ev.clientY - oy));
      panel.style.setProperty('left', `${left}px`, 'important');
      panel.style.setProperty('top', `${top}px`, 'important');
      panel.style.setProperty('right', 'auto', 'important');
      panel.style.setProperty('bottom', 'auto', 'important');
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

function makeResizable(panel: HTMLElement): void {
  panel.addEventListener('mousedown', (e: MouseEvent) => {
    const handle = (e.target as Element).closest<HTMLElement>('.ov-resize-handle');
    if (!handle) return;
    const dir = handle.dataset.dir ?? '';
    e.preventDefault();
    e.stopPropagation();
    const rect = panel.getBoundingClientRect();
    panel.style.setProperty('left', `${rect.left}px`, 'important');
    panel.style.setProperty('top', `${rect.top}px`, 'important');
    panel.style.setProperty('right', 'auto', 'important');
    panel.style.setProperty('bottom', 'auto', 'important');
    panel.style.setProperty('width', `${rect.width}px`, 'important');
    panel.style.setProperty('height', `${rect.height}px`, 'important');
    const startX = e.clientX, startY = e.clientY;
    const startLeft = rect.left, startTop = rect.top, startW = rect.width, startH = rect.height;
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      let left = startLeft, top = startTop, w = startW, h = startH;
      if (dir.includes('e')) w = Math.min(window.innerWidth * 0.95, Math.max(320, startW + dx));
      if (dir.includes('s')) h = Math.min(window.innerHeight * 0.95, Math.max(240, startH + dy));
      if (dir.includes('w')) { const cdx = Math.min(startW - 320, dx); w = startW - cdx; left = startLeft + cdx; }
      if (dir.includes('n')) { const cdy = Math.min(startH - 240, dy); h = startH - cdy; top = startTop + cdy; }
      panel.style.setProperty('left', `${left}px`, 'important');
      panel.style.setProperty('top', `${top}px`, 'important');
      panel.style.setProperty('width', `${w}px`, 'important');
      panel.style.setProperty('height', `${h}px`, 'important');
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

// ── Styles ────────────────────────────────────────────────────────────────────

function injectStyles(): void {
  if ($('ov-styles')) return;
  const s = document.createElement('style');
  s.id = 'ov-styles';
  s.textContent = `
    #ov-panel {
      all: initial;
      /* dark theme (default) */
      --ov-bg:               #0d0e10;
      --ov-bg-2:             #14161a;
      --ov-bg-3:             #1a1d22;
      --ov-hdr:              #14161a;
      --ov-border:           #2a2f37;
      --ov-grid:             #1f2329;
      --ov-text:             #d6dae0;
      --ov-text-dim:         #9aa1ab;
      --ov-text-muted:       #6a7180;
      --ov-text-faint:       #4a505c;
      --ov-title:            #d6dae0;
      --ov-accent:           #6ab0ff;
      --ov-accent-bg:        rgba(106,176,255,.14);
      --ov-m-get:            #6ab0ff;
      --ov-m-post:           #b58cff;
      --ov-m-put:            #ffb86c;
      --ov-m-patch:          #ffd86c;
      --ov-m-delete:         #ff6b8a;
      --ov-m-ws:             #4ec9b0;
      --ov-s-2xx:            #7a8290;
      --ov-s-3xx:            #d4a85e;
      --ov-s-4xx:            #ff9a52;
      --ov-s-5xx:            #ff5a6e;
      --ov-s-err:            #ff5a6e;
      --ov-s-pending:        #4ec9b0;
      --ov-scrollbar:        #2a2f37;
      --ov-shadow:           rgba(0,0,0,.6);
      position: fixed !important;
      bottom: 20px !important;
      right: 20px !important;
      width: 520px !important;
      height: 640px !important;
      min-width: 360px !important;
      min-height: 240px !important;
      max-width: 95vw !important;
      max-height: 95vh !important;
      background: var(--ov-bg) !important;
      color: var(--ov-text) !important;
      border-radius: 2px !important;
      box-shadow: 0 12px 40px var(--ov-shadow) !important;
      z-index: 2147483647 !important;
      font-family: 'JetBrains Mono','IBM Plex Mono',ui-monospace,monospace !important;
      font-size: 12px !important;
      display: flex !important;
      flex-direction: column !important;
      overflow: hidden !important;
      border: 1px solid var(--ov-border) !important;
    }
    #ov-panel[data-theme="light"] {
      --ov-bg:               #fbfaf7;
      --ov-bg-2:             #ffffff;
      --ov-bg-3:             #f3f1ec;
      --ov-hdr:              #ffffff;
      --ov-border:           #d9d4c4;
      --ov-grid:             #ebe6d8;
      --ov-text:             #1a1c20;
      --ov-text-dim:         #4a4f59;
      --ov-text-muted:       #6c727c;
      --ov-text-faint:       #9a9fa8;
      --ov-title:            #1a1c20;
      --ov-accent:           #2a6fdb;
      --ov-accent-bg:        rgba(42,111,219,.12);
      --ov-m-get:            #1f6feb;
      --ov-m-post:           #7a3df0;
      --ov-m-put:            #b8631a;
      --ov-m-patch:          #a6791f;
      --ov-m-delete:         #d23158;
      --ov-m-ws:             #1a8473;
      --ov-s-2xx:            #6c727c;
      --ov-s-3xx:            #8a5a14;
      --ov-s-4xx:            #b8541d;
      --ov-s-5xx:            #c0273f;
      --ov-s-err:            #c0273f;
      --ov-s-pending:        #1a8473;
      --ov-scrollbar:        #d9d4c4;
      --ov-shadow:           rgba(0,0,0,.15);
    }

    /* ── Header ── */
    #ov-header {
      display: flex !important;
      align-items: center !important;
      gap: 6px !important;
      padding: 0 8px 0 10px !important;
      height: 36px !important;
      background: var(--ov-hdr) !important;
      cursor: move !important;
      user-select: none !important;
      border-bottom: 1px solid var(--ov-border) !important;
      flex-shrink: 0 !important;
    }
    .ov-grip {
      display: grid !important;
      grid-template-columns: 3px 3px !important;
      grid-template-rows: repeat(3, 3px) !important;
      gap: 2px !important;
      flex-shrink: 0 !important;
      margin-right: 2px !important;
    }
    .ov-grip::before, .ov-grip::after {
      content: '' !important;
      display: none !important;
    }
    .ov-grip {
      background-image: radial-gradient(circle, var(--ov-text-faint) 1px, transparent 1px) !important;
      background-size: 4px 4px !important;
      width: 8px !important;
      height: 12px !important;
      background-position: 0 0 !important;
      border-radius: 0 !important;
    }
    .ov-hdr-title {
      font-weight: 700 !important;
      font-size: 10px !important;
      color: var(--ov-title) !important;
      letter-spacing: .1em !important;
      text-transform: uppercase !important;
      flex-shrink: 0 !important;
    }
    .ov-count-badge {
      font-size: 9px !important;
      color: var(--ov-text-faint) !important;
      background: var(--ov-bg-3) !important;
      border: 1px solid var(--ov-border) !important;
      padding: 1px 5px !important;
      border-radius: 2px !important;
      font-weight: 700 !important;
      flex-shrink: 0 !important;
    }
    .ov-hdr-spacer { flex: 1 !important; }
    .ov-divider {
      width: 1px !important;
      height: 14px !important;
      background: var(--ov-border) !important;
      flex-shrink: 0 !important;
    }
    #ov-actions { display: flex !important; align-items: center !important; gap: 2px !important; }
    #ov-actions button {
      all: unset !important;
      background: transparent !important;
      color: var(--ov-text-muted) !important;
      padding: 3px 7px !important;
      border-radius: 2px !important;
      cursor: pointer !important;
      font-size: 10px !important;
      font-family: inherit !important;
      white-space: nowrap !important;
      border: 1px solid transparent !important;
      transition: color 80ms, border-color 80ms !important;
    }
    #ov-actions button:hover { color: var(--ov-text) !important; border-color: var(--ov-border) !important; }
    #ov-actions button.ov-active { color: var(--ov-accent) !important; border-color: var(--ov-accent) !important; }

    /* ── Filter row ── */
    #ov-filter-row {
      padding: 6px 8px !important;
      background: var(--ov-bg-2) !important;
      border-bottom: 1px solid var(--ov-border) !important;
      flex-shrink: 0 !important;
    }
    .ov-search {
      display: flex !important;
      align-items: center !important;
      background: var(--ov-bg-3) !important;
      border: 1px solid var(--ov-border) !important;
      border-radius: 2px !important;
      padding: 0 4px !important;
    }
    .ov-prompt {
      color: var(--ov-text-muted) !important;
      font-size: 13px !important;
      padding: 0 4px !important;
      flex-shrink: 0 !important;
    }
    #ov-filter {
      all: unset !important;
      flex: 1 !important;
      color: var(--ov-text) !important;
      font-size: 11px !important;
      font-family: inherit !important;
      padding: 5px 4px !important;
    }
    #ov-filter::placeholder { color: var(--ov-text-faint) !important; }
    #ov-filter.ov-filter-invalid { color: var(--ov-s-err) !important; }
    .ov-search-modes { display: flex !important; gap: 2px !important; padding: 0 2px !important; }
    .ov-modebtn {
      all: unset !important;
      cursor: pointer !important;
      padding: 2px 5px !important;
      font-size: 10px !important;
      font-weight: 700 !important;
      font-family: inherit !important;
      color: var(--ov-text-faint) !important;
      border-radius: 2px !important;
      border: 1px solid transparent !important;
    }
    .ov-modebtn:hover { color: var(--ov-text-muted) !important; }
    .ov-modebtn.ov-active { color: var(--ov-accent) !important; border-color: var(--ov-accent) !important; }

    /* ── Chips ── */
    #ov-chips {
      display: flex !important;
      align-items: center !important;
      gap: 3px !important;
      padding: 4px 8px !important;
      background: var(--ov-bg) !important;
      border-bottom: 1px solid var(--ov-border) !important;
      flex-shrink: 0 !important;
      flex-wrap: wrap !important;
    }
    .ov-chip-label {
      font-size: 9px !important;
      letter-spacing: .06em !important;
      text-transform: uppercase !important;
      color: var(--ov-text-faint) !important;
      padding: 0 2px !important;
      flex-shrink: 0 !important;
    }
    .ov-chip {
      all: unset !important;
      cursor: pointer !important;
      font-size: 9px !important;
      font-weight: 700 !important;
      font-family: inherit !important;
      letter-spacing: .04em !important;
      padding: 2px 6px !important;
      border-radius: 2px !important;
      border: 1px solid var(--ov-border) !important;
      color: var(--ov-text-muted) !important;
      background: transparent !important;
      white-space: nowrap !important;
      transition: color 80ms, border-color 80ms, background 80ms !important;
    }
    .ov-chip:hover { border-color: var(--ov-text-muted) !important; color: var(--ov-text) !important; }
    .ov-chip.on { border-color: var(--ov-accent) !important; color: var(--ov-accent) !important; background: var(--ov-accent-bg) !important; }
    .ov-chip[data-s="2xx"].on { color: var(--ov-s-2xx) !important; border-color: var(--ov-s-2xx) !important; }
    .ov-chip[data-s="4xx"].on { color: var(--ov-s-4xx) !important; border-color: var(--ov-s-4xx) !important; }
    .ov-chip[data-s="5xx"].on { color: var(--ov-s-5xx) !important; border-color: var(--ov-s-5xx) !important; }
    .ov-chip[data-m="GET"].on    { color: var(--ov-m-get) !important;    border-color: var(--ov-m-get) !important; }
    .ov-chip[data-m="POST"].on   { color: var(--ov-m-post) !important;   border-color: var(--ov-m-post) !important; }
    .ov-chip[data-m="PUT"].on    { color: var(--ov-m-put) !important;    border-color: var(--ov-m-put) !important; }
    .ov-chip[data-m="PATCH"].on  { color: var(--ov-m-patch) !important;  border-color: var(--ov-m-patch) !important; }
    .ov-chip[data-m="DELETE"].on { color: var(--ov-m-delete) !important; border-color: var(--ov-m-delete) !important; }
    .ov-chip[data-m="WS"].on     { color: var(--ov-m-ws) !important;     border-color: var(--ov-m-ws) !important; }
    .ov-chip-count {
      font-size: 8px !important;
      margin-left: 3px !important;
      color: var(--ov-text-faint) !important;
    }
    .ov-chip.on .ov-chip-count { color: inherit !important; }
    .ov-chip-sep {
      display: inline-block !important;
      width: 1px !important;
      height: 12px !important;
      background: var(--ov-border) !important;
      margin: 0 4px !important;
      flex-shrink: 0 !important;
    }

    /* ── List ── */
    #ov-list {
      overflow-y: auto !important;
      flex: 1 !important;
      padding: 0 !important;
    }
    #ov-list::-webkit-scrollbar { width: 10px !important; }
    #ov-list::-webkit-scrollbar-track { background: var(--ov-bg) !important; }
    #ov-list::-webkit-scrollbar-thumb { background: var(--ov-scrollbar) !important; border-radius: 0 !important; }

    /* ── Rows ── */
    .ov-row {
      display: grid !important;
      grid-template-columns: 42px 38px 52px 1fr 54px !important;
      align-items: center !important;
      min-height: 26px !important;
      padding: 0 !important;
      border-radius: 0 !important;
      border-bottom: 1px solid var(--ov-grid) !important;
      background: transparent !important;
      cursor: pointer !important;
      transition: background 80ms !important;
    }
    .ov-row:hover { background: var(--ov-bg-2) !important; }
    .ov-row.ov-expanded {
      grid-template-rows: 26px auto !important;
      min-height: auto !important;
      height: auto !important;
      background: var(--ov-bg-2) !important;
      box-shadow: inset 2px 0 0 var(--ov-accent) !important;
      align-items: start !important;
    }
    .ov-row.ov-pinned:not(.ov-expanded) { box-shadow: inset 2px 0 0 var(--ov-m-patch) !important; }

    .ov-c {
      padding: 0 5px !important;
      min-width: 0 !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      font-size: 11px !important;
      line-height: 26px !important;
    }
    .ov-c-method {
      font-weight: 700 !important;
      font-size: 9px !important;
      letter-spacing: .04em !important;
      text-align: right !important;
      padding-right: 6px !important;
    }
    .ov-c-method.m-get    { color: var(--ov-m-get)    !important; }
    .ov-c-method.m-post   { color: var(--ov-m-post)   !important; }
    .ov-c-method.m-put    { color: var(--ov-m-put)    !important; }
    .ov-c-method.m-patch  { color: var(--ov-m-patch)  !important; }
    .ov-c-method.m-delete { color: var(--ov-m-delete) !important; }
    .ov-c-method.m-ws     { color: var(--ov-m-ws)     !important; }
    .ov-c-status {
      font-weight: 700 !important;
      font-size: 10px !important;
    }
    .ov-c-status.s-2xx     { color: var(--ov-s-2xx) !important; }
    .ov-c-status.s-3xx     { color: var(--ov-s-3xx) !important; }
    .ov-c-status.s-4xx     { color: var(--ov-s-4xx) !important; }
    .ov-c-status.s-5xx     { color: var(--ov-s-5xx) !important; }
    .ov-c-status.s-err     { color: var(--ov-s-err) !important; }
    .ov-c-status.s-pending { color: var(--ov-s-pending) !important; }
    .ov-c-dur {
      color: var(--ov-text-muted) !important;
      font-size: 10px !important;
      font-variant-numeric: tabular-nums !important;
    }
    .ov-c-url { flex: 1 !important; display: flex !important; align-items: center !important; gap: 4px !important; }
    .ov-url-path { color: var(--ov-text-dim) !important; overflow: hidden !important; text-overflow: ellipsis !important; }
    .ov-fr { font-size: 9px !important; color: var(--ov-m-ws) !important; flex-shrink: 0 !important; }
    .ov-init {
      font-size: 8px !important;
      color: var(--ov-text-muted) !important;
      border: 1px solid var(--ov-border) !important;
      padding: 0 3px !important;
      text-transform: uppercase !important;
      letter-spacing: .04em !important;
      flex-shrink: 0 !important;
      border-radius: 1px !important;
    }
    .ov-init-bg { color: var(--ov-text-faint) !important; }
.ov-c-act {
      display: flex !important;
      gap: 3px !important;
      align-items: center !important;
      justify-content: flex-end !important;
      padding-right: 6px !important;
      opacity: 0 !important;
      transition: opacity 80ms !important;
    }
    .ov-row:hover .ov-c-act,
    .ov-row.ov-pinned .ov-c-act { opacity: 1 !important; }
    .ov-pin-btn, .ov-copy-btn {
      all: unset !important;
      cursor: pointer !important;
      font-size: 9px !important;
      font-family: inherit !important;
      color: var(--ov-text-muted) !important;
      padding: 1px 4px !important;
      border-radius: 2px !important;
    }
    .ov-pin-btn:hover, .ov-copy-btn:hover { background: var(--ov-bg-3) !important; color: var(--ov-text) !important; }
    .ov-pin-btn.on { color: var(--ov-m-patch) !important; }

    /* ── Detail panel ── */
    .ov-detail {
      grid-column: 1 / -1 !important;
      padding: 8px 10px !important;
      border-top: 1px solid var(--ov-border) !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 0 !important;
    }
    .ov-detail-section { margin-bottom: 8px !important; }
    .ov-tabs {
      display: flex !important;
      gap: 2px !important;
      margin-bottom: 8px !important;
      border-bottom: 1px solid var(--ov-border) !important;
    }
    .ov-tab {
      all: unset !important;
      cursor: pointer !important;
      padding: 4px 10px !important;
      font-size: 10px !important;
      font-weight: 700 !important;
      letter-spacing: .04em !important;
      color: var(--ov-text-muted) !important;
      border-bottom: 2px solid transparent !important;
      font-family: inherit !important;
      text-transform: uppercase !important;
    }
    .ov-tab:hover { color: var(--ov-text) !important; }
    .ov-tab.ov-tab-active { color: var(--ov-accent) !important; border-bottom-color: var(--ov-accent) !important; }
    .ov-detail-label {
      font-size: 9px !important;
      font-weight: 700 !important;
      color: var(--ov-text-muted) !important;
      letter-spacing: .06em !important;
      text-transform: uppercase !important;
      margin-bottom: 4px !important;
    }
    .ov-trigger-full {
      font-size: 10px !important;
      color: var(--ov-text-dim) !important;
      padding: 3px 0 !important;
    }
    .ov-hdr-table {
      background: var(--ov-bg) !important;
      border: 1px solid var(--ov-border) !important;
      border-radius: 2px !important;
      padding: 2px 0 !important;
      max-height: 180px !important;
      overflow-y: auto !important;
    }
    .ov-hdr-table::-webkit-scrollbar { width: 8px !important; }
    .ov-hdr-table::-webkit-scrollbar-thumb { background: var(--ov-scrollbar) !important; }
    .ov-hdr-row {
      display: flex !important;
      gap: 8px !important;
      padding: 2px 8px !important;
      font-size: 10px !important;
      line-height: 1.4 !important;
    }
    .ov-hdr-row:hover { background: var(--ov-bg-2) !important; }
    .ov-hdr-name {
      color: var(--ov-accent) !important;
      font-weight: 700 !important;
      flex-shrink: 0 !important;
      min-width: 110px !important;
      max-width: 180px !important;
      word-break: break-all !important;
    }
    .ov-hdr-val { color: var(--ov-text-dim) !important; word-break: break-all !important; flex: 1 !important; }
    .ov-body-pre {
      all: unset !important;
      display: block !important;
      background: var(--ov-bg) !important;
      border: 1px solid var(--ov-border) !important;
      border-radius: 2px !important;
      padding: 6px 8px !important;
      font-size: 10px !important;
      font-family: inherit !important;
      color: var(--ov-s-2xx) !important;
      white-space: pre-wrap !important;
      word-break: break-all !important;
      max-height: 150px !important;
      overflow-y: auto !important;
    }
    .ov-body-pre::-webkit-scrollbar { width: 8px !important; }
    .ov-body-pre::-webkit-scrollbar-thumb { background: var(--ov-scrollbar) !important; }
    .ov-body-json {
      display: block !important;
      background: var(--ov-bg) !important;
      border: 1px solid var(--ov-border) !important;
      border-radius: 2px !important;
      padding: 6px 8px !important;
      font-size: 10px !important;
      font-family: inherit !important;
      color: var(--ov-text) !important;
      white-space: pre-wrap !important;
      word-break: break-all !important;
      max-height: 220px !important;
      overflow-y: auto !important;
    }
    .ov-body-json::-webkit-scrollbar { width: 8px !important; }
    .ov-body-json::-webkit-scrollbar-thumb { background: var(--ov-scrollbar) !important; }
    .ov-jk { color: var(--ov-accent) !important; }
    .ov-jv { cursor: pointer !important; border-radius: 1px !important; padding: 0 1px !important; transition: background .1s !important; }
    .ov-jv-string  { color: #89d182 !important; }
    .ov-jv-number  { color: #f78c6c !important; }
    .ov-jv-boolean { color: #b58cff !important; }
    .ov-jv-null    { color: #b58cff !important; font-style: italic !important; }
    #ov-panel[data-theme="light"] .ov-jk { color: var(--ov-accent) !important; }
    #ov-panel[data-theme="light"] .ov-jv-string  { color: #2e7d32 !important; }
    #ov-panel[data-theme="light"] .ov-jv-number  { color: #b8541d !important; }
    #ov-panel[data-theme="light"] .ov-jv-boolean { color: #7a3df0 !important; }
    #ov-panel[data-theme="light"] .ov-jv-null    { color: #7a3df0 !important; }
    .ov-jv:hover { background: var(--ov-accent-bg) !important; }
    .ov-jv.ov-jv-active { background: rgba(255,90,110,.2) !important; box-shadow: inset 0 0 0 1px var(--ov-s-err) !important; }
    .ov-jv-trunc { color: var(--ov-text-faint) !important; font-style: italic !important; }
    .ov-body-none { font-size: 10px !important; color: var(--ov-text-faint) !important; font-style: italic !important; }
    .ov-value-status {
      display: inline-block !important;
      margin-left: 6px !important;
      padding: 0 6px !important;
      background: var(--ov-s-err) !important;
      color: #fff !important;
      border-radius: 2px !important;
      font-size: 9px !important;
      font-weight: 700 !important;
      vertical-align: middle !important;
    }
    .ov-value-status[data-empty="1"] { background: var(--ov-text-faint) !important; }

    /* ── WS ── */
    .ov-ws-thread { max-height: 200px !important; overflow-y: auto !important; }
    .ov-ws-thread::-webkit-scrollbar { width: 8px !important; }
    .ov-ws-thread::-webkit-scrollbar-thumb { background: var(--ov-scrollbar) !important; }
    .ov-ws-msg { display: flex !important; gap: 6px !important; margin: 3px 0 !important; align-items: flex-start !important; }
    .ov-ws-dir { font-size: 9px !important; font-weight: 700 !important; padding: 1px 4px !important; border-radius: 1px !important; flex-shrink: 0 !important; }
    .ov-ws-sent .ov-ws-dir { background: rgba(78,201,176,.15) !important; color: var(--ov-m-ws) !important; }
    .ov-ws-recv .ov-ws-dir { background: var(--ov-accent-bg) !important; color: var(--ov-accent) !important; }
    .ov-ws-body { all: unset !important; display: block !important; font-size: 10px !important; font-family: inherit !important; color: var(--ov-text-dim) !important; white-space: pre-wrap !important; word-break: break-all !important; flex: 1 !important; }
    .ov-ws-t { font-size: 9px !important; color: var(--ov-text-faint) !important; flex-shrink: 0 !important; margin-top: 1px !important; }

    /* ── Tab spacer & pane containers ── */
    .ov-tab-spacer { flex: 1 !important; }
    .ov-panel { padding: 4px 0 !important; }
    .ov-kv {
      display: grid !important;
      grid-template-columns: 80px 1fr !important;
      gap: 2px 8px !important;
      font-size: 10px !important;
      padding: 4px 2px !important;
    }
    .ov-kv-k {
      color: var(--ov-text-muted) !important;
      font-size: 9px !important;
      font-weight: 700 !important;
      letter-spacing: .04em !important;
      text-transform: uppercase !important;
      padding: 2px 0 !important;
    }
    .ov-kv-v {
      color: var(--ov-text) !important;
      font-weight: 700 !important;
      padding: 2px 0 !important;
    }

    /* ── Empty ── */
    .ov-empty {
      color: var(--ov-text-faint) !important;
      text-align: center !important;
      padding: 30px 10px !important;
      line-height: 1.7 !important;
      font-size: 11px !important;
    }

    /* ── Pin tray ── */
    .ov-pintray {
      border-bottom: 1px solid var(--ov-border) !important;
      background: var(--ov-bg-2) !important;
    }
    .ov-pintray-head {
      font-size: 9px !important;
      font-weight: 700 !important;
      letter-spacing: .06em !important;
      text-transform: uppercase !important;
      color: var(--ov-m-patch) !important;
      padding: 4px 8px 2px !important;
    }
    .ov-pintray-empty {
      font-size: 10px !important;
      color: var(--ov-text-faint) !important;
      padding: 4px 8px 6px !important;
      font-style: italic !important;
    }

    /* ── Footer ── */
    #ov-footer {
      display: flex !important;
      align-items: center !important;
      gap: 10px !important;
      padding: 4px 10px !important;
      font-size: 10px !important;
      color: var(--ov-text-muted) !important;
      border-top: 1px solid var(--ov-border) !important;
      flex-shrink: 0 !important;
      background: var(--ov-hdr) !important;
    }
    .ov-fstat { color: var(--ov-text-muted) !important; }
    .ov-fstat b { color: var(--ov-text) !important; font-weight: 700 !important; }
    .ov-fstat-err b { color: var(--ov-s-err) !important; }
    .ov-fstat-warn b { color: var(--ov-s-4xx) !important; }
    .ov-fspacer { flex: 1 !important; }
    .ov-pin-toggle {
      all: unset !important;
      cursor: pointer !important;
      font-size: 9px !important;
      font-family: inherit !important;
      color: var(--ov-text-muted) !important;
      padding: 1px 5px !important;
      border: 1px solid var(--ov-border) !important;
      border-radius: 2px !important;
    }
    .ov-pin-toggle:hover { color: var(--ov-m-patch) !important; border-color: var(--ov-m-patch) !important; }
    .ov-pin-toggle.on { color: var(--ov-m-patch) !important; border-color: var(--ov-m-patch) !important; }

    /* ── Resize handles ── */
    .ov-resize-handle { position: absolute !important; z-index: 10 !important; }
    .ov-resize-handle[data-dir="n"]  { top:0 !important; left:8px !important; right:8px !important; height:5px !important; cursor:n-resize !important; }
    .ov-resize-handle[data-dir="s"]  { bottom:0 !important; left:8px !important; right:8px !important; height:5px !important; cursor:s-resize !important; }
    .ov-resize-handle[data-dir="e"]  { top:8px !important; right:0 !important; bottom:8px !important; width:5px !important; cursor:e-resize !important; }
    .ov-resize-handle[data-dir="w"]  { top:8px !important; left:0 !important; bottom:8px !important; width:5px !important; cursor:w-resize !important; }
    .ov-resize-handle[data-dir="nw"] { top:0 !important; left:0 !important; width:8px !important; height:8px !important; cursor:nw-resize !important; }
    .ov-resize-handle[data-dir="ne"] { top:0 !important; right:0 !important; width:8px !important; height:8px !important; cursor:ne-resize !important; }
    .ov-resize-handle[data-dir="sw"] { bottom:0 !important; left:0 !important; width:8px !important; height:8px !important; cursor:sw-resize !important; }
    .ov-resize-handle[data-dir="se"] { bottom:0 !important; right:0 !important; width:8px !important; height:8px !important; cursor:se-resize !important; }

    /* ── Pill ── */
    #ov-pill {
      all: initial;
      position: fixed !important;
      bottom: 20px !important;
      right: 20px !important;
      z-index: 2147483646 !important;
      display: flex !important;
      align-items: center !important;
      gap: 8px !important;
      padding: 0 14px !important;
      height: 32px !important;
      background: #14161a !important;
      border: 1px solid #2a2f37 !important;
      border-radius: 16px !important;
      font-family: 'JetBrains Mono','IBM Plex Mono',ui-monospace,monospace !important;
      font-size: 11px !important;
      color: #d6dae0 !important;
      cursor: move !important;
      box-shadow: 0 4px 20px rgba(0,0,0,.55) !important;
      user-select: none !important;
    }
    #ov-pill[data-theme="light"] {
      background: #ffffff !important;
      border-color: #d9d4c4 !important;
      color: #1a1c20 !important;
      box-shadow: 0 4px 20px rgba(0,0,0,.18) !important;
    }
    .ov-pill-dot {
      width: 7px !important; height: 7px !important;
      border-radius: 50% !important;
      background: #4ec9b0 !important;
      flex-shrink: 0 !important;
    }
    .ov-pill-count { font-weight: 700 !important; font-size: 12px !important; }
    .ov-pill-label {
      color: #6a7180 !important;
      font-size: 9px !important;
      font-weight: 700 !important;
      letter-spacing: .06em !important;
      text-transform: uppercase !important;
    }
    .ov-pill-err { color: #ff5a6e !important; font-weight: 700 !important; font-size: 10px !important; }
    .ov-pill-rail { display: flex !important; gap: 2px !important; align-items: center !important; margin: 0 2px !important; }
    .ov-pill-tick {
      width: 3px !important; height: 12px !important;
      background: #2a2f37 !important;
      border-radius: 1px !important;
      flex-shrink: 0 !important;
    }
    .ov-pill-tick.ok { background: #4ec9b0 !important; }
    .ov-pill-tick.err { background: #ff5a6e !important; }
    .ov-pill-tick.warn { background: #d4a85e !important; }
    .ov-pill-tick.ws { background: #6ab0ff !important; }
    .ov-pill-expand {
      all: unset !important;
      cursor: pointer !important;
      font-size: 11px !important;
      color: #6a7180 !important;
      padding: 0 3px !important;
      line-height: 1 !important;
    }
    .ov-pill-expand:hover { color: #6ab0ff !important; }

    /* ── Ghost mode ── */
    .ov-ghost { opacity: 0.25 !important; transition: opacity 100ms !important; pointer-events: auto !important; }
    .ov-ghost:hover { opacity: 1 !important; }

    /* ── Host page highlights ── */
    .ov-highlighted {
      outline: 2px solid #6ab0ff !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 0 4px rgba(106,176,255,.15) !important;
    }
    .ov-value-match {
      outline: 1.5px dashed #ff6b8a !important;
      outline-offset: 2px !important;
    }
    .ov-value-current {
      outline: 2px solid #ff5a6e !important;
      outline-offset: 3px !important;
      box-shadow: 0 0 0 5px rgba(255,90,110,.18) !important;
    }

    /* ── Float badge cluster button ── */
    .ov-float-badge {
      position: absolute !important;
      z-index: 2147483645 !important;
      pointer-events: none !important;
      font-family: 'JetBrains Mono','IBM Plex Mono',ui-monospace,monospace !important;
    }
    .ov-fb-cluster {
      pointer-events: auto !important;
    }

    /* dark theme (default) */
    .ov-fb-cluster .ov-fb-circle {
      background: #14161a !important;
      color: #6ab0ff !important;
      border-color: #2a2f37 !important;
    }
    .ov-fb-cluster:hover .ov-fb-circle,
    .ov-fb-cluster.ov-fb-open .ov-fb-circle {
      background: #1a1d22 !important;
      color: #6ab0ff !important;
      border-color: #6ab0ff !important;
    }
    .ov-fb-cluster .ov-fb-popup {
      background: #14161a !important;
      border-color: #2a2f37 !important;
    }
    .ov-fb-cluster .ov-fb-url { color: #9aa1ab !important; }
    .ov-fb-cluster .ov-fb-s   { color: #6c727c !important; }

    /* light theme */
    .ov-fb-cluster[data-theme="light"] .ov-fb-circle {
      background: #ffffff !important;
      color: #2a6fdb !important;
      border-color: #d9d4c4 !important;
      box-shadow: 0 2px 8px rgba(0,0,0,.18) !important;
    }
    .ov-fb-cluster[data-theme="light"]:hover .ov-fb-circle,
    .ov-fb-cluster[data-theme="light"].ov-fb-open .ov-fb-circle {
      background: #f3f1ec !important;
      border-color: #2a6fdb !important;
    }
    .ov-fb-cluster[data-theme="light"] .ov-fb-popup {
      background: #ffffff !important;
      border-color: #d9d4c4 !important;
      box-shadow: 0 6px 20px rgba(0,0,0,.15) !important;
    }
    .ov-fb-cluster[data-theme="light"] .ov-fb-url { color: #4a4f59 !important; }
    .ov-fb-cluster[data-theme="light"] .ov-fb-s   { color: #6c727c !important; }

    /* Single-endpoint inline badge */
    .ov-fb-single {
      pointer-events: none !important;
      background: #14161a !important;
      border: 1px solid #2a2f37 !important;
      border-radius: 4px !important;
      box-shadow: 0 2px 8px rgba(0,0,0,.45) !important;
      animation: ov-fadein .15s ease !important;
    }
    .ov-fb-single .ov-fb-row { border-bottom: none !important; }
    .ov-fb-single .ov-fb-url { color: #9aa1ab !important; }
    .ov-fb-single .ov-fb-s   { color: #6c727c !important; }
    .ov-fb-single[data-theme="light"] {
      background: #ffffff !important;
      border-color: #d9d4c4 !important;
      box-shadow: 0 2px 8px rgba(0,0,0,.18) !important;
    }
    .ov-fb-single[data-theme="light"] .ov-fb-url { color: #4a4f59 !important; }
    .ov-fb-single[data-theme="light"] .ov-fb-s   { color: #6c727c !important; }

    .ov-fb-circle {
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 26px !important;
      height: 26px !important;
      border-radius: 50% !important;
      font-size: 11px !important;
      font-weight: 700 !important;
      cursor: pointer !important;
      box-shadow: 0 2px 8px rgba(0,0,0,.45) !important;
      border: 1.5px solid !important;
      user-select: none !important;
      animation: ov-fadein .15s ease !important;
      transition: background .12s, border-color .12s, transform .1s !important;
    }
    .ov-fb-cluster:hover .ov-fb-circle {
      transform: scale(1.1) !important;
    }

    /* popup panel — opens to the right of the circle */
    .ov-fb-popup {
      display: none !important;
      position: absolute !important;
      top: -4px !important;
      min-width: 230px !important;
      max-width: 340px !important;
      border-radius: 6px !important;
      box-shadow: 0 6px 20px rgba(0,0,0,.5) !important;
      padding: 4px 0 !important;
      animation: ov-fadein .12s ease !important;
      z-index: 2147483646 !important;
      border: 1px solid !important;
    }
    /* default: open to the right of the circle */
    .ov-fb-popup-right { left: 32px !important; right: auto !important; }
    /* flip: open to the left when circle is in the right half of the viewport */
    .ov-fb-popup-left  { right: 32px !important; left: auto !important; }
    .ov-fb-popup-show {
      display: block !important;
    }
    .ov-fb-row {
      display: flex !important;
      align-items: center !important;
      gap: 5px !important;
      padding: 5px 10px !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      border-bottom: 1px solid #1e2229 !important;
    }
    .ov-fb-cluster[data-theme="light"] .ov-fb-row {
      border-bottom-color: #ebe6d8 !important;
    }
    .ov-fb-row:last-child { border-bottom: none !important; }
    .ov-fb-m {
      font-weight: 700 !important;
      font-size: 9px !important;
      letter-spacing: .04em !important;
      padding: 1px 5px !important;
      border-radius: 2px !important;
      color: #fff !important;
      flex-shrink: 0 !important;
    }
    .ov-fb-m-get    { background: #1f6feb !important; }
    .ov-fb-m-post   { background: #7a3df0 !important; }
    .ov-fb-m-put    { background: #b8631a !important; }
    .ov-fb-m-patch  { background: #a6791f !important; }
    .ov-fb-m-delete { background: #d23158 !important; }
    .ov-fb-m-ws     { background: #1a8473 !important; }
    .ov-fb-url {
      font-size: 10px !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      flex: 1 1 0 !important;
      min-width: 0 !important;
    }
    .ov-fb-s {
      font-weight: 700 !important;
      font-size: 10px !important;
      flex-shrink: 0 !important;
    }
    .ov-fb-s-2 { color: #4ec9b0 !important; }
    .ov-fb-s-4 { color: #d4a85e !important; }
    .ov-fb-s-5 { color: #ff5a6e !important; }
    @keyframes ov-fadein {
      from { opacity:0; transform:translateY(4px); }
      to   { opacity:1; transform:translateY(0); }
    }

    /* ── Tooltips ── */
    #ov-panel [data-tip] { position: relative !important; }
    #ov-panel [data-tip]::after {
      content: attr(data-tip) !important;
      position: absolute !important;
      top: calc(100% + 7px) !important;
      left: 50% !important;
      transform: translateX(-50%) !important;
      background: var(--ov-bg-3) !important;
      color: var(--ov-text-dim) !important;
      border: 1px solid var(--ov-border) !important;
      border-radius: 2px !important;
      padding: 4px 8px !important;
      font-size: 9px !important;
      font-family: 'JetBrains Mono','IBM Plex Mono',ui-monospace,monospace !important;
      line-height: 1.5 !important;
      white-space: nowrap !important;
      pointer-events: none !important;
      opacity: 0 !important;
      transition: opacity 0.1s !important;
      z-index: 9999 !important;
    }
    #ov-panel [data-tip]::before {
      content: '' !important;
      position: absolute !important;
      top: calc(100% + 2px) !important;
      left: 50% !important;
      transform: translateX(-50%) !important;
      border: 4px solid transparent !important;
      border-bottom-color: var(--ov-border) !important;
      pointer-events: none !important;
      opacity: 0 !important;
      transition: opacity 0.1s !important;
      z-index: 9999 !important;
    }
    #ov-panel [data-tip]:hover::after { opacity: 1 !important; transition: opacity 0.15s 0.4s !important; }
    #ov-panel [data-tip]:hover::before { opacity: 1 !important; transition: opacity 0.15s 0.4s !important; }
    #ov-panel [data-tip][data-tip-pos="above"]::after {
      top: auto !important; bottom: calc(100% + 7px) !important;
    }
    #ov-panel [data-tip][data-tip-pos="above"]::before {
      top: auto !important; bottom: calc(100% + 2px) !important;
      border-bottom-color: transparent !important;
      border-top-color: var(--ov-border) !important;
    }
    #ov-panel [data-tip][data-tip-align="right"]::after { left: auto !important; right: 0 !important; transform: none !important; }
    #ov-panel [data-tip][data-tip-align="right"]::before { left: auto !important; right: 8px !important; transform: none !important; }
  `;
  document.documentElement.appendChild(s);
}

// ── Activation / deactivation ─────────────────────────────────────────────────

let injectedLoaded = false;

function activateOverlay(): void {
  if (activated) return;
  activated = true;
  cspBlocked = false;
  if (!injectedLoaded) {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('dist/injected.js');
    script.onload = () => { injectedLoaded = true; script.remove(); };
    script.onerror = () => { script.remove(); cspBlocked = true; renderList(); };
    (document.head || document.documentElement).prepend(script);
  } else {
    signalInjected('start');
  }

  const init = () => {
    loadTheme().then(theme => {
      currentTheme = theme;
      chrome.storage.local.get(['ovDockState', 'ovPinnedKeys', 'ovFilters'], result => {
        dockState = (result.ovDockState as DockState) || 'panel';
        if (Array.isArray(result.ovPinnedKeys)) {
          for (const k of result.ovPinnedKeys) pinnedKeys.add(k);
        }
        if (result.ovFilters) {
          const f = result.ovFilters as { status?: string[]; methods?: string[]; initiators?: string[] };
          if (f.status) for (const s of f.status) activeStatus.add(s);
          if (f.methods) for (const m of f.methods) activeMethods.add(m);
          if (f.initiators) for (const i of f.initiators) activeInitiators.add(i);
        }
if (dockState === 'pill') buildPill();
        else buildPanel();
      });
    });
  };

  clusterOutsideClickHandler = (e: MouseEvent) => {
    const target = e.target as Element | null;
    for (const badge of selectorBadges.values()) {
      if (!badge.classList.contains('ov-fb-open')) continue;
      if (!badge.contains(target)) {
        badge.classList.remove('ov-fb-open');
        refreshClusterBadge(badge.dataset.sel ?? '');
      }
    }
  };
  document.addEventListener('click', clusterOutsideClickHandler, true);

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
}

function deactivateOverlay(): void {
  if (!activated) return;
  activated = false;
  rowEventsBound = false;
  if (clusterOutsideClickHandler) {
    document.removeEventListener('click', clusterOutsideClickHandler, true);
    clusterOutsideClickHandler = null;
  }
  signalInjected('stop');
  cancelScheduledRender();
  document.getElementById('ov-panel')?.remove();
  document.getElementById('ov-pill')?.remove();
  document.getElementById('ov-styles')?.remove();
  filterInput = null;
  clearAllBadges();
  clearValueHighlights();
  clearBulkHighlights();
  requests.clear();
  expandedIds.clear();
  detailTabs.clear();
  pinnedIds.clear();
  activeStatus.clear();
  activeMethods.clear();
  activeInitiators.clear();
  paused = false;
  panelVisible = true;
  cspBlocked = false;
  dockState = 'panel';
  showPinTray = false;
  ghostHeld = false;
}

// ── Ghost mode ────────────────────────────────────────────────────────────────

window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key !== 'Alt' || ghostHeld) return;
  if (ghostTimer !== null) { clearTimeout(ghostTimer); ghostTimer = null; }
  ghostTimer = window.setTimeout(() => {
    ghostTimer = null;
    if (!ghostHeld) {
      ghostHeld = true;
      $('ov-panel')?.classList.add('ov-ghost');
      $('ov-pill')?.classList.add('ov-ghost');
    }
  }, 80);
});

window.addEventListener('keyup', (e: KeyboardEvent) => {
  if (e.key !== 'Alt') return;
  if (ghostTimer !== null) { clearTimeout(ghostTimer); ghostTimer = null; }
  ghostHeld = false;
  $('ov-panel')?.classList.remove('ov-ghost');
  $('ov-pill')?.classList.remove('ov-ghost');
});

// ── Host allowlist ────────────────────────────────────────────────────────────

function hostAllowed(allowedHosts: string[], current: string): boolean {
  if (!current) return false;
  return allowedHosts.some(h => h === current || current.endsWith('.' + h));
}

chrome.storage.local.get('ovAllowedHosts', ({ ovAllowedHosts }) => {
  if (hostAllowed((ovAllowedHosts as string[]) ?? [], location.hostname)) {
    activateOverlay();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.ovAllowedHosts) return;
  const next = (changes.ovAllowedHosts.newValue as string[] | undefined) ?? [];
  const shouldBeActive = hostAllowed(next, location.hostname);
  if (shouldBeActive && !activated) activateOverlay();
  else if (!shouldBeActive && activated) deactivateOverlay();
});
