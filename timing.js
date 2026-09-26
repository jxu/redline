export const DEFAULT_TIMING_OPTIONS = Object.freeze({
    toleranceMs: 5,
    windowSize: 4,
});

function mean(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Centered moving average; the window shrinks near either end.
function movingAverage(values, windowSize) {
    const half = Math.floor((windowSize - 1) / 2);
    return values.map((_, index) =>
        mean(values.slice(Math.max(0, index - half), index - half + windowSize))
    );
}

// Replace each maximal run whose spread stays within tolerance with its mean.
function averageSteadyRuns(values, tolerance) {
    const result = values.slice();

    let start = 0;
    while (start < values.length) {
        let end = start;
        let min = values[start];
        let max = values[start];

        while (end + 1 < values.length) {
            const nextMin = Math.min(min, values[end + 1]);
            const nextMax = Math.max(max, values[end + 1]);
            if (nextMax - nextMin > tolerance) break;
            min = nextMin;
            max = nextMax;
            end++;
        }

        const average = mean(values.slice(start, end + 1));
        for (let index = start; index <= end; index++) result[index] = average;

        start = end + 1;
    }

    return result;
}

function beatLengthsMs(ticks, toleranceMs, windowSize) {
    const intervals = ticks
        .slice(0, -1)
        .map((tick, index) => (ticks[index + 1] - tick) * 1000);
    const smoothed = movingAverage(intervals, windowSize);
    return averageSteadyRuns(smoothed, toleranceMs).map((ms) => ms.toFixed(2));
}

function generateOsuTimingPoints(ticks, beatLengths) {
    const lines = beatLengths
        .map((beatLength, index) => ({
            timeMs: Math.round(ticks[index] * 1000),
            beatLength,
        }))
        .filter((point, index) => index === 0 || point.beatLength !== beatLengths[index - 1])
        .map((point) => `${point.timeMs},${point.beatLength},4,2,0,100,1,0`);

    return `[TimingPoints]\n${lines.join("\n")}`;
}

function averageBpm(ticks) {
    if (ticks.length < 2) return 0;
    const secondsPerBeat = (ticks[ticks.length - 1] - ticks[0]) / (ticks.length - 1);
    return 60 / secondsPerBeat;
}

export function calculateTiming(ticks, options = {}) {
    const {
        toleranceMs = DEFAULT_TIMING_OPTIONS.toleranceMs,
        windowSize = DEFAULT_TIMING_OPTIONS.windowSize,
    } = options;
    const beatLengths = beatLengthsMs(ticks, toleranceMs, windowSize);

    return {
        averageBpm: averageBpm(ticks),
        beatLengths,
        rawBpmSeries: ticks.slice(0, -1).map((time, index) => ({
            x: time,
            y: 60 / (ticks[index + 1] - time),
        })),
        smoothedBpmSeries: ticks.slice(0, -1).map((time, index) => ({
            x: time,
            y: 60000 / Number(beatLengths[index]),
        })),
        osuTimingPoints: generateOsuTimingPoints(ticks, beatLengths),
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
