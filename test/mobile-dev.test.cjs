const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { lanAddress, devServer } = require('../bin/mobile-dev.cjs');

test('LAN selection rejects loopback/public addresses and ambiguous networks', () => {
    const entry = address => ({ address, family: 'IPv4', internal: false });
    const interfaces = { wlan0: [entry('192.168.20.4')], docker0: [entry('172.17.0.1')], lo: [{ ...entry('127.0.0.1'), internal: true }] };
    assert.equal(lanAddress(interfaces), '192.168.20.4');
    assert.equal(lanAddress(interfaces, 'wlan0'), '192.168.20.4');
    assert.throws(() => lanAddress({ eth0: [entry('8.8.8.8')] }));
    assert.throws(() => lanAddress({ wlan0: interfaces.wlan0, eth0: [entry('10.0.0.2')] }));
    assert.throws(() => lanAddress(interfaces, 'unknown'));
});

// Invoke the HTTP handler without binding a network socket (works inside sandbox).
function request(server, url, method = 'GET') {
    return new Promise(resolve => {
        const req = Object.assign(new EventEmitter(), { url, method });
        const res = { status: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
            writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body: body?.toString() || '', headers: this.headers }); } };
        server.emit('request', req, res);
    });
}

test('Dev server injects reload only into responses and blocks secrets/API/symlinks', async t => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'goaltracker-dev-test-'));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    const www = path.join(temp, 'www'); await fs.mkdir(www);
    const html = '<html><head></head><body>GoalTracker</body></html>';
    const app = 'class App { async checkForWebUpdate({ force = false } = {}) {} }';
    await fs.writeFile(path.join(www, 'index.html'), html);
    await fs.writeFile(path.join(www, 'app.js'), app);
    await fs.writeFile(path.join(temp, 'secret.txt'), 'PRIVATE');
    await fs.symlink(path.join(temp, 'secret.txt'), path.join(www, 'escape.txt'));
    const server = devServer(www, new Set());
    const index = await request(server, '/');
    assert.match(index.body, /EventSource/); assert.equal(index.headers['Cache-Control'], 'no-store');
    assert.match((await request(server, '/app.js')).body, /checkForWebUpdate\(\{ force = false \} = \{\}\) \{ return;/);
    for (const url of ['/.env', '/%2eenv', '/api/data', '/escape.txt', '/../secret.txt']) assert.ok((await request(server, url)).status >= 400, url);
    assert.equal((await request(server, '/', 'POST')).status, 405);
    assert.equal(await fs.readFile(path.join(www, 'index.html'), 'utf8'), html);
    assert.equal(await fs.readFile(path.join(www, 'app.js'), 'utf8'), app);
});

test('Browser server serves the same app without requiring live reload or Android', async t => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ncd-browser-test-'));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    await fs.writeFile(path.join(temp, 'index.html'), '<html><head></head><body>NCD</body></html>');
    const server = devServer(temp, new Set(), { liveReload: false });
    const index = await request(server, '/');
    assert.equal(index.status, 200);assert.match(index.body, /randomUUID/);assert.doesNotMatch(index.body, /EventSource/);
    assert.equal((await request(server, '/api/data')).status, 404);
});
