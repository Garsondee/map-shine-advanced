/**
 * Node verification for window-rain-flow.js — the "which way is down the pane"
 * field that rain on window light slides along.
 *
 * Orientation is the whole point, so it is asserted before any browser is
 * involved. World space is +x east, +y SOUTH (screen down), and a window's
 * "down" is OUTWARD from the building. So:
 *   south wall -> +y (90 deg), north wall -> -y (-90), east wall -> +x (0),
 *   west wall -> -x (180).
 * The corner tests pin the property the earlier V1/V2 attempts lacked: a pool
 * that spans a corner is two RIGID facets joined by a continuous blend weight,
 * never one direction that changes pixel to pixel.
 */
import {
  deriveWindowRainFlow,
  sampleWindowRainFlow,
  buildWindowPresenceGrid,
  RAIN_FLOW_DEFAULT_EASE_PX,
} from '../window-rain-flow.js';

const CELL = 20;

function makeScene(W = 128, H = 128) {
  const spec = { x: 0, y: 0, width: W * CELL, height: H * CELL, w: W, h: H, texelW: CELL, texelH: CELL };
  return { W, H, spec, outdoors: new Uint8Array(W * H).fill(255), presence: new Uint8Array(W * H) };
}

function fillRect(s, arr, x0, y0, x1, y1, v) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) arr[y * s.W + x] = v;
}

const building = (s, x0, y0, x1, y1) => fillRect(s, s.outdoors, x0, y0, x1, y1, 0);
const courtyard = (s, x0, y0, x1, y1) => fillRect(s, s.outdoors, x0, y0, x1, y1, 255);
const pool = (s, x0, y0, x1, y1) => fillRect(s, s.presence, x0, y0, x1, y1, 255);
const derive = (s, extra = {}) =>
  deriveWindowRainFlow({ outdoors: { spec: s.spec, data: s.outdoors }, presence: s.presence, ...extra });
const at = (f, cx, cy) => sampleWindowRainFlow(f, cx * CELL + CELL / 2, cy * CELL + CELL / 2);
const deg = (x, y) => (Math.atan2(y, x) * 180) / Math.PI;
const angDiff = (a, b) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

/** The rectangular building with one pool against each wall, plus a corner pool, used by several tests. */
function houseScene() {
  const s = makeScene();
  building(s, 32, 32, 96, 96);
  pool(s, 56, 84, 72, 94); // south wall
  pool(s, 56, 34, 72, 44); // north wall
  pool(s, 84, 56, 94, 72); // east wall
  pool(s, 34, 56, 44, 72); // west wall
  return s;
}

