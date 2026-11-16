// Общие веб-ассеты для PWA и Capacitor; исходники — в корне проекта.
const fs = require('fs');
const { createHash } = require('node:crypto');
const esbuild = require('esbuild');
const path = require('path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const root = path.join(__dirname, '..');
const scripts = ['ios-layout.js', 'workspace.js', 'case.js', 'learning.js', 'goals.js', 'achievements.js', 'ota-sync.js', 'ui-select.js', 'app.js', 'supabase-config.js', 'sync.js', 'finance.js', 'health.js', 'health-3d.js', 'gamification.js', 'notifications.js', 'auth_sync.js', 'avatar.js', 'profile-storage.js', 'sw.js'];
async function prepare() {
const logo = path.join(root, 'assets/logo.png');
const suppliedLogo = path.join(root, 'public/assets/logo.png');
if (!fs.existsSync(logo) && fs.existsSync(suppliedLogo)) fs.copyFileSync(suppliedLogo, logo);
if (!fs.existsSync(logo)) console.log('NCD logo asset is missing; text fallback remains active.');
for (const file of scripts) await run(process.execPath, ['--check', path.join(root, file)]);
for (const file of ['body_scan.mp4', 'body_preview.jpg']) {
    if (!fs.statSync(path.join(root, 'assets/avatar', file)).size) throw new Error(`Empty media: ${file}`);
}
// CSS is compiled locally; no CDN/Tailwind runtime is needed.
const result = await esbuild.build({ entryPoints: [path.join(root, 'styles.css')], bundle: true, minify: true, target: ['safari15'], write: false, logLevel: 'warning' });
const css = result.outputFiles[0].text;
if (!css.trim() || /@import\s/.test(css)) throw new Error('Compiled CSS must be self-contained');
const cssHash = createHash('sha256').update(css).digest('hex').slice(0, 12);
const stylesheet = `./styles.css?v=${cssHash}`;
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace('href="./styles.css"', `href="${stylesheet}"`);
if (!html.includes(stylesheet)) throw new Error('Missing main stylesheet link');
const buildHash = createHash('sha256').update(html).update(css).update(scripts.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n')).digest('hex').slice(0, 12);
const worker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8').replace("'./styles.css',", `'${stylesheet}',`).replace(/(const CACHE_NAME = '[^']+)';/, `$1-${buildHash}';`);
const files = ['manifest.json', 'favicon.ico', ...scripts,
    ...fs.readdirSync(root).filter(name => /^icon.*\.(png|svg|ico)$/.test(name))];
// dist also contains native releases: only clean the dedicated web output.
fs.rmSync(path.join(root, 'dist/web'), { recursive: true, force: true });
for (const directory of ['public', 'www', 'dist/web']) {
    const destination = path.join(root, directory);
    if (directory === 'www') fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(destination, { recursive: true });
    for (const obsolete of ['social.js', 'chat.js']) fs.rmSync(path.join(destination, obsolete), { force: true });
    for (const file of files) fs.copyFileSync(path.join(root, file), path.join(destination, file));
    fs.writeFileSync(path.join(destination, 'styles.css'), css);
    fs.writeFileSync(path.join(destination, 'index.html'), html);
    fs.writeFileSync(path.join(destination, 'sw.js'), worker);
    fs.copyFileSync(path.join(root, 'web-hosting/_headers'), path.join(destination, '_headers'));
    fs.cpSync(path.join(root, 'assets'), path.join(destination, 'assets'), { recursive: true });
    // Локальный three.js (вендор) — нужен для offline-работы 3D-сцены через import map
    fs.cpSync(path.join(root, 'vendor'), path.join(destination, 'vendor'), { recursive: true });
    console.log(`${directory}: web assets ready`);
}

}
prepare().catch(error => { console.error(error); process.exitCode = 1; });
