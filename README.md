# redline

redline is a browser-based prototype that generates a rough osu! timing map from
an audio file. Its output is intended as a starting point for manual timing.

Beat detection on the `senet` branch uses Jacob Lin's trained ResNet-SE beat
model, exported to ONNX. In the browser, Redline recreates the model's three
mel-spectrogram inputs and runs inference with ONNX Runtime Web. The model and
all audio processing remain local to the browser. Spectrogram generation and
model inference run in a Web Worker so the page remains responsive; FFT.js and
ONNX Runtime Web are loaded from pinned CDN URLs by the worker. Inference uses
WebGPU when the browser and model support it, with automatic WASM fallback.

## Run locally

Install the development dependency and start the static server:

```bash
npm install
npm run dev
```

Open <http://localhost:8080> in a browser. The development command disables
caching so changes are visible after a refresh. A local HTTP server is required
because the app loads JavaScript modules and WebAssembly in the browser.

## Test

Run the calculation tests with:

```bash
npm test
```

## Benchmark

Place each exact audio and `.osu` pair under `benchmark/corpus/<mapset-id>/`,
then add the case to `benchmark/manifest.json`. The `allowedTempoScales` field
lists the BPM multiples the benchmark may try, such as `0.5`, `1`, and `2`.
Record any osu! online offset in `onlineOffsetMs`; positive values move the
reference grid later, matching osu!'s gameplay convention.
Run every configured corpus case from the command line:

```bash
npm run benchmark
```

To run one mapset:

```bash
npm run benchmark -- 1670652
```

Each run expands the ranked map's red timing points into a reference beat grid,
detects beats from the same audio, filters spurious subdivisions, and fills plausible
gaps. For each allowed tempo scale (including both phases when halving tempo), it
then runs the same smoothing and `[TimingPoints]` export used by the app, parses
that exported text, and reconstructs the beat grid through the end of the audio.
This includes rounded offsets and beat lengths, collapsed timing points, and
grid resets at new timing sections. All scores measure this final exported grid.

Smoothing defaults match the app: `windowSize: 4` and `toleranceMs: 5`. A case can
override these with `"timingOptions": { "windowSize": 4, "toleranceMs": 5 }` in
the manifest. The settings and selected export text are saved in each result.

The benchmark selects the scale with the highest one-to-one
beat-matching F1 score, using 17.5% of the median reference beat interval as the
matching tolerance. Symmetric nearest-grid error breaks ties. Beats in the first
and last five seconds of the audio are excluded from scale selection and metrics.
Tempo selection uses the reference grid, so scores assume that tempo correction
has been chosen correctly; the app still exposes this as a manual control.
The command writes every candidate score plus detailed results under
`benchmark/results/` and an SVG beat-alignment chart under `benchmark/plots/`.
`detectedBeatsMs` contains the evaluated export grid; raw, filtered, and interpolated
detections remain in separate fields for diagnosis. Charts show the export grid
alongside the reference and the intermediate SENet beats.
Regenerate charts from the saved result files without rerunning inference with:

```bash
npm run benchmark:plot
```

Render the ranked and final exported grids as click tracks mixed with the corpus audio:

```bash
npm run benchmark:listen -- 236292
```

Pass an additional offset in milliseconds to render a third ranked-grid variant:

```bash
npm run benchmark:listen -- 236292 10
```

The WAV files are written under `benchmark/listening/<mapset-id>/`.
