import { MODEL_HOP_LENGTH, MODEL_SAMPLE_RATE } from "./mel-spectrogram.js";
import { chooseStableSections } from "./fixed-sections.js";
import { constrainOctaveJumps, isOctaveJump } from "./tempo-continuity.js";

export const MAX_EXPORT_BPM = 300;
const MIN_EXPORT_BEAT_LENGTH_MS = 60000 / MAX_EXPORT_BPM;
const MODEL_FRAME_MS = 1000 * MODEL_HOP_LENGTH / MODEL_SAMPLE_RATE;

export const DEFAULT_TIMING_OPTIONS = Object.freeze({
    toleranceMs: 5,
    windowSize: 4,
    tempoSmoothness: 5,
});

export function defaultToleranceMs(tempoPattern) {
    return tempoPattern === "continuous" ? 6 : DEFAULT_TIMING_OPTIONS.toleranceMs;
}

export function defaultTempoSmoothness(tempoPattern) {
    return tempoPattern === "continuous" ? 0 : DEFAULT_TIMING_OPTIONS.tempoSmoothness;
}

export const TEMPO_PATTERNS = Object.freeze({
    fixed: "Fixed BPM",
    continuous: "Continuously variable BPM",
    sections: "Variable BPM with fixed sections",
});

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

function medianPositiveInterval(ticks) {
    const intervals = ticks.slice(1).map((tick, index) => tick - ticks[index])
        .filter((interval) => interval > 0).sort((a, b) => a - b);
    if (!intervals.length) return null;
    return intervals[Math.floor(intervals.length / 2)];
}

function selectPulse(gridTicks, observedTicks) {
    const typicalInterval = medianPositiveInterval(observedTicks);
    if (!typicalInterval || !gridTicks.length) return gridTicks;
    const selected = [gridTicks[0]];
    // Retained peaks establish the song's pulse; closer grid beats are likely
    // subdivisions. This threshold is relative to the audio, not a BPM cap.
    for (const tick of gridTicks.slice(1)) {
        if (tick - selected.at(-1) >= typicalInterval * 0.65 - 1e-9) selected.push(tick);
    }
    return selected;
}

function probabilityObservations(ticks, estimates, probabilities, frameMs) {
    return estimates.map((estimate, index) => {
        const originalMs = ticks[index] * 1000;
        const estimateMs = estimate * 1000;
        const previousGap = index ? (ticks[index] - ticks[index - 1]) * 1000 : Infinity;
        const nextGap = index + 1 < ticks.length
            ? (ticks[index + 1] - ticks[index]) * 1000 : Infinity;
        // A local search avoids stealing a neighboring beat or subdivision.
        const radiusMs = Math.min(80, 0.2 * Math.min(previousGap, nextGap));
        const first = Math.max(0, Math.ceil((estimateMs - radiusMs) / frameMs));
        const last = Math.min(probabilities.length - 1,
            Math.floor((estimateMs + radiusMs) / frameMs));
        let mass = 0;
        let moment = 0;
        let kernelTotal = 0;
        for (let frame = first; frame <= last; frame++) {
            const timeMs = frame * frameMs;
            const distance = timeMs - estimateMs;
            const kernel = Math.exp(-0.5 * (distance / 25) ** 2);
            const evidence = probabilities[frame] ** 2 * kernel;
            mass += evidence;
            moment += evidence * timeMs;
            kernelTotal += kernel;
        }
        // Squaring the response favors a clear hit over a broad low plateau.
        const evidenceWeight = kernelTotal ? mass / kernelTotal : 0;
        return { evidenceWeight, evidenceMs: mass ? moment / mass : originalMs,
            originalMs };
    });
}

