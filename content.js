// ── Inject the interceptor into the page's MAIN world ─────────────────────
const script = document.createElement('script');
script.src = chrome.runtime.getURL('injected.js');
(document.head || document.documentElement).prepend(script);

// ── State ──────────────────────────────────────────────────────────────────
const requests = new Map(); // id → request object
let panelVisible = true;
let activeHighlight = null;
let paused = false;

// ── Listen to interceptor messages ────────────────────────────────────────
window.addEventListener('message', e => {
  if (!e.data?.__apiOverlay || paused) return;
  const req = e.data;

  if (requests.has(req.id)) {
    // Update existing (pending → resolved)
    Object.assign(requests.get(req.id), req);
  } else {
    requests.set(req.id, { ...req });
  }

  renderList();

  if (req.element?.selector && req.status !== 'pending') {
    flashBadge(req);
  }
});

// ── Listen to popup messages ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener(msg => {
  if (msg.action === 'toggle') {
    panelVisible = !panelVisible;
    const panel = $('ov-panel');
    if (panel) panel.style.display = panelVisible ? 'flex' : 'none';
  }
  if (msg.action === 'pause') {
    paused = msg.value;
    const btn = $('ov-pause');
    if (btn) btn.textContent = paused ? '▶ Resume' : '⏸ Pause';
  }
  if (msg.action === 'clear') {
    requests.clear();
    clearAllBadges();
    renderList();
  }
});

function $(id) { return document.getElementById(id); }

// ── Build panel once ───────────────────────────────────────────────────────
function buildPanel() {
  if ($('ov-panel')) return;

  injectStyles();

  const panel = document.createElement('div');
  panel.id = 'ov-panel';
  panel.innerHTML = `
    <div id="ov-header">
      <span id="ov-title">🔌 API Overlay <span id="ov-count" class="ov-badge">0</span></span>
      <div id="ov-actions">
        <button id="ov-pause">⏸ Pause</button>
        <button id="ov-clear">🗑 Clear</button>
        <button id="ov-close">✕</button>
      </div>
    </div>
    <div id="ov-filter-row">
      <input id="ov-filter" placeholder="Filter by URL…" autocomplete="off" spellcheck="false"/>
      <select id="ov-method-filter">
        <option value="">All</option>
        <option>GET</option><option>POST</option><option>PUT</option>
        <option>DELETE</option><option>PATCH</option>
      </select>
    </div>
    <div id="ov-list"></div>
    <div id="ov-footer">Hover a row to highlight its trigger element</div>
  `;
  document.documentElement.appendChild(panel);

  $('ov-close').onclick = () => { panel.style.display = 'none'; panelVisible = false; };
  $('ov-clear').onclick = () => { requests.clear(); clearAllBadges(); renderList(); };
  $('ov-pause').onclick = () => {
    paused = !paused;
    $('ov-pause').textContent = paused ? '▶ Resume' : '⏸ Pause';
  };
  $('ov-filter').oninput = renderList;
  $('ov-method-filter').onchange = renderList;

  makeDraggable(panel, $('ov-header'));
  renderList();
}

