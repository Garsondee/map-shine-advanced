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
  // MASK PROXIMITY (2026-08-17) — reads the bench's own full-res fixture
  // mask directly, independent of the derivation grid every earlier channel
  // in this list depends on. MUST show real signal here: unlike
  // `obstacleFoam` (depth-buffer-sourced, and this bench wires no depth
  // pass), this one only needs the mask the bench already provides.
  'maskProximityFoam',
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
 * `obstacleFoam` (2026-08-17) lives here too: it reads `buf:scene.depth`
 * (`water-render.js#WATER_OBSTACLE_RING_TAPS`), which this bench's synthetic
 * fixture never provides — legitimately, structurally zero here, same as it
 * is on any real scene with no depth-authority pass wired. A live Foundry
 * session is what proves or disproves this channel, not the bench.
 * `flowSolidity`/`flowVelocity` (S2/S3, 2026-08-17) live here for the
 * OPPOSITE reason: this bench builds the material directly, never through
 * `water-surface-subsystem.js`'s own `flowPackPlaceholder`+
 * `setFlowPackTexture` wiring, so it never passes a `flowPackTexture`
 * argument at all — a live `res:waterFlow` bake (both the S2 solidity seed
 * AND the S3 coarse-to-fine velocity cascade) is a `vt-pan-viewer.js`-only
 * thing (the per-floor flow subsystem), structurally out of reach for a
 * standalone shader bench with no scene, no floor list, and no allocator. */
const INFORMATIONAL = ['bedVisibility', 'obstacleFoam', 'flowSolidity', 'flowVelocity'];

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
    tier: WATER_DEFAULT_TIER >= 4 ? WATER_DEFAULT_TIER : 4,
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
    // ⚠️ NO `depthTexture` — the depth-authority occlusion gate is out of
    // scope for a foam-visibility bench (Water-Testament W0's own ask); this
    // compiles the gate OUT (Effects.md Law 4), so water always draws
    // unoccluded, exactly the "torture fixture" shape `water-render.test.mjs`
    // already proves safe.
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
  const scene = new THREE.Scene();
  scene.add(meshAbsorb, meshInscatter);

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
