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

function fitTempoCurve(ticks, smoothness, boundaries = []) {
    if (ticks.length < 3) return ticks;
    const observed = ticks.map((tick) => tick * 1000);
    const count = observed.length;
    const penalties = Array(count).fill(smoothness);
    for (let index = 1; index < count - 1; index++) {
        if (boundaries.some((time) => ticks[index - 1] < time && time <= ticks[index + 1])) {
            penalties[index] = 0;
        }
    }
    const applySystem = (values) => {
        const result = [...values];
        for (let index = 1; index < count - 1; index++) {
            const curvature = values[index - 1] - 2 * values[index] + values[index + 1];
            result[index - 1] += penalties[index] * curvature;
            result[index] -= 2 * penalties[index] * curvature;
            result[index + 1] += penalties[index] * curvature;
        }
        return result;
    };

    // Minimize squared beat-time error plus squared changes in beat spacing.
    // The latter penalizes abrupt tempo spikes without capping BPM or jumps.
    let fitted = [...observed];
    let product = applySystem(fitted);
    let residual = observed.map((time, index) => time - product[index]);
    let direction = [...residual];
    let residualSize = residual.reduce((sum, value) => sum + value * value, 0);
    for (let iteration = 0; iteration < Math.min(256, count) && residualSize > 1e-8; iteration++) {
        product = applySystem(direction);
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

// Fit each section to the longest run that stays near a straight beat grid.
// A section starts on the beat predicted by the previous one, so changing
// tempo cannot create a second beat just before the new timing point.
export function fitTimingGrid(ticks, {
    toleranceMs = 5, windowSize = 4, observedTicks = ticks, tempoPattern = null,
} = {}) {
    if (ticks.length < 2) return { timingPoints: [], beatLengths: [] };
    if (!observedTicks.length) observedTicks = ticks;

    const beatsMs = ticks.map((tick) => tick * 1000);
    const minBeats = Math.max(2, Math.floor(windowSize / 2));
    const maxResidualMs = 20 + 2 * toleranceMs;
    const maxDriftMs = 5 + toleranceMs;
    const timingPoints = [];
    const beatLengths = [];
    let lastTimingStart = 0;
    let offsetMs = Math.round(beatsMs[0]);

    for (let start = 0; start < beatsMs.length - 1;) {
        const limit = Math.min(
            beatsMs.length - 1,
            tempoPattern === "continuous" ? start + 16 : Infinity
        );
        let end = Math.min(limit, start + minBeats);

        // The endpoint sets the tempo. Check every interior beat before
        // extending the section, including inserted beats and tempo drift.
        for (let candidate = end + 1; candidate <= limit; candidate++) {
            const beatLengthMs = (beatsMs[candidate] - offsetMs) / (candidate - start);
            let largestResidualMs = 0;
            let rollingResidualMs = 0;
            let largestDriftMs = 0;
            const residuals = [];
            for (let index = start + 1; index < candidate; index++) {
                const predicted = offsetMs + (index - start) * beatLengthMs;
                const residual = beatsMs[index] - predicted;
                largestResidualMs = Math.max(largestResidualMs, Math.abs(residual));
                residuals.push(residual);
                rollingResidualMs += residual;
                if (residuals.length > 8) rollingResidualMs -= residuals[residuals.length - 9];
                if (residuals.length >= 8) {
                    largestDriftMs = Math.max(largestDriftMs, Math.abs(rollingResidualMs / 8));
                }
            }
            if (largestResidualMs > maxResidualMs || largestDriftMs > maxDriftMs) break;
            end = candidate;
        }

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
        start = end;
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
    let fitted = fitTimingGrid(ticks, options);
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
            boundaries);
        fitted = fitTimingGrid(fittedTicks, {
            ...options,
            observedTicks: options.tempoPattern === "fixed" ? observedTicks : fittedTicks,
        });
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
