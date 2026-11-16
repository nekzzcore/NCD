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
        url: 'https://subgoal-types.invalid/', runScripts: 'outside-only',
        pretendToBeVisual: true, virtualConsole
    });
    t.after(() => { assert.deepEqual(errors, []); dom.window.close(); });
    const w = dom.window;
    w.eval(appSource + '\nwindow.GoalTracker = GoalTracker;');
    const app = Object.create(w.GoalTracker.prototype);
    Object.assign(app, {
        goals: [], achievements: [], events: [], notes: {}, settings: {},
        currentMonth: new Date(), currentView: 'dashboard',
        saved: 0, newGoals: 0, changed: [], toasts: [],
        saveData() {
            this.saved++;
            w.localStorage.setItem('fixture-goals', JSON.stringify(this.goals));
            return true;
        },
        onNewGoal() { this.newGoals++; },
        onGoalChanged(goal) { this.changed.push(goal); },
        onSubgoalComplete() { this.subgoalRewards = (this.subgoalRewards || 0) + 1; },
        showToast(message, type) { this.toasts.push({ message, type }); }
    });
    const d = w.document;
    w.NCDModalViews.mount('goalModal');
    d.getElementById('goalForm').addEventListener('submit', event => app.saveGoal(event));
    const h = {
        app, w, d,
        submit(title = 'Подцель', description = '', priority = 'medium') {
            d.getElementById('goalTitle').value = title;
            d.getElementById('goalDescription').value = description;
            d.getElementById('goalPriority').value = priority;
            return app.saveGoal(new w.Event('submit', { bubbles: true, cancelable: true }));
        },
        addParent(id = 'parent') {
            app.goals.push({ id, title: 'Родитель', category: 'career', priority: 'medium', status: 'active', subgoals: [] });
            app.openGoalDetail(id);
            d.getElementById('addSubgoalBtn').click();
            return app.goals.find(goal => goal.id === id);
        },
        chooseKind(kind) {
            d.querySelector(`[data-subgoal-kind="${kind}"]`).click();
        },
        choosePeriod(period) {
            d.querySelector(`[data-subgoal-period="${period}"]`).click();
        },
        date(...args) { return new w.Date(...args); },
        child(parent = app.goals[0]) { return parent.subgoals[0]; }
    };
    return h;
}

test('Add-subgoal form offers checkbox, rhythm and balance types and reveals only matching fields', async t => {
    const h = fixture(t);
    assert.equal(h.d.getElementById('subgoalKindGroup').hidden, true, 'root goal form hides subgoal types');
    h.addParent();
    const group = h.d.getElementById('subgoalKindGroup');
    assert.equal(group.hidden, false);
    assert.deepEqual([...group.querySelectorAll('[data-subgoal-kind]')].map(button => button.querySelector('span').textContent),
        ['Чекбокс', 'Ритм', 'Баланс / Сумма']);
    assert.equal(h.d.getElementById('goalSubgoalKind').value, 'checkbox');
    assert.equal(h.d.getElementById('subgoalRhythmFields').hidden, true);
    assert.equal(h.d.getElementById('subgoalBalanceFields'), null);

    h.chooseKind('rhythm');
    assert.equal(h.d.getElementById('goalSubgoalKind').value, 'rhythm');
    assert.equal(h.d.getElementById('subgoalRhythmFields').hidden, false);
    assert.equal(h.d.querySelector('[data-subgoal-kind="rhythm"]').getAttribute('aria-checked'), 'true');
    assert.equal(h.d.querySelector('[data-subgoal-kind="checkbox"]').getAttribute('aria-checked'), 'false');
    assert.equal(h.d.getElementById('goalSubgoalPeriod').value, 'week');
    h.choosePeriod('month');
    assert.equal(h.d.getElementById('goalSubgoalPeriod').value, 'month');
    assert.equal(h.d.querySelector('[data-subgoal-period="month"]').getAttribute('aria-checked'), 'true');

    h.chooseKind('balance');
    assert.equal(h.d.getElementById('subgoalRhythmFields').hidden, true);
    const target = h.d.getElementById('goalTargetAmount');
    assert.ok(target, 'balance target input is created');
    assert.equal(target.value, '10000');
    assert.equal(h.d.getElementById('subgoalBalanceFields').hidden, false);

    h.chooseKind('checkbox');
    assert.equal(h.d.getElementById('subgoalBalanceFields').hidden, true);
    assert.equal(h.d.getElementById('goalSubgoalKind').value, 'checkbox');
});

