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
