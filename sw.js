const CACHE_NAME = 'goaltracker-v62-conditional-form-views';
const STATIC_ASSETS = [
    './',
    './index.html',
    './styles.css',
    './assets/ncd-compass.svg',
    './app.js',
    './ios-layout.js',
    './icon-180.png',
    './icon-180.png?v=compass-1',
    './workspace.js',
    './case.js',
    './learning.js',
    './goals.js',
    './achievements.js',
    './ui-select.js',
    './ota-sync.js',
    './supabase-config.js',
    './sync.js',
    './vendor/supabase/supabase.js',
    './finance.js',
    './assets/custodian.png',
    './health.js',
    './health-3d.js',
    './vendor/three/three.module.js',
    './vendor/three/three.core.js',
    './vendor/three/addons/controls/OrbitControls.js',
    './vendor/three/addons/loaders/GLTFLoader.js',
    './vendor/three/addons/utils/BufferGeometryUtils.js',
    './vendor/three/addons/utils/SkeletonUtils.js',
    './profile-storage.js',
    './gamification.js',
    './notifications.js',
    './auth_sync.js',
    './avatar.js',
    './manifest.json',
    './icon.png',
    './icon.ico',
    './favicon.ico',
    './icon-48.png',
    './icon-192.png',
    './icon-512.png',
    './icon-192-maskable.png',
    './icon-512-maskable.png',
    './icon.svg',
    './assets/ncd-app-icon.svg',
    ...['favicon.ico', 'icon-48.png', 'icon-192.png', 'icon-512.png',
        'icon-192-maskable.png', 'icon-512-maskable.png', 'icon.svg']
        .map(name => `./${name}?v=compass-1`)
];

// Install — принудительно кэшируем ВСЕ статические файлы
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('[SW] Caching all static assets for offline-first');
                return cache.addAll(STATIC_ASSETS);
            })
            .then(() => caches.open(CACHE_NAME).then(cache => Promise.all([
                './assets/logo.png',
                './assets/avatar/body_scan.mp4',
                './assets/avatar/body_preview.jpg'
            ].map(url => cache.add(url).catch(() => {})))))
            .then(() => {
                console.log('[SW] Install complete, skipping waiting');
                return self.skipWaiting();
            })
            .catch(err => {
                console.error('[SW] Install failed:', err);
                throw err; // Keep the previous worker if the new shell is incomplete.
            })
    );
});

// Activate — чистим старые кэши и берём контроль над клиентами
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME && /^goaltracker-v\d+-/.test(k)).map(k => {
                console.log('[SW] Deleting old cache:', k);
                return caches.delete(k);
            }))
        ).then(() => {
            console.log('[SW] Activating, claiming clients');
            return self.clients.claim();
        })
    );
});

// Stale-While-Revalidate для ВСЕХ запросов (offline-first)
self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);
    if (url.pathname.startsWith('/api/') || url.pathname === '/__mobile_events' || url.pathname.endsWith('/version.json') || url.pathname.includes('/updates/')) return;
    if (event.request.headers.has('authorization') || /^\/(?:auth|rest|storage)\/v1(?:\/|$)/.test(url.pathname)) return;
    const isNavigation = event.request.mode === 'navigate';
    const isSameOrigin = url.origin === self.location.origin;

    // Игнорируем cross-origin запросы (не кэшируем их)
    if (!isSameOrigin) {
        event.respondWith(fetch(event.request).catch(() => new Response('', { status: 504 })));
        return;
    }

    // MP4: полная копия в кэше, отдельные 206-ответы для видеоплеера.
    // Ошибка видео не должна мешать установке PWA или загрузке интерфейса.
    if (url.pathname.endsWith('.mp4')) {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE_NAME);
            const cached = await cache.match(url.href);
            if (!cached) {
                return fetch(event.request).catch(() => new Response('', { status: 503 }));
            }
            const range = event.request.headers.get('Range');
            if (!range) return cached;
            const blob = await cached.blob();
            const match = /^bytes=(\d*)-(\d*)$/.exec(range);
            let start = 0;
            let end = blob.size - 1;
            if (match && (match[1] || match[2])) {
                start = match[1] ? Number(match[1]) : Math.max(0, blob.size - Number(match[2]));
                end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
            }
            if (!match || !(match[1] || match[2]) || !Number.isSafeInteger(start) ||
                !Number.isSafeInteger(end) || start > end || start >= blob.size) {
                return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
            }
            return new Response(blob.slice(start, end + 1), {
                status: 206,
                headers: {
                    'Content-Type': 'video/mp4',
                    'Content-Length': String(end - start + 1),
                    'Content-Range': `bytes ${start}-${end}/${blob.size}`,
                    'Accept-Ranges': 'bytes'
                }
            });
        })());
        return;
    }

    // Keep the worker alive until the refreshed static asset is written.
    const network = caches.open(CACHE_NAME).then(async cache => {
        const response = await fetch(event.request);
        if (response.ok) await cache.put(event.request, response.clone());
        return response;
    }).catch(() => null);
    event.waitUntil(network.then(() => {}));
    event.respondWith(caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        const response = await network;
        if (response) return response;
        if (isNavigation) {
            const shell = await cache.match('./index.html');
            if (shell) return shell;
        }
        return new Response('Offline: resource not cached', {
            status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
    }));
});

// Push notifications (оставляем как было)
self.addEventListener('push', event => {
    const data = event.data ? event.data.json() : {};
    const title = data.title || 'NCD';
    const options = {
        body: data.body || 'У вас есть обновления по целям',
        icon: 'icon-192.png',
        badge: 'icon-48.png',
        vibrate: [200, 100, 200],
        tag: 'goaltracker-notification',
        renotify: true
    };
    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
            for (const client of clientList) {
                if (client.url.includes(self.location.origin) && 'focus' in client) {
                    return client.focus();
                }
            }
            return clients.openWindow('./');
        })
    );
});

// Обработка сообщений от клиента (skipWaiting на команду)
self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});
