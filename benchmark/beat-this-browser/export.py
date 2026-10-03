"""Export Beat This Small and reference fixtures for browser validation."""
import argparse, hashlib, json, time
from pathlib import Path
from importlib.metadata import version
import numpy as np
import torch
import onnx
from beat_this.inference import Audio2Beats

parser = argparse.ArgumentParser()
parser.add_argument('--artifacts', type=Path, default=Path(__file__).parent / 'artifacts')
args = parser.parse_args()
out = args.artifacts
out.mkdir(parents=True, exist_ok=True)
torch.set_num_threads(4)
tracker = Audio2Beats('small0', device='cpu', dbn=False)

class ExportModel(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model
    def forward(self, spectrogram):
        result = self.model(spectrogram)
        return result['beat'], result['downbeat']

model = ExportModel(tracker.model).eval()
samples = np.fromfile(out / 'audio.f32', dtype='<f4')
fixtures = []
with torch.inference_mode():
    for seconds in (5, 30):
        pcm = samples[:seconds * 22050]
        spect = tracker.signal2spect(pcm, 22050)
        # Same six-frame boundary padding as the official chunked inference.
        padded = torch.nn.functional.pad(spect, (0, 0, 6, 6)).unsqueeze(0)
        name = f'{seconds}s'
        spect.numpy().astype('<f4').tofile(out / f'{name}-spect.f32')
        timings = []
        for _ in range(3):
            started = time.perf_counter()
            beat, downbeat = model(padded)
            timings.append((time.perf_counter() - started) * 1000)
        beat[0].numpy().astype('<f4').tofile(out / f'{name}-beat.f32')
        downbeat[0].numpy().astype('<f4').tofile(out / f'{name}-downbeat.f32')
        fixtures.append({'name': name, 'seconds': len(pcm)/22050, 'frames': len(spect), 'inputFrames': padded.shape[1], 'pytorchInferenceMs': timings})
    full_samples = np.fromfile(out / 'full-audio.f32', dtype='<f4')
    full_beat, full_downbeat = tracker.spect2frames(tracker.signal2spect(full_samples, 22050))
    full_ticks, full_downbeats = tracker.frames2beats(full_beat, full_downbeat)
    full_beat.sigmoid().numpy().astype('<f4').tofile(out / 'full-beat.f32')
    full_downbeat.sigmoid().numpy().astype('<f4').tofile(out / 'full-downbeat.f32')
    (out / 'full-reference.json').write_text(json.dumps({'ticks':full_ticks.tolist(), 'downbeats':full_downbeats.tolist(), 'frames':len(full_beat), 'seconds':len(full_samples)/22050}))
    dummy = torch.zeros(1, 263, 128)
    torch.onnx.export(model, dummy, out / 'small0.onnx', dynamo=False,
        input_names=['spectrogram'], output_names=['beat', 'downbeat'],
        dynamic_axes={'spectrogram': {1: 'frames'}, 'beat': {1: 'frames'}, 'downbeat': {1: 'frames'}},
        opset_version=17)
onnx.checker.check_model(str(out / 'small0.onnx'))
# Store exact trained filter/window values for the independent JS FFT path.
mel = tracker.spect.spect_class
mel.mel_scale.fb.cpu().numpy().astype('<f4').tofile(out / 'mel-filter.f32')
mel.spectrogram.window.cpu().numpy().astype('<f4').tofile(out / 'window.f32')
checkpoint = Path(torch.hub.get_dir()) / 'checkpoints' / 'beat_this-small0.ckpt'
metadata = {'mapsetId': json.loads((out/'audio.json').read_text())['mapsetId'], 'checkpoint': 'small0', 'checkpointSha256': hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
    'modelBytes': (out/'small0.onnx').stat().st_size, 'opset': 17,
    'versions': {name:version(name) for name in ('beat-this','torch','torchaudio','onnx')},
    'fixtures': fixtures, 'preprocessing': {'sampleRate':22050,'fftSize':1024,'hopLength':441,'melBands':128,'power':1,'normalized':'frame_length','logMultiplier':1000,'padding':'reflect'}}
(out / 'fixtures.json').write_text(json.dumps(metadata, indent=2)+'\n')
print(json.dumps(metadata, indent=2))
