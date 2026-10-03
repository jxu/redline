import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { decodeAudioFile } from "../audio-decoder.js";
const id = process.argv[2] ?? "13012";
const manifest = JSON.parse(
    await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
);
const entry = manifest.find((entry) => entry.id === id);
if (!entry) throw new Error(`Unknown mapset: ${id}`);
const decoded = await decodeAudioFile(
    fileURLToPath(new URL(entry.audio, new URL("../", import.meta.url))),
    22050,
);
if (decoded.samples.length < 30 * 22050)
    throw new Error("Fixture requires at least 30 seconds");
const samples = decoded.samples.slice(0, 30 * 22050);
const directory = new URL("./artifacts/", import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(
    new URL("full-audio.f32", directory),
    Buffer.from(
        decoded.samples.buffer,
        decoded.samples.byteOffset,
        decoded.samples.byteLength,
    ),
);
await writeFile(
    new URL("audio.f32", directory),
    Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength),
);
await writeFile(
    new URL("audio.json", directory),
    JSON.stringify({ mapsetId: id }) + "\n",
);
console.log(`Prepared 30 seconds from mapset ${id}`);