function fitTempoCurve(ticks, smoothness, boundaries = [], probabilities = null,
    frameMs = MODEL_FRAME_MS) {
    if (ticks.length < 3) return ticks;
    const observed = ticks.map((tick) => tick * 1000);
    const count = observed.length;
    const penalties = Array(count).fill(smoothness);
    for (let index = 1; index < count - 1; index++) {
        if (boundaries.some((time) => ticks[index - 1] < time && time <= ticks[index + 1])) {
            penalties[index] = 0;
        }
    }
    const applySystem = (values, weights) => {
        const result = values.map((value, index) => value * weights[index]);
        for (let index = 1; index < count - 1; index++) {
            const curvature = values[index - 1] - 2 * values[index] + values[index + 1];
            result[index - 1] += penalties[index] * curvature;
            result[index] -= 2 * penalties[index] * curvature;
            result[index + 1] += penalties[index] * curvature;
        }
        return result;
    };

    // Alternate between aligning each beat to the nearby probability curve
    // and penalizing changes in beat spacing. With no model output, retain the
    // original squared-error fit against the picked beat times.
    let fitted = [...observed];
    for (let pass = 0; pass < (probabilities?.length ? 3 : 1); pass++) {
        let observations;
        if (probabilities?.length) {
            const evidence = probabilityObservations(ticks,
                fitted.map((time) => time / 1000), probabilities, frameMs);
            const averageWeight = evidence.reduce((sum, beat) =>
                sum + beat.evidenceWeight, 0) / count;
            observations = evidence.map(({ evidenceWeight, evidenceMs, originalMs }) => {
                // Keep the global smoothing setting comparable to the old fit;
                // confidence changes the relative influence of individual beats.
                const signalWeight = averageWeight
                    ? Math.min(3, evidenceWeight / averageWeight) : 0;
                const anchorWeight = averageWeight ? 0.15 : 1;
                const weight = anchorWeight + signalWeight;
                return { weight, targetMs:
                    (anchorWeight * originalMs + signalWeight * evidenceMs) / weight };
            });
        } else {
            observations = observed.map((targetMs) => ({ targetMs, weight: 1 }));
        }
        const weights = observations.map(({ weight }) => weight);
        const right = observations.map(({ targetMs, weight }) => targetMs * weight);
        let product = applySystem(fitted, weights);
        let residual = right.map((value, index) => value - product[index]);
        let direction = [...residual];
        let residualSize = residual.reduce((sum, value) => sum + value * value, 0);
        for (let iteration = 0; iteration < Math.min(256, count) && residualSize > 1e-8; iteration++) {
            product = applySystem(direction, weights);
            const denominator = direction.reduce((sum, value, index) =>
                sum + value * product[index], 0);
            const step = residualSize / denominator;
            fitted = fitted.map((time, index) => time + step * direction[index]);
            residual = residual.map((value, index) => value - step * product[index]);
            const nextSize = residual.reduce((sum, value) => sum + value * value, 0);
            const ratio = nextSize / residualSize;
            direction = residual.map((value, index) => value + ratio * direction[index]);
            residualSize = nextSize;
        }
    }
    const curve = fitted.map((time) => time / 1000);
    return curve.every((tick, index) => index === 0 || tick > curve[index - 1])
        ? curve : ticks;
}

function averageBpm(ticks) {
    if (ticks.length < 2) return 0;
    const secondsPerBeat = (ticks[ticks.length - 1] - ticks[0]) / (ticks.length - 1);
    return 60 / secondsPerBeat;
}

