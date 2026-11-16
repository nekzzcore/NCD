import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

// Export the registered Capacitor proxy before sync.js initializes the SDK.
window.NCDNativeStorage = { preferences: Preferences, isNative: () => Capacitor.isNativePlatform() };

const KEY = 'goalTracker_data';
const ACCOUNT_PREFIX = 'gt-account-data-v1:';
let backend;
let snapshot = null;
let queue = Promise.resolve();
let lastIssuedRevision = 0;
let storageEpoch = 0;
let clearing = false;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function readLocalMirror() {
    try {
        return { data: JSON.parse(localStorage.getItem(KEY) || 'null'), error: null };
    } catch (error) {
        return { data: null, error };
    }
}

function localStorageBackend() {
    return {
        read: async () => readLocalMirror().data,
        write: async data => {
            localStorage.setItem(KEY, JSON.stringify(data));
        }
    };
}

async function readWithRetry(read) {
    try {
        return { data: await read(), error: null };
    } catch (firstError) {
        console.warn('[profile] read failed, retrying in 300ms:', firstError?.message || 'unknown');
        await wait(300);
        try {
            return { data: await read(), error: null };
        } catch (secondError) {
            return { data: null, error: secondError || firstError };
        }
    }
}

function migrate(data) {
    if (data === null) return null;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Повреждён формат профиля');
    if (data.schemaVersion > 1) throw new Error('Профиль создан более новой версией приложения');
    if (data.user != null && (typeof data.user !== 'object' || typeof data.user.nickname !== 'string')) {
        throw new Error('Повреждён профиль пользователя');
    }
    for (const field of ['goals', 'habits', 'events', 'achievements']) {
        if (data[field] !== undefined && !Array.isArray(data[field])) throw new Error('Повреждены данные: ' + field);
    }
    if (data.workspace !== undefined && (!data.workspace || typeof data.workspace !== 'object' || ['portfolio','eloHistory','books','topics'].some(key => !Array.isArray(data.workspace[key])))) throw new Error('Повреждены данные модулей');
    const result = { ...data, schemaVersion: 1 };
    if (data.user) result.user = { ...data.user, id: data.user.id || snapshot?.user?.id || crypto.randomUUID() };
    return result;
}

async function browserBackend() {
    const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('goaltracker-profile', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('profile');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Хранилище занято другим окном'));
    });
    function transaction(mode, value, key = KEY) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction('profile', mode);
            const store = tx.objectStore('profile');
            const request = mode === 'readonly' ? store.get(key) : store.put(value, key);
            tx.oncomplete = () => resolve(request.result ?? null);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Сохранение прервано'));
        });
    }
    return { read: () => transaction('readonly'), write: data => transaction('readwrite', data),
        readAccount: identity => transaction('readonly', undefined, ACCOUNT_PREFIX + identity),
        writeAccount: (identity, data) => transaction('readwrite', data, ACCOUNT_PREFIX + identity) };
}

