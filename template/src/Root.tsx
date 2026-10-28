import {Composition, Still} from 'remotion';
import {Cover, Reel, totalFrames} from './Reel';
import {story} from './story';
import reel from './reel.json';
import {TemplateCover, TemplateReel, templateFrames, type ReelData} from './templates/TemplateReel';

// A reel by a rubric template is data in reel.json (TEMPLATES.md); a reel without one is
// drawn by Reel.tsx from story.ts, written for that reel alone.
const data = reel as ReelData;

export const Root = () =>
  data.template ? (
    <>
      <Composition id="Reel" component={TemplateReel} defaultProps={{d: data}} durationInFrames={templateFrames(data)} fps={data.fps ?? 30} width={1080} height={1920} />
      <Still id="Cover" component={TemplateCover} defaultProps={{d: data}} width={1080} height={1920} />
    </>
  ) : (
    <>
      <Composition id="Reel" component={Reel} durationInFrames={totalFrames()} fps={story.fps} width={1080} height={1920} />
      <Still id="Cover" component={Cover} width={1080} height={1920} />
    </>
  );
