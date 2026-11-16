const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

test('habit UI and initialization hooks are removed', () => {
    assert.doesNotMatch(html, /data-view=["']habits["']/);
    assert.doesNotMatch(html, /id=["']view-habits["']/);
    assert.doesNotMatch(html, /id=["']habitModal["']/);
    assert.doesNotMatch(html, /id=["']habitRemindersEnabled["']/);
    assert.doesNotMatch(app, /renderHabits|checkMissedHabits|openHabitModal|saveHabit/);
});

test('all supported routes remain available', () => {
    const views = ['goals', 'calendar', 'finance', 'health', 'achievements'];
    for (const view of views) {
        assert.match(html, new RegExp(`id=["']view-${view}["']`));
        assert.match(html, new RegExp(`data-view=["']${view}["']`));
        assert.match(app, new RegExp(`['"]${view}['"]`));
    }
});

test('legacy habit data is still preserved for compatibility', () => {
    assert.match(app, /habits:\s*this\.habits/);
    assert.match(app, /Array\.isArray\(data\.habits\)/);
});

test('Sidebar includes desktop modules; mobile navigation has five primary destinations', () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(html); const d = dom.window.document;
    try {
        for (const scope of ['.sidebar-nav', '.bottom-nav']) {
            const expected = scope === '.sidebar-nav' ? ['goals','calendar','learning','case','finance','health','achievements'] : ['goals','calendar','finance','health','achievements'];
            assert.deepEqual([...d.querySelectorAll(`${scope} [data-view]`)].map(el => el.dataset.view), expected);
            assert.equal(d.querySelector(`${scope} .active`).dataset.view, 'goals');
            assert.equal(d.querySelectorAll(`${scope} .active`).length, 1);
            assert.equal(d.querySelector(`${scope} [data-view="profile"]`), null);
        }
        assert.deepEqual([...d.querySelectorAll('.view.active')].map(el => el.id), ['view-goals']);
        assert.doesNotMatch(html, /data-view=["']dashboard["']/);
    } finally { dom.window.close(); }
});

test('Actual startup opens goals and clicks in each menu select the corresponding screen', t => {
    const { JSDOM, VirtualConsole } = require('jsdom'); const errors=[]; const vc=new VirtualConsole();
    vc.on('jsdomError',e=>errors.push(String(e)));vc.on('error',(...args)=>errors.push(args.join(' ')));
    const dom=new JSDOM(html,{url:'https://navigation.invalid/',runScripts:'outside-only',virtualConsole:vc});
    t.after(()=>{assert.deepEqual(errors,[]);dom.window.close();});const w=dom.window,d=w.document;
    w.eval(app.split('// ===== Initialize =====')[0]+'\nwindow.GoalTracker=GoalTracker;');
    w.eval(fs.readFileSync(path.join(root,'gamification.js'),'utf8'));
    // Only replace profile loading; execute the real constructor, init, binding and rendering.
    w.GoalTracker.prototype.loadData=function(){this.user={id:'test',nickname:'Fixture'};this.settings.autoSync=false;this.settings.notifications=false;this.settings.gamification=false;};
    // Dynamic ES module loading is outside this jsdom navigation test.
    w.GoalTracker.prototype.setHealth3DActive=function(){};
    w.ProfileStorage={save:async data=>{w.localStorage.setItem('goalTracker_data',JSON.stringify(data));}};
    const instance=new w.GoalTracker();w.app=instance;
    assert.equal(instance.currentView,'goals');
    for (const gear of ['settingsBtn','mobileSettingsBtn']) {
        d.getElementById(gear).click();
        assert.ok(d.getElementById('settingsModal').classList.contains('active'));
        assert.equal(d.querySelector('#settingsUserCard .profile-info h2').textContent,'Fixture');
        assert.ok(d.querySelector('#settingsModal #chooseProfileAvatar'));
        assert.ok(d.querySelector('#settingsModal #profileAvatarFile'));
        assert.match(d.getElementById('profileContent').textContent,/Всего целей/);
        assert.equal(d.getElementById('view-profile'),null);
        assert.equal(instance.currentView,'goals');
        instance.closeModal('settingsModal');
    }
    for(const scope of ['.sidebar-nav','.bottom-nav']) {
        for(const button of d.querySelectorAll(`${scope} [data-view]`)) {
            button.click();assert.equal(instance.currentView,button.dataset.view);
            assert.equal(d.getElementById('mobileScreenTitle'), null);
            assert.equal(d.querySelectorAll('.mobile-app-header .ncd-brand').length,1);
            assert.equal(d.querySelectorAll('.mobile-app-header .ncd-name').length,1);
            assert.deepEqual([...d.querySelectorAll('.mobile-app-header button')].map(button => button.id), ['mobileSettingsBtn', 'mobileThemeBtn']);
            assert.ok(d.querySelector('#mainContent .mobile-app-header #mobileSettingsBtn'));
            assert.ok(d.querySelector('#mainContent .mobile-app-header #mobileThemeBtn'));
            assert.deepEqual([...d.querySelectorAll('.view.active')].map(el=>el.id),['view-'+button.dataset.view]);
            for(const menu of ['.sidebar-nav','.bottom-nav']) {
                const expected = d.querySelector(`${menu} [data-view="${button.dataset.view}"]`) ? button.dataset.view : undefined;
                assert.equal(d.querySelector(`${menu} .active`)?.dataset.view,expected);
            }
        }
    }
    instance.switchView('social');assert.equal(instance.currentView,'goals');
    instance.switchView('habits');assert.equal(instance.currentView,'goals');
    instance.switchView('profile');assert.equal(instance.currentView,'goals');
    w.matchMedia=()=>({matches:true});
    for(const desktopView of ['case','learning']) { instance.switchView(desktopView);assert.equal(instance.currentView,'goals'); }
});
