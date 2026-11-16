// Реальные перезапуски Electron и смена веб-бандла, с изолированными данными.
// node test/profile.persistence.cjs
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const root = path.join(__dirname, '..');
const temporary = fs.mkdtempSync('/tmp/opencode/goaltracker-persistence-');
let server;

async function run(mode, phase, base) {
    const child = spawn(require('electron'), [path.join(__dirname, 'profile.phase.cjs'), mode, phase, base, temporary], {
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const [code] = await once(child, 'exit');
    if (code !== 0) throw new Error(`${mode}/${phase}: ${output}`);
    console.log(`PASS ${mode}/${phase}`);
}

(async () => {
    const fixture = path.join(temporary, 'web');
    fs.mkdirSync(fixture);
    for (const file of fs.readdirSync(root)) {
        if (/\.(js|html|css|png|svg|json)$/.test(file) && !['data.json', 'package-lock.json'].includes(file)) {
            fs.copyFileSync(path.join(root, file), path.join(fixture, file));
        }
    }
    fs.cpSync(path.join(root, 'assets'), path.join(fixture, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'blank.html'), '<!doctype html><title>Migration</title>');
    server = require(path.join(fixture, 'server.js')).start(0);
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const mode of ['electron', 'web']) {
        for (const file of ['app.js', 'sw.js']) fs.copyFileSync(path.join(root, file), path.join(fixture, file));
        for (const phase of ['create', 'restart', 'update', 'reset', 'after-reset', 'migration', 'corrupt']) {
            if (phase === 'update') {
                const appFile = path.join(fixture, 'app.js');
                fs.writeFileSync(appFile, fs.readFileSync(appFile, 'utf8').replace(/const APP_VERSION = '[^']+'/,
                    "const APP_VERSION = '9.9.9'"));
                const swFile = path.join(fixture, 'sw.js');
                fs.writeFileSync(swFile, fs.readFileSync(swFile, 'utf8').replace(/const CACHE_NAME = '[^']+'/,
                    `const CACHE_NAME = 'profile-test-update-${mode}'`));
            }
            await run(mode, phase, base);
        }
    }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    server?.close();
    fs.rmSync(temporary, { recursive: true, force: true });
});
