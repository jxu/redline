import assert from "node:assert/strict";
import test from "node:test";

import { removeLeadingId3Padding } from "../benchmark/audio-decoder.js";

test("removes padding between an ID3 tag and MP3 frames", () => {
    const encoded = Uint8Array.from([
        0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02,
        0x01, 0x02,
        0x00, 0x00,
        0xff, 0xfb, 0x90, 0x64,
    ]);

    assert.deepEqual(
        removeLeadingId3Padding(encoded),
        Uint8Array.from([0xff, 0xfb, 0x90, 0x64])
    );
});

test("leaves audio without ID3 padding unchanged", () => {
    const encoded = Uint8Array.from([0xff, 0xfb, 0x90, 0x64]);
    assert.equal(removeLeadingId3Padding(encoded), encoded);
});

test("recovers an MP3 whose ID3 size incorrectly includes the header", () => {
    const encoded = Uint8Array.from([
        0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0e,
        0x12, 0x34, 0x56, 0x78,
        0xff, 0xfb, 0x90, 0x64,
        0x9a, 0xbc, 0xde, 0xf0, 0x21, 0x43,
    ]);
    assert.deepEqual(
        removeLeadingId3Padding(encoded),
        Uint8Array.from(encoded.subarray(14))
    );
});
