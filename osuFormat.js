export function generateOsuTimingPoints(ticks) {
    const lines = ticks.slice(0, -1).map((tick, i) => {
        const timeMs = Math.round(tick * 1000);
        const beatLength = ((ticks[i + 1] - tick) * 1000).toFixed(2);

        return `${timeMs},${beatLength},4,2,0,100,1,0`;
    });

    return `[TimingPoints]\n${lines.join("\n")}`;
}

export function generateOsuFile({
    audioFilename,
    title = "My Song",
    artist = "Unknown",
    creator = "",
    timingPoints
}) {
    return `osu file format v14

[General]
AudioFilename: ${audioFilename}
AudioLeadIn: 0
PreviewTime: -1
Countdown: 0
SampleSet: Soft
StackLeniency: 0.7
Mode: 0
WidescreenStoryboard: 1

[Editor]
DistanceSpacing: 1
BeatDivisor: 4
GridSize: 32
TimelineZoom: 1

[Metadata]
Title:${title}
Artist:${artist}
Creator:${creator}
Version:Auto BPM

[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:5
ApproachRate:5
SliderMultiplier:1.4
SliderTickRate:1

[Events]

${timingPoints}

[HitObjects]
`;
}
