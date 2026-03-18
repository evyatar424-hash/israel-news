'use strict';

// ── XSS PROTECTION ──
function safeText(str){
  if(!str)return '';
  const d=document.createElement('div');
  d.textContent=str;
  return d.innerHTML;
}
function safeUrl(url){
  if(!url)return '#';
  try{const u=new URL(url);return['http:','https:'].includes(u.protocol)?url:'#';}catch(e){return '#';}
}
function proxyUrl(url){
  if(!url||url.includes('/api/img-proxy'))return url;
  return '/api/img-proxy?url='+encodeURIComponent(url);
}

// ── TOAST NOTIFICATIONS ──
let _toastTimer=null;
function showToast(msg,duration=2500){
  const el=document.getElementById('toast');
  if(!el)return;
  el.textContent=msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer=setTimeout(()=>el.classList.remove('show'),duration);
}

// ── THEME (LIGHT/DARK) ──
function initTheme(){
  const saved=localStorage.getItem('iln-theme');
  if(saved==='light') document.documentElement.classList.add('light');
  const tgl=document.getElementById('tg-theme');
  if(tgl && saved==='light') tgl.classList.add('on');
}
function toggleTheme(){
  const html=document.documentElement;
  const isLight=html.classList.toggle('light');
  localStorage.setItem('iln-theme',isLight?'light':'dark');
  const tgl=document.getElementById('tg-theme');
  if(tgl) tgl.classList.toggle('on',isLight);
  // Update theme-color meta
  const meta=document.querySelector('meta[name="theme-color"]');
  if(meta) meta.content=isLight?'#f5f5f7':'#111113';
  showToast(isLight?'מצב בהיר':'מצב כהה');
}
initTheme();

// ── BACK TO TOP ──
function initBackToTop(){
  const btn=document.getElementById('btt');
  if(!btn)return;
  let shown=false;
  window.addEventListener('scroll',()=>{
    const shouldShow=window.scrollY>400;
    if(shouldShow!==shown){shown=shouldShow;btn.classList.toggle('show',shown);}
  },{passive:true});
  btn.addEventListener('click',()=>{window.scrollTo({top:0,behavior:'smooth'});});
}
initBackToTop();


const ST=JSON.parse(localStorage.getItem('iln10')||'{}');
const DF={sound:true,vib:true,auto:true};
const gs=k=>k in ST?ST[k]:DF[k];
const ss=(k,v)=>{ST[k]=v;localStorage.setItem('iln10',JSON.stringify(ST));};
['sound','vib','auto'].forEach(k=>{if(gs(k))document.getElementById('tg-'+k)?.classList.add('on');});

let items=[],cur='all',tiIdx=0,autoT=null,vol=gs('vol')!=null?gs('vol'):0.8,lastKey='',alertOn=false,busy=false;
// Restore volume slider
(function(){const v=document.getElementById('vsl');if(v)v.value=Math.round(vol*100);})();

// ── TOPIC FILTER ──
const TOPIC_KEYS = {
  security: ['צבא','חיל','קרב','מבצע','ירי','רקטות','חמאס','חיזבאללה','פיגוע','חטוף','חטופים','נפגע','שבוי','עזה','לבנון','איראן','מחבל','כוחות','לחימה','נשק','טיל','ביטחון','כיפת','שיגור','אזעקה','נהרג','נפצע','חייל','קצין','תקיפה'],
  politics: ['ממשלה','כנסת','ראש הממשלה','נתניהו','גנץ','ליכוד','אופוזיציה','קואליציה','בחירות','שר ','שרה','חוק','תקציב','מדיניות','פוליטי','מינוי','פיטורים','הצבעה','ועדה'],
  economy: ['כלכלה','שוק','בורסה','מניה','דולר','אינפלציה','ריבית','חברה','עסק','רווח','הפסד','גז','נפט','נדלן','עבודה','תעסוקה','שכר','יוקר','מחיר','בנק','ייצוא','ייבוא','משק'],
  world: ['ארהב','אמריקה','אירופה','רוסיה','סין','אוקראינה','נאטו','טראמפ','ביידן','בריטניה','צרפת','גרמניה','בינלאומי','עולם','חוץ','דיפלומטיה','הסכם','ועידה']
};
function classifyTopic(title, desc) {
  const text = ((title||'') + ' ' + (desc||'')).toLowerCase();
  for (const [topic, keys] of Object.entries(TOPIC_KEYS)) {
    if (keys.some(k => text.includes(k.toLowerCase()))) return topic;
  }
  return 'other';
}
let currentTopic = 'all';
let searchQuery = '';
function setTopic(t) {
  currentTopic = t;
  document.querySelectorAll('.tc').forEach(el => el.classList.toggle('on', el.dataset.t === t));
  buildList();
}
function onSearch(val) {
  searchQuery = val.trim().toLowerCase();
  const cb = document.getElementById('search-clear');
  if (cb) cb.classList.toggle('on', searchQuery.length > 0);
  buildList();
}
function clearSearch() {
  const inp = document.getElementById('search-input');
  if (inp) inp.value = '';
  searchQuery = '';
  const cb = document.getElementById('search-clear');
  if (cb) cb.classList.remove('on');
  buildList();
}
function detectBreaking(allItems) {
  const bb = document.getElementById('breaking-banner');
  if (!bb) return;
  const groups = {};
  allItems.forEach(item => {
    const words = (item.title||'').split(' ').filter(w => w.length > 4).slice(0,3).join(' ');
    if (!words || words.length < 8) return;
    if (!groups[words]) groups[words] = { title: item.title, sources: new Set(), link: item.link };
    groups[words].sources.add(item.sourceName);
  });
  const breaking = Object.values(groups).filter(g => g.sources.size >= 3).sort((a,b) => b.sources.size - a.sources.size).slice(0, 3);
  if (!breaking.length) { bb.classList.remove('on'); bb.innerHTML=''; return; }
  bb.innerHTML = '<div class="bb-head"><span class="bb-label">🔥 BREAKING</span><span class="bb-count">' + breaking.length + ' נושאים חמים</span></div>' +
    breaking.map(g => '<div class="bb-item" onclick="window.open(\''+safeUrl(g.link)+'\',\'_blank\')"><div class="bb-title">'+safeText(g.title)+'</div><div class="bb-sources">מדווחים: '+[...g.sources].map(s=>safeText(s)).join(' · ')+'</div></div>').join('');
  bb.classList.add('on');
}

const seen=new Set(),histItems=[];

// Clock
function tick(){
  const n=new Date();
  document.getElementById('hclk').textContent=n.toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  document.getElementById('hdate').textContent=n.toLocaleDateString('he-IL',{weekday:'long',day:'numeric',month:'long'});
}
tick();setInterval(tick,1000);

