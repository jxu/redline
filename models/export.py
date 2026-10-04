"""Convert Beat This! Small to the ONNX assets used by the browser."""

import argparse
import hashlib
import json
from importlib.metadata import version
from pathlib import Path

import onnx
import torch
from beat_this.inference import Audio2Beats


class ExportModel(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, spectrogram):
        result = self.model(spectrogram)
        return result["beat"], result["downbeat"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    out = args.output_dir
    out.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(4)
    tracker = Audio2Beats("small0", device="cpu", dbn=False)
    model = ExportModel(tracker.model).eval()
    model_path = out / "beat-this-small.onnx"
    with torch.inference_mode():
        torch.onnx.export(
            model,
            torch.zeros(1, 263, 128),
            model_path,
            dynamo=False,
            input_names=["spectrogram"],
            output_names=["beat", "downbeat"],
            dynamic_axes={
                "spectrogram": {1: "frames"},
                "beat": {1: "frames"},
                "downbeat": {1: "frames"},
            },
            opset_version=17,
        )
    onnx.checker.check_model(str(model_path))
    # Export exact coefficients for the browser's independent FFT path.
    mel = tracker.spect.spect_class
    mel.mel_scale.fb.cpu().numpy().astype("<f4").tofile(out / "beat-this-mel-filter.f32")
    mel.spectrogram.window.cpu().numpy().astype("<f4").tofile(out / "beat-this-window.f32")
    checkpoint = Path(torch.hub.get_dir()) / "checkpoints" / "beat_this-small0.ckpt"
    metadata = {
        "checkpoint": "small0",
        "checkpointSha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
        "modelBytes": model_path.stat().st_size,
        "opset": 17,
        "versions": {name: version(name) for name in ("beat-this", "torch", "torchaudio", "onnx")},
        "preprocessing": {
            "sampleRate": 22050, "fftSize": 1024, "hopLength": 441,
            "melBands": 128, "power": 1, "normalized": "frame_length",
            "logMultiplier": 1000, "padding": "reflect",
        },
        "source": "https://github.com/CPJKU/beat_this",
        "onnxSha256": hashlib.sha256(model_path.read_bytes()).hexdigest(),
        "chunkFrames": 1500,
        "borderFrames": 6,
        "overlapMode": "keep_first",
        "input": {"name": "spectrogram", "shape": [1, "frames", 128]},
        "outputs": ["beat", "downbeat"],
    }
    (out / "beat-this-small.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"Exported browser model and preprocessing coefficients to {out}")


if __name__ == "__main__":
    main()
