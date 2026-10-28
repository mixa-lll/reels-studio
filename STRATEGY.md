# Strategy and plan

How the agent keeps a project's strategy and plan in the web studio. Both are plain JSON
files in the project folder; the page draws the Strategy tabs, the rubrics in the sidebar
and the Calendar from them. Change only what the request is about and keep other fields.

## strategy.json — where, what about, how often

```json
{
  "platforms": [{"id": "ig-ru", "name": "Instagram RU", "account": "@…", "audience": "who reads it",
    "lang": "русский · цены в ₽", "time": "19:00–21:00",
    "formats": [{"kind": "reel|photo|carousel|text|story", "spec": "9:16 · 15–20 с", "note": "…", "perWeek": 4}],
    "memory": ["what works here, learned from results and the owner's edits"]}],
  "rubrics": [{"id": "money", "name": "Деньги и выбор", "color": "#22A55B", "share": 25,
    "why": "why people save it", "about": "topics", "look": "how it looks",
    "rules": [{"text": "Цены с датой и источником", "lock": true}], "series": ["Чек: сколько стоит"],
    "approve": {"name": "Марина", "note": "директор, неделя по пятницам"}}],
  "rhythm": {"season": "Запись на смены", "slots": [{"day": 3, "time": "19:00", "rubric": "money", "platform": "ig-ru", "kind": "reel"}]},
  "events": [{"date": "2026-11-05", "title": "День открытых дверей"}],
  "voice": {"about": "how the project speaks", "never": ["what we never say"],
    "styles": [{"name": "Тёплый", "when": "жизнь, люди", "sample": "a line in this style"}]}
}
```

- `share` is the rubric's percent of the plan; the slots of the rhythm should roughly match it (the page shows the balance).
- `day` is 1 (Monday) … 7 (Sunday). Each slot becomes an empty place in the Calendar until something fills it.
- Rubric colours stay stable once chosen: colour means rubric everywhere in the interface; the icon means the format.
- 🔒 rules (`lock: true`) hold for every reel and post of the rubric.
- `voice` is the project's voice and 3–4 text styles; post variants are written in these styles (Settings › Голос и стили).
- `approve` names who approves the rubric's week by a link (no account, no sign-in); the team page lists them under the table.

## plan.json — what goes when

```json
{"at": {"reel:13-gudauri-prices-en-2": "2026-11-05T19:00", "post:02-first-day": "2026-11-06T12:00"},
 "rubric": {"reel:13-gudauri-prices-en-2": "money"}}
```

Keys are `reel:<folder>` or `post:<folder>`. The page writes here when someone drags an item to a day; the agent writes here when it plans the week. When asked to fill an empty slot, suggest an idea from `ideas.md` or a reel/post in work that fits the slot's rubric and format.