// Ticker
function rotateTicker(){
  if(!items.length)return;
  const el=document.getElementById('ticker');
  el.style.opacity='0';
  setTimeout(()=>{const it=items[tiIdx++%Math.min(items.length,40)];if(it)el.textContent=it.sourceIcon+' '+it.title;el.style.opacity='1';},380);
}
setInterval(rotateTicker,7000);

// Tabs
function goTab(t){
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('on'));
  document.querySelectorAll('.tab').forEach(b=>b.classList.remove('on'));
  document.querySelectorAll('.nb').forEach(b=>b.classList.remove('on'));
  document.getElementById('panel-'+t).classList.add('on');
  document.getElementById('t-'+t).classList.add('on');
  document.getElementById('nb-'+t).classList.add('on');
  if(t==='alerts') setTimeout(apLoadHistory, 200);
  if(t==='settings') setTimeout(updateNotifStatus, 200);
}

function tog(k){const v=!gs(k);ss(k,v);const e=document.getElementById('tg-'+k);v?e.classList.add('on'):e.classList.remove('on');if(k==='auto')v?startAuto():stopAuto();}

// Live player
function openLive(url,name){
  const p=document.getElementById('player');
  document.getElementById('pl-name').textContent='📺 '+name;
  document.getElementById('pl-frame').src=url;
  p.classList.add('on');p.scrollIntoView({behavior:'smooth',block:'nearest'});
}
function closeLive(){document.getElementById('pl-frame').src='';document.getElementById('player').classList.remove('on');}

// Channel info
const CH={
  ynet:      {n:'ynet',          c:'#C8233A', logo:'https://www.ynet.co.il/favicon.ico'},
  ynet_war:  {n:'ynet מלחמה',   c:'#cc0000', logo:'https://www.ynet.co.il/favicon.ico'},
  walla:     {n:'וואלה',         c:'#FF6000', logo:'https://walla.co.il/favicon.ico'},
  walla_w:   {n:'וואלה ביטחון', c:'#cc4400', logo:'https://walla.co.il/favicon.ico'},
  walla_econ:{n:'וואלה כלכלה',  c:'#15803d', logo:'https://walla.co.il/favicon.ico'},
  ch12:      {n:'חדשות 12',     c:'#C8102E', logo:'https://www.n12.co.il/favicon.ico'},
  ch13:      {n:'רשת 13',       c:'#8B00FF', logo:'https://13tv.co.il/favicon.ico'},
  ch14:      {n:'ערוץ 14',      c:'#b45309', logo:'https://www.now14.co.il/favicon.ico'},
  mako:      {n:'מאקו',         c:'#e11d48', logo:'https://www.mako.co.il/favicon.ico'},
  maariv:    {n:'מעריב',        c:'#0369a1', logo:'https://www.maariv.co.il/favicon.ico'},
  haaretz:   {n:'הארץ',         c:'#555555', logo:'https://www.haaretz.co.il/favicon.ico'},
  idf:       {n:'דובר צבא',     c:'#15803d', logo:'https://www.idf.il/favicon.ico'},
  srugim:    {n:'סרוגים',       c:'#7c3aed', logo:'https://www.srugim.co.il/favicon.ico'},
  calcalist: {n:'כלכליסט',      c:'#0f4c8a', logo:'https://www.calcalist.co.il/favicon.ico'},
  globes:    {n:'גלובס',        c:'#006633', logo:'https://www.globes.co.il/favicon.ico'},
    kan:       {n:'כאן 11',        c:'#1a56db', logo:'https://www.kan.org.il/favicon.ico'},
    glz:       {n:'גלצ',            c:'#2d6a4f', logo:'https://glz.co.il/favicon.ico'},
};
const NO_IMG=new Set([]);
function goodImg(url,src){
  if(!url||url.length<12)return false;
  const l=url.toLowerCase();
  const fname=l.split('/').pop().split('?')[0];
  for(const b of ['mivzakim','placeholder','noimage','no-image','RenderImage','%D7%9E%D7%91%D7%96%D7%A7%D7%99%D7%9D','breaking_news','breakingnews','default_image','default-image'])if(l.includes(b))return false;
  if(fname.startsWith('logo')||fname.startsWith('brand')||fname==='favicon.ico')return false;
  // Maariv: block generic banner images
  if(l.includes('maariv')){
    for(const p of ['mivzak','logo','brand','breaking','default','mitparzot','generic','share_default','og-default','rss_image','rssimage','rssfeed'])if(l.includes(p))return false;
    if(url.length<90)return false;
  }
  // Walla: block short numeric image paths (always logos)
  if(l.includes('walla')&&l.includes('/image/')&&/\/image\/\d{5,9}/.test(l)&&url.length<100)return false;
  // Block tiny tracker images
  if(/[?&](w|width)=(1|2|5|10|16)(&|$)/.test(url))return false;
  return true;
}

// Hero card

