import { MODEL_HOP_LENGTH, MODEL_SAMPLE_RATE } from "./mel-spectrogram.js";

export const DEFAULT_BEAT_THRESHOLD = 0.33;

export function beatsFromProbabilities(probabilities, { threshold = DEFAULT_BEAT_THRESHOLD } = {}) {
    const smoothedProbabilities = smoothProbabilities(probabilities);
    const ticks = pickBeatPeaks(smoothedProbabilities, threshold);
    const confidence = ticks.length
        ? ticks.reduce(
            (sum, tick) => sum + smoothedProbabilities[Math.round(
                tick * MODEL_SAMPLE_RATE / MODEL_HOP_LENGTH
            )],
            0
        ) / ticks.length
        : 0;

    return { ticks, confidence, probabilities, smoothedProbabilities };
}

export function smoothProbabilities(probabilities) {
    // Equivalent to numpy.hamming(5), normalized, followed by convolution in
    // "same" mode in the Python evaluation code.
    const weights = [0.08, 0.54, 1, 0.54, 0.08];
    const weightSum = weights.reduce((sum, value) => sum + value, 0);
    const smoothed = new Float32Array(probabilities.length);

    for (let index = 0; index < probabilities.length; index++) {
        let value = 0;
        for (let offset = -2; offset <= 2; offset++) {
            const source = index + offset;
            if (source >= 0 && source < probabilities.length) {
                value += probabilities[source] * weights[offset + 2];
            }
        }
        smoothed[index] = value / weightSum;
    }
    return smoothed;
}

export function pickBeatPeaks(probabilities, threshold = DEFAULT_BEAT_THRESHOLD) {
    const candidates = [];
    for (let index = 1; index < probabilities.length - 1; index++) {
        if (
            probabilities[index] >= threshold &&
            probabilities[index] > probabilities[index - 1] &&
            probabilities[index] >= probabilities[index + 1]
        ) {
            candidates.push(index);
        }
    }

    // scipy.signal.find_peaks enforces distance by retaining the taller peak.
    const retained = [];
    for (const candidate of candidates.sort(
        (left, right) => probabilities[right] - probabilities[left]
    )) {
        if (retained.every((other) => Math.abs(other - candidate) >= 5)) {
            retained.push(candidate);
        }
    }

    return retained.sort((left, right) => left - right)
        .map((frame) => frame * MODEL_HOP_LENGTH / MODEL_SAMPLE_RATE);
}
