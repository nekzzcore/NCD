// Статус локального профиля и явно настроенной синхронизации. Облачного аккаунта нет.
(function () {
    'use strict';
    function getApp() {
        return typeof window.app?.getSyncBase === 'function' ? window.app : null;
    }
    const AuthSync = {
        refreshAll() {
            const configured = !!getApp()?.getSyncBase();
            document.querySelectorAll('[data-auth-sync-status]').forEach(element => {
                element.textContent = configured
                    ? 'Локальный профиль · Сервер синхронизации настроен'
                    : 'Локальный профиль · Только на этом устройстве';
            });
        },
        bind() {
            document.querySelectorAll('[data-auth-sync-now]').forEach(button => {
                if (button.dataset.bound) return;
                button.dataset.bound = 'true';
                button.addEventListener('click', () => getApp()?.syncData(false));
            });
            AuthSync.refreshAll();
        }
    };
    window.AuthSync = AuthSync;
    document.addEventListener('DOMContentLoaded', AuthSync.bind);
    document.addEventListener('goaltracker:profile-rendered', AuthSync.bind);
})();
