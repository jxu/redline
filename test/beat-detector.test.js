import assert from "node:assert/strict";
import test from "node:test";
import {
    beatsFromProbabilities,
    pickBeatPeaks,
} from "../beat-postprocessing.js";

test("Beat This keeps strict positive-logit maxima in seven-frame windows", () => {
    assert.deepEqual(
        pickBeatPeaks(Float32Array.from([0.6, 0, 0, 0, 0.5, 0, 0, 0.7, 0])),
        [0, 0.14],
    );
    assert.deepEqual(
        pickBeatPeaks(Float32Array.from([0, 0.6, 0, 0.7, 0, 0, 0, 0.6, 0])),
        [0.06, 0.14],
    );
});
test("adjacent equal maxima are averaged and downbeats snap to beats", () => {
    const p = Float32Array.from([0, 0.8, 0.8, 0, 0, 0, 0, 0, 0.9]);
    const d = Float32Array.from([0, 0, 0, 0, 0, 0, 0, 0.9, 0]);
    const result = beatsFromProbabilities(p, { downbeatProbabilities: d });
    assert.deepEqual(result.ticks, [0.03, 0.16]);
    assert.deepEqual(result.downbeats, [0.16]);
    assert.equal(result.probabilityFrameMs, 20);
});
