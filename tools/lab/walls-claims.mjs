/**
 * tools/lab/walls-claims.mjs — what Lab · Walls & Windows SHOULD show, written down BEFORE measuring
 * (mmp-78u, the "expectations first" method; Ingram 2026-11-08: "Build a wide set of expectations and
 * then compare what you find").
 *
 * Every claim names its SOURCE, most trusted first:
 *   foundry — Foundry v14's own rules (resources/app/client/canvas/geometry/clockwise-sweep.mjs,
 *             edges/edge.mjs, shapes/source-polygon.mjs, documents/wall.mjs, placeables/token.mjs).
 *             The probe's `foundry.lights` IS Foundry's verdict for a point (the wall-clipped light
 *             shape contains it); MSA must draw light where Foundry says lit and none where it says unlit.
 *   msa     — MSA's own declarations (foundry/scene-walls.js, lighting/window-reach.js,
 *             lighting/light-penumbra.js, lighting/aperture-gobo.js, window/window-room-light.js, guide).
 *   author  — Ingram's rulings (~/.claude/rants), quoted by date in `cite`.
 *   physics — plain physics / common sense (no reflections, symmetry, a wall never changes its lit side).
 *
 * METRIC (corrected after the first run, see the note). The composite works in GAMMA space: measured on
 * the rig, lit = toLinear(albedo_srgb x illum + coloration) to 4 decimals for every static light. So:
 *   - a point's EXCESS is OETF(lit) minus the same cell's `ref` (unlit floor) in OETF(lit), and "dark" /
 *     "lit" thresholds are in 8-bit levels of that (what the eye sees, before Dynamic Range);
 *   - a RATIO compares a point with a MIRROR point at the same distance from the light with a clear path,
 *     using the COLORATION buffer: the light's own term, zero where it does not land, and it scales exactly
 *     with any multiplier on the light (window reach read 0.941 against the declared 0.944);
 *   - daylight and _Windows claims read `illum` (no coloration there).
 * NOTE (c, 2026-11-09): the first run used LINEAR lit excess for everything. Because toLinear is convex,
 * linear ratios understate multipliers (the wall fade read 0.568 for a declared 0.84, window reach 0.87
 * for 0.944) and linear thresholds are blind to dim but visible light. Claims unchanged; the metric fixed.
 *
 * Lamp/candle/torch radii in px (grid 150 px = 5 ft, so 30 px/ft): lamp 12 ft = 360, candle 6 ft = 180,
 * token torch 12 ft + external radius 75 = 435 (Token#getLightRadius).
 *
 * POINTS are named per light kind, as [dx, dy] from (wall x, feature-segment middle) in scene px. The
 * wall runs dy -300..300; the feature segment is dy -150..150; the normal ends are the rest.
 *
 * Pure: data and small functions, no IO. The runner is lab-check.mjs (`lab.mjs check --family walls`).
 *
 * @module tools/lab/walls-claims
 */
import { WALL_TYPES, LIGHT_KINDS, wallsCell } from './walls-spec.mjs';

/** One 8-bit level of OETF(lit). */
const LEVEL = 1 / 255;
/** Excess (OETF(lit), mean RGB) at or below this = "adds no light": 4 levels. Ambient here is ~35/255. */
export const EXCESS_DARK = 4 * LEVEL;
/** The looser bound of the universal no-leak claim (G01): 6 levels. */
export const EXCESS_LEAK = 6 * LEVEL;
/** "Clearly lit": 8 levels. */
export const EXCESS_LIT = 8 * LEVEL;
/** Coloration ratios never divide by less than this (an unlit mirror would make any ratio noise). */
const MIN_MIRROR_COLOR = 0.01;

// --------------------------------------------------------------------------------------------- points
// A third element 'patch' makes a 3x3 patch, 10 px apart, read as its MEAN: window light carries MSA's glass
// caustic (a blob field, by design), so a lone pixel is not "the pool" (manager, 2026-11-09).
const SPLIT_POINTS = Object.freeze({
  out: [-225, -300], // open ground, middle of the outdoor strip
  lit: [-45, 0], // outdoors, 45 px from the indoor half, beside the feature segment
  litEnd: [-45, -225], // outdoors, 45 px from the indoor half, beside a normal end
  spill: [-15, -30], // outdoors, 15 px out, inside the painted pool's Gaussian spill (~25% of the pool value)
  pool: [150, -40, 'patch'], // indoors, the middle of the _Windows pool (off the joins stub line)
  poolB: [110, 80, 'patch'], // indoors, a second patch of the pool
  poolNear: [20, -40, 'patch'], // indoors, 20 px from the wall, in the pool
  beh: [60, -40], // indoors behind the feature segment
  behEnd: [60, -225], // indoors behind a normal end
  ref: [375, -375], // indoors, unlit floor
});
const PATCH = Object.freeze([-10, 0, 10].flatMap((oy) => [-10, 0, 10].map((ox) => [ox, oy])));

export const WALLS_POINTS = Object.freeze({
  // lamp at (-120, 0), radius 360, bright 120
  lampNear: Object.freeze({
    lit: [-45, 0],
    wall6: [-6, 4], // 6 px before the wall face, 114 px from the lamp
    m114: [-120, -114],
    m128: [-120, -128],
    m180: [-120, -180],
    m240: [-120, -240],
    jct1: [-20, -150], // lit side at the upper junction of normal end and feature (180 px)
    jct2: [-20, 150], // lit side at the lower junction (180 px)
    fin: [45, -191], // FAR side, inside the upper joint's shadow-edge band: 60 px past the corner, 10 px in (252 px)
    m252: [-120, -252],
    b8: [8, 6], // 8 px past the feature (128 px from the lamp)
    b60: [60, 12], // 180 px
    b120: [120, 12], // 240 px
    pat90: [90, 30], // pattern scan behind the window (212, 252, 292 px)
    pat130: [130, -30],
    pat170: [170, 30],
    ref: [375, -375],
  }),
  // lamp at (-60, -352): 52 px above the wall's top end, 60 px to its left
  lampEnd: Object.freeze({
    lit: [-20, -280], // lit side, 82 px
    m82: [-142, -352],
    around: [100, -330], // round the wall's top end, right of the wall (161 px)
    m161: [-221, -352],
    edgeNear: [49, -280], // 17 px inside the top-end shadow edge, 50 px past the corner (130 px)
    m130: [-190, -352],
    edgeFar: [99, -236], // 17 px inside the same edge, 117 px past the corner (197 px)
    m197: [-257, -352],
    endShadow: [40, -140], // behind the normal end (its ray crosses the end at dy -225), 234 px
    fin: [-20, -150], // lit side at the junction, 206 px
    m206: [-266, -352],
    ref: [375, -375],
  }),
  // candle at (-75, 0), radius 180, bright 45, flame animation
  candle: Object.freeze({
    lit: [-45, 0],
    m30: [-75, -30],
    b30: [30, 12], // 106 px
    m106: [-75, -106],
    b60: [60, 12], // 136 px
    m136: [-75, -136],
    b90: [90, 12], // 165 px
    m165: [-75, -165],
    r54: [-75, 54], // radial profile on the lit side: 0.30, 0.60, 0.85, 0.95 of the radius
    r108: [-75, 108],
    r153: [-75, 153],
    r171: [-75, 171],
    ref: [375, -375],
  }),
  // token torch centred at (-165, 0) (token x is its corner, 240 px out), radius 435, bright 255, ext 75
  torch: Object.freeze({
    lit: [-45, 0], // 120 px
    m120: [-165, -120],
    b30: [30, 12], // 195 px
    m195: [-165, -195],
    b60: [60, 12], // 225 px
    m225: [-165, -225],
    b120: [120, 12], // 285 px
    m285: [-165, -285],
    endShadow: [40, -211], // behind the normal end, 294 px
    pillarShadow: [-302, -312], // behind the joins pillar, 341 px
    pillarMirror: [-195, -339], // same distance, clear of the pillar
    r400: [-165, 400], // 400 px, inside the 435 px token radius
    ref: [375, -375],
  }),
  pool: SPLIT_POINTS,
  sun: SPLIT_POINTS,
});

