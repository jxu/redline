import assert from "node:assert/strict";
import test from "node:test";

import {
    generateBeatGrid,
    parseOsuHitObjectSpan,
    parseOsuTimingPoints,
} from "../benchmark/osu-timing.js";

const osuText = `[General]
AudioFilename: audio.mp3

[TimingPoints]
1000,500,4,2,1,70,1,0
1250,-100,4,2,1,70,0,0
2200,400,4,2,1,70,1,0

[HitObjects]
256,192,1000,1,0,0:0:0:0:
`;

test("parses only uninherited timing points", () => {
    assert.deepEqual(parseOsuTimingPoints(osuText), [
        { offsetMs: 1000, beatLengthMs: 500, bpm: 120, meter: 4 },
        { offsetMs: 2200, beatLengthMs: 400, bpm: 150, meter: 4 },
    ]);
});

test("uses the first and last rhythmic hit-object timestamps for the benchmark span", () => {
    const map = `[HitObjects]
// The objects need not be sorted to find the mapped span.
256,192,2000,1,0,0:0:0:0:
256,192,500,1,0,0:0:0:0:
256,192,100,8,0,400
256,192,3000,8,0,4000

[Events]
256,192,9000,1,0,0:0:0:0:`;
    assert.deepEqual(parseOsuHitObjectSpan(map), { firstMs: 500, lastMs: 2000 });
    assert.throws(() => parseOsuHitObjectSpan("[HitObjects]\n// empty"), /no valid rhythmic hit objects/);
});

test("includes slider repeats and inherited velocity in the last object's end", () => {
    const map = `[Difficulty]
SliderMultiplier:2

[TimingPoints]
0,500,4,2,1,70,1,0
1000,-50,4,2,1,70,0,0

[HitObjects]
256,192,500,1,0,0:0:0:0:
256,192,2000,2,0,B|300:192,2,100`;
    assert.deepEqual(parseOsuHitObjectSpan(map), { firstMs: 500, lastMs: 2250 });
});

test("uses the first red point for an old map's slider just before its fractional offset", () => {
    const map = `[Difficulty]
SliderMultiplier:2

[TimingPoints]
1999.65771146278,666.666666666667,4,2,1,100,1,0

[HitObjects]
336,116,1999,2,0,B|408:28,2,100`;
    assert.deepEqual(parseOsuHitObjectSpan(map), { firstMs: 1999, lastMs: 2665.666666666667 });
});

test("generates beats until each new timing section resets the grid", () => {
    const points = parseOsuTimingPoints(osuText);
    assert.deepEqual(generateBeatGrid(points, 3100), [1000, 1500, 2000, 2200, 2600, 3000]);
});
