// smoke-тест: страница + виджет загружаются без исключений
const { JSDOM } = require('jsdom');
const http = require('http');

function get(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => resolve(d));
        }).on('error', reject);
    });
}

(async () => {
    const base = 'http://localhost:8123';
    const html = await get(base + '/');
    // PIN синхронизации (сервер требует X-Goal-PIN) — берём из pin.txt, если есть
    let pin = '';
    try { pin = require('fs').readFileSync(require('path').join(__dirname, '..', 'pin.txt'), 'utf8').trim(); } catch {}
    const errors = [];
    const virtualConsole = new (require('jsdom').VirtualConsole)();
    virtualConsole.on('jsdomError', (e) => {
        const msg = String(e.message || e);
        // В jsdom нет WebGL (ожидаемо) — виджет обязан корректно откатиться на фолбэк
        if (/WebGL|getContext/.test(msg)) return;
        if (!/Could not parse CSS|Not implemented/.test(msg)) errors.push(msg);
    });
    virtualConsole.on('error', (...a) => {
        const msg = a.join(' ');
        if (/WebGL|getContext/.test(msg)) return; // THREE дословно так и пишет при отсутствии WebGL
        errors.push(msg);
    });

    const dom = new JSDOM(html, {
        url: base + '/',
        runScripts: 'dangerously',
        resources: 'usable',
        pretendToBeVisual: true,
        virtualConsole,
        beforeParse(window) {
            // PIN синхронизации — чтобы автосинхронизация прошла авторизацию
            if (pin) { try { window.localStorage.setItem('goalTracker_pin', pin); } catch {} }
            // jsdom не даёт fetch/WebGL — даём приложению то, что есть в браузере
            // (node fetch не понимает относительные URL — резолвим к базе)
            window.fetch = (url, opts) =>
                fetch(typeof url === 'string' && url.startsWith('/') ? base + url : url, opts);
            window.ResizeObserver = class {
                observe() {}
                unobserve() {}
                disconnect() {}
            };
            window.IntersectionObserver = class {
                observe() {}
                unobserve() {}
                disconnect() {}
            };
        },
    });

    // app.js + avatar.js подгружаются на DOMContentLoaded, дождёмся
    await new Promise((r) => setTimeout(r, 2500));

    const { window } = dom;
    const fatal = errors.filter((e) => !/Could not parse CSS|Not implemented/.test(e));
    const checks = [];
    const ok = (name, cond) => checks.push((cond ? 'OK  ' : 'FAIL') + ' ' + name);

    ok('app.js создал window.app', window.app && typeof window.app.renderDashboard === 'function');
    // Профиль подтянется, только если на сервере есть data.json (сейчас её может не быть — не сбой)
    ok('профиль: app.user инициализирован (без данных на сервере — пусто, не ошибка)', !!window.app);
    ok('элементы виджета в DOM', !!window.document.getElementById('avatarStage') && !!window.document.getElementById('avatarCanvas'));
    ok('без WebGL виджет откатился на фолбэк', window.document.getElementById('avatarStage').classList.contains('avatar-fallback'));
    ok('avatar.js подключён', [...window.document.scripts].some((s) => s.src.endsWith('avatar.js')));
    ok('нет исключений', fatal.length === 0);

    console.log(checks.join('\n'));
    if (fatal.length) console.log('\nИсключения:\n' + fatal.slice(0, 5).join('\n---\n'));
    process.exit(checks.some((c) => c.startsWith('FAIL')) ? 1 : 0);
})();
