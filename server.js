// ===== NCD — статический сервер + API синхронизации =====
// Запуск: node server.js [порт]
// GET  /api/data  — получить данные
// POST /api/data  — сохранить данные (побеждает более свежий updatedAt)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2] || process.env.PORT || '8000', 10);
const ROOT = __dirname;
// Упакованный app.asar доступен только для чтения.
const electronApp = process.versions.electron ? require('electron').app : null;
const DATA_ROOT = electronApp?.isPackaged ? electronApp.getPath('userData') : ROOT;
const DATA_FILE = path.join(DATA_ROOT, 'data.json');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.mp4': 'video/mp4',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.bin': 'application/octet-stream',
    '.wasm': 'application/wasm'
};

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readData() {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch { return null; }
}

// ===== Код доступа (PIN) =====
const PIN_FILE = path.join(DATA_ROOT, 'pin.txt');
function getPin() {
    try {
        const pin = fs.readFileSync(PIN_FILE, 'utf8').trim();
        if (/^\d{4,8}$/.test(pin)) return pin;
    } catch {}
    const pin = String(Math.floor(1000 + Math.random() * 9000)); // 4 цифры
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(PIN_FILE, pin + '\n', { mode: 0o600 });
    return pin;
}
function checkPin(req) {
    const pin = getPin();
    const given = req.headers['x-goal-pin'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    return given === pin;
}

const server = http.createServer((req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const remote = req.socket.remoteAddress || '?';
    if (!req.url.startsWith('/api/data') || req.method !== 'POST') {
        console.log(`[http] ${remote} ${req.method} ${req.url}`);
    }

    // API синхронизации (защищено кодом доступа)
    if (req.url.startsWith('/api/data')) {
        if (!checkPin(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ status: 'pin_required' }));
        }
        if (req.method === 'GET') {
            const data = readData();
            res.writeHead(data ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(data ? JSON.stringify(data) : '{"error":"no data"}');
        }
        if (req.method === 'POST') {
            let body = '';
            req.on('data', c => { body += c; if (body.length > 5e6) req.destroy(); });
            req.on('end', () => {
                try {
                    const incoming = JSON.parse(body);
                    const baseUpdatedAt = incoming.baseUpdatedAt;
                    delete incoming.baseUpdatedAt;
                    const current = readData();

                    // Конфликт, если клиент отстал от сервера:
                    // 1) его версия старее или 2) он правил данные, прочитанные до последней записи
                    const stale = current && current.updatedAt && (
                        (incoming.updatedAt && incoming.updatedAt < current.updatedAt) ||
                        (baseUpdatedAt && baseUpdatedAt < current.updatedAt)
                    );
                    if (stale) {
                        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
                        return res.end(JSON.stringify({ status: 'stale', server: current }));
                    }

                    fs.writeFileSync(DATA_FILE, JSON.stringify(incoming, null, 2));
                    console.log(`[sync] данные сохранены (${incoming.updatedAt}) base=${baseUpdatedAt || '-'}`);
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ status: 'ok' }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ status: 'error', message: e.message }));
                }
            });
            return;
        }
        res.writeHead(405); return res.end();
    }

    // Статические файлы
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.join(ROOT, path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, ''));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end(); }

    // Видео отдаём потоком с поддержкой Range (Android/WebKit, повтор и перемотка).
    if (path.extname(filePath) === '.mp4') {
        return fs.stat(filePath, (err, stat) => {
            if (err || !stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
            const headers = { 'Content-Type': MIME['.mp4'], 'Accept-Ranges': 'bytes' };
            let start = 0;
            let end = stat.size - 1;
            const range = req.headers.range;
            if (range) {
                const match = /^bytes=(\d*)-(\d*)$/.exec(range);
                if (match && (match[1] || match[2])) {
                    start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
                    end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
                }
                if (!match || !(match[1] || match[2]) || !Number.isSafeInteger(start) ||
                    !Number.isSafeInteger(end) || start > end || start >= stat.size) {
                    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
                    return res.end();
                }
                headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
            }
            headers['Content-Length'] = Math.max(0, end - start + 1);
            res.writeHead(range ? 206 : 200, headers);
            if (req.method === 'HEAD' || stat.size === 0) return res.end();
            const stream = fs.createReadStream(filePath, { start, end });
            stream.on('error', () => res.destroy());
            res.on('close', () => stream.destroy());
            stream.pipe(res);
        });
    }

    fs.readFile(filePath, (err, buf) => {
        if (err) {
            // Запросы к файлам с расширением не отдаём как HTML (иначе ломается загрузка .glb и пр.)
            if (path.extname(urlPath)) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                return res.end('Not found');
            }
            // SPA fallback
            return fs.readFile(path.join(ROOT, 'index.html'), (e2, b2) => {
                if (e2) { res.writeHead(404); return res.end('Not found'); }
                res.writeHead(200, { 'Content-Type': MIME['.html'] });
                res.end(b2);
            });
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(buf);
    });
});

function start(port) {
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`[sync] порт ${port} занят — сервер уже запущен`);
        } else {
            console.log('[sync] ошибка сервера:', err.message);
        }
    });
    server.listen(port, '0.0.0.0', () => {
        const nets = require('os').networkInterfaces();
        const ips = Object.values(nets).flat().filter(n => n.family === 'IPv4' && !n.internal).map(n => n.address);
        console.log('==============================================');
        console.log('  🎯 NCD сервер запущен!');
        console.log('==============================================');
        console.log(`  На этом компьютере:  http://localhost:${port}`);
        ips.forEach(ip => console.log(`  С телефона (Wi-Fi):   http://${ip}:${port}`));
        console.log('  Синхронизация:       POST/GET /api/data');
        console.log(`  🔑 Код доступа:      ${getPin()}`);
        console.log('  Вне дома:            ./tunnel.sh (публичная ссылка)');
        console.log('  Остановить: Ctrl+C');
        console.log('==============================================');
    });
    return server;
}

if (require.main === module) start(PORT);
module.exports = { start, getPin };
