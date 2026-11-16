# NCD: iOS, Xcode и TestFlight

## Что подготовлено и что ещё нужно проверить

- Capacitor 8.5.3, bundle identifier **com.ncd.app**, display name **NCD**.
- Нативный SPM-проект: `ios/App/App.xcodeproj`, схема `App`, iOS 15+.
- `ios:sync` собирает веб-ресурсы и выполняет `cap sync ios`.
- `ios:open` синхронизирует и открывает Xcode.
- `ios:build` на macOS синхронизирует проект и создаёт Release-архив
  `ios/App/build/NCD.xcarchive`. Подписание и экспорт выполняются через Xcode.
- Для iPhone нужна подписанная **IPA** или установка через TestFlight. APK на iOS не работает.

В текущей Linux-среде `npx cap add ios` был запущен, но завершился ошибкой:
не установлен `@capacitor/ios`; попытка установки получила `ENOTFOUND registry.npmjs.org`.
Поэтому Xcode-проект извлечён из официального `ios-spm-template.tar.gz` локального
Capacitor CLI 8.5.3, затем идентификатор и имя настроены штатной функцией CLI.
Зависимость добавлена в package.json и lockfile; её загрузка и полная синхронизация
плагинов здесь **не выполнены**. Не открывайте этот исходный шаблон как готовый релиз:
сначала выполните `npm ci` и `npm run ios:sync` на Mac.

`npm run build:web` и тесты хранилища, Health Connect fallback, тем и OTA прошли.
Тест Preferences моделирует iOS без Android API и сети: запись, повторное открытие,
изоляция аккаунта и сохранность прежних данных при ошибке записи.
Это не проверка реального UserDefaults/WKWebView. Визуальная и touch-проверка не
выполнена: среда запрещает сокеты HTTP-сервера и запуск Chrome; Xcode здесь отсутствует.
Нативная сборка, подписание и проверка на iPhone 15 остаются обязательными шагами ниже.

Полный `npm test` выявил ошибки `calendar-agenda`, `custodian`, `goal-modal` и
`profile-store`. Для последнего отсутствовала временная папка `/tmp/opencode`;
после её создания тест прошёл. Остальные три требуют отдельного исправления:
ожидаемая дата календаря зависит от текущего дня, savings fixture получает null,
приоритет подцели — medium вместо high. Они также воспроизводятся на копии
app.js без добавленных iOS-изменений. Полный набор тестов не является зелёным.

## 1. Подготовка Mac

1. Установите совместимую macOS и **Xcode 26+** для Capacitor 8.
   В Xcode → Settings → Components установите iOS Simulator runtime.
2. Запустите Xcode, примите лицензию и дождитесь установки компонентов.
   В Settings → Locations выберите Command Line Tools текущего Xcode.
3. Установите Node.js 22+ и npm. Проверьте `node -v`, `npm -v`, `xcodebuild -version`.
4. Для TestFlight нужна оплаченная Apple Developer Program, доступ к команде,
   сертификатам и App Store Connect. В Xcode → Settings → Accounts добавьте Apple Account.
5. Скопируйте весь проект, включая `ios`, исходные веб-файлы, `assets`, `vendor`
   и lockfile. Не переносите Linux `node_modules`.

```sh
npm ci
npm run ios:sync
npm run ios:open
```

SPM-зависимости генерируются Capacitor при sync; Xcode загружает их при открытии.
CocoaPods для этого проекта не требуется. Не запускайте `cap add ios` повторно,
если папка `ios` уже есть: это команда первоначального создания платформы.
Если sync сообщает о неподдерживаемом SPM-плагине, сначала разберите ошибку;
не удаляйте ios с пользовательскими настройками. Установленные Preferences,
LocalNotifications и Capgo должны присутствовать в итоговых зависимостях проекта.
Не пропускайте ошибки `cap sync`.

## 2. Настройки Xcode

1. Откройте `ios/App/App.xcodeproj` (SPM), выберите target **App**.
2. General: Display Name `NCD`, Bundle Identifier `com.ncd.app`, Version `1.3.39`
   или актуальная версия продукта. Build увеличивайте при каждой загрузке в TestFlight.
3. Signing & Capabilities: включите Automatically manage signing и выберите Team.
   Зарегистрируйте explicit App ID `com.ncd.app` в своей команде.
   Если идентификатор занят другой командой, потребуется доступ к владельцу;
   локальная конфигурация не резервирует идентификатор у Apple.
4. Проверьте AppIcon (1024×1024 без прозрачности), launch screen, deployment target,
   orientations и список устройств. Шаблон также поддерживает iPad; для выпуска
   только на iPhone выберите iPhone в Supported Destinations/Devices и перепроверьте архив.
5. В App target → Build Phases → Copy Bundle Resources должен быть
   `PrivacyInfo.xcprivacy`. Для Preferences указан UserDefaults reason `CA92.1`.
   Это декларация доступа API, не полная декларация обработки данных:
   перед публикацией сверьте privacy manifest и App Privacy с фактическими
   облачной синхронизацией, профилем и сторонними SDK. Проверьте Privacy Report архива.
6. Не добавляйте HealthKit capability: iOS HealthKit-интеграция сейчас не реализована.

Android сохраняет существующий `applicationId` в Gradle. Изменение общего `appId`
не мигрирует Android-профили и не меняет идентификатор уже установленного APK.

## 3. Проверка iPhone 15

Выберите iPhone 15 Simulator (при необходимости создайте его в Devices and Simulators)
и нажмите Run. Затем повторите ключевые сценарии на физическом iPhone 15.
Для устройства включите Developer Mode, подключите и подтвердите доверие Mac.

Чек-лист; отмечайте только после фактического выполнения:

