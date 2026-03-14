// Options page logic: save/load settings to chrome.storage.sync

const defaults = {
  webhookUrl: '',
  webhookEnabled: false,
  autoCollect: true,
  contexts: ['timeline','profile','search','list','bookmarks'],
  handleFilter: '',
  keywordFilter: ''
};

function getFormValues() {
  const webhookUrl = document.getElementById('webhookUrl').value.trim();
  const webhookEnabled = document.getElementById('webhookEnabled').checked;
  const autoCollect = document.getElementById('autoCollect').checked;
  const handleFilter = document.getElementById('handleFilter').value.trim();
  const keywordFilter = document.getElementById('keywordFilter').value.trim();
  const ctxEls = document.querySelectorAll('.ctx');
  const contexts = [];
  ctxEls.forEach(c => { if (c.checked) contexts.push(c.value); });
  return { webhookUrl, webhookEnabled, autoCollect, handleFilter, keywordFilter, contexts };
}

function setFormValues(cfg) {
  document.getElementById('webhookUrl').value = cfg.webhookUrl || '';
  document.getElementById('webhookEnabled').checked = !!cfg.webhookEnabled;
  document.getElementById('autoCollect').checked = typeof cfg.autoCollect === 'undefined' ? true : !!cfg.autoCollect;
  document.getElementById('handleFilter').value = cfg.handleFilter || '';
  document.getElementById('keywordFilter').value = cfg.keywordFilter || '';
  const ctxEls = document.querySelectorAll('.ctx');
  ctxEls.forEach(c => { c.checked = (cfg.contexts || []).includes(c.value); });
}

document.addEventListener('DOMContentLoaded', () => {
  const status = document.getElementById('status');
  document.getElementById('save').addEventListener('click', () => {
    const cfg = getFormValues();
    chrome.storage.sync.set(cfg, () => {
      status.textContent = 'Saved.';
      setTimeout(() => status.textContent = '', 2000);
    });
  });

  document.getElementById('restore').addEventListener('click', () => {
    setFormValues(defaults);
    chrome.storage.sync.set(defaults, () => { status.textContent = 'Restored defaults.'; setTimeout(()=>status.textContent='',1500); });
  });

  // load saved
  chrome.storage.sync.get(defaults, (items) => {
    setFormValues(items);
  });
});
