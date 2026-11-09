"""tools/lab/wind-smoke-series.py - does a fire's smoke go where the air goes, smoothly? (mmp-9un.5)

    python -I -X utf8 tools/lab/wind-smoke-series.py <out.png> <title> <run.json>:<fire>:<label> [...]

Each run is a `wind-plume.mjs` result whose rows carry the smoke meter: `smokeGx/Gy` (the drift's weighted middle on the
ground, world px from the fuel bed, before the camera), `grainX/Y` (where the column's grain frame has moved to) and `tSec`
(the fire clock). Per series it prints and plots:

  heading   the drift's direction against the wind's (the dial's heading: what you see blowing across the map), and the
            local air's heading at the fire for context. A REVERSAL is the smoke more than 90 deg off the wind for more
            than 0.5 s.
  grain     the grain pattern's speed along the air (m/s; the pattern should travel with the smoke, not against it).
  swing     how far the drift's middle moves frame to frame (m/s at the meter's rate).
"""
import json
import math
import os
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

PX_PER_M = 98.43
# a heading is only read once the smoke has visibly gone somewhere (a few cm of drift can point anywhere)
MIN_DRIFT_M = 0.5
OUT = Path(sys.argv[1])
TITLE = sys.argv[2]
specs = [a.split(":") for a in sys.argv[3:]]
# windows drive letters: rejoin "C" + rest
fixed = []
for parts in specs:
    if len(parts) > 3 and len(parts[0]) == 1:
        parts = [parts[0] + ":" + parts[1]] + parts[2:]
    fixed.append(parts)


def wrap(a):
    return (a + 180) % 360 - 180


