const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

function setup(t) {
    const dom = new JSDOM(fs.readFileSync('index.html', 'utf8'), { runScripts:'outside-only' });
    t.after(() => dom.window.close());
    const w = dom.window;
    let now = 0, next = 0;
    const timers = new Map();
    Object.defineProperty(w.performance, 'now', { value:() => now });
    w.setTimeout = (callback, delay) => { const id = ++next; timers.set(id, { callback, at:now+delay }); return id; };
    w.clearTimeout = id => timers.delete(id);
    w.eval(w.document.getElementById('native-splash-timer').textContent);
    w.eval(fs.readFileSync('app.js','utf8').split('// ===== Initialize =====')[0]+'\nwindow.GoalTracker = GoalTracker;');
    const app = Object.create(w.GoalTracker.prototype);
    app.showSplashScreen();
    const advance = ms => {
        const end = now+ms;
        while (true) {
            const entry = [...timers].filter(([,v]) => v.at <= end).sort((a,b) => a[1].at-b[1].at)[0];
            if (!entry) break;
            now = entry[1].at; timers.delete(entry[0]); entry[1].callback();
        }
        now = end;
    };
    return { app, splash:w.document.getElementById('native-splash'), advance, timers };
}

test('hard timer rejects early auth dismissal, holds 4000ms, then fades for 800ms', t => {
    const {app,splash,advance,timers} = setup(t);
    app.hideSplashScreen(); advance(1000); app.hideSplashScreen();
    assert.equal(timers.size,1);
    advance(2999); assert.equal(splash.style.display,'flex'); assert.equal(splash.style.opacity,'');
    advance(1); assert.equal(splash.style.opacity,'0');
    advance(799); assert.equal(splash.style.display,'flex');
    advance(1); assert.equal(splash.style.display,'none'); assert.equal(splash.style.display,'none');
});

test('startup timer runs without any network or session callback', t => {
    const {splash,advance} = setup(t);
    advance(3999); assert.equal(splash.style.opacity,'');
    advance(1); assert.equal(splash.style.opacity,'0');
    advance(800); assert.equal(splash.style.display,'none');
});

test('repeated account loading and ready calls cannot shorten or restart the timer/fade', t => {
    const {app,splash,advance} = setup(t);
    advance(1000); app.showAccountLoading(); app.hideSplashScreen(); app.showSplashScreen();
    advance(2999); assert.equal(splash.style.opacity,'');
    advance(1); assert.equal(splash.style.opacity,'0');
    app.showAccountLoading(); app.hideSplashScreen(); advance(800);
    assert.equal(splash.style.display,'none');
});

test('sync error handler delegates to the guarded splash API', () => {
    const sync = fs.readFileSync('sync.js','utf8');
    assert.doesNotMatch(sync, /getElementById\(['"]appSplash['"]\)/);
    assert.match(sync, /app\.hideSplashScreen\?\.\(\)/);
});


test('splash is first body element and animates without scripts or external assets', () => {
    const dom = new JSDOM(fs.readFileSync('index.html', 'utf8'));
    const splash = dom.window.document.body.firstElementChild;
    assert.equal(splash.id, 'native-splash');
    assert.equal(splash.style.background, 'var(--bg-primary)');
    assert.ok(splash.querySelector('.splash-star-logo svg path'));
    assert.equal(splash.querySelector('use, img'), null);
    assert.match(splash.textContent, /NOTE CARPE DIEM/);
    assert.match(dom.window.document.head.querySelector('style').textContent, /@keyframes nativeSplashPulse/);
    dom.window.close();
});
