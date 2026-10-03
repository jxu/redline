export const MODEL_SAMPLE_RATE = 22050;
export const MODEL_HOP_LENGTH = 441;
export const MODEL_MEL_BANDS = 128;
const FFT_SIZE = 1024;

// Coefficients come from Beat This's torchaudio LogMelSpect transform.
export function createSpectrogram(
    samples,
    FFT,
    { filters, window },
    onProgress,
) {
    if (!samples.length) throw new Error("The decoded audio is empty");
    const frameCount = Math.floor(samples.length / MODEL_HOP_LENGTH) + 1;
    const data = new Float32Array(frameCount * MODEL_MEL_BANDS);
    const fft = new FFT(FFT_SIZE),
        input = new Float64Array(FFT_SIZE);
    const output = fft.createComplexArray(),
        magnitude = new Float64Array(513);
    for (let frame = 0; frame < frameCount; frame++) {
        for (let n = 0; n < FFT_SIZE; n++) {
            let index = frame * MODEL_HOP_LENGTH - FFT_SIZE / 2 + n;
            if (samples.length === 1) index = 0;
            else
                while (index < 0 || index >= samples.length) {
                    if (index < 0) index = -index;
                    if (index >= samples.length)
                        index = 2 * samples.length - 2 - index;
                }
            input[n] = samples[index] * window[n];
        }
        fft.realTransform(output, input);
        for (let k = 0; k < 513; k++)
            magnitude[k] = Math.hypot(output[2 * k], output[2 * k + 1]) / 32;
        for (let band = 0; band < MODEL_MEL_BANDS; band++) {
            let sum = 0;
            for (let k = 0; k < 513; k++)
                sum += magnitude[k] * filters[k * MODEL_MEL_BANDS + band];
            data[frame * MODEL_MEL_BANDS + band] = Math.log1p(1000 * sum);
        }
        if (frame % 100 === 0) onProgress?.(frame / frameCount);
    }
    onProgress?.(1);
    return { data, frameCount };
}
