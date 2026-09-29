import assert from "node:assert/strict";
import test from "node:test";

import { calculateTiming } from "../timing.js";
import { generateBeatGrid, parseOsuTimingPoints } from "../benchmark/osu-timing.js";

test("keeps a genuine tempo change and the audible grid matches the export", () => {
    const timing = calculateTiming([0, 0.5, 1, 1.6, 2.2], {
        toleranceMs: 0, windowSize: 1, endTime: 2.8,
    });
    assert.equal(timing.osuTimingPoints,
        "[TimingPoints]\n0,500.00,4,2,0,100,1,0\n1000,600.00,4,2,0,100,1,0");
    const exported = parseOsuTimingPoints(timing.osuTimingPoints);
    const exportGridMs = generateBeatGrid(exported, 2800);
    assert.deepEqual(timing.gridTicks.map((beat) => beat * 1000), exportGridMs);
});

function ticksFromIntervals(intervalsMs) {
    let timeMs = 0;
    return [0, ...intervalsMs.map((intervalMs) => (timeMs += intervalMs) / 1000)];
}

test("a fixed track keeps one precise grid despite an extrapolated tail", () => {
    const ticks = ticksFromIntervals([
        ...Array(570).fill(294.117),
        ...Array(30).fill(290),
    ]);
    const timing = calculateTiming(ticks, {
        observedTicks: ticks.slice(0, 571), tempoPattern: "fixed",
    });
    assert.equal(timing.timingPoints.length, 1);
    assert.ok(Math.abs(timing.timingPoints[0].beatLengthMs - 294.117) < 0.00001);
    assert.ok(Math.abs(timing.timingPoints[0].offsetMs + 600 * timing.timingPoints[0].beatLengthMs - 600 * 294.117) < 1);
    assert.ok(timing.gridTicks.every((tick) => tick >= 0));
});

test("a late observed tempo change is not mistaken for a fixed track", () => {
    const ticks = ticksFromIntervals([
        ...Array(570).fill(294.117),
        ...Array(30).fill(290),
    ]);
    const timing = calculateTiming(ticks, { observedTicks: ticks, tempoPattern: "sections" });
    assert.ok(timing.timingPoints.length > 1);
    const forcedFixed = calculateTiming(ticks, { observedTicks: ticks, tempoPattern: "fixed" });
    assert.equal(forcedFixed.timingPoints.length, 1);
    assert.equal(forcedFixed.fitWarning, true);
});

test("preserves fixed sections while following gradual tempo drift", () => {
    const sections = ticksFromIntervals([
        ...Array(300).fill(500),
        ...Array(300).fill(450),
    ]);
    const ramp = ticksFromIntervals(Array.from({ length: 600 }, (_, index) => 450 + index / 6));
    const sectionFit = calculateTiming(sections, { tempoPattern: "sections" });
    const continuousFit = calculateTiming(ramp, { tempoPattern: "continuous" });
    assert.equal(sectionFit.timingPoints.length, 2);
    assert.ok(continuousFit.timingPoints.length > sectionFit.timingPoints.length);
});

test("probability evidence pulls a jittered live grid toward individual beats", () => {
    const trueBeats = Array.from({ length: 24 }, (_, index) => 1 + index * 0.5);
    const ticks = trueBeats.map((beat, index) =>
        beat + [0, 0.03, -0.025, 0.04, -0.03][index % 5]);
    const options = { tempoPattern: "continuous", endTime: 13.5 };
    const withoutEvidence = calculateTiming(ticks, options);
    const meanError = ({ gridTicks }) => trueBeats.reduce((sum, beat, index) =>
        sum + Math.abs(gridTicks[index] - beat), 0) / trueBeats.length;

    for (const probabilityFrameMs of [10, 20]) {
        const probabilities = new Float32Array(14000 / probabilityFrameMs).fill(0.001);
        for (const beat of trueBeats) {
            const frame = Math.round(beat * 1000 / probabilityFrameMs);
            for (let offset = -3; offset <= 3; offset++) {
                probabilities[frame + offset] = 0.9 * Math.exp(-0.5 * (offset / 1.1) ** 2);
            }
        }
        const withEvidence = calculateTiming(ticks, {
            ...options, probabilities, probabilityFrameMs,
        });
        assert.ok(meanError(withEvidence) < meanError(withoutEvidence) / 2);
        assert.ok(meanError(withEvidence) < 0.005);
    }
});
