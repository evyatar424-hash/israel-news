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
  { id:'kan',      name:'כאן 11',       color:'#2563EB', icon:'🎙️', url:'https://www.kan.org.il/Rss/RssKan.aspx?CatId=30',                         limit:5 },
  { id:'kan_news', name:'כאן חדשות',    color:'#1a56db', icon:'📻', url:'https://www.kan.org.il/Rss/RssKan.aspx?CatId=2',                            limit:4 },
  { id:'ch12',     name:'ערוץ 12',      color:'#C8102E', icon:'📺', url:'https://www.mako.co.il/AjaxPage?jspName=rssFeedMako.jsp&zone=news', limit:5 },
  { id:'sport5',   name:'ספורט 5',       color:'#e11d48', icon:'⚽', url:'https://www.sport5.co.il/rss.aspx',                                          limit:3 },
  { id:'calcalist',name:'כלכליסט',       color:'#e11d48', icon:'💼', url:'https://www.calcalist.co.il/rss/1111',                                      limit:3 },
  { id:'ch14',     name:'ערוץ 14',      color:'#d97706', icon:'🦅', url:'https://www.now14.co.il/feed/',                                            limit:5 },
  { id:'mako',     name:'מאקו',         color:'#e11d48', icon:'🎬', url:'https://www.mako.co.il/AjaxPage?jspName=rssFeedMako.jsp&zone=tarbut',                                limit:3 },
  { id:'maariv',   name:'מעריב',        color:'#0891B2', icon:'🗞️', url:'https://www.maariv.co.il/Rss/RssFeedsMivzakiChadashot',                   limit:4 },
  { id:'haaretz',  name:'הארץ',         color:'#444',    icon:'📜', url:'https://www.haaretz.co.il/srv/rss---feedly',                                    limit:3 },
  { id:'inn',      name:'ערוץ 7',       color:'#1565c0', icon:'✡️', url:'https://www.israelnationalnews.com/rss.aspx',                              limit:3 },
  { id:'idf',      name:'דובר צבא',     color:'#16a34a', icon:'🪖', url:'https://www.idf.il/rss/',                                                  limit:3 },
  { id:'walla_tech',name:'וואלה טק',     color:'#FF6B00', icon:'💻', url:'https://rss.walla.co.il/feed/11',                                             limit:3 },
  { id:'ch15',     name:'ערוץ 15',       color:'#7c3aed', icon:'📻', url:'https://www.15tv.co.il/feed/',                                                limit:4 },
  { id:'srugim',   name:'סרוגים',        color:'#0891b2', icon:'✡️', url:'https://www.srugim.co.il/feed',                                               limit:3 },
  { id:'globes',   name:'גלובס',         color:'#15803d', icon:'💹', url:'https://www.globes.co.il/rss/rss.asp?cnt=737',                                               limit:3 },
];

// Block known logo/placeholder images
const BAD_PATTERNS = [
  'mivzakim', '/logo', 'placeholder', 'noimage', 'no-image',
  'RenderImage', 'walla.co.il/rb/', 'breaking_news', 'brand', 'favicon',
  // Walla breaking logo: img.walla.co.il/v2/image/... with specific logo IDs
  '2907054','2907055','2907056','2907057','2907058','2907059', // known walla logo IDs
];

// Sources that NEVER have real images — skip image entirely
const NO_IMAGE_SOURCES = new Set(['walla', 'walla_w', 'maariv']);

function isRealImage(url, sourceId) {
  if (!url || url.length < 12) return false;
  if (sourceId && NO_IMAGE_SOURCES.has(sourceId)) return false;
  const l = url.toLowerCase();
  for (const p of BAD_PATTERNS) if (l.includes(p.toLowerCase())) return false;
  // Walla blue mivzakim logo check — their logo image is always the same file
  if (url.includes('walla') && url.includes('/image/') && url.includes('2')) {
    // If URL ends with known logo dimensions query or has no descriptive path
    if (/\/image\/\d{7}/.test(url) && url.length < 80) return false;
  }
  return true;
}

