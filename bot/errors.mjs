// Explains an agent failure to the owner in plain words. Known cases get advice;
// anything else is shown as is, with the exit code, so nothing is hidden.

const RU = {
  head: '⚠️ Агент не смог выполнить задачу.',
  spawn: (bin) => `Не нашёл программу агента (\`${bin}\`). Похоже, она не установлена или путь в настройках устарел — попроси своего агента заново пройти SETUP.md.`,
  login: 'Агент не залогинен или ключ недействителен. Открой его на компьютере и войди заново (`claude` → /login, или `codex login`).',
  limit: (when) => `Закончился лимит подписки агента${when ? ` (сброс: ${when})` : ''}. Нажми «🔁 Повторить», когда лимит обновится.`,
  billing: 'На балансе API-аккаунта агента закончились деньги. Пополни баланс и нажми «🔁 Повторить».',
  network: 'Нет связи с серверами агента или они перегружены. Обычно проходит за пару минут — нажми «🔁 Повторить».',
  version: 'Версия агента устарела для выбранной модели. Обнови его (`npm i -g @anthropic-ai/claude-code` или `npm i -g @openai/codex`) и нажми «🔁 Повторить».',
  context: 'Разговор с агентом стал слишком длинным. Начинаю новую сессию — нажми «🔁 Повторить».',
  turns: 'Агент упёрся в лимит шагов за один ход. Нажми «🔁 Повторить» — он продолжит с того места.',
  unknown: 'Неизвестная ошибка.',
  details: 'Подробности',
  code: 'код',
  retry: '🔁 Повторить',
};
const EN = {
  head: '⚠️ The agent could not finish the task.',
  spawn: (bin) => `Could not find the agent program (\`${bin}\`). It is not installed or the configured path is stale — ask your agent to run SETUP.md again.`,
  login: 'The agent is not logged in or its key is invalid. Open it on the computer and log in again (`claude` → /login, or `codex login`).',
  limit: (when) => `The agent's plan limit is used up${when ? ` (resets: ${when})` : ''}. Tap «🔁 Retry» once it resets.`,
  billing: "The agent's API account is out of credit. Top it up and tap «🔁 Retry».",
  network: "Can't reach the agent's servers or they are overloaded. Usually gone in a few minutes — tap «🔁 Retry».",
  version: 'The agent is too old for the chosen model. Update it (`npm i -g @anthropic-ai/claude-code` or `npm i -g @openai/codex`) and tap «🔁 Retry».',
  context: 'The conversation with the agent got too long. Starting a new session — tap «🔁 Retry».',
  turns: 'The agent hit its step limit for one turn. Tap «🔁 Retry» and it continues from there.',
  unknown: 'Unknown error.',
  details: 'Details',
  code: 'code',
  retry: '🔁 Retry',
};

const RULES = [
  ['spawn', (r) => r.spawnError === 'ENOENT'],
  ['version', (r, t) => /requires a newer version|please upgrade|upgrade (codex|claude)|unsupported model/i.test(t)],
  ['billing', (r, t) => /credit balance|insufficient[_ ]quota|billing|payment required|402/i.test(t)],
  ['limit', (r, t) => /usage limit|limit reached|rate.?limit|hit your (usage )?limit|quota|429|too many requests/i.test(t)],
  ['login', (r, t) => /not logged in|please run \/login|log ?in again|invalid (api )?key|authentication|unauthori[sz]ed|\b401\b|\b403\b|oauth token/i.test(t)],
  ['context', (r, t) => /prompt is too long|context (length|window)|too many tokens|maximum context/i.test(t)],
  ['turns', (r, t) => /error_max_turns|max(imum)? turns/i.test(t)],
  ['network', (r, t) => /overloaded|\b5\d\d\b|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|network|stream (disconnected|error)|socket hang up|timed? ?out/i.test(t)],
];

/** True when the session id is unknown to the agent (deleted or from another machine). */
export const lostSession = (res) => /no conversation found|session .*not found|thread .*not found|unknown (session|thread)/i.test(`${res.text}\n${res.stderr ?? ''}`);

/** Returns {kind, text, retry}: the owner-facing explanation of a failed turn. */
export function explain(res, {lang, bin}) {
  const L = lang === 'en' ? EN : RU;
  const raw = `${res.text ?? ''}\n${res.stderr ?? ''}`.trim();
  const kind = RULES.find(([, test]) => test(res, raw))?.[0] ?? 'unknown';
  // Claude reports «…limit reached|<unix time>» or «resets 5pm»: show the reset time if present.
  const epoch = raw.match(/limit reached\|(\d{10})/)?.[1];
  const when = epoch ? new Date(Number(epoch) * 1000).toLocaleString(lang === 'en' ? 'en-GB' : 'ru-RU', {hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short'})
    : raw.match(/(?:resets?|try again) (?:at |in )?([^\n,;]{3,30}?)(?:\.|$)/im)?.[1];
  const advice = kind === 'spawn' ? L.spawn(bin) : kind === 'limit' ? L.limit(when) : L[kind];
  const detail = raw.split('\n').filter(Boolean).slice(-6).join('\n').slice(0, 700);
  const code = res.code ?? res.spawnError ?? '—';
  return {
    kind,
    text: `${L.head}\n${advice}\n\n${L.details} (${L.code} ${code}):\n\`\`\`\n${detail || '—'}\n\`\`\``,
    retry: L.retry,
  };
}
