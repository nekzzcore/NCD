const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../finance.js'), 'utf8');

function harness(t, reduced = false) {
    const dom = new JSDOM('<main id="financeMain"></main>', {
        url: 'https://preview.invalid/', runScripts: 'outside-only', pretendToBeVisual: true
    });
    t.after(() => dom.window.close());
    const w = dom.window;
    const timers = new Map();
    let clock = 0, sequence = 0, observer;
    w.setTimeout = (fn, delay) => { const id = ++sequence; timers.set(id, { fn, at: clock + delay }); return id; };
    w.clearTimeout = id => timers.delete(id);
    w.matchMedia = () => ({ matches: reduced, addEventListener() {} });
    w.IntersectionObserver = class {
        constructor(fn) { this.fn = fn; observer = this; }
        observe() { this.fn([{ isIntersecting: true }]); }
        disconnect() {}
    };
    w.eval(source);
    w.renderFinanceView();
    w.document.querySelector('[data-finance-step="safety"]').click();
    return {
        w, timers,
        data: () => JSON.parse(w.localStorage.getItem('goalTracker_finance')),
        stage: () => w.document.querySelector('.custodian-stage'),
        click: amount => w.document.querySelector(`[data-piggy-quick="${amount}"]`).click(),
        offscreen: value => observer.fn([{ isIntersecting: !value }]),
        advance(ms) {
            const end = clock + ms;
            while (true) {
                const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
                if (!next || next[1].at > end) break;
                timers.delete(next[0]); clock = next[1].at; next[1].fn();
            }
            clock = end;
        }
    };
}

test('Savings uses numeric indicators and preserves quick deposit accounting without animation', t => {
    const h = harness(t);
    assert.equal(h.stage(), null);
    assert.deepEqual([...h.w.document.querySelectorAll('[data-piggy-quick]')].map(e => e.dataset.piggyQuick), ['500', '1000', '2000', '5000']);
    h.click(500); h.click(1000); h.click(2000); h.click(5000);
    assert.equal(h.data().safetyFund.balance, 8500);
    assert.equal(h.data().safetyFund.history.length, 4);
    assert.equal(h.timers.size, 0);
    assert.match(h.w.document.querySelector('[data-safety-balance]').textContent, /8.*500/);
    h.w.renderFinanceView();
    assert.equal(h.stage(), null);
    assert.equal(h.data().safetyFund.balance, 8500);
});

test('Manual positive decimal deposit works; invalid amounts do not alter savings', t => {
    const h = harness(t);
    h.w.document.querySelector('[data-piggy-toggle]').click();
    const form = h.w.document.querySelector('[data-finance-form="deposit"]');
    const input = form.querySelector('[name="amount"]');
    input.value = '123.45';
    form.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(h.data().safetyFund.balance, 123.45);
    assert.ok(form.classList.contains('is-collapsed'));
    for (const value of ['0', '-5', '']) {
        input.value = value;
        form.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
    }
    assert.equal(h.data().safetyFund.balance, 123.45);
    assert.equal(h.data().safetyFund.history.length, 1);
});

