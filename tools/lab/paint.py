"""tools/lab/paint.py - the MSA Lab painter (mmp-78u).

Reads a paint job (JSON from `node tools/lab/lab.mjs job`) and writes every floor image
and mask it names. Deterministic: same job in, same bytes out.

    python -I tools/lab/paint.py <job.json> <out_dir> [--quality 85] [--lossless-art]

Ops (all coordinates in image pixels, colours as byte lists):
    fill    {rgba}
    rect    {x, y, w, h, rgba, feather}  feather = 10-90% edge width in px (0 = hard)
    clear   {x, y, w, h}                 alpha 0 (a hole in the floor)
    text    {x, y, text, size, rgba}
    checker {x, y, w, h, cell, a, b}
    ellipse {cx, cy, rx, ry, rgba}       ~1 px anti-aliased edge (canopy cut-outs for _Tree/_Bush)
    paste   {src, sx, sy, sw, sh, x, y, flip, rot}  a crop of the author's own art (Lab · Vegetation),
                                         read from the job's artRoot; her art never enters the repo
    ramp    {x, y, w, h, a, b, axis}     linear colour ramp a -> b along x or y (Lab · Water depth ramps)
    blob    {cx, cy, rx, ry, peak, shore, wobble, seed}  a soft-shored grey pool for a _Water mask,
                                         MAX-merged (Lab · Water puddles, ponds, islands)

Encoding copies the author's maps: lossy WebP for everything, alpha kept exact.
After writing, each image is decoded again and its op regions are checked, so a codec
surprise (a grey that is no longer 128) is reported here, not discovered in Foundry.
"""

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

Image.MAX_IMAGE_PIXELS = None

FONT_PATHS = ["C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/arial.ttf"]


def font(size):
    for p in FONT_PATHS:
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default()


def rgba4(c):
    c = list(c)
    return tuple(c + [255]) if len(c) == 3 else tuple(c)


def paste_layer(img, layer):
    """Alpha-composite a full-size RGBA layer over img (both RGBA)."""
    img.alpha_composite(layer)


def op_rect(img, o):
    x, y, w, h = (int(round(o[k])) for k in ("x", "y", "w", "h"))
    col = rgba4(o["rgba"])
    feather = float(o.get("feather") or 0)
    if feather <= 0:
        # hard rect: replace pixels (including alpha), like a painted solid area
        img.paste(col, (x, y, x + w, y + h))
        return
    # Soft edge: a Gaussian with 10-90% width `feather` has sigma = feather / 2.563.
    sigma = feather / 2.563
    pad = int(sigma * 4) + 2
    X0, Y0 = max(0, x - pad), max(0, y - pad)
    X1, Y1 = min(img.width, x + w + pad), min(img.height, y + h + pad)
    m = Image.new("L", (X1 - X0, Y1 - Y0), 0)
    ImageDraw.Draw(m).rectangle([x - X0, y - Y0, x - X0 + w - 1, y - Y0 + h - 1], fill=255)
    m = m.filter(ImageFilter.GaussianBlur(sigma))
    region = img.crop((X0, Y0, X1, Y1))
    solid = Image.new("RGBA", region.size, col)
    region = Image.composite(solid, region, m)
    img.paste(region, (X0, Y0))


def op_clear(img, o):
    x, y, w, h = (int(round(o[k])) for k in ("x", "y", "w", "h"))
    img.paste((0, 0, 0, 0), (x, y, x + w, y + h))


def op_text(img, o):
    d = ImageDraw.Draw(img)
    d.text((o["x"], o["y"]), o["text"], fill=rgba4(o["rgba"]), font=font(int(o["size"])))


