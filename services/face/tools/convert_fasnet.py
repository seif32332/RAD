"""One-time conversion of the MiniFASNet liveness models (PyTorch) to ONNX.

Run ONCE on a development machine (not on the server), then commit the two .onnx files in
../models together with the Apache-2.0 notice (models/LICENSE-Silent-Face-Anti-Spoofing.txt):

    # 1. the original project (network code + weights), Apache-2.0
    curl -L -o silent-face.zip https://codeload.github.com/minivision-ai/Silent-Face-Anti-Spoofing/zip/refs/heads/master
    unzip silent-face.zip                       # -> Silent-Face-Anti-Spoofing-master/
    # 2. a throw-away virtualenv with PyTorch (CPU) + ONNX
    python -m venv .venv-convert && . .venv-convert/bin/activate     # Windows: .venv-convert\\Scripts\\activate
    pip install torch --index-url https://download.pytorch.org/whl/cpu
    pip install onnx onnxruntime numpy
    # 3. convert (from services/face)
    python tools/convert_fasnet.py --silent-face ../path/to/Silent-Face-Anti-Spoofing-master

The script checks that ONNX Runtime reproduces the PyTorch outputs before writing the files.
Preprocessing expected by the models (same as the original project): BGR, CHW, float, NOT divided
by 255, 80x80 crop of the face box enlarged 2.7x (V2) / 4.0x (V1SE); output = 3 logits, class 1 = live.
"""
from __future__ import annotations

import argparse
import sys
from collections import OrderedDict
from pathlib import Path

import numpy as np
import torch

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"
TARGETS = (
    # (network factory in src/model_lib/MiniFASNet.py, original weight file, ONNX output)
    ("MiniFASNetV2", "2.7_80x80_MiniFASNetV2.pth", "fasnet_v2_2.7_80x80.onnx"),
    ("MiniFASNetV1SE", "4_0_0_80x80_MiniFASNetV1SE.pth", "fasnet_v1se_4.0_80x80.onnx"),
)
KERNEL_80 = ((80 + 15) // 16, (80 + 15) // 16)  # src/utility.py get_kernel(80, 80) == (5, 5)


def load(repo: Path, factory: str, weight_file: str) -> torch.nn.Module:
    sys.path.insert(0, str(repo))
    from src.model_lib import MiniFASNet  # type: ignore[import-not-found]

    model = getattr(MiniFASNet, factory)(conv6_kernel=KERNEL_80)
    state = torch.load(repo / "resources" / "anti_spoof_models" / weight_file, map_location="cpu")
    if next(iter(state)).startswith("module."):
        state = OrderedDict((k[len("module.") :], v) for k, v in state.items())
    model.load_state_dict(state)
    return model.eval()


def export(model: torch.nn.Module, sample: torch.Tensor, out: Path) -> None:
    kwargs = dict(input_names=["input"], output_names=["logits"], opset_version=13)
    try:
        torch.onnx.export(model, sample, str(out), dynamo=False, **kwargs)  # TorchScript exporter
    except TypeError:  # older torch without the `dynamo` argument
        torch.onnx.export(model, sample, str(out), **kwargs)


def main() -> None:
    import onnxruntime as ort

    parser = argparse.ArgumentParser()
    parser.add_argument("--silent-face", required=True, type=Path, help="folder of the Silent-Face-Anti-Spoofing checkout")
    repo = parser.parse_args().silent_face.resolve()
    if not (repo / "src" / "model_lib" / "MiniFASNet.py").is_file():
        raise SystemExit(f"{repo} is not a Silent-Face-Anti-Spoofing checkout")

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(0)
    sample = torch.randint(0, 256, (1, 3, 80, 80)).float()
    for factory, weight_file, out_name in TARGETS:
        model = load(repo, factory, weight_file)
        out = MODELS_DIR / out_name
        export(model, sample, out)
        with torch.no_grad():
            expected = torch.softmax(model(sample), dim=1).numpy()
        logits = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"]).run(None, {"input": sample.numpy()})[0]
        got = np.exp(logits - logits.max(axis=1, keepdims=True))
        got = got / got.sum(axis=1, keepdims=True)
        if not np.allclose(expected, got, atol=1e-4):
            raise SystemExit(f"{out_name}: ONNX output differs from PyTorch")
        print(f"wrote {out} ({out.stat().st_size} bytes), verified against PyTorch")


if __name__ == "__main__":
    main()
