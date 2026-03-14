const express = require('express');
const Parser = require('rss-parser');
const cors = require('cors');
const https = require('https');
const path = require('path');
const WebSocket = require('ws');

// ── PUSH NOTIFICATIONS (VAPID) ──
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || 'BJgaRfdawY-VK3Kj_2W9yz2s_2xB7R4Ocp_rEDcGbcqNV0l84C3GI69nJs27yijlDcruILy-Ax776L3y7ndTVYk';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'WtzCv7_f0jrdyXhOVrBc3ejeXlezi_OYd3GzK0J__hY';
const VAPID_SUBJECT     = 'mailto:admin@briefil.co.il';

// In-memory push subscriptions (survives restarts via simple JSON file)
const fs = require('fs');
const SUBS_FILE = path.join(__dirname, 'push-subs.json');
let pushSubscriptions = [];
try {
  if (fs.existsSync(SUBS_FILE)) {
    pushSubscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
    console.log(`Loaded ${pushSubscriptions.length} push subscriptions`);
  }
} catch(e) { pushSubscriptions = []; }

function saveSubs() {
  try { fs.writeFileSync(SUBS_FILE, JSON.stringify(pushSubscriptions)); } catch(e) {}
}

// Minimal VAPID push without web-push npm package
// Uses Node crypto + fetch to send Web Push manually
let _webpush=null;try{_webpush=require('web-push');_webpush.setVapidDetails(VAPID_SUBJECT,VAPID_PUBLIC_KEY,VAPID_PRIVATE_KEY);console.log('web-push ✓');}catch(e){console.error('web-push missing:',e.message);}

async function sendWebPush(subscription, payload) {
  if (!_webpush) return false;
  try {
    await _webpush.sendNotification(subscription, JSON.stringify(payload));
    return true;
  } catch(e) {
    if (e.statusCode === 410 || e.statusCode === 404) {
      // Subscription expired — remove it
      pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== subscription.endpoint);
      saveSubs();
    }
    return false;
  }
}

// ── PUSH: Breaking News ──
const seenNewsIds = new Set(); // track sent news to avoid duplicates

async function broadcastNewsPush(item) {
  if (!pushSubscriptions.length) return;
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
    renotify: false
  };
  const results = await Promise.allSettled(pushSubscriptions.map(s => sendWebPush(s, payload)));
  const ok = results.filter(r => r.status==='fulfilled' && r.value).length;
  console.log(`[NEWS PUSH] "${item.title?.slice(0,40)}" → ${ok}/${pushSubscriptions.length}`);
}

// Check new items after each refresh and push breaking ones
let lastPushCheck = Date.now();
function checkAndPushNewItems(newItems) {
  if (!pushSubscriptions.length) return;
  const now = Date.now();
  // Only push items from the last 10 minutes that we haven't pushed before
  const fresh = newItems.filter(item => {
    if (seenNewsIds.has(item.id)) return false;
    const age = now - (item.ts || 0);
    return age < 10 * 60 * 1000; // < 10 minutes old
  });
  // Count how many channels cover the same headline (breaking = 2+ channels)
  const titleMap = {};
  fresh.forEach(item => {
    const key = item.title.replace(/[^א-ת]/g,'').slice(0,20);
    if (!titleMap[key]) titleMap[key] = [];
    titleMap[key].push(item);
  });
  // Push breaking (multi-channel) first, then top 1 new item
  let pushed = 0;
  const maxPush = 3;
  Object.values(titleMap).forEach(group => {
    if (pushed >= maxPush) return;
    if (group.length >= 2) { // breaking — covered by 2+ channels
      const item = group[0];
      seenNewsIds.add(item.id);
      group.forEach(i => seenNewsIds.add(i.id));
      broadcastNewsPush({ ...item, sourceName: '🔥 מבזק — ' + item.sourceName });
      pushed++;
    }
  });
  // Push up to 1 fresh non-breaking item if no breaking
  if (pushed === 0) {
    const single = fresh.find(item => !seenNewsIds.has(item.id));
    if (single) {
      seenNewsIds.add(single.id);
      broadcastNewsPush(single);
    }
  }
  // Keep seenNewsIds bounded
  if (seenNewsIds.size > 500) {
    const arr = [...seenNewsIds];
    arr.slice(0, 200).forEach(id => seenNewsIds.delete(id));
  }
}

async function broadcastPush(alert) {
  if (!pushSubscriptions.length) return;
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
    lang: 'he'
  };
  console.log(`Sending push to ${pushSubscriptions.length} subscribers: ${preview}`);
  const results = await Promise.allSettled(pushSubscriptions.map(s => sendWebPush(s, payload)));
  const ok = results.filter(r => r.status === 'fulfilled' && r.value).length;
  console.log(`Push sent: ${ok}/${pushSubscriptions.length}`);
}


const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const parser = new Parser({
  timeout: 5000,
  customFields: { item: ['media:content','media:thumbnail','media:group','enclosure','image','description'] },
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }
});

