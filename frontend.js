// Browser entry point: UI, playback, and rendering.
import WaveSurfer from "wavesurfer.js";
import Regions from "wavesurfer.js/regions";

import Chart from "chart.js/auto";

import { detectBeats } from "./beat-detector.js";
import { calculateTiming, doubleTicks, halveTicks } from "./timing.js";

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
// One Chart.js instance is reused across recalcs: create it on first draw, then
// just swap its data (destroying/recreating each time would leak canvases).
let bpmChart = null;

function drawBpmGraph(raw, smoothed) {
    if (!bpmChart) {
        bpmChart = new Chart(document.getElementById("bpmGraph"), {
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

    bpmChart.data.datasets[0].data = raw;
    bpmChart.data.datasets[1].data = smoothed;
    bpmChart.update();
}

// 1000Hz click with fade-out
function createClick(clickLength, sampleRate) {
    return Array.from({ length: clickLength }, (_, i) => {
        const t = i / sampleRate;
        return Math.sin(2 * Math.PI * 1000 * t) * (1 - i / clickLength) * 0.4;
    });
}

// Manually create metronome buffer
function createMetronomeBuffer(ticks, duration, sampleRate) {
    const length = Math.ceil(duration * sampleRate);
    const clickLength = Math.floor(0.05 * sampleRate); // 50ms

    const click = createClick(clickLength, sampleRate);

    const buffer = audioContext.createBuffer(
        1,
        length,
        sampleRate
    );

    const data = buffer.getChannelData(0);

    ticks.forEach((tick) => {
        const start = Math.floor(tick * sampleRate);

        click.forEach((sample, i) => {
            if (start + i < data.length) data[start + i] += sample;
        });
    });

    return buffer;
}

function mixBuffers(original, clicks) {
    const channels = original.numberOfChannels;

    // click track is mono, shared across channels
    const click = clicks.getChannelData(0);

    const mixed = audioContext.createBuffer(
        channels,
        original.length,
        original.sampleRate
    );

    Array.from({ length: channels }, (_, ch) => ch)
    .forEach((ch) => {
        const input = original.getChannelData(ch);

        // prevent clipping
        const output = input.map((sample, i) => clamp(sample + click[i]));

        mixed.getChannelData(ch).set(output);
    });

    return mixed;
}

const fileInput = document.getElementById("audioFile");
const resultsBox = document.getElementById("results");

const smoothingSlider = document.getElementById("smoothing");
const toleranceSlider = document.getElementById("tolerance");
const smoothingValue = document.getElementById("smoothingValue");
const toleranceValue = document.getElementById("toleranceValue");

const audioContext = new AudioContext();

// Hidden WebAudio state
let startTime = 0;
let pausedAt = 0;
let playing = false;
let newSource = null;

// Per-track state, set on each file load
let mixedBuffer = null;

// Decoded audio for the current file, reused across re-calculations so re-running
// (or a ×2/÷2 octave fix) doesn't force another decode/resample.
let currentFile = null;
let currentAudioBuffer = null;
let currentSamples = null; // 44.1 kHz mono Float32Array for essentia

// Detection results kept so the ×2/÷2 buttons can reshape the beats in place
let currentTicks = [];
let currentConfidence = 0;

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
    if (playing || !mixedBuffer) return;

    if (audioContext.state === "suspended") {
        audioContext.resume();
    }

    newSource = audioContext.createBufferSource();
    newSource.buffer = mixedBuffer;
    newSource.connect(audioContext.destination);

    startTime = audioContext.currentTime - pausedAt;

    newSource.start(
        0,
        pausedAt
    );

    playing = true;

    updateWaveSurferCursor();
}

function pauseMixed() {
    if (!playing) return;

    newSource.stop();

    pausedAt = audioContext.currentTime - startTime;

    playing = false;
    newSource = null; // get rid of it
}

function updateWaveSurferCursor() {
    if (!playing) return;

    const current =
        audioContext.currentTime - startTime;

    // stop advancing once the track finishes
    if (current >= mixedBuffer.duration) {
        wavesurfer.setTime(mixedBuffer.duration);

        newSource = null; // source stops itself at the end
        playing = false;
        pausedAt = 0; // next play restarts from the beginning
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
const MIN_PX_PER_SEC = 1;
const MAX_PX_PER_SEC = 500;
let pxPerSec = MIN_PX_PER_SEC;

document.getElementById("waveform").addEventListener("wheel", (event) => {
    event.preventDefault(); // don't scroll the page while zooming
    const factor = Math.exp(-event.deltaY * 0.002); // up = in, down = out
    pxPerSec = clamp(pxPerSec * factor, MIN_PX_PER_SEC, MAX_PX_PER_SEC);
    wavesurfer.zoom(pxPerSec);
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
    if (currentTicks.length < 2) return;
    currentTicks = doubleTicks(currentTicks);
    renderTicks();
};

document.getElementById("halveTempo").onclick = () => {
    if (currentTicks.length < 2) return;
    currentTicks = halveTicks(currentTicks);
    renderTicks();
};

// sync seeking (works whether paused or mid-playback)
wavesurfer.on("interaction", (time) => {
    const wasPlaying = playing;

    // pause first so pauseMixed() can't overwrite the new position
    if (wasPlaying) pauseMixed();

    pausedAt = time;

    if (wasPlaying) playMixed();
});

// decode + resample once per file; store the results for reuse on re-calculation
async function loadFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    currentAudioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    // IMPORTANT: Essentia expects 44.1 kHz mono, resample here
    const targetSampleRate = 44100;

    const offline = new OfflineAudioContext(
        1, // mono
        Math.ceil(currentAudioBuffer.duration * targetSampleRate),
        targetSampleRate
    );

    // Copy the decoded audio into the offline context
    const offlineSource = offline.createBufferSource();
    offlineSource.buffer = currentAudioBuffer;
    offlineSource.connect(offline.destination);
    offlineSource.start();

    const resampledBuffer = await offline.startRendering();

    currentSamples = resampledBuffer.getChannelData(0); // Float32Array
    currentFile = file;
}

// run beat detection on the loaded file, then hand the ticks to renderTicks()
async function analyze() {
    if (!currentFile) return;

    resultsBox.textContent = "Analyzing...";

    // essentia runs synchronously and blocks the main thread, so let the browser
    // actually paint "Analyzing..." (two frames) before we hand control to WASM
    await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
    );

    try {
        const result = detectBeats(currentSamples);
        currentTicks = result.ticks;
        currentConfidence = result.confidence;
    } catch (err) {
        resultsBox.textContent = `Analysis failed: ${err}`;
        return;
    }

    renderTicks();
}

// rebuild everything downstream of the beats. Split in two: the audio mix +
// readout depend only on currentTicks (analyze / ×2 / ÷2), while the smoothing
// view also depends on the sliders -- renderSmoothing() owns that part and is
// cheap enough to re-run live as the sliders move.
function renderTicks() {
    // reset playback before rebuilding the mixed audio
    pauseMixed();
    pausedAt = 0;

    const timing = calculateTiming(currentTicks, {
        toleranceMs: Number(toleranceSlider.value),
        windowSize: Number(smoothingSlider.value),
    });

    resultsBox.innerHTML = `
        <h3>Rhythm Analysis</h3>
        <p><strong>Average BPM:</strong> ${timing.averageBpm.toFixed(1)}</p>
        <p><strong>Confidence:</strong> ${currentConfidence.toFixed(1)}</p>
    `;

    // click track + mixed audio place clicks at currentTicks, so they're
    // unaffected by the smoothing sliders -- built here, not in renderSmoothing
    const clickBuffer = createMetronomeBuffer(
        currentTicks,
        currentAudioBuffer.duration,
        currentAudioBuffer.sampleRate
    );

    mixedBuffer = mixBuffers(
        currentAudioBuffer,
        clickBuffer
    );

    renderSmoothing(timing);
}

// smoothing-dependent view: beat lengths, BPM graph, waveform markers, osu
// export. No essentia and no full-buffer mixing, so the sliders can re-run this
// live on every input without re-detecting beats or interrupting playback.
function renderSmoothing(timing = null) {
    if (!currentTicks.length) return;

    timing ??= calculateTiming(currentTicks, {
        toleranceMs: Number(toleranceSlider.value),
        windowSize: Number(smoothingSlider.value),
    });
    const { beatLengths } = timing;

    drawBpmGraph(timing.rawBpmSeries, timing.smoothedBpmSeries);

    // redraw markers from scratch against the new beat lengths
    regions.clearRegions();
    currentTicks.forEach((beat, i) => {
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
    pausedAt = 0;
    regions.clearRegions();
    currentTicks = [];
    resultsBox.textContent = "Press Calculate after the waveform updates, then adjust smoothing if needed.";

    // decode + show the waveform now; run beat detection only on Calculate
    await loadFile(file);
    await wavesurfer.loadBlob(file);
});