function extractImage(item, sourceId) {
  try {
    const candidates = [];
    if (item['media:content']?.$?.url) candidates.push(item['media:content'].$.url);
    if (item['media:thumbnail']?.$?.url) candidates.push(item['media:thumbnail'].$.url);
    if (item.enclosure?.url && item.enclosure?.type?.startsWith('image')) candidates.push(item.enclosure.url);
    const html = item.content || item['content:encoded'] || item.summary || '';
    const m = html.match(/<img[^>]+src=["']([^"']{20,})["']/);
    if (m) candidates.push(m[1]);
    for (const c of candidates) if (isRealImage(c, sourceId)) return c;
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
          'media:content': i.enclosure?.link ? { $: { url: i.enclosure.link } } : undefined,
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

const PROXY_CHANNELS = new Set(['ch12','ch12b','ch13','ch14','kan','kan_news']);

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
    const feed = PROXY_CHANNELS.has(ch.id)
      ? await fetchWithProxy(ch.url)
      : await parser.parseURL(ch.url);
    if (!feed || !feed.items) return [];
    return (feed.items || []).slice(0, ch.limit || 5).map((item, i) => ({
      id: ch.id + '_' + (item.guid || item.link || i),
      source: ch.id, sourceName: ch.name, sourceColor: ch.color, sourceIcon: ch.icon,
      title: (item.title || '').replace(/<[^>]+>/g, '').trim(),
      desc: (item.contentSnippet || item.summary || '').replace(/<[^>]+>/g, '').trim().slice(0, 200),
      link: item.link || '',
      image: extractImage(item, ch.id),
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
  newsCache = combined; cacheTime = Date.now();
  console.log(`${combined.length} items, ${ok}/${CHANNELS.length} channels`);
}

app.get('/api/news', async (req, res) => {
  if (Date.now() - cacheTime > 10000) await refreshNews();
  res.json({ items: newsCache, updated: new Date(cacheTime).toISOString(), total: newsCache.length });
});

// ── AI PROXY — Claude Haiku ──
app.post('/api/ai/summarize', async (req, res) => {
  const { title, desc } = req.body || {};
  if (!title) { res.json({ text: '—' }); return; }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.json({ text: 'ANTHROPIC_API_KEY חסר ב-Render Environment Variables.' }); return; }
  try {
    const prompt = `אתה עורך חדשות ישראלי. כתוב משפט אחד קצר וחד בעברית שמסכם את הכתבה הבאה. רק המשפט, ללא הסברים.\n\nכותרת: ${title}\n${desc ? 'תיאור: ' + desc : ''}`;
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await apiRes.json();
    console.log('Claude status:', apiRes.status, JSON.stringify(data).slice(0,200));
    const text = data?.content?.[0]?.text?.trim();
    res.json({ text: text || data?.error?.message || '—' });
  } catch(e) {
    console.log('Claude err:', e.message);
    res.json({ text: 'שגיאת חיבור.' });
  }
});

// ── ALERTS ENGINE ──
let currentAlert = null;
let alertHistory = [];
let tzofarWs = null;
let tzofarConnected = false;
let orefConnected = false;
const sseClients = new Set();

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
    if (alertHistory.length > 50) alertHistory.length = 50;
    console.log('🚨 Oref alert:', currentAlert.title, currentAlert.data.slice(0, 3));
    broadcastSSE({ alert: currentAlert, connected: true });

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
setInterval(pollOref, 5000);

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
            if (alertHistory.length > 50) alertHistory.length = 50;
            console.log('🚨 Tzofar alert:', currentAlert.title);
            broadcastSSE({ alert: currentAlert, connected: true });
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

// History — local cache (populated by Tzofar WebSocket)
app.get('/api/alerts/history', (req, res) => {
  res.json(alertHistory);
});

// Oref history proxy — fetches from pikud haoref official API
app.get('/api/alerts/oref-history', async (req, res) => {
  try {
    const r = await fetch('https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json', {
      headers: {
        'Referer': 'https://www.oref.org.il/',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0'
      },
      signal: AbortSignal.timeout(8000)
    });
    const data = await r.json();
    res.json(Array.isArray(data) ? data.slice(0, 50) : []);
  } catch(e) {
    console.log('Oref history err:', e.message);
    res.json([]);
  }
});

app.get('/health', (req, res) => res.json({ ok: true, items: newsCache.length, tzofar: tzofarConnected, oref: orefConnected }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Port ${PORT}`);
  refreshNews();
  setInterval(refreshNews, 10000);
});
