import assert from "node:assert/strict";
import test from "node:test";

import {
    generateBeatGrid,
    nearestBeat,
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

test("generates beats until each new timing section resets the grid", () => {
    const points = parseOsuTimingPoints(osuText);
    assert.deepEqual(generateBeatGrid(points, 3100), [1000, 1500, 2000, 2200, 2600, 3000]);
});

test("finds the closest reference beat", () => {
    assert.equal(nearestBeat([1000, 1500, 2000], 1410), 1500);
    assert.equal(nearestBeat([1000, 1500, 2000], 1250), 1000);
    assert.equal(nearestBeat([], 1250), null);
});
