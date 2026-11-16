const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const [mode, phase, base, temporary] = process.argv.slice(2);
const separate = ['migration', 'corrupt'].includes(phase);
const directory = path.join(temporary, mode + (separate ? '-' + phase : ''));
fs.mkdirSync(directory, { recursive: true });
app.setPath('userData', directory);
app.disableHardwareAcceleration();
const legacyFile = path.join(directory, 'legacy.json');
const store = require('../profile-store').createProfileStore(directory, [legacyFile]);
ipcMain.handle('read-profile', () => store.read());
ipcMain.handle('read-legacy-profile', () => store.readLegacy());
ipcMain.handle('write-profile', (_, data) => store.write(data));
let win;
const deadline = setTimeout(() => { console.error('Timeout', mode, phase); app.exit(1); }, 40000);

app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, webPreferences: {
        backgroundThrottling: false,
        ...(mode === 'electron' ? { preload: path.join(__dirname, '../preload.js') } : {})
    } });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: /^https?:/.test(details.url) && !details.url.startsWith(base) });
    });
    const evaluate = code => win.webContents.executeJavaScript(code);
    const wait = async code => {
        for (let i = 0; i < 150; i++) {
            if (await evaluate(code)) return;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Not ready: ' + code);
    };
    const load = async () => { await win.loadURL(base); await wait('window.app instanceof GoalTracker'); };
    const expectedFile = path.join(directory, 'expected.json');

    if (phase === 'migration') {
        await win.loadURL(base + '/blank.html');
        await evaluate(`localStorage.setItem('goalTracker_data', JSON.stringify({user:{nickname:'Legacy',createdAt:'2020-01-01'},goals:[],notes:{},customField:{keep:true},settings:{autoSync:false,notifications:false}}))`);
        await load();
        const id = await evaluate('app.user.id');
        assert(id);
        await evaluate('ProfileStorage.flush()');
        await load();
        assert.equal(await evaluate('app.user.id'), id);
        assert.equal(await evaluate('ProfileStorage.get().customField.keep'), true);
        if (mode === 'electron') assert.equal(store.read().user.id, id);
        return;
    }

    if (phase === 'corrupt') {
        if (mode === 'electron') fs.writeFileSync(path.join(directory, 'profile.json'), '{broken');
        else {
            await win.loadURL(base + '/blank.html');
            await evaluate(`localStorage.setItem('goalTracker_data','{broken')`);
        }
        await win.loadURL(base);
        await wait(`document.getElementById('authScreen').textContent.includes('Данные не сброшены')`);
        assert.equal(await evaluate(`!!document.getElementById('authForm')`), false);
        if (mode === 'electron') assert.equal(fs.readFileSync(path.join(directory, 'profile.json'), 'utf8'), '{broken');
        else assert.equal(await evaluate(`localStorage.getItem('goalTracker_data')`), '{broken');
        return;
    }

    await load();
    if (phase === 'create') {
        assert.equal(await evaluate('app.user'), null);
        await evaluate(`app.settings.autoSync=false;app.settings.notifications=false;document.getElementById('authNickname').value='Persistent';document.getElementById('authForm').requestSubmit()`);
        await wait('!!app.user && getComputedStyle(document.getElementById("app")).display !== "none"');
        await evaluate(`app.goals=[{id:'goal-1',title:'Keep goal',category:'health',priority:'medium',status:'active',subgoals:[]}]; app.notes={'2026-01-01':[{id:'note-1',content:'Keep note'}]};app.gamification.xp=123;app.saveData()`);
        await evaluate('ProfileStorage.flush()');
        const id = await evaluate('app.user.id');
        assert(id);
        fs.writeFileSync(expectedFile, JSON.stringify({ id }));
    } else if (phase === 'restart' || phase === 'update') {
        const { id } = JSON.parse(fs.readFileSync(expectedFile));
        if (phase === 'update') {
            await evaluate('navigator.serviceWorker.ready.then(r=>r.update())');
            await wait(`caches.keys().then(keys=>keys.includes('profile-test-update-${mode}'))`);
            await wait('navigator.serviceWorker.getRegistration().then(r=>r && !r.installing && !r.waiting)');
            await load();
            await wait(`APP_VERSION === '9.9.9'`);
        }
        assert.equal(await evaluate('app.user.id'), id);
        assert.equal(await evaluate('app.goals[0].title'), 'Keep goal');
        assert.equal(await evaluate('app.notes["2026-01-01"][0].content'), 'Keep note');
        assert.equal(await evaluate(`getComputedStyle(document.getElementById('authScreen')).display`), 'none');
        // Регрессия: частичный ответ сервера без user не должен стереть профиль на диске.
        await evaluate(`app.applyRemote({settings:{theme:'dark'}})`);
        await evaluate('ProfileStorage.flush()');
        await load();
        assert.equal(await evaluate('app.user.id'), id);
        assert.equal(await evaluate('app.goals[0].title'), 'Keep goal');
        await evaluate(`app.switchView('profile')`);
        assert.equal(await evaluate(`!!document.querySelector('[data-auth-form],input[type="password"]')`), false);
    } else if (phase === 'reset') {
        const { id } = JSON.parse(fs.readFileSync(expectedFile));
        fs.writeFileSync(legacyFile, JSON.stringify(await evaluate('app.serialize()')));
        await evaluate('window.confirm=()=>false;app.resetProfile()');
        assert.equal(await evaluate('app.user.id'), id);
        const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
        await evaluate('window.confirm=()=>true;app.resetProfile()');
        await loaded;
        await wait('window.app instanceof GoalTracker');
        assert.equal(await evaluate('app.user'), null);
        assert.equal(await evaluate('app.goals.length'), 0);
    } else if (phase === 'after-reset') {
        assert.equal(await evaluate('app.user'), null);
        assert.equal(await evaluate('app.settings.autoSync'), false);
        assert.equal(await evaluate('ProfileStorage.get().profileReset'), true);
    }
    await evaluate('ProfileStorage.flush()');
    win.webContents.session.flushStorageData();
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    clearTimeout(deadline);
    win?.destroy();
    app.exit(process.exitCode || 0);
});
