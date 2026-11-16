import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // Существующий Android сохраняет applicationId в android/app/build.gradle.
  appId: 'com.ncd.app',
  appName: 'NCD',
  webDir: 'www',
  server: {
    androidScheme: 'https'
  },
  ios: {
    contentInset: 'never', // Safe-area учитывается веб-версткой.
    backgroundColor: '#10131a'
  },
  android: {
    allowMixedContent: true,
    captureInput: true,
    webContentsDebuggingEnabled: false
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 0,
      launchAutoHide: true,
      launchFadeOutDuration: 0,
      fadeOutDuration: 0,
      backgroundColor: "#000000"
    },
    LocalNotifications: {
      smallIcon: "ic_stat_notification",
      iconColor: "#6366f1",
      sound: "beep.wav"
    },
    CapacitorUpdater: {
      autoUpdate: false,
      // Проверку /version.json выполняет app.js; загрузка через ручной API Capgo.

    }
  }
};

export default config;