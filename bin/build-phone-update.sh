#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Use an explicitly configured toolchain, then this workstation's local SDK/JDK.
if [[ -z "${JAVA_HOME:-}" && -d "$HOME/jdk-21.0.2" ]]; then
    export JAVA_HOME="$HOME/jdk-21.0.2"
fi
if [[ -z "${ANDROID_HOME:-}" && -d "$HOME/android-sdk" ]]; then
    export ANDROID_HOME="$HOME/android-sdk"
fi
npm run android:sync
(cd android && ./gradlew --no-daemon --max-workers=2 assembleDebug)
VERSION=$(node -p "require('./package.json').version")
mkdir -p dist
cp android/app/build/outputs/apk/debug/app-debug.apk "dist/NCD-${VERSION}.apk"
echo "Готово: dist/NCD-${VERSION}.apk — установить поверх существующего NCD."