const CHANNELS = [
  { id:'ynet',      name:'ynet',         color:'#E8001E', icon:'📰', url:'https://www.ynet.co.il/Integration/StoryRss2.xml',                           limit:6 },
  { id:'ynet_war',  name:'ynet מלחמה',   color:'#ff4444', icon:'🔴', url:'https://www.ynet.co.il/Integration/StoryRss2784.xml',                        limit:4 },
  { id:'walla',     name:'וואלה',        color:'#FF6B00', icon:'🔥', url:'https://rss.walla.co.il/feed/22',                                             limit:4 },
  { id:'walla_w',   name:'וואלה ביטחון', color:'#cc5500', icon:'⚔️', url:'https://rss.walla.co.il/feed/2686',                                          limit:3 },
  { id:'walla_econ',name:'וואלה כלכלה',  color:'#15803d', icon:'💹', url:'https://rss.walla.co.il/feed/9',                                              limit:3 },
  { id:'ch12',      name:'חדשות 12',     color:'#C8102E', icon:'📺', url:'https://news.google.com/rss/search?q=site:n12.co.il+when:1d&hl=he&gl=IL&ceid=IL:he',  limit:6 },
  { id:'ch13',      name:'רשת 13',       color:'#7C3AED', icon:'📡', url:'https://news.google.com/rss/search?q=site:13tv.co.il+when:1d&hl=he&gl=IL&ceid=IL:he', limit:6 },
  { id:'ch14',      name:'ערוץ 14',      color:'#d97706', icon:'🦅', url:'https://news.google.com/rss/search?q=site:now14.co.il+when:1d&hl=he&gl=IL&ceid=IL:he', limit:5 },
  { id:'mako',      name:'מאקו',         color:'#e11d48', icon:'🎬', url:'https://news.google.com/rss/search?q=site:mako.co.il+when:1d&hl=he&gl=IL&ceid=IL:he', limit:4 },
  { id:'maariv',    name:'מעריב',        color:'#0891B2', icon:'🗞️', url:'https://www.maariv.co.il/Rss/RssFeedsMivzakiChadashot',                      limit:4 },
  { id:'haaretz',   name:'הארץ',         color:'#444',    icon:'📜', url:'https://www.haaretz.co.il/srv/rss---feedly',                                  limit:3 },
  { id:'glz',       name:'גלצ',          color:'#2d6a4f', icon:'🎖️', url:'https://news.google.com/rss/search?q=site:glz.co.il+when:1d&hl=he&gl=IL&ceid=IL:he', limit:4 },
  { id:'idf',       name:'דובר צבא',     color:'#16a34a', icon:'🪖', url:'https://news.google.com/rss/search?q=%D7%93%D7%95%D7%91%D7%A8+%D7%A6%D7%94%22%D7%9C+OR+%D7%A6%D7%91%D7%90+when:1d&hl=he&gl=IL&ceid=IL:he', limit:3 },
  { id:'srugim',    name:'סרוגים',        color:'#0891b2', icon:'✡️', url:'https://news.google.com/rss/search?q=site:srugim.co.il+when:1d&hl=he&gl=IL&ceid=IL:he', limit:3 },
  { id:'calcalist', name:'כלכליסט',       color:'#0f4c8a', icon:'💼', url:'https://www.calcalist.co.il/GeneralRSS/0,15910,L-8,00.xml',                   limit:4 },
  { id:'globes',    name:'גלובס',         color:'#006633', icon:'📊', url:'https://www.globes.co.il/webservice/rss/rssfeeder.asmx/FeederNode?iID=1',      limit:4 },
  { id:'kan',       name:'כאן 11',        color:'#1a56db', icon:'📻', url:'https://www.kan.org.il/rss/rssFeeder.aspx?id=1',                               limit:4 },
];

// No circuit breaker — simple timeout per channel handles failures

// Block known logo/placeholder images
const BAD_PATTERNS = [
  'mivzakim', 'placeholder', 'noimage', 'no-image',
  'RenderImage', 'walla.co.il/rb/', 'breaking_news',
  // Walla breaking logo: img.walla.co.il/v2/image/... with specific logo IDs
  '2907054','2907055','2907056','2907057','2907058','2907059', // known walla logo IDs
];

// Separate pattern: only block if URL ENDS with or IS a logo file
const LOGO_PATTERNS = ['/logo.', '/logo-', '/brand.', '/favicon.', 'favicon.ico'];

// Sources that NEVER have real images — skip image entirely
const NO_IMAGE_SOURCES = new Set([]);

function isRealImage(url, sourceId) {
  if (!url || url.length < 12) return false;
  if (sourceId && NO_IMAGE_SOURCES.has(sourceId)) return false;
  const l = url.toLowerCase();
  for (const p of BAD_PATTERNS) if (l.includes(p.toLowerCase())) return false;
  // Logo check — more precise: only block if logo is in the filename, not deep in path
  for (const p of LOGO_PATTERNS) if (l.includes(p)) return false;
  // Walla blue mivzakim logo check
  if (url.includes('walla') && url.includes('/image/') && url.includes('2')) {
    if (/\/image\/\d{7}/.test(url) && url.length < 80) return false;
  }
  // Block tiny images (1x1 trackers, spacers)
  if (/[?&](w|width)=(1|2|3|4|5|10|16|20)(&|$)/.test(url)) return false;
  return true;
}

