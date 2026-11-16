const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8').split('// ===== Initialize =====')[0];
function fixture(t, goals) {
    const dom = new JSDOM('<div id="categoryStats"></div>', { runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    dom.window.eval(source + '\nwindow.GoalTracker=GoalTracker;');
    const app = Object.create(dom.window.GoalTracker.prototype); app.goals = goals;
    app.renderCategoryStats(); return { app, document: dom.window.document };
}
test('Only real categories are shown; empty state offers adding a goal', t => {
    const h = fixture(t, []);
    assert.equal(h.document.querySelectorAll('.category-stat').length, 0);
    assert.ok(h.document.querySelector('[data-add-category]'));
    assert.match(h.document.getElementById('categoryStats').textContent, /первую цель/);
    h.app.goals = [{ id:'goal', category: 'personal', status: 'active', subgoals: [] }]; h.app.renderCategoryStats();
    assert.equal(h.document.querySelectorAll('.category-stat').length, 1);
    assert.equal(h.document.querySelector('.category-stat-count').textContent, '0/1');
    assert.equal(h.document.querySelectorAll('.category-stat.is-empty').length, 0);
    assert.doesNotMatch(h.document.getElementById('categoryStats').textContent,/Пока нет целей|0\/0/);
});
test('Category metrics preserve actual progress, completion counts and additional categories', t => {
    const h = fixture(t, [{category:'personal',status:'completed'}, {category:'personal',status:'completed'}, {category:'personal',status:'active'}, {category:'career',status:'active',subgoals:[{completed:true},{completed:false}]}]);
    const bars = h.document.querySelectorAll('[role="progressbar"]');
    assert.equal(bars[0].getAttribute('aria-valuenow'), '67');
    assert.equal(h.document.querySelector('.category-stat-count').textContent, '2/3');
    assert.equal(bars.length, 2); assert.equal(bars[1].getAttribute('aria-valuenow'), '50');
    assert.match(h.document.querySelectorAll('.category-stat-name')[1].textContent, /Карьера/);
});
test('Uncategorized goals count as personal; imported category text is escaped', t => {
    const h = fixture(t, [{ status:'active' }, { category:'<img src=x onerror=alert(1)>',status:'active' }]);
    assert.equal(h.document.querySelector('.category-stat-count').textContent, '0/1');
    assert.equal(h.document.querySelector('img'), null);
});

test('Weekly activity counts actual dated subgoals/calendar completions using local dates',t=>{
 const h=fixture(t,[]);const app=h.app;
 const stamp=(day)=>new h.document.defaultView.Date(2026,9,day,12).toISOString();
 app.goals=[{deadline:'2026-10-23',subgoals:[{completed:true,completedAt:stamp(19)},{completed:false}]},{subgoals:[{completed:true,completedAt:stamp(20)},{completed:true}]}];
 app.notes={'2026-10-21':[{completed:true,completedAt:stamp(21)}],'2026-10-25':[{completed:false}]};
 app.events=[{date:'2026-10-10',completed:true,completedAt:stamp(20)}];
 app.achievements=[{date:'2026-10-21'}];
 const stats=app.getWeeklyActivity(new h.document.defaultView.Date(2026,9,21,15));
 assert.deepEqual(Array.from(stats.days,d=>d.count),[1,2,1,0,0,0,0]);
 assert.equal(stats.completed,4);assert.equal(stats.planned,6);assert.equal(stats.productivity,67);assert.equal(stats.undated,1);
 assert.equal(stats.days[0].date,'2026-10-19');assert.equal(stats.days[6].date,'2026-10-25');
});
test('Weekly diagram has dates, seven columns and one current-day marker, without fake bars',t=>{
 const h=fixture(t,[]);h.app.notes={};h.app.events=[];
 const container=h.document.createElement('div');container.id='weeklyActivity';h.document.body.append(container);h.app.renderWeeklyActivity();
 assert.equal(container.querySelectorAll('.weekly-day').length,7);assert.equal(container.querySelectorAll('.is-today').length,1);
 assert.ok([...container.querySelectorAll('.weekly-track > span')].every(span=>span.style.height==='0%'));
 assert.match(container.textContent,/Выполнено за неделю: 0 задач/);assert.equal(h.app.getWeeklyActivity().productivity,null);
});
