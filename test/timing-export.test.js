import assert from "node:assert/strict";
import test from "node:test";
import { calculateExportTiming } from "../timing-export.js";
import { calculateTiming } from "../timing.js";

test("export text, markers and playback share the correction while fitting uses native beats", () => {
    const ticks = [0.027, 0.527, 1.027, 1.527];
    const options = { endTime: 1.8, tempoPattern: "fixed" };
    const native = calculateTiming(ticks, options);
    const corrected = calculateExportTiming(ticks, options);
    assert.deepEqual(corrected.gridTicks, [0, 0.5, 1, 1.5]);
    assert.equal(corrected.timingPoints[0].offsetMs, native.timingPoints[0].offsetMs - 27);
    assert.equal(corrected.osuTimingPoints, "[TimingPoints]\n0,500.00,4,2,0,100,1,0");
    assert.deepEqual(corrected.rawBpmSeries, native.rawBpmSeries);
    assert.deepEqual(calculateExportTiming(ticks, { ...options, exportOffsetMs: 0 }), native);
});