test('Saving a rhythm subgoal persists its kind, period and check-ins without a round emoji avatar', async t => {
    const h = fixture(t);
    h.app._rhythmNow = h.date(2026, 10, 20, 10, 0, 0);
    h.addParent();
    h.chooseKind('rhythm');
    h.choosePeriod('week');
    assert.equal(await h.submit('Зарядка', 'Каждое утро'), true);
    const child = h.child();
    assert.equal(child.kind, 'rhythm');
    assert.equal(child.period, 'week');
    assert.deepEqual([...child.checkins], []);
    assert.equal(child.parentId, 'parent');
    assert.equal(child.completed, false);
    const stored = JSON.parse(h.w.localStorage.getItem('fixture-goals'))[0].subgoals[0];
    assert.equal(stored.kind, 'rhythm');
    assert.equal(stored.period, 'week');
    assert.deepEqual(stored.checkins, []);

    h.app.openGoalDetail('parent');
    const markup = h.d.getElementById('goalDetailContent').innerHTML;
    assert.match(markup, /subgoal-rhythm/);
    assert.match(markup, /rhythm-grid is-week/);
    assert.match(markup, /0\/7<\/strong> дней выполнено/);
    assert.doesNotMatch(markup, /[\u{1F300}-\u{1FAFF}]/u, 'rhythm UI contains no emoji');
    assert.equal(h.d.querySelectorAll('.rhythm-grid.is-week .rhythm-cell:not(.is-empty)').length, 7);
});

