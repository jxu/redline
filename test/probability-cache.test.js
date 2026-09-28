import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createProbabilityCache } from "../benchmark/probability-cache.js";
import { beatsFromProbabilities } from "../beat-postprocessing.js";

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), "redline-probabilities-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const audio = join(root, "audio.wav");
    const model = join(root, "model.onnx");
    const directory = join(root, "cache");
    await writeFile(audio, "audio version 1");
    await writeFile(model, "model version 1");
    let decodes = 0;
    let inferences = 0;
    const probabilities = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0.5, 0, 0, 0]);
    const options = {
        directory,
        dependencies: [model],
        decode: async () => {
            decodes++;
            return { samples: new Float32Array(1600), durationMs: 100, sourceSampleRate: 44100 };
        },
        infer: async () => { inferences++; return probabilities; },
    };
    return { audio, model, directory, probabilities, options, counts: () => [decodes, inferences] };
}

test("persists the full Float32 curve and reuses it across cache instances without decoding or inference", async (t) => {
    const f = await fixture(t);
    const cold = await createProbabilityCache(f.options)(f.audio);
    const warm = await createProbabilityCache(f.options)(f.audio, { requireCached: true });
    assert.equal(cold.cache.hit, false);
    assert.equal(warm.cache.hit, true);
    assert.equal(cold.cache.key, warm.cache.key);
    assert.deepEqual(warm.probabilities, f.probabilities);
    assert.equal(warm.durationMs, 100);
    assert.equal(warm.sourceSampleRate, 44100);
    assert.deepEqual(f.counts(), [1, 1]);
    assert.deepEqual(beatsFromProbabilities(warm.probabilities), beatsFromProbabilities(cold.probabilities));
    assert.notDeepEqual(
        beatsFromProbabilities(warm.probabilities, { threshold: 0.2 }).ticks,
        beatsFromProbabilities(warm.probabilities, { threshold: 0.9 }).ticks
    );
    assert.deepEqual(f.counts(), [1, 1]);
    assert.deepEqual(await readdir(f.directory), [`${cold.cache.key}.json`]);
});

test("audio and model changes invalidate cached probabilities", async (t) => {
    const f = await fixture(t);
    const get = createProbabilityCache(f.options);
    const first = await get(f.audio);
    await writeFile(f.audio, "audio version 2");
    await assert.rejects(get(f.audio, { requireCached: true }), /Missing or invalid probability cache/);
    const changedAudio = await get(f.audio);
    assert.notEqual(changedAudio.cache.key, first.cache.key);
    await writeFile(f.model, "model version 2");
    const changedModel = await createProbabilityCache(f.options)(f.audio);
    assert.notEqual(changedModel.cache.key, changedAudio.cache.key);
    assert.deepEqual(f.counts(), [3, 3]);
});

test("regression-only misses fail without starting inference; refresh deliberately recomputes", async (t) => {
    const f = await fixture(t);
    const get = createProbabilityCache(f.options);
    await assert.rejects(get(f.audio, { requireCached: true }), /benchmark:cache/);
    assert.deepEqual(f.counts(), [0, 0]);
    const first = await get(f.audio);
    const refreshed = await get(f.audio, { refresh: true });
    assert.equal(refreshed.cache.key, first.cache.key);
    assert.equal(refreshed.cache.hit, false);
    assert.deepEqual(f.counts(), [2, 2]);
    await assert.rejects(get(f.audio, { refresh: true, requireCached: true }), /Cannot refresh/);
    assert.deepEqual(f.counts(), [2, 2]);
});

test("malformed, truncated, or invalid curves cannot be reused for regression", async (t) => {
    const f = await fixture(t);
    const get = createProbabilityCache(f.options);
    const first = await get(f.audio);
    const path = join(f.directory, `${first.cache.key}.json`);
    const valid = JSON.parse(await readFile(path, "utf8"));
    for (const invalid of [
        "{",
        JSON.stringify({ ...valid, probabilities: valid.probabilities.slice(1) }),
        JSON.stringify({ ...valid, probabilities: valid.probabilities.map(() => null) }),
        JSON.stringify({ ...valid, probabilities: valid.probabilities.map(() => 2) }),
        JSON.stringify({ ...valid, durationMs: 0 }),
    ]) {
        await writeFile(path, invalid);
        await assert.rejects(get(f.audio, { requireCached: true }), /Missing or invalid/);
    }
    assert.deepEqual(f.counts(), [1, 1]);
    assert.equal((await get(f.audio)).cache.hit, false);
    assert.equal((await get(f.audio, { requireCached: true })).cache.hit, true);
    assert.deepEqual(f.counts(), [2, 2]);
});

