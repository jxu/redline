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

Raw SENet probabilities are saved in `benchmark/cache/probabilities/` on the first
run. Later runs reuse them, skipping audio decoding, spectrogram generation, and
model inference. Smoothing, peak picking, filtering, and timing regression still
run with the current code and settings. The cache stores the full probability
curve at 10 ms frame spacing plus the audio duration and source sample rate;
it does not freeze the detected beats or regression output.

To prepare probabilities first, then run regression without any inference:

```bash
npm run benchmark:cache
npm run benchmark:regression
```

Both commands accept a single mapset ID, for example
`npm run benchmark:regression -- 1670652`. Regression-only mode fails if a cache
is missing or invalid, rather than silently starting inference. Cache-only mode
does not generate scores or plots. A normal `npm run benchmark` reuses valid
caches and computes missing ones automatically.

Cache keys include the exact audio bytes, model, inference/preprocessing source,
dependency lockfile, and Node runtime/platform. Changes to these inputs create a
new cache; changes to timing settings, peak thresholds, reference maps, or online
offsets reuse the probabilities. To explicitly regenerate probabilities, run
`npm run benchmark:cache -- --refresh-probabilities` (optionally with a mapset ID).
Cache files are local and ignored by Git; each benchmark result records its cache
key and whether it was reused. Older result files contain only detected beats,
so the first cached run must compute the full curve once.

Each run expands the ranked map's red timing points into a reference beat grid,
detects beats from the same audio, filters spurious subdivisions, and fills plausible
gaps. For each allowed tempo scale (including both phases when halving tempo), it
then runs the same timing-grid fit and `[TimingPoints]` export used by the app, parses
that exported text, and reconstructs the beat grid through the end of the audio.
For fixed BPM, the fitter estimates one tempo and offset from observed detections;
interpolated or extrapolated beats do not influence the global fit. Other choices
first build a provisional beat grid, then search section boundaries across the
full track. The final fit pays for timing error, each new section, and the size
of every BPM change. Large percentage changes cost more than small ones, and
large changes close together receive an additional penalty. This makes isolated
noisy detections less likely to create a series of large tempo jumps. The general
fit starts each new section on a beat of the
previous section. The waveform markers and click track follow the exported grid.
For tracks marked variable BPM with fixed sections, Redline also looks for
persistent tempo changes in long-span beat intervals and fits a steady grid to
each run. It uses that simpler export when it retains nearly as much support
from the observed beats as the general fit.
Scores measure that grid after osu! offset and beat-length rounding.
The fitter regularizes beat times before creating the final timing points.
Continuously variable tracks use retained detections to choose the pulse and a
stronger penalty on abrupt tempo changes. Fixed-section tracks use a lighter
penalty that preserves sustained section boundaries. Fixed tracks still produce
a single precise grid. The Tempo smoothing slider adjusts the regression penalty
without rerunning beat detection; its default is 5.

Default fit settings match the app: `windowSize: 4`, `toleranceMs: 5`, and
`tempoSmoothness: 5`. The minimum
section length is `max(2, floor(windowSize / 2))` beats. The provisional fit
allows an isolated interior residual up to `20 + 2 * toleranceMs` milliseconds;
its average signed residual over eight beats must stay within `5 + toleranceMs`
milliseconds. The final fit scores all candidate sections by squared timing
error plus tempo-change costs. A case
can override these settings with
`"timingOptions": { "windowSize": 4, "toleranceMs": 5 }` in
the manifest. The settings and selected export text are saved in each result.

The benchmark reports the manifest's scale and phase. Its main score is
weighted F1 across one-to-one beat-matching tolerances of 3, 6, ..., 30 ms,
with normalized inverse-threshold weights of 1, 1/2, ..., 1/10. A beat can
match at most once per threshold. F1@20ms remains available for comparison
with older results. The benchmark also ranks alternative scales for diagnosis, but
does not use that ranking to choose the reported export. Metrics cover the mapped
span from the first hit object through the end of the last hit object, inclusive,
after the manifest's online offset is applied. The fitter still processes the full audio.
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
