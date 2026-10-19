/**
 * Node verification for window-rain-field.js - the per-position "which way is down the pane" field.
 *
 * World space is +x east, +y SOUTH (screen down); a window's "down" is OUTWARD from the building:
 *   south wall -> 90 deg, north -> -90, east -> 0, west -> 180.
 * The fixtures are ANTI-ALIASED (a cell's gray is its uncovered share), like the band-limited mask the engine
 * hands over, so a diagonal wall is a ramp of grays and the sub-cell distance code is really exercised.
 */
import {
  deriveWindowRainField,
  sampleWindowRainField,
  buildWindowPresenceGrid,
  signedDistanceFromGray,
  RAIN_FIELD_DEFAULT_EASE_PX,
} from '../window-rain-field.js';

const CELL = 20;
const deg = (x, y) => (Math.atan2(y, x) * 180) / Math.PI;
const angDiff = (a, b) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

function makeScene(W = 128, H = 128) {
  const spec = { x: 0, y: 0, width: W * CELL, height: H * CELL, w: W, h: H, texelW: CELL, texelH: CELL };
  return { W, H, spec, outdoors: new Uint8Array(W * H).fill(255), presence: new Uint8Array(W * H) };
}

/** Paint a building (0 = building) from an inside(x, y) test in CELL units, 4x4 supersampled. */
function paintBuilding(s, inside) {
  for (let y = 0; y < s.H; y++) {
    for (let x = 0; x < s.W; x++) {
      let hit = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hit++;
      }
      const g = Math.round(255 * (1 - hit / 16));
      if (g < s.outdoors[y * s.W + x]) s.outdoors[y * s.W + x] = g;
    }
  }
}
const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const rotRect = (cx, cy, hw, hh, deg_) => {
  const c = Math.cos((deg_ * Math.PI) / 180);
  const sn = Math.sin((deg_ * Math.PI) / 180);
  return (x, y) => {
    const u = (x - cx) * c + (y - cy) * sn;
    const v = -(x - cx) * sn + (y - cy) * c;
    return Math.abs(u) <= hw && Math.abs(v) <= hh;
  };
};
const circle = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const pool = (s, x0, y0, x1, y1) => {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s.presence[y * s.W + x] = 255;
};
const poolWhere = (s, f) => {
  for (let y = 0; y < s.H; y++) for (let x = 0; x < s.W; x++) if (f(x + 0.5, y + 0.5)) s.presence[y * s.W + x] = 255;
};
const derive = (s, extra = {}) =>
  deriveWindowRainField({ outdoors: { spec: s.spec, data: s.outdoors }, presence: s.presence, maxDim: 4096, ...extra });
const at = (f, cx, cy) => sampleWindowRainField(f, cx * CELL, cy * CELL);
/** The direction a cell runs: the nearest level blended with the other by `mix`. */
const dirOf = (p) => deg(p.px * (1 - p.mix) + p.qx * p.mix, p.py * (1 - p.mix) + p.qy * p.mix);

