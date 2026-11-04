"""tools/video-capture/storyboard.py — plan a map video on the plain albedo before rendering it.

    python tools/video-capture/storyboard.py --plan plan.json --survey survey.json --data <Foundry Data dir> --out <dir>
        [--legible 0.45] [--width 1600]

Reads the same plan record.mjs renders and the scene facts `record.mjs survey` exports, and writes:
  storyboard.png   one panel per level: every shot's camera path (numbered) and its first/last frame,
                   the COVERAGE map (green = seen at a readable zoom, red = map never seen), and a
                   timeline strip (shot length, time of day as sky colour, weather)
  shots.png        a contact sheet: each shot's first / middle / last frame cut from the albedo
  coverage.json    per level: % of the map's content seen at >= --legible zoom, plus the gaps

Coverage counts a map pixel once it has sat inside the frame while the camera scale was at least
--legible (screen px per map px; 0.45 at 4K = a 150 px grid square drawn ~67 px wide). One
zoomed-out shot would otherwise "cover" everything and prove nothing. Empty void around a level's
art (an underground level's grey surround) does not count as content.

The camera maths (keys, easing, geometric zoom) is a line-for-line port of record.mjs's camAt, so
what this draws is where the render will point.
"""
import argparse, json, math, os
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

Image.MAX_IMAGE_PIXELS = None

EASE = {
    'linear': lambda u: u,
    'cosine': lambda u: 0.5 - 0.5 * math.cos(math.pi * u),
    'smooth': lambda u: u * u * u * (u * (u * 6 - 15) + 10),
}

PALETTE = [(255, 99, 71), (255, 196, 0), (80, 200, 255), (130, 255, 120), (255, 120, 220), (255, 160, 60),
           (120, 160, 255), (0, 230, 200), (230, 230, 120), (200, 140, 255), (255, 255, 255), (160, 255, 200),
           (255, 140, 140), (140, 220, 255), (255, 220, 160)]


def clamp_keys(shot, rect, vp):
    """Pull every key in so its frame stays on the map (a frame wider than the map is centred).
    Keys, not frames: clamping each frame would stop the camera dead at the edge mid-move.
    Same rule as record.mjs's clampKey. `"allowOutside": true` on a shot opts out."""
    if shot.get('allowOutside'):
        return
    for k in shot['keys']:
        hw, hh = vp['width'] / 2 / k['scale'], vp['height'] / 2 / k['scale']
        cx, cy = rect['x'] + rect['width'] / 2, rect['y'] + rect['height'] / 2
        k['x'] = cx if 2 * hw >= rect['width'] else min(max(k['x'], rect['x'] + hw), rect['x'] + rect['width'] - hw)
        k['y'] = cy if 2 * hh >= rect['height'] else min(max(k['y'], rect['y'] + hh), rect['y'] + rect['height'] - hh)


def cam_at(shot, u):
    keys = sorted(shot['keys'], key=lambda k: k['t'])
    ease = EASE.get(shot.get('easing', 'cosine'), EASE['cosine'])
    if u <= keys[0]['t']:
        return keys[0]
    if u >= keys[-1]['t']:
        return keys[-1]
    i = 0
    while i < len(keys) - 2 and u > keys[i + 1]['t']:
        i += 1
    a, b = keys[i], keys[i + 1]
    s = ease((u - a['t']) / max(1e-9, b['t'] - a['t']))
    return {'x': a['x'] + (b['x'] - a['x']) * s, 'y': a['y'] + (b['y'] - a['y']) * s,
            'scale': a['scale'] * (b['scale'] / a['scale']) ** s}


def view_rect(cam, vp):
    hw, hh = vp['width'] / 2 / cam['scale'], vp['height'] / 2 / cam['scale']
    return cam['x'] - hw, cam['y'] - hh, cam['x'] + hw, cam['y'] + hh


def sky_colour(hour):
    """A readable swatch for the time of day (night navy, dawn rose, noon blue, dusk amber)."""
    stops = [(0, (20, 24, 60)), (5, (25, 30, 70)), (6.5, (230, 140, 120)), (9, (140, 190, 240)), (13, (110, 175, 245)),
             (17, (150, 180, 230)), (19, (240, 150, 70)), (20.5, (90, 60, 110)), (22, (25, 28, 65)), (24, (20, 24, 60))]
    h = hour % 24
    for (h0, c0), (h1, c1) in zip(stops, stops[1:]):
        if h0 <= h <= h1:
            f = (h - h0) / max(1e-9, h1 - h0)
            return tuple(int(c0[k] + (c1[k] - c0[k]) * f) for k in range(3))
    return stops[-1][1]