function upgradeImgUrl(url){
  if(!url||url.length<10)return url;
  try{
    // ynet — largest crop
    if(url.includes('ynet')){
      url=url.replace(/crop_images\/\d+\/\d+\//,'crop_images/1200/675/');
      url=url.replace(/_\d+\.jpg/,'_1200.jpg');
      url=url.replace(/\/picserver\d\/\d+\//,(m)=>m.replace(/\/\d+\//,'/1200/'));
    }
    // haaretz
    if(url.includes('haaretz')){
      url=url.replace(/\?imageVersion=\d+x\d+/,'?imageVersion=1200x675');
      url=url.replace(/height=\d+/,'height=675').replace(/width=\d+/,'width=1200');
    }
    // walla
    if(url.includes('walla.co.il')){
      url=url.replace(/\/\d+x\d+\//,'/1200x675/');
    }
    // Google News thumbnails — extract the real image URL if possible
    if(url.includes('news.google.com')){
      url=url.replace(/=w\d+(-h\d+)?(-[a-zA-Z]+)?/,'=w1200-h675-rw');
    }
    // mako
    if(url.includes('mako.co.il')){
      url=url.replace(/\/\d+x\d+\//,'/1200x675/');
      url=url.replace(/width=\d+/,'width=1200').replace(/height=\d+/,'height=675');
    }
    // calcalist
    if(url.includes('calcalist')){
      url=url.replace(/_\d+\.jpg/,'_1200.jpg');
      url=url.replace(/\/\d+\/\d+\/crop\//,'/1200/675/crop/');
    }
    // n12
    if(url.includes('n12.co.il')||url.includes('maariv.co.il')){
      url=url.replace(/\/\d+x\d+\//,'/1200x675/');
      url=url.replace(/width=\d+/,'width=1200').replace(/height=\d+/,'height=675');
    }
    // globes
    if(url.includes('globes.co.il')){
      url=url.replace(/\/\d+x\d+\//,'/1200x675/');
    }
    // Generic: try upgrading common thumbnail patterns
    url=url.replace(/[\?&]w=\d+/,'?w=1200').replace(/[\?&]h=\d+/,'&h=675');
  }catch(e){}
  return url;
}
function buildHero(item){
  const el=document.getElementById('hero');
  if(!item){el.innerHTML='';return;}
  const ch=CH[item.source]||{n:item.source,c:'#60a5fa',i:'📰'};
  const originalImg=item.image||'';
  const upgradedImg=upgradeImgUrl(originalImg);
  const hasImg=upgradedImg&&upgradedImg.startsWith('http');
  const logoHtml=ch.logo?`<img src="${safeUrl(ch.logo)}" style="width:14px;height:14px;border-radius:3px;object-fit:contain;opacity:.85;margin-left:5px;vertical-align:middle" onerror="this.remove()">`:'';
  const title=safeText(item.title);
  const desc=safeText((item.desc||'').slice(0,120));
  const link=safeUrl(item.link);
  const time=safeText(item.timeAgo||'');
  const isFresh = item.ts && (Date.now() - item.ts) < 15*60*1000;
  const badgeHtml = isFresh ? '<div class="hero-tags"><span class="hero-breaking">⚡ מבזק</span></div>' : '<div class="hero-tags"></div>';
  // Fallback chain: upgraded → original → proxy → text-only
  const proxyImg = proxyUrl(originalImg);
  const textFallback = `this.closest('.hero-card').innerHTML='<div class=hero-text-card>${badgeHtml}<h2 class=hero-title-text>${title}</h2></div>';`;
  let fallbackJs;
  if (originalImg !== upgradedImg) {
    fallbackJs = `onerror="var f=parseInt(this.dataset.fell||0);this.dataset.fell=f+1;if(f===0){this.src='${safeUrl(originalImg)}';}else if(f===1){this.src='${proxyImg}';}else{${textFallback}}"`;
  } else {
    fallbackJs = `onerror="var f=parseInt(this.dataset.fell||0);this.dataset.fell=f+1;if(f===0){this.src='${proxyImg}';}else{${textFallback}}"`;
  }
  if(hasImg){
    el.innerHTML=`<a class="hero-card" href="${link}" target="_blank" rel="noopener">
      <div class="hero-img-wrap">
        <img class="hero-img" src="${safeUrl(upgradedImg)}" alt="" loading="eager" ${fallbackJs}>
        <div class="hero-grad"></div>
        <div class="hero-body">
          ${badgeHtml}
          <h2 class="hero-title">${title}</h2>
          ${desc?`<p class="hero-desc">${desc}...</p>`:''}
          <div class="hero-foot">
            <span class="hero-src">${logoHtml}<span style="color:${ch.c}">${safeText(ch.n)}</span></span>
            <span class="hero-time">${time}</span>
          </div>
        </div>
      </div>
    </a>`;
  }else{
    el.innerHTML=`<a class="hero-card" href="${link}" target="_blank" rel="noopener">
      <div class="hero-text-card">
        ${badgeHtml}
        <h2 class="hero-title-text">${title}</h2>
        ${desc?`<p class="hero-desc-text">${desc}</p>`:''}
        <div class="hero-foot">
          <span class="hero-src">${logoHtml}<span style="color:${ch.c}">${safeText(ch.n)}</span></span>
          <span class="hero-time">${time}</span>
        </div>
      </div>
    </a>`;
  }
}

// Chips
function buildChips(){
  const el=document.getElementById('chips');el.innerHTML='';
  ['all',...new Set(items.map(x=>x.source))].forEach(id=>{
    const ch=id==='all'?{n:'הכל',c:'#c9a84c',logo:null}:(CH[id]||{n:id,c:'#888',logo:null});
    const b=document.createElement('button');
    b.className='chip'+(id===cur?' on':'');
    b.title=ch.n;
    b.style.setProperty('--chip-color', ch.c);
    if(id==='all'){
      b.innerHTML='<span class="chip-all">✦</span>';
    } else if(ch.logo){
      const img=document.createElement('img');
      img.src=ch.logo;
      img.alt=ch.n;
      img.onerror=function(){this.parentElement.innerHTML='<span class="chip-all" style="font-size:9px;color:'+ch.c+'">'+ch.n.slice(0,3)+'</span>';};
      b.appendChild(img);
    } else {
      b.innerHTML='<span class="chip-all" style="font-size:9px;color:'+ch.c+'">'+ch.n.slice(0,3)+'</span>';
    }
    b.onclick=()=>{cur=id;buildChips();buildList();};
    el.appendChild(b);
  });
}

// AI summarize
async function aiSum(btn){
  const title=btn._t||'';
  const desc=btn._d||'';
  btn.style.display='none';
  const box=btn.nextElementSibling;
  box.classList.add('on');
  box.innerHTML='<span class="spinner">⟳</span> מנתח...';
  try{
    const r=await fetch('/api/ai/summarize',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({title,desc}),
      
    });
    const d=await r.json();
    if(d.text && d.text !== '—' && !d.text.includes('חסר') && !d.text.includes('שגיאה') && d.text.length > 5){
      box.textContent=d.text;
    }else if(d.text && d.text.includes('חסר')){
      box.innerHTML='<span style="color:var(--am)">⚙️ '+d.text+'</span>';
    }else{
      box.innerHTML='<span style="color:var(--t3)">לא זמין כרגע — נסה שוב</span>';
    }
  }catch(e){
    box.innerHTML='<span style="color:var(--t3)">לא זמין כרגע</span>';
  }
}

// News cards

// ── TRENDING ──
function hebrewStem(w){
  // הסר תחיליות נפוצות
  return w.replace(/^(ה|ו|ב|ל|מ|ש|כ|ל|אל|על|עם|בין|כי|אם)/,'').replace(/['".,!?:;]/g,'');
}

function titleWords(title){
  return (title||'').split(/\s+/)
    .map(w=>hebrewStem(w))
    .filter(w=>w.length>=3)
    .filter(w=>!['אמר','אמרה','לפי','עוד','כבר','היום','אחרי','לאחר','בעקבות','בין','על','עם','את','של','כי','הוא','היא','הם','אבל','גם','רק','כל','זה','זו'].includes(w));
}

function buildTrending(list){
  const sec = document.getElementById('trending-section');
  const el  = document.getElementById('trend-cards');
  if(!el) return;

  // Group items by shared keywords (2+ channels)
  const wordMap = {}; // word → [items]
  list.forEach(item => {
    titleWords(item.title).forEach(w => {
      if(!wordMap[w]) wordMap[w] = [];
      if(!wordMap[w].find(x=>x.id===item.id)) wordMap[w].push(item);
    });
  });

  // Build clusters: items that share a word with 2+ different sources
  const clusters = [];
  const usedIds = new Set();

  Object.entries(wordMap)
    .filter(([w,its]) => {
      const srcs = new Set(its.map(i=>i.source));
      return srcs.size >= 2;
    })
    .sort((a,b) => {
      const sa = new Set(a[1].map(i=>i.source));
      const sb = new Set(b[1].map(i=>i.source));
      return sb.size - sa.size;
    })
    .slice(0, 6)
    .forEach(([word, its]) => {
      const srcs = [...new Set(its.map(i=>i.source))];
      if(srcs.length < 2) return;
      // Pick best title (longest, most informative)
      const best = its.slice().sort((a,b)=>(b.title||'').length-(a.title||'').length)[0];
      if(usedIds.has(best.id)) return;
      usedIds.add(best.id);
      clusters.push({ keyword: word, title: best.title, link: best.link, sources: srcs.slice(0,4), count: srcs.length });
    });

  if(clusters.length < 2){ sec.style.display='none'; return; }
  sec.style.display='block';
  el.innerHTML='';

  clusters.slice(0,5).forEach(cl => {
    const card = document.createElement('a');
    card.className = 'trend-card';
    card.href = cl.link || '#';
    card.target = '_blank';
    card.rel = 'noopener';

    const srcDots = cl.sources.map(sid => {
      const ch = CH[sid]||{c:'#888',n:sid};
      return '<span class="trend-src-dot" style="background:'+ch.c+'" title="'+ch.n+'"></span>';
    }).join('');

    card.innerHTML =
      '<div class="trend-badge">🔴 '+cl.count+' ערוצים</div>' +
      '<div class="trend-kw">'+safeText(cl.title)+'</div>' +
      '<div class="trend-sources">'+srcDots+'</div>';

    el.appendChild(card);
  });
}

function buildList(){
  const el=document.getElementById('nlist');
  // Source filter
  let list=cur==='all'?items:items.filter(x=>x.source===cur);
  // Topic filter
  if (currentTopic !== 'all') {
    list = list.filter(x => classifyTopic(x.title, x.desc) === currentTopic);
  }
  // Search filter
  if (searchQuery) {
    list = list.filter(x => 
      (x.title||'').toLowerCase().includes(searchQuery) ||
      (x.desc||'').toLowerCase().includes(searchQuery) ||
      (x.sourceName||'').toLowerCase().includes(searchQuery)
    );
  }
  // Breaking detection (always on full list)
  detectBreaking(cur==='all'?items:items.filter(x=>x.source===cur));
  buildTrending(cur==='all'?items:list);
  if(!list.length){el.innerHTML='<div class="empty"><div class="empty-ico">📭</div><div class="empty-txt">אין כתבות</div></div>';return;}
  el.innerHTML='';
  const sep=document.createElement('div');sep.className='sep';
  sep.innerHTML='<span class="sep-line"></span><span>עדכון '+new Date().toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'})+'</span><span class="sep-line"></span>';
  el.appendChild(sep);
  // Skip hero item from list to avoid duplicate
  const heroId = (cur==='all') ? (items.find(x => x.image && x.image.length > 10) || items[0])?.id : null;
  list.slice(0).filter(x => x.id !== heroId).forEach((item,i)=>{
    const ch=CH[item.source]||{n:item.source,c:'#888',i:'📰'};
    const isNew=!seen.has(item.id);
    const hi=goodImg(item.image,item.source);
    const upgradedImg = hi ? upgradeImgUrl(item.image) : '';
    const a=document.createElement('a');
    a.className='nc';a.href=safeUrl(item.link);a.target='_blank';a.rel='noopener';
    a.style.animationDelay=Math.min(i,12)*0.028+'s';
    const logoHtml = ch.logo
      ? '<img style="width:16px;height:16px;border-radius:5px;object-fit:contain;background:#fff;padding:1px;margin-left:5px;vertical-align:middle;flex-shrink:0" src="'+safeUrl(ch.logo)+'" onerror="this.remove()">'
      : '';
    const proxyImg = hi ? proxyUrl(item.image) : '';
    const imgHtml = hi ? '<div class="nc-img-wrap"><img class="nc-img" src="'+safeUrl(upgradedImg)+'" alt="" loading="lazy" onerror="var f=parseInt(this.dataset.fell||0);this.dataset.fell=f+1;if(f===0){this.src=\''+safeUrl(item.image)+'\';}else if(f===1){this.src=\''+proxyImg+'\';}else{this.parentElement.remove();}"></div>' : '';
    a.innerHTML='<div class="nc-bar" style="background:'+ch.c+'"></div>'+imgHtml+
      '<div class="nc-body"><div class="nc-top"><span class="nc-src" style="background:'+ch.c+'18;color:'+ch.c+'">'+logoHtml+safeText(ch.n)+'</span><div class="nc-right"><span class="nc-time">'+safeText(item.timeAgo)+'</span>'+(isNew?'<span class="nc-new">חדש</span>':'')+'</div></div>'+
      '<div class="nc-title">'+safeText(item.title)+'</div>'+(item.desc?'<div class="nc-desc">'+safeText(item.desc)+'</div>':'')+
      '</div>';
    // AI button attached via JS to avoid quote escaping
    const aib=document.createElement('button');
    aib.className='ai-btn';
    aib._t=item.title;
    aib._d=item.desc||'';
    aib.innerHTML='<span class="ai-btn-star">✦</span> תמצית AI';
    aib.addEventListener('click',function(ev){ev.preventDefault();ev.stopPropagation();aiSum(this);});
    const air=document.createElement('div');
    air.className='ai-result';
    a.querySelector('.nc-body').appendChild(aib);
    a.querySelector('.nc-body').appendChild(air);
    // Share button
    const sbtn = document.createElement('button');
    sbtn.className = 'share-btn';
    sbtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg> שתף';
    sbtn._item = item;
    sbtn.addEventListener('click', function(ev){ ev.preventDefault(); ev.stopPropagation(); openShare(this._item); });
    a.querySelector('.nc-body').appendChild(sbtn);
    el.appendChild(a);seen.add(item.id);
  });
}

let _lastNewsIds = new Set();
function sendBreakingNotif(title, source){
  if(!('Notification'in window)||Notification.permission!=='granted')return;
  if(localStorage.getItem('notif')!=='granted')return;
  new Notification('🔴 ' + (source||'מבזק'), {
    body: title, icon:'/icon-192.png', badge:'/icon-192.png',
    dir:'rtl', tag:'news-'+Date.now()
  });
}
async function loadNews(manual=false){
  if(busy&&!manual)return;busy=true;
  const btn=document.getElementById('rfbtn'),stxt=document.getElementById('stxt');
  if(manual){btn.disabled=true;btn.innerHTML='<span class="spinner">⟳</span>';}
  try{
    const r=await fetch('/api/news?t='+Date.now());
    const txt=await r.text();
    if(txt.trimStart().startsWith('<')){
      // SW ישן מחזיר HTML — אלץ עדכון
      stxt.textContent='🔄 מעדכן...';
      if('serviceWorker' in navigator){
        const reg=await navigator.serviceWorker.getRegistration();
        if(reg){await reg.update();await reg.unregister();}
      }
      setTimeout(()=>location.reload(true),1000);
      return;
    }
    const d=JSON.parse(txt);
    if(d.items&&d.items.length){
      items=d.items;
      const t=new Date(d.updated).toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      stxt.textContent='✓ '+t+' · '+d.total+' כתבות';
      // clear loading state (skeletons or old empty)
      const nl=document.getElementById('nlist');
      if(nl&&nl.querySelector('.skel-card')) nl.innerHTML='';
      if(nl&&nl.querySelector('.empty-ico')) nl.innerHTML='';
      if(cur==='all'){
        const heroItem = items.find(x => x.image && x.image.startsWith('http') && x.image.length > 20) || items.find(x => x.image) || items[0];
        buildHero(heroItem);
      }
      buildChips();buildList();rotateTicker();
    } else {
      stxt.textContent='⟳ מחכה לערוצים...';
    }
  }catch(e){
    console.error('loadNews error:',e);
    stxt.textContent='⚠️ שגיאת חיבור';
  }
  if(manual){btn.disabled=false;btn.innerHTML='⟳ רענן';}
  busy=false;
}
function startAuto(){setRefreshInterval(120000);}
function setRefreshInterval(ms){
  stopAuto();
  const lbl=document.getElementById('interval-lbl');
  const sel=document.getElementById('interval-sel');
  if(!ms){if(lbl)lbl.textContent='כבוי';return;}
  if(sel)sel.value=ms;
  const labels={60000:'כל דקה',120000:'כל 2 דקות',180000:'כל 3 דקות',300000:'כל 5 דקות'};
  if(lbl)lbl.textContent=labels[ms]||'רענון אוטומטי';
  autoT=setInterval(()=>loadNews(),ms);
  ss('refreshInterval',ms);
}
// Restore saved interval
const _savedInterval=parseInt(gs('refreshInterval')||120000);
if(_savedInterval>0)setRefreshInterval(_savedInterval);
function stopAuto(){if(autoT){clearInterval(autoT);autoT=null;}}
startAuto();

// Sound — pleasant chime for news, urgent for alerts
function playChime(urgent){
  if(!gs('sound'))return;
  try{
    const ctx=new(window.AudioContext||window.webkitAudioContext)();
    if(urgent){
      // Alert: firm but not harsh — two-tone rising
      [[523,.12],[659,.12],[784,.18]].forEach(([f,d],i)=>{
        const o=ctx.createOscillator(),g=ctx.createGain();
        o.connect(g);g.connect(ctx.destination);
        o.type='sine';o.frequency.value=f;
        const t=ctx.currentTime+i*.15;
        g.gain.setValueAtTime(vol*.35,t);
        g.gain.exponentialRampToValueAtTime(.001,t+d);
        o.start(t);o.stop(t+d+.05);
      });
    } else {
      // News chime: soft two-note bell (C5-E5)
      [[523,.15],[659,.2]].forEach(([f,d],i)=>{
        const o=ctx.createOscillator(),g=ctx.createGain();
        o.connect(g);g.connect(ctx.destination);
        o.type='sine';o.frequency.value=f;
        const t=ctx.currentTime+i*.18;
        g.gain.setValueAtTime(vol*.25,t);
        g.gain.exponentialRampToValueAtTime(.001,t+d);
        o.start(t);o.stop(t+d+.05);
      });
    }
  }catch(e){}
}
function playAlarm(){ playChime(true); }
function testAudio(){playChime(false);if(gs('vib')&&navigator.vibrate)navigator.vibrate([150,80,150]);}

// Alert UI
function triggerAlert(areas,type,key){
  sendAlertNotif(areas,type);
  if(key===lastKey)return;lastKey=key;alertOn=true;
  const str=Array.isArray(areas)?areas.map(a=>safeText(a)).join(' · '):safeText(String(areas));
  document.getElementById('bar-areas').textContent=str;
  document.getElementById('abar').classList.add('on');
  document.getElementById('nb-dot').className='nb-badge alrt';
  document.getElementById('tdot').style.display='block';
  document.getElementById('ovl-areas').textContent=str;
  document.getElementById('ovl-type').textContent=type;
  document.getElementById('ovl').classList.add('on');
  playAlarm();
  if(gs('vib')&&navigator.vibrate)navigator.vibrate([500,150,500,150,500,150,500]);
  if('Notification'in window&&Notification.permission==='granted')
    new Notification('🚨 '+type,{body:str,icon:'/icon-192.png',requireInteraction:true});
  histItems.unshift({data:Array.isArray(areas)?areas:[areas],title:type,alertDate:new Date().toISOString()});
  if(histItems.length>20)histItems.length=20;
  apSetAlert({data:Array.isArray(areas)?areas:[areas],title:type});
}
function clearAlertUI(){
  if(!alertOn)return;alertOn=false;lastKey='';
  document.getElementById('abar').classList.remove('on');
  document.getElementById('nb-dot').className='nb-badge ok';
  document.getElementById('tdot').style.display='none';
  apSetAlert(null);
}
function closeOvl(){document.getElementById('ovl').classList.remove('on');}

// ── Alert panel state ──
let sseRetries = 0;

function setConn(s){
  apSetLive(s==='ok'||s==='alrt');
}

// SSE stream — stable reconnection
let _es = null;
function connectStream(){
  if(_es){ try{_es.close();}catch(e){} _es=null; }
  try{
    _es=new EventSource('/api/alerts/stream');
    const timeout=setTimeout(()=>{ if(_es){_es.close();_es=null;} setTimeout(connectStream,10000); },10000);
    _es.onopen=()=>{
      clearTimeout(timeout);
      sseRetries=0;
      setConn('ok');
      apLoadHistory();
      console.log('[SSE] Connected');
    };
    _es.onmessage=e=>{
      clearTimeout(timeout);
      try{
        const d=JSON.parse(e.data);
        if(d.connected!==undefined) setConn(d.connected?'ok':'err');
        if(d.alert&&d.alert.data&&d.alert.data.length>0){
          setConn('alrt');
          triggerAlert(d.alert.data,d.alert.title||'ירי רקטות',d.alert.id||d.alert.data.join(','));
        } else if(d.alert===null){
          setConn('ok');clearAlertUI();
        }
      }catch(err){}
    };
    _es.onerror=()=>{
      clearTimeout(timeout);
      sseRetries++;
      setConn('err');
      if(_es){_es.close();_es=null;}
      const delay=Math.min(3000*Math.pow(1.5,sseRetries),30000);
      console.log('[SSE] Reconnecting in',Math.round(delay/1000)+'s');
      setTimeout(connectStream, delay);
    };
  }catch(e){
    setTimeout(connectStream,10000);
  }
}
// Reconnect SSE on visibility change
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible' && (!_es || _es.readyState===2)){
    sseRetries=0;
    connectStream();
  }
});

function pollOnce(){
  fetch('/api/alerts')
    .then(r=>r.json())
    .then(d=>{
      setConn(d.connected?'ok':'err');
      if(d.alert&&d.alert.data&&d.alert.data.length>0){
        setConn('alrt');
        triggerAlert(d.alert.data,d.alert.title||'ירי רקטות',d.alert.id||d.alert.data.join(','));
      }
    }).catch(()=>{ /* SSE handles state */ });
}

document.addEventListener('DOMContentLoaded', () => {
  updateNotifStatus();
});


let deferredPrompt;
window.addEventListener('beforeinstallprompt',(e)=>{
  e.preventDefault(); deferredPrompt=e;
  const banner = document.getElementById('installBanner');
  if(banner) banner.style.display='block';
});
function installPWA(){
  if(!deferredPrompt)return;
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then(r=>{
    deferredPrompt=null;
    const banner=document.getElementById('installBanner');
    if(banner)banner.style.display='none';
  });
}
window.addEventListener('appinstalled',()=>{
  const banner=document.getElementById('installBanner');
  if(banner)banner.style.display='none';
});

// Show install banner if not already installed
(function(){
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if(isStandalone) return; // already installed
  // Show banner after 2 seconds if not dismissed
  setTimeout(()=>{
    if(!deferredPrompt && !/iphone|ipad|ipod/i.test(navigator.userAgent)) return;
    const banner = document.getElementById('installBanner');
    if(banner && banner.style.display==='none') banner.style.display='block';
    // iOS special message
    if(/iphone|ipad|ipod/i.test(navigator.userAgent)){
      const btn = banner && banner.querySelector('button');
      if(btn) btn.textContent = '📲 לחץ שתף ← הוסף למסך הבית';
    }
  }, 2000);
})();

// ── NOTIFICATIONS ──
async function updateNotifStatus(){
  const btn=document.getElementById('notifBtn');
  const offBtn=document.getElementById('notifOffBtn');
  const status=document.getElementById('notifStatus');
  const pushStatus=document.getElementById('pushServerStatus');
  if(!btn) return;

  // Check browser support
  if(!('Notification' in window)){
    if(status)status.textContent='התראות לא נתמכות בדפדפן זה';
    if(btn)btn.style.display='none';
    if(offBtn)offBtn.style.display='none';
    return;
  }

  // Update based on browser permission
  if(Notification.permission==='granted'){
    if(offBtn)offBtn.style.display='inline-block';
    if(btn){btn.textContent='מופעל ✓';btn.style.background='var(--green)';btn.disabled=true;}
    if(status)status.textContent='✅ התראות Push מופעלות';
  } else if(Notification.permission==='denied'){
    if(offBtn)offBtn.style.display='none';
    if(btn){btn.textContent='חסום';btn.style.background='var(--t3)';btn.disabled=true;}
    if(status)status.textContent='❌ חסום — שנה בהגדרות הדפדפן';
    return;
  } else {
    if(offBtn)offBtn.style.display='none';
    if(btn){btn.textContent='הפעל';btn.style.background='var(--blue)';btn.disabled=false;}
    if(status)status.textContent='לחץ הפעל כדי לקבל התראות';
    return;
  }

  // Check actual push subscription status with server
  try{
    const r=await fetch('/api/push/status');
    const d=await r.json();
    if(pushStatus){
      if(!d.webpush){
        pushStatus.textContent='⚠️ שרת Push לא מוגדר';
        pushStatus.style.color='var(--red)';
      } else if(d.subscribers>0){
        pushStatus.textContent='🟢 מחובר · '+d.subscribers+' מכשירים רשומים';
        pushStatus.style.color='var(--green)';
      } else {
        pushStatus.textContent='⚠️ אין מכשירים רשומים';
        pushStatus.style.color='var(--red)';
      }
    }
    // If permission granted, always ensure subscription is current
    if(d.webpush && Notification.permission==='granted'){
      console.log('[PUSH] Permission granted, ensuring subscription is current...');
      await subscribePush(true); // silent re-subscribe
      // Re-check status after subscribe
      try{
        const r2=await fetch('/api/push/status');
        const d2=await r2.json();
        if(pushStatus && d2.subscribers>0){
          pushStatus.textContent='🟢 מחובר · '+d2.subscribers+' מכשירים רשומים';
          pushStatus.style.color='var(--green)';
        }
      }catch(e){}
    }
  }catch(e){
    if(pushStatus){pushStatus.textContent='⚠️ לא ניתן לבדוק חיבור לשרת';pushStatus.style.color='var(--t3)';}
  }
}

async function checkPushSubscription(){
  try{
    if(!('serviceWorker' in navigator)||!('PushManager' in window)) return false;
    const reg=await navigator.serviceWorker.ready;
    const sub=await reg.pushManager.getSubscription();
    return !!sub;
  }catch(e){ return false; }
}

async function disableNotifications(){
  try{
    if('serviceWorker' in navigator){
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if(sub){
        await sub.unsubscribe();
        await fetch('/api/push/unsubscribe',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({endpoint:sub.endpoint})
        });
      }
    }
    ss('notif','');
    showToast('🔕 התראות בוטלו');
    await updateNotifStatus();
  }catch(e){ showToast('שגיאה: '+e.message); }
}
async function requestNotifications(){
  if(!('Notification' in window)){showToast('הדפדפן לא תומך בהתראות');return;}
  if(!('serviceWorker' in navigator)){showToast('הדפדפן לא תומך ב-Service Worker');return;}
  const btn=document.getElementById('notifBtn');
  if(btn){btn.textContent='מפעיל...';btn.disabled=true;}
  try{
    // Make sure SW is registered first
    await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    const perm = await Notification.requestPermission();
    if(perm==='granted'){
      const ok = await subscribePush(false);
      if(ok) showToast('🔔 התראות הופעלו!');
      else showToast('⚠️ הרשמה נכשלה — נסה שוב');
    } else {
      showToast('⚠️ יש לאשר הרשאה בדפדפן');
    }
  }catch(e){
    console.error('[PUSH] requestNotifications error:', e);
    showToast('שגיאה: '+e.message);
  }
  await updateNotifStatus();
}

async function subscribePush(silent){
  try{
    if(!('serviceWorker' in navigator) || !('PushManager' in window)){
      if(!silent) showToast('הדפדפן לא תומך בהתראות Push');
      return false;
    }
    const reg = await navigator.serviceWorker.ready;
    console.log('[PUSH] SW ready, fetching VAPID key...');

    // Get VAPID public key from server
    const keyRes = await fetch('/api/push/vapid-key');
    if(!keyRes.ok){
      console.warn('[PUSH] VAPID key not available:', keyRes.status);
      if(!silent) showToast('⚠️ שרת התראות לא זמין');
      return false;
    }
    const { publicKey } = await keyRes.json();
    if(!publicKey){
      if(!silent) showToast('⚠️ מפתח Push לא מוגדר בשרת');
      return false;
    }
    console.log('[PUSH] VAPID key received:', publicKey.slice(0, 20) + '...');

    // Convert base64url to Uint8Array
    const vapidKey = urlBase64ToUint8Array(publicKey);

    // Always clear old subscription and create fresh one
    // This ensures VAPID key mismatches never happen
    let sub = await reg.pushManager.getSubscription();
    if(sub){
      console.log('[PUSH] Clearing old subscription...');
      try{ await sub.unsubscribe(); }catch(e){ console.warn('[PUSH] Unsubscribe failed:', e.message); }
    }

    console.log('[PUSH] Creating new push subscription...');
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: vapidKey
    });
    console.log('[PUSH] Push subscription created, sending to server...');

    // Send subscription to server
    const subData = sub.toJSON();
    console.log('[PUSH] Subscription endpoint:', subData.endpoint?.slice(0, 60));
    const subRes = await fetch('/api/push/subscribe', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(subData)
    });
    if(!subRes.ok){
      const errData = await subRes.json().catch(()=>({}));
      console.warn('[PUSH] Server subscribe failed:', subRes.status, errData);
      if(!silent) showToast('⚠️ שגיאה ברישום: '+(errData.error||subRes.status));
      return false;
    }
    const result = await subRes.json();
    console.log('[PUSH] Subscription saved! Total:', result.total);
    ss('notif','granted');
    return true;
  }catch(e){
    console.error('[PUSH] Subscribe failed:', e);
    if(!silent) showToast('⚠️ '+e.message);
    return false;
  }
}

async function testPush(){
  const btn=document.querySelector('[onclick="testPush()"]');
  if(btn){btn.textContent='📤 שולח...';btn.disabled=true;}
  try{
    const r = await fetch('/api/push/test',{method:'POST'});
    const d = await r.json();
    if(d.ok) showToast('✅ פוש נשלח ל-'+d.subscribers+' מכשירים');
    else showToast('⚠️ '+(d.msg||d.error||'שגיאה'));
  }catch(e){ showToast('שגיאה: '+e.message); }
  if(btn){btn.textContent='📤 שלח פוש בדיקה';btn.disabled=false;}
}

function urlBase64ToUint8Array(base64String){
  const padding='='.repeat((4-base64String.length%4)%4);
  const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');
  const raw=window.atob(base64);
  return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));
}

