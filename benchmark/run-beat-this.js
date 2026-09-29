import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { filterSpuriousBeats } from "../beat-filter.js";
import { interpolateBeatGaps } from "../beat-interpolation.js";
import { DEFAULT_TIMING_OPTIONS } from "../timing.js";
import { nearestBeat } from "./osu-timing.js";
import { writeResultPlot } from "./plot-results.js";
import { evaluateTempoScales, selectTempoCandidate } from "./scaling.js";

const run = promisify(execFile);
const benchmarkDirectory = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const modelFlagIndex = args.indexOf("--model");
const modelName = modelFlagIndex < 0 ? "small0" : args[modelFlagIndex + 1];
if (!["small0", "final0"].includes(modelName)) {
    throw new Error(`Unknown Beat This! model: ${modelName}`);
}
if (modelFlagIndex >= 0) args.splice(modelFlagIndex, 2);
if (args.length > 1) throw new Error("Specify at most one mapset ID");
const outputDirectory = resolve(
    benchmarkDirectory, modelName === "small0" ? "beat-this-small" : "beat-this-full"
);
const python = process.env.BEAT_THIS_PYTHON ?? "python3";
const detectorScript = resolve(benchmarkDirectory, "beat-this-detect.py");
const manifest = JSON.parse(await readFile(resolve(benchmarkDirectory, "manifest.json"), "utf8"));
const requestedId = args[0];
const selectedCases = requestedId ? manifest.filter(({ id }) => id === requestedId) : manifest;
if (!selectedCases.length) throw new Error(`Unknown mapset ID: ${requestedId}`);

function percentile(sortedValues, fraction) {
    return sortedValues.length ? sortedValues[Math.ceil(sortedValues.length * fraction) - 1] : null;
}

function calculateMetrics(detectedBeatsMs, referenceBeatsMs) {
    if (!detectedBeatsMs.length || !referenceBeatsMs.length) return null;
    const errorsMs = detectedBeatsMs.map((beatMs) => beatMs - nearestBeat(referenceBeatsMs, beatMs));
    const absoluteErrors = errorsMs.map(Math.abs).sort((a, b) => a - b);
    return {
        medianAbsoluteErrorMs: percentile(absoluteErrors, 0.5),
        percentile95AbsoluteErrorMs: percentile(absoluteErrors, 0.95),
        meanErrorMs: errorsMs.reduce((sum, error) => sum + error, 0) / errorsMs.length,
        within5Ms: absoluteErrors.filter((error) => error <= 5).length / absoluteErrors.length,
        within10Ms: absoluteErrors.filter((error) => error <= 10).length / absoluteErrors.length,
        within20Ms: absoluteErrors.filter((error) => error <= 20).length / absoluteErrors.length,
    };
}

