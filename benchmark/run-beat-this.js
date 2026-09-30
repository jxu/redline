import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { filterSpuriousBeats } from "../beat-filter.js";
import { interpolateBeatGaps } from "../beat-interpolation.js";
import { DEFAULT_TIMING_OPTIONS, defaultTempoSmoothness, defaultToleranceMs } from "../timing.js";
import { decodeAudioFile } from "./audio-decoder.js";
import { generateBeatGrid, nearestBeat, parseOsuHitObjectSpan, parseOsuTimingPoints } from "./osu-timing.js";
import { writeResultPlot } from "./plot-results.js";
import { evaluateTempoScales, selectTempoCandidate } from "./scaling.js";

const run = promisify(execFile);
const benchmarkDirectory = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const offsetFlagIndex = args.indexOf("--beat-offset-ms");
const beatOffsetMs = offsetFlagIndex < 0 ? -27 : Number(args[offsetFlagIndex + 1]);
if (!Number.isFinite(beatOffsetMs) || !Number.isInteger(beatOffsetMs)) {
    throw new Error(`Beat offset must be an integer number of milliseconds: ${beatOffsetMs}`);
}
if (offsetFlagIndex >= 0) args.splice(offsetFlagIndex, 2);
const preservePulseIndex = args.indexOf("--preserve-pulse");
const preserveInputPulse = preservePulseIndex >= 0;
if (preserveInputPulse) args.splice(preservePulseIndex, 1);
const modelFlagIndex = args.indexOf("--model");
const modelName = modelFlagIndex < 0 ? "final0" : args[modelFlagIndex + 1];
if (!["small0", "final0"].includes(modelName)) {
    throw new Error(`Unknown Beat This! model: ${modelName}`);
}
if (modelFlagIndex >= 0) args.splice(modelFlagIndex, 2);
if (args.length > 1) throw new Error("Specify at most one mapset ID");
const offsetSuffix = beatOffsetMs
    ? `-offset-${beatOffsetMs < 0 ? "minus" : "plus"}${Math.abs(beatOffsetMs)}ms` : "";
