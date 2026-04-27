/// <reference types="chrome" />

let visible = true;
let capturePaused = false;
let popupTheme: 'dark' | 'light' = 'dark';

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

const btnTheme = document.getElementById('btn-theme') as HTMLButtonElement;
const btnToggle = document.getElementById('btn-toggle') as HTMLButtonElement;
const btnPause = document.getElementById('btn-pause') as HTMLButtonElement;
const dot = document.getElementById('dot') as HTMLElement;

chrome.storage.local.get('ovTheme', result => {
  applyPopupTheme((result['ovTheme'] as 'dark' | 'light') || 'dark');
});

btnTheme.addEventListener('click', async () => {
  const next: 'dark' | 'light' = popupTheme === 'dark' ? 'light' : 'dark';
  chrome.storage.local.set({ ovTheme: next });
  applyPopupTheme(next);
  await send('theme', { value: next });
});

btnToggle.addEventListener('click', async () => {
  visible = !visible;
  btnToggle.textContent = visible ? 'Hide Panel' : 'Show Panel';
  dot.className = `dot${visible ? '' : ' off'}`;
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
