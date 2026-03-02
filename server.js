const express = require('express');
const Parser = require('rss-parser');
const cors = require('cors');
const https = require('https');
const path = require('path');
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const parser = new Parser({
  timeout: 12000,
  customFields: { item: ['media:content','media:thumbnail','enclosure'] },
  headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' }
});

const CHANNELS = [
  { id:'ynet',     name:'ynet',         color:'#E8001E', icon:'📰', url:'https://www.ynet.co.il/Integration/StoryRss2.xml',                        limit:5 },
  { id:'ynet_war', name:'ynet מלחמה',   color:'#ff4444', icon:'🔴', url:'https://www.ynet.co.il/Integration/StoryRss2784.xml',                     limit:4 },
  { id:'walla',    name:'וואלה',        color:'#FF6B00', icon:'🔥', url:'https://rss.walla.co.il/feed/22',                                          limit:3 },
  { id:'walla_w',  name:'וואלה ביטחון', color:'#cc5500', icon:'⚔️', url:'https://rss.walla.co.il/feed/2686',                                       limit:3 },
  { id:'kan',      name:'כאן 11',       color:'#2563EB', icon:'🎙️', url:'https://www.kan.org.il/Rss/RssKan.aspx?CatId=30',                         limit:4 },
  { id:'ch12',     name:'ערוץ 12',      color:'#C8102E', icon:'📺', url:'https://rcs.mako.co.il/rss/31750a2610f26110VgnVCM2000002a0c10acRCRD.xml', limit:4 },
  { id:'ch13',     name:'ערוץ 13',      color:'#7C3AED', icon:'📡', url:'https://13tv.co.il/rss/news/',                                             limit:4 },
  { id:'ch14',     name:'ערוץ 14',      color:'#d97706', icon:'🦅', url:'https://www.now14.co.il/feed/',                                            limit:4 },
  { id:'mako',     name:'מאקו',         color:'#e11d48', icon:'🎬', url:'https://rcs.mako.co.il/rss/news-new.xml',                                  limit:3 },
  { id:'maariv',   name:'מעריב',        color:'#0891B2', icon:'🗞️', url:'https://www.maariv.co.il/Rss/RssFeedsMivzakiChadashot',                   limit:4 },
  { id:'haaretz',  name:'הארץ',         color:'#444',    icon:'📜', url:'https://www.haaretz.co.il/srv/htz-rss',                                    limit:3 },
  { id:'inn',      name:'ערוץ 7',       color:'#1565c0', icon:'✡️', url:'https://www.israelnationalnews.com/rss.aspx',                              limit:3 },
  { id:'idf',      name:'דובר צבא',     color:'#16a34a', icon:'🪖', url:'https://www.idf.il/rss/',                                                  limit:3 },
];

// Block known logo/placeholder images
const BAD_PATTERNS = ['mivzakim','/logo','placeholder','noimage','no-image','RenderImage','walla.co.il/rb/','breaking_news','brand','favicon'];
function isRealImage(url) {
  if (!url || url.length < 12) return false;
  const l = url.toLowerCase();
  for (const p of BAD_PATTERNS) if (l.includes(p.toLowerCase())) return false;
  return true;
}

function extractImage(item) {
  try {
    const candidates = [];
    if (item['media:content']?.$?.url) candidates.push(item['media:content'].$.url);
    if (item['media:thumbnail']?.$?.url) candidates.push(item['media:thumbnail'].$.url);
    if (item.enclosure?.url && item.enclosure?.type?.startsWith('image')) candidates.push(item.enclosure.url);
    const html = item.content || item['content:encoded'] || item.summary || '';
    const m = html.match(/<img[^>]+src=["']([^"']{20,})["']/);
    if (m) candidates.push(m[1]);
    for (const c of candidates) if (isRealImage(c)) return c;
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
      image: image: (ch.id === 'walla' || ch.id === 'walla_w') ? null : extractImage(item),
      timeAgo: timeAgo(item.pubDate || item.isoDate),
      ts: new Date(item.pubDate || item.isoDate).getTime() || (Date.now() - i * 60000)
    }));
  } catch(e) {
    console.log(`ERR ${ch.name}: ${e.message.slice(0,80)}`);
    return [];
  }
}

let newsCache = [], cacheTime = 0;
async function refreshNews() {
  const results = await Promise.allSettled(CHANNELS.map(ch => fetchChannel(ch)));
  let combined = [], ok = 0;
  results.forEach(r => { if (r.status === 'fulfilled' && r.value.length > 0) { combined = combined.concat(r.value); ok++; } });
  combined.sort((a, b) => b.ts - a.ts);
  newsCache = combined; cacheTime = Date.now();
  console.log(`${combined.length} items, ${ok}/${CHANNELS.length} channels`);
}

app.get('/api/news', async (req, res) => {
  if (Date.now() - cacheTime > 10000) await refreshNews();
  res.json({ items: newsCache, updated: new Date(cacheTime).toISOString(), total: newsCache.length });
});

