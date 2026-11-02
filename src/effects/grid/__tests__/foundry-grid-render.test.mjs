/**
 * foundry-grid-render.test.mjs — Foundry's grid and outline, ported to TSL: every built-in grid type ×
 * style CONSTRUCTS (`keyhole-tsl-constructs-in-node`), through the real present material it is folded
 * into, which rebuilds only when the grid's shape changes; the uniforms carry exactly what Foundry's
 * `GridShader#_preRender` would; and the lens warp follows `post.lens` on and off.
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import {
  FOUNDRY_GRID_TYPES as T,
  FOUNDRY_GRID_STYLES as S,
  foundryGridShapeKey,
  createFoundryGridUniforms,
  writeFoundryGridUniforms,
  buildFoundryGridAlpha,
  buildSceneOutlineAlpha,
  compositeFoundryOverlay,
} from '../foundry-grid-render.js';
import { buildGradePresentMaterial } from '../../grade/grade-present.js';
import { lensWarpUv } from '../../lens-render.js';

// The present rebuilds lazily (grade-present.js `rebuildFragment` marks it stale, `flushRebuild` builds once, right
// before the draw), so "did it rebuild?" is asked of the node the next draw would use.
const nodeOf = (g) => {
  g.flushRebuild?.();
  return g.material.fragmentNode;
};

function stubTexture() {
  const tex = new THREE.DataTexture(new Uint8Array([0, 128, 128, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.needsUpdate = true;
  return tex;
}

const grid = (over = {}) => ({
  type: T.SQUARE,
  style: S.LINE_SOLID,
  sizePx: 100,
  thicknessPx: 2,
  color: [0.2, 0.4, 0.6],
  alpha: 0.5,
  mesh: { x: 0, y: 0, width: 6000, height: 4000 },
  ...over,
});
const outline = {
  canvasRect: { x: 0, y: 0, width: 6000, height: 4000 },
  sceneRect: { x: 1000, y: 800, width: 4000, height: 2400 },
  widthPx: 4,
  canvasAlpha: 0.75,
  sceneAlpha: 0.25,
};

export function run(t) {
  const { ok } = t;
  const TSL = THREE.TSL;

  // ── SHAPE KEYS ──────────────────────────────────────────────────────────
  ok('gridless has no shape (nothing to draw)', foundryGridShapeKey(T.GRIDLESS, S.LINE_SOLID) === null);
  ok('an unknown type has no shape', foundryGridShapeKey(9, S.LINE_SOLID) === null);
  ok('an unknown style has no shape (left to Foundry)', foundryGridShapeKey(T.SQUARE, 6) === null);
  ok('square solid is a shape', foundryGridShapeKey(T.SQUARE, S.LINE_SOLID) === '1:0');

  // ── EVERY TYPE × STYLE CONSTRUCTS ───────────────────────────────────────
  const u = createFoundryGridUniforms(TSL);
  const failures = [];
  for (const type of [T.SQUARE, T.HEXODDR, T.HEXEVENR, T.HEXODDQ, T.HEXEVENQ]) {
    for (const style of Object.values(S)) {
      try {
        const a = buildFoundryGridAlpha(TSL, { canvasXY: TSL.vec2(123.4, 567.8), u, type, style });
        if (!a?.isNode) failures.push(`${type}:${style} returned no node`);
      } catch (e) {
        failures.push(`${type}:${style} threw ${e.message}`);
      }
    }
  }
  ok(`⭐ all 5 grid types × 6 styles construct (${failures.join('; ') || 'clean'})`, failures.length === 0);
  ok('the outline constructs', !!buildSceneOutlineAlpha(TSL, { canvasXY: TSL.vec2(10, 10), u })?.isNode);
  const lin = TSL.vec3(0.5, 0.5, 0.5);
  ok(
    'neither layer ⇒ the colour node comes back untouched by any blend',
    compositeFoundryOverlay(TSL, lin, { gridAlpha: null, outlineAlpha: null, u }) !== null
  );

  // ── UNIFORMS = FOUNDRY'S _preRender ─────────────────────────────────────
  writeFoundryGridUniforms(u, { grid: grid(), outline, pxPerCanvas: 0.75 });
  ok('thickness is in GRID units (thickness / size)', Math.abs(u.thickness.value - 0.02) < 1e-9);
  ok('resolution = output px per canvas px × size', Math.abs(u.resolution.value - 75) < 1e-9);
  ok('colour and alpha are passed through', u.color.value.y === 0.4 && u.alpha.value === 0.5);
  ok(
    "the clip defaults to the grid mesh's own rect (Foundry's masks.canvas)",
    u.clip.value.x === 0 && u.clip.value.z === 6000 && u.clip.value.w === 4000
  );
  ok('no plane ⇒ unscaled (0, 0, 1)', u.plane.value.z === 1 && u.plane.value.x === 0);
  ok(
    'the outline rects are min/max',
    u.outlineScene.value.x === 1000 && u.outlineScene.value.z === 5000 && u.outlineScene.value.w === 3200
  );
  ok('the outline alphas', u.outlineAlpha.value.x === 0.75 && u.outlineAlpha.value.y === 0.25);
  writeFoundryGridUniforms(u, {
    grid: grid(),
    outline: null,
    pxPerCanvas: 1,
    clip: { minX: 1000, minY: 800, maxX: 5000, maxY: 3200 },
    plane: { x: 3000, y: 2000, scale: 0.8 },
  });
  ok('a clip override (the Table keeps lines on the board)', u.clip.value.x === 1000 && u.clip.value.w === 3200);
  ok('a Parallax plane is carried', u.plane.value.x === 3000 && Math.abs(u.plane.value.z - 0.8) < 1e-9);
  ok('no outline ⇒ its alphas are zero', u.outlineAlpha.value.x === 0 && u.outlineAlpha.value.y === 0);
  writeFoundryGridUniforms(u, { grid: null, outline: null, pxPerCanvas: 1 });
  ok('no grid ⇒ its alpha is zero', u.alpha.value === 0);

  // ── THROUGH THE REAL PRESENT ────────────────────────────────────────────
  const { uniform, vec4, texture } = TSL;
  const guardCalls = [];
  const gp = buildGradePresentMaterial({
    THREE,
    litTexture: stubTexture(),
    outdoorsTexNode: texture(stubTexture()),
    uViewRect: uniform(vec4(0, 0, 1920, 1080)),
    uOutdoorsRect: uniform(vec4(0, 0, 1920, 1080)),
    lampGlowTexture: stubTexture(),
    lensUvGuard: (plain, warped) => {
      guardCalls.push(1);
      return warped;
    },
  });
  const base = nodeOf(gp);
  ok('starts with no overlay and no lens warp', gp.foundryOverlayCompiled().grid === null && !gp.lensWarpCompiled());
  const r0 = gp.setFoundryOverlay({});
  ok('an empty overlay changes nothing', r0.grid === false && r0.outline === false && nodeOf(gp) === base);
  const r1 = gp.setFoundryOverlay({ grid: grid(), outline, pxPerCanvas: 1 });
  ok('⭐ a grid + outline compile in, and say so', r1.grid && r1.outline && nodeOf(gp) !== base);
  const withGrid = nodeOf(gp);
  gp.setFoundryOverlay({ grid: grid({ alpha: 0.9, thicknessPx: 3 }), outline, pxPerCanvas: 2 });
  ok('⭐ a new alpha/thickness/zoom is a uniform write, not a rebuild', nodeOf(gp) === withGrid);
  gp.setFoundryOverlay({ grid: grid({ type: T.HEXODDQ, style: S.LINE_DASHED }), outline, pxPerCanvas: 1 });
  ok('a new type/style rebuilds', nodeOf(gp) !== withGrid && gp.foundryOverlayCompiled().grid === '4:1');
  const unknown = gp.setFoundryOverlay({ grid: grid({ style: 42 }), outline: null, pxPerCanvas: 1 });
  ok('⭐ a style it cannot draw reports grid:false (the caller leaves it to Foundry)', unknown.grid === false);

  gp.setLensWarp(false);
  ok('lens off ⇒ no warp compiled, no guard built', !gp.lensWarpCompiled() && guardCalls.length === 0);
  const beforeLens = nodeOf(gp);
  gp.setLensWarp(true, -0.1);
  ok(
    "⭐ lens on ⇒ the warp compiles in, through the lens's own Table guard",
    gp.lensWarpCompiled() && nodeOf(gp) !== beforeLens && guardCalls.length > 0
  );
  const withLens = nodeOf(gp);
  gp.setLensWarp(true, -0.25);
  ok('a new distortion is a uniform write, not a rebuild', nodeOf(gp) === withLens);
  gp.setLensWarp(false);
  ok(
    '⭐ lens off again ⇒ the warp STAYS compiled (distortion 0): a toggle is never a rebuild',
    gp.lensWarpCompiled() && nodeOf(gp) === withLens
  );

  // ── THE ONE WARP ────────────────────────────────────────────────────────
  ok('lensWarpUv builds without a guard', !!lensWarpUv(TSL, TSL.uv(), TSL.float(-0.1))?.isNode);
  let sawPlain = null;
  lensWarpUv(TSL, TSL.uv(), TSL.float(-0.1), (plain, warped) => {
    sawPlain = plain;
    return warped;
  });
  ok('the guard is handed the plain uv it was given', sawPlain !== null && sawPlain.isNode);
}
