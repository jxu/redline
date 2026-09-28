# Beat This! final0 comparison

This experiment runs the official Beat This! `final0` checkpoint through the
same Redline benchmark path as `small0` and SENet: beat filtering, gap
interpolation, mapper-supplied tempo scale and pattern, fitted tempo curve,
osu! timing-point export, and exported-grid scoring. Beat This! 1.1.0 uses
its native minimal postprocessor without a DBN. FFmpeg decodes to 22,050 Hz
mono, and the model produces beats on a 50-fps frame grid. The saved SENet
results provide the same reference grid, evaluation window, and duration for
all three detectors. Reference `.osu` timing never enters inference or chooses
the reported export's tempo scale.

The eight variable-BPM songs are the primary comparison. The Beatles and The
Who are representative live recordings; Disconnected Hardkore is a particularly
hard stress case. F1 matches exported beats one-to-one within 17.5% of the
median reference beat interval. Median error is the nearest-reference distance
for each exported beat, so a higher F1 can coexist with less precise placement.

| Mapset | Pattern | final0 F1 | small0 F1 | SENet F1 | final0 median error (ms) | small0 median error (ms) | SENet median error (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1670652 Beatles | Continuous | 0.968 | 0.986 | 0.916 | 26.4 | 34.2 | 10.8 |
| 2470141 Prom Queen | Continuous | 0.961 | 0.949 | 0.883 | 16.6 | 25.4 | 8.7 |
| 2302704 Won't Get Fooled Again | Continuous | 0.915 | 0.849 | 0.725 | 12.9 | 25.7 | 20.7 |
| 2605182 Welcome to the Jungle | Continuous | 0.964 | 0.896 | 0.698 | 26.8 | 35.2 | 36.1 |
| 30485 Disconnected Hardkore | Sections | 0.108 | 0.164 | 0.745 | 81.4 | 81.9 | 14.0 |
| 65923 Roaming Legendary Pokemon | Sections | 0.984 | 0.960 | 0.949 | 31.4 | 34.9 | 53.7 |
| 2521355 Anthem | Sections | 0.518 | 0.555 | 0.437 | 43.7 | 42.2 | 61.7 |
| 545156 Loose Change | Sections | 0.733 | 0.837 | 0.951 | 36.4 | 23.1 | 5.2 |

On the four continuously variable tracks, `final0` improves mean F1 to
**0.952**, versus **0.920** for `small0` and **0.805** for SENet. Mean per-song
median error is **20.7 ms**, versus **30.1 ms** and **19.0 ms** respectively.
The Who is the clearest gain: `final0` reaches 0.915 F1 and 12.9 ms median
error, compared with 0.849 / 25.7 ms for `small0` and 0.725 / 20.7 ms for
SENet. On the Beatles track, `small0` has slightly higher F1, but `final0`
improves timing precision; SENet remains more precise there.

On the four fixed-section songs, SENet leads in mean F1 (**0.770**) over
`small0` (**0.629**) and `final0` (**0.586**). `final0` is worse on the
Disconnected Hardkore stress case (0.108 F1), and it also loses ground on
Loose Change. Across all eight variable songs, mean F1 is **0.769** for
`final0`, **0.774** for `small0`, and **0.788** for SENet. These aggregates
should be read with the per-song differences, especially the live tracks.

Fixed-BPM results are a bonus: all three models score 1.000 F1 on Tornado and
Ai no Sukima, while `final0` scores 0.751 on So Deep versus 1.000 for both
`small0` and SENet. They do not determine the recommendation for variable BPM.

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
