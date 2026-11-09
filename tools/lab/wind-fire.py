"""tools/lab/wind-fire.py - what each fire on Lab · Wind feels, from wind-fire-page.js runs (mmp-vm1.1.6).

    python -I -X utf8 tools/lab/wind-fire.py <fires.json> <run.json> [<run.json> ...]

<fires.json> is the scene's fire list (key, x, y in scene px; `node -e` on wind-spec.mjs windFires()). Each run is a
saved page result with a "label". Rows: per fire, the billow model's wind push (weather-gated, 0..1) mean and spread
(the gust response), and where the build reports it, the local air speed (m/s) and its heading spread (σθ).
"""
import json
import math
import sys
from pathlib import Path

fires = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
runs = [json.loads(Path(p).read_text(encoding="utf-8")) for p in sys.argv[2:]]

# id -> fire key, learned from any run whose rows carry x/y (scene px offset by the canvas padding: nearest wins)
id_key = {}
for run in runs:
    for cid, rows in run["series"].items():
        r = rows[-1]
        if "x" in r:
            best = min(fires, key=lambda f: (f["x"] + run.get("ox", 3000) - r["x"]) ** 2 + (f["y"] + run.get("oy", 2250) - r["y"]) ** 2)
            id_key[cid] = best["key"]


def stats(vals):
    if not vals:
        return None, None
    m = sum(vals) / len(vals)
    s = math.sqrt(sum((v - m) ** 2 for v in vals) / len(vals))
    return m, s


def heading(rows):
    xs = [r["dirX"] for r in rows if "dirX" in r]
    ys = [r["dirY"] for r in rows if "dirY" in r]
    if not xs:
        return None, None
    angs = [math.atan2(x, -y) for x, y in zip(xs, ys)]
    c = sum(math.cos(a) for a in angs) / len(angs)
    s = sum(math.sin(a) for a in angs) / len(angs)
    R = math.hypot(c, s)
    return (math.degrees(math.atan2(s, c)) + 360) % 360, math.degrees(math.sqrt(max(0.0, -2 * math.log(max(R, 1e-12)))))


order = [f["key"] for f in fires]
out = {}
for run in runs:
    lab = run.get("label", "?")
    for cid, rows in run["series"].items():
        key = id_key.get(cid, f"id{cid}")
        wind_m, wind_s = stats([r["wind"] for r in rows if "wind" in r])
        push_m, push_s = stats([r["push"] for r in rows if "push" in r])
        air_m, air_s = stats([r["airMps"] for r in rows if "airMps" in r])
        hd, sth = heading(rows)
        out.setdefault(key, {})[lab] = {
            "wind": wind_m,
            "windSd": wind_s,
            "push": push_m,
            "pushSd": push_s,
            "airMps": air_m,
            "airSd": air_s,
            "headingDeg": hd,
            "sigmaThetaDeg": sth,
            "n": len(rows),
        }


def f(v, n=2):
    return "  —  " if v is None else f"{v:.{n}f}"


labels = [r.get("label", "?") for r in runs]
print("fire".ljust(16) + "".join(f"| {lab[:22]:22s} wind±sd   air m/s±sd  hdg σθ " for lab in labels))
for key in order + [k for k in out if k not in order]:
    if key not in out:
        continue
    line = key.ljust(16)
    for lab in labels:
        d = out[key].get(lab)
        if not d:
            line += "| " + " " * 60
            continue
        line += f"| {f(d['wind'])}±{f(d['windSd'])}  {f(d['airMps'],1)}±{f(d['airSd'],1)}  {f(d['headingDeg'],0)} {f(d['sigmaThetaDeg'],1)}      "
    print(line)
Path(sys.argv[2]).with_name("fire-summary.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
