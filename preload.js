const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    showNotification: (title, body) => {
        ipcRenderer.send('show-notification', { title, body });
    },
    getSyncPin: () => ipcRenderer.invoke('get-sync-pin'),
    readAuthSession: key => ipcRenderer.invoke('read-auth-session', key),
    writeAuthSession: (key,value) => ipcRenderer.invoke('write-auth-session', key,value),
    readProfile: () => ipcRenderer.invoke('read-profile'),
    readLegacyProfile: () => ipcRenderer.invoke('read-legacy-profile'),
    writeProfile: data => ipcRenderer.invoke('write-profile', data),
    clearProfile: data => ipcRenderer.invoke('clear-profile', data),
    readAccountData: identity => ipcRenderer.invoke('read-account-data', identity),
    writeAccountData: (identity, data) => ipcRenderer.invoke('write-account-data', identity, data),
    platform: process.platform
});
