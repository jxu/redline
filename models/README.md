# Browser model assets

`export.py` converts the upstream Beat This! `small0` checkpoint into the ONNX
model, exact mel-filter/window coefficients, and provenance JSON used by the
browser. It does not run a Python benchmark or generate parity fixtures.

Use Python 3.10 with the recorded conversion dependencies:

```bash
python3.10 -m venv .venv
.venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu 'torch==2.11.0+cpu' 'torchaudio==2.11.0+cpu'
.venv/bin/pip install 'beat-this==1.1.0' 'onnx==1.23.1' 'rotary-embedding-torch==0.9.1'
.venv/bin/python models/export.py --output-dir /tmp/redline-model-export
```

The exporter downloads the checkpoint to the PyTorch cache if needed. Review the
generated assets before replacing the four matching files in `models/`; verify
changes with the production browser benchmark. The upstream MIT license is
retained in `beat-this-LICENSE`.
