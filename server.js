const express = require('express');
const Parser = require('rss-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const compression = require('compression');

// ══════════════════════════════════════════════
// CONFIG & ENVIRONMENT
// ══════════════════════════════════════════════
const APP_VERSION = '25';
const PORT = process.env.PORT || 3000;

const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT || 'mailto:admin@briefil.co.il';
const ADMIN_SECRET      = process.env.ADMIN_SECRET || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHANNEL   = process.env.TELEGRAM_CHANNEL  || '';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// Validate critical env vars on startup
function checkEnv() {
  const warnings = [];
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY)
    warnings.push('VAPID keys missing — push notifications disabled');
  if (!ADMIN_SECRET)
    warnings.push('ADMIN_SECRET not set — admin endpoints disabled');
  if (!ANTHROPIC_API_KEY)
    warnings.push('ANTHROPIC_API_KEY missing — AI summaries disabled');
  if (!TELEGRAM_BOT_TOKEN)
    warnings.push('TELEGRAM_BOT_TOKEN missing — Telegram disabled');
  warnings.forEach(w => console.warn(`⚠️  ${w}`));
  return warnings;
}

// ══════════════════════════════════════════════
// PUSH SUBSCRIPTIONS (persisted to JSON file)
// ══════════════════════════════════════════════
const SUBS_FILE = path.join(__dirname, 'push-subs.json');
const MAX_SUBSCRIPTIONS = 500;
let pushSubscriptions = [];

try {
  if (fs.existsSync(SUBS_FILE)) {
    pushSubscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
    console.log(`Loaded ${pushSubscriptions.length} push subscriptions`);
  }
} catch (e) { pushSubscriptions = []; }

function saveSubs() {
  try { fs.writeFileSync(SUBS_FILE, JSON.stringify(pushSubscriptions)); } catch (e) {}
}

// ══════════════════════════════════════════════
// WEB PUSH (VAPID)
// ══════════════════════════════════════════════
let _webpush = null;
const VAPID_FILE = path.join(__dirname, 'vapid-keys.json');

// Auto-generate VAPID keys if not provided via env vars
let vapidPublic = VAPID_PUBLIC_KEY;
let vapidPrivate = VAPID_PRIVATE_KEY;

if (!vapidPublic || !vapidPrivate) {
  // Try loading from persisted file
  try {
    if (fs.existsSync(VAPID_FILE)) {
      const saved = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
      if (saved.publicKey && saved.privateKey) {
        vapidPublic = saved.publicKey;
        vapidPrivate = saved.privateKey;
        console.log('VAPID keys loaded from file');
      }
    }
  } catch (e) {}

  // Generate new keys if still missing
  if (!vapidPublic || !vapidPrivate) {
    try {
      const wp = require('web-push');
      const keys = wp.generateVAPIDKeys();
      vapidPublic = keys.publicKey;
      vapidPrivate = keys.privateKey;
      fs.writeFileSync(VAPID_FILE, JSON.stringify({ publicKey: vapidPublic, privateKey: vapidPrivate }));
      console.log('VAPID keys generated and saved');
    } catch (e) {
      console.error('Failed to generate VAPID keys:', e.message);
    }
  }
}

if (vapidPublic && vapidPrivate) {
  try {
    _webpush = require('web-push');
    _webpush.setVapidDetails(VAPID_SUBJECT, vapidPublic, vapidPrivate);
    console.log('web-push ✓ | VAPID public key:', vapidPublic.slice(0, 20) + '...');
  } catch (e) {
    console.error('web-push init failed:', e.message);
  }
} else {
  console.warn('web-push ✗ | No VAPID keys available');
}

async function sendWebPush(subscription, payload) {
  if (!_webpush) return false;
  try {
    await _webpush.sendNotification(subscription, JSON.stringify(payload));
    return true;
  } catch (e) {
    if (e.statusCode === 410 || e.statusCode === 404) {
      pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== subscription.endpoint);
      saveSubs();
    }
    return false;
  }
}

async function broadcastNewsPush(item) {
  if (!pushSubscriptions.length || !_webpush) return;
  const payload = {
    title: '📰 ' + (item.sourceName || 'חדשות IL'),
    body: item.title || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    image: item.image || undefined,
    data: { url: item.link || '/' },
    vibrate: [200, 50, 200],
    dir: 'rtl',
    lang: 'he',
    tag: 'news-' + item.id,
    renotify: false,
  };
  const results = await Promise.allSettled(pushSubscriptions.map(s => sendWebPush(s, payload)));
  const ok = results.filter(r => r.status === 'fulfilled' && r.value).length;
  console.log(`[NEWS PUSH] "${item.title?.slice(0, 40)}" → ${ok}/${pushSubscriptions.length}`);
}

async function broadcastAlertPush(alert) {
  if (!pushSubscriptions.length || !_webpush) return;
  const cities = alert.data || [];
  const preview = cities.slice(0, 3).join(', ') + (cities.length > 3 ? ` +${cities.length - 3}` : '');
  const payload = {
    title: '🚨 ' + (alert.title || 'ירי רקטות'),
    body: preview || 'אזעקה פעילה',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: '/', alertId: alert.id },
    vibrate: [300, 100, 300, 100, 300],
    requireInteraction: true,
    dir: 'rtl',
    lang: 'he',
  };
  console.log(`[ALERT PUSH] → ${pushSubscriptions.length} subscribers: ${preview}`);
  const results = await Promise.allSettled(pushSubscriptions.map(s => sendWebPush(s, payload)));
  const ok = results.filter(r => r.status === 'fulfilled' && r.value).length;
  console.log(`[ALERT PUSH] Sent: ${ok}/${pushSubscriptions.length}`);
}

// ══════════════════════════════════════════════
// BREAKING NEWS PUSH DETECTION
// ══════════════════════════════════════════════
const seenNewsIds = new Set();