export function run(t) {
  // ── 1. straight walls point OUT, at full wall-ness ───────────────────────
  {
    const s = makeScene();
    paintBuilding(s, rect(32, 32, 96, 96));
    pool(s, 56, 84, 72, 94);
    pool(s, 56, 34, 72, 44);
    pool(s, 84, 56, 94, 72);
    pool(s, 34, 56, 44, 72);
    const f = derive(s);
    t.ok('rain-field: a house with four windows derives', f !== null);
    for (const [name, cx, cy, want] of [
      ['south', 64, 90, 90],
      ['north', 64, 38, -90],
      ['east', 90, 64, 0],
      ['west', 38, 64, 180],
    ]) {
      const p = at(f, cx, cy);
      t.ok(`rain-field: ${name} window runs ${want} deg, got ${dirOf(p).toFixed(1)}`, angDiff(dirOf(p), want) < 3);
      t.ok(`rain-field: ${name} window is wall-attached (kappa ${p.kappa.toFixed(2)})`, p.kappa > 0.9);
      t.ok(`rain-field: ${name} window is gated on`, p.gate > 0.99);
    }
    const far = at(f, 10, 10);
    t.ok('rain-field: far from any light the gate is closed', far.gate < 0.01);
    for (const want of [0, 90, 180, 270]) {
      t.ok(
        `rain-field: a level sits exactly at ${want} deg`,
        f.levels.some((a) => angDiff(a, want) < 1.5)
      );
    }
  }

  // ── 2. a building rotated 30 deg: the exact wall angle, not the nearest cardinal ──
  {
    const s = makeScene();
    paintBuilding(s, rotRect(64, 64, 30, 22, 30));
    const c30 = Math.cos(Math.PI / 6);
    const s30 = Math.sin(Math.PI / 6);
    // light against the rotated "south" edge: local v in [14, 20]
    poolWhere(s, (x, y) => {
      const u = (x - 64) * c30 + (y - 64) * s30;
      const v = -(x - 64) * s30 + (y - 64) * c30;
      return Math.abs(u) < 8 && v > 14 && v < 20;
    });
    const f = derive(s);
    const mid = at(f, 64 - 17 * s30, 64 + 17 * c30);
    t.ok(`rain-field: a 30-degree wall runs 120 deg, got ${dirOf(mid).toFixed(1)}`, angDiff(dirOf(mid), 120) < 3);
    t.ok(
      'rain-field: a diagonal wall gets its own level',
      f.levels.some((a) => angDiff(a, 120) < 2)
    );
    t.ok(`rain-field: and is wall-attached (${mid.kappa.toFixed(2)})`, mid.kappa > 0.9);
  }

  // ── 3. a round tower: the direction is radial, all the way round ─────────
  {
    const s = makeScene();
    paintBuilding(s, circle(64, 64, 30));
    poolWhere(s, (x, y) => {
      const r = Math.hypot(x - 64, y - 64);
      return r > 22 && r < 28;
    });
    const f = derive(s);
    for (const a of [20, 75, 140, 200, 260, 330]) {
      const cx = 64 + 25 * Math.cos((a * Math.PI) / 180);
      const cy = 64 + 25 * Math.sin((a * Math.PI) / 180);
      const p = at(f, cx, cy);
      t.ok(`rain-field: round tower at ${a} deg runs radially, got ${dirOf(p).toFixed(0)}`, angDiff(dirOf(p), a) < 9);
    }
  }

  // ── 4. skylights: bright light in the middle of a big building does not run ──
  {
    const s = makeScene(192, 192);
    paintBuilding(s, rect(16, 16, 176, 176));
    pool(s, 90, 90, 102, 102); // a roof light in the middle of a 160-cell hall
    pool(s, 80, 160, 112, 170); // a real window on the south wall
    const f = derive(s);
    const sky = at(f, 96, 96);
    t.ok(`rain-field: a mid-hall roof light has no direction (kappa ${sky.kappa.toFixed(2)})`, sky.kappa < 0.1);
    const win = at(f, 96, 166);
    t.ok(
      `rain-field: a wall window in the same hall runs south (${dirOf(win).toFixed(0)}, kappa ${win.kappa.toFixed(2)})`,
      angDiff(dirOf(win), 90) < 3 && win.kappa > 0.85
    );
    t.ok('rain-field: the skylight is still gated on (splats run there)', sky.gate > 0.99);
  }

  // ── 5. a TALL window keeps its wall's direction past the room's midline ──
  {
    const s = makeScene();
    paintBuilding(s, rect(20, 40, 108, 80)); // a 40-cell-deep room
    pool(s, 60, 50, 68, 78); // light from the south wall reaching well past the middle (y = 60)
    const f = derive(s);
    let flipped = 0;
    let lit = 0;
    for (let y = 50; y < 78; y++) {
      const p = at(f, 64, y + 0.5);
      if (p.kappa > 0.3) {
        lit++;
        if (Math.sin((dirOf(p) * Math.PI) / 180) < 0) flipped++;
      }
    }
    t.ok('rain-field: a tall window never flips north past the midline', lit > 5 && flipped === 0);
    t.ok(`rain-field: its base is fully wall-attached (${at(f, 64, 76).kappa.toFixed(2)})`, at(f, 64, 76).kappa > 0.9);
  }

  // ── 6. a corner pool turns smoothly: south -> east with no jump ──────────
  {
    const s = makeScene();
    paintBuilding(s, rect(32, 32, 96, 96));
    pool(s, 80, 80, 94, 94); // the SE interior corner
    const f = derive(s, { easePx: RAIN_FIELD_DEFAULT_EASE_PX });
    let maxStep = 0;
    let prev = null;
    let sawSouth = false;
    let sawEast = false;
    for (let i = 0; i <= 28; i++) {
      // walk from just above the south wall to just left of the east wall, through the corner diagonal
      const a = dirOf(at(f, 82 + i * 0.4, 93 - i * 0.4));
      if (prev !== null) maxStep = Math.max(maxStep, angDiff(a, prev));
      prev = a;
      if (angDiff(a, 90) < 12) sawSouth = true;
      if (angDiff(a, 0) < 12) sawEast = true;
    }
    t.ok(`rain-field: the corner turns in small steps (largest ${maxStep.toFixed(0)} deg)`, maxStep < 22);
    t.ok('rain-field: both walls are represented along the way', sawSouth && sawEast);
  }

  // ── 7. light outside any building, and no outdoors at all ────────────────
  {
    const s = makeScene();
    paintBuilding(s, rect(32, 32, 96, 96));
    pool(s, 10, 10, 20, 20); // out in the open
    const f = derive(s);
    const o = at(f, 15, 15);
    t.ok('rain-field: light on open ground has no direction but is gated on', o.kappa < 0.05 && o.gate > 0.99);
    const g = deriveWindowRainField({ outdoors: null, spec: s.spec, presence: s.presence, maxDim: 4096 });
    t.ok('rain-field: with no outdoors it still derives a gate', g !== null && at(g, 15, 15).gate > 0.99);
    t.ok('rain-field: ...and every kappa is 0', at(g, 15, 15).kappa === 0 && g.stats.hasGeometry === false);
  }

  // ── 8. nothing lit -> null; bad input -> null; determinism; texture encoding ──
  {
    const s = makeScene();
    paintBuilding(s, rect(32, 32, 96, 96));
    t.ok('rain-field: no window light derives nothing', derive(s) === null);
    t.ok(
      'rain-field: mismatched sizes derive nothing',
      deriveWindowRainField({ outdoors: { spec: s.spec, data: s.outdoors }, presence: new Uint8Array(5) }) === null
    );
    pool(s, 56, 84, 72, 94);
    const a = derive(s);
    const b = derive(s);
    t.ok(
      'rain-field: derivation is deterministic',
      Buffer.compare(Buffer.from(a.dirs), Buffer.from(b.dirs)) === 0 &&
        Buffer.compare(Buffer.from(a.aux), Buffer.from(b.aux)) === 0
    );
    let bad = 0;
    for (let i = 0; i < s.W * s.H; i++) {
      if (!a.aux[i * 4 + 3]) continue;
      const m = a.aux[i * 4] / 255;
      const px = a.dirs[i * 4] / 127.5 - 1;
      const py = a.dirs[i * 4 + 1] / 127.5 - 1;
      const l = Math.hypot(px, py);
      if (m > 0.5 + 0.01 || Math.abs(l - 1) > 0.03) bad++;
    }
    t.ok('rain-field: mix never exceeds 1/2 and P is a unit vector', bad === 0);
    t.ok('rain-field: a pure wall has no cross-fade at its pool', at(a, 64, 89).mix < 0.02);
  }

  // ── 9. derived on a coarser grid, the picture does not change ────────────
  {
    const s = makeScene(512, 512);
    s.spec = { x: 0, y: 0, width: 512 * 5, height: 512 * 5, w: 512, h: 512, texelW: 5, texelH: 5 };
    paintBuilding(s, rect(128, 128, 384, 384));
    for (let y = 336; y < 376; y++) for (let x = 224; x < 288; x++) s.presence[y * 512 + x] = 255;
    const full = deriveWindowRainField({
      outdoors: { spec: s.spec, data: s.outdoors },
      presence: s.presence,
      maxDim: 4096,
    });
    const half = deriveWindowRainField({ outdoors: { spec: s.spec, data: s.outdoors }, presence: s.presence });
    t.ok(
      'rain-field: a 512 grid is derived at 256 by default',
      half.spec.w === 256 && half.spec.h === 256 && full.spec.w === 512
    );
    const pf = sampleWindowRainField(full, 256 * 5, 356 * 5);
    const ph = sampleWindowRainField(half, 256 * 5, 356 * 5);
    t.ok(
      `rain-field: same direction at either resolution (${dirOf(pf).toFixed(1)} / ${dirOf(ph).toFixed(1)})`,
      angDiff(dirOf(pf), dirOf(ph)) < 2 && Math.abs(pf.kappa - ph.kappa) < 0.1
    );
    t.ok('rain-field: the coarse grid keeps the light gated on', ph.gate > 0.99);
  }

  // ── 10. gray distance is sub-cell accurate on a diagonal ─────────────────
  {
    const s = makeScene(64, 64);
    paintBuilding(s, rotRect(32, 32, 14, 14, 45));
    const sd = signedDistanceFromGray(s.outdoors, 64, 64);
    t.ok(
      `rain-field: distance at the centre of a diamond is its half-width (${sd[32 * 64 + 32].toFixed(2)})`,
      Math.abs(sd[32 * 64 + 32] - 14) < 0.5
    );
  }

  // ── 11. the presence builder decodes like the shader ─────────────────────
  {
    const data = new Uint8Array(4 * 4 * 4);
    const set = (x, y, r, g, b, a) => data.set([r, g, b, a], (y * 4 + x) * 4);
    set(1, 1, 0, 0, 200, 255); // a blue-only cookie counts
    set(2, 2, 90, 0, 0, 0); // alpha 0 reads as opaque (the engine's fallback)
    const spec = { x: 0, y: 0, width: 400, height: 400, w: 4, h: 4 };
    const g = buildWindowPresenceGrid({
      data,
      width: 4,
      height: 4,
      rect: { minX: 0, minY: 0, maxX: 400, maxY: 400 },
      spec,
    });
    t.ok('rain-field: a blue-only cookie is present', g[1 * 4 + 1] === 200);
    t.ok('rain-field: alpha 0 falls back to opaque', g[2 * 4 + 2] === 90);
    t.ok('rain-field: nothing elsewhere', g[0] === 0 && g[15] === 0);
  }
}
