// Run: node test/calendar-mobile.cjs. Screenshots/report: /tmp/calendar-mobile.
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
(async () => {
    const root = path.join(__dirname, '..');
    const out = process.env.CALENDAR_SHOTS || '/tmp/calendar-mobile';
    fs.mkdirSync(out, { recursive: true });
    const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const results = [], errors = [];
    try {
        const page = await browser.newPage();
        page.on('pageerror', e => errors.push(e.message));
        await page.setRequestInterception(true);
        page.on('request', req => req.respond({ status: 200, contentType: 'text/html', body: '<!doctype html>' }));
        for (const width of [360, 390, 430, 1280]) {
            await page.setViewport({ width, height: 800, isMobile: width <= 600, hasTouch: width <= 600 });
            await page.goto('https://calendar.test');
            const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
            await page.setContent(html);
            await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'styles.css'), 'utf8') });
            await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'app.js'), 'utf8').split('// ===== Initialize =====')[0] + '\nwindow.GoalTracker=GoalTracker;' });
            await page.evaluate(() => {
                const app = Object.create(window.GoalTracker.prototype);
                Object.assign(app, { currentView: 'calendar', currentMonth: new Date(2026, 9, 1), selectedDate: '2026-10-17', goals: [], events: [], notes: { '2026-10-17': [{ id: 'n', content: 'ОченьДлиннаяЗапись'.repeat(20), time: '12:00' }] }, setHealth3DActive() {} });
                window.app = app;
                document.getElementById('app').style.display = 'flex';
                app.switchView('calendar');
            });
            const metrics = await page.evaluate(() => {
                const grid = document.querySelector('.calendar-grid').getBoundingClientRect();
                const cells = [...document.querySelectorAll('.calendar-day')].map(el => el.getBoundingClientRect());
                const header = document.querySelector('.mobile-app-header').getBoundingClientRect();
                const nav = document.querySelector('.calendar-nav').getBoundingClientRect();
                const controls = document.querySelector('.mobile-header-actions');
                const before = document.querySelector('#view-calendar .calendar-grid-card').getBoundingClientRect().top;
                const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
                return {
                    overflow, columns: getComputedStyle(document.querySelector('.calendar-grid')).gridTemplateColumns.split(' ').length,
                    cellsFit: cells.every(r => r.left >= grid.left - 1 && r.right <= grid.right + 1),
                    equalSizes: Math.max(...cells.map(r => r.width)) - Math.min(...cells.map(r => r.width)) < 1 && new Set(cells.map(r => r.height)).size === 1,
                    headerInFlow: !['fixed', 'absolute'].includes(getComputedStyle(controls).position),
                    noOverlap: header.bottom <= nav.top && nav.bottom <= before,
                    mobileTitle: document.querySelector('#mobileScreenTitle').textContent,
                    scrollTopBefore: window.scrollY
                };
            });
            await page.screenshot({ path: path.join(out, `${width}.png`), fullPage: true });
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            const verticalScroll = await page.evaluate(() => ({ scrollY: window.scrollY, scrollX: window.scrollX }));
            results.push({ width, ...metrics, ...verticalScroll });
        }
        fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ results, errors }, null, 2));
        if (errors.length || results.some(r => r.overflow > 0 || r.columns !== 7 || !r.cellsFit || !r.equalSizes || r.scrollX !== 0 || (r.width <= 600 && (!r.headerInFlow || !r.noOverlap || r.scrollY <= 0)))) throw new Error('Calendar verification failed; inspect report.json');
        console.log('PASS: 360/390/430/1280 px');
    } finally { await browser.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
