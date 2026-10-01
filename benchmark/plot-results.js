import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const COLORS = Object.freeze({
    raw: "#277fbd",
    interpolated: "#f28e2b",
    filtered: "#9467bd",
    scaled: "#2a9d8f",
    reference: "#333333",
    error: "#d62728",
});

function escapeXml(value) {
    return String(value).replace(/[<>&"']/g, (character) => ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
    })[character]);
}

function nearestIndex(sortedValues, target) {
    let low = 0;
    let high = sortedValues.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (sortedValues[middle] < target) low = middle + 1;
        else high = middle;
    }
    if (low === 0) return 0;
    if (low === sortedValues.length) return sortedValues.length - 1;
    return target - sortedValues[low - 1] <= sortedValues[low] - target
        ? low - 1
        : low;
}

function containsBeat(sortedValues, target) {
    if (!sortedValues.length) return false;
    return Math.abs(sortedValues[nearestIndex(sortedValues, target)] - target) < 1e-5;
}

function classifyBeat(result, beatMs) {
    if (result.evaluationGrid === "exported-timing-points") return "scaled";
    if (containsBeat(result.rawDetectedBeatsMs, beatMs)) return "raw";
    if (containsBeat(result.interpolatedDetectedBeatsMs, beatMs)) return "interpolated";
    return "scaled";
}

export function matchResultBeats(result) {
    const toleranceMs = selectedCandidate(result).matchingToleranceMs;
    const detected = result.detectedBeatsMs;
    const reference = result.referenceBeatsMs;
    const matched = [];
    const extra = [];
    const missing = [];
    let detectedIndex = 0;
    let referenceIndex = 0;

    while (detectedIndex < detected.length && referenceIndex < reference.length) {
        const errorMs = detected[detectedIndex] - reference[referenceIndex];
        if (Math.abs(errorMs) <= toleranceMs) {
            matched.push({
                detectedMs: detected[detectedIndex],
                referenceMs: reference[referenceIndex],
                errorMs,
                source: classifyBeat(result, detected[detectedIndex]),
            });
            detectedIndex++;
            referenceIndex++;
        } else if (errorMs < 0) {
            extra.push(detected[detectedIndex++]);
        } else {
            missing.push(reference[referenceIndex++]);
        }
    }

    extra.push(...detected.slice(detectedIndex));
    missing.push(...reference.slice(referenceIndex));
    return { matched, extra, missing };
}

function selectedCandidate(result) {
    return result.tempoScaleCandidates.find((candidate) =>
        candidate.tempoScale === result.selectedTempoScale &&
        candidate.phase === result.selectedTempoPhase
    ) ?? result.tempoScaleCandidates[0];
}

function niceStep(range, targetTicks) {
    const rough = range / targetTicks;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const normalized = rough / magnitude;
    const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    return factor * magnitude;
}

function visibleTempoPoints(points, startMs, endMs) {
    const valid = points.filter(({ offsetMs, beatLengthMs }) =>
        Number.isFinite(offsetMs) && Number.isFinite(beatLengthMs) && beatLengthMs > 0
    );
    const preceding = valid.filter(({ offsetMs }) => offsetMs <= startMs).at(-1);
    const visible = valid.filter(({ offsetMs }) => offsetMs > startMs && offsetMs < endMs);
    return [
        ...(preceding ? [{ offsetMs: startMs, bpm: 60000 / preceding.beatLengthMs }] : []),
        ...visible.map(({ offsetMs, beatLengthMs }) => ({ offsetMs, bpm: 60000 / beatLengthMs })),
    ];
}

function bpmStepPath(points, endMs, x, y) {
    if (!points.length) return "";
    const [first, ...rest] = points;
    let path = `M ${x(first.offsetMs)} ${y(first.bpm)}`;
    for (const point of rest) {
        path += ` H ${x(point.offsetMs)} V ${y(point.bpm)}`;
    }
    return `${path} H ${x(endMs)}`;
}

