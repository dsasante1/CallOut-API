let visible = true;
let paused = false;

async function getTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(action, extra = {}) {
  const tab = await getTab();
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { action, ...extra });
}

document.getElementById('btn-toggle').addEventListener('click', async () => {
  visible = !visible;
  document.getElementById('btn-toggle').textContent = visible ? 'Hide Panel' : 'Show Panel';
  document.getElementById('dot').className = `dot${visible ? '' : ' off'}`;
  await send('toggle');
});

document.getElementById('btn-pause').addEventListener('click', async () => {
  paused = !paused;
  document.getElementById('btn-pause').textContent = paused ? 'Resume Capture' : 'Pause Capture';
  await send('pause', { value: paused });
});

document.getElementById('btn-export').addEventListener('click', async () => {
  await send('export-har');
});

document.getElementById('btn-clear').addEventListener('click', async () => {
  await send('clear');
});
