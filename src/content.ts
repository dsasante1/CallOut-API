/// <reference types="chrome" />

interface ElementInfo {
  selector: string;
  label: string;
}

interface WsMessage {
  dir: 'sent' | 'recv';
  body: string;
  ts: number;
}

type RequestStatus = number | 'pending' | 'error' | 'closed';
type HeaderPair = [string, string];
type DetailTab = 'body' | 'headers';

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
  // Cached lowercase forms for body/url search. Recomputed when the source field
  // updates so a keystroke doesn't re-lowercase MB of bodies.
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
// JSON tree rendering + click-to-locate
const MAX_JSON_RENDER_CHARS = 4000;
const MAX_JSON_LEAF_LEN = 1000;
const MAX_VALUE_HIGHLIGHTS = 50;
const MIN_VALUE_LEN = 2;
const MIN_SUBSTRING_LEN = 4;

const requests = new Map<number, ApiRequest>();
const expandedIds = new Set<number>();
const badgeTimers = new Map<number, number>();
let panelVisible = true;
let activeHighlight: HTMLElement | null = null;
let paused = false;
let groupByDomain = false;
let currentTheme: 'dark' | 'light' = 'dark';
let activated = false;
let cspBlocked = false;
let renderScheduled = false;
let renderTimer: number | null = null;
let lastRenderTime = 0;
let filterInput: HTMLInputElement | null = null;
let methodFilterSelect: HTMLSelectElement | null = null;
let statusFilterSelect: HTMLSelectElement | null = null;
let caseSensitiveSearch = false;
let regexSearch = false;
// Active detail tab per expanded row. Absent = default 'body'.
const detailTabs = new Map<number, DetailTab>();

// Click-to-locate state for response JSON values. Persists across rerenders so a
// new request arriving doesn't blow away the user's active highlight.
let valueHighlightEls: HTMLElement[] = [];
let valueHighlightIndex = 0;
// Key shape: `${rowId}|${kind}|${encodedRawValue}` — reattached on rerender.
let valueHighlightKey = '';

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

// Use for data-driven renders that should freeze when the user pauses capture.
// User actions (row click, filter typing) call scheduleRender() directly so they
// still respond while paused.
function scheduleRenderUnlessPaused(): void {
  if (paused) return;
  scheduleRender();
}

function cancelScheduledRender(): void {
  if (renderTimer !== null) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
  renderScheduled = false;
}

function trimRequests(): void {
  if (requests.size <= MAX_REQUESTS) return;
  const overflow = requests.size - MAX_REQUESTS;
  const iter = requests.keys();
  for (let i = 0; i < overflow; i++) {
    const k = iter.next().value as number | undefined;
    if (k === undefined) break;
    requests.delete(k);
    expandedIds.delete(k);
    detailTabs.delete(k);
    const timer = badgeTimers.get(k);
    if (timer !== undefined) {
      clearTimeout(timer);
      badgeTimers.delete(k);
    }
    badges.get(k)?.remove();
    badges.delete(k);
  }
}

// Refresh cached lowercase forms after an incoming message updates url/body
// fields, so the search loop never lowercases bodies on every keystroke.
function refreshSearchCache(req: ApiRequest, msg: OverlayMessage): void {
  if (msg.url !== undefined) req._lcUrl = (req.url || '').toLowerCase();
  if (msg.reqBody !== undefined) req._lcReqBody = req.reqBody ? req.reqBody.toLowerCase() : '';
  if (msg.resBody !== undefined) req._lcResBody = req.resBody ? req.resBody.toLowerCase() : '';
}

window.addEventListener('message', (e: MessageEvent<OverlayMessage>) => {
  if (e.source !== window) return;
  if (!e.data?.__apiOverlay || !activated) return;
  const msg = e.data;

  if (msg.__wsMsg) {
    if (msg.wsId == null) return;
    const conn = requests.get(msg.wsId);
    if (conn) {
      if (!conn.messages) conn.messages = [];
      if (msg.dir && msg.body != null && msg.ts != null) {
        conn.messages.push({ dir: msg.dir, body: msg.body, ts: msg.ts });
      }
      // Trim in chunks so steady-state pushes are O(1), not O(n).
      if (conn.messages.length > WS_TRIM_TRIGGER) {
        conn.messages.splice(0, conn.messages.length - MAX_WS_MESSAGES_PER_CONN);
      }
      if (expandedIds.has(conn.id)) scheduleRenderUnlessPaused();
    }
    return;
  }

  if (msg.id == null) return;

  if (requests.has(msg.id)) {
    const existing = requests.get(msg.id)!;
    Object.assign(existing, msg);
    refreshSearchCache(existing, msg);
  } else {
    if (paused) return; // drop new captures only; keep merging updates to in-flight ones.
    const fresh = { ...msg } as ApiRequest;
    refreshSearchCache(fresh, msg);
    requests.set(msg.id, fresh);
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
      sendResponse({ visible: panelVisible, paused, theme: currentTheme, activated });
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
      clearAllBadges();
      clearValueHighlights();
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
      console.warn('[CalloutAPI] unknown action received:', msg.action);
      sendResponse({ ok: false });
  }
  // Synchronous response — do not return true (which would leave the channel open).
});

function setPaused(next: boolean): void {
  if (next === paused) return;
  const wasPaused = paused;
  paused = next;
  chrome.storage.local.set({ ovPaused: paused });
  signalInjected(paused ? 'pause' : 'resume');
  const btn = $('ov-pause');
  if (btn) btn.textContent = paused ? 'Resume' : 'Pause';
  if (wasPaused && !paused) {
    // On resume, render any updates that arrived while paused.
    renderList();
  }
}

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function applyTheme(theme: 'dark' | 'light'): void {
  currentTheme = theme;
  const panel = $('ov-panel');
  if (panel) panel.dataset.theme = theme;
  const btn = $('ov-theme');
  if (btn) btn.textContent = theme === 'dark' ? 'Light' : 'Dark';
}

function loadTheme(): Promise<'dark' | 'light'> {
  return new Promise(resolve => {
    chrome.storage.local.get('ovTheme', result => {
      resolve((result.ovTheme as 'dark' | 'light') || 'dark');
    });
  });
}