// Send notification when alert arrives
function sendAlertNotif(cities, type){
  if(!('Notification'in window)||Notification.permission!=='granted')return;
  const body = Array.isArray(cities) ? cities.slice(0,4).join(' · ') : cities;
  new Notification('🚨 ' + (type||'ירי רקטות'),{
    body: body,
    icon:'/icon-192.png',
    badge:'/icon-192.png',
    vibrate:[300,100,300,100,300],
    requireInteraction:true,
    dir:'rtl',
    tag:'alert'
  });
}

// ── ALERT PANEL v2 JS ──
function apSetLive(connected){
  const pulse=document.getElementById('ap-pulse'),label=document.getElementById('ap-live-label'),sub=document.getElementById('ap-live-sub'),badge=document.getElementById('ap-src-badge');
  if(!pulse)return;
  if(connected){pulse.classList.remove('alrt');if(label)label.textContent='מחובר לצופר';if(sub)sub.textContent='מאזין לאזעקות בזמן אמת';if(badge){badge.textContent='🟢 LIVE';badge.classList.remove('alrt');}}
  else{pulse.classList.add('alrt');if(label)label.textContent='מתחבר מחדש...';if(sub)sub.textContent='מנסה לחזור לצופר';if(badge){badge.textContent='🔴 OFF';badge.classList.add('alrt');}}
}
function apSetAlert(alert){
  const box=document.getElementById('ap-status'),ico=document.getElementById('ap-status-ico'),txt=document.getElementById('ap-status-txt'),areas=document.getElementById('ap-status-areas'),card=document.getElementById('ap-live-card'),pulse=document.getElementById('ap-pulse'),badge=document.getElementById('ap-src-badge');
  if(!box)return;
  if(alert&&alert.data&&alert.data.length>0){
    box.classList.add('alrt');if(card)card.classList.add('active');if(pulse)pulse.classList.add('alrt');
    if(badge){badge.textContent='🚨 אזעקה!';badge.classList.add('alrt');}
    if(ico)ico.textContent='🚨';if(txt)txt.textContent=alert.title||'ירי רקטות';if(areas)areas.textContent=alert.data.join(' • ');
  }else{
    box.classList.remove('alrt');if(card)card.classList.remove('active');if(pulse)pulse.classList.remove('alrt');
    if(badge){badge.textContent='🟢 LIVE';badge.classList.remove('alrt');}
    if(ico)ico.textContent='🛡️';if(txt)txt.textContent='אין אזעקות פעילות';if(areas)areas.textContent='';
  }
}
function apUpdateStats(items){
  if(!items||!items.length)return;
  const today=new Date().toLocaleDateString('he-IL');
  let todayCount=0;const totalCities=new Set();
  items.forEach(item=>{
    const d=item.alertDate?new Date(item.alertDate).toLocaleDateString('he-IL'):'';
    if(d===today)todayCount++;
    (item.data||item.cities||[]).forEach(c=>totalCities.add(c));
  });
  const s1=document.getElementById('ap-stat-today'),s2=document.getElementById('ap-stat-cities'),s3=document.getElementById('ap-stat-total');
  if(s1)s1.textContent=todayCount;if(s2)s2.textContent=totalCities.size;if(s3)s3.textContent=items.length;
}
function apRenderHistory(items){
  const el=document.getElementById('ap-hist-list');if(!el)return;
  if(!items||!items.length){el.innerHTML='<div class="ap-empty"><div class="ap-empty-ico">🕊️</div>אין אירועים לאחרונה</div>';return;}
  el.innerHTML=items.slice(0,30).map((item,i)=>{
    const cities=Array.isArray(item.data)?item.data:(item.cities||[]);
    const main=cities.slice(0,5).map(c=>safeText(c)).join(' · ');
    const extra=cities.length>5?`<span class="ap-hist-count">+${cities.length-5} יישובים</span>`:'';
    const d=item.alertDate?new Date(item.alertDate):null;
    const timeStr=d?d.toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'}):'';
    const dateStr=d?d.toLocaleDateString('he-IL',{day:'numeric',month:'numeric'}):'';
    return `<div class="ap-hist-item" style="animation-delay:${i*.04}s"><div class="ap-hist-head"><div class="ap-hist-type">🚨 ${safeText(item.title||'ירי רקטות')}</div><div class="ap-hist-dt">${dateStr} · ${timeStr}</div></div><div class="ap-hist-cities">${main}${extra?'<br>'+extra:''}</div></div>`;
  }).join('');
  apUpdateStats(items);
}
async function apLoadHistory(){
  const el=document.getElementById('ap-hist-list');
  if(el)el.innerHTML='<div class="ap-empty"><div class="ap-empty-ico">⏳</div>טוען היסטוריה...</div>';
  // 1. local cache from server
  try{
    const r=await fetch('/api/alerts/history');
    if(r.ok){const d=await r.json();if(Array.isArray(d)&&d.length>0){apRenderHistory(d);return;}}
  }catch(e){}
  // 2. oref history proxy
  try{
    const r2=await fetch('/api/alerts/oref-history');
    if(r2.ok){const d2=await r2.json();if(Array.isArray(d2)&&d2.length>0){apRenderHistory(d2);return;}}
  }catch(e){}
  // 3. empty state
  const el2=document.getElementById('ap-hist-list');
  if(el2)el2.innerHTML='<div class="ap-empty"><div class="ap-empty-ico">🕊️</div><div style="font-size:14px;font-weight:700;margin-bottom:4px">אין שיגורים לאחרונה</div><div style="font-size:11px;opacity:0.6">המערכת מחוברת ופעילה.<br>אירועים יופיעו כאן בזמן אמת.</div></div>';
}
// New UI is fed via patched setConn / triggerAlert / clearAlertUI


