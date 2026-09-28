import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { inferBeatProbabilities } from "../beat-detector.js";
import { MODEL_HOP_LENGTH, MODEL_SAMPLE_RATE } from "../mel-spectrogram.js";
import { decodeAudioFile } from "./audio-decoder.js";

const schemaVersion = 1;
const defaultDirectory = new URL("./cache/probabilities/", import.meta.url);
// Postprocessing and timing code deliberately do not participate: changing
// smoothing, peak thresholds, filtering, or regression must reuse raw inference.
const inferenceFiles = [
    "../models/senet.onnx",
    "../beat-detector.js",
    "../mel-spectrogram.js",
    "../audio-decoder.js",
    "./audio-decoder.js",
    "../package-lock.json",
].map((path) => new URL(path, import.meta.url));

async function sha256File(path) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
}

export function createProbabilityCache({
    directory = defaultDirectory,
    dependencies = inferenceFiles,
    decode = decodeAudioFile,
    infer = inferBeatProbabilities,
} = {}) {
    let dependencyHashes;

    return async function getProbabilities(audioPath, { refresh = false, requireCached = false } = {}) {
        if (refresh && requireCached) throw new Error("Cannot refresh probabilities in regression-only mode");
        dependencyHashes ??= Promise.all(dependencies.map(sha256File));
        const identity = {
            schemaVersion,
            audioSha256: await sha256File(audioPath),
            inferenceSha256: await dependencyHashes,
            nodeVersion: process.version,
            platform: process.platform,
            architecture: process.arch,
            executionProvider: "cpu",
            sampleRate: MODEL_SAMPLE_RATE,
            hopLength: MODEL_HOP_LENGTH,
        };
        const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
        const path = directory instanceof URL
            ? new URL(`${key}.json`, directory)
            : join(directory, `${key}.json`);
        let entry;
        if (!refresh) {
            try {
                entry = JSON.parse(await readFile(path, "utf8"));
            } catch (error) {
                if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
            }
            if (validEntry(entry, identity)) {
                return { ...entry, probabilities: Float32Array.from(entry.probabilities), cache: { key, hit: true } };
            }
        }
        if (requireCached) {
            throw new Error(`Missing or invalid probability cache for ${audioPath}. Run npm run benchmark:cache first.`);
        }

        const decoded = await decode(audioPath);
        const probabilities = await infer(decoded.samples);
        entry = {
            identity,
            durationMs: decoded.durationMs,
            sourceSampleRate: decoded.sourceSampleRate,
            sampleCount: decoded.samples.length,
            frameCount: probabilities.length,
            probabilities: Array.from(probabilities),
        };
        if (!validEntry(entry, identity)) throw new Error(`Invalid inference output for ${audioPath}`);
        await mkdir(directory, { recursive: true });
        const temporaryPath = path instanceof URL
            ? new URL(`${key}.${randomUUID()}.tmp`, directory)
            : `${path}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporaryPath, `${JSON.stringify(entry)}\n`, { flag: "wx" });
            await rename(temporaryPath, path);
        } finally {
            await rm(temporaryPath, { force: true });
        }
        return { ...entry, probabilities: Float32Array.from(entry.probabilities), cache: { key, hit: false } };
    };
}

function validEntry(entry, identity) {
    return entry != null && JSON.stringify(entry.identity) === JSON.stringify(identity) &&
        Number.isFinite(entry.durationMs) && entry.durationMs > 0 &&
        Number.isFinite(entry.sourceSampleRate) && entry.sourceSampleRate > 0 &&
        Number.isInteger(entry.sampleCount) && entry.sampleCount > 0 &&
        entry.frameCount === Math.floor(entry.sampleCount / MODEL_HOP_LENGTH) + 1 &&
        Array.isArray(entry.probabilities) && entry.probabilities.length === entry.frameCount &&
        entry.probabilities.every((value) => Number.isFinite(value) && value >= 0 && value <= 1);
}
