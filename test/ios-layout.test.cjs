const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(require('node:path').join(__dirname, '../ios-layout.js'), 'utf8');
test('iOS keyboard viewport resizes dialogs and restores navigation when dismissed', async t => {
    const dom = new JSDOM('<input>', { runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    const w = dom.window;
    w.Capacitor = { getPlatform: () => 'ios' };
    const viewport = new w.EventTarget();
    Object.assign(viewport, { height: 852, offsetTop: 0, scale: 1 });
    Object.defineProperty(w, 'visualViewport', { value: viewport });
    w.innerHeight = 852;
    let revealed = false;
    const input = w.document.querySelector('input');
    input.scrollIntoView = () => { revealed = true; };
    w.eval(source);
    const root = w.document.documentElement;
    assert.equal(root.classList.contains('native-ios'), true);
    input.focus();
    viewport.height = 500;
    viewport.dispatchEvent(new w.Event('resize'));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(root.classList.contains('ios-keyboard-open'), true);
    assert.equal(root.style.getPropertyValue('--ios-visible-height'), '500px');
    assert.equal(revealed, true);
    viewport.height = 852;
    viewport.dispatchEvent(new w.Event('resize'));
    assert.equal(root.classList.contains('ios-keyboard-open'), false);
});
test('iOS layout handler leaves Android and web untouched', t => {
    for (const platform of ['android', 'web']) {
        const dom = new JSDOM('', { runScripts: 'outside-only' });
        t.after(() => dom.window.close());
        dom.window.Capacitor = { getPlatform: () => platform };
        dom.window.eval(source);
        assert.equal(dom.window.document.documentElement.className, '');
    }
});

for (const ua of ['iPhone', 'iPad']) {
    test(`${ua} browser enables safe-area and keyboard handling without Capacitor`, t => {
        const dom = new JSDOM('', { runScripts: 'outside-only' });
        t.after(() => dom.window.close());
        Object.defineProperty(dom.window.navigator, 'userAgent', { value: ua });
        dom.window.eval(source);
        assert.equal(dom.window.document.documentElement.classList.contains('ios-layout'), true);
        assert.equal(dom.window.document.documentElement.classList.contains('native-ios'), false);
    });
}
