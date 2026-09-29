import { MODEL_HOP_LENGTH, MODEL_SAMPLE_RATE } from "./mel-spectrogram.js";
import { chooseStableSections } from "./fixed-sections.js";

export const DEFAULT_TIMING_OPTIONS = Object.freeze({
    toleranceMs: 5,
    windowSize: 4,
    tempoSmoothness: 5,
});

export const TEMPO_PATTERNS = Object.freeze({
    fixed: "Fixed BPM",
    continuous: "Continuously variable BPM",
    sections: "Variable BPM with fixed sections",
});

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

function probabilityObservations(ticks, estimates, probabilities) {
    const frameMs = 1000 * MODEL_HOP_LENGTH / MODEL_SAMPLE_RATE;
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

function fitTempoCurve(ticks, smoothness, boundaries = [], probabilities = null) {
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
                fitted.map((time) => time / 1000), probabilities);
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
        if (beatLengthMs < 150 || beatLengthMs > 1500) continue;

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
            if (fittedLength < 150 || fittedLength > 1500) break;
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

const LARGE_JUMP_THRESHOLD = Math.log(1.08);
const LARGE_JUMP_MEMORY_BEATS = 16;

export function scoreTempoChange(previousBeatLengthMs, beatLengthMs,
    recentLargeJumps, beatsSincePreviousChange, jumpPenalty) {
    const logBpmChange = Math.abs(Math.log(beatLengthMs / previousBeatLengthMs));
    const largeExcess = Math.max(0, logBpmChange - LARGE_JUMP_THRESHOLD);
    const recent = recentLargeJumps *
        Math.exp(-beatsSincePreviousChange / LARGE_JUMP_MEMORY_BEATS);
    return {
        // A squared log ratio penalizes a large percentage change more than
        // several small ones. Repeated large jumps add a decaying surcharge.
        cost: jumpPenalty * (logBpmChange ** 2 + largeExcess ** 2 * recent),
        recentLargeJumps: Math.min(4, recent + largeExcess / Math.log(1.1)),
    };
}

// Choose section boundaries across the entire track. Each candidate section
// pays for its timing error; a transition also pays for a new timing point and
// for the size of its BPM change. This lets a later beat influence an earlier
// boundary instead of committing to the first locally acceptable section.
export function fitTimingGrid(ticks, {
    toleranceMs = 5, windowSize = 4, observedTicks = ticks, tempoPattern = null,
} = {}) {
    if (ticks.length < 2) return { timingPoints: [], beatLengths: [] };
    if (!observedTicks.length) observedTicks = ticks;

    const beatsMs = ticks.map((tick) => tick * 1000);
    const minBeats = Math.max(2, Math.floor(windowSize / 2));
    const maxSectionBeats = Math.max(minBeats, tempoPattern === "continuous" ? 16 : 64);
    const toleranceScale = Math.max(1, toleranceMs / 5) ** 2;
    const sectionPenalty = (tempoPattern === "continuous" ? 1500 : 1800) * toleranceScale;
    const jumpPenalty = (tempoPattern === "continuous" ? 250000 : 100000) * toleranceScale;
    const states = Array.from({ length: beatsMs.length }, () => []);
    states[0].push({
        cost: 0, previous: null, start: 0, end: 0,
        beatLengthMs: 0, recentLargeJumps: 0,
    });

    for (let end = 1; end < beatsMs.length; end++) {
        const candidates = [];
        for (let start = Math.max(0, end - maxSectionBeats); start < end; start++) {
            if (end - start < minBeats && end !== beatsMs.length - 1) continue;
            const beatLengthMs = (beatsMs[end] - beatsMs[start]) / (end - start);
            if (!(beatLengthMs > 0)) continue;
            let timingError = 0;
            for (let index = start + 1; index < end; index++) {
                const residual = beatsMs[index] - beatsMs[start] -
                    (index - start) * beatLengthMs;
                timingError += residual * residual;
            }
            for (const previous of states[start]) {
                const change = start
                    ? scoreTempoChange(previous.beatLengthMs, beatLengthMs,
                        previous.recentLargeJumps, start - previous.start, jumpPenalty)
                    : { cost: 0, recentLargeJumps: 0 };
                candidates.push({
                    cost: previous.cost + timingError + (start ? sectionPenalty +
                        change.cost : 0),
                    previous, start, end, beatLengthMs,
                    recentLargeJumps: change.recentLargeJumps,
                });
            }
        }
        // Retain the cheapest paths with distinct terminal tempos or recent
        // jump histories, which both affect the next transition cost.
        candidates.sort((left, right) => left.cost - right.cost);
        for (const candidate of candidates) {
            if (states[end].every((state) =>
                Math.abs(Math.log(candidate.beatLengthMs / state.beatLengthMs)) > 0.005 ||
                Math.abs(candidate.recentLargeJumps - state.recentLargeJumps) > 0.3
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
    let offsetMs = Math.round(beatsMs[0]);
    for (const { start, end } of sections) {
        const beatLengthMs = Number(((beatsMs[end] - offsetMs) / (end - start)).toFixed(2));
        const previous = timingPoints.at(-1);
        if (
            !previous ||
            previous.beatLengthMs !== beatLengthMs ||
            Math.abs(offsetMs - (
                previous.offsetMs + (start - lastTimingStart) * previous.beatLengthMs
            )) > 1e-6
        ) {
            timingPoints.push({ offsetMs, beatLengthMs });
            lastTimingStart = start;
        }
        for (let index = start; index < end; index++) {
            beatLengths.push(beatLengthMs.toFixed(2));
        }

        // Integer osu! offsets must be at or before the prior section's
        // next beat; rounding up could make that beat appear twice.
        offsetMs = Math.floor(offsetMs + (end - start) * beatLengthMs + 1e-7);
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

export function calculateTiming(ticks, options = {}) {
    let fittedTicks = ticks;
    let fitted = options.tempoPattern && options.tempoPattern !== "fixed" && ticks.length >= 2
        ? { timingPoints: provisionalTimingGrid(ticks, {
            toleranceMs: options.toleranceMs ?? DEFAULT_TIMING_OPTIONS.toleranceMs,
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
        const pulseGrid = options.tempoPattern === "continuous"
            ? selectPulse(initialGrid, observedTicks) : initialGrid;
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
        const smoothness = options.tempoSmoothness ?? DEFAULT_TIMING_OPTIONS.tempoSmoothness;
        fittedTicks = fitTempoCurve(pulseGrid,
            options.tempoPattern === "sections" ? smoothness / 5 : smoothness,
            boundaries, options.probabilities);
        fitted = fitTimingGrid(fittedTicks, {
            ...options,
            observedTicks: options.tempoPattern === "fixed" ? observedTicks : fittedTicks,
        });
    }
    if (options.tempoPattern === "sections") {
        const stablePoints = chooseStableSections(
            options.observedTicks?.length ? options.observedTicks : ticks,
            fitted.timingPoints, durationMs
        );
        if (stablePoints) {
            fitted = {
                ...fitted,
                timingPoints: stablePoints,
                beatLengths: fittedTicks.slice(0, -1).map((tick) => {
                    let index = 0;
                    while (index + 1 < stablePoints.length &&
                        stablePoints[index + 1].offsetMs <= tick * 1000) index++;
                    return stablePoints[index].beatLengthMs.toFixed(2);
                }),
            };
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
