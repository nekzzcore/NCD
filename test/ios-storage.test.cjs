const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/profile-storage.js'), 'utf8').replace(/^import .*;\n/gm, '');

test('iOS Preferences restores profile offline after reopening; failed writes keep durable data', async t => {
    const durable = new Map();
    let failWrite = false;
    function open() {
        const dom = new JSDOM('', { url: 'capacitor://localhost', runScripts: 'outside-only' });
        t.after(() => dom.window.close());
        dom.window.preferences = {
            get: async ({ key }) => ({ value: durable.get(key) || null }),
            set: async ({ key, value }) => { if (failWrite) throw new Error('disk write failed'); durable.set(key, value); }
        };
        dom.window.eval('const Capacitor={getPlatform:()=>"ios",isNativePlatform:()=>true,isPluginAvailable:n=>n==="Preferences"}; const Preferences=window.preferences;\n' + source);
        return dom.window.ProfileStorage;
    }
    const first = open();
    await first.open();
    const profile = { schemaVersion: 1, user: { id: 'ios-user', nickname: 'iPhone' }, goals: [{ id: 'offline-goal', title: 'Offline goal' }] };
    await first.save(profile);
    await first.flush();
    await first.writeAccount('ios-account', profile);
    const reopened = open();
    await reopened.open();
    assert.equal(reopened.get().goals[0].id, 'offline-goal');
    assert.equal((await reopened.readAccount('ios-account')).user.id, 'ios-user');
    failWrite = true;
    await assert.rejects(reopened.save({ ...profile, goals: [] }), /disk write failed/);
    assert.equal(reopened.get().goals[0].id, 'offline-goal');
    const again = open();
    await again.open();
    assert.equal(again.get().goals[0].id, 'offline-goal');
});
