"""Face analysis pipeline: detection (YuNet), embedding (SFace), passive liveness (MiniFASNet).

All models are licensed for commercial use (see ../models/MODELS.md). InsightFace models
(buffalo_l / ArcFace) are NOT used: their weights are for non-commercial research only.

Nothing is written to disk and images are never logged.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"
YUNET_FILE = "face_detection_yunet_2023mar.onnx"
SFACE_FILE = "face_recognition_sface_2021dec.onnx"
# MiniFASNet (Silent-Face-Anti-Spoofing), converted to ONNX by tools/convert_fasnet.py.
FASNET_FILES = (("fasnet_v2_2.7_80x80.onnx", 2.7), ("fasnet_v1se_4.0_80x80.onnx", 4.0))

MAX_SIDE = 640
DET_SCORE_MIN = 0.7
# Ignore tiny background faces when counting faces (fraction of the image area).
MIN_FACE_AREA_RATIO = 0.015
FASNET_SIZE = 80


@dataclass
class Analysis:
    faces: int
    det_score: float | None = None
    face_ratio: float | None = None
    blur: float | None = None
    brightness: float | None = None
    liveness: float | None = None
    embedding: list[float] | None = None

    def to_json(self) -> dict:
        return {
            "faces": self.faces,
            "detScore": self.det_score,
            "quality": {"faceRatio": self.face_ratio, "blur": self.blur, "brightness": self.brightness},
            "liveness": {"score": self.liveness},
            "embedding": self.embedding,
            "model": "sface_2021dec",
        }


class Pipeline:
    """Loads the models once; `analyze` is serialized per process (OpenCV DNN nets are not re-entrant)."""

    def __init__(self, models_dir: Path = MODELS_DIR) -> None:
        yunet = models_dir / YUNET_FILE
        sface = models_dir / SFACE_FILE
        for f in (yunet, sface):
            if not f.is_file():
                raise FileNotFoundError(f"missing model {f.name}: run scripts/download_models.py")
        self._detector = cv2.FaceDetectorYN.create(str(yunet), "", (320, 320), DET_SCORE_MIN, 0.3, 5000)
        self._recognizer = cv2.FaceRecognizerSF.create(str(sface), "")
        self._fasnets: list[tuple[object, float]] = []
        try:
            import onnxruntime as ort

            opts = ort.SessionOptions()
            opts.intra_op_num_threads = 1
            for name, scale in FASNET_FILES:
                path = models_dir / name
                if path.is_file():
                    self._fasnets.append((ort.InferenceSession(str(path), opts, providers=["CPUExecutionProvider"]), scale))
        except ImportError:  # pragma: no cover - onnxruntime is a declared dependency
            self._fasnets = []
        self._lock = threading.Lock()

    @property
    def liveness_available(self) -> bool:
        return len(self._fasnets) == len(FASNET_FILES)

    def status(self) -> dict:
        return {"detector": YUNET_FILE, "recognizer": SFACE_FILE, "liveness": self.liveness_available}

    def analyze(self, data: bytes) -> Analysis:
        img = decode_image(data)
        with self._lock:
            return self._analyze(img)

    def _analyze(self, img: np.ndarray) -> Analysis:
        h, w = img.shape[:2]
        self._detector.setInputSize((w, h))
        _, detections = self._detector.detect(img)
        if detections is None:
            return Analysis(faces=0)
        image_area = float(w * h)
        faces = [d for d in detections if d[14] >= DET_SCORE_MIN and (d[2] * d[3]) / image_area >= MIN_FACE_AREA_RATIO]
        if len(faces) != 1:
            return Analysis(faces=len(faces))

        face = faces[0]
        x, y, fw, fh = (float(v) for v in face[:4])
        x0, y0 = max(0, int(x)), max(0, int(y))
        x1, y1 = min(w, int(x + fw)), min(h, int(y + fh))
        gray = cv2.cvtColor(img[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY) if x1 > x0 and y1 > y0 else None

        aligned = self._recognizer.alignCrop(img, face)
        feature = self._recognizer.feature(aligned).reshape(-1).astype(np.float64)
        norm = float(np.linalg.norm(feature))
        embedding = (feature / norm).tolist() if norm > 0 else None

        return Analysis(
            faces=1,
            det_score=round(float(face[14]), 4),
            face_ratio=round((fw * fh) / image_area, 4),
            blur=round(float(cv2.Laplacian(gray, cv2.CV_64F).var()), 2) if gray is not None and gray.size else None,
            brightness=round(float(gray.mean()), 2) if gray is not None and gray.size else None,
            liveness=self._liveness(img, (x, y, fw, fh)),
            embedding=[round(v, 6) for v in embedding] if embedding else None,
        )

    def _liveness(self, img: np.ndarray, box: tuple[float, float, float, float]) -> float | None:
        """Probability (0..1) that the capture is a live face: MiniFASNet softmax averaged over both models."""
        if not self.liveness_available:
            return None
        total = np.zeros(3, dtype=np.float64)
        for session, scale in self._fasnets:
            patch = crop_scaled(img, box, scale, FASNET_SIZE)
            # Silent-Face feeds raw BGR values (0..255, no normalization) in CHW order.
            tensor = patch.transpose(2, 0, 1)[np.newaxis].astype(np.float32)
            name = session.get_inputs()[0].name  # type: ignore[attr-defined]
            logits = session.run(None, {name: tensor})[0][0]  # type: ignore[attr-defined]
            e = np.exp(logits - np.max(logits))
            total += e / e.sum()
        # Class 1 = real face (classes 0 and 2 are attack types).
        return round(float(total[1] / len(self._fasnets)), 4)


def decode_image(data: bytes) -> np.ndarray:
    """Decodes JPEG / PNG / WebP bytes to BGR and downsizes the longest side to MAX_SIDE."""
    buf = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("not a decodable image")
    h, w = img.shape[:2]
    if max(h, w) > MAX_SIDE:
        f = MAX_SIDE / float(max(h, w))
        img = cv2.resize(img, (max(1, int(w * f)), max(1, int(h * f))), interpolation=cv2.INTER_AREA)
    return img


def crop_scaled(img: np.ndarray, box: tuple[float, float, float, float], scale: float, size: int) -> np.ndarray:
    """Square-ish crop around the face box enlarged by `scale` (clamped to the image), resized to size x size.

    Same geometry as Silent-Face-Anti-Spoofing's CropImage (the models were trained on it).
    """
    src_h, src_w = img.shape[:2]
    x, y, bw, bh = box
    bw, bh = max(bw, 1.0), max(bh, 1.0)
    scale = min((src_h - 1) / bh, min((src_w - 1) / bw, scale))
    new_w, new_h = bw * scale, bh * scale
    cx, cy = x + bw / 2, y + bh / 2
    left, top = cx - new_w / 2, cy - new_h / 2
    right, bottom = cx + new_w / 2, cy + new_h / 2
    if left < 0:
        right -= left
        left = 0
    if top < 0:
        bottom -= top
        top = 0
    if right > src_w - 1:
        left -= right - src_w + 1
        right = src_w - 1
    if bottom > src_h - 1:
        top -= bottom - src_h + 1
        bottom = src_h - 1
    patch = img[int(top) : int(bottom) + 1, int(left) : int(right) + 1]
    return cv2.resize(patch, (size, size))
