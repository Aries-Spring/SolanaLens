'use strict';

const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

const rpcInput = document.getElementById('rpcInput');
const enabledToggle = document.getElementById('enabledToggle');
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const statusMsg = document.getElementById('statusMsg');

// Load saved settings
chrome.storage.sync.get(['rpcUrl', 'enabled'], ({ rpcUrl, enabled }) => {
  if (rpcUrl && rpcUrl !== DEFAULT_RPC) rpcInput.value = rpcUrl;
  enabledToggle.checked = enabled !== false;
});

resetBtn.addEventListener('click', () => {
  rpcInput.value = '';
  rpcInput.focus();
  showStatus('');
});

saveBtn.addEventListener('click', save);
rpcInput.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });

function save() {
  const raw = rpcInput.value.trim();

  if (raw && !isHttpUrl(raw)) {
    showStatus('Enter a valid http(s) URL', true);
    rpcInput.focus();
    return;
  }

  const rpcUrl = raw || DEFAULT_RPC;

  chrome.storage.sync.set({ rpcUrl, enabled: enabledToggle.checked }, () => {
    showStatus('Saved');
    setTimeout(() => showStatus(''), 2000);
  });
}

function isHttpUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function showStatus(msg, isError = false) {
  statusMsg.textContent = msg;
  statusMsg.className = 'status' + (isError ? ' error' : '');
}
