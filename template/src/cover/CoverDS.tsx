// A reel cover drawn by the brand's cover system («Правила: обложки, метки, формы», 26.11.2026):
// fixed places for the label, the right-hand line and the headline; a free zone between them.
// 1080×1920; everything that matters stays inside the 3:4 feed crop (y 240–1680) and the
// bottom-left (64..584 × 1470..1660) stays empty — the view counter sits there in the profile grid.
import React from 'react';
import {AbsoluteFill, Img} from 'remotion';
import {loadFont as geist} from '@remotion/google-fonts/Geist';
import {loadFont as geistMono} from '@remotion/google-fonts/GeistMono';
import G from './geometry.json';

export type CoverProps = {
  rubric: 'useful' | 'news' | 'memes' | 'beauty';
  /** What stands behind the host: a word, a number, a list or nothing (the photo alone). */
  zone: 'word' | 'number' | 'list' | 'none';
  zoneText?: string;
  items?: string[];
  /** The type label: «Полезное», «Новость · 21 ноября». Memes and beauty have none. */
  label?: string;
  /** A series number rides beside the label: «№ 2». */
  series?: string;
  /** The mono line at the top right (the series or the topic). */
  right?: string;
  /** The headline: up to two lines, thin; the second is highlighted in news. */
  t1: string;
  t2?: string;
  /** Memes: the caption on the tilted plate and where the plate stands. */
  caption?: string;
  memeLayout?: 'top' | 'bottom' | 'cut';
  /** Beauty: the place line, mono. */
  place?: string;
  frame: string;
  person?: string;
};

const F = geist('normal', {weights: ['300', '400', '500', '600', '800'], subsets: ['latin', 'cyrillic']}).fontFamily;
const M = geistMono('normal', {weights: ['400', '500'], subsets: ['latin', 'cyrillic']}).fontFamily;
const RED = '#EE4224', INK = '#151612', SNOW = '#F5F1EA';
const fit = (text: string, base: number, width = 950, k = 0.56) => Math.min(base, Math.floor(width / (Math.max(1, text.length) * k)));

const L = G.label;
const Plate: React.FC<{bg: string; ink?: string; children: React.ReactNode; icon?: 'bolt' | 'bookmark'}> = ({bg, ink = '#fff', children, icon}) => (
  <div style={{display: 'inline-flex', alignItems: 'center', gap: L.gap, background: bg, color: ink, fontFamily: F, fontSize: L.font, fontWeight: L.weight, letterSpacing: '-0.01em', lineHeight: 1, padding: `${L.padTop}px ${L.padX}px ${L.padBottom}px`, borderRadius: L.radius, whiteSpace: 'nowrap'}}>
    {icon === 'bolt' && <svg viewBox="0 0 24 24" width={L.icon} height={L.icon} fill="#fff"><path d="M13.5 2 4.5 13.5h6L9.5 22l10-12.5h-6.2Z" /></svg>}
    {icon === 'bookmark' && <svg viewBox="0 0 24 24" width={L.icon} height={L.icon} fill="#fff"><path d="M6.5 3.5h11a1 1 0 0 1 1 1v16.2l-6.5-4.6-6.5 4.6V4.5a1 1 0 0 1 1-1Z" /></svg>}
    <span>{children}</span>
  </div>
);

const Smile: React.FC = () => (
  <svg viewBox="0 0 24 24" width={64} height={64}>
    <rect x="10.6" y="1" width="2.8" height="5" fill="#fff" /><rect x="3" y="6" width="18" height="15" rx="4" fill="#fff" />
    <circle cx="8.6" cy="11.6" r="1.5" fill={INK} /><circle cx="15.4" cy="11.6" r="1.5" fill={INK} />
    <path d="M7.6 15.2c1.2 1.9 2.8 2.7 4.4 2.7s3.2-.8 4.4-2.7" fill="none" stroke={INK} strokeWidth="1.7" strokeLinecap="round" />
  </svg>
);

// «Выделение как в телефоне» — only news: a half-red field with two handles.
const Highlight: React.FC<{children: React.ReactNode}> = ({children}) => (
  <span style={{position: 'relative', display: 'inline-block', whiteSpace: 'nowrap', background: 'rgba(238,66,36,0.42)', padding: '0 0.05em'}}>
    {children}
    <span style={{position: 'absolute', left: '-0.03em', top: '-0.02em', bottom: 0, width: '0.045em', background: RED}} />
    <span style={{width: '0.16em', height: '0.16em', borderRadius: '50%', background: RED, position: 'absolute', left: '-0.088em', top: '-0.16em'}} />
    <span style={{position: 'absolute', right: '-0.03em', top: 0, bottom: '-0.02em', width: '0.045em', background: RED}} />
    <span style={{width: '0.16em', height: '0.16em', borderRadius: '50%', background: RED, position: 'absolute', right: '-0.088em', bottom: '-0.16em'}} />
  </span>
);

const Photo: React.FC<{src: string; style?: React.CSSProperties}> = ({src, style}) => (
  <Img src={src} style={{position: 'absolute', left: 0, top: 0, width: 1080, height: 1920, objectFit: 'cover', ...style}} />
);

