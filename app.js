import Essentia from "https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia.js-core.es.js";

// import essentia-wasm-module
import { EssentiaWASM } from 'https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia-wasm.es.js';

import WaveSurfer from 'https://unpkg.com/wavesurfer.js@7/dist/wavesurfer.esm.js';

const essentia = new Essentia(EssentiaWASM);

// prints version of essentia wasm backend
console.log(essentia.version)

// prints all the available algorithm methods in Essentia
console.log(essentia.algorithmNames)

const fileInput = document.getElementById("audioFile");
const player = document.getElementById("player");

const audioContext = new AudioContext();

// WaveSurfer 
const wavesurfer = WaveSurfer.create({
    container: '#waveform',
    waveColor: '#4F4A85',
    progressColor: '#383351',
    height: 120,
});
wavesurfer.on('click', () => wavesurfer.playPause())


fileInput.addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    await wavesurfer.loadBlob(file);

    // For Essentia
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    const samples = audioBuffer.getChannelData(0); // Float32Array

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
    const resultsBox = document.getElementById("results");

    resultsBox.innerHTML = `
        <h3>Rhythm Analysis</h3>
        <p><strong>Average BPM:</strong> ${result.bpm.toFixed(2)}</p>
        <p><strong>Confidence:</strong> ${result.confidence.toFixed(2)}</p>
        <p><strong>Beats detected:</strong> ${tickArray}</p>
    `;


});

