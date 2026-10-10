import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { removeId3Mp3Padding, stripLeadingZeroMp3Padding } from "../audio-decoder.js";
import { decodeAudioFile, removeLeadingId3Padding } from "../benchmark/audio-decoder.js";

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

test("matches osu!lazer's legacy MP3 timing without changing tagged gapless audio", async () => {
    const looseChangePath = fileURLToPath(new URL("../benchmark/corpus/545156 Royal Blood - Loose Change/audio.mp3", import.meta.url));
    const hardkorePath = fileURLToPath(new URL("../benchmark/corpus/30485 Inspector K - Disconnected Hardkore (CanBlaster Remix)/Disconnected_Hardkore.mp3", import.meta.url));
    const looseChange = await decodeAudioFile(looseChangePath);
    const hardkore = await decodeAudioFile(hardkorePath);

    // Loose Change has no encoded delay: BASS retains the 529 samples that
    // mpg123 normally removes. Hardkore carries explicit gapless metadata.
    assert.equal(looseChange.durationMs, 6902784 / 44100 * 1000);
    assert.equal(hardkore.durationMs, 5544320 / 48000 * 1000);

    const hardkoreBytes = await readFile(hardkorePath);
    const hardkoreBuffer = hardkoreBytes.buffer.slice(
        hardkoreBytes.byteOffset, hardkoreBytes.byteOffset + hardkoreBytes.byteLength
    );
    const normalized = new Uint8Array(removeId3Mp3Padding(hardkoreBuffer));
    assert.equal(normalized.length, hardkoreBytes.length - 1);
    assert.deepEqual(normalized.subarray(81, 85), Uint8Array.from(hardkoreBytes.subarray(82, 86)));

    const looseBytes = await readFile(looseChangePath);
    const looseBuffer = looseBytes.buffer.slice(looseBytes.byteOffset, looseBytes.byteOffset + looseBytes.byteLength);
    assert.equal(removeId3Mp3Padding(looseBuffer), looseBuffer);
});

test("decodes an old MP3 with a verified zero preamble", async () => {
    const path = fileURLToPath(new URL(
        "../benchmark/corpus/39217 Arctic Monkeys - I Bet You Look Good on the Dancefloor/02-I Bet You Look Good On The Dancefloor.mp3",
        import.meta.url
    ));
    const bytes = await readFile(path);
    const stripped = stripLeadingZeroMp3Padding(bytes);
    assert.equal(bytes.length - stripped.length, 417);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    assert.equal(new Uint8Array(removeId3Mp3Padding(buffer)).length, stripped.length);
    const decoded = await decodeAudioFile(path);
    assert.ok(decoded.durationMs > 170000);
});
