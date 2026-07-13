import Essentia from "essentia.js";
import { EssentiaWASM } from "essentia.js/wasm";

import WaveSurfer from "wavesurfer.js";
import Regions from "wavesurfer.js/regions";

import Chart from "chart.js/auto";

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

function generateOsuTimingPoints(ticks, beatLengths) {
    // keep only points whose beatLength differs from the previous one
    const lines = beatLengths
        .map((beatLength, i) => ({ timeMs: Math.round(ticks[i] * 1000), beatLength }))
        .filter((point, i) => i === 0 || point.beatLength !== beatLengths[i - 1])
        .map((point) => `${point.timeMs},${point.beatLength},4,2,0,100,1,0`);

    return `[TimingPoints]\n${lines.join("\n")}`;
}


function clamp(x, min = -1, max = 1) {
    return Math.max(min, Math.min(max, x));
}

// Beat-smoothing config. Essentia's per-tick jitter makes adjacent intervals
// swing wildly (differencing amplifies noise), so a raw spread test can never
// group them. Two stages instead:
//   BEAT_WINDOW      - moving-average the intervals; averaging W of them measures
//                      the period over a W-beat baseline, cutting jitter by ~sqrt(W)
//                      and cancelling the long/short/long alternation when W is even.
//   BEAT_TOLERANCE_MS - group the now-smooth series into runs (spread <= tolerance)
//                      and replace each run by its mean, so steady tempo -> one value.
const BEAT_TOLERANCE_MS = 5;
const BEAT_WINDOW = 4;

// beatLength (ms, 2 dp) of the interval starting at each tick except the last,
// smoothed over a window then collapsed into steady runs (see config above)
function beatLengthsMs(ticks, tolerance = BEAT_TOLERANCE_MS, windowSize = BEAT_WINDOW) {
    const intervals = ticks.slice(0, -1).map((tick, i) => (ticks[i + 1] - tick) * 1000);
    const smoothed = movingAverage(intervals, windowSize);
    return averageSteadyRuns(smoothed, tolerance).map((ms) => ms.toFixed(2));
}

// trailing moving average over `windowSize` samples (shorter at the start)
function movingAverage(values, windowSize) {
    return values.map((_, i) => {
        const window = values.slice(Math.max(0, i - windowSize + 1), i + 1);
        return window.reduce((sum, v) => sum + v, 0) / window.length;
    });
}

// Replace each maximal run of values whose spread stays within `tolerance`
// with the run's average, so a steady tempo collapses to a single value.
function averageSteadyRuns(values, tolerance) {
    const result = values.slice();

    let start = 0;
    while (start < values.length) {
        let end = start; // inclusive end of the current run
        let min = values[start];
        let max = values[start];

        // extend the run while its spread stays within `tolerance`
        while (end + 1 < values.length) {
            const nextMin = Math.min(min, values[end + 1]);
            const nextMax = Math.max(max, values[end + 1]);
            if (nextMax - nextMin > tolerance) break;
            min = nextMin;
            max = nextMax;
            end++;
        }

        const avg =
            values.slice(start, end + 1).reduce((sum, v) => sum + v, 0) / (end - start + 1);
        for (let i = start; i <= end; i++) result[i] = avg;

        start = end + 1;
    }

    return result;
}

// ×2 octave fix: place a beat at the midpoint of every gap (102 -> 204 BPM)
function doubleTicks(ticks) {
    return ticks.flatMap((tick, i) =>
        i < ticks.length - 1 ? [tick, (tick + ticks[i + 1]) / 2] : [tick]
    );
}

// ÷2 octave fix: keep every other beat (204 -> 102 BPM)
function halveTicks(ticks) {
    return ticks.filter((_, i) => i % 2 === 0);
}

// overall BPM from the mean beat spacing (reflects the current ticks, so it
// updates after ×2/÷2 unlike essentia's one-shot reported bpm)
function averageBpm(ticks) {
    if (ticks.length < 2) return 0;
    const secondsPerBeat = (ticks[ticks.length - 1] - ticks[0]) / (ticks.length - 1);
    return 60 / secondsPerBeat;
}

