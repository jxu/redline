import assert from "node:assert/strict";
import test from "node:test";

import { calculateTiming, doubleTicks, halveTicks } from "../timing.js";

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
    const timing = calculateTiming([0, 0.5, 1, 1.6], {
        toleranceMs: 0,
        windowSize: 1,
    });

    assert.equal(
        timing.osuTimingPoints,
        "[TimingPoints]\n0,500.00,4,2,0,100,1,0\n1000,600.00,4,2,0,100,1,0"
    );
});

test("octave corrections preserve ordered beat positions", () => {
    assert.deepEqual(doubleTicks([0, 1, 2]), [0, 0.5, 1, 1.5, 2]);
    assert.deepEqual(halveTicks([0, 0.5, 1, 1.5, 2]), [0, 1, 2]);
});
