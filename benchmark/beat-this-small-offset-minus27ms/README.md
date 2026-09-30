# Beat This! small versus full

Evaluated all 25 corpus maps on 2026-09-30 using Beat This! 1.1.0, CPU PyTorch 2.11.0+cpu, four inference threads, and the current 0.7.0 Redline timing pipeline. The small run uses `small0`; the comparison uses the saved `final0` results in `../results/`. Reference grids, evaluation spans, mapper tempo scales/phases, timing settings, and the fixed −27 ms export correction match, as checked by `../compare-beat-this.js`.

**Recommendation: offer Small (smaller download) and Full when Beat This! is integrated into the browser.** Small preserves overall benchmark quality with a much smaller checkpoint. Keep Full available because individual tracks regress, especially music with tempo sections. The browser currently uses SENet; this evaluation does not add a browser selector.

| Metric | Small | Full |
| --- | ---: | ---: |
| Checkpoint bytes | 8,451,101 | 81,058,141 |
| Parameters | 2,099,960 | 20,251,712 |
| Mean weighted F1, all 25 maps | 0.456 | 0.453 |
| Median weighted F1 | 0.475 | 0.462 |
| Mean F1@20 ms | 0.734 | 0.748 |
| Mean weighted F1, 10 continuous tempo maps | 0.450 | 0.416 |
| Mean weighted F1, 11 section maps excluding Hardkore | 0.503 | 0.532 |
| Mean weighted F1, 5 Beatles/The Who maps | 0.411 | 0.373 |

Small wins weighted F1 on 13 of 25 maps. Its checkpoint is 89.6% smaller (8.45 MB versus 81.06 MB, decimal units). These are PyTorch checkpoint sizes; actual browser downloads depend on the ONNX export, precision, compression, and runtime assets. Browser inference speed and WebGPU compatibility were not measured.

Scores evaluate the final exported grid against ranked osu! timing, with normalized inverse-threshold weights across 3, 6, ..., 30 ms. Mapper tempo inputs are shared and are not chosen by maximizing the reference score. The −27 ms correction was previously calibrated using corpus maps, so this is not a blind holdout or evidence of a significant overall accuracy difference. A good alignment score does not guarantee a correct BPM curve: both models flatten Loose Change and Valkyrie Dimension to one timing point in these settings, and Anthem remains fragmented. Use the BPM panels to inspect mapping usefulness.

Disconnected Hardkore is a separate stress case: weighted F1 improves from 0.305 to 0.377 with Small, while timing points increase from 18 to 31. Representative improvements include The Who (0.276 to 0.461) and Prom Queen (0.391 to 0.546). Regressions include Hours (0.445 to 0.188), Balaclava (0.616 to 0.468), and Welcome to the Jungle (0.537 to 0.449).

## Per-map comparison