function checkAndPushNewItems(newItems) {
  if (!pushSubscriptions.length || !_webpush) return;
  const now = Date.now();
  const fresh = newItems.filter(item => {
    if (seenNewsIds.has(item.id)) return false;
    return (now - (item.ts || 0)) < 10 * 60 * 1000;
  });

  // Group by title similarity — breaking = 2+ channels with same headline
  const titleMap = {};
  fresh.forEach(item => {
    const key = item.title.replace(/[^א-ת]/g, '').slice(0, 20);
    if (!titleMap[key]) titleMap[key] = [];
    titleMap[key].push(item);
  });

  let pushed = 0;
  const maxPush = 3;

  Object.values(titleMap).forEach(group => {
    if (pushed >= maxPush) return;
    if (group.length >= 2) {
      const item = group[0];
      seenNewsIds.add(item.id);
      group.forEach(i => seenNewsIds.add(i.id));
      broadcastNewsPush({ ...item, sourceName: '🔥 מבזק — ' + item.sourceName });
      pushed++;
    }
  });

  if (pushed === 0) {
    const single = fresh.find(item => !seenNewsIds.has(item.id));
    if (single) {
      seenNewsIds.add(single.id);
      broadcastNewsPush(single);
    }
  }

  // Keep set bounded
  if (seenNewsIds.size > 500) {
    const arr = [...seenNewsIds];
    arr.slice(0, 200).forEach(id => seenNewsIds.delete(id));
  }
}

// ══════════════════════════════════════════════
// EXPRESS APP SETUP
// ══════════════════════════════════════════════
const app = express();

// Gzip compression
app.use(compression());

// CORS
app.use(cors());

