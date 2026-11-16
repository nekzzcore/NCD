const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const {options}=require('../bin/web-dev.cjs');
const root=path.join(__dirname,'..');
function worker(network=async()=>{throw new Error('offline');}) {
 const handlers={},entries=new Map(),writes=[];
 const cache={match:async key=>entries.get(typeof key==='string'?key:key.url),put:async(key,value)=>{writes.push(key.url);entries.set(key.url,value);},addAll:async assets=>{for(const asset of assets)assert.ok(fs.existsSync(path.join(root,asset.split('?')[0])),asset);},add:async()=>{}};
 const context=vm.createContext({self:{location:{origin:'https://ncd.invalid'},addEventListener:(name,fn)=>handlers[name]=fn,skipWaiting:async()=>{},clients:{claim:async()=>{}}},caches:{open:async()=>cache},fetch:network,URL,Response,console});
 vm.runInContext(fs.readFileSync(path.join(root,'sw.js'),'utf8'),context);
 return {handlers,entries,writes,async get(url,mode='cors',headers={}){
  let response;const waits=[];
  handlers.fetch({request:{url:'https://ncd.invalid'+url,method:'GET',mode,headers:new Headers(headers)},respondWith:value=>response=value,waitUntil:value=>waits.push(value)});
  const result=response?await response:null;await Promise.all(waits);return result;
 }};
}
test('PWA manifest uses standalone mode and real 192/512px icons',()=>{
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json')));
 assert.equal(manifest.name,'NCD');assert.equal(manifest.display,'standalone');
 for(const size of [192,512]){
  const icon=manifest.icons.find(i=>i.sizes===`${size}x${size}`&&i.purpose==='any');assert.ok(icon);
  const png=fs.readFileSync(path.join(root,icon.src.split('?')[0]));assert.equal(png.readUInt32BE(16),size);assert.equal(png.readUInt32BE(20),size);
 }
});
test('Browser CLI accepts LAN flags, defaults to all interfaces, and rejects invalid ports',()=>{
 assert.deepEqual(options([],{}),{host:'0.0.0.0',port:8100});
 assert.deepEqual(options(['--host','--port','8101'],{}),{host:'0.0.0.0',port:8101});
 assert.equal(options(['--host','192.168.1.4'],{}).host,'192.168.1.4');
 for(const port of ['NaN','0','65536'])assert.throws(()=>options(['--port',port],{}));
 assert.throws(()=>options([],{NCD_HTTPS_CERT:'cert.pem'}));
});
test('Worker precache references existing assets',async()=>{
 const h=worker();let work;h.handlers.install({waitUntil:p=>work=p});await work;
});
test('Offline navigation to an uncached URL falls back to the cached shell',async()=>{
 const h=worker();h.entries.set('./index.html',new Response('<main>NCD offline</main>'));
 const result=await h.get('/index.html?from=home','navigate');assert.equal(result.status,200);assert.match(await result.text(),/NCD offline/);
 assert.equal((await h.get('/unknown.js')).status,503);
});
test('Worker returns cached assets immediately and keeps the network update alive',async()=>{
 const h=worker(async()=>new Response('new'));h.entries.set('https://ncd.invalid/app.js',new Response('cached'));
 assert.equal(await(await h.get('/app.js')).text(),'cached');assert.ok(h.writes.includes('https://ncd.invalid/app.js'));
 assert.equal(await h.entries.get('https://ncd.invalid/app.js').text(),'new');
});
test('Worker leaves API, credentials and update metadata outside the cache',async()=>{
 const h=worker();for(const url of ['/api/data','/rest/v1/goals','/__mobile_events','/version.json','/updates/latest.zip'])assert.equal(await h.get(url),null);
 assert.equal(await h.get('/private','cors',{authorization:'Bearer fixture'}),null);assert.deepEqual(h.writes,[]);
});
test('Install prompt is retained on the app and listeners are bound only once',async t=>{
 const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:'https://ncd.invalid',runScripts:'outside-only'});t.after(()=>dom.window.close());
 const w=dom.window;w.eval(fs.readFileSync(path.join(root,'app.js'),'utf8').split('// ===== Initialize =====')[0]+';window.GoalTracker=GoalTracker;');
 const app=Object.create(w.GoalTracker.prototype);app.showToast=()=>{};app.initPWA();app.initPWA();
 const event=new w.Event('beforeinstallprompt',{cancelable:true});let prompts=0;event.prompt=async()=>{prompts++;};event.userChoice=Promise.resolve({outcome:'accepted'});
 w.dispatchEvent(event);assert.ok(event.defaultPrevented);assert.equal(app.deferredPrompt,event);
 assert.notEqual(w.document.getElementById('installPwaBtn').style.display,'none');await app.installPWA();
 assert.equal(prompts,1);assert.equal(app.deferredPrompt,null);assert.equal(w.document.getElementById('installPwaBtn').style.display,'none');
});

test('Mobile details behave as a dismissible dialog and desktop details remain a region',t=>{
 const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:'https://mobile.invalid',runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());
 const w=dom.window,d=w.document;const media=new Map();
 w.matchMedia=query=>{if(!media.has(query))media.set(query,{matches:query.includes('768px')||query.includes('reduced-motion'),addEventListener(type,fn){this.change=fn;}});return media.get(query);};
 w.eval(fs.readFileSync(path.join(root,'app.js'),'utf8').split('// ===== Initialize =====')[0]+';window.GoalTracker=GoalTracker;');
 const app=Object.create(w.GoalTracker.prototype);Object.assign(app,{goals:[{id:'mobile',title:'Цель на телефоне',status:'active',category:'personal',priority:'medium',subgoals:[]}],achievements:[],events:[],notes:{},settings:{},currentView:'goals',currentMonth:new Date()});
 d.getElementById('app').style.display='grid';d.getElementById('authScreen').style.display='none';
 app.bindEvents();app.renderGoals();const row=d.querySelector('.goal-item');const wrap=d.querySelector('.goal-row');row.focus();row.click();
 assert.ok(wrap.classList.contains('is-open'),'row click expands the accordion');assert.equal(row.getAttribute('aria-expanded'),'true');
 const detail=d.getElementById('goalDetailModal');assert.equal(detail.classList.contains('active'),false,'expanding never opens the modal');
 const openDetail=()=>wrap.querySelector('[data-open-goal-detail]').click();
 openDetail();assert.equal(detail.getAttribute('role'),'dialog');assert.equal(detail.getAttribute('aria-modal'),'true');assert.equal(d.activeElement.id,'closeDetailModal');
 d.getElementById('addGoalBtn').focus();assert.ok(detail.contains(d.activeElement));
 d.getElementById('goalDetailBackdrop').click();assert.equal(detail.classList.contains('active'),false);assert.equal(d.activeElement,row);
 openDetail();assert.equal(d.activeElement.id,'closeDetailModal');d.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(detail.classList.contains('active'),false);
 openDetail();d.getElementById('editGoalBtn').click();assert.ok(d.getElementById('goalModal').classList.contains('active'));assert.equal(d.activeElement.id,'goalTitle');app.closeModal('goalModal');
 const mobile=media.get('(max-width: 768px)');mobile.matches=false;mobile.change();
 assert.equal(detail.getAttribute('role'),'region');assert.equal(detail.hasAttribute('aria-modal'),false);
});
