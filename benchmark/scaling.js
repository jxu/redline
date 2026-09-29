import { calculateTiming, DEFAULT_TIMING_OPTIONS } from "../timing.js";
import { generateBeatGrid, nearestBeat, parseOsuTimingPoints } from "./osu-timing.js";

function subdivisionCount(tempoScale) {
    if (!Number.isFinite(tempoScale) || tempoScale <= 0) {
        throw new Error(`Tempo scale must be positive: ${tempoScale}`);
    }

    const count = tempoScale >= 1 ? tempoScale : 1 / tempoScale;
    if (!Number.isInteger(count)) {
        throw new Error(`Tempo scale must be an integer or its reciprocal: ${tempoScale}`);
    }

    return count;
}

export function scaleBeatGrid(beatsMs, tempoScale, phase = 0) {
    const count = subdivisionCount(tempoScale);
    if (tempoScale === 1) return [...beatsMs];

    if (tempoScale < 1) {
        if (!Number.isInteger(phase) || phase < 0 || phase >= count) {
            throw new Error(`Invalid phase ${phase} for tempo scale ${tempoScale}`);
        }
        return beatsMs.filter((_, index) => index % count === phase);
    }

    return beatsMs.flatMap((beat, index) => {
        if (index === beatsMs.length - 1) return [beat];
        const interval = beatsMs[index + 1] - beat;
        return Array.from({ length: count }, (_, subdivision) =>
            beat + interval * subdivision / count
        );
    });
}

export function selectTempoCandidate(candidates, tempoScale, phase = 0) {
    const selected = candidates.find((candidate) =>
        candidate.tempoScale === tempoScale && candidate.phase === phase
    );
    if (!selected) throw new Error(`Tempo scale ${tempoScale} phase ${phase} was not evaluated`);
    return selected;
}

function meanNearestError(sourceBeatsMs, targetBeatsMs) {
    if (!sourceBeatsMs.length || !targetBeatsMs.length) return Infinity;
    return sourceBeatsMs.reduce(
        (sum, beat) => sum + Math.abs(beat - nearestBeat(targetBeatsMs, beat)),
        0
    ) / sourceBeatsMs.length;
}

function symmetricMeanNearestError(detectedBeatsMs, referenceBeatsMs) {
    return (
        meanNearestError(detectedBeatsMs, referenceBeatsMs) +
        meanNearestError(referenceBeatsMs, detectedBeatsMs)
    ) / 2;
}

function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}

function matchingTolerance(referenceBeatsMs) {
    const intervals = referenceBeatsMs
        .slice(1)
        .map((beatMs, index) => beatMs - referenceBeatsMs[index])
        .filter((intervalMs) => intervalMs > 0);
    const medianIntervalMs = median(intervals);
    return medianIntervalMs === null ? 70 : medianIntervalMs * 0.175;
}

function countMatchingBeats(detectedBeatsMs, referenceBeatsMs, toleranceMs) {
    let detectedIndex = 0;
    let referenceIndex = 0;
    let matchedBeatCount = 0;

    while (
        detectedIndex < detectedBeatsMs.length &&
        referenceIndex < referenceBeatsMs.length
    ) {
        const errorMs = detectedBeatsMs[detectedIndex] - referenceBeatsMs[referenceIndex];
        if (Math.abs(errorMs) <= toleranceMs) {
            matchedBeatCount++;
            detectedIndex++;
            referenceIndex++;
        } else if (errorMs < 0) {
            detectedIndex++;
        } else {
            referenceIndex++;
        }
    }

    return matchedBeatCount;
}

export function evaluateTempoScales(
    detectedBeatsMs,
    referenceBeatsMs,
    allowedTempoScales,
    {
        durationMs,
        observedBeatsMs = detectedBeatsMs,
        probabilities = null,
        probabilityFrameMs,
        timingOptions = DEFAULT_TIMING_OPTIONS,
        startMs = 0,
        endMs = durationMs,
    } = {}
) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
        throw new Error("Audio duration must be a positive finite number");
    }
    if (!allowedTempoScales?.length) throw new Error("At least one tempo scale is required");
    if (startMs >= endMs) throw new Error("Evaluation start must be before its end");

    const evaluationReferenceBeatsMs = referenceBeatsMs.filter(
        (beatMs) => beatMs >= startMs && beatMs < endMs
    );
    const matchingToleranceMs = matchingTolerance(evaluationReferenceBeatsMs);

    const candidates = allowedTempoScales.flatMap((tempoScale) => {
        const phaseCount = tempoScale < 1 ? subdivisionCount(tempoScale) : 1;
        return Array.from({ length: phaseCount }, (_, phase) => {
            // Match the UI: tempo correction precedes fitting and export.
            // Round-trip the serialized text so offset and beat-length rounding,
            // collapsed timing points, and section resets all affect the score.
            const ticks = scaleBeatGrid(detectedBeatsMs, tempoScale, phase)
                .map((beatMs) => beatMs / 1000);
            const scaledObservedBeatsMs = tempoScale >= 1
                ? scaleBeatGrid(observedBeatsMs, tempoScale)
                : observedBeatsMs;
            const scaledTickTimes = new Set(ticks.map((tick) => Math.round(tick * 1e6)));
            const observedTicks = scaledObservedBeatsMs
                .filter((beatMs) => scaledTickTimes.has(Math.round(beatMs * 1000)))
                .map((beatMs) => beatMs / 1000);
            const { osuTimingPoints, tempoPattern } = calculateTiming(ticks, {
                ...timingOptions,
                endTime: durationMs / 1000,
                observedTicks,
                probabilities,
                probabilityFrameMs,
            });
            const exportedTimingPoints = parseOsuTimingPoints(osuTimingPoints);
            const beatsMs = generateBeatGrid(exportedTimingPoints, durationMs)
                .filter((beatMs) => beatMs >= startMs && beatMs < endMs);
            const matchedBeatCount = countMatchingBeats(
                beatsMs,
                evaluationReferenceBeatsMs,
                matchingToleranceMs
            );
            const totalBeatCount = beatsMs.length + evaluationReferenceBeatsMs.length;
            return {
                tempoScale,
                phase,
                beatsMs,
                osuTimingPoints,
                tempoPattern,
                exportedTimingPoints,
                matchedBeatCount,
                matchingToleranceMs,
                matchingF1: totalBeatCount ? 2 * matchedBeatCount / totalBeatCount : 0,
                symmetricMeanNearestErrorMs: symmetricMeanNearestError(
                    beatsMs,
                    evaluationReferenceBeatsMs
                ),
            };
        });
    });

    candidates.sort((left, right) =>
        right.matchingF1 - left.matchingF1 ||
        left.symmetricMeanNearestErrorMs - right.symmetricMeanNearestErrorMs ||
        Math.abs(Math.log2(left.tempoScale)) - Math.abs(Math.log2(right.tempoScale)) ||
        left.phase - right.phase
    );

    return candidates;
}
