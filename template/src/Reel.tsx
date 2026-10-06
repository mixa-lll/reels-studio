import {loadFont} from '@remotion/google-fonts/Unbounded';
import {AbsoluteFill, Audio, Easing, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {story} from './story';

const {fontFamily} = loadFont();
const t = story.theme;
const ease = Easing.bezier(0.16, 1, 0.3, 1);
const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;

const sceneFrames = (bars: number) => Math.round(bars * story.barSeconds * story.fps);
export const totalFrames = () => story.scenes.reduce((n, s) => n + sceneFrames(s.bars), 0);

/** Slow eased push-in background: two soft gradients, no pulsing. */
const Backdrop = () => {
  const f = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const zoom = interpolate(f, [0, durationInFrames], [1, 1.08]);
  return (
    <AbsoluteFill style={{background: t.bg, overflow: 'hidden'}}>
      <AbsoluteFill
        style={{
          transform: `scale(${zoom})`,
          background: `radial-gradient(60% 40% at 30% 70%, ${t.accent}33, transparent), radial-gradient(70% 50% at 80% 20%, ${t.bg2}, transparent)`,
        }}
      />
    </AbsoluteFill>
  );
};

/** One headline per scene; enters fast, leaves on the cut. */
const Title = ({title, note}: {title: string; note: string}) => {
  const f = useCurrentFrame();
  const inP = interpolate(f, [0, 18], [0, 1], {...clamp, easing: ease});
  const noteP = interpolate(f, [10, 30], [0, 1], {...clamp, easing: ease});
  return (
    <AbsoluteFill style={{justifyContent: 'center', padding: 90, top: 260, fontFamily}}>
      <div style={{color: t.ink, fontSize: 104, fontWeight: 700, lineHeight: 1.05, letterSpacing: -2, opacity: inP, transform: `translateY(${(1 - inP) * 60}px)`}}>
        {title}
      </div>
      <div style={{color: t.accent, fontSize: 46, marginTop: 36, opacity: noteP, transform: `translateY(${(1 - noteP) * 30}px)`}}>
        {note}
      </div>
    </AbsoluteFill>
  );
};

export const Reel = () => {
  let from = 0;
  return (
    <AbsoluteFill>
      <Backdrop />
      {story.scenes.map((s, i) => {
        const d = sceneFrames(s.bars);
        const seq = (
          <Sequence key={i} from={from} durationInFrames={d}>
            <Title title={s.title} note={s.note} />
          </Sequence>
        );
        from += d;
        return seq;
      })}
      {story.music && <Audio src={staticFile(story.music)} />}
    </AbsoluteFill>
  );
};

/** Cover: the first scene's headline, fully shown. */
export const Cover = () => (
  <AbsoluteFill>
    <Backdrop />
    <Sequence from={-60}>
      <Title title={story.scenes[0].title} note={story.scenes[0].note} />
    </Sequence>
  </AbsoluteFill>
);
