// Background service worker: stores tweets in IndexedDB and forwards to webhook if configured.

const DB_NAME = 'xosint_db';
const DB_VERSION = 1;
const STORE_NAME = 'tweets';

let sessionCount = 0;

// Notion sync settings and cached handles
let notionHandles = [];

async function fetchNotionHandlesOnce() {
  try {
    const cfg = await new Promise((res) => chrome.storage.sync.get({ notionEnabled: false, notionApiKey: '', notionDatabaseId: '' }, res));
    if (!cfg.notionEnabled || !cfg.notionApiKey || !cfg.notionDatabaseId) return;
    const url = `https://api.notion.com/v1/databases/${cfg.notionDatabaseId}/query`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + cfg.notionApiKey,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ page_size: 100 })
    });
    if (!resp.ok) throw new Error('Notion fetch failed ' + resp.status);
    const data = await resp.json();
    const pages = data.results || [];
    const handles = [];
    for (const p of pages) {
      // Try to extract a property named "Handle"
      const props = p.properties || {};
      if (props.Handle) {
        const prop = props.Handle;
        let val = '';
        // Handle could be rich_text or title or people etc.
        if (prop.type === 'rich_text' && prop.rich_text && prop.rich_text.length) {
          val = prop.rich_text.map(t => t.plain_text).join('');
        } else if (prop.type === 'title' && prop.title && prop.title.length) {
          val = prop.title.map(t => t.plain_text).join('');
        } else if (prop.type === 'url' && prop.url) {
          val = prop.url;
        }
        if (val) {
          // normalize: extract handle from url or text
          let h = val.trim();
          if (h.includes('twitter.com') || h.includes('x.com')) {
            try { const u = new URL(h); const parts = u.pathname.split('/').filter(Boolean); if (parts.length) h = parts[0]; } catch (e) {}
          }
          h = h.replace(/^@/, '').toLowerCase();
          if (h) handles.push('@' + h);
        }
      }
      // fallback: try to find a property that looks like a handle
      else {
        for (const k of Object.keys(props)) {
          const prop = props[k];
          if (prop && (prop.type === 'rich_text' || prop.type === 'title')) {
            const text = (prop.rich_text || prop.title || []).map(t => t.plain_text).join('');
            if (text && /@?[A-Za-z0-9_\-]{1,15}/.test(text)) {
              const m = text.match(/@?([A-Za-z0-9_\-]{1,15})/);
              if (m) handles.push('@' + m[1].toLowerCase());
            }
          }
        }
      }
    }
    // dedupe
    const uniq = Array.from(new Set(handles));
    notionHandles = uniq;
    chrome.storage.local.set({ notionHandles: uniq });
  } catch (e) {
    console.error('Notion sync error', e);
  }
}

// Kick off Notion syncing every 5 minutes
setInterval(() => { fetchNotionHandlesOnce(); }, 5 * 60 * 1000);
fetchNotionHandlesOnce();

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'url' });
        store.createIndex('collectedAt', 'collectedAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeTweets(tweets) {
  if (!tweets || !tweets.length) return { inserted: 0 };
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    let inserted = 0;
    tx.oncomplete = () => resolve({ inserted });
    tx.onerror = () => reject(tx.error);
    for (const t of tweets) {
      const getReq = store.get(t.url);
      getReq.onsuccess = () => {
        if (!getReq.result) {
          const rec = Object.assign({}, t, { collectedAt: new Date().toISOString() });
          store.add(rec);
          inserted++;
        }
      };
      getReq.onerror = () => {
        // ignore individual get errors
      };
    }
  });
}

async function forwardToWebhook(tweets) {
  try {
    const settings = await new Promise((res) => chrome.storage.sync.get({ webhookEnabled: false, webhookUrl: '' }, res));
    if (!settings.webhookEnabled || !settings.webhookUrl) return { ok: false, reason: 'disabled' };
    const payload = JSON.stringify({ tweets });
    const doPost = async () => {
      const resp = await fetch(settings.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      });
      if (!resp.ok) throw new Error('bad resp ' + resp.status);
      return { ok: true };
    };
    try {
      return await doPost();
    } catch (e) {
      // retry once
      try { return await doPost(); } catch (e2) { return { ok: false, reason: e2.message }; }
    }
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Update persistent total count
function addToTotalCount(n) {
  chrome.storage.local.get({ totalCollected: 0 }, (items) => {
    const total = (items.totalCollected || 0) + n;
    chrome.storage.local.set({ totalCollected: total });
  });
}

function setBadge(count) {
  const text = count > 0 ? String(count) : '';
  try { chrome.action.setBadgeText({ text }); } catch (e) { }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'tweetBatch') {
    const tweets = Array.isArray(msg.tweets) ? msg.tweets : [];
    (async () => {
      try {
        const res = await storeTweets(tweets);
        if (res.inserted && res.inserted > 0) {
          sessionCount += res.inserted;
          addToTotalCount(res.inserted);
          setBadge(sessionCount);
          // forward all tweets (new ones only would be better, but simplest to forward the batch)
          try { await forwardToWebhook(tweets); } catch (e) { /* ignore */ }
        }
      } catch (e) {
        // log
        console.error('storeTweets error', e);
      }
    })();
    sendResponse({ received: true });
    return true; // indicate async response possible
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get({ totalCollected: 0 }, (items) => {
    if (typeof items.totalCollected === 'undefined') chrome.storage.local.set({ totalCollected: 0 });
  });
});

// Expose a simple message-based API for popup/options to interact
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'resetSessionCount') {
    sessionCount = 0;
    setBadge(0);
    sendResponse({ ok: true });
  }
  if (msg.type === 'getSessionCount') {
    sendResponse({ sessionCount });
  }
});
