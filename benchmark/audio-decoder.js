import decode from "audio-decode";
import { readFile } from "node:fs/promises";

import { MODEL_SAMPLE_RATE } from "../audio-decoder.js";

function mp3FrameLength(bytes, index) {
    if (index < 0 || index + 4 > bytes.length || bytes[index] !== 0xff ||
        (bytes[index + 1] & 0xe0) !== 0xe0) return 0;
    const version = (bytes[index + 1] >> 3) & 3;
    const layer = (bytes[index + 1] >> 1) & 3;
    const bitrateIndex = (bytes[index + 2] >> 4) & 15;
    const rateIndex = (bytes[index + 2] >> 2) & 3;
    if (version === 1 || layer !== 1 || bitrateIndex === 0 ||
        bitrateIndex === 15 || rateIndex === 3) return 0;
    const bitrate = (version === 3
        ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
        : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[bitrateIndex];
    const sampleRate = [44100, 48000, 32000][rateIndex] /
        (version === 3 ? 1 : version === 2 ? 2 : 4);
    const padding = (bytes[index + 2] >> 1) & 1;
    return Math.floor((version === 3 ? 144000 : 72000) * bitrate / sampleRate) + padding;
}

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

    // Some older MP3s count the 10-byte ID3 header in the encoded tag size.
    // Chrome and osu!-configured BASS skip the frame overlapped by the declared
    // tag. Restoring it would delay the benchmark audio by one MP3 frame.
    // Use the frame length to find the next boundary: compressed payload can
    // contain false sync words, so scanning for the next header is unsafe.
    const earlierStart = audioStart - 10;
    const earlierFrameLength = mp3FrameLength(encodedAudio, earlierStart);
    if (!mp3FrameLength(encodedAudio, audioStart) && earlierFrameLength) {
        const nextFrame = earlierStart + earlierFrameLength;
        if (!mp3FrameLength(encodedAudio, nextFrame)) return encodedAudio;
        audioStart = nextFrame;
    }

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
