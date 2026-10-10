import FFT from "https://esm.sh/fft.js@4.0.4";
import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.min.mjs";
import { createSpectrogram } from "./mel-spectrogram.js";
import {
    MODEL_URL,
    FILTER_URL,
    WINDOW_URL,
    inferSpectrogram,
} from "./beat-this-inference.js";
import { beatsFromProbabilities } from "./beat-postprocessing.js";
ort.env.wasm.wasmPaths =
    "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
ort.env.wasm.numThreads = globalThis.crossOriginIsolated
    ? Math.min(4, navigator.hardwareConcurrency || 1)
    : 1;
let sessionPromise, coefficientsPromise;
async function loadSession(backend) {
    if (
        backend !== "wasm" &&
        navigator.gpu &&
        (await navigator.gpu.requestAdapter())
    ) {
        try {
            const session = await ort.InferenceSession.create(MODEL_URL.href, {
                executionProviders: ["webgpu"],
                graphOptimizationLevel: "all",
            });
            return { session, backend: "webgpu" };
        } catch (error) {
            console.warn(
                "Beat This! WebGPU initialization failed; using WASM",
                error,
            );
        }
    }
    const session = await ort.InferenceSession.create(MODEL_URL.href, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
    });
    return { session, backend: "wasm" };
}
async function coefficients() {
    const values = await Promise.all(
        [FILTER_URL, WINDOW_URL].map(async (url) => {
            const response = await fetch(url);
            if (!response.ok)
                throw new Error(
                    `Failed to load Beat This! preprocessing (${response.status})`,
                );
            return new Float32Array(await response.arrayBuffer());
        }),
    );
    return { filters: values[0], window: values[1] };
}
async function detect(samples, id, threshold, requestedBackend) {
    const started = performance.now();
    const progress = (stage, fraction) =>
        self.postMessage({
            type: "progress",
            id,
            progress: { stage, fraction },
        });
    progress("Preparing spectrogram", 0);
    coefficientsPromise ??= coefficients().catch((error) => {
        coefficientsPromise = undefined;
        throw error;
    });
    const spect = createSpectrogram(
        samples,
        FFT,
        await coefficientsPromise,
        (fraction) => progress("Preparing spectrogram", fraction * 0.4),
    );
    const spectrogramFinished = performance.now();
    progress("Loading Beat This! Small model (10.4 MB)", 0.4);
    sessionPromise ??= loadSession(requestedBackend).catch((error) => {
        sessionPromise = undefined;
        throw error;
    });
    let loaded = await sessionPromise;
    const modelLoaded = performance.now();
    let frames;
    try {
        frames = await inferSpectrogram(
            ort,
            loaded.session,
            spect,
            (fraction) => progress("Detecting beats", 0.4 + 0.6 * fraction),
        );
    } catch (error) {
        if (loaded.backend !== "webgpu") throw error;
        console.warn(
            "Beat This! WebGPU inference failed; retrying with WASM",
            error,
        );
        await loaded.session.release().catch(() => {});
        sessionPromise = loadSession("wasm");
        loaded = await sessionPromise;
        frames = await inferSpectrogram(
            ort,
            loaded.session,
            spect,
            (fraction) => progress("Detecting beats", 0.4 + 0.6 * fraction),
        );
    }
    const inferred = performance.now();
    const result = beatsFromProbabilities(frames.probabilities, {
        threshold,
        ...frames,
    });
    return {
        ...result,
        backend: loaded.backend,
        timings: {
            spectrogramMs: spectrogramFinished - started,
            modelLoadMs: modelLoaded - spectrogramFinished,
            inferenceMs: inferred - modelLoaded,
            postprocessingMs: performance.now() - inferred,
            totalMs: performance.now() - started,
        },
    };
}
// Serialize analyses so a fallback cannot release a session another run is using.
let queue = Promise.resolve();
self.onmessage = ({ data: { id, samples, threshold, backend } }) => {
    queue = queue.then(async () => {
        try {
            const result = await detect(samples, id, threshold, backend);
            self.postMessage({ type: "result", id, result }, [
                result.probabilities.buffer,
                result.downbeatProbabilities.buffer,
            ]);
        } catch (error) {
            self.postMessage({
                type: "error",
                id,
                error: {
                    message: error.message || String(error),
                    stack: error.stack,
                },
            });
        }
    });
};
