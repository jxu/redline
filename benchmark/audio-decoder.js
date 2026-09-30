import decode from "audio-decode";
import { MPEGDecoder } from "mpg123-decoder";
import { readFile } from "node:fs/promises";

import { MODEL_SAMPLE_RATE, id3TagEnd, mp3FrameLength, stripLeadingZeroMp3Padding } from "../audio-decoder.js";

export function removeLeadingId3Padding(encodedAudio) {
    if (
        encodedAudio.length < 10 ||
        encodedAudio[0] !== 0x49 ||
        encodedAudio[1] !== 0x44 ||
        encodedAudio[2] !== 0x33
    ) {
        return encodedAudio;
    }

    const declaredStart = id3TagEnd(encodedAudio);
    let audioStart = declaredStart;

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
    return audioStart === declaredStart
        ? encodedAudio
        : Uint8Array.from(encodedAudio.subarray(audioStart));
}

async function decodeWithId3PaddingFallback(encodedAudio) {
    try {
        return await decode(encodedAudio);
    } catch (error) {
        const withoutId3Padding = removeLeadingId3Padding(encodedAudio);
        const withoutPadding = withoutId3Padding === encodedAudio
            ? stripLeadingZeroMp3Padding(encodedAudio) : withoutId3Padding;
        if (withoutPadding === encodedAudio || error.message !== "Unknown audio format") throw error;
        return decode(withoutPadding);
    }
}

function hasFirstFrameLameTag(bytes) {
    const tagEnd = id3TagEnd(bytes) ?? 0;

    // Only trust a header followed by another valid frame. A compressed payload
    // can contain bytes that look like an MP3 sync word.
    for (let index = Math.max(0, tagEnd - 10);
        index < Math.min(bytes.length - 4, tagEnd + 4096); index++) {
        const length = mp3FrameLength(bytes, index);
        if (!length || !mp3FrameLength(bytes, index + length)) continue;
        const frame = bytes.subarray(index, index + length);
        for (let offset = 0; offset <= frame.length - 4; offset++) {
            if (frame[offset] === 0x4c && frame[offset + 1] === 0x41 &&
                frame[offset + 2] === 0x4d && frame[offset + 3] === 0x45) return true;
        }
        return false;
    }
    return null;
}

async function matchLegacyMp3GapHandling(encodedAudio, audioBuffer) {
    if (hasFirstFrameLameTag(encodedAudio) !== false) return audioBuffer;

    // mpg123 trims an assumed 529-sample decoder delay when no encoder delay
    // is recorded. osu!lazer's BASS_CONFIG_MP3_OLDGAPS retains those samples.
    // Compare both mpg123 modes so explicit trim data still takes precedence.
    const decoder = new MPEGDecoder({ enableGapless: false });
    await decoder.ready;
    let untrimmed;
    try {
        untrimmed = decoder.decode(encodedAudio);
    } finally {
        decoder.free();
    }
    if (untrimmed.errors.length || untrimmed.sampleRate !== audioBuffer.sampleRate ||
        untrimmed.samplesDecoded - audioBuffer.channelData[0].length !== 529) {
        return audioBuffer;
    }
    return untrimmed;
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
    let audioBuffer = await decodeWithId3PaddingFallback(encodedAudio);
    if (path.toLowerCase().endsWith(".mp3")) {
        audioBuffer = await matchLegacyMp3GapHandling(encodedAudio, audioBuffer);
    }
    const mono = downmix(audioBuffer);

    return {
        durationMs: mono.length / audioBuffer.sampleRate * 1000,
        samples: resampleLinear(mono, audioBuffer.sampleRate, MODEL_SAMPLE_RATE),
        sourceSampleRate: audioBuffer.sampleRate,
    };
}