function fitSteadyTempo(observedBeatsMs, candidatePoints, toleranceMs, firstBeatMs, beatCount, requireSupport = true) {
    if (observedBeatsMs.length < (requireSupport ? 64 : 2)) return null;

    const inlierToleranceMs = 20 + 2 * toleranceMs;
    let best = null;
    for (const point of candidatePoints) {
        let offsetMs = point.offsetMs;
        let beatLengthMs = point.beatLengthMs;
        if (beatLengthMs < MIN_EXPORT_BEAT_LENGTH_MS || beatLengthMs > 1500) continue;

        // Refine both tempo and phase using beats close to this candidate
        // grid. Other beats may be detector extras or missed subdivisions.
        for (let pass = 0; pass < 5; pass++) {
            let count = 0;
            let sumIndex = 0;
            let sumTime = 0;
            let sumIndexSquared = 0;
            let sumIndexTime = 0;
            for (const timeMs of observedBeatsMs) {
                const index = Math.round((timeMs - offsetMs) / beatLengthMs);
                if (Math.abs(timeMs - offsetMs - index * beatLengthMs) > inlierToleranceMs + 5) {
                    continue;
                }
                count++;
                sumIndex += index;
                sumTime += timeMs;
                sumIndexSquared += index * index;
                sumIndexTime += index * timeMs;
            }
            if (count < 16) break;
            const denominator = count * sumIndexSquared - sumIndex * sumIndex;
            if (!denominator) break;
            const fittedLength = (count * sumIndexTime - sumIndex * sumTime) / denominator;
            if (fittedLength < MIN_EXPORT_BEAT_LENGTH_MS || fittedLength > 1500) break;
            beatLengthMs = fittedLength;
            offsetMs = (sumTime - beatLengthMs * sumIndex) / count;
        }

        const assigned = new Set();
        const quarterCounts = [0, 0, 0, 0];
        const quarterTotals = [0, 0, 0, 0];
        const edgeCounts = [0, 0];
        const edgeTotals = [0, 0];
        let inliers = 0;
        observedBeatsMs.forEach((timeMs, position) => {
            const quarter = Math.min(3, Math.floor(4 * position / observedBeatsMs.length));
            quarterTotals[quarter]++;
            if (position < 32) edgeTotals[0]++;
            if (position >= observedBeatsMs.length - 32) edgeTotals[1]++;
            const index = Math.round((timeMs - offsetMs) / beatLengthMs);
            if (Math.abs(timeMs - offsetMs - index * beatLengthMs) <= inlierToleranceMs) {
                inliers++;
                quarterCounts[quarter]++;
                if (position < 32) edgeCounts[0]++;
                if (position >= observedBeatsMs.length - 32) edgeCounts[1]++;
                assigned.add(index);
            }
        });
        const expectedBeats = Math.round(
            (observedBeatsMs.at(-1) - observedBeatsMs[0]) / beatLengthMs
        ) + 1;
        const precision = inliers / observedBeatsMs.length;
        const coverage = assigned.size / expectedBeats;
        const score = 2 * precision * coverage / (precision + coverage);
        const supported = precision >= 0.9 && coverage >= 0.9 &&
            quarterCounts.every((count, quarter) => count / quarterTotals[quarter] >= 0.8) &&
            edgeCounts.every((count, edge) => count / edgeTotals[edge] >= 0.65);
        if (requireSupport && !supported) continue;
        if (!best || score > best.score) {
            best = { offsetMs, beatLengthMs, score, supported };
        }
    }

    if (!best) return null;
    const beatLengthMs = Number(best.beatLengthMs.toFixed(5));
    const firstIndex = Math.round((firstBeatMs - best.offsetMs) / best.beatLengthMs);
    const offsetMs = Math.round(best.offsetMs + firstIndex * best.beatLengthMs);
    return {
        timingPoints: [{ offsetMs, beatLengthMs }],
        beatLengths: Array(beatCount - 1).fill(beatLengthMs.toFixed(5)),
        fitWarning: !best.supported,
    };
}

// The provisional grid supplies a stable beat count for probability alignment.
// The final timing points are selected by the whole-track fit below.
function provisionalTimingGrid(ticks, { toleranceMs, windowSize, tempoPattern }) {
    const beatsMs = ticks.map((tick) => tick * 1000);
    const typicalBeatLengthMs = medianPositiveInterval(ticks) * 1000;
    const minBeats = Math.max(2, Math.floor(windowSize / 2));
    const timingPoints = [];
    let offsetMs = Math.round(beatsMs[0]);
    let lastTimingStart = 0;
    for (let start = 0; start < beatsMs.length - 1;) {
        const limit = Math.min(beatsMs.length - 1,
            tempoPattern === "continuous" ? start + 16 : Infinity);
        let end = Math.min(limit, start + minBeats);
        for (let candidate = end + 1; candidate <= limit; candidate++) {
            const length = (beatsMs[candidate] - offsetMs) / (candidate - start);
            let largestResidual = 0;
            let rollingResidual = 0;
            let largestDrift = 0;
            const residuals = [];
            for (let index = start + 1; index < candidate; index++) {
                const residual = beatsMs[index] - offsetMs - (index - start) * length;
                largestResidual = Math.max(largestResidual, Math.abs(residual));
                residuals.push(residual);
                rollingResidual += residual;
                if (residuals.length > 8) rollingResidual -= residuals[residuals.length - 9];
                if (residuals.length >= 8) {
                    largestDrift = Math.max(largestDrift, Math.abs(rollingResidual / 8));
                }
            }
            if (largestResidual > 20 + 2 * toleranceMs || largestDrift > 5 + toleranceMs) break;
            end = candidate;
        }
        const beatLengthMs = Number(((beatsMs[end] - offsetMs) / (end - start)).toFixed(2));
        const previous = timingPoints.at(-1);
        if (!previous || previous.beatLengthMs !== beatLengthMs ||
            Math.abs(offsetMs - (previous.offsetMs +
                (start - lastTimingStart) * previous.beatLengthMs)) > 1e-6) {
            timingPoints.push({ offsetMs, beatLengthMs });
            lastTimingStart = start;
        }
        offsetMs = Math.floor(offsetMs + (end - start) * beatLengthMs + 1e-7);
        start = end;
    }
    return timingPoints;
}

const TEMPO_MOVEMENT_MEMORY_MS = 8000;
const TEMPO_MOVEMENT_ALLOWANCE_BPM = 20;
const TEMPO_MOVEMENT_SCALE_BPM = 30;
// Avoid switching pulses or moving red points for a marginal support increase.
const PULSE_HYPOTHESIS_MARGIN = 0.05;
const POINT_REFINEMENT_MIN_GAIN = 0.005;

