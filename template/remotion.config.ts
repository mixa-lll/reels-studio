import {Config} from '@remotion/cli/config';

Config.setCodec('h264');
Config.setCrf(18);
Config.setPixelFormat('yuv420p');
Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
// Hardware GL is ~30x faster than software 'swangle' on full-screen gradients. Linux
// machines often have no usable GPU, so they keep Remotion's software default.
if (process.platform !== 'linux') Config.setChromiumOpenGlRenderer('angle');
