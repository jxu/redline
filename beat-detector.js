import Essentia from "essentia.js";
import { EssentiaWASM } from "essentia.js/wasm";

const essentia = new Essentia(EssentiaWASM);

// RhythmExtractor2013 requires 44.1 kHz mono samples. The caller owns decoding
// and resampling; this adapter owns all temporary Essentia/WASM allocations.
export function detectBeats(samples) {
    const signal = essentia.arrayToVector(samples);
    let result;

    try {
        result = essentia.RhythmExtractor2013(signal, 250, "multifeature", 40);

        return {
            ticks: Array.from(
                { length: result.ticks.size() },
                (_, index) => result.ticks.get(index)
            ),
            confidence: result.confidence,
        };
    } finally {
        signal.delete();
        result?.ticks?.delete?.();
        result?.estimates?.delete?.();
        result?.bpmIntervals?.delete?.();
    }
}