def op_checker(img, o):
    x, y, w, h, cell = (int(o[k]) for k in ("x", "y", "w", "h", "cell"))
    a, b = np.array(rgba4(o["a"]), np.uint8), np.array(rgba4(o["b"]), np.uint8)
    yy, xx = np.mgrid[0:h, 0:w]
    pick = ((yy // cell + xx // cell) % 2).astype(bool)
    block = np.where(pick[..., None], b, a).astype(np.uint8)
    img.paste(Image.fromarray(block, "RGBA"), (x, y))


def op_ellipse(img, o):
    """A filled ellipse with a ~1 px anti-aliased edge (drawn at 4x, box-downsampled).

    For _Tree/_Bush canopies: the author's cut-outs have hard 1-2 px alpha edges and keep the
    leaf colour under partial alpha, so the colour is written wherever coverage > 0 and the
    alpha takes the coverage (no dark fringe from premultiplying onto transparent black).
    """
    cx, cy, rx, ry = (float(o[k]) for k in ("cx", "cy", "rx", "ry"))
    col = rgba4(o["rgba"])
    ss = 4
    X0, Y0 = max(0, int(cx - rx) - 2), max(0, int(cy - ry) - 2)
    X1, Y1 = min(img.width, int(cx + rx) + 3), min(img.height, int(cy + ry) + 3)
    m = Image.new("L", ((X1 - X0) * ss, (Y1 - Y0) * ss), 0)
    ImageDraw.Draw(m).ellipse(
        [(cx - rx - X0) * ss, (cy - ry - Y0) * ss, (cx + rx - X0) * ss, (cy + ry - Y0) * ss], fill=255
    )
    m = np.asarray(m.resize((X1 - X0, Y1 - Y0), Image.BOX)).astype(np.float32) / 255.0
    region = np.asarray(img.crop((X0, Y0, X1, Y1))).astype(np.float32)
    cover = m * (col[3] / 255.0)
    inside = cover > 0
    out = region.copy()
    out[inside, 0:3] = col[0:3]
    out[..., 3] = np.maximum(region[..., 3], cover * 255.0)
    img.paste(Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8), "RGBA"), (X0, Y0))


_ART_CACHE = {}


def op_paste(img, o):
    """Paste a crop of one of the author's own images (her real _Tree/_Bush art) at (x, y).

    o = {src, sx, sy, sw, sh, x, y, flip?, rot?}: `src` is relative to the job's `artRoot` (her
    maps folder lives outside the public MSA repo, so the lab never commits her art: the spec
    names a file and a rectangle, and the painted result stays in the git-ignored out/ folder).
    `flip` mirrors left-right, `rot` turns by a multiple of 90 degrees (her maps reuse stamps
    turned and mirrored). Pixels are alpha-composited, keeping the leaf colour under the
    author's own alpha edge exactly.
    """
    root = Path(o["artRoot"])
    p = root / o["src"]
    if p not in _ART_CACHE:
        if not p.exists():
            raise SystemExit(f"paste: art not found: {p} (pass --art-root to lab.mjs paint)")
        _ART_CACHE[p] = Image.open(p).convert("RGBA")
    src = _ART_CACHE[p]
    sx, sy, sw, sh = (int(o[k]) for k in ("sx", "sy", "sw", "sh"))
    c = src.crop((sx, sy, sx + sw, sy + sh))
    if o.get("flip"):
        c = c.transpose(Image.FLIP_LEFT_RIGHT)
    rot = int(o.get("rot") or 0) % 360
    if rot:
        c = c.rotate(rot, expand=True)
    x, y = int(round(o["x"])), int(round(o["y"]))
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    layer.paste(c, (x, y))
    img.alpha_composite(layer)


def op_ramp(img, o):
    """A linear colour ramp over a rectangle: colour `a` at the start edge, `b` at the far edge.

    o = {x, y, w, h, a, b, axis}: axis 'x' runs left -> right, 'y' top -> bottom. Lab · Water paints
    its depth ramps with it (a _Water mask from 0 to 255 = dry to deepest), and sand-to-rock beds.
    """
    x, y, w, h = (int(round(o[k])) for k in ("x", "y", "w", "h"))
    a = np.array(rgba4(o["a"]), np.float32)
    b = np.array(rgba4(o["b"]), np.float32)
    n = w if o.get("axis", "x") == "x" else h
    t = (np.arange(n, dtype=np.float32) + 0.5) / max(1, n)
    line = a[None, :] * (1.0 - t[:, None]) + b[None, :] * t[:, None]
    if o.get("axis", "x") == "x":
        block = np.broadcast_to(line[None, :, :], (h, w, 4))
    else:
        block = np.broadcast_to(line[:, None, :], (h, w, 4))
    img.paste(Image.fromarray(np.clip(block + 0.5, 0, 255).astype(np.uint8), "RGBA"), (x, y))


