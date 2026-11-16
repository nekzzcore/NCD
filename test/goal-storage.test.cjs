const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../src/profile-storage.js'), 'utf8')
    .replace(/^import .*;\n/gm, '');

function storageFixture(t) {
    const dom = new JSDOM('', { url: 'https://storage.invalid/', runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
    t.after(() => dom.window.close());
    const w = dom.window;
    const initial = { schemaVersion: 1, user: { id: 'fixture', nickname: 'Test' }, goals: [] };
    let durable = JSON.parse(JSON.stringify(initial));
    let rejectWrite = false;
    let holdNext = null;
    const revisions = [];
    w.electronAPI = {
        readProfile: async () => JSON.parse(JSON.stringify(durable)),
        writeProfile: async data => {
            if (holdNext) { const gate = holdNext; holdNext = null; await gate; }
            if (rejectWrite) throw new Error('simulated storage failure');
            durable = JSON.parse(JSON.stringify(data));
            revisions.push(data.storageRevision);
        }
    };
    w.eval('const Capacitor = { isNativePlatform: () => false }; const Preferences = {};\n' + source);
    return {
        w, initial, revisions,
        holdNextWrite(promise) { holdNext = promise; },
        durable: () => durable,
        fail: value => { rejectWrite = value; },
        mirror: () => JSON.parse(w.localStorage.getItem('goalTracker_data'))
    };
}

test('Failed durable write cannot leak a ghost goal into the snapshot or startup mirror', async t => {
    const h = storageFixture(t); await h.w.ProfileStorage.open();
    const prior = JSON.stringify(h.w.ProfileStorage.get());
    const mirror = JSON.stringify(h.mirror());
    h.fail(true);
    await assert.rejects(h.w.ProfileStorage.save({ ...h.initial, goals: [{ id: 'ghost' }] }));
    assert.equal(JSON.stringify(h.w.ProfileStorage.get()), prior);
    assert.equal(JSON.stringify(h.mirror()), mirror);
    assert.equal(h.durable().goals.length, 0);
    h.fail(false);
    await h.w.ProfileStorage.save({ ...h.initial, goals: [{ id: 'once' }] });
    assert.equal(h.w.ProfileStorage.get().goals.length, 1);
    assert.equal(h.mirror().goals[0].id, 'once');
    assert.equal(h.durable().goals.length, 1);
});

test('Queued writes keep strictly increasing revisions and the last successful snapshot', async t => {
    const h = storageFixture(t); await h.w.ProfileStorage.open();
    const a = h.w.ProfileStorage.save({ ...h.initial, goals: [{ id: 'a' }] });
    const b = h.w.ProfileStorage.save({ ...h.initial, goals: [{ id: 'b' }] });
    await Promise.all([a, b]);
    assert.ok(h.revisions.every((n, i, all) => i === 0 || n > all[i - 1]));
    assert.equal(h.w.ProfileStorage.get().goals[0].id, 'b');
    assert.equal(h.durable().goals[0].id, 'b');
});

test('Local-storage fallback reports quota/write failures instead of false success', async t => {
    const h = storageFixture(t);
    await h.w.ProfileStorage.openFallback('test fallback');
    Object.defineProperty(h.w, 'localStorage', {
        value: { getItem: () => null, setItem() { throw new Error('quota exceeded'); } }
    });
    await assert.rejects(h.w.ProfileStorage.save(h.initial), /quota exceeded/);
    assert.equal(h.w.ProfileStorage.get(), null);
});

test('Secure erase clears durable snapshot, mirror and all legacy private keys and blocks legacy recovery',async t=>{
 const h=storageFixture(t);await h.w.ProfileStorage.open();await h.w.ProfileStorage.save({...h.initial,goals:[{id:'private',title:'PRIVATE'}]});
 for(const key of ['gt_goals','gt_finance','gt_calendar','gt_profile','gt_safety_fund','customAvatarData:fixture','gt-cloud-backup-v1:owner'])h.w.localStorage.setItem(key,'PRIVATE');
 h.w.localStorage.setItem('theme','light');await h.w.ProfileStorage.clearUserData();
 assert.equal(h.durable().user,null);assert.equal(h.durable().goals.length,0);assert.equal(h.mirror().profileReset,true);assert.equal(h.w.ProfileStorage.get().user,null);
 assert.ok(Object.keys(h.w.localStorage).every(key=>['theme','goalTracker_data'].includes(key)));
 h.w.electronAPI.readLegacyProfile=async()=>{throw Error('Legacy recovery must stay blocked');};await h.w.ProfileStorage.open();assert.equal(h.w.ProfileStorage.get().user,null);
});
test('A queued or in-flight write cannot resurrect the prior account after secure erase',async t=>{
 const h=storageFixture(t);await h.w.ProfileStorage.open();let release;h.holdNextWrite(new Promise(r=>release=r));
 const pending=h.w.ProfileStorage.save({...h.initial,goals:[{id:'late',title:'PRIVATE'}]});const outcome=pending.then(()=>false,()=>true);await new Promise(r=>setImmediate(r));
 const clear=h.w.ProfileStorage.clearUserData();await assert.rejects(h.w.ProfileStorage.save(h.initial),/being cleared/);release();assert.equal(await outcome,true);await clear;
 assert.equal(h.durable().user,null);assert.equal(h.mirror().goals.length,0);assert.doesNotMatch(JSON.stringify(h.w.ProfileStorage.get()),/PRIVATE/);
});
test('Failed durable erase still removes private browser content and never revives the old in-memory snapshot',async t=>{
 const h=storageFixture(t);await h.w.ProfileStorage.open();h.fail(true);h.w.localStorage.setItem('gt_goals','PRIVATE');
 await assert.rejects(h.w.ProfileStorage.clearUserData());assert.equal(h.w.ProfileStorage.get().user,null);assert.equal(h.mirror().user,null);assert.equal(h.w.localStorage.getItem('gt_goals'),null);
});
test('Native Preferences secure erase removes every private key and writes only the empty recovery tombstone',async t=>{
 const dom=new JSDOM('',{url:'https://native-storage.invalid/',runScripts:'outside-only',virtualConsole:new VirtualConsole()});t.after(()=>dom.window.close());const w=dom.window;
 const values=new Map([['goalTracker_data',JSON.stringify({schemaVersion:1,user:{id:'a',nickname:'PRIVATE'},goals:[]})],['gt_goals','PRIVATE'],['gt_finance','PRIVATE'],['gt_calendar','PRIVATE'],['gt_profile','PRIVATE'],['gt_safety_fund','PRIVATE'],['customAvatarData:a','PRIVATE'],['goaltracker.supabase.tokens.a.access_token','PRIVATE']]);
 w.nativePreferences={get:async({key})=>({value:values.get(key)||null}),set:async({key,value})=>values.set(key,value),remove:async({key})=>values.delete(key),keys:async()=>({keys:[...values.keys()]})};
 w.eval('const Capacitor={isNativePlatform:()=>true,isPluginAvailable:()=>true};const Preferences=window.nativePreferences;'+source);await w.ProfileStorage.open();await w.ProfileStorage.clearUserData();
 assert.deepEqual([...values.keys()],['goalTracker_data']);assert.equal(JSON.parse(values.get('goalTracker_data')).user,null);assert.equal(w.ProfileStorage.get().user,null);
});

test('Android startup opens the local mirror without waiting for Preferences reads or writes',async t=>{
 const dom=new JSDOM('',{url:'https://native-startup.invalid/',runScripts:'outside-only',virtualConsole:new VirtualConsole()});t.after(()=>dom.window.close());const w=dom.window;
 let calls=0;w.nativePreferences={get:()=>{calls++;return new Promise(()=>{});},set:()=>{calls++;return new Promise(()=>{});}};
 w.localStorage.setItem('goalTracker_data',JSON.stringify({schemaVersion:1,user:{id:'cached',nickname:'Cached'},goals:[{id:'cached-goal'}]}));
 w.eval('const Capacitor={isNativePlatform:()=>true,isPluginAvailable:()=>true};const Preferences=window.nativePreferences;'+source);
 const result=await Promise.race([w.ProfileStorage.open({preferCache:true}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Startup waited for Preferences')),100);t.after(()=>clearTimeout(timer));})]);
 assert.equal(result.user.id,'cached');assert.equal(result.goals[0].id,'cached-goal');assert.equal(calls,0);
});

test('Account snapshots survive clearing active storage and stay separated by identity',async t=>{
 const h=storageFixture(t);await h.w.ProfileStorage.open();
 const a='https://fixture.supabase.co|a',b='https://fixture.supabase.co|b';
 await h.w.ProfileStorage.writeAccount(a,{goals:[{id:'a-goal'}]});await h.w.ProfileStorage.writeAccount(b,{goals:[{id:'b-goal'}]});
 await h.w.ProfileStorage.clearUserData();
 assert.equal((await h.w.ProfileStorage.readAccount(a)).goals[0].id,'a-goal');
 assert.equal((await h.w.ProfileStorage.readAccount(b)).goals[0].id,'b-goal');
 assert.equal(h.w.ProfileStorage.get().user,null);
});