// Plot instantaneous BPM against time for the whole song: the raw per-beat BPM
// (60 / each detected gap) as a faint line, with the smoothed series (what the
// markers/osu export use) drawn on top so you can see what smoothing did.
// One Chart.js instance is reused across recalcs: create it on first draw, then
// just swap its data (destroying/recreating each time would leak canvases).
let bpmChart = null;

function drawBpmGraph(ticks, beatLengths) {
    // both series share an x (the gap's start time); raw comes from the tick
    // spacing, smoothed from the collapsed beatLengths (ms/beat -> BPM)
    const raw = ticks.slice(0, -1).map((t, i) => ({
        x: t,
        y: 60 / (ticks[i + 1] - t),
    }));
    const smoothed = ticks.slice(0, -1).map((t, i) => ({
        x: t,
        y: 60000 / Number(beatLengths[i]),
    }));

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

const essentia = new Essentia(EssentiaWASM);

const fileInput = document.getElementById("audioFile");
const player = document.getElementById("player");
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

// smoothing knobs just update their readouts; they apply on the next Calculate
smoothingSlider.oninput = () => { smoothingValue.textContent = smoothingSlider.value; };
toleranceSlider.oninput = () => { toleranceValue.textContent = toleranceSlider.value; };

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

    // essentia allocates in WASM memory; every vector we create or receive must be
    // freed, or repeated Calculate clicks leak tens of MB each and eventually hang
    const signal = essentia.arrayToVector(currentSamples);

    let result;
    try {
        // main rhythm extractor function, widest range for a confident detection;
        // octave errors are fixed afterwards with the ×2/÷2 buttons
        // args: (signal, maxTempo, method, minTempo)
        result = essentia.RhythmExtractor2013(signal, 250, "multifeature", 40);
    } catch (err) {
        resultsBox.textContent = `Analysis failed: ${err}`;
        return;
    } finally {
        signal.delete();
    }

    console.log(result);

    // convert Emscripten vector to JS array, then free the WASM-side vectors
    currentTicks = Array.from(
        { length: result.ticks.size() },
        (_, i) => result.ticks.get(i)
    );
    currentConfidence = result.confidence;

    result.ticks.delete();
    result.estimates?.delete?.();
    result.bpmIntervals?.delete?.();

    renderTicks();
}

// build everything downstream of the beats: readout, metronome, markers, osu.
// Called by analyze() and by the ×2/÷2 buttons (which only reshape currentTicks).
function renderTicks() {
    // reset playback and clear old markers before rebuilding
    pauseMixed();
    pausedAt = 0;
    regions.clearRegions();

    const beatLengths = beatLengthsMs(
        currentTicks,
        Number(toleranceSlider.value),
        Number(smoothingSlider.value)
    );

    resultsBox.innerHTML = `
        <h3>Rhythm Analysis</h3>
        <p><strong>Average BPM:</strong> ${averageBpm(currentTicks).toFixed(1)}</p>
        <p><strong>Confidence:</strong> ${currentConfidence.toFixed(1)}</p>
    `;

    drawBpmGraph(currentTicks, beatLengths);

    // create mixed result
    const clickBuffer = createMetronomeBuffer(
        currentTicks,
        currentAudioBuffer.duration,
        currentAudioBuffer.sampleRate
    );

    mixedBuffer = mixBuffers(
        currentAudioBuffer,
        clickBuffer
    );

    // waveform is already loaded (on file upload), so draw markers directly
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

    const osuTiming = generateOsuTimingPoints(currentTicks, beatLengths);

    document.getElementById("osuTimingPoints").value = osuTiming;
}

fileInput.addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    // reset state from any previous track; detection waits for Calculate
    pauseMixed();
    pausedAt = 0;
    regions.clearRegions();
    currentTicks = [];
    resultsBox.textContent = "Adjust smoothing, then press Calculate.";

    // decode + show the waveform now; run beat detection only on Calculate
    await loadFile(file);
    await wavesurfer.loadBlob(file);
});
