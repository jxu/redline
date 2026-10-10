import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, relative, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));

// The benchmark page calls the same decoder and worker client as the UI.
export async function createBrowserRuntime(backend = "wasm") {
    const server = createServer(async (request, response) => {
        try {
            const path = resolve(root, "." + decodeURIComponent(new URL(request.url, "http://localhost").pathname));
            if (!path.startsWith(root + "/")) {
                response.writeHead(403).end();
                return;
            }
            const data = await readFile(path);
            response.writeHead(200, { "Content-Type": {
                ".js": "text/javascript", ".html": "text/html", ".json": "application/json",
            }[extname(path)] ?? "application/octet-stream" });
            response.end(data);
        } catch {
            response.writeHead(404).end();
        }
    });
    let connection, page;
    const close = async () => {
        await connection?.close();
        if (server.listening) await new Promise(resolve => server.close(resolve));
    };
    try {
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "0.0.0.0", resolve);
        });
        if (process.env.REDLINE_BROWSER_LAUNCHER) {
            const launcher = await import(pathToFileURL(resolve(process.env.REDLINE_BROWSER_LAUNCHER)));
            connection = await launcher.launchBenchmarkBrowser();
        } else {
            const { chromium } = await import("playwright-core");
            const browser = await chromium.launch({
                ...(process.env.REDLINE_BROWSER_EXECUTABLE
                    ? { executablePath: process.env.REDLINE_BROWSER_EXECUTABLE }
                    : { channel: "chrome" }),
                headless: true,
            });
            connection = { browser, close: () => browser.close() };
        }
        page = await connection.browser.newPage();
        page.on("pageerror", error => console.error(error.message));
        const origin = `http://localhost:${server.address().port}`;
        await page.goto(origin + "/benchmark/browser-runner.html");
        await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
        return {
            close,
            async analyze(audioPath) {
                const path = relative(root, audioPath);
                if (path.startsWith("..") || path.startsWith("/")) throw new Error("Benchmark audio must be inside the repository");
                const result = await page.evaluate(
                    ({ url, backend }) => window.analyzeAudio(url, backend),
                    { url: origin + "/" + path.split("/").map(encodeURIComponent).join("/"), backend },
                );
                if (result.backend !== backend) throw new Error(`Requested ${backend}, received ${result.backend}`);
                return { ...result, browserVersion: connection.browser.version() };
            },
        };
    } catch (error) {
        await close();
        throw error;
    }
}
