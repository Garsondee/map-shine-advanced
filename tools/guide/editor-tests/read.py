"""Read the Photoshop test exports the way Map Shine reads masks (red channel, alpha)."""
import sys
from pathlib import Path
from PIL import Image

out = Path(sys.argv[1])
for f in sorted(out.glob("*.*")):
    if f.suffix.lower() not in (".png", ".webp"):
        continue
    im = Image.open(f)
    mode = im.mode
    rgba = im.convert("RGBA")
    px = rgba.load()
    w, h = rgba.size
    if f.name.startswith("a-"):
        left = px[8, 8]
        right = px[48, 8]
        print(f"{f.name:28} mode={mode:5} transparent px RGBA={left}  opaque px RGBA={right}")
    elif f.name.startswith("b-"):
        print(f"{f.name:28} mode={mode:5} painted 128 reads back as {px[8, 8][:3]}  (white side {px[48, 8][:3]})")
    elif f.name.startswith("c-"):
        line = [px[x, 32][0] for x in range(8, 56)]
        above = [px[x, 30][0] for x in range(8, 56)]
        print(
            f"{f.name:28} mode={mode:5} line red min/max={min(line)}/{max(line)}  "
            f"2px above max={max(above)}  bytes={f.stat().st_size}"
        )
