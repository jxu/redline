# redline

redline is a browser-based prototype that generates a rough osu! timing map from
an audio file. Its output is intended as a starting point for manual timing.

Beat detection uses Beat This! Small (`small0`), exported to ONNX. Audio is
resampled to 22.05 kHz and converted to the model's 128-band log-mel spectrogram.
The model and audio processing remain local to the browser. Spectrogram generation
and inference run in a Web Worker; FFT.js and ONNX Runtime Web load from pinned
CDN URLs. WebGPU is preferred, with WASM fallback if initialization or inference
fails. The worker keeps its session loaded between analyses. First use can take
longer while the runtime loads and GPU shaders compile.

The included model, preprocessing coefficients, provenance, and upstream MIT
license are in `models/`. [Model conversion instructions](models/README.md)
describe how to regenerate the assets. The benchmark uses the production browser decoder
and worker, with compact corpus results in `benchmark/beat-this-small/summary.json`.

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
multiple sections of fixed BPM extends steady sections as long as the beat
evidence supports them. A warning appears if detected beats do not consistently
support a requested fixed BPM. Changing the selection after calculation refits
the export without rerunning beat detection. The ×2 and ÷2 controls preserve
the chosen beat level through subsequent timing fits.
Variable-tempo fits discourage large changes close together and suppress local
half/double-time switches. Sustained transitions to a different tempo remain
possible. A consistently wrong whole-song beat level still needs the ×2 or ÷2
control; inspect the click track after any automatic correction.

The Small-model browser benchmark covers the 25 original corpus maps. Its compact
scores are recorded in
[the benchmark summary](benchmark/beat-this-small/summary.json). Detailed results,
plots, and raw probability caches are generated locally and ignored by Git.

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
override `tempoScale` for the model so exports target the
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

Raw Beat This! beat and downbeat probabilities are saved in `benchmark/cache/probabilities/` on the first
run. Later runs reuse them, skipping audio decoding, spectrogram generation, and
model inference. Peak picking, filtering, and timing regression still
run with the current code and settings. The cache stores the full probability
curves at 20 ms frame spacing plus the audio duration and source sample rate;
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
dependency lockfile, browser backend, and Node runtime/platform. Changes to these inputs create a
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
For tracks marked multiple sections of fixed BPM, Redline also looks for
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
The browser benchmark writes best-octave results and plots under
`benchmark/beat-this-small/`; `--manifest-tempo` uses `benchmark/results/` and
`benchmark/plots/`.
Browser runs write their results and plots under `benchmark/beat-this-small/` (or the
chosen output directory), with a `summary.json` containing per-map scores,
settings, and changes from the previous run.
Edit a case's `comment` field to record observations; reruns preserve it.
`detectedBeatsMs` contains the evaluated export grid; raw, filtered, and interpolated
detections remain in separate fields for diagnosis. Charts show the export grid
alongside the reference and the intermediate detector beats, plus reference and
exported BPM as step lines over the same song-time axis.
Regenerate charts from the saved result files without rerunning inference with:

```bash
npm run benchmark:plot
```

The benchmark uses the browser decoder and production Beat This! Small worker,
then the same export function as the UI. Both shift the fitted timing points by
−27 ms; waveform markers and click playback follow that corrected export grid.
Raw beat probabilities and detections remain on their native timeline.

Install Chrome and the project dependencies, then run:

```bash
npm install
npm run benchmark -- 13012
npm run benchmark -- --backend webgpu 13012
npm run benchmark:regression -- 13012
```

WASM is the default benchmark backend. `--backend webgpu` requires actual WebGPU
execution and fails if the worker falls back. Set `REDLINE_BROWSER_EXECUTABLE` for
a custom Chrome path. In WSL, set `REDLINE_BROWSER_LAUNCHER` to a module exporting
`launchBenchmarkBrowser()` returning `{ browser, close }` for Windows Chrome.
The launcher must connect through Playwright and close its browser and any
connection tunnels when `close()` is called.
`--manifest path/to/manifest.json` selects another corpus (audio and osu paths are
relative to that manifest); `--output-dir path` selects its output folder.
Cached regression runs do not launch a browser. Browser backend and inference
source hashes separate cache entries; results record the browser version.
Refresh probabilities after upgrading the browser or changing devices.

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
- Validate additional browsers and devices for Beat This! Small inference.