/** Scene-px points of one cell, plus its pan centre. */
export function wallsCellPoints(wallKey, lightKey) {
  const col = WALL_TYPES.findIndex((t) => t.key === wallKey);
  const row = LIGHT_KINDS.findIndex((k) => k.key === lightKey);
  if (col < 0 || row < 0) throw new Error(`no walls cell ${wallKey}/${lightKey}`);
  const c = wallsCell(col, row);
  const mid = (c.segTop + c.segBottom) / 2;
  const pts = Object.entries(WALLS_POINTS[lightKey]).flatMap(([name, [dx, dy, kind]]) =>
    kind === 'patch'
      ? PATCH.map(([ox, oy], i) => ({ name: `${name}#${i}`, x: c.wallX + dx + ox, y: mid + dy + oy }))
      : [{ name, x: c.wallX + dx, y: mid + dy }]
  );
  return { key: `${wallKey}/${lightKey}`, wall: wallKey, light: lightKey, col, row, cx: c.wallX, cy: mid, pts };
}

/** Fold `name#i` patch reads into one row `name` (means of the buffers; on screen only if all are). */
export function foldPatches(P) {
  const out = {};
  const groups = {};
  for (const [k, r] of Object.entries(P)) {
    const m = /^(.*)#\d+$/.exec(k);
    if (m) (groups[m[1]] ??= []).push(r);
    else out[k] = r;
  }
  const avg = (rows, key) => {
    if (!rows.every((r) => Array.isArray(r?.[key]))) return null;
    return [0, 1, 2].map((i) => rows.reduce((s, r) => s + r[key][i], 0) / rows.length);
  };
  for (const [name, rows] of Object.entries(groups)) {
    const centre = rows[4] ?? rows[0];
    out[name] = {
      name,
      patch: rows.length,
      onScreen: rows.every((r) => r?.onScreen),
      lit: avg(rows, 'lit'),
      illum: avg(rows, 'illum'),
      coloration: avg(rows, 'coloration'),
      presented: avg(rows, 'presented'),
      drift: rows.find((r) => r?.drift && r.drift.verdict !== 'ok')?.drift ?? centre?.drift ?? null,
      foundry: centre?.foundry ?? null,
    };
  }
  return out;
}

// --------------------------------------------------------------------------------------------- helpers
const mean3 = (a) => (Array.isArray(a) && a.length >= 3 ? (a[0] + a[1] + a[2]) / 3 : NaN);
const oetf = (l) => {
  const c = Math.max(0, Math.min(1, l));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
};
/** Mean of OETF(lit): the gamma-space value the composite produced, 0..1 (x255 = 8-bit levels). */
export const gOf = (r) => (Array.isArray(r?.lit) ? mean3(r.lit.map(oetf)) : NaN);
export const litOf = (r) => mean3(r?.lit);
export const illumOf = (r) => mean3(r?.illum);
export const colOf = (r) => mean3(r?.coloration);
export const presOf = (r) => mean3(r?.presented);
/** Gamma-space excess over the cell's unlit floor. */
export const excess = (r, ref) => gOf(r) - gOf(ref);
/** The light's multiplier at `r` against a clear mirror: coloration ratio (the `ref` argument is unused, kept for call shape). */
export const ratio = (r, m, _ref) => colOf(r) / Math.max(colOf(m), MIN_MIRROR_COLOR);
/** Foundry's light sources whose shape contains the point (MSA's vision-only door lights and global light dropped). */
export const foundryLights = (r) =>
  (r?.foundry?.lights ?? []).filter((l) => !/^(msa-vision|globalLight)/.test(String(l.id)));
export const foundryLit = (r) => foundryLights(r).length > 0;

const f3 = (v) => (Number.isFinite(v) ? Number(v.toFixed(3)) : String(v));
const res = (pass, got, want) => ({ pass: Boolean(pass), got: String(got), want: String(want) });
/** Combine results: passes when all do. */
const every = (...rs) => ({
  pass: rs.every((r) => r.pass),
  got: rs.map((r) => r.got).join('; '),
  want: rs.map((r) => r.want).join('; '),
});
const lv = (e) => (Number.isFinite(e) ? `${(e * 255).toFixed(1)}lv` : String(e));
/** No light added at a point (gamma excess over the cell's ref, in 8-bit levels). */
const isDark = (P, n, tol = EXCESS_DARK) => {
  const e = excess(P[n], P.ref);
  return res(e <= tol, `${n}+${lv(e)}`, `${n}<=${lv(tol)}`);
};
/** Lit by at least `min` (gamma excess). */
const isLit = (P, n, min = EXCESS_LIT) => {
  const e = excess(P[n], P.ref);
  return res(e >= min, `${n}+${lv(e)}`, `${n}>=${lv(min)}`);
};
/** Excess ratio against a mirror within [lo, hi]. */
const within = (P, n, m, lo, hi) => {
  const q = ratio(P[n], P[m], P.ref);
  return res(q >= lo && q <= hi, `${n}/${m}=${f3(q)}`, `${n}/${m} in [${lo},${hi}]`);
};
/** Foundry's verdict at a point. */
const foundrySays = (P, n, lit) =>
  res(foundryLit(P[n]) === lit, `${n}:${foundryLit(P[n]) ? 'lit' : 'unlit'}`, `${n}:${lit ? 'lit' : 'unlit'}`);
const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/**
 * Row scope: each named point's `metric` must sit within `tol` (relative) of the row median.
 * @returns {{pass:boolean, got:string, want:string, cells:string[]}}
 */
function consistentAcross(Prow, names, tol, metric = gOf) {
  const bad = new Set();
  const notes = [];
  for (const n of names) {
    const vals = Object.entries(Prow).map(([w, P]) => [w, metric(P[n])]);
    const med = median(vals.map(([, v]) => v));
    for (const [w, v] of vals) {
      if (!Number.isFinite(v)) continue;
      const dev = Math.abs(v - med) / Math.max(Math.abs(med), 1e-6);
      if (dev > tol) {
        bad.add(w);
        notes.push(`${w}.${n}=${f3(v)} vs median ${f3(med)}`);
      }
    }
  }
  return {
    pass: bad.size === 0,
    got: notes.length
      ? notes.slice(0, 6).join('; ') + (notes.length > 6 ? ` (+${notes.length - 6})` : '')
      : 'all within',
    want: `each of ${names.join(',')} within ${tol * 100}% of the row median`,
    cells: [...bad],
  };
}

