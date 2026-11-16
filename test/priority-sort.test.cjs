const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8').split('// ===== Initialize =====')[0];
function fixture(t) {
    const errors = []; const vc = new VirtualConsole();
    vc.on('jsdomError', e => errors.push(String(e))); vc.on('error', (...args) => errors.push(args.join(' ')));
    const dom = new JSDOM(html, { url: 'https://priority.invalid/', runScripts: 'outside-only', virtualConsole: vc });
    t.after(() => { assert.deepEqual(errors, []); dom.window.close(); });
    const w = dom.window, d = w.document;
    w.eval(source + '\nwindow.GoalTracker = GoalTracker;');
    const app = Object.create(w.GoalTracker.prototype);
    Object.assign(app, { goals: [], achievements: [], events: [], notes: {}, settings: { autoSync: false, gamification: false }, currentMonth: new Date(), currentView: 'goals',
        async saveData() { w.localStorage.setItem('goalTracker_data', JSON.stringify({goals:this.goals})); return true; }, showToast() {} });
    app.bindEvents();
    return { app, w, d, order: () => [...d.querySelectorAll('#goalsList .goal-item')].map(el => el.dataset.id) };
}
const goal = (id, priority, date, status = 'active') => ({ id, title: id, priority, createdAt: date, status, category: 'personal', subgoals: [], tags: [] });
test('Priority is the default, with descending importance and newest-first within each group', t => {
    const h = fixture(t); assert.equal(h.d.getElementById('sortBy').value, 'priority');
    h.app.goals = [goal('low', 'low', '2026-06-01'), goal('old-high','high','2026-01-01'),goal('medium','medium','2026-07-01'),goal('new-high','high','2026-03-01'),goal('critical','critical','2025-01-01')];
    const original = JSON.stringify(h.app.goals); h.app.renderGoals();
    assert.deepEqual(h.order(), ['critical','new-high','old-high','medium','low']);
    assert.equal(JSON.stringify(h.app.goals), original);
    assert.equal(h.d.querySelectorAll('.goal-item-important').length, 3);
});
test('Missing and unknown priorities use medium weight, and date ties retain insertion order', t => {
    const h = fixture(t);
    h.app.goals = [goal('missing',undefined,'2026-01-01'),goal('unknown','constructor','2026-01-01'),goal('medium','medium','2026-01-01'),goal('low','low','2026-12-01')];
    h.app.renderGoals(); assert.deepEqual(h.order(), ['missing','unknown','medium','low']);
});
test('Status filters keep active and completed goals in their respective lists', t => {
    const h = fixture(t); h.app.goals = [goal('low-active','low','2026-06-01'),goal('high-done','high','2026-03-01','completed'),goal('high-active','high','2026-01-01'),goal('low-done','low','2026-07-01','completed')];
    const filter = h.d.getElementById('filterStatus');
    for (const [status, expected] of [['active',['high-active','low-active']],['completed',['high-done','low-done']],['all',['high-active','low-active']]]) {
        filter.value = status; filter.dispatchEvent(new h.w.Event('change')); assert.deepEqual(h.order(), expected);
    }
});
test('Date, deadline, progress and title sorts retain their previous behavior', t => {
    const h = fixture(t); const a = goal('A','low','2026-06-01'), b = goal('B','high','2026-01-01');
    a.deadline = null; b.deadline = '2026-12-01'; h.app.goals = [a,b];
    const select = h.d.getElementById('sortBy');
    for (const [sort, expected] of [['created',['A','B']],['deadline',['B','A']],['progress',['A','B']],['name',['A','B']],['priority',['B','A']]]) {
        select.value = sort; select.dispatchEvent(new h.w.Event('change')); assert.deepEqual(h.order(), expected);
    }
});
test('Creating three priorities and editing priority immediately reorders the existing list and persists', async t => {
    const h = fixture(t);
    for (const priority of ['low','high','medium']) {
        h.app.openGoalModal(); h.d.getElementById('goalTitle').value = priority; h.d.getElementById('goalPriority').value = priority;
        assert.equal(await h.app.saveGoal(new h.w.Event('submit',{cancelable:true})), true);
    }
    const priorities = () => h.order().map(id => h.app.goals.find(g => g.id === id).priority);
    assert.deepEqual(priorities(), ['high','medium','low']);
    const low = h.app.goals.find(g => g.priority === 'low'); h.app.openGoalModal(low.id);
    h.d.getElementById('goalPriority').value = 'high';
    assert.equal(await h.app.saveGoal(new h.w.Event('submit',{cancelable:true})), true);
    assert.deepEqual(priorities(), ['high','high','medium']);
    assert.ok(h.d.querySelector(`.goal-item[data-id="${low.id}"]`).classList.contains('goal-item-important'));
    assert.equal(JSON.parse(h.w.localStorage.getItem('goalTracker_data')).goals.find(g => g.id === low.id).priority, 'high');
});
test('Root sorting never reorders the nested checklist or changes its progress', t => {
    const h = fixture(t); const parent = goal('parent','high','2026-01-01');
    parent.subgoals = [{id:'low-first',title:'First',priority:'low',completed:true},{id:'high-last',title:'Last',priority:'high',completed:false}];
    h.app.goals = [goal('other','low','2026-02-01'),parent]; const original = JSON.stringify(parent.subgoals);
    h.app.renderGoals(); h.app.openGoalDetail('parent');
    assert.deepEqual([...h.d.querySelectorAll('#goalDetailContent .subgoal-checkbox')].map(el => el.dataset.sid), ['low-first','high-last']);
    assert.equal(h.app.calculateProgress(parent), 50); assert.equal(JSON.stringify(parent.subgoals), original);
});
