export const MODEL_SAMPLE_RATE = 16000;

export function mp3FrameLength(bytes, index) {
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

export function id3TagEnd(bytes) {
    if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 ||
        bytes[2] !== 0x33) return null;
    return 10 + ((bytes[6] & 0x7f) << 21) + ((bytes[7] & 0x7f) << 14) +
        ((bytes[8] & 0x7f) << 7) + (bytes[9] & 0x7f) +
        (bytes[5] & 0x10 ? 10 : 0);
}

// Some old MP3s begin with zero bytes before the first valid frame. Remove
// only a short preamble followed by two correctly spaced frame headers.
export function stripLeadingZeroMp3Padding(bytes) {
    let frameStart = 0;
    while (frameStart < Math.min(bytes.length, 4096) && bytes[frameStart] === 0) frameStart++;
    if (!frameStart || frameStart >= 4096) return bytes;
    const frameLength = mp3FrameLength(bytes, frameStart);
    return frameLength && mp3FrameLength(bytes, frameStart + frameLength)
        ? bytes.subarray(frameStart) : bytes;
}

// Chrome can overlook gapless MP3 metadata if padding separates the ID3 tag
// from the first frame. Remove only verified padding before a LAME-tagged frame.
export function removeId3Mp3Padding(arrayBuffer) {
    const originalBytes = new Uint8Array(arrayBuffer);
    const bytes = stripLeadingZeroMp3Padding(originalBytes);
    if (bytes !== originalBytes) return bytes.slice().buffer;
    const tagEnd = id3TagEnd(bytes);
    if (tagEnd === null) return arrayBuffer;
    let frameStart = tagEnd;
    while (frameStart - tagEnd < 16 && bytes[frameStart] === 0) frameStart++;
    if (frameStart === tagEnd) return arrayBuffer;
    const frameLength = mp3FrameLength(bytes, frameStart);
    if (!frameLength || !mp3FrameLength(bytes, frameStart + frameLength)) return arrayBuffer;
    let hasLameTag = false;
    for (let index = frameStart; index <= frameStart + frameLength - 4; index++) {
        if (bytes[index] === 0x4c && bytes[index + 1] === 0x41 &&
            bytes[index + 2] === 0x4d && bytes[index + 3] === 0x45) {
            hasLameTag = true;
            break;
        }
    }
    if (!hasLameTag) return arrayBuffer;
    const normalized = new Uint8Array(bytes.length - (frameStart - tagEnd));
    normalized.set(bytes.subarray(0, tagEnd));
    normalized.set(bytes.subarray(frameStart), tagEnd);
    return normalized.buffer;
}

// Decode browser-supported audio and produce the 16 kHz mono samples expected
// by SENet. The original AudioBuffer is retained for playback.
export async function decodeAudio(arrayBuffer, audioContext) {
    const audioBuffer = await audioContext.decodeAudioData(removeId3Mp3Padding(arrayBuffer));
    const offlineContext = new OfflineAudioContext(
        1,
        Math.ceil(audioBuffer.duration * MODEL_SAMPLE_RATE),
        MODEL_SAMPLE_RATE
    );
    const source = offlineContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineContext.destination);
    source.start();

    const resampledBuffer = await offlineContext.startRendering();

    return {
        audioBuffer,
        samples: resampledBuffer.getChannelData(0),
    };
}
