import { calculateTiming, generateTimingGrid, generateOsuTimingPoints } from "./timing.js";

export const EXPORT_OFFSET_MS = -27;

// Fit native detections first; shift only the resulting export and playback grid.
export function calculateExportTiming(ticks, options = {}) {
    const timing = calculateTiming(ticks, options);
    const offsetMs = options.exportOffsetMs ?? EXPORT_OFFSET_MS;
    const timingPoints = timing.timingPoints.map(point => ({
        ...point, offsetMs: point.offsetMs + offsetMs,
    }));
    const durationMs = options.endTime === undefined
        ? (timing.gridTicks.at(-1) ?? 0) * 1000 + 1
        : options.endTime * 1000;
    return {
        ...timing,
        timingPoints,
        gridTicks: generateTimingGrid(timingPoints, durationMs),
        osuTimingPoints: generateOsuTimingPoints(timingPoints),
    };
}
