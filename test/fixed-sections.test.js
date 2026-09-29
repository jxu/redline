import assert from "node:assert/strict";
import test from "node:test";

import { chooseStableSections } from "../fixed-sections.js";

test("keeps long fixed sections despite subdivision peaks", () => {
    const spans = [[40, 60000 / 220], [25, 60000 / 210],
        [20, 60000 / 220], [25, 400]];
    const beats = [];
    let timeMs = 0;
    for (const [durationSeconds, intervalMs] of spans) {
        const endMs = timeMs + durationSeconds * 1000;
        while (timeMs < endMs) {
            beats.push(timeMs / 1000);
            timeMs += intervalMs;
        }
    }
    const observed = beats.flatMap((beat, index) =>
        index % 7 === 3 ? [beat, beat + 0.14] : [beat]);
    const noisyFit = Array.from({ length: 22 }, (_, index) => ({
        offsetMs: index * 5000,
        beatLengthMs: index < 8 ? 273 : index < 13 ? 286 : index < 17 ? 273 : 400,
    }));

    const sections = chooseStableSections(observed, noisyFit, 110000);
    assert.equal(sections.length, 4);
    assert.deepEqual(sections.map(({ beatLengthMs }) =>
        Math.round(60000 / beatLengthMs)), [220, 210, 220, 150]);
});
