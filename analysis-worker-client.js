import { DEFAULT_BEAT_THRESHOLD } from "./beat-postprocessing.js";

let worker;
let nextRequestId = 1;
const pending = new Map();

function getWorker() {
    if (worker) return worker;

    worker = new Worker(new URL("./analysis-worker.js", import.meta.url), {
        type: "module",
    });
    worker.onmessage = ({ data }) => {
        const request = pending.get(data.id);
        if (!request) return;

        if (data.type === "progress") {
            request.onProgress?.(data.progress);
            return;
        }

        pending.delete(data.id);
        if (data.type === "result") {
            request.resolve(data.result);
        } else {
            const error = new Error(
                data.error?.message || "Beat analysis failed",
            );
            error.stack = data.error?.stack || error.stack;
            request.reject(error);
        }
    };
    worker.onerror = (event) => {
        const error = new Error(event.message || "Beat-analysis worker failed");
        for (const request of pending.values()) request.reject(error);
        pending.clear();
        worker.terminate();
        worker = undefined;
    };
    return worker;
}

export function detectBeats(
    samples,
    { onProgress, threshold = DEFAULT_BEAT_THRESHOLD, backend } = {},
) {
    const requestWorker = getWorker();
    const id = nextRequestId++;
    // Transfer a copy so the caller's saved samples remain usable for another run.
    const workerSamples = samples.slice();

    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onProgress });
        requestWorker.postMessage(
            { id, samples: workerSamples, threshold, backend },
            [workerSamples.buffer],
        );
    });
}
