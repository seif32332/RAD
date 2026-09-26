# Test harness only: PDF/font/QR inspection + perf driver. Never part of the renderer.
FROM ghcr.io/typst/typst@sha256:032e292249bcd378480cc7c142cfa324b63ef8aadeb88d7e7230320c4c9c422f AS typst
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/* && pip install --no-cache-dir pymupdf==1.28.2 fonttools==4.66.0 opencv-python-headless==5.0.0.93 numpy==2.5.3 && pip freeze > /versions.txt
COPY --from=typst /bin/typst /usr/local/bin/typst
WORKDIR /poc