function buildPanel(): void {
  if ($('ov-panel')) return;

  injectStyles();

  const panel = document.createElement('div');
  panel.id = 'ov-panel';
  panel.dataset.theme = currentTheme;
  panel.innerHTML = `
    <div id="ov-header">
      <span id="ov-title">API Overlay <span id="ov-count" class="ov-badge">0</span></span>
      <div id="ov-actions">
        <button id="ov-theme">${currentTheme === 'dark' ? 'Light' : 'Dark'}</button>
        <button id="ov-pause">${paused ? 'Resume' : 'Pause'}</button>
        <button id="ov-export">Export HAR</button>
        <button id="ov-clear">Clear</button>
        <button id="ov-close">x</button>
      </div>
    </div>
    <div id="ov-filter-row">
      <input id="ov-filter" placeholder="Filter URL / body..." autocomplete="off" spellcheck="false"/>
      <button id="ov-case-toggle" title="Case-sensitive">Aa</button>
      <button id="ov-regex-toggle" title="Regex">.*</button>
      <select id="ov-method-filter">
        <option value="">All</option>
        <option>GET</option><option>POST</option><option>PUT</option>
        <option>DELETE</option><option>PATCH</option><option>WS</option>
      </select>
      <select id="ov-status-filter" title="Status">
        <option value="">Status</option>
        <option value="2xx">2xx</option>
        <option value="3xx">3xx</option>
        <option value="4xx">4xx</option>
        <option value="5xx">5xx</option>
        <option value="err">Errors</option>
      </select>
      <button id="ov-group-toggle">Group</button>
    </div>
    <div id="ov-list"></div>
    <div id="ov-footer">Click row to expand. Click a response value to find it on the page.</div>
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
  methodFilterSelect = $('ov-method-filter') as HTMLSelectElement;
  statusFilterSelect = $('ov-status-filter') as HTMLSelectElement;

  $('ov-close')!.onclick = () => {
    panel.style.setProperty('display', 'none', 'important');
    panelVisible = false;
    chrome.storage.local.set({ ovVisible: false });
  };
  $('ov-clear')!.onclick = () => { requests.clear(); expandedIds.clear(); detailTabs.clear(); clearAllBadges(); clearValueHighlights(); renderList(); };
  $('ov-pause')!.onclick = () => setPaused(!paused);
  $('ov-theme')!.onclick = () => {
    const next: 'dark' | 'light' = currentTheme === 'dark' ? 'light' : 'dark';
    chrome.storage.local.set({ ovTheme: next });
    applyTheme(next);
  };
  filterInput.oninput = () => scheduleRender();
  methodFilterSelect.onchange = renderList;
  statusFilterSelect.onchange = renderList;
  $('ov-export')!.onclick = exportHAR;
  $('ov-group-toggle')!.onclick = () => {
    groupByDomain = !groupByDomain;
    $('ov-group-toggle')!.classList.toggle('ov-active', groupByDomain);
    renderList();
  };
  const caseBtn = $('ov-case-toggle')!;
  const regexBtn = $('ov-regex-toggle')!;
  caseBtn.onclick = () => {
    caseSensitiveSearch = !caseSensitiveSearch;
    caseBtn.classList.toggle('ov-active', caseSensitiveSearch);
    renderList();
  };
  regexBtn.onclick = () => {
    regexSearch = !regexSearch;
    regexBtn.classList.toggle('ov-active', regexSearch);
    renderList();
  };

  makeDraggable(panel, $('ov-header')!);
  makeResizable(panel);
  const list = $('ov-list');
  if (list) bindListDelegation(list);
  renderList();
}

// The following helpers are duplicated in popup.ts (as popupEscHtml, normalizeHost, etc.)
// because the no-bundler tsc build (module: "None") emits each entry point as a
// standalone script — there's no shared module that all three (content/popup/injected)
// can import from. Keep changes here in sync with the copies in those files.
function escHtml(str: unknown): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const VALID_HTTP_METHODS = new Set([
  'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'WS'
]);

function safeMethodClass(method: string | null | undefined): string {
  const m = String(method ?? 'GET').toUpperCase();
  return VALID_HTTP_METHODS.has(m) ? m.toLowerCase() : 'unknown';
}

function formatBody(text: string | null | undefined): string {
  if (!text) return '';
  const t = text.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { /* fall through */ }
  }
  return text;
}

// Parse only if the payload looks like an object/array. Strings, numbers, bools
// at the top level are valid JSON but uninteresting as a clickable tree.
function tryParseJsonContainer(text: string | null | undefined): unknown | undefined {
  if (!text) return undefined;
  const t = text.trimStart();
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
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
  // unknown — render as JSON.stringify fallback so we don't drop data silently.
  try {
    const fallback = JSON.stringify(v);
    if (fallback !== undefined) { out.push(escHtml(fallback)); st.chars += fallback.length; }
  } catch { /* skip */ }
}

function writeJsonLeaf(out: string[], st: JsonRenderState, display: string, kind: string, raw: string): void {
  out.push(`<span class="ov-jv ov-jv-${kind}" data-ov-val="${encodeURIComponent(raw)}" data-ov-kind="${kind}">${display}</span>`);
  st.chars += display.length;
}

// Extract the first contiguous signed-decimal number from a text fragment and
// normalize it (drops commas, trims units). Returns '' when no number is found.
function normalizeNumber(s: string): string {
  const m = s.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return '';
  const n = Number(m[0]);
  return Number.isFinite(n) ? String(n) : '';
}

// Walk the host DOM for matches of `value`. Skips overlay-owned nodes. Caps
// results so a vague match (e.g. "OK", "true") can't blanket the page.
function findValuesInDom(value: string, kind: string): HTMLElement[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (kind === 'boolean' || kind === 'null') return []; // too ambiguous to be useful
  if (trimmed.length < MIN_VALUE_LEN) return [];

  const results: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  const ownedByOverlay = (el: Element | null): boolean =>
    !!el && (!!el.closest('#ov-panel') || el.classList.contains('ov-float-badge'));
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
  const row = jv.closest<HTMLElement>('.ov-row');
  const rowId = row?.dataset.id || '';
  const encVal = jv.dataset.ovVal || '';
  const kind = jv.dataset.ovKind || 'string';
  const key = `${rowId}|${kind}|${encVal}`;
  const value = decodeURIComponent(encVal);

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

// After renderList rebuilds the row HTML, restore the active span styling and
// the status badge. If the row collapsed or scrolled out of the limit, drop the
// on-page highlights entirely.
function reattachValueHighlight(): void {
  if (!valueHighlightKey) return;
  const parts = valueHighlightKey.split('|');
  if (parts.length < 3) return;
  const [rowId, kind, encVal] = parts;
  const span = document.querySelector<HTMLElement>(
    `#ov-list .ov-row[data-id="${rowId}"] .ov-jv[data-ov-kind="${kind}"][data-ov-val="${encVal}"]`
  );
  if (!span) {
    clearValueHighlights();
    return;
  }
  span.classList.add('ov-jv-active');
  setValueStatusBadge(span, valueHighlightEls.length, valueHighlightIndex);
}

