export const OCTAVE_JUMP_TOLERANCE = 0.08;
const MIN_BEAT_LENGTH_MS = 200;

function octaveCorrection(length, neighbor) {
    const power = Math.round(Math.log2(length / neighbor));
    const corrected = length / 2 ** power;
    return power !== 0 && Math.abs(corrected / neighbor - 1) <= OCTAVE_JUMP_TOLERANCE
        ? corrected : null;
}

export function isOctaveJump(previousLength, length) {
    return previousLength > 0 && length > 0 &&
        octaveCorrection(length, previousLength) !== null;
}

function ticksInSection(ticks, startMs, endMs) {
    return ticks.map((tick) => tick * 1000)
        .filter((time) => time >= startMs && time < endMs);
}

function phaseSupport(observations, offsetMs, periodMs) {
    if (observations.length < 4) return 0;
    const matches = observations.filter((time) => Math.abs(time - offsetMs -
        Math.round((time - offsetMs) / periodMs) * periodMs) <= 30);
    return matches.length / observations.length;
}

function phaseEvidence(probabilities, frameMs, offsetMs, periodMs, endMs) {
    if (!probabilities?.length) return 0;
    let sum = 0;
    let count = 0;
    for (let time = offsetMs; time < endMs; time += periodMs) {
        sum += probabilities[Math.round(time / frameMs)] ?? 0;
        count++;
    }
    return count ? sum / count : 0;
}

// Establish the pulse from the longest section, then preserve local drift and
// genuine non-octave section changes while walking outward in both directions.
export function constrainOctaveJumps(points, durationMs, {
    observedTicks = [], downbeatTicks = [], probabilities = null, probabilityFrameMs = 10,
} = {}) {
    if (points.length < 2) return points;
    const corrected = points.map((point) => ({ ...point }));
    const durations = points.map((point, index) =>
        Math.max(0, Math.min(points[index + 1]?.offsetMs ?? durationMs, durationMs) - point.offsetMs));
    const center = durations.indexOf(Math.max(...durations));
    const follow = (index, neighbor) => {
        const length = octaveCorrection(corrected[index].beatLengthMs,
            corrected[neighbor].beatLengthMs);
        if (length === null) return;
        if (length < MIN_BEAT_LENGTH_MS) {
            // Prefer a legal slower pulse to introducing a jump at the BPM cap.
            corrected[neighbor].beatLengthMs *= 2;
            return;
        }
        corrected[index].beatLengthMs = length;
    };
    // A cap correction can move the anchor to its slower octave. Revisit its
    // neighbors so that this exception cannot introduce another octave jump.
    for (let pass = 0; pass <= points.length; pass++) {
        for (let index = center + 1; index < points.length; index++) follow(index, index - 1);
        for (let index = center - 1; index >= 0; index--) follow(index, index + 1);
        if (!corrected.slice(1).some((point, index) =>
            isOctaveJump(corrected[index].beatLengthMs, point.beatLengthMs))) break;
    }

    return corrected.map((point, index) => {
        const original = points[index];
        if (point.beatLengthMs !== original.beatLengthMs && "bpm" in point) {
            point.bpm = 60000 / point.beatLengthMs;
        }
        if (point.beatLengthMs <= original.beatLengthMs) return point;
        const end = points[index + 1]?.offsetMs ?? durationMs;
        const shifted = point.offsetMs + original.beatLengthMs;
        if (shifted >= end) return point;
        // Halving has two alternating phases. Use downbeats when available,
        // otherwise retained peaks; probabilities break dense-peak ties.
        const downbeats = ticksInSection(downbeatTicks, point.offsetMs, end);
        const observations = downbeats.length >= 4 ? downbeats
            : ticksInSection(observedTicks, point.offsetMs, end);
        const gain = phaseSupport(observations, shifted, point.beatLengthMs) -
            phaseSupport(observations, point.offsetMs, point.beatLengthMs);
        if (gain > 0.2 || (Math.abs(gain) <= 0.05 &&
            phaseEvidence(probabilities, probabilityFrameMs, shifted, point.beatLengthMs, end) >
            phaseEvidence(probabilities, probabilityFrameMs, point.offsetMs, point.beatLengthMs, end) + 0.1)) {
            point.offsetMs = shifted;
        }
        return point;
    });
}