function extractImage(item, sourceId) {
  try {
    const candidates = [];
    // Priority 1: media tags (all variations)
    if (item['media:content']?.$?.url) candidates.push(item['media:content'].$.url);
    if (item['media:thumbnail']?.$?.url) candidates.push(item['media:thumbnail'].$.url);
    // media:group can contain multiple media:content
    if (item['media:group']?.['media:content']) {
      const mg = item['media:group']['media:content'];
      if (Array.isArray(mg)) mg.forEach(m => { if (m?.$?.url) candidates.push(m.$.url); });
      else if (mg?.$?.url) candidates.push(mg.$.url);
    }
    // Priority 2: enclosure
    if (item.enclosure?.url && item.enclosure?.type?.startsWith('image')) candidates.push(item.enclosure.url);
    if (item.enclosure?.url && !item.enclosure?.type) candidates.push(item.enclosure.url);
    // Priority 3: img tags in HTML content (up to 5 candidates)
    const html = item.content || item['content:encoded'] || item.summary || item.description || '';
    const imgs = [...html.matchAll(/<img[^>]+src=["']([^"']{20,})["']/g)].map(m=>m[1]);
    candidates.push(...imgs.slice(0,5));
    // Priority 4: srcset — pick largest
    const srcsets = [...html.matchAll(/srcset=["']([^"']+)["']/g)].map(m=>m[1]);
    srcsets.forEach(ss => {
      const parts = ss.split(',').map(s=>s.trim()).filter(Boolean);
      // Pick the largest (last) srcset entry
      if (parts.length > 0) {
        const last = parts[parts.length-1].split(/\s+/)[0];
        if (last && last.length > 15) candidates.push(last);
      }
    });
    // Priority 5: og:image or twitter:image meta-like patterns in content
    const ogMatch = html.match(/(?:og:image|twitter:image)[^>]*content=["']([^"']{20,})["']/i);
    if (ogMatch) candidates.push(ogMatch[1]);
    // Priority 6: data-src for lazy loaded images
    const dataSrc = [...html.matchAll(/data-src=["']([^"']{20,})["']/g)].map(m=>m[1]);
    candidates.push(...dataSrc.slice(0,3));
    // Return first valid, upgraded image
    for (const url of candidates) {
      if (isRealImage(url, sourceId)) return upgradeImageUrl(url, sourceId);
    }
  } catch(e) {}
  return null;
}