// --------------------------------------------------------------------------------------------- wall groups
// Per light, by Foundry's rules (Edge#applyThreshold + PointSourcePolygon threshold attenuation):
//   lamp 120 px from the glass:   t10 window passes (attenuated radius 345 = full here), t5 window attenuates
//                                 to 138.75 px from the lamp (19 px past the glass)
//   candle 75 px:                 t10 passes full (180), t5 attenuates to 150 px (75 px past)
//   torch 165 px, ext 75 (90 eff): t10 passes full (435), t5 attenuates to 215 px (50 px past)
const ALL = WALL_TYPES.map((t) => t.key);
/** Light sense NONE, an open door (Wall#isOpen zeroes every sense), one LIMITED wall (the first is passed). */
const CLEAR = ['invisible', 'terrain', 'oneway', 'doorOpen', 'seeDoor'];
/** Blocks every light here (normal; DISTANCE without a threshold blocks like normal; closed doors). */
const SOLID = ['normal', 'distance', 'doorClosed', 'secret', 'joins'];
/** MSA's window REACH windows (deriveWallLooksLikeWindow) that Foundry lets the lamp through fully. */
const REACH_FULL = ['window', 'sightOnly'];

const C = (s) =>
  ({
    sweep: 'client/canvas/geometry/clockwise-sweep.mjs#_testEdgeInclusion',
    threshold: 'client/canvas/geometry/edges/edge.mjs#applyThreshold',
    atten:
      'client/canvas/geometry/shapes/source-polygon.mjs#calculateThresholdAttenuation (CONFIG.Wall.thresholdAttenuationMultiplier 1)',
    open: 'client/documents/wall.mjs#createEdge (isOpen -> every sense NONE)',
    limited: 'clockwise-sweep.mjs (LIMITED: the first limited edge is passed, the second blocks)',
    dir: 'clockwise-sweep.mjs#_testEdgeInclusion + edge.mjs#orientPoint (orient2dFast<0 = LEFT)',
    token:
      'client/canvas/placeables/token.mjs#getLightRadius + #externalRadius (light reach and threshold measured from the token edge)',
    region: 'adjustDarknessLevel Region, override mode 0, modifier 0.9 (walls-spec.mjs)',
    reach: 'src/effects/lighting/window-reach.js (reach 300 px, full for the first 30%, smoothstep to 0 at 300)',
    pen: 'src/effects/lighting/light-penumbra.js (wall fade 8 px; shadow band 2 + 0.35 px per px past the corner; inside only)',
    gobo: 'src/effects/lighting/aperture-gobo.js + foundry/scene-walls.js#deriveWallAperture (flag windowPattern)',
    room: 'src/effects/window/window-room-light.js + scene/room-map.js (window light fades near room-dividing walls)',
    probe: 'src/vt/vt-pan-viewer.js#runProbeV2 (drift = presented vs OETF(lit); ok < 32)',
  })[s] ?? s;

// --------------------------------------------------------------------------------------------- claims
/**
 * @typedef {object} WallsClaim
 * @property {string} id
 * @property {'foundry'|'msa'|'author'|'physics'} source
 * @property {string} cite
 * @property {string} claim
 * @property {string[]} lights - light kinds (rows) it covers
 * @property {string[]} walls - wall types (columns) it covers
 * @property {'cell'|'row'|'scene'} [scope] - cell (default): check(P); row: check({wall: P}); scene: check({key: P})
 * @property {string[]} [views] - default both
 * @property {string} [known] - an existing bead this claim is expected to fail on
 * @property {string} [untestable] - why this layout cannot test it: measured and reported, never judged
 * @property {string} [note] - why a claim was corrected (method: keep the note)
 * @property {Function} check
 */
