const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');

for (const directory of ['.', 'www']) {
    test(`${directory}: inactive dialogs stay hidden without external CSS and buttons open only their dialog`, t => {
        const dom = new JSDOM(fs.readFileSync(path.join(root, directory, 'index.html'), 'utf8'), { url: 'https://ncd.invalid/', runScripts: 'outside-only', pretendToBeVisual: true });
        const w = dom.window, d = w.document;
        t.after(() => w.close());
        w.matchMedia = () => ({ matches: true, addEventListener() {} });
        w.eval(fs.readFileSync(path.join(root, 'app.js'), 'utf8').split('// ===== Initialize =====')[0] + ';window.GoalTracker=GoalTracker;');
        const app = Object.create(w.GoalTracker.prototype);
        Object.assign(app, { goals: [], achievements: [], events: [], notes: {}, settings: {}, selectedDate: '2026-11-05', currentMonth: new Date(), saveData() {} });
        app.bindEvents();
        const ids = ['goalModal', 'achievementModal', 'noteModal'];
        for (const id of ids) assert.equal(d.getElementById(id), null);
        for (const [button, id] of [['addGoalBtn', 'goalModal'], ['addAchievementBtn', 'achievementModal'], ['addCalendarNoteBtn', 'noteModal']]) {
            d.getElementById(button).click();
            assert.ok(d.getElementById(id).classList.contains('active'), id);
            assert.notEqual(w.getComputedStyle(d.getElementById(id)).display, 'none');
            for (const other of ids.filter(name => name !== id)) assert.equal(d.getElementById(other), null);
            app.closeModal(id);
            assert.equal(d.getElementById(id), null);
        }
    });
}

test('Compiled CSS is local, parseable, versioned, and included in the offline shell', { skip: !fs.existsSync(path.join(root, 'www/styles.css')) }, t => {
    const css = fs.readFileSync(path.join(root, 'www/styles.css'), 'utf8');
    require('css-tree').parse(css);
    assert.doesNotMatch(css, /@import\s/);
    assert.match(css, /--bg-primary:#020617/);
    assert.match(css, /\.modal\{display:none/);
    const hash = createHash('sha256').update(css).digest('hex').slice(0, 12);
    const dom = new JSDOM(fs.readFileSync(path.join(root, 'www/index.html'), 'utf8'));
    t.after(() => dom.window.close());
    const href = dom.window.document.getElementById('ncd-main-styles').getAttribute('href');
    assert.equal(href, `./styles.css?v=${hash}`);
    assert.ok(fs.readFileSync(path.join(root, 'www/sw.js'), 'utf8').includes(`'${href}'`));
    assert.equal(fs.readFileSync(path.join(root, 'www/app.js'), 'utf8'), fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
});