test('Month rhythm renders a Monday-first calendar grid with leading blanks', async t => {
    const h = fixture(t);
    h.app._rhythmNow = h.date(2026, 10, 20, 10, 0, 0); // November 2026 starts on Sunday.
    h.app.goals.push({
        id: 'parent', title: 'Родитель', category: 'career', priority: 'medium', status: 'active',
        subgoals: [{ id: 'r', title: 'Ритм', kind: 'rhythm', period: 'month', checkins: [], completed: false }]
    });
    h.app.openGoalDetail('parent');
    const content = h.d.getElementById('goalDetailContent');
    assert.equal(content.querySelectorAll('.rhythm-weekdays span').length, 7);
    assert.deepEqual([...content.querySelectorAll('.rhythm-weekdays span')].map(item => item.textContent),
        ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']);
    assert.equal(content.querySelectorAll('.rhythm-grid.is-month .rhythm-cell.is-empty').length, 6);
    assert.equal(content.querySelectorAll('.rhythm-grid.is-month .rhythm-cell:not(.is-empty)').length, 30);
    assert.match(content.textContent, /0\/30 дней выполнено/);
    assert.match(content.textContent, /Месяц · Ноябрь 2026 г\./);
});

test('Rhythm day boundary is 06:00: asleep before dawn, waiting at 06:00, done after check-in', async t => {
    const h = fixture(t);
    const step = { id: 'r', title: 'Ритм', kind: 'rhythm', period: 'week', checkins: [], completed: false };
    h.app.goals.push({ id: 'parent', title: 'Родитель', category: 'career', priority: 'medium', status: 'active', subgoals: [step] });

    h.app._rhythmNow = h.date(2026, 10, 20, 5, 59, 0);
    let stats = h.app.getRhythmStats(step);
    assert.equal(stats.beforeSix, true);
    assert.equal(stats.today, '2026-11-19');
    assert.deepEqual({ ...stats.status }, { state: 'asleep', label: 'Отдых до 06:00' });
    assert.equal(h.app.getRhythmClock().today, '2026-11-19');
    h.app.openGoalDetail('parent');
    assert.ok(h.d.querySelector('.rhythm-cell.is-today.is-asleep'));
    assert.equal(h.d.querySelector('.rhythm-cell.is-today').disabled, false);
    assert.equal(h.d.querySelector('.rhythm-status').textContent, 'Отдых до 06:00');

    h.app._rhythmNow = h.date(2026, 10, 20, 6, 0, 0);
    stats = h.app.getRhythmStats(step);
    assert.equal(stats.beforeSix, false);
    assert.equal(stats.today, '2026-11-20');
    assert.deepEqual({ ...stats.status }, { state: 'waiting', label: 'Ждёт отметки' });
    h.app._goalActionPending = true;
    assert.equal(await h.app.toggleRhythmDay('parent', 'r'), false, 'actions stay locked while another save runs');
    h.app._goalActionPending = false;

    const first = h.app.toggleRhythmDay('parent', 'r');
    const second = h.app.toggleRhythmDay('parent', 'r');
    assert.equal(await second, false, 'a second tap is ignored while saving');
    assert.equal(await first, true);
    assert.deepEqual([...h.child().checkins], ['2026-11-20']);
    assert.equal(h.app.getRhythmStats(h.child()).status.state, 'done');
    h.app.openGoalDetail('parent');
    assert.equal(h.d.querySelector('.rhythm-status').textContent, 'День зачтён');
    assert.ok(h.d.querySelector('.rhythm-cell.is-today.is-done'));
    assert.match(h.d.querySelector('.rhythm-mark-btn').textContent, /День зачтён/);

    assert.equal(await h.app.toggleRhythmDay('parent', 'r'), true);
    assert.deepEqual([...h.child().checkins], []);
    assert.equal(h.app.getRhythmStats(h.child()).status.state, 'waiting');
});

test('Only today can be checked; missed days stay dark slots and are never deleted', async t => {
    const h = fixture(t);
    h.app._rhythmNow = h.date(2026, 10, 20, 10, 0, 0); // Friday
    const step = { id: 'r', title: 'Ритм', kind: 'rhythm', period: 'week', checkins: ['2026-11-16'], completed: false };
    h.app.goals.push({ id: 'parent', title: 'Родитель', category: 'career', priority: 'medium', status: 'active', subgoals: [step] });
    h.app.openGoalDetail('parent');

    const missed = [...h.d.querySelectorAll('.rhythm-grid.is-week .rhythm-cell.is-missed')];
    assert.deepEqual(missed.map(cell => cell.dataset.date), ['2026-11-17', '2026-11-18', '2026-11-19']);
    assert.equal(h.d.querySelectorAll('.rhythm-grid.is-week .rhythm-cell.is-done').length, 1);
    assert.equal(h.d.querySelector('.rhythm-cell.is-missed').disabled, true, 'missed day is not clickable');
    assert.equal(await h.app.toggleRhythmDay('parent', 'r', '2026-11-19'), false, 'cannot backfill a missed day');
    assert.deepEqual([...h.child().checkins], ['2026-11-16']);
    assert.match(h.d.querySelector('.rhythm-score').textContent, /1\/7/);
    assert.match(h.d.querySelector('.rhythm-score').textContent, /дней выполнено/);

    await h.app.toggleRhythmDay('parent', 'r');
    assert.deepEqual([...h.child().checkins], ['2026-11-16', '2026-11-20'], 'old check-in is preserved');
    assert.equal(h.app.getRhythmStats(h.child()).streak, 1);
});

test('Rhythm reports an honest completed/total score and feeds weighted goal progress', async t => {
    const h = fixture(t);
    h.app._rhythmNow = h.date(2026, 10, 20, 10, 0, 0);
    const goal = {
        id: 'parent', title: 'Родитель', category: 'career', priority: 'medium', status: 'active',
        subgoals: [
            { id: 'r', title: 'Ритм', kind: 'rhythm', period: 'week', checkins: ['2026-11-17', '2026-11-18', '2026-11-19'] },
            { id: 'c', title: 'Шаг', completed: true },
            { id: 'b', title: 'Баланс', kind: 'balance', targetAmount: 10000, currentAmount: 5000 }
        ]
    };
    h.app.goals.push(goal);
    const stats = h.app.getRhythmStats(goal.subgoals[0]);
    assert.equal(stats.total, 7);
    assert.equal(stats.completed, 3);
    assert.equal(stats.percent, 43);
    assert.equal(stats.streak, 3);
    const steps = h.app.getSubgoalProgress(goal);
    assert.equal(steps.total, 3);
    assert.equal(steps.completed, 1, 'only fully satisfied subgoals count as completed');
    assert.equal(steps.percent, 64, '(3/7 + 1 + 0.5) / 3 = 64%');
    assert.equal(h.app.calculateProgress(goal), 64);

    h.app.goals.push({
        id: 'month', title: 'Месяц', category: 'career', priority: 'medium', status: 'active',
        subgoals: [{ id: 'm', title: 'Месяц', kind: 'rhythm', period: 'month', checkins: ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'] }]
    });
    const monthStats = h.app.getRhythmStats(h.app.goals[1].subgoals[0]);
    assert.equal(monthStats.completed, 5);
    assert.equal(monthStats.total, 30);
    assert.equal(h.app.calculateProgress(h.app.goals[1]), 17, '5/30 rounded honestly');
});

test('Goal card shows Ждёт отметки after 06:00 and День зачтён after a check-in, staying quiet asleep', async t => {
    const h = fixture(t);
    const goal = { id: 'parent', title: 'Родитель', category: 'career', priority: 'medium', status: 'active',
        subgoals: [{ id: 'r', title: 'Ритм', kind: 'rhythm', period: 'week', checkins: [], completed: false }] };
    h.app.goals.push(goal);

    h.app._rhythmNow = h.date(2026, 10, 20, 5, 0, 0);
    assert.doesNotMatch(h.app.renderGoalItem(goal), /goal-rhythm-chip/, 'no distracting chip before 06:00');

    h.app._rhythmNow = h.date(2026, 10, 20, 9, 0, 0);
    assert.match(h.app.renderGoalItem(goal), /goal-rhythm-chip is-waiting">Ждёт отметки/);

    goal.subgoals[0].checkins = ['2026-11-20'];
    assert.match(h.app.renderGoalItem(goal), /goal-rhythm-chip is-done">День зачтён/);
    assert.equal(h.app.getGoalRhythmStatus(goal).state, 'done');
});

test('Balance subgoal saves a target, rejects empty input and tops up with an honest capped percent', async t => {
    const h = fixture(t);
    h.addParent();
    h.chooseKind('balance');
    h.d.getElementById('goalTargetAmount').value = '10000';
    assert.equal(await h.submit('Подушка', '', 'high'), true);
    let child = h.child();
    assert.equal(child.kind, 'balance');
    assert.equal(child.targetAmount, 10000);
    assert.equal(child.currentAmount, 0);
    assert.equal(child.priority, 'high');

    h.app.openGoalDetail('parent');
    let content = h.d.getElementById('goalDetailContent');
    assert.match(content.textContent, /0 \/ 10\s000 ₽/);
    assert.equal(content.querySelector('.balance-progress').getAttribute('aria-valuenow'), '0');

    assert.equal(await h.app.topUpBalance('parent', child.id, ''), false);
    assert.equal(await h.app.topUpBalance('parent', child.id, '-500'), false);
    assert.equal(await h.app.topUpBalance('parent', child.id, 'abc'), false);
    assert.equal(h.app.goals[0].subgoals[0].currentAmount, 0);
    assert.equal(h.app.toasts.at(-1).message, 'Введите сумму больше нуля');

    assert.equal(await h.app.topUpBalance('parent', child.id, '2 500'), true);
    child = h.child();
    assert.equal(child.currentAmount, 2500);
    assert.equal(child.completed, false);
    assert.equal(h.app.getBalanceStats(child).percent, 25);
    assert.equal(h.app.calculateProgress(h.app.goals[0]), 25);

    h.app.openGoalDetail('parent');
    content = h.d.getElementById('goalDetailContent');
    assert.match(content.textContent, /2\s500\s\/\s10\s000\s₽/);
    assert.equal(content.querySelector('.balance-progress').getAttribute('aria-valuenow'), '25');

    assert.equal(await h.app.topUpBalance('parent', child.id, '8000'), true);
    child = h.child();
    assert.equal(child.currentAmount, 10500);
    assert.equal(child.completed, true);
    assert.equal(h.app.getBalanceStats(child).percent, 100);
    assert.equal(h.app.getBalanceStats(child).reached, true);
    assert.equal(h.app.calculateProgress(h.app.goals[0]), 100);
    assert.equal(h.app.subgoalRewards, 1, 'reward fires when the target is reached');

    assert.equal(await h.app.topUpBalance('parent', child.id, '500'), true);
    assert.equal(h.child().currentAmount, 11000);
    assert.equal(h.app.getBalanceStats(h.child()).percent, 100, 'percent never exceeds 100');
});

test('Top-up and rhythm buttons in the open detail persist through the rendered controls', async t => {
    const h = fixture(t);
    h.app._rhythmNow = h.date(2026, 10, 20, 10, 0, 0);
    h.app.goals.push({
        id: 'parent', title: 'Родитель', category: 'career', priority: 'medium', status: 'active',
        subgoals: [
            { id: 'r', title: 'Ритм', kind: 'rhythm', period: 'week', checkins: [] },
            { id: 'b', title: 'Баланс', kind: 'balance', targetAmount: 5000, currentAmount: 1000 }
        ]
    });
    h.app.openGoalDetail('parent');
    const savedBefore = h.app.saved;

    h.d.querySelector('.rhythm-cell.is-today').click();
    await tick();
    assert.deepEqual([...h.app.goals[0].subgoals[0].checkins], ['2026-11-20']);
    assert.equal(h.app.saved, savedBefore + 1);

    const input = h.d.querySelector('.balance-input[data-sid="b"]');
    input.value = '1500';
    h.d.querySelector('.balance-topup[data-sid="b"]').click();
    await tick();
    assert.equal(h.app.goals[0].subgoals[1].currentAmount, 2500);
    assert.match(h.d.getElementById('goalDetailContent').textContent, /2\s500\s\/\s5\s000\s₽/);
});

test('Editing a rhythm subgoal keeps its check-ins and can switch the period; balance keeps current amount', async t => {
    const h = fixture(t);
    h.app._rhythmNow = h.date(2026, 10, 20, 10, 0, 0);
    h.app.goals.push({
        id: 'parent', title: 'Родитель', category: 'career', priority: 'medium', status: 'active',
        subgoals: [
            { id: 'r', title: 'Ритм', kind: 'rhythm', period: 'week', checkins: ['2026-11-16', '2026-11-17'], completed: false },
            { id: 'b', title: 'Баланс', kind: 'balance', targetAmount: 5000, currentAmount: 1250, completed: false }
        ]
    });
    h.app.openGoalDetail('parent');

    h.d.querySelector('.btn-edit-subgoal[data-sid="r"]').click();
    assert.equal(h.d.getElementById('goalModalTitle').textContent, 'Редактировать подцель');
    assert.equal(h.d.getElementById('goalSubgoalKind').value, 'rhythm');
    assert.equal(h.d.getElementById('goalSubgoalPeriod').value, 'week');
    assert.equal(h.d.getElementById('subgoalRhythmFields').hidden, false);
    h.choosePeriod('month');
    assert.equal(await h.submit('Ритм', '', 'medium'), true);
    let child = h.child();
    assert.equal(child.period, 'month');
    assert.deepEqual([...child.checkins], ['2026-11-16', '2026-11-17']);
    assert.equal(child.priority, 'medium');

    h.d.querySelector('.btn-edit-subgoal[data-sid="b"]').click();
    assert.equal(h.d.getElementById('goalSubgoalKind').value, 'balance');
    assert.equal(h.d.getElementById('goalTargetAmount').value, '5000');
    h.d.getElementById('goalTargetAmount').value = '20000';
    assert.equal(await h.submit('Баланс', '', 'medium'), true);
    child = h.app.goals[0].subgoals.find(item => item.id === 'b');
    assert.equal(child.targetAmount, 20000);
    assert.equal(child.currentAmount, 1250, 'editing the target never loses the saved amount');
    assert.equal(h.app.getBalanceStats(child).percent, 6);
    assert.equal(h.app.goals[0].subgoals.length, 2, 'editing replaces the subgoal instead of duplicating it');
});

test('Rhythm CSS keeps the smoky missed slot, neon accent glow and reduced-motion fallback', () => {
    const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
    const missed = css.match(/\.rhythm-cell\.is-missed \{([^}]*)\}/);
    assert.ok(missed, 'missed-cell rule exists');
    assert.match(missed[1], /background:#2A2A38!important/i);
    assert.match(missed[1], /animation:rhythm-neon-fade/);
    const done = css.match(/\.rhythm-cell\.is-done \{([^}]*)\}/);
    assert.ok(done, 'done-cell rule exists');
    assert.match(done[1], /box-shadow:[^;]*!important/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.rhythm-cell\.is-missed \{ animation:none!important; \}/);
});
