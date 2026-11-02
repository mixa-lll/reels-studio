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
  кодом и мёртвым сокетом) — смени имя в `idFromName('mac-v2')` на следующее и перезапусти агент.