let backendName = 'unknown';
window.ProfileStorage = {
    async open({ preferCache = false } = {}) {
        const mirror = readLocalMirror();
        try {
            if (window.electronAPI?.readProfile) {
                backendName = 'electron-file';
                backend = { read: window.electronAPI.readProfile, write: window.electronAPI.writeProfile };
            } else if (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('Preferences')) {
                backendName = 'capacitor-preferences';
                backend = {
                    read: async () => { const { value } = await Preferences.get({ key: KEY }); return value ? JSON.parse(value) : null; },
                    write: data => Preferences.set({ key: KEY, value: JSON.stringify(data) })
                };
            } else {
                backendName = 'indexeddb';
                try {
                    backend = await browserBackend();
                } catch (firstError) {
                    console.warn('[profile] storage open failed, retrying in 300ms:', firstError?.message || 'unknown');
                    await wait(300);
                    backend = await browserBackend();
                }
            }
        } catch (error) {
            console.warn('[profile] durable storage unavailable; using local mirror:', error?.message || 'unknown');
            backendName = 'localstorage-fallback';
            backend = localStorageBackend();
        }

        // Android/Electron have a synchronous backend selection. The local mirror
        // already contains the last owned profile; do not wait for a plugin read/write.
        if (preferCache && mirror.data?.user && !mirror.data.profileReset) {
            try { snapshot = migrate(mirror.data); return snapshot; } catch {}
        }
        const durableResult = await readWithRetry(backend.read);
        if (durableResult.error) {
            // Не рискуем перезаписывать временно занятый файл: в этой сессии пишем
            // только в зеркало. При следующем запуске более свежая revision мигрирует назад.
            console.warn('[profile] durable read unavailable; continuing from local mirror:', durableResult.error?.message || 'unknown');
            backendName += '+localstorage-fallback';
            backend = localStorageBackend();
        }
        const durable = durableResult.data;
        const legacy = mirror.data;
        // Зеркало восстанавливает последнее изменение после аварийного закрытия до async-записи.
        let data = durable;
        if (data === null || (legacy?.storageRevision || 0) > (data.storageRevision || 0)) data = legacy;
        if (!data?.user && !data?.profileReset && window.electronAPI?.readLegacyProfile) {
            const recovered = await window.electronAPI.readLegacyProfile();
            if (recovered?.user) data = data ? { ...data, user: recovered.user } : recovered;
        }
        try {
            snapshot = migrate(data);
        } catch (error) {
            // Повреждение/ошибка durable-профиля не блокирует запуск, если зеркало читается.
            console.warn('[profile] primary snapshot invalid; trying local mirror:', error?.message || 'unknown');
            try { snapshot = migrate(legacy); }
            catch (mirrorError) {
                console.warn('[profile] local mirror unavailable; starting without profile:', mirrorError?.message || 'unknown');
                snapshot = null;
            }
        }
        if (snapshot) {
            try {
                const saving = this.save(snapshot);
                if (preferCache) saving.catch(() => {}); else await saving;
            }
            catch (error) { console.warn('[profile] startup snapshot write deferred:', error?.message || 'unknown'); }
        }
        // Безопасное логирование: только наличие/версия профиля, без личных данных.
        console.log('[profile] storage=' + backendName +
            ' schema=' + (snapshot?.schemaVersion ?? '-') +
            ' hasProfile=' + !!snapshot?.user +
            ' reset=' + !!snapshot?.profileReset +
            ' source=' + (durable ? 'durable' : (legacy ? 'legacy-localstorage' : (snapshot ? 'legacy-recovery' : 'empty'))));
        // Разрешение на постоянное хранение — только оптимизация, не условие запуска.
        navigator.storage?.persist?.().catch(() => {});
        return snapshot;
    },
    async openFallback(reason) {
        console.warn('[profile] emergency local fallback:', reason?.message || reason || 'unknown');
        backendName = 'localstorage-fallback';
        backend = localStorageBackend();
        const mirror = readLocalMirror();
        try { snapshot = migrate(mirror.data); }
        catch (error) {
            console.warn('[profile] emergency mirror unavailable; starting empty:', error?.message || 'unknown');
            snapshot = null;
        }
        return snapshot;
    },
    get() { return snapshot; },
    async readAccount(identity) {
        if (window.electronAPI?.readAccountData) return window.electronAPI.readAccountData(identity);
        if (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('Preferences')) {
            const { value } = await Preferences.get({ key:ACCOUNT_PREFIX + identity });
            return value ? JSON.parse(value) : null;
        }
        if (backend?.readAccount) return backend.readAccount(identity);
        return JSON.parse(localStorage.getItem(ACCOUNT_PREFIX + identity) || 'null');
    },
    async writeAccount(identity, data) {
        if (window.electronAPI?.writeAccountData) return window.electronAPI.writeAccountData(identity, data);
        if (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('Preferences')) {
            return Preferences.set({ key:ACCOUNT_PREFIX + identity, value:JSON.stringify(data) });
        }
        if (backend?.writeAccount) return backend.writeAccount(identity, data);
        localStorage.setItem(ACCOUNT_PREFIX + identity, JSON.stringify(data));
    },
    save(data) {
        if (clearing) return Promise.reject(new Error('Account storage is being cleared'));
        const epoch = storageEpoch;
        const next = migrate(JSON.parse(JSON.stringify(data)));
        next.storageRevision = Math.max(Date.now(), (snapshot?.storageRevision || 0) + 1, lastIssuedRevision + 1);
        lastIssuedRevision = next.storageRevision;
        queue = queue.catch(() => {}).then(async () => {
            if (epoch !== storageEpoch) throw new Error('Stale account write');
            await backend.write(next);
            if (epoch !== storageEpoch) throw new Error('Stale account write');
            // Do not expose a failed write as committed in memory or in the mirror.
            snapshot = next;
            try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
            try { document.dispatchEvent(new CustomEvent('goaltracker:storage-saved')); } catch {}
        });
        return queue;
    },
    flush() { return queue; },
    async clearUserData({ preserveKeys = [] } = {}) {
        clearing = true; storageEpoch++;
        const keep = new Set([KEY, 'gt-supabase-config-v1', 'gt-session-locked-v1', 'theme', ...preserveKeys]);
        const cleared = { schemaVersion:1, profileReset:true, user:null, goals:[], habits:[], events:[], achievements:[], notes:{}, settings:{ autoSync:true }, storageRevision:Math.max(Date.now(),lastIssuedRevision+1,(snapshot?.storageRevision||0)+1) };
        snapshot = cleared;
        const work = queue.catch(() => {}).then(async () => {
            // A non-private tombstone blocks every legacy recovery path on restart.
            if (window.electronAPI?.clearProfile) await window.electronAPI.clearProfile(cleared);
            else await backend.write(cleared);
            if (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('Preferences')) {
                const keys = typeof Preferences.keys === 'function' ? (await Preferences.keys()).keys : [];
                for (const key of new Set([...keys,KEY,'gt_goals','gt_finance','gt_calendar','gt_profile','gt_safety_fund','goalTracker_finance'])) {
                    if (!keep.has(key) && !key.startsWith(ACCOUNT_PREFIX)) await Preferences.remove({ key });
                }
                await Preferences.set({ key:KEY, value:JSON.stringify(cleared) });
            }
            for (const key of Object.keys(localStorage)) if (!keep.has(key) && !key.startsWith(ACCOUNT_PREFIX)) localStorage.removeItem(key);
            localStorage.setItem(KEY,JSON.stringify(cleared));
            snapshot = cleared; lastIssuedRevision = cleared.storageRevision;
        });
        queue = work;
        try { await work; } finally {
            for (const key of Object.keys(localStorage)) if (!keep.has(key) && !key.startsWith(ACCOUNT_PREFIX)) localStorage.removeItem(key);
            localStorage.setItem(KEY,JSON.stringify(cleared)); snapshot = cleared; clearing = false;
        }
        return cleared;
    },
    async reset() {
        // Tombstone не позволит восстановить удалённый профиль из legacy-копии.
        await queue;
        const cleared = { schemaVersion: 1, profileReset: true, user: null, settings: { autoSync: false }, storageRevision: Math.max(Date.now(), (snapshot?.storageRevision || 0) + 1) };
        await backend.write(cleared);
        snapshot = cleared;
        try { localStorage.setItem(KEY, JSON.stringify(cleared)); } catch {}
        for (const key of ['goalTracker_pin', 'goaltracker_cloud_auth', 'theme', 'goaltracker_update_dismissed']) {
            try { localStorage.removeItem(key); } catch {}
        }
    }
};
