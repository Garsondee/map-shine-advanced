"""tools/lab/wind-plume.py - how far each fire's smoke and flame lean with the wind (mmp-vm1.1.6).

    python -I -X utf8 tools/lab/wind-plume.py <summary.json> <run.json> [<run.json> ...]

Each run is a saved `wind-plume.mjs` result (a "label" and per dial speed and fire the plume meter's samples). Angles are
measured on the picture, from straight up the page (0) toward the wind (90 = lying flat downwind):

  smoke  page: the strength x area weighted middle of the smoke lobes as drawn, from the fuel bed (the smoke camera swells
         and leans high smoke out, so the page exaggerates); net: the same with the fire's calm reading taken out;
         phys: the drift's middle on the ground (before the camera) against its mean height — the angle in the air,
         which is what physics predicts.
  flame  the flame lobes' middle; the flame is lifted `heightTilt` (the engine's, 0.3 by default) page px per px of
         height, so its tilt in the air is atan(downwind / (up / heightTilt)).

Also the jitter of the smoke middle (its frame-to-frame speed, m/s at the meter's rate).
"""
import json
import math
import sys
from pathlib import Path

PX_PER_M = 98.43
# the page lift per unit of height the billow engine uses (`heightTilt`, default 0.3); rows that carry it override this
TILT = 0.3

summary_path = Path(sys.argv[1])
runs = [json.loads(Path(p).read_text(encoding="utf-8")) for p in sys.argv[2:]]


def mean(v):
    return sum(v) / len(v) if v else None


def sd(v):
    if len(v) < 2:
        return None
    m = mean(v)
    return math.sqrt(sum((x - m) ** 2 for x in v) / len(v))


