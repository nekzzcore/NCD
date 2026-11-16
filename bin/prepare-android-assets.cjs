// Website APK/OTA downloads are generated distribution artifacts, not app assets.
// Remove them only from the generated Android copy; keep the website downloads.
const fs = require('node:fs');
const path = require('node:path');
fs.rmSync(path.join(__dirname, '..', 'android/app/src/main/assets/public/updates'), {
    recursive: true, force: true
});
console.log('Android web assets ready (website update archives excluded).');
