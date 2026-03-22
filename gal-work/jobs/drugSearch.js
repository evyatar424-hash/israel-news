const fs = require('fs');
const path = require('path');
const https = require('https');

const STATE_FILE = path.join(__dirname, '..', 'state', 'drug-search-state.json');

const KEYWORDS = [
  'סמים', 'קנאביס', 'הרואין', 'קוקאין', 'אמפטמין',
  'drug', 'narcotics', 'cannabis', 'cocaine', 'heroin'
];

const NEWS_SOURCES = [
  'https://rss.walla.co.il/feed/2686',
  'https://www.ynet.co.il/Integration/StoryRss2.xml',
];

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {}
  return { lastSeen: [] };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                   block.match(/<title>(.*?)<\/title>/))?.[1] || '';
    const link  = (block.match(/<link>(.*?)<\/link>/))?.[1] || '';
    const guid  = (block.match(/<guid[^>]*>(.*?)<\/guid>/))?.[1] || link;
    items.push({ title, link, guid });
  }
  return items;
}

function containsKeyword(text) {
  const lower = text.toLowerCase();
  return KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

async function run() {
  const state = loadState();
  const seenGuids = new Set(state.lastSeen || []);
  const newItems = [];

  for (const url of NEWS_SOURCES) {
    try {
      const xml = await fetchUrl(url);
      const items = parseItems(xml);
      for (const item of items) {
        if (!seenGuids.has(item.guid) && containsKeyword(item.title)) {
          newItems.push(item);
          seenGuids.add(item.guid);
        }
      }
    } catch (e) {
      console.error(`Error fetching ${url}:`, e.message);
    }
  }

  state.lastSeen = [...seenGuids].slice(-500);
  saveState(state);

  if (newItems.length > 0) {
    console.log(`Found ${newItems.length} new drug-related articles`);
    const { sendWhatsApp } = require('../notifications/whatsapp');
    for (const item of newItems) {
      await sendWhatsApp(`חדשות סמים:\n${item.title}\n${item.link}`);
    }
  } else {
    console.log('No new drug-related articles found');
  }
}

run().catch(console.error);
