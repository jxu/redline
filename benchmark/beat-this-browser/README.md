# Beat This Small browser ONNX experiment

Beat This! `small0` runs in Windows Chrome 154 with ONNX Runtime Web 1.30.0,
using either WebGPU or WASM. Both tested lengths passed a maximum absolute
beat/downbeat probability error tolerance of `0.0001` against PyTorch.
The browser computes its own log-mel spectrogram using FFT.js and the exact
filter/window coefficients exported from torchaudio.

Recorded on 2026-10-02 using the first 5 and 30 seconds of mapset 13012
(So Deep). WebGPU used the Intel `gen-12lp` adapter and executed 10,000 GPU
compute dispatches across the validation runs. Some graph operations run on CPU.
The ONNX model is 10,401,061 bytes (about 9.9 MiB).

| Measurement | WebGPU | WASM, one thread |
| --- | ---: | ---: |
| Session initialization | 9.45 s | 10.80 s |
| First 5-second inference after initialization | 12.60 s | 1.90 s |
| Warm 5-second inference, all subsequent runs | 0.23–0.26 s | 1.06–1.52 s |
| First 30-second inference, after 5-second runs | 8.42 s | 12.24 s |
| Subsequent 30-second inference | 2.44–4.90 s | 9.68–10.49 s |
| Maximum probability error, either output/input mode | <0.000096 | <0.000008 |

Browser mel preprocessing took 0.14–0.15 s for 5 seconds and 0.45–0.69 s
for 30 seconds. Those times are separate from inference above. Measurements
include only a few runs on one machine and are not general speed guarantees.
JS heap snapshots were approximately 10–11 MB; these exclude GPU and WASM
allocations and do **not** establish total or peak memory use.

[validation.json](validation.json) contains all measurements and comparisons.
The browser app now uses this model with official chunking and minimal peak
postprocessing. The original excerpt experiment covers decoded mono PCM,
spectrogram generation, and model logits/probabilities. Its original results do not validate full-track chunk aggregation; subsequent
full-track results are recorded separately below.
The 30-second test deliberately uses 1,513 padded frames to check a second
input length; the official inference pipeline normally uses chunks of at most
1,500 frames with six-frame borders. The production worker reproduces that chunking; its complete-track comparison
is recorded below.

## Reproduce

From the repository root, create an ignored virtual environment (or one outside
the repository) and install Python 3.10-compatible dependencies:

```bash
python3.10 -m venv .venv
.venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu 'torch==2.11.0+cpu' 'torchaudio==2.11.0+cpu'
.venv/bin/pip install 'beat-this==1.1.0' 'onnx==1.23.1' 'rotary-embedding-torch==0.9.1'
npm install
node benchmark/beat-this-browser/prepare-audio.js
.venv/bin/python benchmark/beat-this-browser/export.py
```

The exporter downloads the original `small0` checkpoint and writes the ONNX
model, PCM, coefficients, and reference fixtures into ignored `artifacts/`.
The checkpoint SHA-256 is
`6074be2c4d490c5f6101fcc374a1ec72ae93456e23bb6019783b849f5dc7d47b`.
The legacy opset-17 export emits tracing warnings; the two tested frame counts
agree with independent PyTorch references, but arbitrary shapes are unverified.

The validator accepts a browser-launcher module exporting
`launchBenchmarkBrowser()`, returning `{ browser, close }` with a Playwright
browser and cleanup function. The existing `webgpu-benchmarks` branch contains
such a launcher plus Windows/WSL launch scripts. Keep those three files together
and install `playwright-core` in the launcher's environment. Point the validator
to that module using a relative path:

```bash
REDLINE_BROWSER_LAUNCHER=path/to/browser-connection.js node benchmark/beat-this-browser/validate-full-track.js
```

It tests the production worker with WebGPU then WASM, writes
`full-track-browser.json`, and fails if probability error exceeds the tolerance,
beat/downbeat times differ from Python, or the requested backend is not used.
An individual provider can be selected with a trailing `webgpu` or `wasm`.
The harness starts a temporary local HTTP server and an isolated browser; it
loads pinned ONNX Runtime Web and FFT.js modules from CDNs.

## Production worker, full-track validation

The 94.35-second So Deep track was compared against Python Beat This! 1.1.0
using official 1,500-frame chunks, six-frame borders, keep-first overlaps,
and minimal beat/downbeat postprocessing. All 4,718 frames were checked.

| Path | Max beat probability error | Max downbeat probability error | Beat/downbeat times |
| --- | ---: | ---: | --- |
| Node ONNX CPU | 0.00001276 | 0.00000471 | Identical: 221 beats, 57 downbeats |
| Browser worker WebGPU | 0.00009549 | 0.00003034 | Identical: 221 beats, 57 downbeats |
| Browser worker WASM | 0.00001442 | 0.00000554 | Identical: 221 beats, 57 downbeats |

Both browser paths decoded the expected 2,080,512 samples at 22,050 Hz
and produced a nine-point timing export. Probability comparisons use the same
Node-decoded PCM as Python, independently of the browser decode sample-count
check. They do not establish sample-for-sample decoder equality.
Cold worker analysis took 50.15 s with WebGPU and 60.52 s with WASM on this
machine; Node analysis took 11.28 s. Other local checks ran concurrently, so
these timings establish completion rather than a controlled speed comparison.
Full measurements are in [full-track-browser.json](full-track-browser.json)
and [full-track-node.json](full-track-node.json).

The model session remains loaded for subsequent uploads. Initialization or
inference errors on WebGPU trigger WASM fallback. Audio, model buffers, and
spectrograms stay local; the runtime/FFT modules load from CDNs.

## Current corpus benchmark

`npm run benchmark` now runs the production browser decoder and worker. WASM is
used by default; add `-- --backend webgpu` to require WebGPU. Scoring and the UI
share `timing-export.js`, including the −27 ms correction after fitting.
The Python inference runners have been removed; `export.py` remains the ONNX
conversion and reference-fixture tool. The measurements above are historical
model validation results, not scores for the corrected export.
