// Быстрые скриншоты вкладки "Финансы" на 412px и 1280px + разметка виновников
const puppeteer = require('puppeteer-core');

const seedData = () => ({
  schemaVersion: 1, profileReset: false,
  user: { id: 'u1', nickname: 'Тест', createdAt: new Date().toISOString() },
  goals: [], achievements: [], habits: [], events: [], notes: {},
  settings: { theme: 'dark' }, gamification: { level: 3, xp: 120, hp: 90 },
  finance: undefined,
  updatedAt: new Date().toISOString()
});

(async () => {
  for (const [width, h] of [[412, 900], [1280, 1000]]) {
    const browser = await puppeteer.launch({
      executablePath: '/usr/bin/google-chrome', headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--disable-gpu', '--disable-software-rasterizer']
    });
    const page = await browser.newPage();
    await page.setViewport({ width, height: h, isMobile: width < 700, hasTouch: width < 700, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument((s) => { localStorage.clear(); localStorage.setItem('goalTracker_data', s); }, JSON.stringify(seedData()));
    await page.goto('http://127.0.0.1:8090/index.html', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise((r) => setTimeout(r, 1200));
    await page.evaluate(() => document.querySelector('[data-view="finance"]')?.click());
    await new Promise((r) => setTimeout(r, 700));
    const info = await page.evaluate(() => {
      const list = [];
      document.querySelectorAll('#view-finance *').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width && (r.right > window.innerWidth + 1)) {
          const cls = (typeof el.className === 'string' ? el.className : '').split(' ').filter(Boolean).slice(0, 2).join('.');
          list.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''} L=${Math.round(r.left)} R=${Math.round(r.right)}`);
        }
      });
      return list.slice(0, 15);
    });
    console.log(`=== ${width}px offenders ===`);
    info.forEach((i) => console.log('  ', i));
    await page.screenshot({ path: `/tmp/opencode/finance-${width}.png` });
    await browser.close();
  }
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
