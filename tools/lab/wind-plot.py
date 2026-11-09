"""tools/lab/wind-plot.py - turn wind-meter runs into numbers and PNG plots (mmp-vm1.1, the Wind lab).

    python -I tools/lab/wind-plot.py <run dir>            (the folder wind-meter.mjs wrote speed-*.json into)

Writes into the same folder:
    summary.json            every statistic below, per speed and per probe
    series-<s>.png          speed at the along-wind probe line over time, with the 3-s mean
    spectrum.png            speed power spectrum at the field centre for every speed, with a -5/3 line
    autocorr.png            speed autocorrelation at the field centre for every speed
    taylor-<s>.png          lag of best correlation vs along-wind separation (gust travel speed)
    snapshot-<s>.png        the baked field at one moment: speed colour, arrows, walls, probes
    places.png              mean speed at every named probe as a fraction of the open field, per speed

Numbers, not adjectives: speeds in m/s (field units x 70), distances in m (scene px / px-per-metre).
Pure numpy + matplotlib (no scipy on this machine).
"""

import json
import math
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

MPS = 70.0  # dial units -> m/s
OPEN_LINE = ["f03", "f07", "f11", "f15", "f19", "f23", "f27", "f31"]
OPEN_SET = OPEN_LINE + ["fy03", "fy07", "fy15", "fy19"]
CENTRE = "f19"


def load(run):
    files = sorted(Path(run).glob("speed-*.json"))
    out = []
    for f in files:
        d = json.loads(f.read_text(encoding="utf-8"))
        out.append(d)
    out.sort(key=lambda d: d["speed01"])
    return out


def series_of(d, name):
    t = np.asarray(d["t"], dtype=float) / 1000.0
    v = np.asarray(d["series"][name], dtype=float) * MPS  # (n, 2) m/s
    return t, v


def resample(t, y, dt=0.1):
    """Uniform grid by linear interpolation (the reads are ~5-10 Hz and slightly uneven)."""
    tt = np.arange(t[0], t[-1], dt)
    if y.ndim == 1:
        return tt, np.interp(tt, t, y)
    return tt, np.stack([np.interp(tt, t, y[:, k]) for k in range(y.shape[1])], axis=1)


def running_mean(y, n):
    if n <= 1:
        return y.copy()
    k = np.ones(n) / n
    return np.convolve(y, k, mode="valid")


def events(y3, mean, hi=1.2, lo=0.8, dt=0.1):
    """Gust (3-s mean above hi*mean) and lull (below lo*mean) durations, crests and gaps."""
    def runs(mask):
        out = []
        start = None
        for i, m in enumerate(mask):
            if m and start is None:
                start = i
            if not m and start is not None:
                out.append((start, i))
                start = None
        if start is not None:
            out.append((start, len(mask)))
        return out

    g = runs(y3 > hi * mean)
    l_ = runs(y3 < lo * mean)
    crests = [float(y3[a:b].max()) for a, b in g]
    starts = [a * dt for a, _ in g]
    gaps = np.diff(starts).tolist() if len(starts) > 1 else []
    return {
        "gusts": len(g),
        "gustDurS": [round((b - a) * dt, 2) for a, b in g],
        "gustCrestMps": [round(c, 2) for c in crests],
        "gustGapS": [round(x, 2) for x in gaps],
        "lulls": len(l_),
        "lullDurS": [round((b - a) * dt, 2) for a, b in l_],
    }


def cv(a):
    a = np.asarray(a, dtype=float)
    return float(a.std() / a.mean()) if len(a) > 1 and a.mean() > 0 else None


def autocorr(y, max_lag):
    y = y - y.mean()
    var = (y * y).mean()
    if var <= 0:
        return np.zeros(max_lag)
    return np.array([(y[: len(y) - k] * y[k:]).mean() / var for k in range(max_lag)])


def welch(y, dt, seg=256):
    """Welch PSD with a Hann window, 50% overlap. Returns (f, P)."""
    y = y - y.mean()
    seg = min(seg, len(y))
    step = seg // 2
    w = np.hanning(seg)
    acc = None
    n = 0
    for s in range(0, len(y) - seg + 1, step):
        x = y[s : s + seg] * w
        X = np.fft.rfft(x)
        p = (np.abs(X) ** 2) / (w * w).sum() * dt
        acc = p if acc is None else acc + p
        n += 1
    f = np.fft.rfftfreq(seg, dt)
    return f[1:], (acc / max(n, 1))[1:]