out = {}
for run in runs:
    lab = run.get("label", "?")
    deg = run.get("args", {}).get("directionDeg", 90)
    wx, wy = math.sin(math.radians(deg)), -math.cos(math.radians(deg))  # the dial's flow vector (toward), +y down
    for r in run["runs"]:
        rows = [x for x in r["rows"] if x.get("smokeDx") is not None]
        if not rows:
            continue
        sdx = [x["smokeDx"] for x in rows]
        sdy = [x["smokeDy"] for x in rows]
        fl = [x for x in rows if x.get("flameDx") is not None]
        mdx, mdy = mean(sdx), mean(sdy)
        along = mdx * wx + mdy * wy
        up = -mdy
        smoke_ang = math.degrees(math.atan2(along, up))
        cross = -mdx * wy + mdy * wx  # + = to the right of the wind
        # the local air's heading vs the smoke's ground heading (only where the smoke lies over: across vs along)
        air = [(x.get("dirX"), x.get("dirY")) for x in rows if x.get("dirX") is not None]
        ax = mean([a[0] for a in air]) if air else wx
        ay = mean([a[1] for a in air]) if air else wy
        # jitter: frame-to-frame speed of the smoke middle (m/s)
        sp = []
        for p, q in zip(rows, rows[1:]):
            dt = (q["t"] - p["t"]) / 1000
            if dt > 0:
                sp.append(math.hypot(q["smokeDx"] - p["smokeDx"], q["smokeDy"] - p["smokeDy"]) / PX_PER_M / dt)
        sp.sort()
        res = {
            "speedMps": round(float(r["speed01"]) * 70, 1),
            "airMps": round(mean([x.get("airMps", 0) for x in rows]), 2),
            # the air the fire itself used (after roof shelter and the author's response), where the build reports it
            "windMps": round(mean([x["windMps"] for x in rows if x.get("windMps") is not None]), 2)
            if any(x.get("windMps") is not None for x in rows)
            else None,
            "push": round(mean([x.get("push", 0) for x in rows]), 3),
            "smokeDxM": round(mdx / PX_PER_M, 2),
            "smokeUpM": round(up / PX_PER_M, 2),
            "smokeAlongM": round(along / PX_PER_M, 2),
            "smokeCrossM": round(cross / PX_PER_M, 2),
            "smokeAngle": round(smoke_ang, 1),
            "smokeAngleSd": round(sd([math.degrees(math.atan2(dx * wx + dy * wy, -dy)) for dx, dy in zip(sdx, sdy)]) or 0, 1),
            "smokeSdM": round(math.hypot(sd(sdx) or 0, sd(sdy) or 0) / PX_PER_M, 2),
            "jitterP50": round(sp[len(sp) // 2], 2) if sp else None,
            "jitterP95": round(sp[int(len(sp) * 0.95)], 2) if sp else None,
            "jitterMax": round(sp[-1], 2) if sp else None,
            "airHeading": round(math.degrees(math.atan2(ax, -ay)) % 360, 1),
            "n": len(rows),
        }
        # the plume's angle in the air: its drift on the ground (before the camera) against its height
        gr = [x for x in rows if x.get("smokeGx") is not None and x.get("smokeZ") is not None]
        if gr:
            g_along = mean([x["smokeGx"] * wx + x["smokeGy"] * wy for x in gr])
            g_z = mean([x["smokeZ"] for x in gr])
            res["smokePhys"] = round(math.degrees(math.atan2(g_along, g_z)), 1)
            res["smokeDriftM"] = round(g_along / PX_PER_M, 2)
            res["smokeZM"] = round(g_z / PX_PER_M, 2)
        if fl:
            fdx = mean([x["flameDx"] for x in fl])
            fdy = mean([x["flameDy"] for x in fl])
            f_along = fdx * wx + fdy * wy
            f_up = -fdy
            res["flameAlongM"] = round(f_along / PX_PER_M, 2)
            res["flameUpM"] = round(f_up / PX_PER_M, 2)
            res["flameScreenAngle"] = round(math.degrees(math.atan2(f_along, f_up)), 1)
            # undo the page lift the engine used (its `heightTilt`, her dial: 0.3 by default), 0.45 for older builds
            lift = mean([x["heightTilt"] for x in fl if x.get("heightTilt")]) or TILT
            res["flameTilt"] = round(math.degrees(math.atan2(f_along, max(f_up, 1e-6) / lift)), 1)
        out.setdefault(r["key"], {}).setdefault(lab, {})[str(res["speedMps"])] = res
        # the time series, for the swing plots
        out[r["key"]][lab].setdefault("_series", {})[str(res["speedMps"])] = [
            [x["t"], x["smokeDx"], x["smokeDy"], x.get("flameDx"), x.get("flameDy")] for x in rows
        ]

for key, labs in out.items():
    for lab, sp in labs.items():
        calm = sp.get("0.0")
        if not calm:
            continue
        for k, r in sp.items():
            if k.startswith("_"):
                continue
            r["smokeAngleNet"] = round(math.degrees(math.atan2(r["smokeAlongM"] - calm["smokeAlongM"], r["smokeUpM"])), 1)
summary_path.write_text(json.dumps(out), encoding="utf-8")
print(f"{'fire':16s} {'label':14s} {'dial':>5s} {'air':>5s} {'page':>6s} {'net':>6s} {'phys':>6s} {'drift m':>7s} {'z m':>6s} {'flame tilt':>10s} {'jit95':>6s}")
for key, labs in out.items():
    for lab, sp in labs.items():
        for s, r in sp.items():
            if s.startswith("_"):
                continue
            nan = float("nan")
            print(
                f"{key:16s} {lab:14s} {r['speedMps']:5.1f} {r['airMps']:5.1f} {r['smokeAngle']:6.1f} "
                f"{r.get('smokeAngleNet', nan):6.1f} {r.get('smokePhys', nan):6.1f} {r.get('smokeDriftM', nan):7.2f} "
                f"{r.get('smokeZM', nan):6.2f} {r.get('flameTilt', nan):10.1f} {(r['jitterP95'] or 0):6.2f}"
            )