const modeSuffix = `${offsetSuffix}${preserveInputPulse ? "-pulse-locked" : ""}`;
const outputDirectory = modelName === "final0" && beatOffsetMs === -27 && !preserveInputPulse
    ? benchmarkDirectory
    : resolve(benchmarkDirectory,
        `beat-this-${modelName === "small0" ? "small" : "full"}${modeSuffix}`);
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
    const decoded = await decodeAudioFile(audioPath, 22050);
    const osuPath = fileURLToPath(new URL(benchmarkCase.osu, import.meta.url));
    const osuText = await readFile(osuPath, "utf8");
    const timingPoints = parseOsuTimingPoints(osuText);
    const hitObjectSpan = parseOsuHitObjectSpan(osuText);
    const onlineOffsetMs = benchmarkCase.onlineOffsetMs ?? 0;
    const referenceBeatsMs = generateBeatGrid(timingPoints, decoded.durationMs)
        .map((beatMs) => beatMs + onlineOffsetMs)
        .filter((beatMs) => beatMs >= 0 && beatMs < decoded.durationMs);
    const evaluationStartMs = Math.max(0, hitObjectSpan.firstMs + onlineOffsetMs);
    const evaluationEndMs = Math.min(decoded.durationMs,
        hitObjectSpan.lastMs + onlineOffsetMs + 1);
    if (evaluationStartMs >= evaluationEndMs) {
        throw new Error(`No audio between the first and last rhythmic hit object for ${benchmarkCase.id}`);
    }
    const evaluationReferenceBeatsMs = referenceBeatsMs.filter(
        (beatMs) => beatMs >= evaluationStartMs && beatMs < evaluationEndMs
    );
    const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "redline-beat-this-"));
    let stdout;
    try {
        const pcmPath = resolve(temporaryDirectory, "audio.f32");
        await writeFile(pcmPath, Buffer.from(decoded.samples.buffer,
            decoded.samples.byteOffset, decoded.samples.byteLength));
        ({ stdout } = await run(python, [detectorScript, pcmPath], {
            maxBuffer: 8 * 1024 * 1024,
            env: { ...process.env, BEAT_THIS_CHECKPOINT: process.env.BEAT_THIS_CHECKPOINT ?? modelName },
        }));
    } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
    }
    const detection = JSON.parse(stdout);
    const rawTicks = detection.ticks.filter((tick) =>
        Number.isFinite(tick) && tick >= 0 && tick * 1000 < decoded.durationMs
    );
    const filteredTicks = filterSpuriousBeats(rawTicks);
    const interpolatedTicks = interpolateBeatGaps(filteredTicks, {
        endTime: decoded.durationMs / 1000,
    });
    const timingOptions = {
        ...DEFAULT_TIMING_OPTIONS,
        toleranceMs: defaultToleranceMs(benchmarkCase.tempoPattern),
        tempoSmoothness: defaultTempoSmoothness(benchmarkCase.tempoPattern),
        ...benchmarkCase.timingOptions,
        tempoPattern: benchmarkCase.tempoPattern,
        ...(preserveInputPulse ? { preserveInputPulse: true } : {}),
    };
    const scaleCandidates = evaluateTempoScales(
        interpolatedTicks.map((tick) => tick * 1000),
        referenceBeatsMs,
        benchmarkCase.allowedTempoScales,
        {
            durationMs: decoded.durationMs,
            observedBeatsMs: filteredTicks.map((tick) => tick * 1000),
            probabilities: Float32Array.from(detection.beatProbabilities),
            probabilityFrameMs: detection.probabilityFrameMs,
            exportOffsetMs: beatOffsetMs,
            timingOptions,
            startMs: evaluationStartMs,
            endMs: evaluationEndMs,
        }
    );
    const mapperScale = benchmarkCase.beatThisTempoScale ?? benchmarkCase.tempoScale;
    const mapperPhase = benchmarkCase.beatThisTempoPhase ?? benchmarkCase.tempoPhase ?? 0;
    const selectedScale = selectTempoCandidate(
        scaleCandidates, mapperScale, mapperPhase
    );
    const detectedBeatsMs = selectedScale.beatsMs;
    const nearestReferenceErrorsMs = detectedBeatsMs.map((beatMs) =>
        beatMs - nearestBeat(evaluationReferenceBeatsMs, beatMs)
    );
    return {
        mapsetId: benchmarkCase.id,
        name: benchmarkCase.name,
        pipelineVersion: `0.7.0-beat-this-${modelName}${modeSuffix}`,
        decoder: "audio-decode",
        sourceSampleRate: decoded.sourceSampleRate,
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
        beatOffsetMs,
        evaluationGrid: "exported-timing-points",
        timingOptions,
        osuTimingPoints: selectedScale.osuTimingPoints,
        exportedTimingPoints: selectedScale.exportedTimingPoints,
        durationMs: decoded.durationMs,
        evaluationWindow: "first-to-last-rhythmic-hit-object",
        evaluationStartMs,
        evaluationEndMs,
        onlineOffsetMs,
        allowedTempoScales: benchmarkCase.allowedTempoScales,
        selectedTempoScale: selectedScale.tempoScale,
        selectedTempoPhase: selectedScale.phase,
        tempoScaleSource: benchmarkCase.beatThisTempoScale === undefined
            ? "manifest" : "manifest-beat-this",
        selectedTempoPattern: selectedScale.tempoPattern,
        tempoPatternSource: benchmarkCase.tempoPatternSource ?? "mapper",
        tempoScaleCandidates: scaleCandidates.map(({
            beatsMs, osuTimingPoints, exportedTimingPoints, ...candidate
        }) => ({
            ...candidate,
            detectedBeatCount: beatsMs.length,
            timingPointCount: exportedTimingPoints.length,
        })),
        timingPoints,
        referenceBeatsMs: evaluationReferenceBeatsMs,
        rawDetectedBeatsMs: rawTicks.map((tick) => tick * 1000),
        rawDownbeatsMs: detection.downbeats.map((tick) => tick * 1000),
        filteredDetectedBeatsMs: filteredTicks.map((tick) => tick * 1000),
        filteredBeatCount: rawTicks.length - filteredTicks.length,
        interpolatedDetectedBeatsMs: interpolatedTicks.map((tick) => tick * 1000),
        interpolatedBeatCount: interpolatedTicks.length - filteredTicks.length,
        detectedBeatsMs,
        nearestReferenceErrorsMs,
        metrics: {
            ...calculateMetrics(detectedBeatsMs, evaluationReferenceBeatsMs),
            weightedF1: selectedScale.weightedF1,
        },
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
    console.log(`  Weighted F1:    ${selected.weightedF1.toFixed(3)}`);
    console.log(`  Timing points:  ${result.exportedTimingPoints.length}`);
    console.log(`  Median error:   ${result.metrics?.medianAbsoluteErrorMs.toFixed(1) ?? "n/a"} ms`);
}
