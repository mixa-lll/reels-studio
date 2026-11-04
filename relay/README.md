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
