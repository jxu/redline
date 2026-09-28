import assert from "node:assert/strict";
import test from "node:test";

import { interpolateBeatGaps } from "../beat-interpolation.js";

test("continues the previous tempo without stretching to the next detected beat", () => {
    assert.deepEqual(
        interpolateBeatGaps([0, 0.5, 1, 2.56]),
        [0, 0.5, 1, 1.5, 2, 2.56]
    );
});

test("does not fill a gap that is inconsistent with the previous tempo", () => {
    assert.deepEqual(
        interpolateBeatGaps([0, 0.5, 1, 1.8]),
        [0, 0.5, 1, 1.8]
    );
});

test("folds fast subdivisions into a plausible tempo estimate", () => {
    assert.deepEqual(
        interpolateBeatGaps([0, 0.21, 0.63, 1.05, 1.89])
            .map((tick) => Number(tick.toFixed(2))),
        [0, 0.21, 0.63, 1.05, 1.47, 1.89]
    );
});

test("continues the final known tempo to the end of the audio", () => {
    assert.deepEqual(
        interpolateBeatGaps([0, 0.5, 1], { endTime: 2.2 }),
        [0, 0.5, 1, 1.5, 2]
    );
});
