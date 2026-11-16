// Serve the exact production output; no script injection or OTA rewriting.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '../www');
const port = Number(process.env.PORT || 8100);
const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.mp4':'video/mp4', '.jpg':'image/jpeg', '.glb':'model/gltf-binary', '.wasm':'application/wasm' };
http.createServer(async (req, res) => {
    try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const file = path.resolve(root, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
        if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
        const real = await fs.realpath(file);
        if (!real.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
        const data = await fs.readFile(real);
        res.writeHead(200, { 'Content-Type': types[path.extname(real)] || 'application/octet-stream', 'Cache-Control':'no-store' });
        res.end(req.method === 'HEAD' ? undefined : data);
    } catch { res.writeHead(404); res.end(); }
}).on('error', error => { console.error(`Production preview failed: ${error.code} ${error.message}`); process.exitCode = 1; }).listen(port, '127.0.0.1', () => console.log(`NCD production preview: http://127.0.0.1:${port}`));
