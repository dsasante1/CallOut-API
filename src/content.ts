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
  messages?: WsMessage[];
  ms?: number;
}

interface OverlayMessage extends Partial<ApiRequest> {
  __apiOverlay?: boolean;
  __wsMsg?: boolean;
  wsId?: number;
  dir?: 'sent' | 'recv';
  body?: string;
}

const script = document.createElement('script');
script.src = chrome.runtime.getURL('dist/injected.js');
(document.head || document.documentElement).prepend(script);

const requests = new Map<number, ApiRequest>();
const expandedIds = new Set<number>();
let panelVisible = true;
let activeHighlight: HTMLElement | null = null;
let paused = false;
let groupByDomain = false;
let currentTheme: 'dark' | 'light' = 'dark';

window.addEventListener('message', (e: MessageEvent<OverlayMessage>) => {
  if (!e.data?.__apiOverlay || paused) return;
  const msg = e.data;

  if (msg.__wsMsg) {
    const conn = requests.get(msg.wsId!);
    if (conn) {
      if (!conn.messages) conn.messages = [];
      conn.messages.push({ dir: msg.dir!, body: msg.body!, ts: msg.ts! });
      renderList();
    }
    return;
  }

  if (requests.has(msg.id!)) {
    Object.assign(requests.get(msg.id!)!, msg);
  } else {
    requests.set(msg.id!, { ...msg } as ApiRequest);
  }

  renderList();

  if (msg.element?.selector && msg.status !== 'pending') {
    flashBadge(requests.get(msg.id!)!);
  }
});

