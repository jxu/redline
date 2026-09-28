import assert from "node:assert/strict";
import test from "node:test";

import { calculateTiming, doubleTicks, halveTicks, generateTimingGrid } from "../timing.js";
import { generateBeatGrid, parseOsuTimingPoints } from "../benchmark/osu-timing.js";

test("calculates a stable timing map without browser state", () => {
    const timing = calculateTiming([0.1, 0.6, 1.1, 1.6], {
        toleranceMs: 5,
        windowSize: 1,
    });

    assert.equal(timing.averageBpm, 120);
    assert.deepEqual(timing.beatLengths, ["500.00", "500.00", "500.00"]);
    assert.deepEqual(timing.rawBpmSeries.map(({ x }) => x), [0.1, 0.6, 1.1]);
    timing.rawBpmSeries.forEach(({ y }) => assert.ok(Math.abs(y - 120) < 1e-9));
    assert.equal(timing.osuTimingPoints, "[TimingPoints]\n100,500.00,4,2,0,100,1,0");
});

test("emits a new timing point when the calculated beat length changes", () => {
    const timing = calculateTiming([0, 0.5, 1, 1.6, 2.2], {
        toleranceMs: 0,
        windowSize: 1,
    });

    assert.equal(
        timing.osuTimingPoints,
        "[TimingPoints]\n0,500.00,4,2,0,100,1,0\n1000,600.00,4,2,0,100,1,0"
    );
});

test("joins sections at one beat and avoids extra beats at a timing reset", () => {
    const timing = calculateTiming([0, 0.4, 1, 1.4, 2], { endTime: 2.4 });
    assert.equal(timing.osuTimingPoints, "[TimingPoints]\n0,500.00,4,2,0,100,1,0");
    assert.deepEqual(timing.gridTicks, [0, 0.5, 1, 1.5, 2]);
});

test("keeps a genuine tempo change and the audible grid matches the export", () => {
    const timing = calculateTiming([0, 0.5, 1, 1.6, 2.2], {
        toleranceMs: 0, windowSize: 1, endTime: 2.8,
    });
    const exported = parseOsuTimingPoints(timing.osuTimingPoints);
    const exportGridMs = generateBeatGrid(exported, 2800);
    assert.deepEqual(generateTimingGrid(timing.timingPoints, 2800), timing.gridTicks);
    assert.deepEqual(timing.gridTicks.map((beat) => beat * 1000), exportGridMs);
});

test("octave corrections preserve ordered beat positions", () => {
    assert.deepEqual(doubleTicks([0, 1, 2]), [0, 0.5, 1, 1.5, 2]);
    assert.deepEqual(halveTicks([0, 0.5, 1, 1.5, 2]), [0, 1, 2]);
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
    assert.equal(timing.tempoPattern, "Fixed BPM");
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
    assert.equal(timing.tempoPattern, "Variable BPM with fixed sections");
    assert.ok(timing.timingPoints.length > 1);
    const forcedFixed = calculateTiming(ticks, { observedTicks: ticks, tempoPattern: "fixed" });
    assert.equal(forcedFixed.timingPoints.length, 1);
    assert.equal(forcedFixed.fitWarning, true);
});

test("distinguishes fixed sections from continuously varying tempo", () => {
    const sections = ticksFromIntervals([
        ...Array(300).fill(500),
        ...Array(300).fill(450),
    ]);
    const ramp = ticksFromIntervals(Array.from({ length: 600 }, (_, index) => 450 + index / 6));
    const sectionFit = calculateTiming(sections, { tempoPattern: "sections" });
    const continuousFit = calculateTiming(ramp, { tempoPattern: "continuous" });
    assert.equal(sectionFit.tempoPattern, "Variable BPM with fixed sections");
    assert.equal(sectionFit.timingPoints.length, 2);
    assert.equal(continuousFit.tempoPattern, "Continuously variable BPM");
    assert.ok(continuousFit.timingPoints.length > sectionFit.timingPoints.length);
});
