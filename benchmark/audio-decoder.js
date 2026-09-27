import decode from "audio-decode";
import { readFile } from "node:fs/promises";

import { MODEL_SAMPLE_RATE } from "../audio-decoder.js";

export function removeLeadingId3Padding(encodedAudio) {
    if (
        encodedAudio.length < 10 ||
        encodedAudio[0] !== 0x49 ||
        encodedAudio[1] !== 0x44 ||
        encodedAudio[2] !== 0x33
    ) {
        return encodedAudio;
    }

    const tagSize =
        ((encodedAudio[6] & 0x7f) << 21) |
        ((encodedAudio[7] & 0x7f) << 14) |
        ((encodedAudio[8] & 0x7f) << 7) |
        (encodedAudio[9] & 0x7f);
    const footerSize = encodedAudio[5] & 0x10 ? 10 : 0;
    let audioStart = 10 + tagSize + footerSize;

    while (encodedAudio[audioStart] === 0) audioStart++;
    return audioStart === 10 + tagSize + footerSize
        ? encodedAudio
        : Uint8Array.from(encodedAudio.subarray(audioStart));
}

async function decodeWithId3PaddingFallback(encodedAudio) {
    try {
        return await decode(encodedAudio);
    } catch (error) {
        const withoutPadding = removeLeadingId3Padding(encodedAudio);
        if (withoutPadding === encodedAudio || error.message !== "Unknown audio format") throw error;
        return decode(withoutPadding);
    }
}

function downmix(audioBuffer) {
    const sampleCount = audioBuffer.channelData[0]?.length ?? 0;
    const mono = new Float32Array(sampleCount);

    for (const input of audioBuffer.channelData) {
        for (let index = 0; index < input.length; index++) {
            mono[index] += input[index] / audioBuffer.channelData.length;
        }
    }

    return mono;
}

function resampleLinear(samples, sourceRate, targetRate) {
    if (sourceRate === targetRate) return samples;

    const outputLength = Math.ceil(samples.length * targetRate / sourceRate);
    const output = new Float32Array(outputLength);

    for (let index = 0; index < outputLength; index++) {
        const sourcePosition = index * sourceRate / targetRate;
        const beforeIndex = Math.floor(sourcePosition);
        const afterIndex = Math.min(beforeIndex + 1, samples.length - 1);
        const fraction = sourcePosition - beforeIndex;
        output[index] = samples[beforeIndex] * (1 - fraction) + samples[afterIndex] * fraction;
    }

    return output;
}

export async function decodeAudioFile(path) {
    const encodedAudio = await readFile(path);
    const audioBuffer = await decodeWithId3PaddingFallback(encodedAudio);
    const mono = downmix(audioBuffer);

    return {
        durationMs: mono.length / audioBuffer.sampleRate * 1000,
        samples: resampleLinear(mono, audioBuffer.sampleRate, MODEL_SAMPLE_RATE),
        sourceSampleRate: audioBuffer.sampleRate,
    };
}