chrome.runtime.onMessage.addListener((msg: { action: string; value?: unknown }, _sender, sendResponse) => {
  if (msg.action === 'get-state') {
    sendResponse({ visible: panelVisible, paused, theme: currentTheme });
    return true;
  }
  if (msg.action === 'toggle') {
    panelVisible = !panelVisible;
    chrome.storage.local.set({ ovVisible: panelVisible });
    const panel = $('ov-panel');
    if (panel) panel.style.setProperty('display', panelVisible ? 'flex' : 'none', 'important');
  }
  if (msg.action === 'pause') {
    paused = (msg.value as boolean) ?? false;
    chrome.storage.local.set({ ovPaused: paused });
    const btn = $('ov-pause');
    if (btn) btn.textContent = paused ? 'Resume' : 'Pause';
  }
  if (msg.action === 'clear') {
    requests.clear();
    expandedIds.clear();
    clearAllBadges();
    renderList();
  }
  if (msg.action === 'export-har') {
    exportHAR();
  }
  if (msg.action === 'theme') {
    const theme = msg.value as 'dark' | 'light';
    if (theme === 'dark' || theme === 'light') {
      chrome.storage.local.set({ ovTheme: theme });
      applyTheme(theme);
    }
  }
});

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
        <button id="ov-pause">Pause</button>
        <button id="ov-export">Export HAR</button>
        <button id="ov-clear">Clear</button>
        <button id="ov-close">x</button>
      </div>
    </div>
    <div id="ov-filter-row">
      <input id="ov-filter" placeholder="Filter by URL..." autocomplete="off" spellcheck="false"/>
      <select id="ov-method-filter">
        <option value="">All</option>
        <option>GET</option><option>POST</option><option>PUT</option>
        <option>DELETE</option><option>PATCH</option><option>WS</option>
      </select>
      <button id="ov-group-toggle">Group</button>
    </div>
    <div id="ov-list"></div>
    <div id="ov-footer">Click row to expand payload. Hover to highlight trigger element.</div>
  `;
  document.documentElement.appendChild(panel);

  $('ov-close')!.onclick = () => {
    panel.style.setProperty('display', 'none', 'important');
    panelVisible = false;
    chrome.storage.local.set({ ovVisible: false });
  };
  $('ov-clear')!.onclick = () => { requests.clear(); expandedIds.clear(); clearAllBadges(); renderList(); };
  $('ov-pause')!.onclick = () => {
    paused = !paused;
    $('ov-pause')!.textContent = paused ? 'Resume' : 'Pause';
    chrome.storage.local.set({ ovPaused: paused });
  };
  $('ov-theme')!.onclick = () => {
    const next: 'dark' | 'light' = currentTheme === 'dark' ? 'light' : 'dark';
    chrome.storage.local.set({ ovTheme: next });
    applyTheme(next);
  };
  ($('ov-filter') as HTMLInputElement).oninput = renderList;
  ($('ov-method-filter') as HTMLSelectElement).onchange = renderList;
  $('ov-export')!.onclick = exportHAR;
  $('ov-group-toggle')!.onclick = () => {
    groupByDomain = !groupByDomain;
    $('ov-group-toggle')!.classList.toggle('ov-active', groupByDomain);
    renderList();
  };

  makeDraggable(panel, $('ov-header')!);
  renderList();
}

function escHtml(str: unknown): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBody(text: string | null | undefined): string {
  if (!text) return '';
  const t = text.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { /* fall through */ }
  }
  return text;
}

function getHostname(url: string): string {
  try { return new URL(url).hostname; } catch { return 'unknown'; }
}

function rowHtml(req: ApiRequest): string {
  const shortUrl = (() => {
    try {
      const u = new URL(req.url);
      return u.pathname + (u.search.length > 30 ? u.search.slice(0, 30) + '...' : u.search);
    } catch { return req.url?.slice(0, 60) || ''; }
  })();

  const statusClass = req.status === 'pending' ? 'pending'
    : (req.status === 'error' || req.status === 'closed') ? 'err'
    : (req.kind === 'ws' && req.status === 101) ? 'ok'
    : (typeof req.status === 'number' && req.status >= 200 && req.status < 400) ? 'ok' : 'err';

  const statusLabel = req.status === 'pending' ? '...' : String(req.status);
  const triggerLabel = req.element?.label ? `"${req.element.label.slice(0, 45)}"` : 'background / auto';
  const isExpanded = expandedIds.has(req.id);
  const method = req.method || 'GET';

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
      const reqSection = req.reqBody
        ? `<div class="ov-detail-section">
            <div class="ov-detail-label">REQUEST BODY</div>
            <pre class="ov-body-pre">${escHtml(formatBody(req.reqBody).slice(0, 3000))}</pre>
          </div>` : '';

      const resSection = req.resBody != null
        ? `<div class="ov-detail-section">
            <div class="ov-detail-label">RESPONSE BODY</div>
            <pre class="ov-body-pre">${escHtml(formatBody(req.resBody).slice(0, 3000))}</pre>
          </div>`
        : req.status === 'pending'
          ? `<div class="ov-detail-section"><div class="ov-detail-label">RESPONSE BODY</div><div class="ov-body-none">Waiting...</div></div>`
          : `<div class="ov-detail-section"><div class="ov-detail-label">RESPONSE BODY</div><div class="ov-body-none">No body captured</div></div>`;

      detailHtml = `<div class="ov-detail">${reqSection}${resSection}</div>`;
    }
  }

  const wsMsgCount = req.kind === 'ws' && req.messages?.length
    ? `<span class="ov-ws-count">${req.messages.length} msg</span>`
    : '';

  return `<div class="ov-row${isExpanded ? ' ov-expanded' : ''}" data-id="${req.id}" data-sel="${encodeURIComponent(req.element?.selector || '')}">
    <div class="ov-row-main">
      <span class="ov-method m-${method.toLowerCase()}">${escHtml(method)}</span>
      <div class="ov-info">
        <div class="ov-url" title="${escHtml(req.url || '')}">${escHtml(shortUrl)}</div>
        <div class="ov-meta">
          <span class="ov-status ${statusClass}">${statusLabel}</span>
          ${req.ms ? `<span class="ov-ms">${req.ms}ms</span>` : ''}
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
  const list = $('ov-list');
  const countEl = $('ov-count');
  if (!list) return;

  const filterText = (($('ov-filter') as HTMLInputElement)?.value || '').toLowerCase();
  const filterMethod = ($('ov-method-filter') as HTMLSelectElement)?.value || '';

  let items = [...requests.values()].reverse();
  if (filterText) items = items.filter(r => r.url?.toLowerCase().includes(filterText));
  if (filterMethod) items = items.filter(r => r.method === filterMethod);

  if (countEl) countEl.textContent = String(requests.size);

  if (items.length === 0) {
    list.innerHTML = `<div class="ov-empty">${
      requests.size === 0
        ? 'No API calls captured yet.<br><small>Interact with the page to see calls appear here.</small>'
        : 'No results match your filter.'
    }</div>`;
    return;
  }

  const visible = items.slice(0, 200);

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

  attachRowEvents(list);
}