export const CoverDS: React.FC<CoverProps> = (p) => {
  const behind = p.zone !== 'none' && !!p.person && (p.rubric === 'useful' || p.rubric === 'news');
  const hl = p.rubric === 'news';
  return (
    <AbsoluteFill style={{background: INK, fontFamily: F, overflow: 'hidden'}}>
      {behind ? (
        <>
          <Photo src={p.frame} style={{filter: 'brightness(.72) saturate(.85)'}} />
          {p.zone === 'word' && <div style={{position: 'absolute', left: 0, top: G.zone.y, width: 1080, textAlign: 'center', fontSize: fit(p.zoneText || '', G.zone.word, 950, 0.66), fontWeight: 800, letterSpacing: '-0.055em', lineHeight: 0.9, color: '#fff', whiteSpace: 'nowrap'}}>{p.zoneText}</div>}
          {p.zone === 'number' && <div style={{position: 'absolute', left: 0, top: G.zone.y, width: 1080, textAlign: 'center', fontSize: fit(p.zoneText || '', G.zone.number), fontWeight: 300, letterSpacing: '-0.055em', lineHeight: 0.9, color: '#fff', whiteSpace: 'nowrap'}}>{p.zoneText}</div>}
          {p.zone === 'list' && (
            <div style={{position: 'absolute', left: G.zone.list.x, top: G.zone.list.y, width: 860, fontSize: G.zone.list.font, fontWeight: 500, lineHeight: 1.12, letterSpacing: '-0.04em', color: 'rgba(255,255,255,.9)'}}>
              {(p.items || []).slice(0, 4).map((t, i) => <div key={i} style={{opacity: [1, 0.6, 0.35, 0.18][i]}}>{t}</div>)}
            </div>
          )}
          <Img src={p.person!} style={{position: 'absolute', left: 0, top: 0, width: 1080, height: 1920, objectFit: 'cover'}} />
          <div style={{position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(21,22,18,0) 42%, rgba(21,22,18,0.92) 100%)'}} />
        </>
      ) : (
        <>
          <Photo src={p.frame} />
          <div style={{position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(21,22,18,0.3), rgba(21,22,18,0) 45%)'}} />
          <div style={{position: 'absolute', inset: 0, background: `linear-gradient(180deg, rgba(21,22,18,0) 55%, rgba(21,22,18,${p.rubric === 'beauty' ? 0.35 : 0.75}) 100%)`}} />
        </>
      )}

      {(p.rubric === 'useful' || p.rubric === 'news') && (
        <>
          <div style={{position: 'absolute', left: L.x, top: L.y, display: 'flex', gap: G.series.gap, alignItems: 'stretch'}}>
            <Plate bg={p.rubric === 'news' ? RED : INK} icon={p.rubric === 'news' ? 'bolt' : 'bookmark'}>{p.label || (p.rubric === 'news' ? 'Новость' : 'Полезное')}</Plate>
            {p.series && <div style={{display: 'inline-flex', alignItems: 'center', background: '#fff', color: INK, fontSize: L.font, fontWeight: L.weight, lineHeight: 1, padding: `${L.padTop}px ${G.series.padX}px ${L.padBottom}px`, borderRadius: L.radius, whiteSpace: 'nowrap'}}>{p.series}</div>}
          </div>
          {p.right && <div style={{position: 'absolute', right: G.right.x, top: G.right.y, fontFamily: M, fontSize: G.right.font, lineHeight: 1.3, color: '#fff', textAlign: 'right'}}>{p.right}</div>}
          <div style={{position: 'absolute', left: G.title.x, top: G.title.y, fontSize: G.title.font, fontWeight: G.title.weight, color: '#fff', lineHeight: G.title.lineHeight, letterSpacing: `${G.title.tracking}em`}}>
            <div style={{whiteSpace: 'nowrap'}}>{p.t1}</div>
            {p.t2 && (hl ? <Highlight>{p.t2}</Highlight> : <div style={{whiteSpace: 'nowrap'}}>{p.t2}</div>)}
          </div>
        </>
      )}

      {p.rubric === 'memes' && (
        <>
          <div style={{position: 'absolute', left: G.meme.icon.x, top: G.meme.icon.y}}><Smile /></div>
          {p.memeLayout === 'cut' ? (
            <div style={{position: 'absolute', left: 0, top: 0, width: 1080, height: 760, background: '#fff', clipPath: 'polygon(0 0, 1080px 0, 1080px 560px, 0 760px)'}}>
              <div style={{position: 'absolute', left: 64, top: 380, width: 900, fontSize: 62, fontWeight: 500, lineHeight: 1.12, letterSpacing: '-0.035em', color: INK}}>{p.caption}</div>
            </div>
          ) : (
            <div style={{position: 'absolute', left: G.meme.plate.x, top: p.memeLayout === 'bottom' ? G.meme.plate.bottom : G.meme.plate.top, width: G.meme.plate.w, boxSizing: 'border-box', background: '#fff', borderRadius: 20, padding: '44px 48px', transform: `rotate(${p.memeLayout === 'bottom' ? 3 : -3}deg)`, fontSize: 62, fontWeight: 500, lineHeight: 1.12, letterSpacing: '-0.035em', color: INK}}>{p.caption}</div>
          )}
        </>
      )}

      {p.rubric === 'beauty' && p.place && <div style={{position: 'absolute', left: G.place.x, top: G.place.y, fontFamily: M, fontSize: G.place.font, lineHeight: 1.3, color: '#fff'}}>{p.place}</div>}
    </AbsoluteFill>
  );
};
