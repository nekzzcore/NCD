const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8').split('// ===== Initialize =====')[0];

function fixture(t) {
    const errors = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', error => errors.push(error));
    virtualConsole.on('error', (...args) => errors.push(args));
    const dom = new JSDOM(html, {
        url: 'https://goal-modal.invalid/', runScripts: 'outside-only',
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
        saveData() { this.saved++; w.localStorage.setItem('fixture-goals', JSON.stringify(this.goals)); return true; },
        onNewGoal() { this.newGoals++; },
        onGoalChanged(goal) { this.changed.push(goal); },
        showToast(message) { this.toasts.push(message); }
    });
    const d = w.document;
    w.NCDModalViews.mount('goalModal');
    d.getElementById('goalForm').addEventListener('submit', event => app.saveGoal(event));
    return {
        app, w, d,
        submit(title = 'Новая цель', description = '', priority = 'medium') {
            d.getElementById('goalTitle').value = title;
            d.getElementById('goalDescription').value = description;
            d.getElementById('goalPriority').value = priority;
            return app.saveGoal(new w.Event('submit', { bubbles: true, cancelable: true }));
        }
    };
}

test('New goal modal exposes core fields, milestone toggle and four priority choices', async t => {
    const h = fixture(t); h.app.openGoalModal();
    const fields = [...h.d.querySelectorAll('#goalForm input:not([type="hidden"]):not([type="file"]), #goalForm textarea, #goalForm select')];
    assert.deepEqual(fields.map(field => field.id), ['goalTitle', 'goalDescription', 'goalPriority', 'goalMilestone']);
    assert.equal(h.d.getElementById('goalTitle').required, true);
    assert.equal(h.d.getElementById('goalDescription').required, false);
    assert.deepEqual([...h.d.getElementById('goalPriority').options].map(option => option.value), ['low', 'medium', 'high', 'milestone']);
    for (const id of ['goalCategory', 'goalDeadline', 'goalParent', 'goalTags']) assert.equal(h.d.getElementById(id), null);
    assert.equal(h.d.getElementById('cancelGoalBtn').textContent, 'Отмена');
    assert.equal(h.d.querySelector('#goalForm button[type="submit"]').textContent, 'Сохранить');
});

test('Each supported priority creates a goal with compatible defaults and optional description', async t => {
    const h = fixture(t);
    for (const priority of ['low', 'medium', 'high', 'milestone']) {
        h.app.openGoalModal(); await h.submit('  Цель ' + priority + '  ', '', priority);
        const goal = h.app.goals.at(-1);
        assert.equal(goal.title, 'Цель ' + priority);
        assert.equal(goal.description, '');
        assert.equal(goal.priority, priority);
        assert.equal(goal.category, 'personal');
        assert.equal(h.app.getCategoryLabel(goal.category), 'Личное');
        assert.equal(goal.deadline, null);
        assert.equal(goal.parentId, null);
        assert.deepEqual(Array.from(goal.tags), []);
        assert.deepEqual(Array.from(goal.subgoals), []);
        assert.equal(goal.status, 'active');
        assert.ok(!Number.isNaN(Date.parse(goal.createdAt)));
    }
    assert.equal(h.app.saved, 4);
    assert.equal(h.app.newGoals, 4);
    assert.equal(h.app.changed.length, 4);
    assert.equal(JSON.parse(h.w.localStorage.getItem('fixture-goals')).length, 4);
});

test('Blank or whitespace-only title never saves a goal', async t => {
    const h = fixture(t); h.app.openGoalModal();
    await h.submit(''); await h.submit('   ');
    assert.equal(h.app.goals.length, 0);
    assert.equal(h.app.saved, 0);
    assert.equal(h.app.newGoals, 0);
    assert.ok(h.d.getElementById('goalModal').classList.contains('active'));
});

