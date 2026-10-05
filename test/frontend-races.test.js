import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

async function harness() {
    const elements = new Map();
    const element = (id) => {
        if (!elements.has(id)) elements.set(id, {
            value: id === "tempoPattern" ? "continuous" : "5",
            addEventListener(type, handler) { this[type] = handler; },
            focus() {},
        });
        return elements.get(id);
    };
    const decodes = new Map(), loads = [], analyses = [], sources = [];
    const context = {
        state: "running", currentTime: 0,
        resume() { return this.resuming.promise; },
        createBufferSource() {
            const source = { connect() {}, start() { this.started = true; }, stop() {} };
            sources.push(source);
            return source;
        },
    };
    const waveform = {
        on() {}, zoom() {}, setTime() {},
        loadBlob(file) {
            const load = { file, ...deferred() };
            loads.push(load);
            return load.promise;
        },
    };
    const source = (await readFile(new URL("../frontend.js", import.meta.url), "utf8"))
        .replace(/^import\s[\s\S]*?;\n/gm, "");
    const sandbox = {
        document: { getElementById: element, createElement: () => ({ style: {} }) },
        AudioContext: function () { return context; },
        WaveSurfer: { create: () => waveform },
        Regions: { create: () => ({ clearRegions() {}, addRegion() {} }) },
        Chart: function () { this.destroy = () => {}; this.update = () => {}; this.data = { datasets: [{}, {}] }; },
        decodeAudio: (key) => decodes.get(key).promise,
        detectBeats: (samples, options) => {
            const analysis = { samples, options, ...deferred() };
            analyses.push(analysis);
            return analysis.promise;
        },
        filterSpuriousBeats: (ticks) => ticks,
        interpolateBeatGaps: (ticks) => ticks,
        defaultTempoSmoothness: () => 5, defaultToleranceMs: () => 5,
        doubleTicks: (ticks) => ticks, halveTicks: (ticks) => ticks,
        calculateTiming: () => ({ averageBpm: 120, tempoPattern: "continuous",
            gridTicks: [], timingPoints: [], rawBpmSeries: [], smoothedBpmSeries: [], osuTimingPoints: "new grid" }),
        createMetronomeBuffer: () => ({}), mixBuffers: (_, audio) => audio,
        requestAnimationFrame() {},
    };
    vm.runInNewContext(source + "\nglobalThis.app = { state, playMixed, pauseMixed };", sandbox);
    const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
    const select = (name) => {
        decodes.set(name, deferred());
        const file = { name, arrayBuffer: async () => name };
        const done = element("audioFile").change({ target: { files: [file] } });
        return { file, done };
    };
    const decoded = (marker) => ({ samples: new Float32Array([marker]), audioBuffer: { duration: 2, sampleRate: 8000 } });
    const ready = async (name, marker) => {
        const selection = select(name);
        await flush();
        decodes.get(name).resolve(decoded(marker));
        await flush();
        loads.at(-1).resolve();
        await selection.done;
    };
    return { element, decodes, loads, analyses, sources, context, app: sandbox.app, select, decoded, ready, flush };
}

test("rapid file changes discard stale decodes and serialize waveform loads", async () => {
    const h = await harness();
    const first = h.select("first");
    await h.flush();
    h.decodes.get("first").resolve(h.decoded(1));
    await h.flush();
    assert.equal(h.element("calculate").disabled, true);
    await h.element("calculate").onclick();
    assert.equal(h.analyses.length, 0);
    const second = h.select("second");
    await h.flush();
    h.decodes.get("second").resolve(h.decoded(2));
    await h.flush();
    assert.equal(h.loads.length, 1);
    h.loads[0].resolve();
    await first.done;
    await h.flush();
    assert.equal(h.loads.length, 2);
    assert.equal(h.app.state.track.samples, null);
    h.loads[1].resolve();
    await second.done;
    assert.equal(h.app.state.track.file.name, "second");
    assert.equal(h.app.state.track.samples[0], 2);
    assert.equal(h.element("calculate").disabled, false);

    const slow = h.select("slow"), fast = h.select("fast");
    await h.flush();
    h.decodes.get("fast").resolve(h.decoded(4));
    await h.flush();
    h.loads.at(-1).resolve();
    await fast.done;
    h.decodes.get("slow").resolve(h.decoded(3));
    await slow.done;
    assert.equal(h.app.state.track.file.name, "fast");
});

test("duplicate calculations and stale progress/results cannot overwrite a new track", async () => {
    const h = await harness();
    await h.ready("first", 1);
    assert.equal(h.element("play").disabled, true);
    await h.element("play").onclick();
    assert.equal(h.sources.length, 0);
    const analysis = h.element("calculate").onclick();
    await h.element("calculate").onclick();
    assert.equal(h.analyses.length, 1);
    h.element("tempoSmoothness").oninput();
    h.element("tempoPattern").onchange();
    const next = h.select("next");
    h.analyses[0].options.onProgress({ stage: "Old progress", fraction: 1 });
    assert.equal(h.element("results").textContent, "Loading audio...");
    h.analyses[0].resolve({ ticks: [0, 1] });
    await analysis;
    assert.equal(h.app.state.track.ticks.length, 0);
    assert.equal(h.element("calculate").disabled, true);
    await h.flush();
    h.decodes.get("next").reject(new Error("bad audio"));
    await next.done;
    assert.match(h.element("results").textContent, /Audio loading failed/);
    assert.equal(h.element("calculate").disabled, true);
    await h.ready("recovered", 3);
    const retry = h.element("calculate").onclick();
    h.analyses[1].resolve({ ticks: [0, 1], confidence: 1, backend: "wasm",
        timings: { totalMs: 1, inferenceMs: 1, spectrogramMs: 0 } });
    await retry;
    assert.equal(h.element("osuTimingPoints").value, "new grid");
    assert.equal(h.element("calculate").disabled, false);
    assert.equal(h.element("play").disabled, false);
});

test("pause or a new file cancels pending playback; repeated Play starts only one source", async () => {
    const h = await harness();
    h.context.state = "suspended";
    h.context.resuming = deferred();
    h.app.state.playback.mixedBuffer = { duration: 2 };
    const pending = h.app.playMixed();
    h.app.pauseMixed();
    h.context.resuming.resolve();
    await pending;
    assert.equal(h.sources.length, 0);
    h.context.resuming = deferred();
    const first = h.app.playMixed(), second = h.app.playMixed();
    h.context.resuming.resolve();
    await Promise.all([first, second]);
    assert.equal(h.sources.length, 1);
    h.app.pauseMixed();
    h.context.resuming = deferred();
    const third = h.app.playMixed();
    const selection = h.select("new");
    h.context.resuming.resolve();
    await third;
    assert.equal(h.sources.length, 1);
    await h.flush();
    h.decodes.get("new").reject(new Error("bad audio"));
    await selection.done;
});
