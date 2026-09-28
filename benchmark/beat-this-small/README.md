# Beat This! small0 comparison

This experiment replaces SENet detections with the official Beat This! `small0`
checkpoint, using Beat This! 1.1.0 on CPU. FFmpeg decodes the corpus audio to
22,050 Hz mono. The model's native 50-fps, no-DBN beat output then passes through
Redline's existing spurious-beat filter, gap interpolation, mapper-supplied tempo
scale and pattern, fitted tempo curve, osu! timing-point export, and exported-grid
scoring. The saved SENet results supply the same reference grids, evaluation
windows, and audio durations. The reference `.osu` never enters model inference
or selects the reported export's tempo scale.

F1 is one-to-one exported-beat matching within 17.5% of the median reference
beat interval. Median error is the absolute distance from an exported beat to
its nearest reference beat. Both matter for mapping: F1 can improve while
individual beat placement becomes less precise.

| Mapset | Pattern | Beat This! F1 | SENet F1 | Beat This! median error (ms) | SENet median error (ms) | Beat This! / SENet red points |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1670652 Beatles | Continuous | 0.986 | 0.916 | 34.2 | 10.8 | 24 / 34 |
| 236292 Tornado | Fixed | 1.000 | 1.000 | 22.2 | 15.4 | 1 / 1 |
| 13012 So Deep | Fixed | 1.000 | 1.000 | 16.8 | 10.4 | 1 / 1 |
| 1371996 Ai no Sukima | Fixed | 1.000 | 1.000 | 44.9 | 27.6 | 1 / 1 |
| 2470141 Prom Queen | Continuous | 0.949 | 0.883 | 25.4 | 8.7 | 25 / 29 |
| 30485 Disconnected Hardkore | Sections | 0.164 | 0.745 | 81.9 | 14.0 | 41 / 72 |
| 2302704 Won't Get Fooled Again | Continuous | 0.849 | 0.725 | 25.7 | 20.7 | 103 / 176 |
| 65923 Roaming Legendary Pokemon | Sections | 0.960 | 0.949 | 34.9 | 53.7 | 17 / 16 |
| 2521355 Anthem | Sections | 0.555 | 0.437 | 42.2 | 61.7 | 134 / 179 |
| 2605182 Welcome to the Jungle | Continuous | 0.896 | 0.698 | 35.2 | 36.1 | 56 / 83 |
| 545156 Loose Change | Sections | 0.837 | 0.951 | 23.1 | 5.2 | 9 / 30 |

Across the eight variable-tempo songs, mean F1 is **0.774** for Beat This! and
**0.788** for SENet. Beat This! leads on all four continuously variable songs
(mean **0.920** versus **0.805**), while SENet leads on fixed-section songs
(mean **0.770** versus **0.629**). All three fixed-BPM songs score 1.000 F1 for
both detectors, though SENet has lower median error on each. Beat This! exports
412 red timing points across the corpus versus SENet's 622.

Beat This! fails badly on Disconnected Hardkore: the selected `1×` grid scores
0.164 F1, and even the diagnostic `2×` candidate reaches only 0.206. The
reference cannot be used to select that candidate in a real workflow. The
Beatles and Prom Queen grids illustrate the opposite caveat: Beat This! wins
by F1 but has larger median timing error. Listen to exported clicks and inspect
the BPM plots before treating an F1 difference as a mapping improvement.

The checkpoint is [Beat This! small0](https://github.com/CPJKU/beat_this#available-models),
SHA-256 `6074be2c4d490c5f6101fcc374a1ec72ae93456e23bb6019783b849f5dc7d47b`.
The authors say `small0` was trained on all their datasets except GTZAN. We have
not established whether any corpus audio overlaps that training data, so these
results describe this mapping workflow rather than an independent generalization
test. Reproduction instructions are in the project README. Per-song JSON and
SVG plots are under `results/` and `plots/` here.
