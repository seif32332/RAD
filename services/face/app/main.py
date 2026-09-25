"""Internal face verification service for Radeef self clock-in.

- Bound to 127.0.0.1 (or the Docker bridge address) and never exposed by Nginx.
- Every request except /health needs `Authorization: Bearer $FACE_SERVICE_TOKEN`.
- Stateless: receives one image, returns face count, quality, liveness and the embedding.
  Matching against enrolled templates happens in Radeef, so templates never come here.
- Images are processed in memory only and are never written or logged.
"""
from __future__ import annotations

import hmac
import logging
import os
from pathlib import Path

from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse

from .pipeline import Pipeline

MAX_IMAGE_BYTES = 3 * 1024 * 1024

log = logging.getLogger("radeef-face")


def _load_local_env() -> None:
    """Local development only: read KEY=VALUE lines from services/face/.env.local (gitignored)
    when the variables are not already set. In production systemd / Docker provide them."""
    path = Path(__file__).resolve().parent.parent / ".env.local"
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"'))


_load_local_env()
TOKEN = os.environ.get("FACE_SERVICE_TOKEN", "").strip()
if len(TOKEN) < 32:
    raise RuntimeError("FACE_SERVICE_TOKEN must be set (at least 32 characters): openssl rand -hex 32")

pipeline = Pipeline()
if not pipeline.liveness_available:
    log.warning("liveness models missing: every analysis returns liveness=null and Radeef will reject punches")

app = FastAPI(title="radeef-face", docs_url=None, redoc_url=None, openapi_url=None)


def require_token(authorization: str = Header(default="")) -> None:
    expected = f"Bearer {TOKEN}"
    if not hmac.compare_digest(authorization.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "models": pipeline.status()}


@app.post("/analyze", dependencies=[Depends(require_token)])
async def analyze(request: Request, image: UploadFile = File(...)) -> JSONResponse:
    declared = int(request.headers.get("content-length") or 0)
    if declared > MAX_IMAGE_BYTES + 64 * 1024:
        raise HTTPException(status_code=413, detail="image too large")
    data = await image.read(MAX_IMAGE_BYTES + 1)
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413 if data else 400, detail="image too large" if data else "empty image")
    try:
        result = pipeline.analyze(data)
    except ValueError:
        raise HTTPException(status_code=400, detail="not a decodable image") from None
    return JSONResponse(result.to_json(), headers={"Cache-Control": "no-store"})