function marker(x, y, source) {
    if (source === "interpolated") {
        return `<path d="M ${x} ${y - 5} L ${x + 5} ${y} L ${x} ${y + 5} L ${x - 5} ${y} Z" fill="${COLORS.interpolated}"/>`;
    }
    if (source === "scaled") {
        return `<path d="M ${x} ${y - 6} L ${x + 5} ${y + 4} L ${x - 5} ${y + 4} Z" fill="${COLORS.scaled}"/>`;
    }
    return `<circle cx="${x}" cy="${y}" r="3" fill="${COLORS.raw}" fill-opacity="0.8"/>`;
}

function cross(x, y, size = 5) {
    return `<path d="M ${x - size} ${y - size} L ${x + size} ${y + size} M ${x - size} ${y + size} L ${x + size} ${y - size}" stroke="${COLORS.error}" stroke-width="2.2"/>`;
}

function missingMarker(x, referenceY) {
    return `<path d="M ${x - 5} ${referenceY - 27} L ${x + 5} ${referenceY - 27} L ${x} ${referenceY - 18} Z" fill="${COLORS.error}"/>`;
}

export function renderResultPlot(result) {
    const isExportGrid = result.evaluationGrid === "exported-timing-points";
    const detectorLabel = result.detector?.startsWith("beat-this-") ? "Beat This!" : "SENet";
    const width = 1600;
    const bpmTop = isExportGrid ? 925 : 855;
    const bpmBottom = bpmTop + 230;
    const height = bpmBottom + 85;
    const rasterBottom = isExportGrid ? 850 : 780;
    const left = 105;
    const right = 35;
    const plotTop = 105;
    const plotBottom = 585;
    const plotWidth = width - left - right;
    const plotHeight = plotBottom - plotTop;
    const rasterRows = { reference: 690, senet: 760 };
    const startMs = result.evaluationStartMs;
    const endMs = result.evaluationEndMs;
    const durationMs = endMs - startMs;
    const candidate = selectedCandidate(result);
    const toleranceMs = candidate.matchingToleranceMs;
    const alignment = matchResultBeats(result);
    const allErrors = result.nearestReferenceErrorsMs;
    const maxAbsoluteError = Math.max(toleranceMs, 20, ...allErrors.map(Math.abs));
    const yLimit = Math.max(100, Math.ceil(maxAbsoluteError / 50) * 50);
    const x = (timeMs) => left + (timeMs - startMs) / durationMs * plotWidth;
    const y = (errorMs) => plotTop + (yLimit - errorMs) / (2 * yLimit) * plotHeight;
    const referenceBpm = visibleTempoPoints(result.timingPoints ?? [], startMs, endMs);
    const exportedBpm = visibleTempoPoints(result.exportedTimingPoints ?? [], startMs, endMs);
    const bpmValues = [...referenceBpm, ...exportedBpm].map(({ bpm }) => bpm);
    const rawBpmMin = bpmValues.length ? Math.min(...bpmValues) : 60;
    const rawBpmMax = bpmValues.length ? Math.max(...bpmValues) : 180;
    const bpmRange = Math.max(10, rawBpmMax - rawBpmMin);
    const bpmStep = niceStep(bpmRange * 1.2, 6);
    const bpmMin = Math.max(0, Math.floor((rawBpmMin - bpmRange * 0.1) / bpmStep) * bpmStep);
    const bpmMax = Math.ceil((rawBpmMax + bpmRange * 0.1) / bpmStep) * bpmStep;
    const bpmY = (bpm) => bpmBottom - (bpm - bpmMin) / (bpmMax - bpmMin) * (bpmBottom - bpmTop);
    const retainedBeats = result.filteredDetectedBeatsMs ?? result.rawDetectedBeatsMs;
    const addedInterpolated = result.interpolatedDetectedBeatsMs.filter(
        (beatMs) => !containsBeat(retainedBeats, beatMs)
    );
    const filteredBeats = result.rawDetectedBeatsMs.filter(
        (beatMs) => !containsBeat(retainedBeats, beatMs)
    );
    const inside = (beatMs) => beatMs >= startMs && beatMs < endMs;

    const svg = [];
    svg.push(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
        `<title>${escapeXml(result.name)} beat alignment</title>`,
        `<desc>Benchmark residuals, beat positions, and reference versus exported BPM for mapset ${escapeXml(result.mapsetId)}</desc>`,
        `<rect width="100%" height="100%" fill="white"/>`,
        `<style>text{font-family:system-ui,sans-serif;fill:#2b2b2b}.grid{stroke:#d0d0d0;stroke-width:1}.axis{stroke:#555;stroke-width:1}.tick{font-size:16px}.legend{font-size:15px}</style>`,
        `<defs><clipPath id="plot"><rect x="${left}" y="${plotTop}" width="${plotWidth}" height="${plotHeight}"/></clipPath><clipPath id="bpm-plot"><rect x="${left}" y="${bpmTop}" width="${plotWidth}" height="${bpmBottom - bpmTop}"/></clipPath></defs>`,
        `<text x="${width / 2}" y="34" text-anchor="middle" font-size="24">${escapeXml(result.name)}</text>`,
        `<text x="${width / 2}" y="63" text-anchor="middle" font-size="22">${isExportGrid ? "Exported grid" : "Beat alignment"} residuals</text>`,
        `<rect x="${left}" y="${y(20)}" width="${plotWidth}" height="${y(-20) - y(20)}" fill="#2ca02c" fill-opacity="0.09"/>`,
    );

    const yStep = niceStep(2 * yLimit, 8);
    for (let value = -yLimit; value <= yLimit; value += yStep) {
        svg.push(
            `<line class="grid" x1="${left}" y1="${y(value)}" x2="${width - right}" y2="${y(value)}"/>`,
            `<text class="tick" x="${left - 12}" y="${y(value) + 6}" text-anchor="end">${value}</text>`,
        );
    }

    const xStepMs = niceStep(durationMs, 10);
    const firstXTick = Math.ceil(startMs / xStepMs) * xStepMs;
    for (let value = firstXTick; value < endMs; value += xStepMs) {
        svg.push(
            `<line class="grid" x1="${x(value)}" y1="${plotTop}" x2="${x(value)}" y2="${bpmBottom}"/>`,
            `<text class="tick" x="${x(value)}" y="${height - 40}" text-anchor="middle">${value / 1000}</text>`,
        );
    }

    svg.push(
        `<line x1="${left}" y1="${y(0)}" x2="${width - right}" y2="${y(0)}" stroke="#444"/>`,
        `<line x1="${left}" y1="${y(toleranceMs)}" x2="${width - right}" y2="${y(toleranceMs)}" stroke="#999" stroke-dasharray="6 4"/>`,
        `<line x1="${left}" y1="${y(-toleranceMs)}" x2="${width - right}" y2="${y(-toleranceMs)}" stroke="#999" stroke-dasharray="6 4"/>`,
        `<rect x="${left}" y="${plotTop}" width="${plotWidth}" height="${plotHeight}" fill="none" class="axis"/>`,
        `<text x="25" y="${(plotTop + plotBottom) / 2}" text-anchor="middle" font-size="18" transform="rotate(-90 25 ${(plotTop + plotBottom) / 2})">${isExportGrid ? "Exported" : "Detected"} − reference (ms)</text>`,
        `<text x="${left + 12}" y="${plotTop + 25}" font-size="17">weighted F1 ${candidate.weightedF1.toFixed(3)}  |  F1@${toleranceMs}ms ${candidate.matchingF1.toFixed(3)}  |  median |error| ${result.metrics.medianAbsoluteErrorMs.toFixed(1)} ms  |  ${alignment.matched.length} matched, ${alignment.extra.length} extra, ${alignment.missing.length} missing  |  ${result.filteredBeatCount ?? 0} filtered</text>`,
        `<g clip-path="url(#plot)">`,
    );

    for (const beat of alignment.matched) {
        svg.push(marker(x(beat.referenceMs), y(beat.errorMs), beat.source));
    }
    for (const beatMs of alignment.extra) {
        const nearestReferenceMs = result.referenceBeatsMs[
            nearestIndex(result.referenceBeatsMs, beatMs)
        ];
        svg.push(cross(x(beatMs), y(beatMs - nearestReferenceMs)));
    }
    svg.push(`</g>`);

    const legend = isExportGrid ? [
        [COLORS.scaled, "triangle", "matched exported beat"],
        [COLORS.error, "cross", "extra exported beat"],
    ] : [
        [COLORS.raw, "circle", `matched ${detectorLabel} peak`],
        [COLORS.interpolated, "diamond", "matched interpolated beat"],
        [COLORS.scaled, "triangle", "matched tempo-scaled beat"],
        [COLORS.error, "cross", "extra detection"],
    ];
    legend.forEach(([color, shape, label], index) => {
        const legendX = width - 300;
        const legendY = 90 + index * 24;
        if (shape === "circle") svg.push(`<circle cx="${legendX}" cy="${legendY}" r="4" fill="${color}"/>`);
        if (shape === "diamond") svg.push(`<path d="M ${legendX} ${legendY - 5} L ${legendX + 5} ${legendY} L ${legendX} ${legendY + 5} L ${legendX - 5} ${legendY} Z" fill="${color}"/>`);
        if (shape === "triangle") svg.push(`<path d="M ${legendX} ${legendY - 5} L ${legendX + 5} ${legendY + 4} L ${legendX - 5} ${legendY + 4} Z" fill="${color}"/>`);
        if (shape === "cross") svg.push(cross(legendX, legendY, 4));
        svg.push(`<text class="legend" x="${legendX + 13}" y="${legendY + 5}">${label}</text>`);
    });

    svg.push(
        `<line x1="${left + 10}" y1="615" x2="${left + 32}" y2="615" stroke="${COLORS.raw}" stroke-width="3"/><text class="legend" x="${left + 40}" y="620">retained ${detectorLabel} peak</text>`,
        `<line x1="${left + 215}" y1="615" x2="${left + 237}" y2="615" stroke="${COLORS.interpolated}" stroke-width="3"/><text class="legend" x="${left + 245}" y="620">interpolated beat</text>`,
        `<line x1="${left + 395}" y1="615" x2="${left + 417}" y2="615" stroke="${COLORS.filtered}" stroke-width="3" stroke-opacity="0.5" stroke-dasharray="4 3"/><text class="legend" x="${left + 425}" y="620">filtered-out peak</text>`,
        `${missingMarker(left + 590, 642)}<text class="legend" x="${left + 602}" y="620">missing reference beat</text>`,
        `<rect x="${left}" y="640" width="${plotWidth}" height="${rasterBottom - 640}" fill="none" class="axis"/>`,
        `<text x="${left - 12}" y="${rasterRows.reference + 6}" text-anchor="end" font-size="17">reference</text>`,
        `<text x="${left - 12}" y="${rasterRows.senet + 6}" text-anchor="end" font-size="17">${detectorLabel}</text>`,
    );

    for (const beatMs of result.referenceBeatsMs) {
        svg.push(`<line x1="${x(beatMs)}" y1="${rasterRows.reference - 16}" x2="${x(beatMs)}" y2="${rasterRows.reference + 16}" stroke="${COLORS.reference}"/>`);
    }
    for (const beatMs of retainedBeats.filter(inside)) {
        svg.push(`<line x1="${x(beatMs)}" y1="${rasterRows.senet - 16}" x2="${x(beatMs)}" y2="${rasterRows.senet + 16}" stroke="${COLORS.raw}"/>`);
    }
    for (const beatMs of addedInterpolated.filter(inside)) {
        svg.push(`<line x1="${x(beatMs)}" y1="${rasterRows.senet - 16}" x2="${x(beatMs)}" y2="${rasterRows.senet + 16}" stroke="${COLORS.interpolated}" stroke-width="2"/>`);
    }
    for (const beatMs of filteredBeats.filter(inside)) {
        svg.push(`<line x1="${x(beatMs)}" y1="${rasterRows.senet - 16}" x2="${x(beatMs)}" y2="${rasterRows.senet + 16}" stroke="${COLORS.filtered}" stroke-width="2" stroke-opacity="0.5" stroke-dasharray="4 3"/>`);
    }
    for (const beatMs of alignment.missing) {
        svg.push(missingMarker(x(beatMs), rasterRows.reference));
    }

    if (isExportGrid) {
        svg.push(`<text x="${left - 12}" y="836" text-anchor="end" font-size="17">export</text>`);
        for (const beatMs of result.detectedBeatsMs) {
            svg.push(`<line x1="${x(beatMs)}" y1="814" x2="${x(beatMs)}" y2="846" stroke="${COLORS.scaled}"/>`);
        }
    }

    svg.push(
        `<text x="${left}" y="${bpmTop - 30}" font-size="18">Tempo from red timing points</text>`,
        `<line x1="${width - 385}" y1="${bpmTop - 36}" x2="${width - 355}" y2="${bpmTop - 36}" stroke="${COLORS.reference}" stroke-width="2.5"/><text class="legend" x="${width - 347}" y="${bpmTop - 30}">reference BPM</text>`,
        `<line x1="${width - 210}" y1="${bpmTop - 36}" x2="${width - 180}" y2="${bpmTop - 36}" stroke="${COLORS.scaled}" stroke-width="2.5"/><text class="legend" x="${width - 172}" y="${bpmTop - 30}">exported BPM</text>`,
    );
    for (let value = bpmMin; value <= bpmMax + bpmStep * 1e-6; value += bpmStep) {
        svg.push(
            `<line class="grid" x1="${left}" y1="${bpmY(value)}" x2="${width - right}" y2="${bpmY(value)}"/>`,
            `<text class="tick" x="${left - 12}" y="${bpmY(value) + 6}" text-anchor="end">${Number(value.toFixed(1))}</text>`,
        );
    }
    svg.push(
        `<rect x="${left}" y="${bpmTop}" width="${plotWidth}" height="${bpmBottom - bpmTop}" fill="none" class="axis"/>`,
        `<text x="25" y="${(bpmTop + bpmBottom) / 2}" text-anchor="middle" font-size="18" transform="rotate(-90 25 ${(bpmTop + bpmBottom) / 2})">BPM</text>`,
        `<g clip-path="url(#bpm-plot)">`,
        `<path class="bpm-reference" d="${bpmStepPath(referenceBpm, endMs, x, bpmY)}" fill="none" stroke="${COLORS.reference}" stroke-width="2.5" stroke-linejoin="round"/>`,
        `<path class="bpm-export" d="${bpmStepPath(exportedBpm, endMs, x, bpmY)}" fill="none" stroke="${COLORS.scaled}" stroke-width="2.5" stroke-linejoin="round"/>`,
        `</g>`,
    );

    svg.push(
        `<text x="${width / 2}" y="${height - 12}" text-anchor="middle" font-size="18">Song time (seconds)</text>`,
        `</svg>`,
    );
    return `${svg.join("\n")}\n`;
}

