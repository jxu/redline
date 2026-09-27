import {
    MODEL_CONTEXT_FRAMES,
    MODEL_HOP_LENGTH,
    MODEL_MEL_BANDS,
    MODEL_SAMPLE_RATE,
    createMultiViewSpectrogram,
    packContextWindows,
} from "./mel-spectrogram.js";

export const DEFAULT_BEAT_THRESHOLD = 0.33;
const BATCH_SIZE = 128;
const MODEL_URL = new URL("./models/senet.onnx", import.meta.url);
let runtimePromise;
let sessionPromise;

async function loadRuntime() {
    if (typeof window === "undefined") return import("onnxruntime-node");

    const ort = await import("onnxruntime-web");
    ort.env.wasm.wasmPaths =
        "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated
        ? Math.min(4, navigator.hardwareConcurrency || 1)
        : 1;
    return ort;
}

async function loadSession() {
    runtimePromise ??= loadRuntime();
    const ort = await runtimePromise;
    const modelLocation = typeof window === "undefined"
        ? decodeURIComponent(MODEL_URL.pathname)
        : MODEL_URL.href;
    // WASM is the portable baseline. WebGPU can be added after validating its
    // operator coverage and performance across actual target browsers.
    const executionProviders = typeof window === "undefined" ? ["cpu"] : ["wasm"];

    const session = await ort.InferenceSession.create(modelLocation, {
        executionProviders,
        graphOptimizationLevel: "all",
    });
    return { ort, session };
}

function smoothProbabilities(probabilities) {
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

export async function detectBeats(samples, { onProgress, threshold = DEFAULT_BEAT_THRESHOLD } = {}) {
    onProgress?.({ stage: "Preparing spectrogram", fraction: 0 });
    const views = await createMultiViewSpectrogram(samples, (fraction) =>
        onProgress?.({ stage: "Preparing spectrogram", fraction: fraction * 0.45 })
    );
    const frameCount = views[0].frameCount;

    onProgress?.({ stage: "Loading SENet model", fraction: 0.45 });
    sessionPromise ??= loadSession();
    const { ort, session } = await sessionPromise;
    const probabilities = new Float32Array(frameCount);

    for (let firstFrame = 0; firstFrame < frameCount; firstFrame += BATCH_SIZE) {
        const batchSize = Math.min(BATCH_SIZE, frameCount - firstFrame);
        const input = packContextWindows(views, firstFrame, batchSize);
        const tensor = new ort.Tensor(
            "float32",
            input,
            [batchSize, 3, MODEL_MEL_BANDS, MODEL_CONTEXT_FRAMES]
        );
        const output = await session.run({ spectrogram_windows: tensor });
        probabilities.set(output.beat_probability.data, firstFrame);
        onProgress?.({
            stage: "Detecting beats",
            fraction: 0.45 + 0.55 * (firstFrame + batchSize) / frameCount,
        });
    }

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