- [ ] Портрет 393×852 CSS px и альбомная ориентация: все разделы, длинные цели,
  календарь, финансы, профиль; нет горизонтального скролла и обрезанных действий.
- [ ] Dynamic Island/status bar не закрывает заголовки; home indicator не закрывает
  нижнее меню, кнопки модальных окон; в landscape учтены боковые safe-area.
- [ ] Touch: вкладки, создание/редактирование цели, чек-лист, селекты, диалоги,
  прокрутка и закрытие окна работают без наведения мыши.
- [ ] Откройте клавиатуру в авторизации, редактировании цели/профиля и финансовом вводе.
  Поле и действия доступны после прокрутки; при закрытии клавиатуры меню возвращается.
  Повторите в landscape, с предиктивной строкой и аппаратной клавиатурой.
- [ ] Тёмная и светлая темы: текст, системные поля, селекты, модальные окна,
  статус-бар читаемы; переключение и повторный запуск сохраняют выбранную тему.
- [ ] Создайте цель/подцель/событие/финансовую запись, дождитесь сохранения,
  закройте приложение полностью и откройте снова без сети. Данные остались.
- [ ] Установите следующую сборку поверх предыдущей с тем же bundle ID и Team:
  профиль и данные остались. Не удаляйте приложение для этого теста.
- [ ] В авиарежиме доступны локальные функции, шрифтовой fallback и встроенные
  ресурсы. Облачная авторизация/синхронизация закономерно требуют сети.
- [ ] Вход/выход и смена аккаунта не показывают данные другого аккаунта.
- [ ] Health Connect и Android-разрешения не вызываются; нет Not implemented
  или ReferenceError в Safari Web Inspector. Android-only функции недоступны.
- [ ] Проверка обновлений на iOS предлагает TestFlight/App Store, не ZIP/APK.

Safe-area учитывается CSS при `ios.contentInset: 'never'`; viewport-fit=cover уже
включён. `ios-layout.js` использует VisualViewport, ограничивает модальные окна
видимой областью и прокручивает активный ввод при открытой клавиатуре.
На iOS размер шрифта ввода не меньше 16px, чтобы избежать автоматического zoom.
Поведение настоящей клавиатуры и значения env(safe-area-inset-*) подтверждаются
только WKWebView на симуляторе/устройстве, не Node-тестами.

Данные профиля сохраняются через Capacitor Preferences (UserDefaults на iOS),
зеркало — localStorage. Некоторые локальные настройки и health-кэш используют
localStorage. Это не зашифрованное хранилище и не резервная копия: перед удалением
приложения сделайте экспорт/облачную синхронизацию. Удаление приложения может
удалить локальные данные. Android Health Connect и системные напоминания сейчас
реализованы только для Android; наличие LocalNotifications в проекте не означает
готовые iOS-напоминания. На iOS автоматическая установка общих OTA-бандлов отключена.

## 4. Release-архив и подписанная IPA

После проверки и настройки подписи:

```sh
# Team можно сохранить в Xcode или передать переменной:
IOS_TEAM_ID=YOUR_TEAM_ID npm run ios:build
open ios/App/build/NCD.xcarchive
```

Команда создаёт архив, а не готовую IPA. Либо в Xcode выберите **Any iOS Device
(arm64)** и **Product → Archive**. Simulator-сборка не подходит для публикации.
В Organizer выберите архив → Validate App → устраните ошибки подписи, ресурсов,
privacy и версий. Для отдельного файла IPA используйте Distribute App и подходящий
вариант экспорта вашей версии Xcode. Метод подписи должен соответствовать каналу:
Development/Ad Hoc для разрешённых устройств, App Store Connect для распространения
через Apple. Неподписанный архив или переименованный APK не устанавливается на iPhone.
Сертификаты и provisioning profiles не храните в репозитории.

## 5. Публикация в TestFlight

1. В App Store Connect → My Apps → New App: iOS, имя NCD, основной язык,
   bundle ID **com.ncd.app**, уникальный SKU. Выберите нужную команду и доступ.
2. Organizer → Distribute App → **App Store Connect → Upload**; используйте
   автоматическое управление подписью, проверьте Team, bundle ID, Version и Build.
   Для внешнего тестирования не выбирайте режим только внутренних тестировщиков.
3. Дождитесь обработки сборки в App Store Connect. При ошибках откройте сообщения
   обработки, исправьте проект, увеличьте Build и загрузите новый архив.
4. Во вкладке TestFlight выберите сборку, заполните export compliance по фактическому
   использованию шифрования, описание тестирования, контакт и необходимые сведения.
5. Internal Testing: создайте группу пользователей команды и добавьте сборку.
6. External Testing: заполните Beta App Review Information, при необходимости
   предоставьте тестовый аккаунт и инструкции входа; отправьте на Beta App Review.
   После одобрения пригласите внешних тестировщиков или включите публичную ссылку.
7. На iPhone установите TestFlight из App Store, примите приглашение и установите NCD.
   Выполните чек-лист выше именно на загруженной сборке. При обновлениях увеличивайте
   Build, повторяйте Archive/Upload и регрессию сохранности данных.

Для последующего App Store-релиза отдельно подготовьте metadata, screenshots,
privacy policy URL, App Privacy, возрастной рейтинг и отправку на App Review.

## Официальные источники

- [Capacitor iOS](https://capacitorjs.com/docs/ios)
- [Capacitor 8: окружение, Xcode и SPM](https://capacitorjs.com/docs/getting-started/environment-setup)
- [Preferences и privacy manifest](https://capacitorjs.com/docs/apis/preferences)
- [Apple: требования Xcode/macOS](https://developer.apple.com/xcode/system-requirements)
- [Apple: загрузка сборок](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)
- [Apple: TestFlight](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)
