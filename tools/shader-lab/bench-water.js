/**
 * SHADER LAB — THE WATER BENCH (`docs/holy/Water-Testament.md` W0).
 *
 * Builds the REAL production water material (`buildWaterSurfaceMaterial`,
 * imported unmodified from `src/effects/water/water-render.js`) on a real
 * WebGPU device, runs the REAL jump-flood body-pack bake
 * (`src/effects/water/water-body.js` — the exact seed/step/resolve materials
 * `water-body-subsystem.js` drives in production) against a synthetic river
 * mask, and reads the exact pixels back. Template: `bench-specular.js`.
 *
 * ============================================================================
 * WHY THIS BENCH EXISTS
 * ============================================================================
 * The 2026-08-16 session shipped tier 4 (shore foam) TWICE blind — a caustics
 * leak across the whole floor, then a redesigned foam that still read as
 * absent on the author's own river — because nothing could answer "which of
 * the dozen terms a shoreline foam pixel depends on is actually zero" without
 * a live round-trip. `gateLadder()` below is water's copy of the instrument
 * that ended specular's identical twelve-round history: render every debug
 * channel over the SAME painted water, read its mean/max/p99/coverage, and
 * name the first dead term instead of guessing at the next one.
 *
 * ⚠️ IT CANNOT SEE A WIRING BUG IN THE VIEWER. Every input here is synthetic
 * and correct by construction, so a green ladder means "the shader is fine
 * given good inputs", never "the effect works live" — the author's own map is
 * still the only LIVE gate (Water-Testament §5, §6 — ⛔ never the bench
 * Mansion). The value is precise and limited: it partitions shader-vs-plumbing
 * in one run instead of alternating guesses across both for a week.
 *
 * ============================================================================
 * THE FIXTURE: A REAL BEND-AND-ISLAND RIVER, NOT A RECTANGLE
 * ============================================================================
 * A straight-sided rectangle never exercises the SDF's tangent rotation, the
 * shoreline's own varying reach, or a bank the current runs INTO from more
 * than one side. `paintRiverMask()` below rasterises a wavy channel (three
 * bends) that widens into a pool around one elliptical island, entirely
 * surrounded by water — the shape `WATER_DEBUG_CHANNELS`' own `breakFacing`
 * channel (12) needs to prove the tangent-to-normal rotation has the right
 * sign on BOTH banks, not just one.
 *
 * ⚠️ DEPTH IS PAINTED FLAT (one value everywhere inside the channel). This is
 * deliberate, not a missing feature: tier 1's geometric ramp
 * (`depthRamp`/`shoreDist`, from the SDF) is what turns a flat silhouette into
 * a shallow-at-the-bank, deep-mid-channel look — see `water-render.js`'s own
 * header on why a painted depth GRADIENT was never required for that, and
 * because the author's own most common authoring case (a river painted as one
 * polygon) IS a flat presence mask. Depth-gradient authoring is a separate,
 * already-covered question this fixture does not need to re-answer.
 *
 * ============================================================================
 * WHAT THIS BENCH DELIBERATELY DOES NOT MEASURE (yet)
 * ============================================================================
 * `gateLadder()` reports mean/max/p99/coverage over the WHOLE painted water
 * AABB, not a shore-only sub-region. Most of a river's interior is legitimately
 * far from any bank, where shore-derived foam terms (`foamD01`, `breakFoam`,
 * the swash gate) are CORRECTLY near their neutral value — so a low
 * whole-body coverage number is consistent with either "shore foam works and
 * is naturally localised" or "shore foam is broken everywhere". Named here
 * rather than silently trusted: if that ambiguity ever blocks a real
 * diagnosis, the fix is a second, shore-distance-restricted stats pass (reuse
 * a `foamD01` readback as the region mask), not a rewrite of this file.
 *
 * @module tools/shader-lab/bench-water
 */

import {
  buildWaterSurfaceMaterial,
  WATER_DEFAULT_TIER,
  WATER_TIER0_TINT,
  WATER_TIER0_OPACITY,
  WATER_TIER1_ABSORPTION,
  WATER_TIER1_DEPTH_SCALE_PX,
  WATER_TIER1_INSCATTER,
  WATER_TIER1_WET_BAND_PX,
  WATER_TIER1_WET_STRENGTH,
  WATER_TIER4_SWASH_FOAM,
  WATER_TIER4_BREAK_FOAM,
  WATER_TIER4_CAUSTICS,
} from '../../src/effects/water/water-render.js';
import {
  WATER_TIER2_WAVE_SCALE_PX,
  WATER_TIER2_FLOW_SPEED_PX,
  WATER_TIER2_FLOW_ANGLE_DEG,
  WATER_TIER2_FOAM,
  WATER_TIER3_CHOP,
  WATER_FLOW_WARP_INFLUENCE,
  WATER_FLOW_WARP_CAP_CELLS,
  waterFlowVector,
} from '../../src/effects/water/water-field.js';
import {
  WATER_TIER3_SUN_GLINT,
  WATER_TIER3_SKY_SHEEN,
  WATER_TIER3_GLOSSINESS,
  WATER_TIER3_VIEWER_HEIGHT,
  WATER_TIER3_SHADOW_RESPONSE,
  waterKeyLightDirection,
} from '../../src/effects/water/water-light.js';
import {
  buildWaterSeedMaterial,
  buildWaterJfaStepMaterial,
  buildWaterBodyResolveMaterial,
  jfaStepCount,
  jfaStrideForStep,
  WATER_MASK_FILTER,
  WATER_BODY_SUPERSAMPLE,
} from '../../src/effects/water/water-body.js';
import { WATER_DEBUG_CHANNELS } from '../../src/effects/water/water.js';
import { buildWorldSpaceOutdoorsGate } from '../../src/effects/lighting/environmental-light.js';
import { computeCameraFrustum, QUAD_UVS, QUAD_INDICES, buildQuadPositions } from '../../src/scene/world-quad.js';
// ── REAL-MAP SCENARIO (2026-08-18) — see `real-underground-river-flow`
// below. `loadMaskImageTexture` is the REAL production ingest path
// (`vt/mask-image.js`), `TOWER_BRIDGE` is shader-lab's own "Fixture One"
// (AGENTS.md §7), `createWaterFlowSubsystem` is the REAL S2+S3 bake —
// imported, never transcribed, matching this file's own §6 rule.
import { loadMaskImageTexture } from '../../src/vt/mask-image.js';
import TOWER_BRIDGE from './fixtures/tower-bridge.js';
import { createWaterFlowSubsystem } from '../../src/effects/water/water-flow-subsystem.js';
import { createWaterSimSubsystem } from '../../src/effects/water/water-sim-subsystem.js';
// THE SELF-CAPTURE FIX (2026-08-23) — REAL `createWaterRefractionSubsystem`,
// never a stub, for `tier5-refraction-does-not-capture-itself` below. See
// that scenario's own header for why this is the one thing worth a real,
// permanent bench proof rather than a one-off script.
import { createWaterRefractionSubsystem } from '../../src/effects/water/water-refraction-subsystem.js';
// THE RENDERER-GLOBAL MRT BASE (`scene-attr.js`'s own header — "THE MRT
// MECHANISM"). `absorbMaterial`/`inscatterMaterial`/`debugMaterial` each
// declare their OWN `material.mrtNode = mrt({ attr: ... })` (water-render.js),
// a PER-MATERIAL override that MERGES over a renderer-global base — and with
// NO base set at all, `MRTNode.setup()` has nothing to merge into, so the
// material's own single-key struct becomes the WHOLE fragment output, and if
// even THAT key finds no matching attachment name on the bound target, the
// struct is EMPTY: a hard WGSL compile error ("structures must have at least
// one member"), not a silent skip. `buildSceneAttrZeroMrt` is the real,
// unmodified production fix — imported, never transcribed.
import { buildSceneAttrZeroMrt } from '../../src/vt/scene-attr.js';
import { evaluate } from './contract.js';

/** The bench's world rect — bigger than specular's (2000²): a river needs
 * room for real bends, and `WATER_TIER1_DEPTH_SCALE_PX` (256) and the foam
 * reach's own ceiling (420px, `water-shore.js#WATER_FOAM_REACH_MAX_PX`) need
 * to read as genuinely small fractions of the body, the way they would on an
 * author's actual map, not as most of it. */
export const WATER_RECT = Object.freeze({ minX: 0, minY: 0, maxX: 4000, maxY: 4000 });

/** The `_Water` mask's own resolution. `WATER_BODY_SUPERSAMPLE` (currently 1
 * — see `water-body.js`'s own header for why it went back to 1) sizes the
 * flood off THIS, exactly as `water-body-subsystem.js#uploadMask` does. */
const MASK_DIM = 512;
/** Readback/paint resolution. */
const SCREEN_DIM = 768;

/** Below this, a channel's signal counts as absent (`gateLadder`'s DEAD
 * test) or, for a REMAPPED channel, as never having left its 0.5 neutral. */
const DEAD_EPS = 1e-4;

// ---------------------------------------------------------------------------
// THE RIVER FIXTURE — bends + a pool + an island, painted as a real `_Water`
// mask. `v` sweeps 0(=world minY, "north")..1(=world maxY, "south") — the same
// DataTexture row-0-is-minY convention every mask in this renderer uses.
// ---------------------------------------------------------------------------

/** The channel's own centreline, in mask-UV `u`. Two superimposed sine bends
 * so no straight run is longer than a fraction of the map. */
function riverCenterU(v) {
  return 0.42 + 0.16 * Math.sin(v * Math.PI * 2.1) + 0.06 * Math.sin(v * Math.PI * 5.3 + 1.7);
}

/** Half the channel's width at this `v`, in mask-UV — a gentle natural
 * variation PLUS one wide "pool" bulge around v≈0.55 that hosts the island
 * with real water margin on every side. */
function riverHalfWidthU(v) {
  const bulge = Math.exp(-(((v - 0.55) / 0.09) ** 2)) * 0.14;
  return 0.045 + 0.018 * Math.sin(v * Math.PI * 3.1) + bulge;
}

/** The island: an ellipse sitting inside the pool bulge, offset from the
 * centreline so both the near and far banks have real water between them and
 * the outer shore — the shape `breakFacing` (channel 12) needs to prove the
 * tangent rotation is not just right on ONE side by luck. */
const ISLAND = Object.freeze({ u: riverCenterU(0.55) - 0.059, v: 0.56, ru: 0.028, rv: 0.045 });

/** Mask R for painted water — a flat "authored as real river depth" value;
 * see this module's header on why depth is not painted as a gradient. */
const RIVER_MASK_R = 226;

/** @param {number} u @param {number} v @returns {boolean} true = island land */
function insideIsland(u, v) {
  const du = (u - ISLAND.u) / ISLAND.ru;
  const dv = (v - ISLAND.v) / ISLAND.rv;
  return du * du + dv * dv <= 1;
}

/** The default fixture. @param {number} u @param {number} v @returns {number[]} RGBA bytes */
function paintRiver(u, v) {
  if (insideIsland(u, v)) return [0, 0, 0, 0];
  const cx = riverCenterU(v);
  const hw = riverHalfWidthU(v);
  if (Math.abs(u - cx) > hw) return [0, 0, 0, 0];
  return [RIVER_MASK_R, RIVER_MASK_R, RIVER_MASK_R, 255];
}

/** @param {(u:number,v:number)=>number[]} paint @returns {{data:Uint8Array,w:number,h:number}} */
function rasterMask(paint) {
  const w = MASK_DIM;
  const h = MASK_DIM;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const [r, g, b, a] = paint(u, v);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { data, w, h };
}

/** Decode one IEEE-754 binary16 to a JS number — `scene.color`-equivalent
 * readback here is HalfFloat, matching production; a fixed hardware spec
 * transcription, the same class `bench-specular.js`'s own copy is (AGENTS.md
 * §9's "sRGB is a fixed published spec" exemption, one level down).
 * @param {number} h @returns {number} */
function halfToFloat(h) {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  const sign = s ? -1 : 1;
  if (e === 0) return sign * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : sign * Infinity;
  return sign * Math.pow(2, e - 15) * (1 + f / 1024);
}

/** Water channels that multiply/add into the shipped composite — a zero over
 * the whole painted water body IS a bug. See `WATER_DEBUG_CHANNELS`' own
 * header: this list walks n=1..18 in the SAME computation order, just split
 * out by what "dead" means for each. */
const CHAIN = [
  'quad',
  'mask',
  'inside',
  'shoreDist01',
  'depth01',
  'foamCrest',
  'foamD01',
  'worleyLace',
  'swashBand',
  'breakFacing',
  'breakFoam',
  // ⚠️ CHAIN, not informational — the tail is the term that fakes foam MEMORY
  // (`water-shore.js#WATER_TAIL_TAPS`), and it compiles out ENTIRELY when the
  // body-pack sampler is not passed. A zero here therefore means the sampler
  // never arrived, which is a real wiring bug and exactly what this ladder is
  // for. On a fixture with a current and an obstacle it must never be zero.
  'foamTail',
  // `simFoamStructure` (S5, 2026-08-19) belongs here, not INFORMATIONAL —
  // same reasoning as `worleyLace` two lines up, which it is architecturally
  // identical to (both are `buildFoamCellularStructure`'s own output now):
  // neither depends on a REAL flow/sim bake, because `flowDir` (the ROTATION
  // input, always global — `WATER_FOAM_STREAK`'s own restored contract,
  // 2026-08-19) is a well-defined, always-real direction regardless of
  // whether a real bake exists, so the Worley math still produces genuine,
  // non-degenerate cellular variation. ⚠️ NOT the same reasoning as the OLD
  // comment here once gave (deleted 2026-08-19): that cited the dead-zone
  // fallback `localFlowDirSafe` used to have, which is gone — the real
  // fixed point now is that the ROTATION never depended on a real bake to
  // begin with, only the separate, small NUDGE does (and `worleyLace`'s own
  // presence here already proves a neutral nudge does not flatten this
  // channel). Unlike `simFoamStructured` below (INFORMATIONAL): THAT one
  // also multiplies in the accumulator, which IS placeholder-zero here.
  'simFoamStructure',
  // `foamEdgeSharpness` (2026-08-24) belongs here for the SAME reason
  // `worleyLace`/`simFoamStructure` do — it reads the raw mask alone
  // (`WATER_FOAM_EDGE_SHARPNESS_TAP_PX`'s own doc), never a flow/sim bake,
  // so it is well-defined and genuinely non-constant against ANY painted
  // fixture: `paintRiver`'s own hard edges should read close to fully
  // sharp right at the shoreline and zero in open water/deep land.
  'foamEdgeSharpness',
  'totalFoam',
  'reflection',
  'absorbFinal',
  'inscatterFinal',
];
/** Neutral at 0.5 grey, not at 0 — see `water-render.js`'s own debug-node
 * comment. "Dead" here means "never left 0.5", not "reads 0". */
const REMAPPED = ['turbidity', 'causticExcess'];
/** A derived, display-only reading whose own zero can be the CORRECT answer
 * (fully-opaque deep water) — reported, never verdict-bearing.
 * `flowSolidity`/`flowVelocity` (S2/S3, 2026-08-17) live here because this
 * bench builds the material directly, never through
 * `water-surface-subsystem.js`'s own `flowPackPlaceholder`+
 * `setFlowPackTexture` wiring, so it never passes a `flowPackTexture`
 * argument at all — a live `res:waterFlow` bake (both the S2 solidity seed
 * AND the S3 coarse-to-fine velocity cascade) is a `vt-pan-viewer.js`-only
 * thing (the per-floor flow subsystem), structurally out of reach for a
 * standalone shader bench with no scene, no floor list, and no allocator.
 * (`real-underground-river-flow`, elsewhere in this file, is the scenario
 * that DOES wire a real one — see its own header for why it needs its own,
 * separate rig instead of extending this one.) */
// `simFoamRaw`/`simFoam` (S5, 2026-08-18) live here for the EXACT SAME
// reason `flowSolidity`/`flowVelocity` do, two lines up: this bench builds
// the material directly, never through `water-surface-subsystem.js`'s own
// `waterSimPlaceholder`+`setWaterSimTexture` wiring, so `waterSimTexture` is
// always a static all-zero placeholder here — a real, ticking `res:waterSim`
// buffer is a `vt-pan-viewer.js`-only thing (the per-floor sim subsystem),
// structurally out of reach for a standalone shader bench with no scene, no
// floor list, and no allocator, same as the flow pack. `real-underground-
// river-sim`, elsewhere in this file, is the scenario that DOES wire a real,
// ticked one.
// `simFoamStructured` (S5, 2026-08-19) joins `simFoamRaw`/`simFoam` here for
// the identical reason: it multiplies in `waterSimFoam`, which reads this
// bench's own all-zero placeholder sim texture, so the product is dead
// (constant zero) regardless of how real `simFoamStructure` itself is. See
// `simFoamStructure`'s own comment in CHAIN above for why THAT sibling
// channel does NOT belong here.
// `flowWarp` (2026-08-19) joins `flowSolidity`/`flowVelocity` here for the
// SAME reason, one step further downstream: it is `local direction − global
// direction`, and this bench's own flow-pack placeholder is a CONSTANT
// (uniform, matching the global bearing, no per-pixel obstacle deflection
// because there is no real bake) — so the difference is legitimately ~0
// everywhere on this fixture, correctly neutral, not a wiring bug the
// ladder should flag. `synthetic-river-flow-avoids-island`'s own new sign
// check (elsewhere in this file) is where this channel gets proven against
// a REAL bake instead.
const INFORMATIONAL = [
  'bedVisibility',
  'flowSolidity',
  'flowVelocity',
  'simFoamRaw',
  'simFoam',
  'simFoamStructured',
  'flowWarp',
];

/** @param {string} id @returns {'chain'|'remapped'|'info'}
 * Exhaustive, not exclusion-based (`feedback_category_string_must_be_in_
 * closed_list`): a channel id belonging to none of the three lists throws
 * loudly here rather than silently defaulting to 'chain', which is exactly
 * the shape a future channel added to `WATER_DEBUG_CHANNELS` without being
 * classified here would need to be caught by. */
function classifyChannel(id) {
  if (CHAIN.includes(id)) return 'chain';
  if (REMAPPED.includes(id)) return 'remapped';
  if (INFORMATIONAL.includes(id)) return 'info';
  throw new Error(`bench-water: channel '${id}' is not in CHAIN, REMAPPED, or INFORMATIONAL — classify it there`);
}

/**
 * Build the water bench.
 * @param {object} args
 * @param {*} args.THREE @param {*} args.renderer @param {(m:string)=>void} args.log
 * @returns {object} the bench API (also parked on `window.waterBench`).
 */
