/* Manual OTA checks share the same updater as startup checks. */
(() => {
    'use strict';
    window.OTASync = Object.freeze({
        baseUrl: 'https://goaltracker-pro.nekzzcore.workers.dev',
        refresh() { return window.app?.checkForWebUpdate?.({ force:true }); }
    });
})();
