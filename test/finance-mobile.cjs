// Isolated real-browser verification of production finance markup and CSS.
const puppeteer = require('puppeteer-core');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
    const output = process.env.FINANCE_SHOTS || '/tmp/finance-mobile';
    fs.mkdirSync(output, { recursive: true });
    const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const report = [];
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.setRequestInterception(true);
        page.on('request', request => request.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main class="main-content"><div id="view-finance" class="view active"><div id="financeMain"></div></div></main>' }));
        for (const width of [360, 390, 430, 1280]) {
            await page.setViewport({ width, height: 900, isMobile: width <= 600, hasTouch: width <= 600 });
            await page.goto('https://finance.test');
            await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8') });
            await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../finance.js'), 'utf8') });
            await page.evaluate(() => window.renderFinanceView());
            for (const populated of [false, true]) {
                if (populated) await page.evaluate(() => {
                    window.finance.replaceData({ investments: { assets: [{ symbol: 'TEST', name: 'ОченьДлинноеНазваниеАктива'.repeat(4), quantity: 2, buyPrice: 100, currentPrice: 120 }] }, growth: { baseIncome: 50000, currentIncome: 70000, ideas: [{ title: 'ДлиннаяИдея'.repeat(12) }] } });
                });
                for (const step of ['accounting', 'budget', 'safety', 'investments', 'income']) {
                    await page.evaluate(step => document.querySelector(`[data-finance-step="${step}"]`).click(), step);
                    await new Promise(resolve => setTimeout(resolve, 300));
                    const metrics = await page.evaluate(() => {
                        const strip = document.querySelector('.finance-tabs').getBoundingClientRect();
                        const active = document.querySelector('.finance-tab.active').getBoundingClientRect();
                        const overflow = [...document.querySelectorAll('.finance-panel *')].filter(el => {
                            const r = el.getBoundingClientRect();
                            return r.width && r.height && (r.right > innerWidth + 1 || r.left < -1);
                        }).map(el => el.className || el.tagName);
                        return { pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, activeVisible: active.left >= strip.left && active.right <= strip.right, overflow };
                    });
                    report.push({ width, populated, step, ...metrics });
                    await page.screenshot({ path: path.join(output, `${width}-${step}-${populated ? 'data' : 'empty'}.png`), fullPage: true });
                }
            }
        }
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ report, errors }, null, 2));
        if (errors.length || report.some(r => r.pageOverflow > 0 || r.overflow.length || !r.activeVisible)) throw new Error('Finance layout verification failed; see report.json');
        console.log('PASS: 40 panel/data/viewport combinations');
    } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
