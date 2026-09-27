export const MODEL_SAMPLE_RATE = 16000;
export const MODEL_HOP_LENGTH = 160;
export const MODEL_MEL_BANDS = 80;
export const MODEL_CONTEXT_FRAMES = 101;

const VIEW_CONFIGS = [
    { windowLength: 368, fftSize: 512 },
    { windowLength: 736, fftSize: 1024 },
    { windowLength: 1488, fftSize: 2048 },
];

function hzToMel(frequency) {
    return 2595 * Math.log10(1 + frequency / 700);
}

function melToHz(mel) {
    return 700 * (10 ** (mel / 2595) - 1);
}

function createMelFilters(fftSize) {
    const frequencyCount = fftSize / 2 + 1;
    const minMel = hzToMel(27.5);
    // Match the trained model, including its 16 kHz upper bound on 16 kHz
    // audio. Its highest mel filters consequently have no bins below Nyquist.
    const maxMel = hzToMel(16000);
    const points = Array.from({ length: MODEL_MEL_BANDS + 2 }, (_, index) =>
        melToHz(minMel + (maxMel - minMel) * index / (MODEL_MEL_BANDS + 1))
    );

    return Array.from({ length: MODEL_MEL_BANDS }, (_, band) => {
        const left = points[band];
        const center = points[band + 1];
        const right = points[band + 2];
        const bins = [];
        const weights = [];

        for (let bin = 0; bin < frequencyCount; bin++) {
            const frequency = bin * MODEL_SAMPLE_RATE / fftSize;
            const weight = frequency < center
                ? (frequency - left) / (center - left)
                : (right - frequency) / (right - center);
            if (weight > 0) {
                bins.push(bin);
                weights.push(weight);
            }
        }

        return { bins, weights };
    });
}

function createViews(FFT) {
    return VIEW_CONFIGS.map((config) => ({
        ...config,
        fft: new FFT(config.fftSize),
        window: Float64Array.from(
            { length: config.windowLength },
            (_, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * index / config.windowLength)
        ),
        filters: createMelFilters(config.fftSize),
    }));
}

function reflectedSample(samples, index) {
    // torch.stft(center=true) uses reflect padding around the waveform.
    while (index < 0 || index >= samples.length) {
        if (index < 0) index = -index;
        if (index >= samples.length) index = 2 * samples.length - 2 - index;
    }
    return samples[index];
}

function yieldToHost() {
    if (typeof requestAnimationFrame === "function") {
        return new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return new Promise((resolve) => setTimeout(resolve, 0));
}

async function calculateView(samples, view, onProgress) {
    const frameCount = Math.floor(samples.length / MODEL_HOP_LENGTH) + 1;
    const mel = new Float32Array(MODEL_MEL_BANDS * frameCount);
    const fftInput = new Float64Array(view.fftSize);
    const fftOutput = view.fft.createComplexArray();
    const magnitude = new Float64Array(view.fftSize / 2 + 1);
    const windowOffset = (view.fftSize - view.windowLength) / 2;

    for (let frame = 0; frame < frameCount; frame++) {
        fftInput.fill(0);
        const frameStart = frame * MODEL_HOP_LENGTH - view.fftSize / 2;
        for (let index = 0; index < view.windowLength; index++) {
            fftInput[windowOffset + index] =
                reflectedSample(samples, frameStart + windowOffset + index) * view.window[index];
        }

        view.fft.realTransform(fftOutput, fftInput);
        for (let bin = 0; bin < magnitude.length; bin++) {
            const real = fftOutput[2 * bin];
            const imaginary = fftOutput[2 * bin + 1];
            magnitude[bin] = Math.hypot(real, imaginary);
        }

        for (let band = 0; band < MODEL_MEL_BANDS; band++) {
            const { bins, weights } = view.filters[band];
            let value = 0;
            for (let index = 0; index < bins.length; index++) {
                value += magnitude[bins[index]] * weights[index];
            }
            mel[band * frameCount + frame] = Math.log(value + 1e-9);
        }

        if (frame % 128 === 127) {
            onProgress?.((frame + 1) / frameCount);
            await yieldToHost();
        }
    }

    // Match torch.std's default sample correction (N - 1).
    let sum = 0;
    for (const value of mel) sum += value;
    const mean = sum / mel.length;
    let squaredDifference = 0;
    for (const value of mel) squaredDifference += (value - mean) ** 2;
    const standardDeviation = Math.sqrt(squaredDifference / (mel.length - 1)) + 1e-6;
    for (let index = 0; index < mel.length; index++) {
        mel[index] = (mel[index] - mean) / standardDeviation;
    }

    onProgress?.(1);
    return { values: mel, frameCount };
}

export async function createMultiViewSpectrogram(samples, FFT, onProgress) {
    const configurations = createViews(FFT);
    const views = [];
    for (let index = 0; index < configurations.length; index++) {
        views.push(await calculateView(samples, configurations[index], (fraction) =>
            onProgress?.((index + fraction) / configurations.length)
        ));
    }
    return views;
}

export function packContextWindows(views, firstFrame, batchSize) {
    const packed = new Float32Array(
        batchSize * views.length * MODEL_MEL_BANDS * MODEL_CONTEXT_FRAMES
    );
    const radius = Math.floor(MODEL_CONTEXT_FRAMES / 2);
    let outputIndex = 0;

    for (let batch = 0; batch < batchSize; batch++) {
        const center = firstFrame + batch;
        for (const view of views) {
            for (let band = 0; band < MODEL_MEL_BANDS; band++) {
                const bandOffset = band * view.frameCount;
                for (let context = -radius; context <= radius; context++) {
                    const frame = center + context;
                    packed[outputIndex++] = frame < 0 || frame >= view.frameCount
                        ? 0
                        : view.values[bandOffset + frame];
                }
            }
        }
    }

    return packed;
}
