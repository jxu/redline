const DEFAULT_OPTIONS = Object.freeze({
    historySize: 8,
    intervalTolerance: 0.15,
    maxGapBeats: 32,
    minBeatInterval: 60 / 240,
    maxBeatInterval: 60 / 60,
});

function median(values) {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Fold very fast subdivisions and very slow gaps into a plausible 60-240 BPM
// range before using them as evidence for the local tempo.
function normalizeInterval(interval, minInterval, maxInterval) {
    while (interval < minInterval) interval *= 2;
    while (interval > maxInterval) interval /= 2;
    return interval;
}

export function interpolateBeatGaps(ticks, options = {}) {
    if (ticks.length < 2) return [...ticks];

    const {
        endTime = null,
        historySize = DEFAULT_OPTIONS.historySize,
        intervalTolerance = DEFAULT_OPTIONS.intervalTolerance,
        maxGapBeats = DEFAULT_OPTIONS.maxGapBeats,
        minBeatInterval = DEFAULT_OPTIONS.minBeatInterval,
        maxBeatInterval = DEFAULT_OPTIONS.maxBeatInterval,
    } = options;
    const interpolated = [ticks[0]];
    const intervalHistory = [];

    for (let index = 1; index < ticks.length; index++) {
        const previous = ticks[index - 1];
        const next = ticks[index];
        const gap = next - previous;
        const previousInterval = intervalHistory.length
            ? median(intervalHistory)
            : null;
        let divisions = 1;

        if (previousInterval !== null) {
            const candidateDivisions = Math.round(gap / previousInterval);
            const impliedInterval = gap / candidateDivisions;
            if (
                candidateDivisions >= 2 &&
                candidateDivisions <= maxGapBeats &&
                Math.abs(impliedInterval - previousInterval) / previousInterval <=
                    intervalTolerance
            ) {
                divisions = candidateDivisions;
            }
        }

        if (divisions > 1) {
            // Continue the previous tempo just as an osu! red timing point does.
            // The next observed peak remains an anchor and may establish a
            // corrected interval for subsequent beats.
            const impliedInterval = gap / divisions;
            for (let subdivision = 1; subdivision < divisions; subdivision++) {
                const tick = previous + subdivision * previousInterval;
                if (tick < next) interpolated.push(tick);
            }
            intervalHistory.push(impliedInterval);
        } else {
            intervalHistory.push(normalizeInterval(
                gap,
                minBeatInterval,
                maxBeatInterval
            ));
        }

        if (intervalHistory.length > historySize) intervalHistory.shift();
        interpolated.push(next);
    }

    // An osu! red timing point continues indefinitely at its last BPM. Extend
    // that same behavior to the end of the loaded audio when its duration is known.
    if (endTime !== null && endTime > ticks.at(-1) && intervalHistory.length) {
        const previousInterval = median(intervalHistory);
        for (
            let tick = ticks.at(-1) + previousInterval;
            tick < endTime;
            tick += previousInterval
        ) {
            interpolated.push(tick);
        }
    }

    return interpolated;
}
