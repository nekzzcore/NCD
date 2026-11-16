# Сборка NCD для Android

Capacitor уже подключён: `@capacitor/core`, `@capacitor/cli` и `@capacitor/android`
версии 8.5.3. Проект инициализирован, платформа находится в `android/`,
веб-файлы берутся из `www/` (`capacitor.config.ts`).
Повторно выполнять `cap init` и `cap add android` в этом проекте не нужно:
в Android-проекте уже есть Health Connect и другие нативные плагины.

Текущий ID — `com.sayonara.goaltracker`, название — **NCD**.
`com.ncd.app` будет отдельным приложением с отдельным хранилищем Android,
а не обновлением установленного NCD.

## Требования

- Node.js 22+ и зависимости проекта (`npm ci` на новом компьютере).
- Android Studio 2025.2.1+ либо Android SDK с Platform 36 и подходящими Build Tools.
- JDK 21; в Android Studio выберите его в настройке **Gradle JDK**.
- Для CLI задайте `JAVA_HOME` и путь SDK через `ANDROID_HOME` либо `android/local.properties`.
  Например: `sdk.dir=/absolute/path/to/Android/Sdk` (путь зависит от компьютера).

Требования Capacitor: [официальная документация](https://capacitorjs.com/docs/getting-started/environment-setup).
В этом проекте `minSdkVersion = 26` (Android 8+) из-за Health Connect.

## Через Android Studio

Из корня проекта:

```bash
npm run android:open
```

Команда собирает веб-часть, выполняет `cap sync android` и открывает существующий
проект в Android Studio. Если автоматическое открытие IDE недоступно, выполните
`npm run android:sync`, затем откройте папку `android/` вручную.

Дождитесь Gradle Sync, выберите **Build → Build APK(s)** (в некоторых версиях
**Build → Generate App Bundles or APKs → Generate APKs**).
Debug APK: `android/app/build/outputs/apk/debug/app-debug.apk`.

## Через CLI (Linux/macOS/Git Bash)

```bash
npm run android:build
```

Команда выполняет веб-сборку, синхронизацию Capacitor и
`./gradlew --no-daemon --max-workers=2 assembleDebug`.
APK создаётся в `android/app/build/outputs/apk/debug/app-debug.apk` и копируется
в `dist/NCD-<версия>.apk` (сейчас `dist/NCD-1.3.39.apk`).
Скрипт уважает `JAVA_HOME` и `ANDROID_HOME`; на текущем компьютере также умеет
использовать `~/jdk-21.0.2` и `~/android-sdk`, если переменные не заданы.

Для Windows PowerShell:

```powershell
npm run android:sync
cd android
.\gradlew.bat --no-daemon --max-workers=2 assembleDebug
```

Это debug APK для локальной установки. Для распространения подписанного релиза
в Android Studio используйте **Build → Generate Signed App Bundle / APK → APK**
и существующий ключ подписи, если это обновление установленного приложения.

После изменения HTML/CSS/JS перед новой сборкой снова выполните `android:sync`
или воспользуйтесь `android:build` / `android:open`, которые делают это сами.
Обычная сборка содержит локальные веб-файлы и не зависит от dev-сервера.
Live Reload для разработки описан в [MOBILE_DEV.md](MOBILE_DEV.md).

Официальный порядок: [веб-сборка → sync → нативная сборка](https://capacitorjs.com/docs/basics/workflow).
