# /// script
# dependencies = ["librosa"]
# ///
"""Tempo, beat and bar-start times of a track: `uv run scripts/beats.py <audio>`.

Check the tempo against the kicks by ear: trap often comes out at half tempo.
"""
import json
import sys

import librosa

y, sr = librosa.load(sys.argv[1])
tempo, frames = librosa.beat.beat_track(y=y, sr=sr)
beats = librosa.frames_to_time(frames, sr=sr).round(3).tolist()
bpm = float(tempo[0] if hasattr(tempo, "__len__") else tempo)
print(json.dumps({
    "bpm": round(bpm, 1),
    "barSeconds": round(240 / bpm, 3),
    "firstBeat": beats[0] if beats else 0,
    "bars": beats[::4],
}, indent=1))
