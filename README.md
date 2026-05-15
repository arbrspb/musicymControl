# MusicYM Control

MusicYM Control - неофициальный локальный пульт для веб-версии Яндекс Музыки.

Проект состоит из двух частей:

- `extension` - расширение Chrome, которое подключается к открытой вкладке Яндекс Музыки и передает команды плееру;
- `server` - локальный HTTP/WebSocket сервер, который связывает расширение и телефон через QR pairing.

## Отказ от ответственности

Проект не является официальным продуктом Яндекса, не связан с Яндексом и не одобрен Яндексом. Проект работает исключительно с открытой вкладкой Яндекс Музыки через локальный сервер. Проект не собирает никакую информацию, включая cookies или данные аккаунта.

Для работы проекта используется адаптированная копия API из [YmExternalAPI](https://github.com/Night-Soft/YmExternalAPI) автора Night-Soft. Код находится в папке `extension/externalAPI`.

В этой копии внесены локальные изменения для совместимости с актуальной веб-версией Яндекс Музыки и добавлена поддержка выбора вариантов `Моей волны` из телефонного пульта.

> "Это неофициальное API, которое может перестать работать при изменениях на стороне Яндекс Музыки." - Night-Soft

Использование и любые модификации проекта осуществляются на усмотрение пользователя; разработчик не несет ответственности за последствия изменения кода или стороннее использование.

## Возможности

- play/pause, предыдущий и следующий трек;
- выбор вариантов `Моей волны` с телефона;
- лайк и дизлайк текущего трека;
- перемотка текущего трека;
- управление громкостью с телефона;
- защита громкости от случайного нажатия по полоске: значение меняется только при перетаскивании бегунка;
- веб-пульт для телефона по QR-коду;
- список следующих треков с возможностью выбрать трек;
- защита кнопки `вперед`, когда Яндекс Музыка еще не подгрузила следующий трек;
- расширенная панель расширения в отдельном окне;
- debug-логирование в файл;
- автоматический выбор локального IP-адреса ПК с обходом VPN/виртуальных интерфейсов, насколько это возможно.

## Требования

- Windows для обычного запуска и сборки `.exe` или Linux/Ubuntu для серверного запуска;
- Node.js 20 или новее;
- Google Chrome 116 или новее;
- телефон и ПК в одной локальной сети;
- входящий доступ к порту сервера, по умолчанию `8099`.

## Структура проекта

```text
.
├── extension/          # Chrome extension
├── server/             # HTTP/WebSocket server для Windows и разработки
├── server_ubuntu/      # Копия сервера для запуска на Ubuntu
├── dist/               # Build artifacts, создается вручную
├── package.json
└── README.md
```

## Быстрый запуск

Если проект лежит в рабочей папке:

```powershell
cd "Ваш путь\server"
npm install
npm start
```

После запуска сервер покажет адреса:

```text
[server] local:  http://127.0.0.1:8099
[server] public: http://192.168.x.x:8099
[server] ws:     ws://192.168.x.x:8099/ws
```

`local` нужен расширению на этом же ПК. `public` нужен телефону в локальной сети.

## Установка расширения в Chrome

1. Откройте `chrome://extensions/`.
2. Включите режим разработчика.
3. Нажмите `Загрузить распакованное расширение`.
4. Выберите папку `extension`.
5. Откройте `https://music.yandex.ru/`.
6. Нажмите на иконку расширения.
7. Проверьте адрес сервера, обычно `http://127.0.0.1:8099`.
8. Создайте QR pairing.
9. Отсканируйте QR-код телефоном.

Если расширение перезагружалось или обновлялось, обновите вкладку Яндекс Музыки.

## Как пользоваться

1. Запустите сервер.
2. Откройте вкладку `music.yandex.ru` в Chrome.
3. Откройте popup расширения.
4. Создайте QR pairing.
5. Откройте пульт на телефоне через QR-код.

Расширение само не запускает серверный `.exe`. Сначала нужно запустить сервер, потом пользоваться расширением и телефоном.

### Если сервер запущен на другом устройстве

По умолчанию расширение уже разрешает подключение к `127.0.0.1` и `localhost`, то есть к серверу на том же ПК, где открыт Chrome.

Если сервер запущен на другом устройстве в локальной сети, например на Ubuntu-сервере, укажите его адрес в `extension/manifest.json` в разделе `host_permissions`.

Например, для сервера `192.168.1.120`:

```json
"http://192.168.1.120/*"
```

Если у вашего сервера другой IP-адрес, замените `192.168.1.120` на свой.

После изменения `manifest.json`:

1. Перезагрузите расширение в `chrome://extensions/`.
2. Обновите вкладку Яндекс Музыки.
3. В popup расширения укажите адрес того же сервера, например:

```text
http://192.168.1.120:8099
```

## Запуск сервера на Ubuntu

Для Ubuntu можно использовать папку `server_ubuntu`.

Пример размещения проекта:

```bash
/opt/musicym-control/server
```

Установка зависимостей и первый запуск:

```bash
cd /opt/musicym-control/server
npm install
npm start
```

Проверка состояния сервера:

```bash
curl http://127.0.0.1:8099/api/health
```

Ожидаемый ответ:

```json
{
  "ok": true
}
```

### Автозапуск через systemd

Создайте службу:

```bash
sudo nano /etc/systemd/system/musicym-control.service
```

Пример содержимого:

```ini
[Unit]
Description=MusicYM Control Server
After=network.target

[Service]
Type=simple
User=musicym
WorkingDirectory=/opt/musicym-control/server
ExecStart=/usr/bin/node /opt/musicym-control/server/ws_server.js
Restart=always
RestartSec=3
Environment=PUBLIC_HTTP_ORIGIN=http://192.168.1.120:8099

[Install]
WantedBy=multi-user.target
```

Если Node.js установлен через `nvm`, укажите в `ExecStart` полный путь к своему `node`, например:

```ini
ExecStart=/home/musicym/.nvm/versions/node/v20.x.x/bin/node /opt/musicym-control/server/ws_server.js
```

После создания службы:

```bash
sudo systemctl daemon-reload
sudo systemctl enable musicym-control
sudo systemctl restart musicym-control
sudo systemctl status musicym-control
```

Проверка после перезагрузки:

```bash
sudo reboot
```

После повторного входа:

```bash
sudo systemctl status musicym-control
curl http://127.0.0.1:8099/api/health
```

Если служба активна и `/api/health` отвечает `ok: true`, автозапуск работает.

## Debug и логирование

По умолчанию CLI-команды сервера отключены. Чтобы включить их при ручном запуске:

```powershell
$env:ENABLE_CLI="1"
npm start
```

После этого в серверной консоли доступны команды:

```text
help
debug on
debug off
heartbeat
stop
```

`debug on` включает подробный лог в файл `server.log`.

`debug off` выключает подробный лог.

`server.log` создается:

- при `npm start` - в папке сервера;
- у собранного `.exe` - рядом с `musicym-server.exe`.

Debug можно включать и выключать уже после запуска сервера. Для обычной сборки `.exe` специально указывать debug не нужно.

Если нужно включить debug сразу при запуске:

```powershell
$env:DEBUG="1"
npm start
```

По умолчанию debug пишет в файл, а не засыпает консоль. Если специально нужно дублировать debug в консоль:

```powershell
$env:DEBUG="1"
$env:DEBUG_CONSOLE="1"
npm start
```

Для собранного `.exe` аналогично:

```powershell
$env:DEBUG="1"
..\dist\musicym-server.exe
```

Если нужно, чтобы `server.log` у `.exe` появлялся рядом с `musicym-server.exe`, в `server/ws_server.js` используется такой путь:

```js
const appDir = process.pkg ? path.dirname(process.execPath) : __dirname;
const logFile = path.join(appDir, "server.log");
```

## Сборка сервера в exe

Из папки сервера:

```powershell
cd "Ваш путь\server"
npm install
npm install --save-dev @yao-pkg/pkg
New-Item -ItemType Directory -Force ..\dist
npx @yao-pkg/pkg .\ws_server.js --targets node20-win-x64 --output ..\dist\musicym-server.exe
```

Запуск готового сервера:

```powershell
..\dist\musicym-server.exe
```

Папка `node_modules` нужна только для разработки и сборки. Рядом с готовым `.exe` она не нужна.

Если при сборке появляется ошибка:

```text
Property 'bin' does not exist in package.json
```

значит сборщик был запущен на папку `.`. Используйте команду с прямым указанием файла:

```powershell
npx @yao-pkg/pkg .\ws_server.js --targets node20-win-x64 --output ..\dist\musicym-server.exe
```

## Сборка zip расширения

Из корня проекта:

```powershell
cd "Ваш путь\musicym-control"
New-Item -ItemType Directory -Force .\dist
Compress-Archive -Path .\extension\* -DestinationPath .\dist\musicym-extension.zip -Force
```

Важно: внутри zip файл `manifest.json` должен лежать в корне архива, а не внутри дополнительной папки `extension`.

## Публикация расширения

Для публикации в Chrome Web Store:

1. Зарегистрируйте аккаунт в Chrome Developer Dashboard.
2. Соберите `dist/musicym-extension.zip`.
3. Увеличьте `version` в `extension/manifest.json`.
4. Загрузите zip в Chrome Developer Dashboard.
5. Заполните описание, иконки, скриншоты и privacy practices.
6. Укажите, что расширение требует локальный companion-сервер на ПК.
7. Укажите, что проект неофициальный и не связан с Яндексом.
8. Отправьте расширение на проверку.

Не используйте официальный логотип Яндекса или формулировки, из которых может казаться, что это официальный продукт.

## Расширенная панель

Файлы расширенной панели:

```text
extension/control.html
extension/control.js
```

Popup расширения:

```text
extension/popup.html
extension/popup.js
```

Открытие панели отдельным окном:

```js
chrome.windows.create({
  url: chrome.runtime.getURL("control.html"),
  type: "popup",
  width: 460,
  height: 720
});
```

## Частые проблемы

### Телефон пишет "ожидание pairing"

В `server.log` после открытия пульта с телефона должны появиться строки:

```text
New WebSocket connection established
handleHello from phone
Socket bound: role=phone
```

Если есть только:

```text
HTTP request: GET /remote
```

значит страница на телефоне открылась, но WebSocket не подключился.

Проверьте:

- телефон и ПК в одной сети;
- Windows Firewall не блокирует порт `8099`;
- QR создан после последнего запуска сервера;
- адрес в QR начинается с локального IP ПК, например `http://192.168.x.x:8099`;
- в мобильном браузере нет ошибки JavaScript.

### Расширение подключилось, а телефон нет

В логе будет:

```text
handleHello from extension
Socket bound: role=extension
```

но не будет `handleHello from phone`.

Проверьте сеть телефона, firewall и адрес в QR-коде.

### Телефон подключился, но трек не отображается

Проверьте:

- открыта ли вкладка `music.yandex.ru`;
- обновлена ли вкладка после перезагрузки расширения;
- не отключилось ли расширение в `chrome://extensions/`;
- нет ли ошибок content script в DevTools страницы Яндекс Музыки.

### Кнопка "вперед" временно не нажимается

Это нормальная защита. Иногда Яндекс Музыка еще не успевает подгрузить следующий трек. В этот момент команда `next` не отправляется, чтобы не сломать внутреннюю очередь плеера.

Как только следующий трек появится в состоянии плеера, кнопка снова станет доступной.

### Громкость на телефоне не меняется от нажатия по полоске

Так задумано. На странице телефона громкость меняется только если тянуть сам бегунок. Это сделано, чтобы случайный тап по полоске не делал звук резко тише или громче.

### После VPN выбран неправильный IP

Сервер пытается выбрать физический LAN-интерфейс. Если адрес выбран неверно, задайте public origin вручную.

Для разработки:

```powershell
$env:PUBLIC_HTTP_ORIGIN="http://192.168.1.100:8099"
npm start
```

Для `.exe`:

```powershell
$env:PUBLIC_HTTP_ORIGIN="http://192.168.1.100:8099"
..\dist\musicym-server.exe
```

Для Ubuntu-сервера значение можно задать в `systemd`-службе:

```ini
Environment=PUBLIC_HTTP_ORIGIN=http://192.168.1.120:8099
```

### После обновления расширения появились ошибки `Extension context invalidated`

Обычно это не критично. Такое бывает, когда Chrome перезагрузил расширение, а старая вкладка Яндекс Музыки еще держит старый content script.

Решение: обновить вкладку Яндекс Музыки.

## Что не добавлять в GitHub

Обычно не нужно коммитить:

```text
node_modules/
dist/
server/server.log
server_ubuntu/server.log
*.zip
*.exe
.env
```

Проверьте, что эти файлы указаны в `.gitignore`.

## Приватность и безопасность

Сервер рассчитан на локальную сеть. Не открывайте порт `8099` в интернет.