// Upgrade image URL to higher resolution
function upgradeImageUrl(url, sourceId) {
  if (!url) return url;
  try {
    // ynet: change size params to larger
    if (url.includes('ynet-pic') || url.includes('ynet.co.il')) {
      url = url.replace(/\/picserver\d\/\d+\//, (m) => m.replace(/\/\d+\//, '/1200/'));
      url = url.replace(/_\d+\.jpg/, '_1200.jpg');
      url = url.replace(/crop_images\/\d+\/\d+\//, (m) => m.replace(/\/\d+\/\d+\//, '/1200/675/'));
    }
    // haaretz: upgrade to larger
    if (url.includes('haaretz.co.il') || url.includes('img.haaretz')) {
      url = url.replace(/\?imageVersion=\d+x\d+/, '?imageVersion=1200x675');
      url = url.replace(/height=\d+/, 'height=675').replace(/width=\d+/, 'width=1200');
    }
    // walla: upgrade
    if (url.includes('walla.co.il')) {
      url = url.replace(/\/\d+x\d+\//, '/1200x675/');
    }
    // google news thumbnails — request largest available
    if (url.includes('news.google.com') && url.includes('=w')) {
      url = url.replace(/=w\d+(-h\d+)?(-[a-zA-Z]+)?/, '=w1200-h675-rw');
    }
    // mako
    if (url.includes('mako.co.il')) {
      url = url.replace(/\/\d+x\d+\//, '/1200x675/');
      url = url.replace(/width=\d+/, 'width=1200').replace(/height=\d+/, 'height=675');
    }
    // calcalist
    if (url.includes('calcalist')) {
      url = url.replace(/_\d+\.jpg/, '_1200.jpg');
    }
    // n12 / maariv
    if (url.includes('n12.co.il') || url.includes('maariv.co.il')) {
      url = url.replace(/\/\d+x\d+\//, '/1200x675/');
      url = url.replace(/width=\d+/, 'width=1200').replace(/height=\d+/, 'height=675');
    }
    // globes
    if (url.includes('globes.co.il')) {
      url = url.replace(/\/\d+x\d+\//, '/1200x675/');
    }
    // Generic w/h params
    url = url.replace(/[\?&]w=\d+/, (m) => m[0] + 'w=1200');
  } catch(e) {}
  return url;
}

function timeAgo(d) {
  try {
    const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
    if (s < 90) return 'לפני דקה';
    if (s < 3600) return `לפני ${Math.floor(s/60)} דקות`;
    if (s < 7200) return 'לפני שעה';
    if (s < 86400) return `לפני ${Math.floor(s/3600)} שעות`;
    return 'אתמול';
  } catch(e) { return ''; }
}

// Proxy wrapper for channels that block US IPs (12/13/14)
async function fetchWithProxy(url) {
  // Try direct first
  try {
    const feed = await parser.parseURL(url);
    return feed;
  } catch(e1) {}

  // Fallback 1: rss2json API
  try {
    const r2j = 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(url);
    const res = await fetch(r2j, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    if (data.status === 'ok' && data.items?.length) {
      return {
        items: data.items.map(i => ({
          title: i.title, link: i.link, pubDate: i.pubDate,
          contentSnippet: i.description?.replace(/<[^>]+>/g,'').slice(0,200),
          'media:content': (i.thumbnail && i.thumbnail.length > 10) ? { $: { url: i.thumbnail } } :
                           (i.enclosure?.link ? { $: { url: i.enclosure.link } } : undefined),
          'media:thumbnail': (i.thumbnail && i.thumbnail.length > 10) ? { $: { url: i.thumbnail } } : undefined,
          content: i.content || '',
          guid: i.guid
        }))
      };
    }
  } catch(e2) {}

  // Fallback 2: allorigins
  try {
    const proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url);
    return await parser.parseURL(proxyUrl);
  } catch(e3) {}

  // Fallback 3: corsproxy.io
  try {
    const proxyUrl = 'https://corsproxy.io/?' + encodeURIComponent(url);
    return await parser.parseURL(proxyUrl);
  } catch(e4) {}

  throw new Error('All proxies failed');
}

const PROXY_CHANNELS = new Set([]); // all channels use direct or Google News

// Read GitHub Actions cache for blocked channels
async function readGithubCache() {
  try {
    const cachePath = path.join(__dirname, 'public', 'news-cache.json');
    const fs = require('fs');
    if (fs.existsSync(cachePath)) {
      const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const age = Date.now() - new Date(data.updated).getTime();
      if (age < 600000) { // max 10 min old
        console.log(`GitHub cache: ${data.total} items, age ${Math.round(age/1000)}s`);
        return data.items || [];
      }
    }
  } catch(e) {}
  return null;
}

async function fetchChannel(ch) {
  try {
    let feed;
    if (PROXY_CHANNELS.has(ch.id)) {
      feed = await fetchWithProxy(ch.url);
    } else {
      feed = await parser.parseURL(ch.url);
    }
    if (!feed || !feed.items) return [];
    return (feed.items || []).slice(0, ch.limit || 5).map((item, i) => {
      let image = extractImage(item, ch.id);
      // If RSS gave no image, check og:image cache from previous scrapes
      if (!image && item.link && ogCache.has(item.link)) {
        image = ogCache.get(item.link);
      }
      return {
        id: ch.id + '_' + (item.guid || item.link || i),
        source: ch.id, sourceName: ch.name, sourceColor: ch.color, sourceIcon: ch.icon,
        title: (item.title || '').replace(/<[^>]+>/g, '').trim(),
        desc: (item.contentSnippet || item.summary || '').replace(/<[^>]+>/g, '').trim().slice(0, 200),
        link: item.link || '',
        image,
        timeAgo: timeAgo(item.pubDate || item.isoDate),
        ts: new Date(item.pubDate || item.isoDate).getTime() || (Date.now() - i * 60000)
      };
    });
  } catch(e) {
    console.log(`ERR ${ch.name}: ${e.message.slice(0,60)}`);
    return [];
  }
}

let newsCache = [], cacheTime = 0;

// ── OG:IMAGE SCRAPER — fills missing images in background ──
const ogCache = new Map(); // url → imageUrl (persists across refreshes)
const OG_MAX_CACHE = 200;
const OG_CONCURRENT = 5; // max parallel fetches
const OG_TIMEOUT = 4000;

async function scrapeOgImage(articleUrl) {
  if (!articleUrl || ogCache.has(articleUrl)) return ogCache.get(articleUrl) || null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OG_TIMEOUT);
    const res = await fetch(articleUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'he-IL,he;q=0.9'
      },
      signal: controller.signal,
      redirect: 'follow'
    });
    clearTimeout(timeout);
    if (!res.ok) { ogCache.set(articleUrl, null); return null; }
    // Read only first 30KB — og:image is always in <head>
    const reader = res.body.getReader();
    let html = '';
    let bytesRead = 0;
    const maxBytes = 30000;
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value, { stream: true });
      bytesRead += value.length;
    }
    try { reader.cancel(); } catch(e) {}

    // Extract og:image, twitter:image, or first large image
    let img = null;
    // Priority 1: og:image
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']{20,})["']/i)
                 || html.match(/<meta[^>]+content=["']([^"']{20,})["'][^>]+property=["']og:image["']/i);
    if (ogMatch) img = ogMatch[1];
    // Priority 2: twitter:image
    if (!img) {
      const twMatch = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']{20,})["']/i)
                   || html.match(/<meta[^>]+content=["']([^"']{20,})["'][^>]+name=["']twitter:image["']/i);
      if (twMatch) img = twMatch[1];
    }
    // Priority 3: first large img in article
    if (!img) {
      const imgTags = [...html.matchAll(/<img[^>]+src=["']([^"']{30,})["']/gi)].map(m => m[1]);
      for (const candidate of imgTags.slice(0, 5)) {
        if (isRealImage(candidate, null) && !candidate.includes('avatar') && !candidate.includes('icon')) {
          img = candidate;
          break;
        }
      }
    }
    // Resolve relative URLs
    if (img && !img.startsWith('http')) {
      try {
        const base = new URL(articleUrl);
        img = new URL(img, base.origin).href;
      } catch(e) {}
    }
    // Upgrade and cache
    if (img && isRealImage(img, null)) {
      img = upgradeImageUrl(img, null);
      ogCache.set(articleUrl, img);
      return img;
    }
    ogCache.set(articleUrl, null);
    return null;
  } catch(e) {
    ogCache.set(articleUrl, null);
    return null;
  }
}

