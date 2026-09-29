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

export function parseOsuHitObjectSpan(osuText) {
    const lines = osuText.replaceAll("\r", "").split("\n");
    const sectionStart = lines.findIndex((line) => line.trim() === "[HitObjects]");
    if (sectionStart === -1) throw new Error("The .osu file has no [HitObjects] section");

    const timingStart = lines.findIndex((line) => line.trim() === "[TimingPoints]");
    const timingLines = [];
    if (timingStart !== -1) {
        for (const line of lines.slice(timingStart + 1)) {
            if (line.trim().startsWith("[")) break;
            timingLines.push(line);
        }
    }
    const sliderTiming = timingLines.map((line) => line.split(","))
        .filter((fields) => fields.length >= 7)
        .map((fields) => ({
            offsetMs: Number(fields[0]),
            beatLengthMs: Number(fields[1]),
            uninherited: fields[6] === "1",
        }))
        .filter(({ offsetMs, beatLengthMs }) =>
            Number.isFinite(offsetMs) && Number.isFinite(beatLengthMs)
        ).sort((left, right) => left.offsetMs - right.offsetMs);
    const multiplierLine = lines.find((line) => line.startsWith("SliderMultiplier:"));
    const sliderMultiplier = multiplierLine
        ? Number(multiplierLine.split(":", 2)[1].trim()) : NaN;

    let firstMs = Infinity;
    let lastMs = -Infinity;
    for (const rawLine of lines.slice(sectionStart + 1)) {
        const line = rawLine.trim();
        if (line.startsWith("[")) break;
        if (!line || line.startsWith("//")) continue;
        const fields = line.split(",");
        const time = fields[2]?.trim();
        if (!/^\d+$/.test(time ?? "")) continue;
        const timeMs = Number(time);
        firstMs = Math.min(firstMs, timeMs);
        let endMs = timeMs;
        const type = Number(fields[3]);
        if (type & 8 || type & 128) {
            const objectEnd = Number(fields[5]?.split(":", 1)[0]);
            if (Number.isFinite(objectEnd) && objectEnd >= timeMs) endMs = objectEnd;
        } else if (type & 2) {
            const repeatCount = Number(fields[6]);
            const pixelLength = Number(fields[7]);
            let beatLengthMs = NaN;
            let velocity = 1;
            for (const point of sliderTiming) {
                if (point.offsetMs > timeMs) break;
                if (point.uninherited) {
                    beatLengthMs = point.beatLengthMs;
                    velocity = 1;
                } else if (point.beatLengthMs < 0) {
                    velocity = -100 / point.beatLengthMs;
                }
            }
            if (!(beatLengthMs > 0 && velocity > 0 && sliderMultiplier > 0 &&
                repeatCount > 0 && pixelLength >= 0)) {
                throw new Error(`Cannot determine slider end at ${timeMs} ms`);
            }
            endMs += repeatCount * pixelLength * beatLengthMs /
                (100 * sliderMultiplier * velocity);
        }
        lastMs = Math.max(lastMs, endMs);
    }
    if (!Number.isFinite(firstMs)) throw new Error("The .osu file has no valid hit objects");
    return { firstMs, lastMs };
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
