import {Composition, Still} from 'remotion';
import {Cover, Reel, totalFrames} from './Reel';
import {story} from './story';

export const Root = () => (
  <>
    <Composition id="Reel" component={Reel} durationInFrames={totalFrames()} fps={story.fps} width={1080} height={1920} />
    <Still id="Cover" component={Cover} width={1080} height={1920} />
  </>
);
