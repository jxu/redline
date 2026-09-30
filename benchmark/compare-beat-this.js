import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
const smallDirectory = new URL("./beat-this-small-offset-minus27ms/", import.meta.url);
const rows = [];
function selected(result) {
    return result.tempoScaleCandidates.find(({ tempoScale, phase }) =>
        tempoScale === result.selectedTempoScale && phase === result.selectedTempoPhase);
}
for (const entry of manifest) {
    const full = JSON.parse(await readFile(new URL(`./results/${entry.id}.json`, import.meta.url), "utf8"));
    const small = JSON.parse(await readFile(new URL(`./results/${entry.id}.json`, smallDirectory), "utf8"));
    for (const field of ["beatOffsetMs", "evaluationStartMs", "evaluationEndMs", "selectedTempoScale", "selectedTempoPhase", "beatThisVersion", "torchVersion"]) {
        if (full[field] !== small[field]) throw new Error(`${entry.id}: different ${field}`);
    }
    if (full.modelName !== "final0" || small.modelName !== "small0" ||
        JSON.stringify(full.timingOptions) !== JSON.stringify(small.timingOptions) ||
        JSON.stringify(full.referenceBeatsMs) !== JSON.stringify(small.referenceBeatsMs)) {
        throw new Error(`${entry.id}: incompatible model results or timing configuration`);
    }
    rows.push({
        mapsetId: entry.id, name: entry.name, tempoPattern: entry.tempoPattern,
        fullWeightedF1: selected(full).weightedF1, smallWeightedF1: selected(small).weightedF1,
        deltaWeightedF1: selected(small).weightedF1 - selected(full).weightedF1,
        fullF1At20Ms: selected(full).matchingF1, smallF1At20Ms: selected(small).matchingF1,
        fullTimingPoints: full.exportedTimingPoints.length, smallTimingPoints: small.exportedTimingPoints.length,
    });
}
function mean(values) { return values.reduce((a, b) => a + b, 0) / values.length; }
function median(values) {
    const sorted = values.toSorted((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function summarize(group) {
    return {
        count: group.length,
        fullMeanWeightedF1: mean(group.map(r => r.fullWeightedF1)),
        smallMeanWeightedF1: mean(group.map(r => r.smallWeightedF1)),
        fullMedianWeightedF1: median(group.map(r => r.fullWeightedF1)),
        smallMedianWeightedF1: median(group.map(r => r.smallWeightedF1)),
        fullMeanF1At20Ms: mean(group.map(r => r.fullF1At20Ms)),
        smallMeanF1At20Ms: mean(group.map(r => r.smallF1At20Ms)),
        smallWins: group.filter(r => r.deltaWeightedF1 > 0).length,
    };
}
const report = {
    beatOffsetMs: -27,
    groups: {
        all: summarize(rows),
        continuous: summarize(rows.filter(r => r.tempoPattern === "continuous")),
        sectionsWithoutHardkore: summarize(rows.filter(r => r.tempoPattern === "sections" && r.mapsetId !== "30485")),
        fixed: summarize(rows.filter(r => r.tempoPattern === "fixed")),
        beatlesAndWho: summarize(rows.filter(r => /^The (Beatles|Who) -/.test(r.name))),
    },
    rows,
};
await writeFile(new URL("./comparison.json", smallDirectory), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.groups, null, 2));
console.log(`Saved ${fileURLToPath(new URL("./comparison.json", smallDirectory))}`);
