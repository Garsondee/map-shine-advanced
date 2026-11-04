/**
 * specular-pan.test.mjs — ROUND 2 of the metal work (2026-11-02, mmp-9nb):
 * metal that is ALIVE in a camera pan. Author: *"make metal look more
 * interesting/dynamic/animated during camera pans… change the way that we
 * generate highlight areas."*
 *
 * Pinned here:
 *   1. The shape bake's geometry: slopes point the right way round a painted
 *      disc, an ink ring inside bright paint is CLOSED (it made a bullseye in the
 *      lab), flat paint has no slope, and a floor-sized mask bakes small.
 *   2. The pan easing: rises at once, settles over PAN_RELEASE_SEC, ignores
 *      teleports, never reads a clock of its own.
 *   3. The eye: metal's eye height is water's, so a pan moves both surfaces'
 *      highlights by one geometry.
 *   4. The material compiles the shape path when given a shape map (and only
 *      then, and never below the shimmer tier), and a swap reaches the node.
 *   5. The five new controls flow through the schema and BOTH subsystems.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from '../../../../src/vendor/three/three.webgpu.js';
import { buildWorldSpaceOutdoorsGate } from '../../lighting/environmental-light.js';
import { CATEGORY_ORDER } from '../../../ui/widgets/param-groups.js';
import { WATER_TIER3_VIEWER_HEIGHT } from '../../water/water-light.js';
import { SPECULAR_PARAMS } from '../specular.js';
import {
  buildSpecularSurfaceMaterial,
  SPECULAR_EYE_HEIGHT,
  SPECULAR_DEFAULT_CAMERA_GLINT,
  SPECULAR_DEFAULT_REFLECTION_BEND,
  SPECULAR_DEFAULT_SPARKLE,
  SPECULAR_DEFAULT_SPARKLE_SIZE_PX,
  SPECULAR_DEFAULT_PAN_FLARE,
} from '../specular-render.js';
import { buildSpecularShapeMap, SHAPE_MAX_SIDE } from '../specular-shape.js';
import { easePanMotion, PAN_RELEASE_SEC, PAN_TELEPORT_VIEWS } from '../specular-material.js';

const NEW_PARAMS = {
  cameraGlint: SPECULAR_DEFAULT_CAMERA_GLINT,
  reflectionBend: SPECULAR_DEFAULT_REFLECTION_BEND,
  sparkle: SPECULAR_DEFAULT_SPARKLE,
  sparkleSizePx: SPECULAR_DEFAULT_SPARKLE_SIZE_PX,
  panFlare: SPECULAR_DEFAULT_PAN_FLARE,
};

function stubTexture(bytes = [0, 0, 0, 255]) {
  const t = new THREE.DataTexture(new Uint8Array(bytes), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

/** A square RGBA mask painted by `paint(x, y) → 0..255`. */
function mask(n, paint) {
  const rgba = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const v = paint(x, y);
      const o = (y * n + x) * 4;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
      rgba[o + 3] = 255;
    }
  return { rgba, width: n, height: n };
}

/** Decoded slope (mask axes) at a MASK pixel. */
function slopeAt(m, x, y) {
  const sx = Math.min(m.w - 1, Math.round(x * m.scale));
  const sy = Math.min(m.h - 1, Math.round(y * m.scale));
  const o = (sy * m.w + sx) * 4;
  return [(m.data[o] / 255 - 0.5) * 2, (m.data[o + 1] / 255 - 0.5) * 2];
}

