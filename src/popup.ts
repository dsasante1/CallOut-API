/// <reference types="chrome" />

let visible = true;
let capturePaused = false;
let popupTheme: 'dark' | 'light' = 'dark';
let siteEnabled = false;
let allowedHosts: string[] = [];
let currentHostname = '';
// Popup is bound to one tab/window for its lifetime — cache the id at init to
// avoid re-querying chrome.tabs on every click.
let currentTabId: number | null = null;

function sendMessageSafe(tabId: number, message: Record<string, unknown>): Promise<unknown | null> {
  return new Promise(resolve => {
    try {
      chrome.tabs.sendMessage(tabId, message, response => {
        void chrome.runtime.lastError;
        resolve(response ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function send(action: string, extra: Record<string, unknown> = {}): Promise<void> {
  if (currentTabId != null) await sendMessageSafe(currentTabId, { action, ...extra });
}

function popupEscHtml(str: unknown): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeHost(raw: string): string {
  const trimmed = raw.trim().toLowerCase().replace(/\.+$/, '');
  if (!trimmed) return '';
  try {
    const withScheme = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(withScheme).hostname.replace(/\.+$/, '');
  } catch {
    return /^[a-z0-9.-]+$/.test(trimmed) ? trimmed : '';
  }
}

// "example.com" matches example.com and any subdomain; narrower entries don't widen.
function popupHostAllowed(allowedHosts: string[], current: string): boolean {
  if (!current) return false;
  return allowedHosts.some(h => h === current || current.endsWith(`.${h}`));
}

function applyPopupTheme(theme: 'dark' | 'light'): void {
  popupTheme = theme;
  document.body.dataset.theme = theme;
  btnTheme.textContent = theme === 'dark' ? 'Light Theme' : 'Dark Theme';
}

function applyVisibleState(v: boolean): void {
  visible = v;
  btnToggle.textContent = v ? 'Hide Panel' : 'Show Panel';
  updateDot();
}

function applyPausedState(p: boolean): void {
  capturePaused = p;
  btnPause.textContent = p ? 'Resume Capture' : 'Pause Capture';
}

const btnTheme = document.getElementById('btn-theme') as HTMLButtonElement;
const btnToggle = document.getElementById('btn-toggle') as HTMLButtonElement;
const btnPause = document.getElementById('btn-pause') as HTMLButtonElement;
const dot = document.getElementById('dot') as HTMLElement;
const hostInput = document.getElementById('host-input') as HTMLInputElement;
const btnAddHost = document.getElementById('btn-add-host') as HTMLButtonElement;
const controlsSection = document.getElementById('controls-section') as HTMLDivElement;

function updateDot(): void {
  dot.className = `dot${(visible && siteEnabled) ? '' : ' off'}`;
}

function updateControlsState(): void {
  controlsSection.classList.toggle('disabled', !siteEnabled);
}

function getTabHostname(tab: chrome.tabs.Tab | undefined): string {
  try { return tab?.url ? new URL(tab.url).hostname : ''; } catch { return ''; }
}

function renderHostList(): void {
  const list = document.getElementById('host-list');
  if (!list) return;
  if (allowedHosts.length === 0) {
    list.innerHTML = '<div class="host-empty">No sites added yet</div>';
    return;
  }
  list.innerHTML = allowedHosts
    .map((h, i) => {
      const safe = popupEscHtml(h);
      return `<div class="host-item">
        <span class="host-name" title="${safe}">${safe}</span>
        <button class="host-remove" data-index="${i}" title="Remove">×</button>
      </div>`;
    })
    .join('');
}

function bindHostListDelegation(): void {
  const list = document.getElementById('host-list');
  if (!list) return;
  list.addEventListener('click', async (e: Event) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>('.host-remove');
    if (!btn) return;
    const idx = Number(btn.dataset.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= allowedHosts.length) return;
    allowedHosts.splice(idx, 1);
    await chrome.storage.local.set({ ovAllowedHosts: allowedHosts });
    renderHostList();
    const stillAllowed = popupHostAllowed(allowedHosts, currentHostname);
    if (siteEnabled && !stillAllowed) {
      siteEnabled = false;
      updateControlsState();
      updateDot();
      if (currentTabId != null) await sendMessageSafe(currentTabId, { action: 'deactivate' });
    }
  });
}

async function init(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id ?? null;
  currentHostname = getTabHostname(tab);
  if (currentHostname) hostInput.value = currentHostname;

  allowedHosts = await new Promise<string[]>(resolve => {
    chrome.storage.local.get('ovAllowedHosts', ({ ovAllowedHosts }) => {
      resolve((ovAllowedHosts as string[]) ?? []);
    });
  });

  siteEnabled = popupHostAllowed(allowedHosts, currentHostname);
  updateControlsState();
  renderHostList();
  bindHostListDelegation();

  let synced = false;
  if (currentTabId != null) {
    const response = await sendMessageSafe(currentTabId, { action: 'get-state' }) as
      { visible?: boolean; paused?: boolean; theme?: 'dark' | 'light' } | null;
    if (response) {
      applyPopupTheme(response.theme || 'dark');
      applyVisibleState(response.visible !== false);
      applyPausedState(response.paused === true);
      synced = true;
    }
  }

  if (!synced) {
    await new Promise<void>(resolve => {
      chrome.storage.local.get(['ovTheme', 'ovVisible', 'ovPaused'], ({ ovTheme, ovVisible, ovPaused }) => {
        applyPopupTheme((ovTheme as 'dark' | 'light') || 'dark');
        applyVisibleState(ovVisible !== false);
        applyPausedState(ovPaused === true);
        resolve();
      });
    });
  }

  updateDot();
}

void init();

btnTheme.addEventListener('click', async () => {
  const next: 'dark' | 'light' = popupTheme === 'dark' ? 'light' : 'dark';
  applyPopupTheme(next);
  await send('theme', { value: next });
});

btnToggle.addEventListener('click', async () => {
  const prev = visible;
  visible = !visible;
  applyVisibleState(visible);
  if (currentTabId != null) {
    const ok = await sendMessageSafe(currentTabId, { action: 'toggle' });
    if (ok === null) {
      visible = prev;
      applyVisibleState(visible);
    }
  }
});

btnPause.addEventListener('click', async () => {
  const prev = capturePaused;
  capturePaused = !capturePaused;
  applyPausedState(capturePaused);
  if (currentTabId != null) {
    const ok = await sendMessageSafe(currentTabId, { action: 'pause', value: capturePaused });
    if (ok === null) {
      capturePaused = prev;
      applyPausedState(capturePaused);
    }
  }
});

(document.getElementById('btn-export') as HTMLButtonElement).addEventListener('click', () => send('export-har'));
(document.getElementById('btn-clear') as HTMLButtonElement).addEventListener('click', () => send('clear'));

btnAddHost.addEventListener('click', async () => {
  const host = normalizeHost(hostInput.value);
  if (!host) {
    hostInput.value = '';
    hostInput.placeholder = 'invalid hostname';
    return;
  }
  if (allowedHosts.includes(host)) {
    hostInput.value = host;
    return;
  }
  allowedHosts.push(host);
  hostInput.value = host;
  await chrome.storage.local.set({ ovAllowedHosts: allowedHosts });
  renderHostList();
  if (!siteEnabled && popupHostAllowed([host], currentHostname)) {
    siteEnabled = true;
    updateControlsState();
    updateDot();
    if (currentTabId != null) await sendMessageSafe(currentTabId, { action: 'activate' });
  }
});

hostInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') btnAddHost.click();
});