// JSON body parser with size limit
app.use(express.json({ limit: '16kb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ── Rate limiting (in-memory, simple) ──
const rateLimits = new Map();
const RATE_WINDOW = 60_000; // 1 minute
const RATE_MAX_GENERAL = 120;
const RATE_MAX_AI = 15;

function rateLimit(key, max) {
  const now = Date.now();
  const entry = rateLimits.get(key);
  if (!entry || now - entry.start > RATE_WINDOW) {
    rateLimits.set(key, { start: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > max;
}

// Cleanup rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimits) {
    if (now - entry.start > RATE_WINDOW * 2) rateLimits.delete(key);
  }
}, 5 * 60 * 1000);

// General rate limiter middleware
function rateLimitMiddleware(max = RATE_MAX_GENERAL) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (rateLimit(ip + ':' + req.path, max)) {
      return res.status(429).json({ error: 'יותר מדי בקשות. נסה שוב בעוד דקה.' });
    }
    next();
  };
}

// ── Static files ──
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.get('/index.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

// ══════════════════════════════════════════════
// RSS PARSER & CHANNELS
// ══════════════════════════════════════════════
const parser = new Parser({
  timeout: 5000,
  customFields: { item: ['media:content', 'media:thumbnail', 'media:group', 'enclosure', 'image', 'description'] },
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
});

const CHANNELS = [
  { id: 'ynet',       name: 'ynet',         color: '#E8001E', icon: '📰', url: 'https://www.ynet.co.il/Integration/StoryRss2.xml',                                                                                        limit: 6 },
  { id: 'ynet_war',   name: 'ynet מלחמה',   color: '#ff4444', icon: '🔴', url: 'https://www.ynet.co.il/Integration/StoryRss2784.xml',                                                                                     limit: 4 },
  { id: 'walla',      name: 'וואלה',        color: '#FF6B00', icon: '🔥', url: 'https://rss.walla.co.il/feed/22',                                                                                                          limit: 4 },
  { id: 'walla_w',    name: 'וואלה ביטחון', color: '#cc5500', icon: '⚔️', url: 'https://rss.walla.co.il/feed/2686',                                                                                                       limit: 3 },
  { id: 'walla_econ', name: 'וואלה כלכלה',  color: '#15803d', icon: '💹', url: 'https://rss.walla.co.il/feed/9',                                                                                                           limit: 3 },
  { id: 'ch12',       name: 'חדשות 12',     color: '#C8102E', icon: '📺', url: 'https://news.google.com/rss/search?q=site:n12.co.il+when:1d&hl=he&gl=IL&ceid=IL:he',                                                       limit: 6 },
  { id: 'ch13',       name: 'רשת 13',       color: '#7C3AED', icon: '📡', url: 'https://news.google.com/rss/search?q=site:13tv.co.il+when:1d&hl=he&gl=IL&ceid=IL:he',                                                      limit: 6 },
  { id: 'ch14',       name: 'ערוץ 14',      color: '#d97706', icon: '🦅', url: 'https://news.google.com/rss/search?q=site:now14.co.il+when:1d&hl=he&gl=IL&ceid=IL:he',                                                     limit: 5 },
  { id: 'mako',       name: 'מאקו',         color: '#e11d48', icon: '🎬', url: 'https://news.google.com/rss/search?q=site:mako.co.il+when:1d&hl=he&gl=IL&ceid=IL:he',                                                      limit: 4 },
  { id: 'maariv',     name: 'מעריב',        color: '#0891B2', icon: '🗞️', url: 'https://www.maariv.co.il/Rss/RssFeedsMivzakiChadashot',                                                                                   limit: 4 },
  { id: 'haaretz',    name: 'הארץ',         color: '#444',    icon: '📜', url: 'https://www.haaretz.co.il/srv/rss---feedly',                                                                                               limit: 3 },
  { id: 'glz',        name: 'גלצ',          color: '#2d6a4f', icon: '🎖️', url: 'https://news.google.com/rss/search?q=site:glz.co.il+when:1d&hl=he&gl=IL&ceid=IL:he',                                                      limit: 4 },
  { id: 'idf',        name: 'דובר צבא',     color: '#16a34a', icon: '🪖', url: 'https://news.google.com/rss/search?q=%D7%93%D7%95%D7%91%D7%A8+%D7%A6%D7%94%22%D7%9C+OR+%D7%A6%D7%91%D7%90+when:1d&hl=he&gl=IL&ceid=IL:he', limit: 3 },
  { id: 'srugim',     name: 'סרוגים',       color: '#0891b2', icon: '✡️', url: 'https://news.google.com/rss/search?q=site:srugim.co.il+when:1d&hl=he&gl=IL&ceid=IL:he',                                                    limit: 3 },
  { id: 'calcalist',  name: 'כלכליסט',      color: '#0f4c8a', icon: '💼', url: 'https://news.google.com/rss/search?q=site:calcalist.co.il+when:1d&hl=he&gl=IL&ceid=IL:he',                                                 limit: 4 },
  { id: 'globes',     name: 'גלובס',        color: '#006633', icon: '📊', url: 'https://news.google.com/rss/search?q=site:globes.co.il+when:1d&hl=he&gl=IL&ceid=IL:he',                                                    limit: 4 },
  { id: 'kan',        name: 'כאן 11',       color: '#1a56db', icon: '📻', url: 'https://news.google.com/rss/search?q=site:kan.org.il+when:1d&hl=he&gl=IL&ceid=IL:he',                                                      limit: 4 },
];

// ══════════════════════════════════════════════
// IMAGE PROCESSING
// ══════════════════════════════════════════════
const BAD_PATTERNS = [
  'mivzakim', 'placeholder', 'noimage', 'no-image',
  'RenderImage', 'walla.co.il/rb/', 'breaking_news', 'breakingnews',
  '%D7%9E%D7%91%D7%96%D7%A7%D7%99%D7%9D',
  '2907054', '2907055', '2907056', '2907057', '2907058', '2907059',
  'default_image', 'default-image', 'generic_', 'generic-',
];
const LOGO_PATTERNS = ['/logo.', '/logo-', '/brand.', '/favicon.', 'favicon.ico'];
const STRICT_IMAGE_SOURCES = new Set(['walla', 'walla_w', 'walla_econ', 'maariv']);

// Known generic/banner images per source (hash of URL patterns)
const MAARIV_GENERIC_PATTERNS = [
  'mivzak', 'logo', 'brand', 'breaking', 'default',
  'mitparzot', 'hadashot-mitparzot', 'mivzakim',
  'generic', 'share_default', 'og-default',
  'rss_image', 'rssimage', 'rssfeed',
];

function isRealImage(url, sourceId) {
  if (!url || url.length < 12) return false;
  const l = url.toLowerCase();
  for (const p of BAD_PATTERNS) if (l.includes(p.toLowerCase())) return false;
  for (const p of LOGO_PATTERNS) if (l.includes(p)) return false;
  if (l.includes('walla') && l.includes('/image/') && /\/image\/\d{5,9}/.test(l)) return false;
  if (l.includes('walla') && url.length < 100) return false;
  // Maariv: block generic/banner images
  if (l.includes('maariv')) {
    for (const p of MAARIV_GENERIC_PATTERNS) if (l.includes(p)) return false;
    if (url.length < 90) return false;
  }
  if (sourceId && STRICT_IMAGE_SOURCES.has(sourceId) && url.length < 80) return false;
  if (/[?&](w|width)=(1|2|3|4|5|10|16|20)(&|$)/.test(url)) return false;
  return true;
}

function extractImage(item, sourceId) {
  try {
    const candidates = [];
    if (item['media:content']?.$?.url) candidates.push(item['media:content'].$.url);
    if (item['media:thumbnail']?.$?.url) candidates.push(item['media:thumbnail'].$.url);
    if (item['media:group']?.['media:content']) {
      const mg = item['media:group']['media:content'];
      if (Array.isArray(mg)) mg.forEach(m => { if (m?.$?.url) candidates.push(m.$.url); });
      else if (mg?.$?.url) candidates.push(mg.$.url);
    }
    if (item.enclosure?.url && item.enclosure?.type?.startsWith('image')) candidates.push(item.enclosure.url);
    if (item.enclosure?.url && !item.enclosure?.type) candidates.push(item.enclosure.url);
    const html = item.content || item['content:encoded'] || item.summary || item.description || '';
    const imgs = [...html.matchAll(/<img[^>]+src=["']([^"']{20,})["']/g)].map(m => m[1]);
    candidates.push(...imgs.slice(0, 5));
    const srcsets = [...html.matchAll(/srcset=["']([^"']+)["']/g)].map(m => m[1]);
    srcsets.forEach(ss => {
      const parts = ss.split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length > 0) {
        const last = parts[parts.length - 1].split(/\s+/)[0];
        if (last && last.length > 15) candidates.push(last);
      }
    });
    const ogMatch = html.match(/(?:og:image|twitter:image)[^>]*content=["']([^"']{20,})["']/i);
    if (ogMatch) candidates.push(ogMatch[1]);
    const dataSrc = [...html.matchAll(/data-src=["']([^"']{20,})["']/g)].map(m => m[1]);
    candidates.push(...dataSrc.slice(0, 3));
    for (const url of candidates) {
      if (isRealImage(url, sourceId)) return upgradeImageUrl(url);
    }
  } catch (e) {}
  return null;
}

function upgradeImageUrl(url) {
  if (!url) return url;
  try {
    if (url.includes('ynet-pic') || url.includes('ynet.co.il')) {
      url = url.replace(/\/picserver\d\/\d+\//, (m) => m.replace(/\/\d+\//, '/1200/'));
      url = url.replace(/_\d+\.jpg/, '_1200.jpg');
      url = url.replace(/crop_images\/\d+\/\d+\//, (m) => m.replace(/\/\d+\/\d+\//, '/1200/675/'));
    }
    if (url.includes('haaretz.co.il') || url.includes('img.haaretz')) {
      url = url.replace(/\?imageVersion=\d+x\d+/, '?imageVersion=1200x675');
      url = url.replace(/height=\d+/, 'height=675').replace(/width=\d+/, 'width=1200');
    }
    if (url.includes('walla.co.il')) {
      url = url.replace(/\/\d+x\d+\//, '/1200x675/');
    }
    if (url.includes('news.google.com') && url.includes('=w')) {
      url = url.replace(/=w\d+(-h\d+)?(-[a-zA-Z]+)?/, '=w1200-h675-rw');
    }
    if (url.includes('mako.co.il')) {
      url = url.replace(/\/\d+x\d+\//, '/1200x675/');
      url = url.replace(/width=\d+/, 'width=1200').replace(/height=\d+/, 'height=675');
    }
    if (url.includes('calcalist')) {
      url = url.replace(/_\d+\.jpg/, '_1200.jpg');
    }
    if (url.includes('n12.co.il') || url.includes('maariv.co.il')) {
      url = url.replace(/\/\d+x\d+\//, '/1200x675/');
      url = url.replace(/width=\d+/, 'width=1200').replace(/height=\d+/, 'height=675');
    }
    if (url.includes('globes.co.il')) {
      url = url.replace(/\/\d+x\d+\//, '/1200x675/');
    }
    url = url.replace(/[\?&]w=\d+/, (m) => m[0] + 'w=1200');
  } catch (e) {}
  return url;
}

// ══════════════════════════════════════════════
// OG IMAGE SCRAPER — fallback when RSS has no image
// ══════════════════════════════════════════════
const ogImageCache = new Map(); // url -> { image, ts }
const OG_CACHE_TTL = 30 * 60 * 1000; // 30 min
const OG_CACHE_MAX = 200;
const OG_SCRAPE_TIMEOUT = 4000;

// Cleanup old OG cache entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ogImageCache) {
    if (now - v.ts > OG_CACHE_TTL) ogImageCache.delete(k);
  }
}, 5 * 60 * 1000);

async function scrapeOgImage(articleUrl) {
  if (!articleUrl || articleUrl.length < 10) return null;
  // Check cache
  const cached = ogImageCache.get(articleUrl);
  if (cached) return cached.image;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), OG_SCRAPE_TIMEOUT);
    const res = await fetch(articleUrl, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html',
      },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    // Read only the first 30KB to find meta tags (they're in <head>)
    const reader = res.body.getReader();
    let html = '';
    const decoder = new TextDecoder();
    while (html.length < 30000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
    }
    try { reader.cancel(); } catch (e) {}

    // Extract og:image, twitter:image, or first large image
    const candidates = [];
    // og:image (most reliable)
    const ogMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']{20,})["']/i)
                 || html.match(/<meta[^>]*content=["']([^"']{20,})["'][^>]*property=["']og:image["']/i);
    if (ogMatch) candidates.push(ogMatch[1]);
    // twitter:image
    const twMatch = html.match(/<meta[^>]*(?:name|property)=["']twitter:image["'][^>]*content=["']([^"']{20,})["']/i)
                 || html.match(/<meta[^>]*content=["']([^"']{20,})["'][^>]*(?:name|property)=["']twitter:image["']/i);
    if (twMatch) candidates.push(twMatch[1]);
    // JSON-LD image
    const ldMatch = html.match(/"image"\s*:\s*"(https?:\/\/[^"]{20,})"/i);
    if (ldMatch) candidates.push(ldMatch[1]);
    // Content images — look for article images inside the body
    const contentImgs = [...html.matchAll(/<img[^>]+src=["'](https?:\/\/[^"']{30,})["'][^>]*>/gi)]
      .map(m => m[1])
      .filter(u => !u.includes('icon') && !u.includes('avatar') && !u.includes('logo') && !u.includes('pixel'));
    candidates.push(...contentImgs.slice(0, 3));

    for (const url of candidates) {
      // Resolve relative URLs
      let fullUrl = url;
      if (url.startsWith('//')) fullUrl = 'https:' + url;
      else if (url.startsWith('/')) {
        try { fullUrl = new URL(url, articleUrl).href; } catch (e) { continue; }
      }
      if (isRealImage(fullUrl)) {
        const upgraded = upgradeImageUrl(fullUrl);
        // Cache result
        if (ogImageCache.size >= OG_CACHE_MAX) {
          ogImageCache.delete(ogImageCache.keys().next().value);
        }
        ogImageCache.set(articleUrl, { image: upgraded, ts: Date.now() });
        return upgraded;
      }
    }
    // Cache null result to avoid re-scraping
    ogImageCache.set(articleUrl, { image: null, ts: Date.now() });
  } catch (e) {
    // Timeout or network error — don't cache so we retry next cycle
  }
  return null;
}

// ══════════════════════════════════════════════
// NEWS FETCHING
// ══════════════════════════════════════════════
function timeAgo(d) {
  try {
    const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
    if (s < 90) return 'לפני דקה';
    if (s < 3600) return `לפני ${Math.floor(s / 60)} דקות`;
    if (s < 7200) return 'לפני שעה';
    if (s < 86400) return `לפני ${Math.floor(s / 3600)} שעות`;
    return 'אתמול';
  } catch (e) { return ''; }
}

async function fetchWithProxy(url) {
  try {
    return await parser.parseURL(url);
  } catch (e1) {}

  try {
    const r2j = 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(url);
    const res = await fetch(r2j, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    if (data.status === 'ok' && data.items?.length) {
      return {
        items: data.items.map(i => ({
          title: i.title, link: i.link, pubDate: i.pubDate,
          contentSnippet: i.description?.replace(/<[^>]+>/g, '').slice(0, 200),
          'media:content': (i.thumbnail && i.thumbnail.length > 10) ? { $: { url: i.thumbnail } } :
                           (i.enclosure?.link ? { $: { url: i.enclosure.link } } : undefined),
          'media:thumbnail': (i.thumbnail && i.thumbnail.length > 10) ? { $: { url: i.thumbnail } } : undefined,
          content: i.content || '',
          guid: i.guid,
        })),
      };
    }
  } catch (e2) {}

  try {
    return await parser.parseURL('https://api.allorigins.win/raw?url=' + encodeURIComponent(url));
  } catch (e3) {}

  try {
    return await parser.parseURL('https://corsproxy.io/?' + encodeURIComponent(url));
  } catch (e4) {}

  throw new Error('All proxies failed');
}

const PROXY_CHANNELS = new Set([]);

async function fetchChannel(ch) {
  try {
    const feed = PROXY_CHANNELS.has(ch.id)
      ? await fetchWithProxy(ch.url)
      : await parser.parseURL(ch.url);
    if (!feed?.items) return [];
    const mapped = feed.items.slice(0, ch.limit || 5).map((item, i) => ({
      id: ch.id + '_' + (item.guid || item.link || i),
      source: ch.id, sourceName: ch.name, sourceColor: ch.color, sourceIcon: ch.icon,
      title: (item.title || '').replace(/<[^>]+>/g, '').trim(),
      desc: (item.contentSnippet || item.summary || '').replace(/<[^>]+>/g, '').trim().slice(0, 200),
      link: item.link || '',
      image: extractImage(item, ch.id),
      timeAgo: timeAgo(item.pubDate || item.isoDate),
      ts: new Date(item.pubDate || item.isoDate).getTime() || (Date.now() - i * 60000),
    }));
    // OG scrape for items missing images (parallel, non-blocking)
    const noImage = mapped.filter(m => !m.image && m.link);
    if (noImage.length > 0) {
      const scrapeResults = await Promise.allSettled(
        noImage.map(m => scrapeOgImage(m.link))
      );
      scrapeResults.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value) {
          noImage[i].image = r.value;
        }
      });
    }
    return mapped;
  } catch (e) {
    console.log(`ERR ${ch.name}: ${e.message.slice(0, 60)}`);
    return [];
  }
}

let newsCache = [], cacheTime = 0;

async function refreshNews() {
  const results = await Promise.allSettled(CHANNELS.map(ch => fetchChannel(ch)));
  let combined = [], ok = 0;
  results.forEach(r => {
    if (r.status === 'fulfilled' && r.value.length > 0) {
      combined = combined.concat(r.value);
      ok++;
    }
  });

  combined.sort((a, b) => b.ts - a.ts);

  // Dedup by title similarity
  const seenTitles = new Set();
  combined = combined.filter(item => {
    const key = item.title.replace(/[^א-תA-z]/g, '').slice(0, 25).toLowerCase();
    if (seenTitles.has(key)) return false;
    seenTitles.add(key);
    return true;
  });

  // Detect generic/reused images: if same image URL appears 2+ times from same source, it's a generic banner
  const imgCount = {};
  combined.forEach(item => {
    if (item.image) {
      const key = item.source + '|' + item.image;
      imgCount[key] = (imgCount[key] || 0) + 1;
    }
  });
  combined.forEach(item => {
    if (item.image) {
      const key = item.source + '|' + item.image;
      if (imgCount[key] >= 2) {
        console.log(`[IMG] Removed generic image from ${item.sourceName}: ${item.image.slice(0, 60)}`);
        item.image = null;
      }
    }
  });

  newsCache = combined.slice(0, 60);
  cacheTime = Date.now();
  console.log(`[NEWS] ${combined.length} items, ${ok}/${CHANNELS.length} channels`);

  checkAndPushNewItems(newsCache);
  checkAndSendToTelegram(newsCache);
}

// ══════════════════════════════════════════════
// API ROUTES — NEWS
// ══════════════════════════════════════════════
app.get('/api/news', rateLimitMiddleware(), async (req, res) => {
  if (Date.now() - cacheTime > 60000) await refreshNews();
  res.json({ items: newsCache, updated: new Date(cacheTime).toISOString(), total: newsCache.length });
});

// ══════════════════════════════════════════════
// API ROUTES — IMAGE PROXY
// ══════════════════════════════════════════════
const ALLOWED_IMAGE_HOSTS = new Set([
  'maariv.co.il', 'www.maariv.co.il', 'images.maariv.co.il',
  'n12.co.il', 'www.n12.co.il',
  'ynet.co.il', 'www.ynet.co.il', 'pic.ynet.co.il',
  'img.mako.co.il', 'www.mako.co.il',
  'images.walla.co.il', 'img.walla.co.il',
  'www.calcalist.co.il', 'images.calcalist.co.il',
  'www.globes.co.il', 'images.globes.co.il',
  'img.haaretz.co.il', 'www.haaretz.co.il',
  'www.kan.org.il', 'kanapi.media.kan.org.il',
  'images.now14.co.il', 'www.now14.co.il',
  'images1.ynet.co.il', 'pic1.ynet.co.il', 'pic2.ynet.co.il',
  '13tv.co.il', 'www.13tv.co.il', 'img.13tv.co.il',
  'www.srugim.co.il', 'images.srugim.co.il',
  'glz.co.il', 'www.glz.co.il',
  'lh3.googleusercontent.com', 'news.google.com',
]);

function isAllowedImageHost(url) {
  try {
    const hostname = new URL(url).hostname;
    if (ALLOWED_IMAGE_HOSTS.has(hostname)) return true;
    // Allow subdomains of allowed hosts
    for (const h of ALLOWED_IMAGE_HOSTS) {
      if (hostname.endsWith('.' + h)) return true;
    }
    return false;
  } catch (e) { return false; }
}

app.get('/api/img-proxy', rateLimitMiddleware(), async (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith('http')) return res.status(400).send('Bad URL');
  if (!isAllowedImageHost(url)) return res.status(403).send('Host not allowed');

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const imgRes = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'image/*',
        'Referer': new URL(url).origin + '/',
      },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!imgRes.ok) return res.status(imgRes.status).send('Upstream error');

    const ct = imgRes.headers.get('content-type') || 'image/jpeg';
    if (!ct.startsWith('image/')) return res.status(400).send('Not an image');

    res.set({
      'Content-Type': ct,
      'Cache-Control': 'public, max-age=86400, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    const body = Buffer.from(await imgRes.arrayBuffer());
    res.send(body);
  } catch (e) {
    res.status(502).send('Fetch failed');
  }
});

// ══════════════════════════════════════════════
// API ROUTES — AI SUMMARY
// ══════════════════════════════════════════════
const summaryCache = new Map();

function cacheSet(k, v) {
  if (summaryCache.size >= 50) {
    summaryCache.delete(summaryCache.keys().next().value);
  }
  summaryCache.set(k, v);
}

// Periodic cleanup
setInterval(() => {
  summaryCache.clear();
  if (global.gc) global.gc();
}, 15 * 60 * 1000);

app.post('/api/ai/summarize', rateLimitMiddleware(RATE_MAX_AI), async (req, res) => {
  const { title, desc } = req.body || {};
  if (!title || typeof title !== 'string') return res.json({ text: '—' });
  if (!ANTHROPIC_API_KEY) return res.json({ text: 'סיכום AI לא זמין כרגע.' });

  // Sanitize input length
  const cleanTitle = title.slice(0, 300);
  const cleanDesc = (desc || '').slice(0, 500);

  const cacheKey = cleanTitle.slice(0, 80);
  if (summaryCache.has(cacheKey)) return res.json({ text: summaryCache.get(cacheKey) });

  const MODELS = [
    'claude-haiku-4-5-20251001',
    'claude-haiku-3-5-20241022',
    'claude-sonnet-4-5',
  ];
  const prompt = `אתה עורך חדשות ישראלי. כתוב משפט אחד קצר וחד בעברית שמסכם את הכתבה הבאה. רק המשפט, ללא הסברים.\n\nכותרת: ${cleanTitle}\n${cleanDesc ? 'תיאור: ' + cleanDesc : ''}`;

  for (const model of MODELS) {
    try {
      const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model, max_tokens: 100, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await apiRes.json();

      if (apiRes.status === 529 || data?.error?.type === 'overloaded_error') continue;
      if (data?.error) {
        console.log(`[AI] ${model} error: ${data.error.type}`);
        continue;
      }

      const text = data?.content?.[0]?.text?.trim();
      if (text) {
        cacheSet(cacheKey, text);
        return res.json({ text });
      }
    } catch (e) {
      console.log(`[AI] ${model} err: ${e.message}`);
    }
  }
  res.json({ text: '—' });
});

// ══════════════════════════════════════════════
// ALERTS ENGINE (Oref polling)
// ══════════════════════════════════════════════
let currentAlert = null;
let alertHistory = [];
let orefConnected = false;
let lastOrefAlertId = null;
let orefAlertClearTimer = null;

const sseClients = new Set();
const MAX_SSE_CLIENTS = 50;

function broadcastSSE(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach(res => {
    try { res.write(data); } catch (e) { sseClients.delete(res); }
  });
}

async function pollOref() {
  try {
    const r = await fetch('https://www.oref.org.il/warningMessages/alert/Alerts.json', {
      headers: {
        'Referer': 'https://www.oref.org.il/',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: AbortSignal.timeout(4000),
    });

    if (!orefConnected) {
      orefConnected = true;
      console.log('[OREF] Connected ✓');
      broadcastSSE({ alert: currentAlert, connected: true });
    }

    const text = await r.text();
    const trimmed = text.trim();

    if (!trimmed || trimmed === '' || trimmed === '\r\n' || trimmed === '\\r\\n') {
      if (currentAlert) {
        currentAlert = null;
        broadcastSSE({ alert: null, connected: true });
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(trimmed); } catch (e) { return; }

    if (!msg?.data || !Array.isArray(msg.data) || msg.data.length === 0) {
      if (currentAlert) {
        currentAlert = null;
        broadcastSSE({ alert: null, connected: true });
      }
      return;
    }

    const alertId = String(msg.id || '');
    if (alertId && alertId === lastOrefAlertId) return;
    lastOrefAlertId = alertId;

    currentAlert = {
      data: msg.data,
      title: msg.title || msg.cat || 'ירי רקטות',
      id: alertId || String(Date.now()),
      ts: Date.now(),
    };

    alertHistory.unshift({ ...currentAlert, alertDate: new Date().toISOString() });
    if (alertHistory.length > 20) alertHistory.length = 20;

    console.log('🚨 [OREF] Alert:', currentAlert.title, currentAlert.data.slice(0, 3));
    broadcastSSE({ alert: currentAlert, connected: true });
    broadcastAlertPush(currentAlert);

    if (orefAlertClearTimer) clearTimeout(orefAlertClearTimer);
    orefAlertClearTimer = setTimeout(() => {
      if (currentAlert) {
        currentAlert = null;
        lastOrefAlertId = null;
        broadcastSSE({ alert: null, connected: true });
      }
    }, 120_000);
  } catch (e) {
    if (orefConnected) {
      orefConnected = false;
      console.log('[OREF] Poll err:', e.message);
      broadcastSSE({ alert: currentAlert, connected: false });
    }
  }
}

// ── Alert API routes ──
app.get('/api/alerts/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ alert: currentAlert, connected: orefConnected })}\n\n`);

  if (sseClients.size >= MAX_SSE_CLIENTS) {
    const oldest = sseClients.values().next().value;
    try { oldest.end(); } catch (e) {}
    sseClients.delete(oldest);
  }
  sseClients.add(res);

  const hb = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (e) { clearInterval(hb); }
  }, 25_000);

  req.on('close', () => {
    sseClients.delete(res);
    clearInterval(hb);
  });
});

