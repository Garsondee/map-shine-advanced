"""tools/lab/water-sheet.py - labelled contact sheets of Lab · Water shots.

    python -I tools/lab/water-sheet.py <out.jpg> <cols> <label=path.png> [<label=path.png> ...]
        [--crop x0,y0,x1,y1]  (same crop, in shot pixels, applied to every shot)
        [--width 1200]        (each cell's width after scaling)

Every cell gets its label in a dark bar on top, so before/after pairs read at a glance.
"""

import sys

from PIL import Image, ImageDraw, ImageFont


def font(size):
    for p in ("C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/arial.ttf"):
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default()


def main():
    args = sys.argv[1:]
    crop = None
    width = 1200
    if "--crop" in args:
        i = args.index("--crop")
        crop = tuple(int(v) for v in args[i + 1].split(","))
        del args[i : i + 2]
    if "--width" in args:
        i = args.index("--width")
        width = int(args[i + 1])
        del args[i : i + 2]
    out, cols, items = args[0], int(args[1]), args[2:]
    cells = []
    for it in items:
        label, path = it.split("=", 1)
        im = Image.open(path).convert("RGB")
        if crop:
            im = im.crop(crop)
        h = round(im.height * width / im.width)
        cells.append((label, im.resize((width, h), Image.LANCZOS)))
    bar = 44
    ch = max(c[1].height for c in cells) + bar
    rows = (len(cells) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * width + (cols - 1) * 8, rows * ch + (rows - 1) * 8), (24, 24, 24))
    d = ImageDraw.Draw(sheet)
    f = font(28)
    for k, (label, im) in enumerate(cells):
        x, y = (k % cols) * (width + 8), (k // cols) * (ch + 8)
        d.rectangle([x, y, x + width, y + bar], fill=(16, 16, 16))
        d.text((x + 12, y + 7), label, fill=(235, 235, 235), font=f)
        sheet.paste(im, (x, y + bar))
    sheet.save(out, quality=90)
    print(out, sheet.size)


if __name__ == "__main__":
    main()
