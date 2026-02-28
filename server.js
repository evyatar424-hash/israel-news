const express = require('express');
const Parser = require('rss-parser');
const cors = require('cors');
const https = require('https');
const path = require('path');

const app = express();
const parser = new Parser({ timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IsraelNewsBot/2.0)' } });

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const CHANNELS = [
  { id: 'ynet',     name: 'ynet',         color: '#E8001E', icon: '📰', url: 'https://www.ynet.co.il/Integration/StoryRss2.xml' },
  { id: 'ynet_war', name: 'ynet מלחמה',  color: '#b30000', icon: '🚨', url: 'https://www.ynet.co.il/Integration/StoryRss2784.xml' },
  { id: 'walla',    name: 'וואלה',        color: '#FF6B00', icon: '🔥', url: 'https://rss.walla.co.il/feed/22' },
  { id: 'walla_war',name: 'וואלה ביטחון', color: '#cc5500', icon: '⚔️', url: 'https://rss.walla.co.il/feed/2686' },
  { id: 'maariv',   name: 'מעריב',        color: '#0891B2', icon: '🗞️', url: 'https://www.maariv.co.il/Rss/RssFeedsMivzakiChadashot' },
  { id: 'kan',      name: 'כאן 11',       color: '#2563EB', icon: '🎙️', url: 'https://www.kan.org.il/Rss/RssKan.aspx?CatId=30' },
  { id: 'ch12',     name: 'ערוץ 12',      color: '#C8102E', icon: '📺', url: 'https://www.mako.co.il/rss/31750a2610f26110VgnVCM2000002a0c10acRCRD.xml' },
  { id: 'ch13',     name: 'ערוץ 13',      color: '#7C3AED', icon: '📡', url: 'https://13tv.co.il/rss/news/' },
  { id: 'ch14',     name: 'ערוץ 14',      color: '#d97706', icon: '🦅', url: 'https://www.now14.co.il/feed/' },
  { id: 'galatz',   name: 'גלצ',          color: '#15803d', icon: '🎖️', url: 'https://glz.co.il/Rss/RssFeeds.aspx?CatId=18' },
  { id: 'haaretz',  name: 'הארץ',         color: '#1d4ed8', icon: '📜', url: 'https://www.haaretz.co.il/cmlink/1.4585' },
  { id: 'idf',      name: 'דובר צה״ל',   color: '#166534', icon: '🪖', url: 'https://www.idf.il/rss/' },
];

let newsCache = [], cacheTime = 0;
const CACHE_TTL = 5000;

function timeAgo(dateStr) {
  try {
    const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (diff < 60) return 'לפני ' + diff + ' שנ\'';
    if (diff < 3600) return 'לפני ' + Math.floor(diff/60) + ' דק\'';
    if (diff < 86400) return 'לפני ' + Math.floor(diff/3600) + ' שע\'';
    return 'לפני ' + Math.floor(diff/86400) + ' ימים';
  } catch(e) { return ''; }
}

async function fetchChannel(ch) {
  try {
    const feed = await parser.parseURL(ch.url);
    return (feed.items||[]).slice(0,12).map((item,i) => ({
      id: ch.id+'_'+i, source: ch.id, sourceName: ch.name,
      sourceColor: ch.color, sourceIcon: ch.icon,
      title: (item.title||'').replace(/<[^>]+>/g,'').trim(),
      desc: (item.contentSnippet||item.summary||'').replace(/<[^>]+>/g,'').trim().substring(0,160),
      link: item.link||'',
      pubDate: item.pubDate||item.isoDate||'',
      timeAgo: timeAgo(item.pubDate||item.isoDate),
      ts: new Date(item.pubDate||item.isoDate).getTime()||(Date.now()-i*60000),
    }));
  } catch(e) { console.log('Error '+ch.name+': '+e.message); return []; }
}

async function refreshNews() {
  const results = await Promise.allSettled(CHANNELS.map(ch => fetchChannel(ch)));
  let combined = []; let ok = 0;
  results.forEach(r => { if(r.status==='fulfilled'&&r.value.length>0){combined.push(...r.value);ok++;} });
  combined.sort((a,b) => b.ts-a.ts);
  newsCache = combined; cacheTime = Date.now();
  console.log(new Date().toLocaleTimeString()+' | '+combined.length+' items | '+ok+'/'+CHANNELS.length+' channels');
}

app.get('/api/news', async (req,res) => {
  if(Date.now()-cacheTime > CACHE_TTL) await refreshNews();
  res.json({items:newsCache, updated:new Date(cacheTime).toISOString(), total:newsCache.length});
});

function proxyOref(urlPath, res) {
  const opts = { hostname:'www.oref.org.il', path:urlPath,
    headers:{'Referer':'https://www.oref.org.il/','X-Requested-With':'XMLHttpRequest','User-Agent':'Mozilla/5.0'} };
  https.get(opts, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{res.setHeader('Content-Type','application/json');res.send(d||'{}');}); }).on('error',()=>res.json({}));
}

app.get('/api/alerts', (req,res) => proxyOref('/WarningMessages/alert/alerts.json', res));
app.get('/api/alerts/history', (req,res) => proxyOref('/WarningMessages/History/AlertsHistory.json', res));
app.get('/health', (req,res) => res.json({ok:true, items:newsCache.length, updated:new Date(cacheTime).toISOString()}));

const PORT = process.env.PORT||3000;
app.listen(PORT, () => { console.log('Server on port '+PORT); refreshNews(); setInterval(refreshNews, CACHE_TTL); });async function fetchChannel(ch) {
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