/** @type {WallsClaim[]} */
export const WALLS_CLAIMS = [
  // ------------------------------------------------------------------ V: Foundry's own verdicts
  {
    id: 'V01',
    source: 'foundry',
    cite: C('sweep'),
    claim: 'A normal wall stops the near lamp: Foundry says unlit behind it.',
    lights: ['lampNear'],
    walls: ['normal'],
    check: (P) => every(foundrySays(P, 'b60', false), foundrySays(P, 'b120', false)),
  },
  {
    id: 'V02',
    source: 'foundry',
    cite: `${C('sweep')}; ${C('open')}; ${C('limited')}`,
    claim: 'Light NONE, an open door and a single LIMITED wall all pass the lamp: Foundry says lit behind them.',
    lights: ['lampNear'],
    walls: ['invisible', 'sightOnly', 'seeDoor', 'doorOpen', 'terrain'],
    check: (P) => every(foundrySays(P, 'b60', true), foundrySays(P, 'b120', true)),
  },
  {
    id: 'V03',
    source: 'foundry',
    cite: `${C('threshold')}; ${C('atten')}`,
    claim:
      'The Window preset (light PROXIMITY, 10 ft, attenuation) passes a lamp 4 ft away out to 345 px: lit at 180 and 240 px.',
    lights: ['lampNear'],
    walls: ['window', 'pattern'],
    check: (P) => every(foundrySays(P, 'b60', true), foundrySays(P, 'b120', true)),
  },
  {
    id: 'V04',
    source: 'foundry',
    cite: `${C('threshold')}; ${C('atten')}`,
    claim:
      'The 5 ft window passes the lamp 4 ft away but attenuates it to 138.75 px from the lamp: lit 8 px past the glass, unlit 60 px past.',
    lights: ['lampNear'],
    walls: ['window5'],
    check: (P) => every(foundrySays(P, 'b8', true), foundrySays(P, 'b60', false)),
  },
  {
    id: 'V05',
    source: 'foundry',
    cite: `${C('threshold')} (no threshold -> returns false -> the edge stays, like NORMAL)`,
    claim: 'A DISTANCE wall with no threshold set blocks light like a normal wall.',
    lights: ['lampNear'],
    walls: ['distance'],
    check: (P) => foundrySays(P, 'b60', false),
  },
  {
    id: 'V06',
    source: 'foundry',
    cite: C('dir'),
    claim:
      'One-way wall dir=1 (LEFT): the lamp sits on its LEFT side, so in NORMAL mode the edge is skipped and light passes.',
    lights: ['lampNear'],
    walls: ['oneway'],
    check: (P) => foundrySays(P, 'b60', true),
  },
  {
    id: 'V07',
    source: 'foundry',
    cite: C('open'),
    claim: 'Closed doors and closed secret doors block light.',
    lights: ['lampNear'],
    walls: ['doorClosed', 'secret'],
    check: (P) => foundrySays(P, 'b60', false),
  },
  {
    id: 'V08',
    source: 'foundry',
    cite: `${C('threshold')}; ${C('atten')}`,
    claim:
      'The 5 ft window passes the candle 2.5 ft away, attenuated to 150 px: lit at 106 and 136 px, unlit at 165 px.',
    lights: ['candle'],
    walls: ['window5'],
    check: (P) => every(foundrySays(P, 'b30', true), foundrySays(P, 'b60', true), foundrySays(P, 'b90', false)),
  },
  {
    id: 'V09',
    source: 'foundry',
    cite: `${C('threshold')}; ${C('atten')}`,
    claim: 'The Window preset passes the candle at its full 180 px radius: lit at 165 px.',
    lights: ['candle'],
    walls: ['window', 'pattern'],
    check: (P) => foundrySays(P, 'b90', true),
  },
  {
    id: 'V10',
    source: 'foundry',
    cite: `${C('token')}; ${C('threshold')}; ${C('atten')}`,
    claim:
      'The token torch is 165 px from the 5 ft window but its 75 px external radius counts (90 px < 150): it passes, attenuated to 215 px: lit at 195 px, unlit at 225 px.',
    lights: ['torch'],
    walls: ['window5'],
    check: (P) => every(foundrySays(P, 'b30', true), foundrySays(P, 'b60', false)),
  },
  {
    id: 'V11',
    source: 'foundry',
    cite: `${C('token')}; ${C('atten')}`,
    claim: 'The Window preset passes the torch unattenuated (radius 435): lit at 285 px.',
    lights: ['torch'],
    walls: ['window'],
    check: (P) => foundrySays(P, 'b120', true),
  },
  {
    id: 'V12',
    source: 'foundry',
    cite: C('sweep'),
    claim:
      "The lamp at the wall's end lights round the end and not behind the normal end, whatever the feature segment is.",
    lights: ['lampEnd'],
    walls: ALL,
    check: (P) => every(foundrySays(P, 'around', true), foundrySays(P, 'endShadow', false)),
  },
  {
    id: 'V13',
    source: 'foundry',
    cite: C('sweep'),
    claim: 'The joins pillar casts a shadow from the torch: unlit behind it, lit beside it.',
    lights: ['torch'],
    walls: ['joins'],
    check: (P) => every(foundrySays(P, 'pillarShadow', false), foundrySays(P, 'pillarMirror', true)),
  },
  {
    id: 'V14',
    source: 'foundry',
    cite: C('token'),
    claim: 'A token light reaches dim + external radius (12 ft + 75 px = 435 px): lit at 400 px.',
    lights: ['torch'],
    walls: ALL,
    check: (P) => foundrySays(P, 'r400', true),
  },
  {
    id: 'V15',
    source: 'foundry',
    cite: C('region'),
    claim: 'Foundry darkness is 0.9 indoors (Region override) and 0 on the open strip at noon.',
    lights: LIGHT_KINDS.map((k) => k.key),
    walls: ALL,
    check: (P) => {
      const d = (n) => P[n]?.foundry?.darkness;
      const near = (v, t) => Number.isFinite(v) && Math.abs(v - t) < 0.02;
      const parts = [res(near(d('ref'), 0.9), `ref:${f3(d('ref'))}`, 'ref:0.9')];
      if (P.out) parts.push(res(near(d('out'), 0), `out:${f3(d('out'))}`, 'out:0'));
      return every(...parts);
    },
  },

  // ------------------------------------------------------------------ G: universal
  {
    id: 'G01',
    source: 'foundry',
    cite: `${C('sweep')}; ${C('pen')} (inside only: MSA never adds light outside Foundry's polygon)`,
    claim: 'Wherever Foundry says no light reaches a probe point, MSA adds none (at most 6 levels over unlit floor).',
    lights: ['lampNear', 'lampEnd', 'candle', 'torch'],
    walls: ALL,
    check: (P) => {
      const bad = [];
      let n = 0;
      for (const [name, row] of Object.entries(P)) {
        if (name === 'ref' || !row || foundryLit(row)) continue;
        n++;
        const e = excess(row, P.ref);
        if (!(e <= EXCESS_LEAK)) bad.push(`${name}+${lv(e)}`);
      }
      return res(
        bad.length === 0,
        bad.length ? bad.join(', ') : `${n} unlit points dark`,
        `excess<=${lv(EXCESS_LEAK)}`
      );
    },
  },
  {
    id: 'G02',
    source: 'msa',
    cite: C('probe'),
    claim: 'With the post effects off, the presented pixel matches the lit buffer (probe drift ok) at every point.',
    lights: LIGHT_KINDS.map((k) => k.key),
    walls: ALL,
    views: ['measure'],
    check: (P) => {
      const bad = Object.entries(P)
        .filter(([, r]) => r?.drift && r.drift.verdict !== 'ok')
        .map(([n, r]) => `${n}:${r.drift.maxAbs}`);
      return res(bad.length === 0, bad.length ? bad.join(', ') : 'all ok', 'drift ok (<32)');
    },
  },
  {
    id: 'G03',
    source: 'msa',
    cite: 'msa-lab memory: the composite multiplies in gamma space (screen ~ painted x illum); indoor ambient illum 0.264',
    claim: 'Measure view: unlit indoor floor (art 128, albedo ~132) presents at about 132 x 0.264 = 35 (28..42).',
    lights: LIGHT_KINDS.map((k) => k.key),
    walls: ALL,
    views: ['measure'],
    check: (P) => {
      const v = presOf(P.ref);
      return res(v >= 28 && v <= 42, `ref ${f3(v)}`, '28..42');
    },
  },
  {
    id: 'G04',
    source: 'msa',
    cite: 'msa-lab memory: noon daylight illum 0.922; "Measure view shows 128 as 116"',
    claim: 'Measure view: open ground at noon presents at about 116 (106..126).',
    lights: ['pool', 'sun'],
    walls: ALL,
    views: ['measure'],
    check: (P) => {
      const v = presOf(P.out);
      return res(v >= 106 && v <= 126, `out ${f3(v)}`, '106..126');
    },
  },

  // ------------------------------------------------------------------ A: lamp near the feature
  {
    id: 'A01',
    source: 'physics',
    cite: 'no wall changes the light on its own lit side; identical lamps render identically',
    claim: "The lamp side reads the same in all 14 columns (the light's coloration within 3% of the row median).",
    lights: ['lampNear'],
    walls: ALL,
    scope: 'row',
    check: (Prow) => consistentAcross(Prow, ['lit', 'm114', 'm128', 'm180', 'm240'], 0.03, colOf),
  },
  {
    id: 'A02',
    source: 'foundry',
    cite: `${C('sweep')}; ${C('atten')}`,
    claim:
      'Behind walls that stop the lamp (normal, Distance, closed doors, joins, and the 5 ft window past 19 px) MSA adds no light.',
    lights: ['lampNear'],
    walls: [...SOLID, 'window5'],
    check: (P) => every(isDark(P, 'b60'), isDark(P, 'b120')),
  },
  {
    id: 'A03',
    source: 'foundry',
    cite: `${C('sweep')}; ${C('open')}; ${C('limited')}; ${C('dir')}`,
    claim:
      'Walls Foundry lets the lamp through unchanged leave its light unchanged (behind = mirror at the same distance, +-8%).',
    lights: ['lampNear'],
    walls: CLEAR,
    check: (P) => every(within(P, 'b60', 'm180', 0.92, 1.08), within(P, 'b120', 'm240', 0.92, 1.08)),
  },
  {
    id: 'A04',
    source: 'msa',
    cite: C('reach'),
    claim:
      'Window reach keeps full strength for the first 90 px past a window: 60 px past reads like the mirror (>= 0.92).',
    lights: ['lampNear'],
    walls: REACH_FULL,
    check: (P) => within(P, 'b60', 'm180', 0.92, 1.08),
  },
  {
    id: 'A05',
    source: 'msa',
    cite: C('reach'),
    claim: 'Window reach at 120 px past the glass is smoothstep(90, 300) -> x0.944: behind/mirror in [0.88, 1.0].',
    lights: ['lampNear'],
    walls: REACH_FULL,
    check: (P) => within(P, 'b120', 'm240', 0.88, 1.0),
  },
  {
    id: 'A06',
    source: 'foundry',
    cite: `${C('atten')}; ${C('reach')}`,
    claim:
      "8 px past the 5 ft window, inside Foundry's attenuated radius, MSA lights the floor (>= 0.6 of the mirror).",
    lights: ['lampNear'],
    walls: ['window5'],
    check: (P) => within(P, 'b8', 'm128', 0.6, 1.1),
  },
  {
    id: 'A07',
    source: 'physics',
    cite: 'Foundry lights have no reflections; nothing brightens a floor because a wall stands beside it',
    claim:
      'Right at the wall face (6 px) the lamp side is never brighter than open floor at the same distance (<= 1.05).',
    lights: ['lampNear'],
    walls: ALL,
    check: (P) => within(P, 'wall6', 'm114', -1, 1.05),
  },
  {
    id: 'A08',
    source: 'msa',
    cite: C('pen'),
    claim:
      'Where the lamp meets a wall face the light fades over 8 px: 6 px out it reads smoothstep(0,8,6) ~ 0.84 of open floor (0.6..0.95).',
    lights: ['lampNear'],
    walls: SOLID,
    check: (P) => within(P, 'wall6', 'm114', 0.6, 0.95),
  },
  {
    id: 'A09',
    source: 'msa',
    cite: `${C('pen')} (only edges of the light's own polygon fade; a passable wall is not one)`,
    claim:
      'Where the wall lets the lamp through there is no wall fade at the face: 6 px out reads like open floor (0.95..1.05).',
    lights: ['lampNear'],
    walls: [...CLEAR, ...REACH_FULL, 'window5', 'pattern'],
    check: (P) => within(P, 'wall6', 'm114', 0.95, 1.05),
  },
  {
    id: 'A10',
    source: 'author',
    cite: 'rants 2026-11-01 "strange shapes from the light near those nodes"; physics: light never darkens the side it comes from',
    claim:
      'On the lamp side, where the normal ends meet the feature segment, the light equals open floor at the same distance (+-8%).',
    lights: ['lampNear'],
    walls: ALL,
    known: 'mmp-78u.14',
    check: (P) => every(within(P, 'jct1', 'm180', 0.92, 1.08), within(P, 'jct2', 'm180', 0.92, 1.08)),
  },
  {
    id: 'A11',
    source: 'physics',
    cite: 'the cell is mirror-symmetric about the lamp row',
    claim: 'The upper and lower junctions read alike (+-5%).',
    lights: ['lampNear'],
    walls: ALL,
    check: (P) => within(P, 'jct1', 'jct2', 0.95, 1.05),
  },
  {
    id: 'A12',
    source: 'msa',
    cite: C('gobo'),
    claim:
      'A window-pattern wall (Window preset + flag) casts a window pattern: somewhere behind it the lamp lights the floor (>= 0.15 of the plateau).',
    lights: ['lampNear'],
    walls: ['pattern'],
    known: 'mmp-78u.13',
    check: (P) => {
      const best = Math.max(...['b60', 'b120', 'pat90', 'pat130', 'pat170'].map((n) => ratio(P[n], P.m240, P.ref)));
      return res(best >= 0.15, `best ${f3(best)}`, '>=0.15 of m240');
    },
  },

  {
    id: 'A13',
    source: 'msa',
    cite: `${C('pen')} (60 px past the joint the band is 2 + 0.35 x 60 = 23 px; 10 px inside it -> smoothstep(0.435) = 0.40)`,
    claim:
      "Beyond a wall the lamp passes, next to the joint, the end's shadow edge is the declared INSIDE-ONLY band: 10 px inside it, 60 px past the corner, the light reads ~0.40 of open floor (0.2..0.65). This band is the 'fin'.",
    lights: ['lampNear'],
    walls: CLEAR,
    known: 'mmp-78u.14',
    check: (P) => within(P, 'fin', 'm252', 0.2, 0.65),
  },
  {
    id: 'A14',
    source: 'msa',
    cite: `${C('pen')}; ${C('reach')} (soft sides: the outer 30% of the glass fades; the crossing is 4% along it)`,
    claim:
      'Through a reach window the same spot is also near the end of the glass, so window reach soft sides darken it further: ~0.40 x 0.28 = 0.11 of open floor (0.02..0.3).',
    lights: ['lampNear'],
    walls: REACH_FULL,
    check: (P) => within(P, 'fin', 'm252', 0.02, 0.3),
  },

  // ------------------------------------------------------------------ B: lamp at the wall's end
  {
    id: 'B01',
    source: 'physics',
    cite: 'no wall changes the light on its own lit side; identical lamps render identically',
    claim: "The lamp side reads the same in all 14 columns (the light's coloration within 3% of the row median).",
    lights: ['lampEnd'],
    walls: ALL,
    scope: 'row',
    check: (Prow) => consistentAcross(Prow, ['lit', 'm82', 'm130', 'm161', 'm197', 'm206'], 0.03, colOf),
  },
  {
    id: 'B02',
    source: 'foundry',
    cite: C('sweep'),
    claim: "Light that goes round the wall's end reads like open floor at the same distance (+-10%).",
    lights: ['lampEnd'],
    walls: ALL,
    check: (P) => within(P, 'around', 'm161', 0.9, 1.1),
  },
  {
    id: 'B03',
    source: 'foundry',
    cite: C('sweep'),
    claim: 'Behind the normal end MSA adds no light.',
    lights: ['lampEnd'],
    walls: ALL,
    check: (P) => isDark(P, 'endShadow'),
  },
  {
    id: 'B04',
    source: 'msa',
    cite: C('pen'),
    claim:
      "The end's shadow edge is soft: 17 px inside it, 117 px past the corner (band 43 px), the light reads smoothstep(0.4) ~ 0.35 of open floor (0.1..0.7).",
    lights: ['lampEnd'],
    walls: ALL,
    check: (P) => within(P, 'edgeFar', 'm197', 0.1, 0.7),
  },
  {
    id: 'B05',
    source: 'author',
    cite: `rants 2026-11-01 "A bit blurred where light meets a wall and very blurred where light cut but going further away"; ${C('pen')}`,
    claim:
      'The shadow edge sharpens toward the corner: 17 px inside it but only 50 px past the corner the light is nearly full (>= 0.85), and clearly fuller than 117 px past (by >= 0.2).',
    lights: ['lampEnd'],
    walls: ALL,
    check: (P) => {
      const near = ratio(P.edgeNear, P.m130, P.ref);
      const far = ratio(P.edgeFar, P.m197, P.ref);
      return res(near >= 0.85 && near - far >= 0.2, `near ${f3(near)} far ${f3(far)}`, 'near>=0.85, near-far>=0.2');
    },
  },
  {
    id: 'B06',
    source: 'author',
    cite: 'rants 2026-11-01 "strange shapes from the light near those nodes"; physics: light never darkens the side it comes from',
    claim: 'On the lamp side at the junction, the light equals open floor at the same distance (+-8%).',
    lights: ['lampEnd'],
    walls: ALL,
    known: 'mmp-78u.14',
    check: (P) => within(P, 'fin', 'm206', 0.92, 1.08),
  },
  {
    id: 'B07',
    source: 'physics',
    cite: 'no reflections; the wall fade only acts within 8 px of where the ray meets the wall',
    claim: 'Next to the normal end on the lamp side (20 px off it) the light equals open floor (0.92..1.05).',
    lights: ['lampEnd'],
    walls: ALL,
    check: (P) => within(P, 'lit', 'm82', 0.92, 1.05),
  },

  // ------------------------------------------------------------------ C: candle
  {
    id: 'C01',
    source: 'foundry',
    cite: C('sweep'),
    claim: 'A candle is cut by a wall it is near: behind normal, Distance, closed doors and joins, no light.',
    lights: ['candle'],
    walls: SOLID,
    check: (P) => every(isDark(P, 'b30'), isDark(P, 'b60')),
  },
  {
    id: 'C02',
    source: 'foundry',
    cite: `${C('sweep')}; ${C('reach')} (30 and 60 px past are inside the 90 px hold)`,
    claim:
      'Behind walls Foundry passes fully (and the reach windows, inside their hold) the candle reads like the mirror (+-15%, flame flicker).',
    lights: ['candle'],
    walls: [...CLEAR, ...REACH_FULL],
    check: (P) => every(within(P, 'b30', 'm106', 0.85, 1.15), within(P, 'b60', 'm136', 0.85, 1.15)),
  },
  {
    id: 'C03',
    source: 'foundry',
    cite: `${C('threshold')}; ${C('atten')}`,
    claim:
      'The 5 ft window passes the candle to 150 px: lit like the mirror at 106 px, mostly lit at 136 px (>= 0.7), dark at 165 px.',
    lights: ['candle'],
    walls: ['window5'],
    check: (P) => every(within(P, 'b30', 'm106', 0.85, 1.15), within(P, 'b60', 'm136', 0.7, 1.15), isDark(P, 'b90')),
  },
  {
    id: 'C04',
    source: 'author',
    cite: 'rants 2026-10-27 "Make all dropoff/falloffs soft and more exponential"; 2026-11-08 "for organic effects like candles and fire we should always have a soft falloff"',
    claim:
      'The candle falls off smoothly: brighter at 0.3 R than 0.6 R than 0.85 R, still a little light at 0.85 R, and at 0.95 R at most a quarter of 0.3 R.',
    lights: ['candle'],
    walls: ALL,
    check: (P) => {
      // the light's own term (coloration) along the radius
      const [a, b, c, d] = ['r54', 'r108', 'r153', 'r171'].map((n) => colOf(P[n]));
      const pass = a > b && b > c && c >= d - 0.002 && c > 0.002 && d <= 0.25 * a;
      return res(pass, `col ${f3(a)} > ${f3(b)} > ${f3(c)} >= ${f3(d)}`, 'monotone, r153>0.002, r171<=0.25*r54');
    },
  },
  {
    id: 'C05',
    source: 'physics',
    cite: 'a point light is round',
    claim: 'On the candle side the light is the same at 30 px in two directions (+-15%, flicker read in one frame).',
    lights: ['candle'],
    walls: ALL,
    check: (P) => within(P, 'lit', 'm30', 0.85, 1.15),
  },
  {
    id: 'C06',
    source: 'msa',
    cite: C('gobo'),
    claim: 'A window-pattern wall lets some candle light through (>= 0.15 of the mirror somewhere behind it).',
    lights: ['candle'],
    walls: ['pattern'],
    known: 'mmp-78u.13',
    check: (P) => {
      const best = Math.max(ratio(P.b30, P.m106, P.ref), ratio(P.b60, P.m136, P.ref), ratio(P.b90, P.m165, P.ref));
      return res(best >= 0.15, `best ${f3(best)}`, '>=0.15');
    },
  },

  // ------------------------------------------------------------------ D: token torch
  {
    id: 'D01',
    source: 'physics',
    cite: 'a point light is round',
    claim: 'On the torch side the light is the same at 120 px in two directions (+-15%, flicker).',
    lights: ['torch'],
    walls: ALL,
    check: (P) => within(P, 'lit', 'm120', 0.85, 1.15),
  },
  {
    id: 'D02',
    source: 'foundry',
    cite: C('sweep'),
    claim: 'Behind normal, Distance, closed doors and joins the torch adds no light.',
    lights: ['torch'],
    walls: SOLID,
    check: (P) => every(isDark(P, 'b30'), isDark(P, 'b60'), isDark(P, 'b120')),
  },
  {
    id: 'D03',
    source: 'foundry',
    cite: `${C('sweep')}; ${C('open')}; ${C('limited')}; ${C('dir')}`,
    claim: 'Walls Foundry passes leave the torch unchanged behind them (+-15%, flicker).',
    lights: ['torch'],
    walls: CLEAR,
    check: (P) =>
      every(
        within(P, 'b30', 'm195', 0.85, 1.15),
        within(P, 'b60', 'm225', 0.85, 1.15),
        within(P, 'b120', 'm285', 0.85, 1.15)
      ),
  },
  {
    id: 'D04',
    source: 'foundry',
    cite: `${C('token')}; ${C('atten')}`,
    claim:
      "The torch through the 5 ft window follows Foundry's attenuated shape: lit 30 px past (>= 0.6), dark 60 px past.",
    lights: ['torch'],
    walls: ['window5'],
    check: (P) => every(within(P, 'b30', 'm195', 0.6, 1.15), isDark(P, 'b60')),
  },
  {
    id: 'D05',
    source: 'msa',
    cite: C('reach'),
    claim:
      'Through the reach windows the torch holds full strength to 90 px past (>= 0.85) and is faded only a little at 120 px (0.8..1.0).',
    lights: ['torch'],
    walls: REACH_FULL,
    check: (P) =>
      every(
        within(P, 'b30', 'm195', 0.85, 1.15),
        within(P, 'b60', 'm225', 0.85, 1.15),
        within(P, 'b120', 'm285', 0.8, 1.0)
      ),
  },
  {
    id: 'D06',
    source: 'foundry',
    cite: C('sweep'),
    claim: 'Behind the normal end the torch adds no light.',
    lights: ['torch'],
    walls: ALL,
    check: (P) => isDark(P, 'endShadow'),
  },
  {
    id: 'D07',
    source: 'foundry',
    cite: C('sweep'),
    claim: 'The joins pillar shadows the torch: dark behind it, lit beside it.',
    lights: ['torch'],
    walls: ['joins'],
    check: (P) => every(isDark(P, 'pillarShadow'), isLit(P, 'pillarMirror')),
  },
  {
    id: 'D08',
    source: 'physics',
    cite: 'control: with no pillar the two points are the same distance from the torch',
    claim: 'Without a pillar the "pillar shadow" point reads like its mirror (+-15%).',
    lights: ['torch'],
    walls: ALL.filter((w) => w !== 'joins'),
    check: (P) => within(P, 'pillarShadow', 'pillarMirror', 0.85, 1.15),
  },
  {
    id: 'D09',
    source: 'msa',
    cite: C('gobo'),
    claim: 'A window-pattern wall lets some torch light through (>= 0.15 of the mirror somewhere behind it).',
    lights: ['torch'],
    walls: ['pattern'],
    known: 'mmp-78u.13',
    check: (P) => {
      const best = Math.max(ratio(P.b30, P.m195, P.ref), ratio(P.b60, P.m225, P.ref), ratio(P.b120, P.m285, P.ref));
      return res(best >= 0.15, `best ${f3(best)}`, '>=0.15');
    },
  },

  // ------------------------------------------------------------------ E: _Windows pool at noon
  {
    id: 'E01',
    source: 'msa',
    cite: 'guide/pages/mask-window.md "The mask is the light"; src/effects/window/',
    claim: 'The painted _Windows pool lights the indoor floor: both pool patches at least 8 levels over unlit floor.',
    lights: ['pool'],
    walls: ALL.filter((w) => w !== 'joins'),
    note: "(c) 2026-11-09: joins split out to E09 — its T-stub crosses the pool and window light fades 48 px either side of a room-dividing wall (window-room-light.js wallFadePx), so its 'pool' patch, 40 px off the stub, read +7.7 levels by design.",
    check: (P) => every(isLit(P, 'pool'), isLit(P, 'poolB')),
  },
  {
    id: 'E09',
    source: 'msa',
    cite: 'guide/pages/mask-window.md "The mask is the light"; window-room-light.js wallFadePx 48',
    claim:
      'With the T-stub crossing the pool, the pool still lights the floor 80 px from the stub (poolB at least 8 levels).',
    lights: ['pool'],
    walls: ['joins'],
    check: (P) => isLit(P, 'poolB'),
  },
  {
    id: 'E02',
    source: 'author',
    cite: 'rants 2026-11-04 "_Window effect: indoors must never be brighter than outdoors (max 120%)"',
    claim: 'The window pool is at most 120% of open ground outside (illum, the light on the art).',
    lights: ['pool'],
    walls: ALL,
    check: (P) => {
      const q = Math.max(illumOf(P.pool), illumOf(P.poolB)) / Math.max(illumOf(P.out), 1e-6);
      return res(q <= 1.2, `brightest pool patch/out illum ${f3(q)}`, '<=1.2');
    },
  },
  {
    id: 'E03',
    source: 'msa',
    cite: 'guide/pages/mask-window.md "The mask is the light, not the window"',
    claim: 'The pool centre reads the same whatever the wall type (illum within 10% of the row median).',
    lights: ['pool'],
    walls: ALL,
    scope: 'row',
    untestable:
      'each pool sits under a different patch of the glass caustic (249 px blobs, gain 0.6..1.6, by design) and the open-ended walls give each column a different room-light facing; side experiment 2026-11-09: illum excess / caustic gain (window debug channel 10) = 0.318..0.355 over normal, invisible, seeDoor, doorClosed',
    check: (Prow) => consistentAcross(Prow, ['pool'], 0.1, illumOf),
  },
  {
    id: 'E04',
    source: 'author',
    cite: 'rants 2026-10-28 "what we never want is for that light to move accidentally … outside the building"; guide mask-window "Keep patches inside"',
    claim: "No window light outdoors: the outdoor point 45 px from the pool reads like the sun row's (+-5%).",
    lights: ['pool'],
    walls: ALL,
    scope: 'scene',
    check: (all) => {
      const bad = [];
      const q = (w) => illumOf(all[`${w}/pool`]?.lit) / illumOf(all[`${w}/sun`]?.lit);
      for (const w of ALL) {
        if (!Number.isFinite(q(w))) continue;
        if (Math.abs(q(w) - 1) > 0.05) bad.push(w);
      }
      return {
        pass: bad.length === 0,
        got: bad.length ? bad.map((w) => `${w} ${f3(q(w))}`).join('; ') : 'all within',
        want: 'pool.lit / sun.lit illum within 5%',
        cells: bad.map((w) => `${w}/pool`),
      };
    },
  },
  {
    id: 'E05',
    source: 'msa',
    cite: `${C('room')}; foundry/scene-walls.js#deriveWallRoomBarrier (every door divides rooms; light AND sight NONE does not)`,
    claim:
      'Window light fades near room-dividing walls only: 20 px from an invisible wall the pool keeps more of itself than beside a normal wall, and every other wall type (doors included) fades like the normal one (keep within 0.15).',
    lights: ['pool'],
    walls: ALL,
    scope: 'row',
    untestable:
      "open-ended walls: each cell's outdoor strip and indoor half are ONE room, so the room-light facing that decides whether the fade applies is degenerate (1 in most columns, ~0 in seeDoor, window debug channel 18); needs a closed-room window row",
    check: (Prow) => {
      const ex = (w, n) => illumOf(Prow[w]?.[n]) - illumOf(Prow[w]?.ref);
      const keep = (w) => ex(w, 'poolNear') / Math.max(ex(w, 'pool'), 1e-6);
      const base = keep('normal');
      const bad = [];
      if (!(keep('invisible') >= base + 0.1)) bad.push('invisible');
      for (const w of Object.keys(Prow)) {
        if (w === 'normal' || w === 'invisible' || w === 'joins') continue;
        if (Math.abs(keep(w) - base) > 0.15) bad.push(w);
      }
      return {
        pass: bad.length === 0,
        got: Object.keys(Prow)
          .map((w) => `${w} ${f3(keep(w))}`)
          .join('; '),
        want: 'invisible >= normal+0.1; others within 0.15 of normal',
        cells: bad,
      };
    },
  },
  {
    id: 'E06',
    source: 'msa',
    cite: C('region'),
    claim: 'One indoor ambient: unlit indoor floor in the split rows reads like the lamp rows (illum within 0.01).',
    lights: ['pool', 'sun'],
    walls: ALL,
    scope: 'scene',
    check: (all) => {
      const base = median(ALL.map((w) => illumOf(all[`${w}/lampNear`]?.ref)));
      const bad = [];
      for (const k of ['pool', 'sun']) {
        for (const w of ALL) {
          const v = illumOf(all[`${w}/${k}`]?.ref);
          if (Number.isFinite(v) && Math.abs(v - base) > 0.01) bad.push(`${w}/${k}`);
        }
      }
      return {
        pass: bad.length === 0,
        got: bad.length ? bad.join(', ') : `all near ${f3(base)}`,
        want: `illum within 0.01 of ${f3(base)}`,
        cells: bad,
      };
    },
  },
  {
    id: 'E07',
    source: 'physics',
    cite: 'the same open ground under the same sun',
    claim: 'Open ground in the pool row reads like the sun row (+-3%).',
    lights: ['pool'],
    walls: ALL,
    scope: 'scene',
    check: (all) => {
      const bad = [];
      for (const w of ALL) {
        const a = illumOf(all[`${w}/pool`]?.out);
        const b = illumOf(all[`${w}/sun`]?.out);
        if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a / b - 1) > 0.03) bad.push(`${w}/pool`);
      }
      return { pass: bad.length === 0, got: bad.length ? bad.join(', ') : 'all within', want: 'within 3%', cells: bad };
    },
  },

  {
    id: 'E08',
    source: 'msa',
    cite: 'guide/pages/mask-window.md "Keep patches inside the building, on the black of _Outdoors. Window light out on the street is wasted."',
    claim:
      "Window light is not drawn on white _Outdoors: 15 px outside, where the painted pool's soft edge still spills (~25%), reads like the sun row (illum +-5%).",
    lights: ['pool'],
    walls: ALL,
    scope: 'scene',
    check: (all) => {
      const bad = [];
      const q = (w) => illumOf(all[`${w}/pool`]?.spill) / illumOf(all[`${w}/sun`]?.spill);
      for (const w of ALL) if (Number.isFinite(q(w)) && Math.abs(q(w) - 1) > 0.05) bad.push(w);
      return {
        pass: bad.length === 0,
        got: bad.length ? bad.map((w) => `${w} ${f3(q(w))}`).join('; ') : `all within (e.g. normal ${f3(q('normal'))})`,
        want: 'pool.spill / sun.spill illum within 5%',
        cells: bad.map((w) => `${w}/pool`),
      };
    },
  },

  // ------------------------------------------------------------------ F: sun only at noon
  {
    id: 'F01',
    source: 'author',
    cite: 'rants 2026-11-08 "It\'s obviously not considered indoors if it\'s not black on the _Outdoors mask"; indoors = black _Outdoors + Region',
    claim:
      'No sun gets through any wall type into the indoor half without a _Windows mask (behind the feature = unlit floor).',
    lights: ['sun'],
    walls: ALL,
    check: (P) => isDark(P, 'beh'),
  },
  {
    id: 'F02',
    source: 'msa',
    cite: 'msa-lab memory: noon daylight illum 0.922 / 0.933 / 0.966',
    claim: 'Open ground at noon reads full daylight (illum >= 0.85).',
    lights: ['sun', 'pool'],
    walls: ALL,
    check: (P) => {
      const v = illumOf(P.out);
      return res(v >= 0.85, `out illum ${f3(v)}`, '>=0.85');
    },
  },
  {
    id: 'F03',
    source: 'physics',
    cite: 'the same open ground under the same sun',
    claim: 'Open ground reads the same in all 14 columns (within 3%).',
    lights: ['sun'],
    walls: ALL,
    scope: 'row',
    check: (Prow) => consistentAcross(Prow, ['out'], 0.03, illumOf),
  },
  {
    id: 'F04',
    source: 'physics',
    cite: 'the outdoor side of a wall does not depend on what the wall segment is',
    claim: 'Outdoors, beside the feature segment and beside the normal end read alike (+-5%).',
    lights: ['sun'],
    walls: ALL,
    check: (P) => {
      const q = illumOf(P.lit) / Math.max(illumOf(P.litEnd), 1e-6);
      return res(Math.abs(q - 1) <= 0.05, `lit/litEnd ${f3(q)}`, '0.95..1.05');
    },
  },
  {
    id: 'F05',
    source: 'msa',
    cite: 'mmp-78u.11: the halo round indoor blocks is the building shadow blur (soft, not a hard shadow)',
    claim: 'Outdoors 45 px from the building keeps most of the daylight (illum >= 0.6 of open ground).',
    lights: ['sun'],
    walls: ALL,
    check: (P) => {
      const q = illumOf(P.lit) / Math.max(illumOf(P.out), 1e-6);
      return res(q >= 0.6, `lit/out illum ${f3(q)}`, '>=0.6');
    },
  },
  {
    id: 'F06',
    source: 'physics',
    cite: 'indoors beside a normal end there is nothing to light it',
    claim: 'Indoors behind the normal end: unlit floor.',
    lights: ['sun'],
    walls: ALL,
    check: (P) => isDark(P, 'behEnd'),
  },
];

