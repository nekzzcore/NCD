const { app, BrowserWindow, ipcMain, Notification, safeStorage } = require('electron');
const path = require('path');
app.setName('NCD');
const { createProfileStore } = require('./profile-store');

// Стабильный каталог и в dev, и в установленной версии. Явный CLI-путь сохраняем.
if (!app.commandLine.hasSwitch('user-data-dir')) {
    app.setPath('userData', path.join(app.getPath('appData'), 'goaltracker-pro'));
}
const profileStore = createProfileStore(app.getPath('userData'), [
    path.join(app.getPath('userData'), 'data.json'),
    path.join(__dirname, 'data.json')
]);
// Session backups live beside the profile, outside renderer caches and web updates.
ipcMain.handle('read-auth-session', (_event,key) => {
    const stored = profileStore.readAuth(key);
    if (stored?.startsWith('encrypted:')) return safeStorage.decryptString(Buffer.from(stored.slice(10),'base64'));
    return stored;
});
ipcMain.handle('write-auth-session', (_event,key,value) => {
    const stored = value !== null && safeStorage.isEncryptionAvailable() ? 'encrypted:' + safeStorage.encryptString(value).toString('base64') : value;
    profileStore.writeAuth(key,stored);
});
ipcMain.handle('read-profile', () => profileStore.read());
ipcMain.handle('read-legacy-profile', () => profileStore.readLegacy());
ipcMain.handle('write-profile', (_event, data) => profileStore.write(data));
ipcMain.handle('clear-profile', (_event, data) => profileStore.clear(data));
ipcMain.handle('read-account-data', (_event, identity) => profileStore.readAccount(identity));
ipcMain.handle('write-account-data', (_event, identity, data) => profileStore.writeAccount(identity, data));

let mainWindow;
let serverStarted = false;

// Код доступа к серверу синхронизации (для автозаполнения в приложении)
ipcMain.handle('get-sync-pin', () => {
    try {
        return require('./server').getPin();
    } catch {
        return '';
    }
});

// Сервер синхронизации для телефона
let serverInstance = null;
function startServer() {
    return new Promise((resolve) => {
        try {
            const { start } = require('./server');
            serverInstance = start(8000);
            // Ждём события listening
            serverInstance.once('listening', () => {
                console.log('[sync] сервер запущен на порту 8000');
                resolve(serverInstance);
            });
            serverInstance.once('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    console.log('[sync] порт 8000 занят — сервер уже запущен');
                    // Сервер уже запущен, считаем что готово
                    resolve(serverInstance);
                } else {
                    console.log('[sync] ошибка сервера:', err.message);
                    resolve(null);
                }
            });
        } catch (e) {
            console.log('[sync] сервер не запущен:', e.message);
            resolve(null);
        }
    });
}

async function createWindow() {
    mainWindow = new BrowserWindow({
        title: 'NCD',
        backgroundColor: '#020617',
        width: 1400,
        height: 900,
        minWidth: 900,
        minHeight: 600,
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        titleBarStyle: 'hiddenInset',
        show: false
    });

    // Electron already serves its assets locally. An old PWA worker can keep
    // serving an earlier auth bundle even after the source files were updated.
    // Clear only worker/script caches; preserve profiles, tokens and IndexedDB.
    try {
        await mainWindow.webContents.session.clearStorageData({
            origin: 'http://localhost:8000',
            storages: ['serviceworkers', 'cachestorage']
        });
    } catch (error) {
        console.warn('[startup] Could not clear obsolete web asset cache:', error.message);
    }
    // Загружаем через локальный сервер (не file://) чтобы API работало
    mainWindow.loadURL('http://localhost:8000');

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(async () => {
    await startServer();
    serverStarted = true;
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Handle notifications from renderer
ipcMain.on('show-notification', (event, { title, body }) => {
    if (Notification.isSupported()) {
        new Notification({ title, body, icon: path.join(__dirname, 'icon.png') }).show();
    }
});

// Handle deep links (goaltracker://)
app.setAsDefaultProtocolClient('goaltracker');

app.on('open-url', (event, url) => {
    event.preventDefault();
    if (mainWindow) {
        mainWindow.webContents.send('deep-link', url);
    }
});
