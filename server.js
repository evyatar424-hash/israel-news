const express = require('express');
const Parser = require('rss-parser');
const cors = require('cors');
const https = require('https');
const path = require('path');

const app = express();
const parser = new Parser({ timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)' } });

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const CHANNELS = [
  { id: 'ynet',   name: 'ynet',   color: '#E8001E', icon: '📰', url: 'https://www.ynet.co.il/Integration/StoryRss2.xml' },
  { id: 'walla',  name: 'וואלה', color: '#FF6B00', icon: '🔥', url: 'https://rss.walla.co.il/feed/22' },
  { id: 'maariv', name: 'מעריב', color: '#0891B2', icon: '🗞️', url: 'https://www.maariv.co.il/Rss/RssFeedsMivzakiChadashot' },
  { id: 'kan',    name: 'כאן 11',color: '#2563EB', icon: '🎙️', url: 'https://www.kan.org.il/Rss/RssKan.aspx?CatId=30' },
  { id: 'walla2', name: 'וואלה ביטחון', color: '#dc6b00', icon: '⚔️', url: 'https://rss.walla.co.il/feed/2686' },
  { id: 'ynet2',  name: 'ynet מלחמה', color: '#b30000', icon: '🚨', url: 'https://www.ynet.co.il/Integration/StoryRss2784.xml' },
];

let newsCache = [];
let cacheTime = 0;
const CACHE_TTL = 60 * 1000;

function timeAgo(dateStr) {
  try {
    const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
    if (diff < 1) return 'עכשיו';
    if (diff < 60) return 'לפני ' + diff + ' דקות';
    const h = Math.floor(diff / 60);
    if (h < 24) return 'לפני ' + h + ' שעות';
    return 'לפני ' + Math.floor(h / 24) + ' ימים';
  } catch (e) { return ''; }
}

async function fetchChannel(ch) {
  try {
    const feed = await parser.parseURL(ch.url);
    return (feed.items || []).slice(0, 15).map((item, i) => ({
      id: ch.id + '_' + i,
      source: ch.id,
      sourceName: ch.name,
      sourceColor: ch.color,
      sourceIcon: ch.icon,
      title: (item.title || '').replace(/<[^>]+>/g, '').trim(),
      desc: (item.contentSnippet || item.summary || '').replace(/<[^>]+>/g, '').trim().substring(0, 150),
      link: item.link || '',
      pubDate: item.pubDate || item.isoDate || '',
      timeAgo: timeAgo(item.pubDate || item.isoDate),
      ts: new Date(item.pubDate || item.isoDate).getTime() || (Date.now() - i * 60000),
    }));
  } catch (e) {
    console.log('Error fetching ' + ch.name + ': ' + e.message);
    return [];
  }
}

async function refreshNews() {
  console.log('Fetching all channels...');
  const results = await Promise.allSettled(CHANNELS.map(ch => fetchChannel(ch)));
  let combined = [];
  results.forEach(r => { if (r.status === 'fulfilled') combined.push(...r.value); });
  combined.sort((a, b) => b.ts - a.ts);
  newsCache = combined;
  cacheTime = Date.now();
  console.log('Fetched ' + combined.length + ' items');
}

app.get('/api/news', async (req, res) => {
  if (Date.now() - cacheTime > CACHE_TTL) await refreshNews();
  res.json({ items: newsCache, updated: new Date(cacheTime).toISOString(), total: newsCache.length });
});

app.get('/api/alerts', (req, res) => {
  const options = {
    hostname: 'www.oref.org.il',
    path: '/WarningMessages/alert/alerts.json',
    headers: { 'Referer': 'https://www.oref.org.il/', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'Mozilla/5.0' }
  };
  https.get(options, (proxyRes) => {
    let data = '';
    proxyRes.on('data', chunk => data += chunk);
    proxyRes.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.send(data || '{}'); });
  }).on('error', () => res.json({}));
});

app.get('/api/alerts/history', (req, res) => {
  const options = {
    hostname: 'www.oref.org.il',
    path: '/WarningMessages/History/AlertsHistory.json',
    headers: { 'Referer': 'https://www.oref.org.il/', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'Mozilla/5.0' }
  };
  https.get(options, (proxyRes) => {
    let data = '';
    proxyRes.on('data', chunk => data += chunk);
    proxyRes.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.send(data || '[]'); });
  }).on('error', () => res.json([]));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
  refreshNews();
  setInterval(refreshNews, CACHE_TTL);
});