// Run in background: scrape og:image for items with no image
async function fillMissingImages() {
  const missing = newsCache.filter(item => !item.image && item.link);
  if (!missing.length) return;
  console.log(`[OG] Scraping ${missing.length} missing images...`);

  // Process in batches of OG_CONCURRENT
  for (let i = 0; i < missing.length; i += OG_CONCURRENT) {
    const batch = missing.slice(i, i + OG_CONCURRENT);
    const results = await Promise.allSettled(
      batch.map(item => scrapeOgImage(item.link))
    );
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled' && r.value) {
        batch[idx].image = r.value;
      }
    });
  }

  // Keep ogCache bounded
  if (ogCache.size > OG_MAX_CACHE) {
    const keys = [...ogCache.keys()];
    keys.slice(0, 80).forEach(k => ogCache.delete(k));
  }

  const filled = missing.filter(i => i.image).length;
  console.log(`[OG] Filled ${filled}/${missing.length} images`);
}

async function refreshNews() {

  // Direct channels (not blocked)
  const directChannels = CHANNELS.filter(ch => !PROXY_CHANNELS.has(ch.id));
  const results = await Promise.allSettled(directChannels.map(ch => fetchChannel(ch)));
  let combined = [], ok = 0;
  results.forEach(r => { if (r.status === 'fulfilled' && r.value.length > 0) { combined = combined.concat(r.value); ok++; } });

  // Try to get blocked channels from GitHub Actions cache
  const cached = await readGithubCache();
  if (cached && cached.length > 0) {
    const cachedIds = new Set(combined.map(i => i.id));
    const fromCache = cached.filter(i => PROXY_CHANNELS.has(i.source) && !cachedIds.has(i.id));
    combined = [...combined, ...fromCache];
    ok += new Set(fromCache.map(i => i.source)).size;
  } else {
    // Fallback: try proxy for blocked channels anyway
    const proxyResults = await Promise.allSettled(CHANNELS.filter(ch => PROXY_CHANNELS.has(ch.id)).map(ch => fetchChannel(ch)));
    proxyResults.forEach(r => { if (r.status === 'fulfilled' && r.value.length > 0) { combined = combined.concat(r.value); ok++; } });
  }

  combined.sort((a, b) => b.ts - a.ts);
  // Dedup by title similarity — remove near-duplicates across channels
  const seenTitles = new Set();
  combined = combined.filter(item => {
    const key = item.title.replace(/[^א-תA-z]/g,'').slice(0,25).toLowerCase();
    if (seenTitles.has(key)) return false;
    seenTitles.add(key);
    return true;
  });
  newsCache = combined.slice(0, 60); // 60 items — 17 channels
  cacheTime = Date.now();
  console.log(`${combined.length} items, ${ok}/${CHANNELS.length} channels`);
  // Push new breaking items to subscribers
  checkAndPushNewItems(newsCache);
  // Send breaking to Telegram
  checkAndSendToTelegram(newsCache);
  // Fill missing images in background (don't block response)
  fillMissingImages().catch(e => console.log('[OG] Error:', e.message));
}

app.get('/api/news', async (req, res) => {
  if (Date.now() - cacheTime > 60000) await refreshNews(); // 60s cache — less load
  res.json({ items: newsCache, updated: new Date(cacheTime).toISOString(), total: newsCache.length });
});

// ── AI PROXY — Claude Haiku ──
// Summary cache — max 80 entries, LRU-lite
const summaryCache = new Map();
function cacheSet(k, v) {
  if (summaryCache.size >= 50) {
    // delete oldest entry
    summaryCache.delete(summaryCache.keys().next().value);
  }
  summaryCache.set(k, v);
}
// Periodic memory cleanup every 30 min
setInterval(() => {
  summaryCache.clear();
  if (global.gc) global.gc(); // trigger GC if --expose-gc
  console.log('Memory cleanup: summary cache cleared');
}, 15 * 60 * 1000);

app.post('/api/ai/summarize', async (req, res) => {
  const { title, desc } = req.body || {};
  if (!title) { res.json({ text: '—' }); return; }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.json({ text: 'ANTHROPIC_API_KEY חסר ב-Render Environment Variables.' }); return; }
  // Cache hit — return instantly
  const cacheKey = title.slice(0, 80);
  if (summaryCache.has(cacheKey)) { res.json({ text: summaryCache.get(cacheKey) }); return; }
  // Try models in order — stop at first success
  const MODELS = [
    'claude-haiku-4-5-20251001',
    'claude-haiku-3-5-20241022',
    'claude-sonnet-4-5'   // fallback — costs more but never overloaded
  ];
  const prompt = `אתה עורך חדשות ישראלי. כתוב משפט אחד קצר וחד בעברית שמסכם את הכתבה הבאה. רק המשפט, ללא הסברים.\n\nכותרת: ${title}\n${desc ? 'תיאור: ' + desc : ''}`;

  for (const model of MODELS) {
    try {
      const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({ model, max_tokens: 100, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(10000)
      });
      const data = await apiRes.json();
      console.log(`${model} status:${apiRes.status} err:${data?.error?.type||'none'} content:${JSON.stringify(data?.content?.[0])?.slice(0,80)}`);
      // 529 = overloaded, 529/overload_error = try next
      if (apiRes.status === 529 || data?.error?.type === 'overloaded_error') {
        console.log(`${model} overloaded, trying next...`);
        continue;
      }
      // Any other error — try next model too
      if (data?.error) {
        console.log(`${model} error: ${data.error.type} — ${data.error.message}`);
        continue;
      }
      const text = data?.content?.[0]?.text?.trim();
      if (text) {
        cacheSet(cacheKey, text);
        res.json({ text });
        return;
      }
      continue; // empty text — try next model
    } catch(e) {
      console.log(`${model} err: ${e.message}`);
    }
  }
  res.json({ text: '—' }); // all models failed
});