app.get('/api/alerts', rateLimitMiddleware(), (req, res) => {
  res.json({ alert: currentAlert, connected: orefConnected });
});

app.get('/api/alerts/history', rateLimitMiddleware(), (req, res) => {
  res.json(alertHistory);
});

app.get('/api/alerts/oref-history', rateLimitMiddleware(), async (req, res) => {
  try {
    const r = await fetch('https://api.tzevaadom.co.il/alerts-history', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) {
      return res.json(alertHistory.slice(0, 30));
    }

    const threatNames = {
      0: 'ירי רקטות', 1: 'חדירת כלי טיס עוין', 2: 'רעידת אדמה',
      3: 'חומרים מסוכנים', 4: 'צונאמי', 5: 'חדירת מחבלים',
      6: 'אירוע רדיולוגי', 7: 'אירוע לא קונבנציונלי', 13: 'אירוע בטחוני',
    };
    const normalized = [];
    data.slice(0, 30).forEach(event => {
      if (!event.alerts) return;
      event.alerts.forEach(a => {
        if (a.isDrill) return;
        normalized.push({
          alertDate: new Date(a.time * 1000).toISOString(),
          title: threatNames[a.threat] || 'אזעקה',
          data: a.cities || [],
          id: event.id + '_' + a.time,
        });
      });
    });
    normalized.sort((a, b) => new Date(b.alertDate) - new Date(a.alertDate));
    res.json(normalized.slice(0, 50));
  } catch (e) {
    console.log('[OREF-HISTORY] err:', e.message);
    res.json(alertHistory.slice(0, 30));
  }
});

