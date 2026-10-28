// «Как увидят» (canvas «Черновик 8», NX0–NX7): a reel or a post shown inside the platform's own
// interface — Reels, the Instagram feed, a carousel, the profile grid, a Telegram channel, a
// story. The interfaces are drawn here, without logos, only for previewing inside the studio.
// One script for the web page and the mini app: window.Preview = {ZONES, VIEWS, frame, checks}.
(() => {
  // Where the platform's own interface covers the picture: no text or plates there. Fractions of
  // the 9:16 frame (x0, y0, x1, y1). One place for every check and for the hatching.
  const ZONES = {
    reels: [{label: 'кнопки', x0: 0.84, y0: 0.38, x1: 1, y1: 0.84}, {label: 'подпись и аккаунт', x0: 0, y0: 0.8, x1: 0.84, y1: 1}, {label: 'шапка', x0: 0, y0: 0, x1: 1, y1: 0.07}],
    story: [{label: 'шапка истории', x0: 0, y0: 0, x1: 1, y1: 0.12}, {label: 'ответ и реакции', x0: 0, y0: 0.87, x1: 1, y1: 1}],
  };
  // The grid shows a 9:16 cover cut to 3:4 (the middle 75 % of its height) and a 4:5 post the same way.
  const GRID = {reel: {y0: 0.125, y1: 0.875}, post: {y0: 1 / 30, y1: 29 / 30}};
  // Caption length visible before «ещё», and the Telegram text that still shows without «Показать полностью».
  const MORE = {reels: 70, feed: 125, carousel: 125};
  const TG_FULL = 700;
  const VIEWS = {reels: 'Reels', feed: 'Лента', carousel: 'Карусель', grid: 'Сетка профиля', telegram: 'Канал', story: 'История'};

  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const I = {
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
    chat: '<path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.4L3 21l2.1-5.6A8.4 8.4 0 1 1 21 11.5z"/>', send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
    save: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>', dots: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
    home: '<path d="M3 10.5 12 3l9 7.5V21H3z"/>', search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>', plus: '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M12 8v8M8 12h8"/>',
    reel: '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M3 8h18M8 3l3 5M13 3l3 5M10 12v5l4-2.5z"/>', play: '<path d="M8 5v14l11-7z"/>', stack: '<rect x="7" y="7" width="13" height="13" rx="2"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/>',
  };
  const ic = (n, s = 24) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n]}</svg>`;
  const initials = (o) => esc((o.name || o.account || '··').replace(/^@/, '').split(/[\s._]+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase());
  const handle = (o) => esc((o.account || o.name || 'account').replace(/^@/, ''));
  const media = (m, fit = 'cover') => !m ? '<div class="pv-ph"></div>' : m.type === 'video'
    ? `<video src="${esc(m.url)}" playsinline muted loop autoplay preload="metadata" style="object-fit:${fit}"></video>` : `<img src="${esc(m.url)}" alt="" style="object-fit:${fit}">`;
  const cut = (t, n) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${esc(s.slice(0, n).replace(/\s\S*$/, ''))}… <span class="pv-m">ещё</span>` : esc(s); };
  const zones = (kind, on) => !on ? '' : (ZONES[kind] || []).map((z) => `<div class="pv-safe" style="left:${z.x0 * 100}%;top:${z.y0 * 100}%;width:${(z.x1 - z.x0) * 100}%;height:${(z.y1 - z.y0) * 100}%"><span>${z.label}</span></div>`).join('');
  const nav = (dark) => `<div class="pv-nav ${dark ? 'dk' : ''}">${ic('home')}${ic('search')}${ic('plus')}${ic('reel')}<span class="pv-av pv-s">··</span></div>`;

  const CSS = `
  .pv{width:100%;max-width:380px;aspect-ratio:390/844;position:relative;overflow:hidden;border-radius:28px;background:#000;color:#fff;font:14px/1.4 -apple-system,"SF Pro Text",system-ui,Roboto,sans-serif;letter-spacing:-.01em;container-type:inline-size;box-shadow:0 0 0 8px #171717,0 18px 50px rgba(0,0,0,.25);margin:8px auto}
  .pv video,.pv img{width:100%;height:100%;display:block}
  .pv-ph{width:100%;height:100%;background:linear-gradient(160deg,#C9D6DF,#7E97A6)}
  .pv-full{position:absolute;inset:0}
  .pv-safe{position:absolute;background:repeating-linear-gradient(45deg,rgba(250,204,21,.32) 0 6px,rgba(250,204,21,.1) 6px 12px);border:1.5px dashed #FACC15;z-index:3;pointer-events:none}
  .pv-safe span{position:absolute;left:5px;top:3px;font:700 10px Manrope,system-ui;color:#FACC15;text-shadow:0 1px 2px rgba(0,0,0,.7)}
  .pv-rr{position:absolute;right:3%;bottom:17%;display:flex;flex-direction:column;align-items:center;gap:16px;font-size:12px;font-weight:600;z-index:2;text-shadow:0 1px 3px rgba(0,0,0,.4)}
  .pv-rr div{display:flex;flex-direction:column;align-items:center;gap:2px}
  .pv-capt{position:absolute;left:4%;right:20%;bottom:9%;z-index:2;text-shadow:0 1px 3px rgba(0,0,0,.5)}
  .pv-u{display:flex;align-items:center;gap:8px;font-weight:700;margin-bottom:6px}
  .pv-fb{border:1px solid rgba(255,255,255,.75);border-radius:8px;padding:2px 8px;font-size:12px;font-weight:600}
  .pv-m{opacity:.6}
  .pv-av{width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,#22A55B,#0E7490);flex:none;display:grid;place-items:center;color:#fff;font-size:11px;font-weight:700}
  .pv-av.pv-s{width:24px;height:24px;font-size:9px}
  .pv-nav{position:absolute;left:0;right:0;bottom:0;height:7%;display:flex;justify-content:space-around;align-items:center;background:#fff;color:#0F0F0F;border-top:.5px solid rgba(0,0,0,.12);z-index:4}
  .pv-nav.dk{background:#000;color:#fff;border-color:rgba(255,255,255,.15)}
  .pv.feed{background:#fff;color:#0F0F0F;overflow-y:auto}
  .pv-top{display:flex;align-items:center;padding:10px 14px 6px;font:italic 700 22px Georgia,serif}
  .pv-h{display:flex;align-items:center;gap:10px;padding:8px 12px;font-size:14px}
  .pv-45{aspect-ratio:4/5;position:relative;background:#eee;overflow:hidden}
  .pv-act{display:flex;align-items:center;gap:14px;padding:10px 12px 4px}
  .pv-dots{display:flex;gap:4px;justify-content:center;flex:1}.pv-dots i{width:6px;height:6px;border-radius:50%;background:#C7C7CC}.pv-dots i.on{background:#0095F6}
  .pv-n{position:absolute;right:10px;top:10px;background:rgba(0,0,0,.6);color:#fff;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:600}
  .pv-cp{padding:3px 12px;font-size:14px}.pv-cp .pv-m{color:#737373;opacity:1}
  .pv-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:2px}
  .pv-grid span{aspect-ratio:3/4;position:relative;overflow:hidden;background:#E5E5E5}
  .pv-grid span.me{outline:3px solid #FACC15;outline-offset:-3px}
  .pv-grid span i{position:absolute;right:5px;top:5px;color:#fff;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}
  .pv-stat{display:flex;justify-content:space-around;text-align:center;font-size:12px;padding:6px 0}.pv-stat b{display:block;font-size:16px}
  .pv.tg{background:#9BB8A2;color:#000}.pv.tg.dk{background:#0E1621;color:#fff}
  .pv-tgh{background:#fff;display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:.5px solid #DADADA}.dk .pv-tgh{background:#17212B;border-color:#0E1621}
  .pv-bub{background:#fff;border-radius:14px 14px 14px 4px;overflow:hidden;box-shadow:0 1px 1px rgba(0,0,0,.12);margin:14px 10px;max-width:92%}.dk .pv-bub{background:#182533}
  .pv-bub .tx{padding:8px 11px 4px;font-size:15px;line-height:1.38;white-space:pre-wrap;word-wrap:break-word}
  .pv-bub .ft{display:flex;gap:6px;padding:2px 10px 7px;font-size:12px;color:#8E8E93;justify-content:flex-end}
  .pv-rx{display:inline-flex;gap:4px;background:#E8F1FB;color:#2481CC;border-radius:999px;padding:3px 8px;font-size:13px;font-weight:600}.dk .pv-rx{background:#2B5278;color:#fff}
  .pv-more{color:#2481CC;font-weight:600}
  .pv-bars{position:absolute;left:8px;right:8px;top:8px;display:flex;gap:3px;z-index:3}.pv-bars i{flex:1;height:2.5px;border-radius:2px;background:rgba(255,255,255,.4)}.pv-bars i.on{background:#fff}
  .pv-sh{position:absolute;left:10px;right:10px;top:18px;display:flex;align-items:center;gap:8px;z-index:3;font-weight:600;font-size:13px}
  .pv-reply{position:absolute;left:10px;right:10px;bottom:14px;display:flex;align-items:center;gap:10px;z-index:3}.pv-reply span{flex:1;border:1px solid rgba(255,255,255,.6);border-radius:999px;padding:9px 14px;font-size:13px}`;
  if (!document.getElementById('pv-css')) { const st = document.createElement('style'); st.id = 'pv-css'; st.textContent = CSS; document.head.append(st); }

  // o: {media: {type, url}, slides: [url], cover: url, caption, account, name, grid: [{url, kind}], zones, theme: 'dark'|'light', slide}
  function frame(kind, o = {}) {
    if (kind === 'reels') return `<div class="pv"><div class="pv-full">${media(o.media)}</div>${zones('reels', o.zones)}
      <div class="pv-rr"><div>${ic('heart', 26)}<span>1 284</span></div><div>${ic('chat', 26)}<span>46</span></div><div>${ic('send', 26)}<span>212</span></div><div>${ic('save', 26)}</div><div>${ic('dots', 22)}</div></div>
      <div class="pv-capt"><div class="pv-u"><span class="pv-av">${initials(o)}</span>${handle(o)}<span class="pv-fb">Подписаться</span></div>${cut(o.caption, MORE.reels)}<div style="margin-top:6px;font-size:12px;opacity:.9">♫ ${esc(o.name || handle(o))} · оригинальный звук</div></div>${nav(true)}</div>`;
    if (kind === 'feed' || kind === 'carousel') {
      const n = o.slides?.length || 1, at = Math.min(o.slide || 0, n - 1);
      const m = o.slides?.length ? {type: 'image', url: o.slides[at]} : o.media;
      return `<div class="pv feed"><div class="pv-top">Лента<span style="flex:1"></span>${ic('heart', 24)}</div>
        <div class="pv-h"><span class="pv-av">${initials(o)}</span><b style="flex:1">${handle(o)}</b>${ic('dots', 20)}</div>
        <div class="pv-45" data-pv-slide>${media(m)}${n > 1 ? `<span class="pv-n">${at + 1}/${n}</span>` : ''}</div>
        <div class="pv-act">${ic('heart', 24)}${ic('chat', 24)}${ic('send', 24)}${n > 1 ? `<span class="pv-dots">${Array.from({length: Math.min(n, 10)}, (_, i) => `<i class="${i === at ? 'on' : ''}"></i>`).join('')}</span>` : '<span style="flex:1"></span>'}${ic('save', 24)}</div>
        <div class="pv-cp"><b>Нравится: 312</b></div><div class="pv-cp"><b>${handle(o)}</b> ${cut(o.caption, MORE.feed)}</div><div class="pv-cp pv-m">Смотреть все комментарии (18)</div><div style="height:60px"></div>${nav(false)}</div>`;
    }
    if (kind === 'grid') {
      const cells = [{url: o.cover || o.media?.url, kind: o.media?.type === 'video' ? 'reel' : o.slides?.length > 1 ? 'carousel' : 'post', me: true}, ...(o.grid || [])].slice(0, 12);
      return `<div class="pv feed"><div class="pv-top" style="font:700 18px system-ui">${handle(o)}</div>
        <div style="display:flex;align-items:center;gap:14px;padding:6px 14px"><span class="pv-av" style="width:64px;height:64px;font-size:20px">${initials(o)}</span><div class="pv-stat" style="flex:1"><div><b>${cells.length + 200}</b>публикаций</div><div><b>3 812</b>подписчиков</div><div><b>96</b>подписок</div></div></div>
        <div style="padding:0 14px 10px;font-size:13px"><b>${esc(o.name || handle(o))}</b></div>
        <div class="pv-grid">${cells.map((c) => `<span class="${c.me ? 'me' : ''}">${c.url ? (/\.(mp4|mov|webm)(\?|&|$)/i.test(c.url) ? `<video src="${esc(c.url)}" muted playsinline preload="metadata" style="width:100%;height:100%;object-fit:cover"></video>` : `<img src="${esc(c.url)}" alt="" style="width:100%;height:100%;object-fit:cover">`) : ''}${c.kind === 'reel' ? `<i>${ic('play', 16)}</i>` : c.kind === 'carousel' ? `<i>${ic('stack', 16)}</i>` : ''}</span>`).join('')}</div><div style="height:60px"></div>${nav(false)}</div>`;
    }
    if (kind === 'telegram') {
      const dk = o.theme === 'dark', text = String(o.caption || ''), long = text.length > TG_FULL;
      return `<div class="pv tg ${dk ? 'dk' : ''}"><div class="pv-tgh"><span style="color:#2481CC">‹</span><span style="flex:1;text-align:center"><b>${esc(o.name || 'Канал')}</b><div style="font-size:12px;color:#8E8E93">3 812 подписчиков</div></span><span class="pv-av">${initials(o)}</span></div>
        <div class="pv-bub">${o.media || o.slides?.length ? `<div style="max-height:260px;overflow:hidden">${media(o.slides?.length ? {type: 'image', url: o.slides[0]} : o.media)}</div>` : ''}
        <div class="tx">${esc(long ? text.slice(0, TG_FULL).replace(/\s\S*$/, '') + '…' : text)}${long ? '\n<span class="pv-more">Показать полностью</span>' : ''}</div>
        <div style="display:flex;gap:6px;padding:4px 10px 0"><span class="pv-rx">👍 48</span><span class="pv-rx">❤️ 21</span><span class="pv-rx">🔥 9</span></div><div class="ft">👁 1,2K · 10:30</div></div></div>`;
    }
    if (kind === 'story') return `<div class="pv"><div class="pv-full">${media(o.media)}</div>${zones('story', o.zones)}<div class="pv-bars"><i class="on"></i><i></i><i></i></div>
      <div class="pv-sh"><span class="pv-av pv-s">${initials(o)}</span>${handle(o)}<span style="opacity:.7;font-weight:400">2 ч</span><span style="flex:1"></span>✕</div>
      <div class="pv-reply"><span>Отправить сообщение</span>${ic('heart', 24)}${ic('send', 24)}</div></div>`;
    return '';
  }

  // Plates of a template reel (reel.json) as boxes in the 9:16 frame, to check against the zones.
  const PLACE = {top: [0.12, 0.3], middle: [0.42, 0.56], 'under-face': [0.64, 0.76], bottom: [0.6, 0.78]};
  function plates(reel) {
    if (!reel?.scenes) return [];
    let t = 0;
    return reel.scenes.filter((s) => !s.skip).map((s) => {
      const dur = s.dur ?? {hook: 2, photo: 3, clip: 5, base: 3, item: 3, total: 3, tip: 4, compare: 5, question: 3, answer: 5, fact: 4, cta: 2}[s.kind] ?? 3;
      const at = t; t += dur;
      if (!s.text || ['hook', 'total', 'question', 'fact', 'cta'].includes(s.kind)) return null;
      const place = s.place || (s.kind === 'clip' ? 'under-face' : 'bottom');
      const [y0, y1] = PLACE[place] || PLACE.bottom;
      // A plate runs from the left margin; a long line reaches the right edge.
      return {text: s.text, at, place, x0: 0.065, x1: Math.min(0.935, 0.12 + s.text.length * 0.034), y0, y1};
    }).filter(Boolean);
  }
  const hit = (a, z) => a.x0 < z.x1 && a.x1 > z.x0 && a.y0 < z.y1 && a.y1 > z.y0;
  const tc = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  // Warnings for one view: [{text, fix}] — fix is what to ask Claude for.
  function checks(kind, o = {}) {
    const out = [];
    const cap = String(o.caption || '').replace(/\s+/g, ' ').trim();
    if (MORE[kind] && cap.length > MORE[kind]) {
      const first = cap.split(/(?<=[.!?…])\s/)[0];
      if (first.length > MORE[kind]) out.push({text: `До «ещё» видно ${MORE[kind]} знаков — первая фраза не влезает целиком.`, fix: `Сократи первую фразу подписи для ${o.platform || 'Instagram'} до ${MORE[kind] - 10} знаков, чтобы она целиком была видна до «ещё».`});
    }
    if (kind === 'telegram' && cap.length > TG_FULL) out.push({text: `Текст длиннее ${TG_FULL} знаков — в канале появится «Показать полностью».`, fix: `Сократи текст для ${o.platform || 'Телеграма'} до ${TG_FULL - 50} знаков, чтобы он читался без «Показать полностью».`});
    if (kind === 'reels' || kind === 'story') {
      for (const p of plates(o.reel)) for (const z of ZONES[kind]) if (hit(p, z)) {
        out.push({text: `Плашка «${p.text}» (${tc(p.at)}) заходит в зону «${z.label}».`, fix: `В reel.json плашка «${p.text}» на ${tc(p.at)} заходит под интерфейс ${kind === 'reels' ? 'Reels' : 'истории'} (${z.label}). Перенеси её выше или короче (place: middle / top) и собери новую версию.`});
        break;
      }
    }
    if (kind === 'grid' && o.reel?.scenes?.length) {
      const first = plates({...o.reel, scenes: o.reel.scenes.slice(0, 1)})[0];
      if (first && (first.y0 < GRID.reel.y0 || first.y1 > GRID.reel.y1)) out.push({text: `В сетке обложка режется до 3:4 — «${first.text}» уходит за край.`, fix: 'Обложка в сетке профиля режется до 3:4 и прячет текст первого кадра. Сделай обложку, где главное в середине кадра.'});
    }
    return out;
  }

  window.Preview = {ZONES, GRID, VIEWS, frame, checks, plates};
})();
