/**
 * make-torture-world.mjs — Keyhole Stage 0 fixture generator (docs/planning/Keyhole.md §8).
 * ============================================================================
 * Emits the synthetic TORTURE SCENE that is Stage 0's fixture and every stage's
 * gate: a 12,000² × 3-floor world with labeled grids + per-floor tint (so a
 * mis-streamed page is instantly visible), alpha holes in the upper floors (so
 * lower floors show through — the water-under-floor / alphaTest-hole case), and
 * synthetic _Outdoors/_Specular/_Fire/_Tree/_Bush masks with known patterns.
 *
 * Outputs (into --out, default assets/torture/, gitignored — regenerable):
 *   torture_floor{N}.png              albedo (labeled grid + tint; upper floors holed)
 *   torture_floor{N}_Outdoors.png     indoor/outdoor area mask (max(r,g,b) convention)
 *   torture_floor{N}_Specular.png     specular highlight pattern
 *   torture_floor{N}_Fire.png         sparse known fire-spawn points (per-page extract test)
 *   torture_floor{N}_Tree.png         RGBA canopy blobs (transparent)
 *   torture_floor{N}_Bush.png         RGBA bush blobs (transparent)
 *   torture-scene.macro.js            paste into a Foundry Script macro + execute → builds the Scene
 *
 * Run FROM THE PROJECT ROOT so `pngjs` resolves:
 *   node tools/make-torture-world.mjs                 # full 12k, 3 floors
 *   node tools/make-torture-world.mjs --size=2048     # fast iteration
 *
 * pngjs holds the whole RGBA buffer (12k² ≈ 576 MB + internal ≈ 1.1 GB RSS,
 * measured), one image at a time — fine on a dev box; ~8 s per 12k image.
 */

import pkg from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const { PNG } = pkg;
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// --- args -------------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const SIZE = Number(args.size ?? 12000);
const FLOORS = Number(args.floors ?? 3);
const CELL = Number(args.cell ?? 512); // grid cell in px
const LIGHTS = Number(args.lights ?? 60);
const WALLS = Number(args.walls ?? 1000);
const MODULE_ID = String(args['module-id'] ?? 'map-shine-advanced');
const OUT_REL = String(args.out ?? 'assets/torture'); // module-relative
const OUT_DIR = path.join(ROOT, OUT_REL);
const ELEV_STEP = 10; // Levels elevation band height per floor

// --- deterministic PRNG (seedable; no Math.random so fixtures are stable) ----
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// --- 5x7 bitmap font: digits, 'F', ',', space — enough for "F0 12,7" labels --
const FONT = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  ',': [0, 0, 0, 0, 0x04, 0x04, 0x08],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  3: [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
};

// per-floor identity tint (dark base so grid + labels pop; wrong floor = wrong hue)
const FLOOR_TINT = [
  [70, 26, 26], // 0 red
  [26, 70, 32], // 1 green
  [28, 34, 78], // 2 blue
  [72, 60, 20], // 3 amber (headroom)
];

function px(d, size, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
}

function drawText(d, size, x, y, str, scale, rgb) {
  let cx = x;
  for (const ch of str.toUpperCase()) {
    const glyph = FONT[ch] || FONT[' '];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row] & (1 << (4 - col))) {
          for (let sy = 0; sy < scale; sy++)
            for (let sx = 0; sx < scale; sx++)
              px(d, size, cx + col * scale + sx, y + row * scale + sy, rgb[0], rgb[1], rgb[2]);
        }
      }
    }
    cx += 6 * scale; // 5px glyph + 1px gap
  }
}

function newPNG() {
  return new PNG({ width: SIZE, height: SIZE });
}

// Is this cell SOLID on floor f? Floor 0 fully solid; upper floors punch
// deterministic 2x2-cell "courtyard" holes (~25%) so lower floors show through
// the alphaTest holes (the water-under-floor case). Grouped by >>1 so the
// pattern still cycles in small iteration grids, not just at full 12k.
function isSolid(f, cx, cy) {
  if (f === 0) return true;
  return ((cx >> 1) * 3 + (cy >> 1) * 7 + f * 5) % 4 !== 0;
}

