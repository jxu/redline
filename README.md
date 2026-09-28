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
Choose the song's tempo pattern before Calculate. Fixed BPM fits one global grid;
continuously variable BPM follows changes in sections of at most 16 beats;
variable BPM with fixed sections extends steady sections as long as the beat
evidence supports them. A warning appears if detected beats do not consistently
support a requested fixed BPM. Changing the selection after calculation refits
the export without rerunning beat detection.

## Test

Run the calculation tests with:

```bash
npm test
```

## Benchmark

Place each exact audio and `.osu` pair under `benchmark/corpus/<mapset-id>/`,
then add the case to `benchmark/manifest.json`, including a `tempoPattern` of
`fixed`, `continuous`, or `sections`. This is the mapper-supplied choice; the
reference `.osu` file is used only to score the resulting export. Set
`tempoScale` to the mapper's octave choice (`0.5`, `1`, or `2`) and, when
halving, `tempoPhase` to `0` or `1`. `allowedTempoScales` lists alternatives
to score for diagnosis, but the reference never selects the reported export.
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
then runs the same timing-grid fit and `[TimingPoints]` export used by the app, parses
that exported text, and reconstructs the beat grid through the end of the audio.
For fixed BPM, the fitter estimates one tempo and offset from observed detections;
interpolated or extrapolated beats do not influence the global fit. Other choices
fit successive sections. Isolated noisy detections can deviate from
the grid, but sustained drift prompts a new section. Every new section starts on
a beat of the previous section, so a tempo change cannot produce a duplicate beat
at the boundary. The waveform markers and click track follow the exported grid.
Scores measure that grid after osu! offset and beat-length rounding.
The fitter regularizes beat times before creating the final timing points.
Continuously variable tracks use retained detections to choose the pulse and a
stronger penalty on abrupt tempo changes. Fixed-section tracks use a lighter
penalty that preserves sustained section boundaries. Fixed tracks still produce
a single precise grid. The Tempo smoothing slider adjusts the regression penalty
without rerunning beat detection; its default is 5.

Default fit settings match the app: `windowSize: 4`, `toleranceMs: 5`, and
`tempoSmoothness: 5`. The minimum
section length is `max(2, floor(windowSize / 2))` beats. The maximum isolated
interior residual is `20 + 2 * toleranceMs` milliseconds; the average signed
residual over eight beats must stay within `5 + toleranceMs` milliseconds. A case
can override these settings with
`"timingOptions": { "windowSize": 4, "toleranceMs": 5 }` in
the manifest. The settings and selected export text are saved in each result.

The benchmark reports the manifest's scale and phase. It scores that export with
one-to-one beat-matching F1, using 17.5% of the median reference beat interval
as the matching tolerance. It also ranks alternative scales for diagnosis, but
does not use that ranking to choose the reported export. Beats in the first and
last five seconds of the audio are excluded from metrics.
The command writes every candidate score plus detailed results under
`benchmark/results/` and an SVG beat-alignment chart under `benchmark/plots/`.
`detectedBeatsMs` contains the evaluated export grid; raw, filtered, and interpolated
detections remain in separate fields for diagnosis. Charts show the export grid
alongside the reference and the intermediate SENet beats, plus reference and
exported BPM as step lines over the same song-time axis.
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
