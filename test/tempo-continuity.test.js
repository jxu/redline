import assert from "node:assert/strict";
import test from "node:test";
import { constrainOctaveJumps, isOctaveJump } from "../tempo-continuity.js";

test("removes repeated octave switching while retaining a real section change and drift", () => {
    const points = [
        { offsetMs: 0, beatLengthMs: 500 },
        { offsetMs: 10000, beatLengthMs: 312.5 },
        { offsetMs: 60000, beatLengthMs: 625 },
        { offsetMs: 80000, beatLengthMs: 315 },
        { offsetMs: 100000, beatLengthMs: 630 },
    ];
    const result = constrainOctaveJumps(points, 120000);
    assert.deepEqual(result.map((p) => p.beatLengthMs), [500, 312.5, 312.5, 315, 315]);
    assert.equal(points[2].beatLengthMs, 625);
});

test("halving chooses the supported alternating beat phase", () => {
    const points = [{ offsetMs: 0, beatLengthMs: 330 }, { offsetMs: 20000, beatLengthMs: 660 }];
    const downbeatTicks = Array.from({ length: 7 }, (_, i) => (330 + i * 2640) / 1000);
    const result = constrainOctaveJumps(points, 60000, { downbeatTicks });
    assert.equal(result[0].beatLengthMs, 660);
    assert.equal(result[0].offsetMs, 330);
});

test("octave continuity stays legal at the export BPM cap", () => {
    const points = [{ offsetMs: 0, beatLengthMs: 200 },
        { offsetMs: 50000, beatLengthMs: 380 }, { offsetMs: 60000, beatLengthMs: 200 }];
    const result = constrainOctaveJumps(points, 70000);
    assert.ok(result.every((point) => point.beatLengthMs >= 200));
    assert.ok(result.slice(1).every((point, i) => !isOctaveJump(result[i].beatLengthMs, point.beatLengthMs)));
});
