import { nearestBeat } from "./osu-timing.js";

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

export function evaluateTempoScales(
    detectedBeatsMs,
    referenceBeatsMs,
    allowedTempoScales,
    { startMs = -Infinity, endMs = Infinity } = {}
) {
    if (!allowedTempoScales?.length) throw new Error("At least one tempo scale is required");
    if (startMs >= endMs) throw new Error("Evaluation start must be before its end");

    const evaluationReferenceBeatsMs = referenceBeatsMs.filter(
        (beatMs) => beatMs >= startMs && beatMs < endMs
    );

    const candidates = allowedTempoScales.flatMap((tempoScale) => {
        const phaseCount = tempoScale < 1 ? subdivisionCount(tempoScale) : 1;
        return Array.from({ length: phaseCount }, (_, phase) => {
            const beatsMs = scaleBeatGrid(detectedBeatsMs, tempoScale, phase)
                .filter((beatMs) => beatMs >= startMs && beatMs < endMs);
            return {
                tempoScale,
                phase,
                beatsMs,
                symmetricMeanNearestErrorMs: symmetricMeanNearestError(
                    beatsMs,
                    evaluationReferenceBeatsMs
                ),
            };
        });
    });

    candidates.sort((left, right) =>
        left.symmetricMeanNearestErrorMs - right.symmetricMeanNearestErrorMs ||
        Math.abs(Math.log2(left.tempoScale)) - Math.abs(Math.log2(right.tempoScale)) ||
        left.phase - right.phase
    );

    return candidates;
}
