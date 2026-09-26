# radeef-render: internal document renderer

Renders official documents (salary certificates, letters) to PDF with a pinned Typst binary and font bundle, for
the document issuance engine (`docs/document-engine/`: ADR-001, SPEC, POC).

- **What it does:** receives a Typst template, a ready-to-print data model and assets, and returns the PDF bytes.
  It is stateless: each request gets a private temp directory that is deleted afterwards. Nothing is stored, and
  no content is logged.
- **What it does not do:** document logic. Numbering, snapshots, approvals, signatures policy, formatting of
  amounts and dates, Hijri conversion and QR generation all happen in Radeef (the render model, ADR DOC-01). The
  service only lays out strings it is given.
- **Guarantees:**
  - **Deterministic:** the same template, data, assets and timestamp give the same bytes. The golden tests pin
    the output hashes of the POC fixtures.
  - **Warnings are errors.**
  - **No silent font fallback:** every character is checked against the font bundle's cmap before Typst runs
    (`UNSUPPORTED_CHARACTERS`).
- **Security:**
  - `127.0.0.1` only, `Authorization: Bearer $RENDER_SERVICE_TOKEN`.
  - Strict input validation: file names, template package imports, PNG checks, and an SVG allow-list.
  - Typst runs with an empty environment in its own process group, is killed on timeout, and has no network.
  - The systemd unit mirrors `radeef-face` (`systemd-analyze security`: 1.2 OK).
- **Runtime dependencies:** none (Node ≥ 20.9 standard library). Plain JS with JSDoc types, type-checked with
  the repository's TypeScript.

## API

`GET /health` returns `{"status":"ok","typst":{"version":"0.15.1","sha256":"…"},"fontsSha256":"…","busy":0,"queued":0,"concurrency":4}`.

`POST /render` takes `Content-Type: application/json` (8 MB max):

```json
{
  "templateRef": "typst:salary-certificate/ar-en@1",
  "template": { "main.typ": "<base64>" },
  "data": { "doc": { "number": "ACM-SAL-2026-000184" } },
  "assets": { "logo.png": "<base64>", "qr.svg": "<base64>" },
  "creationTimestamp": 1790413200,
  "pdfStandard": "a-2b"
}
```

The data object is shortened here; it holds everything the template prints.

- **200:** `application/pdf`, with headers `X-Renderer`, `X-Renderer-Version`, `X-Typst-Sha256`,
  `X-Fonts-Sha256`, `X-Pdf-Sha256` and `X-Request-Id`. The engine stores these on the issued document (DOC-07).
- **Errors:** `{"error": CODE, "detail"?, "requestId"}`:
  - 400: validation.
  - 401: `UNAUTHORIZED`.
  - 413: `BODY_TOO_LARGE`.
  - 415: `UNSUPPORTED_MEDIA_TYPE`.
  - 422: `UNSUPPORTED_CHARACTERS`, `TEMPLATE_FORBIDDEN`, `TEMPLATE_ERROR` or `RENDER_WARNING`.
  - 503: `BUSY`, with `Retry-After`.
  - 504: `RENDER_TIMEOUT`.

## Files

| Path | Role |
|---|---|
| `typst.lock` | Pinned Typst release per architecture: tarball digest (= GitHub's) and binary sha256 |
| `fonts.lock` | Pinned font bundle; only these files may be in `fonts/` |
| `scripts/fetch-assets.sh <dest> [arch]` | Downloads and verifies both into `<dest>/bin`, `<dest>/fonts` |
| `src/` | `main.mjs` (startup checks, config), `server.mjs` (HTTP), `validate.mjs`, `render.mjs`, `fonts.mjs` |
| `test/` | Unit + end-to-end tests with the real binary; POC fixtures and golden hashes |
| `Dockerfile` | Docker deployments (Node 24 LTS, pinned by digest, non-root, read-only) |
| `../../ops/render-setup.sh`, `../../ops/systemd/radeef-render.service` | Host (PM2) deployments; see `docs/RUNBOOK.md` §6 |

## Development

```bash
cd services/render
sh scripts/fetch-assets.sh .      # bin/typst + fonts/ (gitignored), Linux only
npm test                           # node --test; needs bin/ and fonts/
npx tsc -p tsconfig.json           # from the repo root: npx tsc -p services/render/tsconfig.json
```

On Windows, run the tests in a container:

```bash
docker run --rm -v "$PWD:/srv/render:ro" -w /srv/render node:24-alpine sh -c \
  'apk add --no-cache curl xz >/dev/null && sh scripts/fetch-assets.sh /tmp/a >/dev/null && TYPST_BIN=/tmp/a/bin/typst FONTS_DIR=/tmp/a/fonts npm test'
```

Changing `typst.lock` or `fonts.lock` changes the rendered bytes. Update `GOLDEN` in `test/helpers.mjs` in the same
commit, after a visual review of the output.
