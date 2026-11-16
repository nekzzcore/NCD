const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const { start } = require('../server');

app.disableHardwareAcceleration();
const testData = fs.mkdtempSync('/tmp/opencode/goaltracker-navigation-');
app.setPath('userData', testData);

let server;
let win;
const errors = [];
const timeout = setTimeout(() => {
    console.error('Navigation smoke test timed out');
    app.exit(1);
}, 30000);

app.whenReady().then(async () => {
    server = start(0);
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;

    win = new BrowserWindow({ show: false, webPreferences: { partition: 'navigation-smoke' } });
    win.webContents.debugger.attach('1.3');
    win.webContents.debugger.on('message', (_, method, params) => {
        if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails);
    });
    const evaluate = code => win.webContents.executeJavaScript(code);

    await win.loadURL(base);
    await win.webContents.debugger.sendCommand('Runtime.enable');
    for (let attempt = 0; attempt < 100; attempt++) {
        if (await evaluate('window.app instanceof GoalTracker')) break;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    await evaluate(`window.ProfileStorage.save({
        user: { nickname: 'Smoke', avatar: '😊', createdAt: new Date().toISOString() },
        habits: [{ id: 'legacy-habit', title: 'Legacy' }],
        settings: { autoSync: false, notifications: false, habitReminders: true }
    })`);
    await win.loadURL(base);
    for (let attempt = 0; attempt < 100; attempt++) {
        if (await evaluate('window.app instanceof GoalTracker')) break;
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    const result = await evaluate(`(() => {
        const views = ['dashboard', 'goals', 'achievements', 'calendar', 'profile', 'finance', 'social', 'health'];
        const active = {};
        for (const view of views) {
            app.switchView(view);
            active[view] = document.getElementById('view-' + view)?.classList.contains('active') === true;
        }
        app.switchView('habits');
        return {
            active,
            fallback: app.currentView,
            habitElements: document.querySelectorAll('[data-view="habits"], #view-habits, #habitModal').length,
            legacyDataPreserved: app.habits.some(habit => habit.id === 'legacy-habit'),
            habitReminders: app.settings.habitReminders
        };
    })()`);

    assert.deepEqual(Object.values(result.active), Array(7).fill(true));
    assert.equal(result.fallback, 'profile');
    assert.equal(result.habitElements, 0);
    assert.equal(result.legacyDataPreserved, true);
    assert.equal(result.habitReminders, false);
    assert.deepEqual(errors, []);
    console.log('PASS navigation without habits or renderer exceptions');
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    clearTimeout(timeout);
    win?.destroy();
    server?.close();
    fs.rmSync(testData, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
});