test("failed inference leaves no reusable cache or partial file", async (t) => {
    const f = await fixture(t);
    const get = createProbabilityCache({ ...f.options, infer: async () => { throw new Error("model failure"); } });
    await assert.rejects(get(f.audio), /model failure/);
    await assert.rejects(readdir(f.directory), { code: "ENOENT" });
});

test("benchmark CLI refits cached probabilities after timing/reference changes without decoding audio", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "redline-regression-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = fileURLToPath(new URL("../", import.meta.url));
    await mkdir(join(root, "benchmark"));
    for (const directory of ["", "benchmark"]) {
        for (const name of await readdir(join(source, directory))) {
            if (name.endsWith(".js")) await cp(join(source, directory, name), join(root, directory, name));
        }
    }
    for (const name of ["package.json", "package-lock.json"]) await cp(join(source, name), join(root, name));
    for (const name of ["node_modules", "models"]) await symlink(join(source, name), join(root, name), "dir");
    const audio = join(root, "benchmark/audio.wav");
    // Intentionally undecodable: a regression that accidentally invokes audio
    // decoding will fail even before it can reach the model.
    await writeFile(audio, "cached audio fixture");
    const osu = join(root, "benchmark/reference.osu");
    await writeFile(osu, "[TimingPoints]\n0,500,4,2,1,100,1,0\n");
    const manifestPath = join(root, "benchmark/manifest.json");
    const manifest = [{ id: "fixture", name: "Fixture", audio: "./audio.wav", osu: "./reference.osu",
        tempoPattern: "fixed", tempoScale: 1, allowedTempoScales: [1] }];
    await writeFile(manifestPath, JSON.stringify(manifest));
    const run = (...args) => promisify(execFile)(process.execPath, ["benchmark/run.js", ...args], { cwd: root });
    await assert.rejects(run("--regression-only", "fixture"), /Missing or invalid probability cache/);
    const { createProbabilityCache: createCache } = await import(pathToFileURL(join(root, "benchmark/probability-cache.js")));
    const probabilities = new Float32Array(1501);
    for (let frame = 50; frame < 1500; frame += 50) probabilities.fill(1, frame - 1, frame + 2);
    const cached = await createCache({
        decode: async () => ({ samples: new Float32Array(240000), durationMs: 15000, sourceSampleRate: 16000 }),
        infer: async () => probabilities,
    })(audio);
    const prepared = await run("--cache-only", "fixture");
    assert.match(prepared.stdout, /Probabilities: +cached/);
    assert.deepEqual(await readdir(join(root, "benchmark/results")), []);
    await run("--regression-only", "fixture");
    const resultPath = join(root, "benchmark/results/fixture.json");
    const first = JSON.parse(await readFile(resultPath, "utf8"));
    manifest[0].timingOptions = { tempoSmoothness: 20 };
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(osu, "[TimingPoints]\n10,500,4,2,1,100,1,0\n");
    await run("fixture", "--regression-only");
    const second = JSON.parse(await readFile(resultPath, "utf8"));
    assert.deepEqual(second.probabilityCache, { key: cached.cache.key, hit: true });
    assert.deepEqual(second.rawDetectedBeatsMs, first.rawDetectedBeatsMs);
    assert.notDeepEqual(second.referenceBeatsMs, first.referenceBeatsMs);
    assert.equal(second.timingOptions.tempoSmoothness, 20);
    assert.ok(second.detectedBeatsMs.length > 0);
    assert.ok((await readdir(join(root, "benchmark/plots"))).some((name) => name.endsWith(".svg")));
});