export function createWaterBench({ THREE, renderer, log }) {
  const { uniform, vec4, texture } = THREE.TSL;

  const state = {
    scenario: 'river',
    tint: [...WATER_TIER0_TINT],
    opacity: WATER_TIER0_OPACITY,
    absorption: WATER_TIER1_ABSORPTION,
    depthScalePx: WATER_TIER1_DEPTH_SCALE_PX,
    inscatter: WATER_TIER1_INSCATTER,
    waveScalePx: WATER_TIER2_WAVE_SCALE_PX,
    flowSpeedPx: WATER_TIER2_FLOW_SPEED_PX,
    flowAngleDeg: WATER_TIER2_FLOW_ANGLE_DEG,
    foam: WATER_TIER2_FOAM,
    wetBandPx: WATER_TIER1_WET_BAND_PX,
    wetStrength: WATER_TIER1_WET_STRENGTH,
    sunGlint: WATER_TIER3_SUN_GLINT,
    skySheen: WATER_TIER3_SKY_SHEEN,
    glossiness: WATER_TIER3_GLOSSINESS,
    viewerHeight: WATER_TIER3_VIEWER_HEIGHT,
    shadowResponse: WATER_TIER3_SHADOW_RESPONSE,
    chop: WATER_TIER3_CHOP,
    swashFoam: WATER_TIER4_SWASH_FOAM,
    breakFoam: WATER_TIER4_BREAK_FOAM,
    caustics: WATER_TIER4_CAUSTICS,
    tier: WATER_DEFAULT_TIER >= 5 ? WATER_DEFAULT_TIER : 5,
    debugChannel: 0,
    timeMs: 0,
    zoom: 1,
    /** The riverbed/dry-land art the two meshes draw ONTO — a warm sand/mud
     * tone, so the multiply pass (absorption) has something real to darken
     * and the add pass (in-scatter) has something to be visible AGAINST. */
    bedColor: [0.32, 0.25, 0.16],
  };

  const uViewRect = uniform(vec4(WATER_RECT.minX, WATER_RECT.minY, WATER_RECT.maxX, WATER_RECT.maxY));
  const uOutdoorsRect = uniform(vec4(WATER_RECT.minX, WATER_RECT.minY, WATER_RECT.maxX, WATER_RECT.maxY));
  const uTimeMs = uniform(0);

  /** @param {Uint8Array} data @param {number} w @param {number} h @param {string} filter 'linear'|'nearest' */
  const makeTex = (data, w, h, filter) => {
    const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    const f = filter === 'linear' ? THREE.LinearFilter : THREE.NearestFilter;
    t.minFilter = f;
    t.magFilter = f;
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.colorSpace = THREE.NoColorSpace; // RAW bytes — the mask carries no transfer curve
    t.flipY = false; // row 0 = minY, this renderer's own convention everywhere
    t.needsUpdate = true;
    return t;
  };
  const solidTex = (r, g, b, a) => makeTex(new Uint8Array([r, g, b, a]), 1, 1, 'nearest');
  /** A high-contrast checkerboard, `cell` px per square — DIAGNOSTIC, see the
   * tier-5 `capturedTexture` call site's own comment. Distinct hues per
   * square (not just light/dark) so a bend that SWAPS which square a pixel
   * reads is as visible as one that merely shifts within the same square. */
  function makeCheckerTex(w, h, cell) {
    const data = new Uint8Array(w * h * 4);
    const hues = [
      [230, 60, 60],
      [60, 200, 90],
      [70, 110, 230],
      [230, 200, 60],
    ];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const cx = (x / cell) | 0;
        const cy = (y / cell) | 0;
        const [r, g, b] = hues[(cx + cy * 2) % hues.length];
        const i = (y * w + x) * 4;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = 255;
      }
    }
    return makeTex(data, w, h, 'nearest');
  }

  let maskTexture = solidTex(0, 0, 0, 255);
  const outdoorsTexture = solidTex(255, 255, 255, 255); // a river reads fully outdoors
  const outdoorsTexNode = texture(outdoorsTexture);

  // ── THE BODY PACK'S OWN TARGETS — SAME format choices as `water-body-
  // subsystem.js#ensureTargets`: HalfFloat/RGBA/NoColorSpace, LINEAR for the
  // finished pack (smoothly-varying scalars), NEAREST for the ping-pong pair
  // (mid-flood offset VECTORS — interpolating them is meaningless). Built
  // directly via `new THREE.RenderTarget`, not the allocator — the same
  // choice `bench-specular.js` makes for its own depth pass, since shader-lab
  // tooling owns its targets outright.
  const floodW = MASK_DIM * WATER_BODY_SUPERSAMPLE;
  const floodH = MASK_DIM * WATER_BODY_SUPERSAMPLE;
  const rtDescribe = (filter) => ({
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.NoColorSpace,
    depthBuffer: false,
    minFilter: filter,
    magFilter: filter,
  });
  const bodyRt = new THREE.RenderTarget(floodW, floodH, rtDescribe(THREE.LinearFilter));
  const jfaPingRt = new THREE.RenderTarget(floodW, floodH, rtDescribe(THREE.NearestFilter));
  const jfaPongRt = new THREE.RenderTarget(floodW, floodH, rtDescribe(THREE.NearestFilter));
  for (const rt of [bodyRt, jfaPingRt, jfaPongRt]) {
    rt.texture.wrapS = THREE.ClampToEdgeWrapping;
    rt.texture.wrapT = THREE.ClampToEdgeWrapping;
  }
  const jfaSteps = jfaStepCount(floodW, floodH);

  /** `renderSunShadowPass`'s exact triplet (`vt-pan-viewer.js`) — save,
   * bind, render, restore. `QuadMesh` renders itself (`quad.render(renderer)`
   * — it bundles its own geometry AND camera), never `renderer.render(quad, camera)`.
   * @param {*} target @param {*} quad */
  function renderQuadPass(target, quad) {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    quad.render(renderer);
    renderer.setRenderTarget(prev);
  }

  // THE THREE REAL BAKE MATERIALS.
  //
  // ⚠️ `seed`/`resolve` are REBUILT (never merely re-pointed) every time the
  // mask changes — `rebuildBodyMaterials`, called from `applyFixture` below.
  // Production's OWN discipline (`water-body-subsystem.js#ensureMaterials`)
  // re-points `.value` on long-lived materials instead, and that IS what this
  // bench tried first — proven live, 2026-08-17, to leave
  // `buildWaterBodyResolveMaterial`'s mask sample reading as if the texture
  // were still its ORIGINAL (1×1 placeholder) value: `isWater` false
  // EVERYWHERE, so the SDF's sign never went negative, so `shoreDist01` (and
  // everything downstream of it) read dead on a real, correctly-painted
  // river, even though a FRESH material sampling the SAME texture object read
  // it correctly (`_debug.probeMaskDirect()`). Production never actually hits
  // this path: `ensureMaterials` only runs the FIRST time `uploadMask`
  // reassigns `maskTexture` to a real file, so it never builds these two
  // materials against the placeholder at all. This bench's single-shot
  // construction order does not have that luxury, and nobody has fully
  // characterised the underlying WebGPU mechanism (the exact shape
  // `feedback_instruments_must_not_lie`'s specular precedent names: "the
  // mechanism was never actually found, only worked around per-channel") — so
  // rebuilding fresh is the PROVEN-correct choice over trusting a repoint path
  // this session cannot explain. `jfa` is exempt: it never references
  // `maskTexture`, only the fixed ping-pong targets.
  let bodyMaterials = null;
  function rebuildBodyMaterials() {
    const prevJfa = bodyMaterials?.jfa;
    bodyMaterials?.seed?.material?.dispose?.();
    bodyMaterials?.resolve?.material?.dispose?.();
    const seed = buildWaterSeedMaterial({ THREE, maskTexture, width: floodW, height: floodH });
    const jfa =
      prevJfa ?? buildWaterJfaStepMaterial({ THREE, prevTexture: jfaPingRt.texture, width: floodW, height: floodH });
    const resolve = buildWaterBodyResolveMaterial({
      THREE,
      jfaTexture: jfaPingRt.texture,
      maskTexture,
      texelWorldW: 1,
      texelWorldH: 1,
      farDistancePx: 1,
    });
    bodyMaterials = { seed, jfa, resolve };
  }

  /** SEED → `jfaSteps` ping-pong rounds → RESOLVE — byte-for-byte
   * `water-body-subsystem.js#runFlood`'s own sequence, against THIS bench's
   * own targets. One-shot: the bench's mask never changes mid-session, so
   * there is no per-frame poll to replicate, only the bake itself. */
  function bakeBody() {
    renderQuadPass(jfaPingRt, bodyMaterials.seed.quad);
    let readFromPing = true;
    for (let i = 0; i < jfaSteps; i++) {
      const src = readFromPing ? jfaPingRt : jfaPongRt;
      const dst = readFromPing ? jfaPongRt : jfaPingRt;
      bodyMaterials.jfa.uStride.value = jfaStrideForStep(i, jfaSteps);
      for (const node of bodyMaterials.jfa.prevTexNodes) node.value = src.texture;
      renderQuadPass(dst, bodyMaterials.jfa.quad);
      readFromPing = !readFromPing;
    }
    bodyMaterials.resolve.jfaTexNode.value = (readFromPing ? jfaPingRt : jfaPongRt).texture;
    renderQuadPass(bodyRt, bodyMaterials.resolve.quad);
  }

  // THE REAL SURFACE MATERIAL — built exactly as `water-surface-subsystem.js`
  // builds it (minus the depth-authority gate: deliberately unwired here, see
  // below), with the same injected outdoors-gate seam the viewer passes.
  // `waterSimTexture` (S5, 2026-08-18): a 1×1 "no foam" placeholder, same
  // shape as `flowPackTexture`'s own missing-default gap this bench already
  // had — `buildWaterSurfaceMaterial` samples this UNCONDITIONALLY (never
  // JS-null-compiled-out), so a real render needs SOME real texture object
  // here regardless of whether this scenario cares about sim foam.
  const surface = buildWaterSurfaceMaterial({
    THREE,
    maskTexture,
    maskRect: WATER_RECT,
    bodyTexture: bodyRt.texture,
    bodyRect: WATER_RECT,
    bodyTexSize: [floodW, floodH],
    timeMsNode: uTimeMs,
    uViewRect,
    uOutdoorsRect,
    outdoorsTexNode,
    buildOutdoorsGate: buildWorldSpaceOutdoorsGate,
    waterSimTexture: makeTex(new Uint8Array([0, 0, 0, 0]), 1, 1, 'linear'),
    // ⚠️ REAL, PRE-EXISTING BUG, FOUND WHILE WIRING S5 (2026-08-18) — this
    // material never passed `flowPackTexture` at all (relying on its own
    // `null` default) since the day S2/S3 shipped, and `calibration`
    // ('quad', a trivial constant channel with zero relation to flow data)
    // FAILED along with every coverage check — not just the ones actually
    // reading flow data. `texture(null, …)` here does not merely read as a
    // degenerate value on this WebGPU backend; it corrupts `debugMaterial`'s
    // WHOLE combined shader (every channel is summed into one graph — see
    // `buildDebugChannelColor`'s own doc), which is why an UNRELATED
    // constant channel failed too. Node-level tests never caught this
    // because `texture()` only validates its argument at WGSL-compile time,
    // never at graph-construction time — exactly `feedback_check_console_
    // before_theorizing`'s own point, confirmed a second time this session.
    //
    // ⚠️ NOT ALL-ZERO ANY MORE (2026-08-19) — a SECOND real bug this exact
    // placeholder hid until today: an all-zero RG reads as `localVel=(0,0)`,
    // which `water-render.js`'s own `localFlowDirSafe` used to paper over by
    // falling back to the global compass whenever local speed read near
    // zero. That fallback is gone (author's explicit instruction: "no
    // fallbacks, either flow works or breaks") — reading it directly means
    // `breakFacing` (S4, dots the local direction against the shore
    // tangent) went CONSTANT, since `dot((0,0), anything) = 0` regardless of
    // how the tangent itself varies, and this scenario's own gate ladder
    // correctly caught it as a dead term. R=0, G=255 encodes `(0, 1.0)` —
    // free-stream flow at exactly `WATER_TIER2_FLOW_ANGLE_DEG` (south), the
    // shipped default bearing — a real, non-degenerate reading a generic
    // placeholder should have carried from the start, not a workaround for
    // the fallback that used to exist.
    flowPackTexture: makeTex(new Uint8Array([0, 255, 90, 0]), 1, 1, 'linear'),
    // ⚠️ NO `depthTexture` — the depth-authority occlusion gate is out of
    // scope for a foam-visibility bench (Water-Testament W0's own ask); this
    // compiles the gate OUT (Effects.md Law 4), so water always draws
    // unoccluded, exactly the "torture fixture" shape `water-render.test.mjs`
    // already proves safe.
    // TIER 5 — REFRACTION (2026-08-23). A SOLID, saturated placeholder — a
    // brand-new colour nowhere else in this scene (bed/tint/foam are all in
    // the brown/teal family), so a screenshot alone shows whether the
    // refraction mesh is drawing SOMETHING and roughly where, at a glance,
    // with no separate readback. This is not a correctness check (a formal
    // gate-ladder scenario, matching `tier4-gate-ladder-no-dead-term`'s own
    // rigor, is still a real gap — noted, not built here) — only a real-GPU
    // construction+render smoke test: does the whole tier-5 graph compile,
    // bind, and draw without throwing or reading back as NaN/garbage.
    // `capturedRect` == the whole world rect: the simplest input for which
    // "this frame's positionWorld remapped through it" is trivially correct
    // by construction, same reasoning `WATER_TIER5_PLACEHOLDER_RECT` uses.
    // KEPT PERMANENTLY (2026-08-23, live-reported "oil spill" chaos) — a
    // real checkerboard, not a solid colour: a flat colour cannot show
    // whether the sample point is bending SMOOTHLY (a checker square stays
    // a recognisable square, just shifted/warped) or CHAOTICALLY
    // (neighbouring pixels land on unrelated, far-apart squares — the
    // actual look of the live report). This is strictly more capable than
    // the 1×1 solid colour it replaces — still catches a throw/NaN/garbage
    // construction failure, AND is the only fixture in this bench that can
    // ever reveal a distortion-coherence bug like this one. No automated
    // test in `tools/shader-lab/` depends on the old fixture's colour or
    // size, so there is no reason to revert.
    capturedTexture: makeCheckerTex(64, 64, 8),
    capturedRect: WATER_RECT,
    capturedTexSize: { width: 64, height: 64 },
    tier: state.tier,
    debugChannel: 0,
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
  geometry.setIndex(Array.from(QUAD_INDICES));
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));

  // TWO MESHES, SAME GEOMETRY — `water-surface-subsystem.js`'s own shape.
  // Mesh 1 (absorb) simply hides during a debug channel; mesh 2 (in-scatter)
  // is the one whose MATERIAL swaps to `surface.debugMaterial` — see
  // `applyDebugChannel` below, which is that subsystem's `refreshVisibility`
  // transcribed against this bench's own two meshes.
  // ⚠️ `frustumCulled = false` ON BOTH — `water-surface-subsystem.js`'s own
  // meshes set this explicitly ("world-space; the camera rect moves every
  // frame"), and it is load-bearing, not a nicety: this geometry's position
  // attribute is mutated in place (`applyFixture`) with no
  // `computeBoundingSphere()` call, so the default `boundingSphere` stays
  // `null` and the renderer's automatic frustum test against it drops the
  // draw call SILENTLY — every debug channel, every mesh, reading back as
  // the clear colour with no error anywhere (found live, 2026-08-17: `quad`,
  // a flat constant with no texture dependency at all, read back exactly
  // zero across the WHOLE canvas).
  const meshAbsorb = Object.assign(new THREE.Mesh(geometry, surface.absorbMaterial), {
    renderOrder: 0.5,
    frustumCulled: false,
  });
  const meshInscatter = Object.assign(new THREE.Mesh(geometry, surface.inscatterMaterial), {
    renderOrder: 0.51,
    frustumCulled: false,
  });
  // TIER 5 — REFRACTION (2026-08-23). `surface.refractMaterial` is `null`
  // below tier 5 (or if `capturedTexture` had been missing above) — this
  // bench's own `state.tier` default is now 5, so on a stock run this IS a
  // real material, but the null-guard mirrors production's own
  // `refractPlaceholderMaterial` fallback (`water-surface-subsystem.js`)
  // for the same reason: `THREE.Mesh` always wants a real material object.
  const meshRefract = Object.assign(new THREE.Mesh(geometry, surface.refractMaterial ?? new THREE.NodeMaterial()), {
    renderOrder: 0.52,
    frustumCulled: false,
    visible: !!surface.refractMaterial,
  });
  const scene = new THREE.Scene();
  scene.add(meshAbsorb, meshInscatter, meshRefract);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  /** The renderer-global MRT base every `render()` call scopes in and out —
   * see the import comment above. Built once (it references `TSL.output`, a
   * stable symbolic node), matching `buildSceneAttrZeroMrt`'s own doc. */
  const waterZeroMrt = buildSceneAttrZeroMrt(THREE);
  let rt = null;
  let quadWorld = null;
  let orientationFlip = false;

  /** @param {number} n */
  function applyDebugChannel(n) {
    const showDebug = n > 0;
    meshAbsorb.visible = !showDebug;
    meshInscatter.material = showDebug ? surface.debugMaterial : surface.inscatterMaterial;
    meshInscatter.visible = true;
    meshRefract.visible = !showDebug && !!surface.refractMaterial;
  }

  /** The camera rect currently on screen — zoom 1 is the whole world rect. */
  function viewRect() {
    const cx = (WATER_RECT.minX + WATER_RECT.maxX) / 2;
    const cy = (WATER_RECT.minY + WATER_RECT.maxY) / 2;
    const halfW = ((WATER_RECT.maxX - WATER_RECT.minX) / 2) * state.zoom;
    const halfH = ((WATER_RECT.maxY - WATER_RECT.minY) / 2) * state.zoom;
    return { minX: cx - halfW, minY: cy - halfH, maxX: cx + halfW, maxY: cy + halfH };
  }

  /**
   * Paint a mask (the river by default), upload it, measure its world AABB,
   * crop the quad to it, and re-point every consumer that samples it —
   * `water-surface-subsystem.js#ensureMaskImage` + the geometry crop from
   * `sync()`'s own bake handler, in one function since this bench has no
   * per-frame poll to spread them across.
   * @param {(u:number,v:number)=>number[]} [paint]
   */
  function applyFixture(paint = paintRiver) {
    const { data, w, h } = rasterMask(paint);
    let minU = 1;
    let minV = 1;
    let maxU = 0;
    let maxV = 0;
    let painted = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        // R alone — water's mask channel convention (`water-body.js` header:
        // "R depth AND presence"), never max(r,g,b) (that is specular's own
        // multi-channel-colour caveat, not water's).
        if (data[i] > 0) {
          painted++;
          const u = (x + 0.5) / w;
          const v = (y + 0.5) / h;
          if (u < minU) minU = u;
          if (u > maxU) maxU = u;
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
        }
      }
    }
    maskTexture.dispose();
    maskTexture = makeTex(data, w, h, WATER_MASK_FILTER);
    // `surface` DOES use plain `.value =` re-pointing, deliberately — its own
    // 'mask'/'inside' debug channels were independently measured correct
    // against this exact re-point pattern (0.886 max, 26.15% coverage
    // matching the painted fraction exactly), so there is real evidence this
    // path is fine for THAT material; only `seed`/`resolve` are rebuilt, per
    // `rebuildBodyMaterials`'s own header.
    surface.maskTexNode.value = maskTexture;
    rebuildBodyMaterials();

    const spanX = WATER_RECT.maxX - WATER_RECT.minX;
    const spanY = WATER_RECT.maxY - WATER_RECT.minY;
    quadWorld =
      painted > 0
        ? {
            minX: WATER_RECT.minX + minU * spanX,
            minY: WATER_RECT.minY + minV * spanY,
            maxX: WATER_RECT.minX + maxU * spanX,
            maxY: WATER_RECT.minY + maxV * spanY,
          }
        : null;
    if (quadWorld) {
      geometry.getAttribute('position').array.set(
        buildQuadPositions([
          { x: quadWorld.minX, y: quadWorld.minY },
          { x: quadWorld.maxX, y: quadWorld.minY },
          { x: quadWorld.maxX, y: quadWorld.maxY },
          { x: quadWorld.minX, y: quadWorld.maxY },
        ])
      );
      geometry.getAttribute('position').needsUpdate = true;
    }
    // texel size / far distance — the SAME derivation `uploadMask` does,
    // against THIS bench's own fixed grid/rect rather than a mask-authority
    // product.
    bodyMaterials.resolve.setTexelWorld(spanX / floodW, spanY / floodH);
    bodyMaterials.resolve.setFarDistance(Math.hypot(spanX, spanY));
    return { paintedFraction: painted / (w * h), quadWorld };
  }

  function pushLook() {
    surface.setTint(state.tint);
    surface.setOpacity(state.opacity);
    surface.setAbsorption(state.absorption);
    surface.setDepthScalePx(state.depthScalePx);
    surface.setInscatter(state.inscatter);
    surface.setWaveScalePx(state.waveScalePx);
    surface.setFlowSpeedPx(state.flowSpeedPx);
    surface.setFlowAngleDeg(state.flowAngleDeg);
    surface.setFoam(state.foam);
    surface.setChop(state.chop);
    surface.setWetBandPx(state.wetBandPx);
    surface.setWetStrength(state.wetStrength);
    surface.setSunGlint(state.sunGlint);
    surface.setSkySheen(state.skySheen);
    surface.setGlossiness(state.glossiness);
    surface.setViewerHeight(state.viewerHeight);
    surface.setShadowResponse(state.shadowResponse);
    surface.setSwashFoam(state.swashFoam);
    surface.setBreakFoam(state.breakFoam);
    surface.setCaustics(state.caustics);
    // A real midday sun, roughly SE — `waterKeyLightDirection`, the ONE
    // heading→vector conversion, never hand-rolled trig (this codebase has
    // paid for that Y-flip five times over).
    const dir = waterKeyLightDirection({ elevationDeg: 55, dirX: 0.6, dirY: -0.8 });
    surface.setSky({
      keyDir: dir,
      keyColor: [1, 0.96, 0.88],
      keyStrength: 1,
      fillColor: [0.65, 0.75, 0.9],
      fillStrength: 0.35,
    });
    const v = viewRect();
    surface.setViewCentre((v.minX + v.maxX) / 2, (v.minY + v.maxY) / 2);
    uTimeMs.value = state.timeMs;
    surface.setDebugChannel(state.debugChannel);
    applyDebugChannel(state.debugChannel);
  }

  async function render() {
    if (!rt) {
      rt = new THREE.RenderTarget(SCREEN_DIM, SCREEN_DIM, {
        type: THREE.HalfFloatType, // matches production's HalfFloat colour targets
        format: THREE.RGBAFormat,
        colorSpace: THREE.NoColorSpace,
      });
      // ⚠️ NAMED, VERBATIM — `MRTNode.setup()` matches a struct key against
      // the BOUND target's `textures[i].name` by exact string equality
      // (`scene-attr.js`'s own header); an unnamed texture matches nothing,
      // which is the other half of the empty-struct trap this bench hit live.
      rt.texture.name = 'output';
    }
    pushLook();
    const v = viewRect();
    const f = computeCameraFrustum(v);
    camera.left = f.left;
    camera.right = f.right;
    camera.top = f.top;
    camera.bottom = f.bottom;
    camera.updateProjectionMatrix();

    const prevTarget = renderer.getRenderTarget();
    const prevClear = new THREE.Color();
    renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();
    const previousMRT = renderer.getMRT();
    // The BED this pass draws onto — BLACK for a debug channel (REPLACE
    // blend overwrites the mesh footprint anyway; black outside it reads
    // unambiguously as "no mesh here" rather than a stray bed colour), the
    // real riverbed tone at channel 0.
    const [br, bg, bb] = state.debugChannel > 0 ? [0, 0, 0] : state.bedColor;
    renderer.setClearColor(new THREE.Color(br, bg, bb), 1);
    // SCOPED, NEVER LEFT SET — `scene-attr.js`'s own discipline: save, set,
    // render, restore, so this bench can never leave a stray global MRT
    // behind for whatever renders next (its own body-pack QuadMesh passes,
    // which use plain `fragmentNode` and would silently break under one).
    renderer.setMRT(waterZeroMrt);
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(prevTarget);
    renderer.setMRT(previousMRT);
    renderer.setClearColor(prevClear, prevAlpha);
  }

  /** Whole target, decoded from half-float, row 0 = screen TOP after the
   * one orientation correction `selfTest` calibrates. */
  async function readFrame() {
    const buf = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, SCREEN_DIM, SCREEN_DIM);
    const raw = buf instanceof Promise ? await buf : buf;
    const u16 = raw instanceof Uint16Array ? raw : new Uint16Array(raw.buffer ?? raw);
    const out = new Float32Array(SCREEN_DIM * SCREEN_DIM * 4);
    for (let y = 0; y < SCREEN_DIM; y++) {
      const src = orientationFlip ? SCREEN_DIM - 1 - y : y;
      for (let i = 0; i < SCREEN_DIM * 4; i++) out[y * SCREEN_DIM * 4 + i] = halfToFloat(u16[src * SCREEN_DIM * 4 + i]);
    }
    return out;
  }

  function worldToPixel(wx, wy) {
    const v = viewRect();
    const u = (wx - v.minX) / (v.maxX - v.minX);
    const t = (wy - v.minY) / (v.maxY - v.minY);
    return {
      px: Math.max(0, Math.min(SCREEN_DIM - 1, Math.round(u * (SCREEN_DIM - 1)))),
      py: Math.max(0, Math.min(SCREEN_DIM - 1, Math.round(t * (SCREEN_DIM - 1)))),
    };
  }

  function pixelAt(frame, wx, wy) {
    const { px, py } = worldToPixel(wx, wy);
    const i = (py * SCREEN_DIM + px) * 4;
    return { r: frame[i], g: frame[i + 1], b: frame[i + 2], a: frame[i + 3] };
  }

  /**
   * Mean/max/min/p99/coverage over the PAINTED water AABB. `remapped` swaps
   * the "is there signal" test from "away from 0" to "away from 0.5" — see
   * `REMAPPED`'s own doc above.
   * @param {Float32Array} frame @param {{remapped?: boolean}} [opts]
   */
  function statsOverQuad(frame, { remapped = false } = {}) {
    if (!quadWorld) return null;
    const a = worldToPixel(quadWorld.minX, quadWorld.minY);
    const b = worldToPixel(quadWorld.maxX, quadWorld.maxY);
    const x0 = Math.min(a.px, b.px);
    const x1 = Math.max(a.px, b.px);
    const y0 = Math.min(a.py, b.py);
    const y1 = Math.max(a.py, b.py);
    const samples = [];
    let sum = 0;
    let max = -Infinity;
    let min = Infinity;
    let coverageHits = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * SCREEN_DIM + x) * 4;
        const l = 0.2126 * frame[i] + 0.7152 * frame[i + 1] + 0.0722 * frame[i + 2];
        samples.push(l);
        sum += l;
        if (l > max) max = l;
        if (l < min) min = l;
        const signal = remapped ? Math.abs(l - 0.5) : l;
        if (signal > DEAD_EPS) coverageHits++;
      }
    }
    samples.sort((p, q) => p - q);
    const n = samples.length;
    const p99 = n ? samples[Math.min(n - 1, Math.floor(n * 0.99))] : 0;
    return {
      mean: sum / Math.max(1, n),
      max,
      min,
      p99,
      n,
      coverage: n ? coverageHits / n : 0,
      maxDeviationFromHalf: remapped ? Math.max(Math.abs(max - 0.5), Math.abs(min - 0.5)) : null,
    };
  }

  /**
   * ⚠️ THE HEADLINE INSTRUMENT — every real channel (n=1..18), IN THEIR OWN
   * COMPUTATION ORDER (`water.js#WATER_DEBUG_CHANNELS`'s own header). Read
   * top to bottom: the first CHAIN or REMAPPED row marked DEAD is the term
   * that kills everything below it (`feedback_count_silent_preconditions`).
   */
  async function gateLadder() {
    const restore = state.debugChannel;
    const rows = [];
    try {
      for (const ch of WATER_DEBUG_CHANNELS) {
        if (ch.n === 0) continue;
        const kind = classifyChannel(ch.id);
        state.debugChannel = ch.n;
        await render();
        const frame = await readFrame();
        const s = statsOverQuad(frame, { remapped: kind === 'remapped' });
        if (!s) {
          rows.push({ n: ch.n, id: ch.id, kind, error: 'no painted water AABB — call applyFixture() first' });
          continue;
        }
        const dead = kind === 'remapped' ? s.maxDeviationFromHalf <= DEAD_EPS : kind === 'chain' && s.max <= DEAD_EPS;
        rows.push({
          n: ch.n,
          id: ch.id,
          kind,
          mean: Number(s.mean.toFixed(5)),
          max: Number(s.max.toFixed(5)),
          min: Number(s.min.toFixed(5)),
          p99: Number(s.p99.toFixed(5)),
          coveragePct: Number((s.coverage * 100).toFixed(2)),
          DEAD: kind !== 'info' && dead,
        });
      }
    } finally {
      state.debugChannel = restore;
      await render();
    }
    const firstDead = rows.find((r) => r.DEAD);
    return {
      scenario: state.scenario,
      tier: state.tier,
      rows,
      verdict: firstDead
        ? `FIRST DEAD TERM: '${firstDead.id}' (channel ${firstDead.n}, ${firstDead.kind}) — everything below it is a consequence.`
        : 'no dead term — every factor in the composite is contributing something over the painted river',
    };
  }

  /**
   * ORIENTATION, VERIFIED NOT ASSUMED (`feedback_y_flip_recurring_risk`).
   * Paints a marker mask whose water sits only in the low-world-Y half,
   * renders the `quad` channel (geometry-only — no texture sampling, so it
   * cannot itself be broken by whatever this test is trying to catch), and
   * checks the bright rows land at the world TOP. Restores the real river
   * fixture (and re-bakes it) in `finally`.
   */
  async function selfTest() {
    const savedChannel = state.debugChannel;
    const markerPaint = (_u, v) => (v < 0.45 ? [255, 255, 255, 255] : [0, 0, 0, 0]);
    try {
      applyFixture(markerPaint);
      state.debugChannel = WATER_DEBUG_CHANNELS.find((c) => c.id === 'quad').n;
      await render();
      let frame = await readFrame();
      const top = pixelAt(frame, (WATER_RECT.minX + WATER_RECT.maxX) / 2, WATER_RECT.minY + WATER_RECT.maxY * 0.15);
      const bottom = pixelAt(frame, (WATER_RECT.minX + WATER_RECT.maxX) / 2, WATER_RECT.maxY * 0.85);
      if (!(top.r > 0.5 && bottom.r < 0.5)) {
        orientationFlip = !orientationFlip;
        frame = await readFrame();
        const t2 = pixelAt(frame, (WATER_RECT.minX + WATER_RECT.maxX) / 2, WATER_RECT.minY + WATER_RECT.maxY * 0.15);
        const b2 = pixelAt(frame, (WATER_RECT.minX + WATER_RECT.maxX) / 2, WATER_RECT.maxY * 0.85);
        const ok = t2.r > 0.5 && b2.r < 0.5;
        log?.(`water selfTest: orientation flipped (orientationFlip=${orientationFlip}) -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
      }
      log?.('water selfTest: orientation OK, no flip needed');
      return true;
    } finally {
      state.debugChannel = savedChannel;
      applyFixture(paintRiver);
      bakeBody();
      await render();
    }
  }

  /** Draw the current frame to a canvas, sRGB-encoded — deliberately NOT
   * tonemapped: water draws into `buf:scene.color`, BEFORE light
   * accumulation/grade/tonemap run on it, so the raw linear value here is
   * what THIS layer actually contributes, not what a player would eventually
   * see (unlike specular's own additive `scene.lit` pass, which needs the
   * tonemap context to judge visibility against). */
  async function paint(canvas) {
    const frame = await readFrame();
    if (canvas.width !== SCREEN_DIM || canvas.height !== SCREEN_DIM) {
      canvas.width = SCREEN_DIM;
      canvas.height = SCREEN_DIM;
    }
    const out = new Uint8ClampedArray(SCREEN_DIM * SCREEN_DIM * 4);
    for (let i = 0; i < SCREEN_DIM * SCREEN_DIM; i++) {
      for (let c = 0; c < 3; c++) {
        const lin = Math.max(0, Math.min(1, frame[i * 4 + c]));
        const enc = lin <= 0.0031308 ? lin * 12.92 : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055;
        out[i * 4 + c] = Math.round(enc * 255);
      }
      out[i * 4 + 3] = 255;
    }
    canvas.getContext('2d').putImageData(new ImageData(out, SCREEN_DIM, SCREEN_DIM), 0, 0);
  }

  /** A world-space scanline of final luma, crossing the river perpendicular
   * to its centreline at the pool/island's own `v` — the row with the most
   * going on (both banks, the island's near shore, real break/swash foam
   * candidates), never the arithmetic-middle row.
   * @param {{steps?: number}} [opts] */
  async function profileAcrossPool({ steps = 200 } = {}) {
    const frame = await readFrame();
    const wy = WATER_RECT.minY + ISLAND.v * (WATER_RECT.maxY - WATER_RECT.minY);
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const wx = WATER_RECT.minX + ((WATER_RECT.maxX - WATER_RECT.minX) * i) / steps;
      const p = pixelAt(frame, wx, wy);
      pts.push({ vis: 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b });
    }
    return pts;
  }

  // ── CONTRACT SCENARIOS (AGENTS.md §5) ────────────────────────────────────
  const scenarios = new Map();

  scenarios.set('river-bake-produces-real-sdf', {
    name: 'river-bake-produces-real-sdf',
    summary: 'The REAL JFA bake, run against a synthetic bend+island river, produces a real signed distance field.',
    async run({ runId }) {
      const calOk = await selfTest();
      applyFixture(paintRiver);
      bakeBody();
      state.debugChannel = 0;
      await render();
      const buf = await renderer.readRenderTargetPixelsAsync(bodyRt, 0, 0, floodW, floodH);
      const raw = buf instanceof Promise ? await buf : buf;
      const u16 = raw instanceof Uint16Array ? raw : new Uint16Array(raw.buffer ?? raw);
      let minSigned = Infinity;
      let maxSigned = -Infinity;
      let anyInside = false;
      let anyOutside = false;
      let tangentNonZero = 0;
      let n = 0;
      for (let i = 0; i < floodW * floodH; i++) {
        const r = halfToFloat(u16[i * 4]);
        const ba = halfToFloat(u16[i * 4 + 2]);
        const bb = halfToFloat(u16[i * 4 + 3]);
        if (r < minSigned) minSigned = r;
        if (r > maxSigned) maxSigned = r;
        if (r < 0) anyInside = true;
        if (r > 0) anyOutside = true;
        if (Math.abs(ba) > 1e-3 || Math.abs(bb) > 1e-3) tangentNonZero++;
        n++;
      }
      const png = await saveCanvasPngSafe(runId, 'river-quad.png');
      return {
        calibration: calOk ? 'OK' : 'FAILED',
        checks: [
          evaluate('bake-ran-a-real-flood', () => ({ ok: jfaSteps >= 6, measured: jfaSteps, expected: '>= 6' })),
          evaluate('sdf-has-negative-inside-water', () => ({ ok: anyInside, measured: anyInside, expected: true })),
          evaluate('sdf-has-positive-outside-water', () => ({ ok: anyOutside, measured: anyOutside, expected: true })),
          evaluate('sdf-range-is-plausible-for-this-world', () => ({
            ok: maxSigned > 50 && minSigned < -50 && maxSigned < 6000 && minSigned > -6000,
            measured: { minSigned: Number(minSigned.toFixed(1)), maxSigned: Number(maxSigned.toFixed(1)) },
            expected: 'min < -50, max > 50, both within the world diagonal',
          })),
          evaluate('shore-tangent-is-non-zero-somewhere', () => ({
            ok: tangentNonZero > 0,
            measured: tangentNonZero,
            expected: '> 0',
            note: 'zero everywhere would mean the seed pass found no interface at all',
          })),
        ],
        inputs: { worldRect: WATER_RECT, floodW, floodH, jfaSteps },
        stats: { minSigned, maxSigned, texelsSampled: n, tangentNonZeroTexels: tangentNonZero },
        artifacts: png ? [png] : [],
      };
    },
  });

  scenarios.set('tier4-gate-ladder-no-dead-term', {
    name: 'tier4-gate-ladder-no-dead-term',
    summary: 'Every WATER_DEBUG_CHANNELS term (1-18) shows real signal over the painted river at tier 4.',
    async run({ runId }) {
      const calOk = await selfTest();
      applyFixture(paintRiver);
      bakeBody();
      state.tier = 4;
      const ladder = await gateLadder();
      const png = await saveCanvasPngSafe(runId, 'tier4-composite.png');
      return {
        calibration: calOk ? 'OK' : 'FAILED',
        checks: [
          evaluate('no-dead-chain-or-remapped-term', () => ({
            ok: !ladder.rows.some((r) => r.DEAD),
            measured: ladder.rows.filter((r) => r.DEAD).map((r) => r.id),
            expected: [],
            note: ladder.verdict,
          })),
        ],
        inputs: { tier: state.tier },
        stats: { rows: ladder.rows, verdict: ladder.verdict },
        artifacts: png ? [png] : [],
      };
    },
  });

  scenarios.set('shore-foam-has-real-coverage', {
    name: 'shore-foam-has-real-coverage',
    summary:
      "The specific bug this instrument was built to end — 'no sign of additional shoreline foam' — as a repeatable check.",
    async run({ runId }) {
      const calOk = await selfTest();
      applyFixture(paintRiver);
      bakeBody();
      state.tier = 4;
      state.debugChannel = WATER_DEBUG_CHANNELS.find((c) => c.id === 'totalFoam').n;
      await render();
      const totalFoamStats = statsOverQuad(await readFrame());
      state.debugChannel = WATER_DEBUG_CHANNELS.find((c) => c.id === 'breakFoam').n;
      await render();
      const breakFoamStats = statsOverQuad(await readFrame());
      state.debugChannel = 0;
      await render();
      const png = await saveCanvasPngSafe(runId, 'shore-foam.png');
      return {
        calibration: calOk ? 'OK' : 'FAILED',
        checks: [
          evaluate('total-foam-covers-a-real-fraction-of-the-river', () => ({
            ok: totalFoamStats.coverage > 0.02,
            measured: Number((totalFoamStats.coverage * 100).toFixed(2)),
            expected: '> 2%',
            note: 'a river with real bends and an island should show foam along a visible fraction of its banks',
          })),
          evaluate('total-foam-peak-is-not-negligible', () => ({
            ok: totalFoamStats.max > 0.1,
            measured: Number(totalFoamStats.max.toFixed(4)),
            expected: '> 0.1',
          })),
          evaluate('break-foam-fires-on-the-island-and-outer-banks', () => ({
            ok: breakFoamStats.max > 0.05,
            measured: Number(breakFoamStats.max.toFixed(4)),
            expected: '> 0.05',
            note: 'the island sits mid-current on purpose — its upstream face is the clearest break-foam case in this fixture',
          })),
        ],
        inputs: { tier: state.tier, flowAngleDeg: state.flowAngleDeg, flowSpeedPx: state.flowSpeedPx },
        stats: { totalFoam: totalFoamStats, breakFoam: breakFoamStats },
        artifacts: png ? [png] : [],
      };
    },
  });

  scenarios.set('tier5-refraction-does-not-capture-itself', {
    name: 'tier5-refraction-does-not-capture-itself',
    summary:
      "THE SELF-CAPTURE FIX (2026-08-23, water-render.js#WATER_TIER5_DISABLED_PENDING_SELF_CAPTURE_FIX's " +
      'own doc has the live-reported bug). Mesh 3 (refraction) now draws in its OWN scene, in its own pass, ' +
      "AFTER water-refraction-subsystem.js's own capture — never inside `scene` itself, so it can never be " +
      'baked into what the capture reads. Proof: over a STATIC fixture (fixed camera, fixed params, no ' +
      "animation), the captured content read back BEFORE mesh 3's own draw must be byte-identical every " +
      'single iteration of a real capture-then-draw loop — a genuinely excluded mesh cannot make the ' +
      'thing that excludes it drift, no matter how many times the loop runs. Under the OLD, buggy ' +
      "architecture (mesh 3 sharing `scene`) this same check would fail: mesh 3's own chromatically- " +
      'fringed output would be captured, re-fringed, and blended back in again every single iteration.',
    async run({ runId }) {
      const calOk = await selfTest();
      applyFixture(paintRiver);
      bakeBody();
      state.tier = 5;
      state.sunGlint = 2;
      state.chop = 0.86;
      state.debugChannel = 0;

      // ⚠️ `meshRefract` is a SHARED object, constructed once at bench
      // startup and left permanently inside the shared `scene` (matching
      // this file's own general "one bench, one scene, one everything"
      // shape — see the module header). Pulling it OUT here, into a
      // scenario-local `refractScene`, and putting it BACK before this
      // scenario returns, is what keeps this from corrupting any OTHER
      // scenario that runs later in the same bench instance.
      const wasInScene = meshRefract.parent === scene;
      if (wasInScene) scene.remove(meshRefract);
      const refractScene = new THREE.Scene();
      refractScene.add(meshRefract);

      // A REAL `createWaterRefractionSubsystem`, own local allocator — same
      // minimal-allocator shape `real-underground-river-flow`'s own
      // `localAllocator` already proves out for a sibling subsystem, never
      // the shared bench-wide allocator (this scenario owns its targets
      // outright and disposes them itself, below).
      const localAllocator = {
        create(name, descriptor) {
          const filter = descriptor.filter === 'linear' ? THREE.LinearFilter : THREE.NearestFilter;
          const target = new THREE.RenderTarget(descriptor.resolvedW, descriptor.resolvedH, {
            type: descriptor.type,
            format: descriptor.format,
            colorSpace: descriptor.colorSpace,
            depthBuffer: !!descriptor.depth,
            minFilter: filter,
            magFilter: filter,
          });
          target.texture.name = name;
          return target;
        },
        dispose(target) {
          target?.dispose?.();
        },
      };
      const refraction = createWaterRefractionSubsystem({
        THREE,
        allocator: localAllocator,
        renderWaterPass: renderQuadPass,
      });

      const v = viewRect();
      const ITERATIONS = 6;
      const preDrawFrames = [];
      for (let i = 0; i < ITERATIONS; i++) {
        // HALF ONE — the geometry pass equivalent: mesh 1 + mesh 2 ONLY,
        // freshly cleared (`render()`'s own default autoClear), since
        // `meshRefract` no longer lives in `scene` at all.
        await render();
        // HALF TWO — the capture, reading THIS iteration's just-drawn,
        // mesh-3-free `rt`.
        refraction.tick({
          bodyRect: quadWorld,
          viewRect: v,
          canvasW: rt.width,
          canvasH: rt.height,
          sceneColorTexture: rt.texture,
        });
        // Read back BEFORE mesh 3 draws — THIS is "what got captured this
        // iteration". A static fixture (no time/camera change across the
        // loop) means this must read the SAME every time, if and only if
        // nothing from a PRIOR iteration's mesh-3 draw leaked into it.
        preDrawFrames.push(await readFrame());

        // Re-point tier 5's own taps + rect/size — the SAME thing
        // `water-surface-subsystem.js#syncCapturedRefraction` does in
        // production, transcribed here (this bench builds
        // `buildWaterSurfaceMaterial` directly, never through that
        // subsystem — see the module header's own §6 rule on why real
        // production code is imported, not re-implemented, everywhere
        // ELSE in this file; this one small piece genuinely has no
        // subsystem-level home to import from without dragging in a real
        // mask/body dependency graph this scenario doesn't otherwise need).
        for (const node of surface.capturedTexNodes) node.value = refraction.texture;
        if (Number.isFinite(refraction.width) && Number.isFinite(refraction.height)) {
          surface.setCapturedTexSize?.(refraction.width, refraction.height);
        }
        if (refraction.capturedRect) surface.setCapturedRect?.(refraction.capturedRect);

        // HALF THREE — the draw, mirroring `vt-pan-viewer.js#
        // runWaterRefractionCapturePass`'s own save/set/restore exactly:
        // same target, same MRT base, NO clear (lands on top of what HALF
        // ONE already put there this iteration).
        const prevTarget = renderer.getRenderTarget();
        const prevMrt = renderer.getMRT();
        const prevAutoClearColor = renderer.autoClearColor;
        renderer.setMRT(waterZeroMrt);
        renderer.setRenderTarget(rt);
        renderer.autoClearColor = false;
        renderer.render(refractScene, camera);
        renderer.autoClearColor = prevAutoClearColor;
        renderer.setRenderTarget(prevTarget);
        renderer.setMRT(prevMrt);
      }

      let maxDiff = 0;
      for (let i = 1; i < preDrawFrames.length; i++) {
        const a = preDrawFrames[0];
        const b = preDrawFrames[i];
        for (let p = 0; p < a.length; p++) {
          const d = Math.abs(a[p] - b[p]);
          if (d > maxDiff) maxDiff = d;
        }
      }
      const png = await saveCanvasPngSafe(runId, 'tier5-self-capture-fix.png');

      // Cleanup — `meshRefract` goes back where every OTHER scenario in
      // this bench expects to find it. `refraction.dispose()` frees its
      // OWN capture target through `localAllocator` itself — nothing else
      // to tear down here.
      refractScene.remove(meshRefract);
      if (wasInScene) scene.add(meshRefract);
      refraction.dispose?.();

      return {
        calibration: calOk ? 'OK' : 'FAILED',
        checks: [
          evaluate('captured-content-is-stable-across-a-real-capture-then-draw-loop', () => ({
            ok: maxDiff < 1e-3,
            measured: Number(maxDiff.toFixed(6)),
            expected: '< 0.001 (float tolerance — exact 0 across a real GPU pipeline is not a safe bar)',
            note:
              'nonzero means mesh 3 (refraction) is STILL reaching what gets captured for its own next ' +
              'read — the self-capture fix did not take, or regressed',
          })),
        ],
        inputs: { tier: state.tier, iterations: ITERATIONS, chop: state.chop, sunGlint: state.sunGlint },
        stats: { maxDiff, iterations: ITERATIONS },
        artifacts: png ? [png] : [],
      };
    },
  });

  // ══════════════════════════════════════════════════════════════════════════
  // REAL-MAP SCENARIO (2026-08-18) — see this file's own module comment on
  // `loadMaskImageTexture`/`TOWER_BRIDGE`/`createWaterFlowSubsystem` above.
  //
  // WHY THIS EXISTS: two live rounds on channel 22/23 were diagnosed from the
  // author's own screenshots and both diagnoses were WRONG — the first
  // ("solidity undersampling") was a real bug but explained nothing the
  // author actually saw; the second ("a debug colour painting over a room
  // and a loom") invented geometry that was never in the picture at all —
  // the author was looking at the real river the whole time. The author's
  // own correction: *"YOU HAVE THE FILES for this map... You could be using
  // those and the shader lab to actually make this work yourself."* This
  // scenario is that — the REAL Underground `_Water` mask, the REAL S2+S3
  // bake, the REAL surface material with a REAL `flowPackTexture` wired in
  // from construction (never a placeholder), read back on a real GPU.
  //
  // Deliberately a SEPARATE render pipeline (own targets/camera/scene/
  // material) rather than retrofitting the shared `surface`/`WATER_RECT`
  // above — those are shared, frozen-rect, 4000² synthetic-scale state every
  // OTHER scenario in this file depends on; a 10650×4950 real map has no
  // business mutating them mid-suite.
  // ══════════════════════════════════════════════════════════════════════════
  scenarios.set('real-underground-river-flow', {
    name: 'real-underground-river-flow',
    summary:
      'The REAL createWaterFlowSubsystem bake against the REAL Tower Bridge Underground _Water mask, ' +
      'then the REAL buildWaterSurfaceMaterial with a REAL flowPackTexture wired in at construction — ' +
      'reads back channel 22/23 pixels and saves PNGs, on a real GPU, against real art.',
    async run({ runId }) {
      // ── LOAD THE REAL MASK — the same `loadMaskImageTexture` production
      // itself calls, never a bench-local re-decode. 0.1 lands close to
      // WATER_FLOW_GRID_MAX_DIM's own 1024px cap (10650 × 0.1 ≈ 1065), so the
      // flow solve sees essentially the same effective detail a live scene's
      // OWN internal 1024-cap would hand it, without decoding the full 52.7 M
      // texel original (AGENTS.md §7's own cost warning).
      const scale = 0.1;
      const maskRes = await loadMaskImageTexture({
        url: `${TOWER_BRIDGE.dir}/Tower_Bridge_Underground_Water.webp`,
        THREE,
        scale,
        channels: 'r',
      });
      if (!maskRes) {
        return {
          calibration: 'FAILED',
          checks: [
            evaluate('real-mask-loads', () => ({
              ok: false,
              measured: 'fetch/decode failed',
              expected: 'a real texture',
            })),
          ],
          inputs: { scale },
          stats: {},
          artifacts: [],
        };
      }
      const { texture: realMaskTexture, data: maskBytes, width: mw, height: mh, contentBounds } = maskRes;
      if (!contentBounds) {
        return {
          calibration: 'FAILED',
          checks: [
            evaluate('real-mask-has-content', () => ({
              ok: false,
              measured: 'no painted texels',
              expected: 'a real river',
            })),
          ],
          inputs: { scale, mw, mh },
          stats: {},
          artifacts: [],
        };
      }
      // `worldRect` = the mask's OWN full grid rect — what `waterBody.getRect()`
      // returns in production (`water-body-subsystem.js#getRect`, "the mask
      // grid's own rect"), one mask texel = one world px on this fixture
      // (`fixtures/tower-bridge.js#WORLD_RECT`'s own doc). `waterBounds` = the
      // TIGHT painted-water AABB (`getWaterBounds()` in production) — what the
      // real mesh geometry crops to (Law 6), a SMALLER rect nested inside
      // `worldRect`, never the other way round.
      const worldRect = { minX: 0, minY: 0, maxX: TOWER_BRIDGE.native.width, maxY: TOWER_BRIDGE.native.height };
      const spanX = worldRect.maxX - worldRect.minX;
      const spanY = worldRect.maxY - worldRect.minY;
      const waterBounds = {
        minX: worldRect.minX + contentBounds.minU * spanX,
        minY: worldRect.minY + contentBounds.minV * spanY,
        maxX: worldRect.minX + contentBounds.maxU * spanX,
        maxY: worldRect.minY + contentBounds.maxV * spanY,
      };

      // ── FIND THE PIERS BY SCANNING THE REAL PIXELS, never a guessed
      // coordinate (`findRealArtRegion`'s own discipline, AGENTS.md §10) — a
      // texel strictly inside the tight water AABB reading R=0 cannot be the
      // outer land bank (that is, by construction, outside `contentBounds`
      // entirely); it can only be an obstacle island inside the channel.
      const x0 = Math.max(0, Math.floor(contentBounds.minU * mw));
      const x1 = Math.min(mw, Math.ceil(contentBounds.maxU * mw));
      const y0 = Math.max(0, Math.floor(contentBounds.minV * mh));
      const y1 = Math.min(mh, Math.ceil(contentBounds.maxV * mh));
      let sumX = 0;
      let sumY = 0;
      let solidTexels = 0;
      let waterTexels = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const r = maskBytes[y * mw + x];
          if (r === 0) {
            sumX += x;
            sumY += y;
            solidTexels++;
          } else {
            waterTexels++;
          }
        }
      }
      const pierCentre =
        solidTexels > 0
          ? {
              wx: worldRect.minX + ((sumX / solidTexels + 0.5) / mw) * spanX,
              wy: worldRect.minY + ((sumY / solidTexels + 0.5) / mh) * spanY,
            }
          : { wx: (waterBounds.minX + waterBounds.maxX) / 2, wy: (waterBounds.minY + waterBounds.maxY) / 2 };

      // ── THE REAL FLOW BAKE — `createWaterFlowSubsystem`, unmodified, with a
      // MINIMAL local allocator (a bare `THREE.RenderTarget` per descriptor,
      // no VRAM-budget bookkeeping — this bench owns its own targets outright,
      // same choice `bodyRt`/`jfaPingRt` above already make). Tracks the LAST
      // target named `*.pack` it creates: `buildLevel` builds levels coarsest-
      // to-finest, so the finest level's own pack — `flow.texture`'s own
      // getter target — is always created last, with no need to import the
      // level-count constant just to spell its name.
      let finestPackRt = null;
      const localAllocator = {
        create(name, descriptor) {
          const filter = descriptor.filter === 'linear' ? THREE.LinearFilter : THREE.NearestFilter;
          const rt = new THREE.RenderTarget(descriptor.resolvedW, descriptor.resolvedH, {
            type: descriptor.type,
            format: descriptor.format,
            colorSpace: descriptor.colorSpace,
            depthBuffer: !!descriptor.depth,
            minFilter: filter,
            magFilter: filter,
          });
          rt.texture.name = name;
          if (name.endsWith('.pack')) finestPackRt = rt;
          return rt;
        },
        dispose(rt) {
          rt?.dispose?.();
        },
      };
      const bearingDeg = WATER_TIER2_FLOW_ANGLE_DEG; // 180 — this project's own documented "downstream" default
      const flow = createWaterFlowSubsystem({
        THREE,
        allocator: localAllocator,
        waterSurface: { getFullResMaskTexture: () => realMaskTexture },
        waterBody: { getRect: () => worldRect },
        renderWaterPass: renderQuadPass,
        createFlowTexture: (data, w, h, filter) => makeTex(data, w, h, filter),
        getWaterRenderState: () => ({ params: { flowAngleDeg: bearingDeg } }),
      });
      flow.maybeBake();
      const flowStatus = flow.getStatus();

      // ── RAW READBACK OF THE FINEST PACK — decoupled from the surface
      // material / `inRect` / debug-channel-select layer entirely. Answers
      // "does the SOLVE itself produce sane, spatially-varying numbers
      // against real geometry" on its own, before the display layer is even
      // involved. FloatType targets (`water-flow-subsystem.js#buildLevel`'s
      // own `describe()`) read back as `Float32Array` directly — no
      // half-float decode needed, unlike `bodyRt` above.
      let rawStats = null;
      if (finestPackRt) {
        const gw = finestPackRt.width;
        const gh = finestPackRt.height;
        const buf = await renderer.readRenderTargetPixelsAsync(finestPackRt, 0, 0, gw, gh);
        const raw = buf instanceof Promise ? await buf : buf;
        const f32 = raw instanceof Float32Array ? raw : new Float32Array(raw.buffer ?? raw);
        let minSpeed = Infinity;
        let maxSpeed = -Infinity;
        let sumSpeed = 0;
        let solidCount = 0;
        let openCount = 0;
        const n = gw * gh;
        for (let i = 0; i < n; i++) {
          const b = f32[i * 4 + 2]; // speed01
          const a = f32[i * 4 + 3]; // solidity
          if (b < minSpeed) minSpeed = b;
          if (b > maxSpeed) maxSpeed = b;
          sumSpeed += b;
          if (a > 0.5) solidCount++;
          else openCount++;
        }
        rawStats = {
          grid: `${gw}x${gh}`,
          minSpeed: Number(minSpeed.toFixed(4)),
          maxSpeed: Number(maxSpeed.toFixed(4)),
          meanSpeed: Number((sumSpeed / n).toFixed(4)),
          solidFraction: Number((solidCount / n).toFixed(4)),
          openFraction: Number((openCount / n).toFixed(4)),
        };
      }

      // ── THE REAL SURFACE MATERIAL — built against the SAME 1×1 all-zero
      // placeholder `water-surface-subsystem.js#flowPackPlaceholder` uses,
      // THEN re-pointed via `.value =` exactly like `setFlowPackTexture`
      // does — LIVE REGRESSION, 2026-08-18: the FIRST version of this
      // scenario wired `flow.texture` in at CONSTRUCTION, which never
      // exercises re-pointing AT ALL and therefore never caught the bug
      // where the `inRect` gate silently broke it (`texture(...).mul(...)`
      // assigned back onto `flowPackTexNode` returns a derived node with no
      // real `.value` setter — see `water-render.js`'s own header on this
      // exact line for the full mechanism). Own scene/camera/target: this
      // must NOT touch the shared `surface`/`scene`/meshes above.
      //
      // Own independent uniform/texture nodes, not the shared
      // `uTimeMs`/`uViewRect`/`uOutdoorsRect`/`outdoorsTexNode` above — this
      // was chased as a suspect while hunting the real bug below (an
      // isolated two-material repro sharing nodes DID appear to reproduce a
      // dead re-point) but proved to be a confound, not the cause: that
      // repro also happened to carry the real bug (`bodyTexture: null` at
      // tier 4). Kept anyway on its own merits — production never shares
      // these across floors either, so a bench that does is testing a shape
      // that cannot occur live.
      const flowPlaceholder = makeTex(new Uint8Array([0, 0, 0, 0]), 1, 1, 'linear');
      const { uniform: uniformFn, vec4: vec4Fn } = THREE.TSL;
      const realTimeMs = uniformFn(0);
      const realViewRect = uniformFn(vec4Fn(worldRect.minX, worldRect.minY, worldRect.maxX, worldRect.maxY));
      const realOutdoorsRect = uniformFn(vec4Fn(worldRect.minX, worldRect.minY, worldRect.maxX, worldRect.maxY));
      const realOutdoorsTexNode = texture(makeTex(new Uint8Array([255, 255, 255, 255]), 1, 1, 'nearest'));
      // ⚠️ NEVER `null` AT TIER 4 — a real, live root cause found only by
      // finally reading the console for a `NodeError` it silently threw.
      // `bodyTexture: null` is a valid, DOCUMENTED shape (`bodyTexNode`
      // compiles out below tier 1 — Law 4), but tier 4's own shore-foam tail
      // (`buildWaterShoreFoam`'s `sampleBodyAt`) captures this SAME
      // `bodyTexture` argument and unconditionally calls
      // `texture(bodyTexture, …)` at BUILD time whenever `sampleBodyAt` is
      // supplied at all — which `water-render.js` always supplies once
      // `activeTier >= 4`, regardless of whether a real body texture exists.
      // `texture(null, …)` throws `NodeError: texture(value) expects a
      // valid instance of THREE.Texture` repeatedly, and the material that
      // failed to fully construct reads back as black — which looked
      // exactly like a re-pointing regression and cost a very long detour
      // chasing that theory instead.
      //
      // A STUB alone would stop the throw but leaves shore-foam's OWN
      // inputs (shoreDist, the shore tangent) degenerate — swash/break/
      // streak would compile and render, over genuinely wrong data, which
      // is not what "see some real results" asked for. So: THE REAL JFA
      // BODY-PACK BAKE, against the REAL mask — the exact SEED→JFA-STEPS→
      // RESOLVE sequence `bakeBody()` above already runs for the synthetic
      // river, mirrored here rather than re-derived, at the mask's own
      // already-loaded resolution (no reason to flood at a different scale
      // than the flow grid already uses).
      const realFloodW = mw;
      const realFloodH = mh;
      const realRtDescribe = (filter) => ({
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.NoColorSpace,
        depthBuffer: false,
        minFilter: filter,
        magFilter: filter,
      });
      const realJfaPingRt = new THREE.RenderTarget(realFloodW, realFloodH, realRtDescribe(THREE.NearestFilter));
      const realJfaPongRt = new THREE.RenderTarget(realFloodW, realFloodH, realRtDescribe(THREE.NearestFilter));
      const realBodyRt = new THREE.RenderTarget(realFloodW, realFloodH, realRtDescribe(THREE.LinearFilter));
      for (const rt of [realJfaPingRt, realJfaPongRt, realBodyRt]) {
        rt.texture.wrapS = THREE.ClampToEdgeWrapping;
        rt.texture.wrapT = THREE.ClampToEdgeWrapping;
      }
      const realJfaSteps = jfaStepCount(realFloodW, realFloodH);
      const realSeed = buildWaterSeedMaterial({
        THREE,
        maskTexture: realMaskTexture,
        width: realFloodW,
        height: realFloodH,
      });
      const realJfa = buildWaterJfaStepMaterial({
        THREE,
        prevTexture: realJfaPingRt.texture,
        width: realFloodW,
        height: realFloodH,
      });
      const realResolve = buildWaterBodyResolveMaterial({
        THREE,
        jfaTexture: realJfaPingRt.texture,
        maskTexture: realMaskTexture,
        texelWorldW: spanX / realFloodW,
        texelWorldH: spanY / realFloodH,
        farDistancePx: Math.hypot(spanX, spanY),
      });
      renderQuadPass(realJfaPingRt, realSeed.quad);
      let realReadFromPing = true;
      for (let i = 0; i < realJfaSteps; i++) {
        const src = realReadFromPing ? realJfaPingRt : realJfaPongRt;
        const dst = realReadFromPing ? realJfaPongRt : realJfaPingRt;
        realJfa.uStride.value = jfaStrideForStep(i, realJfaSteps);
        for (const node of realJfa.prevTexNodes) node.value = src.texture;
        renderQuadPass(dst, realJfa.quad);
        realReadFromPing = !realReadFromPing;
      }
      realResolve.jfaTexNode.value = (realReadFromPing ? realJfaPingRt : realJfaPongRt).texture;
      renderQuadPass(realBodyRt, realResolve.quad);

      const realSurface = buildWaterSurfaceMaterial({
        THREE,
        maskTexture: realMaskTexture,
        maskRect: worldRect,
        bodyTexture: realBodyRt.texture,
        bodyRect: worldRect,
        bodyTexSize: [realFloodW, realFloodH],
        timeMsNode: realTimeMs,
        uViewRect: realViewRect,
        uOutdoorsRect: realOutdoorsRect,
        outdoorsTexNode: realOutdoorsTexNode,
        buildOutdoorsGate: buildWorldSpaceOutdoorsGate,
        // Placeholder-then-repoint, exactly like `setFlowPackTexture` — see
        // the repoint test just after this material is built, below.
        flowPackTexture: flowPlaceholder,
        // `waterSimTexture` (S5, 2026-08-18): this scenario is about the FLOW
        // pack specifically (see its own module comment) — a plain "no foam"
        // placeholder, never re-pointed, is enough so the unconditional
        // `texture(waterSimTexture, …)` read has a real object to sample.
        // The SIM pack's own render-path proof lives in the
        // `real-underground-river-sim` scenario below instead.
        waterSimTexture: makeTex(new Uint8Array([0, 0, 0, 0]), 1, 1, 'linear'),
        // TIER 4 — S4 (2026-08-18) needs swash/break/streak to actually
        // compile and run so this scenario can render the REAL visible
        // water look, not only the debug channels. Tier is independent of
        // the debug material's own visibility (`water-render.js`'s own
        // "un-gated by tier" note), so this does not change anything about
        // the debug-channel checks already below.
        tier: 4,
        debugChannel: 0,
      });
      const realGeometry = new THREE.BufferGeometry();
      realGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
      realGeometry.setIndex(Array.from(QUAD_INDICES));
      realGeometry.setAttribute(
        'position',
        new THREE.BufferAttribute(
          buildQuadPositions([
            { x: waterBounds.minX, y: waterBounds.minY },
            { x: waterBounds.maxX, y: waterBounds.minY },
            { x: waterBounds.maxX, y: waterBounds.maxY },
            { x: waterBounds.minX, y: waterBounds.maxY },
          ]),
          3
        )
      );
      // TWO MESHES, SAME GEOMETRY — the shared `surface` above's own shape
      // (`meshAbsorb`/`meshInscatter`), not a third mesh added alongside it.
      // S4 (2026-08-18) tried a third `debugMaterial` mesh sharing the scene
      // with `absorb`+`inscatter`, visibility-toggled, and it broke
      // `flowPackTexNode`'s own re-point (proven NOT a node-identity bug —
      // an isolated JS-level check showed `.value` reassignment working
      // perfectly — something about THREE's own WebGPU render-list/pipeline
      // caching across three co-resident materials, never fully chased down
      // since the fix was cheap and this shape is already proven safe by
      // every OTHER scenario in this file). `meshInscatter`'s own MATERIAL
      // swaps between `inscatterMaterial` and `debugMaterial` instead —
      // `applyDebugChannel` above is the exact precedent this mirrors.
      const realMeshAbsorb = Object.assign(new THREE.Mesh(realGeometry, realSurface.absorbMaterial), {
        renderOrder: 0.5,
        frustumCulled: false,
      });
      const realMeshInscatter = Object.assign(new THREE.Mesh(realGeometry, realSurface.inscatterMaterial), {
        renderOrder: 0.51,
        frustumCulled: false,
      });
      const realScene = new THREE.Scene();
      realScene.add(realMeshAbsorb, realMeshInscatter);
      const realCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
      const DEBUG_DIM = 512;
      const debugRt = new THREE.RenderTarget(DEBUG_DIM, DEBUG_DIM, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.NoColorSpace,
      });
      debugRt.texture.name = 'output';

      /** Shared render core — camera framing + save/bind/render/restore, the
       * SAME triplet the shared `render()` above uses. Callers set mesh
       * visibility and clear colour themselves first.
       * @param {{minX:number,minY:number,maxX:number,maxY:number}} view
       * @returns {Promise<Uint8Array>} RGBA bytes, `DEBUG_DIM`² — orientation
       * NOT calibrated (a diagnostic readback; the PNG is read directly to
       * settle orientation by eye, per AGENTS.md §4). */
      async function renderRealCore(view) {
        const f = computeCameraFrustum(view);
        realCamera.left = f.left;
        realCamera.right = f.right;
        realCamera.top = f.top;
        realCamera.bottom = f.bottom;
        realCamera.updateProjectionMatrix();
        const prevTarget = renderer.getRenderTarget();
        const previousMRT = renderer.getMRT();
        renderer.setMRT(waterZeroMrt); // NOT optional — AGENTS.md §10, `debugMaterial.mrtNode` needs the renderer-global base to merge into
        renderer.setRenderTarget(debugRt);
        renderer.render(realScene, realCamera);
        renderer.setRenderTarget(prevTarget);
        renderer.setMRT(previousMRT);
        const buf = await renderer.readRenderTargetPixelsAsync(debugRt, 0, 0, DEBUG_DIM, DEBUG_DIM);
        const raw = buf instanceof Promise ? await buf : buf;
        return raw instanceof Uint8Array ? raw : new Uint8Array(raw.buffer ?? raw);
      }

      /** @param {{minX:number,minY:number,maxX:number,maxY:number}} view @param {number} channel */
      async function renderRealChannel(view, channel) {
        realSurface.setDebugChannel(channel);
        realMeshAbsorb.visible = false;
        realMeshInscatter.material = realSurface.debugMaterial;
        const prevClear = new THREE.Color();
        renderer.getClearColor(prevClear);
        const prevAlpha = renderer.getClearAlpha();
        renderer.setClearColor(new THREE.Color(0, 0, 0), 1); // black bed — REPLACE-blend debug material overwrites its own footprint anyway
        const bytes = await renderRealCore(view);
        renderer.setClearColor(prevClear, prevAlpha);
        return bytes;
      }

      /** S4 (2026-08-18) — the REAL visible water, absorb+inscatter, over a
       * riverbed tone (not black — this is what the composite actually
       * looks like against something, the same reasoning the shared bench's
       * own `state.bedColor` uses).
       * @param {{minX:number,minY:number,maxX:number,maxY:number}} view */
      async function renderRealWaterLook(view) {
        realSurface.setDebugChannel(0);
        realMeshAbsorb.visible = true;
        realMeshInscatter.material = realSurface.inscatterMaterial;
        const prevClear = new THREE.Color();
        renderer.getClearColor(prevClear);
        const prevAlpha = renderer.getClearAlpha();
        renderer.setClearColor(new THREE.Color(0.32, 0.25, 0.16), 1); // the shared bench's own riverbed tone
        const bytes = await renderRealCore(view);
        renderer.setClearColor(prevClear, prevAlpha);
        return bytes;
      }

      /** @param {Uint8Array} bytes @param {string} runId @param {string} file */
      async function savePng(bytes, runId, file) {
        try {
          const { saveCanvasPng } = await import('./contract.js');
          const canvas = document.createElement('canvas');
          canvas.width = DEBUG_DIM;
          canvas.height = DEBUG_DIM;
          const ctx = canvas.getContext('2d');
          const imgData = ctx.createImageData(DEBUG_DIM, DEBUG_DIM);
          imgData.data.set(bytes);
          ctx.putImageData(imgData, 0, 0);
          return await saveCanvasPng(runId, file, canvas);
        } catch {
          return null;
        }
      }

      // FRAME A — tight on the piers (data-found centre), real-world scale,
      // to see routing detail. FRAME B — the whole water AABB plus a 40%
      // margin beyond it on every side, specifically to test whether the
      // `inRect` gate (2026-08-18 fix) shows real colour INSIDE the water and
      // clean black OUTSIDE it — the exact question the author's "entirely
      // black" report raises.
      const pierSpan = Math.max(200, (waterBounds.maxX - waterBounds.minX) * 0.25);
      const frameA = {
        minX: pierCentre.wx - pierSpan,
        minY: pierCentre.wy - pierSpan,
        maxX: pierCentre.wx + pierSpan,
        maxY: pierCentre.wy + pierSpan,
      };
      const marginX = (waterBounds.maxX - waterBounds.minX) * 0.4;
      const marginY = (waterBounds.maxY - waterBounds.minY) * 0.4;
      const frameB = {
        minX: waterBounds.minX - marginX,
        minY: waterBounds.minY - marginY,
        maxX: waterBounds.maxX + marginX,
        maxY: waterBounds.maxY + marginY,
      };

      function sampleCentre(bytes) {
        const px = Math.floor(DEBUG_DIM * 0.5);
        const py = Math.floor(DEBUG_DIM * 0.5);
        const i = (py * DEBUG_DIM + px) * 4;
        return { r: bytes[i], g: bytes[i + 1], b: bytes[i + 2], a: bytes[i + 3] };
      }

      // ── THE RE-POINT ITSELF, PROVEN — render ONCE against the placeholder
      // (must read black — "not baked yet", the honest default), THEN call
      // the EXACT line `setFlowPackTexture` calls in production
      // (`surface.flowPackTexNode.value = t`), THEN render the SAME frame
      // again and demand the SAME pixel changed. This is the one check nulls
      // out silently if `flowPackTexNode` is ever again a derived expression
      // instead of a real texture node — a broken re-point makes BOTH
      // readings identical (both black), which is exactly the live symptom.
      const preRepointBytes = await renderRealChannel(frameB, 23);
      const beforeRepointCentre = sampleCentre(preRepointBytes);
      realSurface.flowPackTexNode.value = flow.texture; // THE line `setFlowPackTexture` runs
      const postRepointBytes = await renderRealChannel(frameB, 23);
      const afterRepointCentre = sampleCentre(postRepointBytes);

      const artifacts = [];
      const pngA23 = await renderRealChannel(frameA, 23);
      artifacts.push(await savePng(pngA23, runId, 'real-piers-channel23.png'));
      const pngA22 = await renderRealChannel(frameA, 22);
      artifacts.push(await savePng(pngA22, runId, 'real-piers-channel22.png'));
      const bytesB23 = await renderRealChannel(frameB, 23);
      artifacts.push(await savePng(bytesB23, runId, 'real-wide-channel23.png'));

      // S4 (2026-08-18) — THE REAL VISIBLE WATER, not a debug channel: the
      // actual absorb+inscatter composite, tier 4, over the real piers, so
      // swash/break/streak's local-velocity wiring can be judged by eye —
      // "I'd like to actually see some real results" (the author's own ask).
      // A SECOND, tighter frame right against one pier's upstream face is
      // where break foam should be most obviously concentrated.
      const pierTightSpan = Math.max(80, pierSpan * 0.35);
      const frameC = {
        minX: pierCentre.wx - pierTightSpan,
        minY: pierCentre.wy - pierTightSpan * 1.4,
        maxX: pierCentre.wx + pierTightSpan,
        maxY: pierCentre.wy + pierTightSpan * 1.4,
      };
      const bytesLookA = await renderRealWaterLook(frameA);
      artifacts.push(await savePng(bytesLookA, runId, 'real-look-piers-wide.png'));
      const bytesLookC = await renderRealWaterLook(frameC);
      artifacts.push(await savePng(bytesLookC, runId, 'real-look-piers-tight.png'));
      // ⚠️ THE ROTATION CHECK (2026-08-18) — a SECOND capture of the SAME
      // tight frame, `WATER_SWASH_TIME_STEP_MS` later, specifically to catch
      // the live-reported "radiating rings rotating in space" artifact by
      // eye: swash bands should shift RADIALLY (uniformly inward/outward)
      // between the two frames, never appear to SPIN around an obstacle —
      // the second shape is exactly what a per-angle-varying phase RATE
      // produces, and is what this scenario exists to catch before the
      // author has to find it live a second time.
      const WATER_SWASH_TIME_STEP_MS = 2000;
      realTimeMs.value = WATER_SWASH_TIME_STEP_MS;
      const bytesLookC2 = await renderRealWaterLook(frameC);
      artifacts.push(await savePng(bytesLookC2, runId, 'real-look-piers-tight-t2.png'));
      realTimeMs.value = 0;
      // A quick, honest sanity stat — NOT a substitute for looking at the
      // picture (AGENTS.md §4): the fraction of `bytesLookC` that is neither
      // pure riverbed clear-colour NOR pure black, i.e. "the water mesh
      // actually drew something here, at something other than a flat
      // constant". A degenerate render (mesh missing, shader compiled to a
      // constant) would read as ~0%.
      function fractionNotFlat(bytes, flatR, flatG, flatB) {
        let n = 0;
        const total = DEBUG_DIM * DEBUG_DIM;
        for (let i = 0; i < total; i++) {
          const r = bytes[i * 4];
          const g = bytes[i * 4 + 1];
          const b = bytes[i * 4 + 2];
          if (Math.abs(r - flatR) > 6 || Math.abs(g - flatG) > 6 || Math.abs(b - flatB) > 6) n++;
        }
        return n / total;
      }
      const lookVariety = fractionNotFlat(
        bytesLookC,
        Math.round(0.32 * 255),
        Math.round(0.25 * 255),
        Math.round(0.16 * 255)
      );

      // A CORNER of frameB, well outside `waterBounds` on every axis
      // (guaranteed outside — the margin is 40% of the water span on each
      // side) — this pixel MUST read black if `inRect` is doing its job.
      // The CENTRE of frameB sits inside `waterBounds` by construction — it
      // MUST NOT read black, or the gate is suppressing real water too.
      function sampleCorner(bytes, u, v) {
        const px = Math.min(DEBUG_DIM - 1, Math.max(0, Math.round(u * DEBUG_DIM)));
        const py = Math.min(DEBUG_DIM - 1, Math.max(0, Math.round(v * DEBUG_DIM)));
        const i = (py * DEBUG_DIM + px) * 4;
        return { r: bytes[i], g: bytes[i + 1], b: bytes[i + 2], a: bytes[i + 3] };
      }
      const outsideSample = sampleCorner(bytesB23, 0.02, 0.02); // top-left corner of frameB — outside waterBounds
      const centreSample = sampleCorner(bytesB23, 0.5, 0.5); // centre of frameB — inside waterBounds

      const png = artifacts.filter(Boolean);
      return {
        calibration: 'OK', // no orientation calibration attempted — see renderRealChannel's own doc
        checks: [
          evaluate('real-flow-bake-ran', () => ({
            ok: flowStatus.bakes === 1,
            measured: flowStatus.bakes,
            expected: 1,
          })),
          evaluate('real-pack-has-nonzero-speed-somewhere', () => ({
            ok: !!rawStats && rawStats.maxSpeed > 0.01,
            measured: rawStats?.maxSpeed,
            expected: '> 0.01',
          })),
          evaluate('real-pack-solidity-detects-the-piers-as-a-minority', () => ({
            ok: !!rawStats && rawStats.solidFraction > 0 && rawStats.solidFraction < 0.5,
            measured: rawStats?.solidFraction,
            expected: 'between 0 and 0.5 (piers are real obstacles, not most of the channel)',
          })),
          evaluate('wide-frame-outside-water-bounds-reads-black', () => ({
            ok: outsideSample.r < 4 && outsideSample.g < 4 && outsideSample.b < 4,
            measured: outsideSample,
            expected: 'r,g,b < 4 — the 2026-08-18 inRect gate',
          })),
          evaluate('wide-frame-inside-water-bounds-is-NOT-black', () => ({
            ok: centreSample.r + centreSample.g + centreSample.b > 4,
            measured: centreSample,
            expected: 'r+g+b > 4 — real water must still show real colour, not be gated to nothing too',
          })),
          evaluate('before-repoint-reads-the-placeholder-honestly-black', () => ({
            ok: beforeRepointCentre.r < 4 && beforeRepointCentre.g < 4 && beforeRepointCentre.b < 4,
            measured: beforeRepointCentre,
            expected: 'r,g,b < 4 — before setFlowPackTexture runs, "not baked yet" must read black, not stale data',
          })),
          evaluate('re-point-actually-changes-the-rendered-pixel', () => ({
            ok:
              afterRepointCentre.r !== beforeRepointCentre.r ||
              afterRepointCentre.g !== beforeRepointCentre.g ||
              afterRepointCentre.b !== beforeRepointCentre.b,
            measured: { before: beforeRepointCentre, after: afterRepointCentre },
            expected:
              'after == flowPackTexNode.value = flow.texture (the exact line setFlowPackTexture runs), the ' +
              'SAME pixel must change — identical before/after is the live regression this check exists for',
          })),
          evaluate('real-water-look-draws-something-not-a-flat-constant', () => ({
            ok: lookVariety > 0.1,
            measured: Number(lookVariety.toFixed(4)),
            expected: '> 0.1 — a degenerate render (missing mesh, a shader that compiled to one constant) reads near 0',
            note: 'a NUMBER, not a substitute for looking at real-look-piers-tight.png directly (AGENTS.md §4)',
          })),
        ],
        inputs: { scale, worldRect, waterBounds, pierCentre, bearingDeg, frameA, frameB, frameC },
        stats: {
          flowStatus,
          rawStats,
          outsideSample,
          centreSample,
          beforeRepointCentre,
          afterRepointCentre,
          solidTexels,
          waterTexels,
          lookVariety: Number(lookVariety.toFixed(4)),
        },
        artifacts: png,
      };
    },
  });

  // ══════════════════════════════════════════════════════════════════════════
  // REAL-MAP SIM SCENARIO (2026-08-18, S5) — see `real-underground-river-flow`
  // above for the shared real-mask/body/flow setup this duplicates rather
  // than shares (that scenario's own comment explains why: a real 10650×4950
  // map has no business mutating the shared synthetic-fixture state, and
  // this file's own convention is a SEPARATE pipeline per real-map scenario,
  // never retrofitted onto another one).
  //
  // PROOF CRITERION (`docs/planning/Water-Simulation-Turn.md` §4 S5's own
  // line): "foam sheds off the rock and rides the current downstream while
  // fading". A single bake cannot prove this — advection is a PER-FRAME,
  // CUMULATIVE effect — so this scenario ticks the REAL
  // `createWaterSimSubsystem` many times at a fixed `dtSec` and tracks the
  // foam field's own WORLD-SPACE, foam-WEIGHTED centroid over time, then
  // checks that its projection along the real solved bulk flow direction
  // genuinely increases between an early and a late sample. A system that
  // only PAINTS foam near an obstacle and never transports it would pass
  // "foam exists somewhere" but fail this — the one check that actually
  // tells the two apart.
  // ══════════════════════════════════════════════════════════════════════════
  scenarios.set('real-underground-river-sim', {
    name: 'real-underground-river-sim',
    summary:
      'The REAL createWaterSimSubsystem, ticked across many frames against the REAL Tower Bridge Underground ' +
      '_Water mask (real body + flow bakes underneath it) — proves foam actually ADVECTS downstream over ' +
      'time, not just appears near an obstacle and sits there.',
    async run({ runId }) {
      const scale = 0.1;
      const maskRes = await loadMaskImageTexture({
        url: `${TOWER_BRIDGE.dir}/Tower_Bridge_Underground_Water.webp`,
        THREE,
        scale,
        channels: 'r',
      });
      if (!maskRes) {
        return {
          calibration: 'FAILED',
          checks: [
            evaluate('real-mask-loads', () => ({
              ok: false,
              measured: 'fetch/decode failed',
              expected: 'a real texture',
            })),
          ],
          inputs: { scale },
          stats: {},
          artifacts: [],
        };
      }
      const { texture: realMaskTexture, data: maskBytes, width: mw, height: mh, contentBounds } = maskRes;
      if (!contentBounds) {
        return {
          calibration: 'FAILED',
          checks: [
            evaluate('real-mask-has-content', () => ({
              ok: false,
              measured: 'no painted texels',
              expected: 'a real river',
            })),
          ],
          inputs: { scale, mw, mh },
          stats: {},
          artifacts: [],
        };
      }
      const worldRect = { minX: 0, minY: 0, maxX: TOWER_BRIDGE.native.width, maxY: TOWER_BRIDGE.native.height };
      const spanX = worldRect.maxX - worldRect.minX;
      const spanY = worldRect.maxY - worldRect.minY;
      const waterBounds = {
        minX: worldRect.minX + contentBounds.minU * spanX,
        minY: worldRect.minY + contentBounds.minV * spanY,
        maxX: worldRect.minX + contentBounds.maxU * spanX,
        maxY: worldRect.minY + contentBounds.maxV * spanY,
      };

      // ── FIND THE PIER — same real-pixel scan `real-underground-river-flow`
      // uses, duplicated rather than shared (this file's own convention).
      const x0 = Math.max(0, Math.floor(contentBounds.minU * mw));
      const x1 = Math.min(mw, Math.ceil(contentBounds.maxU * mw));
      const y0 = Math.max(0, Math.floor(contentBounds.minV * mh));
      const y1 = Math.min(mh, Math.ceil(contentBounds.maxV * mh));
      let sumX = 0;
      let sumY = 0;
      let solidTexels = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (maskBytes[y * mw + x] === 0) {
            sumX += x;
            sumY += y;
            solidTexels++;
          }
        }
      }
      const pierCentre =
        solidTexels > 0
          ? {
              wx: worldRect.minX + ((sumX / solidTexels + 0.5) / mw) * spanX,
              wy: worldRect.minY + ((sumY / solidTexels + 0.5) / mh) * spanY,
            }
          : { wx: (waterBounds.minX + waterBounds.maxX) / 2, wy: (waterBounds.minY + waterBounds.maxY) / 2 };

      // ── REAL BODY BAKE — identical sequence to `real-underground-river-flow`.
      const realFloodW = mw;
      const realFloodH = mh;
      const realRtDescribe = (filter) => ({
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.NoColorSpace,
        depthBuffer: false,
        minFilter: filter,
        magFilter: filter,
      });
      const realJfaPingRt = new THREE.RenderTarget(realFloodW, realFloodH, realRtDescribe(THREE.NearestFilter));
      const realJfaPongRt = new THREE.RenderTarget(realFloodW, realFloodH, realRtDescribe(THREE.NearestFilter));
      const realBodyRt = new THREE.RenderTarget(realFloodW, realFloodH, realRtDescribe(THREE.LinearFilter));
      for (const rt of [realJfaPingRt, realJfaPongRt, realBodyRt]) {
        rt.texture.wrapS = THREE.ClampToEdgeWrapping;
        rt.texture.wrapT = THREE.ClampToEdgeWrapping;
      }
      const realJfaSteps = jfaStepCount(realFloodW, realFloodH);
      const realSeed = buildWaterSeedMaterial({
        THREE,
        maskTexture: realMaskTexture,
        width: realFloodW,
        height: realFloodH,
      });
      const realJfa = buildWaterJfaStepMaterial({
        THREE,
        prevTexture: realJfaPingRt.texture,
        width: realFloodW,
        height: realFloodH,
      });
      const realResolve = buildWaterBodyResolveMaterial({
        THREE,
        jfaTexture: realJfaPingRt.texture,
        maskTexture: realMaskTexture,
        texelWorldW: spanX / realFloodW,
        texelWorldH: spanY / realFloodH,
        farDistancePx: Math.hypot(spanX, spanY),
      });
      renderQuadPass(realJfaPingRt, realSeed.quad);
      let realReadFromPing = true;
      for (let i = 0; i < realJfaSteps; i++) {
        const src = realReadFromPing ? realJfaPingRt : realJfaPongRt;
        const dst = realReadFromPing ? realJfaPongRt : realJfaPingRt;
        realJfa.uStride.value = jfaStrideForStep(i, realJfaSteps);
        for (const node of realJfa.prevTexNodes) node.value = src.texture;
        renderQuadPass(dst, realJfa.quad);
        realReadFromPing = !realReadFromPing;
      }
      realResolve.jfaTexNode.value = (realReadFromPing ? realJfaPingRt : realJfaPongRt).texture;
      renderQuadPass(realBodyRt, realResolve.quad);

      // ── REAL FLOW BAKE — identical sequence to `real-underground-river-flow`,
      // except the local allocator also remembers `finestW`/`finestH` (the
      // flow scenario never needed them — its own readback used
      // `finestPackRt.width/.height` directly off the RT).
      let finestPackRt = null;
      let finestW = 0;
      let finestH = 0;
      const flowLocalAllocator = {
        create(name, descriptor) {
          const filter = descriptor.filter === 'linear' ? THREE.LinearFilter : THREE.NearestFilter;
          const rt = new THREE.RenderTarget(descriptor.resolvedW, descriptor.resolvedH, {
            type: descriptor.type,
            format: descriptor.format,
            colorSpace: descriptor.colorSpace,
            depthBuffer: !!descriptor.depth,
            minFilter: filter,
            magFilter: filter,
          });
          rt.texture.name = name;
          if (name.endsWith('.pack')) {
            finestPackRt = rt;
            finestW = descriptor.resolvedW;
            finestH = descriptor.resolvedH;
          }
          return rt;
        },
        dispose(rt) {
          rt?.dispose?.();
        },
      };
      const bearingDeg = WATER_TIER2_FLOW_ANGLE_DEG; // 180 — this project's own documented "downstream" default
      const flow = createWaterFlowSubsystem({
        THREE,
        allocator: flowLocalAllocator,
        waterSurface: { getFullResMaskTexture: () => realMaskTexture },
        waterBody: { getRect: () => worldRect },
        renderWaterPass: renderQuadPass,
        createFlowTexture: (data, w, h, filter) => makeTex(data, w, h, filter),
        getWaterRenderState: () => ({ params: { flowAngleDeg: bearingDeg } }),
      });
      flow.maybeBake();
      const flowStatus = flow.getStatus();
      if (!finestPackRt) {
        return {
          calibration: 'FAILED',
          checks: [
            evaluate('real-flow-bake-ran-before-sim', () => ({
              ok: false,
              measured: flowStatus,
              expected: 'a finished flow pack (sim has nothing to read without one)',
            })),
          ],
          inputs: { scale, bearingDeg },
          stats: { flowStatus },
          artifacts: [],
        };
      }

      // ── THE REAL SIM SUBSYSTEM — `createWaterSimSubsystem`, unmodified. The
      // local allocator tracks BOTH ping/pong targets by their exact
      // production names (`water-sim-subsystem.js#ensureTargets`'s own
      // `'water.sim.ping'`/`'water.sim.pong'`) — the SAME "read the RT the
      // subsystem itself created, never a bench-side guess" trick
      // `finestPackRt` above already uses for the flow pack, because
      // `sim.texture` only exposes the bare Texture, and a pixel READBACK
      // needs the RenderTarget that owns it.
      let simPingRt = null;
      let simPongRt = null;
      const simLocalAllocator = {
        create(name, descriptor) {
          const filter = descriptor.filter === 'linear' ? THREE.LinearFilter : THREE.NearestFilter;
          const rt = new THREE.RenderTarget(descriptor.resolvedW, descriptor.resolvedH, {
            type: descriptor.type,
            format: descriptor.format,
            colorSpace: descriptor.colorSpace,
            depthBuffer: !!descriptor.depth,
            minFilter: filter,
            magFilter: filter,
          });
          rt.texture.name = name;
          if (name === 'water.sim.ping') simPingRt = rt;
          if (name === 'water.sim.pong') simPongRt = rt;
          return rt;
        },
        dispose(rt) {
          rt?.dispose?.();
        },
      };
      // Deliberately well above the schema default (90) — this scenario runs
      // a BOUNDED number of ticks and needs "does foam arrive downstream"
      // answered inside that budget, not eventually; a slower river would
      // still be correct, only slower to prove within a bench run.
      //
      // Measured once at the real default (2026-08-18, S6 calibration pass):
      // `maxFoamEver` at flowSpeedPx=90 was 0.3137 vs 0.2454 here at 220 —
      // the accumulator's peak does NOT scale down at realistic speed (if
      // anything it ran slightly higher, since slower advection gives foam
      // more residence time near the emission site before decay/transport
      // carry it off) — see `WATER_SIM_CLUMP_LO`/`HI`'s own doc in
      // `water-sim.js` for what that measurement was checking.
      const testFlowSpeedPx = 220;
      const { uniform: uniformFnSim, float: floatFnSim } = THREE.TSL;
      const simTimeMs = uniformFnSim(floatFnSim(0));
      const sim = createWaterSimSubsystem({
        THREE,
        allocator: simLocalAllocator,
        waterFlow: { texture: flow.texture, width: finestW, height: finestH },
        waterBody: { texture: realBodyRt.texture, getRect: () => worldRect },
        renderWaterPass: renderQuadPass,
        getWaterRenderState: () => ({ params: { flowSpeedPx: testFlowSpeedPx, foam: 1 } }),
        timeMsNode: simTimeMs,
      });

      /** Whole-grid readback of the sim buffer's own R channel (foam),
       * decoded from half-float — `halfToFloat`, this file's own module-level
       * helper, the SAME decode `bodyRt`'s own readback elsewhere in this
       * file already uses for the identical HalfFloatType/RGBAFormat shape.
       * @returns {{foam: Float32Array, w: number, h: number}|null} */
      async function readSimFoam() {
        const tex = sim.texture;
        if (!tex || !simPingRt || !simPongRt) return null;
        const rt = tex === simPingRt.texture ? simPingRt : simPongRt;
        const gw = rt.width;
        const gh = rt.height;
        const buf = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, gw, gh);
        const raw = buf instanceof Promise ? await buf : buf;
        const u16 = raw instanceof Uint16Array ? raw : new Uint16Array(raw.buffer ?? raw);
        const foam = new Float32Array(gw * gh);
        for (let i = 0; i < gw * gh; i++) foam[i] = halfToFloat(u16[i * 4]);
        return { foam, w: gw, h: gh };
      }

      /**
       * Foam-weighted centroid, in WORLD space, plus its projection along the
       * real solved bulk flow direction relative to the pier — the one number
       * this scenario's whole proof rests on. `null` centroid (no foam yet
       * at all) is a legitimate early-tick answer, not a failure.
       * @param {{foam: Float32Array, w: number, h: number}} grid
       */
      function centroidAndProjection(grid) {
        const [dirX, dirY] = waterFlowVector(bearingDeg);
        let sum = 0;
        let sumX = 0;
        let sumY = 0;
        for (let gy = 0; gy < grid.h; gy++) {
          for (let gx = 0; gx < grid.w; gx++) {
            const v = grid.foam[gy * grid.w + gx];
            if (v <= 0) continue;
            sum += v;
            sumX += v * gx;
            sumY += v * gy;
          }
        }
        if (sum <= 0) return { totalFoam: 0, centroidWorld: null, downstreamProjectionPx: null };
        const centroidWorld = {
          wx: worldRect.minX + ((sumX / sum + 0.5) / grid.w) * spanX,
          wy: worldRect.minY + ((sumY / sum + 0.5) / grid.h) * spanY,
        };
        const downstreamProjectionPx =
          (centroidWorld.wx - pierCentre.wx) * dirX + (centroidWorld.wy - pierCentre.wy) * dirY;
        return { totalFoam: sum, centroidWorld, downstreamProjectionPx };
      }

      /** @param {Float32Array} foam @param {number} w @param {number} h @param {string} runId @param {string} file */
      async function saveFoamPng(foam, w, h, runIdArg, file) {
        try {
          const { saveCanvasPng } = await import('./contract.js');
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          const imgData = ctx.createImageData(w, h);
          for (let i = 0; i < w * h; i++) {
            const g = Math.max(0, Math.min(255, Math.round(foam[i] * 255)));
            imgData.data[i * 4] = g;
            imgData.data[i * 4 + 1] = g;
            imgData.data[i * 4 + 2] = g;
            imgData.data[i * 4 + 3] = 255;
          }
          ctx.putImageData(imgData, 0, 0);
          return await saveCanvasPng(runIdArg, file, canvas);
        } catch {
          return null;
        }
      }

      // ── TICK — fixed 30Hz dtSec, enough ticks to cross several
      // `WATER_SIM_TAU_FOAM_SEC` decay constants AND for `testFlowSpeedPx` to
      // carry foam a genuinely measurable distance across the sim grid.
      const dtSec = 1 / 30;
      const ticksPerSample = 30; // one sample per simulated second
      const sampleCount = 5; // 5 simulated seconds total
      const samples = [];
      const artifacts = [];
      let hadNaN = false;
      let maxFoamEver = 0;
      for (let s = 0; s < sampleCount; s++) {
        for (let i = 0; i < ticksPerSample; i++) {
          simTimeMs.value += dtSec * 1000;
          sim.tick(dtSec);
        }
        const grid = await readSimFoam();
        if (!grid) {
          samples.push({ atSec: (s + 1) * ticksPerSample * dtSec, totalFoam: 0, downstreamProjectionPx: null });
          continue;
        }
        for (let i = 0; i < grid.foam.length; i++) {
          if (!Number.isFinite(grid.foam[i])) {
            hadNaN = true;
          } else if (grid.foam[i] > maxFoamEver) {
            maxFoamEver = grid.foam[i];
          }
        }
        const { totalFoam, downstreamProjectionPx } = centroidAndProjection(grid);
        samples.push({
          atSec: (s + 1) * ticksPerSample * dtSec,
          totalFoam: Number(totalFoam.toFixed(4)),
          downstreamProjectionPx,
        });
        if (s === 0 || s === sampleCount - 1) {
          artifacts.push(
            await saveFoamPng(
              grid.foam,
              grid.w,
              grid.h,
              runId,
              `real-sim-foam-t${Math.round((s + 1) * ticksPerSample * dtSec)}s.png`
            )
          );
        }
      }
      const simStatus = sim.getStatus();

      // ── S6 (2026-08-19) — RENDER THE ACTUAL DEBUG CHANNELS the author is
      // looking at (25 simFoam / 26 simFoamStructure / 27 simFoamStructured),
      // against THIS scenario's own real, now-fully-ticked sim texture —
      // never attempted before this round; every earlier S5 round only
      // proved the ACCUMULATOR's own numbers, never rendered the debug
      // material against it. Author, live, zoomed in: *"26 shows concentric
      // poles of almost magnetic like rings... 25 shows a huge amount of
      // pixelated non-sense... could we increase texel resolution please?"*
      // — reproduce first, diagnose from what is actually seen, not from
      // re-reading the shader source a fourth time
      // ([[feedback_check_console_before_theorizing]]'s own standing lesson,
      // this file's own memory).
      //
      // Single-mesh, single-material debug render — NOT the dual absorb+
      // inscatter MRT composite this same scenario tried and reverted
      // earlier this phase. `real-underground-river-flow`'s own
      // `renderRealChannel` (this file, above) already proves this exact
      // shape (debugMaterial + setMRT(waterZeroMrt) + single quad) safe on
      // this backend — mirrored here, not re-invented.
      const { uniform: uniformFnSim2, vec4: vec4FnSim2 } = THREE.TSL;
      const simRealTimeMs = uniformFnSim2(0);
      const simRealViewRect = uniformFnSim2(vec4FnSim2(worldRect.minX, worldRect.minY, worldRect.maxX, worldRect.maxY));
      const simRealOutdoorsRect = uniformFnSim2(
        vec4FnSim2(worldRect.minX, worldRect.minY, worldRect.maxX, worldRect.maxY)
      );
      const simRealOutdoorsTexNode = texture(makeTex(new Uint8Array([255, 255, 255, 255]), 1, 1, 'nearest'));
      const simRealSurface = buildWaterSurfaceMaterial({
        THREE,
        maskTexture: realMaskTexture,
        maskRect: worldRect,
        bodyTexture: realBodyRt.texture,
        bodyRect: worldRect,
        bodyTexSize: [realFloodW, realFloodH],
        timeMsNode: simRealTimeMs,
        uViewRect: simRealViewRect,
        uOutdoorsRect: simRealOutdoorsRect,
        outdoorsTexNode: simRealOutdoorsTexNode,
        buildOutdoorsGate: buildWorldSpaceOutdoorsGate,
        flowPackTexture: flow.texture,
        flowPackTexSize: [finestW, finestH],
        // THE REAL, NOW FULLY-TICKED SIM TEXTURE — this scenario's whole
        // point, and the one thing no earlier debug-channel render in this
        // file has ever actually wired in.
        waterSimTexture: sim.texture,
        waterSimTexSize: [simPingRt.width, simPingRt.height],
        tier: 4,
        debugChannel: 0,
      });
      const simRealGeometry = new THREE.BufferGeometry();
      simRealGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
      simRealGeometry.setIndex(Array.from(QUAD_INDICES));
      // TIGHT on the pier — the author's own screenshots are extreme close
      // crops, so reproducing the complaint means framing the same way, not
      // the whole-body view earlier rounds used.
      // WIDENED (2026-08-19, after the first pass came back all-zero for
      // `simFoam` here): `pierCentre` is the centroid of SOLID pixels — the
      // pier's own land, not the water around it (this file's own "FIND THE
      // PIER" comment above). A 220px half-width was entirely land for this
      // pier. 400px reliably pulls in real water on every side regardless of
      // the exact pier footprint.
      const zoomHalfPx = 400;
      simRealGeometry.setAttribute(
        'position',
        new THREE.BufferAttribute(
          buildQuadPositions([
            { x: pierCentre.wx - zoomHalfPx, y: pierCentre.wy - zoomHalfPx },
            { x: pierCentre.wx + zoomHalfPx, y: pierCentre.wy - zoomHalfPx },
            { x: pierCentre.wx + zoomHalfPx, y: pierCentre.wy + zoomHalfPx },
            { x: pierCentre.wx - zoomHalfPx, y: pierCentre.wy + zoomHalfPx },
          ]),
          3
        )
      );
      const simRealMesh = Object.assign(new THREE.Mesh(simRealGeometry, simRealSurface.debugMaterial), {
        renderOrder: 0.5,
        frustumCulled: false,
      });
      const simRealScene = new THREE.Scene();
      simRealScene.add(simRealMesh);
      const simRealCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
      const SIM_DEBUG_DIM = 512;
      const simDebugRt = new THREE.RenderTarget(SIM_DEBUG_DIM, SIM_DEBUG_DIM, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.NoColorSpace,
      });
      simDebugRt.texture.name = 'output';

      /** @param {number} channel @returns {Promise<Uint8Array>} */
      async function renderSimDebugChannel(channel) {
        simRealSurface.setDebugChannel(channel);
        const view = {
          minX: pierCentre.wx - zoomHalfPx,
          minY: pierCentre.wy - zoomHalfPx,
          maxX: pierCentre.wx + zoomHalfPx,
          maxY: pierCentre.wy + zoomHalfPx,
        };
        const f = computeCameraFrustum(view);
        simRealCamera.left = f.left;
        simRealCamera.right = f.right;
        simRealCamera.top = f.top;
        simRealCamera.bottom = f.bottom;
        simRealCamera.updateProjectionMatrix();
        const prevTarget = renderer.getRenderTarget();
        const previousMRT = renderer.getMRT();
        renderer.setMRT(waterZeroMrt); // NOT optional — see `renderRealCore`'s own comment above
        renderer.setRenderTarget(simDebugRt);
        renderer.setClearColor(new THREE.Color(0, 0, 0), 1);
        renderer.render(simRealScene, simRealCamera);
        renderer.setRenderTarget(prevTarget);
        renderer.setMRT(previousMRT);
        const buf = await renderer.readRenderTargetPixelsAsync(simDebugRt, 0, 0, SIM_DEBUG_DIM, SIM_DEBUG_DIM);
        const raw = buf instanceof Promise ? await buf : buf;
        return raw instanceof Uint8Array ? raw : new Uint8Array(raw.buffer ?? raw);
      }

      /** @param {Uint8Array} bytes */
      function statsOf(bytes) {
        let lo = 255;
        let hi = 0;
        let sum = 0;
        let n = 0;
        for (let i = 0; i < bytes.length; i += 4) {
          const v = bytes[i]; // R channel — every one of these debug channels is greyscale (R=G=B)
          if (v < lo) lo = v;
          if (v > hi) hi = v;
          sum += v;
          n++;
        }
        return { min: lo, max: hi, mean: Number((sum / n).toFixed(2)) };
      }

      /** @param {Uint8Array} bytes @param {string} file */
      async function saveDebugPng(bytes, file) {
        try {
          const { saveCanvasPng } = await import('./contract.js');
          const canvas = document.createElement('canvas');
          canvas.width = SIM_DEBUG_DIM;
          canvas.height = SIM_DEBUG_DIM;
          const ctx = canvas.getContext('2d');
          const imgData = ctx.createImageData(SIM_DEBUG_DIM, SIM_DEBUG_DIM);
          imgData.data.set(bytes);
          ctx.putImageData(imgData, 0, 0);
          return await saveCanvasPng(runId, file, canvas);
        } catch {
          return null;
        }
      }

      const channel10Bytes = await renderSimDebugChannel(10); // worleyLace — shore foam's OWN structure tap, for direct A/B comparison
      const channel25Bytes = await renderSimDebugChannel(25); // simFoam
      const channel26Bytes = await renderSimDebugChannel(26); // simFoamStructure
      const channel27Bytes = await renderSimDebugChannel(27); // simFoamStructured
      const debugChannelArtifacts = (
        await Promise.all([
          saveDebugPng(channel10Bytes, 'debug-ch10-worleyLace-zoom.png'),
          saveDebugPng(channel25Bytes, 'debug-ch25-simFoam-zoom.png'),
          saveDebugPng(channel26Bytes, 'debug-ch26-simFoamStructure-zoom.png'),
          saveDebugPng(channel27Bytes, 'debug-ch27-simFoamStructured-zoom.png'),
        ])
      ).filter(Boolean);
      const debugChannelStats = {
        worleyLace: statsOf(channel10Bytes),
        simFoam: statsOf(channel25Bytes),
        simFoamStructure: statsOf(channel26Bytes),
        simFoamStructured: statsOf(channel27Bytes),
      };

      const earlySample = samples[0];
      const lateSample = samples[samples.length - 1];
      const png = [...artifacts.filter(Boolean), ...debugChannelArtifacts];

      return {
        calibration: 'OK', // no orientation calibration attempted — a foam-density grayscale, not a debug channel
        checks: [
          evaluate('real-sim-ticked-the-expected-number-of-times', () => ({
            ok: simStatus.steps === sampleCount * ticksPerSample,
            measured: simStatus.steps,
            expected: sampleCount * ticksPerSample,
          })),
          evaluate('real-sim-has-no-NaN-or-Inf-anywhere-in-the-grid', () => ({
            ok: !hadNaN,
            measured: hadNaN ? 'found non-finite texels' : 'all finite',
            expected: 'all finite — a NaN here would spread via the next frame’s own blur',
          })),
          evaluate('real-sim-foam-stays-well-under-its-defensive-storage-ceiling', () => ({
            ok: maxFoamEver <= 1.001,
            measured: Number(maxFoamEver.toFixed(4)),
            expected:
              '<= ~1 (WATER_SIM_STORAGE_CEIL is 3) — decay alone should keep the accumulator far below its ' +
              'own defensive ceiling at steady state; nowhere near it is a healthy sign, not a tight margin',
          })),
          evaluate('real-sim-emits-real-foam-near-the-pier-within-the-first-second', () => ({
            ok: earlySample.totalFoam > 0,
            measured: earlySample.totalFoam,
            expected: '> 0',
          })),
          evaluate('real-sim-foam-centroid-moves-further-downstream-over-time', () => ({
            ok:
              earlySample.downstreamProjectionPx != null &&
              lateSample.downstreamProjectionPx != null &&
              lateSample.downstreamProjectionPx > earlySample.downstreamProjectionPx,
            measured: { early: earlySample.downstreamProjectionPx, late: lateSample.downstreamProjectionPx },
            expected:
              'late > early — THE S5 proof criterion itself ("foam sheds off the rock and rides the current ' +
              'downstream while fading"): a system that only paints foam near an obstacle without transporting ' +
              'it would pass every OTHER check here and fail only this one',
          })),
        ],
        inputs: { scale, bearingDeg, testFlowSpeedPx, dtSec, sampleCount, ticksPerSample, pierCentre, zoomHalfPx },
        stats: { flowStatus, simStatus, samples, maxFoamEver, solidTexels, debugChannelStats },
        artifacts: png,
      };
    },
  });

  // ══════════════════════════════════════════════════════════════════════
  // SYNTHETIC-RIVER FLOW — the shader lab's OWN DEFAULT `paintRiver`+ISLAND
  // fixture, never previously flow-baked (2026-08-19). Every OTHER scenario
  // either only body-bakes this fixture (`river-bake-produces-real-sdf`) or
  // only flow-bakes the REAL Tower Bridge mask — nothing had ever run
  // `createWaterFlowSubsystem` against the bench's own default shape until
  // this. Author, live, annotating a screenshot of exactly this fixture with
  // arrows at several points along the bend and around the island: *"I can't
  // see any evidence of the water itself going around structures... test
  // these points on the river... see if they end up pointing in the
  // directions provided by the arrows... get river flowing obstacle
  // avoiding working in the shader lab first."*
  scenarios.set('synthetic-river-flow-avoids-island', {
    name: 'synthetic-river-flow-avoids-island',
    summary:
      "The REAL createWaterFlowSubsystem bake against the shader lab's OWN default synthetic " +
      'bend+island river (`paintRiver`) — never flow-baked before. Samples the solved velocity at ' +
      'points either side of the island and checks the current genuinely SPLITS and reroutes, not ' +
      'just a uniform bulk-direction field painted over the mask.',
    async run({ runId }) {
      const { data: maskBytes, w: mw, h: mh } = rasterMask(paintRiver);
      const synMaskTexture = makeTex(maskBytes, mw, mh, 'nearest');
      const worldRect = WATER_RECT;
      const spanX = worldRect.maxX - worldRect.minX;
      const spanY = worldRect.maxY - worldRect.minY;

      // ── REAL BODY BAKE (JFA) — identical sequence to the "real" scenarios
      // above, against THIS fixture's own mask instead of a loaded PNG.
      const floodW = mw;
      const floodH = mh;
      const rtDescribe = (filter) => ({
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.NoColorSpace,
        depthBuffer: false,
        minFilter: filter,
        magFilter: filter,
      });
      const jfaPingRt = new THREE.RenderTarget(floodW, floodH, rtDescribe(THREE.NearestFilter));
      const jfaPongRt = new THREE.RenderTarget(floodW, floodH, rtDescribe(THREE.NearestFilter));
      const synBodyRt = new THREE.RenderTarget(floodW, floodH, rtDescribe(THREE.LinearFilter));
      for (const rt of [jfaPingRt, jfaPongRt, synBodyRt]) {
        rt.texture.wrapS = THREE.ClampToEdgeWrapping;
        rt.texture.wrapT = THREE.ClampToEdgeWrapping;
      }
      const steps = jfaStepCount(floodW, floodH);
      const seed = buildWaterSeedMaterial({ THREE, maskTexture: synMaskTexture, width: floodW, height: floodH });
      const jfa = buildWaterJfaStepMaterial({ THREE, prevTexture: jfaPingRt.texture, width: floodW, height: floodH });
      const resolve = buildWaterBodyResolveMaterial({
        THREE,
        jfaTexture: jfaPingRt.texture,
        maskTexture: synMaskTexture,
        texelWorldW: spanX / floodW,
        texelWorldH: spanY / floodH,
        farDistancePx: Math.hypot(spanX, spanY),
      });
      renderQuadPass(jfaPingRt, seed.quad);
      let readFromPing = true;
      for (let i = 0; i < steps; i++) {
        const src = readFromPing ? jfaPingRt : jfaPongRt;
        const dst = readFromPing ? jfaPongRt : jfaPingRt;
        jfa.uStride.value = jfaStrideForStep(i, steps);
        for (const node of jfa.prevTexNodes) node.value = src.texture;
        renderQuadPass(dst, jfa.quad);
        readFromPing = !readFromPing;
      }
      resolve.jfaTexNode.value = (readFromPing ? jfaPingRt : jfaPongRt).texture;
      renderQuadPass(synBodyRt, resolve.quad);

      // ── REAL FLOW BAKE — `createWaterFlowSubsystem`, unmodified.
      // ⚠️ EVERY `.pack`-named target, not just "the last one created" — a
      // live discrepancy (this scenario's own first run: `flow.texture`
      // rendered normally through the real material, but this readback of
      // "the last-created `.pack` RT" read near-zero everywhere) traced to
      // exactly this assumption being unsafe. Matched by IDENTITY against
      // `flow.texture` itself after the bake instead — the same defensive
      // pattern `real-underground-river-sim#readSimFoam` already uses for
      // `sim.texture` ("the RT the subsystem itself currently points at",
      // never a bench-side guess about creation order).
      const packRtCandidates = [];
      const flowAllocator = {
        create(name, descriptor) {
          const filter = descriptor.filter === 'linear' ? THREE.LinearFilter : THREE.NearestFilter;
          const rt = new THREE.RenderTarget(descriptor.resolvedW, descriptor.resolvedH, {
            type: descriptor.type,
            format: descriptor.format,
            colorSpace: descriptor.colorSpace,
            depthBuffer: !!descriptor.depth,
            minFilter: filter,
            magFilter: filter,
          });
          rt.texture.name = name;
          if (name.endsWith('.pack')) packRtCandidates.push(rt);
          return rt;
        },
        dispose(rt) {
          rt?.dispose?.();
        },
      };
      // `WATER_TIER2_FLOW_ANGLE_DEG` (180, "south") — this project's own
      // documented default; `waterFlowVector(180)` = straight DOWN in world
      // space, matching `paintRiver`'s own v-axis (v=0 top, v=1 bottom) —
      // the fixture's winding shape was authored to be travelled top-to-
      // bottom, same as `river-bake-produces-real-sdf`'s own "downstream".
      const bearingDeg = WATER_TIER2_FLOW_ANGLE_DEG;
      const flow = createWaterFlowSubsystem({
        THREE,
        allocator: flowAllocator,
        waterSurface: { getFullResMaskTexture: () => synMaskTexture },
        waterBody: { getRect: () => worldRect },
        renderWaterPass: renderQuadPass,
        createFlowTexture: (data, w, h, filter) => makeTex(data, w, h, filter),
        getWaterRenderState: () => ({ params: { flowAngleDeg: bearingDeg } }),
      });
      flow.maybeBake();
      const flowStatus = flow.getStatus();
      const finestPackRt = packRtCandidates.find((rt) => rt.texture === flow.texture) ?? null;
      const finestW = finestPackRt?.width ?? 0;
      const finestH = finestPackRt?.height ?? 0;
      if (!finestPackRt) {
        return {
          calibration: 'FAILED',
          checks: [
            evaluate('synthetic-flow-bake-ran', () => ({
              ok: false,
              measured: flowStatus,
              expected: 'a finished flow pack',
            })),
          ],
          inputs: { bearingDeg },
          stats: { flowStatus },
          artifacts: [],
        };
      }

      // ── READ BACK the finest pack — RG velocity (normalised, free-stream
      // = 1), B speed01, A solidity (`buildWaterProjectPackMaterial`'s own
      // doc, `water-flow.js`).
      //
      // ⚠️ `Float32Array`, NOT `Uint16Array`+`halfToFloat` — a real bug this
      // scenario's own first run caught in ITSELF, not the solver: this
      // pack's own allocator descriptor (`water-flow-subsystem.js`) requests
      // `THREE.FloatType` (full 32-bit), unlike almost every OTHER render
      // target in this bench file (body/JFA/sim all use `HalfFloatType`,
      // which is why `halfToFloat` exists here at all) — copying that
      // sibling pattern without checking THIS target's own descriptor
      // reinterpreted each 4-byte float32 as two unrelated 2-byte halves,
      // producing small, plausible-looking-but-wrong numbers (a decoded
      // `speed01` of 0.0002 alongside a raw velocity magnitude of 5.4 —
      // internally inconsistent with `buildWaterProjectPackMaterial`'s own
      // `speed01 = clamp(length(velocity)/HEADROOM, 0, 1)` formula, which is
      // what actually exposed it: the rendered channel 23 PNG from this same
      // run looked normal, so the bug had to be in this readback, not the
      // bake).
      const buf = await renderer.readRenderTargetPixelsAsync(finestPackRt, 0, 0, finestW, finestH);
      const raw = buf instanceof Promise ? await buf : buf;
      const f32 = raw instanceof Float32Array ? raw : new Float32Array(raw.buffer ?? raw);
      /** @param {number} worldX @param {number} worldY */
      function sampleFlowAt(worldX, worldY) {
        const u = (worldX - worldRect.minX) / spanX;
        const v = (worldY - worldRect.minY) / spanY;
        const gx = Math.max(0, Math.min(finestW - 1, Math.floor(u * finestW)));
        const gy = Math.max(0, Math.min(finestH - 1, Math.floor(v * finestH)));
        const i = (gy * finestW + gx) * 4;
        const vx = f32[i];
        const vy = f32[i + 1];
        const speed01 = f32[i + 2];
        const solidity = f32[i + 3];
        // Invert `waterFlowVector`'s own `x=sin(rad), y=-cos(rad)` — the
        // SAME compass convention the rest of this codebase uses, so a
        // reported angle here means the same thing it would in-game.
        const deg = ((Math.atan2(vx, -vy) * 180) / Math.PI + 360) % 360;
        return { vx, vy, speed01, solidity, angleDeg: Number(deg.toFixed(1)), mag: Math.hypot(vx, vy) };
      }

      // ── TEST POINTS — derived from the SAME `riverCenterU`/`riverHalfWidthU`/
      // `ISLAND` this fixture is painted from (never eyeballed), at the world
      // coordinates the author's own arrows marked: the upper winding bends,
      // then either side of the island in the wide pool.
      const bendV1 = 0.1; // first winding bend, mild
      const bendV2 = 0.3; // second bend — the sharpest lateral swing before the pool
      const islandV = ISLAND.v; // 0.56 — level with the island's own centre
      const tailV = 0.8; // past the pool, lower winding section
      const bend1 = { wx: riverCenterU(bendV1) * spanX, wy: bendV1 * spanY };
      const bend2 = { wx: riverCenterU(bendV2) * spanX, wy: bendV2 * spanY };
      const islandLeftBankX = (riverCenterU(islandV) - riverHalfWidthU(islandV)) * spanX;
      const islandRightBankX = (riverCenterU(islandV) + riverHalfWidthU(islandV)) * spanX;
      const islandLeftEdgeX = (ISLAND.u - ISLAND.ru) * spanX;
      const islandRightEdgeX = (ISLAND.u + ISLAND.ru) * spanX;
      const leftOfIsland = { wx: (islandLeftBankX + islandLeftEdgeX) / 2, wy: islandV * spanY };
      const rightOfIsland = { wx: (islandRightEdgeX + islandRightBankX) / 2, wy: islandV * spanY };
      const tail = { wx: riverCenterU(tailV) * spanX, wy: tailV * spanY };

      const sBend1 = sampleFlowAt(bend1.wx, bend1.wy);
      const sBend2 = sampleFlowAt(bend2.wx, bend2.wy);
      const sLeft = sampleFlowAt(leftOfIsland.wx, leftOfIsland.wy);
      const sRight = sampleFlowAt(rightOfIsland.wx, rightOfIsland.wy);
      const sTail = sampleFlowAt(tail.wx, tail.wy);
      // ── THE DECISIVE CHECK — solidity DEAD CENTRE of the island itself.
      // Every point above reads near-zero deflection despite squeezing past
      // an obstacle; before concluding the SOLVE is at fault, rule out the
      // simpler explanation first: does the solver's own solidity pack even
      // recognise the island as solid at all? If this reads near-zero too,
      // nothing downstream ever had an obstacle to route around.
      const sIslandCentre = sampleFlowAt(ISLAND.u * spanX, ISLAND.v * spanY);

      // ── THE FLOW WARP TERM (`water-field.js#buildWaterSurfaceField`,
      // `WATER_FLOW_WARP_INFLUENCE`) — a pure-JS mirror of the new TSL
      // formula, evaluated against these SAME already-baked real samples
      // rather than a second GPU render: proves the formula responds to
      // genuine deflection (and stays inside its own cap) without the risk
      // of a second render-target/texture-format mismatch, the exact class
      // of bug this scenario's own header already caught itself in once.
      // ⚠️ Dead zone is on `mag` (length of the RG/free-stream=1.0 channel,
      // i.e. `localSpeed` in the real shader) — NOT `speed01` (the SEPARATE
      // HEADROOM-relative gauge channel B). Mixing the two up here would
      // silently test a different formula than the one that ships.
      const bulkDirXY = waterFlowVector(bearingDeg);
      // ⚠️ TWO CAPS NOW (2026-08-23) — see `WATER_FLOW_WARP_CAP_CELLS`'s own
      // doc, `water-field.js`. The influence-scaled magnitude AND the
      // independent per-cell ceiling both apply; the SMALLER one wins,
      // exactly mirroring the real shader's `min(1, capPx/warpLen)` rescale.
      function flowWarpPxAt(sample, influence = WATER_FLOW_WARP_INFLUENCE) {
        const [cx, cy] = bulkDirXY;
        const useReal = sample.mag >= 0.02;
        const dx = useReal ? sample.vx / sample.mag : cx;
        const dy = useReal ? sample.vy / sample.mag : cy;
        const devX = dx - cx;
        const devY = dy - cy;
        const devLen = Math.hypot(devX, devY);
        const clampScale = devLen > 1 ? 1 / devLen : 1;
        let warpX = devX * clampScale * WATER_TIER2_WAVE_SCALE_PX * influence;
        let warpY = devY * clampScale * WATER_TIER2_WAVE_SCALE_PX * influence;
        const rawMag = Math.hypot(warpX, warpY);
        const capPx = WATER_TIER2_WAVE_SCALE_PX * WATER_FLOW_WARP_CAP_CELLS;
        const capScale = Math.min(1, capPx / Math.max(rawMag, 1e-4));
        warpX *= capScale;
        warpY *= capScale;
        return { warpX, warpY, mag: Math.hypot(warpX, warpY) };
      }
      const warpBend1 = flowWarpPxAt(sBend1);
      const warpBend2 = flowWarpPxAt(sBend2);
      const warpCapPx = Math.min(
        WATER_TIER2_WAVE_SCALE_PX * WATER_FLOW_WARP_INFLUENCE,
        WATER_TIER2_WAVE_SCALE_PX * WATER_FLOW_WARP_CAP_CELLS
      );

      // ── WIDE VISUAL — channel 23 (`flowVelocity`, hue = deviation from the
      // bulk compass) over the WHOLE fixture, the same already-live-
      // confirmed instrument, so the author's own eyes can check this
      // exactly the way they confirmed it once before on the real map.
      const { uniform: uniformFnSyn, vec4: vec4FnSyn } = THREE.TSL;
      const synTimeMs = uniformFnSyn(0);
      const synViewRect = uniformFnSyn(vec4FnSyn(worldRect.minX, worldRect.minY, worldRect.maxX, worldRect.maxY));
      const synOutdoorsRect = uniformFnSyn(vec4FnSyn(worldRect.minX, worldRect.minY, worldRect.maxX, worldRect.maxY));
      const synOutdoorsTexNode = texture(makeTex(new Uint8Array([255, 255, 255, 255]), 1, 1, 'nearest'));
      const synSurface = buildWaterSurfaceMaterial({
        THREE,
        maskTexture: synMaskTexture,
        maskRect: worldRect,
        bodyTexture: synBodyRt.texture,
        bodyRect: worldRect,
        bodyTexSize: [floodW, floodH],
        timeMsNode: synTimeMs,
        uViewRect: synViewRect,
        uOutdoorsRect: synOutdoorsRect,
        outdoorsTexNode: synOutdoorsTexNode,
        buildOutdoorsGate: buildWorldSpaceOutdoorsGate,
        flowPackTexture: flow.texture,
        flowPackTexSize: [finestW, finestH],
        waterSimTexture: makeTex(new Uint8Array([0, 0, 0, 0]), 1, 1, 'linear'),
        tier: 4,
        debugChannel: 23,
      });
      const synGeometry = new THREE.BufferGeometry();
      synGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
      synGeometry.setIndex(Array.from(QUAD_INDICES));
      synGeometry.setAttribute(
        'position',
        new THREE.BufferAttribute(
          buildQuadPositions([
            { x: worldRect.minX, y: worldRect.minY },
            { x: worldRect.maxX, y: worldRect.minY },
            { x: worldRect.maxX, y: worldRect.maxY },
            { x: worldRect.minX, y: worldRect.maxY },
          ]),
          3
        )
      );
      const synMesh = Object.assign(new THREE.Mesh(synGeometry, synSurface.debugMaterial), {
        renderOrder: 0.5,
        frustumCulled: false,
      });
      const synScene = new THREE.Scene();
      synScene.add(synMesh);
      const synCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
      const SYN_DIM = 512;
      const synRt = new THREE.RenderTarget(SYN_DIM, SYN_DIM, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.NoColorSpace,
      });
      synRt.texture.name = 'output';
      const f = computeCameraFrustum(worldRect);
      synCamera.left = f.left;
      synCamera.right = f.right;
      synCamera.top = f.top;
      synCamera.bottom = f.bottom;
      synCamera.updateProjectionMatrix();
      const prevTarget = renderer.getRenderTarget();
      const previousMRT = renderer.getMRT();
      renderer.setMRT(waterZeroMrt);
      renderer.setRenderTarget(synRt);
      renderer.setClearColor(new THREE.Color(0, 0, 0), 1);
      renderer.render(synScene, synCamera);
      renderer.setRenderTarget(prevTarget);
      renderer.setMRT(previousMRT);
      const wideBuf = await renderer.readRenderTargetPixelsAsync(synRt, 0, 0, SYN_DIM, SYN_DIM);
      const wideRaw = wideBuf instanceof Promise ? await wideBuf : wideBuf;
      const wideBytes = wideRaw instanceof Uint8Array ? wideRaw : new Uint8Array(wideRaw.buffer ?? wideRaw);
      const artifacts = [];
      artifacts.push(await saveDebugPngGeneric(wideBytes, SYN_DIM, runId, 'synthetic-river-channel23-wide.png'));

      // ── SECOND VISUAL — channel 7 (`turbidity`), THE ACTUAL BASE-SURFACE
      // NOISE THE NEW `flowWarp` TERM PERTURBS, not a dedicated debug view
      // built just for this (none exists, and none was needed — this
      // channel already existed for tier 2's own turbidity look). A human
      // eyeballing this PNG should see the noise pattern visibly bend near
      // the island/bends rather than running in flat, uniform bands the
      // way it would with `bankWarp`+`drift` alone.
      synSurface.setDebugChannel(7);
      renderer.setMRT(waterZeroMrt);
      renderer.setRenderTarget(synRt);
      renderer.setClearColor(new THREE.Color(0, 0, 0), 1);
      renderer.render(synScene, synCamera);
      renderer.setRenderTarget(prevTarget);
      renderer.setMRT(previousMRT);
      const turbidityBuf = await renderer.readRenderTargetPixelsAsync(synRt, 0, 0, SYN_DIM, SYN_DIM);
      const turbidityRaw = turbidityBuf instanceof Promise ? await turbidityBuf : turbidityBuf;
      const turbidityBytes =
        turbidityRaw instanceof Uint8Array ? turbidityRaw : new Uint8Array(turbidityRaw.buffer ?? turbidityRaw);
      artifacts.push(await saveDebugPngGeneric(turbidityBytes, SYN_DIM, runId, 'synthetic-river-turbidity-wide.png'));

      // ── THE SIGN PROOF LINE (2026-08-19) — channel 28 (`flowWarp` alone),
      // read back at a SINGLE known point, checked against the REAL baked
      // deviation at that same point. Renders a TIGHT crop centred exactly
      // on `bend2` (a square frustum built FROM that centre, same trick
      // `real-underground-river-sim`'s own zoomed debug renders already
      // use) so the CENTRE PIXEL is bend2 by construction — no world→pixel
      // mapping to get subtly wrong, unlike reading one pixel out of the
      // wide 512-wide render above.
      const SIGN_DIM = 64;
      const signHalfPx = 20;
      const signRect = {
        minX: bend2.wx - signHalfPx,
        minY: bend2.wy - signHalfPx,
        maxX: bend2.wx + signHalfPx,
        maxY: bend2.wy + signHalfPx,
      };
      synSurface.setDebugChannel(28);
      const signFrustum = computeCameraFrustum(signRect);
      const signCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
      signCamera.left = signFrustum.left;
      signCamera.right = signFrustum.right;
      signCamera.top = signFrustum.top;
      signCamera.bottom = signFrustum.bottom;
      signCamera.updateProjectionMatrix();
      const signRt = new THREE.RenderTarget(SIGN_DIM, SIGN_DIM, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.NoColorSpace,
      });
      signRt.texture.name = 'output';
      renderer.setMRT(waterZeroMrt);
      renderer.setRenderTarget(signRt);
      renderer.setClearColor(new THREE.Color(0, 0, 0), 1);
      renderer.render(synScene, signCamera);
      renderer.setRenderTarget(prevTarget);
      renderer.setMRT(previousMRT);
      const signBuf = await renderer.readRenderTargetPixelsAsync(
        signRt,
        Math.floor(SIGN_DIM / 2),
        Math.floor(SIGN_DIM / 2),
        1,
        1
      );
      const signRaw = signBuf instanceof Promise ? await signBuf : signBuf;
      const signBytes = signRaw instanceof Uint8Array ? signRaw : new Uint8Array(signRaw.buffer ?? signRaw);
      // Undo the shader's own `clamp(x/10 + 0.5, 0, 1)` display remap
      // (`water.js`'s own channel-28 doc) back into world px.
      const renderedFlowWarpX = (signBytes[0] / 255 - 0.5) * 10;
      const renderedFlowWarpY = (signBytes[1] / 255 - 0.5) * 10;
      // The REAL baked deviation at this exact point, already sampled above
      // as `sBend2` — the expected SIGN, independent of the shader, derived
      // straight from `WATER_FLOW_WARP_INFLUENCE`'s own doc: flowWarp must
      // be the NEGATIVE of (local direction − bulk direction).
      const bend2DirX = sBend2.mag > 1e-4 ? sBend2.vx / sBend2.mag : bulkDirXY[0];
      const bend2DirY = sBend2.mag > 1e-4 ? sBend2.vy / sBend2.mag : bulkDirXY[1];
      const expectedSignX = Math.sign(-(bend2DirX - bulkDirXY[0]));
      const expectedSignY = Math.sign(-(bend2DirY - bulkDirXY[1]));

      // ── THE GRAIN/BUBBLE ANIMATION PROOF LINE (2026-08-19) — author,
      // live, after the FIRST bubble attempt: "No sign of bubbles or
      // animation from the foam... at all." A construction-only test could
      // not have caught that (the graph builds and runs fine either way);
      // this renders channel 26 (`simFoamStructure`, which now carries both
      // the bubble nudge AND the grain multiply) at the SAME tiny crop, TWO
      // different `tSec` values a few seconds apart, and requires the
      // pixels to have actually CHANGED — the one thing a static screenshot
      // can never show, proven here instead of merely re-asserted.
      const ANIM_DIM = 32;
      synSurface.setDebugChannel(26);
      const animRect = {
        minX: bend2.wx - signHalfPx,
        minY: bend2.wy - signHalfPx,
        maxX: bend2.wx + signHalfPx,
        maxY: bend2.wy + signHalfPx,
      };
      const animFrustum = computeCameraFrustum(animRect);
      const animCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
      animCamera.left = animFrustum.left;
      animCamera.right = animFrustum.right;
      animCamera.top = animFrustum.top;
      animCamera.bottom = animFrustum.bottom;
      animCamera.updateProjectionMatrix();
      const animRt = new THREE.RenderTarget(ANIM_DIM, ANIM_DIM, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.NoColorSpace,
      });
      animRt.texture.name = 'output';
      async function renderAnimFrameAt(tMs) {
        synTimeMs.value = tMs;
        renderer.setMRT(waterZeroMrt);
        renderer.setRenderTarget(animRt);
        renderer.setClearColor(new THREE.Color(0, 0, 0), 1);
        renderer.render(synScene, animCamera);
        renderer.setRenderTarget(prevTarget);
        renderer.setMRT(previousMRT);
        const buf = await renderer.readRenderTargetPixelsAsync(animRt, 0, 0, ANIM_DIM, ANIM_DIM);
        const raw = buf instanceof Promise ? await buf : buf;
        return raw instanceof Uint8Array ? raw : new Uint8Array(raw.buffer ?? raw);
      }
      const animFrame0 = await renderAnimFrameAt(0);
      const animFrame1 = await renderAnimFrameAt(4000);
      let animDiffSum = 0;
      for (let i = 0; i < animFrame0.length; i += 4) {
        animDiffSum += Math.abs(animFrame0[i] - animFrame1[i]);
      }
      const animMeanAbsDiff = animDiffSum / (ANIM_DIM * ANIM_DIM);
      synTimeMs.value = 0;

      return {
        calibration: 'OK',
        checks: [
          evaluate('flow-bake-produced-a-real-pack', () => ({
            ok: flowStatus?.ok !== false,
            measured: flowStatus,
            expected: 'a completed bake',
          })),
          evaluate('no-sample-point-landed-on-solid-land', () => ({
            ok: [sBend1, sBend2, sLeft, sRight, sTail].every((s) => s.mag > 0 || s.speed01 >= 0),
            measured: { sBend1, sBend2, sLeft, sRight, sTail },
            expected:
              'every marked point resolves to a real (non-NaN) reading — a NaN/undefined here means a point was mis-placed on land, not that the solver failed',
          })),
          evaluate('the-narrow-side-of-the-island-runs-faster-than-the-wide-side', () => ({
            ok: sLeft.speed01 > sRight.speed01,
            measured: {
              leftSpeed01: sLeft.speed01,
              rightSpeed01: sRight.speed01,
              leftGapWorldPx: islandLeftEdgeX - islandLeftBankX,
              rightGapWorldPx: islandRightBankX - islandRightEdgeX,
            },
            expected:
              'left (narrow gap) speed > right (wide gap) speed — real incompressible flow speeds up through a ' +
              'narrower opening; a solve that ignored the island entirely would show these roughly EQUAL instead',
          })),
          evaluate('the-second-bend-genuinely-deflects-off-the-bulk-compass', () => ({
            ok: Math.abs(sBend2.angleDeg - bearingDeg) > 3,
            measured: {
              angleDeg: sBend2.angleDeg,
              bulkBearingDeg: bearingDeg,
              deviationDeg: Number((sBend2.angleDeg - bearingDeg).toFixed(1)),
            },
            expected:
              '> 3° off the bulk compass at the sharpest bend — a uniform field with no real routing would sit ' +
              'exactly on the bulk bearing everywhere, never deviating',
          })),
          evaluate('the-island-itself-reads-as-solid', () => ({
            ok: sIslandCentre.solidity > 0.5,
            measured: { islandCentreSolidity: sIslandCentre.solidity, islandCentreSpeed01: sIslandCentre.speed01 },
            expected:
              '> 0.5 — dead centre of the painted island; if this reads near-zero (open water), the solve never ' +
              'recognised the island as an obstacle at all, which alone would explain every other check above ' +
              'reading as a near-uniform field',
          })),
          evaluate('the-flow-warp-term-responds-more-at-the-sharper-bend', () => ({
            ok: warpBend2.mag > warpBend1.mag,
            measured: {
              warpBend1Px: warpBend1.mag,
              warpBend2Px: warpBend2.mag,
              bend1AngleDeg: sBend1.angleDeg,
              bend2AngleDeg: sBend2.angleDeg,
            },
            expected:
              'bend 2 (the sharper lateral swing, already measured further off the bulk compass above) should ' +
              "warp the base surface's own noise domain MORE than bend 1 (the milder bend) — the new " +
              '`buildWaterSurfaceField` term (`WATER_FLOW_WARP_INFLUENCE`) tracking real deflection, not a flat constant',
          })),
          evaluate('the-flow-warp-term-never-exceeds-its-own-cap', () => ({
            ok: warpBend1.mag <= warpCapPx + 1e-6 && warpBend2.mag <= warpCapPx + 1e-6,
            measured: { warpBend1Px: warpBend1.mag, warpBend2Px: warpBend2.mag, warpCapPx },
            expected:
              `neither point exceeds ${warpCapPx.toFixed(2)}px (WATER_TIER2_WAVE_SCALE_PX × WATER_FLOW_WARP_INFLUENCE) ` +
              "— the bounded-fraction-of-one-cell safety property `WATER_BANK_INFLUENCE`'s own doc requires of " +
              'anything added to `domainOffset`, checked against REAL baked deflection rather than just the constant in isolation',
          })),
          // ⚠️ 2026-08-23 — the check above is a no-op proof at the bench's own
          // default influence (1.0): both caps already coincide there, so it
          // cannot tell "capped correctly" apart from "never needed capping".
          // Author's own tuned preset raised WATER_FLOW_WARP_INFLUENCE to 3 —
          // measured live against the REAL Tower Bridge mask (not this
          // fixture) before this fix shipped: up to 456px (3 full noise
          // cells) at solid-boundary texels, the mechanism behind the
          // "flow emerges from the stonework's own normal" report. This
          // check re-evaluates the SAME two real baked points at influence=3
          // and demands `WATER_FLOW_WARP_CAP_CELLS` still holds regardless —
          // the one property this whole fix exists to guarantee.
          evaluate('the-flow-warp-cap-holds-even-at-3x-the-shipped-default-influence', () => {
            const boosted = 3;
            const boostedCapPx = WATER_TIER2_WAVE_SCALE_PX * WATER_FLOW_WARP_CAP_CELLS;
            const b1 = flowWarpPxAt(sBend1, boosted);
            const b2 = flowWarpPxAt(sBend2, boosted);
            return {
              ok: b1.mag <= boostedCapPx + 1e-6 && b2.mag <= boostedCapPx + 1e-6,
              measured: { warpBend1PxAtInfluence3: b1.mag, warpBend2PxAtInfluence3: b2.mag, boostedCapPx },
              expected:
                `neither point exceeds ${boostedCapPx.toFixed(2)}px (WATER_TIER2_WAVE_SCALE_PX × WATER_FLOW_WARP_CAP_CELLS) ` +
                'even with influence tripled — the cap is independent of influence BY DESIGN, not a coincidence of ' +
                'the shipped default; a regression here would mean the cap stopped applying, not just that influence changed',
            };
          }),
          evaluate('the-rendered-flow-warp-sign-matches-the-real-deflection-not-its-opposite', () => ({
            ok:
              (expectedSignX === 0 || Math.sign(renderedFlowWarpX) === expectedSignX) &&
              (expectedSignY === 0 || Math.sign(renderedFlowWarpY) === expectedSignY),
            measured: {
              renderedFlowWarpX,
              renderedFlowWarpY,
              expectedSignX,
              expectedSignY,
              bend2DirX,
              bend2DirY,
              bulkDirXY,
            },
            expected:
              'THE 2026-08-19 SIGN FIX, PROVEN AGAINST THE ACTUAL COMPILED SHADER, not just a JS mirror of it ' +
              '(a JS-only check could carry the identical sign mistake and still pass) — channel 28, read back at a ' +
              'single point where the real bake has a known, non-trivial deflection, must point AWAY from the ' +
              "obstacle side the deflection is pushing water toward, matching `WATER_FLOW_WARP_INFLUENCE`'s own " +
              'derivation, never the un-negated (and live-reported "pushes water INTO the obstacle") version',
          })),
          evaluate('the-foam-structure-genuinely-changes-over-time-not-just-translates', () => ({
            ok: animMeanAbsDiff > 3,
            measured: { animMeanAbsDiffOn0to255Scale: animMeanAbsDiff, framesComparedMsApart: 4000 },
            expected:
              '> 3 (on a 0..255 channel scale) — the SAME crop, only `tSec` changed: THE bubble nudge and grain ' +
              'multiply (`WATER_FOAM_BUBBLE_AMOUNT`/`WATER_FOAM_GRAIN_AMOUNT`, `water-shore.js`) are the only things ' +
              'that can move a pixel here without the camera or the obstacle moving too — a value near 0 would mean ' +
              'the "evolving, bubbling" fix compiles but produces no real motion, exactly the live-reported symptom ' +
              'the FIRST attempt at this (0.12 amount, no separate grain) apparently shipped',
          })),
        ],
        inputs: { bearingDeg, floodW, floodH, bendPoints: { bend1, bend2, leftOfIsland, rightOfIsland, tail } },
        stats: {
          flowStatus,
          sBend1,
          sBend2,
          sLeft,
          sRight,
          sTail,
          sIslandCentre,
          warpBend1,
          warpBend2,
          warpCapPx,
          animMeanAbsDiff,
        },
        artifacts: artifacts.filter(Boolean),
      };
    },
  });

  /** @param {Uint8Array} bytes @param {number} dim @param {string} runId @param {string} file */
  async function saveDebugPngGeneric(bytes, dim, runId, file) {
    try {
      const { saveCanvasPng } = await import('./contract.js');
      const canvas = document.createElement('canvas');
      canvas.width = dim;
      canvas.height = dim;
      const ctx = canvas.getContext('2d');
      const imgData = ctx.createImageData(dim, dim);
      imgData.data.set(bytes);
      ctx.putImageData(imgData, 0, 0);
      return await saveCanvasPng(runId, file, canvas);
    } catch {
      return null;
    }
  }

  /** `saveCanvasPng` needs `contract.js`'s own import, but this module takes
   * no dependency on `installContract()` having run yet (a bench must be
   * constructible standalone, for a future Node-side smoke test) — so the
   * artifact save is best-effort and never throws the scenario itself.
   * @param {string} runId @param {string} file */
  async function saveCanvasPngSafe(runId, file) {
    try {
      const { saveCanvasPng } = await import('./contract.js');
      const canvas = document.createElement('canvas');
      await paint(canvas);
      return await saveCanvasPng(runId, file, canvas);
    } catch {
      return null;
    }
  }

  applyFixture(paintRiver);
  bakeBody();

  return {
    name: 'water',
    title: 'Water — shore foam instrument (Water-Testament W0)',
    rung: 4,
    summary:
      'Real buildWaterSurfaceMaterial + the real JFA body-pack bake, against a synthetic bend+island river. ' +
      'The gate ladder walks WATER_DEBUG_CHANNELS 1-18 in computation order and names the first dead term.',
    scenarios,
    params: {
      note: 'live dials via window.waterBench.state.<key> then window.waterBench.render()',
      look: [
        'tint',
        'opacity',
        'absorption',
        'depthScalePx',
        'inscatter',
        'waveScalePx',
        'flowSpeedPx',
        'flowAngleDeg',
        'foam',
        'chop',
        'wetBandPx',
        'wetStrength',
        'sunGlint',
        'skySheen',
        'glossiness',
        'viewerHeight',
        'shadowResponse',
        'swashFoam',
        'breakFoam',
        'caustics',
        'tier',
        'debugChannel',
        'timeMs',
        'zoom',
      ],
    },
    checkIds: [...scenarios.values()].flatMap((s) => s.name),
    ready: () => true,
    state,
    WATER_RECT,
    applyFixture,
    bakeBody,
    render,
    paint,
    profileAcrossPool,
    gateLadder,
    selfTest,
    async runScenario(scenario, ctx) {
      return scenario.run(ctx);
    },
    getQuadWorld: () => quadWorld,
    getStatus: () => ({
      ...state,
      quadWorld,
      orientationFlip,
      jfaSteps,
      floodGrid: `${floodW}x${floodH}`,
      builtTier: surface.tier,
      outdoorsGateCompiled: surface.outdoorsGateCompiled,
      floorGateCompiled: surface.floorGateCompiled,
      normalCompiled: surface.normalCompiled,
    }),
    /** Raw GPU handles, for live `javascript_tool` probing during a diagnosis
     * — not part of the stable API (no other bench method reads this), kept
     * because water-testament W0's own instrument-building had no way to ask
     * "is the mesh even visible / what tier did this actually build" without
     * it. Mirrors the spirit of `dumpShader` one level more raw. */
    _debug: {
      surface,
      meshAbsorb,
      meshInscatter,
      scene,
      camera,
      renderer,
      bodyRt,
      bodyMaterials,
      get maskTexture() {
        return maskTexture;
      },
      get rt() {
        return rt;
      },
      /** ISOLATION PROBE (2026-08-17 live diagnosis) — a QuadMesh sampling
       * `maskTexture` via a BRAND NEW, minimal `texture(mask, uv()).r`
       * fragmentNode, bypassing `buildWaterBodyResolveMaterial` entirely.
       * Answers "is the texture itself readable at all through this exact
       * mechanism" independent of the resolve material's own graph. */
      async probeMaskDirect() {
        const { texture: texFn, uv: uvFn, vec4: vec4Fn } = THREE.TSL;
        const probeMat = new THREE.NodeMaterial();
        const node = texFn(maskTexture, uvFn());
        probeMat.fragmentNode = vec4Fn(node.r, node.r, node.r, 1);
        const probeQuad = new THREE.QuadMesh(probeMat);
        const probeRt = new THREE.RenderTarget(floodW, floodH, rtDescribe(THREE.LinearFilter));
        renderQuadPass(probeRt, probeQuad);
        const buf = await renderer.readRenderTargetPixelsAsync(probeRt, 0, 0, floodW, floodH);
        const raw = buf instanceof Promise ? await buf : buf;
        const u16 = raw instanceof Uint16Array ? raw : new Uint16Array(raw.buffer ?? raw);
        let max = -Infinity;
        let nonZero = 0;
        for (let i = 0; i < floodW * floodH; i++) {
          const r = halfToFloat(u16[i * 4]);
          if (r > max) max = r;
          if (r > 1e-4) nonZero++;
        }
        probeMat.dispose();
        probeRt.dispose();
        return { max, nonZero, totalTexels: floodW * floodH };
      },
    },
    /**
     * THE GENERATED WGSL for whichever material is currently attached —
     * `bench-specular.js`'s own highest-value tool, one level over: this is
     * how a variable ASSIGNED inside one debug-channel branch and READ from
     * another would actually be caught, if arithmetic selection ever
     * regressed back toward `select()`.
     */
    async dumpShader() {
      await render();
      const mat = state.debugChannel > 0 ? meshInscatter : meshAbsorb;
      const s = await renderer.debug.getShaderAsync(scene, camera, mat);
      return { vertex: s.vertexShader, fragment: s.fragmentShader };
    },
  };
}