/** Counts by source, for the report. */
export function claimSourceCounts(claims = WALLS_CLAIMS) {
  return claims.reduce((m, c) => ((m[c.source] = (m[c.source] ?? 0) + 1), m), {});
}

/** The cells a set of claims needs, each with its points (the light kind's whole set: every point is some claim's). */
export function wallsCheckCells(claims = WALLS_CLAIMS, { walls = null, lights = null } = {}) {
  const keys = new Set();
  for (const c of claims) for (const l of c.lights) for (const w of c.walls) keys.add(`${w}/${l}`);
  // scene-scope claims read other rows too (E04/E07 read sun, E06 reads lampNear)
  for (const c of claims) {
    if (c.scope !== 'scene') continue;
    for (const w of c.walls) for (const l of ['sun', 'lampNear', 'pool']) keys.add(`${w}/${l}`);
  }
  const out = [];
  LIGHT_KINDS.forEach((k) => {
    WALL_TYPES.forEach((t) => {
      const key = `${t.key}/${k.key}`;
      if (!keys.has(key)) return;
      if (walls && !walls.includes(t.key)) return;
      if (lights && !lights.includes(k.key)) return;
      out.push(wallsCellPoints(t.key, k.key));
    });
  });
  return out;
}

/**
 * Evaluate every claim on probe data. `data[cellKey][pointName]` = a probe row (`onScreen` false or a
 * missing row makes a claim SKIP rather than read garbage — off-screen probe buffers are nonsense).
 * @returns {Array<{id:string, cell:string, pass:boolean|null, got:string, want:string, known:string|null}>}
 */