def op_blob(img, o):
    """A soft-shored body of water for a _Water mask (grey), merged with what is there by MAX.

    o = {cx, cy, rx, ry, peak, shore, wobble?, seed?}: the value is `peak` (0-255) in the middle and
    falls to 0 at the rim; `shore` is the fraction of the radius over which it rises from 0 at the
    rim to `peak` (smoothstep), so shore 1 is a dome, 0.1 a flat pool with a narrow sloping bank and
    0 a hard-edged pool. `wobble` bends the rim by up to that fraction of the radius with a few
    deterministic harmonics, so puddles and ponds are not perfect ellipses.
    """
    cx, cy, rx, ry = (float(o[k]) for k in ("cx", "cy", "rx", "ry"))
    peak = float(o["peak"])
    shore = max(0.0, float(o.get("shore", 0.2)))
    wob = float(o.get("wobble", 0.0))
    seed = int(o.get("seed", 1))
    reach = 1.0 + abs(wob)
    X0, Y0 = max(0, int(cx - rx * reach) - 2), max(0, int(cy - ry * reach) - 2)
    X1, Y1 = min(img.width, int(cx + rx * reach) + 3), min(img.height, int(cy + ry * reach) + 3)
    yy, xx = np.mgrid[Y0:Y1, X0:X1].astype(np.float32)
    dx, dy = (xx + 0.5 - cx) / rx, (yy + 0.5 - cy) / ry
    r = np.sqrt(dx * dx + dy * dy)
    if wob:
        th = np.arctan2(dy, dx)
        rng = np.random.default_rng(seed)
        bend = np.zeros_like(th)
        for k in (2, 3, 5, 7):
            bend += np.sin(k * th + rng.uniform(0, 2 * np.pi)) / k
        r = r / (1.0 + wob * bend / 1.03)
    if shore <= 0:
        # hard pool: ~1 px anti-aliased rim in pixel units
        edge_px = np.clip((1.0 - r) * min(rx, ry) + 0.5, 0.0, 1.0)
        v = peak * edge_px
    else:
        t = np.clip((1.0 - r) / shore, 0.0, 1.0)
        v = peak * t * t * (3.0 - 2.0 * t)
    region = np.asarray(img.crop((X0, Y0, X1, Y1))).astype(np.float32)
    grey = np.maximum(region[..., 0], v)
    out = region.copy()
    out[..., 0] = out[..., 1] = out[..., 2] = grey
    out[..., 3] = 255.0
    img.paste(Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8), "RGBA"), (X0, Y0))


def _path_samples(points, widths, step=8.0):
    """Catmull-Rom through `points` (end points repeated): dense samples, their widths, unit left normals and
    signed curvature (centre of curvature at p + n / k)."""
    P = np.array(points, np.float64)
    W = np.array(widths if isinstance(widths, (list, tuple)) else [widths] * len(points), np.float64)
    Pp = np.vstack([P[0] * 2 - P[1], P, P[-1] * 2 - P[-2]])
    Wp = np.concatenate([[W[0]], W, [W[-1]]])
    out, ws = [], []
    for i in range(1, len(Pp) - 2):
        p0, p1, p2, p3 = Pp[i - 1], Pp[i], Pp[i + 1], Pp[i + 2]
        n = max(2, int(np.linalg.norm(p2 - p1) / step))
        for j in range(n):
            t = j / n
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
            ws.append(Wp[i] + (Wp[i + 1] - Wp[i]) * t)
    out.append(Pp[-2])
    ws.append(Wp[-2])
    S = np.array(out)
    d1 = np.gradient(S, axis=0)
    d2 = np.gradient(d1, axis=0)
    sp = np.maximum(np.linalg.norm(d1, axis=1), 1e-6)
    nrm = np.stack([-d1[:, 1], d1[:, 0]], axis=1) / sp[:, None]
    k = (d1[:, 0] * d2[:, 1] - d1[:, 1] * d2[:, 0]) / sp**3
    return S, np.array(ws), nrm, k


