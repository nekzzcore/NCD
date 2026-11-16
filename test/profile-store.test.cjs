const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createProfileStore } = require('../profile-store');

test('Неудачная запись не повреждает сохранённый профиль', t => {
    const dir = fs.mkdtempSync('/tmp/opencode/goaltracker-store-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = createProfileStore(dir);
    const saved = { user: { id: 'stable-id', nickname: 'Saved' }, goals: [{ id: 'goal' }] };
    store.write(saved);
    fs.mkdirSync(path.join(dir, 'profile.json.tmp'));
    assert.throws(() => store.write({ user: null }));
    assert.deepEqual(createProfileStore(dir).read(), saved);
});

test('Повреждённый JSON не считается отсутствующим профилем', t => {
    const dir = fs.mkdtempSync('/tmp/opencode/goaltracker-store-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = createProfileStore(dir);
    assert.equal(store.read(), null);
    fs.writeFileSync(path.join(dir, 'profile.json'), '{broken');
    assert.throws(() => store.read(), SyntaxError);
    assert.equal(fs.readFileSync(path.join(dir, 'profile.json'), 'utf8'), '{broken');
});

test('Secure clear overwrites the current Electron profile and legacy recovery files',t=>{
 const dir=fs.mkdtempSync('/tmp/opencode/goaltracker-store-');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const legacy=path.join(dir,'data.json');
 fs.writeFileSync(legacy,JSON.stringify({user:{nickname:'PRIVATE'},goals:[{id:'private'}]}));const store=createProfileStore(dir,[legacy]);store.write({user:{nickname:'PRIVATE'},goals:[{id:'private'}]});
 const empty={schemaVersion:1,profileReset:true,user:null,goals:[]};store.clear(empty);assert.deepEqual(store.read(),empty);assert.equal(store.readLegacy(),null);assert.doesNotMatch(fs.readFileSync(legacy,'utf8'),/PRIVATE/);
});

test('Per-account data remains durable after logout clears active and legacy profiles',t=>{
 const dir=fs.mkdtempSync('/tmp/ncd-accounts-');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=createProfileStore(dir),a='https://fixture.supabase.co|account-a',b='https://fixture.supabase.co|account-b';
 const data={goals:[{id:'kept'}],transactions:[{id:'tx'}]};store.writeAccount(a,data);store.writeAccount(b,{goals:[]});
 store.clear({user:null,profileReset:true});
 const reopened=createProfileStore(dir);assert.deepEqual(reopened.readAccount(a),data);assert.deepEqual(reopened.readAccount(b),{goals:[]});
 assert.equal(reopened.readAccount('https://fixture.supabase.co|unknown'),null);
 for(const file of fs.readdirSync(path.join(dir,'accounts')))assert.equal(fs.statSync(path.join(dir,'accounts',file)).mode&0o777,0o600);
});