export function run(t) {
  const { ok } = t;

  // ── 1. THE SHAPE BAKE ────────────────────────────────────────────────────
  const disc = buildSpecularShapeMap(mask(400, (x, y) => (Math.hypot(x - 200, y - 200) < 120 ? 220 : 0)));
  const right = slopeAt(disc, 320, 200);
  const left = slopeAt(disc, 80, 200);
  const bottom = slopeAt(disc, 200, 320);
  // Height FALLS outward, so the stored gradient points inward and the shader's
  // normal (−s) points outward — the rim faces away from the disc's middle.
  ok('disc: the right rim slopes down to the right (gradient −x)', right[0] < -0.2 && Math.abs(right[1]) < 0.05);
  ok('disc: the left rim mirrors it (gradient +x)', left[0] > 0.2 && Math.abs(left[1]) < 0.05);
  ok('disc: the bottom rim slopes down toward +y', bottom[1] < -0.2 && Math.abs(bottom[0]) < 0.05);
  const crown = slopeAt(disc, 200, 200);
  ok('disc: the crown is flat', Math.abs(crown[0]) < 0.03 && Math.abs(crown[1]) < 0.03);

  // An author's small dark ink RING inside bright paint is drawing, not a pit.
  // Proportions of the case that showed it (Bank T07's dome: a 1125 px mask,
  // downsampled ~3x, a ~12 px ink circle inside a big bright dome).
  const inked = buildSpecularShapeMap(
    mask(1200, (x, y) => {
      const d = Math.hypot(x - 600, y - 600);
      if (d >= 450) return 0;
      return d > 34 && d < 46 ? 30 : 220; // a 12 px ink ring of radius 40
    })
  );
  let ringSlope = 0;
  for (const r of [50, 60, 70]) {
    const s2 = slopeAt(inked, 600 + r, 600);
    ringSlope = Math.max(ringSlope, Math.hypot(s2[0], s2[1]));
  }
  ok(
    `an ink ring inside bright paint is closed — no crater slopes around it (the lab bullseye; ${ringSlope.toFixed(3)})`,
    ringSlope < 0.06
  );

  const flat = buildSpecularShapeMap(mask(64, () => 200));
  let flatMax = 0;
  for (let i = 0; i < flat.data.length; i += 4) {
    flatMax = Math.max(flatMax, Math.abs(flat.data[i] - 128), Math.abs(flat.data[i + 1] - 128));
  }
  ok('evenly painted metal has no slope anywhere', flatMax <= 1);

  const big = buildSpecularShapeMap({ rgba: new Uint8Array(4000 * 2000 * 4), width: 4000, height: 2000 });
  ok('a floor-sized mask bakes SMALL (longest side capped)', Math.max(big.w, big.h) <= SHAPE_MAX_SIDE);
  ok('…and keeps its aspect', Math.abs(big.w / big.h - 2) < 0.05);

  // ── 2. THE PAN EASING ────────────────────────────────────────────────────
  let s = easePanMotion(null, { cx: 0, cy: 0, viewSpan: 1000, tMs: 0 });
  ok('first frame: no flare', s.amount === 0);
  s = easePanMotion(s, { cx: 1000, cy: 0, viewSpan: 1000, tMs: 500 }); // 2 views/s
  ok('a brisk pan reaches full flare at once', s.amount === 1);
  ok('…and remembers its direction', s.dirX === 1 && s.dirY === 0);
  s = easePanMotion(s, { cx: 1000, cy: 0, viewSpan: 1000, tMs: 500 + PAN_RELEASE_SEC * 1000 });
  ok('after stopping it settles by 1/e over PAN_RELEASE_SEC', Math.abs(s.amount - Math.exp(-1)) < 1e-6);
  ok('…keeping the last direction while it settles', s.dirX === 1);
  const jump = easePanMotion(
    { cx: 0, cy: 0, tMs: 0, dirX: 1, dirY: 0, amount: 0.5 },
    { cx: 1000 * (PAN_TELEPORT_VIEWS + 1), cy: 0, viewSpan: 1000, tMs: 16 }
  );
  ok('a teleport (scene change, jump to token) does not flash the metal', jump.amount === 0);
  const noClock = easePanMotion(
    { cx: 0, cy: 0, tMs: 0, dirX: 1, dirY: 0, amount: 0.4 },
    { cx: 5, cy: 0, viewSpan: 1000, tMs: NaN }
  );
  ok('no shared clock value → no flare, never a guess', noClock.amount === 0);
  const src = readFileSync(fileURLToPath(new URL('../specular-material.js', import.meta.url)), 'utf8');
  ok('the easing reads no clock of its own (time/one-clock)', !/performance\.now|Date\.now/.test(src));

  // ── 3. ONE EYE FOR METAL AND WATER ───────────────────────────────────────
  ok('metal and water share one eye height', SPECULAR_EYE_HEIGHT === WATER_TIER3_VIEWER_HEIGHT);

  // ── 4. THE MATERIAL ──────────────────────────────────────────────────────
  const { uniform, vec4, float } = THREE.TSL;
  const args = (extra = {}) => ({
    THREE,
    maskTexture: stubTexture(),
    islandPackTexture: stubTexture(),
    illumTexture: stubTexture(),
    depthTexture: stubTexture(),
    timeMsNode: uniform(float(0)),
    uViewRect: uniform(vec4(0, 0, 100, 100)),
    uOutdoorsRect: uniform(vec4(0, 0, 100, 100)),
    outdoorsTexNode: THREE.TSL.texture(stubTexture()),
    buildOutdoorsGate: buildWorldSpaceOutdoorsGate,
    ...extra,
  });
  let built = null;
  let err = null;
  try {
    built = buildSpecularSurfaceMaterial(args({ shapeTexture: stubTexture([128, 128, 0, 128]) }));
  } catch (e) {
    err = e;
  }
  ok(`the material builds WITH a shape map (${err ? err.message : 'clean'})`, err === null);
  if (!built) return;
  ok('…and compiles the shape path', built.shapeEnabled === true);
  ok('no shape map → the shape path compiles out', buildSpecularSurfaceMaterial(args()).shapeEnabled === false);
  ok(
    'tier 0 → compiled out even with a shape map',
    buildSpecularSurfaceMaterial(args({ shapeTexture: stubTexture(), tier: 0 })).shapeEnabled === false
  );
  for (const key of [...Object.keys(NEW_PARAMS), 'shapeTexture', 'panMotion']) {
    const setter = `set${key[0].toUpperCase()}${key.slice(1)}`;
    ok(`the material exposes ${setter}`, typeof built[setter] === 'function');
  }
  let threw = false;
  try {
    built.setPanMotion({ dirX: 0, dirY: 0, amount: 9 });
    built.setPanMotion(null);
    built.setSparkleSizePx(-4);
    built.setPanFlare(7);
    built.setSunDir(0, 1, 0.9);
    built.setSunDir(1, 0);
  } catch {
    threw = true;
  }
  ok('the new setters tolerate odd input without throwing', !threw);

  // ── 5. THE CONTROLS, END TO END ──────────────────────────────────────────
  for (const [key, renderDefault] of Object.entries(NEW_PARAMS)) {
    const p = SPECULAR_PARAMS[key];
    ok(`${key}: declared`, !!p);
    if (!p) continue;
    ok(`${key}: schema default equals the render default`, p.default === renderDefault);
    ok(`${key}: default inside its range`, p.min <= p.default && p.default <= p.max);
    ok(`${key}: a real Studio group`, CATEGORY_ORDER.includes(p.category));
  }
  for (const file of ['specular-surface-subsystem.js', 'specular-tile-surface-subsystem.js']) {
    const text = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
    for (const key of Object.keys(NEW_PARAMS)) {
      ok(`${file}: ${key} is in the params cache key`, new RegExp(`^\\s*p\\.${key},\\s*$`, 'm').test(text));
      ok(`${file}: ${key} is pushed`, text.includes(`set${key[0].toUpperCase()}${key.slice(1)}(p.${key})`));
    }
    ok(`${file}: bakes the shape map`, text.includes('buildSpecularShapeMap('));
    ok(`${file}: pushes the eased pan motion`, text.includes('easePanMotion(panMotion'));
    ok(`${file}: passes the sun's elevation`, text.includes('setSunDir(dir[0], dir[1], dir[2])'));
  }

  // ── 6. NO BULLSEYES (2026-11-04, Big Bank underground) ───────────────────
  // Round 2 scaled each layer's parallax by `1 + 1.2·|slope|`. On a small round
  // island (an inlay diamond blurs into a dome) |slope| depends on radius only,
  // so every pixel at one radius read one pattern point: concentric rings on
  // every inlay, more of them the further the camera sat from the map origin
  // (the parallax is the absolute view centre). Lab proof: rings vanish with
  // bend OR parallax off, and with this term removed. The pattern lookup may
  // move by the slope VECTOR (bendOffset), never by a scalar of it.
  const render = readFileSync(fileURLToPath(new URL('../specular-render.js', import.meta.url)), 'utf8');
  const layerLine = render.split('\n').find((l) => /const p = worldUv\.sub\(parallaxBase/.test(l)) || '';
  ok('the shimmer layer lookup is found', layerLine.length > 0);
  ok(
    'the layer parallax is not scaled per pixel (a scalar of the slope draws rings)',
    /parallaxBase\.mul\(L\.uParallaxDepth\)\)/.test(layerLine)
  );
  ok(
    'no |slope| feeds the pattern position anywhere (length(shapeSlopeW) is never a pattern-space term)',
    !/length\(shapeSlopeW\)/.test(render)
  );
}
