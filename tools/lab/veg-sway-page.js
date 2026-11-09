// tools/lab/veg-sway-page.js — runs IN the Foundry page. veg-sway.mjs appends
// `return await vegSwayPage(args);` and sends it with cdp.mjs eval --file (`args` in scope).
// Measures how each plant's canopy moves: capture-clock frames at an exact dt, and per plant the
// leaf-coloured centroid inside its box (a rigidly swaying canopy moves its centroid exactly with it;
// thousands of pixels give sub-pixel precision). Also a "flutter" number: mean |frame - previous| of
// leaf pixels inside the box, in 0-255 units.
// args: { speed01, dirDeg, frames, dtMs, settleMs, view: {x, y, scale}, plants: [{key, box:{x,y,w,h}}], gust }
// eslint-disable-next-line no-unused-vars
async function vegSwayPage(args) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const d = canvas.dimensions;
  const rs = game.settings.get('map-shine-advanced', 'renderScale');
  if (String(rs) !== '1') throw new Error(`renderScale is ${rs}, not 1: refusing to measure (mmp-78u.41)`);
  await MapShine.setWind({ directionDeg: args.dirDeg, speed01: args.speed01 });
  await canvas.animatePan({
    x: d.sceneX + args.view.x,
    y: d.sceneY + args.view.y,
    scale: args.view.scale,
    duration: 0,
  });
  await sleep(args.settleMs ?? 8000); // live: springs and the wind field reach their steady state
  const cap = MapShine.capture;
  await cap.begin({ renderScale: '1' });
  const out = { args: { ...args, plants: undefined }, plants: {}, frames: [] };
  try {
    const first = await cap.frame({ dtMs: args.dtMs, readback: true });
    const W = first.width;
    const H = first.height;
    const k = W / window.innerWidth; // canvas px per CSS px
    const toScreen = (x, y) => {
      const p = canvas.stage.worldTransform.apply({ x: d.sceneX + x, y: d.sceneY + y });
      return { x: p.x * k, y: p.y * k };
    };
    const zoom = canvas.stage.scale.x * k; // canvas px per scene px
    out.zoom = zoom;
    out.size = [W, H];
    const boxes = args.plants.map((p) => {
      const m = 0.15;
      const a = toScreen(p.box.x - p.box.w * m, p.box.y - p.box.h * m);
      const b = toScreen(p.box.x + p.box.w * (1 + m), p.box.y + p.box.h * (1 + m));
      const x0 = Math.max(0, Math.floor(a.x));
      const y0 = Math.max(0, Math.floor(a.y));
      const x1 = Math.min(W, Math.ceil(b.x));
      const y1 = Math.min(H, Math.ceil(b.y));
      out.plants[p.key] = { screen: [x0, y0, x1, y1], clipped: a.x < 0 || a.y < 0 || b.x > W || b.y > H };
      return { key: p.key, x0, y0, x1, y1, prev: null };
    });
    const measure = (px) => {
      const row = {};
      for (const bx of boxes) {
        let sw = 0;
        let sx = 0;
        let sy = 0;
        let n = 0;
        let flut = 0;
        const w = bx.x1 - bx.x0;
        const h = bx.y1 - bx.y0;
        if (w <= 0 || h <= 0) continue;
        const cur = new Uint8Array(w * h);
        for (let y = bx.y0; y < bx.y1; y++) {
          for (let x = bx.x0; x < bx.x1; x++) {
            const i = (y * W + x) * 4;
            const r = px[i];
            const g = px[i + 1];
            const b = px[i + 2];
            const hi = Math.max(r, g, b);
            const lo = Math.min(r, g, b);
            // leaf colour: saturated and green-or-olive (g well above b); the grey floor and the grey
            // shadow under a canopy have chroma < ~12
            const c = hi - lo;
            const wgt = g - b > 12 && c > 18 ? Math.min(1, (c - 18) / 20) : 0;
            cur[(y - bx.y0) * w + (x - bx.x0)] = g;
            if (wgt > 0) {
              sw += wgt;
              sx += wgt * x;
              sy += wgt * y;
              n++;
              if (bx.prev) flut += Math.abs(g - bx.prev[(y - bx.y0) * w + (x - bx.x0)]);
            }
          }
        }
        row[bx.key] = sw > 0 ? [sx / sw, sy / sw, n, bx.prev ? flut / Math.max(1, n) : null] : null;
        bx.prev = cur;
      }
      return row;
    };
    out.frames.push({ t: first.tMs, m: measure(first.pixels) });
    if (args.gust) MapShine.gustWind();
    for (let f = 1; f < args.frames; f++) {
      const fr = await cap.frame({ dtMs: args.dtMs, readback: true });
      out.frames.push({ t: fr.tMs, warm: fr.warmFrames, m: measure(fr.pixels) });
    }
  } finally {
    cap.end();
  }
  return out;
}
