const DEFAULT_OPTIONS = Object.freeze({
    historySize: 8,
    intervalTolerance: 0.15,
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

function normalizeInterval(interval, minInterval, maxInterval) {
    while (interval < minInterval) interval *= 2;
    while (interval > maxInterval) interval /= 2;
    return interval;
}

export function filterSpuriousBeats(ticks, options = {}) {
    if (ticks.length < 3) return [...ticks];

    const {
        historySize = DEFAULT_OPTIONS.historySize,
        intervalTolerance = DEFAULT_OPTIONS.intervalTolerance,
        minBeatInterval = DEFAULT_OPTIONS.minBeatInterval,
        maxBeatInterval = DEFAULT_OPTIONS.maxBeatInterval,
    } = options;
    const filtered = [ticks[0]];
    const intervalHistory = [];

    for (let index = 1; index < ticks.length; index++) {
        const previous = filtered.at(-1);
        const interval = ticks[index] - previous;
        const expectedInterval = intervalHistory.length
            ? median(intervalHistory)
            : null;
        const next = ticks[index + 1];

        // A peak faster than the supported tempo range is probably a
        // subdivision. Drop it only when the following peak restores the
        // recent tempo, so genuine accelerations remain untouched.
        if (expectedInterval !== null && next !== undefined && interval < minBeatInterval) {
            const intervalAfterSkipping = next - previous;
            const relativeError = Math.abs(intervalAfterSkipping - expectedInterval) /
                expectedInterval;
            if (relativeError <= intervalTolerance) continue;
        }

        filtered.push(ticks[index]);
        intervalHistory.push(normalizeInterval(
            interval,
            minBeatInterval,
            maxBeatInterval
        ));
        if (intervalHistory.length > historySize) intervalHistory.shift();
    }

    return filtered;
}