function getHostname(url: string): string {
  try { return new URL(url).hostname; } catch { return 'unknown'; }
}

// Bucket for status filter + color badge: 'pending' | 'err' | '2xx' | '3xx' | '4xx' | '5xx'
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

function rowHtml(req: ApiRequest): string {
  const shortUrl = (() => {
    try {
      const u = new URL(req.url);
      return u.pathname + (u.search.length > 30 ? `${u.search.slice(0, 30)}...` : u.search);
    } catch { return req.url?.slice(0, 60) || ''; }
  })();

  const bucket = statusBucket(req);
  const statusLabel = req.status === 'pending' ? '...' : String(req.status);
  const triggerLabel = req.element?.label ? `"${req.element.label.slice(0, 45)}"` : 'background / auto';
  const isExpanded = expandedIds.has(req.id);
  const method = req.method || 'GET';
  const activeTab: DetailTab = detailTabs.get(req.id) || 'body';

  let detailHtml = '';
  if (isExpanded) {
    if (req.kind === 'ws') {
      const msgs = req.messages || [];
      detailHtml = `<div class="ov-detail">
        <div class="ov-detail-label">MESSAGES (${msgs.length})</div>
        <div class="ov-ws-thread">${
          msgs.length === 0
            ? '<div class="ov-body-none">No messages yet</div>'
            : msgs.slice(-100).map(m => `<div class="ov-ws-msg ov-ws-${m.dir}">
                <span class="ov-ws-dir">${m.dir === 'sent' ? 'S' : 'R'}</span>
                <pre class="ov-ws-body">${escHtml(m.body.slice(0, 500))}</pre>
              </div>`).join('')
        }</div>
      </div>`;
    } else {
      const tabsHtml = `<div class="ov-tabs" data-id="${req.id}">
        <button class="ov-tab${activeTab === 'body' ? ' ov-tab-active' : ''}" data-tab="body">Body</button>
        <button class="ov-tab${activeTab === 'headers' ? ' ov-tab-active' : ''}" data-tab="headers">Headers</button>
      </div>`;

      let paneHtml = '';
      if (activeTab === 'body') {
        const reqSection = req.reqBody
          ? `<div class="ov-detail-section">
              <div class="ov-detail-label">REQUEST BODY</div>
              <pre class="ov-body-pre">${escHtml(formatBody(req.reqBody).slice(0, 3000))}</pre>
            </div>` : '';

        let resBodyHtml: string;
        if (req.resBody != null) {
          const parsed = tryParseJsonContainer(req.resBody);
          resBodyHtml = parsed !== undefined
            ? `<div class="ov-body-json">${renderJsonHtml(parsed)}</div>`
            : `<pre class="ov-body-pre">${escHtml(formatBody(req.resBody).slice(0, 3000))}</pre>`;
        } else {
          resBodyHtml = '';
        }
        const resSection = req.resBody != null
          ? `<div class="ov-detail-section">
              <div class="ov-detail-label">RESPONSE BODY</div>
              ${resBodyHtml}
            </div>`
          : req.status === 'pending'
            ? `<div class="ov-detail-section"><div class="ov-detail-label">RESPONSE BODY</div><div class="ov-body-none">Waiting...</div></div>`
            : `<div class="ov-detail-section"><div class="ov-detail-label">RESPONSE BODY</div><div class="ov-body-none">No body captured</div></div>`;

        paneHtml = reqSection + resSection;
      } else {
        paneHtml = headerRowsHtml('REQUEST HEADERS', req.reqHeaders)
                 + headerRowsHtml('RESPONSE HEADERS', req.resHeaders);
      }

      detailHtml = `<div class="ov-detail">${tabsHtml}${paneHtml}</div>`;
    }
  }

  const wsMsgCount = req.kind === 'ws' && req.messages?.length
    ? `<span class="ov-ws-count">${req.messages.length} msg</span>`
    : '';

  return `<div class="ov-row${isExpanded ? ' ov-expanded' : ''}" data-id="${req.id}" data-sel="${encodeURIComponent(req.element?.selector || '')}">
    <div class="ov-row-main">
      <span class="ov-method m-${safeMethodClass(method)}">${escHtml(method)}</span>
      <div class="ov-info">
        <div class="ov-url" title="${escHtml(req.url || '')}">${escHtml(shortUrl)}</div>
        <div class="ov-meta">
          <span class="ov-status s-${bucket}">${statusLabel}</span>
          <span class="ov-ms">${req.ms != null ? `${req.ms}ms` : ''}</span>
          <span class="ov-kind">${req.kind?.toUpperCase() || ''}</span>
          ${wsMsgCount}
        </div>
        <div class="ov-trigger">${escHtml(triggerLabel)}</div>
      </div>
      <button class="ov-copy-btn" data-url="${encodeURIComponent(req.url || '')}" title="Copy URL">copy</button>
    </div>
    ${detailHtml}
  </div>`;
}

