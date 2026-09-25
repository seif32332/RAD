"""One-time conversion of the MiniFASNet liveness models (PyTorch) to ONNX.

Run ONCE on a development machine (not on the server), then commit the two .onnx files in
../models together with the Apache-2.0 notice (models/LICENSE-Silent-Face-Anti-Spoofing.txt):

    python -m venv .venv-convert && . .venv-convert/bin/activate      # Windows: .venv-convert\\Scripts\\activate
    pip install torch --index-url https://download.pytorch.org/whl/cpu
    pip install deepface onnx
    python tools/convert_fasnet.py

Source: minivision-ai/Silent-Face-Anti-Spoofing (Apache-2.0). The network definitions and the
weight mirror are taken from the `deepface` package (MIT), which ships the same MiniFASNet
backbone and downloads the original weights on first use.

The script checks that ONNX Runtime reproduces the PyTorch outputs before writing the files.
"""
from __future__ import annotations

from collections import OrderedDict
from pathlib import Path

import numpy as np
import torch

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"
TARGETS = (
    # (class name in deepface's FasNetBackbone, weight file in ~/.deepface/weights, output name)
    ("MiniFASNetV2", "2.7_80x80_MiniFASNetV2.pth", "fasnet_v2_2.7_80x80.onnx"),
    ("MiniFASNetV1SE", "4_0_0_80x80_MiniFASNetV1SE.pth", "fasnet_v1se_4.0_80x80.onnx"),
)


def ensure_weights() -> Path:
    """Lets deepface download the original weights (it knows the mirror) and returns their folder."""
    from deepface.models.spoofing.FasNet import Fasnet  # noqa: F401  (downloads on construction)

    Fasnet()
    return Path.home() / ".deepface" / "weights"


def load(cls_name: str, weights: Path) -> torch.nn.Module:
    from deepface.models.spoofing import FasNetBackbone

    model = getattr(FasNetBackbone, cls_name)(conv6_kernel=(5, 5))
    state = torch.load(weights, map_location="cpu")
    if next(iter(state)).startswith("module."):
        state = OrderedDict((k[len("module.") :], v) for k, v in state.items())
    model.load_state_dict(state)
    return model.eval()


def main() -> None:
    import onnxruntime as ort

    weights_dir = ensure_weights()
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    sample = torch.randint(0, 256, (1, 3, 80, 80)).float()
    for cls_name, weight_file, out_name in TARGETS:
        model = load(cls_name, weights_dir / weight_file)
        out = MODELS_DIR / out_name
        torch.onnx.export(model, sample, str(out), input_names=["input"], output_names=["logits"], opset_version=13)
        with torch.no_grad():
            expected = model(sample).numpy()
        got = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"]).run(None, {"input": sample.numpy()})[0]
        if not np.allclose(expected, got, atol=1e-3):
            raise SystemExit(f"{out_name}: ONNX output differs from PyTorch")
        print(f"wrote {out} (verified against PyTorch)")


if __name__ == "__main__":
    main()