// --- image builders ---------------------------------------------------------
function buildAlbedo(f) {
  const png = newPNG();
  const d = png.data;
  const tint = FLOOR_TINT[f % FLOOR_TINT.length];
  const cellsX = Math.ceil(SIZE / CELL);
  const labelScale = Math.max(3, Math.floor(CELL / 64));
  for (let y = 0; y < SIZE; y++) {
    const cy = (y / CELL) | 0;
    const inGridY = y % CELL < 3;
    for (let x = 0; x < SIZE; x++) {
      const cx = (x / CELL) | 0;
      const i = (y * SIZE + x) * 4;
      if (!isSolid(f, cx, cy)) { d[i + 3] = 0; continue; } // hole → transparent
      const grid = inGridY || x % CELL < 3;
      if (grid) { d[i] = 210; d[i + 1] = 210; d[i + 2] = 230; d[i + 3] = 255; continue; }
      // per-cell position-encoding tint over the floor base — region errors show as hue jumps
      d[i] = (tint[0] + ((cx * 17) % 60)) & 255;
      d[i + 1] = (tint[1] + ((cy * 17) % 60)) & 255;
      d[i + 2] = (tint[2] + (((cx + cy) * 11) % 60)) & 255;
      d[i + 3] = 255;
    }
  }
  // labels: "F{f}" + "{cx},{cy}" near each solid cell's top-left
  for (let cy = 0; cy < cellsX; cy++)
    for (let cx = 0; cx < cellsX; cx++)
      if (isSolid(f, cx, cy)) {
        const ox = cx * CELL + 8, oy = cy * CELL + 8;
        drawText(d, SIZE, ox, oy, `F${f}`, labelScale, [255, 255, 120]);
        drawText(d, SIZE, ox, oy + 9 * labelScale, `${cx},${cy}`, labelScale, [230, 230, 230]);
      }
  return png;
}

// _Outdoors: large known regions. Outer 1/6 margin ring = outdoor (white), a
// diagonal band per floor toggles, center = indoor (black). max(r,g,b) decode.
function buildOutdoors(f) {
  const png = newPNG();
  const d = png.data;
  const m = SIZE / 6;
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const margin = x < m || y < m || x >= SIZE - m || y >= SIZE - m;
      const band = (((x + y + f * SIZE) / (SIZE / 3)) | 0) % 2 === 0;
      const outdoor = margin || band;
      const v = outdoor ? 255 : 0;
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
  return png;
}

// _Specular: diagonal stripe highlights, phase-shifted per floor.
function buildSpecular(f) {
  const png = newPNG();
  const d = png.data;
  const period = 220;
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const s = ((x + y + f * 70) % period) < 40 ? 255 : 20;
      d[i] = s; d[i + 1] = s; d[i + 2] = s; d[i + 3] = 255;
    }
  return png;
}

// _Fire: sparse KNOWN bright spawn points (a deterministic grid, jittered per
// floor). The per-page CPU extractor (Stage 4) must find exactly these.
function buildFire(f) {
  const png = newPNG();
  const d = png.data; // starts all-zero (black, alpha 0) → set opaque black then dots
  for (let i = 3; i < d.length; i += 4) d[i] = 255; // opaque
  const rnd = lcg(0xf17e + f);
  const step = SIZE / 8;
  const R = Math.max(6, (SIZE / 400) | 0);
  for (let gy = 0; gy < 8; gy++)
    for (let gx = 0; gx < 8; gx++) {
      const px0 = (gx + 0.5) * step + (rnd() - 0.5) * step * 0.5;
      const py0 = (gy + 0.5) * step + (rnd() - 0.5) * step * 0.5;
      for (let dy = -R; dy <= R; dy++)
        for (let dx = -R; dx <= R; dx++)
          if (dx * dx + dy * dy <= R * R) px(d, SIZE, (px0 + dx) | 0, (py0 + dy) | 0, 255, 180, 40, 255);
    }
  return png;
}

// _Tree / _Bush: RGBA blobs with real transparency (canopy shapes).
function buildFoliage(f, seed, count, radius, color) {
  const png = newPNG();
  const d = png.data; // all zero → fully transparent background
  const rnd = lcg(seed + f * 131);
  for (let n = 0; n < count; n++) {
    const cxp = rnd() * SIZE, cyp = rnd() * SIZE;
    const R = radius * (0.6 + rnd() * 0.8);
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const dd = dx * dx + dy * dy;
        if (dd > R * R) continue;
        const a = Math.max(0, 1 - Math.sqrt(dd) / R);
        px(d, SIZE, (cxp + dx) | 0, (cyp + dy) | 0, color[0], color[1], color[2], (a * 235) | 0);
      }
  }
  return png;
}

async function writePNG(png, file) {
  const p = path.join(OUT_DIR, file);
  await new Promise((res, rej) =>
    png.pack().pipe(fs.createWriteStream(p)).on('finish', res).on('error', rej)
  );
  return +(fs.statSync(p).size / 1048576).toFixed(2);
}

