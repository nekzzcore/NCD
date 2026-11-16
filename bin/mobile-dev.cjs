/* Development only: LAN server + an isolated Capacitor Android project. */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const privateIPv4 = ip => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
function lanAddress(interfaces, requested) {
    const candidates = Object.entries(interfaces).flatMap(([name, entries]) =>
        entries.filter(e => !e.internal && (e.family === 'IPv4' || e.family === 4) && privateIPv4(e.address))
            .map(e => ({ name, address: e.address })));
    if (requested) {
        const match = candidates.find(e => e.name === requested || e.address === requested);
        if (!match) throw new Error('MOBILE_DEV_INTERFACE не соответствует локальному LAN IPv4.');
        return match.address;
    }
    const physical = candidates.filter(e => !/^(docker|veth|br-|virbr|tun|tap|wg|tailscale)/i.test(e.name));
    const choices = physical.length ? physical : candidates;
    if (choices.length !== 1) throw new Error('Не удалось однозначно выбрать LAN IPv4. Задайте MOBILE_DEV_INTERFACE именем Wi-Fi интерфейса.');
    return choices[0].address;
}

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4',
    '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.ico': 'image/x-icon' };
const browserReload = `<script>
// LAN HTTP may lack randomUUID, while getRandomValues remains available.
if (!crypto.randomUUID) crypto.randomUUID = () => {
 const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
 const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
 return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
};
const mobileReload = new EventSource('/__mobile_events');
mobileReload.addEventListener('reload', () => location.reload());
</script>`;

function devServer(webRoot, clients, { liveReload = true, tls = null } = {}) {
    const createServer = tls ? handler => require('node:https').createServer(tls, handler) : handler => http.createServer(handler);
    return createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
        let pathname;
        try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
        catch { res.writeHead(400); return res.end(); }
        if (liveReload && pathname === '/__mobile_events' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
            res.write(': connected\n\n'); clients.add(res);
            req.on('close', () => clients.delete(res)); return;
        }
        // Never serve the repository, database, credentials or sync API.
        if (pathname.split('/').some(part => part.startsWith('.')) || pathname.startsWith('/api/')) {
            res.writeHead(404); return res.end();
        }
        const file = path.resolve(webRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
        if (!file.startsWith(webRoot + path.sep)) { res.writeHead(403); return res.end(); }
        try {
            const real = await fsp.realpath(file);
            if (!real.startsWith(webRoot + path.sep)) { res.writeHead(403); return res.end(); }
            let data = await fsp.readFile(real);
            if (pathname === '/' || pathname === '/index.html') data = Buffer.from(data.toString().replace('</head>', (liveReload ? browserReload : browserReload.replace(/const mobileReload[\s\S]*?<\/script>/, '</script>')) + '</head>'));
            // Prevent a production OTA bundle from replacing this development session.
            if (pathname === '/app.js') data = Buffer.from(data.toString().replace(/async checkForWebUpdate\s*\([^)]*\)\s*\{/, match => match + ' return;'));
            res.setHeader('Content-Type', mime[path.extname(real)] || 'application/octet-stream');
            res.end(req.method === 'HEAD' ? undefined : data);
        } catch { res.writeHead(404); res.end(); }
    });
}

