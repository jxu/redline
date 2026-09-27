import assert from "node:assert/strict";
import test from "node:test";

import { pickBeatPeaks } from "../beat-detector.js";

test("picks local probability maxima above the threshold", () => {
    const probabilities = Float32Array.from([0, 0.2, 0.4, 0.2, 0, 0, 0, 0, 0.6, 0]);
    assert.deepEqual(pickBeatPeaks(probabilities, 0.33), [0.02, 0.08]);
});

test("keeps the taller of peaks inside the minimum distance", () => {
    const probabilities = Float32Array.from([0, 0.5, 0, 0.7, 0, 0, 0, 0.6, 0]);
    assert.deepEqual(pickBeatPeaks(probabilities, 0.33), [0.03]);
});
