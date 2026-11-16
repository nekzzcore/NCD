const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const root = path.join(__dirname, '..');
function fixture(t) {
    const errors = []; const vc = new VirtualConsole();vc.on('jsdomError',e=>errors.push(String(e)));vc.on('error',(...a)=>errors.push(a.join(' ')));
    const dom = new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'), {url:'https://calendar.invalid/',runScripts:'outside-only',virtualConsole:vc});
    t.after(()=>{assert.deepEqual(errors,[]);dom.window.close();});const w=dom.window,d=w.document;
    w.eval(fs.readFileSync(path.join(root,'app.js'),'utf8').split('// ===== Initialize =====')[0]+'\nwindow.GoalTracker=GoalTracker;');
    const app=Object.create(w.GoalTracker.prototype);Object.assign(app,{goals:[],achievements:[],events:[],notes:{'2026-10-17':[{id:'later',content:'Встреча с командой и подробное обсуждение следующего релиза',time:'15:00'},{id:'early',content:'Проверить прототип',time:'09:00'}]},settings:{autoSync:false},currentMonth:new Date(2026,9,31),selectedDate:'2026-10-17',currentView:'calendar',showToast(){},async saveData(){w.localStorage.setItem('goalTracker_data',JSON.stringify({notes:this.notes}));return true;}});
    w.confirm=()=>true;app.bindEvents();app.renderCalendar();return {app,w,d};
}
test('Day cells show ordered text event chips and clicking selects without opening a form',t=>{
 const h=fixture(t),day=h.d.querySelector('[data-date="2026-10-17"]');assert.equal(day.querySelector('.calendar-day-number').textContent,'17');assert.equal(day.querySelectorAll('.calendar-event-chip').length,2);assert.match(day.querySelector('.calendar-event-chip').textContent,/09:00.*Проверить прототип/);assert.equal(day.querySelector('.calendar-activity-dot'),null);
 h.d.querySelector('[data-date="2026-10-18"]').click();assert.equal(h.app.selectedDate,'2026-10-18');assert.equal(h.d.querySelector('.calendar-day.selected').getAttribute('aria-pressed'),'true');assert.ok(!h.d.getElementById('noteModal').classList.contains('active'));assert.match(h.d.getElementById('calendarDayEvents').textContent,/На этот день планов нет/);
});
test('Agenda displays full escaped titles, ordered times, selected date and edit controls',t=>{
 const h=fixture(t);h.app.notes['2026-10-17'].push({id:'html',content:'<img src=x onerror=alert(1)>',time:null});h.app.renderCalendar();
 const list=h.d.getElementById('calendarDayEvents');assert.equal(list.querySelector('img'),null);assert.match(list.textContent,/<img src=x/);assert.match(list.textContent,/подробное обсуждение следующего релиза/);assert.deepEqual([...list.querySelectorAll('time')].map(x=>x.textContent),['Без времени','09:00','15:00']);assert.match(h.d.getElementById('calendarSelectedDate').textContent,/17 октября/);
 list.querySelector('[data-edit-calendar-note="1"]').click();assert.equal(h.d.getElementById('noteId').value,'early');assert.equal(h.d.getElementById('noteDate').value,'2026-10-17');
});
test('Adding, editing and deleting from agenda retain date, update dots and persist localStorage',t=>{
 const h=fixture(t);h.app.selectCalendarDate('2026-10-18');h.d.getElementById('addCalendarNoteBtn').click();assert.equal(h.d.getElementById('noteDate').value,'2026-10-18');h.d.getElementById('noteContent').value='Новая встреча';h.d.getElementById('noteTime').value='12:30';h.d.getElementById('noteForm').dispatchEvent(new h.w.Event('submit',{cancelable:true}));
 assert.equal(JSON.parse(h.w.localStorage.getItem('goalTracker_data')).notes['2026-10-18'][0].time,'12:30');assert.equal(h.d.querySelector('[data-date="2026-10-18"]').querySelectorAll('.calendar-event-chip').length,1);
 h.d.querySelector('[data-edit-calendar-note]').click();h.d.getElementById('noteContent').value='Новое название';h.d.getElementById('noteForm').dispatchEvent(new h.w.Event('submit',{cancelable:true}));assert.equal(h.app.notes['2026-10-18'].length,1);assert.match(h.d.getElementById('calendarDayEvents').textContent,/Новое название/);
 h.w.confirm=()=>false;h.d.querySelector('[data-delete-calendar-note]').click();assert.equal(h.app.notes['2026-10-18'].length,1);h.w.confirm=()=>true;h.d.querySelector('[data-delete-calendar-note]').click();assert.equal(h.app.notes['2026-10-18'],undefined);assert.equal(JSON.parse(h.w.localStorage.getItem('goalTracker_data')).notes['2026-10-18'],undefined);assert.equal(h.d.querySelector('[data-date="2026-10-18"] .calendar-event-chip'),null);
});
test('All activities includes only current month in date/time order and selects clicked date',t=>{
 const h=fixture(t);h.app.notes['2026-10-03']=[{id:'first',content:'Ранний день',time:'12:00'}];h.app.notes['2026-11-01']=[{id:'outside',content:'Другой месяц'}];h.d.getElementById('allCalendarActivitiesBtn').click();
 const rows=[...h.d.querySelectorAll('.calendar-month-activity')];assert.equal(rows.length,3);assert.match(rows[0].textContent,/Ранний день/);assert.match(rows[1].textContent,/09:00/);assert.match(rows[2].textContent,/15:00/);assert.ok(!h.d.getElementById('calendarMonthActivities').textContent.includes('Другой месяц'));
 rows[0].click();assert.ok(!h.d.getElementById('calendarActivitiesModal').classList.contains('active'));assert.equal(h.app.selectedDate,'2026-10-03');assert.match(h.d.getElementById('calendarDayEvents').textContent,/Ранний день/);
});
test('Month changes handle the 31st, leap February and year boundaries without skipping',t=>{
 const h=fixture(t);h.app.changeMonth(1);assert.equal(h.app.currentMonth.getMonth(),10);assert.equal(h.app.selectedDate,'2026-11-01');h.app.currentMonth=new Date(2024,0,31);h.app.changeMonth(1);assert.equal(h.app.currentMonth.getMonth(),1);assert.equal(h.d.querySelectorAll('button.calendar-day').length,29);h.app.currentMonth=new Date(2026,11,31);h.app.changeMonth(1);assert.equal(h.app.selectedDate,'2027-01-01');h.app.changeMonth(-1);assert.equal(h.app.selectedDate,'2026-12-01');
});
test('Deadline and legacy event markers remain visible and appear in both activity lists',t=>{
 const h=fixture(t);h.app.goals=[{id:'goal',title:'Релиз',deadline:'2026-10-17'}];h.app.events=[{id:'event',title:'Старое событие',date:'2026-10-17',time:'10:00'}];h.app.renderCalendar();assert.equal(h.d.querySelectorAll('[data-date="2026-10-17"] .calendar-event-chip').length,2);assert.equal(h.d.querySelectorAll('.calendar-indicator.goal-indicator').length,1);assert.match(h.d.querySelector('[data-date="2026-10-17"] .calendar-events-more').textContent,/2/);assert.match(h.d.getElementById('calendarDayEvents').textContent,/Релиз/);assert.match(h.d.getElementById('calendarDayEvents').textContent,/Старое событие/);h.app.openCalendarActivities();assert.equal(h.d.querySelectorAll('.calendar-month-activity').length,4);
});
test('Empty monthly list has a clear empty state and closing button works',t=>{
 const h=fixture(t);h.app.notes={};h.app.openCalendarActivities();assert.match(h.d.getElementById('calendarMonthActivities').textContent,/В этом месяце активностей нет/);h.d.getElementById('closeCalendarActivitiesModal').click();assert.ok(!h.d.getElementById('calendarActivitiesModal').classList.contains('active'));
});

