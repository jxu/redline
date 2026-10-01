# Beat This Small benchmark

Recorded on 2026-10-01 on the original 25-map corpus using `small0`, the 0.8.0 timing fitter, and a -27 ms export offset. The benchmark tries half, normal, and double tempo, including both halving phases. Reference scores select the best global octave; local timing sections are fitted without the reference. Configured-octave scores remain available for comparison.

Mean weighted F1 is 0.4634; mean F1 at 20 ms is 0.7473. The browser continues to use SENet.

`summary.json` contains per-map scores, model and evaluation settings, octave choices, timing-point counts, and comments. Future runs record score changes against the previous summary and preserve each case's `comment` field. Per-threshold weighted-F1 arrays are omitted.

Detailed timing grids and SVG plots are generated locally in `results/` and `plots/`, which Git ignores. Only the Small benchmark summary and documentation are retained.

```bash
BEAT_THIS_PYTHON=.venv/bin/python npm run benchmark:beat-this-small
```

Use `--manifest-tempo` for configured-octave selection and `--output-dir` to isolate an additional experiment. Review tempo curves and click tracks when available: an aggregate score can hide local errors or a consistently wrong pulse level.