// ── ALERTS ENGINE ──
let currentAlert = null;
let alertHistory = [];
let tzofarWs = null;
let tzofarConnected = false;
let orefConnected = false;
const sseClients = new Set();
const MAX_SSE_CLIENTS = 20; // low memory budget on free tier

function broadcastSSE(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach(res => {
    try { res.write(data); } catch(e) { sseClients.delete(res); }
  });
}

// ── SOURCE 1: oref.org.il polling (primary — works from any IP) ──
let lastOrefAlertId = null;
let orefAlertClearTimer = null;

async function pollOref() {
  try {
    const r = await fetch('https://www.oref.org.il/warningMessages/alert/Alerts.json', {
      headers: {
        'Referer': 'https://www.oref.org.il/',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: AbortSignal.timeout(4000)
    });

    if (!orefConnected) {
      orefConnected = true;
      console.log('Oref polling ✓');
      broadcastSSE({ alert: currentAlert, connected: true });
    }

    const text = await r.text();
    const trimmed = text.trim();

    if (!trimmed || trimmed === '' || trimmed === '\r\n' || trimmed === '\\r\\n') {
      if (currentAlert) {
        console.log('Oref: all clear');
        currentAlert = null;
        broadcastSSE({ alert: null, connected: true });
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(trimmed); } catch(e) { return; }

    if (!msg || !msg.data || !Array.isArray(msg.data) || msg.data.length === 0) {
      if (currentAlert) { currentAlert = null; broadcastSSE({ alert: null, connected: true }); }
      return;
    }

    const alertId = String(msg.id || '');
    if (alertId && alertId === lastOrefAlertId) return;
    lastOrefAlertId = alertId;

    currentAlert = {
      data: msg.data,
      title: msg.title || msg.cat || 'ירי רקטות',
      id: alertId || String(Date.now()),
      ts: Date.now()
    };
    alertHistory.unshift({ ...currentAlert, alertDate: new Date().toISOString() });
    if (alertHistory.length > 20) alertHistory.length = 20;
    console.log('🚨 Oref alert:', currentAlert.title, currentAlert.data.slice(0, 3));
    broadcastSSE({ alert: currentAlert, connected: true });
    broadcastPush(currentAlert);

    // Auto-clear after 2 minutes if oref goes quiet
    if (orefAlertClearTimer) clearTimeout(orefAlertClearTimer);
    orefAlertClearTimer = setTimeout(() => {
      if (currentAlert) {
        currentAlert = null;
        lastOrefAlertId = null;
        broadcastSSE({ alert: null, connected: true });
      }
    }, 120000);

  } catch(e) {
    if (orefConnected) {
      orefConnected = false;
      console.log('Oref poll err:', e.message);
      broadcastSSE({ alert: currentAlert, connected: false });
    }
  }
}

pollOref();
setInterval(pollOref, 15000); // 15s polling — lower memory pressure

// Tzofar WebSocket DISABLED — consumes memory on free tier, oref polling is sufficient

// ── SOURCE 2: Tzofar WebSocket (secondary — may be blocked from US IP) ──
function connectTzofar() {
  try {
    if (tzofarWs) { try { tzofarWs.terminate(); } catch(e) {} }
    console.log('Connecting Tzofar WebSocket...');
    tzofarWs = new WebSocket('wss://ws.tzevaadom.co.il/socket?platform=WEB', {
      headers: { 'Origin': 'https://www.tzevaadom.co.il', 'User-Agent': 'Mozilla/5.0' }
    });
    tzofarWs.on('open', () => {
      tzofarConnected = true;
      console.log('Tzofar WebSocket ✓ (bonus source)');
    });
    tzofarWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.data && Array.isArray(msg.data) && msg.data.length > 0) {
          const newAlert = { data: msg.data, title: msg.title || 'ירי רקטות', id: String(msg.id || Date.now()), ts: Date.now() };
          if (!currentAlert || currentAlert.id !== newAlert.id) {
            currentAlert = newAlert;
            alertHistory.unshift({ ...currentAlert, alertDate: new Date().toISOString() });
            if (alertHistory.length > 20) alertHistory.length = 20;
            console.log('🚨 Tzofar alert:', currentAlert.title);
            broadcastSSE({ alert: currentAlert, connected: true });
            broadcastPush(currentAlert);
          }
        }
        if (msg.type === 'ALERT') {
          const cities = msg.notification?.cities || msg.cities || [];
          if (cities.length > 0 && !currentAlert) {
            currentAlert = { data: cities, title: msg.notification?.threat || 'ירי רקטות', id: String(Date.now()), ts: Date.now() };
            alertHistory.unshift({ ...currentAlert, alertDate: new Date().toISOString() });
            broadcastSSE({ alert: currentAlert, connected: true });
          }
        }
        if (msg.type === 'ALL_CLEAR') {
          if (currentAlert) { currentAlert = null; broadcastSSE({ alert: null, connected: true }); }
        }
      } catch(e) {}
    });
    tzofarWs.on('close', () => { tzofarConnected = false; setTimeout(connectTzofar, 15000); });
    tzofarWs.on('error', (e) => { tzofarConnected = false; console.log('Tzofar WS err:', e.message); setTimeout(connectTzofar, 30000); });
    const ping = setInterval(() => {
      if (tzofarWs?.readyState === WebSocket.OPEN) tzofarWs.ping();
      else clearInterval(ping);
    }, 55000);
  } catch(e) {
    console.log('Tzofar err:', e.message);
    setTimeout(connectTzofar, 30000);
  }
}
// connectTzofar(); — disabled to save memory on free tier