export function scoreTempoChange(previousBeatLengthMs, beatLengthMs,
    recentBpmMovement, elapsedMs, jumpPenalty) {
    const logBpmChange = Math.abs(Math.log(beatLengthMs / previousBeatLengthMs));
    const bpmChange = Math.abs(60000 / beatLengthMs - 60000 / previousBeatLengthMs);
    const recent = recentBpmMovement * Math.exp(-elapsedMs / TEMPO_MOVEMENT_MEMORY_MS);
    const movement = recent + bpmChange;
    const excursionCost = (value) =>
        (Math.max(0, value - TEMPO_MOVEMENT_ALLOWANCE_BPM) / TEMPO_MOVEMENT_SCALE_BPM) ** 4;
    return {
        // Charge the increase in a steep cost of recent absolute BPM movement.
        // Both a reversal and several smaller steps accumulate the same motion;
        // a sustained new tempo lets the history decay in real elapsed time.
        cost: jumpPenalty * (logBpmChange ** 2 +
            // A large jump after a short section is less plausible than a
            // sustained new tempo. Keep this finite for genuine transitions.
            4 * Math.max(0, logBpmChange - Math.log(1.3)) ** 2 *
                Math.exp(-elapsedMs / TEMPO_MOVEMENT_MEMORY_MS) +
            excursionCost(movement) - excursionCost(recent)),
        recentBpmMovement: movement,
    };
}

// Match observations to a candidate grid one-to-one. Missing beats and extra
// detections pay a finite cost instead of forcing every observation to advance
// the beat index. Two observations cannot claim the same exported beat.
function gridResidualCost(beatsMs, start, end, offsetMs, beatLengthMs, beatCount, unmatchedCost) {
    let cost = 0;
    let matched = 0;
    let lastIndex = 0;
    let lastError = 0;
    for (let index = start + 1; index <= end; index++) {
        const beatIndex = Math.round((beatsMs[index] - offsetMs) / beatLengthMs);
        const error = (beatsMs[index] - offsetMs - beatIndex * beatLengthMs) ** 2;
        if (beatIndex <= 0 || beatIndex > beatCount || error >= 2 * unmatchedCost) {
            cost += unmatchedCost;
        } else if (beatIndex === lastIndex) {
            cost += unmatchedCost + Math.min(0, error - lastError);
            lastError = Math.min(lastError, error);
        } else {
            cost += error;
            matched++;
            lastIndex = beatIndex;
            lastError = error;
        }
    }
    return cost + (beatCount - matched) * unmatchedCost;
}

