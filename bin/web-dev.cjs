/* Browser/PWA development, without Electron, Android SDK or a sync API. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { devServer } = require('./mobile-dev.cjs');
const root = path.resolve(__dirname, '..');
function options(args, env = process.env) {
    const result = { host: env.NCD_WEB_HOST || '0.0.0.0', port: Number(env.NCD_WEB_PORT || 8100) };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--host') result.host = args[i+1] && !args[i+1].startsWith('--') ? args[++i] : '0.0.0.0';
        else if (args[i] === '--port' && args[i+1]) result.port = Number(args[++i]);
        else throw new Error(`Неизвестный аргумент: ${args[i]}. Используйте --host [IP] и --port PORT.`);
    }
    if (!Number.isInteger(result.port) || result.port < 1024 || result.port > 65535) throw new Error('Порт должен быть от 1024 до 65535.');
    if (!!env.NCD_HTTPS_CERT !== !!env.NCD_HTTPS_KEY) throw new Error('Задайте одновременно NCD_HTTPS_CERT и NCD_HTTPS_KEY.');
    if (env.NCD_HTTPS_CERT) result.tls = { cert: fs.readFileSync(env.NCD_HTTPS_CERT), key: fs.readFileSync(env.NCD_HTTPS_KEY) };
    return result;
}
async function main() {
    if (process.argv.includes('--help')) {
        console.log('npm run dev -- --host [IP] --port 8100\nБез Android SDK. По умолчанию: 0.0.0.0:8100.\nHTTPS: NCD_HTTPS_CERT=/path/cert.pem NCD_HTTPS_KEY=/path/key.pem npm run web');
        return;
    }
    const config = options(process.argv.slice(2));
    await new Promise((resolve, reject) => {
        const child = spawn('npm', ['run', 'build:web'], { cwd: root, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Веб-сборка завершилась с кодом ${code}`)));
    });
    const server = devServer(path.join(root, 'www'), new Set(), { liveReload: false, tls: config.tls });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
    const protocol = config.tls ? 'https' : 'http';
    console.log(`\nNCD: ${protocol}://localhost:${config.port}`);
    if (config.host === '0.0.0.0' || config.host === '::') {
        for (const entries of Object.values(os.networkInterfaces())) for (const entry of entries || []) {
            if (!entry.internal && entry.family === 'IPv4') console.log(`Телефон в той же Wi-Fi сети: ${protocol}://${entry.address}:${config.port}`);
        }
    } else console.log(`Адрес: ${protocol}://${config.host}:${config.port}`);
    console.log('PWA: localhost или HTTPS с доверенным сертификатом. LAN HTTP: работа в браузере.\nПосле изменения исходников: npm run build:web и обновить страницу. Ctrl+C — остановить.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
}
module.exports = { options };
if (require.main === module) main().catch(error => { console.error('NCD web:', error.message); process.exitCode = 1; });
