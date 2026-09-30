# Beat This! full with a fixed timestamp correction

These 25 results use the Beat This! `final0` checkpoint, the current Redline
timing fitter, and a fixed 27 ms earlier shift of exported red points. The shift
changes timing offsets, not the model probabilities, BPM curve, or timing-point
count. It was calibrated against 12 older variable-BPM maps after a consistent
late bias was observed, so the corpus comparison is not a blind holdout.

The mean weighted F1 across the 25 saved maps is 0.397, with a median of 0.402.
The ten maps added most recently have a median of 0.420. A good beat score does
not guarantee a useful tempo curve: Valkyrie Dimension, for example, still
misses its opening ramp. Inspect the BPM panels and expected mapping edits as
well as the alignment score.

Per-map JSON is in this directory; the corresponding 25 SVG charts are in
`../plots/`. Regenerate the charts with `npm run benchmark:plot`. Run the model
with `BEAT_THIS_PYTHON` pointing to an environment containing Beat This! 1.1.0
and CPU PyTorch, then `npm run benchmark:beat-this-full` or append `-- <mapset-id>`
for one map. The browser app still uses SENet.
