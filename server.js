const express = require('express');
const Parser = require('rss-parser');
const cors = require('cors');
const https = require('https');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

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

// Image block: bad patterns + bad source domains
const BAD_IMG_PATTERNS = [
  'mivzakim', '/logo', 'placeholder', 'default', 'noimage', 'no-image',
  'breaking', 'generic', 'brand', 'favicon', 'avatar', 'profile',
  'walla.co.il/RenderImage', // walla's logo renderer
  'breaking_news', 'bkn_'
];

// Walla uses img.walla.co.il/RenderImage?... for logos — block entire domain pattern
const BAD_IMG_DOMAINS = [
  /img\.walla\.co\.il\/RenderImage/,
  /walla\.co\.il\/rb\//,
];

function isRealImage(url) {
  if (!url || url.length < 10) return false;
  const lower = url.toLowerCase();
  for (const p of BAD_IMG_PATTERNS) if (lower.includes(p.toLowerCase())) return false;
  for (const rx of BAD_IMG_DOMAINS) if (rx.test(url)) return false;
  // Walla breaking news image — their square blue logo
  if (url.includes('walla') && url.includes('RenderImage')) return false;
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

// ─── AI PROXY — so API key isn't exposed in browser ───
app.post('/api/ai/summarize', express.json(), async (req, res) => {
  const { title, desc } = req.body || {};
  if (!title) { res.json({ text: '—' }); return; }
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        system: 'אתה עורך חדשות ישראלי. כתוב משפט אחד קצר וחד בעברית שמסכם את הכתבה.',
        messages: [{ role: 'user', content: `${title}\n${desc || ''}` }]
      })
    });
    const data = await response.json();
    const text = data?.content?.[0]?.text || '—';
    res.json({ text });
  } catch(e) {
    res.json({ text: 'שגיאת חיבור.' });
  }
});

// oref history helper (works even geo-blocked, history is less strict)
function fetchOref(path, cb) {
  const req = https.get({
    hostname: 'www.oref.org.il', path, timeout: 6000,
    headers: { 'Referer': 'https://www.oref.org.il/', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'Mozilla/5.0' }
  }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>cb(null,d)); });
  req.on('error', err => cb(err));
  req.on('timeout', () => { req.destroy(); cb(new Error('timeout')); });
}

// ─── ALERTS: Tzofar WebSocket (works worldwide, no geo-block) ───
const WebSocket = require('ws');

let currentAlert = null; // { data, title, id, ts }
let alertHistory = [];
let tzofarWs = null;
let tzofarConnected = false;

function connectTzofar() {
  try {
    if (tzofarWs) { try { tzofarWs.terminate(); } catch(e) {} }
    console.log('Connecting to Tzofar WebSocket...');
    tzofarWs = new WebSocket('wss://ws.tzevaadom.co.il/socket?platform=WEB', {
      headers: {
        'Origin': 'https://www.tzevaadom.co.il',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
      }
    });

    tzofarWs.on('open', () => {
      tzofarConnected = true;
      console.log('Tzofar connected ✓');
    });

    tzofarWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        console.log('Tzofar msg:', JSON.stringify(msg).slice(0, 200));

        // Tzofar sends: { type: 'ALERT', notification: { cities: [...], threat: '...', ... } }
        // or: { type: 4, ... } (raw pikud haoref format)
        if (msg.type === 'ALERT' || msg.type === 'alert') {
          const cities = msg.notification?.cities || msg.cities || msg.data || [];
          const title = msg.notification?.threat || msg.title || 'ירי רקטות';
          currentAlert = { data: Array.isArray(cities) ? cities : [cities], title, id: Date.now().toString(), ts: Date.now() };
          // Add to history
          alertHistory.unshift({ ...currentAlert, alertDate: new Date().toISOString() });
          if (alertHistory.length > 50) alertHistory = alertHistory.slice(0, 50);
          broadcastAlert(currentAlert);
        } else if (msg.type === 'ALL_CLEAR' || msg.type === 'clear') {
          currentAlert = null;
          broadcastAlert(null);
        }
        // Handle raw pikud format: { id, cat, title, data: [...] }
        if (msg.id && msg.data && Array.isArray(msg.data) && msg.data.length > 0) {
          currentAlert = { data: msg.data, title: msg.title || 'ירי רקטות', id: msg.id, ts: Date.now() };
          alertHistory.unshift({ ...currentAlert, alertDate: new Date().toISOString() });
          if (alertHistory.length > 50) alertHistory = alertHistory.slice(0, 50);
          broadcastAlert(currentAlert);
        }
      } catch(e) { console.log('Tzofar parse err:', e.message); }
    });

    tzofarWs.on('close', () => {
      tzofarConnected = false;
      console.log('Tzofar disconnected, reconnecting in 10s...');
      setTimeout(connectTzofar, 10000);
    });

    tzofarWs.on('error', (e) => {
      tzofarConnected = false;
      console.log('Tzofar error:', e.message);
      setTimeout(connectTzofar, 15000);
    });

    // Keepalive ping every 60s
    setInterval(() => {
      if (tzofarWs && tzofarWs.readyState === WebSocket.OPEN) {
        tzofarWs.ping();
      }
    }, 60000);

  } catch(e) {
    console.log('Tzofar connect failed:', e.message);
    setTimeout(connectTzofar, 15000);
  }
}
connectTzofar();

// SSE clients list
const sseClients = new Set();
function broadcastAlert(alert) {
  const data = JSON.stringify({ alert, ts: Date.now() });
  sseClients.forEach(res => {
    try { res.write(`data: ${data}\n\n`); } catch(e) { sseClients.delete(res); }
  });
}

// SSE endpoint — client subscribes once, gets pushed alerts in real-time
app.get('/api/alerts/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  // Send current state immediately
  res.write(`data: ${JSON.stringify({ alert: currentAlert, ts: Date.now(), connected: tzofarConnected })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// Polling fallback (for clients that don't support SSE)
app.get('/api/alerts', (req, res) => {
  res.json({ alert: currentAlert, connected: tzofarConnected, ts: Date.now() });
});

app.get('/api/alerts/history', (req, res) => {
  // Try oref history first, fall back to local
  fetchOref('/WarningMessages/History/AlertsHistory.json', (err, data) => {
    if (!err) {
      try {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed) && parsed.length > 0) { res.json(parsed); return; }
      } catch(e) {}
    }
    res.json(alertHistory);
  });
});


// AI summary proxy — avoids CORS, hides key server-side
app.post('/api/ai/summarize', async (req, res) => {
  const { title, desc } = req.body || {};
  if (!title) return res.json({ text: '—' });
  try {
    const response = await new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        system: 'אתה עורך חדשות ישראלי קצר ומקצועי. כ

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  refreshNews();
  setInterval(refreshNews, CACHE_TTL);
});
