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
    const console = new VirtualConsole();
    console.on('jsdomError', error => errors.push(String(error)));
    console.on('error', (...args) => { if (args[0] !== '[goals.persist] Failed to save goal action:') errors.push(args.join(' ')); });
    const dom = new JSDOM(html, { url: 'https://checklist.invalid/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: console });
    t.after(() => { assert.deepEqual(errors, []); dom.window.close(); });
    const w = dom.window; const d = w.document;
    // Data and interaction checks use reduced motion; animation is checked separately.
    w.matchMedia = query => ({ matches: query.includes("prefers-reduced-motion") });
    w.eval(appSource + '\nwindow.GoalTracker = GoalTracker;');
    w.eval(fs.readFileSync(path.join(root, 'gamification.js'), 'utf8'));
    const app = Object.create(w.GoalTracker.prototype);
    Object.assign(app, {
        user: { id: 'fixture', nickname: 'Fixture' },
        goals: [{ id: 'parent', title: 'Подготовить приложение', status: 'active', category: 'personal', priority: 'medium', tags: [], createdAt: '2026-01-01', subgoals: [
            { id: 'one', title: 'Составить план', completed: true, priority: 'low' },
            { id: 'two', title: 'Собрать прототип', completed: false, priority: 'medium' },
            { id: 'three', title: 'Проверить результат', completed: false, priority: 'high' }
        ] }],
        achievements: [], events: [], notes: {}, settings: { autoSync: false, gamification: false },
        currentMonth: new Date(), currentView: 'goals', toasts: [],
        async saveData() { w.localStorage.setItem('goalTracker_data', JSON.stringify({ goals: this.goals, achievements: this.achievements })); return true; },
        showToast(text) { this.toasts.push(text); }
    });
    app.gamificationEngine = new w.GamificationEngine(app);
    w.prompt = () => { throw new Error('No native prompt in Electron'); };
    w.confirm = () => true;
    app.renderGoals(); app.openGoalDetail('parent');
    return {
        app, w, d,
        stored: () => JSON.parse(w.localStorage.getItem('goalTracker_data')),
        async settled() {
            for (let i = 0; app._goalActionPending && i < 50; i++) await new Promise(resolve => setImmediate(resolve));
            assert.equal(Boolean(app._goalActionPending), false);
            await Promise.resolve();
        },
        submit: () => app.saveGoal(new w.Event('submit', { cancelable: true }))
    };
}

test('Subgoal ratio is the single progress source, including manually completed goals', t => {
    const h = fixture(t); const goal = h.app.goals[0];
    assert.equal(h.app.calculateProgress(goal), 33);
    goal.status = 'completed'; assert.equal(h.app.calculateProgress(goal), 33);
    goal.subgoals[1].completed = true; assert.equal(h.app.calculateProgress(goal), 67);
    goal.subgoals[2].completed = true; assert.equal(h.app.calculateProgress(goal), 100);
    goal.subgoals = []; assert.equal(h.app.calculateProgress(goal), 100);
    goal.status = 'active'; assert.equal(h.app.calculateProgress(goal), 0);
});

test('Checklist directly follows goal progress and has counts, accessible labels and card mini progress', t => {
    const h = fixture(t);
    const progress = h.d.querySelector('.goal-progress-section');
    assert.ok(progress.nextElementSibling.classList.contains('subgoals-section'));
    assert.ok(progress.nextElementSibling.nextElementSibling.classList.contains('inspector-files'));
    assert.ok(progress.nextElementSibling.nextElementSibling.nextElementSibling.classList.contains('goal-achievements-section'));
    assert.equal(progress.querySelector('.ring-value').getAttribute('stroke-dasharray'), `${h.app.calculateProgress(h.app.goals[0])} 100`);
    assert.equal(progress.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '33');
    assert.equal(h.d.querySelector('.subgoals-count').textContent, '1 из 3 выполнено');
    assert.equal(h.d.querySelectorAll('#goalDetailContent .subgoal-item').length, 3);
    assert.equal(h.d.querySelectorAll('#goalDetailContent .subgoal-item.is-complete').length, 1);
    assert.equal(h.d.querySelectorAll('#goalDetailContent .subgoal-main input[type="checkbox"]').length, 3);
    assert.equal(h.d.querySelector('#goalsList .subgoal-mini-bar').getAttribute('aria-valuenow'), '33');
});

test('Actual checkbox change saves and refreshes modal, card and localStorage both directions', async t => {
    const h = fixture(t);
    h.d.querySelector('.subgoal-checkbox[data-sid="two"]').click(); await h.settled();
    assert.equal(h.stored().goals[0].subgoals[1].completed, true);
    assert.equal(h.d.querySelector('[data-goal-progress]').textContent, '67%');
    assert.equal(h.d.querySelector('.subgoals-count').textContent, '2 из 3 выполнено');
    assert.equal(h.d.querySelector('#goalsList .subgoal-mini-bar').getAttribute('aria-valuenow'), '67');
    h.d.querySelector('.subgoal-checkbox[data-sid="two"]').click(); await h.settled();
    assert.equal(h.stored().goals[0].subgoals[1].completed, false);
    assert.equal(h.d.querySelector('[data-goal-progress]').textContent, '33%');
    assert.equal(h.d.querySelector('.subgoal-checkbox[data-sid="two"]').checked, false);
});

test('Failed checkbox persistence restores the old checkbox, count and progress', async t => {
    const h = fixture(t); const original = h.app.goals[0];
    h.app.saveData = async () => false;
    h.d.querySelector('.subgoal-checkbox[data-sid="two"]').click(); await h.settled();
    assert.equal(h.app.goals[0], original);
    assert.equal(h.d.querySelector('.subgoal-checkbox[data-sid="two"]').checked, false);
    assert.equal(h.d.querySelector('[data-goal-progress]').textContent, '33%');
    assert.ok(h.app.toasts.some(text => text.includes('не сохранены')));
});

test('Pending checklist writes lock actions and ignore overlapping changes', async t => {
    const h = fixture(t); let finish;
    h.app.saveData = () => new Promise(resolve => { finish = resolve; });
    const pending = h.app.toggleSubgoal('parent', 'two', true);
    assert.equal(h.d.querySelector('.subgoal-checkbox').disabled, true);
    assert.equal(await h.app.toggleSubgoal('parent', 'three', true), false);
    h.app.closeModal('goalDetailModal');
    assert.ok(h.d.getElementById('goalDetailModal').classList.contains('active'));
    finish(true); assert.equal(await pending, true);
    assert.equal(h.d.querySelectorAll('#goalDetailContent .subgoal-checkbox:checked').length, 2);
    assert.equal(h.d.querySelector('.subgoal-checkbox').disabled, false);
});

test('Edit icon opens the compact form and preserves completed state and parent linkage', async t => {
    const h = fixture(t);
    h.app.goals[0].subgoals[0].parentId = 'parent';
    h.d.querySelector('.btn-edit-subgoal[data-sid="one"]').click();
    assert.equal(h.d.getElementById('goalModalTitle').textContent, 'Редактировать подцель');
    assert.equal(h.d.getElementById('goalForm').dataset.subgoalId, 'one');
    h.d.getElementById('goalTitle').value = 'Уточнённый план';
    h.d.getElementById('goalDescription').value = 'Детали';
    h.d.getElementById('goalPriority').value = 'high';
    assert.equal(await h.submit(), true);
    const step = h.app.goals[0].subgoals[0];
    assert.equal(step.title, 'Уточнённый план');
    assert.equal(step.completed, true);
    assert.equal(step.parentId, 'parent');
    assert.equal(h.app.goals[0].subgoals.length, 3);
    assert.equal(h.d.querySelector('[data-goal-progress]').textContent, '33%');
});

test('Confirmed subgoal deletion recalculates progress; cancellation changes nothing', async t => {
    const h = fixture(t); h.w.confirm = () => false;
    assert.equal(await h.app.deleteSubgoal('parent', 'three'), false);
    assert.equal(h.app.goals[0].subgoals.length, 3);
    h.w.confirm = () => true;
    assert.equal(await h.app.deleteSubgoal('parent', 'three'), true);
    assert.equal(h.stored().goals[0].subgoals.length, 2);
    assert.equal(h.d.querySelector('[data-goal-progress]').textContent, '50%');
    assert.equal(h.d.querySelector('.subgoals-count').textContent, '1 из 2 выполнено');
});

test('Empty checklist offers add-next-to-hint and creates the first linked step', async t => {
    const h = fixture(t); h.app.goals[0].subgoals = []; h.app.openGoalDetail('parent');
    assert.match(h.d.querySelector('.subgoals-empty').textContent, /Разбей цель на шаги/);
    h.d.querySelector('[data-add-subgoal]').click();
    h.d.getElementById('goalTitle').value = 'Первый шаг';
    assert.equal(await h.submit(), true);
    assert.equal(h.app.goals[0].subgoals[0].parentId, 'parent');
    assert.equal(h.d.querySelector('.subgoals-count').textContent, '0 из 1 выполнено');
    assert.equal(h.d.querySelector('[data-goal-progress]').textContent, '0%');
});

test('Complete and return buttons preserve checklist progress and persist status', async t => {
    const h = fixture(t);
    h.d.getElementById('completeGoalBtn').click(); await h.settled();
    assert.equal(h.stored().goals[0].status, 'completed');
    assert.equal(h.app.calculateProgress(h.app.goals[0]), 33);
    assert.equal(h.app.achievements.length, 0);
    assert.ok(!h.d.getElementById('goalDetailModal').classList.contains('active'));
    h.app.openGoalDetail('parent');
    assert.equal(h.d.querySelector('[data-goal-progress]').textContent, '33%');
    assert.match(h.d.getElementById('completeGoalBtn').textContent, /Вернуть/);
    assert.equal(await h.app.toggleGoalStatus('parent'), true);
    assert.equal(h.stored().goals[0].status, 'active');
    assert.equal(h.app.achievements.length, 0);
});

test('Root edit/add/delete action buttons remain wired and deletions still require confirmation', async t => {
    const h = fixture(t); h.d.getElementById('editGoalBtn').click();
    assert.equal(h.d.getElementById('goalId').value, 'parent');
    h.app.closeModal('goalModal'); h.app.openGoalDetail('parent');
    h.d.getElementById('addSubgoalBtn').click();
    assert.equal(h.d.getElementById('goalForm').dataset.parentGoal, 'parent');
    h.app.closeModal('goalModal'); h.app.openGoalDetail('parent');
    h.d.getElementById('deleteGoalHeaderBtn').click();
    h.d.getElementById('cancelDeleteGoalBtn').click();
    assert.equal(h.app.goals.length, 1);
    h.d.querySelector('.goal-item').dispatchEvent(new h.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    h.d.querySelectorAll('.goal-context-menu button')[1].click();
    assert.ok(h.d.getElementById('deleteGoalMessage').textContent.includes('Подготовить приложение'));
    h.d.getElementById('confirmDeleteGoalBtn').click();
    await h.settled();
    assert.equal(h.app.goals.length, 0);
    assert.equal(h.stored().goals.length, 0);
});


test('Attachment upload saves nested attachments, renders tags, and deletes the Storage object', async t => {
    const h = fixture(t); const calls = [];
    const storage = {
        async upload(path, file, options) { calls.push(['upload', path, file.name, options.upsert]); return {}; },
        getPublicUrl(path) { return { data: { publicUrl: `https://cloud.invalid/storage/v1/object/public/goal-attachments/${path}` } }; },
        async remove(paths) { calls.push(['remove', paths]); return {}; }
    };
    h.w.CloudSync = { attachmentStorage: () => ({ userId: 'owner', storage, assertOwner() {} }), async sync() { return true; } };
    assert.equal(await h.app.changeSubgoalAttachment('parent', 'two', new h.w.File(['image'], 'photo.png')), true);
    assert.match(calls[0][1], /^owner\/parent\/two\/.+-photo\.png$/);
    assert.equal(calls[0][3], false);
    assert.equal(h.stored().goals[0].subgoals[1].attachments[0].name, 'photo.png');
    assert.match(h.d.querySelector('.attachment-open').textContent, /photo.png/);
    assert.equal(await h.app.changeSubgoalAttachment('parent', 'two', null, 0), true);
    assert.equal(calls[1][1][0], calls[0][1]);
    assert.equal(h.stored().goals[0].subgoals[1].attachments.length, 0);
});

test('Failed attachment persistence removes uploaded object and preserves metadata', async t => {
    const h = fixture(t); let removed = false;
    h.w.CloudSync = { attachmentStorage: () => ({ userId: 'owner', assertOwner() {}, storage: {
        async upload() { return {}; },
        getPublicUrl(path) { return { data: { publicUrl: 'https://cloud.invalid/' + path } }; },
        async remove() { removed = true; return {}; }
    } }) };
    h.app.saveData = async () => false;
    assert.equal(await h.app.changeSubgoalAttachment('parent', 'two', new h.w.File(['x'], 'a.txt')), false);
    assert.equal(removed, true);
    assert.equal(h.app.goals[0].subgoals[1].files, undefined);
    assert.equal(h.d.querySelector('.attachment-add').disabled, false);
});

test('Offline attachment is stored as Base64 and survives checkbox progress updates', async t => {
    const h = fixture(t);
    Object.defineProperty(h.w.navigator, 'onLine', { value: false, configurable: true });
    assert.equal(await h.app.changeSubgoalAttachment('parent', 'two', new h.w.File(['offline-document'], 'plan.pdf', { type: 'application/pdf' })), true);
    const saved = h.stored().goals[0].subgoals[1].attachments[0];
    assert.match(saved.data, /^data:application\/pdf;base64,/);
    assert.equal(Buffer.from(saved.data.split(',')[1], 'base64').toString(), 'offline-document');
    assert.equal(h.app.calculateProgress(h.app.goals[0]), 33);
    h.d.querySelector('.subgoal-checkbox[data-sid="two"]').click(); await h.settled();
    assert.equal(h.app.calculateProgress(h.app.goals[0]), 67);
    assert.equal(h.stored().goals[0].subgoals[1].attachments[0].data, saved.data);
    assert.equal(await h.app.changeSubgoalAttachment('parent', 'two', null, 0), true);
    assert.equal(h.stored().goals[0].subgoals[1].attachments.length, 0);
    assert.equal(h.app.calculateProgress(h.app.goals[0]), 67);
});

test('Storage failure falls back to a durable inline attachment', async t => {
    const h = fixture(t);
    h.w.CloudSync = { attachmentStorage: () => ({ userId: 'owner', assertOwner() {}, storage: { async upload() { return { error: { message: 'Offline' } }; } } }) };
    assert.equal(await h.app.changeSubgoalAttachment('parent', 'two', new h.w.File(['x'], 'a.txt', { type: 'text/plain' })), true);
    assert.match(h.stored().goals[0].subgoals[1].attachments[0].data, /^data:text\/plain;base64,/);
    assert.ok(h.app.toasts.some(text => /Storage не удалась/.test(text)));
});

test('Legacy files stay visible and migrate to attachments on the next change', async t => {
    const h = fixture(t);
    const legacy = { name: 'old.pdf', url: 'https://cloud.invalid/old.pdf' };
    h.app.goals[0].subgoals[1].files = [legacy]; h.app.openGoalDetail('parent');
    assert.match(h.d.querySelector('.attachment-open').textContent, /old.pdf/);
    assert.equal(await h.app.changeSubgoalAttachment('parent', 'two', new h.w.File(['new'], 'new.txt')), true);
    const step = h.stored().goals[0].subgoals[1];
    assert.equal(step.files, undefined); assert.equal(step.attachments.length, 2);
    assert.equal(step.attachments[0].url, legacy.url);
});

test('Failed deletion persistence never removes the remote object', async t => {
    const h = fixture(t); let removed = false;
    h.app.goals[0].subgoals[1].attachments = [{ name: 'a.txt', url: 'https://cloud.invalid/storage/v1/object/public/goal-attachments/owner/parent/two/a.txt' }];
    h.w.CloudSync = { attachmentStorage: () => ({ userId: 'owner', assertOwner() {}, storage: {
        getPublicUrl(p) { return { data: { publicUrl: 'https://cloud.invalid/storage/v1/object/public/goal-attachments/' + p } }; },
        async remove() { removed = true; return {}; }
    } }) };
    h.app.saveData = async () => false;
    assert.equal(await h.app.changeSubgoalAttachment('parent', 'two', null, 0), false);
    assert.equal(removed, false); assert.equal(h.app.goals[0].subgoals[1].attachments.length, 1);
});

test('Inline images open in a dialog; documents download; unsafe URLs do not open', t => {
    const h = fixture(t); const downloads = [], opened = [];
    h.w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    h.w.HTMLDialogElement.prototype.close = function () { this.dispatchEvent(new h.w.Event('close')); };
    h.app.openGoalAttachment({ name: 'photo.png', url: 'data:image/png;base64,eA==' });
    assert.equal(h.d.querySelector('.attachment-preview img').alt, 'photo.png');
    h.d.querySelector('.attachment-preview button').click(); assert.equal(h.d.querySelector('.attachment-preview'), null);
    h.w.URL.createObjectURL = () => 'blob:fixture'; h.w.URL.revokeObjectURL = () => {};
    h.w.HTMLAnchorElement.prototype.click = function () { downloads.push({ name: this.download, url: this.href }); };
    h.app.openGoalAttachment({ name: 'plan.pdf', url: 'data:application/pdf;base64,eA==' });
    assert.equal(downloads[0].name, 'plan.pdf');
    h.w.open = url => opened.push(url);
    h.app.openGoalAttachment({ name: 'plan.pdf', url: 'https://cloud.invalid/plan.pdf' });
    h.app.openGoalAttachment({ name: 'evil.html', url: 'javascript:alert(1)' });
    assert.equal(opened.length, 1);
});

test('Offline file size limit leaves subgoal and progress unchanged', async t => {
    const h = fixture(t);
    const file = new h.w.File(['x'], 'large.pdf'); Object.defineProperty(file, 'size', { value: 3 * 1024 * 1024 + 1 });
    assert.equal(await h.app.changeSubgoalAttachment('parent', 'two', file), false);
    assert.equal(h.app.goals[0].subgoals[1].attachments, undefined);
    assert.equal(h.app.calculateProgress(h.app.goals[0]), 33);
    assert.ok(h.app.toasts.some(text => /3 МБ/.test(text)));
});

test('Android file providers without MIME still allow offline image preview', async t => {
    const h = fixture(t);
    assert.equal(await h.app.changeSubgoalAttachment('parent', 'two', new h.w.File(['x'], 'camera.PNG')), true);
    const attachment = h.stored().goals[0].subgoals[1].attachments[0];
    assert.equal(attachment.type, 'image/png'); assert.match(attachment.data, /^data:image\/png;base64,/);
    h.w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    h.app.openGoalAttachment(attachment);
    assert.equal(h.d.querySelector('.attachment-preview img').alt, 'camera.PNG');
});

test('Completing a subgoal stores the real completion time; undo clears it',async t=>{
 const h=fixture(t);assert.equal(await h.app.toggleSubgoal('parent','two',true),true);
 assert.ok(Number.isFinite(Date.parse(h.stored().goals[0].subgoals[1].completedAt)));
 assert.equal(await h.app.toggleSubgoal('parent','two',false),true);
 assert.equal(h.stored().goals[0].subgoals[1].completedAt,null);
});

test('Subgoal form selects multiple files, removes a draft, and saves Base64 with progress unchanged', async t => {
    const h = fixture(t); h.app.bindEvents(); h.app.openGoalModal(null, 'parent', 'two');
    assert.equal(h.d.getElementById('goalAttachmentFields').hidden, false);
    const input = h.d.getElementById('goalAttachmentInput');
    assert.equal(input.multiple, true);
    Object.defineProperty(input, 'files', { configurable: true, value: [new h.w.File(['pdf'], 'plan.pdf', {type:'application/pdf'}), new h.w.File(['png'], 'photo.png', {type:'image/png'})] });
    input.dispatchEvent(new h.w.Event('change'));
    assert.equal(h.d.querySelectorAll('.goal-attachment-row').length, 2);
    h.d.querySelector('[data-remove-draft="0"]').click();
    assert.equal(h.d.querySelectorAll('.goal-attachment-row').length, 1);
    assert.equal(await h.submit(), true);
    const step = h.stored().goals[0].subgoals[1];
    assert.equal(step.attachments.length, 1);assert.equal(step.attachments[0].name,'photo.png');
    assert.match(step.attachments[0].data,/^data:image\/png;base64,/);assert.equal(step.attachments[0].url,undefined);
    assert.equal(step.completed,false);assert.equal(h.app.calculateProgress(h.app.goals[0]),33);
    h.app.openGoalModal(null,'parent','two');assert.match(h.d.getElementById('goalAttachmentList').textContent,/photo.png/);
    h.d.querySelector('[data-remove-draft="0"]').click();h.app.closeModal('goalModal');
    assert.equal(h.app.goals[0].subgoals[1].attachments.length,1,'cancel leaves saved attachments intact');
    h.app.openGoalModal();assert.equal(h.d.getElementById('goalAttachmentFields').hidden,true);
});
test('New subgoal form uploads to Storage and rolls back uploaded files after persistence failure',async t=>{
 const h=fixture(t);let uploads=0,removals=0;
 h.w.CloudSync={attachmentStorage:()=>({userId:'owner',assertOwner(){},storage:{async upload(){uploads++;return {};},getPublicUrl(path){return {data:{publicUrl:'https://cloud.invalid/'+path}};},async remove(){removals++;return {};}}})};
 h.app.openGoalModal(null,'parent');h.d.getElementById('goalTitle').value='With document';
 h.app._goalAttachmentDraft=[{file:new h.w.File(['doc'],'file.doc',{type:'application/msword'})}];
 h.app.saveData=async()=>false;assert.equal(await h.submit(),false);assert.equal(uploads,1);assert.equal(removals,1);assert.equal(h.app.goals[0].subgoals.length,3);
 h.app.saveData=async function(){h.w.localStorage.setItem('goalTracker_data',JSON.stringify({goals:this.goals}));return true;};
 assert.equal(await h.submit(),true);assert.equal(uploads,2);assert.equal(h.stored().goals[0].subgoals.length,4);
 assert.match(h.stored().goals[0].subgoals[3].attachments[0].url,/^https:\/\/cloud.invalid\//);
});

test('Completed ordinary goals go to archive while milestones go to achievements without duplicates', t => {
    const h = fixture(t);
    const base = h.app.goals[0];
    h.app.goals = ['low', 'medium', 'high', 'milestone'].map(priority => ({
        ...base, id: priority, title: `Result ${priority}`, priority,
        status: 'active', subgoals: [{ id: 'step', title: 'Done', completed: true }]
    }));
    h.app.achievements = [
        { id: 'manual', title: 'Manual result', date: '2026-10-25' },
        { id: 'old', goalId: 'low', title: 'Old automatic result', autoCreated: true },
        { id: 'star', goalId: 'milestone', title: 'Milestone', autoCreated: true }
    ];
    h.app.renderGoals();
    assert.equal(h.d.querySelectorAll('#goalsList .goal-item').length, 0);
    h.app.renderAchievements();
    assert.equal(h.d.querySelectorAll('#achievementsList .achievement-item-full').length, 2);
    assert.match(h.d.getElementById('achievementsList').textContent, /Result milestone/);
    assert.doesNotMatch(h.d.getElementById('achievementsList').textContent, /Old automatic/);
    h.d.querySelector('[data-achievement-tab="archive"]').click();
    assert.equal(h.d.querySelectorAll('[data-archive-goal]').length, 3);
    assert.equal(h.d.getElementById('addAchievementBtn').hidden, true);
    h.d.querySelector('[data-archive-goal="low"]').click();
    assert.match(h.d.getElementById('completeGoalBtn').textContent, /Вернуть/);
    h.app.goals[0].subgoals[0].completed = false;
    h.app.renderAchievements(); h.app.renderGoals();
    assert.equal(h.d.querySelectorAll('[data-archive-goal]').length, 2);
    assert.equal(h.d.querySelectorAll('#goalsList .goal-item').length, 1);
    h.app.goals[3].priority = 'high';
    assert.equal(h.app.getAchievementEntries().length, 1);
});

test('Saved completion flashes before removal and rejects another toggle during feedback', async t => {
    const h = fixture(t);
    h.w.matchMedia = () => ({ matches:false });
    const content = h.d.getElementById('goalDetailContent');
    content.getClientRects = () => [{}];
    let finish;
    h.w.setTimeout = callback => { finish = callback; return 1; };
    const completing = h.app.toggleGoalStatus('parent');
    for (let i = 0; i < 8 && !finish; i++) await Promise.resolve();
    assert.equal(h.stored().goals[0].status, 'completed');
    assert.ok(content.classList.contains('completion-feedback'));
    assert.ok(h.d.getElementById('detailGoalTitle').classList.contains('completion-title'));
    assert.ok(h.d.getElementById('goalDetailModal').classList.contains('active'));
    assert.equal(await h.app.toggleGoalStatus('parent'), false);
    finish(); await completing;
    assert.equal(content.classList.contains('completion-feedback'), false);
    assert.equal(h.d.getElementById('goalDetailModal').classList.contains('active'), false);
});

test('Progress animates to 100 and back to zero, and reduced motion skips animation', t => {
    const h = fixture(t);
    const content = h.d.getElementById('goalDetailContent');
    h.w.matchMedia = () => ({ matches:false });
    let frame;
    h.w.requestAnimationFrame = callback => { frame = callback; return 1; };
    h.w.cancelAnimationFrame = () => {};
    for (const [from, to] of [[0,100], [100,43], [43,0]]) {
        h.app.animateInspectorProgress(content,from,to);
        frame(0); frame(325);
        const mid = Number(content.querySelector('[data-goal-progress]').textContent.replace('%',''));
        assert.ok(mid > Math.min(from,to) && mid < Math.max(from,to));
        frame(650);
        assert.equal(content.querySelector('[data-goal-progress]').textContent, `${to}%`);
        assert.equal(content.querySelector('.ring-value').getAttribute('stroke-dasharray'), `${to} 100`);
    }
    h.w.matchMedia = () => ({ matches:true });
    h.app.animateInspectorProgress(content,0,100);
    assert.equal(content.querySelector('[data-goal-progress]').textContent,'100%');
});

 test('Failed goal deletion restores state and permits retry', async t => {
    const h = fixture(t);
    h.app.saveData = async () => false;
    h.app.deleteGoal('parent');
    h.d.getElementById('confirmDeleteGoalBtn').click();
    await h.settled();
    assert.equal(h.app.goals.length, 1);
    assert.equal(h.d.getElementById('confirmDeleteGoalBtn').disabled, false);
    assert.ok(h.d.getElementById('deleteGoalModal').classList.contains('active'));
 });

test('Numeric legacy goal ID deletes through a string UI ID only after persistence', async t => {
 const h=fixture(t);h.app.goals[0].id=42;
 let release;const gate=new Promise(resolve=>release=resolve);
 h.app.saveData=async()=>{await gate;return true;};
 h.app.deleteGoal('42');h.d.getElementById('confirmDeleteGoalBtn').click();
 assert.ok(h.d.getElementById('deleteGoalModal').classList.contains('active'));
 assert.ok(h.d.querySelector('.goal-item'));
 release();await h.settled();
 assert.equal(h.app.goals.length,0);
 assert.equal(h.d.querySelector('.goal-item'),null);
 assert.equal(h.d.getElementById('goalDetailContent').dataset.goalId,undefined);
});
