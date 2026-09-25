# Face verification service (Docker deployments). One container serves all tenants.
# Build from services/face:   docker build -t radeef-face services/face
# Run (bridge address only, like Postgres; never publish on 0.0.0.0):
#   docker run -d --name radeef-face --restart unless-stopped --read-only --cap-drop ALL \
#     --env-file /etc/radeef/services/face.env -p 172.17.0.1:8090:8090 radeef-face
# (/etc/radeef/services/, not /etc/radeef/: every /etc/radeef/*.env is treated as a tenant.)
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /srv/face

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app
COPY scripts ./scripts
COPY models ./models
# Detection / recognition models are downloaded (and checksum-verified) at build time;
# the liveness ONNX files are committed in models/.
RUN python scripts/download_models.py

RUN useradd --system --uid 10001 face && chown -R face /srv/face
USER face

EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=3).status == 200 else 1)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8090", "--workers", "2", "--no-server-header"]
