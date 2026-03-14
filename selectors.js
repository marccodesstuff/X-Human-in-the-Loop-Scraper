// Centralized DOM selectors for X/Twitter scraping.
// Keep selectors semantic and resilient: prefer tags and attributes
// (article, time[datetime], a[href*="/status/"], aria-label) over class names.

(function () {
  window.XOSINT_SELECTORS = {
    // Tweets are rendered as <article> elements — observe these.
    tweetArticle: 'article',

    // Link to the tweet contains "/status/" in the href.
    tweetLink: 'a[href*="/status/"]',

    // Timestamp element with ISO datetime.
    time: 'time[datetime]',

    // Tweet text content: prefer data-testid when present, fallback to div[lang]
    tweetText: 'div[data-testid="tweetText"], article div[lang]',

    // Media: images and videos inside the article.
    image: 'img',
    video: 'video, video source',

    // Engagement buttons often carry aria-labels like "3 Likes".
    engagementButtons: '[role="group"] [aria-label]',

    // Retweet/repost label detection: look for text nodes mentioning "Reposted"/"Retweeted".
    repostLabel: null,

    // Generic handle selector fallback: elements with text starting with @
    handleCandidate: '*'
  };
})();
