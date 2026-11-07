"""Make the source images for the Krita/GIMP round trips (mmp-0mv.18).

    python tools/guide/editor-tests/make-sources.py <dir>   -> <dir>/src/a.png, b.png, c.png

a: left half fully transparent but still holding red (what erasing leaves in Krita and GIMP),
b: 50% grey left / white right, c: a one-pixel white line on black.
"""
import sys
from pathlib import Path
from PIL import Image

src = Path(sys.argv[1]) / "src"
src.mkdir(parents=True, exist_ok=True)
a = Image.new("RGBA", (64, 64), (255, 0, 0, 255))
a.paste((255, 0, 0, 0), (0, 0, 32, 64))
a.save(src / "a.png")
b = Image.new("RGB", (64, 64), (255, 255, 255))
b.paste((128, 128, 128), (0, 0, 32, 64))
b.save(src / "b.png")
c = Image.new("RGB", (64, 64), (0, 0, 0))
c.paste((255, 255, 255), (8, 32, 56, 33))
c.save(src / "c.png")
