// Produce an Xcode archive. Signing/export is configured in Xcode Organizer.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
if (process.platform !== 'darwin') {
    console.error('iOS requires macOS + Xcode 26+. See IOS_BUILD.md. No IPA was created.');
    process.exit(1);
}
const root = path.resolve(__dirname, '..');
function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
    if (result.error) { console.error(result.error.message); process.exit(1); }
    if (result.status !== 0) process.exit(result.status || 1);
}
run('npm', ['run', 'ios:sync']);
run('xcodebuild', ['-project', 'ios/App/App.xcodeproj', '-scheme', 'App',
    '-configuration', 'Release', '-destination', 'generic/platform=iOS',
    '-archivePath', 'ios/App/build/NCD.xcarchive', '-allowProvisioningUpdates',
    ...(process.env.IOS_TEAM_ID ? [`DEVELOPMENT_TEAM=${process.env.IOS_TEAM_ID}`] : []), 'archive']);
console.log('Archive: ios/App/build/NCD.xcarchive. Open it in Xcode Organizer to validate and distribute.');