export function evaluateWallsClaims(rawData, view, claims = WALLS_CLAIMS) {
  const out = [];
  const data = Object.fromEntries(Object.entries(rawData).map(([k, P]) => [k, foldPatches(P)]));
  const usable = (P) => P && Object.values(P).every((r) => r && r.onScreen);
  for (const c of claims) {
    if (c.views && !c.views.includes(view)) continue;
    const base = { id: c.id, source: c.source, known: c.known ?? null };
    if (c.untestable) {
      // Measured and kept as evidence, but no verdict: the layout cannot exercise what the claim is about.
      out.push(
        ...evaluateWallsClaims(rawData, view, [{ ...c, untestable: null }]).map((r) => ({
          ...r,
          pass: null,
          untestable: true,
          got: `NOT TESTABLE (${c.untestable}); measured: ${r.got}`,
        }))
      );
      continue;
    }
    if (!c.scope || c.scope === 'cell') {
      for (const l of c.lights) {
        for (const w of c.walls) {
          const cell = `${w}/${l}`;
          const P = data[cell];
          if (!P) continue;
          if (!usable(P)) {
            const off = Object.entries(P)
              .filter(([, r]) => !r?.onScreen)
              .map(([n]) => n);
            out.push({ ...base, cell, pass: null, got: `off-screen: ${off.join(',')}`, want: '' });
            continue;
          }
          let r;
          try {
            r = c.check(P);
          } catch (err) {
            r = { pass: false, got: `check threw: ${err.message}`, want: '' };
          }
          out.push({ ...base, cell, ...r });
        }
      }
    } else if (c.scope === 'row') {
      for (const l of c.lights) {
        const Prow = {};
        for (const w of c.walls) if (usable(data[`${w}/${l}`])) Prow[w] = data[`${w}/${l}`];
        if (!Object.keys(Prow).length) continue;
        const r = c.check(Prow);
        out.push({
          ...base,
          cell: `*/${l}`,
          pass: r.pass,
          got: r.got,
          want: r.want,
          cells: (r.cells ?? []).map((w) => `${w}/${l}`),
        });
      }
    } else {
      const all = {};
      for (const [k, P] of Object.entries(data)) if (usable(P)) all[k] = P;
      const r = c.check(all);
      out.push({ ...base, cell: '*', pass: r.pass, got: r.got, want: r.want, cells: r.cells ?? [] });
    }
  }
  return out;
}
