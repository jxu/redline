# Beat This! final0 comparison

This experiment runs the official Beat This! `final0` checkpoint through
Redline's beat filtering, gap interpolation, mapper-supplied tempo scale and
pattern, fitted tempo curve, osu! timing-point export, and exported-grid
scoring. Beat This! 1.1.0 uses its native minimal postprocessor without a DBN.
FFmpeg decodes to 22,050 Hz mono, and the model produces beats and beat
probabilities at 50 fps. The fitter now uses the full beat-probability curve
at its native 20 ms frame step. The saved SENet results use the same fitter
version and provide the same reference grid, evaluation window, and duration.
Reference `.osu` timing never enters inference or chooses the reported export's
tempo scale.

The eight variable-BPM songs are the primary comparison. The Beatles and The
Who are representative live recordings; Disconnected Hardkore is a particularly
hard stress case. F1 matches exported beats one-to-one within 17.5% of the
median reference beat interval. Median error is the nearest-reference distance
for each exported beat, so a higher F1 can coexist with less precise placement.

| Mapset | Pattern | final0 F1 before → after | final0 median error (ms) before → after | SENet F1 after | SENet median error (ms) after |
| --- | --- | ---: | ---: | ---: | ---: |
| 1670652 Beatles | Continuous | 0.968 → 0.971 | 26.4 → 25.0 | 0.919 | 11.6 |
| 2470141 Prom Queen | Continuous | 0.961 → 0.961 | 16.6 → 15.1 | 0.883 | 10.6 |
| 2302704 Won't Get Fooled Again | Continuous | 0.915 → 0.916 | 12.9 → 13.0 | 0.742 | 17.7 |
| 2605182 Welcome to the Jungle | Continuous | 0.964 → 0.966 | 26.8 → 29.0 | 0.683 | 29.3 |
| 30485 Disconnected Hardkore | Sections | 0.108 → 0.093 | 81.4 → 84.4 | 0.724 | 14.0 |
| 65923 Roaming Legendary Pokemon | Sections | 0.984 → 0.995 | 31.4 → 34.0 | 0.963 | 48.7 |
| 2521355 Anthem | Sections | 0.518 → 0.520 | 43.7 → 42.5 | 0.464 | 58.0 |
| 545156 Loose Change | Sections | 0.733 → 0.700 | 36.4 → 37.2 | 0.939 | 3.9 |

For the four continuously variable songs, final0's mean F1 changes only from
**0.952 to 0.953**, and mean per-song median error from **20.7 to 20.5 ms**.
The Beatles improves slightly; The Who is effectively unchanged. Fixed-section
mean F1 declines from **0.586 to 0.577**, with particularly poor results on
Disconnected Hardkore and Loose Change. This does not establish a useful
benefit from probability fitting for final0. It leaves the larger model's
stronger pulse tracking on live music and SENet's closer timing on the Beatles
as separate observations.

The older `small0` result files still use pipeline version 0.1.1 and are not
included in this fitted-probability comparison. Fixed-BPM songs remain a bonus:
final0 reaches 1.000 F1 on Tornado and Ai no Sukima, but only 0.746 on So Deep.

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
