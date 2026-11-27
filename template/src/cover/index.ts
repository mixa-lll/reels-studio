// A separate entry for cover stills (web/cover.mjs → template/cover-render.mjs): the covers do not
// belong to any one reel's project, so they are bundled on their own.
import React from 'react';
import {Still, registerRoot} from 'remotion';
import {CoverDS, type CoverProps} from './CoverDS';

const base: CoverProps = {rubric: 'useful', zone: 'word', zoneText: 'Слово', t1: 'Заголовок', t2: 'в две строки', frame: ''};

registerRoot(() => React.createElement(Still, {id: 'CoverDS', component: CoverDS as React.FC<any>, width: 1080, height: 1920, defaultProps: base}));