function renderList(): void {
  if (!activated) return;
  const list = $('ov-list');
  const countEl = $('ov-count');
  if (!list) return;

  if (cspBlocked) {
    list.innerHTML = `<div class="ov-empty" style="color:#ef5350">
      Capture script failed to load.<br><small>Likely blocked by the page's Content-Security-Policy. Reload the page to retry.</small>
    </div>`;
    if (countEl) countEl.textContent = '0';
    return;
  }

  const rawFilter = filterInput?.value || '';
  const filterText = caseSensitiveSearch ? rawFilter : rawFilter.toLowerCase();
  const filterMethod = methodFilterSelect?.value || '';
  const filterStatus = statusFilterSelect?.value || '';

  // Compile regex once per render (not per row). Invalid pattern = no rows shown,
  // and we flag the filter input so the user knows why.
  let regex: RegExp | null = null;
  let regexInvalid = false;
  if (regexSearch && rawFilter) {
    try { regex = new RegExp(rawFilter, caseSensitiveSearch ? '' : 'i'); }
    catch { regexInvalid = true; }
  }
  filterInput?.classList.toggle('ov-filter-invalid', regexInvalid);

  function matchesText(r: ApiRequest): boolean {
    if (!filterText) return true;
    if (regexInvalid) return false;
    if (regex) {
      return regex.test(r.url || '')
          || (r.reqBody != null && regex.test(r.reqBody))
          || (r.resBody != null && regex.test(r.resBody));
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
    if (!filterStatus) return true;
    const b = statusBucket(r);
    if (filterStatus === 'err') return b === 'err' || b === '4xx' || b === '5xx';
    return b === filterStatus;
  }

  // Walk insertion order once into a snapshot, then iterate that snapshot
  // backward (newest first) collecting matches until we hit RENDER_LIMIT.
  // Avoids the second pass that .reverse() + .filter() would do, and stops
  // early when the filter is narrow enough.
  const snapshot = Array.from(requests.values());
  const visible: ApiRequest[] = [];
  for (let i = snapshot.length - 1; i >= 0 && visible.length < RENDER_LIMIT; i--) {
    const r = snapshot[i];
    if (filterMethod && r.method !== filterMethod) continue;
    if (!matchesStatus(r)) continue;
    if (!matchesText(r)) continue;
    visible.push(r);
  }

  if (countEl) countEl.textContent = String(requests.size);

  if (visible.length === 0) {
    list.innerHTML = `<div class="ov-empty">${
      requests.size === 0
        ? 'No API calls captured yet.<br><small>Interact with the page to see calls appear here.</small>'
        : 'No results match your filter.'
    }</div>`;
    return;
  }

  if (groupByDomain) {
    const groups = new Map<string, ApiRequest[]>();
    for (const req of visible) {
      const host = getHostname(req.url);
      if (!groups.has(host)) groups.set(host, []);
      groups.get(host)!.push(req);
    }

    const pageHost = location.hostname;
    const sorted = [...groups.entries()].sort(([a], [b]) => {
      if (a === pageHost && b !== pageHost) return -1;
      if (b === pageHost && a !== pageHost) return 1;
      return a.localeCompare(b);
    });

    list.innerHTML = sorted.map(([host, reqs]) => {
      const fp = host === pageHost
        || host.endsWith('.' + pageHost)
        || pageHost.endsWith('.' + host);
      return `<div class="ov-domain-group">
        <div class="ov-domain-header ${fp ? 'ov-first-party' : 'ov-third-party'}">
          <span>${escHtml(host)}</span>
          <span class="ov-domain-count">${reqs.length}</span>
        </div>
        ${reqs.map(rowHtml).join('')}
      </div>`;
    }).join('');
  } else {
    list.innerHTML = visible.map(rowHtml).join('');
  }

  reattachValueHighlight();
}

let rowEventsBound = false;

function bindListDelegation(list: HTMLElement): void {
  if (rowEventsBound) return;
  rowEventsBound = true;

  list.addEventListener('mouseover', (e: Event) => {
    const row = (e.target as Element).closest<HTMLElement>('.ov-row');
    if (!row || !list.contains(row)) return;
    const related = (e as MouseEvent).relatedTarget as Element | null;
    if (related && row.contains(related)) return;
    const sel = decodeURIComponent(row.dataset.sel || '');
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
    const copyBtn = target.closest<HTMLElement>('.ov-copy-btn');
    if (copyBtn) {
      e.stopPropagation();
      const url = decodeURIComponent(copyBtn.dataset.url || '');
      const restore = (label: string) => {
        copyBtn.textContent = label;
        setTimeout(() => { copyBtn.textContent = 'copy'; }, 900);
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(url).then(
          () => restore('copied'),
          () => restore('failed')
        );
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
    } else {
      expandedIds.add(id);
    }
    scheduleRender();
  });
}

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
        method: r.method || 'GET',
        url: r.url || '',
        httpVersion: 'HTTP/1.1',
        headers: toHarHeaders(r.reqHeaders),
        queryString: parseQuery(r.url),
        cookies: [],
        headersSize: -1,
        bodySize: byteLen(r.reqBody),
        ...(r.reqBody ? { postData: { mimeType: detectMime(r.reqBody), text: r.reqBody } } : {})
      },
      response: {
        status: r.status as number,
        statusText: '',
        httpVersion: 'HTTP/1.1',
        headers: toHarHeaders(r.resHeaders),
        cookies: [],
        content: {
          size: byteLen(r.resBody),
          mimeType: detectMime(r.resBody),
          text: r.resBody || ''
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: byteLen(r.resBody)
      },
      cache: {},
      timings: { send: 0, wait: r.ms || 0, receive: 0 }
    }));

  const har = {
    log: {
      version: '1.2',
      creator: { name: 'API Overlay', version: '1.0' },
      pages: [],
      entries
    }
  };

  // Compact serialization — pretty-printing tens of MB blocks the main thread.
  const blob = new Blob([JSON.stringify(har)], { type: 'application/json' });
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = 'api-overlay-' + Date.now() + '.har';
  document.documentElement.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}

function highlightEl(selector: string): void {
  clearHighlight();
  try {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el || el.closest('#ov-panel')) return;
    el.classList.add('ov-highlighted');
    activeHighlight = el;
    const rect = el.getBoundingClientRect();
    const fullyVisible = rect.top >= 0 && rect.bottom <= window.innerHeight;
    if (!fullyVisible) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch { /* invalid selector */ }
}

function clearHighlight(): void {
  if (activeHighlight) {
    activeHighlight.classList.remove('ov-highlighted');
    activeHighlight = null;
  }
}

const badges = new Map<number, HTMLDivElement>();

function flashBadge(req: ApiRequest): void {
  if (!req.element?.selector) return;
  try {
    const el = document.querySelector(req.element.selector);
    if (!el || el.closest('#ov-panel')) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) return;

    const key = req.id;
    const existing = badges.get(key);
    if (existing) existing.remove();
    const prevTimer = badgeTimers.get(key);
    if (prevTimer !== undefined) clearTimeout(prevTimer);

    const badge = document.createElement('div');
    badge.className = 'ov-float-badge';
    badge.dataset.method = safeMethodClass(req.method);

    let label = req.url;
    try { label = new URL(req.url).pathname; } catch { /* use full url */ }
    badge.textContent = `${req.method} ${label}`;

    badge.style.cssText = `top:${window.scrollY + rect.top - 22}px;left:${window.scrollX + rect.left}px;`;
    document.documentElement.appendChild(badge);
    badges.set(key, badge);

    const timer = window.setTimeout(() => {
      badge.remove();
      badges.delete(key);
      badgeTimers.delete(key);
    }, 5000);
    badgeTimers.set(key, timer);
  } catch { /* invalid selector */ }
}

function clearAllBadges(): void {
  for (const b of badges.values()) b.remove();
  for (const t of badgeTimers.values()) clearTimeout(t);
  badges.clear();
  badgeTimers.clear();
  for (const b of document.querySelectorAll('.ov-float-badge')) b.remove();
}

