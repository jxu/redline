// Browser entry point: UI, playback, and rendering.
import WaveSurfer from "wavesurfer.js";
import Regions from "wavesurfer.js/regions";

import Chart from "chart.js/auto";

import { decodeAudio } from "./audio-decoder.js";
import { filterSpuriousBeats } from "./beat-filter.js";
import { interpolateBeatGaps } from "./beat-interpolation.js";
import { detectBeats } from "./analysis-worker-client.js";
import { createMetronomeBuffer, mixBuffers } from "./metronome.js";
import { calculateTiming, doubleTicks, halveTicks } from "./timing.js";

const MIN_PX_PER_SEC = 1;
const MAX_PX_PER_SEC = 500;

const state = {
    bpmChart: null,
    zoomPxPerSec: MIN_PX_PER_SEC,
    playback: {
        startTime: 0,
        pausedAt: 0,
        playing: false,
        source: null,
        mixedBuffer: null,
    },
    track: {
        file: null,
        audioBuffer: null,
        samples: null, // 16 kHz mono Float32Array for SENet
        ticks: [],
        filteredBeatCount: 0,
        interpolatedBeatCount: 0,
        confidence: 0,
        probabilities: null,
        smoothedProbabilities: null,
    },
};

// A BPM label pinned just right of a marker line. Styled inline because regions
// render inside wavesurfer's shadow DOM, which external stylesheets can't reach.
function makeBpmLabel(text) {
    const span = document.createElement("span");
    span.textContent = text;
    Object.assign(span.style, {
        position: "absolute",
        top: "0",
        left: "3px",
        fontSize: "0.7rem",
        lineHeight: "1",
        color: "red",
        whiteSpace: "nowrap",
        pointerEvents: "none", // don't block hover/tooltip on the line itself
    });
    return span;
}

function clamp(x, min = -1, max = 1) {
    return Math.max(min, Math.min(max, x));
}

// Plot instantaneous BPM against time for the whole song: the raw per-beat BPM
// (60 / each detected gap) as a faint line, with the smoothed series (what the
// markers/osu export use) drawn on top so you can see what smoothing did.
function drawBpmGraph(raw, smoothed) {
    if (!state.bpmChart) {
        state.bpmChart = new Chart(document.getElementById("bpmGraph"), {
            type: "line",
            data: {
                datasets: [
                    {
                        label: "raw",
                        data: raw,
                        borderColor: "rgba(79, 74, 133, 0.35)",
                        borderWidth: 1,
                        pointRadius: 0,
                    },
                    {
                        label: "smoothed",
                        data: smoothed,
                        borderColor: "#4F4A85",
                        borderWidth: 1.5,
                        pointRadius: 0,
                    },
                ],
            },
            options: {
                animation: false,
                maintainAspectRatio: false, // fill the CSS-sized canvas box
                scales: {
                    x: { type: "linear", title: { display: true, text: "seconds" } },
                    y: { title: { display: true, text: "BPM" } },
                },
                plugins: { legend: { display: true } },
            },
        });
        return;
    }

    state.bpmChart.data.datasets[0].data = raw;
    state.bpmChart.data.datasets[1].data = smoothed;
    state.bpmChart.update();
}

const fileInput = document.getElementById("audioFile");
const resultsBox = document.getElementById("results");

const smoothingSlider = document.getElementById("smoothing");
const toleranceSlider = document.getElementById("tolerance");
const smoothingValue = document.getElementById("smoothingValue");
const toleranceValue = document.getElementById("toleranceValue");

const audioContext = new AudioContext();

// WaveSurfer
const regions = Regions.create();

const wavesurfer = WaveSurfer.create({
    container: '#waveform',
    waveColor: '#4F4A85',
    progressColor: '#383351',
    height: 120,
    plugins: [regions],
});

function playMixed() {
    if (state.playback.playing || !state.playback.mixedBuffer) return;

    if (audioContext.state === "suspended") {
        audioContext.resume();
    }

    state.playback.source = audioContext.createBufferSource();
    state.playback.source.buffer = state.playback.mixedBuffer;
    state.playback.source.connect(audioContext.destination);

    state.playback.startTime = audioContext.currentTime - state.playback.pausedAt;

    state.playback.source.start(
        0,
        state.playback.pausedAt
    );

    state.playback.playing = true;

    updateWaveSurferCursor();
}