// Choose section boundaries across the entire track. Each candidate section
// pays for its timing error; a transition also pays for a new timing point and
// for the size of its BPM change. This lets a later beat influence an earlier
// boundary instead of committing to the first locally acceptable section.
export function fitTimingGrid(ticks, {
    tempoPattern = null, toleranceMs = defaultToleranceMs(tempoPattern),
    windowSize = 4, observedTicks = ticks,
} = {}) {
    if (ticks.length < 2) return { timingPoints: [], beatLengths: [] };
    if (!observedTicks.length) observedTicks = ticks;

    const beatsMs = ticks.map((tick) => tick * 1000);
    const typicalBeatLengthMs = medianPositiveInterval(ticks) * 1000;
    const minBeats = Math.max(2, Math.floor(windowSize / 2));
    const maxSectionBeats = Math.max(minBeats, tempoPattern === "continuous" ? 16 : 64);
    const toleranceScale = Math.max(1, toleranceMs / 5) ** 2;
    const unmatchedCost = 100 ** 2 * toleranceScale;
    const sectionPenalty = (tempoPattern === "continuous" ? 1500 : 1800) * toleranceScale;
    // Prefer small live tempo drift to a few unsupported large jumps.
    const jumpPenalty = (tempoPattern === "continuous" ? 4_000_000 : 100_000) * toleranceScale;
    const states = Array.from({ length: beatsMs.length }, () => []);
    states[0].push({
        cost: 0, previous: null, start: 0, end: 0,
        beatLengthMs: 0, recentBpmMovement: 0,
        offsetMs: Math.round(beatsMs[0]), endOffsetMs: Math.round(beatsMs[0]),
    });

    for (let end = 1; end < beatsMs.length; end++) {
        const candidates = [];
        for (let start = Math.max(0, end - maxSectionBeats); start < end; start++) {
            if (end - start < minBeats && end !== beatsMs.length - 1) continue;
            const count = end - start;
            if (!(beatsMs[end] > beatsMs[start])) continue;
            const segmentCosts = new Map();
            for (const previous of states[start]) {
                const offsetMs = previous.endOffsetMs;
                const spanMs = beatsMs[end] - offsetMs;
                // Keep the detected count as an option, but also try the pulse
                // carried by the previous section and the track's typical pulse.
                // Neither alternative requires a reference map or tempo label.
                const maxBeatCount = Math.max(1, Math.floor(spanMs / (MIN_EXPORT_BEAT_LENGTH_MS - 0.005)));
                const beatCounts = new Set([
                    count,
                    Math.max(1, Math.round(spanMs / (previous.beatLengthMs || typicalBeatLengthMs))),
                    Math.max(1, Math.round(spanMs / typicalBeatLengthMs)),
                ].map((value) => Math.min(value, maxBeatCount)));
                for (const beatCount of beatCounts) {
                    const key = `${offsetMs}:${beatCount}`;
                    let segment = segmentCosts.get(key);
                    if (!segment) {
                        const beatLengthMs = Math.max(MIN_EXPORT_BEAT_LENGTH_MS,
                            Number((spanMs / beatCount).toFixed(2)));
                        segment = { beatLengthMs, timingError: gridResidualCost(
                            beatsMs, start, end, offsetMs, beatLengthMs, beatCount, unmatchedCost
                        ) };
                        segmentCosts.set(key, segment);
                    }
                    const { beatLengthMs, timingError } = segment;
                    if (start && tempoPattern && tempoPattern !== "fixed" &&
                        isOctaveJump(previous.beatLengthMs, beatLengthMs)) continue;
                    const change = start
                        ? scoreTempoChange(previous.beatLengthMs, beatLengthMs,
                            previous.recentBpmMovement, offsetMs - previous.offsetMs, jumpPenalty)
                        : { cost: 0, recentBpmMovement: 0 };
                    candidates.push({
                        cost: previous.cost + timingError + (start ? sectionPenalty +
                            change.cost : 0),
                        previous, start, end, beatCount, beatLengthMs, offsetMs,
                        // Score exactly the rounded, continuous grid we export.
                        endOffsetMs: Math.floor(offsetMs + beatCount * beatLengthMs + 1e-7),
                        recentBpmMovement: change.recentBpmMovement,
                    });
                }
            }
        }
        // Retain the cheapest paths with distinct terminal tempos or recent
        // jump histories, which both affect the next transition cost.
        candidates.sort((left, right) => left.cost - right.cost);
        for (const candidate of candidates) {
            if (states[end].every((state) =>
                Math.abs(Math.log(candidate.beatLengthMs / state.beatLengthMs)) > 0.005 ||
                Math.abs(candidate.recentBpmMovement - state.recentBpmMovement) > 3 ||
                Math.abs(candidate.endOffsetMs - state.endOffsetMs) > 1
            )) states[end].push(candidate);
            if (states[end].length === 24) break;
        }
    }

    const sections = [];
    let state = states.at(-1)[0];
    while (state?.previous) {
        sections.push(state);
        state = state.previous;
    }
    sections.reverse();
    const timingPoints = [];
    const beatLengths = [];
    let lastTimingStart = 0;
    let exportedBeatIndex = 0;
    for (const { start, end, offsetMs, beatLengthMs, beatCount } of sections) {
        const previous = timingPoints.at(-1);
        if (
            !previous ||
            previous.beatLengthMs !== beatLengthMs ||
            Math.abs(offsetMs - (
                previous.offsetMs + (exportedBeatIndex - lastTimingStart) * previous.beatLengthMs
            )) > 1e-6
        ) {
            timingPoints.push({ offsetMs, beatLengthMs });
            lastTimingStart = exportedBeatIndex;
        }
        exportedBeatIndex += beatCount;
        for (let index = start; index < end; index++) {
            beatLengths.push(beatLengthMs.toFixed(2));
        }
    }

    const observedBeatsMs = observedTicks.map((tick) => tick * 1000);
    if (tempoPattern === "fixed" || tempoPattern === null) {
        return fitSteadyTempo(
            observedBeatsMs, timingPoints, toleranceMs, beatsMs[0], beatsMs.length,
            tempoPattern === null
        ) ?? { timingPoints, beatLengths, fitWarning: tempoPattern === "fixed" };
    }
    return { timingPoints, beatLengths };
}

