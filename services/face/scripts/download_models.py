"""Downloads the detection / recognition models into ../models and verifies their SHA-256.

Usage:  python scripts/download_models.py

The liveness models (MiniFASNet) are produced once by tools/convert_fasnet.py and committed to
the repository; they are not downloaded here.

Pinned checksums: on the first real download, if a checksum below is still empty, the script
prints the computed value; review the file's origin, then pin it here (a changed file must
never be accepted silently).
"""
from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"

MODELS = [
    {
        "file": "face_detection_yunet_2023mar.onnx",
        "url": "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
        "sha256": "",  # pin after the first reviewed download
        "license": "MIT (opencv_zoo)",
    },
    {
        "file": "face_recognition_sface_2021dec.onnx",
        "url": "https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
        "sha256": "",  # pin after the first reviewed download
        "license": "Apache-2.0 (opencv_zoo)",
    },
]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    failed = False
    for m in MODELS:
        target = MODELS_DIR / m["file"]
        if not target.is_file():
            print(f"downloading {m['file']} ({m['license']})")
            tmp = target.with_suffix(".part")
            urllib.request.urlretrieve(m["url"], tmp)  # noqa: S310 - fixed https URLs above
            tmp.replace(target)
        digest = sha256(target)
        if not m["sha256"]:
            print(f"UNPINNED {m['file']}: sha256={digest}  -> review, then pin it in scripts/download_models.py")
        elif digest != m["sha256"]:
            print(f"CHECKSUM MISMATCH {m['file']}: expected {m['sha256']}, got {digest}", file=sys.stderr)
            target.unlink()
            failed = True
        else:
            print(f"ok {m['file']}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
