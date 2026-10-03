import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { filterSpuriousBeats } from "../beat-filter.js";
import { interpolateBeatGaps } from "../beat-interpolation.js";
import { beatsFromProbabilities } from "../beat-postprocessing.js";
import {
    DEFAULT_TIMING_OPTIONS,
    defaultTempoSmoothness,
    defaultToleranceMs,
} from "../timing.js";
import { createProbabilityCache } from "./probability-cache.js";
import {
    generateBeatGrid,
    nearestBeat,
    parseOsuHitObjectSpan,
    parseOsuTimingPoints,
} from "./osu-timing.js";
import { writeResultPlot } from "./plot-results.js";
import { evaluateTempoScales, selectTempoCandidate } from "./scaling.js";
import { recordSummary } from "./summary.js";

import { EXPORT_OFFSET_MS } from "../timing-export.js";
import { createBrowserRuntime } from "./browser-runtime.js";

const benchmarkDirectory = dirname(fileURLToPath(import.meta.url));
const pipelineVersion = "0.8.0";
const args = process.argv.slice(2);
const valueOptions = {};
for (const option of ["--backend", "--manifest", "--output-dir"]) {
    const index = args.indexOf(option);
    if (index >= 0) {
        if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${option} requires a value`);
        valueOptions[option] = args[index + 1];
        args.splice(index, 2);
    }
}
const backend = valueOptions["--backend"] ?? "wasm";
if (!["wasm", "webgpu"].includes(backend)) throw new Error(`Unknown browser backend: ${backend}`);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
for (const flag of flags) {
    if (
        ![
            "--cache-only",
            "--regression-only",
            "--refresh-probabilities",
            "--manifest-tempo",
        ].includes(flag)
    ) {
        throw new Error(`Unknown option: ${flag}`);
    }
}
const ids = args.filter((arg) => !arg.startsWith("--"));
if (ids.length > 1) throw new Error("Specify at most one mapset ID");
const requestedId = ids[0];
const cacheOnly = flags.has("--cache-only");
const requireCached = flags.has("--regression-only");
const refresh = flags.has("--refresh-probabilities");
const useManifestTempo = flags.has("--manifest-tempo");
const manifestPath = valueOptions["--manifest"] ? resolve(valueOptions["--manifest"]) : `${benchmarkDirectory}/manifest.json`;
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const outputDirectory = valueOptions["--output-dir"] ? resolve(valueOptions["--output-dir"]) : useManifestTempo
    ? benchmarkDirectory
    : `${benchmarkDirectory}/best-octave`;
if (requireCached && (cacheOnly || refresh)) {
    throw new Error(
        "--regression-only cannot be combined with --cache-only or --refresh-probabilities",
    );
}
let runtime;
const getProbabilities = createProbabilityCache({
    runtimeIdentity: { executionProvider: `browser-${backend}` },
    analyze: async path => {
        runtime ??= await createBrowserRuntime(backend);
        return runtime.analyze(path);
    },
});
const selectedCases = requestedId
    ? manifest.filter(({ id }) => id === requestedId)
    : manifest;

if (!selectedCases.length) throw new Error(`Unknown mapset ID: ${requestedId}`);

function percentile(sortedValues, fraction) {
    if (!sortedValues.length) return null;
    return sortedValues[Math.ceil(sortedValues.length * fraction) - 1];
}

function calculateMetrics(detectedBeatsMs, referenceBeatsMs) {
    const errorsMs = detectedBeatsMs.map(
        (detectedMs) => detectedMs - nearestBeat(referenceBeatsMs, detectedMs),
    );
    const absoluteErrors = errorsMs.map(Math.abs).sort((a, b) => a - b);

    return {
        medianAbsoluteErrorMs: percentile(absoluteErrors, 0.5),
        percentile95AbsoluteErrorMs: percentile(absoluteErrors, 0.95),
        meanErrorMs:
            errorsMs.reduce((sum, error) => sum + error, 0) / errorsMs.length,
        within5Ms:
            absoluteErrors.filter((error) => error <= 5).length /
            absoluteErrors.length,
        within10Ms:
            absoluteErrors.filter((error) => error <= 10).length /
            absoluteErrors.length,
        within20Ms:
            absoluteErrors.filter((error) => error <= 20).length /
            absoluteErrors.length,
    };
}

async function runCase(benchmarkCase) {
    const audioPath = fileURLToPath(
        new URL(benchmarkCase.audio, pathToFileURL(manifestPath)),
    );
    const decoded = await getProbabilities(audioPath, {
        refresh,
        requireCached,
    });
    console.log(
        `  Probabilities:   ${decoded.cache.hit ? "cached" : "computed and cached"} (${decoded.frameCount} frames)`,
    );
    if (cacheOnly) return;
    const osuPath = fileURLToPath(new URL(benchmarkCase.osu, pathToFileURL(manifestPath)));
    const osuText = await readFile(osuPath, "utf8");

    const timingPoints = parseOsuTimingPoints(osuText);
    const hitObjectSpan = parseOsuHitObjectSpan(osuText);
    const onlineOffsetMs = benchmarkCase.onlineOffsetMs ?? 0;
    const fullReferenceBeatsMs = generateBeatGrid(
        timingPoints,
        decoded.durationMs,
    )
        .map((beatMs) => beatMs + onlineOffsetMs)
        .filter((beatMs) => beatMs >= 0 && beatMs < decoded.durationMs);
    const evaluationStartMs = Math.max(
        0,
        hitObjectSpan.firstMs + onlineOffsetMs,
    );
    const evaluationEndMs = Math.min(
        decoded.durationMs,
        hitObjectSpan.lastMs + onlineOffsetMs + 1,
    );
    if (evaluationStartMs >= evaluationEndMs) {
        throw new Error(
            `No audio between the first and last rhythmic hit object for ${benchmarkCase.id}`,
        );
    }
    const referenceBeatsMs = fullReferenceBeatsMs.filter(
        (beatMs) => beatMs >= evaluationStartMs && beatMs < evaluationEndMs,
    );
    const detection = beatsFromProbabilities(decoded.probabilities, decoded);
    const rawDetectedBeatsMs = detection.ticks.map((seconds) => seconds * 1000);
    const filteredBeats = filterSpuriousBeats(detection.ticks);
    const filteredDetectedBeatsMs = filteredBeats.map(
        (seconds) => seconds * 1000,
    );
    const interpolatedBeats = interpolateBeatGaps(filteredBeats, {
        endTime: decoded.durationMs / 1000,
    });
    const interpolatedDetectedBeatsMs = interpolatedBeats.map(
        (seconds) => seconds * 1000,
    );
    const timingOptions = {
        ...DEFAULT_TIMING_OPTIONS,
        toleranceMs: defaultToleranceMs(benchmarkCase.tempoPattern),
        tempoSmoothness: defaultTempoSmoothness(benchmarkCase.tempoPattern),
        ...benchmarkCase.timingOptions,
        tempoPattern: benchmarkCase.tempoPattern,
    };
    const scaleCandidates = evaluateTempoScales(
        interpolatedDetectedBeatsMs,
        fullReferenceBeatsMs,
        useManifestTempo
            ? benchmarkCase.allowedTempoScales
            : [...new Set([0.5, 1, 2, ...benchmarkCase.allowedTempoScales])],
        {
            durationMs: decoded.durationMs,
            observedBeatsMs: filteredDetectedBeatsMs,
            probabilities: decoded.probabilities,
            probabilityFrameMs: 20,
            downbeatTicks: detection.downbeats,
            timingOptions,
            startMs: evaluationStartMs,
            endMs: evaluationEndMs,
        },
    );
    const configuredCandidate = selectTempoCandidate(
        scaleCandidates,
        benchmarkCase.beatThisTempoScale ?? benchmarkCase.tempoScale,
        benchmarkCase.beatThisTempoPhase ?? benchmarkCase.tempoPhase ?? 0,
    );
    const selectedScale = selectTempoCandidate(
        scaleCandidates,
        useManifestTempo
            ? (benchmarkCase.beatThisTempoScale ?? benchmarkCase.tempoScale)
            : undefined,
        benchmarkCase.beatThisTempoPhase ?? benchmarkCase.tempoPhase ?? 0,
    );
    const detectedBeatsMs = selectedScale.beatsMs;
    const nearestReferenceErrorsMs = detectedBeatsMs.map(
        (detectedMs) => detectedMs - nearestBeat(referenceBeatsMs, detectedMs),
    );

    return {
        mapsetId: benchmarkCase.id,
        name: benchmarkCase.name,
        pipelineVersion,
        decoder: "browser-decodeAudio",
        inferenceBackend: decoded.backend,
        browserVersion: decoded.browserVersion,
        beatOffsetMs: EXPORT_OFFSET_MS,
        sourceSampleRate: decoded.sourceSampleRate,
        detector: "beat-this-small0-onnx-minimal",
        modelSampleRate: 22050,
        probabilityFrameMs: 20,
        probabilityCache: decoded.cache,
        evaluationGrid: "exported-timing-points",
        timingOptions,
        osuTimingPoints: selectedScale.osuTimingPoints,
        exportedTimingPoints: selectedScale.exportedTimingPoints,
        durationMs: decoded.durationMs,
        evaluationWindow: "first-to-last-rhythmic-hit-object",
        evaluationStartMs,
        evaluationEndMs,
        confidence: detection.confidence,
        onlineOffsetMs,
        allowedTempoScales: [
            ...new Set(scaleCandidates.map(({ tempoScale }) => tempoScale)),
        ],
        selectedTempoScale: selectedScale.tempoScale,
        selectedTempoPhase: selectedScale.phase,
        tempoScaleSource: useManifestTempo
            ? "manifest"
            : "reference-best-octave",
        configuredTempoScale:
            benchmarkCase.beatThisTempoScale ?? benchmarkCase.tempoScale,
        configuredTempoPhase:
            benchmarkCase.beatThisTempoPhase ?? benchmarkCase.tempoPhase ?? 0,
        configuredWeightedF1: configuredCandidate.weightedF1,
        configuredF1At20Ms: configuredCandidate.matchingF1,
        selectedTempoPattern: selectedScale.tempoPattern,
        tempoPatternSource: benchmarkCase.tempoPatternSource ?? "mapper",
        tempoScaleCandidates: scaleCandidates.map(
            ({
                beatsMs,
                osuTimingPoints,
                exportedTimingPoints,
                ...candidate
            }) => ({
                ...candidate,
                detectedBeatCount: beatsMs.length,
                timingPointCount: exportedTimingPoints.length,
            }),
        ),
        timingPoints,
        referenceBeatsMs,
        rawDetectedBeatsMs,
        filteredDetectedBeatsMs,
        filteredBeatCount: detection.ticks.length - filteredBeats.length,
        interpolatedDetectedBeatsMs,
        interpolatedBeatCount: interpolatedBeats.length - filteredBeats.length,
        detectedBeatsMs,
        nearestReferenceErrorsMs,
        metrics: {
            ...calculateMetrics(detectedBeatsMs, referenceBeatsMs),
            weightedF1: selectedScale.weightedF1,
        },
    };
}

try {
    if (!cacheOnly) await mkdir(`${outputDirectory}/results`, { recursive: true });

    for (const benchmarkCase of selectedCases) {
        console.log(`Analyzing ${benchmarkCase.id}: ${benchmarkCase.name}`);
        const result = await runCase(benchmarkCase);
        if (cacheOnly) continue;
        const outputPath = `${outputDirectory}/results/${benchmarkCase.id}.json`;
        await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
        const plotPath = await writeResultPlot(result, outputDirectory);
        await recordSummary(result, outputDirectory);
        const selectedCandidate = result.tempoScaleCandidates.find(
            (candidate) =>
                candidate.tempoScale === result.selectedTempoScale &&
                candidate.phase === result.selectedTempoPhase,
        );

        console.log(`  Reference beats: ${result.referenceBeatsMs.length}`);
        console.log(
            `  Evaluation:      ${result.evaluationStartMs}-${result.evaluationEndMs.toFixed(3)} ms`,
        );
        console.log(`  Online offset:   ${result.onlineOffsetMs} ms`);
        console.log(`  Raw detections:  ${result.rawDetectedBeatsMs.length}`);
        console.log(`  Filtered:        ${result.filteredBeatCount}`);
        console.log(`  Interpolated:    ${result.interpolatedBeatCount}`);
        console.log(
            `  Selected scale:  ${result.selectedTempoScale}x` +
                (result.selectedTempoPhase
                    ? ` (phase ${result.selectedTempoPhase})`
                    : ""),
        );
        console.log(
            `  Export F1@20ms:  ${selectedCandidate.matchingF1.toFixed(3)} ` +
                `(${selectedCandidate.matchedBeatCount} matches within ` +
                `${selectedCandidate.matchingToleranceMs.toFixed(1)} ms)`,
        );
        console.log(
            `  Weighted F1:     ${selectedCandidate.weightedF1.toFixed(3)}`,
        );
        console.log(`  Exported beats:  ${result.detectedBeatsMs.length}`);
        console.log(`  Timing points:   ${result.exportedTimingPoints.length}`);
        console.log(
            `  Fit settings:    window ${result.timingOptions.windowSize}, ` +
                `tolerance ${result.timingOptions.toleranceMs} ms, ` +
                `tempo smoothing ${result.timingOptions.tempoSmoothness}`,
        );
        console.log(
            `  Median error:    ${result.metrics.medianAbsoluteErrorMs.toFixed(3)} ms`,
        );
        console.log(
            `  95th percentile: ${result.metrics.percentile95AbsoluteErrorMs.toFixed(3)} ms`,
        );
        console.log(`  Result:           ${outputPath}`);
        console.log(`  Plot:             ${plotPath}`);
    }

} finally {
    await runtime?.close();
}