// ── Render the request list ────────────────────────────────────────────────
function renderList() {
  const list = $('ov-list');
  const countEl = $('ov-count');
  if (!list) return;

  const filterText = ($('ov-filter')?.value || '').toLowerCase();
  const filterMethod = ($('ov-method-filter')?.value || '');

  let items = [...requests.values()].reverse();
  if (filterText) items = items.filter(r => r.url?.toLowerCase().includes(filterText));
  if (filterMethod) items = items.filter(r => r.method === filterMethod);

  if (countEl) countEl.textContent = requests.size;

  if (items.length === 0) {
    list.innerHTML = `<div class="ov-empty">
      ${requests.size === 0 ? 'No API calls captured yet.<br><small>Interact with the page to see calls appear here.</small>' : 'No results match your filter.'}
    </div>`;
    return;
  }

  list.innerHTML = items.slice(0, 100).map(req => {
    const shortUrl = (() => {
      try { const u = new URL(req.url); return u.pathname + (u.search.length > 30 ? u.search.slice(0,30)+'…' : u.search); }
      catch { return req.url?.slice(0, 60) || ''; }
    })();

    const statusClass = req.status === 'pending' ? 'pending'
      : req.status === 'error' ? 'err'
      : (req.status >= 200 && req.status < 400) ? 'ok' : 'err';

    const statusLabel = req.status === 'pending' ? '…' : String(req.status);
    const triggerLabel = req.element?.label
      ? `↑ "${req.element.label.slice(0, 45)}"`
      : '↑ background / auto';

    return `<div class="ov-row" data-id="${req.id}" data-sel="${encodeURIComponent(req.element?.selector||'')}">
      <span class="ov-method m-${req.method?.toLowerCase()}">${req.method}</span>
      <div class="ov-info">
        <div class="ov-url" title="${req.url}">${shortUrl}</div>
        <div class="ov-meta">
          <span class="ov-status ${statusClass}">${statusLabel}</span>
          ${req.ms ? `<span class="ov-ms">${req.ms}ms</span>` : ''}
          <span class="ov-kind">${req.kind?.toUpperCase()}</span>
        </div>
        <div class="ov-trigger">${triggerLabel}</div>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.ov-row').forEach(row => {
    row.addEventListener('mouseenter', () => {
      const sel = decodeURIComponent(row.dataset.sel || '');
      if (sel) highlightEl(sel);
    });
    row.addEventListener('mouseleave', clearHighlight);
    row.addEventListener('click', () => {
      const req = requests.get(Number(row.dataset.id));
      if (req?.url) navigator.clipboard?.writeText(req.url).catch(()=>{});
      row.classList.add('ov-copied');
      setTimeout(() => row.classList.remove('ov-copied'), 700);
    });
  });
}

// ── Element highlight on hover ─────────────────────────────────────────────
function highlightEl(selector) {
  clearHighlight();
  try {
    const el = document.querySelector(selector);
    if (!el || el.closest('#ov-panel')) return;
    el.classList.add('ov-highlighted');
    activeHighlight = el;
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch {}
}

function clearHighlight() {
  if (activeHighlight) {
    activeHighlight.classList.remove('ov-highlighted');
    activeHighlight = null;
  }
}

// ── Floating badges on page ────────────────────────────────────────────────
const badges = new Map();

function flashBadge(req) {
  if (!req.element?.selector) return;
  try {
    const el = document.querySelector(req.element.selector);
    if (!el || el.closest('#ov-panel')) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) return;

    const key = req.id;
    if (badges.has(key)) badges.get(key).remove();

    const badge = document.createElement('div');
    badge.className = 'ov-float-badge';
    badge.dataset.method = req.method?.toLowerCase();

    let label = req.url;
    try { label = new URL(req.url).pathname; } catch {}
    badge.textContent = `${req.method} ${label}`;

    badge.style.cssText = `
      top:${window.scrollY + rect.top - 22}px;
      left:${window.scrollX + rect.left}px;
    `;
    document.documentElement.appendChild(badge);
    badges.set(key, badge);

    setTimeout(() => { badge.remove(); badges.delete(key); }, 5000);
  } catch {}
}

function clearAllBadges() {
  badges.forEach(b => b.remove());
  badges.clear();
  document.querySelectorAll('.ov-float-badge').forEach(b => b.remove());
}

// ── Draggable ──────────────────────────────────────────────────────────────
function makeDraggable(panel, handle) {
  let ox, oy;
  handle.addEventListener('mousedown', e => {
    if (e.target.tagName === 'BUTTON') return;
    e.preventDefault();
    ox = e.clientX - panel.getBoundingClientRect().left;
    oy = e.clientY - panel.getBoundingClientRect().top;
    const move = ev => {
      panel.style.left = (ev.clientX - ox) + 'px';
      panel.style.top = (ev.clientY - oy) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

// ── Styles ─────────────────────────────────────────────────────────────────
function injectStyles() {
  if ($('ov-styles')) return;
  const s = document.createElement('style');
  s.id = 'ov-styles';
  s.textContent = `
    #ov-panel {
      all: initial;
      position: fixed !important;
      bottom: 20px !important;
      right: 20px !important;
      width: 400px !important;
      max-height: 520px !important;
      background: #12121f !important;
      color: #dde1f0 !important;
      border-radius: 14px !important;
      box-shadow: 0 12px 40px rgba(0,0,0,.55) !important;
      z-index: 2147483647 !important;
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace !important;
      font-size: 12px !important;
      display: flex !important;
      flex-direction: column !important;
      overflow: hidden !important;
      border: 1px solid #2a2a45 !important;
    }
    #ov-header {
      display: flex !important;
      justify-content: space-between !important;
      align-items: center !important;
      padding: 10px 14px !important;
      background: #0d0d1c !important;
      cursor: move !important;
      user-select: none !important;
      border-bottom: 1px solid #2a2a45 !important;
      flex-shrink: 0 !important;
    }
    #ov-title {
      font-weight: 700 !important;
      font-size: 13px !important;
      color: #c8cfff !important;
      letter-spacing: .02em !important;
    }
    .ov-badge {
      background: #3a3a6a !important;
      color: #9fa8da !important;
      padding: 1px 7px !important;
      border-radius: 10px !important;
      font-size: 10px !important;
      font-weight: 600 !important;
      margin-left: 6px !important;
    }
    #ov-actions { display: flex !important; gap: 5px !important; }
    #ov-actions button {
      all: unset !important;
      background: #1e1e38 !important;
      color: #9fa8da !important;
      padding: 3px 9px !important;
      border-radius: 5px !important;
      cursor: pointer !important;
      font-size: 11px !important;
      font-family: inherit !important;
      transition: background .15s !important;
      white-space: nowrap !important;
    }
    #ov-actions button:hover { background: #2e2e52 !important; color: #fff !important; }

    #ov-filter-row {
      display: flex !important;
      gap: 6px !important;
      padding: 8px 10px !important;
      background: #0f0f20 !important;
      border-bottom: 1px solid #1e1e38 !important;
      flex-shrink: 0 !important;
    }
    #ov-filter, #ov-method-filter {
      all: unset !important;
      background: #1a1a30 !important;
      border: 1px solid #2e2e52 !important;
      color: #dde1f0 !important;
      padding: 4px 8px !important;
      border-radius: 6px !important;
      font-size: 11px !important;
      font-family: inherit !important;
    }
    #ov-filter { flex: 1 !important; }
    #ov-method-filter { width: 72px !important; }

    #ov-list {
      overflow-y: auto !important;
      flex: 1 !important;
      padding: 6px !important;
    }
    #ov-list::-webkit-scrollbar { width: 4px !important; }
    #ov-list::-webkit-scrollbar-track { background: #12121f !important; }
    #ov-list::-webkit-scrollbar-thumb { background: #2e2e52 !important; border-radius: 4px !important; }

    #ov-footer {
      padding: 5px 12px !important;
      font-size: 10px !important;
      color: #555 !important;
      border-top: 1px solid #1e1e38 !important;
      text-align: center !important;
      flex-shrink: 0 !important;
    }

    .ov-empty {
      color: #555 !important;
      text-align: center !important;
      padding: 30px 10px !important;
      line-height: 1.7 !important;
    }

    .ov-row {
      display: flex !important;
      align-items: flex-start !important;
      gap: 8px !important;
      padding: 7px 8px !important;
      margin: 2px 0 !important;
      background: #181830 !important;
      border-radius: 8px !important;
      cursor: pointer !important;
      border-left: 3px solid transparent !important;
      transition: background .12s, border-color .12s !important;
    }
    .ov-row:hover { background: #1e1e45 !important; border-left-color: #5c6bc0 !important; }
    .ov-row.ov-copied { background: #1a3a1a !important; border-left-color: #66bb6a !important; }

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
    .m-head, .m-options { background:#263238 !important; color:#b0bec5 !important; }

    .ov-info { flex: 1 !important; overflow: hidden !important; min-width: 0 !important; }
    .ov-url {
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      color: #c5cae9 !important;
      font-size: 11px !important;
    }
    .ov-meta {
      display: flex !important;
      gap: 8px !important;
      margin-top: 3px !important;
      font-size: 10px !important;
      color: #607d8b !important;
      align-items: center !important;
    }
    .ov-status { font-weight: 700 !important; }
    .ov-status.ok      { color: #66bb6a !important; }
    .ov-status.err     { color: #ef5350 !important; }
    .ov-status.pending { color: #ffa726 !important; }
    .ov-ms { color: #78909c !important; }
    .ov-kind { color: #455a64 !important; }
    .ov-trigger {
      font-size: 10px !important;
      color: #5c6bc0 !important;
      margin-top: 3px !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
    }

    /* Highlight outline on trigger elements */
    .ov-highlighted {
      outline: 2.5px solid #ff4081 !important;
      outline-offset: 3px !important;
      box-shadow: 0 0 0 5px rgba(255,64,129,.15) !important;
    }

    /* Floating badges above elements */
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

// ── Init ───────────────────────────────────────────────────────────────────
if (document.body) {
  buildPanel();
} else {
  document.addEventListener('DOMContentLoaded', buildPanel, { once: true });
}
