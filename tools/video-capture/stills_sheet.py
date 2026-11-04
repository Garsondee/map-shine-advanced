"""tools/video-capture/stills_sheet.py — lay `record.mjs run --stills` output out as one sheet per 5 shots.
    python tools/video-capture/stills_sheet.py <render dir> [--plan plan.json]"""
import sys, os, json, glob
from PIL import Image, ImageDraw, ImageFont
d = sys.argv[1]
plan = json.load(open(sys.argv[sys.argv.index('--plan') + 1], encoding='utf-8')) if '--plan' in sys.argv else None
names = [s['name'] for s in plan['shots']] if plan else sorted({os.path.basename(p).rsplit('-', 1)[0] for p in glob.glob(os.path.join(d, 'stills', '*.jpg'))})
W, H = 640, 360
try:
    f = ImageFont.truetype(os.path.join(os.environ.get('WINDIR', 'C:/Windows'), 'Fonts', 'georgiab.ttf'), 22)
except OSError:
    f = ImageFont.load_default()
for page in range(0, len(names), 5):
    group = names[page:page + 5]
    sheet = Image.new('RGB', (W * 3, H * len(group)), (0, 0, 0))
    dr = ImageDraw.Draw(sheet)
    for r, n in enumerate(group):
        for c in range(3):
            p = os.path.join(d, 'stills', f'{n}-{c}.jpg')
            if os.path.exists(p):
                sheet.paste(Image.open(p).resize((W, H)), (c * W, r * H))
        dr.rectangle([0, r * H, 300, r * H + 34], fill=(0, 0, 0))
        dr.text((8, r * H + 5), n, fill=(255, 220, 120), font=f)
    out = os.path.join(d, f'stills-{page // 5 + 1}.jpg')
    sheet.save(out, quality=88)
    print(out)
