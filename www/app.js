// ===== NCD - Main Application =====

// ☁️ Облачный сервер (настраивается в Настройки → Синхронизация, пусто = локально)
const CLOUD_URL = '';

// 📦 Версия встроенного бандла (должна совпадать с package.json / version.json на сервере)
const APP_VERSION = '1.3.39';
// 🌐 Сервер обновлений (version.json + updates/latest.zip)
const UPDATE_BASE_URL = window.OTASync?.baseUrl || 'https://goaltracker-pro.nekzzcore.workers.dev';

const nativeUpdater = window.Capacitor?.Plugins?.CapacitorUpdater;


// Shared Android/PWA form views. Inactive forms live in inert templates, outside
// the rendered document; moving the same nodes preserves handlers and drafts.
window.NCDModalViews = (() => {
    const views = new Map([...document.querySelectorAll('template[data-modal-view]')].map(template => [template.dataset.modalView, { template, node: template.content.firstElementChild }]));
    return {
        mount(id) { const view = views.get(id); if (view && !view.node.isConnected) view.template.after(view.node); return view?.node; },
        unmount(id) { const view = views.get(id); if (view) view.template.content.append(view.node); },
        mountAll() { for (const id of views.keys()) this.mount(id); },
        unmountInactive() { for (const [id, view] of views) if (!view.node.classList.contains('active')) this.unmount(id); }
    };
})();

class GoalTracker {
    getVersion() { return APP_VERSION; }
    constructor() {
        this.user = null;
        this.goals = [];
        this.achievements = [];
        this.habits = [];
        this.events = [];
        this.notes = {};
        this.workspace = { portfolio:[], eloHistory:[], books:[], topics:[] };
        this.settings = {
            theme: 'dark',
            notifications: true,
            habitReminders: false,
            deadlineWarnings: true,
            calendarReminders: true,
            streakAlerts: true,
            notificationSound: true,
            notificationVibration: true,
            reminderDays: 3,
            gamification: true,
            autoSync: true
        };
        this.updatedAt = null;
        this._dirty = false;
        this._syncTimer = null;
        this._dataEpoch = 0;
        this._resetting = false;
        this.gamification = {
            xp: 0,
            level: 1,
            hp: 100,
            maxHp: 100,
            streak: 0,
            lastActiveDate: null,
            badges: [],
            completedGoals: 0,
            totalHabits: 0,
            activeHabits: 0,
            earlyCompletions: 0,
            lateCompletions: 0,
            skipProtectionPotions: 0,
            injuryDebuffUntil: null,
        };
        this.currentView = 'goals';
        this.currentMonth = new Date();
        this.selectedDate = null;
        this.notificationManager = null;
        this.deferredPrompt = null;
        this.gamificationEngine = null;
        this.init();
    }

