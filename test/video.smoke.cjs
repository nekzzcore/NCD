// Запуск: node_modules/.bin/electron test/video.smoke.cjs
// Изолированная сессия и случайный порт: пользовательские данные не используются.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const packaged = process.argv.includes('--asar');
let testData;
if (packaged) {
    testData = fs.mkdtempSync('/tmp/opencode/goaltracker-asar-test-');
    app.setPath('userData', testData);
    Object.defineProperty(app, 'isPackaged', { value: true });
}
const { start } = require(packaged ? '../dist/linux-unpacked/resources/app.asar/server.js' : '../server');

app.disableHardwareAcceleration();
let server;
let win;
const errors = [];
const requests = [];
let offlineMode = false;
const timeout = setTimeout(() => { console.error('Test timed out'); app.exit(1); }, 45000);

app.whenReady().then(async () => {
    server = start(0);
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const bytes = fs.readFileSync(path.join(__dirname, '../assets/avatar/body_scan.mp4'));
    for (const [range, start, end] of [['bytes=0-99', 0, 99], ['bytes=-128', bytes.length - 128, bytes.length - 1], ['bytes=100-', 100, bytes.length - 1]]) {
        const res = await fetch(base + '/assets/avatar/body_scan.mp4', { headers: { Range: range } });
        assert.equal(res.status, 206);
        assert.equal(res.headers.get('content-type'), 'video/mp4');
        assert.equal(res.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`);
        assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes.subarray(start, end + 1));
    }
    for (const range of ['bytes=999999999-', 'bytes=-0', 'bytes=20-10']) {
        assert.equal((await fetch(base + '/assets/avatar/body_scan.mp4', { headers: { Range: range } })).status, 416);
    }
    console.log('PASS HTTP video ranges');

    win = new BrowserWindow({ show: false, webPreferences: { partition: 'body-video-smoke', backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        requests.push(details.url);
        callback({ cancel: offlineMode || (!details.url.startsWith(base) && /^https?:/.test(details.url)) });
    });
    win.webContents.debugger.attach('1.3');
    win.webContents.debugger.on('message', (_, method, params) => {
        if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails);
    });
    const evaluate = code => win.webContents.executeJavaScript(code);
    async function waitFor(expression) {
        for (let i = 0; i < 100; i++) {
            if (await evaluate(expression)) return;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('Not ready: ' + expression);
    }

    await win.loadURL(base);
    await win.webContents.debugger.sendCommand('Runtime.enable');
    await waitFor('window.app instanceof GoalTracker');
    assert.equal(await evaluate('window.app instanceof GoalTracker && getComputedStyle(document.getElementById("authScreen")).display !== "none"'), true);
    console.log('PASS fresh-profile startup');
    await evaluate(`window.ProfileStorage.save({user:{nickname:'Smoke',avatar:'😊',createdAt:new Date().toISOString()},settings:{autoSync:false,notifications:false}})`);
    await win.loadURL(base);
    await waitFor('document.getElementById("bodyScanVideo").currentTime > 0.1');
    assert.deepEqual(await evaluate(`(()=>{const v=document.getElementById('bodyScanVideo');return [v.videoWidth,v.videoHeight,v.muted,v.loop,v.playsInline]})()`), [720, 1280, true, true, true]);
    await evaluate(`app.switchView('goals')`);
    assert.equal(await evaluate('document.getElementById("bodyScanVideo").paused'), true);
    await evaluate(`app.switchView('dashboard')`);
    await waitFor('!document.getElementById("bodyScanVideo").paused');
    console.log('PASS H.264 decoding, autoplay, navigation');

    await evaluate(`navigator.serviceWorker.ready.then(() => true)`);
    await waitFor('!!navigator.serviceWorker.controller');
    await win.loadURL(base);
    win.webContents.session.enableNetworkEmulation({ offline: true });
    offlineMode = true;
    const offline = await evaluate(`fetch('assets/avatar/body_scan.mp4', {headers:{Range:'bytes=0-99'}}).then(async r=>({status:r.status,length:(await r.arrayBuffer()).byteLength}))`);
    assert.deepEqual(offline, { status: 206, length: 100 });
    await win.loadURL(base);
    await waitFor('document.getElementById("bodyScanVideo").currentTime > 0.1');
    console.log('PASS offline PWA reload and video playback');
    win.webContents.session.disableNetworkEmulation();
    offlineMode = false;

    await evaluate(`window.savedPlay=HTMLMediaElement.prototype.play; document.getElementById('bodyScanVideo').pause(); HTMLMediaElement.prototype.play=()=>Promise.reject(new DOMException('Blocked','NotAllowedError')); window.avatarVideo.refresh()`);
    await waitFor('!document.getElementById("bodyScanPlay").hidden');
    await evaluate(`HTMLMediaElement.prototype.play=window.savedPlay; document.getElementById('bodyScanPlay').click()`);
    await waitFor('!document.getElementById("bodyScanVideo").paused');
    console.log('PASS autoplay rejection and manual recovery');

    await evaluate(`document.getElementById('bodyScanVideo').src='assets/avatar/missing-test.mp4'`);
    await waitFor('document.getElementById("bodyScanVideo").hidden');
    assert.equal(await evaluate(`document.querySelector('.avatar-video-preview').naturalWidth > 0 && getComputedStyle(document.getElementById('app')).display !== 'none'`), true);
    await evaluate(`for(const view of ['goals','achievements','calendar','profile','finance','health','dashboard']) app.switchView(view)`);
    await evaluate(`document.getElementById('bodyScanVideo').src='assets/avatar/body_scan.mp4';document.getElementById('bodyScanPlay').click()`);
    await waitFor('!document.getElementById("bodyScanVideo").hidden && !document.getElementById("bodyScanVideo").paused');
    assert.equal(requests.some(url => /\.glb(?:\?|$)/.test(url)), false);
    assert.deepEqual(errors, []);
    console.log('PASS missing-video fallback, recovery, no GLB requests or JS exceptions');
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    clearTimeout(timeout);
    win?.destroy();
    server?.close();
    if (testData) fs.rmSync(testData, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
});
