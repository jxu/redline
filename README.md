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
the export without rerunning beat detection. The ×2 and ÷2 controls preserve
the chosen beat level through subsequent timing fits.
Variable-tempo fits discourage large changes close together and suppress local
half/double-time switches. Sustained transitions to a different tempo remain
possible. A consistently wrong whole-song beat level still needs the ×2 or ÷2
control; inspect the click track after any automatic correction.

The recorded Small-model benchmark for this fitter is in
[Small benchmark](benchmark/beat-this-small/README.md),
with compact summaries for all 25 original corpus maps. Detailed results and plots
are generated locally and ignored by Git.

## Test

Run the calculation tests with:

```bash
npm test
```

## Benchmark

Place each exact audio and `.osu` pair under a folder named after its `.osz`
archive (without the `.osz` extension), then add its actual file paths to
`benchmark/manifest.json`, including a `tempoPattern` of
`fixed`, `continuous`, or `sections`. This is normally the mapper-supplied
choice. Cases classified from their reference `.osu` file set
`tempoPatternSource` to `reference-osu` so those results are identifiable. Set
`tempoScale` to the mapper's octave choice (`0.5`, `1`, or `2`) and, when
halving, `tempoPhase` to `0` or `1`. `allowedTempoScales` lists alternatives
to try. By default the reference scores select the best global octave and phase;
`--manifest-tempo` retains the configured choice instead.
When the detectors start at different beat levels, `beatThisTempoScale` can
override the SENet-oriented choice for Beat This! so both exports target the
same mapper-intended pulse. An explicit half/double selection is preserved by
the fitter instead of being silently reversed.
`genre` uses one of osu!'s broad music categories, based on the beatmapset
listing or the `.osu` tags when that listing is misleading.
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
full track. The final fit pays for timing error, unmatched detections or grid
beats, each new section, and tempo changes. It can revise a section's beat count
instead of bending the tempo to accommodate extra or missed detections. A steep
penalty on accumulated absolute BPM movement over a few seconds suppresses both
sudden spikes and excursions split into several smaller changes. Sustained tempo
changes can still win when the beat evidence supports them. Candidate scoring uses
the same rounded offsets and beat lengths as the export. The general fit starts
each new section on a beat of the previous section. The waveform markers and click track follow the exported grid.
Exported red timing points are limited to 300 BPM.
For tracks marked variable BPM with fixed sections, Redline also looks for
persistent tempo changes in long-span beat intervals and fits a steady grid to
each run. It uses that simpler export when it retains nearly as much support
from the observed beats as the general fit.
Scores measure that grid after osu! offset and beat-length rounding.
The fitter regularizes beat times before creating the final timing points.
Continuously variable tracks use retained detections to choose the pulse and a
strong penalty on abrupt tempo changes, favoring gradual BPM drift. Fixed-section
tracks use a lighter penalty that preserves sustained section boundaries. Fixed
tracks still produce a single precise grid. The Beat-time smoothing slider adjusts
the earlier beat-time regression without rerunning beat detection. Its default is
0 for continuously variable tracks, leaving the final BPM fit to smooth the grid,
and 5 for other patterns.

Default fit settings match the app: `windowSize: 4`, with `tempoSmoothness: 0`
and `toleranceMs: 6` for continuously variable tracks or `tempoSmoothness: 5`
and `toleranceMs: 5` for other patterns. The minimum
section length is `max(2, floor(windowSize / 2))` beats. The provisional fit
allows an isolated interior residual up to `20 + 2 * toleranceMs` milliseconds;
its average signed residual over eight beats must stay within `5 + toleranceMs`
milliseconds. The final fit scores all candidate sections by squared timing
error plus tempo-change costs. A case
can override these settings with
`"timingOptions": { "windowSize": 4, "toleranceMs": 5 }` in
the manifest. The settings and selected export text are saved in each result.

The benchmark reports the best allowed global scale and phase by default, labeled
`reference-best-octave` in the result. This models a mapper choosing ×2 or ÷2
after listening; it is reference-assisted rather than automatic tempo selection.
Use `--manifest-tempo` for the configured scale and phase. Its main score is
weighted F1 across one-to-one beat-matching tolerances of 3, 6, ..., 30 ms,
with normalized inverse-threshold weights of 1, 1/2, ..., 1/10. A beat can
match at most once per threshold. F1@20ms remains available for comparison
with older results. Only a global octave and halving phase are selected; local
tempo sections are fitted without the reference. Metrics cover the mapped
span from the first through the last rhythmic hit object, including slider tails
but excluding spinner-only intros or outros, after the manifest's online offset
is applied. The fitter still processes the full audio.
The SENet benchmark writes best-octave results and plots under
`benchmark/best-octave/`; `--manifest-tempo` uses `benchmark/results/` and
`benchmark/plots/`.
The retained summary is the latest Small Beat This! run, using
best-octave selection and the −27 ms timestamp correction. Running either benchmark command again replaces
the local results and plots for the selected mapsets. Each run updates a tracked
`summary.json` with per-map scores, settings, and changes from the previous run.
Edit a case's `comment` field to record observations; reruns preserve it.
`detectedBeatsMs` contains the evaluated export grid; raw, filtered, and interpolated
detections remain in separate fields for diagnosis. Charts show the export grid
alongside the reference and the intermediate detector beats, plus reference and
exported BPM as step lines over the same song-time axis.
Regenerate charts from the saved result files without rerunning inference with:

```bash
npm run benchmark:plot
```

To run the Beat This! Small model against the corpus, install Python 3.10,
CPU PyTorch, and Beat This! 1.1.0 in a separate environment:

```bash
python3.10 -m venv /tmp/redline-beat-this
/tmp/redline-beat-this/bin/pip install --index-url https://download.pytorch.org/whl/cpu 'torch==2.11.0+cpu' 'torchaudio==2.11.0+cpu'
/tmp/redline-beat-this/bin/pip install beat-this==1.1.0
BEAT_THIS_PYTHON=/tmp/redline-beat-this/bin/python npm run benchmark:beat-this-small
```

An optional mapset ID follows `--`. Beat This! uses the same audio decoder,
mapper tempo input, fitter, exported-grid scoring, and evaluation window as the
SENet benchmark. Its native 20 ms beat probabilities enter the fitter at that
frame spacing. Maps whose detectors choose different beat levels use
`beatThisTempoScale` in the manifest. The default run applies the −27 ms
timestamp correction. The compact summary is saved to
`benchmark/beat-this-small/summary.json`; detailed results and plots remain
local and ignored by Git. Each case includes its configured-octave score.
Use `--manifest-tempo` to retain the configured-scale behavior.
Set `BEAT_THIS_PYTHON` to your installed environment.
The browser app continues to use SENet.

Render the ranked and final exported grids as click tracks mixed with the corpus audio:

```bash
npm run benchmark:listen -- 236292
```

Pass an additional offset in milliseconds to render a third ranked-grid variant:

```bash
npm run benchmark:listen -- 236292 10
```

The WAV files are written under `benchmark/listening/<mapset-id>/`.

## TODO

- Let users adjust the final timing-grid/BPM smoothing separately from the existing beat-time smoothing slider.
- Let users adjust the global timing offset of the exported red points.
- Add Beat This! Small to the browser after validating a browser-compatible model export.