function pauseMixed() {
    if (!state.playback.playing) return;

    state.playback.source.stop();

    state.playback.pausedAt = audioContext.currentTime - state.playback.startTime;

    state.playback.playing = false;
    state.playback.source = null;
}

function updateWaveSurferCursor() {
    if (!state.playback.playing) return;

    const current =
        audioContext.currentTime - state.playback.startTime;

    // stop advancing once the track finishes
    if (current >= state.playback.mixedBuffer.duration) {
        wavesurfer.setTime(state.playback.mixedBuffer.duration);

        state.playback.source = null; // source stops itself at the end
        state.playback.playing = false;
        state.playback.pausedAt = 0; // next play restarts from the beginning
        return;
    }

    wavesurfer.setTime(current);

    requestAnimationFrame(updateWaveSurferCursor);
}

document
    .getElementById("play")
    .onclick = playMixed;

document
    .getElementById("pause")
    .onclick = pauseMixed;

// zoom with the mouse wheel over the waveform. zoom() takes pixels-per-second,
// so we scale it multiplicatively (each notch is a constant ratio, which feels
// even across the range) and clamp between fully zoomed-out and a tight view.
document.getElementById("waveform").addEventListener("wheel", (event) => {
    event.preventDefault(); // don't scroll the page while zooming
    const factor = Math.exp(-event.deltaY * 0.002); // up = in, down = out
    state.zoomPxPerSec = clamp(
        state.zoomPxPerSec * factor,
        MIN_PX_PER_SEC,
        MAX_PX_PER_SEC
    );
    wavesurfer.zoom(state.zoomPxPerSec);
}, { passive: false });

// smoothing knobs update their readout and re-render the smoothing view live --
// re-detection isn't needed and renderSmoothing() is cheap (see its comment).
smoothingSlider.oninput = () => {
    smoothingValue.textContent = smoothingSlider.value;
    renderSmoothing();
};
toleranceSlider.oninput = () => {
    toleranceValue.textContent = toleranceSlider.value;
    renderSmoothing();
};

document.getElementById("calculate").onclick = analyze;

// octave fixes: reshape the detected beats in place, no re-detection needed
document.getElementById("doubleTempo").onclick = () => {
    if (state.track.ticks.length < 2) return;
    state.track.ticks = doubleTicks(state.track.ticks);
    renderTicks();
};

document.getElementById("halveTempo").onclick = () => {
    if (state.track.ticks.length < 2) return;
    state.track.ticks = halveTicks(state.track.ticks);
    renderTicks();
};

// sync seeking (works whether paused or mid-playback)
wavesurfer.on("interaction", (time) => {
    const wasPlaying = state.playback.playing;

    // pause first so pauseMixed() can't overwrite the new position
    if (wasPlaying) pauseMixed();

    state.playback.pausedAt = time;

    if (wasPlaying) playMixed();
});

// decode + resample once per file; store the results for reuse on re-calculation
async function loadFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    const decoded = await decodeAudio(arrayBuffer, audioContext);
    state.track.audioBuffer = decoded.audioBuffer;
    state.track.samples = decoded.samples;
    state.track.file = file;
}

// run beat detection on the loaded file, then hand the ticks to renderTicks()
async function analyze() {
    if (!state.track.file) return;

    resultsBox.textContent = "Analyzing...";

    try {
        const result = await detectBeats(state.track.samples, {
            onProgress: ({ stage, fraction }) => {
                const percent = Math.round(fraction * 100);
                resultsBox.innerHTML = `
                    <p>${stage} (${percent}%)</p>
                    <progress max="100" value="${percent}"></progress>
                `;
            },
        });
        const filteredTicks = filterSpuriousBeats(result.ticks);
        state.track.ticks = interpolateBeatGaps(filteredTicks, {
            endTime: state.track.audioBuffer.duration,
        });
        state.track.filteredBeatCount = result.ticks.length - filteredTicks.length;
        state.track.interpolatedBeatCount = state.track.ticks.length - filteredTicks.length;
        state.track.confidence = result.confidence;
        state.track.probabilities = result.probabilities;
        state.track.smoothedProbabilities = result.smoothedProbabilities;
    } catch (err) {
        resultsBox.textContent = `Analysis failed: ${err}`;
        return;
    }

    renderTicks();
}