def circ_mean_std(angles_rad):
    c = np.cos(angles_rad).mean()
    s = np.sin(angles_rad).mean()
    R = math.hypot(c, s)
    mean = math.atan2(s, c)
    std = math.sqrt(max(0.0, -2.0 * math.log(max(R, 1e-12))))
    return mean, std


def direction_toward_deg(vx, vy):
    """MSA's convention: degrees, 0 = toward -y (north on screen), clockwise; 90 = toward +x."""
    return (np.degrees(np.arctan2(vx, -vy)) + 360.0) % 360.0


def point_stats(d, name):
    t, v = series_of(d, name)
    if len(t) < 8:
        return None
    tt, vv = resample(t, v)
    sp = np.hypot(vv[:, 0], vv[:, 1])
    mean = float(sp.mean())
    n3 = int(round(3.0 / 0.1))
    n1 = int(round(1.0 / 0.1))
    s3 = running_mean(sp, n3)
    vx1 = running_mean(vv[:, 0], n1)
    vy1 = running_mean(vv[:, 1], n1)
    ang1 = np.radians(direction_toward_deg(vx1, vy1))
    cm, cs = circ_mean_std(ang1)
    mvx, mvy = float(vv[:, 0].mean()), float(vv[:, 1].mean())
    ev = events(s3, mean) if mean > 0.05 else {}
    return {
        "durationS": round(float(tt[-1] - tt[0]), 1),
        "meanMps": round(mean, 3),
        "meanVecMps": [round(mvx, 3), round(mvy, 3)],
        "meanVecDirDeg": round(float(direction_toward_deg(mvx, mvy)), 1),
        "sigmaMps": round(float(sp.std()), 3),
        "TI": round(float(sp.std() / mean), 3) if mean > 0 else None,
        "peak3sMps": round(float(s3.max()), 3) if len(s3) else None,
        "min3sMps": round(float(s3.min()), 3) if len(s3) else None,
        "gustFactor3s": round(float(s3.max() / mean), 3) if mean > 0 and len(s3) else None,
        "peakInstMps": round(float(sp.max()), 3),
        "dirMeanDeg": round(math.degrees(cm) % 360.0, 1),
        "sigmaThetaDeg": round(math.degrees(cs), 1),
        **ev,
    }


def snapshot_arrays(d, snap):
    g = d["grid"]
    fx = np.asarray(snap["fx"], dtype=float).reshape(g["rows"], g["cols"]) * MPS
    fy = np.asarray(snap["fy"], dtype=float).reshape(g["rows"], g["cols"]) * MPS
    return fx, fy


def open_field_box(d):
    """WN1 open field in grid cells: x 1-35, y 1-21 squares (150 px)."""
    g = d["grid"]
    ox, oy = d["sceneOffset"]["x"], d["sceneOffset"]["y"]
    c0 = int((ox + 1.5 * 150 - g["originX"]) / g["cellSize"])
    c1 = int((ox + 34.5 * 150 - g["originX"]) / g["cellSize"])
    r0 = int((oy + 1.5 * 150 - g["originY"]) / g["cellSize"])
    r1 = int((oy + 20.5 * 150 - g["originY"]) / g["cellSize"])
    return c0, c1, r0, r1


def corr_length(prof, cell_m):
    """Separation (m) where a 1-D autocorrelation first drops below 1/e."""
    for k, r in enumerate(prof):
        if r < 1 / math.e:
            if k == 0:
                return 0.0
            r0 = prof[k - 1]
            frac = (r0 - 1 / math.e) / max(r0 - r, 1e-9)
            return (k - 1 + frac) * cell_m
    return None


