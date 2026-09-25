# radeef-face: internal face verification service

Used by the portal self clock-in (`/api/portal/attendance/punch`, `/api/portal/face`).

- **What it does:** receives one image and returns the number of faces, quality numbers, a
  passive liveness score and the 128-d SFace embedding of the single face. It stores nothing.
- **What it does not do:** matching. Radeef compares the embedding with the employee's
  encrypted template, so enrolled templates never leave Radeef.
- **Security:** it listens on `127.0.0.1` only (or the Docker bridge address), is never
  exposed by Nginx, and every request except `/health` needs
  `Authorization: Bearer $FACE_SERVICE_TOKEN`. Images are never written or logged.
- **Failure mode:** when the service is down or busy, Radeef rejects punches that need the
  face check (`FACE_SERVICE_UNAVAILABLE`). Employees can still file a correction request.

## API

`GET /health` returns `{"status": "ok", "models": {"liveness": true, ...}}`.

`POST /analyze` takes a multipart `image` field (JPEG / PNG / WebP, at most 3 MB) and returns:

```json
{ "faces": 1, "detScore": 0.97,
  "quality": { "faceRatio": 0.18, "blur": 210.4, "brightness": 121.0 },
  "liveness": { "score": 0.93 },
  "embedding": [0.0123, "...128 floats, L2-normalized"],
  "model": "sface_2021dec" }
```

`embedding` is `null` unless exactly one face is found. `liveness.score` is `null` when the
liveness models are missing, and Radeef then rejects the punch.

## Install

On a host (PM2 layout), `ops/face-setup.sh` does the following:
1. Creates `/opt/radeef/face/.venv`.
2. Installs `requirements.txt`.
3. Downloads the models.
4. Writes `/etc/radeef/services/face.env` with a random token. It must be a sub-folder, because every `/etc/radeef/*.env` is treated as a tenant.
5. Installs the `radeef-face` systemd unit.

On Docker, see the header of `Dockerfile`. Full procedure: `docs/RUNBOOK.md`, section
«خدمة التحقق من الوجه».

Before the first deployment, generate the liveness models once and commit them (see
`tools/convert_fasnet.py` and `models/MODELS.md`).

## Tests

```bash
cd services/face && pip install -r requirements.txt pytest httpx
python scripts/download_models.py && python -m pytest -q
```
