export const MODEL_SAMPLE_RATE = 16000;

// Decode browser-supported audio and produce the 16 kHz mono samples expected
// by BeatSE. The original AudioBuffer is retained for playback.
export async function decodeAudio(arrayBuffer, audioContext) {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
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