function attachRowEvents(list: HTMLElement): void {
  list.querySelectorAll<HTMLElement>('.ov-row').forEach(row => {
    row.addEventListener('mouseenter', () => {
      const sel = decodeURIComponent(row.dataset.sel || '');
      if (sel) highlightEl(sel);
    });
    row.addEventListener('mouseleave', clearHighlight);

    const main = row.querySelector('.ov-row-main');
    if (main) {
      main.addEventListener('click', (e: Event) => {
        if ((e.target as Element).closest('.ov-copy-btn')) return;
        const id = Number(row.dataset.id);
        if (expandedIds.has(id)) expandedIds.delete(id);
        else expandedIds.add(id);
        renderList();
      });
    }
  });

  list.querySelectorAll<HTMLElement>('.ov-copy-btn').forEach(btn => {
    btn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      const url = decodeURIComponent(btn.dataset.url || '');
      navigator.clipboard?.writeText(url).catch(() => {});
      btn.textContent = 'copied';
      setTimeout(() => { btn.textContent = 'copy'; }, 700);
    });
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

  const entries = [...requests.values()]
    .filter(r => r.kind !== 'ws' && typeof r.status === 'number')
    .map(r => ({
      startedDateTime: new Date(r.ts || Date.now()).toISOString(),
      time: r.ms || 0,
      request: {
        method: r.method || 'GET',
        url: r.url || '',
        httpVersion: 'HTTP/1.1',
        headers: [],
        queryString: parseQuery(r.url),
        cookies: [],
        headersSize: -1,
        bodySize: r.reqBody ? r.reqBody.length : -1,
        ...(r.reqBody ? { postData: { mimeType: detectMime(r.reqBody), text: r.reqBody } } : {})
      },
      response: {
        status: r.status as number,
        statusText: '',
        httpVersion: 'HTTP/1.1',
        headers: [],
        cookies: [],
        content: {
          size: r.resBody ? r.resBody.length : -1,
          mimeType: detectMime(r.resBody),
          text: r.resBody || ''
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: r.resBody ? r.resBody.length : -1
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

  const blob = new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' });
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
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
    if (badges.has(key)) badges.get(key)!.remove();

    const badge = document.createElement('div');
    badge.className = 'ov-float-badge';
    badge.dataset.method = req.method?.toLowerCase();

    let label = req.url;
    try { label = new URL(req.url).pathname; } catch { /* use full url */ }
    badge.textContent = `${req.method} ${label}`;

    badge.style.cssText = `top:${window.scrollY + rect.top - 22}px;left:${window.scrollX + rect.left}px;`;
    document.documentElement.appendChild(badge);
    badges.set(key, badge);

    setTimeout(() => { badge.remove(); badges.delete(key); }, 5000);
  } catch { /* invalid selector */ }
}

function clearAllBadges(): void {
  for (const b of badges.values()) b.remove();
  badges.clear();
  for (const b of document.querySelectorAll('.ov-float-badge')) b.remove();
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
      max-height: 620px !important;
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
    #ov-filter, #ov-method-filter {
      all: unset !important;
      background: var(--ov-input-bg) !important;
      border: 1px solid var(--ov-input-border) !important;
      color: var(--ov-text) !important;
      padding: 4px 8px !important;
      border-radius: 6px !important;
      font-size: 11px !important;
      font-family: inherit !important;
    }
    #ov-filter { flex: 1 !important; }
    #ov-method-filter { width: 72px !important; }
    #ov-group-toggle {
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
    #ov-group-toggle:hover { background: var(--ov-btn-hover) !important; color: var(--ov-text) !important; }
    #ov-group-toggle.ov-active {
      background: var(--ov-grp-act-bg) !important;
      border-color: var(--ov-grp-act-brd) !important;
      color: var(--ov-grp-act-fg) !important;
    }
    #ov-list {
      overflow-y: auto !important;
      flex: 1 !important;
      padding: 6px !important;
    }
    #ov-list::-webkit-scrollbar { width: 4px !important; }
    #ov-list::-webkit-scrollbar-track { background: var(--ov-bg) !important; }
    #ov-list::-webkit-scrollbar-thumb { background: var(--ov-scrollbar) !important; border-radius: 4px !important; }
    #ov-footer {
      padding: 5px 12px !important;
      font-size: 10px !important;
      color: var(--ov-text-faint) !important;
      border-top: 1px solid var(--ov-filter-border) !important;
      text-align: center !important;
      flex-shrink: 0 !important;
    }
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
    .ov-status { font-weight: 700 !important; }
    .ov-status.ok      { color: #66bb6a !important; }
    .ov-status.err     { color: #ef5350 !important; }
    .ov-status.pending { color: #ffa726 !important; }
    .ov-ms { color: var(--ov-text-muted) !important; }
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
    .ov-body-pre::-webkit-scrollbar { width: 3px !important; }
    .ov-body-pre::-webkit-scrollbar-thumb { background: var(--ov-scrollbar) !important; }
    .ov-body-none {
      font-size: 10px !important;
      color: var(--ov-text-faint) !important;
      font-style: italic !important;
    }
    .ov-ws-thread {
      max-height: 200px !important;
      overflow-y: auto !important;
    }
    .ov-ws-thread::-webkit-scrollbar { width: 3px !important; }
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

if (document.body) {
  loadTheme().then(theme => { currentTheme = theme; buildPanel(); });
} else {
  document.addEventListener('DOMContentLoaded', () => {
    loadTheme().then(theme => { currentTheme = theme; buildPanel(); });
  }, { once: true });
}
