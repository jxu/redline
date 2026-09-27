import assert from "node:assert/strict";
import test from "node:test";

import { createMetronomeBuffer, mixBuffers } from "../metronome.js";

function createAudioContext() {
    return {
        createBuffer(numberOfChannels, length, sampleRate) {
            const channels = Array.from(
                { length: numberOfChannels },
                () => new Float32Array(length)
            );
            return {
                numberOfChannels,
                length,
                sampleRate,
                duration: length / sampleRate,
                getChannelData(channel) {
                    return channels[channel];
                },
            };
        },
    };
}

test("places a 50 ms click at each beat", () => {
    const audioContext = createAudioContext();
    const buffer = createMetronomeBuffer(audioContext, [0.1], 1, 8000);
    const samples = buffer.getChannelData(0);

    assert.equal(samples.length, 8000);
    assert.equal(samples.slice(0, 800).some(Boolean), false);
    assert.equal(samples.slice(800, 1200).some(Boolean), true);
    assert.equal(samples.slice(1200).some(Boolean), false);
});

test("mixes mono clicks into every channel and prevents clipping", () => {
    const audioContext = createAudioContext();
    const original = audioContext.createBuffer(2, 3, 8000);
    original.getChannelData(0).set([0.9, -0.9, 0.25]);
    original.getChannelData(1).set([-0.25, 0.25, 0]);
    const clicks = audioContext.createBuffer(1, 3, 8000);
    clicks.getChannelData(0).set([0.4, -0.4, 0.5]);

    const mixed = mixBuffers(audioContext, original, clicks);

    assert.deepEqual(Array.from(mixed.getChannelData(0)), [1, -1, 0.75]);
    assert.deepEqual(
        Array.from(mixed.getChannelData(1)),
        [0.15000000596046448, -0.15000000596046448, 0.5]
    );
});