def spatial_corr(d):
    """Mean along-wind (x) and across-wind (y) autocorrelation of speed over the open field, across snapshots."""
    g = d["grid"]
    cell_m = g["cellSize"] / d["ambient"]["pixelsPerMetre"]
    c0, c1, r0, r1 = open_field_box(d)
    maxlag = min(c1 - c0, r1 - r0) - 2
    ax = []
    ay = []
    cvs = []
    for s in d["snaps"]:
        fx, fy = snapshot_arrays(d, s)
        sp = np.hypot(fx, fy)[r0:r1, c0:c1]
        if sp.mean() <= 0.01:
            continue
        cvs.append(float(sp.std() / sp.mean()))
        a = sp - sp.mean()
        var = (a * a).mean()
        ax.append([(a[:, : a.shape[1] - k] * a[:, k:]).mean() / var for k in range(maxlag)])
        ay.append([(a[: a.shape[0] - k, :] * a[k:, :]).mean() / var for k in range(maxlag)])
    if not ax:
        return None
    ax = np.mean(np.asarray(ax), axis=0)
    ay = np.mean(np.asarray(ay), axis=0)
    return {
        "cellM": round(cell_m, 3),
        "alongWindLm": corr_length(ax, cell_m),
        "acrossWindLm": corr_length(ay, cell_m),
        "openFieldSpeedCV": round(float(np.mean(cvs)), 3),
        "alongProfile": [round(float(x), 3) for x in ax[:: max(1, len(ax) // 40)]],
        "acrossProfile": [round(float(x), 3) for x in ay[:: max(1, len(ay) // 40)]],
    }


def taylor(d):
    """Lag (s) of the best cross-correlation between f03 and each downstream line probe (speed series)."""
    t0, v0 = series_of(d, "f03")
    tt, vv0 = resample(t0, v0)
    s0 = np.hypot(vv0[:, 0], vv0[:, 1])
    s0 = s0 - s0.mean()
    ppm = d["ambient"]["pixelsPerMetre"]
    x0 = next(p for p in d["points"] if p["name"] == "f03")["x"]
    out = []
    for nm in OPEN_LINE[1:]:
        t1, v1 = series_of(d, nm)
        _, vv1 = resample(t1, v1)
        n = min(len(vv0), len(vv1))
        s1 = np.hypot(vv1[:n, 0], vv1[:n, 1])
        s1 = s1 - s1.mean()
        a = s0[:n]
        best = (None, -2.0)
        for lag in range(0, min(200, n // 2)):
            c = float((a[: n - lag] * s1[lag:n]).mean() / (a.std() * s1.std() + 1e-12))
            if c > best[1]:
                best = (lag * 0.1, c)
        x1 = next(p for p in d["points"] if p["name"] == nm)["x"]
        dist = (x1 - x0) / ppm
        out.append({"probe": nm, "distM": round(dist, 2), "lagS": best[0], "r": round(best[1], 3)})
    return out


def plot_series(d, out):
    fig, ax = plt.subplots(figsize=(12, 5))
    U = d["speed01"] * MPS
    for i, nm in enumerate(OPEN_LINE):
        t, v = series_of(d, nm)
        tt, vv = resample(t, v)
        sp = np.hypot(vv[:, 0], vv[:, 1])
        ax.plot(tt - tt[0], sp, lw=0.7, alpha=0.55, color=plt.cm.viridis(i / len(OPEN_LINE)), label=nm)
    t, v = series_of(d, CENTRE)
    tt, vv = resample(t, v)
    sp = np.hypot(vv[:, 0], vv[:, 1])
    s3 = running_mean(sp, 30)
    ax.plot(tt[29:] - tt[0] - 1.5, s3, color="k", lw=2, label=f"{CENTRE} 3-s mean")
    ax.axhline(U, color="r", ls="--", lw=1, label=f"dial {U:.1f} m/s")
    ax.set_xlabel("sim time (s)")
    ax.set_ylabel("speed (m/s)")
    ax.set_title(f"Baked wind field, open-field probe line (6.1 m apart along the wind), dial {d['speed01']} = {U:.1f} m/s")
    ax.legend(ncol=5, fontsize=8, loc="upper right")
    ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(out, dpi=110)
    plt.close(fig)


def plot_spectrum(runs, out):
    fig, ax = plt.subplots(figsize=(8, 6))
    for d in runs:
        t, v = series_of(d, CENTRE)
        tt, vv = resample(t, v)
        sp = np.hypot(vv[:, 0], vv[:, 1])
        if sp.std() <= 0:
            continue
        f, P = welch(sp, 0.1, seg=min(256, len(sp)))
        U = d["speed01"] * MPS
        ax.loglog(f, P / (U * U), label=f"{U:.1f} m/s")
    ff = np.array([0.05, 3])
    ax.loglog(ff, 0.02 * ff ** (-5 / 3), "k--", lw=1, label="-5/3")
    ax.set_xlabel("frequency (Hz)")
    ax.set_ylabel("PSD / U^2 (1/Hz)")
    ax.set_title(f"Speed spectrum at {CENTRE} (open field)")
    ax.legend(fontsize=8)
    ax.grid(alpha=0.3, which="both")
    fig.tight_layout()
    fig.savefig(out, dpi=110)
    plt.close(fig)


def plot_autocorr(runs, out):
    fig, ax = plt.subplots(figsize=(9, 5))
    for d in runs:
        t, v = series_of(d, CENTRE)
        tt, vv = resample(t, v)
        sp = np.hypot(vv[:, 0], vv[:, 1])
        if sp.std() <= 0:
            continue
        ac = autocorr(sp, min(len(sp) // 2, 300))
        ax.plot(np.arange(len(ac)) * 0.1, ac, label=f"{d['speed01'] * MPS:.1f} m/s")
    ax.axhline(0, color="k", lw=0.8)
    ax.axhline(1 / math.e, color="grey", ls=":", lw=0.8)
    ax.set_xlabel("lag (s)")
    ax.set_ylabel("autocorrelation of speed")
    ax.set_title(f"Does the wind repeat? Autocorrelation at {CENTRE}")
    ax.legend(fontsize=8)
    ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(out, dpi=110)
    plt.close(fig)


def plot_snapshot(d, out, idx=None):
    if not d["snaps"]:
        return
    snap = d["snaps"][len(d["snaps"]) // 2 if idx is None else idx]
    g = d["grid"]
    fx, fy = snapshot_arrays(d, snap)
    sp = np.hypot(fx, fy)
    U = d["speed01"] * MPS
    fig, ax = plt.subplots(figsize=(16, 11.2))
    ext = [g["originX"], g["originX"] + g["cols"] * g["cellSize"], g["originY"] + g["rows"] * g["cellSize"], g["originY"]]
    im = ax.imshow(sp / max(U, 1e-6), extent=ext, cmap="magma", vmin=0, vmax=2.2, interpolation="bilinear")
    cells = d.get("cells") or {}
    if cells.get("solid"):
        solid = np.asarray(cells["solid"], dtype=float).reshape(g["rows"], g["cols"])
        ax.contour(
            np.linspace(ext[0], ext[1], g["cols"]), np.linspace(ext[3], ext[2], g["rows"]), solid, levels=[0.5], colors="cyan", linewidths=0.8
        )
    step = max(1, g["cols"] // 64)
    ys, xs = np.mgrid[0 : g["rows"] : step, 0 : g["cols"] : step]
    X = g["originX"] + (xs + 0.5) * g["cellSize"]
    Y = g["originY"] + (ys + 0.5) * g["cellSize"]
    ax.quiver(X, Y, fx[::step, ::step], fy[::step, ::step], color="white", scale=U * 60 if U > 0 else 1, width=0.0012, alpha=0.8)
    for p in d["points"]:
        ax.plot(p["wx"], p["wy"], "c.", ms=3)
    ax.set_xlim(d["sceneOffset"]["x"], d["sceneOffset"]["x"] + 12000)
    ax.set_ylim(d["sceneOffset"]["y"] + 8400, d["sceneOffset"]["y"])
    ax.set_title(f"Baked wind field at t = {snap['t'] / 1000:.1f} s, dial {d['speed01']} ({U:.1f} m/s): colour = speed / dial (0..2.2), cyan = walls")
    fig.colorbar(im, ax=ax, fraction=0.025, label="speed / dial speed")
    fig.tight_layout()
    fig.savefig(out, dpi=90)
    plt.close(fig)


def plot_taylor(d, tay, out):
    U = d["speed01"] * MPS
    fig, ax = plt.subplots(figsize=(7, 5))
    xs = [r["distM"] for r in tay]
    ys = [r["lagS"] for r in tay]
    ax.plot(xs, ys, "o-", label="best-correlation lag")
    if U > 0:
        xx = np.linspace(0, max(xs) if xs else 1, 20)
        ax.plot(xx, xx / U, "r--", label=f"d / U (U = {U:.1f} m/s)")
    for r in tay:
        ax.annotate(f"r={r['r']}", (r["distM"], r["lagS"]), fontsize=7)
    ax.set_xlabel("separation along the wind (m)")
    ax.set_ylabel("lag (s)")
    ax.set_title("Do gusts travel downwind at the wind's speed?")
    ax.legend()
    ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(out, dpi=110)
    plt.close(fig)


def plot_places(runs, summary, out):
    names = [p["name"] for p in runs[0]["points"] if p["name"] not in OPEN_SET]
    fig, ax = plt.subplots(figsize=(16, 6))
    w = 0.8 / max(1, len(runs))
    for k, d in enumerate(runs):
        s = summary["speeds"][str(d["speed01"])]
        ref = s["openMeanMps"] or 1e-9
        vals = [(s["points"].get(n) or {}).get("meanMps", 0) / ref for n in names]
        ax.bar(np.arange(len(names)) + k * w, vals, w, label=f"{d['speed01'] * MPS:.1f} m/s")
    ax.axhline(1, color="k", lw=0.8)
    ax.set_xticks(np.arange(len(names)) + 0.4)
    ax.set_xticklabels(names, rotation=70, fontsize=8)
    ax.set_ylabel("mean speed / open-field mean")
    ax.set_title("Where the wind is: every named probe against the open field")
    ax.legend(fontsize=8)
    ax.grid(alpha=0.3, axis="y")
    fig.tight_layout()
    fig.savefig(out, dpi=110)
    plt.close(fig)


def main():
    run = Path(sys.argv[1])
    runs = load(run)
    if not runs:
        raise SystemExit(f"no speed-*.json in {run}")
    summary = {"run": str(run), "speeds": {}}
    for d in runs:
        pts = {}
        for p in d["points"]:
            pts[p["name"]] = point_stats(d, p["name"])
        open_means = [pts[n]["meanMps"] for n in OPEN_SET if pts.get(n)]
        open_mean = float(np.mean(open_means)) if open_means else None
        tay = taylor(d) if d["speed01"] > 0 else []
        sc = spatial_corr(d)
        summary["speeds"][str(d["speed01"])] = {
            "dialMps": round(d["speed01"] * MPS, 2),
            "openMeanMps": round(open_mean, 3) if open_mean is not None else None,
            "openMeanOverDial": round(open_mean / (d["speed01"] * MPS), 3) if open_mean and d["speed01"] > 0 else None,
            "samples": len(d["t"]),
            "simSpanS": round((d["t"][-1] - d["t"][0]) / 1000, 1) if d["t"] else 0,
            "grid": d["grid"],
            "taylor": tay,
            "spatial": sc,
            "points": pts,
        }
        tagS = f"{d['speed01']:.3f}"
        plot_series(d, run / f"series-{tagS}.png")
        plot_snapshot(d, run / f"snapshot-{tagS}.png")
        if tay:
            plot_taylor(d, tay, run / f"taylor-{tagS}.png")
    plot_spectrum(runs, run / "spectrum.png")
    plot_autocorr(runs, run / "autocorr.png")
    plot_places(runs, summary, run / "places.png")
    (run / "summary.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
    # A compact console table: the open field per speed.
    for k, s in summary["speeds"].items():
        c = s["points"].get(CENTRE) or {}
        sp = s["spatial"] or {}
        print(
            f"dial {k:>6} {s['dialMps']:6.1f} m/s | open mean {s['openMeanMps']} ({s['openMeanOverDial']}x) | "
            f"{CENTRE}: TI {c.get('TI')} G3 {c.get('gustFactor3s')} sTheta {c.get('sigmaThetaDeg')} deg "
            f"gusts {c.get('gusts')} lulls {c.get('lulls')} | L_along {sp.get('alongWindLm')} m "
            f"L_across {sp.get('acrossWindLm')} m CV {sp.get('openFieldSpeedCV')}"
        )


if __name__ == "__main__":
    main()
