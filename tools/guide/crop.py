"""tools/guide/crop.py — finish the guide's pictures (mmp-0mv).

    python tools/guide/crop.py --data <Foundry Data dir> [--raw tools/guide/raw] [--only id,id]

For every shot in guide/shots.json that tools/guide/shoot.mjs has rendered:
  * the Map Shine render is resized to the guide size and saved as WebP;
  * the SAME map rectangle is cut from the plain map art (plus any overlay layers)
    and from each mask file named in the shot, so every picture lines up exactly;
  * masks with transparency are shown over a grey checkerboard, so "transparent"
    never looks like "black";
  * the shot's notes (callouts with arrows) are drawn on top, in the guide's style.

All images land in guide/images/ as WebP, sized so a whole map can't be rebuilt
from them (Ingram 2026-11-07): the longest side is at most 1600 px.
"""
import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

Image.MAX_IMAGE_PIXELS = None
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "guide" / "images"
GOLD = (231, 195, 104)
INK = (20, 16, 8)
FONT_BOLD = "C:/Windows/Fonts/segoeuib.ttf"
FONT = "C:/Windows/Fonts/segoeui.ttf"


def font(size, bold=True):
    try:
        return ImageFont.truetype(FONT_BOLD if bold else FONT, size)
    except OSError:
        return ImageFont.load_default()


def crop_norm(path, uv, size, bg):
    """Cut the normalised rect uv (may run past 0..1) from an image and fit it to size."""
    im = Image.open(path)
    w, h = im.size
    box = (uv["u0"] * w, uv["v0"] * h, uv["u1"] * w, uv["v1"] * h)
    # Decode only what is needed: draft for JPEG, plain crop otherwise.
    ib = (max(0, int(box[0])), max(0, int(box[1])), min(w, int(box[2]) + 1), min(h, int(box[3]) + 1))
    piece = im.crop(ib).convert("RGBA")
    out_w = box[2] - box[0]
    out_h = box[3] - box[1]
    canvas = Image.new("RGBA", (max(1, round(out_w)), max(1, round(out_h))), (0, 0, 0, 0))
    canvas.paste(piece, (round(ib[0] - box[0]), round(ib[1] - box[1])))
    canvas = canvas.resize(size, Image.LANCZOS)
    if bg is None:
        return canvas
    base = bg(size)
    base.alpha_composite(canvas)
    return base


def black(size):
    return Image.new("RGBA", size, (0, 0, 0, 255))


def checker(size, cell=16):
    im = Image.new("RGBA", size, (92, 92, 98, 255))
    d = ImageDraw.Draw(im)
    for y in range(0, size[1], cell):
        for x in range(0, size[0], cell):
            if (x // cell + y // cell) % 2:
                d.rectangle([x, y, x + cell - 1, y + cell - 1], fill=(120, 120, 128, 255))
    return im


def draw_notes(im, notes):
    """Callouts: a gold pill with dark text, and an optional arrow to the point it names."""
    d = ImageDraw.Draw(im)
    W, H = im.size
    f = font(max(18, W // 62))
    for n in notes:
        ax, ay = n["at"][0] * W, n["at"][1] * H
        text = n["text"]
        tw = d.textlength(text, font=f)
        pad = f.size * 0.55
        bw, bh = tw + pad * 2, f.size * 1.75
        x0 = min(max(8, ax - bw / 2), W - bw - 8)
        y0 = min(max(8, ay - bh / 2), H - bh - 8)
        if "to" in n:
            tx, ty = n["to"][0] * W, n["to"][1] * H
            sx, sy = x0 + bw / 2, y0 + bh / 2
            for width, col in ((9, (0, 0, 0, 150)), (5, GOLD + (255,))):
                d.line([(sx, sy), (tx, ty)], fill=col, width=width)
            r = 9
            d.ellipse([tx - r - 2, ty - r - 2, tx + r + 2, ty + r + 2], fill=(0, 0, 0, 150))
            d.ellipse([tx - r, ty - r, tx + r, ty + r], fill=GOLD + (255,), outline=INK + (255,), width=2)
        d.rounded_rectangle([x0 + 2, y0 + 3, x0 + bw + 2, y0 + bh + 3], radius=bh / 2, fill=(0, 0, 0, 120))
        d.rounded_rectangle([x0, y0, x0 + bw, y0 + bh], radius=bh / 2, fill=GOLD + (255,))
        d.text((x0 + pad, y0 + bh / 2), text, font=f, fill=INK + (255,), anchor="lm")
    return im


def label(im, text):
    """A small corner tag naming what the picture is ("Plain art", "Map Shine", "_Water mask")."""
    d = ImageDraw.Draw(im)
    f = font(max(16, im.size[0] // 80))
    tw = d.textlength(text, font=f)
    d.rounded_rectangle([12, 12, 12 + tw + 22, 12 + f.size * 1.7], radius=8, fill=(0, 0, 0, 170))
    d.text((23, 12 + f.size * 0.85), text, font=f, fill=(255, 255, 255, 255), anchor="lm")
    return im


def save(im, name, quality):
    OUT.mkdir(parents=True, exist_ok=True)
    im.convert("RGB").save(OUT / name, "WEBP", quality=quality, method=6)
    print(f"  {name}  {(OUT / name).stat().st_size // 1024} KB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--raw", default=str(REPO / "tools" / "guide" / "raw"))
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    data = Path(a.data)
    raw = Path(a.raw)
    manifest = json.loads((REPO / "guide" / "shots.json").read_text(encoding="utf-8"))
    size = tuple(manifest.get("viewport", [1600, 900]))
    quality = manifest.get("quality", 82)
    only = set(filter(None, a.only.split(",")))
    for shot in manifest["shots"]:
        sid = shot["id"]
        if only and sid not in only:
            continue
        info_p = raw / f"{sid}.json"
        if not info_p.exists():
            print(f"[skip] {sid}: not rendered yet")
            continue
        info = json.loads(info_p.read_text(encoding="utf-8"))
        uv = info["uv"]
        out = shot.get("out", {})
        notes = shot.get("notes", [])
        print(f"[{sid}] {shot['scene']}")
        if "msa" in out:
            im = Image.open(raw / f"{sid}-msa.png").convert("RGBA").resize(size, Image.LANCZOS)
            if shot.get("tags"):
                label(im, "Map Shine")
            save(draw_notes(im, [n for n in notes if n.get("on", "msa") == "msa"]), out["msa"], quality)
        if "art" in out:
            art = data / info["art"]
            im = crop_norm(art, uv, size, black)
            for layer in shot.get("artLayers", []):
                im.alpha_composite(crop_norm(data / layer, uv, size, None))
            if shot.get("tags"):
                label(im, "Plain art")
            save(draw_notes(im, [n for n in notes if n.get("on") == "art"]), out["art"], quality)
        for m in out.get("masks", []):
            bg = checker if m.get("bg") == "checker" else black
            im = crop_norm(data / m["file"], uv, size, bg)
            if shot.get("tags"):
                label(im, m.get("label", "Mask"))
            save(draw_notes(im, [n for n in notes if n.get("on") == m["name"]]), m["name"], quality)


if __name__ == "__main__":
    main()
