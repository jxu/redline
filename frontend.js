// Browser entry point: UI, playback, and rendering.
import WaveSurfer from "wavesurfer.js";
import Regions from "wavesurfer.js/regions";

import Chart from "chart.js/auto";

import { decodeAudio } from "./audio-decoder.js";
import { filterSpuriousBeats } from "./beat-filter.js";
import { interpolateBeatGaps } from "./beat-interpolation.js";
import { detectBeats } from "./analysis-worker-client.js";
import { createMetronomeBuffer, mixBuffers } from "./metronome.js";
import {
    defaultTempoSmoothness, defaultToleranceMs, doubleTicks, halveTicks,
} from "./timing.js";

import { calculateExportTiming as calculateTiming } from "./timing-export.js";

const MIN_PX_PER_SEC = 1;
const MAX_PX_PER_SEC = 500;
let trackGeneration = 0;
let loading = false;
let analyzing = false;
let waveformLoad = Promise.resolve();

const state = {
    bpmChart: null,
    zoomPxPerSec: MIN_PX_PER_SEC,
    playback: {
        startTime: 0,
        pausedAt: 0,
        playing: false,
        source: null,
        mixedBuffer: null,
        cursorGeneration: 0,
    },
    track: {
        file: null,
        audioBuffer: null,
        samples: null, // 22.05 kHz mono Float32Array for Beat This!
        ticks: [],
        observedTicks: [],
        manualTempoLevel: false,
        filteredBeatCount: 0,
        interpolatedBeatCount: 0,
        confidence: 0,
        inferenceBackend: null,
        inferenceTimings: null,
        probabilities: null,
        downbeats: null,
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

// Plot instantaneous BPM against time for the whole song: raw detected gaps
// as a faint line, with the fitted export tempo drawn on top.
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
                        label: "fitted export",
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
const calculateButton = document.getElementById("calculate");

function updateControls() {
    const busy = loading || analyzing;
    calculateButton.disabled = busy || !state.track.samples;
    for (const id of ["doubleTempo", "halveTempo"]) {
        document.getElementById(id).disabled = busy || state.track.ticks.length < 2;
    }
    document.getElementById("play").disabled = busy || !state.playback.mixedBuffer;
    document.getElementById("pause").disabled = busy || !state.playback.mixedBuffer;
}

const tempoPatternSelect = document.getElementById("tempoPattern");
const tempoSmoothnessSlider = document.getElementById("tempoSmoothness");
const tempoSmoothnessValue = document.getElementById("tempoSmoothnessValue");
const toleranceSlider = document.getElementById("tolerance");
const toleranceValue = document.getElementById("toleranceValue");
let smoothnessTouched = false;
let toleranceTouched = false;

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

async function playMixed() {
    if (loading || analyzing || state.playback.playing || !state.playback.mixedBuffer) return;
    const generation = ++state.playback.cursorGeneration;
    const buffer = state.playback.mixedBuffer;

    try {
        if (audioContext.state === "suspended") await audioContext.resume();
    } catch (error) {
        if (generation === state.playback.cursorGeneration) {
            resultsBox.textContent = `Playback failed: ${error}`;
        }
        return;
    }
    if (generation !== state.playback.cursorGeneration || buffer !== state.playback.mixedBuffer) return;
    if (state.playback.pausedAt >= buffer.duration) state.playback.pausedAt = 0;

    state.playback.source = audioContext.createBufferSource();
    state.playback.source.buffer = state.playback.mixedBuffer;
    state.playback.source.connect(audioContext.destination);

    state.playback.startTime = audioContext.currentTime - state.playback.pausedAt;

    state.playback.source.start(
        0,
        state.playback.pausedAt
    );

    state.playback.playing = true;

    updateWaveSurferCursor(generation);
}

function pauseMixed() {
    // Also cancel a Play waiting for AudioContext.resume().
    state.playback.cursorGeneration++;
    if (!state.playback.playing) return;

    state.playback.source.stop();

    state.playback.pausedAt = audioContext.currentTime - state.playback.startTime;

    state.playback.playing = false;
    state.playback.source = null;
}

function updateWaveSurferCursor(generation) {
    if (!state.playback.playing || generation !== state.playback.cursorGeneration) return;

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

    requestAnimationFrame(() => updateWaveSurferCursor(generation));
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
    if (loading || !state.track.audioBuffer) return;
    const factor = Math.exp(-event.deltaY * 0.002); // up = in, down = out
    state.zoomPxPerSec = clamp(
        state.zoomPxPerSec * factor,
        MIN_PX_PER_SEC,
        MAX_PX_PER_SEC
    );
    wavesurfer.zoom(state.zoomPxPerSec);
}, { passive: false });

// These controls refit the grid without running the beat detector again.
tempoSmoothnessSlider.oninput = () => {
    smoothnessTouched = true;
    tempoSmoothnessValue.textContent = tempoSmoothnessSlider.value;
    renderTimingGrid();
};
toleranceSlider.oninput = () => {
    toleranceTouched = true;
    toleranceValue.textContent = toleranceSlider.value;
    renderTimingGrid();
};
tempoPatternSelect.onchange = () => {
    if (!smoothnessTouched) {
        tempoSmoothnessSlider.value = defaultTempoSmoothness(tempoPatternSelect.value);
        tempoSmoothnessValue.textContent = tempoSmoothnessSlider.value;
    }
    if (!toleranceTouched) {
        toleranceSlider.value = defaultToleranceMs(tempoPatternSelect.value);
        toleranceValue.textContent = toleranceSlider.value;
    }
    if (state.track.ticks.length) renderTicks();
};

calculateButton.onclick = analyze;

// octave fixes: reshape the detected beats in place, no re-detection needed
document.getElementById("doubleTempo").onclick = () => {
    if (loading || analyzing || state.track.ticks.length < 2) return;
    state.track.ticks = doubleTicks(state.track.ticks);
    state.track.observedTicks = doubleTicks(state.track.observedTicks);
    state.track.manualTempoLevel = true;
    renderTicks();
};

document.getElementById("halveTempo").onclick = () => {
    if (loading || analyzing || state.track.ticks.length < 2) return;
    state.track.ticks = halveTicks(state.track.ticks);
    const gridTimes = new Set(state.track.ticks.map((tick) => Math.round(tick * 1e6)));
    state.track.observedTicks = state.track.observedTicks.filter(
        (tick) => gridTimes.has(Math.round(tick * 1e6))
    );
    state.track.manualTempoLevel = true;
    renderTicks();
};

// sync seeking (works whether paused or mid-playback)
wavesurfer.on("interaction", (time) => {
    if (loading || analyzing || !state.playback.mixedBuffer) return;
    const wasPlaying = state.playback.playing;

    // pause first so pauseMixed() can't overwrite the new position
    pauseMixed();

    state.playback.pausedAt = clamp(time, 0, state.playback.mixedBuffer.duration);

    if (wasPlaying) playMixed();
});

// decode + resample once per file; store the results for reuse on re-calculation
async function loadFile(file, generation) {
    const arrayBuffer = await file.arrayBuffer();
    if (generation !== trackGeneration) return;
    const decoded = await decodeAudio(arrayBuffer, audioContext);
    if (generation !== trackGeneration) return;
    // WaveSurfer mutates its own state asynchronously. Serialize loads so an
    // earlier render cannot overwrite the newest file's waveform.
    const pendingLoad = waveformLoad.catch(() => {}).then(async () => {
        if (generation !== trackGeneration) return;
        await wavesurfer.loadBlob(file);
    });
    waveformLoad = pendingLoad;
    await pendingLoad;
    if (generation !== trackGeneration) return;
    state.track.audioBuffer = decoded.audioBuffer;
    state.track.samples = decoded.samples;
    state.track.file = file;
}

// run beat detection on the loaded file, then hand the ticks to renderTicks()
async function analyze() {
    if (loading || analyzing || !state.track.samples) return;
    if (!tempoPatternSelect.value) {
        resultsBox.textContent = "Choose the song's tempo pattern before calculating.";
        tempoPatternSelect.focus();
        return;
    }

    resultsBox.textContent = "Analyzing...";
    const generation = trackGeneration;
    const audioBuffer = state.track.audioBuffer;
    analyzing = true;
    updateControls();
    pauseMixed();
    state.track.manualTempoLevel = false;

    try {
        const result = await detectBeats(state.track.samples, {
            onProgress: ({ stage, fraction }) => {
                if (generation !== trackGeneration) return;
                const percent = Math.round(fraction * 100);
                resultsBox.innerHTML = `
                    <p>${stage} (${percent}%)</p>
                    <progress max="100" value="${percent}"></progress>
                `;
            },
        });
        if (generation !== trackGeneration) return;
        const filteredTicks = filterSpuriousBeats(result.ticks);
        state.track.observedTicks = filteredTicks;
        state.track.ticks = interpolateBeatGaps(filteredTicks, {
            endTime: audioBuffer.duration,
        });
        state.track.filteredBeatCount = result.ticks.length - filteredTicks.length;
        state.track.interpolatedBeatCount = state.track.ticks.length - filteredTicks.length;
        state.track.confidence = result.confidence;
        state.track.inferenceBackend = result.backend;
        state.track.inferenceTimings = result.timings;
        state.track.probabilities = result.probabilities;
        state.track.downbeats = result.downbeats;
        analyzing = false;
        if (state.track.ticks.length) renderTicks();
        else resultsBox.textContent = "No beats detected. Try another audio file.";
    } catch (err) {
        if (generation === trackGeneration) resultsBox.textContent = `Analysis failed: ${err}`;
    } finally {
        analyzing = false;
        updateControls();
    }
}

// Update the analysis readout, then fit the visible and audible timing grid.
function renderTicks() {
    if (loading || analyzing || !state.track.ticks.length) return;
    // A new detection starts playback from the beginning.
    pauseMixed();
    state.playback.pausedAt = 0;
    state.playback.mixedBuffer = null;

    const timing = calculateTiming(state.track.ticks, {
        toleranceMs: Number(toleranceSlider.value),
        tempoSmoothness: Number(tempoSmoothnessSlider.value),
        endTime: state.track.audioBuffer.duration,
        observedTicks: state.track.observedTicks,
        tempoPattern: tempoPatternSelect.value,
        probabilities: state.track.probabilities,
        probabilityFrameMs: 20,
        downbeatTicks: state.track.downbeats,
        preserveInputPulse: state.track.manualTempoLevel,
    });

    resultsBox.innerHTML = `
        <h3>Rhythm Analysis</h3>
        <p><strong>Average BPM:</strong> ${timing.averageBpm.toFixed(1)}</p>
        <p><strong>Tempo pattern:</strong> ${timing.tempoPattern}</p>
        <p id="fitWarning" hidden>Detected beats do not consistently support one BPM; inspect the click track.</p>
        <p><strong>Mean peak probability:</strong> ${state.track.confidence.toFixed(3)}</p>
        <p><strong>Inference backend:</strong> ${state.track.inferenceBackend === "webgpu" ? "WebGPU" : "WASM"}</p>
        <p><strong>Analysis time:</strong> ${(state.track.inferenceTimings.totalMs / 1000).toFixed(1)} seconds
            (${(state.track.inferenceTimings.spectrogramMs / 1000).toFixed(1)} spectrogram,
            ${(state.track.inferenceTimings.inferenceMs / 1000).toFixed(1)} inference)</p>
        <p><strong>Filtered extra beats:</strong> ${state.track.filteredBeatCount}</p>
        <p><strong>Interpolated beats:</strong> ${state.track.interpolatedBeatCount}</p>
    `;

    renderTimingGrid(timing);
    updateControls();
}

// The fitted export grid drives the waveform markers and audible click track.
function renderTimingGrid(timing = null) {
    if (loading || analyzing || !state.track.ticks.length) return;

    timing ??= calculateTiming(state.track.ticks, {
        toleranceMs: Number(toleranceSlider.value),
        tempoSmoothness: Number(tempoSmoothnessSlider.value),
        endTime: state.track.audioBuffer.duration,
        observedTicks: state.track.observedTicks,
        tempoPattern: tempoPatternSelect.value,
        probabilities: state.track.probabilities,
        probabilityFrameMs: 20,
        downbeatTicks: state.track.downbeats,
        preserveInputPulse: state.track.manualTempoLevel,
    });

    const warning = document.getElementById("fitWarning");
    if (warning) warning.hidden = !timing.fitWarning;

    const wasPlaying = state.playback.playing;
    pauseMixed();
    const clickBuffer = createMetronomeBuffer(
        audioContext,
        timing.gridTicks,
        state.track.audioBuffer.duration,
        state.track.audioBuffer.sampleRate
    );
    state.playback.mixedBuffer = mixBuffers(
        audioContext,
        state.track.audioBuffer,
        clickBuffer
    );
    if (wasPlaying) playMixed();

    drawBpmGraph(timing.rawBpmSeries, timing.smoothedBpmSeries);

    // Red markers are exported timing points; gray markers are their grid beats.
    regions.clearRegions();
    let pointIndex = 0;
    timing.gridTicks.forEach((beat) => {
        const point = timing.timingPoints[pointIndex];
        const isNewTempo = point && Math.abs(beat * 1000 - point.offsetMs) < 1e-6;
        const bpmText = isNewTempo
            ? `${(60000 / point.beatLengthMs).toFixed(1)} BPM`
            : "";
        if (isNewTempo) pointIndex++;

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
    const generation = ++trackGeneration;
    loading = true;

    // reset state from any previous track; detection waits for Calculate
    pauseMixed();
    state.playback.pausedAt = 0;
    state.playback.mixedBuffer = null;
    state.track.file = null;
    state.track.audioBuffer = null;
    state.track.samples = null;
    regions.clearRegions();
    state.track.ticks = [];
    state.track.observedTicks = [];
    state.track.manualTempoLevel = false;
    state.track.filteredBeatCount = 0;
    state.track.interpolatedBeatCount = 0;
    state.track.inferenceBackend = null;
    state.track.inferenceTimings = null;
    state.track.probabilities = null;
    state.track.downbeats = null;
    document.getElementById("osuTimingPoints").value = "";
    state.bpmChart?.destroy();
    state.bpmChart = null;
    resultsBox.textContent = "Loading audio...";
    updateControls();

    // decode + show the waveform now; run beat detection only on Calculate
    try {
        await loadFile(file, generation);
        if (generation === trackGeneration) resultsBox.textContent = "Press Calculate to analyze.";
    } catch (error) {
        if (generation === trackGeneration) resultsBox.textContent = `Audio loading failed: ${error}`;
    } finally {
        if (generation === trackGeneration) {
            loading = false;
            updateControls();
        }
    }
});

updateControls();
