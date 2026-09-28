import FFT from "https://esm.sh/fft.js@4.0.4";
import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.min.mjs";

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

const BATCH_SIZE = 128;
const MODEL_URL = new URL("./models/senet.onnx", import.meta.url);
let sessionPromise;

ort.env.wasm.wasmPaths =
    "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
ort.env.wasm.numThreads = globalThis.crossOriginIsolated
    ? Math.min(4, navigator.hardwareConcurrency || 1)
    : 1;

async function loadSession() {
    if (navigator.gpu) {
        try {
            const session = await ort.InferenceSession.create(MODEL_URL.href, {
                executionProviders: ["webgpu"],
                graphOptimizationLevel: "all",
            });
            return { session, backend: "webgpu" };
        } catch (error) {
            console.warn("SENet WebGPU initialization failed; using WASM", error);
        }
    }

    const session = await ort.InferenceSession.create(MODEL_URL.href, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
    });
    return { session, backend: "wasm" };
}

function reportProgress(id, stage, fraction) {
    self.postMessage({ type: "progress", id, progress: { stage, fraction } });
}

async function detectBeats(samples, id, threshold = DEFAULT_BEAT_THRESHOLD) {
    const startedAt = performance.now();
    reportProgress(id, "Preparing spectrogram", 0);
    const views = createMultiViewSpectrogram(samples, FFT, (fraction) =>
        reportProgress(id, "Preparing spectrogram", fraction * 0.45)
    );
    const frameCount = views[0].frameCount;
    const spectrogramFinishedAt = performance.now();

    reportProgress(id, "Loading SENet model", 0.45);
    sessionPromise ??= loadSession();
    const { session, backend } = await sessionPromise;
    const modelLoadedAt = performance.now();
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
        reportProgress(
            id,
            `Detecting beats (${backend === "webgpu" ? "WebGPU" : "WASM"})`,
            0.45 + 0.55 * (firstFrame + batchSize) / frameCount
        );
    }

    const inferenceFinishedAt = performance.now();
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
    const finishedAt = performance.now();

    return {
        ticks,
        confidence,
        probabilities,
        smoothedProbabilities,
        backend,
        timings: {
            spectrogramMs: spectrogramFinishedAt - startedAt,
            modelLoadMs: modelLoadedAt - spectrogramFinishedAt,
            inferenceMs: inferenceFinishedAt - modelLoadedAt,
            postprocessingMs: finishedAt - inferenceFinishedAt,
            totalMs: finishedAt - startedAt,
        },
    };
}

self.onmessage = async ({ data: { id, samples, threshold } }) => {
    try {
        const result = await detectBeats(samples, id, threshold);
        self.postMessage(
            { type: "result", id, result },
            [result.probabilities.buffer, result.smoothedProbabilities.buffer]
        );
    } catch (error) {
        self.postMessage({
            type: "error",
            id,
            error: {
                message: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            },
        });
    }
};
