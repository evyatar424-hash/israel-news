const express = require('express');
const Parser = require('rss-parser');
const cors = require('cors');
const https = require('https');
const http = require('http');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const parser = new Parser({
  timeout: 12000,
  customFields: { item: ['media:content','media:thumbnail','enclosure','image'] },
  headers: {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  }
});

// ─── CHANNELS — hottest Israeli news sites ───
const CHANNELS = [
  { id:'ynet',     name:'ynet',         color:'#E8001E', icon:'📰', url:'https://www.ynet.co.il/Integration/StoryRss2.xml',                          limit:5 },
  { id:'ynet_war', name:'ynet מלחמה',   color:'#ff4444', icon:'🔴', url:'https://www.ynet.co.il/Integration/StoryRss2784.xml',                       limit:4 },
  { id:'walla',    name:'וואלה',        color:'#FF6B00', icon:'🔥', url:'https://rss.walla.co.il/feed/22',                                            limit:3 },
  { id:'walla_w',  name:'וואלה ביטחון', color:'#cc5500', icon:'⚔️', url:'https://rss.walla.co.il/feed/2686',                                         limit:3 },
  { id:'kan',      name:'כאן 11',       color:'#2563EB', icon:'🎙️', url:'https://www.kan.org.il/Rss/RssKan.aspx?CatId=30',                           limit:4 },
  { id:'ch12',     name:'ערוץ 12',      color:'#C8102E', icon:'📺', url:'https://rcs.mako.co.il/rss/31750a2610f26110VgnVCM2000002a0c10acRCRD.xml',   limit:4 },
  { id:'ch13',     name:'ערוץ 13',      color:'#7C3AED', icon:'📡', url:'https://13tv.co.il/rss/news/',                                               limit:4 },
  { id:'ch14',     name:'ערוץ 14',      color:'#d97706', icon:'🦅', url:'https://www.now14.co.il/feed/',                                              limit:4 },
  { id:'mako',     name:'מאקו',         color:'#e11d48', icon:'🎬', url:'https://rcs.mako.co.il/rss/news-new.xml',                                    limit:3 },
  { id:'maariv',   name:'מעריב',        color:'#0891B2', icon:'🗞️', url:'https://www.maariv.co.il/Rss/RssFeedsMivzakiChadashot',                    limit:4 },
  { id:'haaretz',  name:'הארץ',         color:'#1a1a1a', icon:'📜', url:'https://www.haaretz.co.il/srv/htz-rss',                                      limit:3 },
  { id:'inn',      name:'ערוץ 7',       color:'#1565c0', icon:'✡️', url:'https://www.israelnationalnews.com/rss.aspx',                                limit:3 },
  { id:'idf',      name:'דובר צבא',     color:'#16a34a', icon:'🪖', url:'https://www.idf.il/rss/',                                                    limit:3 },
];

// Known logo/placeholder image patterns to block
const BAD_IMG_PATTERNS = [
  'mivzakim', 'logo', 'placeholder', 'default', 'noimage', 'no-image',
  'breaking', 'generic', 'walla-logo', 'brand', 'icon', 'favicon',
  'walla_logo', 'mako-logo', 'ynet-logo', 'avatar', 'profile'
];

function isRealImage(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  // Block known bad patterns
  for (const p of BAD_IMG_PATTERNS) {
    if (lower.includes(p)) return false;
  }
  // Must look like a real photo URL (jpg, jpeg, png, webp, gif)
  if (!/\.(jpe?g|png|webp|gif)(\?|$)/i.test(url) && !url.includes('image') && !url.includes('photo') && !url.includes('img')) {
    // Still allow CDN-style URLs that don't have extension
    if (!url.includes('cdn') && !url.includes('media') && !url.includes('upload')) return false;
  }
  return true;
}

