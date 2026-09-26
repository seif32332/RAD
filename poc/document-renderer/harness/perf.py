"""AC-15 (determinism), AC-17 (performance/memory), AC-18 (PDF/A-2b).

Runs inside the checker image (which carries the same pinned typst binary) under production-like
limits, e.g.:  docker run --rm --network none --memory 512m --cpus 2 ... python harness/perf.py
Each render is a full CLI process (cold start, font scan, compile, write), as the sidecar would
spawn it. Peak RSS is measured per process with wait4().
"""
import hashlib, json, os, statistics, subprocess, sys, tempfile, time
from concurrent.futures import ThreadPoolExecutor

TS = "1790413200"
RUNS = int(os.environ.get("RUNS", "30"))
TMP = tempfile.mkdtemp()


def render(fx, out, extra=()):
    args = ["typst", "compile", "--root", f"work/{fx}", "--font-path", "fonts", "--ignore-system-fonts", "--ignore-embedded-fonts",
            "--creation-timestamp", TS, *extra, f"work/{fx}/main.typ", out]
    t0 = time.perf_counter()
    p = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    _, status, ru = os.wait4(p.pid, 0)
    dt = (time.perf_counter() - t0) * 1000
    err = p.stderr.read().decode()
    return {"ms": dt, "rss_mb": ru.ru_maxrss / 1024, "ok": os.waitstatus_to_exitcode(status) == 0, "err": err.strip()}


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


res = {}

# AC-15 determinism: 10 renders of each fixture -> one hash each
det = {}
for fx in ["F1-ar", "F2-ar-en", "F6-stress"]:
    hashes = set()
    for i in range(10):
        out = f"{TMP}/{fx}-{i}.pdf"
        r = render(fx, out)
        assert r["ok"], r["err"]
        hashes.add(sha(out))
    det[fx] = sorted(hashes)
res["determinism"] = det

# AC-17 sequential latency + per-process peak RSS
for fx in ["F1-ar", "F2-ar-en", "F6-stress"]:
    samples = [render(fx, f"{TMP}/lat-{fx}.pdf") for _ in range(RUNS)]
    assert all(s["ok"] for s in samples)
    ms = sorted(s["ms"] for s in samples)
    res[f"latency_{fx}"] = {
        "runs": RUNS, "p50_ms": round(statistics.median(ms), 1), "p95_ms": round(ms[int(0.95 * (len(ms) - 1))], 1),
        "max_ms": round(ms[-1], 1), "peak_rss_mb": round(max(s["rss_mb"] for s in samples), 1),
    }

# AC-17 concurrency: 5 at once, 4 waves
waves = []
for w in range(4):
    t0 = time.perf_counter()
    with ThreadPoolExecutor(5) as ex:
        rs = list(ex.map(lambda i: render("F2-ar-en", f"{TMP}/c{w}-{i}.pdf"), range(5)))
    waves.append({"wall_ms": round((time.perf_counter() - t0) * 1000, 1), "ok": all(r["ok"] for r in rs),
                  "sum_peak_rss_mb": round(sum(r["rss_mb"] for r in rs), 1), "max_ms": round(max(r["ms"] for r in rs), 1)})
res["concurrency_5"] = waves

# AC-18 PDF/A-2b
r = render("F2-ar-en", f"{TMP}/pdfa.pdf", ("--pdf-standard", "a-2b"))
res["pdfa_2b"] = {"ok": r["ok"], "err": r["err"][:300], "sha": sha(f"{TMP}/pdfa.pdf") if r["ok"] else None}

print(json.dumps(res, indent=1))
json.dump(res, open(os.environ.get("PERF_OUT", "out/perf.json"), "w"), indent=1)