function signalInjected(action: 'pause' | 'resume' | 'stop' | 'start'): void {
  window.postMessage({ __apiOverlayControl: true, action }, '*');
}

function makeDraggable(panel: HTMLElement, handle: HTMLElement): void {
  let ox = 0;
  let oy = 0;
  handle.addEventListener('mousedown', (e: MouseEvent) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    e.preventDefault();
    ox = e.clientX - panel.getBoundingClientRect().left;
    oy = e.clientY - panel.getBoundingClientRect().top;
    const move = (ev: MouseEvent) => {
      panel.style.left = (ev.clientX - ox) + 'px';
      panel.style.top = (ev.clientY - oy) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
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

    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = rect.left;
    const startTop = rect.top;
    const startW = rect.width;
    const startH = rect.height;

    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let left = startLeft, top = startTop, w = startW, h = startH;

      if (dir.includes('e')) w = Math.min(window.innerWidth * 0.95, Math.max(320, startW + dx));
      if (dir.includes('s')) h = Math.min(window.innerHeight * 0.95, Math.max(240, startH + dy));
      if (dir.includes('w')) {
        const clampedDx = Math.min(startW - 320, dx);
        w = startW - clampedDx;
        left = startLeft + clampedDx;
      }
      if (dir.includes('n')) {
        const clampedDy = Math.min(startH - 240, dy);
        h = startH - clampedDy;
        top = startTop + clampedDy;
      }

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

function injectStyles(): void {
  if ($('ov-styles')) return;
  const s = document.createElement('style');
  s.id = 'ov-styles';
  s.textContent = `
    #ov-panel {
      all: initial;
      /* ── dark theme variables (default) ── */
      --ov-bg:               #12121f;
      --ov-hdr:              #0d0d1c;
      --ov-border:           #2a2a45;
      --ov-filter-bg:        #0f0f20;
      --ov-filter-border:    #1e1e38;
      --ov-text:             #dde1f0;
      --ov-text-dim:         #9fa8da;
      --ov-text-muted:       #607d8b;
      --ov-text-faint:       #555;
      --ov-title:            #c8cfff;
      --ov-badge-bg:         #3a3a6a;
      --ov-badge-fg:         #9fa8da;
      --ov-btn-bg:           #1e1e38;
      --ov-btn-hover:        #2e2e52;
      --ov-input-bg:         #1a1a30;
      --ov-input-border:     #2e2e52;
      --ov-row-bg:           #181830;
      --ov-row-hover:        #1e1e45;
      --ov-row-expanded:     #1a1a40;
      --ov-pre-bg:           #0a0a18;
      --ov-pre-border:       #1e1e38;
      --ov-pre-text:         #a5d6a7;
      --ov-ws-text:          #c5cae9;
      --ov-url-text:         #c5cae9;
      --ov-trigger:          #5c6bc0;
      --ov-detail-lbl:       #5c6bc0;
      --ov-copy-btn:         #3a3a6a;
      --ov-grp-act-bg:       #2a2a6a;
      --ov-grp-act-brd:      #5c6bc0;
      --ov-grp-act-fg:       #c5cae9;
      --ov-scrollbar:        #2e2e52;
      --ov-fp-bg:            #1a2a3a;
      --ov-fp-fg:            #64b5f6;
      --ov-tp-bg:            #2a1a2e;
      --ov-tp-fg:            #ce93d8;
      --ov-shadow:           rgba(0,0,0,.55);
      --ov-domain-count-bg:  rgba(255,255,255,.08);
      position: fixed !important;
      bottom: 20px !important;
      right: 20px !important;
      width: 440px !important;
      height: 620px !important;
      min-width: 320px !important;
      min-height: 240px !important;
      max-width: 95vw !important;
      max-height: 95vh !important;
      background: var(--ov-bg) !important;
      color: var(--ov-text) !important;
      border-radius: 14px !important;
      box-shadow: 0 12px 40px var(--ov-shadow) !important;
      z-index: 2147483647 !important;
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace !important;
      font-size: 12px !important;
      display: flex !important;
      flex-direction: column !important;
      overflow: hidden !important;
      border: 1px solid var(--ov-border) !important;
    }
    /* ── light theme variable overrides ── */
    #ov-panel[data-theme="light"] {
      --ov-bg:               #f5f5fb;
      --ov-hdr:              #eaeaf7;
      --ov-border:           #d0d0e8;
      --ov-filter-bg:        #ededf5;
      --ov-filter-border:    #c5c5e0;
      --ov-text:             #1a1a2e;
      --ov-text-dim:         #4a4a7a;
      --ov-text-muted:       #546e7a;
      --ov-text-faint:       #999;
      --ov-title:            #3a3a7a;
      --ov-badge-bg:         #d0d0ee;
      --ov-badge-fg:         #4a4a8a;
      --ov-btn-bg:           #e0e0f0;
      --ov-btn-hover:        #c8c8e8;
      --ov-input-bg:         #f0f0fa;
      --ov-input-border:     #c0c0e0;
      --ov-row-bg:           #ffffff;
      --ov-row-hover:        #f0f0fa;
      --ov-row-expanded:     #eeeef8;
      --ov-pre-bg:           #f8f8ff;
      --ov-pre-border:       #d0d0e8;
      --ov-pre-text:         #2e7d32;
      --ov-ws-text:          #2a2a4a;
      --ov-url-text:         #3a3a6a;
      --ov-trigger:          #5c6bc0;
      --ov-detail-lbl:       #5c6bc0;
      --ov-copy-btn:         #aaaacc;
      --ov-grp-act-bg:       #ddddf0;
      --ov-grp-act-brd:      #5c6bc0;
      --ov-grp-act-fg:       #3a3a7a;
      --ov-scrollbar:        #c0c0e0;
      --ov-fp-bg:            #e0edf8;
      --ov-fp-fg:            #1565c0;
      --ov-tp-bg:            #f0e0f5;
      --ov-tp-fg:            #6a1b9a;
      --ov-shadow:           rgba(0,0,0,.15);
      --ov-domain-count-bg:  rgba(0,0,0,.08);
    }
    #ov-header {
      display: flex !important;
      justify-content: space-between !important;
      align-items: center !important;
      padding: 10px 14px !important;
      background: var(--ov-hdr) !important;
      cursor: move !important;
      user-select: none !important;
      border-bottom: 1px solid var(--ov-border) !important;
      flex-shrink: 0 !important;
    }
    #ov-title {
      font-weight: 700 !important;
      font-size: 13px !important;
      color: var(--ov-title) !important;
      letter-spacing: .02em !important;
    }
    .ov-badge {
      background: var(--ov-badge-bg) !important;
      color: var(--ov-badge-fg) !important;
      padding: 1px 7px !important;
      border-radius: 10px !important;
      font-size: 10px !important;
      font-weight: 600 !important;
      margin-left: 6px !important;
    }
    #ov-actions { display: flex !important; gap: 5px !important; }
    #ov-actions button {
      all: unset !important;
      background: var(--ov-btn-bg) !important;
      color: var(--ov-text-dim) !important;
      padding: 3px 9px !important;
      border-radius: 5px !important;
      cursor: pointer !important;
      font-size: 11px !important;
      font-family: inherit !important;
      transition: background .15s !important;
      white-space: nowrap !important;
    }
    #ov-actions button:hover { background: var(--ov-btn-hover) !important; color: var(--ov-text) !important; }
    #ov-theme {
      border: 1px solid var(--ov-border) !important;
    }
    #ov-filter-row {
      display: flex !important;
      gap: 6px !important;
      padding: 8px 10px !important;
      background: var(--ov-filter-bg) !important;
      border-bottom: 1px solid var(--ov-filter-border) !important;
      flex-shrink: 0 !important;
      align-items: center !important;
    }
    #ov-filter, #ov-method-filter, #ov-status-filter {
      all: unset !important;
      background: var(--ov-input-bg) !important;
      border: 1px solid var(--ov-input-border) !important;
      color: var(--ov-text) !important;
      padding: 4px 8px !important;
      border-radius: 6px !important;
      font-size: 11px !important;
      font-family: inherit !important;
    }
    #ov-filter { flex: 1 !important; min-width: 60px !important; }
    #ov-filter.ov-filter-invalid {
      border-color: #ef5350 !important;
      color: #ef5350 !important;
    }
    #ov-method-filter { width: 68px !important; }
    #ov-status-filter { width: 64px !important; }
    #ov-group-toggle, #ov-case-toggle, #ov-regex-toggle {
      all: unset !important;
      background: var(--ov-input-bg) !important;
      border: 1px solid var(--ov-input-border) !important;
      color: var(--ov-text-dim) !important;
      padding: 4px 8px !important;
      border-radius: 6px !important;
      font-size: 11px !important;
      font-family: inherit !important;
      cursor: pointer !important;
      white-space: nowrap !important;
    }
    #ov-case-toggle, #ov-regex-toggle {
      padding: 4px 6px !important;
      font-weight: 700 !important;
      letter-spacing: 0 !important;
    }
    #ov-group-toggle:hover, #ov-case-toggle:hover, #ov-regex-toggle:hover {
      background: var(--ov-btn-hover) !important; color: var(--ov-text) !important;
    }
    #ov-group-toggle.ov-active, #ov-case-toggle.ov-active, #ov-regex-toggle.ov-active {
      background: var(--ov-grp-act-bg) !important;
      border-color: var(--ov-grp-act-brd) !important;
      color: var(--ov-grp-act-fg) !important;
    }
    #ov-list {
      overflow-y: auto !important;
      flex: 1 !important;
      padding: 6px !important;
    }
    #ov-list::-webkit-scrollbar { width: 12px !important; }
    #ov-list::-webkit-scrollbar-track { background: var(--ov-bg) !important; border-radius: 6px !important; }
    #ov-list::-webkit-scrollbar-thumb { background: var(--ov-scrollbar) !important; border-radius: 6px !important; border: 2px solid var(--ov-bg) !important; }
    #ov-footer {
      padding: 5px 12px !important;
      font-size: 10px !important;
      color: var(--ov-text-faint) !important;
      border-top: 1px solid var(--ov-filter-border) !important;
      text-align: center !important;
      flex-shrink: 0 !important;
    }
    .ov-resize-handle {
      position: absolute !important;
      z-index: 10 !important;
    }
    .ov-resize-handle[data-dir="n"]  { top:0 !important; left:12px !important; right:12px !important; height:5px !important; cursor:n-resize !important; }
    .ov-resize-handle[data-dir="s"]  { bottom:0 !important; left:12px !important; right:12px !important; height:5px !important; cursor:s-resize !important; }
    .ov-resize-handle[data-dir="e"]  { top:12px !important; right:0 !important; bottom:12px !important; width:5px !important; cursor:e-resize !important; }
    .ov-resize-handle[data-dir="w"]  { top:12px !important; left:0 !important; bottom:12px !important; width:5px !important; cursor:w-resize !important; }
    .ov-resize-handle[data-dir="nw"] { top:0 !important; left:0 !important; width:12px !important; height:12px !important; cursor:nw-resize !important; border-top-left-radius:14px !important; }
    .ov-resize-handle[data-dir="ne"] { top:0 !important; right:0 !important; width:12px !important; height:12px !important; cursor:ne-resize !important; border-top-right-radius:14px !important; }
    .ov-resize-handle[data-dir="sw"] { bottom:0 !important; left:0 !important; width:12px !important; height:12px !important; cursor:sw-resize !important; border-bottom-left-radius:14px !important; }
    .ov-resize-handle[data-dir="se"] { bottom:0 !important; right:0 !important; width:12px !important; height:12px !important; cursor:se-resize !important; border-bottom-right-radius:14px !important; }
    .ov-empty {
      color: var(--ov-text-faint) !important;
      text-align: center !important;
      padding: 30px 10px !important;
      line-height: 1.7 !important;
    }
    .ov-domain-group { margin-bottom: 6px !important; }
    .ov-domain-header {
      display: flex !important;
      justify-content: space-between !important;
      align-items: center !important;
      padding: 4px 8px !important;
      font-size: 10px !important;
      font-weight: 700 !important;
      border-radius: 5px !important;
      margin-bottom: 3px !important;
      letter-spacing: .04em !important;
    }
    .ov-first-party { background: var(--ov-fp-bg) !important; color: var(--ov-fp-fg) !important; }
    .ov-third-party { background: var(--ov-tp-bg) !important; color: var(--ov-tp-fg) !important; }
    .ov-domain-count {
      background: var(--ov-domain-count-bg) !important;
      padding: 1px 6px !important;
      border-radius: 8px !important;
      font-size: 9px !important;
    }
    .ov-row {
      display: flex !important;
      flex-direction: column !important;
      padding: 7px 8px !important;
      margin: 2px 0 !important;
      background: var(--ov-row-bg) !important;
      border-radius: 8px !important;
      cursor: pointer !important;
      border-left: 3px solid transparent !important;
      transition: background .12s, border-color .12s !important;
    }
    .ov-row:hover { background: var(--ov-row-hover) !important; border-left-color: #5c6bc0 !important; }
    .ov-row.ov-expanded { background: var(--ov-row-expanded) !important; border-left-color: #5c6bc0 !important; }
    .ov-row-main {
      display: flex !important;
      align-items: flex-start !important;
      gap: 8px !important;
      width: 100% !important;
    }
    .ov-method {
      all: unset !important;
      font-size: 9px !important;
      font-weight: 700 !important;
      padding: 3px 6px !important;
      border-radius: 4px !important;
      white-space: nowrap !important;
      flex-shrink: 0 !important;
      letter-spacing: .04em !important;
      margin-top: 2px !important;
      font-family: inherit !important;
    }
    .m-get    { background:#1565c0 !important; color:#90caf9 !important; }
    .m-post   { background:#1b5e20 !important; color:#a5d6a7 !important; }
    .m-put    { background:#bf360c !important; color:#ffccbc !important; }
    .m-delete { background:#b71c1c !important; color:#ef9a9a !important; }
    .m-patch  { background:#4a148c !important; color:#ce93d8 !important; }
    .m-ws     { background:#005f5f !important; color:#80deea !important; }
    .m-head, .m-options { background:#263238 !important; color:#b0bec5 !important; }
    .ov-info { flex: 1 !important; overflow: hidden !important; min-width: 0 !important; }
    .ov-url {
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      color: var(--ov-url-text) !important;
      font-size: 11px !important;
    }
    .ov-meta {
      display: flex !important;
      gap: 8px !important;
      margin-top: 3px !important;
      font-size: 10px !important;
      color: var(--ov-text-muted) !important;
      align-items: center !important;
    }
    .ov-status {
      font-weight: 700 !important;
      padding: 1px 5px !important;
      border-radius: 3px !important;
      min-width: 28px !important;
      text-align: center !important;
      display: inline-block !important;
    }
    .ov-status.s-2xx     { color: #a5d6a7 !important; background: rgba(102,187,106,.15) !important; }
    .ov-status.s-3xx     { color: #ffcc80 !important; background: rgba(255,167,38,.15) !important; }
    .ov-status.s-4xx     { color: #ffab91 !important; background: rgba(255,112,67,.18) !important; }
    .ov-status.s-5xx     { color: #ef9a9a !important; background: rgba(239,83,80,.2) !important; }
    .ov-status.s-err     { color: #ef5350 !important; background: rgba(239,83,80,.15) !important; }
    .ov-status.s-pending { color: #ffa726 !important; background: rgba(255,167,38,.12) !important; }
    .ov-ms {
      color: var(--ov-text-muted) !important;
      display: inline-block !important;
      min-width: 44px !important;
      text-align: right !important;
      font-variant-numeric: tabular-nums !important;
    }
    .ov-kind { color: var(--ov-text-faint) !important; }
    .ov-ws-count { color: #80deea !important; }
    .ov-trigger {
      font-size: 10px !important;
      color: var(--ov-trigger) !important;
      margin-top: 3px !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
    }
    .ov-copy-btn {
      all: unset !important;
      font-size: 9px !important;
      font-family: inherit !important;
      color: var(--ov-copy-btn) !important;
      padding: 2px 6px !important;
      border-radius: 3px !important;
      cursor: pointer !important;
      flex-shrink: 0 !important;
      margin-top: 2px !important;
      transition: background .12s, color .12s !important;
    }
    .ov-copy-btn:hover { background: var(--ov-btn-bg) !important; color: var(--ov-text-dim) !important; }
    .ov-detail {
      margin-top: 8px !important;
      border-top: 1px solid var(--ov-border) !important;
      padding-top: 8px !important;
    }
    .ov-detail-section { margin-bottom: 8px !important; }
    .ov-tabs {
      display: flex !important;
      gap: 4px !important;
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
    }
    .ov-tab:hover { color: var(--ov-text) !important; }
    .ov-tab.ov-tab-active {
      color: var(--ov-detail-lbl) !important;
      border-bottom-color: var(--ov-detail-lbl) !important;
    }
    .ov-hdr-table {
      background: var(--ov-pre-bg) !important;
      border: 1px solid var(--ov-pre-border) !important;
      border-radius: 4px !important;
      padding: 4px 0 !important;
      max-height: 180px !important;
      overflow-y: auto !important;
    }
    .ov-hdr-table::-webkit-scrollbar { width: 12px !important; }
    .ov-hdr-table::-webkit-scrollbar-thumb { background: var(--ov-scrollbar) !important; }
    .ov-hdr-row {
      display: flex !important;
      gap: 8px !important;
      padding: 2px 8px !important;
      font-size: 10px !important;
      line-height: 1.4 !important;
      align-items: baseline !important;
    }
    .ov-hdr-row:hover { background: var(--ov-row-hover) !important; }
    .ov-hdr-name {
      color: var(--ov-detail-lbl) !important;
      font-weight: 700 !important;
      flex-shrink: 0 !important;
      min-width: 110px !important;
      max-width: 180px !important;
      word-break: break-all !important;
    }
    .ov-hdr-val {
      color: var(--ov-ws-text) !important;
      word-break: break-all !important;
      flex: 1 !important;
    }
    .ov-detail-label {
      font-size: 9px !important;
      font-weight: 700 !important;
      color: var(--ov-detail-lbl) !important;
      letter-spacing: .06em !important;
      margin-bottom: 4px !important;
    }
    .ov-body-pre {
      all: unset !important;
      display: block !important;
      background: var(--ov-pre-bg) !important;
      border: 1px solid var(--ov-pre-border) !important;
      border-radius: 4px !important;
      padding: 6px 8px !important;
      font-size: 10px !important;
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace !important;
      color: var(--ov-pre-text) !important;
      white-space: pre-wrap !important;
      word-break: break-all !important;
      max-height: 150px !important;
      overflow-y: auto !important;
    }
    .ov-body-pre::-webkit-scrollbar { width: 12px !important; }
    .ov-body-pre::-webkit-scrollbar-thumb { background: var(--ov-scrollbar) !important; }
    .ov-body-json {
      display: block !important;
      background: var(--ov-pre-bg) !important;
      border: 1px solid var(--ov-pre-border) !important;
      border-radius: 4px !important;
      padding: 6px 8px !important;
      font-size: 10px !important;
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace !important;
      color: var(--ov-text) !important;
      white-space: pre-wrap !important;
      word-break: break-all !important;
      max-height: 220px !important;
      overflow-y: auto !important;
    }
    .ov-body-json::-webkit-scrollbar { width: 5px !important; }
    .ov-body-json::-webkit-scrollbar-thumb { background: var(--ov-scrollbar) !important; }
    .ov-jk { color: #82aaff !important; }
    .ov-jv {
      cursor: pointer !important;
      border-radius: 2px !important;
      padding: 0 1px !important;
      transition: background .1s !important;
    }
    .ov-jv-string  { color: #c3e88d !important; }
    .ov-jv-number  { color: #f78c6c !important; }
    .ov-jv-boolean { color: #c792ea !important; }
    .ov-jv-null    { color: #c792ea !important; font-style: italic !important; }
    .ov-jv:hover { background: rgba(124,170,255,.18) !important; }
    .ov-jv.ov-jv-active {
      background: rgba(255,64,129,.22) !important;
      box-shadow: inset 0 0 0 1px #ff4081 !important;
    }
    .ov-jv-trunc { color: var(--ov-text-faint) !important; font-style: italic !important; }
    .ov-value-status {
      display: inline-block !important;
      margin-left: 6px !important;
      padding: 0 6px !important;
      background: #ff4081 !important;
      color: #fff !important;
      border-radius: 8px !important;
      font-size: 9px !important;
      font-weight: 700 !important;
      letter-spacing: .03em !important;
      vertical-align: middle !important;
    }
    .ov-value-status[data-empty="1"] { background: #555 !important; }
    #ov-panel[data-theme="light"] .ov-body-json { color: var(--ov-text) !important; }
    #ov-panel[data-theme="light"] .ov-jk { color: #3949ab !important; }
    #ov-panel[data-theme="light"] .ov-jv-string  { color: #2e7d32 !important; }
    #ov-panel[data-theme="light"] .ov-jv-number  { color: #d84315 !important; }
    #ov-panel[data-theme="light"] .ov-jv-boolean { color: #6a1b9a !important; }
    #ov-panel[data-theme="light"] .ov-jv-null    { color: #6a1b9a !important; }
    .ov-value-match {
      outline: 1.5px dashed #ff80ab !important;
      outline-offset: 2px !important;
    }
    .ov-value-current {
      outline: 2.5px solid #ff4081 !important;
      outline-offset: 3px !important;
      box-shadow: 0 0 0 5px rgba(255,64,129,.18) !important;
    }
    .ov-body-none {
      font-size: 10px !important;
      color: var(--ov-text-faint) !important;
      font-style: italic !important;
    }
    .ov-ws-thread {
      max-height: 200px !important;
      overflow-y: auto !important;
    }
    .ov-ws-thread::-webkit-scrollbar { width: 12px !important; }
    .ov-ws-thread::-webkit-scrollbar-thumb { background: var(--ov-scrollbar) !important; }
    .ov-ws-msg {
      display: flex !important;
      gap: 6px !important;
      margin: 3px 0 !important;
      align-items: flex-start !important;
    }
    .ov-ws-dir {
      font-size: 9px !important;
      font-weight: 700 !important;
      padding: 2px 5px !important;
      border-radius: 3px !important;
      flex-shrink: 0 !important;
    }
    .ov-ws-sent .ov-ws-dir { background: #1b5e20 !important; color: #a5d6a7 !important; }
    .ov-ws-recv .ov-ws-dir { background: #1565c0 !important; color: #90caf9 !important; }
    .ov-ws-body {
      all: unset !important;
      display: block !important;
      font-size: 10px !important;
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace !important;
      color: var(--ov-ws-text) !important;
      white-space: pre-wrap !important;
      word-break: break-all !important;
      flex: 1 !important;
    }
    .ov-highlighted {
      outline: 2.5px solid #ff4081 !important;
      outline-offset: 3px !important;
      box-shadow: 0 0 0 5px rgba(255,64,129,.15) !important;
    }
    .ov-float-badge {
      position: absolute !important;
      color: #fff !important;
      font-size: 10px !important;
      font-family: 'SF Mono', monospace !important;
      font-weight: 700 !important;
      padding: 2px 7px !important;
      border-radius: 10px !important;
      z-index: 2147483646 !important;
      pointer-events: none !important;
      white-space: nowrap !important;
      max-width: 220px !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      box-shadow: 0 2px 8px rgba(0,0,0,.4) !important;
      animation: ov-fadein .2s ease !important;
    }
    .ov-float-badge[data-method="get"]    { background: #1565c0 !important; }
    .ov-float-badge[data-method="post"]   { background: #2e7d32 !important; }
    .ov-float-badge[data-method="put"]    { background: #e64a19 !important; }
    .ov-float-badge[data-method="delete"] { background: #c62828 !important; }
    .ov-float-badge[data-method="patch"]  { background: #6a1b9a !important; }
    .ov-float-badge                       { background: #37474f !important; }
    @keyframes ov-fadein {
      from { opacity:0; transform:translateY(4px); }
      to   { opacity:1; transform:translateY(0); }
    }
  `;
  document.documentElement.appendChild(s);
}

let injectedLoaded = false;

function activateOverlay(): void {
  if (activated) return;
  activated = true;
  cspBlocked = false;
  if (!injectedLoaded) {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('dist/injected.js');
    script.onload = () => {
      injectedLoaded = true;
      script.remove();
    };
    script.onerror = () => {
      // Page CSP refused chrome-extension: scripts; surface a clear notice.
      script.remove();
      cspBlocked = true;
      renderList();
    };
    (document.head || document.documentElement).prepend(script);
  } else {
    // Injected script already loaded from a previous activation — wake it up.
    signalInjected('start');
  }
  if (document.body) {
    loadTheme().then(theme => { currentTheme = theme; buildPanel(); });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      loadTheme().then(theme => { currentTheme = theme; buildPanel(); });
    }, { once: true });
  }
}

function deactivateOverlay(): void {
  if (!activated) return;
  activated = false;
  rowEventsBound = false;
  signalInjected('stop');
  cancelScheduledRender();
  document.getElementById('ov-panel')?.remove();
  document.getElementById('ov-styles')?.remove();
  filterInput = null;
  methodFilterSelect = null;
  statusFilterSelect = null;
  clearAllBadges();
  clearValueHighlights();
  requests.clear();
  expandedIds.clear();
  detailTabs.clear();
  // Reset UI state so a fresh re-activation isn't silently paused / hidden.
  paused = false;
  panelVisible = true;
  cspBlocked = false;
}

// "example.com" matches example.com and any subdomain (api.example.com, www.example.com),
// but "www.example.com" does not match example.com — narrower entries stay narrow.
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