// ── PULL TO REFRESH ──
(function(){
  let startY=0, pulling=false, threshold=72;
  const el=document.getElementById('ptr');
  document.addEventListener('touchstart',e=>{
    if(window.scrollY===0) startY=e.touches[0].clientY;
  },{passive:true});
  document.addEventListener('touchmove',e=>{
    if(!startY||window.scrollY>0) return;
    const dy=e.touches[0].clientY-startY;
    if(dy>10){
      pulling=true;
      el.classList.add('visible');
      const prog=Math.min(dy/threshold,1);
      el.style.transform=`translateX(-50%) translateY(${-60+prog*112}px) rotate(${prog*180}deg)`;
    }
  },{passive:true});
  document.addEventListener('touchend',()=>{
    if(!pulling){startY=0;return;}
    pulling=false;startY=0;
    el.style.transform='';
    el.classList.add('releasing','loading');
    el.textContent='↻';
    loadNews(true).finally?.(()=>{
      el.classList.remove('releasing','loading','visible');
    });
    // fallback cleanup
    setTimeout(()=>el.classList.remove('releasing','loading','visible'),3000);
  });
})();

loadNews(true);
connectStream();
pollOnce();

// ── AUTO-UPDATE ENGINE v3 — zero user interaction ──
const CLIENT_VERSION = '30';

