# Beat This! final0 comparison at 20 ms

This experiment runs the official Beat This! `final0` checkpoint through
Redline's beat filtering, gap interpolation, mapper-supplied tempo scale and
pattern, fitted tempo curve, osu! timing-point export, and exported-grid
scoring. Beat This! 1.1.0 uses its native minimal postprocessor without a DBN.
FFmpeg decodes to 22,050 Hz mono, and the model produces beats and beat
probabilities at 50 fps. The fitter uses the full beat-probability curve
at its native 20 ms frame step. The saved SENet results use the same fitter
and F1@20ms scorer (pipeline 0.2.1), reference grid, evaluation window, and duration.
Reference `.osu` timing never enters inference or chooses the reported export's
tempo scale.

The eight variable-BPM songs are the primary comparison. The Beatles and The
Who are representative live recordings; Disconnected Hardkore is a particularly
hard stress case. F1@20ms matches exported beats one-to-one within 20 ms, so
both false positives and missed beats count. Median error measures each
exported beat's distance to its nearest reference beat.

| Mapset | Pattern | SENet F1@20ms | final0 F1@20ms | SENet median error (ms) | final0 median error (ms) | Red points SENet / final0 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1670652 Beatles | Continuous | 0.748 | 0.332 | 11.6 | 25.0 | 32 / 23 |
| 2470141 Prom Queen | Continuous | 0.756 | 0.662 | 10.6 | 15.1 | 28 / 24 |
| 2302704 Won't Get Fooled Again | Continuous | 0.533 | 0.662 | 17.7 | 13.0 | 150 / 91 |
| 2605182 Welcome to the Jungle | Continuous | 0.343 | 0.216 | 29.3 | 29.0 | 72 / 48 |
| 30485 Disconnected Hardkore | Sections | 0.602 | 0.031 | 14.0 | 84.4 | 68 / 32 |
| 65923 Roaming Legendary Pokemon | Sections | 0.025 | 0.102 | 48.7 | 34.0 | 16 / 14 |
| 2521355 Anthem | Sections | 0.286 | 0.152 | 58.0 | 42.5 | 165 / 158 |
| 545156 Loose Change | Sections | 0.913 | 0.028 | 3.9 | 37.2 | 28 / 32 |

On continuously variable songs, mean per-song F1@20ms is **0.595 for SENet**
and **0.468 for final0**. final0 leads on The Who, while SENet leads clearly
on the Beatles. On fixed-section songs, the means are **0.456** and **0.078**;
final0 struggles especially on Disconnected Hardkore and Loose Change. The
Pokemon case has low strict F1 for both despite high scores with the old broad
tolerance, because their grids have systematic offsets of tens of milliseconds.

Only scoring changed in this comparison: cached SENet regression and a new
final0 inference run reproduced their previous exported grids exactly. The
older `small0` result files still use pipeline version 0.1.1 and the broad F1
tolerance, so their stored F1 values
cannot be compared directly. Fixed-BPM songs remain a bonus; the stricter score
is zero for final0 on all three fixed-BPM cases despite its previously high
broad-tolerance F1.

F1@20ms also counts a uniformly shifted grid as wrong, even when a mapper could
repair it with one global offset. Read the score alongside median error and the
BPM plots when judging how much editing an export would require.

On this CPU machine with four PyTorch threads, detector-only runs including
Python startup and decoding took 9.68 seconds for `final0` versus 6.77 seconds
for `small0` on the 136-second Beatles track, and 27.47 versus 18.78 seconds
on the 511-second Who track. The larger model is about 1.4 times slower in
these two trials. The `final0` checkpoint is 81,058,141 bytes, SHA-256
`8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331`.
It has six layers and transformer width 512; `small0` has six layers and width
128. Both output at 50 fps.

The [Beat This! authors](https://github.com/CPJKU/beat_this#available-models)
say these models were trained on all their datasets except GTZAN. We have not
established whether this corpus overlaps their training data, so these scores
describe this mapping workflow rather than an independent generalization test.
Reproduction instructions are in the project README. Per-song JSON and SVG
plots are under `results/` and `plots/` here.
