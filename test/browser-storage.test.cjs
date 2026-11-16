const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../src/profile-storage.js'), 'utf8').replace(/^import .*;\n/gm, '');

test('Browser without IndexedDB keeps the offline profile in localStorage across reopen', async t => {
    function open(storage) {
        const dom = new JSDOM('', { url: 'https://ncd.invalid/', runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
        t.after(() => dom.window.close());
        const w = dom.window;
        if (storage) Object.defineProperty(w, 'localStorage', { value: storage });
        w.eval('const Capacitor={isNativePlatform:()=>false};const Preferences={};\n' + source);
        return w;
    }
    const first = open();
    await first.ProfileStorage.open();
    await first.ProfileStorage.save({ schemaVersion: 1, user: { id: 'browser', nickname: 'Safari' }, goals: [{ id: 'offline', title: 'Saved offline' }] });
    await first.ProfileStorage.flush();
    const reopened = open(first.localStorage);
    await reopened.ProfileStorage.open();
    assert.equal(reopened.ProfileStorage.get().goals[0].id, 'offline');
    assert.equal(reopened.ProfileStorage.get().user.nickname, 'Safari');
});
