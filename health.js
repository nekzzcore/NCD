(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.GoalTrackerHealth = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const STORAGE_KEY = 'goalTracker_health_local_v1';
    const ACCOUNT_STORAGE_KEY = 'goalTracker_health_account_v1';
    const REQUESTED_TYPES = ['steps', 'heartRate', 'sleep', 'weight'];

    class HealthService {
        constructor({ platform = 'web', adapter = null, storage = null, now = () => new Date() } = {}) {
            this.platform = platform;
            this.adapter = adapter;
            this.storage = storage;
            this.now = now;
            this.generation = 0;
            this.state = this.readLocal();
        }

        emptyState() {
            return { connected: false, metrics: {}, lastReadAt: null, status: 'idle' };
        }

        readLocal() {
            if (!this.storage) return this.emptyState();
            try {
                const deviceData = this.storage.getItem(STORAGE_KEY);
                const parsed = JSON.parse(deviceData || this.storage.getItem(ACCOUNT_STORAGE_KEY) || 'null');
                if (!parsed || typeof parsed !== 'object') return this.emptyState();
                return {
                    connected: !!deviceData && parsed.connected === true,
                    metrics: parsed.metrics && typeof parsed.metrics === 'object' ? parsed.metrics : {},
                    lastReadAt: typeof parsed.lastReadAt === 'string' ? parsed.lastReadAt : null,
                    status: 'idle'
                };
            } catch (_) {
                return this.emptyState();
            }
        }

        persist() {
            if (!this.storage) return;
            const localOnly = {
                connected: this.state.connected,
                metrics: this.state.metrics,
                lastReadAt: this.state.lastReadAt
            };
            this.storage.setItem(STORAGE_KEY, JSON.stringify(localOnly));
            const cloudValue = JSON.stringify({metrics:this.state.metrics,lastReadAt:this.state.lastReadAt});
            const changed = !!this.state.lastReadAt && this.storage.getItem(ACCOUNT_STORAGE_KEY) !== cloudValue;
            if (changed) this.storage.setItem(ACCOUNT_STORAGE_KEY,cloudValue);
            if (changed && typeof document !== 'undefined' && typeof window !== 'undefined' && this.storage === window.localStorage) {
                document.dispatchEvent(new Event('goaltracker:health-changed'));
            }
        }

        isAndroid() {
            return this.platform === 'android' && !!this.adapter;
        }

        async checkAvailability() {
            const generation = this.generation;
            if (!this.isAndroid()) {
                this.state.status = 'platform-unavailable';
                return this.state;
            }
            const result = await this.adapter.getAvailability();
            if (generation !== this.generation) return this.state;
            this.state.status = result.status === 'available' ? (this.state.connected ? 'connected' : 'ready') : 'unavailable';
            this.state.availability = result.status;
            return this.state;
        }

        async connect() {
            const generation = this.generation;
            if (!this.isAndroid()) {
                this.state.status = 'platform-unavailable';
                return this.state;
            }
            const availability = await this.adapter.getAvailability();
            if (generation !== this.generation) return this.state;
            if (availability.status !== 'available') {
                this.state.status = 'unavailable';
                this.state.availability = availability.status;
                return this.state;
            }
            const result = await this.adapter.requestPermissions({ types: REQUESTED_TYPES });
            if (generation !== this.generation) return this.state;
            const granted = Array.isArray(result.granted) ? result.granted : [];
            this.state.connected = granted.length > 0;
            this.state.status = this.state.connected ? 'connected' : 'permission-denied';
            this.state.granted = granted;
            this.persist();
            return this.state;
        }

        async sync() {
            const generation = this.generation;
            if (!this.isAndroid()) {
                this.state.status = 'platform-unavailable';
                return this.state;
            }
            const availability = await this.adapter.getAvailability();
            if (generation !== this.generation) return this.state;
            if (availability.status !== 'available') {
                this.state.status = 'unavailable';
                return this.state;
            }
            const permissionResult = await this.adapter.getPermissions();
            if (generation !== this.generation) return this.state;
            const granted = Array.isArray(permissionResult.granted) ? permissionResult.granted : [];
            if (!granted.length) {
                this.state.connected = false;
                this.state.status = 'permission-denied';
                this.persist();
                return this.state;
            }
            const result = await this.adapter.readLatest({ types: granted });
            if (generation !== this.generation) return this.state;
            this.state.metrics = sanitizeMetrics(result && result.metrics);
            this.state.lastReadAt = this.now().toISOString();
            this.state.connected = true;
            this.state.granted = granted;
            this.state.status = Object.keys(this.state.metrics).length ? 'data' : 'empty';
            this.persist();
            return this.state;
        }

        clearAccount() {
            this.generation++; this.state = this.emptyState(); this.storage?.removeItem(STORAGE_KEY);
            this.storage?.removeItem(ACCOUNT_STORAGE_KEY);
        }

        clearLocal() {
            this.generation++;
            this.state.metrics = {};
            this.state.lastReadAt = null;
            this.state.status = this.state.connected ? 'connected' : 'idle';
            this.persist();
            return this.state;
        }

        async disconnect() {
            const generation = this.generation;
            if (this.isAndroid()) await this.adapter.revokePermissions();
            this.state = this.emptyState();
            if (this.storage) this.storage.removeItem(STORAGE_KEY);
            return this.state;
        }
    }

    function sanitizeMetrics(metrics) {
        if (!metrics || typeof metrics !== 'object') return {};
        const result = {};
        for (const type of REQUESTED_TYPES) {
            const metric = metrics[type];
            if (!metric || typeof metric !== 'object' || typeof metric.value !== 'number' || !Number.isFinite(metric.value)) continue;
            result[type] = {
                value: metric.value,
                unit: typeof metric.unit === 'string' ? metric.unit : '',
                source: typeof metric.source === 'string' ? metric.source : '',
                measuredAt: typeof metric.measuredAt === 'string' ? metric.measuredAt : null
            };
        }
        return result;
    }

    function browserPlatform() {
        if (typeof window === 'undefined') return 'web';
        if (window.electronAPI) return 'electron';
        const capacitor = window.Capacitor;
        if (capacitor?.isNativePlatform?.() && capacitor.getPlatform?.() === 'android') return 'android';
        return 'web';
    }

    function nativeAdapter() {
        const plugin = typeof window !== 'undefined' ? window.Capacitor?.Plugins?.HealthConnect : null;
        if (!plugin) return null;
        return {
            getAvailability: () => plugin.getAvailability(),
            getPermissions: () => plugin.getPermissions(),
            requestPermissions: options => plugin.requestPermissions(options),
            readLatest: options => plugin.readLatest(options),
            revokePermissions: () => plugin.revokePermissions()
        };
    }

    function formatMetric(type, metric) {
        if (!metric) return '—';
        if (type === 'steps') return Math.round(metric.value).toLocaleString('ru-RU');
        if (type === 'heartRate') return `${Math.round(metric.value)} уд/мин`;
        if (type === 'sleep') {
            const minutes = Math.max(0, Math.round(metric.value));
            return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
        }
        if (type === 'weight') return `${metric.value.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} кг`;
        return '—';
    }

    function createView(service, doc) {
        const statusText = {
            idle: 'Не подключено',
            ready: 'Доступно для подключения',
            connected: 'Подключено. Нажмите «Синхронизировать».',
            data: 'Показатели обновлены',
            empty: 'Доступ разрешён, но данных пока нет',
            'permission-denied': 'Разрешение не предоставлено. Его можно выдать в настройках Health Connect.',
            unavailable: 'Health Connect отсутствует или требует обновления',
            'platform-unavailable': 'Доступно только в Android-приложении'
        };
        let busy = false;

        const view = {
            clearAccount() { service.clearAccount(); view.render(); },
            restoreAccount() { service.generation++; service.state = service.readLocal(); view.render(); },
            async init() {
                const image = doc.getElementById('healthAvatarImage');
                image?.addEventListener('error', () => {
                    image.hidden = true;
                    const fallback = doc.getElementById('healthAvatarFallback');
                    if (fallback) fallback.hidden = false;
                });
                doc.getElementById('healthConnectBtn')?.addEventListener('click', () => view.perform('connect'));
                doc.getElementById('healthSyncBtn')?.addEventListener('click', () => view.perform('sync'));
                doc.getElementById('healthClearBtn')?.addEventListener('click', () => { service.clearLocal(); view.render(); });
                doc.getElementById('healthDisconnectBtn')?.addEventListener('click', () => view.perform('disconnect'));
                try { await service.checkAvailability(); } catch (_) { service.state.status = 'unavailable'; }
                view.render();
            },
            async perform(action) {
                if (busy) return;
                busy = true;
                view.render();
                try { await service[action](); }
                catch (_) { service.state.status = action === 'connect' ? 'permission-denied' : 'unavailable'; }
                busy = false;
                view.render();
            },
            render() {
                if (!service.storage?.getItem(STORAGE_KEY) && service.storage?.getItem(ACCOUNT_STORAGE_KEY)) service.state = service.readLocal();
                const state = service.state;
                const status = doc.getElementById('healthStatus');
                if (status) status.textContent = busy ? 'Подождите…' : (!service.isAndroid() && Object.keys(state.metrics).length ? 'Показатели аккаунта из облака' : (statusText[state.status] || statusText.idle));
                const connect = doc.getElementById('healthConnectBtn');
                const sync = doc.getElementById('healthSyncBtn');
                const disconnect = doc.getElementById('healthDisconnectBtn');
                if (connect) { connect.disabled = busy || !service.isAndroid(); connect.hidden = state.connected; }
                if (sync) sync.disabled = busy || !service.isAndroid() || !state.connected;
                if (disconnect) disconnect.disabled = busy || !service.isAndroid() || !state.connected;
                const last = doc.getElementById('healthLastSync');
                if (last) last.textContent = 'Последнее успешное чтение: ' + (state.lastReadAt ? new Date(state.lastReadAt).toLocaleString('ru-RU') : '—');
                for (const type of REQUESTED_TYPES) {
                    const node = doc.querySelector(`[data-health-metric="${type}"]`);
                    const metric = state.metrics[type];
                    if (!node) continue;
                    node.querySelector('.health-metric-value').textContent = formatMetric(type, metric);
                    node.querySelector('.health-metric-source').textContent = 'Источник: ' + (metric?.source || '—');
                }
            }
        };
        return view;
    }

    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        const service = new HealthService({ platform: browserPlatform(), adapter: nativeAdapter(), storage: window.localStorage });
        const view = createView(service, document);
        window.healthView = view;
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => view.init(), { once: true });
        else void view.init();
    }

    return { HealthService, STORAGE_KEY, REQUESTED_TYPES, sanitizeMetrics, formatMetric, createView };
});