test('Editing preserves hidden metadata, completion, timestamps and subgoals', async t => {
    const h = fixture(t);
    const existing = {
        id: 'existing', title: 'Старая', description: 'Описание', priority: 'high',
        category: 'career', deadline: '2027-01-10', parentId: 'parent', tags: ['работа'],
        parentGoal: 'legacy-parent', status: 'completed', createdAt: '2025-01-01T00:00:00Z',
        subgoals: [{ id: 'step', title: 'Шаг', completed: true }]
    };
    h.app.goals.push(existing); h.app.openGoalModal('existing');
    await h.submit('Исправленная', 'Новое описание', 'low');
    const edited = h.app.goals[0];
    for (const key of ['category', 'deadline', 'parentId', 'parentGoal', 'tags', 'status', 'createdAt', 'subgoals']) {
        assert.deepEqual(edited[key], existing[key], key);
    }
    assert.equal(edited.title, 'Исправленная');
    assert.equal(edited.priority, 'low');
    assert.equal(h.app.newGoals, 0);
    assert.equal(h.app.calculateProgress(edited), 100);
    h.app.openGoalDetail('existing');
    assert.match(h.d.getElementById('goalDetailContent').textContent, /Карьера/);
    assert.match(h.d.getElementById('goalDetailContent').textContent, /работа/);
    assert.match(h.d.getElementById('goalDetailContent').textContent, /10\.01\.2027/);
});

test('Legacy critical priority is preserved on edit but never offered for a new goal', async t => {
    const h = fixture(t);
    h.app.goals.push({ id: 'legacy', title: 'Важная', priority: 'critical', category: 'health', status: 'active', subgoals: [] });
    h.app.openGoalModal('legacy');
    assert.equal(h.d.getElementById('goalPriority').value, 'critical');
    await h.submit('Важная', '', 'critical');
    assert.equal(h.app.goals[0].priority, 'critical');
    h.app.openGoalModal();
    assert.equal(h.d.getElementById('goalPriority').value, 'medium');
    assert.equal(h.d.querySelector('[data-legacy-priority]'), null);
    assert.equal(h.d.getElementById('goalId').value, '');
});

