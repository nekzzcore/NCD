const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8').split('// ===== Initialize =====')[0];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function fixture(t) {
    const errors = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', error => errors.push(error));
    virtualConsole.on('error', (...args) => errors.push(args));
    const dom = new JSDOM(html, {
        url: 'https://goal-accordion.invalid/', runScripts: 'outside-only',
        pretendToBeVisual: true, virtualConsole
    });
    t.after(() => { assert.deepEqual(errors, []); dom.window.close(); });
    const w = dom.window;
    w.eval(appSource + '\nwindow.GoalTracker = GoalTracker;');
    const app = Object.create(w.GoalTracker.prototype);
    Object.assign(app, {
        goals: [], achievements: [], events: [], notes: {}, settings: {},
        currentMonth: new Date(), currentView: 'goals',
        saved: 0, toasts: [],
        saveData() { this.saved++; w.localStorage.setItem('fixture-goals', JSON.stringify(this.goals)); return true; },
        showToast(message) { this.toasts.push(message); },
        onGoalChanged() {}
    });
    const d = w.document;
    w.NCDModalViews.mount('goalModal');
    app.bindEvents();
    return {
        app, w, d,
        row(id = 'parent') { return d.querySelector(`.goal-row[data-id="${id}"]`); },
        header(id = 'parent') { return this.row(id)?.querySelector('.goal-item'); },
        body(id = 'parent') { return this.row(id)?.querySelector('.goal-item-body'); },
        expand(id = 'parent') { this.header(id)?.click(); },
        render() { app.renderGoals(); },
        submit(title, description = '', priority = 'medium') {
            d.getElementById('goalTitle').value = title;
            d.getElementById('goalDescription').value = description;
            d.getElementById('goalPriority').value = priority;
            return app.saveGoal(new w.Event('submit', { bubbles: true, cancelable: true }));
        }
    };
}

const rhythmGoal = () => ({
    id: 'parent', title: 'Утренняя зарядка', category: 'health', priority: 'medium', status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    subgoals: [{ id: 'r', title: 'Ритм', kind: 'rhythm', period: 'week', checkins: [], completed: false }]
});

test('Collapsed goal rows are mobile cards: title, progress badge and chevron only', async t => {
    const h = fixture(t);
    h.app.goals.push(rhythmGoal());
    h.render();
    const row = h.row();
    assert.ok(row, 'every goal is wrapped in an accordion row');
    const header = h.header();
    assert.equal(header.getAttribute('role'), 'button');
    assert.equal(header.getAttribute('tabindex'), '0');
    assert.equal(header.getAttribute('aria-expanded'), 'false');
    assert.equal(header.getAttribute('aria-controls'), h.body().id);
    assert.equal(h.d.querySelector('.goal-row.is-open'), null);

    assert.equal(header.querySelector('.goal-title-text').textContent, 'Утренняя зарядка');
    const badge = header.querySelector('.goal-item-progress');
    assert.equal(badge.textContent, '0%');
    const chevron = header.querySelector('.goal-chevron svg path');
    assert.ok(chevron, 'disclosure chevron is rendered');
    assert.equal(header.querySelector('.goal-subgoal-summary span').textContent, '0/1');
    assert.ok(h.body().classList.contains('goal-item-body'));
});

test('Tapping a row opens a smooth accordion with the subgoals right underneath', async t => {
    const h = fixture(t);
    h.app.goals.push(rhythmGoal());
    h.render();

    h.expand();
    const row = h.row();
    assert.ok(row.classList.contains('is-open'));
    assert.equal(h.header().getAttribute('aria-expanded'), 'true');
    const body = h.body();
    assert.equal(body.style.maxHeight, '0px', 'starts collapsed before the transition');
    assert.equal(body.querySelector('.goal-item-body-meta .goal-body-steps').textContent, '0 из 1 подцелей · 0%');
    assert.ok(body.querySelector('.rhythm-grid.is-week'), 'rhythm week grid is inside the expanded block');
    assert.ok(body.querySelector('[data-open-goal-detail]'), 'the detail modal stays reachable');
    assert.ok(body.querySelector('[data-add-subgoal-inline]'));

    h.expand();
    assert.equal(h.row().classList.contains('is-open'), false);
    assert.equal(h.header().getAttribute('aria-expanded'), 'false');
    assert.equal(h.body().style.maxHeight, '0px');
});

test('Only one goal stays expanded at a time and the open row survives a re-render', async t => {
    const h = fixture(t);
    h.app.goals.push(rhythmGoal(), {
        id: 'second', title: 'Вторая цель', category: 'career', priority: 'low', status: 'active',
        createdAt: '2026-01-02T00:00:00.000Z',
        subgoals: [{ id: 'c', title: 'Шаг', completed: false }]
    });
    h.render();
    h.expand('parent');
    h.expand('second');
    assert.equal(h.row('parent').classList.contains('is-open'), false, 'accordion closes the previous row');
    assert.equal(h.row('second').classList.contains('is-open'), true);

    h.render();
    assert.equal(h.row('second').classList.contains('is-open'), true, 'expanded state survives redraws');
    assert.equal(h.header('second').getAttribute('aria-expanded'), 'true');
    assert.equal(h.row('parent').classList.contains('is-open'), false);
});

