// Popup logic: shows totals, active toggle, exports, and last 5 tweets

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('xosint_db', 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllTweets() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readonly');
    const store = tx.objectStore('tweets');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function download(filename, content) {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function toCSV(rows) {
  const headers = ['url','authorName','authorHandle','text','timestamp','mediaUrls','replies','reposts','likes','views','isRetweet','isQuoteTweet','collectedAt','pageContext'];
  const csv = [headers.join(',')];
  for (const r of rows) {
    const vals = headers.map(h => {
      let v = r[h];
      if (Array.isArray(v)) v = v.join('|');
      if (v === null || typeof v === 'undefined') v = '';
      return '"' + String(v).replace(/"/g, '""') + '"';
    });
    csv.push(vals.join(','));
  }
  return csv.join('\n');
}

document.addEventListener('DOMContentLoaded', async () => {
  const totalEl = document.getElementById('total');
  const activeToggle = document.getElementById('activeToggle');
  const last5 = document.getElementById('last5');

  function refreshTotal() {
    chrome.storage.local.get({ totalCollected: 0, active: true }, (items) => {
      totalEl.textContent = items.totalCollected || 0;
      activeToggle.checked = !!items.active;
    });
  }

  refreshTotal();

  activeToggle.addEventListener('change', () => {
    const active = activeToggle.checked;
    chrome.storage.local.set({ active });
    // Broadcast to tabs to pause/resume content scripts
    chrome.tabs.query({}, (tabs) => {
      for (const t of tabs) {
        chrome.tabs.sendMessage(t.id, { type: active ? 'resume' : 'pause' }, () => {});
      }
    });
  });

  document.getElementById('exportJson').addEventListener('click', async () => {
    const rows = await getAllTweets();
    download('xosint_tweets.json', JSON.stringify(rows, null, 2));
  });

  document.getElementById('exportCsv').addEventListener('click', async () => {
    const rows = await getAllTweets();
    const csv = toCSV(rows);
    download('xosint_tweets.csv', csv);
  });

  document.getElementById('clearDb').addEventListener('click', async () => {
    if (!confirm('Clear all collected tweets? This cannot be undone.')) return;
    const db = await openDB();
    const tx = db.transaction('tweets', 'readwrite');
    tx.objectStore('tweets').clear();
    tx.oncomplete = () => {
      chrome.storage.local.set({ totalCollected: 0 });
      chrome.runtime.sendMessage({ type: 'resetSessionCount' });
      refreshTotal();
      last5.innerHTML = '';
      alert('Database cleared');
    };
  });

  // show last 5 entries
  try {
    const rows = await getAllTweets();
    rows.sort((a,b) => new Date(b.collectedAt) - new Date(a.collectedAt));
    const top = rows.slice(0,5);
    last5.innerHTML = '';
    for (const r of top) {
      const d = document.createElement('div');
      d.className = 'tweet-preview';
      const time = new Date(r.collectedAt).toLocaleString();
      d.innerHTML = `<div><strong>${r.authorHandle || r.authorName}</strong> <span class="muted">${time}</span></div><div>${(r.text||'').slice(0,80)}${(r.text||'').length>80?'…':''}</div>`;
      last5.appendChild(d);
    }
  } catch (e) {
    last5.textContent = 'No tweets yet';
  }

});
