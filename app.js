import Essentia from "https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia.js-core.es.js";

// import essentia-wasm-module
import { EssentiaWASM } from 'https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia-wasm.es.js';

// import WaveSurfer and Regions module
import WaveSurfer from 'https://unpkg.com/wavesurfer.js@7/dist/wavesurfer.esm.js';
import Regions from 'https://unpkg.com/wavesurfer.js@7/dist/plugins/regions.esm.js';

function clamp(x, min = -1, max = 1) {
    return Math.max(min, Math.min(max, x));
};

// Manually create metronome buffer
function createMetronomeBuffer(ticks, duration, sampleRate) {
    const length = Math.ceil(duration * sampleRate);

    const buffer = audioContext.createBuffer(
        1,
        length,
        sampleRate
    );

    const data = buffer.getChannelData(0);

    for (const tick of ticks) {
        const start = Math.floor(tick * sampleRate);

        const clickLength = Math.floor(0.05 * sampleRate); // 50ms

        for (let i = 0; i < clickLength; i++) {
            if (start + i >= data.length) break;

            const t = i / sampleRate;

            // 1000Hz click with fade-out
            data[start + i] +=
                Math.sin(2 * Math.PI * 1000 * t) *
                (1 - i / clickLength) *
                0.4;
        }
    }

    return buffer;
}

function mixBuffers(original, clicks) {
    const channels = original.numberOfChannels;

    const mixed = audioContext.createBuffer(
        channels,
        original.length,
        original.sampleRate
    );

    for (let ch = 0; ch < channels; ch++) {
        const output = mixed.getChannelData(ch);
        const input = original.getChannelData(ch);

        // click track is mono
        const click = clicks.getChannelData(0);

        // prevent clipping?
        for (let i = 0; i < output.length; i++) {
            output[i] = clamp(input[i] + click[i]);
        }
    }

    return mixed;
}

const essentia = new Essentia(EssentiaWASM);

const fileInput = document.getElementById("audioFile");
const player = document.getElementById("player");

const audioContext = new AudioContext();

// Hidden WebAudio state
let source = null;
let startTime = 0;
let pausedAt = 0;
let playing = false;

let newSource = null;

// WaveSurfer 
const regions = Regions.create();

const wavesurfer = WaveSurfer.create({
    container: '#waveform',
    waveColor: '#4F4A85',
    progressColor: '#383351',
    height: 120,
    plugins: [regions],
});



fileInput.addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;


    // For Essentia
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    // IMPORTANT: Essentia expects 44.1 kHz, resample here
    console.log(audioBuffer.sampleRate);
    const targetSampleRate = 44100;

    const offline = new OfflineAudioContext(
        1, // mono
        Math.ceil(audioBuffer.duration * targetSampleRate),
        targetSampleRate
    );

    // Copy the decoded audio into the offline context
    const offlineSource = offline.createBufferSource();
    offlineSource.buffer = audioBuffer;
    offlineSource.connect(offline.destination);
    offlineSource.start();

    const resampledBuffer = await offline.startRendering();

    const samples = resampledBuffer.getChannelData(0); // Float32Array

    const signal = essentia.arrayToVector(samples);


    
    // main rhythm extractor function
    const result = essentia.RhythmExtractor2013(signal);

    console.log(result);

    // convert Emscripten vector to JS array?
    const tickArray = Array.from(
        { length: result.ticks.size() },
        (_, i) => result.ticks.get(i)
    );

    console.log(tickArray);
    const ticks = tickArray;
    const resultsBox = document.getElementById("results");

    resultsBox.innerHTML = `
        <h3>Rhythm Analysis</h3>
        <p><strong>Average BPM:</strong> ${result.bpm.toFixed(2)}</p>
        <p><strong>Confidence:</strong> ${result.confidence.toFixed(2)}</p>
        <p><strong>Beats detected:</strong> ${tickArray}</p>
    `;

    // create mixed result
    const clickBuffer = createMetronomeBuffer(
        ticks,
        audioBuffer.duration,
        audioBuffer.sampleRate
    );

    const mixedBuffer = mixBuffers(
        audioBuffer,
        clickBuffer
    );

    wavesurfer.once("ready", () => {
        for (const beat of tickArray) {
            regions.addRegion({
                start: beat,
                end: beat + 0.01,
                color: "rgba(255,0,0,0.6)",
                drag: false,
                resize: false,
            });
        }
    });

    await wavesurfer.loadBlob(file);

    // buffer only lives once
    let newsource = null;

    function playMixed() {
        if (playing) return;

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

        wavesurfer.setTime(current);

        requestAnimationFrame(updateWaveSurferCursor);
    }

    document
        .getElementById("play")
        .onclick = playMixed;

    document
        .getElementById("pause")
        .onclick = pauseMixed;

    // sync seeking
    wavesurfer.on("interaction", (time) => {
        pausedAt = time;

        if (playing) {
            pauseMixed();
            playMixed();
        }
    });

});

