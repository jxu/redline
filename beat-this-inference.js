import { MODEL_MEL_BANDS } from "./mel-spectrogram.js";
export const MODEL_URL = new URL(
    "./models/beat-this-small.onnx",
    import.meta.url,
);
export const FILTER_URL = new URL(
    "./models/beat-this-mel-filter.f32",
    import.meta.url,
);
export const WINDOW_URL = new URL(
    "./models/beat-this-window.f32",
    import.meta.url,
);
const CHUNK_FRAMES = 1500,
    BORDER_FRAMES = 6;

// Match split_piece(avoid_short_end=True) and keep_first aggregation upstream.
export async function inferSpectrogram(
    ort,
    session,
    { data, frameCount },
    onProgress,
) {
    const starts = [];
    for (
        let start = -BORDER_FRAMES;
        start < frameCount - BORDER_FRAMES;
        start += CHUNK_FRAMES - 2 * BORDER_FRAMES
    )
        starts.push(start);
    if (frameCount > CHUNK_FRAMES - 2 * BORDER_FRAMES)
        starts[starts.length - 1] = frameCount - (CHUNK_FRAMES - BORDER_FRAMES);
    const probabilities = new Float32Array(frameCount),
        downbeatProbabilities = new Float32Array(frameCount);
    let completed = 0;
    // Earlier chunks overwrite overlap, as in the Python keep_first mode.
    for (const start of starts.toReversed()) {
        const first = Math.max(start, 0),
            end = Math.min(start + CHUNK_FRAMES, frameCount);
        const left = Math.max(0, -start),
            right = Math.max(
                0,
                Math.min(BORDER_FRAMES, start + CHUNK_FRAMES - frameCount),
            );
        const frames = end - first + left + right;
        const input = new Float32Array(frames * MODEL_MEL_BANDS);
        input.set(
            data.subarray(first * MODEL_MEL_BANDS, end * MODEL_MEL_BANDS),
            left * MODEL_MEL_BANDS,
        );
        const tensor = new ort.Tensor("float32", input, [
            1,
            frames,
            MODEL_MEL_BANDS,
        ]);
        let output;
        try {
            output = await session.run({ spectrogram: tensor });
            for (let i = BORDER_FRAMES; i < frames - BORDER_FRAMES; i++) {
                const destination = start + i;
                probabilities[destination] =
                    1 / (1 + Math.exp(-output.beat.data[i]));
                downbeatProbabilities[destination] =
                    1 / (1 + Math.exp(-output.downbeat.data[i]));
            }
        } finally {
            tensor.dispose();
            if (output)
                Object.values(output).forEach((tensor) => tensor.dispose());
        }
        onProgress?.(++completed / starts.length);
    }
    return { probabilities, downbeatProbabilities, probabilityFrameMs: 20 };
}
