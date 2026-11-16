const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const main=fs.readFileSync(path.join(root,'main.js'),'utf8');
const createWindow=main.slice(main.indexOf('async function createWindow()'),main.indexOf('app.whenReady()'));

test('Desktop clears only stale worker caches before loading application assets',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;}),calls=[];
 class BrowserWindow {
  constructor(){this.webContents={session:{clearStorageData:async options=>{calls.push(options);await gate;}}};}
  loadURL(url){calls.push(url);} once(){} on(){}
 }
 const context=vm.createContext({BrowserWindow,path,__dirname:root,console});
 vm.runInContext('let mainWindow;'+createWindow+';globalThis.start=createWindow;',context);
 const loading=context.start();
 assert.equal(calls.length,1);
 assert.deepEqual(JSON.parse(JSON.stringify(calls[0])),{origin:'http://localhost:8000',storages:['serviceworkers','cachestorage']});
 release();await loading;
 assert.equal(calls[1],'http://localhost:8000');
});

test('Electron unregisters legacy workers while the browser keeps PWA support',async()=>{
 const source=fs.readFileSync(path.join(root,'app.js'),'utf8');
 const begin=source.indexOf("        if ('serviceWorker' in navigator) {");
 const block=source.slice(begin,source.indexOf('        // PWA Install Prompt',begin));
 for(const desktop of [true,false]){
  const calls=[];
  const context=vm.createContext({window:desktop?{electronAPI:{}}:{},navigator:{serviceWorker:{
   getRegistrations:async()=>[{unregister(){calls.push('unregister');}}],register:url=>{calls.push(url);return Promise.resolve();}
  }}});
  vm.runInContext(block,context);await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,desktop?['unregister']:['/sw.js']);
 }
});
