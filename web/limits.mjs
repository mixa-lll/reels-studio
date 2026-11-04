// Сколько работы Claude идёт одновременно (handbook/LEAN.md, кусок 16) — одно место на всё.
// Ходы `claude -p` (веб, План, мини-приложение и бот вместе) и рендеры Remotion (веб и бот вместе):
// сверх лимита задача ждёт «в очереди · N», чтобы Мак не лёг. Переопределяется переменными окружения.
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);
export const LIMITS = {
  claude: num(process.env.REELS_MAX_CLAUDE, 3),
  render: num(process.env.REELS_MAX_RENDER, 2),
};