test('New goals render in dashboard, calendar, cards, sorts and category statistics', async t => {
    const h = fixture(t);
    const now = new Date();
    const deadline = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-10`;
    h.app.goals.push({ id: 'dated', title: 'С дедлайном', category: 'career', priority: 'high', deadline, status: 'active', createdAt: '2025-01-01', tags: [], subgoals: [] });
    h.app.openGoalModal(); await h.submit('Без дедлайна');
    assert.doesNotThrow(() => h.app.renderDashboard());
    assert.equal(h.d.getElementById('totalGoals').textContent, '2');
    assert.doesNotMatch(h.d.getElementById('upcomingDeadlines').textContent, /Без дедлайна/);
    assert.doesNotThrow(() => h.app.renderCalendar());
    assert.equal(h.d.querySelectorAll('.calendar-indicator.goal-indicator').length, 1);
    for (const sort of ['date', 'deadline', 'progress', 'name']) {
        const selector = h.d.getElementById('sortBy');
        selector.value = sort;
        assert.doesNotThrow(() => h.app.renderGoals());
        assert.equal(h.d.querySelectorAll('#goalsList .goal-item').length, 2);
    }
    assert.match(h.d.getElementById('goalsList').textContent, /Личное/);
    const stats = h.d.createElement('div'); stats.id = 'categoryStats'; h.d.body.appendChild(stats);
    h.app.renderCategoryStats();
    assert.match(stats.textContent, /Личное/);
    assert.match(stats.textContent, /Карьера/);
    assert.equal(h.app.goals.filter(goal => goal.category === 'personal').length, 1);
    assert.equal(h.app.goals.filter(goal => goal.category === 'career').length, 1);
});

test('A stale goal ID cannot silently create or overwrite another goal', async t => {
    const h = fixture(t); h.app.openGoalModal();
    h.d.getElementById('goalId').value = 'missing'; await h.submit('Не сохранять');
    assert.equal(h.app.goals.length, 0);
    assert.equal(h.app.saved, 0);
});

test('Delayed persistence disables submit immediately and admits exactly one goal', async t => {
    const h = fixture(t); h.app.openGoalModal();
    let complete;
    h.app.saveData = () => new Promise(resolve => { complete = resolve; });
    const pending = h.submit('Одна цель');
    const button = h.d.querySelector('#goalForm [type="submit"]');
    assert.equal(button.disabled, true);
    assert.equal(h.d.getElementById('goalForm').getAttribute('aria-busy'), 'true');
    const duplicate = h.app.saveGoal(new h.w.Event('submit', { cancelable: true }));
    assert.equal(await duplicate, false);
    assert.equal(h.app.goals.length, 1);
    h.app.closeModal('goalModal');
    assert.ok(h.d.getElementById('goalModal').classList.contains('active'));
    complete(true);
    assert.equal(await pending, true);
    assert.equal(button.disabled, false);
    assert.ok(!h.d.getElementById('goalModal')?.classList.contains('active'));
    assert.equal(await h.app.saveGoal(new h.w.Event('submit', { cancelable: true })), false);
    assert.equal(h.app.goals.length, 1);
});

test('A failed write rolls back the candidate and leaves an explicit retryable error', async t => {
    const h = fixture(t); h.app.openGoalModal();
    h.app.saveData = async () => false;
    assert.equal(await h.submit('Повторить'), false);
    assert.equal(h.app.goals.length, 0);
    assert.ok(h.d.getElementById('goalModal').classList.contains('active'));
    assert.equal(h.d.querySelector('#goalForm [type="submit"]').disabled, false);
    assert.equal(h.d.getElementById('goalTitle').value, 'Повторить');
    assert.equal(h.d.getElementById('goalFormError').hidden, false);
    assert.match(h.d.getElementById('goalFormError').textContent, /Не удалось сохранить/);
    assert.equal(h.app.newGoals, 0);
    h.app.saveData = async () => true;
    assert.equal(await h.app.saveGoal(new h.w.Event('submit', { cancelable: true })), true);
    assert.equal(h.app.goals.length, 1);
});

test('A rejected write cannot produce a ghost goal or an unhandled rejection', async t => {
    const h = fixture(t); h.app.openGoalModal();
    h.app.saveData = async () => { throw new Error('storage unavailable'); };
    assert.equal(await h.submit('Ошибка диска'), false);
    assert.equal(h.app.goals.length, 0);
    assert.equal(h.d.getElementById('goalFormError').hidden, false);
    assert.equal(h.app._goalSaveInProgress, false);
});

test('The real gamification engine without optional onNewGoal cannot break saving', async t => {
    const h = fixture(t);
    const engineSource = fs.readFileSync(path.join(root, 'gamification.js'), 'utf8');
    h.w.eval(engineSource);
    h.app.gamificationEngine = new h.w.GamificationEngine(h.app);
    delete h.app.onNewGoal;
    assert.equal(typeof h.app.gamificationEngine.onNewGoal, 'undefined');
    h.app.openGoalModal();
    assert.equal(await h.submit('С движком'), true);
    assert.equal(h.app.goals.length, 1);
    assert.ok(!h.d.getElementById('goalModal')?.classList.contains('active'));
});

test('The actual add-subgoal button opens the three-field form and saves one linked nested goal', async t => {
    const h = fixture(t);
    h.app.goals.push({ id: 'parent', title: 'Родитель', category: 'career', priority: 'medium', status: 'active', subgoals: [] });
    h.w.prompt = () => { throw new Error('Electron prompt must not be used'); };
    h.app.openGoalDetail('parent');
    h.d.getElementById('addSubgoalBtn').click();
    assert.ok(!h.d.getElementById('goalDetailModal').classList.contains('active'));
    assert.ok(h.d.getElementById('goalModal').classList.contains('active'));
    assert.equal(h.d.getElementById('goalModalTitle').textContent, 'Новая подцель');
    assert.equal(h.d.getElementById('goalForm').dataset.parentGoal, 'parent');
    assert.equal(await h.submit('Подцель', 'Подробности', 'high'), true);
    assert.equal(h.app.goals.length, 1, 'no extra root goal is created');
    const child = h.app.goals[0].subgoals[0];
    assert.equal(child.parentId, 'parent');
    assert.equal(child.title, 'Подцель');
    assert.equal(child.description, 'Подробности');
    assert.equal(child.priority, 'high');
    assert.equal(child.completed, false);
    assert.ok(h.d.getElementById('goalDetailModal').classList.contains('active'));
    assert.match(h.d.getElementById('goalDetailContent').textContent, /Подцель/);
});

test('Failed subgoal persistence and cancelled subgoal do not alter the parent', async t => {
    const h = fixture(t);
    const parent = { id: 'parent', title: 'Родитель', status: 'active', subgoals: [] };
    h.app.goals.push(parent); h.app.addSubgoal('parent');
    h.app.saveData = async () => false;
    assert.equal(await h.submit('Не сохранять'), false);
    assert.equal(h.app.goals[0], parent);
    assert.equal(parent.subgoals.length, 0);
    h.app.closeModal('goalModal'); h.app.openGoalModal();
    assert.equal(h.d.getElementById('goalForm').dataset.parentGoal, '');
});

test('Analytics category action creates a goal in the chosen sphere without leaking it to normal creation',async t=>{
 const h=fixture(t);h.app.goals=[{id:'personal-goal',title:'Existing',category:'personal',status:'active',subgoals:[]}];
 h.app.renderProfile();h.d.getElementById('settingsModal').classList.add('active');
 h.d.querySelector('[data-category-choice]').value='finance';h.d.querySelector('[data-add-category]').click();
 assert.equal(h.d.getElementById('goalForm').dataset.initialCategory,'finance');
 assert.match(h.d.getElementById('goalParentContext').textContent,/Финансы/);
 assert.equal(await h.submit('Financial goal'),true);assert.equal(h.app.goals.find(g=>g.title==='Financial goal').category,'finance');
 h.app.openGoalModal();assert.equal(await h.submit('Normal goal'),true);assert.equal(h.app.goals.find(g=>g.title==='Normal goal').category,'personal');
});
test('Analytics opens the nearest unfinished subgoal and shows first achievement progress',t=>{
 const h=fixture(t);h.d.getElementById('app').style.display='flex';h.app.goals=[{id:'later',title:'Later',category:'personal',status:'active',deadline:'2035-10-20',subgoals:[{id:'late-step',title:'Later step',completed:false}]},{id:'near',title:'Near',category:'personal',status:'active',deadline:'2035-10-10',subgoals:[{id:'done',title:'Done',completed:true},{id:'next',title:'Next step',completed:false}]}];
 h.app.renderProfile();assert.match(h.d.querySelector('.first-step-achievement').textContent,/Первый шаг/);assert.match(h.d.querySelector('.first-step-achievement').textContent,/0\/1/);
 const next=h.d.querySelector('[data-next-step]');assert.equal(next.dataset.nextStep,'next');next.click();
 assert.ok(h.d.getElementById('goalDetailModal').classList.contains('active'));assert.equal(h.d.activeElement.dataset.sid,'next');
});

test('Legacy gt_goals loads only without a canonical goal list and never resurrects deleted goals',t=>{
 const h=fixture(t);h.w.localStorage.setItem('gt_goals',JSON.stringify([{id:'legacy-goal',title:'Legacy',subgoals:[]} ]));
 h.w.ProfileStorage={get:()=>null};h.app.loadData();assert.equal(h.app.goals[0].id,'legacy-goal');
 h.w.ProfileStorage={get:()=>({user:null,goals:[],settings:{}})};h.app.loadData();assert.equal(h.app.goals.length,0);
});

test('Saving ends the goal draft before triggering the cloud write',async t=>{
 const h=fixture(t);let pushed=false;
 h.w.CloudSync={pushGoals(goal){
  assert.equal(!!h.d.getElementById('goalModal')?.classList.contains('active'),false);
  assert.equal(goal.title,'Название сохранено');pushed=true;return Promise.resolve(true);
 }};
 h.app.openGoalModal();assert.equal(h.d.activeElement.id,'goalTitle');
 assert.equal(await h.submit('Название сохранено'),true);assert.ok(pushed);
});
