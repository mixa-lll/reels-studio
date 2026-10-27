# Posts

How the agent makes posts in the web studio. A post is a text with 0–10 pictures:

- **text post** (`kind: "text"`) — Telegram first: longer, with links and line breaks, no hashtags;
- **post with a photo** (`kind: "photo"`) — one photo people brought, cropped by the page;
- **carousel** (`kind: "carousel"`) — 5–7 slides drawn from five templates of the project's design system.

The post's folder holds `post.json` (everything the editor shows), `sources/` (photos people brought) and `images/` (crops and slide PNGs the page makes). Read `<project>/brief.md` and `PLAYBOOK.md` first: the rubric's voice and the rules apply to posts too.

## post.json

```json
{
  "kind": "text | photo | carousel",
  "title": "short working title",
  "rubric": "rubric name from the brief",
  "texts": [{"style": "Тёплый", "text": "…"}, {"style": "Новость", "text": "…"}, {"style": "Коротко", "text": "…"}],
  "chosen": 0,
  "why": "one line: which photo and why (faces of children not visible, even light…)",
  "photos": [],
  "slides": [{"template": "cover|list|check|summary|cta", "kicker": "", "title": "", "text": "", "items": ["…"], "total": ""}],
  "slidesEn": [],
  "captions": [{"platform": "Instagram RU", "account": "@…", "text": "…", "at": "2026-11-02T19:00"}],
  "checks": [{"ok": true, "text": "…"}],
  "after": [{"text": "Анонс в сторис", "on": true}]
}
```

Edit only what the request is about and keep the other fields. `photos` is written by the page (crop, «Светлее»): to suggest a photo, name its file from `sources/` in `why`.

## Steps

1. **Text.** Three variants in different styles; the rubric's default style first. Keep `chosen` on the variant the person picked.
2. **Pictures.**
   - photo: say which file from `sources/` fits and why, in `why`; the person crops it on the page (4:5 or 1:1, «Светлее»), no AI retouching;
   - carousel: split the topic into 5–7 slides and pick a template for each: `cover` (hook question), `list` (up to 6 items), `check` (items as «thing — price», with `total`), `summary`, `cta`. Slide texts are short: a title of a few words, items of 2–6 words. Colours, fonts and spacing come from the design system; never put them in the slides. The page draws the PNGs («Собрать слайды»).
3. **Publish.** One caption per platform in `captions`: Instagram RU and EN are each written natively, not translated (EN slides go to `slidesEn`), Telegram is longer and without hashtags. Add `checks` (what to verify before posting) and `after` (stories announcement, reply drafts). The person plans the package; the bot sends it to Telegram on time.
