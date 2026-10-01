import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export function summarizeResult(result) {
    const fields = ["mapsetId", "name", "pipelineVersion", "detector", "modelName",
        "checkpointSha256", "beatThisVersion", "torchVersion", "beatOffsetMs",
        "probabilityFrameMs", "durationMs", "evaluationGrid", "evaluationWindow",
        "evaluationStartMs", "evaluationEndMs", "onlineOffsetMs", "timingOptions",
        "allowedTempoScales", "selectedTempoScale", "selectedTempoPhase",
        "tempoScaleSource", "configuredTempoScale", "configuredTempoPhase",
        "configuredWeightedF1", "configuredF1At20Ms", "selectedTempoPattern",
        "tempoPatternSource", "metrics"];
    return {
        ...Object.fromEntries(fields.filter((field) => result[field] !== undefined)
            .map((field) => [field, result[field]])),
        tempoScaleCandidates: result.tempoScaleCandidates.map(({ weightedF1Scores, ...candidate }) => candidate),
        referenceBeatCount: result.referenceBeatsMs.length,
        rawBeatCount: result.rawDetectedBeatsMs.length,
        exportedBeatCount: result.detectedBeatsMs.length,
        timingPointCount: result.exportedTimingPoints.length,
    };
}

// A single-map run updates that case without discarding the other scores or
// hand-written comments. Deltas always compare with the previous recorded run.
export async function recordSummary(result, outputDirectory) {
    await mkdir(outputDirectory, { recursive: true });
    const path = resolve(outputDirectory, "summary.json");
    let summary;
    try {
        summary = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        summary = { schemaVersion: 1, cases: [] };
    }
    const previous = summary.cases.find((entry) => entry.mapsetId === result.mapsetId);
    const current = summarizeResult(result);
    current.comment = previous?.comment ?? "";
    if (previous) {
        current.previousWeightedF1 = previous.metrics.weightedF1;
        current.deltaWeightedF1 = current.metrics.weightedF1 - previous.metrics.weightedF1;
        const selected = (entry) => entry.tempoScaleCandidates.find((candidate) =>
            candidate.tempoScale === entry.selectedTempoScale && candidate.phase === entry.selectedTempoPhase);
        current.deltaF1At20Ms = selected(current).matchingF1 - selected(previous).matchingF1;
    }
    summary.cases = summary.cases.filter((entry) => entry.mapsetId !== result.mapsetId);
    summary.cases.push(current);
    summary.cases.sort((a, b) => a.mapsetId.localeCompare(b.mapsetId, undefined, { numeric: true }));
    const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const scores = summary.cases.map((entry) => entry.metrics.weightedF1);
    summary.aggregate = {
        count: scores.length,
        meanWeightedF1: mean(scores),
        meanF1At20Ms: mean(summary.cases.map((entry) => entry.tempoScaleCandidates.find((candidate) =>
            candidate.tempoScale === entry.selectedTempoScale && candidate.phase === entry.selectedTempoPhase).matchingF1)),
    };
    await writeFile(path, `${JSON.stringify(summary, null, 2)}\n`);
    return path;
}