// ══════════════════════════════════════════════
// PUSH SUBSCRIPTION ENDPOINTS
// ══════════════════════════════════════════════
app.get('/api/version', (req, res) => {
  res.json({ version: APP_VERSION, ts: Date.now() });
});

app.get('/api/push/status', (req, res) => {
  res.json({
    webpush: !!_webpush,
    vapidSet: !!(vapidPublic && vapidPrivate),
    subscribers: pushSubscriptions.length,
  });
});

app.post('/api/push/test', rateLimitMiddleware(5), async (req, res) => {
  if (!pushSubscriptions.length) return res.json({ ok: false, msg: 'אין מנויים' });
  await broadcastNewsPush({
    id: 'test-' + Date.now(),
    title: 'בדיקת פוש — חדשות IL עובד!',
    sourceName: 'חדשות IL',
    link: '/',
    image: '/icon-192.png',
  });
  res.json({ ok: true, subscribers: pushSubscriptions.length });
});

app.get('/api/push/vapid-key', (req, res) => {
  if (!vapidPublic) return res.status(503).json({ error: 'VAPID not configured' });
  res.json({ publicKey: vapidPublic });
});

app.post('/api/push/subscribe', rateLimitMiddleware(30), (req, res) => {
  const sub = req.body;

  // Validate subscription structure
  if (!sub || typeof sub !== 'object') return res.status(400).json({ error: 'Invalid subscription' });
  if (!sub.endpoint || typeof sub.endpoint !== 'string') return res.status(400).json({ error: 'Missing endpoint' });
  if (!sub.keys || typeof sub.keys !== 'object') return res.status(400).json({ error: 'Missing keys' });
  if (!sub.keys.p256dh || !sub.keys.auth) return res.status(400).json({ error: 'Missing key fields' });

  // Validate endpoint is a valid URL
  try { new URL(sub.endpoint); } catch (e) { return res.status(400).json({ error: 'Invalid endpoint URL' }); }

  // Check max subscriptions
  if (pushSubscriptions.length >= MAX_SUBSCRIPTIONS) {
    // Remove oldest subscription to make room
    pushSubscriptions.shift();
  }

  const exists = pushSubscriptions.find(s => s.endpoint === sub.endpoint);
  if (!exists) {
    pushSubscriptions.push({
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    });
    saveSubs();
    console.log(`[PUSH] New subscription. Total: ${pushSubscriptions.length}`);
  }
  res.json({ ok: true, total: pushSubscriptions.length });
});

