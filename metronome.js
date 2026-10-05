function clampSample(sample) {
    return Math.max(-1, Math.min(1, sample));
}

// Generate a short 1000 Hz click with a linear fade-out.
function createClick(clickLength, sampleRate) {
    return Float32Array.from({ length: clickLength }, (_, index) => {
        const time = index / sampleRate;
        return Math.sin(2 * Math.PI * 1000 * time)
            * (1 - index / clickLength)
            * 0.7;
    });
}

export function createMetronomeBuffer(audioContext, ticks, duration, sampleRate) {
    const length = Math.ceil(duration * sampleRate);
    const clickLength = Math.floor(0.05 * sampleRate);
    const click = createClick(clickLength, sampleRate);
    const buffer = audioContext.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    for (const tick of ticks) {
        const start = Math.floor(tick * sampleRate);
        for (let index = 0; index < click.length && start + index < data.length; index++) {
            data[start + index] += click[index];
        }
    }

    return buffer;
}

export function mixBuffers(audioContext, original, clicks, audioGain = 1) {
    const mixed = audioContext.createBuffer(
        original.numberOfChannels,
        original.length,
        original.sampleRate
    );
    const click = clicks.getChannelData(0);

    for (let channel = 0; channel < original.numberOfChannels; channel++) {
        const input = original.getChannelData(channel);
        const output = mixed.getChannelData(channel);
        for (let index = 0; index < input.length; index++) {
            output[index] = clampSample(input[index] * audioGain + click[index]);
        }
    }

    return mixed;
}
