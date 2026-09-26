import decode from "audio-decode";
import { readFile } from "node:fs/promises";

import { ESSENTIA_SAMPLE_RATE } from "../audio-decoder.js";

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
    const audioBuffer = await decode(encodedAudio);
    const mono = downmix(audioBuffer);

    return {
        durationMs: mono.length / audioBuffer.sampleRate * 1000,
        samples: resampleLinear(mono, audioBuffer.sampleRate, ESSENTIA_SAMPLE_RATE),
        sourceSampleRate: audioBuffer.sampleRate,
    };
}