test('Calendar completion checkbox persists a real completion date and survives normalization',async t=>{
 const h=fixture(t);const activity={...h.app.notes['2026-10-17'][0],kind:'note'};
 assert.ok(h.d.querySelector('[data-complete-calendar]'));
 assert.equal(await h.app.toggleCalendarCompletion(activity,'2026-10-17',true),true);
 const saved=JSON.parse(h.w.localStorage.getItem('goalTracker_data')).notes['2026-10-17'][0];
 assert.equal(saved.completed,true);assert.ok(Number.isFinite(Date.parse(saved.completedAt)));
 const normalized=h.app.normalizeNotes({'2026-10-17':[saved]});assert.equal(normalized['2026-10-17'][0].completedAt,saved.completedAt);
 assert.equal(await h.app.toggleCalendarCompletion({...saved,kind:'note'},'2026-10-17',false),true);
 assert.equal(h.app.notes['2026-10-17'][0].completedAt,null);
});
test('Calendar completion save failure rolls back the status',async t=>{
 const h=fixture(t);h.app.saveData=async()=>false;
 const activity={...h.app.notes['2026-10-17'][0],kind:'note'};
 assert.equal(await h.app.toggleCalendarCompletion(activity,'2026-10-17',true),false);
 assert.notEqual(h.app.notes['2026-10-17'][0].completed,true);
});

test('Calendar event titles escape attribute quotes and show a bounded overflow count', t => {
 const h=fixture(t);const title='" onclick="alert(1)"><img src=x onerror=alert(1)>';
 h.app.notes['2026-10-17'].push({id:'unsafe',content:title,time:'08:00'});h.app.renderCalendar();
 const day=h.d.querySelector('[data-date="2026-10-17"]');
 assert.equal(day.querySelector('img'),null);assert.equal(day.querySelector('[onclick]'),null);
 assert.equal(day.querySelector('.calendar-event-chip').getAttribute('title'),title);
 assert.equal(day.querySelectorAll('.calendar-event-chip').length,2);
 assert.match(day.querySelector('.calendar-events-more').textContent,/1/);
});
