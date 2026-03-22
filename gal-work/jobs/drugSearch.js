const https = require('https');
const fs = require('fs');
const path = require('path');
const { sendWhatsApp } = require('../notifications/whatsapp');

const STATE_FILE = path.join(__dirname, '../state/drug-search-state.json');

const DRUGS = [
  { id: 'imlunestrant', searchTerms: ['Imlunestrant', 'Inluriyo'] },
  { id: 'camizestrant', searchTerms: ['Camizestrant', 'AZD9833'] },
  { id: 'giredestrant', searchTerms: ['Giredestrant', 'RO7197597'] },
];

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function searchDrug(term) {
  const body = JSON.stringify({ val: term, prescription: false, healthServices: false, offset: 0, pageSize: 10 });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'israeldrugs.health.gov.il',
      path: '/GovServiceList/IDRServer/SearchByName',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

async function run() {
  const state = loadState();
  let stateChanged = false;

  for (const drug of DRUGS) {
    if (state[drug.id]?.found) {
      console.log(`[${drug.id}] already found, skipping`);
      continue;
    }
    for (const term of drug.searchTerms) {
      console.log(`[${drug.id}] searching for "${term}"...`);
      const result = await searchDrug(term);
      const items = result?.items || result?.result || [];
      if (items.length > 0) {
        console.log(`[${drug.id}] FOUND via "${term}" — ${items.length} results`);
        const msg = `✅ *${drug.id}* נמצאה במסד הנתונים!\nמונח חיפוש: ${term}\nתוצאות: ${items.length}\nתאריך: ${new Date().toLocaleDateString('he-IL')}`;
        await sendWhatsApp(msg);
        state[drug.id] = { found: true, term, count: items.length, ts: Date.now() };
        stateChanged = true;
        break;
      } else {
        console.log(`[${drug.id}] "${term}" — not found`);
      }
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  if (stateChanged) saveState(state);
  console.log('Done.');
}

run().catch(e => { console.error(e); process.exit(1); });
