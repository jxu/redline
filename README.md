# redline

redline is a browser-based prototype that generates a rough osu! timing map from
an audio file. Its output is intended as a starting point for manual timing.

## Run locally

Install the development dependency and start the static server:

```bash
npm install
npm run dev
```

Open <http://localhost:8080> in a browser. The development command disables
caching so changes are visible after a refresh. A local HTTP server is required
because the app loads JavaScript modules and WebAssembly in the browser.

## Test

Run the calculation tests with:

```bash
npm test
```
