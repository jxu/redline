# Large and Small Beat This: best-octave benchmark

Recorded on 2026-10-01 with the octave-limited 0.8.0 fitter. Both models ran full inference on the original 25 maps, with the same reference grids, timing options, -27 ms offset, and global octave choices (0.5, 1, 2, including both halving phases). The reference chooses the highest weighted-F1 candidate, modeling a mapper selecting a beat level. Local sections are fitted without reference assistance. Configured-octave scores remain in each result.

| Metric | Large (`final0`) | Small (`small0`) |
| --- | ---: | ---: |
| Mean weighted F1 | 0.4516 | 0.4634 |
| Median weighted F1 | 0.4648 | 0.4741 |
| Mean F1 at 20 ms | 0.7516 | 0.7473 |
| Configured-octave mean weighted F1 | 0.4509 | 0.4620 |

Small wins on 13 of 25 maps. The paired mean Small-minus-Large weighted-F1 difference is +0.0118; an exploratory paired bootstrap 95% interval is [-0.0284, +0.0508], and a two-sided paired sign-flip permutation gives p=0.568. The corpus is small and selected, so this is evidence about these maps, not a population-wide equivalence claim. Probability accuracy, local BPM curves and per-song failure modes matter beyond aggregate scores. Browser inference speed was not measured.

| Group | Maps | Large weighted F1 | Small weighted F1 |
| --- | ---: | ---: | ---: |
| Continuous | 10 | 0.4155 | 0.4495 |
| Sections excluding Hardkore | 11 | 0.5284 | 0.5198 |
| Fixed | 3 | 0.3395 | 0.3275 |
| Beatles and The Who | 5 | 0.3734 | 0.4110 |

Largest per-map differences (Large → Small):

- SON OF KICK - Hours ft. Lady Leshurr & Paigey Cakey [Gangsta Collab]: 0.450 → 0.207 (-0.243).
- Royal Blood - Loose Change [$]: 0.578 → 0.774 (+0.196).
- The Who - Won't Get Fooled Again [Nothing Ever Happens]: 0.276 → 0.462 (+0.186).
- Beach Bunny - Prom Queen [I love you however you are]: 0.391 → 0.546 (+0.155).
- Arctic Monkeys - Balaclava [Extreme]: 0.615 → 0.470 (-0.145).
- Silvertear - So Deep (Perfect Sphere Remix) [Heavy]: 0.055 → 0.179 (+0.124).

Previous recorded baselines used configured octaves and the earlier fitter, so gains combine octave selection with timing changes.

- Small: historical configured mean 0.4557; current configured mean 0.4620; current best-octave mean 0.4634.
- Full: historical configured mean 0.4531; current configured mean 0.4509; current best-octave mean 0.4516.

Results and plots are in this directory and `../beat-this-large/`. `comparison.json` has grouped scores, per-map octaves, prior-baseline comparisons and paired statistical diagnostics. All 50 result/plot pairs were verified; older benchmark result folders have been removed; their aggregate scores remain in the comparison.

```bash
BEAT_THIS_PYTHON=.venv/bin/python npm run benchmark:beat-this-full
BEAT_THIS_PYTHON=.venv/bin/python npm run benchmark:beat-this-small
node benchmark/compare-beat-this.js
```

Use `--manifest-tempo` with the benchmark runners for configured-scale mode; use `--output-dir` to keep an additional experiment separate.
