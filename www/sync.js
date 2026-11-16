/* Account-isolated cloud sync with durable offline data and session-only logout. */
(function () {
    'use strict';
    if (window.CloudSync) return; // Loading the bundle twice must not create another auth client.
    const CONFIG = 'gt-supabase-config-v1', OWNER = 'gt-supabase-owner-v1', LOCK = 'gt-session-locked-v1';
    const clone = value => JSON.parse(JSON.stringify(value));
    const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
    const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const empty = () => ({ goals: [], transactions: [], safetyFund: {}, profile: {}, financeOther: {}, calendar: {} });
    const normalize = value => ({ ...empty(), ...(value || {}) });
    function validateState(value) {
        const state = normalize(value);
        if (!Array.isArray(state.goals) || !Array.isArray(state.transactions) ||
            !['safetyFund','profile','financeOther','calendar'].every(key => object(state[key])) ||
            state.goals.some(goal => !object(goal) || typeof goal.id !== 'string' || typeof goal.title !== 'string') ||
            ['nickname','status','createdAt','customAvatarData'].some(key => state.profile[key] !== undefined && typeof state.profile[key] !== 'string')) throw new Error('Unsupported cloud data');
        if (state.profile.workspace?.chess !== undefined && (!object(state.profile.workspace.chess) || typeof state.profile.workspace.chess.username !== 'string')) throw new Error('Unsupported chess data');
        if (state.profile.workspace !== undefined && (!object(state.profile.workspace) || ['portfolio','eloHistory','books','topics'].some(key => !Array.isArray(state.profile.workspace[key])))) throw new Error('Unsupported workspace data');
        if (state.profile.habits !== undefined && !Array.isArray(state.profile.habits)) throw new Error('Unsupported habits data');
        if (state.profile.gamification !== undefined && !object(state.profile.gamification)) throw new Error('Unsupported gamification data');
        return state;
    }
    function merge(base, local, remote, prefer, path = '', conflicts = [], allowEmptyGoalDeletion = false) {
        // An empty device is never evidence that every cloud goal was deleted.
        // This also covers stale baselines, pending receipts and explicit conflict choices.
        if (path === '/goals' && !allowEmptyGoalDeletion && Array.isArray(local) && !local.length && Array.isArray(remote) && remote.length) {
            return { value: clone(remote), conflicts };
        }
        if (same(local, base)) return { value: remote, conflicts };
        if (same(remote, base) || same(local, remote)) return { value: local, conflicts };
        if (path === '/profile/health' && object(local) && object(remote) && !prefer) {
            const left=healthSnapshot(local),right=healthSnapshot(remote),metrics={};
            for(const type of ['steps','heartRate','sleep','weight']) {
                const a=left.metrics[type],b=right.metrics[type],old=base?.metrics?.[type];
                if(same(a,old)){if(b)metrics[type]=b;}
                else if(same(b,old)){if(a)metrics[type]=a;}
                else if(!a||!b)metrics[type]=a||b;
                else metrics[type]=(Date.parse(b.measuredAt || right.lastReadAt)||0)>(Date.parse(a.measuredAt || left.lastReadAt)||0)?b:a;
            }
            const lastReadAt=(Date.parse(right.lastReadAt)||0)>(Date.parse(left.lastReadAt)||0)?right.lastReadAt:left.lastReadAt;
            return {value:{metrics,lastReadAt},conflicts};
        }
        if (path === '/safetyFund') {
            if (!prefer) conflicts.push(path);
            return { value: prefer === 'remote' ? remote : local, conflicts };
        }
        if (object(local) && object(remote) && (object(base) || base === undefined)) {
            const value = {};
            for (const key of new Set([...Object.keys(base || {}), ...Object.keys(remote), ...Object.keys(local)])) {
                if (['__proto__','constructor','prototype'].includes(key)) continue;
                const next = merge(base?.[key], local[key], remote[key], prefer, `${path}/${key}`, conflicts, allowEmptyGoalDeletion).value;
                if (next !== undefined) value[key] = next;
            }
            return { value, conflicts };
        }
        const keyed = array => Array.isArray(array) && array.every(item => object(item) && typeof item.id === 'string') && new Set(array.map(item => item.id)).size === array.length;
        if (keyed(local) && keyed(remote) && (keyed(base) || base === undefined)) {
            const maps = [base || [], local, remote].map(items => new Map(items.map(item => [item.id, item])));
            const value = [];
            for (const id of new Set([...remote.map(item => item.id), ...local.map(item => item.id), ...(base || []).map(item => item.id)])) {
                const item = merge(maps[0].get(id), maps[1].get(id), maps[2].get(id), prefer, `${path}/${id}`, conflicts, allowEmptyGoalDeletion).value;
                if (item !== undefined) value.push(item);
            }
            return { value, conflicts };
        }
        if (!prefer) conflicts.push(path || '/');
        return { value: prefer === 'remote' ? remote : local, conflicts };
    }
    function validateConfig(url, key) {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || !['','/'].includes(parsed.pathname)) throw new Error('Укажите HTTPS URL проекта без пути, пароля и параметров.');
        if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) {
            let role;
            try { role = JSON.parse(atob(key.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).role; } catch {}
            if (role !== 'anon') throw new Error('Допустим только публичный anon/publishable key. Секретные ключи запрещены.');
        }
        return { url: parsed.origin, key };
    }
    window.CloudSyncCore = { merge, normalize, empty, validateConfig };
    let app, client, config, session, subscription, timer, polling, busy = false, applying = false;
    let isSyncing = false, lastSyncSucceeded = false, lastSyncFailure = null;
    let bootstrapIdentity = null, bootstrapPromise = null;
    let dataChannel = null, realtimeIdentity = null, realtimeTimer, rerunSync = false;
    const singleton = {instance:null,url:null,key:null,generation:0};
    let sdkEpoch = 0, authPending = false;
    let playerTagVersion = 0, successfulPlayerTagVersion = 0, freshPlayerTag = null;
    let accountEpoch = 0, authCycle = 0, readyIdentity = null, desiredIdentity = null, settledNoSession = false;
    let transitioning = false, loggingOut = false, accountQueue = Promise.resolve(), sessionLoad = null, syncWork = null, logoutWork = null, initializing = null;
    let tokenWrites = Promise.resolve(), pendingWrites = Promise.resolve(), calendarMode = null;
    let accountSnapshotWrites = Promise.resolve();
    const ACCOUNT_PREFIX = 'gt-account-data-v1:';
    const activeRequests = new Set();
    let syncDiagnostic = '', goalsDiagnostic = '', sectionsDiagnostic = '', sessionError = false, storageWarning = false;
    function canOpenCachedAccount(user = app?.user) {
        if (!user?.supabaseUserId || localStorage.getItem(LOCK) === 'true') return false;
        const saved = read(CONFIG, window.SupabaseConfig || null);
        const owner = localStorage.getItem(OWNER);
        return !!saved?.url && (!owner || owner === `${saved.url}|${user.supabaseUserId}`);
    }
    function showStartupFallback() {
        if (canOpenCachedAccount()) app.showApp(); else app.showAccountLoading?.();
    }
    function connectionState() {
        if (needsReauthentication()) return { state:'reauth_required', needsBinding:false, text:REAUTH_MESSAGE };
        if (session) return { state:readyIdentity === ownerId() && !transitioning ? 'active' : transitioning ? 'loading' : 'load_error', needsBinding:false, text:readyIdentity === ownerId() && !transitioning ? 'Сессия активна' : transitioning ? 'Загружаем данные аккаунта…' : 'Сессия активна. Данные пока не синхронизированы.' };
        return { state:sessionError ? 'restore_error' : 'no_session', needsBinding:false, text:sessionError ? 'Не удалось восстановить сессию. Повторите вход.' : 'Войдите в облачный аккаунт.' };
    }
    let message = 'Облако не подключено. Данные сохраняются на устройстве.', conflict = false, bindNeeded = false, previews = [];
    const preferences = window.NCDNativeStorage?.preferences || window.Capacitor?.Plugins?.Preferences;
    const nativePreferences = window.NCDNativeStorage?.isNative?.() ?? !!window.Capacitor?.isNativePlatform?.();
    const AUTH_PREFERENCE_PREFIX = 'goaltracker.supabase.';
    const authStorage = {
        async getItem(key) {
            if (window.electronAPI?.readAuthSession) {
                const durable = await window.electronAPI.readAuthSession(key);
                if (durable !== null) return durable;
                const legacy = localStorage.getItem(key);
                if (legacy !== null) await window.electronAPI.writeAuthSession(key,legacy);
                return legacy;
            }
            if (nativePreferences) {
                try {
                    const result = await preferences.get({ key: AUTH_PREFERENCE_PREFIX + key });
                    if (result.value !== null) return result.value;
                    // Однократная миграция сессии из прежнего WebView localStorage.
                    const legacy = localStorage.getItem(key);
                    if (legacy !== null) {
                        await preferences.set({ key: AUTH_PREFERENCE_PREFIX + key, value: legacy });
                        return legacy;
                    }
                    return null;
                } catch (error) { storageWarning = true; throw error; }
            }
            return localStorage.getItem(key);
        },
        async setItem(key, value) {
            if (window.electronAPI?.writeAuthSession) {
                await window.electronAPI.writeAuthSession(key,value);
                // The file is authoritative; a failed renderer mirror must not lose login.
                try { localStorage.setItem(key,value); } catch {}
                return;
            }
            if (nativePreferences) {
                try {
                    await preferences.set({ key: AUTH_PREFERENCE_PREFIX + key, value });
                    return;
                } catch (error) { storageWarning = true; throw error; }
            }
            localStorage.setItem(key, value);
        },
        async removeItem(key) {
            if (window.electronAPI?.writeAuthSession) await window.electronAPI.writeAuthSession(key,null);
            if (nativePreferences) {
                try { await preferences.remove({ key: AUTH_PREFERENCE_PREFIX + key }); } catch {}
            }
            localStorage.removeItem(key);
        }
    };
    const read = (key, fallback) => { const value = localStorage.getItem(key); return value ? JSON.parse(value) : fallback; };
    const write = (key, value) => localStorage.setItem(key, JSON.stringify(value));
    const ownerId = () => session?.user?.id ? `${config.url}|${session.user.id}` : null;
    const metaKey = () => `gt-cloud-state-v1:${ownerId()}`;
    const backupKey = () => `gt-cloud-backup-v1:${ownerId()}`;
    const pendingKey = identity => `gt-cloud-pending-v1:${identity}`;
    const authKey = key => key.startsWith('goaltracker.supabase.') || key.startsWith('gt-supabase-auth:') || /^sb-.*-auth-token/.test(key) || key.startsWith('tokens.');
    function scope() { return { epoch:accountEpoch, identity:ownerId(), userId:session?.user?.id, db:client }; }
    function current(saved) { return !saved?.cancelled && !!saved?.identity && saved.epoch === accountEpoch && saved.identity === ownerId() && saved.db === client && localStorage.getItem(OWNER) === saved.identity; }
    function assertCurrent(saved) { if (!current(saved)) throw Object.assign(new Error('Аккаунт изменился.'), { code:'NCD_STALE' }); }
    function stopAccountRequests() { clearTimeout(timer); clearTimeout(realtimeTimer); clearInterval(polling); stopRealtime(); for (const controller of activeRequests) controller.abort(); }
    async function clearUserCaches({ keepAuth = false, pending = null } = {}) {
        const preferenceKeys = nativePreferences && typeof preferences.keys === 'function' ? (await preferences.keys()).keys : [];
        const knownAuthKeys = config ? [`${AUTH_PREFERENCE_PREFIX}gt-supabase-auth:${config.url}`, ...Object.values(tokenKeys()).map(key => AUTH_PREFERENCE_PREFIX+key)] : [];
        const keys = new Set([...Object.keys(localStorage),...preferenceKeys,...knownAuthKeys,'gt_goals','gt_finance','gt_calendar','gt_profile','gt_safety_fund','goalTracker_finance','goalTracker_health_local_v1']);
        const currentKeys = new Set(knownAuthKeys.flatMap(key => [key,key.replace(AUTH_PREFERENCE_PREFIX,'')]));
        const preserveKeys = [...keys].filter(key => key.startsWith(ACCOUNT_PREFIX) || (keepAuth && currentKeys.has(key)) || key === pending);
        let failure;
        try {
            if (window.ProfileStorage.clearUserData) await window.ProfileStorage.clearUserData({ preserveKeys });
            else { await window.ProfileStorage.flush?.(); await window.ProfileStorage.save({ schemaVersion:1,profileReset:true,user:null,goals:[],events:[],notes:{},habits:[],achievements:[],settings:{autoSync:true} }); }
        } catch (error) { failure = error; }
        const keep = new Set([CONFIG,LOCK,'theme','goalTracker_data',...preserveKeys]);
        for (const key of keys) if (!keep.has(key)) {
            localStorage.removeItem(key);
            if (nativePreferences) { try { await preferences.remove({ key }); } catch (error) { failure ||= error; } }
        }
        const stored = window.ProfileStorage.get?.();
        const marker = stored?.profileReset && !stored.user ? stored : {schemaVersion:1,profileReset:true,user:null,goals:[],events:[],notes:{},habits:[],achievements:[],settings:{autoSync:true},storageRevision:Math.max(Date.now(),(stored?.storageRevision||0)+1)};
        localStorage.setItem('goalTracker_data',JSON.stringify(marker));
        if (nativePreferences) { try { await preferences.set({key:'goalTracker_data',value:JSON.stringify(marker)}); } catch (error) { failure ||= error; } }
        if (failure) throw failure;
    }
    function savePending(identity, value) {
        const key = pendingKey(identity), epoch = accountEpoch;
        if (value) write(key,value); else localStorage.removeItem(key);
        if (nativePreferences) pendingWrites = pendingWrites.catch(() => {}).then(async () => {
            if (epoch !== accountEpoch || identity !== ownerId()) return;
            if (value) await preferences.set({ key,value:JSON.stringify(value) }); else await preferences.remove({ key });
        }).catch(() => { storageWarning = true; });
    }
    function saveAccountSnapshot() {
        const identity = ownerId();
        if (!identity || app?.user?.supabaseUserId !== session?.user?.id) return Promise.resolve();
        const hydrated = readyIdentity === identity;
        const saved = { identity, userId:session.user.id, savedAt:new Date().toISOString(), settings:clone(app.settings),
            deviceHealth:read('goalTracker_health_local_v1',null),
            base:read(metaKey(),{}).base || read(pendingKey(identity),{})?.base || empty(), local:validateState(capture()) };
        const work = accountSnapshotWrites.catch(() => {}).then(async () => {
            if (!hydrated && localEmpty(saved.local)) {
                const previous = await storedAccountSnapshot(identity);
                if (previous?.identity === identity && previous.userId === saved.userId && !localEmpty(validateState(previous.local))) return;
            }
            if (window.ProfileStorage.writeAccount) await window.ProfileStorage.writeAccount(identity,saved);
            else if (nativePreferences) await preferences.set({key:ACCOUNT_PREFIX+identity,value:JSON.stringify(saved)});
            else write(ACCOUNT_PREFIX+identity,saved);
        });
        accountSnapshotWrites = work;
        return work;
    }
    async function storedAccountSnapshot(identity) {
        if (window.ProfileStorage.readAccount) return window.ProfileStorage.readAccount(identity);
        if (nativePreferences) {
            const {value} = await preferences.get({key:ACCOUNT_PREFIX+identity});
            return value ? JSON.parse(value) : null;
        }
        return read(ACCOUNT_PREFIX+identity,null);
    }
    async function readAccountSnapshot(identity, userId) {
        await accountSnapshotWrites.catch(() => {});
        const saved = await storedAccountSnapshot(identity);
        // If saving the separate snapshot failed, logout deliberately retained
        // the original owned profile and its outbox. Recover that before any
        // account-switch cleanup can replace it with an empty workspace.
        const original = window.ProfileStorage.get?.();
        if (original?.user?.supabaseUserId === userId && localStorage.getItem(OWNER) === identity) {
            let pending = read(pendingKey(identity),null);
            if (!pending && nativePreferences) {
                const {value} = await preferences.get({key:pendingKey(identity)});
                if (value) pending = JSON.parse(value);
            }
            if (pending?.local && (!localEmpty(pending.local) || hasPendingGoalDeletion(pending,pending.base,pending.local) || !saved?.local || localEmpty(saved.local))) {
                return {identity,userId,base:validateState(pending.base),local:validateState(pending.local),settings:original.settings};
            }
        }
        if (!saved || saved.identity !== identity || saved.userId !== userId) return null;
        return { ...saved,base:validateState(saved.base),local:validateState(saved.local) };
    }
    function status(text) { message = needsReauthentication() ? REAUTH_MESSAGE : text; refresh(); document.dispatchEvent(new Event('goaltracker:cloud-session')); }
    function healthSnapshot(value) {
        const metrics = {};
        for (const name of ['steps','heartRate','sleep','weight']) {
            const metric = value?.metrics?.[name];
            if (object(metric) && Number.isFinite(metric.value)) metrics[name] = {
                value:metric.value,unit:typeof metric.unit === 'string' ? metric.unit : '',
                source:typeof metric.source === 'string' ? metric.source : '',
                measuredAt:typeof metric.measuredAt === 'string' ? metric.measuredAt : null
            };
        }
        return {metrics,lastReadAt:typeof value?.lastReadAt === 'string' ? value.lastReadAt : null};
    }
    function capture() {
        const finance = window.finance?.getData?.() || read('goalTracker_finance', {});
        const { transactions = [], safetyFund = {}, ...financeOther } = finance;
        return clone({ goals: app.goals, transactions, safetyFund, financeOther,
            profile: { workspace:app.workspace || {portfolio:[],eloHistory:[],books:[],topics:[]}, habits:app.habits || [], gamification:app.gamification || {}, health:healthSnapshot(read('goalTracker_health_account_v1',read('goalTracker_health_local_v1',null))), nickname: app.user?.nickname || '', status: app.user?.status || '', createdAt: app.user?.createdAt || '', customAvatarData: app.getCustomAvatar?.() || '' },
            calendar: { notes: app.notes || {}, events: app.events || [], achievements: app.achievements || [] } });
    }
    function localEmpty(state) {
        return !state.goals.length && !state.transactions.length && !state.safetyFund.balance && !(state.safetyFund.history || []).length &&
            !(state.financeOther.investments?.assets || []).length && !(state.financeOther.growth?.ideas || []).length &&
            !state.financeOther.growth?.baseIncome && !state.financeOther.growth?.currentIncome && !(state.financeOther.growth?.history || []).length &&
            (!state.safetyFund.targetMonths || state.safetyFund.targetMonths === 6) &&
            !Object.values(state.financeOther.budget?.categories || {}).some(item => item.limit) &&
            !Object.keys(state.calendar.notes || {}).length && !(state.calendar.events || []).length && !(state.calendar.achievements || []).length && !state.profile.customAvatarData && !state.profile.status && !state.profile.workspace?.chess?.username && !Object.values(state.profile.workspace || {}).some(value => Array.isArray(value) && value.length);
    }
    // A goal draft belongs to its form until Save. Applying cloud data must
    // not disable the focused input or interrupt the mobile keyboard.
    function appBusy() { return document.getElementById('goalModal')?.classList.contains('active') || app._moduleSaving || app._calendarCompletionPending || app._attachmentPending || app._goalSaveInProgress || app._goalActionPending || app._profileSaving || app._avatarLoading || app._resetting; }
    function localChanged() {
        if (applying || loggingOut || !session || !config || localStorage.getItem(OWNER) !== ownerId()) return;
        saveAccountSnapshot().catch(() => { storageWarning = true; });
        if (transitioning || readyIdentity !== ownerId()) {
            if (!app._accountTransition && app.user?.supabaseUserId === session.user.id) {
                const pending = read(pendingKey(ownerId()),null);
                savePending(ownerId(), { base:pending?.base || read(metaKey(),{}).base || empty(), local:capture() });
                if (!transitioning) { clearTimeout(timer); timer = setTimeout(() => sync(),0); }
            }
            return;
        }
        const base = read(metaKey(),{}).base || empty(), local = capture();
        if (same(base,local)) { savePending(ownerId(),null); return; }
        savePending(ownerId(),{ base,local });
        if (isSyncing) { rerunSync = true; return; }
        status(navigator.onLine === false ? 'Офлайн: изменения ожидают отправки в ваш аккаунт.' : 'Сохраняем в облаке…');
        clearTimeout(timer); timer = setTimeout(() => sync(),0);
    }

    const DOCUMENT_VERSION = '__goaltrackerVersion';
    function documentContent(value) {
        if (Array.isArray(value)) return value.map(item => object(item) ? Object.fromEntries(Object.entries(item).filter(([key]) => key !== DOCUMENT_VERSION)) : item);
        return object(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== DOCUMENT_VERSION)) : value;
    }
    function versionedDocument(value) {
        const next = clone(value), version = crypto.randomUUID();
        if (Array.isArray(next)) { if (next.length) { if (!object(next[0])) throw new Error('Неподдерживаемый формат облачных записей.'); next[0][DOCUMENT_VERSION] = version; } }
        else next[DOCUMENT_VERSION] = version;
        return next;
    }
    function payloadFailure(field) {
        const error = new Error('Некорректное поле перед отправкой в облако.');
        error.payloadField = field;
        return error;
    }
    function cleanId(value, field = 'id') {
        // Accept existing string IDs as well as UUIDs; never coerce objects or regenerate IDs.
        if (typeof value !== 'string' || !value.trim() || value !== value.trim() ||
            /\s|[\x00-\x1f]/.test(value) || ['undefined','null','[object Object]'].includes(value)) throw payloadFailure(field);
        return value;
    }
    function cleanTimestamp(value) {
        // Missing/invalid SQL timestamps are omitted so database defaults can apply.
        if (value == null || value === '') return undefined;
        if (typeof value === 'string') {
            const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
            if (!parts || Number(parts[2]) < 1 || Number(parts[2]) > 12 || Number(parts[3]) < 1 ||
                Number(parts[3]) > new Date(Date.UTC(Number(parts[1]), Number(parts[2]), 0)).getUTCDate()) return undefined;
        }
        const date = Object.prototype.toString.call(value) === '[object Date]' ? value :
            typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2}))?$/.test(value) ? new Date(value) : null;
        return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
    }
    function cleanPayload(value) {
        if (Array.isArray(value)) return value.map(cleanPayload);
        if (!object(value)) return value;
        const result = {};
        for (const [key, field] of Object.entries(value)) {
            if (['__proto__','constructor','prototype'].includes(key) || field === undefined) continue;
            if (['created_at','updated_at','createdAt','updatedAt'].includes(key)) {
                const timestamp = cleanTimestamp(field);
                if (timestamp !== undefined) result[key] = timestamp;
            } else if (['id','user_id'].includes(key)) result[key] = cleanId(field, key);
            else result[key] = cleanPayload(field);
        }
        return result;
    }
    function cloudFailure(error, operation) {
        const failure = new Error('Облачный запрос не завершён.');
        failure.code = error?.code; failure.operation = operation;
        return failure;
    }
    const missingReadSchema = error => ['42703','42P01','PGRST100','PGRST204','PGRST205'].includes(error?.code);
    const calendarSchemaMismatch = error => ['23502','42703','PGRST204'].includes(error?.code);
    async function selectData(table,query,fallback,saved=scope()) {
        try {
            assertCurrent(saved);
            const result=await query();
            assertCurrent(saved);
            if(result.error)throw cloudFailure(result.error,`${table}.select`);
            return result.data ?? fallback;
        } catch(error) {
            if(!current(saved) || !missingReadSchema(error))throw error;
            saved.readErrors ||= new Map();saved.readErrors.set(table,error);
            return fallback;
        }
    }
    function assertReadable(saved) {
        // A schema failure is not proof that cloud rows were deleted.
        // Keep the local outbox and never upload/acknowledge a fabricated empty snapshot.
        if(saved.readErrors?.size)throw saved.readErrors.values().next().value;
    }
    function publishPlayerTag(saved, shortId, version) {
        assertCurrent(saved);
        if (version < successfulPlayerTagVersion) return;
        successfulPlayerTagVersion=version;
        freshPlayerTag={identity:saved.identity,userId:saved.userId,client:saved.db,epoch:saved.epoch,shortId:shortId || null};
        app.user.shortId=shortId || null;
        document.dispatchEvent(new CustomEvent('goaltracker:player-tag',{detail:freshPlayerTag}));
    }
    function currentPlayerTag() {
        const saved=scope();
        return freshPlayerTag && current(saved) && freshPlayerTag.epoch===saved.epoch && freshPlayerTag.identity===saved.identity && freshPlayerTag.client===saved.db ? freshPlayerTag : null;
    }
    async function fetchPlayerTag(saved=scope(), { signal } = {}) {
        if(!session?.user?.id || !app?.user || !saved.db)return null;
        assertCurrent(saved);
        const version=++playerTagVersion;
        const data=await selectData('profiles',async()=>{
            let query = saved.db.from('profiles').select('short_id').eq('id',saved.userId);
            if (signal) query = query.abortSignal(signal);
            const result=await query.single();
            return result.error?.code==='PGRST116'?{data:null,error:null}:result;
        },null,saved);
        if (signal?.aborted) throw new DOMException('Aborted','AbortError');
        assertReadable(saved);
        publishPlayerTag(saved,data?.short_id || null,version);
        return version>=successfulPlayerTagVersion ? {short_id:data?.short_id || null} : {short_id:currentPlayerTag()?.shortId || null};
    }
    const WORKSPACE_FIELDS = { portfolio:'portfolio', learning_chess:'eloHistory', learning_books:'books', learning_topics:'topics' };
    async function workspaceProfileSchema(saved) {
        if (saved.workspaceLayout !== undefined) return saved.workspaceLayout;
        // The OpenAPI root can be disabled even when the user's tables are accessible.
        // Inspect only this owner's existing profile; never guess a write layout.
        const profile = await selectData('profiles', () => saved.db.from('profiles').select('*').eq('id',saved.userId).maybeSingle(), null, saved);
        assertCurrent(saved);
        saved.workspaceProfile = profile;
        const columns = Object.keys(WORKSPACE_FIELDS);
        const isJson = value => object(value) || Array.isArray(value);
        const timestamp = typeof profile?.updated_at === 'string';
        if (profile && columns.every(key => Object.hasOwn(profile,key) && isJson(profile[key])))
            return saved.workspaceLayout = {mode:'columns',columns,timestamp};
        return saved.workspaceLayout = object(profile?.extra) ? {mode:'extra',columns:['extra'],timestamp} : null;
    }
    function profileWorkspace(row, layout) {
        if (!row || !layout) return null;
        const source = layout.mode === 'extra' ? row.extra : row;
        if (!object(source) || !Object.keys(WORKSPACE_FIELDS).every(key => Object.hasOwn(source,key))) return null;
        const workspace = {};
        for (const [column,key] of Object.entries(WORKSPACE_FIELDS)) {
            const value = source[column] ?? [];
            if (column === 'learning_chess' && object(value)) {
                if (!Array.isArray(value.history ?? []) || (value.username !== undefined && typeof value.username !== 'string')) throw cloudFailure({code:'22023'},'profiles.learning_chess.json');
                const { history = [], ...chess } = value;
                workspace.eloHistory = history; if (typeof chess.username === 'string') workspace.chess = chess;
                continue;
            }
            if (!Array.isArray(value)) throw cloudFailure({code:'22023'},`profiles.${column}.json`);
            workspace[key] = value;
        }
        return workspace;
    }
    async function writeProfileWorkspace(workspace, remote, saved) {
        const layout = await workspaceProfileSchema(saved);
        assertCurrent(saved);
        const nonempty = !!workspace?.chess?.username || Object.values(workspace || {}).some(value => Array.isArray(value) && value.length);
        if (!layout) {
            if (nonempty) throw cloudFailure({code:'P0001'},'profiles.workspace.schema');
            return;
        }
        const previous = remote.rows.profiles;
        const currentWorkspace = profileWorkspace(previous,layout);
        if (currentWorkspace && same(currentWorkspace,workspace)) return;
        if (!currentWorkspace && !nonempty) return;
        const fields = Object.fromEntries(Object.entries(WORKSPACE_FIELDS).map(([column,key]) => [column,column === 'learning_chess' && workspace?.chess ? {...workspace.chess,history:workspace.eloHistory || []} : workspace?.[key] || []]));
        const payload = layout.mode === 'extra' ? { extra:{ ...(previous?.extra || {}), ...fields, __ncdWorkspaceVersion:crypto.randomUUID() } } : fields;
        if (layout.timestamp) payload.updated_at = new Date().toISOString();
        let query = saved.db.from('profiles').update(cleanPayload(payload)).eq('id',saved.userId);
        if (layout.mode === 'extra') {
            const version = previous?.extra?.__ncdWorkspaceVersion;
            query = version ? query.eq('extra->>__ncdWorkspaceVersion',version) : query.is('extra->>__ncdWorkspaceVersion',null);
        } else if (layout.timestamp && previous?.updated_at) query = query.eq('updated_at',previous.updated_at);
        const result = await query.select('id');
        assertCurrent(saved);
        if (result.error) throw cloudFailure(result.error,'profiles.workspace.update');
        if (!result.data?.length) throw cloudFailure({code:'40001'},'profiles.workspace.compare-and-swap');
    }
    async function fetchProfile(saved = scope()) {
        if (!session?.user?.id || !app?.user || !saved.userId || !saved.db) return null;
        assertCurrent(saved);
        const version=++playerTagVersion;
        const layout = await workspaceProfileSchema(saved);
        assertCurrent(saved);
        const profile=saved.workspaceProfile;
        if(saved.readErrors?.has('profiles'))return null;
        if (profile && profile.id !== saved.userId) throw cloudFailure({code:'42501'},'profiles.owner');
        // This read runs independently of finance hydration; never reuse a cached ID.
        publishPlayerTag(saved,profile?.short_id || null,version);
        app.user.handle = profile?.handle || null;
        document.dispatchEvent(new Event('goaltracker:cloud-session'));
        return profile;
    }
    async function tableRow(table, userId, db = client, saved = scope()) {
        if (!session?.user?.id || !app?.user || !userId || !db) return null;
        assertCurrent(saved);
        cleanId(userId, 'user_id');
        if (table === 'profiles') return fetchProfile(saved);
        if (table === 'finance_transactions') return transactionRows(userId,db,saved);
        if (table === 'goals') return goalRows(userId,db,saved);
        if(!['safety_fund','user_profile','calendar_events'].includes(table))throw new Error('Unsupported document table');
        const row=await selectData(table,()=>db.from(table).select('user_id,data').eq('user_id',userId).maybeSingle(),null,saved);
        if (row && row.user_id !== userId) throw cloudFailure({code:'42501'},`${table}.owner`);
        return row;
    }

    // Goals and transactions are rows keyed by id; other domains use per-user documents.
    const GOAL_FIELDS = ['id','title','description','category','priority','deadline','status','progress','tags','subgoals'];
    const GOAL_ALIASES = { parentId: 'parent_id', createdAt: 'created_at', updatedAt: 'updated_at', targetAmount: 'target_amount', currentAmount: 'current_amount', isCompleted: 'is_completed' };
    const GOAL_WRITE_FIELDS = ['id','title','description','priority','category','status','progress'];
    function goalArray(value, field) {
        if (value == null) return [];
        let parsed = value;
        if (typeof parsed === 'string') {
            try { parsed = JSON.parse(parsed); } catch { throw payloadFailure(field); }
        }
        if (!Array.isArray(parsed) || (field === 'tags' ? parsed.some(tag => typeof tag !== 'string') : parsed.some(step => !object(step)))) throw payloadFailure(field);
        return clone(parsed);
    }
    function goalToRow(goal, userId) {
        cleanId(goal.id);
        // Keep local/legacy metadata out of PostgREST's column inference.
        const row = { user_id: cleanId(userId, 'user_id') };
        for (const key of GOAL_WRITE_FIELDS) if (goal[key] !== undefined) row[key] = clone(goal[key]);
        for (const key of ['subgoals','tags']) if (goal[key] !== undefined) row[key] = goalArray(goal[key],key);
        const parentId = goal.parentId !== undefined ? goal.parentId : goal.parent_id;
        if (parentId !== undefined) row.parent_id = parentId === null ? null : cleanId(parentId,'parent_id');
        return cleanPayload(row);
    }
    function goalFromRow(row) {
        const goal = {};
        for (const key of GOAL_FIELDS) if (row[key] !== undefined) goal[key] = clone(row[key]);
        for (const [local, column] of Object.entries(GOAL_ALIASES)) if (row[column] !== undefined) goal[local] = clone(row[column]);
        return goal;
    }
    async function goalRows(userId, db = client, saved = scope()) {
        if (!session?.user?.id || !app?.user || !userId || !db) return [];
        assertCurrent(saved);
        const rows = [], pageSize = 500;
        // Original NCD databases keep the account's goals in one JSONB row.
        // Read before ordering so that layout works without an `id` column.
        const first = await selectData('goals', () => db.from('goals').select('*').eq('user_id',userId).range(0,pageSize-1),[],saved);
        if (saved.readErrors?.has('goals')) return [];
        if (first.some(row=>row.user_id!==userId)) throw cloudFailure({code:'42501'},'goals.owner');
        if (first.length === 1 && Array.isArray(first[0].data) && !Object.hasOwn(first[0],'id')) {
            saved.goalsDocument = first[0];
            return documentContent(first[0].data);
        }
        saved.goalsDocument = null;
        if (first.length < pageSize) return first;
        for (let start = 0; ; start += pageSize) {
            const page=await selectData('goals',()=>db.from('goals').select('*').eq('user_id',userId).order('id').range(start,start+pageSize-1),[],saved);
            if(saved.readErrors?.has('goals'))return [];
            if(page.some(row=>row.user_id!==userId))throw cloudFailure({code:'42501'},'goals.owner');
            rows.push(...page);
            if(page.length<pageSize)return rows;
        }
    }
    async function upsertGoalRows(rows, saved) {
        if (!rows.length) return; // Never send an empty goals payload.
        let response;
        try {
            response = await saved.db.from('goals').upsert(rows, { onConflict: 'id', defaultToNull: false });
            if (response.error) throw response.error;
            assertCurrent(saved);
        } catch (error) {
            // Log Supabase's exact error fields, without request headers, session or goal content.
            console.warn('[goals.upsert] Supabase request failed', {
                status: response?.status ?? error?.status ?? null,
                statusText: response?.statusText ?? null,
                error: {
                    code: error?.code ?? null,
                    message: error?.message ?? String(error),
                    details: error?.details ?? null,
                    hint: error?.hint ?? null
                }
            });
            if (error?.code === 'NCD_STALE') throw error;
            throw cloudFailure(error, 'goals.upsert');
        }
    }
    async function writeGoals(goals, previous, identity, saved = scope(), allowDeleteAll = false) {
        assertCurrent(saved);
        if (ownerId() !== identity || localStorage.getItem(OWNER) !== identity) throw new Error('Аккаунт изменился.');
        // Last-line protection even if a caller bypasses the safe merge.
        if (!goals.length && previous.length && !allowDeleteAll) return;
        if (saved.goalsDocument) return writeDocument('goals',goals,saved.goalsDocument,identity,saved);
        const userId = cleanId(session.user.id, 'user_id');
        const goalsPayload = goals.map(goal => goalToRow(goal, userId));
        const ids = new Set(goalsPayload.map(goal => goal.id));
        if (ids.size !== goalsPayload.length) throw new Error('Обнаружены повторяющиеся ID целей.');
        const old = new Map(previous.map(row => [row.id, row]));
        const changed = goalsPayload.filter(row => {
            const before = old.get(row.id);
            return !before || Object.keys(row).some(key => !same(row[key], before[key]));
        });
        if (changed.length) {
            try {
                await upsertGoalRows(changed, saved);
            } catch (error) {
                // An empty JSON-document table cannot be distinguished from an
                // empty row table by SELECT. Fall back only on schema errors.
                if (!['42P10','42703','PGRST204','PGRST205','23502'].includes(error?.code)) throw error;
                saved.goalsDocument = null;
                await writeDocument('goals',goals,null,identity,saved);
                return;
            }
        }
        for (const row of previous) if (!ids.has(row.id)) {
            if (ownerId() !== identity || localStorage.getItem(OWNER) !== identity) throw new Error('Аккаунт изменился.');
            const result = await client.from('goals').delete().eq('user_id', userId).eq('id', row.id);
            assertCurrent(saved);
            if (result.error) throw cloudFailure(result.error, 'goals.delete');
        }
    }

    const TRANSACTION_FIELDS = ['id','type','amount','category','description','date'];
    function transactionFromRow(row) {
        return Object.fromEntries(TRANSACTION_FIELDS.filter(key=>row[key] !== undefined).map(key=>[key,clone(row[key])]));
    }
    function transactionToRow(transaction,userId) {
        if (!object(transaction)) throw payloadFailure('transaction');
        const row = {id:cleanId(transaction.id),user_id:cleanId(userId,'user_id')};
        for (const key of TRANSACTION_FIELDS) if (key!=='id' && transaction[key] !== undefined) row[key]=clone(transaction[key]);
        if (row.amount !== undefined && (!Number.isFinite(row.amount) || row.amount<0)) throw payloadFailure('amount');
        if (row.type !== undefined && !['income','expense'].includes(row.type)) throw payloadFailure('type');
        return cleanPayload(row);
    }
    async function transactionRows(userId,db=client,saved=scope()) {
        assertCurrent(saved);
        const rows=[],pageSize=500;
        // Read the actual columns first: older installations store a single JSON document.
        const initial=await selectData('finance_transactions',()=>db.from('finance_transactions').select('*').eq('user_id',cleanId(userId,'user_id')).range(0,pageSize-1),[],saved);
        const schemaError=saved.readErrors?.get('finance_transactions');
        // An older finance table can lack the expected columns. Keep this
        // account's ledger in its existing owner-protected JSON document.
        // Once selected, this storage marker stays authoritative across devices.
        const profileResult=await db.from('user_profile').select('user_id,data').eq('user_id',userId).maybeSingle();
        assertCurrent(saved);
        const profileRow=profileResult.data;
        if(profileRow && profileRow.user_id!==userId)throw cloudFailure({code:'42501'},'user_profile.owner');
        const extras=documentContent(profileRow?.data)?.__goaltrackerSync;
        const profileLedger=extras?.transactionsStorage==='profile-v1';
        if(schemaError || profileLedger) {
            if(profileResult.error)throw cloudFailure(profileResult.error,'user_profile.select');
            if(schemaError)saved.readErrors.delete('finance_transactions');
            saved.financeUsesProfile=true;saved.financeHasProfileData=profileLedger;
            saved.financeProfileDocument={row:profileRow,data:documentContent(profileRow?.data)||{}};
            const ledger=profileLedger?extras.transactions:[];
            if(!Array.isArray(ledger))throw payloadFailure('transactions');
            return clone(ledger).map(item=>{transactionToRow(item,userId);return {...item,user_id:userId};});
        }
        saved.financeUsesProfile=false;
        if(initial.some(row=>row.user_id!==userId))throw cloudFailure({code:'42501'},'finance_transactions.owner');
        if(initial.length===1 && Array.isArray(initial[0].data) && !Object.hasOwn(initial[0],'id')) {
            saved.financeDocument=initial[0];
            return documentContent(initial[0].data).map(item=>({...item,user_id:userId}));
        }
        if(initial.some(row=>['id','user_id','type','amount','category','description','date'].some(key=>!Object.hasOwn(row,key)))) {
            // An incomplete row cannot safely replace local financial data.
            throw cloudFailure({code:'42703'},'finance_transactions.schema');
        }
        saved.financeDocument=null;
        if(initial.length < pageSize)return initial;
        // For multiple pages use a stable primary-key order to avoid skipped rows.
        for(let start=0;;start+=pageSize) {
            const page=await selectData('finance_transactions',()=>db.from('finance_transactions').select('*').eq('user_id',cleanId(userId,'user_id')).order('id').range(start,start+pageSize-1),[],saved);
            if(saved.readErrors?.has('finance_transactions'))return [];
            if(page.some(row=>row.user_id!==userId))throw cloudFailure({code:'42501'},'finance_transactions.owner');
            rows.push(...page);
            if(page.length<pageSize)return rows;
        }
    }
    async function writeTransactions(transactions,previous,identity,saved=scope()) {
        assertCurrent(saved);
        if(saved.financeUsesProfile) {
            const ids=transactions.map(item=>transactionToRow(item,saved.userId).id);
            if(new Set(ids).size!==ids.length)throw payloadFailure('transactions.id');
            if(saved.profileIncludesTransactions)return;
            return patchUserDocument(saved,data=>({...data,__goaltrackerSync:{...data.__goaltrackerSync,transactions:transactions,transactionsStorage:'profile-v1'}}),saved.financeProfileDocument);
        }
        if(saved.financeDocument) return writeDocument('finance_transactions',transactions,saved.financeDocument,identity,saved);
        if(ownerId()!==identity)throw cloudFailure({code:'42501'},'finance_transactions.owner');
        const userId=saved.userId,payload=transactions.map(transaction=>transactionToRow(transaction,userId));
        const ids=new Set(payload.map(row=>row.id));
        if(ids.size!==payload.length)throw new Error('Обнаружены повторяющиеся ID транзакций.');
        const old=new Map(previous.map(row=>[row.id,row]));
        const changed=payload.filter(row=>!old.has(row.id)||Object.keys(row).some(key=>!same(row[key],old.get(row.id)[key])));
        if(changed.length) {
            const result=await saved.db.from('finance_transactions').upsert(changed,{onConflict:'id',defaultToNull:false});
            assertCurrent(saved);
            if(result.error)throw cloudFailure(result.error,'finance_transactions.upsert');
        }
        for(const row of previous)if(!ids.has(row.id)) {
            assertCurrent(saved);
            const result=await saved.db.from('finance_transactions').delete().eq('user_id',userId).eq('id',row.id);
            assertCurrent(saved);
            if(result.error)throw cloudFailure(result.error,'finance_transactions.delete');
        }
    }
    async function pullDirectState(saved = scope()) {
        assertCurrent(saved); const userId = cleanId(saved.userId,'user_id'), db = saved.db;
        delete saved.workspaceLayout; delete saved.workspaceProfile;
        const tables = ['profiles','goals','finance_transactions','safety_fund','user_profile'];
        const values = await Promise.all(tables.map(table => table === 'goals' ? goalRows(userId,db,saved) : table === 'finance_transactions' ? transactionRows(userId,db,saved) : tableRow(table,userId,db,saved)));
        let calendarRow = null;
        if (calendarMode !== 'legacy') {
            try {
                calendarRow=await tableRow('calendar_events',userId,db,saved);
                const failure=saved.readErrors?.get('calendar_events');
                if(failure && ['PGRST205','42P01','42703','PGRST204'].includes(failure.code)){saved.readErrors.delete('calendar_events');calendarMode='legacy';}
                else calendarMode='document';
            }
            catch (error) { if (!['PGRST205','42P01','42703','PGRST204'].includes(error.code)) throw error; calendarMode = 'legacy'; }
        }
        assertCurrent(saved); assertReadable(saved);
        const rows = Object.fromEntries(tables.map((table,index) => [table,values[index]])); rows.calendar_events = calendarRow;
        const profileRow = rows.profiles, fullProfile = documentContent(rows.user_profile?.data);
        const { __goaltrackerSync:extras,...profile } = fullProfile || {};
        const workspace = profileWorkspace(profileRow,saved.workspaceLayout) || profile.workspace || {portfolio:[],eloHistory:[],books:[],topics:[]};
        return { rows,revision:Number(profileRow?.revision || 0),exists:!!calendarRow || values.some(value => Array.isArray(value) ? value.length>0 : !!value),state:normalize({
            goals:saved.goalsDocument ? rows.goals : rows.goals.map(goalFromRow),transactions:rows.finance_transactions.map(transactionFromRow),safetyFund:documentContent(rows.safety_fund?.data)||{},
            profile:{ ...(fullProfile ? profile : profileRow?.extra?.profile || (profileRow ? {nickname:profileRow.nickname || profileRow.username || profileRow.handle || ''} : {})), ...(workspace ? {workspace} : {}) },
            financeOther:extras?.financeOther || profileRow?.extra?.financeOther || {},
            calendar:calendarRow ? documentContent(calendarRow.data) : extras?.calendar || profileRow?.extra?.calendar || {}
        }) };
    }

    async function writeDocument(table, data, previous, identity, saved = scope()) {
        assertCurrent(saved);
        if(table==='finance_transactions' && !saved.financeDocument)return writeTransactions(data,Array.isArray(previous)?previous:[],identity,saved);
        if(!['goals','finance_transactions','safety_fund','user_profile','calendar_events'].includes(table))throw new Error('Unsupported document table');
        if (ownerId() !== identity || localStorage.getItem(OWNER) !== identity) throw new Error('Аккаунт изменился.');
        if (previous && same(documentContent(previous.data), data)) return;
        const userId = cleanId(session.user.id, 'user_id');
        // Create-only upsert cannot overwrite a row inserted by another device.
        // Existing JSONB documents use a conditional update to preserve concurrent edits.
        const payload = versionedDocument(cleanPayload(data));
        let result;
        if (previous) {
            let query = client.from(table).update({ data: payload }).eq('user_id', userId);
            const old = previous.data;
            if (Array.isArray(old) && old.length === 0) query = query.eq('data', '[]');
            else {
                const versionPath = Array.isArray(old) ? `data->0->>${DOCUMENT_VERSION}` : `data->>${DOCUMENT_VERSION}`;
                const version = Array.isArray(old) ? old[0]?.[DOCUMENT_VERSION] : old?.[DOCUMENT_VERSION];
                query = version ? query.eq(versionPath, version) : query.is(versionPath, null);
                if (Array.isArray(old) && !version) query = query.neq('data', '[]');
            }
            result = await query.select('user_id');
        } else {
            result = await client.from(table).upsert({
                ...(table === 'calendar_events' ? { id: crypto.randomUUID() } : {}),
                user_id: userId,
                data: payload
            }, { onConflict: 'user_id', ignoreDuplicates: true }).select('user_id');
        }
        assertCurrent(saved);
        if (result.error) throw cloudFailure(result.error, `${table}.${previous ? 'update' : 'upsert'}`);
        if (!result.data?.length) throw cloudFailure({ code: '40001' }, `${table}.compare-and-swap`);
    }

    const rejectedProfileWrites = new WeakMap();
    async function upsertOwnedProfile(fields, options = {}, saved = scope()) {
        try {
            assertCurrent(saved);
            const { data, error } = await saved.db.auth.getUser();
            assertCurrent(saved);
            const user = data?.user;
            if (error || !user?.id) return { skipped: true, error: null };
            const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (!uuid.test(user.id) || user.id !== saved.userId || user.id !== session?.user?.id) {
                return { skipped: true, error: null };
            }
            // Production profiles use id/username; short_id is generated by the server.
            // Full profile documents belong to user_profile, never this payload.
            const username = typeof fields?.username === 'string' ? fields.username.trim() : '';
            if (!username) return { skipped: true, error: null };
            const handle = String(fields?.handle || user.user_metadata?.ncd_handle || app?.user?.handle || (/^[a-z][a-z0-9_]{2,31}$/.test(username.toLowerCase()) ? username : 'user_' + user.id.replace(/-/g,'').slice(0,27))).trim().replace(/^@/, '').toLowerCase();
            if (!/^[a-z][a-z0-9_]{2,31}$/.test(handle)) return { error: { code:'22023', message:'Некорректный handle профиля' } };
            const payload = { id: user.id, username, handle };
            const rejected = rejectedProfileWrites.get(saved.db);
            if (rejected?.userId === user.id) return { error: rejected.error };
            const result = await saved.db.from('profiles').upsert(payload, { ...options, onConflict: 'id' });
            assertCurrent(saved);
            // A schema rejection cannot recover by polling the same endpoint.
            if (result.error && (result.status === 400 || ['PGRST204','42703','22P02'].includes(result.error.code))) {
                rejectedProfileWrites.set(saved.db, { userId:user.id, error:result.error });
            }
            return result;
        } catch (error) {
            return { error };
        }
    }

    async function pushDirectState(state, remote, identity, saved = scope(), allowDeleteAllGoals = false) {
        assertCurrent(saved);
        const layout = await workspaceProfileSchema(saved);
        const { workspace, ...legacyProfile } = state.profile;
        const previousProfile = documentContent(remote.rows.user_profile?.data) || {};
        const profileData = { ...previousProfile, ...legacyProfile, ...(!layout ? {workspace} : {}), __goaltrackerSync: { ...previousProfile.__goaltrackerSync, financeOther: state.financeOther, calendar: state.calendar } };
        if(saved.financeUsesProfile) {
            profileData.__goaltrackerSync.transactions=state.transactions;
            profileData.__goaltrackerSync.transactionsStorage='profile-v1';
            saved.profileIncludesTransactions=true;
        }
        const profileRow = remote.rows.profiles;
        const value = { username: state.profile.nickname || 'Профиль' };
        if (!profileRow || (profileRow.username || profileRow.nickname) !== value.username) {
            const result = await upsertOwnedProfile(value, {}, saved);
            if (result.skipped) throw cloudFailure({code:'42501'}, 'profiles.auth');
            if (result.error) throw cloudFailure(result.error, 'profiles.upsert');
        }
        if (layout) await writeProfileWorkspace(workspace,remote,saved);
        await writeGoals(state.goals, remote.rows.goals, identity, saved, allowDeleteAllGoals);
        await writeTransactions(state.transactions,remote.rows.finance_transactions,identity,saved);
        for (const [table, data] of [['safety_fund',state.safetyFund],['user_profile',profileData]]) {
            await writeDocument(table, data, remote.rows[table], identity, saved);
        }
        if (calendarMode === 'document') {
            try {
                await writeDocument('calendar_events',state.calendar,remote.rows.calendar_events,identity,saved);
            } catch (error) {
                if (!calendarSchemaMismatch(error)) throw error;
                // Keep calendar data in user_profile.__goaltrackerSync when the
                // existing table is a legacy event-row schema, not a document table.
                calendarMode = 'legacy';
            }
        }
        assertCurrent(saved);

    }

    async function saveAccountProfile(nickname = app?.user?.nickname, { preserveExisting = false } = {}) {
        const username = String(nickname || '').trim();
        if (transitioning || loggingOut || readyIdentity !== ownerId() || !client || !session || !app || username.length < 2 || username.length > 32) return false;
        const saved = scope();
        const pendingKey = `gt-social-profile-pending-v1:${ownerId()}`;
        if (!preserveExisting) write(pendingKey, { username });
        // Account profiles use profiles(id, username, short_id, ...).
        // Upsert only owned fields so generated short_id and other server fields survive.
        if (!bootstrapIdentity) await tableRow('profiles', saved.userId, saved.db, saved);
        const result = await upsertOwnedProfile({ username }, { ignoreDuplicates: preserveExisting }, saved);
        if (result.skipped) return false;
        if (result.error) throw result.error;
        if (!preserveExisting) localStorage.removeItem(pendingKey);
        return true;
    }

    let goalRefreshWork = null, goalSyncWork = null;
    function syncGoalsOnly() {
        if (goalSyncWork) return goalSyncWork;
        if (isSyncing || busy || applying || transitioning || loggingOut || !session ||
            localStorage.getItem(OWNER) !== ownerId() || app?.user?.supabaseUserId !== session.user.id ||
            navigator.onLine === false || appBusy()) {
            goalsDiagnostic = 'Цели: ожидаем завершения текущей операции или восстановления подключения.';
            refresh();
            return Promise.resolve(false);
        }
        const saved = scope();
        const accountNotice = message;
        const work = (async () => {
            try {
                const meta = read(metaKey(), {base:null,revision:0});
                const pending = read(pendingKey(saved.identity),null);
                const base = clone(meta.base || empty());
                const before = clone(app.goals);
                let localGoals = before;
                if (meta.receipt) {
                    // An unfinished apply of another section must not silently
                    // disable goals forever. Settle only the goals receipt.
                    const accepted = meta.receipt.accepted.goals || [];
                    const recovered = merge(meta.receipt.before.goals || [],before,accepted,undefined,'/goals',[],hasPendingGoalDeletion(pending,meta.receipt.before,capture()));
                    if (recovered.conflicts.length) {
                        goalsDiagnostic = 'Цели: локальные изменения пересеклись с сохранённой версией. Обе копии сохранены.';
                        refresh(); return false;
                    }
                    localGoals = recovered.value; base.goals = accepted;
                }
                goalsDiagnostic = 'Цели: запрос к облаку…'; refresh();
                const previous = await goalRows(saved.userId,saved.db,saved);
                assertReadable(saved); assertCurrent(saved);
                const remote = saved.goalsDocument ? previous : previous.map(goalFromRow);
                validateState({...empty(),goals:remote});
                const allowDelete = hasPendingGoalDeletion(pending,base,capture());
                const merged = merge(base.goals || [],localGoals,remote,undefined,'/goals',[],allowDelete);
                if (merged.conflicts.length) {
                    status('Изменения целей пересеклись. Локальная и облачная версии сохранены.');
                    return false;
                }
                await writeGoals(merged.value,previous,saved.identity,saved,allowDelete);
                const verified = await goalRows(saved.userId,saved.db,saved);
                assertReadable(saved); assertCurrent(saved);
                const confirmed = saved.goalsDocument ? verified : verified.map(goalFromRow);
                validateState({...empty(),goals:confirmed});
                // Preserve edits made while the independent goals request ran.
                const next = merge(before,capture().goals,confirmed,'local','/goals',[],allowDelete).value;
                if (!await applyState(() => ({...capture(),goals:next}),saved)) return false;
                assertCurrent(saved);
                meta.base = {...base,goals:clone(confirmed)};
                if (meta.receipt) {
                    meta.receipt.before.goals = clone(next);
                    meta.receipt.accepted.goals = clone(confirmed);
                }
                write(metaKey(),meta);
                const local = capture();
                savePending(saved.identity,same(local,meta.base) ? null : {base:meta.base,local});
                await saveAccountSnapshot();
                renderPulledState();
                // Other sections may still have failed; never mark the whole
                // account as synchronized after confirming goals alone.
                const details = accountNotice.startsWith('Цели синхронизированы:') ? 'Остальные разделы пока не синхронизированы.' : accountNotice;
                goalsDiagnostic = `Цели: сервер подтвердил ${confirmed.length}.`;
                status(`Цели синхронизированы: ${confirmed.length}. ${details}`);
                return true;
            } catch (error) {
                if (current(saved)) {
                    const code = /^(?:PGRST\d{3}|[0-9A-Z]{5})$/.test(error.code || '') ? error.code : '';
                    goalsDiagnostic = `Цели: ${error.operation || 'goals.sync'}${code ? ' · Код: '+code : ''}`;
                    status('Не удалось синхронизировать цели. Локальная копия сохранена.');
                }
                return false;
            }
        })();
        goalSyncWork = work;
        work.finally(() => {if (goalSyncWork === work) goalSyncWork = null;}).catch(() => {});
        return work;
    }
    let sectionSyncWork = null;
    async function userDocument(saved) {
        const row = await tableRow('user_profile',saved.userId,saved.db,saved);
        assertReadable(saved); assertCurrent(saved);
        return {row,data:documentContent(row?.data) || {}};
    }
    async function patchUserDocument(saved,patch,expected = null) {
        const current = expected || await userDocument(saved);
        await writeDocument('user_profile',patch(clone(current.data)),current.row,saved.identity,saved);
    }
    function sectionField(name,path,fallback,readSection,writeSection) {
        return {name,initial:clone(fallback),mergePath:'/'+path.join('/'),read:readSection,write:writeSection,
            get(state) { return clone(path.reduce((value,key) => value?.[key],state) ?? fallback); },
            put(state,value) {
                let target = state;
                for (const key of path.slice(0,-1)) target = target[key] ||= {};
                target[path.at(-1)] = clone(value);
            }
        };
    }
    const sectionAdapters = [
        sectionField('Календарь',['calendar'],{},async saved => {
            const row = await tableRow('calendar_events',saved.userId,saved.db,saved);
            const error = saved.readErrors?.get('calendar_events');
            if (error) {
                if (!['42703','42P01','PGRST204','PGRST205'].includes(error.code)) throw error;
                saved.readErrors.delete('calendar_events');
            }
            if (row) return {value:documentContent(row.data),row,document:true};
            const full = await userDocument(saved);
            const value = full.data.__goaltrackerSync?.calendar;
            return {value:value || {},row:null,document:!error && value === undefined,userDocument:full,newStorage:!!error && value === undefined};
        },async (value,remote,saved) => {
            if (remote.document) {
                try { await writeDocument('calendar_events',value,remote.row,saved.identity,saved); return; }
                catch (error) { if (!calendarSchemaMismatch(error)) throw error; }
            }
            await patchUserDocument(saved,data => ({...data,__goaltrackerSync:{...data.__goaltrackerSync,calendar:value}}),remote.userDocument);
        }),
        sectionField('Финансовые операции',['transactions'],[],async saved => {
            const rows = await transactionRows(saved.userId,saved.db,saved);
            assertReadable(saved);
            return {value:rows.map(transactionFromRow),rows,newStorage:saved.financeUsesProfile && !saved.financeHasProfileData};
        },(value,remote,saved) => writeTransactions(value,remote.rows,saved.identity,saved)),
        sectionField('Подушка безопасности',['safetyFund'],{},async saved => {
            const row = await tableRow('safety_fund',saved.userId,saved.db,saved);assertReadable(saved);
            return {value:documentContent(row?.data) || {},row,newStorage:!row};
        },(value,remote,saved) => writeDocument('safety_fund',value,remote.row,saved.identity,saved)),
        sectionField('Бюджет и инвестиции',['financeOther'],{},async saved => {
            const full = await userDocument(saved);return {value:full.data.__goaltrackerSync?.financeOther || {},userDocument:full,newStorage:full.data.__goaltrackerSync?.financeOther === undefined};
        },(value,remote,saved) => patchUserDocument(saved,data => ({...data,__goaltrackerSync:{...data.__goaltrackerSync,financeOther:value}}),remote.userDocument)),
        sectionField('Case и обучение',['profile','workspace'],{portfolio:[],eloHistory:[],books:[],topics:[]},async saved => {
            delete saved.workspaceLayout; delete saved.workspaceProfile;
            let layout = null,profile = null;
            try { layout = await workspaceProfileSchema(saved);profile = saved.workspaceProfile; }
            catch (error) { if (!missingReadSchema(error)) throw error; }
            if (saved.readErrors?.has('profiles')) saved.readErrors.delete('profiles');
            const structured = profileWorkspace(profile,layout);
            const full = structured ? null : await userDocument(saved);
            return {value:structured || full?.data.workspace || {portfolio:[],eloHistory:[],books:[],topics:[]},layout,profile,userDocument:full,newStorage:!layout && full?.data.workspace === undefined};
        },async (value,remote,saved) => {
            if (remote.layout) await writeProfileWorkspace(value,{rows:{profiles:remote.profile}},saved);
            else await patchUserDocument(saved,data => ({...data,workspace:value}),remote.userDocument);
        }),
        sectionField('Здоровье',['profile','health'],{metrics:{},lastReadAt:null},async saved => {
            const full = await userDocument(saved);return {value:healthSnapshot(full.data.health),userDocument:full,newStorage:full.data.health === undefined};
        },(value,remote,saved) => patchUserDocument(saved,data => ({...data,health:healthSnapshot(value)}),remote.userDocument))
    ];
    const profileFields = ['nickname','status','createdAt','customAvatarData','habits','gamification'];
    const profileSection = {
        name:'Профиль, привычки и достижения',
        get(state) {
            const source=state.profile || {};
            return {nickname:source.nickname || '',status:source.status || '',createdAt:source.createdAt || '',customAvatarData:source.customAvatarData || '',habits:source.habits || [],gamification:source.gamification || {}};
        },
        put(state,value) {state.profile ||= {};for(const field of profileFields)state.profile[field]=clone(value[field]);},
        async read(saved) {const full=await userDocument(saved);return {value:this.get({profile:full.data}),userDocument:full,newStorage:!full.row};},
        write(value,remote,saved) {return patchUserDocument(saved,data=>({...data,...value}),remote.userDocument);}
    };
    profileSection.initial=profileSection.get(empty());
    sectionAdapters.push(profileSection);
    async function syncSection(adapter) {
        const saved=scope(),meta=read(metaKey(),{base:null,revision:0});
        const base=clone(meta.base || empty()),before=capture();
        if(meta.startupBaseline && !meta.confirmedSections?.includes(adapter.name))adapter.put(base,adapter.get(meta.startupBaseline));
        let local=adapter.get(before);
        if(meta.receipt) {
            const recovery=merge(adapter.get(meta.receipt.before),local,adapter.get(meta.receipt.accepted),undefined,adapter.mergePath || '/profile');
            if(recovery.conflicts.length)throw cloudFailure({code:'40001'},adapter.name+'.receipt');
            local=recovery.value;adapter.put(base,adapter.get(meta.receipt.accepted));
        }
        const remote=await adapter.read(saved);assertCurrent(saved);
        if(remote.newStorage)adapter.put(base,adapter.initial);
        const merged=merge(adapter.get(base),local,remote.value,undefined,adapter.mergePath || '/profile');
        if(merged.conflicts.length)throw cloudFailure({code:'40001'},adapter.name+'.merge');
        const changed=!same(merged.value,remote.value);
        if(changed)await adapter.write(merged.value,remote,saved);
        const verified=changed?await adapter.read(saved):remote;assertCurrent(saved);
        const accepted=verified.value;
        const current=adapter.get(capture());
        const incoming=merge(adapter.get(before),current,accepted,'local').value;
        if(!await applyState(()=>{const next=capture();adapter.put(next,incoming);return next;},saved))return false;
        assertCurrent(saved);
        // Reload metadata after applying, keeping baselines for unrelated sections.
        const latest=read(metaKey(),meta);latest.base ||= base;adapter.put(latest.base,accepted);
        latest.confirmedSections=[...new Set([...(latest.confirmedSections || []),adapter.name])];
        if(latest.receipt){adapter.put(latest.receipt.before,incoming);adapter.put(latest.receipt.accepted,accepted);}
        write(metaKey(),latest);
        const state=capture();savePending(saved.identity,same(state,latest.base)?null:{base:latest.base,local:state});
        await saveAccountSnapshot();return true;
    }
    function syncOtherSections() {
        if(sectionSyncWork)return sectionSyncWork;
        if(isSyncing || busy || applying || transitioning || loggingOut || !session || navigator.onLine===false || appBusy() || localStorage.getItem(OWNER)!==ownerId())return Promise.resolve(false);
        const saved=scope();
        const work=(async()=>{
            const completed=[],errors=[];
            for(const adapter of sectionAdapters) {
                if(!current(saved))return false;
                try {if(await syncSection(adapter))completed.push(adapter.name);}
                catch(error){if(!current(saved))return false;errors.push(`${adapter.name}: ${error.operation || 'запрос'}${error.code?' · '+error.code:''}`);}
            }
            if(!current(saved))return false;
            sectionsDiagnostic=errors.join(' · ');
            const goals=goalsDiagnostic.includes('сервер подтвердил')?'Цели; ':'';
            status(`Синхронизированы: ${goals}${completed.join('; ') || 'пока нет'}.${errors.length || lastSyncFailure?' Синхронизация не завершена. Отдельные разделы ожидают отправки.':''}`);
            return errors.length===0;
        })();
        sectionSyncWork=work;
        work.finally(()=>{if(sectionSyncWork===work)sectionSyncWork=null;}).catch(()=>{});
        return work;
    }
    async function syncIndependentSections() {
        await syncGoalsOnly();
        return syncOtherSections();
    }
    function refreshGoals() {
        if (goalRefreshWork) return goalRefreshWork;
        const work = pullGoals();
        goalRefreshWork = work;
        work.finally(() => { if (goalRefreshWork === work) goalRefreshWork = null; }).catch(() => {});
        return work;
    }
    async function pullGoals() {
        if (!client || !session || !app || busy || applying || transitioning || loggingOut || readyIdentity !== ownerId()) return false;
        const saved = scope();
        if (localStorage.getItem(OWNER) !== ownerId()) return false;
        try {
            const rows = await goalRows(saved.userId, saved.db, saved);
            assertCurrent(saved);
            if (saved.readErrors?.has('goals')) return false;
            // A running full sync owns its receipt and will render the incoming data.
            if (busy || applying || appBusy()) return false;
            const meta = read(metaKey(), { base: null, revision: 0 });
            if (meta.receipt) return false;
            const remote = saved.goalsDocument ? rows : rows.map(goalFromRow);
            const local = capture();
            const pending = read(pendingKey(saved.identity), null);
            const allowDelete = hasPendingGoalDeletion(pending, meta.base, local);
            const merged = merge(meta.base?.goals || [], local.goals, remote, undefined, '/goals', [], allowDelete);
            if (merged.conflicts.length) return false;
            applying = true;
            try {
                const previous = app.goals;
                app.goals = clone(merged.value);
                try {
                    if (await app.saveData({ deferAutoSync: true }) !== true) throw new Error('Local save failed');
                    assertCurrent(saved);
                } catch (error) { if (current(saved)) app.goals = previous; throw error; }
                if (meta.base) { meta.base.goals = clone(remote); write(metaKey(), meta); }
                app.renderGoals(true);
            } finally { applying = false; }
            localChanged();
            return true;
        } catch { return false; }
    }
    async function pushGoals(goal) {
        // Goal writes use the account-wide merge and readback path, which also
        // handles both row and JSON-document schemas consistently.
        if (isSyncing) return false;
        if (!client || !session || !app || transitioning || loggingOut || readyIdentity !== ownerId() || localStorage.getItem(OWNER) !== ownerId()) return false;
        return sync();
    }

    function renderPulledState() {
        const settingsOpen = document.getElementById('settingsModal')?.classList.contains('active');
        if (settingsOpen) app.updateSettingsProfile?.();
        else {
            try {
                switch (app.currentView) {
                    case 'dashboard': app.renderDashboard(); break;
                    case 'goals': app.renderGoals(true); break;
                    case 'achievements': app.renderAchievements(); break;
                    case 'calendar': app.renderCalendar(); break;
                    case 'finance': window.renderFinanceView?.(); break;

                    case 'health': window.healthView?.render(); break;
                    case 'case': window.CaseView?.render(app); break;
                    case 'learning': window.LearningView?.render(app); break;
                }
            } catch {}
        }
        try { app.updateGreeting(); } catch {}
    }

    async function bootstrapCloud(force = false) {
        if (!client || !session || !app) return false;
        if (transitioning || readyIdentity !== ownerId() || localStorage.getItem(OWNER) !== ownerId()) return acceptSession(session,true);
        return sync(force ? 'remote' : undefined);
    }

    function stopRealtime() {
        clearTimeout(realtimeTimer);
        const previous = dataChannel; dataChannel = null; realtimeIdentity = null;
        if (previous && client?.removeChannel) Promise.resolve(client.removeChannel(previous)).catch(() => {});
    }
    function startRealtime() {
        if (!client?.channel || !session || realtimeIdentity === ownerId()) return;
        stopRealtime();
        const identity = ownerId(), userId = session.user.id, saved = scope();
        realtimeIdentity = identity;
        dataChannel = client.channel(`goaltracker-data:${userId}`);
        const changed = () => {
            if (!current(saved) || transitioning) return;
            clearTimeout(realtimeTimer);
            realtimeTimer = setTimeout(() => sync(), 150);
        };
        for (const table of ['goals','calendar_events','finance_transactions','safety_fund','user_profile','profiles']) {
            if (table === 'calendar_events' && calendarMode === 'legacy') continue;
            const column = table === 'profiles' ? 'id' : 'user_id';
            dataChannel = dataChannel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `${column}=eq.${userId}` }, changed);
        }
        dataChannel.subscribe(state => {
            if (!current(saved)) return;
            if (state === 'SUBSCRIBED') changed();
            // A periodic direct read remains active when Realtime is unavailable.
        });
    }
    async function applyState(compute, saved = scope()) {
        assertCurrent(saved);
        if (appBusy()) return false;
        applying = true;
        const controls = [...document.querySelectorAll('button,input,textarea,select')]
            .filter(element => !element.closest('#goalModal'))
            .filter(element => !(app.currentView === 'finance' && element.matches('input,textarea,select') && element.closest('#financeMain')))
            .map(element => [element, element.disabled]);
        try {
            await window.ProfileStorage.flush?.();
            assertCurrent(saved);
            // The user can open the form while storage is flushing. Keep the
            // receipt for the next sync instead of applying over an active draft.
            if (appBusy()) return false;
            const before = capture(), next = normalize(compute(before));
            if (same(before, next) && app.user?.supabaseUserId === session.user.id) return true;
            controls.forEach(([element]) => { element.disabled = true; });
            const local = app.serialize();
            const financeBefore = window.finance?.getData?.() || read('goalTracker_finance', {});
            // Keep a reviewable local backup before any incoming cloud replacement.
            write(backupKey(), { savedAt: new Date().toISOString(), profile: local, finance: financeBefore, avatar: before.profile.customAvatarData });
            const data = { ...local, user: { ...(local.user || {}), nickname: next.profile.nickname || local.user?.nickname || session.user.email?.split('@')[0] || 'Профиль', status: next.profile.status || '', ...(next.profile.createdAt ? { createdAt: next.profile.createdAt } : {}) },
                workspace: next.profile.workspace || {portfolio:[],eloHistory:[],books:[],topics:[]}, habits:next.profile.habits ?? local.habits ?? [], gamification:next.profile.gamification ?? local.gamification ?? {}, goals: next.goals, notes: next.calendar.notes || {}, events: next.calendar.events || [], achievements: next.calendar.achievements || [] };
            if (!data.user.id) data.user.id = crypto.randomUUID();
            data.user.supabaseUserId = session.user.id;
            const finance = { ...next.financeOther, transactions: next.transactions, safetyFund: next.safetyFund };
            const avatarKey = `customAvatarData:${data.user.id || data.user.createdAt || 'local'}`;
            const avatar = next.profile.customAvatarData || '';
            if (avatar && (avatar.length > 200000 || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar))) throw new Error('Облачный аватар имеет неподдерживаемый формат.');
            try {
                localStorage.setItem('goalTracker_finance', JSON.stringify(finance));
                localStorage.setItem(avatarKey, avatar);
                await window.ProfileStorage.save(data);
                assertCurrent(saved);
            } catch (error) {
                localStorage.setItem('goalTracker_finance', JSON.stringify(financeBefore));
                localStorage.setItem(avatarKey, before.profile.customAvatarData || '');
                throw error;
            }
            app.loadData();
            if (app.gamificationEngine) app.gamificationEngine.state = app.gamification;
            window.finance?.replaceData?.(finance); app.updateGreeting(); app.render();
            if (next.profile.health) {
                const health = healthSnapshot(next.profile.health);
                const previousHealth = read('goalTracker_health_local_v1',{});
                localStorage.setItem('goalTracker_health_account_v1',JSON.stringify(health));
                localStorage.setItem('goalTracker_health_local_v1',JSON.stringify({...previousHealth,...health}));
                window.healthView?.restoreAccount?.();
            }
            app.rescheduleAllNotifications?.().catch(() => {});
            return true;
        } finally {
            applying = false; controls.forEach(([element, disabled]) => { if (element.isConnected) element.disabled = disabled; });
        }
    }
    async function settleReceipt(meta, prefer, saved = scope()) {
        assertCurrent(saved);
        if (!meta.receipt) return true;
        let merged;
        const applied = await applyState(now => {
            merged = merge(meta.receipt.before, now, meta.receipt.accepted, prefer, '', [], hasPendingGoalDeletion(read(pendingKey(saved.identity),null),meta.receipt.before,now));
            if (merged.conflicts.length) { conflict = true; throw new Error('Локальные правки пересеклись с входящей синхронизацией. Повторите синхронизацию.'); }
            return merged.value;
        },saved);
        assertCurrent(saved);
        if (applied) { delete meta.receipt; write(metaKey(), meta); }
        return applied;
    }
    function hasPendingGoalDeletion(pending, base, local) {
        return !!pending && Array.isArray(pending.base?.goals) && pending.base.goals.length > 0 &&
            Array.isArray(pending.local?.goals) && pending.local.goals.length === 0 &&
            same(pending.base.goals,base?.goals) && same(pending.local.goals,local?.goals);
    }
    function sync(prefer) {
        // A request made just as the phone reconnects must not disappear while
        // an earlier independent section is finishing.
        if (sectionSyncWork) return sectionSyncWork.then(() => sync(prefer));
        if (goalSyncWork) return goalSyncWork.then(() => sync(prefer));
        if (isSyncing) return Promise.resolve(false);
        isSyncing = true; lastSyncSucceeded = false; lastSyncFailure = null; goalsDiagnostic = ''; sectionsDiagnostic = '';
        const work = performSync(prefer);
        const guarded = work.finally(() => {
            isSyncing = false;
            if (syncWork === guarded) syncWork = null;
            const repeat = rerunSync; rerunSync = false;
            // Retry once only after a successful pass and only if a local edit
            // arrived in flight. Network and schema errors do not retry-loop.
            if (repeat && lastSyncSucceeded && client && session && !transitioning && !loggingOut) {
                clearTimeout(timer); timer = setTimeout(() => sync(), 250);
            }
        });
        syncWork = guarded;
        return guarded.then(async result => {
            // Do not retry invalid goal payloads or failed goal writes through
            // a second path. Independence is for failures in other domains.
            if (!result && !lastSyncFailure?.payloadField) {
                if (!lastSyncFailure?.operation?.startsWith('goals.')) await syncGoalsOnly();
                await syncOtherSections();
            }
            return result;
        });
    }
    async function performSync(prefer) {
        if (!client || !session || !app || transitioning || loggingOut || readyIdentity !== ownerId()) return false;
        if (busy || applying) return false;
        const identity = ownerId(), saved = scope();
        if (localStorage.getItem(OWNER) !== identity) { setTimeout(() => acceptSession(session,true),0); return false; }
        if (navigator.onLine === false) { status('Офлайн: данные остаются на устройстве.'); return false; }
        if (appBusy()) { status('Дождитесь завершения текущего сохранения.'); return false; }
        busy = true; conflict = false; syncDiagnostic = ''; status('Синхронизация…');
        let operation = 'tables.select';
        try {
            let meta = read(metaKey(), { base: null, revision: 0 });
            if (!await settleReceipt(meta, prefer, saved)) { status('Ожидание завершения локального сохранения.'); return false; }
            const response = await pullDirectState(saved);
            if (app._resetting || ownerId() !== identity || localStorage.getItem(OWNER) !== identity) throw new Error('Аккаунт изменился. Синхронизация прервана.');
            const remote = validateState(response.state), local = validateState(capture());
            const initialBase = response.exists && localEmpty(local) ? clone(local) : empty();
            if (!meta.base && response.exists && Object.keys(remote.profile).length) initialBase.profile = clone(local.profile);
            const base = clone(meta.base || initialBase);
            if(saved.financeUsesProfile && !saved.financeHasProfileData)base.transactions=[];
            const allowDeleteAllGoals = hasPendingGoalDeletion(read(pendingKey(identity),null),base,local);
            const pending = merge(base, local, remote, undefined, '', [], allowDeleteAllGoals);
            previews = pending.conflicts.map(path => {
                const get = state => path.split('/').slice(1).reduce((value, key) => Array.isArray(value) ? value.find(item => item.id === key) : value?.[key], state);
                const describe = value => path.includes('customAvatarData') ? (value ? 'Фото профиля' : 'Без фото') : path === '/safetyFund' ? `Баланс: ${value?.balance || 0}, пополнений: ${value?.history?.length || 0}` : value === undefined ? 'Удалено' : JSON.stringify(value).slice(0, 250);
                return `${path.split('/').at(-1)} · На устройстве: ${describe(get(local))} · В облаке: ${describe(get(remote))}`;
            });
            if (prefer && pending.conflicts.length) write(`gt-cloud-conflict-backup-v1:${identity}`, { savedAt: new Date().toISOString(), base, local, remote });
            const merged = prefer ? merge(base, local, remote, prefer, '', [], allowDeleteAllGoals) : pending;
            if (merged.conflicts.length) { conflict = true; status(`Обнаружены пересекающиеся изменения (${merged.conflicts.length}). Выберите версию спорных полей.`); return false; }
            operation = 'tables.write';
            await pushDirectState(merged.value, response, identity, saved, allowDeleteAllGoals);
            const confirmed = await pullDirectState(saved);
            const accepted = validateState(confirmed.state);
            const revision = confirmed.revision;
            if (app._resetting || ownerId() !== identity || localStorage.getItem(OWNER) !== identity) throw new Error('Аккаунт изменился. Данные сохранены в прежнем аккаунте; локальный профиль не заменён.');
            // Receipt is durable before applying: edits made while the request was in flight survive.
            meta = { base: accepted, revision, receipt: { before: local, accepted } };
            write(metaKey(), meta);
            if (!await settleReceipt(meta, prefer, saved)) { status('Облако сохранено. Ожидание локального сохранения.'); return false; }
            assertCurrent(saved);
            renderPulledState();
            if (same(capture(),meta.base)) savePending(identity,null);
            startRealtime();
            status('Синхронизировано · ' + new Date().toLocaleTimeString('ru-RU'));
            if (!same(capture(), meta.base)) savePending(identity,{ base:meta.base,local:capture() });
            lastSyncSucceeded = true;
            return true;
        } catch (error) {
            if (!current(saved)) return false;
            lastSyncFailure = error;
            // Do not log responses, tokens, profile content or credentials.
            const code = /^(?:PGRST\d{3}|[0-9A-Z]{5})$/.test(error?.code || '') ? error.code : '';
            syncDiagnostic = code ? `Код: ${code} · Операция: ${error.operation || operation}` : error.payloadField ? `Некорректное поле: ${error.payloadField}. Отправка остановлена; данные сохранены на устройстве.` : '';
            // Keep direct REST failures visible; never report a partial write as synchronized.
            status(error.operation === 'profiles.workspace.schema' ? 'Case и Обучение сохранены на устройстве. Для облачного сохранения подтвердите JSONB-поля таблицы profiles или примените миграцию модулей.' : conflict ? 'Локальные и облачные правки пересеклись. Выберите версию спорных полей.' : 'Синхронизация не завершена. Локальные данные сохранены. Повторите попытку; если ошибка сохраняется, проверьте доступ к данным в Supabase.');
            return false;
        } finally {
            busy = false; refresh();
        }
    }
    function acceptSession(next, force = false, quiet = true, onOpened = null) {
        if (!next?.user?.id) next = null;
        if (loggingOut) return Promise.resolve(false);
        const identity = next?.user?.id ? `${config.url}|${next.user.id}` : null;
        // While the user is filling in auth, SDK/focus/reconnect events must not
        // start a profile load. Explicit successful authentication passes quiet=false.
        if (quiet && next && readyIdentity !== identity && document.getElementById('cloudAuthModal')?.classList.contains('active')) return Promise.resolve(false);
        if (!force && identity === desiredIdentity && sessionLoad) { session = next; return sessionLoad; }
        if (!force && next && readyIdentity === identity && localStorage.getItem(OWNER) === identity) { session = next; return Promise.resolve(true); }
        if (!next && settledNoSession && !app.user && !sessionLoad) return Promise.resolve(false);
        const owned = !!identity && app.user?.supabaseUserId === next.user.id && (!localStorage.getItem(OWNER) || localStorage.getItem(OWNER) === identity);
        const previousMeta = identity ? read(`gt-cloud-state-v1:${identity}`,{}) : {};
        let pending = identity ? read(pendingKey(identity),null) : null;
        if (owned && !pending && previousMeta.base && !same(previousMeta.base,capture())) pending = { base:previousMeta.base,local:capture() };
        if (!owned) pending = null;
        let opened = false, openingState = null, restored = null;
        const openBeforeSync = !!next;
        const epoch = ++accountEpoch; session = next; desiredIdentity = identity; readyIdentity = null; transitioning = true; settledNoSession = false;
        stopAccountRequests(); conflict = false; bindNeeded = false; previews = []; syncDiagnostic = ''; app._accountTransition = true; if (!openBeforeSync) app.showAccountLoading?.();
        const openWorkspace = () => {
            openingState = capture(); opened = true; app._accountTransition = false;
            authNotice = ''; authSuccess = false; closeAuth(); app.showApp();
            onOpened?.(true);
        };
        // The owned cache is already loaded by app.init(); no queue, disk write or network may delay it.
        if (owned && openBeforeSync) openWorkspace();
        status(next ? 'Загружаем данные аккаунта…' : 'Войдите в облачный аккаунт.');
        const work = accountQueue.catch(() => {}).then(async () => {
            if (epoch !== accountEpoch) return false;
            if (syncWork) await syncWork.catch(() => {});
            await pendingWrites.catch(() => {}); await tokenWrites.catch(() => {});
            const start = Date.now();
            while (appBusy()) { if (Date.now()-start > 16000) throw new Error('Дождитесь завершения текущего действия и повторите вход.'); await new Promise(resolve => setTimeout(resolve,20)); }
            if (epoch !== accountEpoch) return false;
            if (identity && (!owned || localEmpty(capture()))) {
                restored = await readAccountSnapshot(identity,next.user.id);
                if (epoch !== accountEpoch) return false;
                // An empty active cache after a prior failed logout is not a
                // reason to discard a surviving account snapshot.
                if (owned && restored && localEmpty(restored.local)) restored = null;
                if (restored) pending = {base:restored.base,local:restored.local};
            }
            if (owned && !pending && nativePreferences) {
                const stored = await preferences.get({ key:pendingKey(identity) });
                if (stored.value) pending = JSON.parse(stored.value);
            }
            if (!owned) app.clearAccountMemory?.();
            await app.cancelAllNotifications?.();
            if (!owned) await clearUserCaches({ keepAuth:true });
            if (epoch !== accountEpoch) return false;
            if (!next) {
                settledNoSession = true; transitioning = false; app._accountTransition = false;
                app.showAuth(); return false;
            }
            localStorage.setItem(OWNER,identity); calendarMode = null;
            const metadata = next.user.user_metadata || {};
            if (!owned) app.user = { id:next.user.id,supabaseUserId:next.user.id,nickname:metadata.ncd_handle || metadata.username || metadata.nickname || next.user.email?.split('@')[0] || 'Профиль',createdAt:next.user.created_at || new Date().toISOString() };
            app.settings.autoSync = true;
            if (restored) {
                app.settings = {...app.settings,...restored.settings,autoSync:true};
                if (restored.deviceHealth) localStorage.setItem('goalTracker_health_local_v1',JSON.stringify(restored.deviceHealth));
                window.healthView?.restoreAccount?.();
                write(metaKey(),{base:restored.base,revision:0});
                if (!await applyState(() => restored.local,scope())) throw new Error('Не удалось восстановить сохранённые данные аккаунта.');
            }
            if (openBeforeSync && !opened) openWorkspace();
            app.user.shortId = null;
            await window.ProfileStorage.save(app.serialize());
            if (navigator.onLine === false) throw cloudFailure({code:'FETCH_ERROR'},'account.pull');
            const saved = scope();
            // Yield to the visible local workspace before starting network hydration.
            await new Promise(resolve => setTimeout(resolve, 0));
            assertCurrent(saved);
            const response = await withCloudTimeout(async () => {
                const response = await pullDirectState(saved);
                if (!response.rows.profiles || !response.rows.profiles.handle) {
                    // Missing rows are normal on first login. Insert only the owned profile,
                    // without replacing a profile concurrently created by another device.
                    const nickname = response.rows.profiles?.username || response.state.profile?.nickname || app.user.nickname;
                    const hadProfile = !!response.rows.profiles;
                    const handle = next.user.user_metadata?.ncd_handle;
                    const profile = { username:nickname };
                    if (typeof handle === 'string' && /^[a-z][a-z0-9_]{2,31}$/.test(handle)) profile.handle = handle;
                    const created = await upsertOwnedProfile(profile, {}, saved);
                    if (created.skipped) throw cloudFailure({code:'42501'}, 'profiles.auth');
                    if (created.error) throw cloudFailure(created.error, 'profiles.upsert');
                    response.rows.profiles = await tableRow('profiles',next.user.id,saved.db,saved);
                    if (!hadProfile) response.state.profile = { ...response.state.profile, nickname:response.rows.profiles?.username || response.rows.profiles?.nickname || nickname };
                }
                return response;
            }, saved);
            const remote = validateState(response.state);
            assertCurrent(saved);
            if(saved.financeUsesProfile && !saved.financeHasProfileData && (owned || restored) && capture().transactions.length) {
                pending ||= {base:clone(previousMeta.base || empty()),local:capture()};
                pending.base.transactions=[];
            }
            let incoming = remote, pendingConflicts = false;
            if ((owned || restored) && pending) {
                const pendingBase = validateState(pending.base), pendingLocal = validateState(pending.local);
                const merged = merge(pendingBase,pendingLocal,remote,undefined,'',[],hasPendingGoalDeletion(pending,pendingBase,pendingLocal));
                incoming = merged.value; pendingConflicts = merged.conflicts.length > 0;
            }
            if (opened) incoming = merge(openingState,capture(),incoming,'local').value;
            write(metaKey(),{ base:pendingConflicts ? pending.base : remote,revision:response.revision });
            if (!await applyState(() => incoming,saved)) throw new Error('Не удалось применить данные аккаунта. Повторите вход.');
            app.user.handle = response.rows.profiles?.handle;
            assertCurrent(saved); readyIdentity = identity; bootstrapIdentity = identity; transitioning = false; app._accountTransition = false;
            if (!same(incoming,remote) || pendingConflicts) savePending(identity,{ base:pendingConflicts ? pending.base : remote,local:incoming }); else savePending(identity,null);
            app.showApp(); renderPulledState(); startRealtime();
            await saveAccountSnapshot().catch(() => { storageWarning = true; });
            clearInterval(polling); polling = setInterval(() => sync(),5000);
            status('Синхронизировано · ' + new Date().toLocaleTimeString('ru-RU'));
            if (!same(capture(),remote)) localChanged();
            return true;
        }).catch(async error => {
            if (epoch !== accountEpoch) return false;
            readyIdentity = null; transitioning = false; app._accountTransition = false;
            if (opened) {
                const partialMeta=read(metaKey(),{});
                if(!partialMeta.base && !partialMeta.startupBaseline){partialMeta.startupBaseline=owned?empty():openingState;write(metaKey(),partialMeta);}
                savePending(identity,{ base:pending?.base || openingState, local:capture() });
                syncDiagnostic = error.code ? `Код: ${error.code} · Операция: ${error.operation || 'account.pull'}` : '';
                authNotice = ''; authSuccess = false;
                status('Сессия активна. Данные пока не синхронизированы.');
                await syncIndependentSections();
                if (epoch !== accountEpoch) return false;
                startRealtime();
                clearInterval(polling); polling = setInterval(() => bootstrapCloud(),5000);
                return false;
            }
            app.clearAccountMemory?.();
            syncDiagnostic = error.code ? `Код: ${error.code} · Операция: ${error.operation || 'account.pull'}` : '';
            const modal = document.getElementById('cloudAuthModal');
            document.getElementById('app').style.display = 'none'; app.hideSplashScreen?.();
            modal.classList.add('active'); modal.dataset.entry = 'true'; document.body.classList.add('ncd-auth-open');
            // Data-sync failures belong to the cloud status, not to credential errors.
            authNotice = ''; authSuccess = false; setAuthStep('email'); refresh();
            status('Не удалось загрузить данные аккаунта. Повторите попытку.'); return false;
        });
        accountQueue = work; sessionLoad = work;
        work.finally(() => { if (sessionLoad === work) sessionLoad = null; });
        return work;
    }
    async function withCloudTimeout(work, saved) {
        let timeout;
        try {
            return await Promise.race([
                Promise.resolve().then(work),
                new Promise((_, reject) => {
                    timeout = setTimeout(() => {
                        saved.cancelled = true;
                        reject(cloudFailure({code:'FETCH_ERROR'}, 'account.timeout'));
                    }, 2500);
                })
            ]);
        } finally { clearTimeout(timeout); }
    }
    let requestRefresh = null, rejectedSession = null, refreshedPush = null, lastRefreshPush = null;
    let activeDataRequests = 0, refreshPushTimer = null;
    const REAUTH_MESSAGE = 'Не удалось подтвердить сессию. Войдите повторно; локальные данные сохранены.';
    function needsReauthentication() {
        return !!rejectedSession && rejectedSession.db === client;
    }
    function rejectRequestSession(db, cycle, token) {
        if (db !== client || cycle !== authCycle || loggingOut) return;
        rejectedSession = { db, cycle, token };
        status(REAUTH_MESSAGE);
    }
    function pushAfterTokenRefresh(db, cycle, next) {
        if (!next?.access_token) return;
        refreshedPush = { db, cycle, userId:next.user?.id, token:next.access_token };
        flushRefreshedGoals();
    }
    function flushRefreshedGoals() {
        if (!refreshedPush || activeDataRequests || refreshPushTimer !== null) return;
        // Never start another sync inside the SDK auth lock or before the retry finishes.
        refreshPushTimer = setTimeout(() => {
            refreshPushTimer = null;
            if (activeDataRequests) return;
            const pending = refreshedPush; refreshedPush = null;
            if (!pending || pending.db !== client || pending.cycle !== authCycle || loggingOut ||
                session?.user?.id !== pending.userId || needsReauthentication()) return;
            if (lastRefreshPush?.db === pending.db && lastRefreshPush.cycle === pending.cycle && lastRefreshPush.token === pending.token) return;
            lastRefreshPush = pending;
            pushGoals().catch(() => {});
        }, 0);
    }
    function assertRequestOwner(db, cycle, userId) {
        if (db !== client || cycle !== authCycle || loggingOut ||
            (userId && localStorage.getItem(LOCK) === 'true' && !authPending) ||
            (userId && session?.user?.id && session.user.id !== userId)) throw new Error('SUPABASE_SESSION_CHANGED');
    }
    function permanentSessionError(error) {
        return [400,401,403].includes(error?.status) ||
            ['refresh_token_not_found','refresh_token_already_used','session_not_found','session_expired'].includes(error?.code);
    }
    async function requestSession(db, cycle, rejectedToken = null, expectedUserId = null) {
        const { data, error } = await db.auth.getSession();
        assertRequestOwner(db, cycle, expectedUserId);
        if (error) {
            if (permanentSessionError(error)) rejectRequestSession(db, cycle, session?.access_token);
            throw error;
        }
        let next = data?.session;
        const userId = next?.user?.id;
        assertRequestOwner(db, cycle, userId);
        if (!next?.access_token) {
            if (session || rejectedToken) {
                rejectRequestSession(db, cycle, session?.access_token);
                throw new Error('SUPABASE_SESSION_REQUIRED');
            }
            return null; // Public registration RPCs may run before sign-in.
        }
        if (expectedUserId && userId !== expectedUserId) throw new Error('SUPABASE_SESSION_CHANGED');
        if (needsReauthentication() && rejectedSession.token === next.access_token) throw new Error('SUPABASE_SESSION_REJECTED');
        // Another request/SDK auto-refresh may already have replaced the rejected JWT.
        if ((rejectedToken && next.access_token === rejectedToken) || (next.expires_at && next.expires_at * 1000 <= Date.now() + 30000)) {
            if (!requestRefresh || requestRefresh.db !== db || requestRefresh.cycle !== cycle) {
                const work = db.auth.refreshSession().then(result => {
                    if (result.error) throw result.error;
                    const refreshed = result.data?.session;
                    if (!refreshed?.access_token || refreshed.user?.id !== userId) throw new Error('SUPABASE_SESSION_CHANGED');
                    assertRequestOwner(db, cycle, userId);
                    pushAfterTokenRefresh(db, cycle, refreshed);
                    return refreshed;
                }).catch(error => {
                    if (permanentSessionError(error)) rejectRequestSession(db, cycle, next.access_token);
                    throw error;
                });
                const pending = { db, cycle, work }; requestRefresh = pending;
                work.finally(() => { if (requestRefresh === pending) requestRefresh = null; }).catch(() => {});
            }
            next = await requestRefresh.work;
        }
        assertRequestOwner(db, cycle, next.user?.id);
        return next;
    }
    async function boundedFetch(input, options = {}) {
        const url = new URL(input?.url || String(input));
        const authRequest = url.origin === config?.url && /^\/auth\/v1(?:\/|$)/.test(url.pathname);
        const controller = new AbortController();
        const signal = options.signal || input?.signal;
        const abort = () => controller.abort(signal?.reason || new DOMException('Запрос отменён.', 'AbortError'));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
        activeRequests.add(controller);
        // Signing in may take longer on mobile networks than a background data read.
        // Give timeouts their own reason instead of leaking a generic AbortError.
        const timeout = setTimeout(() => controller.abort(new DOMException('Сервер не ответил вовремя. Повторите попытку.', 'TimeoutError')), authRequest ? 30000 : 10000);
        let authenticated = false;
        try {
            // Auth endpoints must bypass getSession: refreshSession uses this same fetch.
            authenticated = !!client && url.origin === config?.url && /^\/(rest|storage|functions)\/v1(?:\/|$)/.test(url.pathname);
            if (authenticated) activeDataRequests++;
            const db = client, cycle = authCycle;
            let sentSession = null, expectedUserId = session?.user?.id || null;
            const send = async rejectedToken => {
                const headers = new Headers(options.headers || (typeof input === 'object' ? input.headers : undefined));
                if (authenticated) {
                    if (controller.signal.aborted) throw controller.signal.reason;
                    let stopWaiting;
                    const cancelled = new Promise((_,reject) => {
                        stopWaiting = () => reject(controller.signal.reason);
                        controller.signal.addEventListener('abort',stopWaiting,{once:true});
                    });
                    try {
                        sentSession = await Promise.race([requestSession(db, cycle, rejectedToken, expectedUserId),cancelled]);
                    } finally { controller.signal.removeEventListener('abort',stopWaiting); }
                    expectedUserId = sentSession?.user?.id || expectedUserId;
                    headers.set('apikey', config.key);
                    if (sentSession) headers.set('Authorization', `Bearer ${sentSession.access_token}`);
                    else if (config.key.startsWith('sb_publishable_')) headers.delete('Authorization');
                    else headers.set('Authorization', `Bearer ${config.key}`);
                }
                if (controller.signal.aborted) throw controller.signal.reason;
                // Clone Request bodies so the single retry can replay an upload.
                return window.fetch(typeof input?.clone === 'function' ? input.clone() : input, { ...options, headers, cache:'no-store', signal: controller.signal });
            };
            let response = await send(null);
            if (authenticated) assertRequestOwner(db, cycle, expectedUserId);
            if (authenticated && response.status === 400 && typeof response.clone === 'function') {
                // Keep credentials and request bodies out of diagnostics.
                response.clone().json().then(error => {
                    const safe = value => String(value || '').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(0,400);
                    console.warn(`[Supabase ${url.pathname}] ${safe(error.code)} ${safe(error.message)}`);
                }).catch(() => {});
            }
            if (authenticated && response.ok && needsReauthentication() && sentSession?.access_token !== rejectedSession.token) rejectedSession = null;
            if (!authenticated || response.status !== 401 || !sentSession) return response;
            const rejectedToken = sentSession.access_token;
            await response.body?.cancel();
            response = await send(rejectedToken);
            assertRequestOwner(db, cycle, expectedUserId);
            if (response.status === 401) rejectRequestSession(db, cycle, sentSession.access_token);
            else if (response.ok && needsReauthentication() && sentSession.access_token !== rejectedSession.token) rejectedSession = null;
            return response;
        }
        catch (error) {
            // Some WebViews discard AbortSignal.reason in the fetch rejection.
            if (controller.signal.aborted) throw controller.signal.reason;
            throw error;
        } finally {
            activeRequests.delete(controller); clearTimeout(timeout); signal?.removeEventListener('abort', abort);
            if (authenticated) { activeDataRequests--; flushRefreshedGoals(); }
        }
    }
    function tokenKeys() {
        const project = new URL(config.url).hostname.replace(/[^a-z0-9.-]/gi, '_');
        return {
            access: `tokens.${project}.access_token`,
            refresh: `tokens.${project}.refresh_token`
        };
    }
    function persistSessionTokens(next) {
        const cycle = authCycle;
        const work = tokenWrites.catch(() => {}).then(async () => { if (next && (loggingOut || cycle !== authCycle)) return; await writeSessionTokens(next); });
        tokenWrites = work; return work;
    }
    async function writeSessionTokens(next) {
        const keys = tokenKeys();
        if (next?.access_token && next?.refresh_token) {
            await Promise.all([
                authStorage.setItem(keys.access, next.access_token),
                authStorage.setItem(keys.refresh, next.refresh_token)
            ]);
        } else if (!next) {
            await Promise.all([
                authStorage.removeItem(keys.access),
                authStorage.removeItem(keys.refresh)
            ]);
        }
    }
    async function restoreSessionTokens() {
        const keys = tokenKeys();
        const [access_token, refresh_token] = await Promise.all([
            authStorage.getItem(keys.access),
            authStorage.getItem(keys.refresh)
        ]);
        if (!access_token || !refresh_token) return null;
        const result = await client.auth.setSession({ access_token, refresh_token });
        if (result.error) throw result.error;
        return result.data.session;
    }
    function initialize() {
        if (initializing) return initializing;
        if (client || !app || loggingOut) return Promise.resolve();
        const work = initializeClient(); initializing = work;
        work.finally(() => { if (initializing === work) initializing = null; }).catch(() => {});
        return work;
    }
    async function initializeClient() {
        try {
            const saved = read(CONFIG, window.SupabaseConfig || null);
            if (!saved) {
                await Promise.resolve();
                if (!document.getElementById('cloudAuthModal')?.classList.contains('active')) app.showAuth();
                return;
            }
            config = validateConfig(saved.url, saved.key);
            if (!window.supabase?.createClient) throw new Error('SDK unavailable');
            if (singleton.instance && (singleton.url !== config.url || singleton.key !== config.key)) throw new Error('SUPABASE_RESTART_REQUIRED');
            singleton.generation = ++sdkEpoch;
            if (nativePreferences && (await preferences.get({key:LOCK})).value === 'true') localStorage.setItem(LOCK,'true');
            const ownedAuthStorage = {
                getItem: key => singleton.generation === sdkEpoch && localStorage.getItem(LOCK) !== 'true' ? authStorage.getItem(key) : Promise.resolve(null),
                setItem: (key,value) => {
                    if (singleton.generation !== sdkEpoch || (localStorage.getItem(LOCK) === 'true' && !authPending)) return Promise.resolve();
                    if (!authPending && session?.user?.id) {
                        let owner; try { owner = JSON.parse(value)?.user?.id; } catch {}
                        if (owner && owner !== session.user.id) return Promise.resolve();
                    }
                    return authStorage.setItem(key,value);
                },
                // Refresh failures must not erase the durable login. Logout owns deletion.
                removeItem: key => singleton.generation === sdkEpoch && loggingOut ? authStorage.removeItem(key) : Promise.resolve()
            };
            if (!singleton.instance) {
                singleton.instance = window.supabase.createClient(config.url, config.key, { global: { fetch: boundedFetch }, auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storage: ownedAuthStorage, storageKey: `gt-supabase-auth:${config.url}` } });
                singleton.url=config.url; singleton.key=config.key;
            }
            client = singleton.instance;
            const db = client, cycle = authCycle;
            subscription = client.auth.onAuthStateChange((event, next) => {
                const eventCycle = authCycle;
                // SDK auth callbacks must not await SDK operations (avoids auth lock deadlocks).
                setTimeout(() => {
                    if (db !== client || eventCycle !== authCycle || loggingOut) return;
                    if (initializing && next) return; // Startup restoration owns the first workspace open.
                    if (event === 'TOKEN_REFRESHED' && next?.user?.id && session?.user?.id && next.user.id !== session.user.id) return;
                    if (event === 'SIGNED_OUT' || !next) return; // Only logout() clears the account and tokens.
                    if (localStorage.getItem(LOCK) === 'true') return;
                    if (next) persistSessionTokens(next).catch(() => {});
                    // Only explicit logout clears our backup tokens; startup/refresh errors must retain them.
                    if (event === 'TOKEN_REFRESHED') pushAfterTokenRefresh(db, eventCycle, next);
                    acceptSession(next, false, true).catch(() => status('Облачная сессия недоступна. Локальная работа продолжается.'));
                }, 0);
            });
            if (localStorage.getItem(LOCK) === 'true') {
                await client.auth.stopAutoRefresh?.();
                // A logged-out startup must not erase retained account data.
                session = null; settledNoSession = true;
                app.clearAccountMemory?.(); app.showAuth(); return;
            }
            await resumeStoredSession(db, cycle);
        } catch {
            sessionError = true; authNotice = ''; authSuccess = false;
            // An unavailable session store/network is not evidence of logout.
            showStartupFallback(); refresh(); status(connectionState().text);
        }
    }
    async function resumeStoredSession(db = client, cycle = authCycle) {
        if (!db || loggingOut || localStorage.getItem(LOCK) === 'true') return;
        try {
            // SDK getSession may refresh an expired access token over the network.
            // Render the persisted account first, then let that refresh run in the background.
            if (!session) {
                const cached = await authStorage.getItem(`gt-supabase-auth:${config.url}`);
                let stored; try { stored = JSON.parse(cached || 'null'); } catch {}
                if (stored?.user?.id && stored.access_token && stored.refresh_token) {
                    await new Promise((resolve, reject) => {
                        acceptSession(stored, false, false, resolve).then(resolve, reject);
                    });
                }
            }
            const { data, error } = await withCloudTimeout(() => db.auth.getSession(), {});
            if (error) throw error;
            const restored = data?.session || await restoreSessionTokens();
            if (db !== client || cycle !== authCycle || loggingOut) return;
            sessionError = false;
            if (restored?.user?.id) {
                persistSessionTokens(restored).catch(() => {});
                // Open the owned workspace first; hydration continues in the background.
                await new Promise((resolve, reject) => {
                    acceptSession(restored, false, false, resolve).then(resolve, reject);
                });
            } else if (canOpenCachedAccount()) {
                // Missing/expired credentials are not an explicit logout. Keep the
                // saved workspace usable and ask for login only for cloud actions.
                sessionError = true;
                showStartupFallback();
                status(connectionState().text);
            } else await acceptSession(null);
            clearInterval(polling); polling = setInterval(() => sync(),5000);
        } catch {
            if (db !== client || cycle !== authCycle || loggingOut) return;
            sessionError = true; authNotice = ''; authSuccess = false;
            if (!session) showStartupFallback();
            status(connectionState().text);
        }
    }

    async function configure(url, key) {
        if (initializing) await initializing;
        if (session || busy) throw new Error('Сначала выйдите из облачного аккаунта.');
        const value = validateConfig(url.trim(), key.trim());
        const owner = localStorage.getItem(OWNER);
        if (owner && !owner.startsWith(value.url + '|')) throw new Error('Устройство связано с другим проектом. Используйте отдельный профиль браузера.');
        if (singleton.instance && (singleton.url!==value.url || singleton.key!==value.key)) {
            write(CONFIG,value);
            throw new Error('Настройки Supabase сохранены. Перезапустите приложение, чтобы сменить проект.');
        }
        if (client && config?.url===value.url && config?.key===value.key) { write(CONFIG,value); return; }
        write(CONFIG, value); stopRealtime(); subscription?.data?.subscription?.unsubscribe(); client = null; config = value;
        await initialize();
    }
    function validAuthEmail(value) {
        const email = String(value || '').trim();
        if (email.length > 254 || /\s/.test(email)) return false;
        const parts = email.split('@');
        if (parts.length !== 2) return false;
        const [local, domain] = parts;
        if (!local || local.length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
        const labels = domain.split('.');
        return labels.length >= 2 && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) && /^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/i.test(labels.at(-1));
    }
    async function existingAuthSession(db) {
        if (loggingOut || needsReauthentication() || localStorage.getItem(LOCK) === 'true') return null;
        if (session?.user?.id) return session;
        const { data, error } = await db.auth.getSession();
        if (error) throw new Error(authErrorMessage(error));
        return data?.session?.user?.id ? data.session : null;
    }
    async function openAuthenticatedSession(next) {
        rejectedSession = null;
        localStorage.removeItem(LOCK);
        if (nativePreferences) await preferences.remove({key:LOCK});
        await persistSessionTokens(next);
        await client.auth.startAutoRefresh?.();
        const hydrated = await new Promise((resolve, reject) => {
            acceptSession(next, false, false, resolve).then(resolve, reject);
        });
        closeAuth();
        if (readyIdentity === ownerId()) pushGoals().catch(() => {});
        return {confirmationRequired:false, hydrated};
    }
    async function authenticate(email, password, signUp, registration = null) {
        if (!validAuthEmail(email)) throw new Error('Введите корректный email (например, you@example.com)');
        email = email.trim();
        if (loggingOut || logoutWork) throw new Error('Дождитесь завершения выхода.');
        await initialize();
        if (!client) throw new Error('Подключение к облаку временно недоступно. Повторите попытку.');
        const db = client, cycle = authCycle;
        const restored = await existingAuthSession(db);
        if (cycle !== authCycle || db !== client || loggingOut) throw new Error('Сессия изменилась. Повторите вход.');
        if (restored) return openAuthenticatedSession(restored);
        if (String(password || '').length < 8) throw new Error('Пароль должен быть не менее 8 символов');
        const attempt = ++authCycle;
        const handle = signUp && registration ? normalizeAuthNickname(registration.nickname) : null;
        if (handle && !await checkAuthNickname(handle)) throw new Error(HANDLE_TAKEN);
        const method = signUp ? 'signUp' : 'signInWithPassword';
        const credentials = signUp
            ? { email, password, options: { data: { username: handle || app?.user?.nickname || '', nickname: handle || app?.user?.nickname || '', ...(handle ? { ncd_handle: handle } : {}) } } }
            : { email, password };
        let result; authPending = true;
        try { result = await db.auth[method](credentials); } catch (error) { throw new Error(authErrorMessage(error, signUp)); } finally { authPending = false; }
        if (attempt !== authCycle || db !== client || loggingOut) throw new Error('Сессия изменилась. Повторите вход.');
        if (signUp && result.error) throw new Error(authErrorMessage(result.error, true));
        // With email confirmation enabled Supabase may hide duplicate accounts
        // behind a successful signup response with an empty identities array.
        const duplicate = signUp && (
            (!result.error && !result.data?.session && Array.isArray(result.data?.user?.identities) && result.data.user.identities.length === 0)
        );
        if (duplicate) {
            authPending = true;
            try {
                const restored = await existingAuthSession(db);
                result = restored ? { data:{session:restored}, error:null } : await db.auth.signInWithPassword({ email,password });
            } catch (error) { throw new Error(authErrorMessage(error)); } finally { authPending = false; }
            if (result.error) {
                throw new Error(authErrorMessage(result.error));
            }
            if (!result.data?.session) throw new Error('Этот email уже занят, пожалуйста, войдите.');
        }
        // Reuse the submitted credentials once; never ask the user to type them again.
        if (signUp && !duplicate && !result.error && !result.data?.session) {
            authPending = true;
            try {
                const restored = await existingAuthSession(db);
                const login = restored ? { data:{session:restored}, error:null } : await db.auth.signInWithPassword({ email, password });
                if (attempt !== authCycle || db !== client || loggingOut) throw new Error('Сессия изменилась. Повторите вход.');
                if (login.error?.code === 'email_not_confirmed') {
                    authNotice = 'Подтвердите адрес по ссылке в письме.';
                } else if (login.error) throw new Error(authErrorMessage(login.error));
                else if (login.data?.session) result = login;
            } catch (error) {
                throw error;
            } finally { authPending = false; }
        }
        if (result.error && handle && !isAuthNetworkError(result.error) && !await checkAuthNickname(handle)) throw new Error(HANDLE_TAKEN);
        if (result.error) throw new Error(authErrorMessage(result.error, signUp));
        if (result.data?.session) {
            if (attempt !== authCycle || db !== client || loggingOut) throw new Error('Сессия изменилась. Повторите вход.');
            return openAuthenticatedSession(result.data.session);
        }
        else { authNotice = 'Подтвердите регистрацию по ссылке в письме.'; authSuccess = true; status(authNotice); }
        return { confirmationRequired: !result.data?.session };
    }
    function logout(checked = false) {
        if (logoutWork) return logoutWork;
        if (!checked && ownerId()) {
            const work = Promise.resolve().then(async () => {
                // Saving is best effort. Offline, conflicted or stuck requests
                // must never prevent the user from leaving the account.
                let timeout;
                try {
                    localChanged(); clearTimeout(timer);
                    await Promise.race([
                        Promise.resolve(syncWork || sync()).catch(() => false),
                        new Promise(resolve => { timeout = setTimeout(resolve, 1000); })
                    ]);
                } catch { /* Logout still proceeds if preparing sync fails. */ }
                finally { clearTimeout(timeout); }
                logoutWork = null;
                return logout(true);
            });
            logoutWork = work; work.finally(() => { if (logoutWork === work) logoutWork = null; }).catch(() => {});
            return work;
        }
        // Persist data independently of the network before clearing the active
        // profile. Signing out removes credentials, never this account copy.
        const accountSaved = saveAccountSnapshot().then(() => null,error => error);
        const db = client; loggingOut = true; authCycle++; accountEpoch++; localStorage.setItem(LOCK,'true'); readyIdentity = null; desiredIdentity = null;
        session = null; rejectedSession = null; conflict = false; bindNeeded = false; previews = []; syncDiagnostic = ''; transitioning = true; app._accountTransition = true; stopAccountRequests();
        subscription?.data?.subscription?.unsubscribe(); subscription = null;
        app.clearAccountMemory?.(); app.showAuth();
        status('Выход из аккаунта…');
        const work = (async () => {
            let clean = false;
            try {
                if (nativePreferences) { try { await preferences.set({key:LOCK,value:'true'}); } catch {} }
                // SDK signOut can wait for HTTP or an auth lock. Clear our
                // durable login independently and never await that network path.
                Promise.resolve().then(() => db?.auth.stopAutoRefresh?.()).catch(() => {});
                Promise.resolve().then(() => db?.auth.signOut({ scope:'local' })).catch(() => {});
                if (db) rejectedProfileWrites.delete(db);
                // Cloud tasks are invalidated by the account epoch above; do
                // not wait for them or for a module whose save may be stuck.
                await tokenWrites.catch(() => {}); await pendingWrites.catch(() => {});
                // Authentication is removed even if preserving account data
                // fails. In that case, never erase the original profile.
                if (config) {
                    await writeSessionTokens(null);
                    for (const suffix of ['', '-user', '-code-verifier']) await authStorage.removeItem(`gt-supabase-auth:${config.url}${suffix}`);
                }
                const snapshotError = await accountSaved;
                if (snapshotError) throw snapshotError;
                app.clearAccountMemory?.(); await app.cancelAllNotifications?.();
                await clearUserCaches(); clean = true;
            } finally {
                sdkEpoch++; client = null; session = null; readyIdentity = null; desiredIdentity = null; bootstrapIdentity = null; sessionLoad = null; goalSyncWork = null; goalRefreshWork = null; sectionSyncWork = null;
                transitioning = false; loggingOut = false; app._accountTransition = false; settledNoSession = true; busy = false; applying = false; rerunSync = false; calendarMode = null; initializing = null;
                app.clearAccountMemory?.(); app.showAuth();
                if (!clean) { authNotice = 'Вы вышли из аккаунта. Исходные данные сохранены на устройстве; локальное хранилище требует проверки.'; authSuccess = false; refresh(); }
            }
            return true;
        })();
        logoutWork = work; work.finally(() => { if (logoutWork === work) logoutWork = null; }).catch(() => {});
        return work;
    }
    let authNotice = '', authSuccess = false;
    function normalizeAuthNickname(value) {
        const name = String(value || '').trim().replace(/^@+/, '').toLowerCase();
        if (!/^[a-z][a-z0-9_]{2,31}$/.test(name)) throw new Error('Используйте 3–32 символа: латинские буквы, цифры и _. Начните с буквы.');
        return name;
    }
    async function checkAuthEmail(value) {
        const email = String(value || '').trim().toLowerCase();
        if (!validAuthEmail(email)) throw new Error('Введите корректный email (например, you@example.com)');
        if (!client) await initialize();
        if (!client) throw new Error('Подключение к облаку временно недоступно. Повторите попытку.');
        try {
            const { data, error } = await client.rpc('ncd_email_available', { check_email: email });
            if (error) throw error;
            if (typeof data !== 'boolean') throw new Error('Invalid availability response');
            return data;
        } catch (error) {
            throw new Error(isAuthNetworkError(error) ? 'Проверьте подключение' : 'Проверка email временно недоступна. Повторите попытку.');
        }
    }

    const HANDLE_TAKEN = 'Этот никнейм уже занят. Придумайте другой';
    async function checkAuthNickname(value) {
        const nickname = normalizeAuthNickname(value);
        if (!client) await initialize();
        if (!client) throw new Error('Подключение к облаку временно недоступно. Повторите попытку.');
        const db = client;
        try {
            const { data, error } = await db.from('profiles').select('handle').eq('handle', nickname).maybeSingle();
            if (error && !['42501','PGRST301','PGRST302'].includes(error.code)) throw error;
            if (db !== client) throw new Error('Подключение изменилось. Повторите проверку.');
            if (!error && data !== null && data !== undefined) return false;
            // Empty SELECT can mean RLS hid a taken handle. Only the server may confirm availability.
            const verified = await db.rpc('ncd_handle_available', { candidate:nickname });
            if (verified.error) throw verified.error;
            if (db !== client || typeof verified.data !== 'boolean') throw new Error('Invalid availability response');
            return verified.data;
        } catch (error) {
            throw new Error(isAuthNetworkError(error) ? 'Проверьте подключение' : 'Проверка никнейма временно недоступна. Повторите попытку.');
        }
    }
    let nicknameCheckVersion = 0, nicknameCheckTimer;
    let nicknameAvailability = { value:'', state:'idle' };
    function updateNicknameAvailability(form) {
        const input = form.querySelector('[name="nickname"]');
        const status = form.querySelector('[data-nickname-status]');
        const active = form.dataset.step === 'profile';
        const valid = nicknameAvailability.value === input.value && nicknameAvailability.state === 'available';
        const invalid = ['taken','invalid','error'].includes(nicknameAvailability.state);
        input.setAttribute('aria-invalid', String(invalid));
        if (status) {
            status.textContent = nicknameAvailability.message || '';
            status.classList.toggle('is-error', invalid);
            status.classList.toggle('is-success', valid);
        }
        form.querySelector('[type="submit"]').disabled = !!form.dataset.saving || (active && !valid);
    }
    async function checkNicknameLive(form) {
        clearTimeout(nicknameCheckTimer);
        const version = ++nicknameCheckVersion;
        const input = form.querySelector('[name="nickname"]');
        const value = input.value;
        let handle;
        try { handle = normalizeAuthNickname(value); }
        catch (error) {
            nicknameAvailability = { value, state:value ? 'invalid' : 'idle', message:value ? error.message : '' };
            updateNicknameAvailability(form); return;
        }
        nicknameAvailability = { value, state:'checking', message:'Проверяем никнейм…' };
        updateNicknameAvailability(form);
        try {
            const available = await checkAuthNickname(handle);
            if (version !== nicknameCheckVersion || input.value !== value || form.dataset.step !== 'profile') return;
            nicknameAvailability = { value, state:available ? 'available' : 'taken', message:available ? 'Никнейм свободен' : HANDLE_TAKEN };
        } catch (error) {
            if (version !== nicknameCheckVersion || input.value !== value || form.dataset.step !== 'profile') return;
            nicknameAvailability = { value, state:'error', message:error.message };
        }
        updateNicknameAvailability(form);
    }
    function isAuthNetworkError(error) {
        return navigator.onLine === false || error?.name === 'AuthRetryableFetchError' ||
            /fetch|network|connection|offline|timeout|timed out/i.test(`${error?.name || ''} ${error?.code || ''} ${error?.message || ''}`);
    }
    function authErrorMessage(error, signup = false) {
        if (/TimeoutError|AbortError|aborted|отменён|не ответил вовремя/i.test(`${error?.name || ''} ${error?.message || ''}`)) {
            return 'Не удалось дождаться ответа сервера. Проверьте подключение и повторите вход.';
        }
        // Preserve the provider's diagnosis. The UI renders this with textContent.
        return error?.message || error?.code || (signup ? 'Не удалось зарегистрироваться.' : 'Не удалось войти.');
    }

    function setAuthStep(step, focus = true) {
        const modal = document.getElementById('cloudAuthModal'), form = modal.querySelector('form');
        const signup = form.querySelector('[value="signup"]').checked, recovery = form.dataset.recovery === 'true';
        const previousStep = form.dataset.step;
        form.dataset.step = step;
        form.querySelectorAll('[data-auth-stage]').forEach(panel => {
            panel.hidden = panel.dataset.authStage !== step;
            panel.querySelectorAll('input').forEach(input => { input.disabled = panel.hidden; input.required = !panel.hidden; });
        });
        form.querySelector('.cloud-auth-mode').hidden = step !== 'email' || recovery;
        const password = form.querySelector('[name="password"]');
        password.autocomplete = signup ? 'new-password' : 'current-password';
        if (step !== 'password') {
            password.value = ''; password.type = 'password';
            const reveal = form.querySelector('[data-auth-show-password]');
            reveal.textContent = 'Показать'; reveal.setAttribute('aria-pressed','false'); reveal.setAttribute('aria-label','Показать пароль');
        }
        form.querySelector('[data-cloud-forgot]').hidden = recovery || signup || step !== 'password';
        form.querySelector('[data-cloud-back]').hidden = !recovery;
        modal.querySelector('[data-auth-prev]').hidden = recovery || step === 'email' || step === 'confirm';
        const label = { email: recovery ? 'Восстановить доступ' : 'Ваша почта', profile:'Как вас найти?', password:signup ? 'Создайте пароль' : 'С возвращением', confirm:'Проверьте почту' };
        const descriptions = { email:recovery ? 'Отправим письмо с инструкцией по сбросу пароля.' : 'Один аккаунт для ваших целей, заметок и планов.', profile:'Выберите уникальный никнейм. Игровой ID будет создан автоматически.', password:signup ? 'Не менее 8 символов. Пароль известен только вам.' : 'Введите пароль, чтобы открыть своё пространство.', confirm:form.querySelector('[name="email"]').value };
        document.getElementById('cloudAuthTitle').textContent = label[step];
        form.querySelector('[data-auth-description]').textContent = descriptions[step];
        form.querySelector('[data-auth-edit-email]').textContent = form.querySelector('[name="email"]').value;
        form.querySelector('[type="submit"]').innerHTML = step === 'confirm' ? 'Войти после подтверждения' : recovery ? 'Отправить письмо' : step === 'password' ? (signup ? 'Создать аккаунт' : 'Войти') : 'Продолжить <span aria-hidden="true">→</span>';
        const order = signup ? ['email','profile','password'] : ['email','password'];
        const progress = modal.querySelector('[data-auth-progress]'); progress.hidden = recovery || step === 'confirm';
        progress.querySelectorAll('li').forEach((dot,index) => {
            dot.hidden = !signup && index === 1;
            const dotStep = ['email','profile','password'][index];
            dot.classList.toggle('is-done',order.indexOf(dotStep) < order.indexOf(step));
            if (dotStep === step) dot.setAttribute('aria-current','step'); else dot.removeAttribute('aria-current');
        });
        if (step === 'profile' && previousStep !== 'profile') checkNicknameLive(form);
        else if (step !== 'profile') { clearTimeout(nicknameCheckTimer); nicknameCheckVersion++; }
        updateNicknameAvailability(form);
        if (focus && step !== 'confirm') form.querySelector(`[data-auth-stage="${step}"] input`)?.focus({ preventScroll:true });
    }
    function setAuthMode(recovery) {
        const modal = document.getElementById('cloudAuthModal'), form = modal.querySelector('form');
        if (form.dataset.saving) return;
        form.dataset.recovery = recovery ? 'true' : 'false';
        authNotice = ''; authSuccess = false;
        const password = form.querySelector('[name="password"]'); password.value = ''; password.type = 'password';
        const reveal = form.querySelector('[data-auth-show-password]'); reveal.textContent = 'Показать'; reveal.setAttribute('aria-pressed','false'); reveal.setAttribute('aria-label','Показать пароль');
        if (!recovery) form.querySelector('[value="signin"]').checked = true;
        setAuthStep('email'); refresh();
    }
    async function requestPasswordReset(email) {
        if (!client) await initialize();
        if (!client) throw new Error('Подключение к облаку временно недоступно. Повторите попытку.');
        const { error } = await client.auth.resetPasswordForEmail(email.trim());
        if (error) throw new Error(authErrorMessage(error));
        authNotice = 'Инструкция по сбросу отправлена на почту'; authSuccess = true;
        refresh(); app?.showToast?.(authNotice, 'success');
    }
    function closeAuth() {
        const modal = document.getElementById('cloudAuthModal');
        if (!modal) return;
        clearTimeout(nicknameCheckTimer); nicknameCheckVersion++;
        if (!session && (modal.dataset.entry === 'true' || modal.querySelector('form').dataset.saving)) return;
        const wasOpen = modal.classList.contains('active');
        modal.classList.remove('active');
        modal.querySelector('[name="password"]').value = '';
        document.body.classList.remove('ncd-auth-open');
        if (wasOpen && document.getElementById('settingsModal')?.classList.contains('active')) {
            document.querySelector(session ? '[data-cloud-logout]' : '[data-cloud-open-auth]')?.focus();
        }
    }
    function openAuth(options = {}) {
        const modal = document.getElementById('cloudAuthModal');
        if (!modal || (session && readyIdentity === ownerId() && !needsReauthentication()) || modal.querySelector('form').dataset.saving) return;
        modal.querySelector('[name="password"]').value = '';
        modal.classList.add('active');
        document.body.classList.add('ncd-auth-open');
        modal.dataset.entry = String(!!options.entry);
        modal.querySelector('#closeCloudAuthBtn').hidden = !!options.entry;
        setAuthMode(false);
        if (options.mode === 'signup') { modal.querySelector('[value="signup"]').checked = true; setAuthStep('email'); }
        refresh();
        modal.querySelector('[name="email"]').focus();
    }
    function refresh() {
        const container = document.getElementById('cloudSyncPanel');
        if (!container) return;
        const set = (selector, text) => { const node = container.querySelector(selector); if (node) node.textContent = text; };
        const connected = !!session && readyIdentity === ownerId() && !transitioning && !needsReauthentication();
        const synced = connected && message.startsWith('Синхронизировано');
        set('[data-cloud-session-state]', connectionState().text);
        set('[data-cloud-status]', synced ? 'Синхронизировано 🟢' : connected ? 'Аккаунт подключён 🟢' : message);
        container.querySelector('[data-cloud-status]').classList.toggle('is-connected', connected);
        set('[data-cloud-sync-status]', message);
        container.querySelector('[data-cloud-sync-status]').hidden = !session || synced || bindNeeded;
        const accountDiagnostic = session && syncDiagnostic ? `Аккаунт: ${session.user.id.slice(0,8)} · Сервер: ${new URL(config.url).hostname}` : '';
        const diagnostics = [syncDiagnostic,goalsDiagnostic,sectionsDiagnostic,accountDiagnostic].filter(Boolean).join(' · ');
        set('[data-cloud-diagnostic]', diagnostics);
        container.querySelector('[data-cloud-diagnostic]').hidden = !diagnostics;
        set('[data-cloud-build]',`NCD ${app?.getVersion?.() || ''}`.trim());
        container.querySelector('[data-cloud-status]').classList.toggle('is-synced', synced);
        set('[data-cloud-account]', session?.user?.email || session?.user?.id || '');
        container.querySelector('[data-cloud-account]').hidden = !session;
        container.querySelector('[data-cloud-open-auth]').hidden = !!session && !needsReauthentication();
        container.querySelector('[data-cloud-actions]').hidden = !session;
        const details = container.querySelector('[data-cloud-details]');
        details.hidden = !session || !(bindNeeded || conflict);
        container.querySelector('[data-cloud-session-state]').hidden = !session || !bindNeeded;
        container.querySelector('[data-cloud-bind]').hidden = !bindNeeded;
        container.querySelector('[data-cloud-conflicts]').hidden = !conflict;
        set('[data-cloud-conflict-preview]', previews.join('\n'));
        const form = document.querySelector('[data-cloud-auth]');
        if (form) form.hidden = !!session && readyIdentity === ownerId() && !needsReauthentication();
        const authStatus = document.querySelector('[data-cloud-auth-status]');
        if (authStatus) { authStatus.textContent = authNotice; authStatus.classList.toggle('is-success', authSuccess); }
        if (session && readyIdentity === ownerId() && !needsReauthentication()) closeAuth();

    }
    async function submitCloudForm(event) {
        event.preventDefault(); const form = event.target;
        if (form.dataset.saving) return;
        const modal = document.getElementById('cloudAuthModal');
        const step = form.dataset.step || 'email', recovery = form.dataset.recovery === 'true';
        const signup = form.querySelector('[value="signup"]').checked;
        if (step === 'confirm') { form.querySelector('[value="signin"]').checked = true; authNotice = ''; authSuccess = false; setAuthStep('email'); refresh(); return; }
        const email = form.querySelector('[name="email"]').value.trim();
        const password = form.querySelector('[name="password"]').value;
        if (!validAuthEmail(email)) {
            authNotice = 'Введите корректный email (например, you@example.com)'; authSuccess = false;
            if (step !== 'email') setAuthStep('email', false);
            refresh(); form.querySelector('[name="email"]').focus(); return;
        }
        if (step === 'password' && password.length < 8) {
            authNotice = 'Пароль должен быть не менее 8 символов'; authSuccess = false;
            refresh(); form.querySelector('[name="password"]').focus(); return;
        }
        const activeInput = form.querySelector(`[data-auth-stage="${step}"] input`);
        if (activeInput && !activeInput.reportValidity()) return;
        authNotice = ''; authSuccess = false; refresh();
        if (step === 'email' && !recovery && !signup) { setAuthStep('password'); return; }
        const controls = [...modal.querySelectorAll('input, button')].map(element => [element, element.disabled]);
        form.dataset.saving = 'true'; form.setAttribute('aria-busy', 'true');
        controls.forEach(([element]) => { element.disabled = true; });
        let nextStep = step;
        try {
            if (recovery) await requestPasswordReset(email);
            else if (step === 'email') {
                if (!await checkAuthEmail(email)) throw new Error("Этот email уже зарегистрирован. Перейдите во вкладку 'Войти'");
                nextStep = 'profile';
            } else if (step === 'profile') {
                const handle = normalizeAuthNickname(form.querySelector('[name="nickname"]').value);
                if (!await checkAuthNickname(handle)) {
                    nicknameAvailability = {value:form.querySelector('[name="nickname"]').value,state:'taken',message:HANDLE_TAKEN};
                    throw new Error(HANDLE_TAKEN);
                }
                form.querySelector('[name="nickname"]').value = handle; nextStep = 'password';
            } else {
                const result = await authenticate(email, password, signup, signup ? { nickname:form.querySelector('[name="nickname"]').value } : null);
                if (result.confirmationRequired) nextStep = 'confirm';
                else if (result.hydrated === false) nextStep = 'email';
            }
        } catch (error) {
            authNotice = error.message || 'Не удалось выполнить действие. Попробуйте ещё раз.'; authSuccess = false;
            if (/никнейм уже занят/.test(authNotice)) nextStep = 'profile';
        } finally {
            if (step === 'password' || recovery) form.querySelector('[name="password"]').value = '';
            delete form.dataset.saving; form.removeAttribute('aria-busy');
            controls.forEach(([element, disabled]) => { element.disabled = disabled; });
            if (modal.classList.contains('active')) setAuthStep(nextStep, false);
            refresh();
            if (nextStep !== step && modal.classList.contains('active')) setAuthStep(nextStep);
        }
    }
    function bindUI() {
        const container = document.getElementById('cloudSyncPanel');
        if (!container || container.dataset.bound) { refresh(); return; }
        container.dataset.bound = 'true';
        container.querySelector('[data-cloud-open-auth]').addEventListener('click', openAuth);
        const modal = document.getElementById('cloudAuthModal');
        modal.querySelector('[data-cloud-auth]').addEventListener('submit', submitCloudForm);
        modal.querySelector('#closeCloudAuthBtn').addEventListener('click', closeAuth);
        modal.querySelector('[data-cloud-forgot]').addEventListener('click', () => setAuthMode(true));
        modal.querySelector('[data-cloud-back]').addEventListener('click', () => setAuthMode(false));
        modal.querySelectorAll('[name="mode"]').forEach(input => input.addEventListener('change', () => {
            if (modal.querySelector('form').dataset.saving) return;
            authNotice = ''; authSuccess = false; modal.querySelector('[name="password"]').value = ''; setAuthStep('email'); refresh();
        }));
        modal.querySelector('[data-auth-prev]').addEventListener('click', () => {
            const form = modal.querySelector('form'); if (form.dataset.saving) return;
            authNotice = ''; form.querySelector('[name="password"]').value = '';
            setAuthStep(form.dataset.step === 'password' && form.querySelector('[value="signup"]').checked ? 'profile' : 'email'); refresh();
        });
        modal.querySelector('[data-auth-edit-email]').addEventListener('click', () => { authNotice = ''; modal.querySelector('[name="password"]').value = ''; setAuthStep('email'); refresh(); });
        modal.querySelector('[name="nickname"]').addEventListener('input', event => {
            event.target.value = event.target.value.replace(/^@+/, '').toLowerCase();
            const form = event.target.form;
            clearTimeout(nicknameCheckTimer); nicknameCheckVersion++;
            nicknameAvailability = { value:event.target.value, state:'checking', message:'Проверяем никнейм…' };
            authNotice = ''; authSuccess = false; refresh(); updateNicknameAvailability(form);
            nicknameCheckTimer = setTimeout(() => checkNicknameLive(form), 300);
        });
        modal.querySelector('[data-auth-show-password]').addEventListener('click', event => {
            const field = modal.querySelector('[name="password"]'), show = field.type === 'password'; field.type = show ? 'text' : 'password';
            event.currentTarget.textContent = show ? 'Скрыть' : 'Показать'; event.currentTarget.setAttribute('aria-pressed',String(show)); event.currentTarget.setAttribute('aria-label',show ? 'Скрыть пароль' : 'Показать пароль');
        });
        const sizeAuth = () => { modal.style.setProperty('--auth-height', `${window.visualViewport?.height || window.innerHeight}px`); modal.style.setProperty('--auth-offset', `${window.visualViewport?.offsetTop || 0}px`); };
        window.visualViewport?.addEventListener('resize', sizeAuth); window.visualViewport?.addEventListener('scroll', sizeAuth); window.addEventListener('resize',sizeAuth); sizeAuth();
        document.addEventListener('keydown', event => {
            if (!modal.classList.contains('active')) return;
            if (event.key === 'Escape') { event.preventDefault(); if (modal.dataset.entry !== 'true') closeAuth(); }
            if (event.key === 'Tab') {
                const controls = [...modal.querySelectorAll('button,input')].filter(element => !element.disabled && !element.closest('[hidden]'));
                const first = controls[0], last = controls[controls.length - 1];
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }
        });
        container.querySelector('[data-cloud-logout]').addEventListener('click', event => {
            const button = event.currentTarget;
            button.disabled = true;
            button.textContent = 'Выходим…';
            logout().catch(error => {
                status(error.message);
                app?.showToast?.(error.message, 'error');
            }).finally(() => {
                if (button.isConnected && session) {
                    button.disabled = false;
                    button.textContent = 'Выйти';
                }
            });
        });
        container.querySelector('[data-cloud-bind]').addEventListener('click', () => {
            if (!session || busy || applying) return;
            // Account switching always pulls the target account; local data is never rebound for upload.
            bootstrapCloud(true).catch(() => {});
        });
        container.querySelectorAll('[data-cloud-resolve]').forEach(button => button.addEventListener('click', () => sync(button.dataset.cloudResolve)));
        refresh();
    }
    function prepareLocalReset() {
        clearTimeout(timer); clearInterval(polling); stopRealtime();
        const owner = localStorage.getItem(OWNER);
        // Local reset must not become a bulk deletion in the cloud on next login.
        if (owner) write(`gt-cloud-state-v1:${owner}`, { base: null, revision: 0 });
    }
    function attachmentStorage() {
        if (!client || !session || busy || applying || transitioning || loggingOut || readyIdentity !== ownerId() || localStorage.getItem(OWNER) !== ownerId())
            throw new Error('Войдите в облачный аккаунт, привяжите профиль и дождитесь синхронизации.');
        const identity = ownerId(), storage = client.storage.from('goal-attachments');
        return { userId: session.user.id, storage, assertOwner() {
            if (identity !== ownerId() || localStorage.getItem(OWNER) !== identity) throw new Error('Облачный аккаунт изменился.');
        } };
    }
    function rememberPlayerTag(userId, shortId, expectedClient) {
        if (expectedClient !== client || session?.user?.id !== userId || loggingOut || !app?.user || app.user.supabaseUserId !== userId) return false;
        if (shortId !== null && !/^#[A-Z0-9]{6,8}$/.test(shortId)) return false;
        publishPlayerTag(scope(),shortId,++playerTagVersion);
        return true;
    }
    Object.defineProperty(window,'supabaseClient',{get:()=>singleton.instance,configurable:false});
    window.CloudSync = { get client(){return singleton.instance;}, currentPlayerTag, fetchPlayerTag:options=>fetchPlayerTag(scope(),options), fetchProfile:()=>fetchProfile(), rememberPlayerTag, canOpenCachedAccount, authClient: () => client, connectionState, refresh, accountConnection() {
        if (!client || !session?.user?.id || loggingOut || localStorage.getItem(LOCK) === 'true') return null;
        const ownProfile = app?.user?.supabaseUserId === session.user.id || app?.user?.id === session.user.id;
        return { client, userId: session.user.id, identity: ownerId(), shortId: ownProfile ? app?.user?.shortId || null : null, handle: (ownProfile ? app?.user?.handle : null) || session.user.user_metadata?.ncd_handle || null };
    }, attachmentStorage, openAuth, closeAuth, prepareLocalReset, attach(instance) { app = instance; bindUI(); initialize(); }, bindUI, localChanged, sync, pushGoals, refreshGoals, saveAccountProfile, bootstrapCloud, configured: () => !!client, isApplying: () => applying, isSyncing: () => isSyncing || !!goalSyncWork || !!sectionSyncWork || busy || transitioning,
        configure, authenticate, checkAuthNickname, logout, capture, localEmpty };
    window.addEventListener('online', () => { if (loggingOut) return; if (client && session) { if (readyIdentity === ownerId()) sync(); else acceptSession(session,true); } else if (client && localStorage.getItem(LOCK) !== 'true') resumeStoredSession(); else initialize(); });
    window.addEventListener('focus', () => { if (!loggingOut && !session && sessionError) { resumeStoredSession(); return; } if (!loggingOut && session) { if (readyIdentity === ownerId()) sync(); else acceptSession(session,true); } });
    document.addEventListener('goaltracker:storage-saved', localChanged);
    document.addEventListener('goaltracker:finance-changed', localChanged);
    document.addEventListener('goaltracker:health-changed', localChanged);
})();
