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

test("matches browser frame skipping when the ID3 size overlaps the first MP3 frame", () => {
    const frameLength = 417; // MPEG-1 Layer III, 128 kbps at 44.1 kHz.
    const encoded = new Uint8Array(14 + 2 * frameLength);
    encoded.set([
        0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0e,
        0x12, 0x34, 0x56, 0x78,
    ]);
    const header = [0xff, 0xfb, 0x90, 0x64];
    encoded.set(header, 14);
    encoded.set(header, 100); // False sync inside the first frame's payload.
    encoded.set(header, 14 + frameLength);
    assert.deepEqual(
        removeLeadingId3Padding(encoded),
        Uint8Array.from(encoded.subarray(14 + frameLength))
    );
});
