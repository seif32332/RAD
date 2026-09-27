"""Internal face verification service for Radeef self clock-in.

- Bound to 127.0.0.1 (or the Docker bridge address) and never exposed by Nginx.
- Every request except /health needs `Authorization: Bearer $FACE_SERVICE_TOKEN`, checked
  (with the request size) BEFORE the body is read.
- Stateless: receives one image, returns face count, quality, liveness and the embedding.
  Matching against enrolled templates happens in Radeef, so templates never come here.
- Images are processed in memory only and are never written or logged.
"""
from __future__ import annotations

import hmac
import logging
import os
from pathlib import Path

# Refuse "decompression bombs" (a small file declaring a huge image) inside OpenCV itself.
# OpenCV reads this variable when it is imported, so it is set before the pipeline import.
os.environ.setdefault("OPENCV_IO_MAX_IMAGE_PIXELS", "20000000")

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from starlette.concurrency import run_in_threadpool  # noqa: E402
from starlette.formparsers import MultiPartParser  # noqa: E402

from .pipeline import Pipeline  # noqa: E402

MAX_IMAGE_BYTES = 3 * 1024 * 1024
MAX_BODY_BYTES = MAX_IMAGE_BYTES + 64 * 1024

# Starlette spools file parts above 1 MB to a temporary file: keep the (bounded) image in memory.
MultiPartParser.spool_max_size = MAX_BODY_BYTES

log = logging.getLogger("radeef-face")


def _unquote(value: str) -> str:
    """`docker run --env-file` passes KEY="value" with the quotes: accept both forms."""
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1].strip()
    return value


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
        os.environ.setdefault(key.strip(), _unquote(value))


_load_local_env()
TOKEN = _unquote(os.environ.get("FACE_SERVICE_TOKEN", ""))
if len(TOKEN) < 32:
    raise RuntimeError("FACE_SERVICE_TOKEN must be set (at least 32 characters): openssl rand -hex 32")

pipeline = Pipeline()
if not pipeline.liveness_available:
    log.warning("liveness models missing: every analysis returns liveness=null and Radeef will reject punches")


class _TooLarge(Exception):
    pass


class AnalyzeGuard:
    """ASGI guard for /analyze: rejects a wrong token or an oversized body before FastAPI reads
    and parses it (an unauthenticated client must not be able to make the service buffer data)."""

    def __init__(self, app) -> None:  # noqa: ANN001 - ASGI app
        self.app = app
        self.expected = f"Bearer {TOKEN}".encode()

    async def __call__(self, scope, receive, send) -> None:  # noqa: ANN001 - ASGI signature
        if scope["type"] != "http" or scope.get("path") != "/analyze":
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers") or [])
        if not hmac.compare_digest(headers.get(b"authorization", b""), self.expected):
            await _plain(send, 401, b"unauthorized")
            return
        declared = headers.get(b"content-length")
        if declared is not None and (not declared.isdigit() or int(declared) > MAX_BODY_BYTES):
            await _plain(send, 413, b"image too large")
            return

        received = 0
        started = False

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > MAX_BODY_BYTES:  # chunked upload without a Content-Length
                    raise _TooLarge()
            return message

        async def tracking_send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except _TooLarge:
            if not started:
                await _plain(send, 413, b"image too large")


async def _plain(send, status: int, body: bytes) -> None:  # noqa: ANN001
    await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"text/plain"), (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})


app = FastAPI(title="radeef-face", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(AnalyzeGuard)


def require_token(authorization: str = Header(default="")) -> None:
    # Defense in depth: AnalyzeGuard already checked it.
    if not hmac.compare_digest(authorization.encode(), f"Bearer {TOKEN}".encode()):
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "models": pipeline.status()}


@app.post("/analyze", dependencies=[Depends(require_token)])
async def analyze(image: UploadFile = File(...)) -> JSONResponse:
    data = await image.read(MAX_IMAGE_BYTES + 1)
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413 if data else 400, detail="image too large" if data else "empty image")
    try:
        # CPU-bound: off the event loop, so /health and other uploads keep being served.
        result = await run_in_threadpool(pipeline.analyze, data)
    except ValueError:
        raise HTTPException(status_code=400, detail="not a decodable image") from None
    return JSONResponse(result.to_json(), headers={"Cache-Control": "no-store"})
