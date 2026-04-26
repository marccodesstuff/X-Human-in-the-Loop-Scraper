// Content script: watches for new tweet <article> elements and extracts data.
// Uses selectors from selectors.js (window.XOSINT_SELECTORS) to remain maintainable.

(function () {
  const S = window.XOSINT_SELECTORS || {};
  const MAX_TWITTER_HANDLE_LENGTH = 15;

  let running = true;
  let seen = new Set(); // dedupe by URL for this content session
  let batch = [];

  // Settings (updated from chrome.storage.sync)
  let settings = {
    webhookEnabled: false,
    webhookUrl: '',
    autoCollect: true,
    contexts: ['timeline','profile','search','list','bookmarks'],
    handleFilter: '',
    keywordFilter: ''
  };
  // cache of notion handles (from background sync)
  settings.notionHandles = [];

  function loadSettings() {
    chrome.storage.sync.get(settings, (items) => {
      settings = Object.assign(settings, items);
      // if autoCollect disabled, and storage/local 'active' flag is false, respect that
      chrome.storage.local.get({ active: !!settings.autoCollect, notionHandles: [] }, (local) => {
        running = !!local.active;
        settings.notionHandles = local.notionHandles || [];
      });
    });
  }
  loadSettings();

  // Listen for settings changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      loadSettings();
    }
    if (area === 'local' && changes.active) {
      running = !!changes.active.newValue;
    }
  });

  // Debounced sender: send batch every 5 seconds if there are items
  setInterval(() => {
    if (batch.length > 0) {
      chrome.runtime.sendMessage({ type: 'tweetBatch', tweets: batch }, () => {});
      batch = [];
    }
  }, 5000);

  // Allow background/popup to pause/resume collection
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'pause') {
      running = false;
      sendResponse({ ok: true });
    } else if (msg && msg.type === 'resume') {
      running = true;
      sendResponse({ ok: true });
    }
  });

  // Determine page context from URL
  function pageContextFromUrl(url) {
    try {
      const u = new URL(url);
      const p = u.pathname;
      if (/^\/search/.test(p)) return 'search';
      if (/^\/i\/lists/.test(p) || /\/lists\//.test(p)) return 'list';
      if (/^\/home/.test(p) || p === '/') return 'timeline';
      if (/^\/bookmarks/.test(p)) return 'bookmarks';
      if (/^\/[^\/]+$/.test(p)) return 'profile';
      return 'unknown';
    } catch (e) {
      return 'unknown';
    }
  }

  // Helper: extract number from aria-label like "1,234 Likes" or "Like 1.2K"
  function parseCountFromAria(label) {
    if (!label) return 0;
    const m = label.match(/([\d,\.]+)\s*(K|M)?/i);
    if (!m) return 0;
    let num = m[1].replace(/,/g, '');
    let val = parseFloat(num);
    const suffix = (m[2] || '').toUpperCase();
    if (suffix === 'K') val *= 1000;
    if (suffix === 'M') val *= 1000000;
    return Math.round(val);
  }

  function getTextContentOrEmpty(el) {
    return el ? el.innerText.trim() : '';
  }

  // Parse a status URL and return canonical URL plus author handle (if present).
  function parseTweetInfoFromUrl(rawUrl) {
    if (!rawUrl) return { url: '', authorHandle: '' };
    try {
      const u = new URL(rawUrl, location.origin);
      const parts = u.pathname.split('/').filter(Boolean);
      const statusIdx = parts.indexOf('status');
      if (statusIdx >= 0 && statusIdx + 1 < parts.length) {
        const canonicalPath = '/' + parts.slice(0, statusIdx + 2).join('/');
        const handlePart = statusIdx > 0 ? parts[statusIdx - 1] : '';
        const isValidHandle = new RegExp(`^[A-Za-z0-9_]{1,${MAX_TWITTER_HANDLE_LENGTH}}$`).test(handlePart);
        return {
          url: u.origin + canonicalPath,
          authorHandle: isValidHandle ? '@' + handlePart : ''
        };
      }
      return { url: u.origin + u.pathname, authorHandle: '' };
    } catch (e) {
      const clean = String(rawUrl).split('?')[0];
      return { url: clean, authorHandle: '' };
    }
  }

  // Extract tweet data from an <article> element
  function extractFromArticle(article) {
    // Timestamp
    const timeEl = article.querySelector(S.time || 'time[datetime]');

    // Find canonical tweet permalink (prefer the anchor wrapping the timestamp)
    let linkEl = timeEl ? timeEl.closest('a[href*="/status/"]') : null;
    if (!linkEl) {
      const candidates = article.querySelectorAll(S.tweetLink || 'a[href*="/status/"]');
      for (const c of candidates) {
        if (c.closest('article') === article) {
          linkEl = c;
          break;
        }
      }
      if (!linkEl && candidates.length) linkEl = candidates[0];
    }
    if (!linkEl) return null;
    const parsedUrl = parseTweetInfoFromUrl(linkEl.href);
    const url = parsedUrl.url;
    if (!url || !url.includes('/status/')) return null;

    if (seen.has(url)) return null;

    const timestamp = timeEl && timeEl.getAttribute('datetime') ? new Date(timeEl.getAttribute('datetime')).toISOString() : null;

    // Author handle: try to find an element whose text starts with @ inside the article
    let authorHandle = parsedUrl.authorHandle || '';
    const allElements = article.querySelectorAll('*');
    if (!authorHandle) {
      for (const node of allElements) {
        const t = node.innerText;
        if (t && t.trim().startsWith('@')) {
          authorHandle = t.trim().split(/\s+/)[0];
          break;
        }
      }
    }

    // Author display name: try to find heading-like text near the top of the article
    let authorName = '';
    const roleLinks = article.querySelectorAll('a');
    if (roleLinks && roleLinks.length > 0) {
      // choose first link that isn't the status link
      for (const a of roleLinks) {
        if (a.href && a.href.includes('/status/')) continue;
        const txt = a.innerText && a.innerText.trim();
        if (txt && !txt.startsWith('@') && txt.length < 60) {
          authorName = txt;
          break;
        }
      }
    }

    // Tweet text: combine text nodes inside the article but avoid headers/handles
    let text = '';
    try {
      const tweetTextSelector = S.tweetText || 'div[data-testid="tweetText"], div[lang]';
      const textEls = article.querySelectorAll(tweetTextSelector);
      const chunks = [];
      const seenChunks = new Set();
      textEls.forEach((el) => {
        if (el.closest('article') !== article) return;
        const t = getTextContentOrEmpty(el);
        if (t && !seenChunks.has(t)) {
          chunks.push(t);
          seenChunks.add(t);
        }
      });
      if (chunks.length) {
        text = chunks.join('\n').trim();
      } else if (timeEl) {
        text = article.innerText || '';
        if (authorHandle) text = text.replace(authorHandle, '');
        if (authorName) text = text.replace(authorName, '');
        text = text.replace(/\n+/g, ' ').trim();
      } else {
        text = article.innerText || '';
      }
    } catch (e) {
      text = article.innerText || '';
    }

    // Media URLs
    const mediaUrls = [];
    const imgs = article.querySelectorAll(S.image || 'img');
    imgs.forEach((img) => {
      const src = img.src || img.getAttribute('data-src') || img.getAttribute('srcset');
      if (src) mediaUrls.push(src);
    });
    const vids = article.querySelectorAll(S.video || 'video, video source');
    vids.forEach((v) => {
      const src = v.src || v.getAttribute('src') || v.getAttribute('poster');
      if (src) mediaUrls.push(src);
    });

    // Engagement metrics via aria-labels
    let replies = 0, reposts = 0, likes = 0, views = 0;
    const engageEls = article.querySelectorAll(S.engagementButtons || '[role="group"] [aria-label]');
    engageEls.forEach((el) => {
      const lab = el.getAttribute('aria-label');
      if (!lab) return;
      const L = lab.toLowerCase();
      if (L.includes('reply') || L.includes('replies')) replies = Math.max(replies, parseCountFromAria(lab));
      else if (L.includes('repost') || L.includes('retweet') || L.includes('reposts')) reposts = Math.max(reposts, parseCountFromAria(lab));
      else if (L.includes('like') || L.includes('likes')) likes = Math.max(likes, parseCountFromAria(lab));
      else if (L.includes('view') || L.includes('views')) views = Math.max(views, parseCountFromAria(lab));
    });

    // isRetweet: look for words like "Reposted" or "Retweeted" in the article
    const articleText = article.innerText || '';
    const isRetweet = /repost(ed)?|retweet(ed)?/i.test(articleText);

    // isQuoteTweet: detect nested <article> elements inside (quote tweets often embed another article)
    const isQuoteTweet = !!article.querySelector('article article');

    const pageContext = pageContextFromUrl(location.href);

    // Apply user filters: contexts, handle list, keywords
    // Context filter
    if (settings.contexts && settings.contexts.length) {
      if (!settings.contexts.includes(pageContext)) return null;
    }
    // Handle filter (exclusive)
    // If Notion handles are present, use them as the exclusive source of truth
    if (settings.notionHandles && settings.notionHandles.length) {
      if (!authorHandle) return null;
      const h = authorHandle.replace(/^@/, '').toLowerCase();
      const ok = settings.notionHandles.some(x => x.replace(/^@/, '').toLowerCase() === h);
      if (!ok) return null;
    } else if (settings.handleFilter && settings.handleFilter.trim()) {
      const allowed = settings.handleFilter.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      if (allowed.length && authorHandle) {
        const h = authorHandle.replace(/^@/, '').toLowerCase();
        const ok = allowed.some(a => a.replace(/^@/, '').toLowerCase() === h);
        if (!ok) return null;
      } else if (allowed.length && !authorHandle) {
        return null;
      }
    }
    // Keyword filter (at least one keyword must appear in text)
    if (settings.keywordFilter && settings.keywordFilter.trim()) {
      const kws = settings.keywordFilter.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      if (kws.length) {
        const found = kws.some(k => (text || '').toLowerCase().includes(k));
        if (!found) return null;
      }
    }

    const result = {
      url,
      authorName: authorName || '',
      authorHandle: authorHandle || '',
      text: (text || '').trim(),
      timestamp: timestamp || new Date().toISOString(),
      mediaUrls: mediaUrls,
      replies,
      reposts,
      likes,
      views,
      isRetweet,
      isQuoteTweet,
      pageContext
    };

    // Mark as seen to avoid re-extracting
    seen.add(url);
    return result;
  }

  // Process added nodes: look for <article> elements and extract
  function processAddedNode(node) {
    if (!running) return;
    try {
      if (!node) return;
      const articles = [];
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.matches && node.matches(S.tweetArticle || 'article')) articles.push(node);
        const found = node.querySelectorAll ? node.querySelectorAll(S.tweetArticle || 'article') : [];
        found.forEach(a => articles.push(a));
      }
      for (const art of articles) {
        const t = extractFromArticle(art);
        if (t) batch.push(t);
      }
    } catch (e) {
      // ignore
    }
  }

  // Observe the document for added tweets. We observe the body subtree to capture timeline infinite scroll.
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.addedNodes && m.addedNodes.length) {
        m.addedNodes.forEach(n => processAddedNode(n));
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Initial scan for existing articles on page load
  window.addEventListener('load', () => {
    const initial = document.querySelectorAll(S.tweetArticle || 'article');
    initial.forEach(a => {
      const t = extractFromArticle(a);
      if (t) batch.push(t);
    });
  });

  // Expose a small API for debugging
  window.__XOSINT = {
    seen,
    getBatch: () => batch.slice(),
    flush: () => {
      if (batch.length) {
        chrome.runtime.sendMessage({ type: 'tweetBatch', tweets: batch }, () => {});
        batch = [];
      }
    }
  };

})();
