import assert from "node:assert/strict";
import test from "node:test";

import {
    evaluateTempoScales,
    selectTempoCandidate,
    weightedBeatF1,
} from "../benchmark/scaling.js";

test("allows the best octave while retaining an explicit mapper scale", () => {
    const candidates = [
        { tempoScale: 2, phase: 0, matchingF1: 1 },
        { tempoScale: 1, phase: 0, matchingF1: 0.8 },
    ];
    assert.equal(selectTempoCandidate(candidates).tempoScale, 2);
    assert.equal(selectTempoCandidate(candidates, 1).matchingF1, 0.8);
    assert.throws(() => selectTempoCandidate(candidates, 0.5), /not evaluated/);
});

test("an explicit double-tempo choice survives pulse fitting", () => {
    const observed = Array.from({ length: 32 }, (_, index) => index * 440);
    const probabilities = new Float32Array(730);
    for (const beatMs of observed) probabilities[beatMs / 20] = 0.9;
    const [candidate] = evaluateTempoScales(
        observed, observed.flatMap((beatMs) => [beatMs, beatMs + 220]), [2],
        {
            durationMs: 14500,
            observedBeatsMs: observed,
            probabilities,
            probabilityFrameMs: 20,
            timingOptions: { tempoPattern: "sections", windowSize: 4,
                toleranceMs: 5, tempoSmoothness: 5 },
        }
    );

    assert.ok(candidate.exportedTimingPoints.every(({ beatLengthMs }) => beatLengthMs < 300));
    assert.ok(candidate.beatsMs.length >= 60);
});

test("tries both phases when reducing a double-tempo grid", () => {
    const candidates = evaluateTempoScales(
        [0, 500, 1000, 1500, 2000],
        [500, 1500],
        [0.5],
        { durationMs: 2000 }
    );

    assert.equal(candidates[0].phase, 1);
    assert.deepEqual(candidates[0].beatsMs, [500, 1500]);
});

test("penalizes an incorrect double-tempo grid for its extra beats", () => {
    const candidates = evaluateTempoScales(
        [0, 500, 1000, 1500, 2000],
        [0, 500, 1000, 1500, 2000],
        [1, 2],
        { durationMs: 2500 }
    );
    const doubled = candidates.find(({ tempoScale }) => tempoScale === 2);

    assert.equal(candidates[0].tempoScale, 1);
    assert.equal(candidates[0].matchingF1, 1);
    assert.ok(candidates[0].matchingF1 > doubled.matchingF1);
});

test("F1 matches exported beats only within 20 ms", () => {
    const reference = [0, 500, 1000, 1500];
    const evaluateShift = (shiftMs) => evaluateTempoScales(
        reference.map((beatMs) => beatMs + shiftMs), reference, [1],
        { durationMs: 1800 }
    )[0];

    assert.equal(evaluateShift(19).matchingF1, 1);
    assert.equal(evaluateShift(21).matchingF1, 0);
    assert.equal(evaluateShift(21).matchingToleranceMs, 20);
});

test("scores a fixed beat-timestamp correction in the exported timing points", () => {
    const [candidate] = evaluateTempoScales(
        [27, 527, 1027, 1527], [0, 500, 1000, 1500], [1],
        { durationMs: 1800, exportOffsetMs: -27 }
    );

    assert.equal(candidate.osuTimingPoints, "[TimingPoints]\n0,500.00,4,2,0,100,1,0");
    assert.deepEqual(candidate.beatsMs, [0, 500, 1000, 1500]);
    assert.equal(candidate.weightedF1, 1);
});

test("weighted F1 emphasizes precise matches across 3 to 30 ms", () => {
    const exact = weightedBeatF1([0, 500], [0, 500]);
    const shifted = weightedBeatF1([12, 512], [0, 500]);
    const harmonic = Array.from({ length: 10 }, (_, index) => 1 / (index + 1));
    const expected = harmonic.slice(3).reduce((sum, weight) => sum + weight, 0) /
        harmonic.reduce((sum, weight) => sum + weight, 0);

    assert.equal(exact.weightedF1, 1);
    assert.ok(Math.abs(shifted.weightedF1 - expected) < 1e-12);
    assert.deepEqual(shifted.scores.map(({ toleranceMs }) => toleranceMs),
        [3, 6, 9, 12, 15, 18, 21, 24, 27, 30]);
    assert.ok(shifted.weightedF1 < exact.weightedF1);
});

test("export rounding, section resets, and final tempo continuation affect the grid", () => {
    const [candidate] = evaluateTempoScales(
        [0.49, 500.496, 1100.499, 1700.499, 2300.499],
        [0, 550.25, 1100, 1700.25, 2300.5, 2900.75],
        [1],
        { durationMs: 3500, timingOptions: { windowSize: 1, toleranceMs: 0 } }
    );

    assert.equal(candidate.osuTimingPoints,
        "[TimingPoints]\n0,550.25,4,2,0,100,1,0\n1100,600.25,4,2,0,100,1,0");
    assert.deepEqual(candidate.beatsMs, [0, 550.25, 1100, 1700.25, 2300.5, 2900.75]);
    assert.equal(candidate.matchingF1, 1);
});

test("exports the full track before trimming the evaluation window", () => {
    const [candidate] = evaluateTempoScales(
        [0, 400, 1000, 1400, 2000],
        [0, 500, 1000, 1500, 2000],
        [1],
        { durationMs: 2400, startMs: 500, endMs: 2000,
            timingOptions: { windowSize: 2, toleranceMs: 101 } }
    );

    assert.deepEqual(candidate.beatsMs, [500, 1000, 1500]);
    assert.equal(candidate.exportedTimingPoints[0].offsetMs, 0);
    assert.equal(candidate.matchingF1, 1);
});

test("no timing grid is invented when fewer than two beats are available", () => {
    for (const ticks of [[], [500]]) {
        const [candidate] = evaluateTempoScales(ticks, [0, 500], [1], { durationMs: 1000 });
        assert.deepEqual(candidate.beatsMs, []);
        assert.equal(candidate.matchingF1, 0);
    }
});
