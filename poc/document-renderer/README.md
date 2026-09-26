# Typst renderer POC (isolated)

Proof of concept for ADR DOC-01: tests Typst as the document renderer only. Nothing in `src/` imports this
folder. Criteria and results: [docs/document-engine/POC.md](../../docs/document-engine/POC.md).

Requires Docker and Node (the host's Git Bash `pdftotext` is xpdf 4.x, used as the reference text extractor).

```bash
./fetch-fonts.sh                 # pinned IBM Plex Sans Arabic bundle, verified against fonts.lock
docker build -t radeef-render-poc-checker checker
node harness/prepare.mjs         # synthetic fixtures F1..F7 -> work/
./render.sh                      # renders in a locked-down container -> out/*.pdf, *.png, *.txt
docker run --rm --network none -v "$PWD:/poc" radeef-render-poc-checker python harness/check.py
docker run --rm --network none --memory 512m --cpus 2 -v "$PWD:/poc" radeef-render-poc-checker python harness/perf.py
./isolation.sh                   # escape probes: all must be blocked
```

| Path | Role |
|---|---|
| `templates/salary-certificate.typ` | The template under test (ar / ar-en) |
| `harness/prepare.mjs` | Plays the engine's render-model step: display strings, Hijri dates, QR, synthetic assets |
| `harness/check.py` | AC-01..AC-14, AC-16 (literal text), AC-19 |
| `harness/perf.py` | AC-15 determinism, AC-17 latency/memory, AC-18 PDF/A-2b |
| `isolation.sh` | AC-16 escape probes |
| `gotenberg/` | Same bilingual page as HTML, for the Gotenberg comparison |
