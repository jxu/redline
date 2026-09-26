export function parseOsuTimingPoints(osuText) {
    const lines = osuText.replaceAll("\r", "").split("\n");
    const sectionStart = lines.findIndex((line) => line.trim() === "[TimingPoints]");
    if (sectionStart === -1) throw new Error("The .osu file has no [TimingPoints] section");

    const timingPoints = [];
    for (const rawLine of lines.slice(sectionStart + 1)) {
        const line = rawLine.trim();
        if (line.startsWith("[")) break;
        if (!line || line.startsWith("//")) continue;

        const fields = line.split(",");
        if (fields.length < 8) continue;

        const offsetMs = Number(fields[0]);
        const beatLengthMs = Number(fields[1]);
        const uninherited = fields[6] === "1";
        if (!uninherited || !Number.isFinite(offsetMs) || beatLengthMs <= 0) continue;

        timingPoints.push({
            offsetMs,
            beatLengthMs,
            bpm: 60000 / beatLengthMs,
            meter: Number(fields[2]),
        });
    }

    return timingPoints.sort((a, b) => a.offsetMs - b.offsetMs);
}

export function generateBeatGrid(timingPoints, durationMs) {
    const beats = [];

    timingPoints.forEach((point, index) => {
        const nextOffset = timingPoints[index + 1]?.offsetMs ?? durationMs;
        const sectionEnd = Math.min(nextOffset, durationMs);

        for (
            let beatIndex = 0;
            point.offsetMs + beatIndex * point.beatLengthMs < sectionEnd;
            beatIndex++
        ) {
            beats.push(point.offsetMs + beatIndex * point.beatLengthMs);
        }
    });

    return beats;
}

export function nearestBeat(referenceBeats, timeMs) {
    if (!referenceBeats.length) return null;

    let low = 0;
    let high = referenceBeats.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (referenceBeats[middle] < timeMs) low = middle + 1;
        else high = middle;
    }

    const after = referenceBeats[Math.min(low, referenceBeats.length - 1)];
    const before = referenceBeats[Math.max(0, low - 1)];
    return Math.abs(timeMs - before) <= Math.abs(after - timeMs) ? before : after;
}
