import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";
// Reuse an existing browser launcher via a caller-supplied module; no machine paths are stored here.
if (!process.env.REDLINE_BROWSER_LAUNCHER)
    throw new Error(
        "Set REDLINE_BROWSER_LAUNCHER to a module exporting launchBenchmarkBrowser",
    );
const { launchBenchmarkBrowser } = await import(
    pathToFileURL(resolve(process.env.REDLINE_BROWSER_LAUNCHER))
);
const root = resolve(".");
const server = createServer(async (req, res) => {
    try {
        const path = resolve(
            root,
            "." +
                decodeURIComponent(
                    new URL(req.url, "http://localhost").pathname,
                ),
        );
        if (!path.startsWith(root + "/")) {
            res.writeHead(403).end();
            return;
        }
        const data = await readFile(path);
        const type =
            {
                ".js": "text/javascript",
                ".html": "text/html",
                ".json": "application/json",
            }[extname(path)] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": type });
        res.end(data);
    } catch {
        res.writeHead(404).end();
    }
});
await new Promise((r) => server.listen(0, "0.0.0.0", r));
let connection;
const results = [];
try {
    connection = await launchBenchmarkBrowser();
    for (const provider of process.argv.slice(2).length
        ? process.argv.slice(2)
        : ["webgpu", "wasm"]) {
        const page = await connection.browser.newPage();
        page.on("console", (message) => {
            if (message.type() === "error")
                console.error(message.text().slice(0, 1000));
        });
        page.on("pageerror", (error) => console.error(error.message));
        try {
            await page.goto(
                `http://localhost:${server.address().port}/test/beat-this-browser-smoke.html`,
            );
            await page.waitForFunction(() => window.ready, null, {
                timeout: 60000,
            });
            console.log(`Testing ${provider}`);
            const detection = await page.evaluate(
                (provider) => window.validate(provider),
                provider,
            );
            const fixtureRoot = "benchmark/beat-this-browser/artifacts/";
            const load = async (name) => {
                const b = await readFile(fixtureRoot + name);
                return new Float32Array(
                    b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
                );
            };
            const reference = JSON.parse(
                await readFile(fixtureRoot + "full-reference.json", "utf8"),
            );
            const error = (a, b) =>
                a.reduce((max, v, i) => Math.max(max, Math.abs(v - b[i])), 0);
            const result = {
                provider,
                backend: detection.backend,
                frames: detection.probabilities.length,
                timings: detection.timings,
                beatError: error(
                    detection.probabilities,
                    await load("full-beat.f32"),
                ),
                downbeatError: error(
                    detection.downbeatProbabilities,
                    await load("full-downbeat.f32"),
                ),
                identicalBeats:
                    JSON.stringify(detection.ticks) ===
                    JSON.stringify(reference.ticks),
                identicalDownbeats:
                    JSON.stringify(detection.downbeats) ===
                    JSON.stringify(reference.downbeats),
                beatCount: detection.ticks.length,
                browserDecodedSamples: detection.browserDecodedSamples,
                pcmSamples: detection.pcmSamples,
                timingPointCount: detection.timingPointCount,
            };
            assert.ok(result.beatError <= 1e-4);
            assert.ok(result.downbeatError <= 1e-4);
            assert.ok(result.identicalBeats);
            assert.ok(result.identicalDownbeats);
            assert.ok(result.timingPointCount > 0);
            assert.equal(result.frames, reference.frames);
            assert.equal(result.backend, provider);
            result.passed = true;
            results.push(result);
            console.log(JSON.stringify(result));
        } catch (error) {
            results.push({ provider, error: error.message });
            console.error(`${provider}: ${error.message}`);
        } finally {
            await page.close();
        }
        await writeFile(
            "benchmark/beat-this-browser/full-track-browser.json",
            JSON.stringify(
                {
                    mapsetId: JSON.parse(
                        await readFile(
                            "benchmark/beat-this-browser/artifacts/fixtures.json",
                            "utf8",
                        ),
                    ).mapsetId,
                    probabilityTolerance: 1e-4,
                    exported: JSON.parse(
                        await readFile(
                            "benchmark/beat-this-browser/artifacts/fixtures.json",
                            "utf8",
                        ),
                    ),
                    results,
                },
                null,
                2,
            ) + "\n",
        );
    }
} finally {
    await connection?.close();
    await new Promise((r) => server.close(r));
}

if (results.some((result) => !result.passed)) process.exitCode = 1;
