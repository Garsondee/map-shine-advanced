/**
 * LAMP REFLECTIONS (2026-11-04) — the author: "A light can be directly above a
 * bit of metal and doesn't seem to brighten it directly downwards."
 *
 * Proves, on the CPU twin of the shader's lamp loop (`specular-lamps.js`):
 *   1. the OLD indoor key (a guessed direction at LAMP_ELEVATION_Z) gave flat
 *      metal straight under a lamp ~0.2% of a highlight — the bug, measured;
 *   2. the new lobe is at its maximum straight under the lamp, nudged toward
 *      the eye by exactly the mirror geometry, and falls to half where
 *      `lampLobeExponent` says;
 *   3. a dome flank FACING the lamp catches more than one facing away;
 *   4. the table: empty slots are inert (no NaN, no weight), nearest lamps win,
 *      a lamp out of reach of the view is left out, and an unchanged frame
 *      reports no change (no re-upload);
 *   5. the material builds with and without the table, its setters reach the
 *      packed uniform, and the source keeps the proven-safe loop shape.
 *
 * Run by ./run-tests.mjs.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from '../../../../src/vendor/three/three.webgpu.js';
import { buildWorldSpaceOutdoorsGate } from '../../lighting/environmental-light.js';
import { SPECULAR_PARAMS } from '../specular.js';
import {
  buildSpecularSurfaceMaterial,
  SPECULAR_DEFAULT_LAMP_HIGHLIGHT,
  SPECULAR_DEFAULT_LAMP_SIZE,
} from '../specular-render.js';
import {
  SPECULAR_LAMP_MAX,
  SPECULAR_LAMP_TABLE_WIDTH,
  SPECULAR_LAMP_HEIGHT_GRID,
  createSpecularLampTable,
  packSpecularLamps,
  lampLobeExponent,
  lampFalloff,
  lampReflectionAt,
} from '../specular-lamps.js';

const UP = { x: 0, y: 0, z: 1 };
const norm = (v) => {
  const l = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};

function stubTexture(bytes = [0, 0, 0, 255]) {
  const t = new THREE.DataTexture(new Uint8Array(bytes), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

function build(extra = {}) {
  const { uniform, vec4, texture } = THREE.TSL;
  return buildSpecularSurfaceMaterial({
    THREE,
    maskTexture: stubTexture([200, 160, 60, 255]),
    islandPackTexture: stubTexture([128, 128, 0, 0]),
    illumTexture: stubTexture([200, 200, 200, 255]),
    shapeTexture: stubTexture([128, 128, 0, 128]),
    uViewRect: uniform(vec4(0, 0, 1000, 1000)),
    uOutdoorsRect: uniform(vec4(0, 0, 1000, 1000)),
    outdoorsTexNode: texture(stubTexture()),
    buildOutdoorsGate: buildWorldSpaceOutdoorsGate,
    timeMsNode: uniform(0),
    ...extra,
  });
}

/** @param {*} t */
export async function run(t) {
  // ── 1. THE BUG, MEASURED ────────────────────────────────────────────────
  // The old camera highlight indoors: key at elevation z 0.85 (render file's
  // LAMP_ELEVATION_Z), direction from the light buffer's slope — which is ZERO
  // under a lamp, so it fell back to the fixed top-left default. Shininess 160.
  {
    const keyZ = 0.85;
    const s = Math.sqrt(1 - keyZ * keyZ);
    const key = norm({ x: -0.6 * s, y: -0.8 * s, z: keyZ });
    const h = norm({ x: key.x, y: key.y, z: key.z + 1 }); // eye overhead
    const old = Math.pow(h.z, 160);
    t.ok(`old guessed key: flat metal under a lamp got ${old.toFixed(4)} of a highlight (< 1%)`, old < 0.01);
  }

  // ── 2. THE NEW LOBE: brightest straight under the lamp ──────────────────
  const grid = 150;
  const height = grid * SPECULAR_LAMP_HEIGHT_GRID;
  const table = createSpecularLampTable();
  const lamp = { x: 1000, y: 1000, radius: 600, ratio: 0.5, luminosity01: 0.5 };
  const view = { minX: 0, minY: 0, maxX: 2000, maxY: 2000 };
  t.ok('pack reports a change on first fill', packSpecularLamps([lamp], view, { gridSizePx: grid, table }) === true);
  t.ok('one lamp packed', table.count === 1);
  t.ok('lamp height = grid × SPECULAR_LAMP_HEIGHT_GRID', table.data[4] === height);
  t.ok('reach = Foundry dim radius, bright = radius × ratio', table.data[2] === 600 && table.data[3] === 300);

  const n = lampLobeExponent(SPECULAR_DEFAULT_LAMP_SIZE);
  // Eye straight above the lamp: the lobe is exactly 1 at the lamp's foot.
  const eyeOver = { x: 1000, y: 1000, z: 2000 };
  const under = lampReflectionAt({ x: 1000, y: 1000 }, UP, eyeOver, table.data, n);
  t.ok(`flat metal straight under the lamp: align ${under.align.toFixed(3)} ≈ 1`, under.align > 0.999);
  t.ok('…and fully inside its reach', under.presence > 0.999);

  // Monotone fall-off away from the foot, along a line through it.
  let prev = Infinity;
  let mono = true;
  for (let d = 0; d <= 500; d += 25) {
    const a = lampReflectionAt({ x: 1000 + d, y: 1000 }, UP, eyeOver, table.data, n).align;
    if (a > prev + 1e-9) mono = false;
    prev = a;
  }
  t.ok('the reflection only fades moving away from straight-under', mono);

  // HALF POWER at size × height (eye far overhead, so the eye's own tilt is negligible).
  const eyeFar = { x: 1000, y: 1000, z: 1e7 };
  const half = lampReflectionAt(
    { x: 1000 + SPECULAR_DEFAULT_LAMP_SIZE * height, y: 1000 },
    UP,
    eyeFar,
    table.data,
    n
  ).align;
  t.ok(`half power at lampSize × height: ${half.toFixed(3)} ≈ 0.5`, Math.abs(half - 0.5) < 0.02);

  // MIRROR GEOMETRY: with the eye off to one side, the peak moves from the
  // lamp's foot TOWARD the eye's foot by h_l·dE/(h_l + h_e) — not away, not
  // anywhere else.
  {
    const eye = { x: 1600, y: 1000, z: 1500 };
    let best = -1;
    let bestX = 0;
    for (let x = 900; x <= 1200; x += 1) {
      const a = lampReflectionAt({ x, y: 1000 }, UP, eye, table.data, n).align;
      if (a > best) {
        best = a;
        bestX = x;
      }
    }
    const expect = 1000 + (height * 600) / (height + 1500);
    t.ok(
      `peak sits between lamp and eye at the mirror point (${bestX} vs ${expect.toFixed(1)})`,
      Math.abs(bestX - expect) <= 1.5
    );
    t.ok('…where it reaches ~1', best > 0.999);
  }

  // ── 3. FORM: the flank facing the lamp catches it ───────────────────────
  {
    const p = { x: 1150, y: 1000 }; // 150 px east of the lamp
    const towardLamp = norm({ x: -0.5, y: 0, z: 1 }); // tilted to face west (the lamp)
    const away = norm({ x: 0.5, y: 0, z: 1 });
    const a = lampReflectionAt(p, towardLamp, eyeOver, table.data, n).align;
    const b = lampReflectionAt(p, away, eyeOver, table.data, n).align;
    t.ok(`a flank facing the lamp (${a.toFixed(3)}) outshines one facing away (${b.toFixed(3)})`, a > 4 * b);
  }

  // ── 4. THE TABLE ────────────────────────────────────────────────────────
  t.ok(
    'an unchanged frame re-packs as unchanged',
    packSpecularLamps([lamp], view, { gridSizePx: grid, table }) === false
  );
  {
    const empty = createSpecularLampTable();
    const r = lampReflectionAt({ x: 0, y: 0 }, UP, eyeOver, empty.data, n);
    t.ok('an empty table: no NaN, align 0, presence 0', r.align === 0 && r.presence === 0);
    t.ok('falloff of an empty slot is 0', lampFalloff(0, 0, 0) === 0);
    t.ok(
      'falloff is 1 inside the bright radius and 0 at the dim one',
      lampFalloff(100, 600, 300) === 1 && lampFalloff(600, 600, 300) === 0
    );
  }
  {
    const many = [];
    for (let i = 0; i < SPECULAR_LAMP_MAX + 10; i++) many.push({ x: 1000 + i * 40, y: 1000, radius: 100, ratio: 0.5 });
    many.push({ x: 9000, y: 9000, radius: 300, ratio: 0.5 }); // far out of view: never packed
    const tb = createSpecularLampTable();
    packSpecularLamps(many, view, { gridSizePx: grid, table: tb });
    t.ok(`at most SPECULAR_LAMP_MAX (${SPECULAR_LAMP_MAX}) lamps`, tb.count === SPECULAR_LAMP_MAX);
    t.ok('nearest to the view centre first', tb.data[0] === 1000);
    let farIn = false;
    for (let k = 0; k < SPECULAR_LAMP_MAX; k++) if (tb.data[k * 8] === 9000) farIn = true;
    t.ok('a lamp out of reach of the view is left out', !farIn);
    // Shrink to one lamp: the slots it vacated read as empty again.
    packSpecularLamps([lamp], view, { gridSizePx: grid, table: tb });
    let clean = true;
    for (let i = 8; i < tb.data.length; i++) if (tb.data[i] !== 0) clean = false;
    t.ok('vacated slots are zeroed (reach 0, weight 0)', clean && tb.count === 1);
  }
  t.ok('table width = 2 texels per lamp', SPECULAR_LAMP_TABLE_WIDTH === SPECULAR_LAMP_MAX * 2);
  t.ok(
    'size 0.25 is tighter than 0.5 is tighter than 1',
    lampLobeExponent(0.25) > lampLobeExponent(0.5) && lampLobeExponent(0.5) > lampLobeExponent(1)
  );

  // ── 5. THE MATERIAL ─────────────────────────────────────────────────────
  {
    const tex = new THREE.DataTexture(table.data, SPECULAR_LAMP_TABLE_WIDTH, 1, THREE.RGBAFormat, THREE.FloatType);
    const withLamps = build({ lampTexture: tex });
    const without = build();
    t.ok('with a lamp table the build reports lamps enabled', withLamps.lampsEnabled === true);
    t.ok('without one, lamps compile out', without.lampsEnabled === false);
    t.ok(
      'setLampHighlight / setLampSize exist',
      typeof withLamps.setLampHighlight === 'function' && typeof withLamps.setLampSize === 'function'
    );
    // Setters must not throw on the compiled-out build either (the card pushes to every build).
    let ok = true;
    try {
      without.setLampHighlight(2);
      without.setLampSize(1);
      withLamps.setLampHighlight(0);
      withLamps.setLampSize(0.25);
    } catch (_) {
      ok = false;
    }
    t.ok('lamp setters are safe on both builds', ok);
  }
  t.ok(
    'card default lampHighlight matches the render default',
    SPECULAR_PARAMS.lampHighlight.default === SPECULAR_DEFAULT_LAMP_HIGHLIGHT
  );
  t.ok(
    'card default lampSize matches the render default',
    SPECULAR_PARAMS.lampSize.default === SPECULAR_DEFAULT_LAMP_SIZE
  );

  const src = readFileSync(fileURLToPath(new URL('../specular-render.js', import.meta.url)), 'utf8');
  const code = src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
  t.ok(
    'the lamp loop is a fixed-count TSL Loop over SPECULAR_LAMP_MAX',
    /Loop\(\{ start: int\(0\), end: int\(SPECULAR_LAMP_MAX\)/.test(code)
  );
  t.ok('the table is read texel-exact through one texture node', code.includes('lampTexNode.load(ivec2('));
  t.ok('no uniformArray (the landmine shape)', !code.includes('uniformArray'));
  const uniforms = (code.match(/\buniform\(/g) || []).length;
  t.ok(`specular-render.js stays within the 40-uniform cap (${uniforms})`, uniforms <= 40);
}
