"""tools/lab/flicker.py — where does weather MOVE on screen? (MSA Lab, weather family)

Rain, snow and splashes are the only things on a still lab scene that change from frame to frame, so the
per-pixel temporal spread of a stack of presented frames is a map of where precipitation is drawn. Reads the
frames written by `weather-frames.mjs` (or any same-size PNG stack) and prints, for each named box, the mean
temporal standard deviation and the share of pixels whose spread exceeds a threshold ("rain coverage").

  python -I tools/lab/flicker.py <frames-dir> <boxes.json> [--out heat.png] [--thresh 6]

boxes.json: [{"name": "...", "x0":..,"y0":..,"x1":..,"y1":..}] in IMAGE pixels (device px of the screenshots).
Writes a heat map (spread x 8, clipped) beside the frames when --out is given. Pure measurement: no Foundry.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image


def main():
    frames_dir = Path(sys.argv[1])
    boxes = json.loads(Path(sys.argv[2]).read_text())
    out = None
    thresh = 6.0
    if "--out" in sys.argv:
        out = sys.argv[sys.argv.index("--out") + 1]
    if "--thresh" in sys.argv:
        thresh = float(sys.argv[sys.argv.index("--thresh") + 1])
    files = sorted(frames_dir.glob("f*.png"))
    if len(files) < 3:
        raise SystemExit(f"need >= 3 frames in {frames_dir}, found {len(files)}")
    stack = np.stack([np.asarray(Image.open(f).convert("L"), dtype=np.float32) for f in files])
    spread = stack.std(axis=0)
    mean = stack.mean(axis=0)
    # SPECKS: drops and splashes are small and sharp; fog, veil and cloud shade move as broad smooth fields.
    # High-pass the spread map (minus its own 9 px-sigma blur) so only the specks remain.
    from PIL import ImageFilter

    smooth = np.asarray(
        Image.fromarray(np.clip(spread * 8, 0, 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(9)),
        dtype=np.float32,
    ) / 8.0
    speck = spread - smooth
    res = {"frames": len(files), "size": [int(spread.shape[1]), int(spread.shape[0])], "thresh": thresh, "boxes": {}}
    for b in boxes:
        s = spread[b["y0"]:b["y1"], b["x0"]:b["x1"]]
        m = mean[b["y0"]:b["y1"], b["x0"]:b["x1"]]
        res["boxes"][b["name"]] = {
            "spreadMean": round(float(s.mean()), 3),
            "spreadP95": round(float(np.percentile(s, 95)), 2),
            "coverage": round(float((s > thresh).mean()), 4),
            "speckCoverage": round(float((speck[b["y0"]:b["y1"], b["x0"]:b["x1"]] > thresh).mean()), 5),
            "lumaMean": round(float(m.mean()), 1),
        }
    if out:
        heat = np.clip(spread * 8, 0, 255).astype(np.uint8)
        Image.fromarray(heat, "L").save(out)
    print(json.dumps(res))


if __name__ == "__main__":
    main()
