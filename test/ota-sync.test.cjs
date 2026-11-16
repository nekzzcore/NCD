const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const appSource=fs.readFileSync(path.join(root,'app.js'),'utf8');
const current=appSource.match(/const APP_VERSION = '([^']+)'/)[1];
function fixture(fetcher,native=false,timer=setTimeout) {
 const calls=[],toasts=[],banners=[],storage=new Map();
 const window={Capacitor:{isNativePlatform:()=>native}};
 const context=vm.createContext({window,document:{addEventListener(){}},console:{log(){},warn(){}},AbortController,
  setTimeout:timer,clearTimeout,localStorage:{removeItem:key=>storage.delete(key),getItem:key=>storage.get(key)},
  fetch:async(url,options)=>{calls.push({url,options});return fetcher(url,options);}});
 vm.runInContext(fs.readFileSync(path.join(root,'ota-sync.js'),'utf8')+'\n'+appSource+'\nwindow.GoalTracker=GoalTracker;',context);
 const app=window.app=Object.create(window.GoalTracker.prototype);
 app.showToast=(...args)=>toasts.push(args);app.showUpdateBanner=info=>banners.push(info);app.hideUpdateBanner=()=>{};
 return {app,window,calls,toasts,banners,storage};
}
const response=version=>({ok:true,json:async()=>({version,updateUrl:'https://goaltracker-pro.nekzzcore.workers.dev/updates/latest.zip?version='+version})});
test('Manual OTA refresh bypasses a completed startup check and uses the configured Worker',async()=>{
 let version=current;const h=fixture(async()=>response(version));
 await h.app.checkForWebUpdate();await h.app.checkForWebUpdate();assert.equal(h.calls.length,1);
 version='999.0.0';h.storage.set('goaltracker_update_dismissed',version);
 await h.window.OTASync.refresh();assert.equal(h.calls.length,2);assert.equal(h.banners[0].version,version);
 assert.equal(h.storage.has('goaltracker_update_dismissed'),false);
 for(const call of h.calls){assert.match(call.url,/^https:\/\/goaltracker-pro\.nekzzcore\.workers\.dev\/version\.json\?t=\d+$/);assert.equal(call.options.cache,'no-store');}
});
test('A failed startup request does not suppress the next OTA attempt',async()=>{
 let fail=true;const h=fixture(async()=>{if(fail)throw new Error('offline');return response(current);});
 await h.app.checkForWebUpdate();assert.equal(h.app._updateCheckDone,false);
 fail=false;await h.app.checkForWebUpdate();assert.equal(h.calls.length,2);assert.equal(h.app._updateCheckDone,true);
});
test('Forced OTA checks report HTTP failures and remain retryable',async()=>{
 const h=fixture(async()=>({ok:false,status:503}));await h.window.OTASync.refresh();
 assert.equal(h.app._updateCheckDone,false);assert.equal(h.toasts.at(-1)[1],'error');
 await h.window.OTASync.refresh();assert.equal(h.calls.length,2);
});
test('Native manual refresh waits for installation rather than only starting a background task',async()=>{
 const h=fixture(async()=>response('999.0.0'),true);let finish,installed=false;
 h.app.backgroundDownloadUpdate=()=>new Promise(resolve=>{finish=()=>{installed=true;resolve(true);};});
 const checking=h.window.OTASync.refresh();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(installed,false);finish();assert.equal(await checking,true);assert.equal(installed,true);
});
test('Concurrent forced refreshes share one version request',async()=>{
 let finish;const h=fixture(()=>new Promise(resolve=>finish=resolve));
 const first=h.window.OTASync.refresh(),second=h.window.OTASync.refresh();assert.equal(h.calls.length,1);
 finish(response(current));await Promise.all([first,second]);assert.equal(h.app._updateCheckPromise,null);
});

test('A stalled version request times out and permits the next manual check',async()=>{
 const h=fixture((url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('timeout')))),false,callback=>setTimeout(callback,1));
 await h.window.OTASync.refresh();assert.equal(h.app._updateCheckDone,false);assert.equal(h.app._updateCheckPromise,null);
 assert.equal(h.toasts.at(-1)[1],'error');
});
