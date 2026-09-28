import FFT from "fft.js";

import {
    MODEL_CONTEXT_FRAMES,
    MODEL_MEL_BANDS,
    createMultiViewSpectrogram,
    packContextWindows,
} from "./mel-spectrogram.js";
import { beatsFromProbabilities } from "./beat-postprocessing.js";

export { DEFAULT_BEAT_THRESHOLD, pickBeatPeaks } from "./beat-postprocessing.js";
const BATCH_SIZE = 32;
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

export async function inferBeatProbabilities(samples, { onProgress } = {}) {
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

    return probabilities;
}

export async function detectBeats(samples, options = {}) {
    const probabilities = await inferBeatProbabilities(samples, options);
    return beatsFromProbabilities(probabilities, options);
}