test('Tapping today lights the neon day immediately without opening any modal', async t => {
    const h = fixture(t);
    h.app._rhythmNow = h.w.Date ? new h.w.Date(2026, 10, 20, 10, 0, 0) : null;
    h.app.goals.push(rhythmGoal());
    h.render();
    h.expand();

    const cell = h.body().querySelector('.rhythm-cell.is-today');
    assert.ok(cell, 'today cell is rendered in the inline grid');
    const savedBefore = h.app.saved;
    cell.click();
    await tick();

    assert.equal(h.d.getElementById('goalDetailModal').classList.contains('active'), false, 'no modal appears');
    assert.deepEqual([...h.app.goals[0].subgoals[0].checkins], ['2026-11-20']);
    assert.equal(h.app.saved, savedBefore + 1, 'the check-in is persisted');
    assert.ok(h.row().classList.contains('is-open'), 'the row stays expanded');
    const after = h.body().querySelector('.rhythm-cell[data-date="2026-11-20"]');
    assert.ok(after.classList.contains('is-done'), 'the cell is lit right after the tap');
    assert.ok(after.classList.contains('is-today'));
    assert.equal(h.body().querySelector('.rhythm-status').textContent, 'День зачтён');

    after.click();
    await tick();
    assert.deepEqual([...h.app.goals[0].subgoals[0].checkins], []);
    assert.equal(h.d.getElementById('goalDetailModal').classList.contains('active'), false);
});

test('Balance rows expand into a bar and a large + Пополнить button that tops up inline', async t => {
    const h = fixture(t);
    h.app.goals.push({
        id: 'parent', title: 'Подушка', category: 'finance', priority: 'medium', status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        subgoals: [{ id: 'b', title: 'Баланс', kind: 'balance', targetAmount: 5000, currentAmount: 1000, completed: false }]
    });
    h.render();
    h.expand();

    const body = h.body();
    assert.ok(body.querySelector('.balance-progress'));
    assert.match(body.textContent, /1 000 \/ 5 000 ₽|1\s000\s\/\s5\s000\s₽/);
    const button = body.querySelector('.balance-topup');
    assert.equal(button.textContent, '+ Пополнить');
    const input = body.querySelector('.balance-input');
    input.value = '1500';
    button.click();
    await tick();

    assert.equal(h.d.getElementById('goalDetailModal').classList.contains('active'), false, 'no modal appears');
    assert.equal(h.app.goals[0].subgoals[0].currentAmount, 2500);
    assert.ok(h.row().classList.contains('is-open'));
    assert.match(h.body().querySelector('.balance-percent').textContent, /50%/);
    assert.equal(h.d.querySelector('.goal-item-progress').textContent, '50%');
});

test('Checkbox subgoals toggle inline and the detail modal stays an explicit action', async t => {
    const h = fixture(t);
    h.app.goals.push({
        id: 'parent', title: 'Чеклист', category: 'personal', priority: 'medium', status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        subgoals: [{ id: 'c', title: 'Шаг', completed: false }, { id: 'c2', title: 'Второй шаг', completed: false }]
    });
    h.render();
    h.expand();

    const checkbox = h.body().querySelector('.subgoal-checkbox');
    checkbox.checked = true;
    checkbox.dispatchEvent(new h.w.Event('change', { bubbles: true }));
    await tick();
    assert.equal(h.app.goals[0].subgoals[0].completed, true);
    assert.equal(h.d.getElementById('goalDetailModal').classList.contains('active'), false);
    assert.ok(h.row().classList.contains('is-open'));
    assert.equal(h.d.querySelector('.goal-item-progress').textContent, '50%');

    h.body().querySelector('[data-open-goal-detail]').click();
    assert.ok(h.d.getElementById('goalDetailModal').classList.contains('active'));
    assert.equal(h.d.getElementById('goalDetailContent').dataset.goalId, 'parent');
});

test('Mobile card CSS, accordion motion and finger-sized rhythm cells are declared', () => {
    const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
    const idx = css.indexOf('Mobile-first goal cards');
    assert.ok(idx > 0, 'accordion CSS section exists');
    const section = css.slice(idx);
    const mobile = section.match(/@media \(max-width:768px\) \{([\s\S]*?)\n\}\n\n@media \(prefers-reduced-motion/);
    assert.ok(mobile, 'mobile card block exists');
    assert.match(mobile[1], /\.goal-item \{[\s\S]*?display:flex!important/);
    assert.match(mobile[1], /min-height:56px; max-height:64px/);
    assert.match(mobile[1], /\.goal-table-head, html\[data-theme\] \.goal-table-head \{ display:none!important; \}/);
    assert.match(mobile[1], /\.goal-item-progress \{[\s\S]*?display:inline-flex!important/);

    assert.match(css, /\.goal-item-body \{[^}]*max-height:0; overflow:hidden; opacity:0;[^}]*transition:max-height/);
    assert.match(css, /\.goal-row\.is-open \.goal-item-body \{[\s\S]*?transition:max-height/);
    assert.match(css, /grid-template-columns:20px minmax\(80px,1fr\) 56px 80px 70px 18px;/, 'desktop keeps the table columns plus chevron');

    const week = css.match(/\.goal-item-body \.rhythm-grid\.is-week \{([^}]*)\}/);
    assert.ok(week);
    assert.match(week[1], /max-width:330px/);
    assert.match(css, /\.goal-item-body \.rhythm-grid\.is-week \.rhythm-cell \{ min-height:40px; \}/);
    const month = css.match(/\.goal-item-body \.rhythm-grid\.is-month \{([^}]*)\}/);
    assert.ok(month);
    assert.match(month[1], /max-width:274px/);
    assert.match(css, /\.goal-item-body \.rhythm-grid\.is-month \.rhythm-cell::after \{[^}]*inset:-3px/, '34px cells get a 40px touch target');
    assert.match(css, /\.goal-item-body \.balance-topup \{[^}]*min-height:48px/);
    assert.match(css, /background:#8B5CF6!important/, 'checked day burns neon #8B5CF6');
});
