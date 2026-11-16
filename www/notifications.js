// Android-only system reminders using Capacitor LocalNotifications.
// Desktop/Electron never resolves the native plugin or requests permissions.

(function () {
'use strict';

// No plugin lookup, permissions, Web Notifications or native fallback on desktop/iOS.
const isAndroid = () => !!window.Capacitor && window.Capacitor.getPlatform?.() === 'android';

class NotificationManager {
    constructor(app) {
        this.app = app;
        this.isNative = isAndroid();
        this.lastError = '';
        this.exactAllowed = false;
        this.channels = new Set();
        this.initialized = false;
    }

    // ===== ИНИЦИАЛИЗАЦИЯ =====
    get native() { return isAndroid() ? window.Capacitor.Plugins?.LocalNotifications : null; }

    async init() {
        if (!isAndroid()) return false;
        if (this.initialized) return true;
        if (this._initPromise) return this._initPromise;
        this._initPromise = (async () => {
            if (!this.native) { this.lastError = 'Нативный модуль уведомлений недоступен.'; return false; }
            try {
                let permission = await this.native.checkPermissions();
                this.permission = permission.display;
                await this.ensureChannel();
                this.exactAllowed = (await this.native.checkExactNotificationSetting()).exact_alarm === 'granted';
                this._actionListener = await this.native.addListener('localNotificationActionPerformed', notification => this.handleNotificationClick(notification));
                await this.removeLegacyReminders();
                this.initialized = true;
                this.lastError = '';
                this.updateSettingsUI();
                return true;
            } catch { this.lastError = 'Не удалось инициализировать системные уведомления.'; this.updateSettingsUI(); return false; }
        })().finally(() => { this._initPromise = null; });
        return this._initPromise;
    }

    updateSettingsUI() {
        const status = document.getElementById('androidNotificationStatus');
        if (status) {
            status.hidden = !isAndroid();
            status.textContent = this.lastError || (this.permission !== 'granted' ? 'Разрешите уведомления в настройках Android.' : !this.exactAllowed ? 'Уведомления разрешены. Без разрешения «Будильники и напоминания» возможна задержка.' : 'Уведомления Календаря разрешены. Точное время включено.');
        }
        const exact = document.getElementById('notificationExactPermissionBtn');
        if (exact) exact.hidden = !isAndroid() || this.exactAllowed;
    }

    async ensureChannel() {
        if (!isAndroid() || !this.native) return null;
        const id = 'calendar_reminders';
        if (!this.channels.has(id)) {
            await this.native.createChannel({ id, name: 'События Календаря', description: 'Напоминания о записях и встречах с датой и временем', importance: 4, visibility: 1, sound: 'beep.wav', vibration: true, lights: true, lightColor: '#22d3ee' });
            this.channels.add(id);
        }
        return id;
    }

    async requestPermissions() {
        if (!isAndroid() || !this.native) return false;
        try {
            const permission = await this.native.requestPermissions();
            this.permission = permission.display;
            if (permission.display === 'granted') this.lastError = '';
            this.updateSettingsUI();
            return permission.display === 'granted';
        } catch { this.lastError = 'Не удалось запросить разрешение Android.'; return false; }
    }

    async checkPermissions() {
        if (!isAndroid() || !this.native) return false;
        try { this.permission = (await this.native.checkPermissions()).display; return this.permission === 'granted'; }
        catch { return false; }
    }

    async requestExactPermission() {
        if (!isAndroid() || !this.native) return false;
        try {
            this.exactAllowed = (await this.native.changeExactNotificationSetting()).exact_alarm === 'granted';
            if (this.exactAllowed) this.lastError = '';
            this.updateSettingsUI(); return this.exactAllowed;
        } catch { this.lastError = 'Откройте в Android разрешение «Будильники и напоминания» для NCD.'; this.updateSettingsUI(); return false; }
    }

    notificationId(type, id, timing) {
        let hash = 2166136261;
        for (const char of `${type}:${id}:${timing}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
        return (hash >>> 0) % 2147483646 + 1;
    }

    schedule(options) {
        const work = this.scheduleForAccount(options); this.pendingSchedules ||= new Set(); this.pendingSchedules.add(work);
        work.finally(() => this.pendingSchedules.delete(work)).catch(() => {}); return work;
    }
    async scheduleForAccount(options) {
        const epoch = this.app._dataEpoch;
        if (!isAndroid() || !this.app.settings.notifications || !this.app.settings.calendarReminders || !['calendar', 'calendar_test'].includes(options.extra?.type)) return false;
        if (!await this.init() || !await this.checkPermissions()) return false;
        try {
            this.exactAllowed = (await this.native.checkExactNotificationSetting()).exact_alarm === 'granted';
            if (options.requireExact && !this.exactAllowed) { this.lastError = 'Разрешение на точное время отключено. Повторите проверку после включения.'; this.updateSettingsUI(); return false; }
            const channelId = await this.ensureChannel();
            if (epoch !== this.app._dataEpoch || this.app._accountTransition) return false;
            const result = await this.native.schedule({ notifications: [{
                id: options.id, title: options.title, body: options.body,
                channelId,
                schedule: { ...(options.schedule || { at: new Date(Date.now() + 1000) }), allowWhileIdle: true },
                isExactNotification: this.exactAllowed, isExactMandatory: !!options.requireExact,
                extra: options.extra || {}, smallIcon: 'ic_stat_notification',
                sound: 'beep.wav'
            }] });
            this.lastError = result?.warning ? 'Android запланировал уведомление с возможной задержкой.' : '';
            this.updateSettingsUI(); return !options.requireExact || !result?.warning;
        } catch { this.lastError = 'Android не смог запланировать уведомление. Проверьте системные разрешения.'; this.updateSettingsUI(); return false; }
    }

    async cancel(id) { return this.cancelMultiple([id]); }

    async cancelMultiple(ids) {
        if (!isAndroid() || !this.native) return false;
        try { await this.native.cancel({ notifications: ids.map(id => ({ id })) }); return true; }
        catch { this.lastError = 'Не удалось отменить системное напоминание.'; return false; }
    }

    async getPending() {
        if (!isAndroid() || !this.native) return [];
        try { return (await this.native.getPending()).notifications || []; }
        catch { this.lastError = 'Не удалось прочитать запланированные уведомления.'; return []; }
    }

    // Stable IDs are unchanged when an event is edited.
    calendarId(eventId) { return this.notificationId('calendar', eventId, 'event'); }

    enqueueEvent(eventId, operation) {
        this.eventOperations ||= new Map();
        const previous = this.eventOperations.get(eventId) || Promise.resolve();
        const next = previous.catch(() => {}).then(operation);
        this.eventOperations.set(eventId, next);
        next.finally(() => { if (this.eventOperations.get(eventId) === next) this.eventOperations.delete(eventId); }).catch(() => {});
        return next;
    }

    async cancelCalendarEventNow(eventId) {
        if (!isAndroid() || !eventId) return false;
        const pending = await this.getPending();
        const ids = new Set([this.calendarId(eventId), ...pending.filter(n => n.extra?.type === 'calendar' && n.extra?.eventId === eventId).map(n => n.id)]);
        return this.cancelMultiple([...ids]);
    }

    async cancelCalendarEvent(eventId) {
        if (!isAndroid() || !eventId) return false;
        return this.enqueueEvent(eventId, () => this.cancelCalendarEventNow(eventId));
    }

    async scheduleCalendarEvent(event, { requestPermission = true } = {}) {
        if (!isAndroid() || !event?.id) return false;
        return this.enqueueEvent(event.id, async () => {
            if (!await this.init()) return false;
            if (!await this.cancelCalendarEventNow(event.id)) return false;
            if (event.completed || !event.date || !event.time || !this.app.settings.notifications || !this.app.settings.calendarReminders) return false;
            const at = new Date(`${event.date}T${event.time}`);
            if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) return false;
            if (!await this.checkPermissions()) {
                if (!requestPermission || !await this.requestPermissions()) { this.updateSettingsUI(); return false; }
            }
            return this.schedule({
                id: this.calendarId(event.id),
                title: 'Календарь: Напоминание',
                body: `${event.title || event.content || event.name || 'Событие'} в ${event.time}`,
                schedule: { at },
                extra: { type: 'calendar', eventId: event.id, eventDate: event.date, action: 'open-calendar', timing: 'event' }
            });
        });
    }

    async removeLegacyReminders() {
        if (!isAndroid()) return false;
        const pending = await this.getPending();
        const ids = pending.filter(n => ['deadline', 'habit', 'streak', 'test'].includes(n.extra?.type) || (n.extra?.type === 'calendar' && n.extra?.timing !== 'event')).map(n => n.id);
        return ids.length ? this.cancelMultiple(ids) : true;
    }

    // Compatibility entry points cannot create non-calendar system notifications.
    async scheduleGoalDeadline() { return false; }
    async scheduleHabitReminders() { return false; }
    async scheduleStreakAlert() { return false; }
    async rescheduleAllHabits() { return false; }
    async cancelGoalDeadline() { return this.removeLegacyReminders(); }

    async sendTestNotification() {
        if (!isAndroid()) return false;
        this.lastError = '';
        if (!await this.init()) return false;
        if (!await this.checkPermissions() && !await this.requestPermissions()) { this.lastError = 'Разрешите уведомления Календаря в Android и повторите проверку.'; return false; }
        this.exactAllowed = (await this.native.checkExactNotificationSetting()).exact_alarm === 'granted';
        if (!this.exactAllowed) {
            this.lastError = 'Разрешите точное время кнопкой ниже, затем повторите проверку.';
            this.updateSettingsUI(); return false;
        }
        if (!this.app.settings.notifications || !this.app.settings.calendarReminders) { this.lastError = 'Включите уведомления Календаря в настройках приложения.'; return false; }
        return this.schedule({ id: 9999, title: 'Календарь: Напоминание', body: 'Тест уведомления Календаря', schedule: { at: new Date(Date.now() + 3000) }, extra: { type: 'calendar_test', action: 'open-calendar' }, requireExact: true });
    }

    async rescheduleAll() {
        if (!isAndroid()) return false;
        if (this._rescheduling) { this._rescheduleAgain = true; return this._rescheduling; }
        this._rescheduling = this.rescheduleCalendar().finally(() => {
            this._rescheduling = null;
            if (this._rescheduleAgain) { this._rescheduleAgain = false; this.rescheduleAll().catch(() => {}); }
        });
        return this._rescheduling;
    }

    async rescheduleCalendar() {
        if (!isAndroid() || !await this.init()) return false;
        await this.removeLegacyReminders();
        const events = [];
        for (const [date, notes] of Object.entries(this.app.notes || {})) {
            for (const note of Array.isArray(notes) ? notes : []) events.push({ ...note, title: note.content, date });
        }
        events.push(...(this.app.events || []));
        const activeIds = new Set(events.filter(event => event.date && event.time).map(event => event.id));
        const pending = await this.getPending();
        const obsolete = pending.filter(n => n.extra?.type === 'calendar' && (!activeIds.has(n.extra.eventId) || !this.app.settings.notifications || !this.app.settings.calendarReminders)).map(n => n.id);
        if (obsolete.length) await this.cancelMultiple(obsolete);
        let scheduled = 0;
        for (const event of events) if (await this.scheduleCalendarEvent(event, { requestPermission: false })) scheduled++;
        return { calendar: scheduled };
    }

    async cancelAll() {
        await Promise.allSettled([...(this.pendingSchedules || [])]);
        if (!isAndroid()) return false;
        const pending = await this.getPending();
        const ids = pending.filter(n => ['calendar', 'calendar_test', 'deadline', 'habit', 'streak', 'test'].includes(n.extra?.type)).map(n => n.id);
        return ids.length ? this.cancelMultiple(ids) : true;
    }

    handleNotificationClick(result) {
        if (!isAndroid() || !this.app) return;
        const extra = result.notification?.extra || {};
        if (!['calendar', 'calendar_test'].includes(extra.type)) return;
        this.app.switchView('calendar');
        if (extra.eventDate) this.app.selectCalendarDate(extra.eventDate);
    }
}
window.NotificationManager = NotificationManager;
})();
