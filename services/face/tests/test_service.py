"""Smoke tests (run from services/face: FACE_SERVICE_TOKEN=... python -m pytest -q).

They need the downloaded models (scripts/download_models.py); without them they are skipped.
Accuracy is not tested here: thresholds are calibrated on real captures during the pilot.
"""
from __future__ import annotations

import os
from pathlib import Path

import cv2
import numpy as np
import pytest

MODELS = Path(__file__).resolve().parent.parent / "models"
pytestmark = pytest.mark.skipif(
    not (MODELS / "face_detection_yunet_2023mar.onnx").is_file() or not (MODELS / "face_recognition_sface_2021dec.onnx").is_file(),
    reason="models not downloaded",
)

TOKEN = "t" * 40
os.environ["FACE_SERVICE_TOKEN"] = TOKEN


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app)


def jpeg(img: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".jpg", img)
    assert ok
    return buf.tobytes()


def test_health_is_open(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_analyze_requires_token(client):
    r = client.post("/analyze", files={"image": ("a.jpg", jpeg(np.zeros((64, 64, 3), np.uint8)), "image/jpeg")})
    assert r.status_code == 401
    r = client.post("/analyze", headers={"Authorization": "Bearer wrong"}, files={"image": ("a.jpg", b"x", "image/jpeg")})
    assert r.status_code == 401


def test_blank_image_has_no_face(client):
    r = client.post(
        "/analyze",
        headers={"Authorization": f"Bearer {TOKEN}"},
        files={"image": ("a.jpg", jpeg(np.full((480, 640, 3), 128, np.uint8)), "image/jpeg")},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["faces"] == 0
    assert body["embedding"] is None


def test_garbage_is_rejected(client):
    r = client.post("/analyze", headers={"Authorization": f"Bearer {TOKEN}"}, files={"image": ("a.jpg", b"not an image", "image/jpeg")})
    assert r.status_code == 400


def test_crop_scaled_stays_inside_the_image():
    from app.pipeline import crop_scaled

    img = np.zeros((100, 120, 3), np.uint8)
    patch = crop_scaled(img, (100.0, 80.0, 30.0, 30.0), 4.0, 80)
    assert patch.shape == (80, 80, 3)