(function initAutoUpdate(){
  if(!('serviceWorker' in navigator) || location.hostname.includes('claude')) return;

  // 1. Register SW with aggressive update check
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(reg => {
    console.log('[UPDATE] SW registered');

    // When a new SW is found, force it to activate immediately
    reg.addEventListener('updatefound', () => {
      const newSW = reg.installing;
      if (!newSW) return;
      newSW.addEventListener('statechange', () => {
        if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
          // New version installed — tell it to take over NOW
          console.log('[UPDATE] New SW installed, forcing activation...');
          newSW.postMessage('SKIP_WAITING');
        }
      });
    });
  }).catch(e => console.log('[UPDATE] SW registration failed:', e.message));

  // 2. When new SW takes control → auto-reload (no banner, no click)
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    console.log('[UPDATE] New SW active — reloading...');
    location.reload();
  });

  // 3. Listen for SW_UPDATED message as backup
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data && e.data.type === 'SW_UPDATED') {
      if (refreshing) return;
      refreshing = true;
      console.log('[UPDATE] SW message — reloading...');
      location.reload();
    }
  });

  // 4. Periodic version check against server API (every 2 min)
  async function checkServerVersion() {
    try {
      const r = await fetch('/api/version?_=' + Date.now(), { cache: 'no-store' });
      const d = await r.json();
      if (d.version && d.version !== CLIENT_VERSION) {
        console.log('[UPDATE] Server version ' + d.version + ' !== client ' + CLIENT_VERSION);
        // Force SW update check
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) {
          await reg.update();
          // If SW didn't catch it, nuclear option: unregister + reload
          setTimeout(() => {
            if (!refreshing) {
              console.log('[UPDATE] Nuclear: clearing everything...');
              nuclearUpdate();
            }
          }, 5000);
        } else {
          nuclearUpdate();
        }
      }
    } catch(e) {}
  }

  // 5. Nuclear update: clear all caches, unregister SW, hard reload
  async function nuclearUpdate() {
    try {
      // Delete all caches
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      // Unregister SW
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.unregister();
      // Hard reload — bypass all caches
      location.href = location.origin + '/?v=' + Date.now();
    } catch(e) {
      location.reload(true);
    }
  }

  // 6. Check for SW update frequently
  function checkSWUpdate() {
    navigator.serviceWorker.getRegistration().then(r => { if(r) r.update(); });
  }

  // Schedule checks
  setTimeout(checkServerVersion, 3000);     // First check after 3s
  setInterval(checkServerVersion, 120000);  // Then every 2 min
  setInterval(checkSWUpdate, 60000);        // SW update check every 1 min

  // 7. On visibility change (user returns to app) — check immediately
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkSWUpdate();
      setTimeout(checkServerVersion, 1000);
    }
  });

  // 8. On online (reconnect after offline) — check immediately
  window.addEventListener('online', () => {
    setTimeout(checkServerVersion, 2000);
  });

})();

