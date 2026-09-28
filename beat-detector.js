import FFT from "fft.js";

import {
    MODEL_CONTEXT_FRAMES,
    MODEL_HOP_LENGTH,
    MODEL_MEL_BANDS,
    MODEL_SAMPLE_RATE,
    createMultiViewSpectrogram,
    packContextWindows,
} from "./mel-spectrogram.js";
import {
    DEFAULT_BEAT_THRESHOLD,
    pickBeatPeaks,
    smoothProbabilities,
} from "./beat-postprocessing.js";

export { DEFAULT_BEAT_THRESHOLD, pickBeatPeaks } from "./beat-postprocessing.js";
const BATCH_SIZE = 128;
const MODEL_URL = new URL("./models/senet.onnx", import.meta.url);
let sessionPromise;

async function loadSession() {
    const ort = await import("onnxruntime-node");
    const modelLocation = decodeURIComponent(MODEL_URL.pathname);

    const session = await ort.InferenceSession.create(modelLocation, {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
    });
    return { ort, session };
}

export async function detectBeats(samples, { onProgress, threshold = DEFAULT_BEAT_THRESHOLD } = {}) {
    onProgress?.({ stage: "Preparing spectrogram", fraction: 0 });
    const views = createMultiViewSpectrogram(samples, FFT, (fraction) =>
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