def content_mask(img):
    """True where the level has art. The void around an underground level is one mottled colour:
    take the MEDIAN border colour (a modal bin splits on the mottling — Big Bank's underground
    read as 0% void that way), mark pixels near it with low local detail as void."""
    a = np.asarray(img.convert('RGB')).astype(np.int32)
    border = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]])
    modal = np.median(border, axis=0)
    near = np.abs(a - modal).sum(-1) < 60
    share = near.mean()
    if share < 0.15:  # no real void: the whole rect is content
        return np.ones(a.shape[:2], bool)
    detail = np.asarray(img.convert('L').filter(ImageFilter.FIND_EDGES).filter(ImageFilter.BoxBlur(3))) > 18
    void = near & ~detail
    void_img = Image.fromarray((void * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(3))
    return ~(np.asarray(void_img) > 127)


def font(size, bold=False):
    for name in (['georgiab.ttf', 'georgia.ttf'] if bold else ['georgia.ttf']) + ['arial.ttf']:
        try:
            return ImageFont.truetype(os.path.join(os.environ.get('WINDIR', 'C:/Windows'), 'Fonts', name), size)
        except OSError:
            continue
    return ImageFont.load_default()


def weather_label(w):
    if isinstance(w, dict):
        return f"{w.get('from')} -> {w.get('to')}"
    return w or ''


def hour_label(h):
    if isinstance(h, list):
        return f"{fmt_h(h[0])}-{fmt_h(h[1])}"
    return fmt_h(h) if h is not None else ''


def fmt_h(h):
    return f"{int(h):02d}:{int(round((h % 1) * 60)) % 60:02d}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--plan', required=True)
    ap.add_argument('--survey', required=True)
    ap.add_argument('--data', required=True, help="Foundry's Data dir (level backgrounds resolve against it)")
    ap.add_argument('--out', required=True)
    ap.add_argument('--legible', type=float, default=0.45)
    ap.add_argument('--width', type=int, default=1600)
    args = ap.parse_args()
    plan = json.load(open(args.plan, encoding='utf-8'))
    sv = json.load(open(args.survey, encoding='utf-8'))
    os.makedirs(args.out, exist_ok=True)
    rect, vp = sv['sceneRect'], sv['viewport']
    fps = plan.get('fps', 60)
    k = args.width / rect['width']  # map px -> board px
    H = int(round(rect['height'] * k))
    to_px = lambda x, y: ((x - rect['x']) * k, (y - rect['y']) * k)

    levels = {l['name']: l for l in sv['levels']}
    level_ids = {l['id']: l['name'] for l in sv['levels']}
    shots = plan['shots']
    for i, s in enumerate(shots):
        clamp_keys(s, rect, vp)
        s['_n'] = i + 1
        s['_level'] = level_ids.get(s.get('level'), s.get('level')) or sv['levels'][0]['name']

    panels, coverage, albedos = [], {}, {}
    for lname, lvl in levels.items():
        src = os.path.join(args.data, lvl['background'])
        alb = Image.open(src).convert('RGB').resize((args.width, H), Image.LANCZOS)
        albedos[lname] = (Image.open(src).convert('RGB'), alb)
        content = content_mask(alb)
        seen = np.zeros((H, args.width), bool)
        lvl_shots = [s for s in shots if s['_level'] == lname]
        for s in lvl_shots:
            n = max(1, round(s['seconds'] * fps))
            for f in range(0, n, 3):
                c = cam_at(s, f / max(1, n - 1))
                if c['scale'] < args.legible:
                    continue
                x0, y0, x1, y1 = view_rect(c, vp)
                (px0, py0), (px1, py1) = to_px(x0, y0), to_px(x1, y1)
                seen[max(0, int(py0)):max(0, int(math.ceil(py1))), max(0, int(px0)):max(0, int(math.ceil(px1)))] = True
        cov = float((seen & content).sum() / max(1, content.sum()))
        gaps = ~seen & content
        coverage[lname] = {'percent': round(100 * cov, 1), 'shots': [s['name'] for s in lvl_shots]}
        if gaps.any():
            ys, xs = np.nonzero(gaps)
            coverage[lname]['gapBoxMap'] = [round(rect['x'] + xs.min() / k), round(rect['y'] + ys.min() / k),
                                            round(rect['x'] + xs.max() / k), round(rect['y'] + ys.max() / k)]
        # draw
        base = np.asarray(alb).astype(float) * 0.55
        base[seen & content] = base[seen & content] * 0.75 + np.array([40, 110, 40]) * 0.25 / 0.55 * 0.55
        base[gaps] = base[gaps] * 0.45 + np.array([230, 40, 40]) * 0.55
        im = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))
        d = ImageDraw.Draw(im)
        for s in lvl_shots:
            col = PALETTE[(s['_n'] - 1) % len(PALETTE)]
            pts = [to_px(**{kk: c[kk] for kk in ('x', 'y')}) for c in (cam_at(s, u / 40) for u in range(41))]
            d.line(pts, fill=col, width=4)
            for u, w in ((0, 2), (1, 4)):
                x0, y0, x1, y1 = view_rect(cam_at(s, u), vp)
                (a0, b0), (a1, b1) = to_px(x0, y0), to_px(x1, y1)
                d.rectangle([a0, b0, a1, b1], outline=col, width=w)
            ex, ey = pts[-1]
            d.ellipse([ex - 7, ey - 7, ex + 7, ey + 7], fill=col)
            sx, sy = pts[0]
            d.ellipse([sx - 16, sy - 16, sx + 16, sy + 16], fill=(0, 0, 0), outline=col, width=3)
            t = str(s['_n'])
            tw = d.textlength(t, font=font(20, True))
            d.text((sx - tw / 2, sy - 12), t, fill=col, font=font(20, True))
        d.rectangle([0, 0, args.width, 44], fill=(0, 0, 0))
        d.text((12, 8), f"{lname}  —  {coverage[lname]['percent']}% of the map seen at zoom >= {args.legible}",
               fill=(255, 255, 255), font=font(24, True))
        panels.append(im)

    # timeline strip
    total = sum(s['seconds'] for s in shots)
    tl_h = 150
    tl = Image.new('RGB', (args.width, tl_h), (16, 16, 20))
    d = ImageDraw.Draw(tl)
    x = 0
    for s in shots:
        w = s['seconds'] / total * args.width
        hrs = s.get('sunHour', 12)
        h0, h1 = (hrs if isinstance(hrs, list) else [hrs, hrs])
        for px in range(int(x), int(x + w)):
            f = (px - x) / max(1, w)
            d.line([(px, 34), (px, 92)], fill=sky_colour(h0 + (h1 - h0) * f))
        d.rectangle([x, 34, x + w, 92], outline=(0, 0, 0), width=2)
        d.text((x + 6, 38), str(s['_n']), fill=(0, 0, 0), font=font(22, True))
        d.text((x + 6, 96), hour_label(s.get('sunHour')), fill=(220, 220, 220), font=font(15))
        d.text((x + 6, 114), weather_label(s.get('weather'))[:22], fill=(170, 200, 255), font=font(14))
        d.text((x + 6, 132), ('U ' if 'Under' in s['_level'] else '') + f"{s['seconds']}s", fill=(150, 150, 150), font=font(13))
        x += w
    fade = plan.get('transition', {}).get('seconds', 0)
    runtime = total - fade * (len(shots) - 1)
    d.text((10, 6), f"{plan.get('title', '')}   ·   {len(shots)} shots   ·   {runtime:.0f} s "
                    f"({int(runtime // 60)}:{int(runtime % 60):02d}) with {fade}s fades", fill=(255, 255, 255), font=font(20, True))

    board = Image.new('RGB', (args.width * len(panels), H + tl_h), (0, 0, 0))
    for i, p in enumerate(panels):
        board.paste(p, (i * args.width, 0))
    board.paste(tl.resize((args.width * len(panels), tl_h)), (0, H)) if len(panels) > 1 else board.paste(tl, (0, H))
    if len(panels) > 1:  # redraw the strip at full width so the text is not stretched
        tl2 = Image.new('RGB', (args.width * len(panels), tl_h), (16, 16, 20))
        tl2.paste(tl, (0, 0))
        board.paste(tl2, (0, H))
    board.save(os.path.join(args.out, 'storyboard.png'))

    # contact sheet: first / middle / last frame from the full-res albedo
    tw_, th_ = 480, 270
    sheet = Image.new('RGB', (tw_ * 3 + 260, th_ * len(shots)), (12, 12, 14))
    d = ImageDraw.Draw(sheet)
    for r, s in enumerate(shots):
        full = albedos[s['_level']][0]
        for cidx, u in enumerate((0, 0.5, 1)):
            c = cam_at(s, u)
            x0, y0, x1, y1 = view_rect(c, vp)
            box = [x0 - rect['x'], y0 - rect['y'], x1 - rect['x'], y1 - rect['y']]
            crop = full.crop([int(v) for v in box]).resize((tw_, th_), Image.BILINEAR)
            sheet.paste(crop, (260 + cidx * tw_, r * th_))
        col = PALETTE[(s['_n'] - 1) % len(PALETTE)]
        d.text((12, r * th_ + 10), f"{s['_n']}. {s['name']}", fill=col, font=font(20, True))
        lines = [s['_level'], f"{s['seconds']} s, {hour_label(s.get('sunHour'))}", weather_label(s.get('weather')),
                 s.get('caption', '')]
        for li, t in enumerate(lines):
            d.text((12, r * th_ + 44 + li * 26), t[:26], fill=(210, 210, 210), font=font(17))
    sheet.save(os.path.join(args.out, 'shots.jpg'), quality=86)

    json.dump({'legible': args.legible, 'runtimeSec': runtime, 'levels': coverage},
              open(os.path.join(args.out, 'coverage.json'), 'w'), indent=1)
    print(json.dumps({'runtimeSec': runtime, 'coverage': {k: v['percent'] for k, v in coverage.items()},
                      'gaps': {k: v.get('gapBoxMap') for k, v in coverage.items()}}, indent=1))


if __name__ == '__main__':
    main()