export function generateTimingGrid(timingPoints, durationMs) {
    const beats = [];
    timingPoints.forEach((point, index) => {
        const sectionEnd = Math.min(timingPoints[index + 1]?.offsetMs ?? durationMs, durationMs);
        for (let beatIndex = 0;
            point.offsetMs + beatIndex * point.beatLengthMs < sectionEnd;
            beatIndex++
        ) {
            const beatMs = point.offsetMs + beatIndex * point.beatLengthMs;
            if (beatMs >= 0) beats.push(beatMs / 1000);
        }
    });
    return beats;
}

function generateOsuTimingPoints(timingPoints) {
    const lines = timingPoints.map(({ offsetMs, beatLengthMs }) => {
        const decimals = beatLengthMs === Number(beatLengthMs.toFixed(2)) ? 2 : 5;
        return `${offsetMs},${beatLengthMs.toFixed(decimals)},4,2,0,100,1,0`;
    });
    return `[TimingPoints]\n${lines.join("\n")}`;
}

function beatLengthsAtTicks(ticks, timingPoints) {
    let pointIndex = 0;
    return ticks.slice(0, -1).map((tick) => {
        while (pointIndex + 1 < timingPoints.length &&
            timingPoints[pointIndex + 1].offsetMs <= tick * 1000) pointIndex++;
        return timingPoints[pointIndex].beatLengthMs.toFixed(2);
    });
}