export function run(t) {
  // ── 1. A straight wall is one rigid facet, pointing OUT ──────────────────
  {
    const s = houseScene();
    const f = derive(s);
    t.ok('rain-flow: a house with four pools derives', f !== null);
    t.ok('rain-flow: four pools are four components', f.stats.components === 4);
    t.ok('rain-flow: straight walls need no second facet', f.stats.twoFacet === 0);
    const cases = [
      ['south', 64, 89, 90],
      ['north', 64, 39, -90],
      ['east', 89, 64, 0],
      ['west', 39, 64, 180],
    ];
    for (const [name, cx, cy, want] of cases) {
      const p = at(f, cx, cy);
      t.ok(
        'rain-flow: ' + name + ' window flows ' + want + ' deg (outward), got ' + deg(p.ax, p.ay).toFixed(1),
        angDiff(deg(p.ax, p.ay), want) < 5
      );
      t.ok(
        'rain-flow: ' + name + ' pool is a single facet (A equals B)',
        angDiff(deg(p.ax, p.ay), deg(p.bx, p.by)) < 2
      );
      t.ok('rain-flow: ' + name + ' pool does not blend (w = 0)', p.w < 0.02);
      t.ok('rain-flow: ' + name + ' pool is confident', p.kappa > 0.95);
    }
  }

  // ── 2. Pane height: 0 at the sill, 1 at the far end, monotone ────────────
  {
    const f = derive(houseScene());
    let prev = Infinity;
    let monotone = true;
    for (let cy = 84; cy <= 93; cy++) {
      const h = at(f, 64, cy).h;
      if (h > prev + 1e-6) monotone = false;
      prev = h;
    }
    t.ok('rain-flow: pane height never rises toward the wall', monotone);
    t.ok('rain-flow: the far end of the south pool is the top of the pane', at(f, 64, 84).h > 0.9);
    t.ok('rain-flow: the wall end of the south pool is the sill', at(f, 64, 93).h < 0.1);
    t.ok(
      'rain-flow: the north pool is mirrored (top at the far end, sill at the wall)',
      at(f, 64, 34).h < 0.1 && at(f, 64, 43).h > 0.9
    );
  }

  // ── 3. A corner pool is TWO facets joined by a continuous blend ──────────
  {
    const s = makeScene();
    building(s, 32, 32, 96, 96);
    pool(s, 84, 84, 94, 94); // the south-east corner
    const f = derive(s);
    t.ok(
      'rain-flow: a corner pool is one component with two facets',
      f.stats.components === 1 && f.stats.twoFacet === 1
    );
    const c = f.components[0];
    const a = deg(c.facetA.x, c.facetA.y);
    const b = deg(c.facetB.x, c.facetB.y);
    t.ok('rain-flow: corner facet A is east (0 deg), got ' + a.toFixed(1), angDiff(a, 0) < 10);
    t.ok('rain-flow: corner facet B is south (90 deg), got ' + b.toFixed(1), angDiff(b, 90) < 10);
    t.ok(
      'rain-flow: the corner facets are about 90 deg apart, got ' + ((c.spreadRad * 180) / Math.PI).toFixed(1),
      Math.abs((c.spreadRad * 180) / Math.PI - 90) < 12
    );
    t.ok('rain-flow: a 90 deg corner keeps full confidence', c.confidence > 0.95);

    // Walk the anti-diagonal across the corner bisector, from the south wall to the east wall.
    const path = [];
    for (let d = 0; d <= 10; d++) path.push(at(f, 84 + d, 93 - d).w);
    t.ok('rain-flow: next to the south wall the blend is all B (south)', path[0] > 0.95);
    t.ok('rain-flow: next to the east wall the blend is all A (east)', path[10] < 0.05);
    let nonIncreasing = true;
    let maxStep = 0;
    for (let i = 1; i < path.length; i++) {
      if (path[i] > path[i - 1] + 1e-6) nonIncreasing = false;
      maxStep = Math.max(maxStep, path[i - 1] - path[i]);
    }
    t.ok('rain-flow: the blend crosses the corner monotonically', nonIncreasing);
    t.ok(
      'rain-flow: the blend never jumps a whole facet in one cell (max step ' + maxStep.toFixed(2) + ')',
      maxStep < 0.75
    );

    // The ease dial widens the transition.
    const transition = (easePx) => {
      const g = derive(s, { easePx });
      let n = 0;
      for (let d = 0; d <= 10; d++) {
        const w = at(g, 84 + d, 93 - d).w;
        if (w > 0.05 && w < 0.95) n++;
      }
      return n;
    };
    const narrow = transition(4);
    const wide = transition(200);
    t.ok('rain-flow: a larger corner ease widens the blend (' + narrow + ' -> ' + wide + ' cells)', wide > narrow);
  }

  // ── 4. A courtyard flows INTO the courtyard ───────────────────────────────
  {
    const s = makeScene();
    building(s, 32, 32, 96, 96);
    courtyard(s, 56, 56, 72, 72);
    pool(s, 60, 74, 68, 82); // south of the courtyard, much nearer it than the outer wall
    const f = derive(s);
    const p = at(f, 64, 78);
    t.ok(
      'rain-flow: a pool beside a courtyard flows into it (north, -90), got ' + deg(p.ax, p.ay).toFixed(1),
      angDiff(deg(p.ax, p.ay), -90) < 8
    );
  }

  // ── 5. A concave (L-shaped) building: both arms flow to their own walls ──
  {
    const s = makeScene();
    building(s, 32, 32, 96, 64); // upper arm
    building(s, 32, 64, 64, 96); // lower arm; the notch is x >= 64, y >= 64
    pool(s, 52, 70, 62, 80); // lower arm, beside the notch's west face
    pool(s, 70, 54, 82, 62); // upper arm, above the notch
    const f = derive(s);
    t.ok('rain-flow: an L-shaped building keeps two separate pools', f.stats.components === 2);
    const lower = at(f, 57, 75);
    const upper = at(f, 76, 58);
    t.ok(
      'rain-flow: the lower arm pool flows east into the notch, got ' + deg(lower.ax, lower.ay).toFixed(1),
      angDiff(deg(lower.ax, lower.ay), 0) < 10
    );
    t.ok(
      'rain-flow: the upper arm pool flows south into the notch, got ' + deg(upper.ax, upper.ay).toFixed(1),
      angDiff(deg(upper.ax, upper.ay), 90) < 10
    );
  }

  // ── 6. No honest direction means no sliders ──────────────────────────────
  {
    // Out in open air, nowhere near a pane.
    const s = makeScene();
    building(s, 60, 60, 96, 96);
    pool(s, 8, 8, 18, 18);
    const f = derive(s);
    t.ok('rain-flow: a pool in open air still derives', f !== null && f.stats.components === 1);
    t.ok(
      'rain-flow: a pool in open air has zero confidence',
      f.components[0].confidence === 0 && at(f, 13, 13).kappa === 0
    );
  }
  {
    // A narrow hall: the pool spans both walls, so "outward" points both ways.
    const s = makeScene();
    building(s, 32, 32, 44, 96);
    pool(s, 33, 60, 43, 70);
    const f = derive(s);
    t.ok(
      'rain-flow: a pool between opposing walls has two facets about 180 deg apart',
      f.stats.twoFacet === 1 && f.components[0].spreadRad > 2.8
    );
    t.ok(
      'rain-flow: a pool between opposing walls has no confidence',
      f.components[0].confidence < 0.05 && at(f, 38, 65).kappa < 0.05
    );
  }

  // ── 7. Degenerate inputs derive nothing, never throw ─────────────────────
  {
    const s = houseScene();
    t.ok(
      'rain-flow: no pools derives nothing',
      deriveWindowRainFlow({ outdoors: { spec: s.spec, data: s.outdoors }, presence: new Uint8Array(s.W * s.H) }) ===
        null
    );
    const open = makeScene();
    pool(open, 10, 10, 20, 20);
    t.ok('rain-flow: no building at all derives nothing', derive(open) === null);
    const solid = makeScene();
    building(solid, 0, 0, 128, 128);
    pool(solid, 10, 10, 20, 20);
    t.ok('rain-flow: no open air at all derives nothing', derive(solid) === null);
    t.ok(
      'rain-flow: a presence grid of the wrong size derives nothing',
      deriveWindowRainFlow({ outdoors: { spec: s.spec, data: s.outdoors }, presence: new Uint8Array(10) }) === null
    );
    t.ok('rain-flow: missing arguments derive nothing', deriveWindowRainFlow({}) === null);
  }

  // ── 8. Determinism and packing ───────────────────────────────────────────
  {
    const a = derive(houseScene());
    const b = derive(houseScene());
    let same = a.dirs.length === b.dirs.length;
    for (let i = 0; same && i < a.dirs.length; i++) if (a.dirs[i] !== b.dirs[i] || a.aux[i] !== b.aux[i]) same = false;
    t.ok('rain-flow: the same input packs byte-identical textures', same);

    let worstLen = 0;
    let poolTexels = 0;
    for (let i = 0; i < a.aux.length; i += 4) {
      if (a.aux[i + 1] === 0) continue; // confidence 0: no direction stored
      poolTexels++;
      for (const o of [0, 2]) {
        const vx = a.dirs[i + o] / 127.5 - 1;
        const vy = a.dirs[i + o + 1] / 127.5 - 1;
        worstLen = Math.max(worstLen, Math.abs(Math.hypot(vx, vy) - 1));
      }
    }
    t.ok('rain-flow: pool texels were packed', poolTexels > 0);
    t.ok(
      'rain-flow: packed facets are unit vectors to within 8-bit quantisation (' + worstLen.toFixed(3) + ')',
      worstLen < 0.02
    );
    t.ok('rain-flow: the alpha of both textures is opaque', a.aux[3] === 255 && a.dirs.length === a.aux.length);
    t.ok(
      'rain-flow: the default ease is a sane number of px',
      RAIN_FLOW_DEFAULT_EASE_PX > 0 && RAIN_FLOW_DEFAULT_EASE_PX < 500
    );
  }

  // ── 9. Sampling mirrors the GPU's linear filter ──────────────────────────
  {
    const f = derive(houseScene());
    const centre = at(f, 64, 89); // exactly at a texel centre
    const o = (89 * 128 + 64) * 4;
    t.ok('rain-flow: a texel centre samples exactly the stored byte', Math.abs(centre.h - f.aux[o + 2] / 255) < 1e-9);
    const mid = sampleWindowRainFlow(f, 65 * CELL, 89 * CELL + CELL / 2); // halfway between two texel centres
    const h1 = f.aux[(89 * 128 + 64) * 4 + 2] / 255;
    const h2 = f.aux[(89 * 128 + 65) * 4 + 2] / 255;
    t.ok('rain-flow: halfway between texels averages them', Math.abs(mid.h - 0.5 * (h1 + h2)) < 1e-9);
    const far = sampleWindowRainFlow(f, -500, -500);
    t.ok('rain-flow: sampling off the grid clamps to the edge', Number.isFinite(far.h) && far.kappa === 0);
  }

  // ── 10. Pooling the window mask down to the flow grid ────────────────────
  {
    const spec = { x: 0, y: 0, width: 160, height: 160, w: 8, h: 8 };
    const rect = { minX: 0, minY: 0, maxX: 160, maxY: 160 };
    const img = (w, h) => new Uint8Array(w * h * 4);
    const put = (d, w, x, y, r, g, b, a) => {
      const i = (y * w + x) * 4;
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = a;
    };

    // Same size as the grid: a BLUE-only cookie counts (the derived R-only grid would drop it).
    let d = img(8, 8);
    put(d, 8, 2, 3, 0, 0, 255, 255);
    put(d, 8, 4, 4, 200, 0, 0, 0); // alpha 0 -> the alpha-missing fallback treats it as opaque
    put(d, 8, 1, 1, 255, 255, 255, 128); // half alpha
    let g = buildWindowPresenceGrid({ data: d, width: 8, height: 8, rect, spec });
    t.ok('rain-presence: a blue-only pixel is full presence', g[3 * 8 + 2] === 255);
    t.ok('rain-presence: alpha 0 falls back to opaque like the shader', g[4 * 8 + 4] === 200);
    t.ok('rain-presence: half alpha halves the presence', Math.abs(g[1 * 8 + 1] - 128) <= 1);
    t.ok('rain-presence: empty pixels stay zero', g[0] === 0 && g[7 * 8 + 7] === 0);

    // A coarser image: each pixel covers 2x2 grid cells.
    d = img(4, 4);
    put(d, 4, 1, 2, 90, 90, 90, 255);
    g = buildWindowPresenceGrid({ data: d, width: 4, height: 4, rect, spec });
    t.ok(
      'rain-presence: a coarse pixel covers all four of its cells',
      g[4 * 8 + 2] === 90 && g[5 * 8 + 3] === 90 && g[4 * 8 + 3] === 90
    );
    t.ok('rain-presence: and nothing outside them', g[3 * 8 + 2] === 0 && g[4 * 8 + 4] === 0);

    // A finer image: one hot pixel makes its whole cell hot (MAX pooling, not mean).
    d = img(64, 64);
    put(d, 64, 17, 33, 255, 255, 255, 255);
    g = buildWindowPresenceGrid({ data: d, width: 64, height: 64, rect, spec });
    t.ok('rain-presence: max pooling keeps a single hot pixel', g[4 * 8 + 2] === 255);

    // An image covering only the right half of the grid's rect.
    d = img(4, 8);
    put(d, 4, 0, 5, 255, 255, 255, 255);
    g = buildWindowPresenceGrid({
      data: d,
      width: 4,
      height: 8,
      rect: { minX: 80, minY: 0, maxX: 160, maxY: 160 },
      spec,
    });
    t.ok('rain-presence: an offset rect lands the pixel in the right cell', g[5 * 8 + 4] === 255);
    t.ok('rain-presence: cells outside the image rect are empty', g[5 * 8 + 3] === 0 && g[5 * 8 + 0] === 0);

    t.ok(
      'rain-presence: short data derives nothing',
      buildWindowPresenceGrid({ data: new Uint8Array(10), width: 8, height: 8, rect, spec }) === null
    );
    t.ok(
      'rain-presence: a degenerate rect derives nothing',
      buildWindowPresenceGrid({
        data: img(8, 8),
        width: 8,
        height: 8,
        rect: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
        spec,
      }) === null
    );
  }

  // ── 11. End to end: pooled presence feeds the flow ───────────────────────
  {
    const s = houseScene();
    // Paint the south pool as a BLUE cookie in an RGBA image the size of the grid.
    const img = new Uint8Array(s.W * s.H * 4);
    for (let y = 84; y < 94; y++) {
      for (let x = 56; x < 72; x++) {
        const i = (y * s.W + x) * 4;
        img[i + 2] = 255;
        img[i + 3] = 255;
      }
    }
    const rect = { minX: 0, minY: 0, maxX: s.spec.width, maxY: s.spec.height };
    const presence = buildWindowPresenceGrid({ data: img, width: s.W, height: s.H, rect, spec: s.spec });
    const f = deriveWindowRainFlow({ outdoors: { spec: s.spec, data: s.outdoors }, presence });
    const p = at(f, 64, 89);
    t.ok(
      'rain-flow: a blue-only cookie still gets its direction (south)',
      f.stats.components === 1 && angDiff(deg(p.ax, p.ay), 90) < 5
    );
  }
}
