function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function localIntervals(beatsMs, durationMs) {
    const blockMs = 10000;
    const blocks = [];
    for (let start = 0; start < durationMs; start += blockMs) {
        const beats = beatsMs.filter((beat) => beat >= start && beat < start + blockMs);
        const intervals = beats.slice(1).map((beat, index) => beat - beats[index])
            .filter((gap) => gap >= 180 && gap <= 650);
        if (intervals.length < 4) {
            blocks.push(null);
            continue;
        }
        const approximate = median(intervals);
        const longIntervals = [];
        for (let first = 0; first < beats.length; first++) {
            for (let last = first + 1; last < beats.length; last++) {
                const gap = beats[last] - beats[first];
                if (gap < 2000 || gap > 6000) continue;
                const count = Math.round(gap / approximate);
                const period = gap / count;
                if (Math.abs(period / approximate - 1) < 0.12) longIntervals.push(period);
            }
        }
        blocks.push(longIntervals.length >= 10 ? median(longIntervals) : approximate);
    }
    return blocks;
}

function stableBoundaries(blocks) {
    const first = blocks.find((value) => value !== null);
    if (first === undefined) return [];
    const boundaries = [0];
    let sectionIntervals = [first];
    let pending = [];
    let pendingStart = 0;
    for (let index = 0; index < blocks.length; index++) {
        const interval = blocks[index];
        if (interval === null) continue;
        const current = median(sectionIntervals);
        if (Math.abs(interval / current - 1) <= 0.03) {
            sectionIntervals.push(interval);
            pending = [];
        } else if (!pending.length || Math.abs(interval / median(pending) - 1) > 0.035) {
            pending = [interval];
            pendingStart = index;
        } else {
            pending.push(interval);
            if (pending.length >= 2) {
                boundaries.push(pendingStart * 10000);
                sectionIntervals = [...pending];
                pending = [];
            }
        }
    }
    return boundaries;
}

function fitPeriodicGrid(beatsMs, startMs, endMs) {
    const observed = beatsMs.filter((beat) => beat >= startMs && beat < endMs);
    const intervals = observed.slice(1).map((beat, index) => beat - observed[index])
        .filter((gap) => gap >= 180 && gap <= 650);
    if (observed.length < 8 || intervals.length < 5) return null;
    const typical = median(intervals);
    let best = null;
    for (let period = typical * 0.87; period <= typical * 1.13; period += 0.1) {
        const bins = Math.max(10, Math.round(period / 5));
        const histogram = new Int32Array(bins);
        for (const beat of observed) {
            const phase = ((beat % period) + period) % period;
            histogram[Math.floor(phase * bins / period) % bins]++;
        }
        for (let center = 0; center < bins; center++) {
            let count = 0;
            for (let offset = -4; offset <= 4; offset++) {
                count += histogram[(center + offset + bins) % bins];
            }
            if (!best || count > best.count) {
                best = { count, period, phase: (center + 0.5) * period / bins };
            }
        }
    }
    let { period, phase } = best;
    for (let pass = 0; pass < 4; pass++) {
        let count = 0;
        let sumIndex = 0;
        let sumTime = 0;
        let sumIndexSquared = 0;
        let sumIndexTime = 0;
        for (const beat of observed) {
            const index = Math.round((beat - phase) / period);
            if (Math.abs(beat - phase - index * period) > 25) continue;
            count++;
            sumIndex += index;
            sumTime += beat;
            sumIndexSquared += index * index;
            sumIndexTime += index * beat;
        }
        if (count < 8) break;
        const denominator = count * sumIndexSquared - sumIndex * sumIndex;
        if (!denominator) break;
        const nextPeriod = (count * sumIndexTime - sumIndex * sumTime) / denominator;
        if (nextPeriod < typical * 0.85 || nextPeriod > typical * 1.15) break;
        period = nextPeriod;
        phase = (sumTime - period * sumIndex) / count;
    }
    return { period, phase };
}

function gridSupport(points, observedBeatsMs, durationMs, startMs = 0, endMs = durationMs) {
    const grid = [];
    for (let section = 0; section < points.length; section++) {
        const { offsetMs, beatLengthMs } = points[section];
        const end = Math.min(points[section + 1]?.offsetMs ?? durationMs, durationMs);
        for (let index = 0; offsetMs + index * beatLengthMs < end; index++) {
            const beat = offsetMs + index * beatLengthMs;
            if (beat >= startMs && beat < endMs) grid.push(beat);
        }
    }
    const observed = observedBeatsMs.filter((beat) => beat >= startMs && beat < endMs);
    let matched = 0;
    let left = 0;
    let right = 0;
    while (left < grid.length && right < observed.length) {
        const error = grid[left] - observed[right];
        if (Math.abs(error) <= 30) {
            matched++;
            left++;
            right++;
        } else if (error < 0) left++;
        else right++;
    }
    return 2 * matched / (grid.length + observed.length);
}

export function chooseStableSections(observedTicks, existingPoints, durationMs) {
    if (observedTicks.length < 32 || existingPoints.length < 2) return null;
    const beatsMs = observedTicks.map((tick) => tick * 1000);
    const boundaries = stableBoundaries(localIntervals(beatsMs, durationMs));
    if (!boundaries.length || boundaries.length * 2 >= existingPoints.length) return null;
    const points = [];
    for (let index = 0; index < boundaries.length; index++) {
        const start = boundaries[index];
        const end = boundaries[index + 1] ?? durationMs;
        const fitted = fitPeriodicGrid(beatsMs, start, end);
        if (!fitted) return null;
        const firstIndex = Math.ceil((start - fitted.phase) / fitted.period);
        const offsetMs = Math.round(fitted.phase + firstIndex * fitted.period);
        if (points.length && offsetMs <= points.at(-1).offsetMs) return null;
        points.push({ offsetMs, beatLengthMs: Number(fitted.period.toFixed(5)) });
    }
    const existingSupport = gridSupport(existingPoints, beatsMs, durationMs);
    const stableSupport = gridSupport(points, beatsMs, durationMs);
    if (stableSupport < existingSupport - 0.05) return null;
    for (let start = 0; start < durationMs; start += 20000) {
        const end = Math.min(durationMs, start + 20000);
        if (beatsMs.filter((beat) => beat >= start && beat < end).length < 8) continue;
        if (gridSupport(points, beatsMs, durationMs, start, end) <
            gridSupport(existingPoints, beatsMs, durationMs, start, end) - 0.15) return null;
    }
    return points;
}