function extractImage(item) {
  try {
    const candidates = [];
    if (item['media:content']?.$?.url) candidates.push(item['media:content'].$.url);
    if (item['media:thumbnail']?.$?.url) candidates.push(item['media:thumbnail'].$.url);
    if (item.enclosure?.url && item.enclosure?.type?.startsWith('image')) candidates.push(item.enclosure.url);
    // Try content HTML
    const html = item.content || item['content:encoded'] || item.summary || '';
    const m = html.match(/<img[^>]+src=["']([^"']{20,})["']/);
    if (m) candidates.push(m[1]);
    for (const c of candidates) {
      if (isRealImage(c)) return c;
    }
  } catch(e) {}
  return null;
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

async function fetchChannel(ch) {
  try {
    const feed = await parser.parseURL(ch.url);
    return (feed.items || []).slice(0, ch.limit || 5).map((item, i) => ({
      id: ch.id + '_' + (item.guid || item.link || i),
      source: ch.id, sourceName: ch.name, sourceColor: ch.color, sourceIcon: ch.icon,
      title: (item.title || '').replace(/<[^>]+>/g, '').trim(),
      desc: (item.contentSnippet || item.summary || '').replace(/<[^>]+>/g, '').trim().slice(0, 200),
      link: item.link || '',
      image: extractImage(item),
      timeAgo: timeAgo(item.pubDate || item.isoDate),
      ts: new Date(item.pubDate || item.isoDate).getTime() || (Date.now() - i * 60000)
    }));
  } catch(e) {
    console.log(`ERR ${ch.name}: ${e.message.slice(0, 80)}`);
    return [];
  }
}

let newsCache = [], cacheTime = 0;
const CACHE_TTL = 10000;

async function refreshNews() {
  const results = await Promise.allSettled(CHANNELS.map(ch => fetchChannel(ch)));
  let combined = [], ok = 0;
  results.forEach(r => { if (r.status === 'fulfilled' && r.value.length > 0) { combined = combined.concat(r.value); ok++; } });
  combined.sort((a, b) => b.ts - a.ts);
  newsCache = combined; cacheTime = Date.now();
  console.log(`${combined.length} items, ${ok}/${CHANNELS.length} channels`);
}

app.get('/api/news', async (req, res) => {
  if (Date.now() - cacheTime > CACHE_TTL) await refreshNews();
  res.json({ items: newsCache, updated: new Date(cacheTime).toISOString(), total: newsCache.length });
});

// ─── ALERTS: dual source — oref + fallback ───
// oref.org.il only works from Israeli IPs (Render is USA)
// We try it, and also expose a manual test endpoint
function fetchOref(path, cb) {
  const req = https.get({
    hostname: 'www.oref.org.il',
    path,
    timeout: 6000,
    headers: {
      'Referer': 'https://www.oref.org.il/',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'he-IL,he;q=0.9',
    }
  }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => cb(null, d, res.statusCode));
  });
  req.on('error', err => cb(err));
  req.on('timeout', () => { req.destroy(); cb(new Error('timeout')); });
}

app.get('/api/alerts', (req, res) => {
  fetchOref('/WarningMessages/alert/alerts.json', (err, data, status) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Oref-Status', status || 'error');
    if (err) { res.json({ error: err.message, geo_blocked: true }); return; }
    res.send(data || '{}');
  });
});

app.get('/api/alerts/history', (req, res) => {
  fetchOref('/WarningMessages/History/AlertsHistory.json', (err, data) => {
    res.setHeader('Content-Type', 'application/json');
    if (err) { res.json([]); return; }
    try {
      const parsed = JSON.parse(data);
      res.json(Array.isArray(parsed) ? parsed : []);
    } catch(e) { res.json([]); }
  });
});

// Debug endpoint — shows raw oref response
app.get('/api/debug/alerts', (req, res) => {
  fetchOref('/WarningMessages/alert/alerts.json', (err, data, status) => {
    res.json({ err: err?.message, status, data, time: new Date().toISOString() });
  });
});

app.get('/health', (req, res) => res.json({ ok: true, items: newsCache.length, cacheAge: Date.now() - cacheTime }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  refreshNews();
  setInterval(refreshNews, CACHE_TTL);
});
