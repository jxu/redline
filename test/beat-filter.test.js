import assert from "node:assert/strict";
import test from "node:test";

import { filterSpuriousBeats } from "../beat-filter.js";

test("removes a fast subdivision when skipping it restores the previous tempo", () => {
    assert.deepEqual(
        filterSpuriousBeats([0, 0.5, 0.7, 1, 1.5]),
        [0, 0.5, 1, 1.5]
    );
});

test("removes repeated subdivisions without changing the tempo history", () => {
    assert.deepEqual(
        filterSpuriousBeats([0, 0.5, 0.7, 1, 1.2, 1.5, 2]),
        [0, 0.5, 1, 1.5, 2]
    );
});

test("keeps a fast peak when skipping it does not restore the previous tempo", () => {
    assert.deepEqual(
        filterSpuriousBeats([0, 0.5, 0.7, 1.3]),
        [0, 0.5, 0.7, 1.3]
    );
});

test("keeps plausible live tempo acceleration", () => {
    assert.deepEqual(
        filterSpuriousBeats([0, 0.5, 0.8, 1.1, 1.4]),
        [0, 0.5, 0.8, 1.1, 1.4]
    );
});
