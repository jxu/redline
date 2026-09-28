import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { interpolateBeatGaps } from "../beat-interpolation.js";
import { detectBeats } from "../beat-detector.js";
import { decodeAudioFile } from "./audio-decoder.js";
import { generateBeatGrid, nearestBeat, parseOsuTimingPoints } from "./osu-timing.js";
import { writeResultPlot } from "./plot-results.js";
import { evaluateTempoScales } from "./scaling.js";

const benchmarkDirectory = dirname(fileURLToPath(import.meta.url));
const evaluationMarginMs = 5000;
const manifest = JSON.parse(await readFile(`${benchmarkDirectory}/manifest.json`, "utf8"));
const requestedId = process.argv[2];
const selectedCases = requestedId
    ? manifest.filter(({ id }) => id === requestedId)
    : manifest;

if (!selectedCases.length) throw new Error(`Unknown mapset ID: ${requestedId}`);

function percentile(sortedValues, fraction) {
    if (!sortedValues.length) return null;
    return sortedValues[Math.ceil(sortedValues.length * fraction) - 1];
}

function calculateMetrics(detectedBeatsMs, referenceBeatsMs) {
    const errorsMs = detectedBeatsMs.map((detectedMs) =>
        detectedMs - nearestBeat(referenceBeatsMs, detectedMs)
    );
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
    const osuPath = fileURLToPath(new URL(benchmarkCase.osu, import.meta.url));
    const [decoded, osuText] = await Promise.all([
        decodeAudioFile(audioPath),
        readFile(osuPath, "utf8"),
    ]);

    const timingPoints = parseOsuTimingPoints(osuText);
    const onlineOffsetMs = benchmarkCase.onlineOffsetMs ?? 0;
    const fullReferenceBeatsMs = generateBeatGrid(timingPoints, decoded.durationMs)
        .map((beatMs) => beatMs + onlineOffsetMs)
        .filter((beatMs) => beatMs >= 0 && beatMs < decoded.durationMs);
    const evaluationStartMs = evaluationMarginMs;
    const evaluationEndMs = decoded.durationMs - evaluationMarginMs;
    const referenceBeatsMs = fullReferenceBeatsMs.filter(
        (beatMs) => beatMs >= evaluationStartMs && beatMs < evaluationEndMs
    );
    const detection = await detectBeats(decoded.samples);
    const rawDetectedBeatsMs = detection.ticks.map((seconds) => seconds * 1000);
    const interpolatedBeats = interpolateBeatGaps(detection.ticks, {
        endTime: decoded.durationMs / 1000,
    });
    const interpolatedDetectedBeatsMs = interpolatedBeats.map((seconds) => seconds * 1000);
    const scaleCandidates = evaluateTempoScales(
        interpolatedDetectedBeatsMs,
        fullReferenceBeatsMs,
        benchmarkCase.allowedTempoScales,
        { startMs: evaluationStartMs, endMs: evaluationEndMs }
    );
    const selectedScale = scaleCandidates[0];
    const detectedBeatsMs = selectedScale.beatsMs;
    const nearestReferenceErrorsMs = detectedBeatsMs.map((detectedMs) =>
        detectedMs - nearestBeat(referenceBeatsMs, detectedMs)
    );

    return {
        mapsetId: benchmarkCase.id,
        name: benchmarkCase.name,
        decoder: "audio-decode",
        sourceSampleRate: decoded.sourceSampleRate,
        detector: "senet-onnx",
        modelSampleRate: 16000,
        durationMs: decoded.durationMs,
        evaluationMarginMs,
        evaluationStartMs,
        evaluationEndMs,
        confidence: detection.confidence,
        onlineOffsetMs,
        allowedTempoScales: benchmarkCase.allowedTempoScales,
        selectedTempoScale: selectedScale.tempoScale,
        selectedTempoPhase: selectedScale.phase,
        tempoScaleCandidates: scaleCandidates.map(({ beatsMs, ...candidate }) => ({
            ...candidate,
            detectedBeatCount: beatsMs.length,
        })),
        timingPoints,
        referenceBeatsMs,
        rawDetectedBeatsMs,
        interpolatedDetectedBeatsMs,
        interpolatedBeatCount: interpolatedBeats.length - detection.ticks.length,
        detectedBeatsMs,
        nearestReferenceErrorsMs,
        metrics: calculateMetrics(detectedBeatsMs, referenceBeatsMs),
    };
}

await mkdir(`${benchmarkDirectory}/results`, { recursive: true });

for (const benchmarkCase of selectedCases) {
    console.log(`Analyzing ${benchmarkCase.id}: ${benchmarkCase.name}`);
    const result = await runCase(benchmarkCase);
    const outputPath = `${benchmarkDirectory}/results/${benchmarkCase.id}.json`;
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    const plotPath = await writeResultPlot(result, benchmarkDirectory);
    const selectedCandidate = result.tempoScaleCandidates[0];

    console.log(`  Reference beats: ${result.referenceBeatsMs.length}`);
    console.log(
        `  Evaluation:      ${result.evaluationStartMs}-${result.evaluationEndMs.toFixed(3)} ms`
    );
    console.log(`  Online offset:   ${result.onlineOffsetMs} ms`);
    console.log(`  Raw detections:  ${result.rawDetectedBeatsMs.length}`);
    console.log(`  Interpolated:    ${result.interpolatedBeatCount}`);
    console.log(
        `  Selected scale:  ${result.selectedTempoScale}x` +
        (result.selectedTempoPhase ? ` (phase ${result.selectedTempoPhase})` : "")
    );
    console.log(
        `  Scale match F1:  ${selectedCandidate.matchingF1.toFixed(3)} ` +
        `(${selectedCandidate.matchedBeatCount} matches within ` +
        `${selectedCandidate.matchingToleranceMs.toFixed(1)} ms)`
    );
    console.log(`  Scaled beats:    ${result.detectedBeatsMs.length}`);
    console.log(`  Median error:    ${result.metrics.medianAbsoluteErrorMs.toFixed(3)} ms`);
    console.log(`  95th percentile: ${result.metrics.percentile95AbsoluteErrorMs.toFixed(3)} ms`);
    console.log(`  Result:           ${outputPath}`);
    console.log(`  Plot:             ${plotPath}`);
}