app.post('/api/push/unsubscribe', rateLimitMiddleware(30), (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
  pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== endpoint);
  saveSubs();
  res.json({ ok: true });
});

// ══════════════════════════════════════════════
// HEALTH & DEBUG
// ══════════════════════════════════════════════
app.get('/health', (req, res) => {
  const mem = Math.round(process.memoryUsage().rss / 1024 / 1024);
  res.json({
    ok: true,
    version: APP_VERSION,
    items: newsCache.length,
    oref: orefConnected,
    sseClients: sseClients.size,
    pushSubs: pushSubscriptions.length,
    imagesTotal: newsCache.filter(i => i.image).length,
    imagesMissing: newsCache.filter(i => !i.image).length,
    memoryMB: mem,
    uptime: Math.round(process.uptime()),
  });
});

app.get('/api/debug/images', (req, res) => {
  res.json({
    ogCacheSize: ogImageCache.size,
    stats: newsCache.map(item => ({
      source: item.sourceName,
      title: (item.title || '').slice(0, 50),
      hasImage: !!item.image,
      imageUrl: item.image ? item.image.slice(0, 120) : null,
    })),
  });
});

// ══════════════════════════════════════════════
// DAILY EVENING SUMMARY (20:00 Israel time)
// ══════════════════════════════════════════════
let lastDailySummaryDate = '';