// --- Foundry scene-builder macro -------------------------------------------
function buildMacro() {
  const base = `modules/${MODULE_ID}/${OUT_REL}`.replace(/\\/g, '/');
  return `// Keyhole torture-scene builder — paste into a Foundry Script macro and EXECUTE.
// Requires the fixture PNGs synced to: ${base}/
(async () => {
  const SIZE = ${SIZE}, FLOORS = ${FLOORS}, ELEV = ${ELEV_STEP};
  const BASE = "${base}";
  const rnd = (s => () => (s = (s*1664525+1013904223)>>>0)/4294967296)(20260715);

  const scene = await Scene.create({
    name: "Keyhole Torture (${SIZE}² ×${FLOORS})",
    width: SIZE, height: SIZE, padding: 0, backgroundColor: "#0a0d14",
    grid: { type: 1, size: ${CELL}, distance: 5, units: "ft" },
    flags: { levels: { sceneLevels: Array.from({length: FLOORS}, (_,f) => [f*ELEV, f*ELEV+ELEV, "F"+f]) } }
  });

  const tiles = Array.from({length: FLOORS}, (_, f) => ({
    texture: { src: BASE + "/torture_floor" + f + ".png" },
    x: 0, y: 0, width: SIZE, height: SIZE, sort: f, elevation: f*ELEV,
    flags: { levels: { rangeBottom: f*ELEV, rangeTop: f*ELEV+ELEV } }
  }));
  await scene.createEmbeddedDocuments("Tile", tiles);

  const lights = Array.from({length: ${LIGHTS}}, (_, i) => {
    const f = i % FLOORS;
    return { x: rnd()*SIZE, y: rnd()*SIZE, elevation: f*ELEV+ELEV/2,
      config: { dim: 400+rnd()*600, bright: 150+rnd()*300,
        color: ["#ffd9a0","#a0c8ff","#ffa0a0","#ffffff"][i%4], alpha: 0.5, luminosity: 0.5 } };
  });
  await scene.createEmbeddedDocuments("AmbientLight", lights);

  const walls = Array.from({length: ${WALLS}}, () => {
    const x = rnd()*SIZE, y = rnd()*SIZE, len = 200+rnd()*1200, horiz = rnd()<0.5;
    const c = horiz ? [x, y, Math.min(SIZE, x+len), y] : [x, y, x, Math.min(SIZE, y+len)];
    return { c };
  });
  await scene.createEmbeddedDocuments("Wall", walls);

  ui.notifications.info("Keyhole torture scene built: " + scene.name);
  console.log("[Keyhole] torture scene", scene.id, "— tiles/lights/walls:", FLOORS, ${LIGHTS}, ${WALLS});
})();
`;
}

// --- main -------------------------------------------------------------------
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[torture] ${SIZE}² × ${FLOORS} floors → ${OUT_REL}/  (cell ${CELL}px)`);
  const t0 = performance.now();
  let totalMB = 0;
  for (let f = 0; f < FLOORS; f++) {
    const jobs = [
      [`torture_floor${f}.png`, () => buildAlbedo(f)],
      [`torture_floor${f}_Outdoors.png`, () => buildOutdoors(f)],
      [`torture_floor${f}_Specular.png`, () => buildSpecular(f)],
      [`torture_floor${f}_Fire.png`, () => buildFire(f)],
      [`torture_floor${f}_Tree.png`, () => buildFoliage(f, 0x77ee, 120, SIZE / 60, [40, 120, 45])],
      [`torture_floor${f}_Bush.png`, () => buildFoliage(f, 0xb05b, 260, SIZE / 130, [70, 150, 60])],
    ];
    for (const [file, make] of jobs) {
      const mb = await writePNG(make(), file);
      totalMB += mb;
      console.log(`  ✔ ${file}  ${mb} MB  (+${((performance.now() - t0) / 1000).toFixed(1)}s)`);
    }
  }
  const macroPath = path.join(OUT_DIR, 'torture-scene.macro.js');
  fs.writeFileSync(macroPath, buildMacro());
  console.log(`  ✔ torture-scene.macro.js`);
  console.log(
    `[torture] done: ${FLOORS * 6} images, ${totalMB.toFixed(1)} MB, ${((performance.now() - t0) / 1000).toFixed(1)}s`
  );
  console.log(`\nNext:`);
  console.log(`  1. Sync ${OUT_REL}/ to the Foundry VM (it's under a synced path).`);
  console.log(`  2. In Foundry: create a Script macro, paste ${OUT_REL}/torture-scene.macro.js, execute.`);
  console.log(`  3. The "Keyhole Torture" scene appears — that's the Stage 0 fixture gate.`);
}

main().catch((e) => { console.error('[torture] FAILED:', e); process.exit(1); });
