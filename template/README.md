# Reel project (Remotion)

- `src/reel.json` — a reel by a rubric template: which template and the scenes with their material (`TEMPLATES.md` in the repo root). With `"template": null` the reel is drawn from `story.ts`.
- `src/templates/` — the templates' components and `catalog.json`; do not change them for one reel.
- `src/story.ts` — the reel as data: fps, bar length, music, theme, scenes. Start here.
- `src/Reel.tsx` — backdrop, titles and the composition. Replace freely: every reel gets its own look.
- `public/` — music, screen captures (PNG sequences under `public/screens/<scene>/0001.png`), images.

```bash
npm ci --ignore-scripts              # once, in template/ (exact lockfile versions)
node scripts/new-reel.mjs <slug>      # from the repo root: a new reel folder with this template inside
npx remotion studio                   # live preview, from the project folder
node scripts/render.mjs <project> <versions/v1/slug-v1.mp4>
npx remotion still src/index.ts Cover <versions/v1/slug-v1-cover.png>
```

Set `barSeconds` from `node scripts/beats.mjs <track>` so cuts land on bar starts.
