# Browser benchmark verification

So Deep (mapset 13012), Chrome 154.0.8037.93, WASM, recorded 2026-10-02.
The production browser decoder and worker processed the complete 94.35-second
track and 4,718 frames. Export scoring uses the shared -27 ms correction.
Weighted F1: 0.137139; F1 at 20 ms: 0.301299. This single-track result is not a
corpus score or a speed comparison. Detailed local results and plots are ignored.

Reproduce from the repository root:

```bash
npm run benchmark -- --output-dir benchmark/browser-results 13012
npm run benchmark:regression -- --output-dir benchmark/browser-results 13012
```

A custom Windows/WSL browser launcher can be selected with
`REDLINE_BROWSER_LAUNCHER`; see the main README. The cached repeat skips browser
launch and reproduces the corrected export and score.
