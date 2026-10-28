// Rubric templates (TEMPLATES.md): the reel is data in src/reel.json — which template, the
// scenes in order, the material of each — and these components draw it. Claude fills the
// data instead of writing a reel from scratch, so a reel by a template is quick and keeps the
// rubric's look. Material lives in public/ and is named by its file name.
import {loadFont as manrope} from '@remotion/google-fonts/Manrope';
import {loadFont as unbounded} from '@remotion/google-fonts/Unbounded';
import {AbsoluteFill, Audio, Easing, Img, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import type {CSSProperties} from 'react';

export type Media = {file: string; from?: number; muted?: boolean; fit?: 'cover' | 'contain'};
export type Scene = {
  kind: 'hook' | 'photo' | 'clip' | 'base' | 'item' | 'total' | 'tip' | 'compare' | 'question' | 'answer' | 'fact' | 'cta';
  dur?: number;
  text?: string;
  note?: string;
  amount?: number;
  media?: Media;
  // compare: two variants side by side
  a?: {label: string; amount?: number; media?: Media};
  b?: {label: string; amount?: number; media?: Media};
  win?: 'a' | 'b';
  // where the plate sits: top, bottom (default), or under the face (lower third, above the chin line)
  place?: 'top' | 'middle' | 'bottom' | 'under-face';
  // a scene still waiting for material: what it needs; «Собрать без сцены» sets skip
  need?: string;
  skip?: boolean;
};
export type ReelData = {
  template: string | null;
  fps?: number;
  currency?: string;
  theme?: {bg?: string; ink?: string; accent?: string; plate?: string; plateInk?: string; font?: 'Manrope' | 'Unbounded'};
  music?: {file: string; volume?: number} | null;
  scenes: Scene[];
};

const DUR: Record<Scene['kind'], number> = {hook: 2, photo: 3, clip: 5, base: 3, item: 3, total: 3, tip: 4, compare: 5, question: 3, answer: 5, fact: 4, cta: 2};
const ease = Easing.bezier(0.16, 1, 0.3, 1);
const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
// Only the chosen font is loaded (each family is dozens of files).
const fontOf = (name?: string) => name === 'Unbounded' ? unbounded('normal', {weights: ['600', '700'], subsets: ['latin', 'cyrillic']}).fontFamily
  : manrope('normal', {weights: ['500', '600', '700', '800'], subsets: ['latin', 'cyrillic']}).fontFamily;

export const sceneSeconds = (s: Scene) => s.dur ?? DUR[s.kind] ?? 3;
const shown = (d: ReelData) => d.scenes.filter((s) => !s.skip);
export const templateFrames = (d: ReelData) => Math.max(1, Math.round(shown(d).reduce((n, s) => n + sceneSeconds(s), 0) * (d.fps ?? 30)));

const theme = (d: ReelData) => ({bg: '#0E0F12', ink: '#FFFFFF', accent: '#F5B700', plate: '#FFFFFF', plateInk: '#171717', ...d.theme, font: fontOf(d.theme?.font)});
type Th = ReturnType<typeof theme>;
const money = (n: number, cur = '₽') => `${Math.round(n).toLocaleString('ru-RU').replace(/,/g, ' ')} ${cur}`;
const isVideo = (f: string) => /\.(mp4|mov|webm|m4v)$/i.test(f);

/** Full-bleed material: a photo slowly pushes in, a video plays (with its sound unless muted). */
const Fill = ({m, dim = 0, push = true}: {m?: Media; dim?: number; push?: boolean}) => {
  const f = useCurrentFrame();
  const {durationInFrames, fps} = useVideoConfig();
  if (!m) return null;
  const style: CSSProperties = {width: '100%', height: '100%', objectFit: m.fit ?? 'cover'};
  const zoom = push ? interpolate(f, [0, durationInFrames], [1.02, 1.1]) : 1;
  return (
    <AbsoluteFill style={{overflow: 'hidden'}}>
      <AbsoluteFill style={{transform: `scale(${zoom})`}}>
        {isVideo(m.file) ? <OffthreadVideo src={staticFile(m.file)} startFrom={Math.round((m.from ?? 0) * fps)} muted={m.muted} style={style} /> : <Img src={staticFile(m.file)} style={style} />}
      </AbsoluteFill>
      {dim > 0 && <AbsoluteFill style={{background: `rgba(0,0,0,${dim})`}} />}
    </AbsoluteFill>
  );
};

const useIn = (delay = 0, len = 14) => interpolate(useCurrentFrame(), [delay, delay + len], [0, 1], {...clamp, easing: ease});

/** A white plate with the scene's words: the one place text sits over material. */
const Plate = ({t, text, note, place = 'bottom', lead, children}: {t: Th; text?: string; note?: string; place?: Scene['place']; lead?: React.ReactNode; children?: React.ReactNode}) => {
  const p = useIn(4);
  if (!text && !children) return null;
  const pos: CSSProperties = place === 'top' ? {top: 230} : place === 'middle' ? {top: '42%'} : place === 'under-face' ? {top: '64%'} : {bottom: 300};
  return (
    <div style={{position: 'absolute', left: 70, right: 70, ...pos, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 14, opacity: p, transform: `translateY(${(1 - p) * 40}px)`}}>
      {lead}
      {text && <div style={{background: t.plate, color: t.plateInk, fontFamily: t.font, fontWeight: 800, fontSize: 62, lineHeight: 1.12, letterSpacing: -1.2, padding: '22px 30px', borderRadius: 28, maxWidth: '100%', boxShadow: '0 12px 40px rgba(0,0,0,.25)'}}>{text}</div>}
      {note && <div style={{background: 'rgba(0,0,0,.55)', color: '#fff', fontFamily: t.font, fontWeight: 600, fontSize: 40, padding: '12px 22px', borderRadius: 18}}>{note}</div>}
      {children}
    </div>
  );
};

const Chip = ({t, children, big = false}: {t: Th; children: React.ReactNode; big?: boolean}) => (
  <div style={{background: t.accent, color: '#171717', fontFamily: t.font, fontWeight: 800, fontSize: big ? 72 : 54, padding: big ? '18px 32px' : '12px 26px', borderRadius: 999, letterSpacing: -1}}>{children}</div>
);

/** Running total of a check, in the top corner: the base plus every item so far. */
const Running = ({t, value, cur}: {t: Th; value: number; cur: string}) => {
  const p = useIn(10);
  return <div style={{position: 'absolute', top: 210, right: 60, background: 'rgba(0,0,0,.6)', color: '#fff', fontFamily: t.font, fontWeight: 700, fontSize: 44, padding: '12px 24px', borderRadius: 999, opacity: p}}>итого {money(value, cur)}</div>;
};

const Big = ({t, text, note, color}: {t: Th; text: string; note?: string; color?: string}) => {
  const p = useIn(0, 18);
  const n = useIn(10);
  return (
    <AbsoluteFill style={{justifyContent: 'center', padding: 80, fontFamily: t.font}}>
      <div style={{color: color ?? t.ink, fontSize: text.length > 18 ? 104 : 150, fontWeight: 800, lineHeight: 1.02, letterSpacing: -3, opacity: p, transform: `scale(${0.92 + 0.08 * p})`, transformOrigin: 'left center'}}>{text}</div>
      {note && <div style={{color: t.ink, opacity: 0.8 * n, fontSize: 52, fontWeight: 600, marginTop: 30}}>{note}</div>}
    </AbsoluteFill>
  );
};

function SceneView({s, i, d, t, total}: {s: Scene; i: number; d: ReelData; t: Th; total: number}) {
  const cur = d.currency ?? '₽';
  switch (s.kind) {
    case 'hook':
      return <AbsoluteFill style={{background: t.bg}}><Fill m={s.media} dim={0.45} /><Big t={t} text={s.text ?? ''} note={s.note} /></AbsoluteFill>;
    case 'photo':
      return <AbsoluteFill style={{background: t.bg}}><Fill m={s.media} /><Plate t={t} text={s.text} note={s.note} place={s.place} /></AbsoluteFill>;
    case 'clip':
      return <AbsoluteFill style={{background: t.bg}}><Fill m={s.media} push={false} /><Plate t={t} text={s.text} note={s.note} place={s.place ?? 'under-face'} /></AbsoluteFill>;
    case 'base':
    case 'item':
      return (
        <AbsoluteFill style={{background: t.bg}}>
          <Fill m={s.media} />
          <Plate t={t} text={s.text} note={s.note} place={s.place}>{s.amount != null && <Chip t={t}>{s.kind === 'item' ? '+ ' : ''}{money(s.amount, cur)}</Chip>}</Plate>
          {s.kind === 'item' && <Running t={t} value={total} cur={cur} />}
        </AbsoluteFill>
      );
    case 'total':
      return <AbsoluteFill style={{background: t.bg}}><Big t={t} text={money(s.amount ?? total, cur)} note={s.text ?? 'итого'} color={t.accent} /></AbsoluteFill>;
    case 'tip': {
      const n = d.scenes.slice(0, i + 1).filter((x) => x.kind === 'tip').length;
      return (
        <AbsoluteFill style={{background: t.bg}}>
          <Fill m={s.media} />
          <Plate t={t} text={s.text} note={s.note} place={s.place} lead={<Chip t={t} big>{n}</Chip>} />
        </AbsoluteFill>
      );
    }
    case 'compare': {
      const side = (v: Scene['a'], k: 'a' | 'b') => (
        <div style={{flex: 1, position: 'relative', overflow: 'hidden'}}>
          <Fill m={v?.media} />
          {s.win === k && <AbsoluteFill style={{boxShadow: `inset 0 0 0 14px ${t.accent}`}} />}
          <div style={{position: 'absolute', left: 30, right: 30, bottom: 340, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start'}}>
            <div style={{background: t.plate, color: t.plateInk, fontFamily: t.font, fontWeight: 800, fontSize: 46, padding: '14px 22px', borderRadius: 20}}>{k.toUpperCase()} · {v?.label}</div>
            {v?.amount != null && <Chip t={t}>{money(v.amount, cur)}</Chip>}
            {s.win === k && <div style={{background: '#171717', color: '#fff', fontFamily: t.font, fontWeight: 700, fontSize: 40, padding: '10px 20px', borderRadius: 999}}>выгоднее</div>}
          </div>
        </div>
      );
      return <AbsoluteFill style={{background: t.bg, flexDirection: 'row'}}>{side(s.a, 'a')}{side(s.b, 'b')}<Plate t={t} text={s.text} place="top" /></AbsoluteFill>;
    }
    case 'question':
      return <AbsoluteFill style={{background: t.bg}}><Fill m={s.media} dim={0.5} /><Big t={t} text={s.text ?? ''} note={s.note} /></AbsoluteFill>;
    case 'answer':
      return <AbsoluteFill style={{background: t.bg}}><Fill m={s.media} push={!s.media || !isVideo(s.media.file)} /><Plate t={t} text={s.text} note={s.note} place={s.place ?? (s.media && isVideo(s.media.file) ? 'under-face' : 'bottom')} /></AbsoluteFill>;
    case 'fact':
      return <AbsoluteFill style={{background: t.bg}}><Fill m={s.media} dim={0.55} /><Big t={t} text={s.text ?? ''} note={s.note} color={t.accent} /></AbsoluteFill>;
    case 'cta':
      return <AbsoluteFill style={{background: t.accent}}><Big t={{...t, ink: '#171717'}} text={s.text ?? ''} note={s.note} /></AbsoluteFill>;
  }
}

/** A short fade between scenes; the cut lands on the scene's first frame. */
const Fade = ({children}: {children: React.ReactNode}) => <AbsoluteFill style={{opacity: useIn(0, 6)}}>{children}</AbsoluteFill>;

export const TemplateReel = ({d: all}: {d: ReelData}) => {
  const d = {...all, scenes: shown(all)};
  const t = theme(d);
  const fps = d.fps ?? 30;
  let from = 0, total = 0;
  return (
    <AbsoluteFill style={{background: t.bg}}>
      {d.scenes.map((s, i) => {
        if (s.kind === 'base' || s.kind === 'item') total += s.amount ?? 0;
        const len = Math.round(sceneSeconds(s) * fps);
        const seq = <Sequence key={i} from={from} durationInFrames={len}><Fade><SceneView s={s} i={i} d={d} t={t} total={total} /></Fade></Sequence>;
        from += len;
        return seq;
      })}
      {d.music && <Audio src={staticFile(d.music.file)} volume={d.music.volume ?? 0.35} />}
    </AbsoluteFill>
  );
};

/** Cover: the first scene, settled. */
export const TemplateCover = ({d}: {d: ReelData}) => (
  <Sequence from={-45}><TemplateReel d={d} /></Sequence>
);
