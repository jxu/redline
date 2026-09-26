export const ESSENTIA_SAMPLE_RATE = 44100;

// Decode browser-supported audio and produce the 44.1 kHz mono samples expected
// by RhythmExtractor2013. The original AudioBuffer is retained for playback.
export async function decodeAudio(arrayBuffer, audioContext) {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    const offlineContext = new OfflineAudioContext(
        1,
        Math.ceil(audioBuffer.duration * ESSENTIA_SAMPLE_RATE),
        ESSENTIA_SAMPLE_RATE
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
