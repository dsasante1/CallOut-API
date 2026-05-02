/// <reference types="chrome" />

let visible = true;
let capturePaused = false;
let popupTheme: 'dark' | 'light' = 'dark';
let siteEnabled = false;
let allowedHosts: string[] = [];

async function getTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(action: string, extra: Record<string, unknown> = {}): Promise<void> {
  const tab = await getTab();
  if (tab?.id != null) {
    chrome.tabs.sendMessage(tab.id, { action, ...extra });
  }
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
  const list = document.getElementById('host-list')!;
  if (allowedHosts.length === 0) {
    list.innerHTML = '<div class="host-empty">No sites added yet</div>';
    return;
  }
  list.innerHTML = allowedHosts
    .map((h, i) => `<div class="host-item">
      <span class="host-name" title="${h}">${h}</span>
      <button class="host-remove" data-index="${i}" title="Remove">×</button>
    </div>`)
    .join('');
  list.querySelectorAll<HTMLButtonElement>('.host-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.index);
      const removed = allowedHosts[idx];
      allowedHosts.splice(idx, 1);
      chrome.storage.local.set({ ovAllowedHosts: allowedHosts });
      renderHostList();
      const tab = await getTab();
      const hostname = getTabHostname(tab);
      if (removed === hostname) {
        siteEnabled = false;
        updateControlsState();
        updateDot();
        if (tab?.id != null) chrome.tabs.sendMessage(tab.id, { action: 'deactivate' });
      }
    });
  });
}

async function initAllowlist(): Promise<void> {
  const tab = await getTab();
  const hostname = getTabHostname(tab);
  if (hostname) hostInput.value = hostname;

  allowedHosts = await new Promise<string[]>(resolve => {
    chrome.storage.local.get('ovAllowedHosts', ({ ovAllowedHosts }) => {
      resolve((ovAllowedHosts as string[]) ?? []);
    });
  });

  siteEnabled = hostname !== '' && allowedHosts.includes(hostname);
  updateControlsState();
  updateDot();
  renderHostList();
}

// Sync state from the live content script; fall back to storage if tab isn't reachable
async function syncState(): Promise<void> {
  const tab = await getTab();
  if (tab?.id != null) {
    chrome.tabs.sendMessage(tab.id, { action: 'get-state' }, response => {
      if (chrome.runtime.lastError || !response) {
        // content script not ready — fall back to storage
        chrome.storage.local.get(['ovTheme', 'ovVisible', 'ovPaused'], ({ ovTheme, ovVisible, ovPaused }) => {
          applyPopupTheme((ovTheme as 'dark' | 'light') || 'dark');
          applyVisibleState(ovVisible !== false);
          applyPausedState(ovPaused === true);
        });
        return;
      }
      applyPopupTheme(response.theme || 'dark');
      applyVisibleState(response.visible !== false);
      applyPausedState(response.paused === true);
    });
  }
}

syncState();
initAllowlist();

btnTheme.addEventListener('click', async () => {
  const next: 'dark' | 'light' = popupTheme === 'dark' ? 'light' : 'dark';
  chrome.storage.local.set({ ovTheme: next });
  applyPopupTheme(next);
  await send('theme', { value: next });
});

btnToggle.addEventListener('click', async () => {
  visible = !visible;
  btnToggle.textContent = visible ? 'Hide Panel' : 'Show Panel';
  updateDot();
  await send('toggle');
});

btnPause.addEventListener('click', async () => {
  capturePaused = !capturePaused;
  btnPause.textContent = capturePaused ? 'Resume Capture' : 'Pause Capture';
  await send('pause', { value: capturePaused });
});

(document.getElementById('btn-export') as HTMLButtonElement).addEventListener('click', async () => {
  await send('export-har');
});

(document.getElementById('btn-clear') as HTMLButtonElement).addEventListener('click', async () => {
  await send('clear');
});

btnAddHost.addEventListener('click', async () => {
  const host = hostInput.value.trim().toLowerCase();
  if (!host || allowedHosts.includes(host)) return;
  allowedHosts.push(host);
  chrome.storage.local.set({ ovAllowedHosts: allowedHosts });
  renderHostList();
  const tab = await getTab();
  const hostname = getTabHostname(tab);
  if (host === hostname) {
    siteEnabled = true;
    updateControlsState();
    updateDot();
    if (tab?.id != null) chrome.tabs.sendMessage(tab.id, { action: 'activate' });
  }
});

hostInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') btnAddHost.click();
});
