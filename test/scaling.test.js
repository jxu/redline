import assert from "node:assert/strict";
import test from "node:test";

import { evaluateTempoScales, scaleBeatGrid } from "../benchmark/scaling.js";

test("scales a beat grid to half or double tempo", () => {
    assert.deepEqual(scaleBeatGrid([0, 1000, 2000], 2), [0, 500, 1000, 1500, 2000]);
    assert.deepEqual(scaleBeatGrid([0, 500, 1000, 1500, 2000], 0.5), [0, 1000, 2000]);
    assert.deepEqual(scaleBeatGrid([0, 500, 1000, 1500, 2000], 0.5, 1), [500, 1500]);
});

test("selects double tempo when raw detections are half the reference tempo", () => {
    const candidates = evaluateTempoScales(
        [0, 1000, 2000],
        [0, 500, 1000, 1500, 2000],
        [0.5, 1, 2]
    );

    assert.equal(candidates[0].tempoScale, 2);
    assert.equal(candidates[0].symmetricMeanNearestErrorMs, 0);
});

test("tries both phases when reducing a double-tempo grid", () => {
    const candidates = evaluateTempoScales(
        [0, 500, 1000, 1500, 2000],
        [500, 1500],
        [0.5]
    );

    assert.equal(candidates[0].phase, 1);
    assert.deepEqual(candidates[0].beatsMs, [500, 1500]);
});