// SSE stream for browser
app.get('/api/alerts/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ alert: currentAlert, connected: orefConnected })}\n\n`);
  if (sseClients.size >= MAX_SSE_CLIENTS) {
    // kick oldest client
    const oldest = sseClients.values().next().value;
    oldest.end();
    sseClients.delete(oldest);
  }
  sseClients.add(res);
  // Heartbeat every 25s to keep connection alive through proxies
  const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch(e) { clearInterval(hb); } }, 25000);
  req.on('close', () => { sseClients.delete(res); clearInterval(hb); });
});

// Polling fallback
app.get('/api/alerts', (req, res) => {
  res.json({ alert: currentAlert, connected: orefConnected });
});

// History — local cache (populated by Tzofar WebSocket)
app.get('/api/alerts/history', (req, res) => {
  res.json(alertHistory);
});

// Tzevaadom alerts-history — public API, works from any IP, real historical data
app.get('/api/alerts/oref-history', async (req, res) => {
  try {
    const r = await fetch('https://api.tzevaadom.co.il/alerts-history', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000)
    });
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) {
      res.json(alertHistory.slice(0, 30)); return;
    }
    // tzevaadom format: [{id, alerts:[{time(unix), cities:[], threat, isDrill}]}]
    // threat: 0=ירי רקטות, 1=חדירת כלי טיס, 2=רעידת אדמה, 3=חומרים מסוכנים, 5=חדירת מחבלים
    const threatNames = {0:'ירי רקטות',1:'חדירת כלי טיס עוין',2:'רעידת אדמה',3:'חומרים מסוכנים',4:'צונאמי',5:'חדירת מחבלים',6:'אירוע רדיולוגי',7:'אירוע לא קונבנציונלי',13:'אירוע בטחוני'};
    const normalized = [];
    data.slice(0, 30).forEach(event => {
      if (!event.alerts) return;
      event.alerts.forEach(a => {
        if (a.isDrill) return;
        normalized.push({
          alertDate: new Date(a.time * 1000).toISOString(),
          title: threatNames[a.threat] || 'אזעקה',
          data: a.cities || [],
          id: event.id + '_' + a.time
        });
      });
    });
    normalized.sort((a,b) => new Date(b.alertDate) - new Date(a.alertDate));
    res.json(normalized.slice(0, 50));
  } catch(e) {
    console.log('tzevaadom history err:', e.message);
    res.json(alertHistory.slice(0, 30));
  }
});


// ── PUSH SUBSCRIPTION ENDPOINTS ──
app.get('/api/version', (req, res) => {
  res.json({ version: '22', ts: Date.now() });
});

app.get('/api/push/status', (req, res) => {
  res.json({
    webpush: !!_webpush,
    vapidSet: !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY),
    subscribers: pushSubscriptions.length,
    publicKey: VAPID_PUBLIC_KEY?.slice(0,20) + '...'
  });
});

app.post('/api/push/test', async (req, res) => {
  if (!pushSubscriptions.length) { res.json({ ok:false, msg:'אין מנויים' }); return; }
  await broadcastNewsPush({
    id: 'test-' + Date.now(),
    title: 'בדיקת פוש — חדשות IL עובד! 🎉',
    sourceName: 'חדשות IL',
    link: '/',
    image: '/icon-192.png'
  });
  res.json({ ok: true, subscribers: pushSubscriptions.length });
});

app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint || !sub.keys) { res.status(400).json({ error: 'Invalid subscription' }); return; }
  const exists = pushSubscriptions.find(s => s.endpoint === sub.endpoint);
  if (!exists) {
    pushSubscriptions.push(sub);
    saveSubs();
    console.log(`New push subscription. Total: ${pushSubscriptions.length}`);
  }
  res.json({ ok: true, total: pushSubscriptions.length });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== endpoint);
  saveSubs();
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({
  ok: true, items: newsCache.length, oref: orefConnected,
  sseClients: sseClients.size, pushSubs: pushSubscriptions.length,
  ogCacheSize: ogCache.size,
  imagesTotal: newsCache.filter(i => i.image).length,
  imagesMissing: newsCache.filter(i => !i.image).length
}));

// Debug: show image status per item
app.get('/api/debug/images', (req, res) => {
  res.json(newsCache.map(item => ({
    source: item.sourceName,
    title: (item.title || '').slice(0, 50),
    hasImage: !!item.image,
    imageUrl: item.image ? item.image.slice(0, 80) + '...' : null,
    link: item.link ? item.link.slice(0, 60) : null
  })));
});

// Memory watchdog — log every 5 min, emergency cleanup if > 420MB
setInterval(() => {
  const mb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  console.log(`MEM: ${mb}MB`);
  if (mb > 420) {
    console.log('⚠️ MEM HIGH: clearing caches');
    summaryCache.clear();
    ogCache.clear();
    newsCache = newsCache.slice(0, 10);
  }
}, 5 * 60 * 1000);



// ══ DAILY EVENING SUMMARY — 20:00 Israel time ══
let lastDailySummaryDate = '';