    init() {
        this.showSplashScreen();
        this.loadData();
        
        // Preserve legacy RPG data without starting its engine or interface effects.
        this.gamificationEngine = null;

        this.bindEvents();
        this.initPWA();
        this.initTheme();
        this.initRhythmClock();

        // Инициализация менеджера уведомлений
        if (window.Capacitor && window.Capacitor.getPlatform?.() === 'android' && window.NotificationManager) {
            this.notificationManager = new window.NotificationManager(this);
            this.notificationManager.init().then(() => this.rescheduleAllNotifications()).catch(() => {});
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') this.rescheduleAllNotifications().catch(() => {});
            });
        }

        if (window.CloudSync) {
            if (window.CloudSync.canOpenCachedAccount?.(this.user)) this.showApp();
            else this.showAccountLoading();
            window.CloudSync.attach(this);
        } else if (this.user) {
            this.showApp();
        } else {
            this.showAuth();
            // Новое устройство: сетевой автовход только после первой отрисовки.
            if (this.settings.autoSync) {
                setTimeout(() => { if (!this.user) this.syncData(true); }, 6500);
            }
        }
    }

    // ===== Auth =====
    showAuth() {
        this.hideSplashScreen();
        document.getElementById('authScreen').style.display = 'flex';
        document.getElementById('app').style.display = 'none';
        window.avatarVideo?.refresh();

        if (window.CloudSync) {
            document.querySelector('#authScreen .auth-card').hidden = true;
            window.CloudSync.attach(this);
            window.CloudSync.openAuth({ mode:localStorage.getItem('gt-session-locked-v1') === 'true' ? 'signin' : 'signup', entry:true });
        }
        if (this.authBound) return;
        this.authBound = true;

        // Avatar selector
        document.querySelectorAll('.avatar-option').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.avatar-option').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });

        document.getElementById('authForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            if (this._creatingProfile || this.user) return;
            const nickname = document.getElementById('authNickname').value.trim();
            const avatar = document.querySelector('.avatar-option.active')?.dataset.avatar || '😊';

            if (nickname.length < 2) {
                this.showToast('Никнейм должен быть от 2 символов', 'error');
                return;
            }

            this._creatingProfile = true;
            this.user = {
                id: crypto.randomUUID(),
                nickname: nickname,
                avatar: avatar,
                createdAt: new Date().toISOString()
            };
            const saved = await this.saveData();
            this._creatingProfile = false;
            if (!saved) { this.user = null; return; }
            this.showApp();
            this.showToast(`Добро пожаловать, ${nickname}! 🎉`, 'success');
        });
    }

    updateGreeting() {
        const hour = new Date().getHours();
        let greeting = 'Добрый день';
        if (hour < 6) greeting = 'Доброй ночи';
        else if (hour < 12) greeting = 'Доброе утро';
        else if (hour < 18) greeting = 'Добрый день';
        else greeting = 'Добрый вечер';
        document.getElementById('dashboardGreeting').textContent = `${greeting}, ${this.user?.nickname || ''}! 👋`;
    }

    // Startup splash is owned exclusively by the inline timer in index.html.
    // Keep these hooks for auth/sync callers without allowing early dismissal or restart.
    showSplashScreen() {}

    hideSplashScreen() {}

    initPWA() {
        if (this._pwaInitialized) return;
        this._pwaInitialized = true;
        // Native shells already serve local assets. A stale PWA worker can
        // override both an Android OTA bundle and an updated Electron build.
        if ('serviceWorker' in navigator) {
            if (window.electronAPI || window.Capacitor?.isNativePlatform?.()) {
                navigator.serviceWorker.getRegistrations()
                    .then(registrations => Promise.all(registrations.map(registration => registration.unregister())))
                    .catch(() => {});
                if ('caches' in window) {
                    caches.keys()
                        .then(keys => Promise.all(keys.filter(key => key.startsWith('goaltracker-')).map(key => caches.delete(key))))
                        .catch(() => {});
                }
            } else {
                if (window.isSecureContext !== false) navigator.serviceWorker.register(new URL('./sw.js', document.baseURI).href, { scope: new URL('./', document.baseURI).href, updateViaCache: 'none' })
                    .catch(error => console.warn('[PWA] Service worker registration failed:', error));
            }
        }

        // PWA Install Prompt
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            this.deferredPrompt = e;
            this.showInstallButton();
        });
        window.addEventListener('appinstalled', () => {
            this.deferredPrompt = null;
            this.hideInstallButton();
            this.showToast('Приложение установлено! 🎉', 'success');
        });

    }

    showApp() {
        this.hideSplashScreen();
        document.getElementById('authScreen').style.display = 'none';
        document.getElementById('app').style.display = 'flex';

        this.updateGreeting();

        this.render();
        this.checkTodayNotes();

        // Supabase attach восстанавливает сессию по сети. Не запускаем его в
        // критическом пути первой отрисовки Android WebView.
        clearTimeout(this._cloudAttachTimer);
        this._cloudAttachTimer = setTimeout(() => window.CloudSync?.attach(this), 0);

        this.initPWA();

        // Тихая синхронизация при запуске (подтянуть данные с сервера)
        if (this.settings.autoSync) {
            setTimeout(() => this.syncData(true), 7000);
        }
    }

    async resetProfile() {
        if (!confirm('Сбросить профиль и все локальные данные? Это действие нельзя отменить. Серверные копии не удаляются.')) return;
        this._resetting = true;
        this._dataEpoch++;
        clearTimeout(this._syncTimer);
        try {
            await this.cancelAllNotifications();
            window.CloudSync?.prepareLocalReset();
            await window.ProfileStorage.reset();
            location.reload();
        } catch (error) {
            this._resetting = false;
            this.showToast('Не удалось сбросить данные: ' + error.message, 'error');
        }
    }

    showAccountLoading() {
        document.getElementById('app').style.display = 'none';
        document.getElementById('authScreen').style.display = 'none';
        document.getElementById('cloudAuthModal').classList.remove('active');
        document.body.classList.remove('ncd-auth-open');
    }

    clearAccountMemory() {
        this._dataEpoch = (this._dataEpoch || 0) + 1;
        clearTimeout(this._syncTimer); clearTimeout(this._cloudAttachTimer); clearTimeout(this._rhythmClockTimer);
        this._rhythmClockTimer = null; this._rhythmClockKey = null;
        this.workspace = { portfolio:[], eloHistory:[], books:[], topics:[] };
        this.user = null; this.goals = []; this.notes = {}; this.events = []; this.achievements = []; this.habits = [];
        this.gamification = {}; this.gamificationEngine = null; this.updatedAt = null; this._storedExtras = { profileReset:true };
        this._goalAttachmentDraft = []; this._dirty = false; this.selectedDate = null; this.currentMonth = new Date(); this.currentView = 'goals';
        this.settings = { theme:document.documentElement.dataset.theme || 'dark', autoSync:true, notifications:true, calendarReminders:true, habitReminders:false, notificationSound:true, notificationVibration:true };
        for (const selector of ['#caseMain','#learningMain','#goalsList','#calendarGrid','#calendarDayEvents','#calendarMonthActivities','#financeMain','#goalDetailContent','#settingsUserCard','#profileContent','#achievementsList','#toastContainer','#inspectorOverview','#recentAchievements','#upcomingDeadlines','#productivityWidget','#goalHealthWidget']) document.querySelector(selector)?.replaceChildren();
        document.querySelectorAll('.modal.active').forEach(modal => modal.classList.remove('active'));
        window.NCDModalViews.unmountInactive();
        document.querySelectorAll('form').forEach(form => form.reset());
        document.querySelectorAll('input:not([type=radio]):not([type=checkbox]):not([type=button]):not([type=submit]),textarea').forEach(field => { field.value = ''; });
        document.querySelectorAll('dialog').forEach(dialog => { if (dialog.open) dialog.close?.(); if (dialog.classList.contains('attachment-preview')) dialog.remove(); });
        const greeting = document.getElementById('dashboardGreeting'); if (greeting) greeting.textContent = 'Добро пожаловать';
        const title = document.getElementById('detailGoalTitle'); if (title) title.textContent = 'Детали цели';
        document.querySelector('[data-auth-edit-email]')?.replaceChildren();
        window.finance?.clearData?.(); window.healthView?.clearAccount?.();
        this.setHealth3DActive(false);
    }

    // ===== Data Management =====
    loadData() {
        const data = window.ProfileStorage.get();
        const legacyGoals = () => {
            try { const value = JSON.parse(localStorage.getItem('gt_goals') || 'null'); return Array.isArray(value) && value.every(goal => goal && typeof goal.id === 'string' && typeof goal.title === 'string') ? value : []; }
            catch { return []; }
        };
        if (!data) { this.goals = legacyGoals(); return; }
        this._storedExtras = data;
        this.user = data.user || null;
        this.goals = Array.isArray(data.goals) ? data.goals : legacyGoals();
        this.achievements = data.achievements || [];
        this.habits = Array.isArray(data.habits) ? data.habits : [];
        this.events = data.events || [];
        this.notes = data.notes || {};
        this.workspace = { portfolio:[], eloHistory:[], books:[], topics:[], ...(data.workspace || {}) };
        this.settings = { ...this.settings, ...(data.settings || {}) };
        this.settings.habitReminders = false;
        this.gamification = { ...this.gamification, ...(data.gamification || {}) };
        this.updatedAt = data.updatedAt || null;
        this.notes = this.normalizeNotes(this.notes);
    }

    serialize() {
        return {
            ...this._storedExtras,
            schemaVersion: 1,
            profileReset: this.user ? false : !!this._storedExtras?.profileReset,
            user: this.user,
            goals: this.goals,
            achievements: this.achievements,
            habits: this.habits,
            events: this.events,
            notes: this.notes,
            workspace: this.workspace,
            settings: this.settings,
            gamification: this.gamification,
            updatedAt: this.updatedAt
        };
    }

    async saveData({ deferAutoSync = false } = {}) {
        if (this._resetting || this._accountTransition) return false;
        this._dirty = true;
        const saved = await this.persistData();
        if (saved && !deferAutoSync) this.scheduleAutoSync();
        return saved;
    }

    async persistData() {
        const epoch = this._dataEpoch;
        if (this._accountTransition) return false;
        try {
            await window.ProfileStorage.save(this.serialize());
            if (epoch !== this._dataEpoch || this._accountTransition) return false;
            try { window.CloudSync?.localChanged(); } catch {}
            return true;
        } catch (error) {
            if (epoch !== this._dataEpoch || this._accountTransition) return false;
            console.error('Profile save failed:', error);
            this.showToast('Не удалось сохранить профиль. Экспортируйте данные и проверьте свободное место.', 'error');
            return false;
        }
    }

    scheduleAutoSync() {
        if (window.CloudSync?.configured()) { window.CloudSync.localChanged(); return; }
        if (this._resetting || !this.settings.autoSync || !this.user) return;
        clearTimeout(this._syncTimer);
        this._syncTimer = setTimeout(() => this.syncData(true), 2000);
    }

    getSyncBase() {
        // Синхронизация только если явно задан URL в настройках
        if (this.settings.syncUrl) return this.settings.syncUrl.replace(/\/$/, '');
        // По умолчанию — никакого сервера (автономный режим)
        return '';
    }

    // ===== Код доступа (PIN) =====
    // В автономном режиме не нужен. Оставлен для совместимости при включении синхронизации.
    getPin() {
        try { return localStorage.getItem('goalTracker_pin') || ''; }
        catch { return ''; }
    }

    setPin(pin) {
        try { localStorage.setItem('goalTracker_pin', pin); } catch {}
    }

    // В Electron код берётся из pin.txt автоматически — вводить не нужно
    async ensurePin() {
        if (this.getPin()) return;
        if (window.electronAPI?.getSyncPin) {
            try {
                const pin = await window.electronAPI.getSyncPin();
                if (pin) this.setPin(pin);
            } catch {}
        }
    }

    async apiFetch(base, init = {}) {
        await this.ensurePin();
        const headers = { ...(init.headers || {}) };
        const pin = this.getPin();
        if (pin) headers['X-Goal-PIN'] = pin;
        return fetch(base + '/api/data', { ...init, headers });
    }

    showPinModal(message) {
        const modal = document.getElementById('pinModal');
        if (modal.classList.contains('active')) return;
        document.getElementById('pinForm').reset();
        const err = document.getElementById('pinError');
        err.textContent = message || 'Введите код доступа, показанный на ноутбуке';
        err.className = message ? 'pin-error show error' : 'pin-error show';
        modal.classList.add('active');
        setTimeout(() => document.getElementById('pinInput').focus(), 60);
    }

    applyRemote(data) {
        if (this._resetting) return;
        if (data.user) this.user = { ...data.user, id: this.user?.id || data.user.id || crypto.randomUUID() };
        this.goals = data.goals ?? this.goals;
        this.achievements = data.achievements ?? this.achievements;
        this.habits = Array.isArray(data.habits) ? data.habits : this.habits;
        this.events = data.events ?? this.events;
        this.notes = data.notes ?? this.notes;
        this.workspace = data.workspace ?? this.workspace;
        this.settings = { ...this.settings, ...(data.settings || {}) };
        this.settings.habitReminders = false;
        this.gamification = { ...this.gamification, ...(data.gamification || {}) };
        this.updatedAt = data.updatedAt || null;
        this._dirty = false;
        this.notes = this.normalizeNotes(this.notes);
        return this.persistData();
    }

    afterRemoteUpdate() {
        if (this.user && document.getElementById('authScreen').style.display !== 'none') {
            // Данные пришли с сервера на новом устройстве — сразу показываем приложение
            this.showApp();
            return;
        }
        this.updateGreeting();
        this.render();
    }

    // ===== Event Binding =====
    bindEvents() {
        if (this._eventsBound) return;
        window.NCDModalViews.mountAll();
        this._eventsBound = true;
        this.initModalA11y();
        document.getElementById('openCloudProfileBtn').addEventListener('click', () => {
            if (this._creatingProfile) return;
            window.CloudSync?.attach(this);
            window.CloudSync?.openAuth({ entry:!this.user });
        });
        const desktopModulesMedia = window.matchMedia?.('(max-width: 768px)');
        desktopModulesMedia?.addEventListener?.('change', event => {
            if (event.matches && ['case','learning'].includes(this.currentView)) this.switchView('goals');
        });
        // Navigation (sidebar + bottom-nav)
        document.querySelectorAll('.nav-item[data-view], .bottom-nav-item[data-view]').forEach(item => {
            item.addEventListener('click', () => this.switchView(item.dataset.view));
        });

        document.querySelectorAll('.nav-item[data-action="settings"]').forEach(item => {
            item.addEventListener('click', () => this.openSettingsModal());
        });

        document.getElementById('toggleSidebar').addEventListener('click', () => {
            document.getElementById('sidebar').classList.toggle('collapsed');
        });

        // Goals
        document.getElementById('addGoalBtn').addEventListener('click', () => this.openGoalModal());
        document.getElementById('addGoalBtn2').addEventListener('click', () => this.openGoalModal());
        document.getElementById('goalForm').addEventListener('submit', (e) => this.saveGoal(e));
        document.getElementById('goalAddAttachment').addEventListener('click', () => document.getElementById('goalAttachmentInput').click());
        document.getElementById('goalAttachmentInput').addEventListener('change', event => {
            if (this._goalSaveInProgress) return;
            this._goalAttachmentDraft.push(...Array.from(event.target.files || [], file => ({ file })));
            event.target.value = '';
            this.renderGoalAttachmentDraft();
        });
        document.getElementById('goalAttachmentList').addEventListener('click', event => {
            if (this._goalSaveInProgress) return;
            const remove = event.target.closest('[data-remove-draft]');
            const open = event.target.closest('[data-open-draft]');
            if (remove) { this._goalAttachmentDraft.splice(Number(remove.dataset.removeDraft), 1); this.renderGoalAttachmentDraft(); }
            if (open) { const item = this._goalAttachmentDraft[Number(open.dataset.openDraft)]; if (item?.attachment) this.openGoalAttachment(item.attachment); }
        });
        document.getElementById('closeGoalModal').addEventListener('click', () => this.closeModal('goalModal'));
        document.getElementById('cancelGoalBtn').addEventListener('click', () => this.closeModal('goalModal'));
        document.getElementById('closeDetailModal').addEventListener('click', () => this.closeModal('goalDetailModal'));
        document.getElementById('goalDetailBackdrop').addEventListener('click', () => this.closeModal('goalDetailModal'));
        const detailMedia = window.matchMedia?.('(max-width: 768px)');
        const updateDetailRole = () => {
            const detail = document.getElementById('goalDetailModal');
            detail.setAttribute('role', detailMedia?.matches ? 'dialog' : 'region');
            if (detailMedia?.matches) detail.setAttribute('aria-modal', 'true');
            else detail.removeAttribute('aria-modal');
        };
        updateDetailRole();
        detailMedia?.addEventListener?.('change', updateDetailRole);

        // Achievements
        document.getElementById('addAchievementBtn').addEventListener('click', () => this.openAchievementModal());
        document.getElementById('achievementForm').addEventListener('submit', (e) => this.saveAchievement(e));
        document.getElementById('closeAchievementModal').addEventListener('click', () => this.closeModal('achievementModal'));
        document.getElementById('cancelAchievementBtn').addEventListener('click', () => this.closeModal('achievementModal'));

        document.getElementById('allCalendarActivitiesBtn').addEventListener('click', () => this.openCalendarActivities());
        document.getElementById('closeCalendarActivitiesModal').addEventListener('click', () => this.closeModal('calendarActivitiesModal'));
        document.getElementById('addCalendarNoteBtn').addEventListener('click', () => this.openNoteModal(this.selectedDate));

        // Notes
        document.getElementById('noteForm').addEventListener('submit', (e) => this.saveNote(e));
        document.getElementById('closeNoteModal').addEventListener('click', () => this.closeModal('noteModal'));
        document.getElementById('cancelNoteBtn').addEventListener('click', () => this.closeModal('noteModal'));
        document.getElementById('deleteNoteBtn').addEventListener('click', () => this.deleteNote());

        // Settings
        document.getElementById('settingsBtn').addEventListener('click', () => this.openSettingsModal());
        document.getElementById('mobileSettingsBtn').addEventListener('click', () => this.openSettingsModal());
        document.getElementById('closeSettingsModal').addEventListener('click', () => this.closeModal('settingsModal'));

        // Код доступа
        document.getElementById('pinForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const pin = document.getElementById('pinInput').value.replace(/\D/g, '');
            if (pin.length < 4) {
                document.getElementById('pinError').textContent = 'Код — минимум 4 цифры';
                document.getElementById('pinError').className = 'pin-error show error';
                return;
            }
            this.setPin(pin);
            this.closeModal('pinModal');
            this.showToast('Код сохранён — синхронизируемся...', 'success');
            setTimeout(() => this.syncData(false), 200);
        });
        document.getElementById('closePinModal').addEventListener('click', () => this.closeModal('pinModal'));
        document.getElementById('cancelPinBtn').addEventListener('click', () => this.closeModal('pinModal'));
        // Notification settings
        document.getElementById('notificationsEnabled').addEventListener('change', (e) => {
            this.settings.notifications = e.target.checked;
            this.saveData();
            const group = document.getElementById('notificationSettingsGroup');
            if (group) group.style.display = e.target.checked ? 'block' : 'none';
            if (e.target.checked) {
                this.requestNotificationPermission().then(granted => { if (granted) return this.rescheduleAllNotifications(); }).catch(() => {});
            } else {
                this.cancelAllNotifications();
            }
        });


        document.getElementById('calendarRemindersEnabled').addEventListener('change', (e) => {
            this.settings.calendarReminders = e.target.checked;
            this.saveData();
            if (e.target.checked) this.requestNotificationPermission().then(() => this.rescheduleAllNotifications()).catch(() => {});
            else this.rescheduleAllNotifications();
        });


        document.getElementById('notificationSoundEnabled').addEventListener('change', (e) => {
            this.settings.notificationSound = e.target.checked;
            this.saveData();
            this.rescheduleAllNotifications();
        });

        document.getElementById('notificationVibrationEnabled').addEventListener('change', (e) => {
            this.settings.notificationVibration = e.target.checked;
            this.saveData();
            this.rescheduleAllNotifications();
        });

        const androidNotifications = !!window.Capacitor && window.Capacitor.getPlatform?.() === 'android';
        document.getElementById('testNotificationBtn').hidden = !androidNotifications;
        document.querySelectorAll('[data-calendar-channel-option]').forEach(label => { label.hidden = androidNotifications; });
        document.querySelector('[data-calendar-channel-hint]').hidden = !androidNotifications;
        document.getElementById('notificationExactPermissionBtn').addEventListener('click', async () => {
            if (!androidNotifications || !this.notificationManager) return;
            const allowed = await this.notificationManager.requestExactPermission();
            if (allowed) await this.rescheduleAllNotifications();
        });
        document.getElementById('testNotificationBtn').addEventListener('click', () => {
            this.sendTestNotification();
        });


        // Theme
        document.getElementById('themeBtn').addEventListener('click', () => this.toggleTheme());
        document.getElementById('mobileThemeBtn').addEventListener('click', () => this.toggleTheme());
        window.CloudSync?.refresh?.();
        document.querySelectorAll('.theme-btn').forEach(btn => {
            btn.addEventListener('click', () => this.setTheme(btn.dataset.theme));
        });

        // Filters
        document.getElementById('filterStatus').addEventListener('change', () => this.renderGoals());
        document.getElementById('sortBy').addEventListener('change', () => this.renderGoals());

        // Calendar
        document.getElementById('prevMonth').addEventListener('click', () => this.changeMonth(-1));
        document.getElementById('nextMonth').addEventListener('click', () => this.changeMonth(1));

        document.getElementById('installPwaBtn').addEventListener('click', () => this.installPWA());

        // Modal overlays
        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', () => this.closeModal(overlay.parentElement.id));
        });

        // New Gamification Modals
        document.getElementById('profileEditForm').addEventListener('submit', event => this.saveProfileDetails(event));
        document.querySelectorAll('#profileEditForm input, #profileEditForm textarea').forEach(field => field.addEventListener('input', () => {
            clearTimeout(this._profileInputTimer);
            this._profileInputTimer = setTimeout(() => this.validateProfileDraft(), 400);
        }));
        document.getElementById('closeProfileEditModal').addEventListener('click', () => this.closeModal('profileEditModal'));
        document.getElementById('cancelProfileEditBtn').addEventListener('click', () => this.closeModal('profileEditModal'));
        window.NCDModalViews.unmountInactive();
        
    }

    // ===== View Management =====
    switchView(viewName) {
        const availableViews = new Set(['dashboard', 'goals', 'achievements', 'calendar', 'finance', 'health', 'case', 'learning']);
        if (!availableViews.has(viewName) || (['case','learning'].includes(viewName) && window.matchMedia?.('(max-width: 768px)').matches)) viewName = 'goals';
        if (viewName !== this.currentView) this.closeModal('goalDetailModal');
        this.currentView = viewName;
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.view === viewName);
        });
        document.querySelectorAll('.bottom-nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.view === viewName);
        });
        document.querySelectorAll('.view').forEach(view => {
            view.classList.toggle('active', view.id === `view-${viewName}`);
        });
        this.setHealth3DActive(viewName === 'health');
        this.render();
        // Render finance view when switching to finance
        if (viewName === 'finance') {
            if (window.renderFinanceView) {
                window.renderFinanceView();
            } else if (typeof renderFinanceView === 'function') {
                renderFinanceView();
            }
        }
    }

    setHealth3DActive(active) {
        if (!active) {
            window.health3D?.setActive(false);
            return;
        }

        if (!this._health3DPromise) {
            const status = document.getElementById('bodyScanStatus');
            if (status) status.textContent = 'Статус: скан загружается...';
            this._health3DPromise = import('./health-3d.js').catch(error => {
                this._health3DPromise = null;
                console.error('[Health3D] Не удалось загрузить 3D-модуль:', error);
                const loader = document.getElementById('health3DLoader');
                if (loader) loader.hidden = true;
                if (status) status.textContent = 'Статус: 3D-скан недоступен';
                return null;
            });
        }

        this._health3DPromise.then(() => {
            if (this.currentView === 'health') window.health3D?.setActive(true);
        });
    }

    render() {
        switch (this.currentView) {
            case 'dashboard': this.renderDashboard(); break;
            case 'goals': this.renderGoals(); break;
            case 'achievements': this.renderAchievements(); break;
            case 'calendar': this.renderCalendar(); break;

            case 'health': window.healthView?.render(); break;
            case 'case': window.CaseView?.render(this); break;
            case 'learning': window.LearningView?.render(this); break;
        }
        if (document.getElementById('settingsModal')?.classList.contains('active')) this.updateSettingsProfile();
        this.renderInspectorOverview();
        window.avatarVideo?.refresh();
    }

    // ===== Dashboard =====
    renderDashboard() {
        const total = this.goals.length;
        const active = this.goals.filter(g => g.status === 'active').length;
        const completed = this.goals.filter(g => g.status === 'completed').length;
        const overallProgress = total > 0
            ? Math.round(this.goals.reduce((s, g) => s + this.calculateProgress(g), 0) / total)
            : 0;

        document.getElementById('totalGoals').textContent = total;
        document.getElementById('activeGoals').textContent = active;
        document.getElementById('completedGoals').textContent = completed;
        document.getElementById('overallProgress').textContent = overallProgress + '%';

        const recent = this.getAchievementEntries().sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);
        document.getElementById('recentAchievements').innerHTML = recent.length
            ? recent.map(a => this.renderAchievementItem(a)).join('')
            : this.renderEmptyState('🏆', 'Пока нет достижений');

        const deadlines = this.goals.filter(g => g.deadline && g.status === 'active')
            .sort((a, b) => new Date(a.deadline) - new Date(b.deadline)).slice(0, 5);
        document.getElementById('upcomingDeadlines').innerHTML = deadlines.length
            ? deadlines.map(g => this.renderDeadlineItem(g)).join('')
            : this.renderEmptyState('📅', 'Нет активных дедлайнов');

        this.renderProductivityWidget();
        this.renderGoalHealthWidget();

    }

    // ===== Account and statistics inside Settings =====
    renderProfile({ rebuild = false } = {}) {
        const container = document.getElementById('profileContent');
        if (!container) return;
        if (!rebuild && document.getElementById('chooseProfileAvatar') && this._settingsProfileOwner === this.user?.id) {
            this.updateSettingsProfile();
            return;
        }
        this._settingsProfileOwner = this.user?.id;

        const total = this.goals.length;
        const active = this.goals.filter(g => g.status === 'active').length;
        const completed = this.goals.filter(g => g.status === 'completed').length;
        const achievementEntries = this.getAchievementEntries();
        const totalAchievements = achievementEntries.length;
        const overallProgress = total > 0
            ? Math.round(this.goals.reduce((s, g) => s + this.calculateProgress(g), 0) / total)
            : 0;

        const avatar = this.getCustomAvatar();
        const initials = (this.user?.nickname || 'Гость').trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0] || '').join('').toLocaleUpperCase('ru-RU');
        container.innerHTML = `
            <div class="profile-header card">
                <div class="profile-avatar-control">
                    <button type="button" class="profile-avatar" id="chooseProfileAvatar" aria-label="Выбрать фото профиля" ${this._avatarLoading ? 'disabled aria-busy="true"' : ''}>
                        ${avatar ? `<img src="${avatar}" alt="Аватар профиля" width="96" height="96">` : `<span class="profile-initials">${this.escapeHtml(initials)}</span>`}
                        <span class="profile-avatar-camera" aria-hidden="true">📷</span>
                    </button>
                    <input type="file" id="profileAvatarFile" accept="image/*" hidden>
                </div>
                <div class="profile-info">
                    <h2>${this.escapeHtml(this.user?.nickname || 'Гость')}</h2>

                    <button type="button" class="btn btn-secondary" id="editProfileBtn">Редактировать профиль</button>
                </div>
            </div>

            <div class="dashboard-grid">
                <div class="card stat-card">
                    <div class="stat-value">${total}</div>
                    <div class="stat-label">Всего целей</div>
                </div>
                <div class="card stat-card">
                    <div class="stat-value">${active}</div>
                    <div class="stat-label">Активных</div>
                </div>
                <div class="card stat-card">
                    <div class="stat-value">${completed}</div>
                    <div class="stat-label">Завершённых</div>
                </div>
                <div class="card stat-card">
                    <div class="stat-value">${overallProgress}%</div>
                    <div class="stat-label">Общий прогресс</div>
                </div>
                <div class="card stat-card">
                    <div class="stat-value">${totalAchievements}</div>
                    <div class="stat-label">Достижений</div>
                </div>
            </div>

            <div class="stats-grid">
                <div class="card category-progress-card">
                    <h3>📊 Прогресс по категориям</h3>
                    <div id="categoryStats"></div>
                </div>
                <div class="card weekly-activity-card">
                    <h3>📈 Активность за неделю</h3>
                    <div id="weeklyActivity"></div>
                </div>
            </div>

            <div class="card">
                <h3>🏆 Последние достижения</h3>
                <div class="achievements-list">
                    ${achievementEntries.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5)
                        .map(a => this.renderAchievementItem(a)).join('') || `<div class="first-step-achievement"><span aria-hidden="true">🏆</span><div><strong>Первый шаг</strong><p>${completed ? 'Первая цель закрыта — первый шаг сделан.' : 'Закройте первую цель, чтобы открыть достижение «Первый шаг»'}</p><div class="first-step-track" role="progressbar" aria-label="Первый шаг" aria-valuemin="0" aria-valuemax="1" aria-valuenow="${completed ? 1 : 0}"><span style="width:${completed ? 100 : 0}%"></span></div></div><strong>${completed ? 1 : 0}/1</strong></div>`}
                </div>
            </div>
        `;

        const accountHeader = container.querySelector('.profile-header');
        document.getElementById('settingsUserCard')?.replaceChildren(accountHeader);
        const host = document.getElementById('settingsUserCard') || container;
        if (this._settingsHeaderHost !== host) {
            this._settingsHeaderEvents?.abort();
            this._settingsHeaderEvents = new AbortController();
            this._settingsHeaderHost = host;
            const options = { signal:this._settingsHeaderEvents.signal };
            host.addEventListener('click', event => {
                if (event.target.closest('#chooseProfileAvatar')) document.getElementById('profileAvatarFile').click();
                if (event.target.closest('#editProfileBtn')) this.openProfileEditor();
            }, options);
            host.addEventListener('change', event => {
                if (event.target.id !== 'profileAvatarFile') return;
                const file = event.target.files?.[0];
                if (file) this.uploadProfileAvatar(file);
            }, options);
        }
        this.renderCategoryStats();
        this.renderWeeklyActivity();
    }

    updateSettingsProfile() {
        const header = document.querySelector('#settingsUserCard .profile-header');
        if (!header) return;
        const nickname = this.user?.nickname || 'Гость';
        const title = header.querySelector('h2');
        if (title.textContent !== nickname) title.textContent = nickname;
        const button = document.getElementById('chooseProfileAvatar');
        button.disabled = !!this._avatarLoading;
        button.setAttribute('aria-busy', String(!!this._avatarLoading));
        const avatar = this.getCustomAvatar(), image = button.querySelector('img');
        if (avatar) {
            if (!image) {
                button.querySelector('.profile-initials')?.remove();
                const node = document.createElement('img');
                node.alt = 'Аватар профиля'; node.width = 96; node.height = 96; node.src = avatar;
                button.prepend(node);
            } else if (image.getAttribute('src') !== avatar) image.src = avatar;
        } else {
            image?.remove();
            let initials = button.querySelector('.profile-initials');
            if (!initials) { initials = document.createElement('span'); initials.className = 'profile-initials'; button.prepend(initials); }
            const value = nickname.trim().split(/\s+/).slice(0,2).map(word => Array.from(word)[0] || '').join('').toLocaleUpperCase('ru-RU');
            if (initials.textContent !== value) initials.textContent = value;
        }
    }

    validateProfileDraft() {
        const error = document.getElementById('profileEditError');
        const nickname = document.getElementById('profileNickname').value.trim();
        const status = document.getElementById('profileStatus').value.trim();
        const valid = nickname.length >= 2 && nickname.length <= 32 && status.length <= 120;
        error.hidden = valid;
        error.textContent = valid ? '' : 'Никнейм: от 2 до 32 символов. Статус: до 120 символов.';
        return valid;
    }

    profileAvatarKey() {
        return `customAvatarData:${this.user?.id || this.user?.createdAt || 'local'}`;
    }

    getCustomAvatar() {
        try {
            const data = localStorage.getItem(this.profileAvatarKey()) || '';
            return data.length <= 200000 && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(data) ? data : '';
        } catch { return ''; }
    }

    async resizeProfileAvatar(file) {
        if (!['image/jpeg','image/png','image/webp','image/gif','image/avif','image/bmp'].includes(file.type)) throw new Error('Выберите растровое изображение: JPG, PNG, WebP, GIF, AVIF или BMP.');
        if (!file.size || file.size > 25 * 1024 * 1024) throw new Error('Фото должно быть не больше 25 МБ.');
        const url = URL.createObjectURL(file);
        try {
            const image = await new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => reject(new Error('Не удалось прочитать изображение. Выберите другое фото.'));
                img.src = url;
            });
            const width = image.naturalWidth, height = image.naturalHeight;
            if (!width || !height || width * height > 40000000) throw new Error('Изображение слишком большое: максимум 40 мегапикселей.');
            const crop = Math.min(width, height), size = Math.min(300, crop);
            const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Обработка фото недоступна в этом браузере.');
            context.drawImage(image, (width-crop)/2, (height-crop)/2, crop, crop, 0, 0, size, size);
            const data = canvas.toDataURL('image/webp', .8);
            if (data.length > 200000 || !/^data:image\/(?:webp|png);base64,/.test(data)) throw new Error('Не удалось сжать фото. Выберите другое изображение.');
            return data;
        } finally { URL.revokeObjectURL(url); }
    }

    async uploadProfileAvatar(file) {
        if (this._avatarLoading || !this.user) return false;
        const key = this.profileAvatarKey();
        this._avatarLoading = true;
        this.updateSettingsProfile();
        try {
            const data = await this.resizeProfileAvatar(file);
            if (key !== this.profileAvatarKey() || !this.user) throw new Error('Профиль изменился. Выберите фото заново.');
            // Device-local image, deliberately excluded from profile serialization/sync.
            localStorage.setItem(key, data);
            try { window.CloudSync?.localChanged(); } catch {}
            this.showToast('Фото профиля сохранено на устройстве', 'success');
            return true;
        } catch (error) {
            this.showToast(error?.name === 'QuotaExceededError' ? 'Не хватает места для фото. Старый аватар сохранён.' : error.message || 'Не удалось сохранить фото. Повторите попытку.', 'error');
            return false;
        } finally {
            this._avatarLoading = false;
            this.updateSettingsProfile();
        }
    }

    openProfileEditor() {
        if (!this.user || this._profileSaving) return;
        document.getElementById('profileNickname').value = this.user.nickname || '';
        document.getElementById('profileStatus').value = this.user.status || '';
        document.getElementById('profileEditError').hidden = true;
        document.getElementById('profileEditModal').classList.add('active');
        document.getElementById('profileNickname').focus();
    }

    async saveProfileDetails(event) {
        event.preventDefault();
        if (this._profileSaving || !this.user || !document.getElementById('profileEditModal').classList.contains('active')) return false;
        const error = document.getElementById('profileEditError'); error.hidden = true;
        const nickname = document.getElementById('profileNickname').value.trim(), status = document.getElementById('profileStatus').value.trim();
        if (nickname.length < 2 || nickname.length > 32 || status.length > 120) {
            error.textContent = 'Никнейм: от 2 до 32 символов. Статус: до 120 символов.'; error.hidden = false; return false;
        }
        const previous = this.user, dirty = this._dirty;
        const controls = [...document.querySelectorAll('#profileEditForm input, #profileEditForm textarea, #profileEditForm button, #closeProfileEditModal')];
        this._profileSaving = true; controls.forEach(control => { control.disabled = true; });
        document.getElementById('profileEditForm').setAttribute('aria-busy', 'true');
        this.user = { ...previous, nickname, status };
        try {
            if (await this.saveData({ deferAutoSync: true }) !== true) throw new Error('Profile not persisted');
        } catch {
            this.user = previous; this._dirty = dirty;
            error.textContent = 'Не удалось сохранить профиль. Изменения не применены. Повторите попытку.'; error.hidden = false; return false;
        } finally {
            this._profileSaving = false; controls.forEach(control => { control.disabled = false; });
            document.getElementById('profileEditForm').removeAttribute('aria-busy');
        }
        try {
            await window.CloudSync?.saveAccountProfile?.(nickname);
        } catch {
            this.showToast('Профиль сохранён на устройстве. Облачный никнейм обновится после восстановления сети.', 'warning');
        }
        this.closeModal('profileEditModal'); this.updateGreeting(); this.updateSettingsProfile();
        this.showToast('Профиль обновлён', 'success');
        return true;
    }

    renderAchievementItem(a) {
        const goal = this.goals.find(g => g.id === a.goalId);
        return `
            <div class="achievement-item">
                <span class="achievement-icon">🏆</span>
                <div class="achievement-info">
                    <div class="achievement-title">${a.protected ? '🔒' : ''} ${this.escapeHtml(a.title)}</div>
                    <div class="achievement-goal">${goal ? this.escapeHtml(goal.title) : 'Общее'}</div>
                </div>
                <span class="achievement-date">${new Date(a.date).toLocaleDateString('ru-RU')}</span>
            </div>
        `;
    }

    renderDeadlineItem(goal) {
        const daysLeft = this.getDaysLeft(goal.deadline);
        let cls = 'normal';
        if (daysLeft < 0) cls = 'urgent';
        else if (daysLeft <= 3) cls = 'warning';
        return `
            <div class="deadline-item ${cls}">
                <div class="deadline-info">
                    <div class="deadline-title">${this.escapeHtml(goal.title)}</div>
                    <div class="deadline-date">${new Date(goal.deadline).toLocaleDateString('ru-RU')}</div>
                </div>
                <span class="deadline-days ${cls}">${daysLeft >= 0 ? daysLeft + ' дн.' : 'Просрочено'}</span>
            </div>
        `;
    }

    renderEmptyState(icon, text) {
        return `<div class="empty-state"><div class="empty-state-icon">${icon}</div><div class="empty-state-text">${text}</div></div>`;
    }

    // ===== Widgets =====

    renderProductivityWidget() {
        const el = document.getElementById('productivityWidget');
        if (!el) return;
        const today = new Date().toISOString().split('T')[0];
        const todayCount = this.achievements.filter(a => a.date === today).length;
        const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
        const weekCount = this.achievements.filter(a => new Date(a.date) >= weekAgo).length;
        el.innerHTML = `
            <div class="widget-header">
                <span class="widget-icon">📈</span>
                <div><div class="widget-title">Продуктивность</div><div class="widget-subtitle">за 7 дней</div></div>
            </div>
            <div class="widget-stats">
                <div class="widget-stat"><span class="widget-stat-value">${todayCount}</span><span class="widget-stat-label">сегодня</span></div>
                <div class="widget-stat"><span class="widget-stat-value">${weekCount}</span><span class="widget-stat-label">за неделю</span></div>
                <div class="widget-stat"><span class="widget-stat-value">${(weekCount/7).toFixed(1)}</span><span class="widget-stat-label">в среднем</span></div>
            </div>
        `;
    }

    renderGoalHealthWidget() {
        const el = document.getElementById('goalHealthWidget');
        if (!el) return;
        const active = this.goals.filter(g => g.status === 'active');
        const onTrack = active.filter(g => {
            if (!g.deadline) return true;
            return this.calculateProgress(g) >= 50 || this.getDaysLeft(g.deadline) > 7;
        }).length;
        el.innerHTML = `
            <div class="widget-header">
                <span class="widget-icon">💚</span>
                <div><div class="widget-title">Здоровье целей</div><div class="widget-subtitle">${active.length} активных</div></div>
            </div>
            <div class="health-indicators">
                <div class="health-item"><span class="health-dot good"></span><span>В графике: ${onTrack}</span></div>
                <div class="health-item"><span class="health-dot bad"></span><span>Под угрозой: ${active.length - onTrack}</span></div>
            </div>
        `;
    }

    // ===== Goals =====
    renderGoals(skipCloud = false) {
        if (!skipCloud && !window.CloudSync?.isApplying?.()) window.CloudSync?.refreshGoals?.();
        const container = document.getElementById('goalsList');
        const filter = document.getElementById('filterStatus').value;
        const sort = document.getElementById('sortBy').value;

        let items = this.goals.filter(goal => filter === 'completed'
            ? this.isGoalFinished(goal)
            : !this.isGoalFinished(goal));
        if (filter === 'active') items = items.filter(goal => goal.status === 'active');
        items.sort((a, b) => {
            switch (sort) {
                case 'priority': {
                    const importance = this.getGoalPriorityWeight(b.priority) - this.getGoalPriorityWeight(a.priority);
                    return importance || (new Date(b.createdAt) - new Date(a.createdAt));
                }
                case 'deadline': return (a.deadline || '9999').localeCompare(b.deadline || '9999');
                case 'progress': return this.calculateProgress(b) - this.calculateProgress(a);
                case 'name': return a.title.localeCompare(b.title);
                default: return new Date(b.createdAt) - new Date(a.createdAt);
            }
        });

        if (!items.length) { container.innerHTML = this.renderEmptyState('🎯', 'Нет целей. Создайте первую!'); return; }
        const groups = new Map();
        items.forEach(goal => {
            const category = goal.category || 'personal';
            if (!groups.has(category)) groups.set(category, []);
            groups.get(category).push(goal);
        });
        container.innerHTML = `<div class="goal-table-head" aria-hidden="true"><span></span><span>Название</span><span>Подцели</span><span>Приоритет</span><span>Дедлайн</span><span></span></div>` + [...groups].map(([category, goals]) => `<section class="goal-group"><h3 class="goal-group-heading">${this.escapeHtml(this.getCategoryLabel(category))}<span>${goals.length}</span></h3>${goals.map(g => this.renderGoalItem(g)).join('')}</section>`).join('');
        container.querySelectorAll('.goal-row').forEach(row => {
            const goal = items.find(item => String(item.id) === row.dataset.id);
            if (goal) this.bindGoalRow(row, goal);
        });
    }

    // A row expands its subgoals inline (accordion); the detail modal stays an explicit action.
    bindGoalRow(row, goal) {
        const header = row.querySelector('.goal-item');
        const body = row.querySelector('.goal-item-body');
        if (!header || !body) return;
        const id = row.dataset.id;
        const toggle = () => this.toggleGoalRow(row);
        header.addEventListener('click', toggle);
        header.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
        });
        header.addEventListener('contextmenu', event => {
            event.preventDefault();
            this.openGoalContextMenu(id, event.clientX, event.clientY, header);
        });
        this.bindSubgoalControls(body, id);
        body.querySelector('[data-open-goal-detail]')?.addEventListener('click', () => this.openGoalDetail(id));
        body.querySelector('[data-add-subgoal-inline]')?.addEventListener('click', () => this.addSubgoal(id));
        if (row.classList.contains('is-open')) this.setGoalRowOpen(row, true, false);
    }

    toggleGoalRow(row) {
        const id = String(row.dataset.id);
        const open = !row.classList.contains('is-open');
        if (open) {
            document.querySelectorAll('.goal-row.is-open').forEach(other => {
                if (other !== row) this.setGoalRowOpen(other, false);
            });
            this._expandedGoalId = id;
        } else if (this._expandedGoalId === id) {
            this._expandedGoalId = null;
        }
        this.setGoalRowOpen(row, open);
    }

    setGoalRowOpen(row, open, animate = true) {
        const body = row.querySelector('.goal-item-body');
        const header = row.querySelector('.goal-item');
        row.classList.toggle('is-open', open);
        header?.setAttribute('aria-expanded', String(open));
        if (!body) return;
        if (body._goalOpenTimer) { clearTimeout(body._goalOpenTimer); body._goalOpenTimer = null; }
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        if (!animate || reduced) { body.style.maxHeight = open ? 'none' : '0px'; return; }
        if (open) {
            body.style.maxHeight = '0px';
            void body.offsetHeight;
            body.style.maxHeight = `${body.scrollHeight}px`;
            body._goalOpenTimer = setTimeout(() => {
                body._goalOpenTimer = null;
                if (row.classList.contains('is-open')) body.style.maxHeight = 'none';
            }, 380);
        } else {
            body.style.maxHeight = `${body.scrollHeight || body.offsetHeight || 0}px`;
            void body.offsetHeight;
            body.style.maxHeight = '0px';
        }
    }

    getGoalPriorityWeight(priority) {
        // Retain legacy critical goals; missing/unknown priorities behave as medium.
        switch (priority) {
            case 'milestone': return 5;
            case 'critical': return 4;
            case 'high': return 3;
            case 'low': return 1;
            default: return 2;
        }
    }

    renderGoalItem(goal) {
        const progress = this.calculateProgress(goal);
        const steps = this.getSubgoalProgress(goal);
        const rhythmStatus = this.getGoalRhythmStatus(goal);
        const rhythmChip = rhythmStatus?.state === 'waiting'
            ? '<span class="goal-rhythm-chip is-waiting">Ждёт отметки</span>'
            : rhythmStatus?.state === 'done'
                ? '<span class="goal-rhythm-chip is-done">День зачтён</span>'
                : '';
        const deadline = goal.deadline ? new Date(goal.deadline).toLocaleDateString('ru-RU', { day:'2-digit', month:'short' }) : '—';
        const id = String(goal.id);
        const open = this._expandedGoalId === id;
        const bodyId = `goalBody-${id.replace(/[^\w-]/g, '_')}`;
        return `<div class="goal-row${open ? ' is-open' : ''}" data-id="${this.escapeHtml(id)}">
            <div class="goal-item${['high', 'critical', 'milestone'].includes(goal.priority) ? ' goal-item-important' : ''}" data-id="${this.escapeHtml(id)}" role="button" tabindex="0" aria-expanded="${open}" aria-controls="${bodyId}" aria-label="${this.escapeHtml(goal.title)}: ${open ? 'свернуть подцели' : 'показать подцели'}">
                <span class="goal-status ${goal.status === 'completed' ? 'is-done' : ''}" aria-label="${goal.status === 'completed' ? 'Завершена' : 'Активна'}">${goal.status === 'completed' ? '✓' : '○'}</span>
                <span class="goal-item-title"><span class="goal-title-text">${this.escapeHtml(goal.title)}</span>${rhythmChip}</span>
                <span class="goal-subgoal-summary" title="Подцели"><span>${steps.completed}/${steps.total}</span><span class="subgoal-mini-bar" role="progressbar" aria-label="Прогресс подцелей" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${steps.percent}"><span style="width:${steps.percent}%"></span></span></span>
                <span class="goal-priority-cell"><i class="priority-dot ${this.getPriorityClass(goal.priority)}"></i><span>${this.escapeHtml(this.getPriorityLabel(goal.priority))}</span></span>
                <time class="goal-row-deadline ${goal.deadline && this.getDaysLeft(goal.deadline) < 0 && goal.status !== 'completed' ? 'overdue' : ''}">${deadline}</time>
                <span class="goal-item-progress" aria-hidden="true">${progress}%</span>
                <span class="goal-row-progress" hidden>${progress}%</span>
                <span class="goal-chevron" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="m6 9 6 6 6-6"/></svg></span>
            </div>
            ${this.renderGoalBody(goal, bodyId)}
        </div>`;
    }

    renderGoalBody(goal, bodyId) {
        const subgoals = Array.isArray(goal.subgoals) ? goal.subgoals : [];
        const steps = this.getSubgoalProgress(goal);
        const id = String(goal.id);
        const deadline = goal.deadline ? new Date(goal.deadline).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' }) : null;
        const overdue = goal.deadline && this.getDaysLeft(goal.deadline) < 0 && goal.status !== 'completed';
        return `<div class="goal-item-body" id="${bodyId}" role="region" aria-label="Подцели цели ${this.escapeHtml(goal.title)}">
            <div class="goal-item-body-inner">
                <div class="goal-item-body-meta">
                    <span class="priority-badge ${this.getPriorityClass(goal.priority)}">${this.escapeHtml(this.getPriorityLabel(goal.priority))}</span>
                    ${deadline ? `<time class="goal-body-deadline${overdue ? ' overdue' : ''}">${deadline}</time>` : ''}
                    <span class="goal-body-steps">${steps.completed} из ${steps.total} подцелей · ${steps.percent}%</span>
                </div>
                ${subgoals.length
                    ? `<div class="subgoals-list" role="list">${subgoals.map(step => this.renderSubgoalItem(goal.id, step)).join('')}</div>`
                    : `<div class="subgoals-empty"><p>Разбей цель на шаги — добавь первую подцель</p></div>`}
                <div class="goal-item-actions">
                    <button type="button" class="btn btn-secondary" data-open-goal-detail="${this.escapeHtml(id)}">Открыть детали</button>
                    <button type="button" class="btn btn-secondary" data-add-subgoal-inline="${this.escapeHtml(id)}">+ Подцель</button>
                </div>
            </div>
        </div>`;
    }

    renderInspectorOverview() {
        const host = document.getElementById('inspectorOverview');
        if (!host) return;
        const active = this.goals.filter(goal => goal.status !== 'completed');
        const upcoming = active.filter(goal => goal.deadline).sort((a,b) => a.deadline.localeCompare(b.deadline)).slice(0,4);
        const done = this.goals.length - active.length;
        const ratio = this.goals.length ? Math.round(done / this.goals.length * 100) : 0;
        let title = 'Обзор пространства';
        let body = `<div class="overview-number"><strong>${active.length}</strong><span>активных целей</span></div><div class="overview-meter"><span style="width:${ratio}%"></span></div><p class="inspector-hint">${done} из ${this.goals.length} целей завершено</p><h3>Ближайшие дедлайны</h3>${upcoming.map(goal => `<button class="inspector-link" data-inspect-goal="${this.escapeHtml(goal.id)}"><span>${this.escapeHtml(goal.title)}</span><time>${new Date(goal.deadline).toLocaleDateString('ru-RU',{day:'2-digit',month:'short'})}</time></button>`).join('') || '<p class="inspector-hint">Нет назначенных дедлайнов</p>'}<div class="inspector-tip">Выберите цель в списке, чтобы открыть её прогресс, действия и файлы.</div>`;
        if (this.currentView === 'calendar') {
            title = 'Повестка дня';
            const today = new Date(); const date = this.calendarDateString(today.getFullYear(), today.getMonth(), today.getDate());
            const activities = this.getCalendarActivities(date);
            body = `<div class="overview-number"><strong>${activities.length}</strong><span>дел на сегодня</span></div><h3>${today.toLocaleDateString('ru-RU',{day:'numeric',month:'long'})}</h3>${activities.map(item => `<div class="context-event"><time>${this.escapeHtml(item.time || 'Весь день')}</time><span>${this.escapeHtml(item.title)}</span></div>`).join('') || '<p class="inspector-hint">На сегодня ничего не запланировано.</p>'}<div class="inspector-tip">Выберите день в календаре, чтобы просмотреть расписание или добавить запись.</div>`;
        } else if (this.currentView === 'finance') {
            title = 'Страж накоплений';
            const safety = window.finance?.getSafetySummary?.() || {balance:0,target:0,targetMonths:6,months:null,percent:null,recent:[]};
            const format = value => Number(value).toLocaleString('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2});
            body = `<figure id="finance-inspector" class="finance-custodian"><div class="custodian-stage"><div class="custodian-artboard"><img class="custodian-character" src="assets/custodian.png" alt="Custodian — страж капитала" width="360" height="360"></div><div class="custodian-energy-coin" aria-hidden="true"><span class="custodian-coin-disc">NCD</span></div><div class="custodian-energy-pulse" aria-hidden="true"></div><span class="custodian-deposit-badge" role="status"></span><div class="custodian-energy-rays" aria-hidden="true"></div><p class="custodian-conversion-status" role="status"></p><figcaption class="custodian-caption">Custodian · Страж капитала</figcaption></div></figure><section class="custodian-savings savings-minimal" aria-label="Накоплено в подушке"><span class="savings-eyebrow">Моя подушка</span><div class="savings-balance" aria-live="polite">${format(safety.balance)}</div></section>`;
        } else if (this.currentView === 'case') {
            title = 'Case';
            body = `<div class="overview-number"><strong>${this.workspace?.portfolio?.length || 0}</strong><span>проектов в портфолио</span></div><p class="inspector-hint">Опишите направление работы, решённую задачу и результат. Готовый кейс можно скопировать для резюме.</p>`;
        } else if (this.currentView === 'learning') {
            title = 'Обучение';
            const workspace = this.workspace || {};
            const stats = window.LearningView?.summary(workspace) || {read:0,reading:0,topics:0,mastery:0};
            const count = stats.read, word = count % 10 === 1 && count % 100 !== 11 ? 'книга прочитана' : [2,3,4].includes(count % 10) && ![12,13,14].includes(count % 100) ? 'книги прочитаны' : 'книг прочитано';
            body = `<div class="learning-inspector-books"><span aria-hidden="true">▤</span><strong>${count}</strong><span>${word}</span></div><dl class="inspector-stats"><div><dt>Сейчас читаю</dt><dd>${stats.reading}</dd></div><div><dt>Активных тем</dt><dd>${stats.topics}</dd></div><div><dt>Среднее освоение</dt><dd>${stats.topics ? stats.mastery + '%' : '—'}</dd></div></dl><div class="overview-meter"><span style="width:${stats.mastery}%"></span></div><p class="inspector-hint">Уровень освоения — ваша оценка текущего навыка. Его можно менять по мере практики.</p>`;
        } else if (this.currentView === 'health') {
            title = 'Данные здоровья';
            body = '<div class="context-symbol">♡</div><h3>Личный мониторинг</h3><p class="inspector-hint">Шаги, пульс, сон и вес — из Android Health Connect.</p><div class="inspector-tip">Показатели доступны только при наличии источника данных. Информация о здоровье хранится локально.</div>';
        } else if (this.currentView === 'achievements') {
            title = 'Результаты';
            body = `<div class="overview-number"><strong>${this.getAchievementEntries().length}</strong><span>зафиксированных достижений</span></div><h3>Последние результаты</h3>${this.getAchievementEntries().sort((a,b) => String(b.date).localeCompare(String(a.date))).slice(0,4).map(item => `<div class="context-event"><time>${this.escapeHtml(item.date || '')}</time><span>${this.escapeHtml(item.title)}</span></div>`).join('') || '<p class="inspector-hint">Здесь появятся ваши результаты.</p>'}`;
        }
        if (this.currentView === 'finance' && host.querySelector('#finance-inspector') && host.querySelector('.savings-minimal')) {
            const amount = window.finance?.getSafetySummary?.()?.balance || 0;
            host.querySelector('.savings-balance').textContent = Number(amount).toLocaleString('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2});
            return;
        }
        host.innerHTML = `<div class="inspector-heading">${title}</div>${body}`;
        host.querySelectorAll('[data-inspect-goal]').forEach(button => button.addEventListener('click', () => this.openGoalDetail(button.dataset.inspectGoal)));
    }

    // ===== Achievements =====
    isGoalFinished(goal) {
        const steps = this.getSubgoalProgress(goal);
        return goal.status === 'completed' || (steps.total > 0 ? steps.completed === steps.total : typeof goal.progress === 'number' && goal.progress >= 100);
    }

    getAchievementEntries() {
        // Completion cards are derived from goals so sync/import and priority edits
        // route existing goals too, without creating duplicate stored achievements.
        const manual = this.achievements.filter(item => !item.autoCreated);
        const milestones = this.goals.filter(goal => this.isGoalFinished(goal) && goal.priority === 'milestone');
        return [...manual, ...milestones.map(goal => {
            const previous = this.achievements.find(item => item.autoCreated && item.goalId === goal.id);
            return { ...previous, id: previous?.id || goal.id, goalId: goal.id,
                title: `Завершена цель: ${goal.title}`, protected: true, autoCreated: true,
                date: previous?.date || goal.completedAt || goal.subgoals?.filter(step => step.completedAt).map(step => step.completedAt).sort().pop() || goal.createdAt };
        })];
    }

    renderAchievements() {
        const container = document.getElementById('achievementsList');
        const archive = this.achievementTab === 'archive';
        document.querySelectorAll('[data-achievement-tab]').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.achievementTab === (archive ? 'archive' : 'achievements')));
            button.onclick = () => { this.achievementTab = button.dataset.achievementTab; this.renderAchievements(); };
        });
        document.getElementById('addAchievementBtn').hidden = archive;
        if (archive) {
            const goals = this.goals.filter(goal => this.isGoalFinished(goal) && goal.priority !== 'milestone');
            container.innerHTML = goals.map(goal => `<button type="button" class="achievement-item-full archive-goal achievement-tier-${window.AchievementIcons?.tier(goal) || 1}" data-archive-goal="${this.escapeHtml(goal.id)}"><span class="achievement-icon achievement-icon-button">${window.getAchievementIcon?.(goal) || ''}</span><span class="achievement-info"><span class="achievement-title">${this.escapeHtml(goal.title)}</span><span class="achievement-goal">${this.escapeHtml(this.getPriorityLabel(goal.priority))} · 100%</span></span></button>`).join('') || this.renderEmptyState('📦', 'Архив пока пуст');
            container.querySelectorAll('[data-archive-goal]').forEach(button => button.onclick = () => this.openGoalDetail(button.dataset.archiveGoal));
            return;
        }
        const sorted = this.getAchievementEntries().sort((a, b) => new Date(b.date) - new Date(a.date));
        if (!sorted.length) { container.innerHTML = this.renderEmptyState('🏆', 'Пока нет достижений'); return; }

        container.innerHTML = sorted.map(a => {
            const goal = this.goals.find(g => g.id === a.goalId);
            return `
                <div class="achievement-item-full achievement-tier-${window.AchievementIcons?.tier(goal || a) || 1}">
                    <button type="button" class="achievement-icon achievement-icon-button" data-inspect-achievement="${this.escapeHtml(a.id)}" aria-label="Детали: ${this.escapeHtml(goal?.title || a.title)}">${window.getAchievementIcon?.(goal || a) || ''}</button>
                    <div class="achievement-info">
                        <div class="achievement-title">${a.protected ? '🔒' : ''} ${this.escapeHtml(a.title)}</div>
                        <div class="achievement-goal">${goal ? this.escapeHtml(goal.title) : 'Общее'}</div>
                        <div class="achievement-date">${new Date(a.date).toLocaleDateString('ru-RU')}</div>
                    </div>
                    <div class="achievement-actions">
                        ${a.autoCreated && goal ? `<button type="button" class="btn-icon" data-result-goal="${this.escapeHtml(goal.id)}" aria-label="Открыть цель">↗</button>` : ''}
                        ${!a.protected ? `
                            <button class="btn-icon btn-edit-achievement" data-id="${a.id}">✎</button>
                            <button class="btn-icon btn-delete-achievement" data-id="${a.id}">×</button>
                        ` : '<span class="protected-label">🔒 Защищено</span>'}
                    </div>
                </div>
            `;
        }).join('');

        container.querySelectorAll('[data-inspect-achievement]').forEach(button => button.onclick = () => this.openAchievementInspector(button.dataset.inspectAchievement));
        container.querySelectorAll('[data-result-goal]').forEach(button => button.onclick = () => this.openGoalDetail(button.dataset.resultGoal));
        container.querySelectorAll('.btn-edit-achievement').forEach(b => b.addEventListener('click', () => this.openAchievementModal(b.dataset.id)));
        container.querySelectorAll('.btn-delete-achievement').forEach(b => b.addEventListener('click', () => this.deleteAchievement(b.dataset.id)));
    }

    openAchievementInspector(id) {
        const archived = this.goals.find(item => item.id === id && this.isGoalFinished(item));
        const entry = this.getAchievementEntries().find(item => item.id === id) || (archived ? { goalId:archived.id, title:archived.title, date:archived.completedAt || archived.subgoals?.filter(step => step.completedAt).map(step => step.completedAt).sort().pop(), description:archived.description } : null);
        if (!entry) return;
        const goal = this.goals.find(item => item.id === entry.goalId);
        const dialog = document.getElementById('achievementInspector');
        const date = new Date(entry.date);
        const steps = Array.isArray(goal?.subgoals) ? goal.subgoals : [];
        document.getElementById('achievementInspectorTitle').textContent = goal?.title || entry.title;
        document.getElementById('achievementInspectorBody').innerHTML = `
            <p class="achievement-detail-date">Достигнуто: ${Number.isNaN(date.getTime()) ? 'Дата не указана' : this.escapeHtml(date.toLocaleDateString('ru-RU'))}</p>
            ${goal?.description || entry.description ? `<p class="achievement-detail-description">${this.escapeHtml(goal?.description || entry.description)}</p>` : ''}
            <h4>Пройденный путь</h4>
            ${steps.length ? `<ol class="achievement-journey">${steps.map(step => `<li><span>${this.escapeHtml(step.title)}</span><small>${step.completed ? 'Выполнено' : 'Не отмечено'}${step.completedAt ? ` · ${this.escapeHtml(new Date(step.completedAt).toLocaleDateString('ru-RU'))}` : ''}</small></li>`).join('')}</ol>` : '<p class="inspector-hint">Этапы этой цели не были записаны.</p>'}
            ${goal ? '<button type="button" class="btn btn-secondary" id="achievementOpenGoal">Открыть цель</button>' : ''}`;
        document.getElementById('closeAchievementInspector').onclick = () => dialog.close();
        dialog.onclick = event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } };
        if (goal) document.getElementById('achievementOpenGoal').onclick = () => { dialog.close(); this.openGoalDetail(goal.id); };
        if (!dialog.open) dialog.showModal();
    }

    // ===== Calendar =====
    calendarDateString(year, month, day) {
        return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    getCalendarActivities(dateStr) {
        const notes = this.getNotes(dateStr).map(note => ({ ...note, kind: 'note', title: note.content }));
        const events = this.events.filter(event => event.date === dateStr).map(event => ({ ...event, kind: 'event', title: event.title || event.content || event.name || 'Событие' }));
        const deadlines = this.goals.filter(goal => goal.deadline === dateStr).map(goal => ({ id: goal.id, kind: 'goal', title: goal.title, time: null }));
        return [...notes, ...events, ...deadlines].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    }

    renderCalendar() {
        const grid = document.getElementById('calendarGrid');
        const year = this.currentMonth.getFullYear(), month = this.currentMonth.getMonth();
        document.getElementById('currentMonth').textContent = new Date(year, month, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
        const today = new Date();
        const prefix = this.calendarDateString(year, month, 1).slice(0, 7);
        if (!this.selectedDate?.startsWith(prefix + '-')) {
            this.selectedDate = this.calendarDateString(year, month, today.getFullYear() === year && today.getMonth() === month ? today.getDate() : 1);
        }
        const todayString = this.calendarDateString(today.getFullYear(), today.getMonth(), today.getDate());
        const weekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (today.getDay() + 6) % 7);
        const weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7);
        const startDay = (new Date(year, month, 1).getDay() + 6) % 7;
        const days = new Date(year, month + 1, 0).getDate();
        let html = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(day => `<div class="calendar-day-header">${day}</div>`).join('');
        for (let cell = 0; cell < 42; cell++) {
            const day = cell - startDay + 1;
            const cellDate = new Date(year, month, day);
            const weekClass = cellDate >= weekStart && cellDate < weekEnd ? 'current-week' : '';
            if (day < 1 || day > days) {
                html += `<div class="calendar-day other-month ${weekClass}" aria-hidden="true"><span class="calendar-day-number">${new Date(year, month, day).getDate()}</span></div>`;
                continue;
            }
            const ds = this.calendarDateString(year, month, day);
            const activities = this.getCalendarActivities(ds);
            const label = new Date(year, month, day).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
            html += `<button type="button" class="calendar-day ${weekClass} ${ds === todayString ? 'today' : ''} ${ds === this.selectedDate ? 'selected' : ''} ${activities.length ? 'has-activity' : ''}" data-date="${ds}" aria-label="${label}${activities.length ? ', есть активности' : ''}" aria-pressed="${ds === this.selectedDate}" ${ds === todayString ? 'aria-current="date"' : ''}><span class="calendar-day-number">${day}</span>${activities.length ? `<span class="calendar-cell-events">${activities.slice(0, 2).map(item => `<span class="calendar-event-chip calendar-indicator ${item.kind === 'goal' ? 'goal-indicator' : item.kind === 'event' ? 'event-indicator' : 'note-indicator'} ${item.completed ? 'is-complete' : ''}" title="${this.escapeHtml(item.title).replace(/"/g, '&quot;')}">${item.time ? `<time>${this.escapeHtml(item.time)}</time>` : ''}<span>${this.escapeHtml(item.title)}</span></span>`).join('')}${activities.length > 2 ? `<span class="calendar-events-more">+${activities.length - 2} ещё</span>` : ''}</span>` : ''}</button>`;
        }
        grid.innerHTML = html;
        grid.querySelectorAll('button[data-date]').forEach(button => button.addEventListener('click', () => this.selectCalendarDate(button.dataset.date)));
        this.renderCalendarAgenda();
    }

    selectCalendarDate(dateStr) {
        this.selectedDate = dateStr;
        this.currentMonth = new Date(dateStr + 'T00:00:00');
        this.currentMonth.setDate(1);
        this.renderCalendar();
    }

    renderCalendarAgenda() {
        const container = document.getElementById('calendarDayEvents');
        document.getElementById('calendarSelectedDate').textContent = new Date(this.selectedDate + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'long' });
        const activities = this.getCalendarActivities(this.selectedDate);
        container.innerHTML = activities.length ? `<ul class="calendar-agenda-list">${activities.map((item, index) => `<li class="calendar-agenda-item ${item.completed ? 'is-complete' : ''}">${item.kind !== 'goal' ? `<input type="checkbox" class="calendar-complete" data-complete-calendar="${index}" aria-label="Выполнено: ${this.escapeHtml(item.title)}" ${item.completed ? 'checked' : ''}>` : ''}<time class="calendar-agenda-time">${item.time ? this.escapeHtml(item.time) : 'Без времени'}</time><div class="calendar-agenda-text"><span>${this.escapeHtml(item.title)}</span>${item.kind !== 'note' ? `<small>${item.kind === 'goal' ? 'Дедлайн цели' : 'Событие'}</small>` : ''}</div><div class="calendar-agenda-actions">${item.kind === 'note' ? `<button type="button" class="btn-icon" data-edit-calendar-note="${index}" aria-label="Редактировать запись">✎</button><button type="button" class="btn-icon" data-delete-calendar-note="${index}" aria-label="Удалить запись">×</button>` : item.kind === 'goal' ? `<button type="button" class="btn-icon" data-open-calendar-goal="${index}" aria-label="Открыть цель">↗</button>` : ''}</div></li>`).join('')}</ul>` : '<p class="calendar-agenda-empty">На этот день планов нет</p>';
        container.querySelectorAll('[data-complete-calendar]').forEach(checkbox => checkbox.addEventListener('change', () => this.toggleCalendarCompletion(activities[Number(checkbox.dataset.completeCalendar)], this.selectedDate, checkbox.checked)));
        container.querySelectorAll('[data-edit-calendar-note]').forEach(button => button.addEventListener('click', () => this.openNoteModal(this.selectedDate, activities[Number(button.dataset.editCalendarNote)].id)));
        container.querySelectorAll('[data-delete-calendar-note]').forEach(button => button.addEventListener('click', () => this.deleteNote(this.selectedDate, activities[Number(button.dataset.deleteCalendarNote)].id)));
        container.querySelectorAll('[data-open-calendar-goal]').forEach(button => button.addEventListener('click', () => this.openGoalDetail(activities[Number(button.dataset.openCalendarGoal)].id)));
    }

    async toggleCalendarCompletion(activity, date, completed) {
        if (this._calendarCompletionPending || !activity || activity.kind === 'goal') return false;
        const originalNotes = this.notes, originalEvents = this.events;
        const source = activity.kind === 'note' ? this.notes[date] : this.events;
        const original = source?.find(item => item.id === activity.id);
        if (!original || Boolean(original.completed) === Boolean(completed)) return false;
        this._calendarCompletionPending = true;
        const updated = { ...original, completed: Boolean(completed), completedAt: completed ? new Date().toISOString() : null };
        if (activity.kind === 'note') this.notes = { ...this.notes, [date]: source.map(item => item === original ? updated : item) };
        else this.events = this.events.map(item => item === original ? updated : item);
        try {
            if (await this.saveData() === false) throw new Error('Not saved');
            try { if (this.notificationManager) await this.notificationManager.scheduleCalendarEvent({ ...updated, date, title: updated.content || updated.title || updated.name }); }
            catch { this.showToast('Выполнение сохранено. Не удалось обновить системное напоминание.', 'info'); }
            return true;
        } catch {
            this.notes = originalNotes; this.events = originalEvents;
            this.showToast('Не удалось сохранить выполнение события.', 'error');
            return false;
        } finally {
            this._calendarCompletionPending = false;
            this.renderCalendarAgenda();
            if (document.getElementById('settingsModal')?.classList.contains('active')) this.updateSettingsProfile();
        this.renderInspectorOverview();
        }
    }

    openCalendarActivities() {
        const year = this.currentMonth.getFullYear(), month = this.currentMonth.getMonth();
        const activities = [];
        for (let day = 1; day <= new Date(year, month + 1, 0).getDate(); day++) {
            const date = this.calendarDateString(year, month, day);
            this.getCalendarActivities(date).forEach(item => activities.push({ ...item, date }));
        }
        document.getElementById('calendarActivitiesTitle').textContent = `Все активности · ${new Date(year, month, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}`;
        const container = document.getElementById('calendarMonthActivities');
        container.innerHTML = activities.length ? activities.map((item, index) => `<button type="button" class="calendar-month-activity" data-activity-index="${index}"><strong>${new Date(item.date + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}</strong><time>${this.escapeHtml(item.time || 'Без времени')}</time><span>${this.escapeHtml(item.title)}</span>${item.kind !== 'note' ? `<small>${item.kind === 'goal' ? 'Дедлайн цели' : 'Событие'}</small>` : ''}</button>`).join('') : '<p class="calendar-agenda-empty">В этом месяце активностей нет</p>';
        container.querySelectorAll('[data-activity-index]').forEach(button => button.addEventListener('click', () => {
            this.closeModal('calendarActivitiesModal');
            this.selectCalendarDate(activities[Number(button.dataset.activityIndex)].date);
            document.querySelector('#calendarGrid .selected')?.focus();
        }));
        document.getElementById('calendarActivitiesModal').classList.add('active');
        (container.querySelector('button') || document.getElementById('closeCalendarActivitiesModal')).focus();
    }

    changeMonth(delta) {
        this.currentMonth = new Date(this.currentMonth.getFullYear(), this.currentMonth.getMonth() + delta, 1);
        this.renderCalendar();
    }

    // ===== Notes =====
    // Нормализация: старый формат (одна заметка на день) → массив записей
    normalizeNotes(notes) {
        const out = {};
        for (const [ds, val] of Object.entries(notes || {})) {
            if (Array.isArray(val)) {
                const list = val.filter(n => n && typeof n.content === 'string' && n.content.trim())
                    .map(n => ({ id: n.id || this.generateId(), content: n.content.trim(), time: n.time || null, completed: n.completed === true, completedAt: typeof n.completedAt === 'string' ? n.completedAt : null, createdAt: n.createdAt || new Date().toISOString(), updatedAt: n.updatedAt || n.createdAt || new Date().toISOString() }));
                if (list.length) out[ds] = list;
            } else if (val && typeof val === 'object' && typeof val.content === 'string' && val.content.trim()) {
                out[ds] = [{
                    id: val.id || this.generateId(),
                    content: val.content.trim(),
                    time: val.time || null,
                    completed: val.completed === true, completedAt: typeof val.completedAt === 'string' ? val.completedAt : null,
                    createdAt: val.updatedAt || new Date().toISOString(),
                    updatedAt: val.updatedAt || new Date().toISOString()
                }];
            } else if (typeof val === 'string' && val.trim()) {
                out[ds] = [{ id: this.generateId(), content: val.trim(), time: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
            }
        }
        return out;
    }

    // Записи дня: без времени сверху (в порядке добавления), встречи по времени ниже
    getNotes(dateStr) {
        const list = this.notes[dateStr];
        if (!Array.isArray(list) || !list.length) return [];
        const untimed = list.filter(n => !n.time);
        const timed = list.filter(n => n.time).sort((a, b) => a.time.localeCompare(b.time));
        return [...untimed, ...timed];
    }

    openNoteModal(dateStr, noteId = null) {
        if (!this.mountFormView('noteModal')) return;
        this.selectedDate = dateStr;
        const form = document.getElementById('noteForm');
        const del = document.getElementById('deleteNoteBtn');
        const list = Array.isArray(this.notes[dateStr]) ? this.notes[dateStr] : [];
        const note = noteId ? list.find(n => n.id === noteId) : null;

        document.getElementById('noteDate').value = dateStr;
        document.getElementById('noteDateLabel').textContent =
            new Date(dateStr + 'T00:00:00').toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

        if (note) {
            document.getElementById('noteModalTitle').textContent = 'Редактировать запись';
            document.getElementById('noteId').value = note.id;
            document.getElementById('noteContent').value = note.content;
            document.getElementById('noteTime').value = note.time || '';
            del.style.display = 'inline-block';
        } else {
            document.getElementById('noteModalTitle').textContent = 'Новая запись';
            form.reset();
            document.getElementById('noteDate').value = dateStr;
            document.getElementById('noteId').value = '';
            del.style.display = 'none';
        }
        document.getElementById('noteModal').classList.add('active');
        setTimeout(() => document.getElementById('noteContent')?.focus(), 50);
    }

    saveNote(e) {
        e.preventDefault();
        const ds = document.getElementById('noteDate').value;
        const noteId = document.getElementById('noteId').value;
        const content = document.getElementById('noteContent').value.trim();
        const time = document.getElementById('noteTime').value || null;
        if (!content || !ds) return;

        if (!Array.isArray(this.notes[ds])) this.notes[ds] = [];
        const now = new Date().toISOString();

        let note;
        if (noteId) {
            note = this.notes[ds].find(n => n.id === noteId);
            if (note) { note.content = content; note.time = time; note.updatedAt = now; }
        } else {
            note = { id: this.generateId(), content, time, createdAt: now, updatedAt: now };
            this.notes[ds].push(note);
        }
        // чистим пустые дни
        this.notes[ds] = this.notes[ds].filter(n => n.content);
        if (!this.notes[ds].length) delete this.notes[ds];

        const saved = this.saveData(); this.closeModal('noteModal'); this.renderCalendar();
        this.showToast(noteId ? 'Запись обновлена!' : 'Запись добавлена!', 'success');
        
        // Перепланируем уведомление для этой заметки
        if (note) Promise.resolve(saved).then(ok => { if (ok !== false) return this.onNoteChanged(note, ds); }).catch(() => this.showToast('Не удалось обновить напоминание.', 'error'));
    }

    deleteNote(ds = document.getElementById('noteDate').value, noteId = document.getElementById('noteId').value) {
        if (!ds || !noteId || !Array.isArray(this.notes[ds])) return;
        if (!confirm('Удалить запись?')) return;
        this.onNoteDeleted(noteId);
        this.notes[ds] = this.notes[ds].filter(n => n.id !== noteId);
        if (!this.notes[ds].length) delete this.notes[ds];
        this.saveData(); this.closeModal('noteModal'); this.renderCalendar(); this.showToast('Удалено', 'success');
    }

    // Напоминание о встречах сегодня (при запуске)
    checkTodayNotes() {
        if (!this.settings.notifications) return;
        const ds = new Date().toISOString().split('T')[0];
        const nowHm = `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`;
        const upcoming = (Array.isArray(this.notes[ds]) ? this.notes[ds] : [])
            .filter(n => n.time && n.time >= nowHm)
            .sort((a, b) => a.time.localeCompare(b.time));
        if (!upcoming.length) return;
        const list = upcoming.slice(0, 3).map(n => `${n.time} — ${n.content}`).join('; ');
        const more = upcoming.length > 3 ? ` и ещё ${upcoming.length - 3}` : '';
        this.showNotification(`Сегодня ${upcoming.length} запис(и): ${list}${more}`);
    }

    // ===== Goal Modal =====
    openGoalModal(goalId = null, parentGoalId = null, subgoalId = null) {
        if (this._goalSaveInProgress || this._goalActionPending) return;
        const parentGoal = parentGoalId ? this.goals.find(goal => goal.id === parentGoalId) : null;
        if (parentGoalId && !parentGoal) return;
        const subgoal = subgoalId ? parentGoal?.subgoals?.find(item => item.id === subgoalId) : null;
        if (subgoalId && !subgoal) return;
        const goal = subgoal || (goalId ? this.goals.find(item => item.id === goalId) : null);
        if (goalId && !goal) return;
        if (!this.mountFormView('goalModal')) return;

        const form = document.getElementById('goalForm');
        const priority = document.getElementById('goalPriority');
        priority.closest('.form-group').hidden = !!parentGoal;
        priority.querySelectorAll('[data-legacy-priority]').forEach(option => option.remove());
        form.reset();
        this._goalAttachmentDraft = this.getSubgoalAttachments(subgoal).map(attachment => ({ attachment }));
        document.getElementById('goalAttachmentFields').hidden = !parentGoal;
        this.renderGoalAttachmentDraft();
        delete form.dataset.initialCategory;
        form.dataset.parentGoal = parentGoal?.id || '';
        form.dataset.subgoalId = subgoal?.id || '';
        const error = document.getElementById('goalFormError');
        error.textContent = ''; error.hidden = true;
        const context = document.getElementById('goalParentContext');
        context.textContent = parentGoal ? `Для цели «${parentGoal.title}»` : '';
        context.hidden = !parentGoal;
        document.getElementById('goalId').value = subgoal ? '' : goal?.id || '';
        document.getElementById('goalModalTitle').textContent = subgoal ? 'Редактировать подцель' : goal ? 'Редактировать цель' : parentGoal ? 'Новая подцель' : 'Новая цель';
        this.setupSubgoalTypeFields(parentGoal, subgoal);

        if (goal) {
            document.getElementById('goalTitle').value = goal.title;
            document.getElementById('goalDescription').value = goal.description || '';
            // Existing critical goals remain editable without silently losing their priority.
            if (goal.priority === 'critical') {
                const legacy = document.createElement('option');
                legacy.value = 'critical';
                legacy.textContent = 'Критический (сохранённый)';
                legacy.dataset.legacyPriority = 'true';
                priority.appendChild(legacy);
            }
            priority.value = ['low', 'medium', 'high', 'milestone', 'critical'].includes(goal.priority) ? goal.priority : 'medium';
        }
        window.GoalMilestone?.bind(priority.value === 'milestone', !!parentGoal);
        document.getElementById('goalModal').classList.add('active');
        document.getElementById('goalTitle').focus({ preventScroll: true });
    }

    setupSubgoalTypeFields(parentGoal, subgoal) {
        const group = document.getElementById('subgoalKindGroup');
        const rhythmFields = document.getElementById('subgoalRhythmFields');
        if (!group) return;
        group.hidden = !parentGoal;
        if (!parentGoal) {
            rhythmFields.hidden = true;
            document.getElementById('subgoalBalanceFields')?.remove();
            document.getElementById('goalSubgoalKind').value = 'checkbox';
            document.getElementById('goalSubgoalPeriod').value = 'week';
            return;
        }
        const kind = this.getSubgoalKind(subgoal);
        const period = this.getRhythmPeriod(subgoal);
        group.querySelectorAll('[data-subgoal-kind]').forEach(button => {
            button.onclick = () => this.setSubgoalKind(button.dataset.subgoalKind);
        });
        rhythmFields.querySelectorAll('[data-subgoal-period]').forEach(button => {
            button.onclick = () => this.setSubgoalPeriod(button.dataset.subgoalPeriod);
        });
        this.setSubgoalKind(kind);
        this.setSubgoalPeriod(period);
        if (kind === 'balance') {
            const target = Number(subgoal?.targetAmount);
            document.getElementById('goalTargetAmount').value = Number.isFinite(target) && target > 0 ? String(target) : '10000';
        }
    }

    ensureSubgoalBalanceField() {
        let group = document.getElementById('subgoalBalanceFields');
        if (!group) {
            group = document.createElement('div');
            group.id = 'subgoalBalanceFields';
            group.className = 'form-group subgoal-balance-fields';
            group.innerHTML = '<label for="goalTargetAmount">Целевая сумма, ₽</label><input type="number" id="goalTargetAmount" min="1" step="1" inputmode="numeric" placeholder="10 000">';
            document.getElementById('subgoalRhythmFields').insertAdjacentElement('afterend', group);
        }
        return group;
    }

    setSubgoalKind(kind) {
        kind = ['rhythm', 'balance'].includes(kind) ? kind : 'checkbox';
        document.getElementById('goalSubgoalKind').value = kind;
        document.querySelectorAll('[data-subgoal-kind]').forEach(button => {
            const active = button.dataset.subgoalKind === kind;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-checked', String(active));
        });
        document.getElementById('subgoalRhythmFields').hidden = kind !== 'rhythm';
        const balance = kind === 'balance' ? this.ensureSubgoalBalanceField() : document.getElementById('subgoalBalanceFields');
        if (balance) balance.hidden = kind !== 'balance';
        if (kind === 'balance' && !document.getElementById('goalTargetAmount').value) document.getElementById('goalTargetAmount').value = '10000';
    }

    setSubgoalPeriod(period) {
        period = period === 'month' ? 'month' : 'week';
        document.getElementById('goalSubgoalPeriod').value = period;
        document.querySelectorAll('[data-subgoal-period]').forEach(button => {
            const active = button.dataset.subgoalPeriod === period;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-checked', String(active));
        });
    }

    async saveGoal(e) {
        e.preventDefault();
        const modal = document.getElementById('goalModal');
        if (this._goalSaveInProgress || this._goalActionPending || !modal?.classList.contains('active')) return false;
        const form = document.getElementById('goalForm');
        const errorElement = document.getElementById('goalFormError');
        const showError = message => {
            errorElement.textContent = message;
            errorElement.hidden = false;
        };
        errorElement.hidden = true;
        const id = document.getElementById('goalId').value;
        const existing = id ? this.goals.find(goal => goal.id === id) : null;
        const parentGoalId = form.dataset.parentGoal || null;
        const parentGoal = parentGoalId ? this.goals.find(goal => goal.id === parentGoalId) : null;
        const subgoalId = form.dataset.subgoalId || null;
        const existingSubgoal = subgoalId ? parentGoal?.subgoals?.find(item => item.id === subgoalId) : null;
        if ((id && !existing) || (parentGoalId && !parentGoal) || (subgoalId && !existingSubgoal)) {
            showError('Цель больше не найдена. Закройте форму и откройте её заново.');
            return false;
        }
        const title = document.getElementById('goalTitle').value.trim();
        if (!title) {
            showError('Введите название цели.');
            document.getElementById('goalTitle').focus();
            return false;
        }
        const selectedPriority = parentGoal
            ? (existingSubgoal?.priority || document.getElementById('goalPriority').value || 'medium')
            : document.getElementById('goalPriority').value;
        const priority = ['low', 'medium', 'high', 'milestone'].includes(selectedPriority)
            ? selectedPriority
            : (existingSubgoal || existing)?.priority === 'critical' && selectedPriority === 'critical' ? 'critical' : 'medium';
        const subgoalKind = parentGoal ? document.getElementById('goalSubgoalKind').value : 'checkbox';
        const subgoalPeriod = document.getElementById('goalSubgoalPeriod').value === 'month' ? 'month' : 'week';
        const targetAmount = parentGoal && subgoalKind === 'balance'
            ? Number(document.getElementById('goalTargetAmount')?.value)
            : 0;
        if (parentGoal && subgoalKind === 'balance' && (!Number.isFinite(targetAmount) || targetAmount <= 0)) {
            showError('Укажите целевую сумму больше нуля.');
            document.getElementById('goalTargetAmount')?.focus();
            return false;
        }
        const applySubgoalKind = (item, previous) => {
            item.kind = ['rhythm', 'balance'].includes(subgoalKind) ? subgoalKind : 'checkbox';
            if (item.kind === 'rhythm') {
                item.period = subgoalPeriod;
                item.checkins = Array.isArray(previous?.checkins) ? [...previous.checkins] : this.getRhythmCheckins(item);
            } else if (item.kind === 'balance') {
                item.targetAmount = targetAmount;
                item.currentAmount = Number(previous?.currentAmount) || Number(item.currentAmount) || 0;
            }
            return item;
        };
        const editable = {
            title,
            description: document.getElementById('goalDescription').value.trim(),
            priority
        };
        const controls = [...form.querySelectorAll('input, textarea, select, button'), document.getElementById('closeGoalModal')];
        const disabledBefore = controls.map(control => control.disabled);
        const saveButton = form.querySelector('[type="submit"]');
        const saveLabel = saveButton.textContent;
        const previousGoals = this.goals;
        const previousDirty = this._dirty;
        let pendingGoals;
        let goal;
        const uploaded = [];
        this._goalSaveInProgress = true;
        controls.forEach(control => { control.disabled = true; });
        saveButton.textContent = 'Сохранение…';
        form.setAttribute('aria-busy', 'true');
        try {
            if (existing) {
                goal = { ...existing, ...editable };
                pendingGoals = this.goals.map(item => item === existing ? goal : item);
            } else if (existingSubgoal) {
                goal = applySubgoalKind({ ...existingSubgoal, ...editable }, existingSubgoal);
                const updatedParent = { ...parentGoal, subgoals: parentGoal.subgoals.map(item => item === existingSubgoal ? goal : item) };
                pendingGoals = this.goals.map(item => item === parentGoal ? updatedParent : item);
            } else {
                goal = {
                    ...editable,
                    id: this.generateId(),
                    category: parentGoal?.category || form.dataset.initialCategory || 'personal',
                    deadline: null,
                    parentId: parentGoalId,
                    tags: [],
                    status: 'active',
                    createdAt: new Date().toISOString(),
                    subgoals: []
                };
                if (parentGoal) {
                    // Keep the existing nested subgoal model; no duplicate root goal.
                    applySubgoalKind(goal);
                    goal.completed = goal.kind === 'balance' && targetAmount > 0 && Number(goal.currentAmount) >= targetAmount;
                    const updatedParent = { ...parentGoal, subgoals: [...(parentGoal.subgoals || []), goal] };
                    pendingGoals = this.goals.map(item => item === parentGoal ? updatedParent : item);
                } else {
                    pendingGoals = [...this.goals, goal];
                }
            }
            if (parentGoal) {
                const attachments = [];
                for (const item of this._goalAttachmentDraft || []) {
                    if (item.file) {
                        const prepared = await this.prepareSubgoalAttachment(item.file, parentGoalId, goal.id);
                        if (prepared.path) uploaded.push(prepared);
                        attachments.push(prepared.attachment);
                    } else attachments.push(item.attachment);
                }
                uploaded.forEach(item => item.context.assertOwner());
                goal.attachments = attachments;
                delete goal.files;
            }
            this.goals = pendingGoals;
            const saved = await this.saveData({ deferAutoSync: true });
            if (saved !== true) throw new Error('Profile persistence did not succeed');
        } catch (error) {
            if (this.goals === pendingGoals) this.goals = previousGoals;
            this._dirty = previousDirty;
            for (const item of uploaded) {
                try { item.context.assertOwner(); await item.context.storage.remove([item.path]); } catch { /* Metadata was not saved; keep draft available for retry. */ }
            }
            showError(error.attachmentError ? error.message : 'Не удалось сохранить цель. Данные не добавлены. Проверьте доступ к хранилищу и повторите попытку.');
            return false;
        } finally {
            this._goalSaveInProgress = false;
            controls.forEach((control, index) => { control.disabled = disabledBefore[index]; });
            saveButton.textContent = saveLabel;
            form.removeAttribute('aria-busy');
        }
        // End the draft before starting sync, which defers incoming data while editing.
        // Closing still follows durable persistence and does not depend on cloud access.
        this.closeModal('goalModal');
        const cloudWrite = window.CloudSync?.pushGoals?.(parentGoal ? pendingGoals.find(item => item.id === parentGoalId) : goal);
        this.showToast(existingSubgoal ? 'Подцель сохранена!' : parentGoal ? 'Подцель добавлена!' : 'Цель сохранена!', 'success');
        if (cloudWrite && typeof cloudWrite.then === 'function') cloudWrite.then(ok => {
            if (ok) this.showToast('Сохранено в облако', 'success');
        }).catch(() => {});
        try {
            this.render();
            if (parentGoal) this.openGoalDetail(parentGoalId);
        } catch (error) {
            console.warn('[goals] Saved, but view refresh failed:', error);
            this.showToast('Цель сохранена. Откройте раздел заново, чтобы обновить экран.', 'warning');
        }
        try {
            if (!existing && !parentGoal) this.onNewGoal();
        } catch (error) {
            console.warn('[goals] Optional reward failed after saving:', error);
        }
        try {
            this.scheduleAutoSync();
            if (!parentGoal) await this.onGoalChanged(goal);
        } catch (error) {
            console.warn('[goals] Saved; background notification or sync failed:', error);
        }
        return true;
    }

    renderSubgoalItem(goalId, step) {
        const kind = this.getSubgoalKind(step);
        if (kind === 'rhythm') return this.renderRhythmSubgoal(step);
        if (kind === 'balance') return this.renderBalanceSubgoal(step);
        return `<div class="subgoal-item ${step.completed ? 'is-complete' : ''}" data-kind="checkbox" role="listitem">
            <div class="subgoal-body"><label class="subgoal-main">
                <input type="checkbox" class="subgoal-checkbox" data-sid="${step.id}" ${step.completed ? 'checked' : ''}>
                <span class="subgoal-title ${step.completed ? 'completed' : ''}">${this.escapeHtml(step.title)}</span>
            </label>
            ${this.renderSubgoalFiles(step)}</div>
            ${this.renderSubgoalActions(step)}
        </div>`;
    }

    renderSubgoalActions(step) {
        return `<div class="subgoal-actions">
            <button type="button" class="btn-icon attachment-add" data-sid="${step.id}" aria-label="Прикрепить файл" title="Прикрепить файл">+</button>
            <button type="button" class="btn-icon btn-edit-subgoal" data-sid="${step.id}" aria-label="Редактировать подцель" title="Редактировать подцель">✎</button>
            <button type="button" class="btn-icon btn-delete-subgoal" data-sid="${step.id}" aria-label="Удалить подцель" title="Удалить подцель">×</button>
        </div>`;
    }

    renderSubgoalFiles(step, minimalist = false) {
        const files = this.getSubgoalAttachments(step);
        if (!files.length) return '<div class="subgoal-files"></div>';
        const markup = files.map((file, index) => {
            const image = /^image\//.test(file.type || '') || /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(file.name);
            const icon = minimalist ? '' : image ? '🖼️ ' : '📄 ';
            return `<span class="subgoal-file"><button type="button" class="attachment-open" data-sid="${step.id}" data-index="${index}">${icon}${this.escapeHtml(file.name)}</button><button type="button" class="attachment-delete" data-sid="${step.id}" data-index="${index}" aria-label="Удалить файл ${this.escapeHtml(file.name)}">×</button></span>`;
        }).join('');
        return `<div class="subgoal-files${minimalist ? ' is-plain' : ''}">${markup}</div>`;
    }

    renderRhythmSubgoal(step) {
        const stats = this.getRhythmStats(step);
        const leading = stats.period === 'month' ? stats.leading : 0;
        const empty = Array.from({ length: leading }, () => '<span class="rhythm-cell is-empty" aria-hidden="true"></span>').join('');
        const cells = stats.days.map(day => {
            const classes = ['rhythm-cell'];
            if (day.done) classes.push('is-done');
            if (day.missed) classes.push('is-missed');
            if (day.today) classes.push('is-today', 'is-active');
            if (day.future) classes.push('is-future');
            if (day.today && stats.beforeSix) classes.push('is-asleep');
            const state = day.done ? 'выполнено' : day.missed ? 'пропущено' : day.today ? 'сегодня' : '';
            const inner = stats.period === 'week'
                ? `<span class="rhythm-weekday">${day.weekday}</span><span class="rhythm-day">${day.day}</span>`
                : `<span class="rhythm-day">${day.day}</span>`;
            return `<button type="button" class="${classes.join(' ')}" data-sid="${step.id}" data-date="${day.date}" aria-label="${day.aria}${state ? `: ${state}` : ''}" aria-pressed="${day.done}"${day.today ? '' : ' disabled'}>${inner}</button>`;
        }).join('');
        const weekdays = stats.period === 'month'
            ? '<div class="rhythm-weekdays" aria-hidden="true"><span>Пн</span><span>Вт</span><span>Ср</span><span>Чт</span><span>Пт</span><span>Сб</span><span>Вс</span></div>'
            : '';
        return `<div class="subgoal-item subgoal-rhythm is-${stats.status.state}" data-kind="rhythm" role="listitem">
            <div class="subgoal-body">
                <div class="subgoal-main subgoal-main-static">
                    <span class="subgoal-title">${this.escapeHtml(step.title)}</span>
                </div>
                <div class="rhythm-module is-${stats.period}" data-sid="${step.id}">
                    <div class="rhythm-head">
                        <span class="rhythm-period">${stats.period === 'month' ? 'Месяц' : 'Неделя'} · ${stats.periodLabel}</span>
                        <span class="rhythm-status is-${stats.status.state}" role="status">${stats.status.label}</span>
                    </div>
                    ${weekdays}
                    <div class="rhythm-grid is-${stats.period}" role="group" aria-label="Ритм: ${this.escapeHtml(step.title)}">${empty}${cells}</div>
                    <div class="rhythm-foot">
                        <span class="rhythm-score"><strong>${stats.completed}/${stats.total}</strong> дней выполнено</span>
                        <span class="rhythm-streak">Серия · ${stats.streak}</span>
                        <button type="button" class="btn btn-secondary rhythm-mark-btn${stats.doneToday ? ' is-done' : ''}" data-sid="${step.id}" aria-pressed="${stats.doneToday}" title="${stats.doneToday ? 'Снять отметку за сегодня' : 'Зачесть сегодняшний день'}">${stats.doneToday ? 'День зачтён' : 'Зачесть день'}</button>
                    </div>
                    ${this.renderSubgoalFiles(step, true)}
                </div>
            </div>
            ${this.renderSubgoalActions(step)}
        </div>`;
    }

    renderBalanceSubgoal(step) {
        const stats = this.getBalanceStats(step);
        const fillClass = stats.percent >= 100 ? 'complete' : stats.percent >= 60 ? 'high' : stats.percent >= 30 ? 'medium' : 'low';
        return `<div class="subgoal-item subgoal-balance${stats.reached ? ' is-reached' : ''}" data-kind="balance" role="listitem">
            <div class="subgoal-body">
                <div class="subgoal-main subgoal-main-static">
                    <span class="subgoal-title">${this.escapeHtml(step.title)}</span>
                    <span class="balance-status">${stats.reached ? 'Собрано' : 'Накоплено'}</span>
                </div>
                <div class="balance-module" data-sid="${step.id}">
                    <div class="balance-figures"><strong>${this.formatAmount(stats.current)} / ${this.formatAmount(stats.target)} ₽</strong><span class="balance-percent">${stats.percent}%</span></div>
                    <div class="progress-bar balance-progress" role="progressbar" aria-label="Собрано по подцели ${this.escapeHtml(step.title)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${stats.percent}"><div class="progress-fill ${fillClass}" style="width:${stats.percent}%"></div></div>
                    <div class="balance-actions">
                        <input type="number" class="balance-input" data-sid="${step.id}" min="1" step="1" inputmode="numeric" placeholder="Сумма" aria-label="Сумма пополнения для ${this.escapeHtml(step.title)}">
                        <button type="button" class="btn btn-secondary balance-topup" data-sid="${step.id}">+ Пополнить</button>
                    </div>
                    ${this.renderSubgoalFiles(step, true)}
                </div>
            </div>
            ${this.renderSubgoalActions(step)}
        </div>`;
    }

    // ===== Goal Detail =====
    // Subgoal controls are shared by the inline accordion body and the detail modal.
    bindSubgoalControls(root, goalId) {
        root.querySelectorAll('.attachment-add').forEach(button => button.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.hidden = true;
            document.body.append(input);
            input.addEventListener('change', () => { const file = input.files?.[0]; input.remove(); if (file) this.changeSubgoalAttachment(goalId, button.dataset.sid, file); }, { once: true });
            input.addEventListener('cancel', () => input.remove(), { once: true });
            input.click();
        }));
        root.querySelectorAll('.attachment-delete').forEach(button => button.addEventListener('click', () => this.changeSubgoalAttachment(goalId, button.dataset.sid, null, Number(button.dataset.index))));
        root.querySelectorAll('.attachment-open').forEach(button => button.addEventListener('click', () => {
            const step = this.goals.find(item => item.id === goalId)?.subgoals?.find(item => item.id === button.dataset.sid);
            const file = this.getSubgoalAttachments(step)[Number(button.dataset.index)];
            if (file) this.openGoalAttachment(file);
        }));
        root.querySelectorAll('.subgoal-checkbox').forEach(cb => cb.addEventListener('change', (e) => this.toggleSubgoal(goalId, e.target.dataset.sid, e.target.checked)));
        root.querySelectorAll('.rhythm-cell[data-date]').forEach(cell => cell.addEventListener('click', () => {
            if (!cell.disabled) this.toggleRhythmDay(goalId, cell.dataset.sid, cell.dataset.date);
        }));
        root.querySelectorAll('.rhythm-mark-btn').forEach(button => button.addEventListener('click', () => this.toggleRhythmDay(goalId, button.dataset.sid)));
        root.querySelectorAll('.balance-topup').forEach(button => button.addEventListener('click', () => {
            const input = button.closest('.balance-actions')?.querySelector('.balance-input');
            this.topUpBalance(goalId, button.dataset.sid, input?.value);
        }));
        root.querySelectorAll('.balance-input').forEach(input => input.addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            this.topUpBalance(goalId, input.dataset.sid, input.value);
        }));
        root.querySelectorAll('.btn-edit-subgoal').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); this.editSubgoal(goalId, b.dataset.sid); }));
        root.querySelectorAll('.btn-delete-subgoal').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); this.deleteSubgoal(goalId, b.dataset.sid); }));
    }

    openGoalDetail(goalId) {
        const goal = this.goals.find(g => g.id === goalId);
        if (!goal) return;
        const content = document.getElementById('goalDetailContent');
        const sameGoal = content.dataset.goalId === String(goalId);
        const wasOpen = document.getElementById('goalDetailModal').classList.contains('active');
        const previousProgress = sameGoal ? Number(content.querySelector('[data-goal-progress]')?.textContent.replace('%', '') || 0) : 0;
        const panel = document.getElementById('infoPanel');
        const previousScroll = panel?.scrollTop || 0;
        content.dataset.goalId = String(goalId);
        document.getElementById('detailGoalTitle').textContent = goal.title;
        document.getElementById('deleteGoalHeaderBtn').onclick = () => this.deleteGoal(goalId);

        const progress = this.calculateProgress(goal);
        const subgoals = Array.isArray(goal.subgoals) ? goal.subgoals : [];
        const steps = this.getSubgoalProgress(goal);
        const hasStructuredSteps = subgoals.some(step => this.getSubgoalKind(step) !== 'checkbox');
        const subgoalCountLabel = hasStructuredSteps
            ? `${steps.completed} из ${steps.total} · ${steps.percent}%`
            : `${steps.completed} из ${steps.total} выполнено`;
        const achievements = this.achievements.filter(a => a.goalId === goalId);

        content.innerHTML = `
            <div class="detail-meta">
                <span class="detail-meta-item">${this.getCategoryLabel(goal.category)}</span>
                <span class="detail-meta-item"><span class="priority-badge ${this.getPriorityClass(goal.priority)}">${this.getPriorityLabel(goal.priority)}</span></span>
                ${goal.deadline ? `<span class="detail-meta-item">${new Date(goal.deadline).toLocaleDateString('ru-RU')}</span>` : ''}
                ${goal.tags?.length ? `<span class="detail-meta-item">${goal.tags.map(tag => this.escapeHtml(tag)).join(', ')}</span>` : ''}
            </div>
            ${goal.description ? `<div class="detail-section"><p>${this.escapeHtml(goal.description)}</p></div>` : ''}
            <div class="detail-section goal-progress-section">
                <h4>Прогресс цели</h4>
                <div class="inspector-progress-chart"><svg class="progress-ring" viewBox="0 0 100 100" aria-hidden="true"><circle class="ring-track" cx="50" cy="50" r="41"/><circle class="ring-value" cx="50" cy="50" r="41" pathLength="100" stroke-dasharray="${progress} 100"/></svg><div class="ring-label"><strong>${progress}%</strong><span>выполнено</span></div></div>
                <div class="progress-bar" role="progressbar" aria-label="Общий прогресс цели" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><div class="progress-fill ${progress>=100?'complete':progress>=60?'high':progress>=30?'medium':'low'}" style="width:${progress}%"></div></div>
                <div class="progress-text"><span>${steps.total ? "По выполненным подцелям" : "Выполнено"}</span><strong data-goal-progress>${progress}%</strong></div>
            </div>
            <section class="detail-section subgoals-section" aria-labelledby="subgoalsHeading">
                <div class="subgoals-header">
                    <h4 id="subgoalsHeading">Подцели</h4>
                    ${steps.total ? `<span class="subgoals-count" aria-live="polite">${subgoalCountLabel}</span>` : ''}
                </div>
                ${subgoals.length ? `<div class="subgoals-list" role="list">
                    ${subgoals.map(step => this.renderSubgoalItem(goalId, step)).join('')}
                </div>` : `<div class="subgoals-empty"><p>Разбей цель на шаги — добавь первую подцель</p><button type="button" class="btn btn-secondary" data-add-subgoal>+ Подцель</button></div>`}
            </section>
            <section class="detail-section inspector-files"><h4>Прикреплённые файлы</h4><div class="inspector-file-list">${subgoals.flatMap(step => this.getSubgoalAttachments(step).map((file, index) => `<button type="button" class="attachment-open inspector-file" data-sid="${step.id}" data-index="${index}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9"/></svg><span>${this.escapeHtml(file.name)}<small>${this.escapeHtml(step.title)}</small></span><span aria-hidden="true">↗</span></button>`)).join('') || '<p class="inspector-hint">Файлы подцелей появятся здесь.<br>Нажмите + у нужного шага, чтобы прикрепить файл.</p>'}</div></section>
            <div class="detail-section goal-achievements-section">
                <h4>Достижения (${achievements.length})</h4>
                <div class="achievements-list">
                    ${achievements.length ? achievements.map(a => `
                        <div class="achievement-item">
                            <span class="achievement-icon"></span>
                            <div class="achievement-info">
                                <div class="achievement-title">${a.protected?'🔒':''} ${this.escapeHtml(a.title)}</div>
                                <div class="achievement-date">${new Date(a.date).toLocaleDateString('ru-RU')}</div>
                            </div>
                            <div class="achievement-actions">
                                ${!a.protected ? `<button class="btn-icon btn-edit-achievement" data-id="${a.id}">✎</button><button class="btn-icon btn-delete-achievement" data-id="${a.id}">×</button>` : ''}
                            </div>
                        </div>
                    `).join('') : '<p style="color:var(--text-secondary)">Нет достижений</p>'}
                </div>
            </div>
            <div class="modal-actions">
                <button class="btn btn-danger" id="deleteGoalBtn">Удалить</button>
                <button class="btn btn-secondary" id="editGoalBtn">Редактировать</button>
                <button class="btn btn-primary" id="addSubgoalBtn">+ Подцель</button>
                <button class="btn btn-primary" id="completeGoalBtn">${this.isGoalFinished(goal)?'Вернуть':'Завершить'}</button>
            </div>
        `;

        content.prepend(content.querySelector('.modal-actions'));

        document.getElementById('editGoalBtn').addEventListener('click', () => { this.closeModal('goalDetailModal'); this.openGoalModal(goalId); });
        document.getElementById('addSubgoalBtn').addEventListener('click', () => this.addSubgoal(goalId));
        content.querySelectorAll('[data-add-subgoal]').forEach(button => button.addEventListener('click', () => this.addSubgoal(goalId)));
        document.getElementById('completeGoalBtn').addEventListener('click', () => this.toggleGoalStatus(goalId));
        document.getElementById('deleteGoalBtn').addEventListener('click', () => this.deleteGoal(goalId));

        this.bindSubgoalControls(content, goalId);
        content.querySelectorAll('.btn-edit-achievement').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); this.editAchievement(b.dataset.id); }));
        content.querySelectorAll('.btn-delete-achievement').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); this.deleteAchievement(b.dataset.id); }));

        document.getElementById('goalDetailModal').classList.add('active');
        document.querySelectorAll('.goal-item').forEach(row => row.classList.toggle('selected', row.dataset.id === goalId));
        this.animateInspectorProgress(content, previousProgress, progress);
        if (sameGoal && panel) panel.scrollTop = previousScroll;
        if ((!sameGoal || !wasOpen) && window.matchMedia?.('(max-width: 768px)').matches) {
            const active = document.activeElement;
            // Focus returns to the accordion header when the modal was opened from a list row.
            this._goalDetailOpener = (active?.closest ? active.closest('.goal-row')?.querySelector('.goal-item') : null) || active;
            document.getElementById('closeDetailModal').focus({ preventScroll: true });
        } else if (!sameGoal && window.matchMedia?.('(max-width: 1000px)').matches) panel?.scrollIntoView?.({ block:'start', behavior:'smooth' });
    }

    animateInspectorProgress(content, from, to) {
        if (this._inspectorProgressFrame) window.cancelAnimationFrame?.(this._inspectorProgressFrame);
        const ring = content.querySelector('.ring-value');
        const fill = content.querySelector('.goal-progress-section .progress-fill');
        const labels = content.querySelectorAll('.ring-label strong, [data-goal-progress]');
        const paint = value => {
            ring?.setAttribute('stroke-dasharray', `${value} 100`);
            if (fill) fill.style.width = `${value}%`;
            labels.forEach(label => { label.textContent = `${Math.round(value)}%`; });
        };
        const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
        if (!window.requestAnimationFrame || reducedMotion || from === to) { paint(to); return; }
        paint(from);
        let start;
        const tick = now => {
            if (!ring?.isConnected) return;
            start ??= now;
            const elapsed = Math.min(1, (now - start) / 650);
            paint(from + (to - from) * (1 - Math.pow(1 - elapsed, 3)));
            if (elapsed < 1) this._inspectorProgressFrame = window.requestAnimationFrame(tick);
            else this._inspectorProgressFrame = null;
        };
        this._inspectorProgressFrame = window.requestAnimationFrame(tick);
    }

    renderGoalAttachmentDraft() {
        const list = document.getElementById('goalAttachmentList');
        list.replaceChildren();
        (this._goalAttachmentDraft || []).forEach((item, index) => {
            const file = item.file || item.attachment;
            const row = document.createElement('div'); row.className = 'goal-attachment-row';
            const name = document.createElement('button'); name.type = 'button'; name.dataset.openDraft = index;
            name.className = 'attachment-open';
            const size = file.size >= 1024 * 1024 ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil((file.size || 0) / 1024)} KB`;
            name.textContent = `${/^image\//.test(file.type || '') ? '🖼️' : '📄'} ${file.name} (${size})`;
            const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.removeDraft = index;
            remove.className = 'attachment-delete'; remove.textContent = '×'; remove.setAttribute('aria-label', `Убрать ${file.name}`);
            row.append(name, remove); list.append(row);
        });
    }

    async prepareSubgoalAttachment(file, goalId, sid) {
        const fail = message => { const error = new Error(message); error.attachmentError = true; throw error; };
        if (file.size > 10 * 1024 * 1024) fail('Максимальный размер файла — 10 МБ.');
        const ext = file.name.split('.').pop().toLowerCase();
        if (!/^image\//.test(file.type || '') && !['png','jpg','jpeg','gif','webp','avif','bmp','svg','pdf','doc','docx','txt'].includes(ext)) fail('Выберите изображение, PDF, DOC, DOCX или TXT.');
        const type = file.type || ({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif',bmp:'image/bmp',svg:'image/svg+xml',pdf:'application/pdf',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',txt:'text/plain'}[ext]) || 'application/octet-stream';
        let context;
        if (navigator.onLine !== false) { try { context = window.CloudSync?.attachmentStorage(); } catch { /* Offline fallback. */ } }
        if (context) {
            const safeName = file.name.normalize('NFKD').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-140) || 'file';
            const path = `${context.userId}/${goalId}/${sid}/${this.generateId()}-${safeName}`;
            let result;
            try { result = await context.storage.upload(path, file, { upsert: false }); } catch { result = { error: true }; }
            if (!result.error) {
                try {
                    context.assertOwner();
                    return { context, path, attachment: { name: file.name, size: file.size, type, url: context.storage.getPublicUrl(path).data.publicUrl } };
                } catch { fail('Аккаунт изменился во время загрузки. Откройте форму заново.'); }
            }
        }
        if (file.size > 3 * 1024 * 1024) fail('Без доступного облачного хранилища можно прикрепить файл до 3 МБ.');
        const data = await new Promise((resolve, reject) => {
            const reader = new FileReader(); reader.onload = () => resolve(reader.result);
            reader.onerror = reader.onabort = () => { const error = new Error('Не удалось прочитать файл.'); error.attachmentError = true; reject(error); };
            reader.readAsDataURL(file);
        });
        return { attachment: { name: file.name, size: file.size, type, data: `data:${type};base64,${String(data).split(',')[1]}` } };
    }

    getSubgoalAttachments(step) {
        // Read legacy files as well; migrate the edited subgoal on its next attachment save.
        const all = [...(Array.isArray(step?.attachments) ? step.attachments : []), ...(Array.isArray(step?.files) ? step.files : [])];
        return all.filter(file => file && typeof file.name === 'string' && typeof (file.url || file.data) === 'string')
            .map(file => file.url ? file : Object.defineProperty({ ...file }, 'url', { value: file.data, enumerable: false }))
            .filter((file, index, files) => files.findIndex(item => item.url === file.url) === index);
    }

    openGoalAttachment(file) {
        file = { ...file, url: file.url || file.data };
        let url;
        try { url = new URL(file.url); } catch { return; }
        const inline = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([a-z0-9+/]*={0,2})$/i.exec(file.url);
        if (url.protocol !== 'https:' && !inline) return;
        const imageFile = inline ? /^image\/(png|jpeg|gif|webp|avif|bmp)$/i.test(inline[1]) : /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(file.name);
        if (!imageFile) {
            if (!inline) { window.open(url.href, '_blank', 'noopener,noreferrer'); return; }
            // Download inline documents as binary, never execute HTML/SVG from attachments.
            const bytes = Uint8Array.from(atob(inline[2]), char => char.charCodeAt(0));
            const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
            const link = document.createElement('a');
            link.href = blobUrl; link.download = file.name; document.body.append(link); link.click(); link.remove();
            setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
            return;
        }
        const dialog = document.createElement('dialog');
        dialog.className = 'attachment-preview';
        dialog.setAttribute('aria-label', file.name);
        const close = document.createElement('button');
        close.textContent = 'Закрыть'; close.className = 'btn btn-secondary';
        const image = document.createElement('img'); image.src = url.href; image.alt = file.name;
        dialog.append(close, image); document.body.append(dialog);
        close.onclick = () => dialog.close();
        dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
        dialog.addEventListener('close', () => dialog.remove());
        dialog.showModal(); close.focus();
    }

    async changeSubgoalAttachment(goalId, sid, file, index) {
        if (this._attachmentPending || this._goalActionPending || this._goalSaveInProgress) return false;
        const step = this.goals.find(goal => goal.id === goalId)?.subgoals?.find(item => item.id === sid);
        const removed = this.getSubgoalAttachments(step)[index];
        if (!step || (!file && !removed)) return false;
        let context, uploadedPath, deletePath, persisted = false, inlineSaved = false, uploadFailed = false;
        const buttons = [...document.querySelectorAll('.attachment-add, .attachment-delete')];
        const before = buttons.map(button => [button, button.disabled, button.textContent]);
        this._attachmentPending = true;
        buttons.forEach(button => { button.disabled = true; if (button.classList.contains('attachment-add') && button.dataset.sid === sid) { button.textContent = '⏳'; button.setAttribute('aria-busy', 'true'); } });
        try {
            if (navigator.onLine !== false) {
                try { context = window.CloudSync?.attachmentStorage(); } catch { /* Local fallback until cloud storage is available. */ }
            }
            let attachment;
            if (file) {
                const prepared = await this.prepareSubgoalAttachment(file, goalId, sid);
                attachment = prepared.attachment;
                if (prepared.path) { context = prepared.context; uploadedPath = prepared.path; }
                else { inlineSaved = true; uploadFailed = Boolean(context); }
            } else if (context && removed.url.startsWith('https:')) {
                const prefix = `${context.userId}/${goalId}/${sid}/`;
                const url = new URL(removed.url);
                const base = new URL(context.storage.getPublicUrl(prefix + 'check').data.publicUrl);
                const storagePath = decodeURIComponent(url.pathname.split('/storage/v1/object/public/goal-attachments/')[1] || '');
                if (url.origin === base.origin && storagePath.startsWith(prefix) && !storagePath.slice(prefix.length).includes('/')) deletePath = storagePath;
            }
            if (uploadedPath) context.assertOwner();
            const goal = this.goals.find(item => item.id === goalId);
            const current = goal?.subgoals?.find(item => item.id === sid);
            if (!current) throw new Error('Подцель больше не существует.');
            const attachments = file ? [...this.getSubgoalAttachments(current), attachment] : this.getSubgoalAttachments(current).filter(item => item.url !== removed.url);
            const { files: legacyFiles, ...currentFields } = current;
            const next = { ...goal, subgoals: goal.subgoals.map(item => item === current ? { ...currentFields, attachments } : item) };
            if (!await this.persistGoalAction(this.goals.map(item => item === goal ? next : item))) throw new Error('Не удалось сохранить список файлов. Повторите операцию.');
            persisted = true;
            // Delete the object only after the durable metadata update succeeds.
            if (deletePath) {
                try { context.assertOwner(); const result = await context.storage.remove([deletePath]); if (result.error) throw result.error; }
                catch { this.showToast('Вложение убрано из подцели. Очистить файл в облаке пока не удалось.', 'info'); }
            }
        } catch (error) {
            if (uploadedPath && !persisted) {
                try { const result = await context.storage.remove([uploadedPath]); if (result.error) throw result.error; }
                catch { this.showToast('Не удалось убрать незавершённую загрузку из Storage.', 'error'); }
            }
            this.showToast(error.message || 'Не удалось изменить вложение.', 'error');
        } finally {
            this._attachmentPending = false;
            before.forEach(([button, disabled, text]) => { button.disabled = disabled; button.textContent = text; button.removeAttribute('aria-busy'); });
        }
        if (persisted) {
            if (document.getElementById('goalDetailModal').classList.contains('active')) this.openGoalDetail(goalId);
            this.render();
            let synced = false;
            try { await window.CloudSync?.pushGoals?.(); synced = await window.CloudSync?.sync?.(); } catch { /* Durable local metadata will retry with normal synchronization. */ }
            this.showToast(inlineSaved ? (uploadFailed ? 'Загрузка в Storage не удалась. Файл сохранён на устройстве.' : 'Файл сохранён на устройстве.') : synced ? 'Вложение сохранено в облаке.' : 'Список вложений сохранён на устройстве. Облачная синхронизация ещё не завершена.', synced ? 'success' : 'info');
        }
        return persisted;
    }

    addSubgoal(goalId) {
        if (this._goalSaveInProgress || this._goalActionPending || !this.goals.some(goal => goal.id === goalId)) return;
        this.closeModal('goalDetailModal');
        this.openGoalModal(null, goalId);
    }

    editSubgoal(goalId, sid) {
        if (this._goalSaveInProgress || this._goalActionPending) return;
        if (!this.goals.find(goal => goal.id === goalId)?.subgoals?.some(step => step.id === sid)) return;
        this.closeModal('goalDetailModal');
        this.openGoalModal(null, goalId, sid);
    }

    // Inline accordion actions redraw only what is actually visible: the open modal and the list.
    refreshGoalDetail(goalId) {
        const active = document.activeElement;
        const rowId = active?.closest?.('.goal-row')?.dataset?.id || null;
        if (document.getElementById('goalDetailModal')?.classList.contains('active')) this.openGoalDetail(goalId);
        this.render();
        if (rowId) document.querySelector(`.goal-row[data-id="${rowId}"] .goal-item`)?.focus({ preventScroll: true });
    }

    async persistGoalAction(nextGoals, nextAchievements = this.achievements) {
        if (this._goalActionPending || this._goalSaveInProgress) return false;
        const previousGoals = this.goals;
        const previousAchievements = this.achievements;
        const previousDirty = this._dirty;
        const content = document.getElementById('goalDetailContent');
        const inline = document.getElementById('goalsList');
        const controls = [
            ...content.querySelectorAll('input, button'),
            ...(inline ? inline.querySelectorAll('.goal-item-body input, .goal-item-body button') : []),
            document.getElementById('closeDetailModal')
        ];
        const disabledBefore = controls.map(control => control.disabled);
        this._goalActionPending = true;
        controls.forEach(control => { control.disabled = true; });
        content.setAttribute('aria-busy', 'true');
        inline?.setAttribute('aria-busy', 'true');
        this.goals = nextGoals;
        this.achievements = nextAchievements;
        try {
            if (await this.saveData({ deferAutoSync: true }) !== true) throw new Error('Goal action not persisted');
        } catch (error) {
            console.error('[goals.persist] Failed to save goal action:', error);
            if (this.goals === nextGoals) this.goals = previousGoals;
            if (this.achievements === nextAchievements) this.achievements = previousAchievements;
            this._dirty = previousDirty;
            this.showToast('Изменения не сохранены. Проверьте хранилище и повторите попытку.', 'error');
            return false;
        } finally {
            this._goalActionPending = false;
            controls.forEach((control, index) => { control.disabled = disabledBefore[index]; });
            content.removeAttribute('aria-busy');
            inline?.removeAttribute('aria-busy');
        }
        try { this.scheduleAutoSync(); } catch (error) { console.warn('[goals] Sync deferred:', error); }
        const changedGoal = nextGoals.find(goal => previousGoals.find(previous => previous.id === goal.id) !== goal);
        if (changedGoal) {
            const cloudWrite = window.CloudSync?.pushGoals?.(changedGoal);
            if (cloudWrite && typeof cloudWrite.then === 'function') cloudWrite.then(ok => {
                if (ok) this.showToast('Прогресс сохранён в облако', 'success');
            }).catch(() => {});
        }
        return true;
    }

    async deleteSubgoal(goalId, sid) {
        if (this._goalActionPending || this._goalSaveInProgress) return false;
        const goal = this.goals.find(item => item.id === goalId);
        if (!goal?.subgoals?.some(step => step.id === sid) || !confirm('Удалить подцель?')) return false;
        const next = { ...goal, subgoals: goal.subgoals.filter(step => step.id !== sid) };
        const saved = await this.persistGoalAction(this.goals.map(item => item === goal ? next : item));
        this.refreshGoalDetail(goalId);
        return saved;
    }

    async animateGoalCompletion(goalId, sid = null) {
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
        const cards = [...document.querySelectorAll('.goal-item')].filter(item => item.dataset.id === goalId);
        const step = sid ? [...document.querySelectorAll('#goalDetailContent .subgoal-checkbox, #goalsList .subgoal-checkbox')].find(item => item.dataset.sid === sid)?.closest('.subgoal-item') : null;
        const targets = (sid ? [step] : [...cards, document.getElementById('goalDetailContent')]).filter(item => item?.getClientRects().length);
        if (!targets.length) return;
        this._goalActionPending = true;
        const controls = targets.flatMap(item => [...item.querySelectorAll('input, button')]);
        const previous = controls.map(item => item.disabled);
        controls.forEach(item => { item.disabled = true; });
        targets.forEach(item => item.classList.add('completion-feedback'));
        const title = sid ? null : document.getElementById('detailGoalTitle');
        title?.classList.add('completion-title');
        try { await new Promise(resolve => setTimeout(resolve, 440)); }
        finally {
            targets.forEach(item => item.classList.remove('completion-feedback'));
            title?.classList.remove('completion-title');
            controls.forEach((item, index) => { item.disabled = previous[index]; });
            this._goalActionPending = false;
        }
    }

    // ===== Subgoal types: rhythm and balance =====
    getSubgoalKind(step) {
        const kind = typeof step?.kind === 'string' ? step.kind : step?.subgoalType;
        return kind === 'rhythm' || kind === 'balance' ? kind : 'checkbox';
    }

    getRhythmPeriod(step) {
        return step?.period === 'month' ? 'month' : 'week';
    }

    getRhythmCheckins(step) {
        const source = Array.isArray(step?.checkins)
            ? step.checkins
            : Array.isArray(step?.rhythm?.checkins) ? step.rhythm.checkins : [];
        return [...new Set(source.filter(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)))].sort();
    }

    getRhythmNow() {
        return this._rhythmNow instanceof Date ? this._rhythmNow : new Date();
    }

    getLocalDateKey(value = new Date()) {
        const date = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    parseLocalDateKey(value) {
        const [year, month, day] = String(value || '').split('-').map(Number);
        if (!year || !month || !day) return null;
        return new Date(year, month - 1, day);
    }

    getRhythmClock(now = this.getRhythmNow()) {
        let real = now instanceof Date ? new Date(now.getTime()) : new Date(now);
        if (Number.isNaN(real.getTime())) real = new Date();
        const beforeSix = real.getHours() < 6;
        const logical = new Date(real.getFullYear(), real.getMonth(), real.getDate());
        // A day runs from 06:00 to 06:00; before dawn the previous day is still active.
        if (beforeSix) logical.setDate(logical.getDate() - 1);
        return { now: real, beforeSix, logical, today: this.getLocalDateKey(logical) };
    }

    getRhythmClockKey(now = this.getRhythmNow()) {
        const clock = this.getRhythmClock(now);
        return `${clock.today}|${clock.beforeSix ? 'sleep' : 'day'}`;
    }

    initRhythmClock() {
        if (this._rhythmClockTimer || typeof setTimeout !== 'function') return;
        const refresh = () => {
            const key = this.getRhythmClockKey();
            if (this._rhythmClockKey === key) return;
            const hadKey = Boolean(this._rhythmClockKey);
            this._rhythmClockKey = key;
            if (!hadKey) return;
            try { this.render(); } catch { /* Startup render owns the first paint. */ }
            const detail = document.getElementById('goalDetailContent');
            const goalId = detail?.dataset.goalId;
            if (goalId && document.getElementById('goalDetailModal')?.classList.contains('active')) {
                try { this.openGoalDetail(goalId); } catch { /* Keep the current detail visible. */ }
            }
        };
        refresh();
        const schedule = () => {
            const now = new Date();
            const six = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 0, 0, 0);
            if (six <= now) six.setDate(six.getDate() + 1);
            const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
            const delay = Math.max(1000, Math.min(six - now, midnight - now) + 1000);
            this._rhythmClockTimer = setTimeout(() => {
                this._rhythmClockTimer = null;
                refresh();
                schedule();
            }, delay);
        };
        schedule();
        document.addEventListener?.('visibilitychange', () => {
            if (document.visibilityState === 'visible') refresh();
        });
    }

    getRhythmStats(step, now = this.getRhythmNow()) {
        const clock = this.getRhythmClock(now);
        const period = this.getRhythmPeriod(step);
        const base = this.parseLocalDateKey(clock.today) || new Date();
        let dates = [];
        let leading = 0;
        if (period === 'month') {
            const first = new Date(base.getFullYear(), base.getMonth(), 1);
            leading = (first.getDay() + 6) % 7;
            const total = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
            for (let day = 1; day <= total; day++) dates.push(new Date(base.getFullYear(), base.getMonth(), day));
        } else {
            const start = new Date(base.getFullYear(), base.getMonth(), base.getDate() - (base.getDay() + 6) % 7);
            for (let index = 0; index < 7; index++) {
                const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
                dates.push(day);
            }
        }
        const checkins = new Set(this.getRhythmCheckins(step));
        const weekdayNames = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
        const days = dates.map(date => {
            const key = this.getLocalDateKey(date);
            const done = checkins.has(key);
            return {
                date: key,
                day: date.getDate(),
                weekday: weekdayNames[date.getDay()],
                aria: date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }),
                done,
                today: key === clock.today,
                missed: key < clock.today && !done,
                future: key > clock.today
            };
        });
        const total = days.length;
        const completed = days.filter(day => day.done).length;
        const percent = total ? Math.round(completed / total * 100) : 0;
        const doneToday = checkins.has(clock.today);
        const status = clock.beforeSix
            ? { state: 'asleep', label: 'Отдых до 06:00' }
            : doneToday ? { state: 'done', label: 'День зачтён' }
                : { state: 'waiting', label: 'Ждёт отметки' };
        const start = dates[0], end = dates[dates.length - 1];
        const periodLabel = period === 'month'
            ? this.capitalize(base.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }))
            : start && end && start.getMonth() === end.getMonth()
                ? `${start.getDate()}–${end.getDate()} ${end.toLocaleDateString('ru-RU', { month: 'short' })}`
                : `${start.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}`;
        return {
            period, periodLabel, leading, days, total, completed, percent,
            doneToday, beforeSix: clock.beforeSix, today: clock.today, status,
            streak: this.getRhythmStreak(checkins, clock.today)
        };
    }

    getRhythmStreak(checkins, today) {
        const cursor = this.parseLocalDateKey(today);
        if (!cursor) return 0;
        if (!checkins.has(today)) cursor.setDate(cursor.getDate() - 1);
        let streak = 0;
        while (checkins.has(this.getLocalDateKey(cursor)) && streak < 3660) {
            streak++;
            cursor.setDate(cursor.getDate() - 1);
        }
        return streak;
    }

    getGoalRhythmStatus(goal, now = this.getRhythmNow()) {
        const rhythms = (goal?.subgoals || []).filter(step => this.getSubgoalKind(step) === 'rhythm');
        if (!rhythms.length) return null;
        const stats = rhythms.map(step => this.getRhythmStats(step, now));
        if (stats.some(item => item.status.state === 'waiting')) return { state: 'waiting', label: 'Ждёт отметки' };
        if (stats.some(item => item.status.state === 'done')) return { state: 'done', label: 'День зачтён' };
        return { state: 'asleep', label: 'Отдых до 06:00' };
    }

    getBalanceStats(step) {
        const target = Math.max(0, Number(step?.targetAmount) || 0);
        const current = Math.max(0, Number(step?.currentAmount) || 0);
        const percent = target > 0 ? Math.min(100, Math.round(current / target * 100)) : 0;
        return { target, current, percent, reached: target > 0 && current >= target };
    }

    getSubgoalFraction(step) {
        const kind = this.getSubgoalKind(step);
        if (kind === 'rhythm') {
            const stats = this.getRhythmStats(step);
            return stats.total ? stats.completed / stats.total : 0;
        }
        if (kind === 'balance') {
            const stats = this.getBalanceStats(step);
            return stats.target > 0 ? Math.min(1, stats.current / stats.target) : 0;
        }
        return step?.completed ? 1 : 0;
    }

    formatAmount(value) {
        const amount = Number(value);
        return Number.isFinite(amount) ? Math.round(amount).toLocaleString('ru-RU') : '0';
    }

    capitalize(value) {
        const text = String(value || '');
        return text ? text[0].toLocaleUpperCase('ru-RU') + text.slice(1) : text;
    }

    async toggleRhythmDay(goalId, sid, date = null) {
        if (this._goalActionPending || this._goalSaveInProgress) return false;
        const goal = this.goals.find(item => item.id === goalId);
        const step = goal?.subgoals?.find(item => item.id === sid);
        if (!step || this.getSubgoalKind(step) !== 'rhythm') return false;
        const clock = this.getRhythmClock();
        const target = date || clock.today;
        if (target !== clock.today) return false;
        const checkins = new Set(this.getRhythmCheckins(step));
        const had = checkins.has(target);
        if (had) checkins.delete(target); else checkins.add(target);
        const nextStep = { ...step, checkins: [...checkins].sort() };
        const next = { ...goal, subgoals: goal.subgoals.map(item => item === step ? nextStep : item) };
        const saved = await this.persistGoalAction(this.goals.map(item => item === goal ? next : item));
        if (saved) {
            this.refreshGoalDetail(goalId);
            this.showToast(had ? 'Отметка снята' : 'День зачтён', had ? 'info' : 'success');
        }
        return saved;
    }

    async topUpBalance(goalId, sid, rawAmount) {
        if (this._goalActionPending || this._goalSaveInProgress) return false;
        const goal = this.goals.find(item => item.id === goalId);
        const step = goal?.subgoals?.find(item => item.id === sid);
        if (!step || this.getSubgoalKind(step) !== 'balance') return false;
        const amount = Number(String(rawAmount ?? '').replace(/\s/g, '').replace(',', '.'));
        if (!Number.isFinite(amount) || amount <= 0) {
            this.showToast('Введите сумму больше нуля', 'warning');
            return false;
        }
        const target = Math.max(0, Number(step.targetAmount) || 0);
        const current = Math.max(0, Number(step.currentAmount) || 0);
        const nextStep = { ...step, currentAmount: current + amount, completed: target > 0 && current + amount >= target };
        const next = { ...goal, subgoals: goal.subgoals.map(item => item === step ? nextStep : item) };
        const saved = await this.persistGoalAction(this.goals.map(item => item === goal ? next : item));
        if (saved) {
            this.refreshGoalDetail(goalId);
            this.showToast(`Добавлено ${this.formatAmount(amount)} ₽`, 'success');
            if (target > 0 && current < target && current + amount >= target) {
                try { this.onSubgoalComplete(); } catch (error) { console.warn('[goals] Optional balance reward failed:', error); }
            }
        }
        return saved;
    }

    async toggleSubgoal(goalId, sid, completed) {
        if (this._goalActionPending || this._goalSaveInProgress) return false;
        const goal = this.goals.find(item => item.id === goalId);
        const subgoal = goal?.subgoals?.find(step => step.id === sid);
        if (!subgoal || Boolean(subgoal.completed) === Boolean(completed)) return false;
        const next = { ...goal, subgoals: goal.subgoals.map(step => step === subgoal ? { ...step, completed: Boolean(completed), completedAt: completed ? new Date().toISOString() : null } : step) };
        const saved = await this.persistGoalAction(this.goals.map(item => item === goal ? next : item));
        if (saved && completed) await this.animateGoalCompletion(goalId, sid);
        // Refresh the open modal as well as the underlying card/dashboard.
        this.refreshGoalDetail(goalId);
        if (saved && completed) {
            try { this.onSubgoalComplete(); } catch (error) { console.warn('[goals] Optional subgoal reward failed:', error); }
        }
        return saved;
    }

    async toggleGoalStatus(goalId) {
        if (this._goalActionPending || this._goalSaveInProgress) return false;
        const goal = this.goals.find(item => item.id === goalId);
        if (!goal) return false;
        const finished = this.isGoalFinished(goal);
        const next = { ...goal, status: finished ? 'active' : 'completed', completedAt: finished ? null : new Date().toISOString(), progress: finished ? 0 : 100,
            ...(finished && this.getSubgoalProgress(goal).total > 0 && this.getSubgoalProgress(goal).completed === this.getSubgoalProgress(goal).total ? { subgoals: (goal.subgoals || []).map(step => ({ ...step, completed: false, completedAt: null })) } : {}) };
        const achievements = next.status === 'completed' && next.priority === 'milestone' ? [...this.achievements.filter(item => !(item.autoCreated && item.goalId === goal.id)), {
            id: this.generateId(), goalId: goal.id,
            title: `Завершена цель: ${goal.title}`, description: goal.description || '',
            date: new Date().toISOString().split('T')[0], progress: 100,
            protected: true, autoCreated: true, createdAt: new Date().toISOString()
        }] : this.achievements.filter(item => !(item.autoCreated && item.goalId === goal.id));
        if (!await this.persistGoalAction(this.goals.map(item => item === goal ? next : item), achievements)) return false;
        if (!finished) await this.animateGoalCompletion(goalId);
        await this.onGoalChanged(next);
        this.closeModal('goalDetailModal'); this.render();
        if (next.status === 'completed') {
            try { this.onGoalComplete(next); this.onAchievementCreated(); } catch (error) { console.warn('[goals] Optional completion reward failed:', error); }
        }
        this.showToast(next.status === 'completed' ? 'Цель завершена! 🎉' : 'Цель возвращена', 'success');
        return true;
    }

    openGoalContextMenu(goalId, x, y, opener) {
        this._closeGoalContextMenu?.();
        const menu = document.createElement('div');
        menu.className = 'goal-context-menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', 'Действия с целью');
        menu.innerHTML = '<button type="button" role="menuitem">✏️ Редактировать</button><button type="button" role="menuitem" class="goal-delete-action">🗑️ Удалить цель</button>';
        const close = () => {
            menu.remove();
            document.removeEventListener('pointerdown', outside, true);
            document.removeEventListener('keydown', keydown);
            window.removeEventListener('resize', close);
            window.removeEventListener('scroll', close, true);
            this._closeGoalContextMenu = null;
        };
        const outside = event => { if (!menu.contains(event.target)) close(); };
        const keydown = event => {
            if (event.key === 'Escape') { event.preventDefault(); close(); opener?.focus(); }
            if (event.key === 'Tab') close();
            if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
                event.preventDefault();
                const buttons = [...menu.querySelectorAll('button')];
                buttons[(buttons.indexOf(document.activeElement) + 1) % buttons.length].focus();
            }
        };
        menu.children[0].onclick = () => { close(); this.closeModal('goalDetailModal'); this.openGoalModal(goalId); };
        menu.children[1].onclick = () => { close(); this.deleteGoal(goalId); };
        document.body.append(menu);
        menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - menu.offsetWidth))}px`;
        menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - menu.offsetHeight))}px`;
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('keydown', keydown);
        window.addEventListener('resize', close);
        window.addEventListener('scroll', close, true);
        this._closeGoalContextMenu = close;
        menu.children[0].focus();
    }

    deleteGoal(goalId) {
        if (this._goalActionPending || this._goalSaveInProgress) return;
        const goal = this.goals.find(item => String(item.id) === String(goalId));
        goalId = goal?.id;
        if (!goal) return;
        this._closeGoalContextMenu?.();
        const modal = document.getElementById('deleteGoalModal');
        const confirmButton = document.getElementById('confirmDeleteGoalBtn');
        document.getElementById('deleteGoalMessage').textContent = `Вы уверены, что хотите удалить цель «${goal.title}»?`;
        const opener = document.activeElement;
        const cancel = () => { this.closeModal('deleteGoalModal'); opener?.isConnected && opener.focus(); };
        document.getElementById('cancelDeleteGoalBtn').onclick = cancel;
        modal.querySelector('.modal-overlay').onclick = cancel;
        confirmButton.onclick = async () => {
            if (this._goalActionPending || this._goalSaveInProgress) return;
            if (!this.goals.some(item => item.id === goalId)) { cancel(); return; }
            confirmButton.disabled = true;
            const nextGoals = this.goals.filter(item => item.id !== goalId)
                .map(item => item.parentId === goalId ? { ...item, parentId: null } : item);
            try {
                if (!await this.persistGoalAction(nextGoals, this.achievements.filter(item => item.goalId !== goalId))) return;
                this.closeModal('deleteGoalModal');
                this.closeModal('goalDetailModal');
                const content = document.getElementById('goalDetailContent');
                content.replaceChildren();
                delete content.dataset.goalId;
                document.getElementById('detailGoalTitle').textContent = 'Детали цели';
                document.getElementById('deleteGoalHeaderBtn').onclick = null;
                this.render();
                this.showToast('Цель удалена', 'success');
                await this.onGoalDeleted(goalId);
            } catch (error) {
                console.error('[goals.delete] Failed to delete goal', { goalId, error });
                this.showToast('Не удалось удалить цель. Повторите попытку.', 'error');
            } finally { confirmButton.disabled = false; }
        };
        modal.classList.add('active');
        document.getElementById('cancelDeleteGoalBtn').focus();
    }

    // ===== Achievement Modal =====
    openAchievementModal(achievementId = null) {
        if (!this.mountFormView('achievementModal')) return;
        const goalSel = document.getElementById('achievementGoal');
        goalSel.innerHTML = this.goals.map(g => `<option value="${g.id}">${this.escapeHtml(g.title)}</option>`).join('');

        if (achievementId) {
            const a = this.achievements.find(x => x.id === achievementId);
            if (a) {
                document.getElementById('achievementId').value = a.id;
                document.getElementById('achievementGoal').value = a.goalId;
                document.getElementById('achievementTitle').value = a.title;
                document.getElementById('achievementDescription').value = a.description || '';
                document.getElementById('achievementDate').value = a.date;
                document.getElementById('achievementProgress').value = a.progress || 0;
                document.getElementById('achievementProtected').checked = a.protected || false;
            }
        } else {
            document.getElementById('achievementForm').reset();
            document.getElementById('achievementId').value = '';
            document.getElementById('achievementDate').value = new Date().toISOString().split('T')[0];
        }
        document.getElementById('achievementModal').classList.add('active');
    }

    saveAchievement(e) {
        e.preventDefault();
        const id = document.getElementById('achievementId').value;
        const data = {
            goalId: document.getElementById('achievementGoal').value,
            title: document.getElementById('achievementTitle').value.trim(),
            description: document.getElementById('achievementDescription').value.trim(),
            date: document.getElementById('achievementDate').value,
            progress: parseInt(document.getElementById('achievementProgress').value) || 0,
            protected: document.getElementById('achievementProtected').checked
        };
        if (id) { const i = this.achievements.findIndex(a => a.id === id); if (i !== -1) this.achievements[i] = { ...this.achievements[i], ...data }; }
        else {
            data.id = this.generateId(); data.createdAt = new Date().toISOString();
            this.achievements.push(data); this.onAchievementCreated();
        }
        this.saveData(); this.closeModal('achievementModal'); this.render(); this.showToast('Сохранено! 🏆', 'success');
    }

    editAchievement(id) { this.closeModal('goalDetailModal'); this.openAchievementModal(id); }

    deleteAchievement(id) {
        const a = this.achievements.find(x => x.id === id);
        if (!a) return;
        if (a.protected) { this.showToast('Защищённое достижение!', 'error'); return; }
        if (!confirm('Удалить достижение?')) return;
        this.achievements = this.achievements.filter(x => x.id !== id);
        this.saveData(); this.render(); this.showToast('Удалено', 'success');
    }

    // ===== Settings =====
    openSettingsModal() {
        if (document.getElementById('settingsModal').classList.contains('active')) return;
        this.cancelSettingsLoad();
        this._settingsController = new AbortController();
        this.renderProfile({ rebuild:true });
        this.notificationManager?.updateSettingsUI();
        document.getElementById('notificationsEnabled').checked = this.settings.notifications;
        document.getElementById('calendarRemindersEnabled').checked = this.settings.calendarReminders;
        document.getElementById('notificationSoundEnabled').checked = this.settings.notificationSound;
        document.getElementById('notificationVibrationEnabled').checked = this.settings.notificationVibration;
        
        const group = document.getElementById('notificationSettingsGroup');
        if (group) group.style.display = this.settings.notifications ? 'block' : 'none';
        
        window.CloudSync?.refresh?.();
        document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === this.settings.theme));
        document.getElementById('settingsModal').classList.add('active');
    }

    cancelSettingsLoad() {
        this._settingsController?.abort();
        clearTimeout(this._settingsRetryTimer);
        this._settingsTagVersion = (this._settingsTagVersion || 0) + 1;
        this.settingsLoading = false;
    }

    // ===== Theme =====
    initTheme() {
        // Тёмная тема по умолчанию, если в localStorage ничего нет
        let saved = null;
        try { saved = localStorage.getItem('theme'); } catch {}
        const theme = saved || this.settings.theme || 'dark';
        this.setTheme(theme);
    }

    setTheme(theme) {
        if (!['dark', 'light', 'auto'].includes(theme)) theme = 'dark';
        this.settings.theme = theme;
        let effective = theme;
        if (theme === 'auto') {
            effective = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }
        document.documentElement.setAttribute('data-theme', effective);
        document.documentElement.style.colorScheme = effective;
        document.body.classList.toggle('light-theme', effective === 'light');
        for (const id of ['themeBtn', 'mobileThemeBtn']) {
            const button = document.getElementById(id);
            if (!button) continue;
            button.setAttribute('aria-pressed', String(effective === 'light'));
            button.setAttribute('aria-label', effective === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему');
            button.title = button.getAttribute('aria-label');
        }
        try { localStorage.setItem('theme', theme); } catch {}
        const themeBtn = document.getElementById('themeBtn');
        if (themeBtn) themeBtn.textContent = effective === 'dark' ? '🌙' : '☀️';
        const mobileThemeBtn = document.getElementById('mobileThemeBtn');
        if (mobileThemeBtn) mobileThemeBtn.textContent = effective === 'dark' ? '🌙' : '☀️';
        window.CloudSync?.refresh?.();
        document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
        this.saveData();
    }

    toggleTheme() {
        const cur = document.documentElement.getAttribute('data-theme') || this.settings.theme;
        this.setTheme(cur === 'dark' ? 'light' : 'dark');
    }

    // ===== Gamification Engine Delegation =====
    addXP(amount, source = '') {
        if (!this.gamificationEngine) return;
        const oldLevel = this.gamificationEngine.state.level;
        const result = this.gamificationEngine.addXp(amount, source);
        const newLevel = this.gamificationEngine.state.level;
        if (newLevel > oldLevel) {
            this.showLevelUpModal(oldLevel, newLevel);
        }
        return result;
    }



    updateStreak() {
        if (!this.gamificationEngine) return;
        this.gamificationEngine.updateStreak();
    }

    checkBadges() {
        if (!this.gamificationEngine) return;
        this.gamificationEngine.checkBadges();
    }

    hasBadge(id) {
        if (!this.gamificationEngine) return false;
        return this.gamificationEngine.hasBadge(id);
    }

    // Goal integration
    onGoalComplete(goal) {
        if (!this.gamificationEngine) return;
        this.gamificationEngine.onGoalComplete?.(goal);
    }

    onSubgoalComplete() {
        if (!this.gamificationEngine) return;
        this.gamificationEngine.onSubgoalComplete?.();
    }

    onNewGoal() {
        if (!this.gamificationEngine) return;
        this.gamificationEngine.onNewGoal?.();
    }

    onAchievementCreated() {
        if (!this.gamificationEngine) return;
        this.gamificationEngine.onAchievementCreated?.();
    }

    // ===== New Gamification UI =====
    // Level Up Modal
    showLevelUpModal() {
        // Legacy rewards remain in saved data, without RPG interface overlays.
    }

    getLevelUpMessage(level) {
        const messages = {
            2: 'Первые шаги пройдены! 🎯',
            3: 'Ты набираешь обороты! 🚀',
            5: 'Рядовой → Офицер! ⭐⭐',
            10: 'Десятый уровень — уважение! 🏆',
            15: 'Половина пути до 30! 💪',
            20: 'Командир отряда! ⭐⭐⭐',
            25: 'Четверть века уровней! 🌟',
            30: 'Тридцатилетие! 🎂',
            50: 'Генерал армии! 👑',
        };
        return messages[level] || 'Продолжай в том же духе! 💪';
    }

    // Confetti Animation
    triggerConfetti() {
        const canvas = document.getElementById('confetti-canvas');
        if (!canvas || getComputedStyle(canvas).display === 'none') return;
        const ctx = canvas.getContext('2d');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        
        const particles = [];
        const colors = ['#6366f1', '#8b5cf6', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#06b6d4'];
        const particleCount = 150;
        
        for (let i = 0; i < particleCount; i++) {
            particles.push({
                x: canvas.width / 2,
                y: canvas.height / 2,
                vx: (Math.random() - 0.5) * 20,
                vy: -Math.random() * 15 - 5,
                size: Math.random() * 8 + 4,
                color: colors[Math.floor(Math.random() * colors.length)],
                rotation: Math.random() * 360,
                rotationSpeed: (Math.random() - 0.5) * 10,
                gravity: 0.3,
                life: 1,
                decay: Math.random() * 0.01 + 0.005,
            });
        }
        
        let animationId;
        const animate = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            let alive = 0;
            
            for (const p of particles) {
                if (p.life <= 0) continue;
                alive++;
                
                p.x += p.vx;
                p.y += p.vy;
                p.vy += p.gravity;
                p.rotation += p.rotationSpeed;
                p.life -= p.decay;
                
                ctx.save();
                ctx.translate(p.x, p.y);
                ctx.rotate(p.rotation * Math.PI / 180);
                ctx.globalAlpha = p.life;
                ctx.fillStyle = p.color;
                ctx.fillRect(-p.size/2, -p.size/2, p.size, p.size);
                ctx.restore();
            }
            
            if (alive > 0) {
                animationId = requestAnimationFrame(animate);
            } else {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            }
        };
        
        animate();
        
        // Cleanup after 5 seconds max
        setTimeout(() => {
            cancelAnimationFrame(animationId);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }, 5000);
    }

    // Sound Effects
    playSound(type) {
        if (!this.settings.notificationSound) return;
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = ctx.createOscillator();
            const gainNode = ctx.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(ctx.destination);
            
            switch (type) {
                case 'levelup':
                    oscillator.type = 'sine';
                    oscillator.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
                    oscillator.frequency.exponentialRampToValueAtTime(1046.50, ctx.currentTime + 0.3); // C6
                    oscillator.frequency.exponentialRampToValueAtTime(1567.98, ctx.currentTime + 0.5); // G6
                    gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
                    gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.8);
                    oscillator.start(ctx.currentTime);
                    oscillator.stop(ctx.currentTime + 0.8);
                    break;
                case 'damage':
                    oscillator.type = 'sawtooth';
                    oscillator.frequency.setValueAtTime(200, ctx.currentTime);
                    oscillator.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.3);
                    gainNode.gain.setValueAtTime(0.2, ctx.currentTime);
                    gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
                    oscillator.start(ctx.currentTime);
                    oscillator.stop(ctx.currentTime + 0.4);
                    break;
                case 'coin':
                    oscillator.type = 'sine';
                    oscillator.frequency.setValueAtTime(880, ctx.currentTime); // A5
                    oscillator.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.1); // E6
                    gainNode.gain.setValueAtTime(0.15, ctx.currentTime);
                    gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
                    oscillator.start(ctx.currentTime);
                    oscillator.stop(ctx.currentTime + 0.2);
                    break;
            }
        } catch (e) {
            // Audio not supported or blocked
        }
    }

    // ===== Stats (in Profile) =====
    renderCategoryStats() {
        const container = document.getElementById('categoryStats');
        if (!container) return;
        const definitions = {
            personal: { icon: '👤', label: 'Личное', color: '#22d3ee' },
            finance: { icon: '💰', label: 'Финансы', color: '#818cf8' },
            health: { icon: '🏋️', label: 'Здоровье / Спорт', color: '#22d3ee' },
            education: { icon: '🧠', label: 'Развитие / IT', color: '#818cf8' },
            career: { icon: '💼', label: 'Карьера', color: '#22d3ee' },
            hobby: { icon: '🎨', label: 'Хобби', color: '#818cf8' },
            other: { icon: '🧩', label: 'Другое', color: '#22d3ee' }
        };
        const cats = new Map();
        this.goals.forEach(goal => {
            const category = goal.category || 'personal';
            if (!cats.has(category)) cats.set(category, { total: 0, completed: 0, progress: 0 });
            const data = cats.get(category);
            data.total++;
            if (goal.status === 'completed') data.completed++;
            data.progress += this.calculateProgress(goal);
        });
        container.innerHTML = [...cats].map(([category, data]) => {
            const { icon, label, color } = Object.hasOwn(definitions, category) ? definitions[category] : { icon: '🧩', label: this.getCategoryLabel(category), color: '#818cf8' };
            const average = Math.round(data.progress / data.total);
            const candidates = this.goals.filter(goal => (goal.category || 'personal') === category && goal.status !== 'completed').flatMap(goal => (goal.subgoals || []).filter(step => !step.completed).map(step => ({ goal, step, due: step.deadline || goal.deadline || '9999-12-31' }))).sort((a, b) => a.due.localeCompare(b.due));
            const next = candidates[0];
            return `<div class="category-stat${data.total ? '' : ' is-empty'}" style="--category-accent:${color}">
                <div class="category-stat-header">
                    <span class="category-stat-name"><span class="category-stat-icon" aria-hidden="true">${icon}</span>${this.escapeHtml(label)}</span>
                    <span class="category-stat-metrics"><strong>${average}%</strong><span aria-hidden="true">•</span><span class="category-stat-count" aria-label="Завершено целей: ${data.completed} из ${data.total}">${data.completed}/${data.total}</span></span>
                </div>
                <div class="category-stat-bar" role="progressbar" aria-label="Прогресс: ${this.escapeHtml(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${average}"><div class="category-stat-fill" style="width:${average}%"></div></div>
                ${next ? `<button type="button" class="category-next-step" data-next-goal="${this.escapeHtml(next.goal.id)}" data-next-step="${this.escapeHtml(next.step.id)}"><span>Следующий шаг${next.due !== '9999-12-31' ? ' · ' + this.escapeHtml(next.due.split('-').reverse().join('.')) : ''}</span><strong>${this.escapeHtml(next.step.title)} ↗</strong><small>${this.escapeHtml(next.goal.title)}</small></button>` : `<p class="category-stat-hint">${data.completed === data.total ? 'Все цели этой сферы завершены' : 'Добавьте подцель, чтобы наметить следующий шаг'}</p>`}
            </div>`;
        }).join('');
        if (!this.goals.length) container.innerHTML = '<p class="category-stats-empty">Выберите сферу и добавьте первую цель — здесь появятся её прогресс и следующий шаг.</p>';
        const domains = Object.entries(definitions).filter(([key]) => !cats.has(key));
        container.insertAdjacentHTML('beforeend', `<div class="category-add-sphere">${domains.length ? `<label><span>Сфера новой цели</span><select data-category-choice aria-label="Сфера новой цели">${domains.map(([key, value]) => `<option value="${key}">${value.icon} ${value.label}</option>`).join('')}</select></label>` : ''}<button type="button" class="btn btn-secondary" data-add-category>+ ${!this.goals.length ? 'Добавить первую цель' : domains.length ? 'Добавить цель в другой сфере' : 'Добавить цель'}</button></div>`);
        container.querySelector('[data-add-category]').addEventListener('click', () => {
            const category = container.querySelector('[data-category-choice]')?.value || 'personal';
            this.closeModal('settingsModal'); this.openGoalModal();
            const form = document.getElementById('goalForm');
            form.dataset.initialCategory = category;
            const context = document.getElementById('goalParentContext');
            context.textContent = `Сфера: ${definitions[category].label}`; context.hidden = false;
        });
        container.querySelectorAll('[data-next-goal]').forEach(button => button.addEventListener('click', () => {
            this.closeModal('settingsModal'); this.openGoalDetail(button.dataset.nextGoal);
            const checkbox = [...document.querySelectorAll('#goalDetailContent .subgoal-checkbox')].find(item => item.dataset.sid === button.dataset.nextStep);
            checkbox?.focus(); checkbox?.closest('.subgoal-item')?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        }));
    }

    getWeeklyActivity(now = new Date()) {
        const monday = new Date(now); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
        const key = date => this.calendarDateString(date.getFullYear(), date.getMonth(), date.getDate());
        const days = Array.from({ length: 7 }, (_, index) => { const date = new Date(monday); date.setDate(date.getDate() + index); return { date: key(date), label: ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'][index], number: date.getDate(), count: 0 }; });
        const counts = new Map(days.map(day => [day.date, day]));
        const tasks = [];
        for (const goal of this.goals || []) for (const step of goal.subgoals || []) tasks.push({ ...step, plannedDate: step.deadline || goal.deadline });
        for (const [date, notes] of Object.entries(this.notes || {})) for (const note of Array.isArray(notes) ? notes : []) tasks.push({ ...note, plannedDate: date });
        for (const event of this.events || []) tasks.push({ ...event, plannedDate: event.date });
        let planned = 0, completed = 0, undated = 0;
        for (const task of tasks) {
            const time = task.completedAt ? new Date(task.completedAt) : null;
            const dated = time && Number.isFinite(time.getTime());
            const completionDate = dated ? key(time) : null;
            const doneThisWeek = task.completed === true && counts.has(completionDate) && time.getTime() <= now.getTime();
            if (counts.has(task.plannedDate) || doneThisWeek) planned++;
            if (doneThisWeek) { counts.get(completionDate).count++; completed++; }
            if (task.completed === true && !dated) undated++;
        }
        return { days, completed, planned, undated, productivity: planned ? Math.round(completed / planned * 100) : null, today: key(now) };
    }

    renderWeeklyActivity() {
        const container = document.getElementById('weeklyActivity');
        if (!container) return;
        const stats = this.getWeeklyActivity();
        const max = Math.max(...stats.days.map(day => day.count), 1);
        const taskWord = stats.completed % 10 === 1 && stats.completed % 100 !== 11 ? 'задача' : [2,3,4].includes(stats.completed % 10) && ![12,13,14].includes(stats.completed % 100) ? 'задачи' : 'задач';
        container.innerHTML = `<div class="weekly-summary"><strong>Выполнено за неделю: ${stats.completed} ${taskWord}</strong><span class="weekly-productivity"><b>${stats.productivity === null ? '—' : stats.productivity + '%'}</b> продуктивности</span></div>
            <p class="weekly-metric">Завершённые подцели и события календаря · ${stats.days[0].date.split('-').reverse().join('.')} — ${stats.days[6].date.split('-').reverse().join('.')}</p>
            <div class="weekly-chart" role="list" aria-label="Выполненные дела по дням недели">${stats.days.map(day => `<div class="weekly-day${day.date === stats.today ? ' is-today' : ''}" role="listitem" aria-label="${day.label} ${day.date}: выполнено ${day.count}${day.date === stats.today ? ', сегодня' : ''}"><strong class="weekly-count">${day.count}</strong><div class="weekly-track"><span style="height:${day.count / max * 100}%"></span></div><span class="weekly-date">${day.label} ${day.number}</span><small>${day.date === stats.today ? 'Сегодня' : '&nbsp;'}</small></div>`).join('')}</div>
            <p class="weekly-explanation">${stats.planned ? `Выполнено ${stats.completed} из ${stats.planned} дел недели. План — подцели со сроком на эту неделю и записи календаря; внеплановые завершённые дела тоже учтены.` : 'Пока нет дел на эту неделю. Добавьте запись в календарь или завершите подцель.'}${stats.undated ? ' Старые выполненные дела без даты завершения в диаграмму не входят.' : ''}</p>`;
    }

    // ===== Sync =====
    async syncData(silent = false) {
        if (window.CloudSync?.configured()) return window.CloudSync.sync();
        if (this._resetting) return false;
        const epoch = this._dataEpoch;
        const base = this.getSyncBase();
        
        // Автономный режим — синхронизация не настроена
        if (!base) {
            if (!silent) this.showToast('📴 Автономный режим: синхронизация отключена', 'info');
            return false;
        }

        if (!silent) this.showToast('Синхронизация...', 'info');

        try {
            // 1. Получаем данные сервера
            let remote = null;
            let r = null;
            try {
                r = await this.apiFetch(base, { cache: 'no-store' });
            } catch { r = null; }
            if (this._resetting || epoch !== this._dataEpoch) return false;
            if (r && r.status === 401) {
                this.showPinModal('Неверный код доступа — введите заново');
                return false;
            }
            if (r && r.ok) remote = await r.json();
            if (this._resetting || epoch !== this._dataEpoch) return false;

            // Нет профиля — можно только забрать данные (автовход на новом устройстве)
            if (!this.user) {
                if (remote && remote.updatedAt) {
                    this.applyRemote(remote);
                    this.afterRemoteUpdate();
                    if (!silent) this.showToast('📥 Профиль получен с сервера', 'success');
                } else if (!silent) {
                    this.showToast('ℹ️ Нет профиля для отправки', 'info');
                }
                return this.user;
            }

            const neverSynced = !this.updatedAt;
            const remoteNewer = !!(remote && remote.updatedAt && this.updatedAt && remote.updatedAt > this.updatedAt);

            // Сервер новее, а локально ничего не меняли — чистое обновление
            if (remoteNewer && !this._dirty) {
                this.applyRemote(remote);
                this.afterRemoteUpdate();
                if (!silent) this.showToast('📥 Данные обновлены с сервера', 'success');
                return true;
            }

            // Локальных изменений нет и сервер актуален — отправлять нечего
            if (!this._dirty && remote && remote.updatedAt && !neverSynced) {
                if (!silent) this.showToast('🔄 Данные уже актуальны', 'success');
                return true;
            }

            // 2. Отправляем локальные данные (merge при первом подключении или одновременных правках)
            let payload = this.serialize();
            payload.updatedAt = new Date().toISOString();
            payload.baseUpdatedAt = (remote && remote.updatedAt) || this.updatedAt || null;
            if (remote && remote.updatedAt && (neverSynced || (remoteNewer && this._dirty))) {
                payload = this.mergeData(remote, payload);
            }

            const doPush = () => this.apiFetch(base, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const resp = await doPush();
            if (this._resetting || epoch !== this._dataEpoch) return false;

            if (resp.status === 401) {
                this.showPinModal('Неверный код доступа — введите заново');
                return false;
            }
            if (resp.status === 409) {
                // Конфликт: сервер ушёл вперёд, пока мы правили — объединяем и повторяем
                const conflict = await resp.json();
                if (this._resetting || epoch !== this._dataEpoch) return false;
                if (conflict.server) {
                    if (this._dirty) {
                        payload = this.mergeData(conflict.server, payload);
                        payload.updatedAt = new Date().toISOString();
                        payload.baseUpdatedAt = conflict.server.updatedAt;
                        const retry = await doPush();
                        if (this._resetting || epoch !== this._dataEpoch) return false;
                        if (!retry.ok) throw new Error('HTTP ' + retry.status);
                    } else {
                        this.applyRemote(conflict.server);
                        this.afterRemoteUpdate();
                        if (!silent) this.showToast('📥 Данные обновлены с сервера', 'success');
                        return true;
                    }
                }
            } else if (!resp.ok) {
                throw new Error('HTTP ' + resp.status);
            }

            this.updatedAt = payload.updatedAt;
            this._dirty = false;
            delete payload.baseUpdatedAt;
            // Синхронизируем память с отправленным (важно после merge — иначе
            // следующий push затёрл бы чужие данные нашей старой копией)
            this.applyRemote(payload);
            this.render();
            if (!silent) this.showToast('📤 Данные синхронизированы', 'success');
            return true;
        } catch (e) {
            console.warn('Sync failed:', e);
            if (!silent) this.showToast('⚠️ Ошибка синхронизации — данные остаются локально', 'error');
            return false;
        }
    }

    // Объединение данных нового устройства с серверными (первое подключение)
    mergeData(remote, local) {
        const byId = arr => new Map(arr.map(x => [x.id, x]));
        const union = (a, b) => {
            const map = byId(a);
            b.forEach(x => { if (!map.has(x.id)) map.set(x.id, x); });
            return [...map.values()];
        };
        const merged = { ...local };
        merged.user = local.user || remote.user;
        merged.goals = union(remote.goals || [], local.goals || []);
        merged.achievements = union(remote.achievements || [], local.achievements || []);
        merged.habits = union(remote.habits || [], local.habits || []);
        merged.events = union(remote.events || [], local.events || []);
        merged.workspace = Object.fromEntries(['portfolio','eloHistory','books','topics'].map(key => [key, union(remote.workspace?.[key] || [], local.workspace?.[key] || [])]));
        if (local.workspace?.chess || remote.workspace?.chess) merged.workspace.chess = local.workspace?.chess || remote.workspace.chess;
        // Записи календаря: по дням, объединение по id
        const rn = this.normalizeNotes(remote.notes || {});
        const ln = this.normalizeNotes(local.notes || {});
        merged.notes = {};
        for (const day of new Set([...Object.keys(rn), ...Object.keys(ln)])) {
            if (rn[day] && ln[day]) {
                const map = new Map(rn[day].map(n => [n.id, n]));
                ln[day].forEach(n => map.set(n.id, n));
                merged.notes[day] = [...map.values()];
            } else {
                merged.notes[day] = ln[day] || rn[day];
            }
        }
        // Геймификация — берём лучшие показатели
        const rg = remote.gamification || {};
        const lg = local.gamification || {};
        merged.gamification = {
            ...lg,
            xp: Math.max(lg.xp || 0, rg.xp || 0),
            level: Math.max(lg.level || 1, rg.level || 1),
            streak: Math.max(lg.streak || 0, rg.streak || 0),
            badges: union(rg.badges || [], lg.badges || [])
        };
        return merged;
    }

    // ===== Export/Import =====
    exportData() {
        const data = { user: this.user, goals: this.goals, achievements: this.achievements, habits: this.habits, events: this.events, notes: this.notes, workspace:this.workspace, settings: this.settings, gamification: this.gamification, exportDate: new Date().toISOString() };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `goaltracker-${new Date().toISOString().split('T')[0]}.json`; a.click();
        URL.revokeObjectURL(url);
        this.showToast('Экспортировано!', 'success');
    }

    exportCSV() {
        const headers = ['Цель','Категория','Приоритет','Статус','Прогресс','Дедлайн'];
        const rows = this.goals.map(g => [g.title, this.getCategoryLabel(g.category), this.getPriorityLabel(g.priority), g.status === 'completed' ? 'Готово' : 'Активна', this.calculateProgress(g)+'%', g.deadline || '']);
        const csv = [headers, ...rows].map(r => r.map(c => `"${c}"`).join(',')).join('\n');
        const blob = new Blob(['\ufeff'+csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `goaltracker.csv`; a.click();
        URL.revokeObjectURL(url);
        this.showToast('CSV экспортирован!', 'success');
    }

    exportPDF() {
        const w = window.open('', '_blank');
        w.document.write(`<html><head><title>NCD</title><style>body{font-family:Arial;padding:20px}h1{color:#6366f1}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#6366f1;color:#fff}</style></head><body><h1>NCD — Отчёт</h1><p>${new Date().toLocaleDateString('ru-RU')}</p><h2>Цели (${this.goals.length})</h2><table><tr><th>Цель</th><th>Категория</th><th>Статус</th><th>Прогресс</th></tr>${this.goals.map(g => `<tr><td>${this.escapeHtml(g.title)}</td><td>${this.getCategoryLabel(g.category)}</td><td>${g.status==='completed'?'Готово':'Активна'}</td><td>${this.calculateProgress(g)}%</td></tr>`).join('')}</table></body></html>`);
        w.document.close(); w.print();
        this.showToast('PDF готов!', 'success');
    }

    importData() {
        const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
        input.onchange = (e) => {
            const file = e.target.files[0]; if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const data = JSON.parse(ev.target.result);
                    if (data.user) this.user = { ...data.user, id: this.user?.id || data.user.id || crypto.randomUUID() };
                    if (data.goals) this.goals = data.goals;
                    if (data.achievements) this.achievements = data.achievements;
                    if (data.workspace) this.workspace = data.workspace;
                    if (data.habits) this.habits = data.habits;
                    if (data.events) this.events = data.events;
                    if (data.notes) this.notes = this.normalizeNotes(data.notes);
                    if (data.settings) this.settings = { ...this.settings, ...data.settings };
                    this.settings.habitReminders = false;
                    if (data.gamification) this.gamification = { ...this.gamification, ...data.gamification };
                    this.saveData(); this.render(); this.showToast('Импортировано!', 'success');
                } catch (err) { this.showToast('Ошибка файла', 'error'); }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    // ===== Notifications =====

    showNotification(message) {
        // System notifications are Android-only; desktop retains in-app feedback.
        this.showToast(message, 'info');
    }

    // ===== Notification Manager Integration =====
    async requestNotificationPermission() {
        if (this.notificationManager) {
            const granted = await this.notificationManager.requestPermissions();
            if (!granted) {
                this.showToast('Разрешение на уведомления не получено', 'warning');
                this.settings.notifications = false;
                this.saveData();
                document.getElementById('notificationsEnabled').checked = false;
                document.getElementById('notificationSettingsGroup').style.display = 'none';
            }
            return granted;
        }
        return false;
    }

    async rescheduleAllNotifications() {
        if (!window.Capacitor || window.Capacitor.getPlatform?.() !== 'android' || !this.notificationManager) return;
        try {
            await this.notificationManager.rescheduleAll();

        } catch (e) {
            console.error('[App] Ошибка перепланировки уведомлений:', e);
        }
    }

    async cancelAllNotifications() {
        if (this.notificationManager) {
            await this.notificationManager.cancelAll();
        }
    }

    async sendTestNotification() {
        if (!window.Capacitor || window.Capacitor.getPlatform?.() !== 'android') {
            this.showToast('Доступно только на Android', 'info'); return false;
        }
        const button = document.getElementById('testNotificationBtn');
        if (button.disabled) return false;
        button.disabled = true;
        try {
            const ok = await this.notificationManager?.sendTestNotification();
            this.showToast(ok ? 'Уведомление запланировано через 3 секунды. Сверните приложение.' : this.notificationManager?.lastError || 'Проверьте разрешение на уведомления в Android.', ok ? 'success' : 'info');
            return !!ok;
        } catch { this.showToast('Не удалось запланировать системное уведомление.', 'error'); return false; }
        finally { button.disabled = false; }
    }

    // Вызывается при изменении цели
    async onGoalChanged() { /* Goal changes do not schedule system notifications. */ }
    async onGoalDeleted() { /* Legacy reminders are cleaned up by NotificationManager.init(). */ }

    // Вызывается при изменении заметки календаря
    async onNoteChanged(note, dateStr) {
        if (this.notificationManager) {
            await this.notificationManager.scheduleCalendarEvent({ 
                id: note.id, 
                title: note.content, 
                date: dateStr, 
                time: note.time,
                completed: note.completed,
                location: note.location
            });
        }
    }

    // Вызывается при удалении заметки
    async onNoteDeleted(noteId) {
        if (this.notificationManager) {
            await this.notificationManager.cancelCalendarEvent(noteId);
        }
    }

    // ===== Utilities =====
    generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

    getSubgoalProgress(goal) {
        const subgoals = Array.isArray(goal.subgoals) ? goal.subgoals : [];
        const total = subgoals.length;
        const fractions = subgoals.map(step => this.getSubgoalFraction(step));
        const completed = fractions.filter(value => value >= 1).length;
        const percent = total ? Math.round(fractions.reduce((sum, value) => sum + value, 0) / total * 100) : 0;
        return { total, completed, percent };
    }

    calculateProgress(goal) {
        const steps = this.getSubgoalProgress(goal);
        if (steps.total) return steps.percent;
        return goal.status === 'completed' ? 100 : 0;
    }

    getDaysLeft(deadline) {
        const now = new Date(); now.setHours(0,0,0,0);
        const dl = new Date(deadline); dl.setHours(0,0,0,0);
        return Math.ceil((dl - now) / 86400000);
    }

    getCategoryLabel(c) { return { personal:'Личное',career:'Карьера',health:'Здоровье',finance:'Финансы',education:'Образование',hobby:'Хобби',other:'Другое' }[c] || c; }
    getPriorityLabel(p) { return { low:'Низкий',medium:'Средний',high:'Высокий',milestone:'★ Главная веха',critical:'Критический' }[p] || p; }
    getPriorityClass(p) { return { low:'priority-low',medium:'priority-medium',high:'priority-high',milestone:'priority-milestone',critical:'priority-critical' }[p] || 'priority-medium'; }

    escapeHtml(t) { if (!t) return ''; const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
    mountFormView(id) {
        for (const other of ['goalModal', 'achievementModal', 'noteModal']) {
            if (other === id || !document.getElementById(other)?.classList.contains('active')) continue;
            this.closeModal(other);
            if (document.getElementById(other)?.classList.contains('active')) return false;
        }
        window.NCDModalViews.mount(id);
        return true;
    }

    closeModal(id) {
        if (id === 'cloudAuthModal' && window.CloudSync) { window.CloudSync.closeAuth(); return; }
        if (id === 'profileEditModal' && this._profileSaving) return;
        if (id === 'deleteGoalModal' && this._goalActionPending) return;
        if ((id === 'goalModal' && this._goalSaveInProgress) || (id === 'goalDetailModal' && this._goalActionPending)) return;
        if (id === 'settingsModal') this.cancelSettingsLoad();
        if (id === 'profileEditModal') clearTimeout(this._profileInputTimer);
        document.getElementById(id)?.classList.remove('active');
        window.NCDModalViews.unmount(id);
        if (id === 'settingsModal') this.render();
        if (id === 'goalDetailModal') {
            document.querySelectorAll('.goal-item.selected').forEach(row => row.classList.remove('selected'));
            if (window.matchMedia?.('(max-width: 768px)').matches && this._goalDetailOpener?.isConnected) this._goalDetailOpener.focus({ preventScroll: true });
            this._goalDetailOpener = null;
        }
    }

    // Доступность модалок на тач-устройствах и с клавиатурой:
    // Escape закрывает верхнюю активную модалку, Tab/фокус не покидают открытое окно.
    initModalA11y() {
        document.addEventListener('keydown', (e) => {
            const active = [...document.querySelectorAll('.modal.active, #goalDetailModal.active[aria-modal="true"]')].pop();
            if (!active) { if (e.key === 'Escape') this.closeModal('goalDetailModal'); return; }
            if (e.key === 'Escape') {
                e.preventDefault();
                this.closeModal(active.id);
                return;
            }
            if (e.key !== 'Tab') return;
            const focusable = [...active.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
                .filter((el) => el.offsetParent !== null);
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            else if (!active.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
        });
        document.addEventListener('focusin', (e) => {
            const active = [...document.querySelectorAll('.modal.active, #goalDetailModal.active[aria-modal="true"]')].pop();
            if (!active || active === e.target || active.contains(e.target)) return;
            const first = active.querySelector('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
            first?.focus();
        });
    }

    showToast(message, type = 'info') {
        const container = document.getElementById('toastContainer');
        // Suppress duplicate copies while the same notice is already visible.
        if ([...container.querySelectorAll('.toast')].some(item => item.textContent === String(message))) return;
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    // ===== PWA Install =====
    showInstallButton() {
        // Кнопка установки появится в профиле или в настройках
        const existing = document.getElementById('installPwaBtn');
        if (existing) existing.style.display = 'inline-block';
    }

    hideInstallButton() {
        const existing = document.getElementById('installPwaBtn');
        if (existing) existing.style.display = 'none';
    }

    async installPWA() {
        if (!this.deferredPrompt) {
            this.showToast('Установка недоступна (уже установлено или браузер не поддерживает)', 'info');
            return;
        }
        this.deferredPrompt.prompt();
        const { outcome } = await this.deferredPrompt.userChoice;
        if (outcome === 'accepted') {
            this.showToast('Установка запущена...', 'success');
        }
        this.deferredPrompt = null;
        this.hideInstallButton();
    }

    // ===== OTA Updates (Live Updates) =====
    // Сравнение версий semver: 1 если a>b, -1 если a<b, 0 если равны
    compareVersions(a, b) {
        const pa = String(a || '0').split('.').map(x => parseInt(x, 10) || 0);
        const pb = String(b || '0').split('.').map(x => parseInt(x, 10) || 0);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const x = pa[i] || 0, y = pb[i] || 0;
            if (x > y) return 1;
            if (x < y) return -1;
        }
        return 0;
    }

    // Жёсткая проверка обновлений при старте: работает ВЕЗДЕ (APK + браузер),
    // без зависимости от нативного плагина. Вызывается из DOMContentLoaded и showApp.
    async checkForWebUpdate({ force = false } = {}) {
        if (window.Capacitor?.getPlatform?.() === 'ios') {
            if (force) this.showToast('Обновления iOS доступны через TestFlight или App Store.', 'info');
            return false;
        }
        if (this._updateCheckPromise) return this._updateCheckPromise;
        if (this._updateCheckDone && !force) return;
        this._updateCheckDone = true;
        this._updateCheckPromise = (async () => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);
            try {
                const res = await fetch(UPDATE_BASE_URL + '/version.json?t=' + Date.now(), { cache:'no-store', signal:controller.signal });
                if (!res.ok) throw new Error('OTA_HTTP_' + res.status);
                const info = await res.json();
                if (!info || !/^\d+\.\d+\.\d+$/.test(info.version)) throw new Error('OTA_INVALID_VERSION');
                if (this.compareVersions(info.version, APP_VERSION) > 0) {
                    this.pendingUpdate = info;
                    if (window.Capacitor?.isNativePlatform?.()) return await this.backgroundDownloadUpdate(info);
                    if (force) localStorage.removeItem('goaltracker_update_dismissed');
                    this.showUpdateBanner(info);
                    return true;
                }
                this.pendingUpdate = null; this.hideUpdateBanner();
                if (force) this.showToast('Установлена актуальная версия приложения.', 'success');
                return false;
            } catch (err) {
                this._updateCheckDone = false;
                console.log('[OTA] Проверка версии не удалась:', err?.message);
                if (force) this.showToast('Не удалось проверить обновления. Проверьте подключение и повторите попытку.', 'error');
                return false;
            } finally { clearTimeout(timeout); }
        })();
        try { return await this._updateCheckPromise; }
        finally { this._updateCheckPromise = null; }
    }

    // Фоновая загрузка бандла через нативный плагин Capgo (без dynamic import —
    // через глобальный объект Capacitor, который всегда есть в WebView)
    async backgroundDownloadUpdate(info) {
        if (this._updateDownloadPromise) return this._updateDownloadPromise;
        this._updateDownloadPromise = this.installNativeUpdate(info);
        try {
            return await this._updateDownloadPromise;
        } finally {
            this._updateDownloadPromise = null;
        }
    }

    async installNativeUpdate(info) {
        if (window.Capacitor?.getPlatform?.() === 'ios') {
            if (true) this.showToast('Обновления iOS доступны через TestFlight или App Store.', 'info');
            return false;
        }
        try {
            const Updater = window.Capacitor?.Plugins?.CapacitorUpdater;
            if (!Updater || !info?.updateUrl) return false;
            this.showToast('Доступно обновление. Устанавливаем...', 'info');
            const downloadOptions = {
                url: info.updateUrl,
                version: info.version
            };
            if (info.checksum) downloadOptions.checksum = info.checksum;
            const bundle = await Updater.download(downloadOptions);
            if (bundle?.id) {
                console.log('[OTA] Бандл загружен, перезапускаем приложение:', bundle.id);
                await window.ProfileStorage?.flush?.();
                // set() активирует бандл и самостоятельно перезагружает WebView.
                await Updater.set({ id: bundle.id });
                return true;
            }
        } catch (err) {
            console.log('[OTA] Фоновая загрузка не удалась:', err?.message);
            this.showToast('Не удалось установить обновление. Повторим при следующем запуске.', 'error');
        }
        return false;
    }

    // Кнопка [Применить] на баннере: нативный путь → плагин, иначе → открыть URL
    async applyWebUpdate() {
        if (window.Capacitor?.getPlatform?.() === 'ios') {
            if (true) this.showToast('Обновления iOS доступны через TestFlight или App Store.', 'info');
            return false;
        }
        const info = this.pendingUpdate;
        if (!info) return;
        if (window.Capacitor?.isNativePlatform?.()) {
            const ok = await this.backgroundDownloadUpdate(info);
            if (ok) {
                this.hideUpdateBanner();
                return;
            }
            // Плагин недоступен — предлагаем перезапуск (вдруг бандл уже подтянут)
            this.showToast('⚠️ Не удалось скачать внутри приложения. Установите новый APK.', 'error');
        }
        const url = info.updateUrl || (UPDATE_BASE_URL + '/updates/latest.zip');
        try { window.open(url, '_blank'); } catch (e) {}
    }

    showUpdateBanner(info) {
        try {
            const dismissed = localStorage.getItem('goaltracker_update_dismissed');
            if (dismissed === info.version) return; // пользователь нажал «Позже» для этой версии
        } catch (e) {}
        let banner = document.getElementById('updateBanner');
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'updateBanner';
            banner.className = 'update-banner';
            document.body.prepend(banner);
        }
        banner.innerHTML =
            '<span class="update-banner-text">🚀 Доступно обновление <b>v' + this.escapeHtml(info.version) + '</b>' +
            (info.changelog ? ' — ' + this.escapeHtml(info.changelog) : '') + '</span>' +
            '<span class="update-banner-actions">' +
            '<button class="btn btn-primary btn-small" id="applyUpdateBtn">Применить</button>' +
            '<button class="btn btn-secondary btn-small" id="dismissUpdateBtn">Позже</button>' +
            '</span>';
        banner.style.display = 'flex';
        document.getElementById('applyUpdateBtn').onclick = () => this.applyWebUpdate();
        document.getElementById('dismissUpdateBtn').onclick = () => {
            try { localStorage.setItem('goaltracker_update_dismissed', info.version); } catch (e) {}
            this.hideUpdateBanner();
        };
    }

    hideUpdateBanner() {
        const banner = document.getElementById('updateBanner');
        if (banner) banner.style.display = 'none';
    }

    async checkForUpdates() {
        // Новый путь: проверка через version.json (работает везде)
        await this.checkForWebUpdate({force:true});
    }

    showRestartButton() {
        // Добавляем кнопку перезапуска в настройки или на дашборд
        const existing = document.getElementById('restartAppBtn');
        if (existing) {
            existing.style.display = 'inline-block';
            return;
        }
        
        // Создаем кнопку динамически
        const btn = document.createElement('button');
        btn.id = 'restartAppBtn';
        btn.className = 'btn btn-warning';
        btn.textContent = '🔄 Перезапустить для обновления';
        btn.style.marginTop = '8px';
        btn.onclick = () => this.restartApp();
        
        // Добавляем в настройки или на дашборд
        const container = document.getElementById('profileContent') || document.getElementById('view-dashboard');
        if (container) {
            container.insertBefore(btn, container.firstChild);
        }
    }

    async restartApp() {
        await window.ProfileStorage.flush();
        if (window.Capacitor?.isNativePlatform?.()) {
            try {
                const CapApp = window.Capacitor?.Plugins?.App;
                if (CapApp?.exitApp) { await CapApp.exitApp(); return; }
            } catch (e) {}
        }
        location.reload();
    }
}

// ===== Initialize =====
document.addEventListener('DOMContentLoaded', async () => {
    // Первое действие после готовности DOM: подтверждаем запуск OTA-бандла.
    // Вызов намеренно не await'ится и происходит до профиля, сети и синхронизации.
    if (nativeUpdater?.notifyAppReady) {
        try {
            nativeUpdater.notifyAppReady().catch(error => {
                console.warn('[OTA] Не удалось подтвердить запуск бандла:', error?.message || error);
            });
        } catch (error) {
            console.warn('[OTA] Плагин подтверждения запуска недоступен:', error?.message || error);
        }
    }

    // защита от двойной инициализации (window.app может быть DOM-элементом id="app")
    if (window.app instanceof GoalTracker) return;
    try {
        await window.ProfileStorage.open({ preferCache:true });
    } catch (firstError) {
        console.warn('[profile] startup read failed, retrying in 300ms:', firstError?.message || 'unknown');
        await new Promise(resolve => setTimeout(resolve, 300));
        try {
            await window.ProfileStorage.open({ preferCache:true });
        } catch (secondError) {
            // Последняя линия защиты: ошибка профиля больше не блокирует весь UI.
            console.warn('[profile] retry failed; opening local fallback:', secondError?.message || 'unknown');
            try { await window.ProfileStorage.openFallback?.(secondError); }
            catch (fallbackError) { console.warn('[profile] empty-session fallback:', fallbackError?.message || 'unknown'); }
        }
    }
    window.app = new GoalTracker();
    console.log('NCD started successfully!');
    // OTA не участвует в запуске: проверяем только в фоне через 5 секунд.
    setTimeout(() => {
        try { window.app?.checkForWebUpdate(); } catch (e) {}
    }, 5000);
});
