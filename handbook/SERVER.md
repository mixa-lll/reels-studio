# Сервер студии (с 5 ноября 2026)

Студия и бот работают на сервере Timeweb Cloud, а не на Маке.

- Сервер: Diligent Crane, Нидерланды, 2 ядра, 4 ГБ памяти + 4 ГБ подкачки, 50 ГБ. Адрес `179.252.208.160`, на Маке алиас `ssh reels-server` (root) и `ssh -i ~/.ssh/id_ed25519_reels reels@179.252.208.160` (пользователь студии).
- Вход только по ключу `id_ed25519_reels`, пароль выключен, ufw пускает только 22.
- Код: `/home/reels/reels-studio` (копия репозитория), проект `projects/main` — настоящая папка, не ссылка.
- Службы systemd (пользователь `reels`): `reels-bot`, `reels-web` (127.0.0.1:8090), `reels-relay` (исходящий WebSocket к Worker `reels-relay`, `RELAY_NODE=misha`). Логи — `data/bot.log`, `data/web.log`, `data/relay.log`.
- reels.mygudauri.org идёт через тот же Worker-релей; DNS и туннели не нужны.
- Claude Code: `/home/reels/.local/bin/claude`, вошёл Миша своей подпиской.
- Remotion: `template/node_modules`, Chrome headless shell скачан `npx remotion browser ensure`.

## Как обновить

```sh
ssh reels@179.252.208.160 'cd ~/reels-studio && git pull'
ssh reels-server 'systemctl restart reels-web reels-bot'
```

Изменения веба выкатываются перезапуском только `reels-web`: Claude бота и его рендеры живут в группе `reels-bot` и не прерываются. Бота перезапускать, только когда он не занят (`pgrep -u reels -f "remotion|claude -p"`).

## Перенос с Мака

`/usr/local/bin/reels-fix-paths` — запускать после каждого rsync с Мака:
- переписывает пути Мака (`/Users/misha/…`) в `.env` и json-файлах `data/`, `projects/main` на серверные;
- восстанавливает у каждого рилса ссылку `project/node_modules` → `template/node_modules` (rsync идёт с `--exclude node_modules`, а ссылки Мака на сервере всё равно не работают).

## Бот только в одном месте

Один токен = один экземпляр, иначе 409 Conflict. На Маке launchd `com.reels-bot`, `com.reels-web`, `com.reels-relay` выключены (`launchctl disable`). Вернуть на Мак: `systemctl disable --now reels-bot reels-web reels-relay` на сервере, затем `launchctl enable` + `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist` на Маке.