async function generateDailySummary() {
  if (!ANTHROPIC_API_KEY || !pushSubscriptions.length || !newsCache.length) return;

  const cutoff = Date.now() - 8 * 60 * 60 * 1000;
  const todayItems = newsCache.filter(i => i.ts > cutoff);
  if (todayItems.length < 3) return;

  const seen = new Set();
  const top5 = [];
  for (const item of todayItems) {
    if (top5.length >= 5) break;
    const key = (item.title || '').replace(/[^\u05D0-\u05EA]/g, '').slice(0, 15);
    if (!seen.has(key)) { seen.add(key); top5.push(item); }
  }

  const headlines = top5.map((item, n) => (n + 1) + '. ' + item.title).join('\n');
  const prompt = `אתה עורך של תוכנית חדשות ישראלית.
כתוב סיכום ערב קצר ומרתק בעברית — 3 משפטים בלבד.
משפט ראשון: הכותרת החשובה ביותר של היום.
משפט שני: עוד 2-3 נושאים מרכזיים.
משפט שלישי: תחזית קצרה.
ללא כותרות, ללא bullets — טקסט רציף, חד ומקצועי.

כותרות היום:
${headlines}`;

  const MODELS = ['claude-haiku-4-5-20251001', 'claude-haiku-3-5-20241022'];
  let summary = '';

  for (const model of MODELS) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model, max_tokens: 250, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      if (data?.error) { console.log('[DAILY] AI err:', data.error.type); continue; }
      summary = data?.content?.[0]?.text?.trim() || '';
      if (summary) break;
    } catch (e) { console.log('[DAILY] err:', e.message); }
  }

  if (!summary) {
    summary = top5.slice(0, 3).map(i => i.title).join(' | ');
  }

  const payload = {
    title: '📋 סיכום יום — חדשות IL',
    body: summary.slice(0, 150),
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: '/' },
    vibrate: [200, 100, 200],
    dir: 'rtl',
    lang: 'he',
    tag: 'daily-summary',
    renotify: true,
  };

  console.log('[DAILY] Sending to', pushSubscriptions.length, 'subscribers');
  const results = await Promise.allSettled(pushSubscriptions.map(s => sendWebPush(s, payload)));
  const ok = results.filter(r => r.status === 'fulfilled' && r.value).length;
  console.log('[DAILY] Sent', ok + '/' + pushSubscriptions.length);
}

