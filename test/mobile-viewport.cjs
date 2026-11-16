// Проверка адаптивности GoalTracker Pro на реальном Chrome (headless)
// Запуск: node test/mobile-viewport.cjs
// Ширины: 360, 390, 412 (мобильные) и 1280 (десктоп). Темы: dark, light.
// Перед запуском: поднят сервер `node server.js 8090`, установлен puppeteer-core.
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const BASE = process.env.MOBILE_BASE || 'http://127.0.0.1:8090';
const SHOTS = process.env.MOBILE_SHOTS || '/tmp/opencode/shots';
fs.mkdirSync(SHOTS, { recursive: true });

const seedData = (theme) => ({
  schemaVersion: 1,
  profileReset: false,
  user: { id: 'test-user-1', nickname: 'Тест', createdAt: new Date().toISOString() },
  goals: [
    {
      id: 'g1', title: 'Пробежать марафон', description: 'Осенняя подготовка', status: 'active', priority: 'high',
      subgoals: [
        { id: 's1', title: 'Записаться на полумарафон', done: false },
        { id: 's2', title: 'Купить кроссовки', done: true }
      ],
      createdAt: new Date().toISOString(), deadline: '2026-12-31'
    },
    {
      id: 'g2', title: 'Прочитать 12 книг за год — очень длинное название цели для проверки переноса строк',
      description: '', status: 'active', priority: 'medium', subgoals: [],
      createdAt: new Date().toISOString()
    }
  ],
  achievements: [],
  habits: [],
  events: [],
  notes: {},
  settings: { theme },
  gamification: { level: 3, xp: 120, hp: 90 },
  updatedAt: new Date().toISOString()
});

const WIDTHS = [360, 390, 412, 1280];
const THEMES = ['dark', 'light'];

async function measure(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const vw = window.innerWidth;
    const horizOverflow = de.scrollWidth - de.clientWidth;
    const offenders = [];
    document.querySelectorAll('body *').forEach((el) => {
      if (el.closest('.modal') && !el.closest('.modal.active')) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      if (r.right > vw + 1 || r.left < -1) {
        const cls = (typeof el.className === 'string' ? el.className : '').split(' ').filter(Boolean).slice(0, 2).join('.');
        offenders.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''} L=${Math.round(r.left)} R=${Math.round(r.right)}`);
      }
    });
    const nav = document.querySelector('.bottom-nav');
    const side = document.querySelector('.sidebar');
    return {
      horizOverflow,
      navVisible: !!(nav && getComputedStyle(nav).display !== 'none'),
      sidebarVisible: !!(side && getComputedStyle(side).display !== 'none'),
      offenders: offenders.slice(0, 6)
    };
  });
}

(async () => {
  const errors = [];
  const report = [];

  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      console.log(`... ${theme} ${width}px`);
      // Отдельный браузер с чистым профилем: service worker из прошлой итерации
      // может тормозить повторные навигации, поэтому не реиспользуем профиль.
      const browser = await puppeteer.launch({
        executablePath: process.env.CHROME || '/usr/bin/google-chrome',
        headless: 'new',
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--disable-gpu', '--disable-software-rasterizer']
      });
      const page = await browser.newPage();
      page.setDefaultTimeout(20000);
      page.on('pageerror', (e) => errors.push(`[${width}/${theme}] JS-ошибка: ` + e.message));
      page.on('console', (m) => {
        if (m.type() === 'error' && !/favicon|sw\.js|Service worker/.test(m.text())) errors.push(`[${width}/${theme}] console: ` + m.text());
      });
      await page.setViewport({ width, height: 800, isMobile: width < 700, hasTouch: width < 700, deviceScaleFactor: 1 });
      // Профиль в localStorage-зеркале до скриптов приложения
      await page.evaluateOnNewDocument((s) => {
        localStorage.clear();
        localStorage.setItem('goalTracker_data', s);
      }, JSON.stringify(seedData(theme)));
      await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 20000 });
      try {
        await page.waitForFunction(() => document.getElementById('app')?.style.display === 'flex', { timeout: 10000 });
      } catch { /* ниже учтём appShown=false */ }
      await new Promise((r) => setTimeout(r, 1200));

      const appShown = await page.evaluate(() => document.getElementById('app')?.style.display === 'flex');
      const base = await measure(page);

      // Проходим все разделы
      const views = [];
      const viewSelectors = await page.evaluate(() =>
        [...document.querySelectorAll('.bottom-nav .bottom-nav-item, .nav-item')]
          .map((b) => ({ view: b.dataset.view, sel: b.dataset.view ? `[data-view="${b.dataset.view}"]` : null }))
          .filter((v) => v.view && v.sel)
      );
      for (const v of viewSelectors) {
        await page.evaluate((sel) => document.querySelector(sel).click(), v.sel);
        await new Promise((r) => setTimeout(r, 350));
        const m = await measure(page);
        views.push({ view: v.view, ...m });
      }

      // Модалка редактирования профиля
      await page.evaluate(() => document.querySelector('[data-view="profile"]')?.click());
      await new Promise((r) => setTimeout(r, 300));
      await page.evaluate(() => document.getElementById('profileEditModal')?.classList.add('active'));
      await new Promise((r) => setTimeout(r, 200));
      const modal = await page.evaluate(() => {
        const mc = document.querySelector('#profileEditModal .modal-content');
        if (!mc) return null;
        const r = mc.getBoundingClientRect();
        return { fits: r.left >= 0 && r.right <= window.innerWidth, top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight };
      });
      await page.evaluate(() => document.getElementById('profileEditModal')?.classList.remove('active'));

      report.push({
        theme, width, appShown,
        horizOverflow: base.horizOverflow,
        nav: { navVisible: base.navVisible, sidebarVisible: base.sidebarVisible },
        offenders: [...base.offenders, ...views.filter((v) => v.horizOverflow > 0 || v.offenders.length).flatMap((v) => v.offenders.slice(0, 3))],
        modal,
        viewOverflows: views.filter((v) => v.horizOverflow > 0).map((v) => ({ view: v.view, overflow: v.horizOverflow }))
      });
      await page.screenshot({ path: path.join(SHOTS, `${theme}-${width}.png`) });
      await page.close();
      await browser.close();
    }
  }

  fs.writeFileSync(path.join(SHOTS, 'mobile-report.json'), JSON.stringify({ report, errors }, null, 2));

  let fail = false;
  for (const r of report) {
    const tag = `${r.theme}/${r.width}px`;
    const badMobile = r.width < 700 && !r.nav.navVisible;
    const bad = !r.appShown || r.horizOverflow > 0 || r.offenders.length || badMobile || (r.modal && !r.modal.fits);
    if (bad) fail = true;
    const navInfo = r.width < 700 ? `nav=${r.nav.navVisible}` : `sidebar=${r.nav.sidebarVisible}`;
    console.log(`${bad ? '✖' : '✔'} ${tag}: app=${r.appShown} overflowX=${r.horizOverflow} ${navInfo} offenders=${r.offenders.length} modal=${r.modal ? (r.modal.fits ? 'fits' : 'NO-FITS') : 'n/a'}`);
    if (r.viewOverflows.length) console.log('   viewOverflows:', JSON.stringify(r.viewOverflows));
    if (r.offenders.length) console.log('   offenders:', JSON.stringify(r.offenders.slice(0, 5)));
    if (r.modal && !r.modal.fits) console.log('   modal:', JSON.stringify(r.modal));
  }
  console.log('JS/console errors:', errors.length ? errors : 'нет');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SCRIPT FAIL:', e.message); process.exit(2); });
