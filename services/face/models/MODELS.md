# Models used by the face verification service

All models are licensed for commercial use. **Do not add InsightFace models** (buffalo_l,
antelopev2, ArcFace weights from the insightface model zoo): the InsightFace README states that
its pretrained models are "for non-commercial research purposes only".

| File | Purpose | Source | License | How it gets here |
|---|---|---|---|---|
| `face_detection_yunet_2023mar.onnx` | Face detection + 5 landmarks | [opencv_zoo/face_detection_yunet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) | MIT | `python scripts/download_models.py` (checksum pinned in the script) |
| `face_recognition_sface_2021dec.onnx` | 128-d face embedding (cosine similarity) | [opencv_zoo/face_recognition_sface](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface) | Apache-2.0 | `python scripts/download_models.py` |
| `fasnet_v2_2.7_80x80.onnx`, `fasnet_v1se_4.0_80x80.onnx` | Passive liveness (live face vs. photo / screen) | [minivision-ai/Silent-Face-Anti-Spoofing](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing) | Apache-2.0 (modified: converted to ONNX) | `python tools/convert_fasnet.py`, run once and committed |

Notes
- The embedding model defines `FaceProfile.model` (`sface_2021dec`). Replacing it invalidates all
  enrolled templates: plan a re-enrollment (the reference photos are kept for that purpose).
- SFace is less accurate than state-of-the-art non-commercial models; thresholds are settings in
  Radeef (attendance_face_*_pct) and must be calibrated during the pilot.
- Passive liveness (one still image) raises the bar against printed photos and screens; it is
  not a certified presentation-attack detection and must not be marketed as tamper-proof.
- The ONNX conversion of the MiniFASNet weights is a modification under Apache-2.0 section 4:
  keep `LICENSE-Silent-Face-Anti-Spoofing.txt` next to the files and this note stating the change.
