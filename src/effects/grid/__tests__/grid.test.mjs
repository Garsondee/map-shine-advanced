/**
 * grid.test.mjs — MSA's Grid look: the declaration is sound, it is ON by default, its defaults are the
 * subtle look the author asked for, `resolveGridLook` clamps and falls back, and the look CONSTRUCTS
 * (`keyhole-tsl-constructs-in-node`) for every grid type × line pattern through the real present.
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import { GRID, GRID_PARAMS, GRID_LINE_STYLES, resolveGridLook, gridInkRgb } from '../grid.js';
import { FOUNDRY_GRID_TYPES as T, createFoundryGridUniforms, buildGridLookAlpha } from '../foundry-grid-render.js';
import { resolveEffectEnabled } from '../../effect-cascade.js';
import { buildGradePresentMaterial } from '../../grade/grade-present.js';
import { parseGridDefaults } from '../../../foundry/grid-defaults-persistence.js';

function stubTexture() {
  const tex = new THREE.DataTexture(new Uint8Array([0, 128, 128, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.needsUpdate = true;
  return tex;
}

export function run(t) {
  const { ok } = t;
  const TSL = THREE.TSL;

  // ── DECLARATION ─────────────────────────────────────────────────────────
  ok('id is grid', GRID.id === 'grid' && GRID.params === GRID_PARAMS);
  ok(
    '⭐ ON by default at every performance profile',
    ['low', 'performance', 'standard', 'quality', 'extreme'].every((profile) => resolveEffectEnabled(GRID, { profile }))
  );
  ok('a GM can switch it off for the table', resolveEffectEnabled(GRID, { gmEnable: 'off' }) === false);
  for (const [k, d] of Object.entries(GRID_PARAMS)) {
    if (d.type === 'float') ok(`${k}: default inside its range`, d.default >= d.min && d.default <= d.max);
    ok(`${k}: has a label, help and category`, !!d.label && !!d.help && !!d.category);
  }
  ok('⭐ thin: one screen pixel', GRID_PARAMS.widthPx.default === 1);
  ok(
    '⭐ subtle: well under half opacity, and quieter on dark ground than bright',
    GRID_PARAMS.dayOpacity.default <= 0.4 && GRID_PARAMS.nightOpacity.default < GRID_PARAMS.dayOpacity.default
  );
  const dark = gridInkRgb(GRID_PARAMS.darkInk.default);
  const light = gridInkRgb(GRID_PARAMS.lightInk.default);
  ok(
    '⭐ a dark ink for bright ground and a pale ink for dark ground',
    dark.every((c) => c < 0.15) && light.every((c) => c > 0.8)
  );

  // ── RESOLVE ─────────────────────────────────────────────────────────────
  const d = resolveGridLook(null);
  ok(
    'nothing stored ⇒ the shipped defaults',
    d.widthPx === 1 && d.lineStyle === 'solid' && d.pivot === GRID_PARAMS.pivot.default
  );
  const r = resolveGridLook({
    widthPx: 99,
    dayOpacity: -1,
    lineStyle: 'wavy',
    darkInk: 'not a colour',
    lightInk: '#ff0000',
  });
  ok('out-of-range numbers clamp', r.widthPx === GRID_PARAMS.widthPx.max && r.dayOpacity === 0);
  ok('an unknown line pattern falls back', r.lineStyle === 'solid');
  ok(
    'a bad colour falls back; a good one is read',
    r.darkInk[0] === dark[0] && r.lightInk[0] === 1 && r.lightInk[1] === 0
  );
  ok('every pattern is offered', GRID_LINE_STYLES.join() === 'solid,dashed,dotted');

  // ── WORLD SETTING ───────────────────────────────────────────────────────
  ok('the world setting: empty ⇒ {}', Object.keys(parseGridDefaults('')).length === 0);
  ok(
    '…junk ⇒ {} (never a throw)',
    Object.keys(parseGridDefaults('{oops')).length === 0 && Object.keys(parseGridDefaults('[1]')).length === 0
  );
  ok('…stored values come back', parseGridDefaults('{"widthPx":1.5}').widthPx === 1.5);

  // ── THE LOOK CONSTRUCTS ─────────────────────────────────────────────────
  const u = createFoundryGridUniforms(TSL);
  const failures = [];
  for (const type of [T.SQUARE, T.HEXODDR, T.HEXEVENR, T.HEXODDQ, T.HEXEVENQ]) {
    for (const lineStyle of GRID_LINE_STYLES) {
      try {
        if (!buildGridLookAlpha(TSL, { canvasXY: TSL.vec2(10, 20), u, type, lineStyle })?.isNode)
          failures.push(`${type}:${lineStyle}`);
      } catch (e) {
        failures.push(`${type}:${lineStyle} threw ${e.message}`);
      }
    }
  }
  ok(`⭐ the look builds for 5 grid types × 3 patterns (${failures.join('; ') || 'clean'})`, failures.length === 0);

  const { uniform, vec4, texture } = TSL;
  const gp = buildGradePresentMaterial({
    THREE,
    litTexture: stubTexture(),
    outdoorsTexNode: texture(stubTexture()),
    uViewRect: uniform(vec4(0, 0, 1920, 1080)),
    uOutdoorsRect: uniform(vec4(0, 0, 1920, 1080)),
  });
  const grid = {
    type: T.SQUARE,
    style: 0,
    sizePx: 100,
    thicknessPx: 1,
    color: [0, 0, 0],
    alpha: 0.2,
    mesh: { x: 0, y: 0, width: 4000, height: 3000 },
  };
  gp.setFoundryOverlay({ grid, outline: null, pxPerCanvas: 1 });
  ok("look off ⇒ Foundry's own style is compiled", gp.foundryOverlayCompiled().grid === '1:0');
  const r1 = gp.setFoundryOverlay({ grid, outline: null, pxPerCanvas: 1, look: resolveGridLook({}) });
  ok(
    '⭐ look on ⇒ the look is compiled, and the grid is drawn',
    r1.grid && gp.foundryOverlayCompiled().grid === 'look:1:solid'
  );
  const withLook = gp.material.fragmentNode;
  gp.setFoundryOverlay({
    grid,
    outline: null,
    pxPerCanvas: 1.5,
    look: resolveGridLook({ widthPx: 2, nightOpacity: 0.05, darkInk: '#000000' }),
  });
  ok('⭐ a new width / opacity / ink is a uniform write, not a rebuild', gp.material.fragmentNode === withLook);
  gp.setFoundryOverlay({
    grid: { ...grid, type: T.HEXODDQ },
    outline: null,
    pxPerCanvas: 1,
    look: resolveGridLook({ lineStyle: 'dotted' }),
  });
  ok(
    'a new pattern or grid type rebuilds',
    gp.foundryOverlayCompiled().grid === 'look:4:dotted' && gp.material.fragmentNode !== withLook
  );
  const none = gp.setFoundryOverlay({ grid: null, outline: null, pxPerCanvas: 1, look: resolveGridLook({}) });
  ok(
    '⭐ no Foundry grid (gridless / hidden) ⇒ the look draws nothing either',
    none.grid === false && gp.foundryOverlayCompiled().grid === null
  );
}