export async function writeResultPlot(result, benchmarkDirectory) {
    const outputDirectory = resolve(benchmarkDirectory, "plots");
    const outputPath = resolve(outputDirectory, `${result.mapsetId}-beat-alignment.svg`);
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(outputPath, renderResultPlot(result));
    return outputPath;
}

async function runCli() {
    const benchmarkDirectory = dirname(fileURLToPath(import.meta.url));
    const args = process.argv.slice(2);
    const resultsDirectoryIndex = args.indexOf("--results-dir");
    const resultsDirectory = resultsDirectoryIndex < 0
        ? resolve(benchmarkDirectory, "beat-this-small")
        : resolve(benchmarkDirectory, args[resultsDirectoryIndex + 1]);
    if (resultsDirectoryIndex >= 0) args.splice(resultsDirectoryIndex, 2);
    const requestedId = args[0];
    if (args.length > 1) throw new Error("Specify at most one mapset ID");
    const resultNames = requestedId
        ? [`${requestedId}.json`]
        : (await readdir(resolve(resultsDirectory, "results")))
            .filter((name) => name.endsWith(".json"))
            .sort();

    for (const resultName of resultNames) {
        const result = JSON.parse(await readFile(
            resolve(resultsDirectory, "results", resultName),
            "utf8"
        ));
        console.log(await writeResultPlot(result, resultsDirectory));
    }
}

const isCli = process.argv[1] &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) await runCli();
