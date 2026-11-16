const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(require('node:path').join(__dirname, '../ui-select.js'), 'utf8');
function fixture(t, modern = false) {
    const dom = new JSDOM('<label for="days">Дедлайн</label><select id="days"><option value="1">За 1 день</option><option value="3" selected>За 3 дня</option><option value="7">За 7 дней</option><option disabled>Недоступно</option></select><button>Outside</button>', { runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    const w = dom.window, d = w.document, select = d.querySelector('select');
    select.getClientRects = () => [{ width: 180 }];
    w.CSS = { supports: () => modern }; w.eval(source);
    return { w, d, select, key: key => select.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) };
}
test('Fallback selects dispatch native change events and close after choosing', t => {
    const { select, d } = fixture(t); let changes = 0;
    select.addEventListener('change', () => changes++);
    select.click();
    assert.equal(d.querySelectorAll('[role="option"]').length, 4);
    assert.equal(select.getAttribute('aria-expanded'), 'true');
    d.querySelectorAll('[role="option"]')[2].click();
    assert.equal(select.value, '7'); assert.equal(changes, 1);
    assert.equal(d.querySelector('[role="listbox"]'), null);
    assert.equal(select.hasAttribute('aria-expanded'), false);
});
test('Fallback keyboard supports arrows, Home, End, confirmation and cancellation', t => {
    const { select, key, d } = fixture(t);
    key(' '); key('ArrowDown'); key('Enter'); assert.equal(select.value, '7');
    key(' '); key('Home'); key('Escape'); assert.equal(select.value, '7');
    assert.equal(d.querySelector('[role="listbox"]'), null);
    key(' '); key('Home'); key('Enter'); assert.equal(select.value, '1');
    key(' '); key('End'); key('Enter'); assert.equal(select.value, '7');
});
test('Disabled and dynamically inserted select controls behave correctly', async t => {
    const { select, d } = fixture(t);
    select.disabled = true; select.click(); assert.equal(d.querySelector('[role="listbox"]'), null);
    const dynamic = select.cloneNode(true); dynamic.disabled = false; dynamic.getClientRects = () => [{ width: 180 }]; d.body.append(dynamic);
    dynamic.click(); assert.ok(d.querySelector('[role="listbox"]'));
    d.querySelectorAll('[role="option"]')[3].click(); assert.equal(dynamic.value, '3');
    dynamic.remove(); await Promise.resolve(); assert.equal(d.querySelector('[role="listbox"]'), null);
});
test('Modern browsers keep their customizable native select behavior', t => {
    const { select, d, key } = fixture(t, true);
    select.click(); key(' '); assert.equal(d.querySelector('[role="listbox"]'), null);
});
