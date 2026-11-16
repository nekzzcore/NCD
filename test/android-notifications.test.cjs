const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'notifications.js'), 'utf8');
function fixture(t, platform = 'android', exact = true) {
    const errors = [], console = new VirtualConsole();
    console.on('jsdomError', error => errors.push(String(error))); console.on('error', (...args) => errors.push(args.join(' ')));
    const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), { url: 'https://notifications.invalid', runScripts: 'outside-only', virtualConsole: console });
    const w = dom.window; t.after(() => { assert.deepEqual(errors, []); w.close(); });
    const calls = [], channels = [], scheduled = []; let pending = [], permission = 'prompt';
    const native = {
        async checkPermissions() { calls.push('check'); return { display: permission }; },
        async requestPermissions() { calls.push('request'); permission = 'granted'; return { display: permission }; },
        async createChannel(channel) { channels.push(channel); },
        async addListener() { calls.push('listener'); return { remove() {} }; },
        async checkExactNotificationSetting() { calls.push('exact'); return { exact_alarm: exact ? 'granted' : 'denied' }; },
        async changeExactNotificationSetting() { calls.push('changeExact'); exact = true; return { exact_alarm: 'granted' }; },
        async schedule({ notifications }) { scheduled.push(...notifications); pending.push(...notifications); return {}; },
        async getPending() { calls.push('pending'); return { notifications: pending }; },
        async cancel({ notifications }) { calls.push('cancel'); pending = pending.filter(n => !notifications.some(item => item.id === n.id)); }
    };
    w.Capacitor = { getPlatform: () => platform, isNativePlatform: () => platform !== 'web' };
    Object.defineProperty(w.Capacitor, 'Plugins', { get() { if (platform !== 'android') return new Proxy({}, { get(_, key) { if (key === 'LocalNotifications') throw new Error('Desktop notification plugin lookup'); return undefined; } }); return { LocalNotifications: native }; } });
    w.eval(source);
    const app = { settings: { notifications:true, deadlineWarnings:true, calendarReminders:true, notificationSound:true, notificationVibration:true }, goals:[], notes:{}, habits:[], showToast() {} };
    const manager = new w.NotificationManager(app);
    return { w, manager, app, calls, channels, scheduled, pending: () => pending };
}
for (const platform of ['web','electron','ios']) test(`${platform}: zero native permission, channel or scheduling calls`, async t => {
    const h = fixture(t, platform);
    assert.equal(await h.manager.init(), false); assert.equal(await h.manager.requestPermissions(), false);
    assert.equal(await h.manager.checkPermissions(), false); assert.equal(await h.manager.sendTestNotification(), false);
    await h.manager.rescheduleAll(); await h.manager.cancelAll(); await h.manager.scheduleCalendarEvent({});
    assert.deepEqual(h.calls, []); assert.deepEqual(h.channels, []); assert.deepEqual(h.scheduled, []);
});
test('Android startup creates calendar channel without asking for notification permission', async t => {
    const h = fixture(t); await Promise.all([h.manager.init(),h.manager.init()]);
    assert.equal(h.calls.filter(call => call === 'request').length, 0);
    assert.equal(h.channels[0].id, 'calendar_reminders'); assert.equal(h.channels[0].name, 'События Календаря');
    assert.equal(h.channels.length, 1); assert.equal(h.channels[0].importance, 4);
    assert.equal(h.channels[0].sound, 'beep.wav'); assert.equal(h.channels[0].vibration, true);
});
test('Android test uses a native alarm three seconds later and survives a full refresh', async t => {
    const h = fixture(t); const before = Date.now();
    assert.equal(await h.manager.sendTestNotification(), true);
    const notification = h.scheduled[0];
    assert.ok(notification.schedule.at.getTime() >= before + 3000 && notification.schedule.at.getTime() < Date.now() + 3100);
    assert.equal(notification.schedule.allowWhileIdle, true); assert.equal(notification.isExactMandatory, true);
    assert.equal(notification.channelId, h.channels[0].id);
    await h.manager.rescheduleAll(); assert.ok(h.pending().some(n => n.id === notification.id));
});
test('Exact-alarm denial is honest: background alarms are inexact, 3-second test waits for permission', async t => {
    const h = fixture(t,'android',false);
    assert.equal(await h.manager.sendTestNotification(), false); assert.equal(h.scheduled.length, 0);
    assert.equal(h.w.document.getElementById('notificationExactPermissionBtn').hidden, false);
    await h.manager.schedule({id:12,title:'Calendar',schedule:{at:new Date(Date.now()+60000)},extra:{type:'calendar'}});
    assert.equal(h.scheduled[0].isExactNotification, false);
    assert.equal(await h.manager.requestExactPermission(), true);
    assert.equal(await h.manager.sendTestNotification(), true);
});
test('Calendar-only settings work and removing a note time cancels its old alarms', async t => {
    const h = fixture(t); await h.manager.init(); await h.manager.requestPermissions(); h.app.settings.deadlineWarnings=false;
    const date = new Date(Date.now()+86400000*3);const dateString = [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
    h.app.notes[dateString] = [{id:'note',content:'Meeting',time:'15:00'}];
    await h.manager.rescheduleAll();assert.equal(h.pending().length,1);
    assert.ok(h.pending().every(n=>n.extra.type==='calendar' && n.schedule.allowWhileIdle));
    await h.manager.scheduleCalendarEvent({id:'note',date:dateString,time:null});assert.equal(h.pending().length,0);
});
test('Goal, habit and streak entry points cannot schedule system notifications', async t => {
    const h = fixture(t);await h.manager.init();await h.manager.requestPermissions();
    await h.manager.scheduleGoalDeadline({id:'goal',title:'Goal',deadline:'2035-12-31',status:'active'});
    await h.manager.scheduleHabitReminders({id:'habit'}); await h.manager.scheduleStreakAlert();
    assert.equal(await h.manager.schedule({id:1,title:'No spam',extra:{type:'deadline'}}),false);
    assert.equal(h.scheduled.length,0);
});
test('Desktop app hides Android controls and never requests Web/Electron notification permission', async t => {
    const h = fixture(t,'web'); let desktopCalls=0;
    h.w.Notification={requestPermission(){desktopCalls++;},permission:'default'};
    h.w.electronAPI={showNotification(){desktopCalls++;}};
    h.w.eval(fs.readFileSync(path.join(root,'app.js'),'utf8').split('// ===== Initialize =====')[0]+'\nwindow.GoalTracker=GoalTracker;');
    h.w.GoalTracker.prototype.loadData=function(){this.user={id:'fixture',nickname:'Test'};this.settings.autoSync=false;};
    h.w.ProfileStorage={save:async()=>true};
    const app=new h.w.GoalTracker();
    assert.equal(app.notificationManager,null);assert.equal(h.w.document.getElementById('testNotificationBtn').hidden,true);
    await app.sendTestNotification();await app.requestNotificationPermission();app.showNotification('In-app only');
    assert.equal(desktopCalls,0);assert.deepEqual(h.calls,[]);
});

test('Saving an event asks permission once, schedules at its local time, and editing replaces its stable ID',async t=>{
    const h=fixture(t); const event={id:'meeting',title:'Встреча с другом',date:'2035-07-22',time:'14:30'};
    assert.equal(await h.manager.scheduleCalendarEvent(event),true);
    assert.equal(h.calls.filter(c=>c==='request').length,1);
    const first=h.pending()[0];assert.equal(first.title,'Календарь: Напоминание');assert.equal(first.body,'Встреча с другом в 14:30');
    assert.equal(first.schedule.at.getHours(),14);assert.equal(first.schedule.at.getMinutes(),30);
    assert.ok(first.id>0&&first.id<=2147483647);
    assert.equal(await h.manager.scheduleCalendarEvent({...event,time:'16:45'}),true);
    assert.equal(h.pending().length,1);assert.equal(h.pending()[0].id,first.id);assert.equal(h.pending()[0].schedule.at.getHours(),16);
    await h.manager.cancelCalendarEvent(event.id);assert.equal(h.pending().length,0);
});
test('Old goal/streak and duplicate calendar reminders are cancelled on startup',async t=>{
    const h=fixture(t);await h.manager.requestPermissions();
    const native=h.w.Capacitor.Plugins.LocalNotifications;
    await native.schedule({notifications:[{id:1,extra:{type:'deadline'}},{id:2,extra:{type:'streak'}},{id:3,extra:{type:'calendar',eventId:'old',timing:'30m'}}]});
    await h.manager.init();assert.equal(h.pending().length,0);
});
test('Background synchronization does not request permission even when timed events exist',async t=>{
    const h=fixture(t);h.app.notes={'2035-07-22':[{id:'remote-note',content:'Remote',time:'14:30'}]};
    await h.manager.rescheduleAll();assert.equal(h.calls.filter(c=>c==='request').length,0);assert.equal(h.pending().length,0);
});
test('Android application boot is quiet; only saving a timed calendar note asks permission',async t=>{
    const h=fixture(t);
    h.w.eval(fs.readFileSync(path.join(root,'app.js'),'utf8').split('// ===== Initialize =====')[0]+'\nwindow.GoalTracker=GoalTracker;');
    h.w.GoalTracker.prototype.loadData=function(){this.user={id:'fixture',nickname:'Test'};this.settings.autoSync=false;};
    h.w.ProfileStorage={save:async()=>true};
    const app=new h.w.GoalTracker();await app.notificationManager.init();await app.rescheduleAllNotifications();
    assert.equal(h.calls.filter(c=>c==='request').length,0);
    assert.equal(h.w.document.getElementById('streakAlertsEnabled'),null);
    assert.equal(h.w.document.getElementById('deadlineWarningsEnabled'),null);
    assert.equal(h.w.document.querySelectorAll('[data-calendar-channel-option][hidden]').length,2);
    await app.onNoteChanged({id:'form-note',content:'Meeting',time:'14:30'},'2035-07-22');
    assert.equal(h.calls.filter(c=>c==='request').length,1);
    assert.equal(h.pending()[0].title,'Календарь: Напоминание');
    await app.onGoalChanged({id:'goal',deadline:'2035-07-22'});assert.equal(h.pending().length,1);
});

test('Account transition prevents a delayed notification schedule from surviving logout cancellation',async t=>{
 const h=fixture(t);await h.manager.init();h.app._dataEpoch=1;let release;h.manager.checkPermissions=async()=>{await new Promise(r=>release=r);return true;};
 const scheduled=h.manager.schedule({id:999,title:'PRIVATE',body:'PRIVATE',extra:{type:'calendar'}});await new Promise(r=>setImmediate(r));
 h.app._dataEpoch++;h.app._accountTransition=true;const cleared=h.manager.cancelAll();release();assert.equal(await scheduled,false);await cleared;assert.equal(h.pending().length,0);assert.equal(h.scheduled.length,0);
});