async function main() {
    if (process.argv.includes('--help')) {
        console.log('npm run mobile:dev [-- --target DEVICE_ID]\nOptional: MOBILE_DEV_INTERFACE=wlan0 MOBILE_DEV_PORT=8100');
        return;
    }
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 2 && args[0] === '--target' && args[1])) throw new Error('Поддерживается только --target DEVICE_ID.');
    const host = lanAddress(os.networkInterfaces(), process.env.MOBILE_DEV_INTERFACE);
    const port = Number(process.env.MOBILE_DEV_PORT || 8100);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('MOBILE_DEV_PORT должен быть от 1024 до 65535.');
    process.chdir(root);
    let temp, child, building = false, pending = false, stopping = false, timer;
    const clients = new Set(), watchers = [];
    const server = devServer(path.join(root, 'www'), clients);
    const run = (cmd, argv, cwd = root) => new Promise((resolve, reject) => {
        child = spawn(cmd, argv, { cwd, stdio: 'inherit', env: process.env });
        child.once('error', reject);
        child.once('exit', code => { child = null; code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} завершился с кодом ${code}`)); });
    });
    const cleanup = async () => {
        stopping = true; clearTimeout(timer); watchers.forEach(w => w.close());
        child?.kill('SIGTERM'); clients.forEach(res => res.end()); server.close();
        if (temp) await fsp.rm(temp, { recursive: true, force: true });
    };
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup().then(() => process.exit(0)); });
    try {
        await run('npm', ['run', 'build:web']);
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
        console.log(`\nLive Reload: http://${host}:${port}\nОткройте этот URL в браузере телефона для проверки Wi-Fi.\nТолько разработка; Ctrl+C — остановить.\n`);
        temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'goaltracker-mobile-dev-'));
        await fsp.chmod(temp, 0o700);
        await fsp.cp(path.join(root, 'android'), path.join(temp, 'android'), {
            recursive: true, filter: source => !['build', '.gradle', '.git'].includes(path.basename(source))
        });
        await fsp.symlink(path.join(root, 'node_modules'), path.join(temp, 'node_modules'), 'dir');
        await fsp.symlink(path.join(root, 'www'), path.join(temp, 'www'), 'dir');
        const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json')));
        await fsp.writeFile(path.join(temp, 'package.json'), JSON.stringify({ name: pkg.name + '-mobile-dev', version: pkg.version, dependencies: pkg.dependencies }));
        // Read the existing TS config without modifying it. The CLI's loader is local to installed Capacitor 8.
        const config = (await require('@capacitor/cli/dist/config').loadConfig()).app.extConfig;
        const devConfig = { ...config, appId: config.appId + '.dev', appName: config.appName,
            android: { ...config.android, webContentsDebuggingEnabled: true },
            server: { ...config.server, cleartext: true } };
        delete devConfig.server.url;
        await fsp.writeFile(path.join(temp, 'capacitor.config.json'), JSON.stringify(devConfig));
        const gradle = path.join(temp, 'android/app/build.gradle');
        const original = await fsp.readFile(gradle, 'utf8');
        const updated = original.replace(/applicationId\s+"[^"]+"/, `applicationId "${devConfig.appId}"`);
        if (original === updated) throw new Error('Не удалось задать отдельный applicationId dev-сборки.');
        await fsp.writeFile(gradle, updated);
        await fsp.appendFile(path.join(temp, 'android/gradle.properties'), '\norg.gradle.workers.max=2\n');
        const strings = path.join(temp, 'android/app/src/main/res/values/strings.xml');
        await fsp.writeFile(strings, (await fsp.readFile(strings, 'utf8')).replace(/(<string name="app_name">)[^<]*/, '$1NCD'));
        const cap = require.resolve('@capacitor/cli/bin/capacitor');
        // Sync only the temporary project. CLI will write server.url only there.
        await run(process.execPath, [cap, 'sync', 'android'], temp);
        child = spawn(process.execPath, [cap, 'run', 'android', '--no-sync', '--live-reload', '--host', host, '--port', String(port), ...args], { cwd: temp, stdio: 'inherit', env: process.env });
        const nativeChild = child;
        const rebuild = async () => {
            if (stopping) return;
            if (building) { pending = true; return; }
            building = true;
            try {
                // Separate child so a rebuild does not replace the native CLI handle.
                await new Promise((resolve, reject) => {
                    const build = spawn('npm', ['run', 'build:web'], { cwd: root, stdio: 'inherit' });
                    build.once('error', reject); build.once('exit', code => code === 0 ? resolve() : reject(new Error('Ошибка веб-сборки')));
                });
                if (!stopping) clients.forEach(res => res.write('event: reload\ndata: ready\n\n'));
            } catch (error) { console.error(error.message); }
            finally { building = false; if (pending) { pending = false; rebuild(); } }
        };
        const changed = () => { clearTimeout(timer); timer = setTimeout(rebuild, 350); };
        watchers.push(fs.watch(root, (_, file) => {
            if (file && /\.(js|html|css|json)$/.test(file) && !['avatar.js', 'profile-storage.js', 'package-lock.json'].includes(file)) changed();
        }));
        for (const dir of ['src', 'assets', 'vendor']) watchers.push(fs.watch(path.join(root, dir), { recursive: true }, changed));
        await new Promise((resolve, reject) => {
            nativeChild.once('error', reject);
            nativeChild.once('exit', code => code === 0 ? resolve() : reject(new Error('Capacitor завершился с ошибкой. Проверьте ADB, Java и вывод Gradle выше.')));
        });
    } finally { await cleanup(); }
}

module.exports = { lanAddress, devServer };
if (require.main === module) main().catch(error => { console.error('mobile:dev:', error.message); process.exitCode = 1; });
