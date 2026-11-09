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


OPS = {
    "rect": op_rect,
    "clear": op_clear,
    "text": op_text,
    "checker": op_checker,
    "ellipse": op_ellipse,
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
