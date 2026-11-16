// ===== NCD — Cloudflare Worker (облачный сервер + OTA Updates) =====
// Раздаёт статику приложения + API синхронизации на KV-хранилище + OTA обновления.

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Goal-PIN, Authorization'
};

const DATA_KEY = 'data';
const VERSION_KEY = 'version';
const UPDATE_KEY = 'updates';

// Текущая версия приложения (обновляется при деплое)
const APP_VERSION = '1.3.39';

function json(status, obj) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS }
    });
}

function pinOk(request, env) {
    const pin = env.SYNC_PIN || '';
    if (!pin) return false;
    const given = request.headers.get('x-goal-pin')
        || (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    return given === pin;
}

async function handleApi(request, env) {
    if (!pinOk(request, env)) return json(401, { status: 'pin_required' });

    if (request.method === 'GET') {
        const data = await env.SYNC.get(DATA_KEY, 'json');
        return data ? json(200, data) : json(404, { error: 'no data' });
    }

    if (request.method === 'POST') {
        let incoming;
        try {
            incoming = await request.json();
        } catch (e) {
            return json(400, { status: 'error', message: e.message });
        }
        const baseUpdatedAt = incoming.baseUpdatedAt;
        delete incoming.baseUpdatedAt;
        const current = await env.SYNC.get(DATA_KEY, 'json');

        // Конфликт, если клиент отстал от сервера (LWW + защита от записи по старой базе)
        const stale = current && current.updatedAt && (
            (incoming.updatedAt && incoming.updatedAt < current.updatedAt) ||
            (baseUpdatedAt && baseUpdatedAt < current.updatedAt)
        );
        if (stale) return json(409, { status: 'stale', server: current });

        await env.SYNC.put(DATA_KEY, JSON.stringify(incoming));
        return json(200, { status: 'ok' });
    }

    return new Response(null, { status: 405, headers: CORS });
}

// OTA: отдаём информацию о версии
async function handleVersion(request, env) {
    const versionData = await env.SYNC.get(VERSION_KEY, 'json') || {
        version: APP_VERSION,
        minVersion: APP_VERSION,
        updateUrl: 'https://goaltracker-pro.nekzzcore.workers.dev/updates/latest.zip',
        changelog: 'Обновления интерфейса и исправления ошибок',
        mandatory: false,
        timestamp: new Date().toISOString()
    };
    return json(200, versionData);
}

// OTA: отдаём архив обновления (capgo/capacitor-updater формат)
async function handleUpdateBundle(request, env) {
    const url = new URL(request.url);
    const version = url.searchParams.get('version') || 'latest';
    
    // Пытаемся достать бандл из KV
    const updateData = await env.SYNC.get(`${UPDATE_KEY}:${version}`, 'arrayBuffer');
    if (updateData) {
        return new Response(updateData, {
            status: 200,
            headers: {
                'Content-Type': 'application/zip',
                'Content-Disposition': `attachment; filename="update-${version}.zip"`,
                'Cache-Control': 'no-store',
                ...CORS
            }
        });
    }
    
    return json(404, { error: 'Update bundle not found' });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS });
        }

        // API синхронизации
        if (url.pathname.startsWith('/api/data')) {
            return handleApi(request, env);
        }

        // OTA: версия
        if (url.pathname === '/version.json' || url.pathname === '/api/version') {
            return handleVersion(request, env);
        }

        // OTA: бандл обновления
        if (url.pathname.startsWith('/api/update') || url.pathname.startsWith('/updates/')) {
            return handleUpdateBundle(request, env);
        }

        // Статика приложения (assets binding)
        let resp = await env.ASSETS.fetch(request);
        if (resp.status === 404 && !url.pathname.includes('.')) {
            resp = await env.ASSETS.fetch(new URL('/index.html', url.origin).toString());
        }
        return resp;
    }
};
