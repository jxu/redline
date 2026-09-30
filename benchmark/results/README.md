# Beat This! full with a fixed timestamp correction

These 25 results use the Beat This! `final0` checkpoint, the current Redline
timing fitter, and a fixed 27 ms earlier shift of exported red points. The shift
changes timing offsets, not the model probabilities, BPM curve, or timing-point
count. It was calibrated against 12 older variable-BPM maps after a consistent
late bias was observed, so the corpus comparison is not a blind holdout.

Pipeline version 0.7.0 preserves an explicitly chosen half/double tempo through
the final timing fit. The two Streetlight maps now export near 270–276 BPM
instead of roughly 135 BPM. Beat This! already detects Yesterday and In My Life
near their mapper-intended 100 BPM, so they use 1× rather than the 0.5× choice
needed for SENet. Skinnyman instead needs 2×: its raw detections are near
91 BPM while the mapper's beat level is near 183 BPM. Valkyrie Dimension and
Loose Change also benefit from 2×, although Valkyrie's opening ramp and Loose
Change's later tempo change remain poorly fitted. Orden Ogan and Spooky Scary
Skrilletons have partial half-time regions that a single 2× choice did not fix.

The mean weighted F1 across the 25 saved maps is 0.453, with a median of 0.462.
The ten maps added most recently have a median of 0.550. A good beat score does
not guarantee a useful tempo curve. Inspect the BPM panels and expected mapping
edits as well as the alignment score.

Per-map JSON is in this directory; the corresponding 25 SVG charts are in
`../plots/`. Regenerate the charts with `npm run benchmark:plot`. Run the model
with `BEAT_THIS_PYTHON` pointing to an environment containing Beat This! 1.1.0
and CPU PyTorch, then `npm run benchmark:beat-this-full` or append `-- <mapset-id>`
for one map. The browser app still uses SENet.
