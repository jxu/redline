import assert from "node:assert/strict";
import test from "node:test";
import { inferSpectrogram } from "../beat-this-inference.js";

test("chunk borders, shifted final chunk and keep_first overlap preserve each frame", async () => {
    const calls = [];
    class Tensor {
        constructor(type, data, dims) {
            this.data = data;
            this.dims = dims;
        }
        dispose() {}
    }
    const session = {
        run: async ({ spectrogram: t }) => {
            calls.push(t.dims[1]);
            assert.ok(t.dims[1] <= 1500);
            const v = Float32Array.from(
                { length: t.dims[1] },
                (_, i) => t.data[i * 128],
            );
            return {
                beat: new Tensor("float32", v),
                downbeat: new Tensor("float32", v),
            };
        },
    };
    for (const n of [1, 251, 1488, 1489, 1501, 4718]) {
        const data = new Float32Array(n * 128);
        for (let i = 0; i < n; i++) data[i * 128] = Math.sin(i / 100);
        const r = await inferSpectrogram({ Tensor }, session, {
            data,
            frameCount: n,
        });
        assert.equal(r.probabilities.length, n);
        for (let i = 0; i < n; i++)
            assert.ok(
                Math.abs(
                    r.probabilities[i] - 1 / (1 + Math.exp(-data[i * 128])),
                ) < 1e-7,
                `frame ${i}/${n}`,
            );
    }
    assert.ok(calls.length > 6);
});