function competingPulseHypotheses(gridTicks, observedTicks, tempoPattern) {
    if (tempoPattern === "fixed") return [gridTicks];
    const primary = tempoPattern === "continuous"
        ? selectPulse(gridTicks, observedTicks) : gridTicks;
    const hypotheses = [primary, gridTicks];
    for (const phase of [0, 1]) {
        hypotheses.push(gridTicks.filter((_, index) => index % 2 === phase));
    }
    hypotheses.push(doubleTicks(gridTicks));

    const seen = new Set();
    return hypotheses.filter((ticks) => {
        if (ticks.length < 2) return false;
        const key = ticks.map((tick) => Math.round(tick * 1e6)).join(",");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function scorePulseHypothesis(timingPoints, observedTicks, probabilities, durationMs,
    frameMs = MODEL_FRAME_MS) {
    const gridMs = generateTimingGrid(timingPoints, durationMs).map((tick) => tick * 1000);
    if (!gridMs.length) return -Infinity;
    const observedMs = observedTicks.map((tick) => tick * 1000);
    const typicalInterval = medianPositiveInterval(observedTicks) * 1000;
    const matchTolerance = Math.min(80, typicalInterval * 0.2);
    let detectedIndex = 0;
    let gridIndex = 0;
    let matches = 0;
    while (detectedIndex < observedMs.length && gridIndex < gridMs.length) {
        const difference = observedMs[detectedIndex] - gridMs[gridIndex];
        if (Math.abs(difference) <= matchTolerance) {
            matches++;
            detectedIndex++;
            gridIndex++;
        } else if (difference < 0) detectedIndex++;
        else gridIndex++;
    }
    const total = observedMs.length + gridMs.length;
    const detectionF1 = total ? 2 * matches / total : 0;
    if (!probabilities?.length) return detectionF1;

    const radius = Math.max(1, Math.round(Math.min(30, typicalInterval * 0.1) / frameMs));
    let probabilitySupport = 0;
    for (const timeMs of gridMs) {
        const center = Math.round(timeMs / frameMs);
        let peak = 0;
        for (let frame = Math.max(0, center - radius);
            frame <= Math.min(probabilities.length - 1, center + radius); frame++) {
            peak = Math.max(peak, probabilities[frame]);
        }
        probabilitySupport += peak;
    }
    return 0.7 * probabilitySupport / gridMs.length + 0.3 * detectionF1;
}

function fitWeightedTempoLine(observations, weights) {
    let sumWeight = 0;
    let sumBeat = 0;
    let sumTime = 0;
    let sumBeatSquared = 0;
    let sumBeatTime = 0;
    observations.forEach(({ beat, timeMs }, index) => {
        const weight = weights[index];
        sumWeight += weight;
        sumBeat += weight * beat;
        sumTime += weight * timeMs;
        sumBeatSquared += weight * beat ** 2;
        sumBeatTime += weight * beat * timeMs;
    });
    const denominator = sumWeight * sumBeatSquared - sumBeat ** 2;
    if (!denominator) return null;
    const beatLengthMs = (sumWeight * sumBeatTime - sumBeat * sumTime) / denominator;
    return {
        offsetMs: (sumTime - beatLengthMs * sumBeat) / sumWeight,
        beatLengthMs,
    };
}

function refineExportTimingPoints(timingPoints, probabilities, durationMs,
    frameMs = MODEL_FRAME_MS) {
    if (!probabilities?.length) return timingPoints;
    return timingPoints.map((point, section) => {
        const endMs = Math.min(timingPoints[section + 1]?.offsetMs ?? durationMs, durationMs);
        const beatCount = Math.floor((endMs - point.offsetMs - 1e-6) / point.beatLengthMs) + 1;
        if (beatCount < 8) return point;

        const observations = [];
        const radiusFrames = Math.max(1, Math.floor(
            Math.min(35, point.beatLengthMs * 0.12) / frameMs
        ));
        for (let beat = 0; beat < beatCount; beat++) {
            const expectedMs = point.offsetMs + beat * point.beatLengthMs;
            const center = Math.round(expectedMs / frameMs);
            const first = Math.max(1, center - radiusFrames);
            const last = Math.min(probabilities.length - 2, center + radiusFrames);
            let peakFrame = -1;
            for (let frame = first; frame <= last; frame++) {
                if (peakFrame < 0 || probabilities[frame] > probabilities[peakFrame]) peakFrame = frame;
            }
            if (peakFrame < 0 || probabilities[peakFrame] < 0.05) continue;
            const left = probabilities[peakFrame - 1];
            const peak = probabilities[peakFrame];
            const right = probabilities[peakFrame + 1];
            const curvature = left - 2 * peak + right;
            const subframe = curvature < 0
                ? clamp(0.5 * (left - right) / curvature, -0.5, 0.5) : 0;
            observations.push({
                beat,
                timeMs: (peakFrame + subframe) * frameMs,
                weight: peak * peak,
                strength: peak,
            });
        }
        if (observations.length < Math.max(8, Math.ceil(beatCount * 0.25))) return point;

        let line = point;
        let weights = observations.map(({ weight }) => weight);
        for (let pass = 0; pass < 4; pass++) {
            const fittedLine = fitWeightedTempoLine(observations, weights);
            if (!fittedLine) break;
            line = fittedLine;
            weights = observations.map((observation) => {
                const error = Math.abs(observation.timeMs - line.offsetMs -
                    observation.beat * line.beatLengthMs);
                return observation.weight * Math.min(1, 15 / Math.max(15, error));
            });
        }

        const averageStrength = observations.reduce((sum, observation) =>
            sum + observation.strength, 0) / observations.length;
        const confidence = Math.min(1, (observations.length - 4) / 16) *
            Math.min(1, averageStrength / 0.35);
        const maxPeriodChange = Math.max(0.5, point.beatLengthMs * 0.002);
        const periodCandidate = point.beatLengthMs + clamp(
            line.beatLengthMs - point.beatLengthMs, -maxPeriodChange, maxPeriodChange
        ) * confidence;
        const refinedPeriod = clamp(periodCandidate, MIN_EXPORT_BEAT_LENGTH_MS, 1500);
        const refinedOffset = point.offsetMs + clamp(line.offsetMs - point.offsetMs,
            -35, 35) * confidence;
        return {
            offsetMs: Math.round(refinedOffset),
            beatLengthMs: Number(refinedPeriod.toFixed(5)),
        };
    });
}

export function calculateTiming(ticks, options = {}) {
    const probabilityFrameMs = options.probabilityFrameMs ?? MODEL_FRAME_MS;
    let fittedTicks = ticks;
    let fitted = options.tempoPattern && options.tempoPattern !== "fixed" && ticks.length >= 3
        ? { timingPoints: provisionalTimingGrid(ticks, {
            toleranceMs: options.toleranceMs ?? defaultToleranceMs(options.tempoPattern),
            windowSize: options.windowSize ?? DEFAULT_TIMING_OPTIONS.windowSize,
            tempoPattern: options.tempoPattern,
        }) }
        : fitTimingGrid(ticks, options);
    const initialFitWarning = fitted.fitWarning ?? false;
    const durationMs = options.endTime === undefined
        ? (ticks.at(-1) ?? 0) * 1000 + (fitted.timingPoints.at(-1)?.beatLengthMs ?? 0)
        : options.endTime * 1000;

    if (options.tempoPattern && fitted.timingPoints.length && ticks.length >= 3) {
        const observedTicks = options.observedTicks?.length ? options.observedTicks : ticks;
        const initialGrid = generateTimingGrid(fitted.timingPoints, durationMs);
        // In section mode, keep changes that persist on both sides of a red
        // point while regularizing the brief excursions between them.
        const boundaries = options.tempoPattern === "sections"
            ? fitted.timingPoints.slice(1).flatMap((point, index) => {
                const previous = fitted.timingPoints[index];
                const nextOffset = fitted.timingPoints[index + 2]?.offsetMs ?? durationMs;
                const previousBeats = (point.offsetMs - previous.offsetMs) / previous.beatLengthMs;
                const followingBeats = (nextOffset - point.offsetMs) / point.beatLengthMs;
                return previousBeats >= 3 && followingBeats >= 3
                    ? [point.offsetMs / 1000] : [];
            }) : [];
        const smoothness = options.tempoSmoothness ?? defaultTempoSmoothness(options.tempoPattern);
        const candidates = options.preserveInputPulse
            ? [initialGrid]
            : competingPulseHypotheses(initialGrid, observedTicks,
                options.tempoPattern);
        const constrainPoints = options.tempoPattern === "fixed" ? (points) => points
            : (points) => constrainOctaveJumps(points, durationMs, {
                observedTicks, downbeatTicks: options.downbeatTicks,
                probabilities: options.probabilities, probabilityFrameMs,
            });
        let best = null;
        for (const pulseGrid of candidates) {
            const candidateTicks = fitTempoCurve(pulseGrid,
                options.tempoPattern === "sections" ? smoothness / 5 : smoothness,
                boundaries, options.probabilities, probabilityFrameMs);
            const candidateFit = fitTimingGrid(candidateTicks, {
                ...options,
                observedTicks: options.tempoPattern === "fixed" ? observedTicks : candidateTicks,
            });
            let candidatePoints = candidateFit.timingPoints;
            if (options.tempoPattern === "sections") {
                const stablePoints = chooseStableSections(observedTicks,
                    candidateFit.timingPoints, durationMs);
                if (stablePoints?.length && stablePoints.every(({ beatLengthMs }) =>
                    beatLengthMs >= MIN_EXPORT_BEAT_LENGTH_MS)) {
                    candidatePoints = stablePoints;
                }
            }
            candidatePoints = constrainPoints(candidatePoints);
            const baseScore = scorePulseHypothesis(candidatePoints, observedTicks,
                options.probabilities, durationMs, probabilityFrameMs);
            const refinedPoints = constrainPoints(refineExportTimingPoints(
                candidatePoints, options.probabilities, durationMs,
                probabilityFrameMs
            ));
            const refinedScore = scorePulseHypothesis(refinedPoints, observedTicks,
                options.probabilities, durationMs, probabilityFrameMs);
            const useRefinement = refinedScore > baseScore + POINT_REFINEMENT_MIN_GAIN;
            const score = useRefinement ? refinedScore : baseScore;
            if (Number.isFinite(score) && (!best || score > best.score + PULSE_HYPOTHESIS_MARGIN)) {
                const points = useRefinement ? refinedPoints : candidatePoints;
                best = { score, candidateTicks, candidateFit: {
                    ...candidateFit, timingPoints: points,
                    // Fixed fits can have diagnostic lengths distinct from the
                    // grid; retain them when neither replacement is selected.
                    beatLengths: options.tempoPattern === "fixed" && !useRefinement
                        ? candidateFit.beatLengths : beatLengthsAtTicks(candidateTicks, points),
                } };
            }
        }
        if (best) {
            fittedTicks = best.candidateTicks;
            fitted = best.candidateFit;
        }
    }
    const { timingPoints, beatLengths } = fitted;
    const fitWarning = initialFitWarning || (fitted.fitWarning ?? false);

    return {
        averageBpm: averageBpm(ticks),
        beatLengths,
        timingPoints,
        tempoPattern: options.tempoPattern ? TEMPO_PATTERNS[options.tempoPattern] : null,
        fitWarning,
        gridTicks: generateTimingGrid(timingPoints, durationMs),
        rawBpmSeries: ticks.slice(0, -1).map((time, index) => ({
            x: time,
            y: 60 / (ticks[index + 1] - time),
        })),
        smoothedBpmSeries: fittedTicks.slice(0, -1).map((time, index) => ({
            x: time,
            y: 60000 / Number(beatLengths[index]),
        })),
        osuTimingPoints: generateOsuTimingPoints(timingPoints),
    };
}

// Place a beat at the midpoint of every gap (102 -> 204 BPM).
export function doubleTicks(ticks) {
    return ticks.flatMap((tick, index) =>
        index < ticks.length - 1 ? [tick, (tick + ticks[index + 1]) / 2] : [tick]
    );
}

// Keep every other beat (204 -> 102 BPM).
export function halveTicks(ticks) {
    return ticks.filter((_, index) => index % 2 === 0);
}