| Map | Small weighted F1 | Full weighted F1 | Delta | Small / full timing points |
| --- | ---: | ---: | ---: | ---: |
| [The Beatles - It Won't Be Long [Yeah]](plots/1670652-beat-alignment.svg) | 0.487 | 0.511 | -0.023 | 23 / 25 |
| [Agressor Bunx - Tornado (Original Mix) [Insane]](plots/236292-beat-alignment.svg) | 0.621 | 0.712 | -0.091 | 1 / 1 |
| [Silvertear - So Deep (Perfect Sphere Remix) [Heavy]](plots/13012-beat-alignment.svg) | 0.179 | 0.055 | +0.124 | 1 / 1 |
| [umu. - Ai no Sukima [Howling]](plots/1371996-beat-alignment.svg) | 0.183 | 0.252 | -0.069 | 1 / 1 |
| [Beach Bunny - Prom Queen [I love you however you are]](plots/2470141-beat-alignment.svg) | 0.546 | 0.391 | +0.155 | 27 / 25 |
| [Inspector K - Disconnected Hardkore (CanBlaster Remix) [Insane]](plots/30485-beat-alignment.svg) | 0.377 | 0.305 | +0.072 | 31 / 18 |
| [The Who - Won't Get Fooled Again [Nothing Ever Happens]](plots/2302704-beat-alignment.svg) | 0.461 | 0.276 | +0.186 | 91 / 86 |
| [Junichi Masuda - Battle! Roaming Legendary Pokemon [Irre's Landorus]](plots/65923-beat-alignment.svg) | 0.606 | 0.688 | -0.082 | 12 / 14 |
| [Bring Me The Horizon - Anthem [nihil's orvtoris]](plots/2521355-beat-alignment.svg) | 0.330 | 0.228 | +0.103 | 72 / 77 |
| [Guns N' Roses - Welcome To The Jungle [Appetite For Destruction]](plots/2605182-beat-alignment.svg) | 0.449 | 0.537 | -0.089 | 49 / 52 |
| [Royal Blood - Loose Change [$]](plots/545156-beat-alignment.svg) | 0.634 | 0.636 | -0.001 | 1 / 1 |
| [ORDEN OGAN - Come With Me To The Other Side (feat. Liv Kristine) [Eternal Light]](plots/1052267-beat-alignment.svg) | 0.475 | 0.463 | +0.012 | 29 / 19 |
| [The Beatles - Here Comes The Sun [Comfort]](plots/1588934-beat-alignment.svg) | 0.477 | 0.462 | +0.015 | 33 / 37 |
| [The Beatles - Yesterday [Insane]](plots/1819703-beat-alignment.svg) | 0.267 | 0.252 | +0.014 | 21 / 20 |
| [The Beatles - In My Life (2023 Mix) [Remembrance]](plots/2519265-beat-alignment.svg) | 0.362 | 0.367 | -0.005 | 22 / 21 |
| [Arctic Monkeys - I Bet You Look Good on the Dancefloor [Insane]](plots/39217-beat-alignment.svg) | 0.615 | 0.531 | +0.084 | 40 / 39 |
| [Spriggan - Valkyrie Dimension [Insane]](plots/45935-beat-alignment.svg) | 0.694 | 0.753 | -0.059 | 1 / 2 |
| [Stufff - Spooky Scary Skrilletons [2Spooky]](plots/124311-beat-alignment.svg) | 0.436 | 0.402 | +0.034 | 11 / 11 |
| [SON OF KICK - Hours ft. Lady Leshurr & Paigey Cakey [Gangsta Collab]](plots/274111-beat-alignment.svg) | 0.188 | 0.445 | -0.257 | 27 / 32 |
| [Arctic Monkeys - Balaclava [Extreme]](plots/298913-beat-alignment.svg) | 0.468 | 0.616 | -0.148 | 22 / 19 |
| [Streetlight Manifesto - The Blonde Lead The Blind [Extra]](plots/376545-beat-alignment.svg) | 0.518 | 0.582 | -0.064 | 30 / 28 |
| [Streetlight Manifesto - Everything Went Numb [Extreme]](plots/414289-beat-alignment.svg) | 0.678 | 0.598 | +0.079 | 14 / 19 |
| [Streetlight Manifesto - A Better Place, A Better Time [Extra]](plots/458195-beat-alignment.svg) | 0.507 | 0.439 | +0.068 | 58 / 54 |
| [Static-X - Skinnyman [FCL's Six miles high]](plots/2052208-beat-alignment.svg) | 0.536 | 0.569 | -0.032 | 45 / 44 |
| [Sonata Arctica - Wolf & Raven (Cut Ver.) [Dread]](plots/2242178-beat-alignment.svg) | 0.298 | 0.260 | +0.039 | 39 / 31 |

## Reproduce

From the repository root, with `BEAT_THIS_PYTHON` pointing to an environment containing the versions above:

```bash
npm run benchmark:beat-this-small
node benchmark/compare-beat-this.js
```

An optional mapset ID follows `npm run benchmark:beat-this-small --`. All 25 maps must be present to regenerate `comparison.json`. Per-map JSON retains raw beats, downbeats, filtered/interpolated beats, exported timing points, candidate scores, checkpoint SHA256, and package versions. SVGs include alignment and BPM panels.