// Check every minute for 20:00 IL
setInterval(() => {
  const now = new Date();
  const ilTime = new Intl.DateTimeFormat('en-IL', {
    timeZone: 'Asia/Jerusalem', hour: 'numeric', minute: 'numeric', hour12: false,
  }).format(now);
  const [ilHour, ilMin] = ilTime.split(':').map(Number);
  const todayStr = now.toISOString().slice(0, 10);
  if (ilHour === 20 && ilMin < 2 && lastDailySummaryDate !== todayStr) {
    lastDailySummaryDate = todayStr;
    console.log('[DAILY] Triggering 20:00 summary...');
    generateDailySummary().catch(e => console.log('[DAILY] Failed:', e.message));
  }
}, 60_000);

// Admin-only manual trigger
app.post('/api/push/daily-summary', rateLimitMiddleware(3), async (req, res) => {
  if (!ADMIN_SECRET) return res.status(503).json({ ok: false, msg: 'Admin endpoint not configured' });
  const secret = req.headers['x-secret'] || req.body?.secret;
  if (secret !== ADMIN_SECRET) {
    return res.status(403).json({ ok: false, msg: 'Unauthorized' });
  }
  await generateDailySummary();
  res.json({ ok: true, subscribers: pushSubscriptions.length });
});

// ══════════════════════════════════════════════
// TELEGRAM INTEGRATION
// ══════════════════════════════════════════════
const sentToTelegram = new Set();

async function sendToTelegram(item) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL) return;
  if (sentToTelegram.has(item.id)) return;
  sentToTelegram.add(item.id);
  if (sentToTelegram.size > 300) {
    const arr = [...sentToTelegram];
    arr.slice(0, 100).forEach(id => sentToTelegram.delete(id));
  }

  const src = item.sourceName || 'חדשות IL';
  const title = item.title || '';
  const link = item.link || APP_URL;

  const escaped = title.replace(/[*_[\]()~`>#+=|{}.!-]/g, '\\$&');
  const text = ['📰 *' + escaped + '*', '', '🔗 ' + src, link].join('\n');

  try {
    const res = await fetch(
      'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHANNEL,
          text,
          parse_mode: 'Markdown',
          disable_web_page_preview: false,
        }),
        signal: AbortSignal.timeout(8000),
      }
    );
    const data = await res.json();
    if (!data.ok) console.log('[TG] Error:', data.description);
    else console.log('[TG] Sent:', title.slice(0, 40));
  } catch (e) {
    console.log('[TG] Failed:', e.message);
  }
}

function checkAndSendToTelegram(items) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL || !items.length) return;
  const now = Date.now();
  const fresh = items.filter(i => !sentToTelegram.has(i.id) && (now - (i.ts || 0)) < 8 * 60 * 1000);

  const groups = {};
  fresh.forEach(item => {
    const key = (item.title || '').replace(/[^\u05D0-\u05EA]/g, '').slice(0, 20);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  });

  Object.values(groups).forEach(group => {
    if (group.length >= 2) sendToTelegram(group[0]);
  });
}

// ══════════════════════════════════════════════
// MEMORY WATCHDOG
// ══════════════════════════════════════════════
setInterval(() => {
  const mb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  if (mb > 420) {
    console.warn('[MEM] HIGH:', mb, 'MB — clearing caches');
    summaryCache.clear();
    newsCache = newsCache.slice(0, 10);
  }
}, 5 * 60 * 1000);

// ══════════════════════════════════════════════
// STARTUP
// ══════════════════════════════════════════════
app.listen(PORT, async () => {
  const warnings = checkEnv();
  console.log(`[START] Port ${PORT} — v${APP_VERSION} — ${CHANNELS.length} channels`);
  if (warnings.length) console.log(`[START] ${warnings.length} warning(s) — check env vars`);

  await refreshNews();
  console.log(`[START] Ready: ${newsCache.length} items, ${newsCache.filter(i => i.image).length} with images`);

  // Start periodic refreshes
  setInterval(refreshNews, 10_000);

  // Start Oref polling
  pollOref();
  setInterval(pollOref, 15_000);
});