// rebuild everything downstream of the beats. Split in two: the audio mix +
// readout depend only on detected ticks (analyze / ×2 / ÷2), while the smoothing
// view also depends on the sliders -- renderSmoothing() owns that part and is
// cheap enough to re-run live as the sliders move.
function renderTicks() {
    // reset playback before rebuilding the mixed audio
    pauseMixed();
    state.playback.pausedAt = 0;

    const timing = calculateTiming(state.track.ticks, {
        toleranceMs: Number(toleranceSlider.value),
        windowSize: Number(smoothingSlider.value),
    });

    resultsBox.innerHTML = `
        <h3>Rhythm Analysis</h3>
        <p><strong>Average BPM:</strong> ${timing.averageBpm.toFixed(1)}</p>
        <p><strong>Mean peak probability:</strong> ${state.track.confidence.toFixed(3)}</p>
        <p><strong>Filtered extra beats:</strong> ${state.track.filteredBeatCount}</p>
        <p><strong>Interpolated beats:</strong> ${state.track.interpolatedBeatCount}</p>
    `;

    // click track + mixed audio place clicks at detected ticks, so they're
    // unaffected by the smoothing sliders -- built here, not in renderSmoothing
    const clickBuffer = createMetronomeBuffer(
        audioContext,
        state.track.ticks,
        state.track.audioBuffer.duration,
        state.track.audioBuffer.sampleRate
    );

    state.playback.mixedBuffer = mixBuffers(
        audioContext,
        state.track.audioBuffer,
        clickBuffer
    );

    renderSmoothing(timing);
}

// smoothing-dependent view: beat lengths, BPM graph, waveform markers, osu
// export. No model inference or full-buffer mixing, so the sliders can re-run this
// live on every input without re-detecting beats or interrupting playback.
function renderSmoothing(timing = null) {
    if (!state.track.ticks.length) return;

    timing ??= calculateTiming(state.track.ticks, {
        toleranceMs: Number(toleranceSlider.value),
        windowSize: Number(smoothingSlider.value),
    });
    const { beatLengths } = timing;

    drawBpmGraph(timing.rawBpmSeries, timing.smoothedBpmSeries);

    // redraw markers from scratch against the new beat lengths
    regions.clearRegions();
    state.track.ticks.forEach((beat, i) => {
        // red if it starts a new tempo (first tick or changed beatLength), else gray
        const isNewTempo =
            i === 0 ||
            (i < beatLengths.length && beatLengths[i] !== beatLengths[i - 1]);

        // only red (new-tempo) lines get a BPM label; gray ones would just repeat it.
        // beatLength is ms-per-beat, so BPM = 60000 / beatLength.
        const showLabel = isNewTempo && i < beatLengths.length;
        const bpmText = showLabel
            ? `${(60000 / Number(beatLengths[i])).toFixed(1)} BPM`
            : "";

        // no `end` => a marker (fixed-width vertical line, see ::part(region) in CSS).
        // regions live in wavesurfer's shadow DOM, so external CSS can't reach the
        // label span -- makeBpmLabel styles it inline, which pierces the boundary.
        regions.addRegion({
            start: beat,
            color: isNewTempo ? "rgba(255, 0, 0, 0.9)" : "rgba(150, 150, 150, 0.9)",
            content: bpmText ? makeBpmLabel(bpmText) : undefined,
            drag: false,
            resize: false,
        });
    });

    document.getElementById("osuTimingPoints").value = timing.osuTimingPoints;
}

fileInput.addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    // reset state from any previous track; detection waits for Calculate
    pauseMixed();
    state.playback.pausedAt = 0;
    regions.clearRegions();
    state.track.ticks = [];
    state.track.filteredBeatCount = 0;
    state.track.interpolatedBeatCount = 0;
    state.track.probabilities = null;
    state.track.smoothedProbabilities = null;
    resultsBox.textContent = "Press Calculate after the waveform updates, then adjust smoothing if needed.";

    // decode + show the waveform now; run beat detection only on Calculate
    await loadFile(file);
    await wavesurfer.loadBlob(file);
});
