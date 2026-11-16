const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');

test('Shared form views mount on demand, save their data, unmount, and keep working after reopening', async t => {
    const dom = new JSDOM(fs.readFileSync(path.join(root, 'www/index.html'), 'utf8'), { url: 'https://ncd.invalid/subfolder/', runScripts: 'outside-only', pretendToBeVisual: true });
    t.after(() => dom.window.close());
    const w = dom.window, d = w.document;
    w.matchMedia = () => ({ matches: true, addEventListener() {} });
    w.eval(fs.readFileSync(path.join(root, 'www/app.js'), 'utf8').split('// ===== Initialize =====')[0] + ';window.GoalTracker=GoalTracker;');
    const app = Object.create(w.GoalTracker.prototype);
    let saves = 0;
    Object.assign(app, { goals: [], achievements: [], notes: {}, events: [], settings: {}, currentMonth: new Date(), selectedDate: '2026-11-05',
        saveData() { saves++; return true; }, render() {}, renderCalendar() {}, showToast() {}, onNewGoal() {}, onGoalChanged() {}, onAchievementCreated() {}, onNoteChanged() {} });
    app.bindEvents();
    const ids = ['goalModal', 'achievementModal', 'noteModal'];
    for (const id of ids) assert.equal(d.getElementById(id), null);
    d.getElementById('addGoalBtn').click();
    d.getElementById('goalTitle').value = 'Shared Android/PWA goal';
    assert.equal(await app.saveGoal(new w.Event('submit', { cancelable: true })), true);
    assert.equal(app.goals[0].title, 'Shared Android/PWA goal');
    assert.equal(d.getElementById('goalModal'), null);
    for (let i = 0; i < 2; i++) {
        d.getElementById('addAchievementBtn').click();
        d.getElementById('achievementTitle').value = `Achievement ${i}`;
        d.getElementById('achievementForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
        assert.equal(d.getElementById('achievementModal'), null);
    }
    assert.equal(app.achievements.length, 2, 'handlers remain bound once after remount');
    d.getElementById('addCalendarNoteBtn').click();
    d.getElementById('noteContent').value = 'Saved note';
    d.getElementById('noteForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
    assert.equal(app.notes['2026-11-05'][0].content, 'Saved note');
    assert.equal(d.getElementById('noteModal'), null);
    d.getElementById('addGoalBtn').click();
    d.getElementById('closeGoalModal').click();
    assert.equal(d.getElementById('goalModal'), null);
    assert.equal(saves, 4);
    // Service worker must stay within the deployment subfolder.
    let registration;
    Object.defineProperty(w.navigator, 'serviceWorker', { value: { register(url, options) { registration = { url, options }; return Promise.resolve(); } } });
    app.initPWA();
    assert.equal(registration.url, 'https://ncd.invalid/subfolder/sw.js');
    assert.equal(registration.options.scope, 'https://ncd.invalid/subfolder/');
});