def _smooth1d(a, n):
    if n <= 1:
        return a
    ker = np.ones(n) / n
    pad = np.pad(a, (n // 2, n - 1 - n // 2), mode="edge")
    return np.convolve(pad, ker, mode="valid")


def _disc_layer(size, centres, radii, blur, q=4):
    """A soft coverage layer (float 0..1, full size): discs along a path, drawn at 1/q and Gaussian-blurred."""
    W, H = size
    lay = Image.new("L", ((W + q - 1) // q, (H + q - 1) // q), 0)
    d = ImageDraw.Draw(lay)
    for (x, y), r in zip(centres, radii):
        r = max(0.5, r / q)
        d.ellipse([x / q - r, y / q - r, x / q + r, y / q + r], fill=255)
    if blur > 0:
        lay = lay.filter(ImageFilter.GaussianBlur(radius=blur / q))
    lay = lay.resize((W, H), Image.BILINEAR)
    return np.asarray(lay).astype(np.float32) / 255.0


def op_channel(img, o):
    """A river along a smooth path (Lab · River).

    o = {points: [[x, y], ...], width: px or [px per point], bank: px, peak, core: {width, peak, outer, blur},
         rgba?, coreRgba?}
    The channel rises from 0 at its banks over `bank` px to `peak`; a deeper core (`core.width` wide, `core.peak`)
    is pushed toward the OUTSIDE of each bend by `core.outer` (0..1 of the free width): the cut bank is deep, the
    inside of the bend a shallow point bar, as in a real river. Mask images MAX-merge greys; art images (`rgba`
    given) paint the bank colour with the channel's coverage, then `coreRgba` with the core's.
    """
    S, ws, nrm, k = _path_samples(o["points"], o["width"])
    bank = float(o.get("bank", 60))
    A = _disc_layer(img.size, S, np.maximum(1.0, ws / 2 - bank / 2), bank / 2)
    core = o.get("core")
    B = None
    if core:
        cw = float(core["width"])
        free = np.maximum(0.0, ws / 2 - cw / 2 - bank / 2)
        bend = np.tanh(np.abs(k) * ws * 1.5)
        off = _smooth1d(-np.sign(k) * bend * free * float(core.get("outer", 0.6)), 31)
        C = S + nrm * off[:, None]
        B = _disc_layer(img.size, C, np.full(len(C), cw / 2), float(core.get("blur", cw / 3)))
    region = np.asarray(img).astype(np.float32)
    if "rgba" in o:
        out = region.copy()
        for cov, col in ((A, o["rgba"]), (B, o.get("coreRgba"))):
            if cov is None or col is None:
                continue
            c = np.array(rgba4(col), np.float32)
            out[..., :3] = out[..., :3] * (1 - cov[..., None]) + c[:3] * cov[..., None]
        out[..., 3] = 255.0
    else:
        grey = np.maximum(region[..., 0], A * float(o["peak"]))
        if B is not None:
            grey = np.maximum(grey, B * float(core["peak"]))
        out = region.copy()
        out[..., 0] = out[..., 1] = out[..., 2] = grey
        out[..., 3] = 255.0
    img.paste(Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8), "RGBA"), (0, 0))


def op_dip(img, o):
    """Cut a soft shallow (or a dry rock) INTO a _Water mask by MIN (Lab · River rocks and riffles).

    o = {cx, cy, rx, ry, floor, shore, wobble?, seed?}: inside, the mask falls to `floor` (0 = dry rock), easing
    in over `shore` of the radius (smoothstep; 0 = a hard edge) — where the mask is already shallower it is kept.
    """
    cx, cy, rx, ry = (float(o[k]) for k in ("cx", "cy", "rx", "ry"))
    floor = float(o.get("floor", 0))
    shore = max(0.0, float(o.get("shore", 0.2)))
    wob = float(o.get("wobble", 0.0))
    reach = 1.0 + abs(wob)
    X0, Y0 = max(0, int(cx - rx * reach) - 2), max(0, int(cy - ry * reach) - 2)
    X1, Y1 = min(img.width, int(cx + rx * reach) + 3), min(img.height, int(cy + ry * reach) + 3)
    if X1 <= X0 or Y1 <= Y0:
        return
    yy, xx = np.mgrid[Y0:Y1, X0:X1].astype(np.float32)
    dx, dy = (xx + 0.5 - cx) / rx, (yy + 0.5 - cy) / ry
    r = np.sqrt(dx * dx + dy * dy)
    if wob:
        th = np.arctan2(dy, dx)
        rng = np.random.default_rng(int(o.get("seed", 1)))
        bend = np.zeros_like(th)
        for kk in (2, 3, 5, 7):
            bend += np.sin(kk * th + rng.uniform(0, 2 * np.pi)) / kk
        r = r / (1.0 + wob * bend / 1.03)
    if shore <= 0:
        t = np.clip((1.0 - r) * min(rx, ry) + 0.5, 0.0, 1.0)
    else:
        t = np.clip((1.0 - r) / shore, 0.0, 1.0)
        t = t * t * (3.0 - 2.0 * t)
    region = np.asarray(img.crop((X0, Y0, X1, Y1))).astype(np.float32)
    if "rgba" in o:
        c = np.array(rgba4(o["rgba"]), np.float32)
        out = region.copy()
        out[..., :3] = region[..., :3] * (1 - t[..., None]) + c[:3] * t[..., None]
    else:
        g = region[..., 0]
        grey = np.minimum(g, g * (1 - t) + floor * t)
        out = region.copy()
        out[..., 0] = out[..., 1] = out[..., 2] = grey
    out[..., 3] = 255.0
    img.paste(Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8), "RGBA"), (X0, Y0))