// ── SHARE ──
let _shareUrl='',_shareTitle='',_shareSrc='';
function openShare(item){
  _shareTitle=item.title||'';_shareUrl=item.link||location.href;_shareSrc=item.sourceName||'חדשות IL';
  const eu=encodeURIComponent(_shareUrl);
  const em=encodeURIComponent(_shareTitle+'\n'+_shareSrc+'\n'+_shareUrl);
  document.getElementById('sh-wa').href='https://wa.me/?text='+em;
  document.getElementById('sh-tg').href='https://t.me/share/url?url='+eu+'&text='+encodeURIComponent(_shareTitle);
  document.getElementById('sh-copy').onclick=function(){
    navigator.clipboard.writeText(_shareUrl).then(()=>{
      const l=document.getElementById('sh-copy-lbl');l.textContent='✓ הועתק!';
      setTimeout(()=>{l.textContent='העתק קישור';},2000);
    });
  };
  document.getElementById('sh-native').onclick=function(){
    if(navigator.share)navigator.share({title:_shareTitle,url:_shareUrl});
    else navigator.clipboard.writeText(_shareUrl);
  };
  document.getElementById('share-overlay').classList.add('on');
}
function closeShare(e){
  if(e&&e.target&&e.target.id!=='share-overlay')return;
  document.getElementById('share-overlay').classList.remove('on');
}
// (update system moved to AUTO-UPDATE ENGINE v3 above)