// ── AI PROXY ──
app.post('/api/ai/summarize', async (req, res) => {
  const { title, desc } = req.body || {};
  if (!title) { res.json({ text: '—' }); return; }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.json({ text: 'API key חסר — הגדר ב-Render Environment Variables.' }); return; }
  try {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      system: 'אתה עורך חדשות ישראלי. כתוב משפט אחד קצר וחד בעברית שמסכם את הכתבה.',
      messages: [{ role: 'user', content: `${title}\n${desc || ''}` }]
    });
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body
    });
    const data = await apiRes.json();
    res.json({ text: data?.content?.[0]?.text || '—' });
  } catch(e) {
    res.json({ text: 'שגיאת חיבור.' });
  }
});

// ── ALERTS via Tzofar WebSocket ──
let currentAlert = null;
let alertHistory = [];
let tzofarWs = null;
let tzofarConnected = false;
const sseClients = new Set();

function broadcastSSE(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach(res => {
    try { res.write(data); } catch(e) { sseClients.delete(res); }
  });
}

function connectTzofar() {
  try {
    if (tzofarWs) { try { tzofarWs.terminate(); } catch(e) {} }
    console.log('Connecting Tzofar...');
    tzofarWs = new WebSocket('wss://ws.tzevaadom.co.il/socket?platform=WEB', {
      headers: { 'Origin': 'https://www.tzevaadom.co.il', 'User-Agent': 'Mozilla/5.0' }
    });
    tzofarWs.on('open', () => {
      tzofarConnected = true;
      console.log('Tzofar ✓');
      broadcastSSE({ alert: currentAlert, connected: true });
    });
    tzofarWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        // Pikud Haoref format: { id, cat, title, data: [...cities] }
        if (msg.data && Array.isArray(msg.data) && msg.data.length > 0) {
          currentAlert = { data: msg.data, title: msg.title || 'ירי רקטות', id: String(msg.id || Date.now()), ts: Date.now() };
          alertHistory.unshift({ ...currentAlert, alertDate: new Date().toISOString() });
          if (alertHistory.length > 30) alertHistory.length = 30;
          broadcastSSE({ alert: currentAlert, connected: true });
        }
        // Tzofar ALERT format
        if (msg.type === 'ALERT') {
          const cities = msg.notification?.cities || msg.cities || [];
          currentAlert = { data: cities, title: msg.notification?.threat || 'ירי רקטות', id: String(Date.now()), ts: Date.now() };
          alertHistory.unshift({ ...currentAlert, alertDate: new Date().toISOString() });
          broadcastSSE({ alert: currentAlert, connected: true });
        }
        // All-clear
        if (msg.type === 'ALL_CLEAR' || (msg.data && msg.data.length === 0)) {
          if (currentAlert) { currentAlert = null; broadcastSSE({ alert: null, connected: true }); }
        }
      } catch(e) {}
    });
    tzofarWs.on('close', () => { tzofarConnected = false; setTimeout(connectTzofar, 10000); });
    tzofarWs.on('error', () => { tzofarConnected = false; setTimeout(connectTzofar, 15000); });
    // Keepalive
    const ping = setInterval(() => {
      if (tzofarWs?.readyState === WebSocket.OPEN) tzofarWs.ping();
      else clearInterval(ping);
    }, 55000);
  } catch(e) {
    console.log('Tzofar err:', e.message);
    setTimeout(connectTzofar, 15000);
  }
}
connectTzofar();

// SSE stream for browser
app.get('/api/alerts/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ alert: currentAlert, connected: tzofarConnected })}\n\n`);
  sseClients.add(res);
  // Heartbeat every 25s to keep connection alive through proxies
  const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch(e) { clearInterval(hb); } }, 25000);
  req.on('close', () => { sseClients.delete(res); clearInterval(hb); });
});

// Polling fallback
app.get('/api/alerts', (req, res) => {
  res.json({ alert: currentAlert, connected: tzofarConnected });
});

// History — try oref first, fall back to local
app.get('/api/alerts/history', (req, res) => {
  const r = https.get({ hostname:'www.oref.org.il', path:'/WarningMessages/History/AlertsHistory.json', timeout:5000,
    headers:{'Referer':'https://www.oref.org.il/','User-Agent':'Mozilla/5.0'} },
    (resp) => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        try { const p = JSON.parse(d); if (Array.isArray(p) && p.length) { res.json(p); return; } } catch(e) {}
        res.json(alertHistory);
      });
    });
  r.on('error', () => res.json(alertHistory));
  r.on('timeout', () => { r.destroy(); res.json(alertHistory); });
});

app.get('/health', (req, res) => res.json({ ok: true, items: newsCache.length, tzofar: tzofarConnected }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Port ${PORT}`);
  refreshNews();
  setInterval(refreshNews, 10000);
});
