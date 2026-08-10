import { chromium } from '@playwright/test';

// Served through the already-running bench Foundry (real http:// origin) rather than
// file:// — Chrome's fetch() blocks local file:// URLs by default (CORS/opaque-origin),
// and this is how the browser actually loads it during real play anyway.
const url = 'http://localhost:30000/modules/map-shine-advanced/mansion_example_map/mythica-machina-mansion-redux/assets/mythica-machina-mansion-Ground_Roof.webp';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const result = await page.evaluate(async (imgUrl) => {
  const resp = await fetch(imgUrl);
  if (!resp.ok) return { ok: false, reason: `fetch failed: ${resp.status}` };
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const samplePoints = [
    [0.1, 0.1], [0.5, 0.5], [0.9, 0.9], [0.25, 0.75], [0.75, 0.25], [0.5, 0.1], [0.1, 0.5], [0.02, 0.02], [0.98, 0.98]
  ];
  const samples = samplePoints.map(([fx, fy]) => {
    const x = Math.floor(fx * bitmap.width), y = Math.floor(fy * bitmap.height);
    const d = ctx.getImageData(x, y, 1, 1).data;
    return { x, y, r: d[0], g: d[1], b: d[2], a: d[3] };
  });
  return { ok: true, width: bitmap.width, height: bitmap.height, samples };
}, url);
console.log(JSON.stringify(result, null, 2));
await browser.close();