OPS = {
    "channel": op_channel,
    "dip": op_dip,
    "rect": op_rect,
    "clear": op_clear,
    "text": op_text,
    "checker": op_checker,
    "ellipse": op_ellipse,
    "paste": op_paste,
    "ramp": op_ramp,
    "blob": op_blob,
}


def render(spec):
    w, h = spec["w"], spec["h"]
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    for o in spec["ops"]:
        if o["op"] == "fill":
            img.paste(rgba4(o["rgba"]), (0, 0, w, h))
        else:
            OPS[o["op"]](img, o)
    return img


def save(img, spec, out, quality, lossless_art):
    mode = spec["mode"]
    im = img if mode == "RGBA" else img.convert(mode)
    lossless = lossless_art and spec["role"] == "art"
    # method 6 = slowest/best; exact=True keeps RGB under alpha 0 (does not matter here)
    im.save(out, "WEBP", quality=quality, lossless=lossless, method=4, alpha_quality=100)


def verify(img, out):
    """Decode the written file and compare it with the image before encoding.

    Reports how many floor-grey (128) pixels survived the codec exactly, the worst grey
    error, and the 99.9th percentile error over all opaque pixels.
    """
    r = np.asarray(img).astype(np.int16)
    d = np.asarray(Image.open(out).convert("RGBA")).astype(np.int16)
    step = 3  # subsample: plenty for statistics, 9x faster
    r, d = r[::step, ::step], d[::step, ::step]
    opaque = r[..., 3] > 0
    if not opaque.any():
        return ["fully transparent"]
    notes = []
    alpha_bad = int((r[..., 3] != d[..., 3]).sum())
    if alpha_bad:
        notes.append(f"alpha changed on {alpha_bad} sampled px")
    grey = opaque & (r[..., 0] == 128) & (r[..., 1] == 128) & (r[..., 2] == 128)
    if grey.any():
        g = np.abs(d[grey][:, :3] - 128).max(axis=1)
        notes.append(f"grey128 exact {100.0 * (g == 0).mean():.2f}% max dev {int(g.max())}")
    err = np.abs(d[opaque][:, :3] - r[opaque][:, :3]).max(axis=1)
    notes.append(f"p99.9 err {int(np.percentile(err, 99.9))}")
    return notes


def main():
    job = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    quality = 85
    if "--quality" in sys.argv:
        quality = int(sys.argv[sys.argv.index("--quality") + 1])
    lossless_art = "--lossless-art" in sys.argv
    report = []
    for spec in job["images"]:
        img = render(spec)
        out = out_dir / spec["name"]
        save(img, spec, out, quality, lossless_art)
        notes = verify(img, out)
        report.append({"name": spec["name"], "bytes": out.stat().st_size, "notes": notes})
        print(f"{spec['name']}: {out.stat().st_size // 1024} KB {'; '.join(notes)}", flush=True)
    (out_dir / "paint-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
