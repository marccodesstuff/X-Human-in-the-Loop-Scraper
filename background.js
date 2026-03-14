// Background service worker: stores tweets in IndexedDB and forwards to webhook if configured.

const DB_NAME = 'xosint_db';
const DB_VERSION = 1;
const STORE_NAME = 'tweets';

let sessionCount = 0;

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