async function generateDailySummary() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !pushSubscriptions.length || !newsCache.length) return;

  const cutoff = Date.now() - 8 * 60 * 60 * 1000;
  const todayItems = newsCache.filter(i => i.ts > cutoff);
  if (todayItems.length < 3) return;

  const seen = new Set();
  const top5 = [];
  for (const item of todayItems) {
    if (top5.length >= 5) break;
    const key = (item.title || '').replace(/[^\u05D0-\u05EA]/g,'').slice(0,15);
    if (!seen.has(key)) { seen.add(key); top5.push(item); }
  }

  const headlines = top5.map((item, n) => (n+1) + '. ' + item.title).join('\n');

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
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({ model, max_tokens: 250, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(15000)
      });
      const data = await res.json();
      if (data?.error) { console.log('Daily AI err:', data.error.type); continue; }
      summary = data?.content?.[0]?.text?.trim() || '';
      if (summary) break;
    } catch(e) { console.log('Daily summary err:', e.message); }
  }

  if (!summary) {
    summary = top5.slice(0,3).map(i => i.title).join(' | ');
  }

  const payload = {
    title: '\u{1F4CB} \u05E1\u05D9\u05DB\u05D5\u05DD \u05D9\u05D5\u05DD \u2014 \u05D7\u05D3\u05E9\u05D5\u05EA IL',
    body: summary.slice(0, 150),
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: '/' },
    vibrate: [200, 100, 200],
    dir: 'rtl',
    lang: 'he',
    tag: 'daily-summary',
    renotify: true
  };

  console.log('[DAILY] Sending to', pushSubscriptions.length, 'subscribers');
  const results = await Promise.allSettled(pushSubscriptions.map(s => sendWebPush(s, payload)));
  const ok = results.filter(r => r.status === 'fulfilled' && r.value).length;
  console.log('[DAILY] Sent', ok + '/' + pushSubscriptions.length);
}

// Check every minute if it's 20:00 IL
setInterval(() => {
  const now = new Date();
  const ilTime = new Intl.DateTimeFormat('en-IL', {
    timeZone: 'Asia/Jerusalem', hour: 'numeric', minute: 'numeric', hour12: false
  }).format(now);
  const [ilHour, ilMin] = ilTime.split(':').map(Number);
  const todayStr = now.toISOString().slice(0, 10);
  if (ilHour === 20 && ilMin < 2 && lastDailySummaryDate !== todayStr) {
    lastDailySummaryDate = todayStr;
    console.log('[DAILY] Triggering 20:00 summary...');
    generateDailySummary().catch(e => console.log('[DAILY] Failed:', e.message));
  }
}, 60 * 1000);

// Manual trigger for testing
app.post('/api/push/daily-summary', async (req, res) => {
  const secret = req.headers['x-secret'] || (req.body && req.body.secret);
  if (secret !== (process.env.ADMIN_SECRET || 'hdshot-admin')) {
    return res.status(403).json({ ok: false, msg: 'Unauthorized' });
  }
  await generateDailySummary();
  res.json({ ok: true, subscribers: pushSubscriptions.length });
});


// ══════════════════════════════════════════════
// WHATSAPP BOT — Telegram fallback (WhatsApp needs business API)
// שולח מבזקים ל-Telegram channel אוטומטית
// ══════════════════════════════════════════════
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHANNEL   = process.env.TELEGRAM_CHANNEL  || '@CumtaAlertsChannel';

const sentToTelegram = new Set(); // prevent duplicates

async function sendToTelegram(item) {
  if (!TELEGRAM_BOT_TOKEN) return;
  if (sentToTelegram.has(item.id)) return;
  sentToTelegram.add(item.id);
  if (sentToTelegram.size > 300) {
    const arr = [...sentToTelegram];
    arr.slice(0, 100).forEach(id => sentToTelegram.delete(id));
  }

  const src   = item.sourceName || 'חדשות IL';
  const title = item.title || '';
  const link  = item.link  || 'https://israel-news-wus7.onrender.com';

  // Telegram message — RTL, markdown
  const escaped = title.replace(/[*_[\]()~`>#+=|{}.!-]/g, '\\$&');
  const text = [
    '📰 *' + escaped + '*',
    '',
    '🔗 ' + src,
    link
  ].join('\n');

  try {
    const res = await fetch(
      'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id:    TELEGRAM_CHANNEL,
          text,
          parse_mode: 'Markdown',
          disable_web_page_preview: false
        }),
        signal: AbortSignal.timeout(8000)
      }
    );
    const data = await res.json();
    if (!data.ok) console.log('[TG] Error:', data.description);
    else console.log('[TG] Sent:', title.slice(0, 40));
  } catch(e) {
    console.log('[TG] Failed:', e.message);
  }
}

// שלח מבזקים מ-2+ ערוצים ל-Telegram
function checkAndSendToTelegram(items) {
  if (!TELEGRAM_BOT_TOKEN || !items.length) return;
  const now = Date.now();
  const fresh = items.filter(i => !sentToTelegram.has(i.id) && (now - (i.ts||0)) < 8 * 60 * 1000);

  // group by title similarity
  const groups = {};
  fresh.forEach(item => {
    const key = (item.title||'').replace(/[^\u05D0-\u05EA]/g,'').slice(0,20);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  });

  // only breaking (2+ channels)
  Object.values(groups).forEach(group => {
    if (group.length >= 2) sendToTelegram(group[0]);
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Port ${PORT}`);
  refreshNews();
  setInterval(refreshNews, 10000);
});
