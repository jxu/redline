export const DEFAULT_BEAT_THRESHOLD = 0.5;

// Official minimal postprocessor: seven-frame max pool, strict threshold,
// adjacent plateau averages, and downbeats moved to their nearest beat.
export function pickBeatPeaks(
    probabilities,
    threshold = DEFAULT_BEAT_THRESHOLD,
) {
    const peaks = [];
    for (let i = 0; i < probabilities.length; i++) {
        if (probabilities[i] <= threshold) continue;
        let maximum = true;
        for (
            let j = Math.max(0, i - 3);
            j <= Math.min(probabilities.length - 1, i + 3);
            j++
        ) {
            if (probabilities[j] > probabilities[i]) {
                maximum = false;
                break;
            }
        }
        if (maximum) peaks.push(i);
    }
    const retained = [];
    let mean,
        count = 0;
    for (const frame of peaks) {
        if (count && frame - mean <= 1) {
            count++;
            mean += (frame - mean) / count;
        } else {
            if (count) retained.push(mean / 50);
            mean = frame;
            count = 1;
        }
    }
    if (count) retained.push(mean / 50);
    return retained;
}

export function beatsFromProbabilities(
    probabilities,
    { threshold = DEFAULT_BEAT_THRESHOLD, downbeatProbabilities } = {},
) {
    const ticks = pickBeatPeaks(probabilities, threshold);
    const downbeats = [
        ...new Set(
            pickBeatPeaks(downbeatProbabilities ?? [], threshold).map(
                (time) => {
                    if (!ticks.length) return time;
                    return ticks.reduce(
                        (nearest, beat) =>
                            Math.abs(beat - time) < Math.abs(nearest - time)
                                ? beat
                                : nearest,
                        ticks[0],
                    );
                },
            ),
        ),
    ].sort((a, b) => a - b);
    const confidence = ticks.length
        ? ticks.reduce(
              (sum, tick) => sum + probabilities[Math.round(tick * 50)],
              0,
          ) / ticks.length
        : 0;
    return {
        ticks,
        downbeats,
        confidence,
        probabilities,
        downbeatProbabilities,
        probabilityFrameMs: 20,
    };
}
