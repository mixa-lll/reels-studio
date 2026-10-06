// The whole reel as data: edit this file first, the components follow it.
export const story = {
  fps: 60,
  // Seconds per bar of the track (60 / bpm * 4); scenes are measured in bars.
  barSeconds: 2,
  // File in public/, or null for silence.
  music: null as string | null,
  theme: {
    bg: '#14161c',
    bg2: '#1f2430',
    ink: '#f4f1ea',
    accent: '#ff6b3d',
    font: 'Unbounded',
  },
  scenes: [
    {bars: 1, title: 'Your hook here', note: 'one line that makes people stay'},
    {bars: 1.5, title: 'The pain', note: 'what goes wrong today'},
    {bars: 1.5, title: 'The turn', note: 'what your product does instead'},
    {bars: 1, title: 'Try it', note: 'link in bio'},
  ],
};
