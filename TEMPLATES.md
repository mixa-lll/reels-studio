# Rubric templates

A rubric can have a template (`"template": "check"` on the rubric in `strategy.json`; the
owner picks it in Strategy › Рубрики). A reel of that rubric is then **data, not code**: you
lay the material out by the template's scenes in `project/src/reel.json`, and the ready
components in `project/src/templates/` draw it. It is quicker than writing a reel, renders
the same way every time and keeps the rubric's look. A reel without a template (or a special
one the owner asks for) is still written by hand in `src/story.ts` / `src/Reel.tsx`.

The catalog — scene kinds and templates — is `template/src/templates/catalog.json`:

| template | scenes | for |
|---|---|---|
| `check` Чек | hook, base, item ×1–6, 🔒 total, 🔒 cta | prices, what is included |
| `morning` Утро | hook, photo ×3–8, 🔒 cta | life, mood, a day |
| `tips` 3 совета | hook, tip ×3–5, 🔒 cta | guides, how-to |
| `compare` Сравнение | hook, compare ×1–3, 🔒 total, 🔒 cta | A or B |
| `qa` Вопрос — ответ | question, answer ×1–3, 🔒 cta | frequent questions |
| `fact` Один факт | hook, fact, photo ×0–2, 🔒 cta | one number |
| `talk` Говорящая голова | clip ×1–6, 🔒 cta | a person talks; plates under the face |

## reel.json

```json
{"template": "check", "currency": "₽", "fps": 30,
 "theme": {"bg": "#0E0F12", "ink": "#FFFFFF", "accent": "#F5B700", "plate": "#FFFFFF", "plateInk": "#171717", "font": "Manrope"},
 "music": {"file": "music.mp3", "volume": 0.35},
 "scenes": [
  {"kind": "hook", "text": "Сколько стоит смена?", "media": {"file": "camp.jpg"}},
  {"kind": "base", "text": "Путёвка", "amount": 48000, "media": {"file": "camp2.jpg"}},
  {"kind": "item", "text": "Автобус туда и обратно", "amount": 3000, "media": {"file": "bus.jpg"}},
  {"kind": "clip", "text": "А это не входит", "media": {"file": "take.mp4", "from": 1.5}, "dur": 4},
  {"kind": "total"},
  {"kind": "cta", "text": "Сохрани, чтобы не потерять", "note": "ссылка в профиле"}
 ]}
```

- Material goes to `project/public/` (copy it from `sources/` or the inbox; convert HEIC to JPG, a talking-head take to MP4 with ffmpeg); `media.file` is its name there. `from` — second of a video to start at; `muted` — drop its sound; `fit: "contain"` — show a screenshot whole.
- `dur` — seconds of the scene; defaults by kind (hook 2, photo 3, clip 5, item 3, total 3, cta 2…). A clip lasts as long as the phrase in it.
- `text` — the plate (one short line); `note` — a smaller line under it. `place`: `top`, `middle`, `bottom` (default) or `under-face` (default for a person in frame). **Nothing over a face**: put plates on clips under the face or at the top.
- `total` sums the base and the items itself (or takes `amount`). `compare` has `a` and `b` (`label`, `amount`, `media`) and `win`.
- 🔒 scenes (`total`, `cta`) come from the rubric: the cta text from its rules or the last reel of the rubric; do not drop them.
- `theme`: take colors and font from the project's design system (`design-system/tokens.json`) when it has one; fonts: `Manrope` or `Unbounded`.

## Laying material out

1. Read the rubric (`strategy.json`) and its template's scenes; read every file the person sent.
2. Match material to scenes: the strongest picture to the hook, one photo per item, a take with speech to `clip`/`answer`. Repeatable scenes take as many as the material allows within the range.
3. Write `reel.json`. If a scene has no material, say which one and what it needs (the catalog's `need`), and offer to build without it.
4. Check: `npx tsc --noEmit` in the project folder, then render as usual (REELS.md step 6, `--draft` first). A still of any frame: `npx remotion still src/index.ts Reel <png> --frame=<n>`.
5. Comments for the next version (`edits.json`) change the data: a scene's `dur`, `text`, `place`, `media`, its order. Changing the template means re-laying the same material by the new template's scenes into a new version; the old one stays.
