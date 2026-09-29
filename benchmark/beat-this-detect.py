"""Run Beat This! and retain its native beat times and frame probabilities."""

import hashlib
import json
import os
import subprocess
import sys
from contextlib import redirect_stdout
from importlib.metadata import version
from pathlib import Path

import numpy as np
import torch
from beat_this.inference import Audio2Beats


def main(audio_path):
    # Decode explicitly because torchaudio's available file backends vary by
    # platform. Audio2Beats still performs the model's own mel preprocessing.
    decoded = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", audio_path, "-ac", "1", "-ar", "22050",
         "-f", "f32le", "-acodec", "pcm_f32le", "-"],
        check=True, capture_output=True,
    )
    samples = np.frombuffer(decoded.stdout, dtype="<f4")
    checkpoint = os.environ.get("BEAT_THIS_CHECKPOINT", "small0")
    threads = int(os.environ.get("BEAT_THIS_THREADS", "4"))
    torch.set_num_threads(threads)
    # torch.hub prints its first-download notice to stdout. Keep stdout JSON-only
    # for the Node benchmark runner.
    with redirect_stdout(sys.stderr):
        tracker = Audio2Beats(checkpoint_path=checkpoint, device="cpu", dbn=False)
    beat_logits, downbeat_logits = tracker.spect2frames(
        tracker.signal2spect(samples, 22050)
    )
    beats, downbeats = tracker.frames2beats(beat_logits, downbeat_logits)
    checkpoint_sha256 = None
    checkpoint_file = Path(checkpoint)
    if not checkpoint_file.is_file() and checkpoint in ("small0", "final0"):
        checkpoint_file = (
            Path(torch.hub.get_dir()) / "checkpoints" / f"beat_this-{checkpoint}.ckpt"
        )
    if checkpoint_file.is_file():
        digest = hashlib.sha256()
        with checkpoint_file.open("rb") as file:
            for chunk in iter(lambda: file.read(1024 * 1024), b""):
                digest.update(chunk)
        checkpoint_sha256 = digest.hexdigest()
    print(json.dumps({
        "ticks": [float(beat) for beat in beats],
        "downbeats": [float(beat) for beat in downbeats],
        "beatProbabilities": beat_logits.sigmoid().tolist(),
        "probabilityFrameMs": 20,
        "durationMs": len(samples) / 22.05,
        "checkpoint": os.path.basename(checkpoint),
        "checkpointSha256": checkpoint_sha256,
        "beatThisVersion": version("beat-this"),
        "torchVersion": torch.__version__,
        "threads": threads,
    }))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: beat-this-detect.py AUDIO_FILE")
    main(sys.argv[1])