async function runCase(benchmarkCase) {
    const audioPath = fileURLToPath(new URL(benchmarkCase.audio, import.meta.url));
    const baseline = JSON.parse(await readFile(
        resolve(benchmarkDirectory, "results", `${benchmarkCase.id}.json`), "utf8"
    ));
    const { stdout } = await run(python, [detectorScript, audioPath], {
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, BEAT_THIS_CHECKPOINT: process.env.BEAT_THIS_CHECKPOINT ?? modelName },
    });
    const detection = JSON.parse(stdout);
    const rawTicks = detection.ticks.filter((tick) =>
        Number.isFinite(tick) && tick >= 0 && tick * 1000 < baseline.durationMs
    );
    const filteredTicks = filterSpuriousBeats(rawTicks);
    const interpolatedTicks = interpolateBeatGaps(filteredTicks, {
        endTime: baseline.durationMs / 1000,
    });
    const timingOptions = {
        ...DEFAULT_TIMING_OPTIONS,
        ...benchmarkCase.timingOptions,
        tempoPattern: benchmarkCase.tempoPattern,
    };
    const scaleCandidates = evaluateTempoScales(
        interpolatedTicks.map((tick) => tick * 1000),
        baseline.referenceBeatsMs,
        benchmarkCase.allowedTempoScales,
        {
            durationMs: baseline.durationMs,
            observedBeatsMs: filteredTicks.map((tick) => tick * 1000),
            probabilities: Float32Array.from(detection.beatProbabilities),
            probabilityFrameMs: detection.probabilityFrameMs,
            timingOptions,
            startMs: baseline.evaluationStartMs,
            endMs: baseline.evaluationEndMs,
        }
    );
    const selectedScale = selectTempoCandidate(
        scaleCandidates, benchmarkCase.tempoScale, benchmarkCase.tempoPhase ?? 0
    );
    const detectedBeatsMs = selectedScale.beatsMs;
    const referenceBeatsMs = baseline.referenceBeatsMs;
    const nearestReferenceErrorsMs = detectedBeatsMs.map((beatMs) =>
        beatMs - nearestBeat(referenceBeatsMs, beatMs)
    );
    return {
        mapsetId: benchmarkCase.id,
        name: benchmarkCase.name,
        pipelineVersion: "0.2.1",
        decoder: "ffmpeg",
        sourceSampleRate: baseline.sourceSampleRate,
        detector: `beat-this-${modelName}-minimal`,
        modelName,
        beatThisVersion: detection.beatThisVersion,
        torchVersion: detection.torchVersion,
        checkpoint: detection.checkpoint,
        checkpointSha256: detection.checkpointSha256,
        inferenceThreads: detection.threads,
        analysisSampleRate: 22050,
        modelFrameRate: 50,
        probabilityFrameMs: detection.probabilityFrameMs,
        evaluationGrid: "exported-timing-points",
        timingOptions,
        osuTimingPoints: selectedScale.osuTimingPoints,
        exportedTimingPoints: selectedScale.exportedTimingPoints,
        durationMs: baseline.durationMs,
        evaluationMarginMs: baseline.evaluationMarginMs,
        evaluationStartMs: baseline.evaluationStartMs,
        evaluationEndMs: baseline.evaluationEndMs,
        onlineOffsetMs: baseline.onlineOffsetMs,
        allowedTempoScales: benchmarkCase.allowedTempoScales,
        selectedTempoScale: selectedScale.tempoScale,
        selectedTempoPhase: selectedScale.phase,
        tempoScaleSource: "manifest",
        selectedTempoPattern: selectedScale.tempoPattern,
        tempoScaleCandidates: scaleCandidates.map(({
            beatsMs, osuTimingPoints, exportedTimingPoints, ...candidate
        }) => ({
            ...candidate,
            detectedBeatCount: beatsMs.length,
            timingPointCount: exportedTimingPoints.length,
        })),
        timingPoints: baseline.timingPoints,
        referenceBeatsMs,
        rawDetectedBeatsMs: rawTicks.map((tick) => tick * 1000),
        rawDownbeatsMs: detection.downbeats.map((tick) => tick * 1000),
        filteredDetectedBeatsMs: filteredTicks.map((tick) => tick * 1000),
        filteredBeatCount: rawTicks.length - filteredTicks.length,
        interpolatedDetectedBeatsMs: interpolatedTicks.map((tick) => tick * 1000),
        interpolatedBeatCount: interpolatedTicks.length - filteredTicks.length,
        detectedBeatsMs,
        nearestReferenceErrorsMs,
        metrics: calculateMetrics(detectedBeatsMs, referenceBeatsMs),
    };
}

await mkdir(resolve(outputDirectory, "results"), { recursive: true });
for (const benchmarkCase of selectedCases) {
    console.log(`Analyzing ${benchmarkCase.id}: ${benchmarkCase.name}`);
    const result = await runCase(benchmarkCase);
    const path = resolve(outputDirectory, "results", `${benchmarkCase.id}.json`);
    await writeFile(path, `${JSON.stringify(result, null, 2)}\n`);
    await writeResultPlot(result, outputDirectory);
    const selected = result.tempoScaleCandidates.find((candidate) =>
        candidate.tempoScale === result.selectedTempoScale &&
        candidate.phase === result.selectedTempoPhase
    );
    console.log(`  Raw beats:      ${result.rawDetectedBeatsMs.length}`);
    console.log(`  Export F1@20ms: ${selected.matchingF1.toFixed(3)}`);
    console.log(`  Timing points:  ${result.exportedTimingPoints.length}`);
    console.log(`  Median error:   ${result.metrics?.medianAbsoluteErrorMs.toFixed(1) ?? "n/a"} ms`);
}