series = []
for path, fire, label in fixed:
    run = json.loads(Path(path).read_text(encoding="utf-8"))
    deg = run.get("args", {}).get("directionDeg", 90)
    dial = math.degrees(math.atan2(-math.cos(math.radians(deg)), math.sin(math.radians(deg))))
    for r in run["runs"]:
        if r["key"] != fire:
            continue
        rows = [x for x in r["rows"] if x.get("smokeGx") is not None]
        t = [(x["t"]) / 1000 for x in rows]
        off = []
        airoff = []
        for x in rows:
            hd = math.degrees(math.atan2(x["smokeGy"], x["smokeGx"]))
            ax, ay = x.get("dirX"), x.get("dirY")
            airoff.append(wrap(math.degrees(math.atan2(ay, ax)) - dial) if ax is not None else float("nan"))
            drift = math.hypot(x["smokeGx"], x["smokeGy"]) / PX_PER_M
            off.append(wrap(hd - dial) if drift > MIN_DRIFT_M else float("nan"))
        # reversals: > 90 deg off for > 0.5 s
        rev, run_start = 0, None
        rev_spans = []
        for k, (tt, o) in enumerate(zip(t, off)):
            bad = (not math.isnan(o)) and abs(o) > 90
            if bad and run_start is None:
                run_start = tt
            if (not bad or k == len(t) - 1) and run_start is not None:
                if tt - run_start > 0.5:
                    rev += 1
                    rev_spans.append((run_start, tt))
                run_start = None
        # grain speed along the air and the drift's swing
        gs, sw, gt = [], [], []
        jumps = 0
        for p, q in zip(rows, rows[1:]):
            dts = q.get("tSec", 0) - p.get("tSec", 0)
            dtw = (q["t"] - p["t"]) / 1000
            if dts > 1e-4 and q.get("grainX") is not None and p.get("grainX") is not None:
                # against the air the smoke's path integrates (the eased air at the fire), where the build reports it
                ax, ay = q.get("pathDirX", q.get("dirX", 1)), q.get("pathDirY", q.get("dirY", 0))
                vx = (q["grainX"] - p["grainX"]) / dts
                vy = (q["grainY"] - p["grainY"]) / dts
                gs.append((vx * ax + vy * ay) / PX_PER_M)
                gt.append(q["t"] / 1000)
            if dtw > 1e-4:
                step = math.hypot(q["smokeGx"] - p["smokeGx"], q["smokeGy"] - p["smokeGy"]) / PX_PER_M
                sw.append(step / dtw)
        sws = sorted(sw)
        valid = [o for o in off if not math.isnan(o)]
        # how fast the smoke's heading turns (deg/s): a column snapped round by the air of one instant turns in a frame
        turn = []
        for k in range(1, len(off)):
            if math.isnan(off[k]) or math.isnan(off[k - 1]):
                continue
            dtt = t[k] - t[k - 1]
            if dtt > 1e-3:
                turn.append(abs(wrap(off[k] - off[k - 1])) / dtt)
                # a SNAP: the whole column swung more than 15 deg between two frames (~0.07 s)
                jumps += 1 if abs(wrap(off[k] - off[k - 1])) > 15 else 0
        turn.sort()
        s = {
            "label": label,
            "fire": fire,
            "reversals": rev,
            "offMeanAbs": sum(abs(o) for o in valid) / max(1, len(valid)),
            "offOver90pct": 100 * sum(1 for o in valid if abs(o) > 90) / max(1, len(valid)),
            "grainAgainstPct": 100 * sum(1 for g in gs if g < 0) / max(1, len(gs)),
            "grainP95": sorted(abs(g) for g in gs)[int(len(gs) * 0.95)] if gs else None,
            "swingP50": sws[len(sws) // 2] if sws else None,
            "swingP95": sws[int(len(sws) * 0.95)] if sws else None,
            "turnP95": turn[int(len(turn) * 0.95)] if turn else None,
            "jumps": jumps,
            "turnMax": turn[-1] if turn else None,
            "airMps": sum((x.get("windMps", x.get("airMps", 0)) or 0) for x in rows) / max(1, len(rows)),
        }
        print(json.dumps({k: (round(v, 2) if isinstance(v, float) else v) for k, v in s.items()}))
        series.append((s, t, off, gt, gs, rev_spans, airoff))

def breaks(ts, ys):
    # an angle that wraps past +-180 is not a jump: break the line there instead of drawing a vertical stroke
    ot, oy = [], []
    for k, (tt, yy) in enumerate(zip(ts, ys)):
        if k and not math.isnan(yy) and not math.isnan(ys[k - 1]) and abs(yy - ys[k - 1]) > 180:
            ot.append(tt)
            oy.append(float("nan"))
        ot.append(tt)
        oy.append(yy)
    return ot, oy


fig, axes = plt.subplots(2, 1, figsize=(14, 9.5), sharex=True)
cols = ["#c0392b", "#2b6f8f", "#e8862a", "#27ae60"]
for i, (s, t, off, gt, gs, spans, airoff) in enumerate(series):
    c = cols[i % len(cols)]
    axes[0].plot(*breaks(t, airoff), color=c, lw=0.8, ls=":", alpha=0.8, label=f"{s['label']}: the air at the fire")
    lab = f"{s['label']}: {s['reversals']} reversals, {s['offOver90pct']:.0f}% of the time > 90 deg off, {s['jumps']} snaps (swung > 15 deg in one frame)"
    axes[0].plot(*breaks(t, off), color=c, lw=1.4, label=lab)
    for a, b in spans:
        axes[0].axvspan(a, b, color=c, alpha=0.12)
    axes[1].plot(gt, gs, color=c, lw=1.2, label=f"{s['label']}: against the air {s['grainAgainstPct']:.0f}% of the time")
for y in (90, -90):
    axes[0].axhline(y, color="k", ls="--", lw=1)
axes[0].axhline(0, color="k", lw=0.6)
axes[0].set_ylim(-185, 185)
axes[0].set_yticks([-180, -90, 0, 90, 180])
axes[0].set_ylabel("smoke direction vs the wind (deg)\n0 = downwind, +-180 = upwind", fontsize=12)
axes[0].set_title("Which way the smoke goes (solid) and the air at the fire (dotted), against the wind", fontsize=14, fontweight="bold", loc="left")
axes[0].legend(fontsize=11, loc="lower right")
axes[0].grid(alpha=0.3)
axes[1].axhline(0, color="k", lw=0.8)
axes[1].set_ylabel("smoke grain speed along the air (m/s)\n+ = with the wind", fontsize=12)
axes[1].set_xlabel("time (s)", fontsize=12)
axes[1].set_title("How the smoke's grain pattern moves (it should drift WITH the smoke)", fontsize=14, fontweight="bold", loc="left")
axes[1].legend(fontsize=11, loc="lower right")
axes[1].grid(alpha=0.3)
# GRAIN_LIM (env) pins the grain axis so a before and an after plot read on the same scale
lim = float(os.environ.get("GRAIN_LIM", "0")) or max([abs(g) for ser in series for g in ser[4]] + [1])
axes[1].set_ylim(-min(lim, 60) * 1.1, min(lim, 60) * 1.1)
fig.suptitle(TITLE, fontsize=15, fontweight="bold", x=0.01, ha="left")
fig.tight_layout(rect=(0, 0, 1, 0.96))
fig.savefig(OUT, dpi=85)
print(OUT)
