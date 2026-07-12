export function generateOsuTimingPoints(ticks) {
    const lines = [];

    for (let i = 0; i < ticks.length - 1; i++) {
        const timeMs = Math.round(ticks[i] * 1000);

        const beatLength = ((ticks[i + 1] - ticks[i]) * 1000).toFixed(2);

        lines.push(
            `${timeMs},${beatLength},4,2,0,100,1,0`
        );
    }

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
