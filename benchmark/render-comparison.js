import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { MODEL_SAMPLE_RATE } from "../audio-decoder.js";
import { decodeAudioFile } from "./audio-decoder.js";

const benchmarkDirectory = dirname(fileURLToPath(import.meta.url));
const mapsetId = process.argv[2];
const additionalRankedOffsetMs = Number(process.argv[3] ?? 0);

if (!mapsetId) {
    throw new Error(
        "Usage: node benchmark/render-comparison.js <mapset-id> [additional-ranked-offset-ms]"
    );
}
if (!Number.isFinite(additionalRankedOffsetMs)) throw new Error("Offset must be a number");

const manifest = JSON.parse(await readFile(`${benchmarkDirectory}/manifest.json`, "utf8"));
const benchmarkCase = manifest.find(({ id }) => id === mapsetId);
if (!benchmarkCase) throw new Error(`Unknown mapset ID: ${mapsetId}`);

const resultPath = `${benchmarkDirectory}/results/${mapsetId}.json`;
const result = JSON.parse(await readFile(resultPath, "utf8"));
const audioPath = fileURLToPath(new URL(benchmarkCase.audio, import.meta.url));
const decoded = await decodeAudioFile(audioPath);

function mixClicks(samples, ticksMs) {
    const mixed = samples.slice();
    const clickLength = Math.floor(0.05 * MODEL_SAMPLE_RATE);

    for (const tickMs of ticksMs) {
        const start = Math.floor(tickMs / 1000 * MODEL_SAMPLE_RATE);
        for (let index = 0; index < clickLength && start + index < mixed.length; index++) {
            const time = index / MODEL_SAMPLE_RATE;
            const click = Math.sin(2 * Math.PI * 1000 * time) *
                (1 - index / clickLength) * 0.8;
            mixed[start + index] = Math.max(-1, Math.min(1, mixed[start + index] + click));
        }
    }

    return mixed;
}

function encodeMonoPcm16Wav(samples) {
    const bytesPerSample = 2;
    const dataLength = samples.length * bytesPerSample;
    const wav = Buffer.alloc(44 + dataLength);

    wav.write("RIFF", 0);
    wav.writeUInt32LE(36 + dataLength, 4);
    wav.write("WAVE", 8);
    wav.write("fmt ", 12);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(MODEL_SAMPLE_RATE, 24);
    wav.writeUInt32LE(MODEL_SAMPLE_RATE * bytesPerSample, 28);
    wav.writeUInt16LE(bytesPerSample, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(dataLength, 40);

    samples.forEach((sample, index) => {
        const clamped = Math.max(-1, Math.min(1, sample));
        const pcm = clamped < 0
            ? Math.round(clamped * 32768)
            : Math.round(clamped * 32767);
        wav.writeInt16LE(pcm, 44 + index * bytesPerSample);
    });

    return wav;
}

const outputDirectory = `${benchmarkDirectory}/listening/${mapsetId}`;
const rankedPath = `${outputDirectory}/ranked-grid.wav`;
const redlinePath = `${outputDirectory}/redline-grid.wav`;
const offsetLabel = additionalRankedOffsetMs >= 0
    ? `plus-${additionalRankedOffsetMs}ms`
    : `minus-${Math.abs(additionalRankedOffsetMs)}ms`;
const adjustedRankedPath = `${outputDirectory}/ranked-grid-${offsetLabel}.wav`;

await mkdir(outputDirectory, { recursive: true });
const writes = [
    writeFile(
        rankedPath,
        encodeMonoPcm16Wav(mixClicks(decoded.samples, result.referenceBeatsMs))
    ),
    writeFile(
        redlinePath,
        encodeMonoPcm16Wav(mixClicks(decoded.samples, result.detectedBeatsMs))
    ),
];

if (additionalRankedOffsetMs !== 0) {
    const adjustedRankedBeatsMs = result.referenceBeatsMs.map(
        (beatMs) => beatMs + additionalRankedOffsetMs
    );
    writes.push(writeFile(
        adjustedRankedPath,
        encodeMonoPcm16Wav(mixClicks(decoded.samples, adjustedRankedBeatsMs))
    ));
}

await Promise.all(writes);

console.log(`Ranked grid:  ${rankedPath}`);
if (additionalRankedOffsetMs !== 0) {
    console.log(`Ranked ${additionalRankedOffsetMs >= 0 ? "+" : ""}${additionalRankedOffsetMs} ms: ${adjustedRankedPath}`);
}
console.log(`Redline grid: ${redlinePath}`);
