const express = require('express');
const Parser = require('rss-parser');
const cors = require('cors');
const https = require('https');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' }
});

const CHANNELS = [
  { id: 'ynet',      name: 'ynet',          color: '#E8001E', icon: '📰', url: 'https://www.ynet.co.il/Integration/StoryRss2.xml',                   limit: 6 },
  { id: 'ynet_war',  name: 'ynet מלחמה',    color: '#ff4444', icon: '🔴', url: 'https://www.ynet.co.il/Integration/StoryRss2784.xml',                limit: 5 },
  { id: 'walla',     name: 'וואלה',         color: '#FF6B00', icon: '🔥', url: 'https://rss.walla.co.il/feed/22',                                    limit: 3 },
  { id: 'walla_war', name: 'וואלה ביטחון',  color: '#cc5500', icon: '⚔️', url: 'https://rss.walla.co.il/feed/2686',                                  limit: 3 },
  { id: 'kan',       name: 'כאן 11',        color: '#2563EB', icon: '🎙️', url: 'https://www.kan.org.il/Rss/RssKan.aspx?CatId=30',                    limit: 5 },
  { id: 'ch12',      name: 'ערוץ 12',       color: '#C8102E', icon: '📺', url: 'https://rcs.mako.co.il/rss/31750a2610f26110VgnVCM2000002a0c10acRCRD.xml', limit: 5 },
  { id: 'ch12b',     name: 'ערוץ 12 חדשות', color: '#e63946', icon: '📺', url: 'https://rcs.mako.co.il/rss/news-military.xml',                       limit: 4 },
  { id: 'ch13',      name: 'ערוץ 13',       color: '#7C3AED', icon: '📡', url: 'https://13tv.co.il/rss/news/',                                       limit: 5 },
  { id: 'ch14',      name: 'ערוץ 14',       color: '#d97706', icon: '🦅', url: 'https://www.now14.co.il/feed/',                                      limit: 5 },
  { id: 'mako',      name: 'מאקו',          color: '#e11d48', icon: '🎬', url: 'https://rcs.mako.co.il/rss/news-new.xml',                            limit: 4 },
  { id: 'maariv',    name: 'מעריב',         color: '#0891B2', icon: '🗞️', url: 'https://www.maariv.co.il/Rss/RssFeedsMivzakiChadashot',              limit: 5 },
  { id: 'idf',       name: 'דובר צבא',      color: '#16a34a', icon: '🪖', url: 'https://www.idf.il/rss/',                                            limit: 4 },
];

let newsCache = [], cacheTime = 0;
const CACHE_TTL = 5000;

function timeAgo(dateStr) {
  try {
    const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (diff < 90)   return 'לפני דקה';
    if (diff < 3600) return 'לפני ' + Math.floor(diff/60) + ' דקות';
    if (diff < 7200) return 'לפני שעה';
    if (diff < 86400) return 'לפני ' + Math.floor(diff/3600) + ' שעות';
    return 'אתמול';
  } catch(e) { return ''; }
}

async function fetchChannel(ch) {
  try {
    const feed = await parser.parseURL(ch.url);
    return (feed.items || []).slice(0, ch.limit || 5).map(function(item, i) {
      return {
        id: ch.id + '_' + (item.guid || i),
        source: ch.id, sourceName: ch.name,
        sourceColor: ch.color, sourceIcon: ch.icon,
        title: (item.title || '').replace(/<[^>]+>/g, '').trim(),
        desc: (item.contentSnippet || item.summary || '').replace(/<[^>]+>/g, '').trim().substring(0, 180),
        link: item.link || '',
        timeAgo: timeAgo(item.pubDate || item.isoDate),
        ts: new Date(item.pubDate || item.isoDate).getTime() || (Date.now() - i * 60000)
      };
    });
  } catch(e) { console.log('ERR ' + ch.name + ': ' + e.message); return []; }
}

async function refreshNews() {
  const results = await Promise.allSettled(CHANNELS.map(ch => fetchChannel(ch)));
  let combined = [], ok = 0;
  results.forEach(r => {
    if (r.status === 'fulfilled' && r.value.length > 0) { combined = combined.concat(r.value); ok++; }
  });
  combined.sort((a, b) => b.ts - a.ts);
  newsCache = combined; cacheTime = Date.now();
  console.log(combined.length + ' items from ' + ok + '/' + CHANNELS.length + ' channels');
}

app.get('/api/news', async (req, res) => {
  if (Date.now() - cacheTime > CACHE_TTL) await refreshNews();
  res.json({ items: newsCache, updated: new Date(cacheTime).toISOString(), total: newsCache.length });
});

function proxyOref(urlPath, res) {
  https.get({
    hostname: 'www.oref.org.il', path: urlPath,
    headers: { 'Referer': 'https://www.oref.org.il/', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'Mozilla/5.0' }
  }, r => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.send(d || '{}'); });
  }).on('error', () => res.json({}));
}

app.get('/api/alerts', (req, res) => proxyOref('/WarningMessages/alert/alerts.json', res));
app.get('/api/alerts/history', (req, res) => proxyOref('/WarningMessages/History/AlertsHistory.json', res));
app.get('/health', (req, res) => res.json({ ok: true, items: newsCache.length }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server on port ' + PORT);
  refreshNews();
  setInterval(refreshNews, CACHE_TTL);
});
