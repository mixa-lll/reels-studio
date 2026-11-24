# Relay: reels.mygudauri.org → студия на Маке

Мак нельзя открыть снаружи (домашний роутер, туннели Cloudflare в сети заблокированы), поэтому он сам
держит исходящий WebSocket к Worker'у на Cloudflare — как бот с Telegram. Запрос браузера идёт в Worker,
по сокету на Мак, там в `web/server.mjs` (127.0.0.1:PORT), ответ потоком обратно.

- `worker.js` — Worker `reels-relay` + Durable Object `Relay`, маршрут `reels.mygudauri.org/*`.
  Выкладка: `npx wrangler deploy` в этой папке. Секрет: `RELAY_SECRET` (`wrangler secret put`).
- `agent.mjs` — сторона Мака, читает `RELAY_SECRET` и `PORT` из `../.env`; автозапуск
  `deploy/mac/com.reels-relay.plist` (launchd), лог `data/relay.log`.
- Мак выключен или спит → Worker отдаёт страницу «Мак сейчас не на связи».
- Локальная проверка: `wrangler dev --port 8787 --local` (+ `.dev.vars`), агент с `RELAY_URL=ws://localhost:8787/__relay`.
- Короткие обрывы сокета: Worker ждёт Мак до 15 с, страница «не на связи» обновляется сама каждые 5 с;
  агент переподключается через 0,3 с (потом до 10 с), пинг каждые 15 с.
- Ответ «не на связи» несёт заголовок `x-relay` с причиной (`no-socket`, `send-failed`, `timeout`, `fail-all:…`).
- Если после `wrangler deploy` поведение старое (2 нояб.: старый экземпляр Durable Object жил со старым
  кодом и мёртвым сокетом) — смени имя в `idFromName('mac-v3')` на следующее и перезапусти агент.

## Один бот на несколько студий (диспетчер, 4 нояб.)

Telegram отдаёт обновления бота только одному читателю, поэтому две студии с одним ключом мешали
друг другу (409). Теперь бот работает через вебхук: Telegram → `https://reels.mygudauri.org/__tg` →
Worker → `Router` (чей человек) → `TgQueue` нужной студии → её бот по сокету `/__tgsocket`.

- Студии — секрет `NODES`: `{"misha": {"secret", "host": "reels.mygudauri.org", "name": "Миши", "default": true, "users": []}, "seva": {..., "host": "seva.reels.mygudauri.org", "users": [tg id Севы]}}`.
  Ещё секреты: `TG_WEBHOOK_SECRET` (его же — `secret_token` в `setWebhook`), `TELEGRAM_BOT_TOKEN` (для «компьютер не на связи»).
- Кто чей: ссылка `t.me/<бот>?start=<node>--<что-угодно>` закрепляет человека за студией (приглашения и ссылка
  владельца из панели такие сами, если в `.env` есть `TG_RELAY` и `RELAY_NODE`); `?start=<node>--` — просто переключить.
  Иначе — по `users` в `NODES`, иначе студия по умолчанию.
- Компьютер спит → обновления ждут в `TgQueue` (до подтверждения ботом), человек один раз в полчаса получает «не на связи».
- Студия на компьютере: в `.env` `TG_RELAY=wss://reels.mygudauri.org/__tgsocket`, `RELAY_NODE=<node>`, `RELAY_SECRET=<её secret>`,
  `MINIAPP_URL=https://<её host>/app`; агент `relay/agent.mjs` (launchd) — для веба. Бот в этом режиме не вызывает getUpdates.
- Новый host (например `seva.reels.mygudauri.org`) — DNS-запись в зоне mygudauri.org (proxied) + маршрут в `wrangler.jsonc`.
- Вернуть старый режим (одна студия, опрос): `deleteWebhook`, убрать `TG_RELAY` из `.env`, перезапустить бота.

## Несколько компьютеров одного владельца (#142)

Устройства владельца — узлы с одинаковым `owner` и одним `host`:
`{"misha-macbook": {"secret", "host": "reels.mygudauri.org", "name": "MacBook", "owner": "misha", "default": true}, "misha-imac": {"secret", "host": "reels.mygudauri.org", "name": "iMac", "owner": "misha"}}`.

- **Веб.** Worker выбирает студию по cookie `device`. Её ставит `/?device=<node>` (302 без параметра; студия открывает
  эту ссылку один раз после загрузки компьютера, если в её `.env` есть `DEVICE_NAME` и `RELAY_NODE`). Нет cookie —
  страница выбора с «на связи / спит». Выбранный спит, другой на связи — «iMac спит, открыть MacBook?» (только для
  страниц; запросы API, как раньше, ждут сокет до 15 с). `/__devices` — список для шапки студии. Вход у каждой студии
  свой: cookie `sid_<node>`, чтобы студии на одном адресе не выбивали друг друга.
- **Телеграм.** Бот каждого устройства подписывает свои сообщения («MacBook · v8 готова», `bot/device.mjs`) и сообщает
  их `message_id` в `POST /__tgsent?node=` (Bearer — секрет узла). Router хранит `m:<chat>:<id> → node` 90 дней: ответ
  или кнопка под сообщением уходят тому устройству. Остальное — на активное устройство владельца (`active:<owner>`: где
  последний раз открыли студию, или выбранное в `/device` — меню отвечает сам Worker). Активное спит, другое на связи —
  «MacBook спит. Отправить на iMac?», кнопка переносит ждущие сообщения из одной `TgQueue` в другую.
- **Проект.** Тексты — git-репозиторий проекта, медиа — R2 по хешу (`bot/sync.mjs`). Первый компьютер:
  `node scripts/sync-setup.mjs main <приватный репозиторий>`, второй: `node scripts/sync-setup.mjs --clone <репозиторий> main`.
  У обоих одинаковые `R2_*`; `OWNER_CODE` / владелец бота подтверждается на каждом (у каждого свой `data/state.json`).
- Добавить устройство, не переписывая `NODES` (секреты чужих узлов не прочитать): секрет `NODES_MORE` — те же поля поверх `NODES` по узлам, например `{"misha": {"owner": "misha", "name": "MacBook"}, "misha-2": {"secret", "host", "name", "owner": "misha"}}`.
- Локальная проверка: в `.dev.vars` `host` узлов — `reels.mygudauri.org` (wrangler dev подставляет host маршрута),
  `TG_API=http://127.0.0.1:<порт>` уводит ответы Worker'а в поддельный Телеграм.
- Открыто: второй компьютер — Мак или Windows (установка, автозапуск и `open` при старте сейчас только для macOS).
