import FFT from "fft.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createSpectrogram } from "./mel-spectrogram.js";
import {
    MODEL_URL,
    FILTER_URL,
    WINDOW_URL,
    inferSpectrogram,
} from "./beat-this-inference.js";
import { beatsFromProbabilities } from "./beat-postprocessing.js";
export {
    DEFAULT_BEAT_THRESHOLD,
    pickBeatPeaks,
} from "./beat-postprocessing.js";
let sessionPromise, coefficientsPromise;
async function loadSession() {
    const ort = await import("onnxruntime-node");
    const session = await ort.InferenceSession.create(
        fileURLToPath(MODEL_URL),
        {
            executionProviders: ["cpu"],
            graphOptimizationLevel: "all",
            intraOpNumThreads: 4,
        },
    );
    return { ort, session };
}
async function coefficients() {
    const values = await Promise.all(
        [FILTER_URL, WINDOW_URL].map(async (url) => {
            const data = await readFile(url);
            return new Float32Array(
                data.buffer.slice(
                    data.byteOffset,
                    data.byteOffset + data.byteLength,
                ),
            );
        }),
    );
    return { filters: values[0], window: values[1] };
}
export async function inferBeatFrames(samples, { onProgress } = {}) {
    coefficientsPromise ??= coefficients();
    const spect = createSpectrogram(
        samples,
        FFT,
        await coefficientsPromise,
        (fraction) =>
            onProgress?.({
                stage: "Preparing spectrogram",
                fraction: fraction * 0.4,
            }),
    );
    onProgress?.({ stage: "Loading Beat This! Small", fraction: 0.4 });
    sessionPromise ??= loadSession();
    const { ort, session } = await sessionPromise;
    return inferSpectrogram(ort, session, spect, (fraction) =>
        onProgress?.({
            stage: "Detecting beats",
            fraction: 0.4 + 0.6 * fraction,
        }),
    );
}
export async function detectBeats(samples, options = {}) {
    const frames = await inferBeatFrames(samples, options);
    return beatsFromProbabilities(frames.probabilities, {
        ...options,
        ...frames,
    });
}
