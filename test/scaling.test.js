import assert from "node:assert/strict";
import test from "node:test";

import { evaluateTempoScales, scaleBeatGrid, selectTempoCandidate } from "../benchmark/scaling.js";

test("reports the mapper's scale even when another candidate scores better", () => {
    const candidates = [
        { tempoScale: 2, phase: 0, matchingF1: 1 },
        { tempoScale: 1, phase: 0, matchingF1: 0.8 },
    ];
    assert.equal(selectTempoCandidate(candidates, 1).matchingF1, 0.8);
    assert.throws(() => selectTempoCandidate(candidates, 0.5), /not evaluated/);
});

test("scales a beat grid to half or double tempo", () => {
    assert.deepEqual(scaleBeatGrid([0, 1000, 2000], 2), [0, 500, 1000, 1500, 2000]);
    assert.deepEqual(scaleBeatGrid([0, 500, 1000, 1500, 2000], 0.5), [0, 1000, 2000]);
    assert.deepEqual(scaleBeatGrid([0, 500, 1000, 1500, 2000], 0.5, 1), [500, 1500]);
});

test("selects double tempo when raw detections are half the reference tempo", () => {
    const candidates = evaluateTempoScales(
        [0, 1000, 2000],
        [0, 500, 1000, 1500, 2000],
        [0.5, 1, 2],
        { durationMs: 2500 }
    );

    assert.equal(candidates[0].tempoScale, 2);
    assert.equal(candidates[0].symmetricMeanNearestErrorMs, 0);
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

test("scores only beats inside the evaluation window", () => {
    const candidates = evaluateTempoScales(
        [0, 1000, 2000, 3000],
        [0, 500, 1000, 1500, 2000, 2500, 3000],
        [2],
        { durationMs: 3500, startMs: 500, endMs: 2500 }
    );

    assert.equal(candidates[0].symmetricMeanNearestErrorMs, 0);
    assert.deepEqual(candidates[0].beatsMs, [500, 1000, 1500, 2000]);
});

test("scores the fitted export grid instead of jittered input detections", () => {
    const [candidate] = evaluateTempoScales(
        [0, 400, 1000, 1400, 2000],
        [0, 500, 1000, 1500, 2000],
        [1],
        { durationMs: 2400, timingOptions: { windowSize: 2, toleranceMs: 101 } }
    );

    assert.equal(candidate.osuTimingPoints, "[TimingPoints]\n0,500.00,4,2,0,100,1,0");
    assert.deepEqual(candidate.beatsMs, [0, 500, 1000, 1500, 2000]);
    assert.equal(candidate.matchedBeatCount, 5);
    assert.equal(candidate.matchingF1, 1);
});

test("uses the app's default fit tolerance when no timing options are supplied", () => {
    const detected = [0, 500, 1000, 1500, 2100];
    const reference = [0, 500, 1000, 1500, 2100];
    const [candidate] = evaluateTempoScales(
        detected,
        reference,
        [1],
        { durationMs: 2500 }
    );
    const [loose] = evaluateTempoScales(
        detected, reference, [1],
        { durationMs: 2500, timingOptions: { windowSize: 4, toleranceMs: 101 } }
    );

    assert.deepEqual(candidate.beatsMs, [0, 500, 1000, 1500, 2100]);
    assert.deepEqual(candidate.exportedTimingPoints.map((point) => point.beatLengthMs),
        [500, 600]);
    assert.notDeepEqual(loose.beatsMs, candidate.beatsMs);
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
        [500, 1000, 1500],
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
