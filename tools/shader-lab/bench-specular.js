/**
 * SHADER LAB — THE SPECULAR BENCH.
 *
 * Builds the REAL production shine material (`buildSpecularSurfaceMaterial`,
 * imported unmodified from `src/effects/specular/specular-render.js`) on a real
 * WebGPU device, feeds it hand-authored `_Specular` / `buf:scene.illum` /
 * `buf:scene.depth` / `_Outdoors` inputs, and reads the exact pixels back.
 *
 * ============================================================================
 * WHY THIS BENCH EXISTS, AND WHAT IT IS ACTUALLY FOR
 * ============================================================================
 * Shine has shipped invisible repeatedly, and every round of it followed the
 * same shape: a plausible theory about ONE factor in a long product, fixed
 * blind, reloaded into a full Foundry scene, and reported still-invisible —
 * because a product of eight terms that reads zero tells you nothing at all
 * about WHICH term was zero (`feedback_count_silent_preconditions`).
 *
 * The composite is (STAGE 3, 2026-08-05 — `coverage`'s own second factor
 * used to be `floorMatch × (1 − occludedHere)`, two `buf:scene.attr` reads;
 * `specular-render.js`'s own "STAGE 3" header has the full account of why one
 * `buf:scene.depth` rank comparison replaced both):
 *
 *     shine = ceil(tint × incident × strength × coverage)              (sheen)
 *           + ceil(tint × shimmer × gain × incident × strength × coverage)
 *     coverage = presence × notOccluded
 *
 * `gateLadder()` below renders EVERY factor in that expression, one debug
 * channel per term, over the SAME painted region, and reports each one's mean
 * and max. A zero in the ladder names the broken term outright. That is the
 * whole point: this bench does not test "does specular look right", it answers
 * "which of the seven things that must all be non-zero is zero".
 *
 * ⚠️ IT CANNOT SEE A WIRING BUG IN THE VIEWER. Every input here is synthetic
 * and correct by construction, so a green ladder means "the shader is fine
 * given good inputs", never "the effect works live". The value of that is
 * precise and limited: it partitions the search space into shader vs. plumbing
 * in one run, instead of alternating guesses across both for ten rounds.
 *
 * @module tools/shader-lab/bench-specular
 */

import { buildSpecularSurfaceMaterial } from '../../src/effects/specular/specular-render.js';
import { buildSpecularIslandPack } from '../../src/effects/specular/specular-islands.js';
import { buildWorldSpaceOutdoorsGate } from '../../src/effects/lighting/environmental-light.js';
import { SPECULAR_DEBUG_CHANNELS } from '../../src/effects/specular/specular.js';
import { computeCameraFrustum, QUAD_UVS, QUAD_INDICES, buildQuadPositions } from '../../src/scene/world-quad.js';
// STAGE 3 (2026-08-05) — the depth-authority gate's own REAL production
// pieces, the same ones `vt/scene-depth.js`'s actual pass uses, proven first
// against a live device in `bench-scene-depth.js` (this module's own header:
// "WHAT IS PROVEN, AND WHERE"). This bench renders a REAL, small depth pass
// with these rather than hand-typing simulated byte values, for the same
// reason it builds the REAL `buildSpecularSurfaceMaterial` rather than a
// lab-local reimplementation — see this file's own header.
import {
  DEPTH_PASS_CAMERA_Z,
  DEPTH_PASS_NEAR,
  DEPTH_PASS_FAR,
  rankToDepthZ,
  computeTieSafeExpectedDepth,
  buildSceneDepthWriterMaterial,
  buildSceneDepthProxyMesh,
} from '../../src/vt/scene-depth.js';

/** The bench's world rect. Fixed for the whole session so a probe coordinate
 * keeps meaning the same thing across scenario changes, exactly as the sun
 * bench's own `FIELD_RECT` does. */
export const SPEC_RECT = Object.freeze({ minX: 0, minY: 0, maxX: 2000, maxY: 2000 });

/** Readback/paint resolution — this bench's stand-in for the drawing buffer. */
const SCREEN_DIM = 512;
/** The `_Specular` file's own resolution. Deliberately NOT the screen dim: a
 * mask texel and a screen pixel are different things and a bench that made them
 * equal would hide every mapping bug it exists to catch. */
const MASK_DIM = 512;

/**
 * `buf:scene.depth` RANK presets — STAGE 3 (2026-08-05), replacing the old
 * `buf:scene.attr` B-channel byte presets below this comment's own former
 * self. Each preset is a list of RANKS to actually render into a REAL depth
 * pass (`renderDepthPass`, `createSpecularBench`'s own function) — never a
 * hand-typed byte — background is rank 0, an occluder (a Tile, a roof) is
 * rank 1, and the query point's own expected depth is ALWAYS rank 0's
 * (`backgroundExpectedDepth`, computed once, constant across every preset
 * exactly as a real background item's own rank would be regardless of what
 * gets drawn over it elsewhere).
 *
 * ⚠️ **TWO OLD PRESETS HAVE NO ANALOGUE HERE, AND THAT IS A REAL
 * SIMPLIFICATION, NOT A DROPPED CASE.** The old `halfAlpha` (margin test) and
 * `oldWeight4` (regression case) both existed because `buf:scene.attr`'s
 * write was an ALPHA-BLENDED MRT write that could survive at partial
 * strength (`feedback_alpha_blended_write_needs_wide_margin`) — a failure
 * mode `computeSceneDepthFlags`'s depth-pass writer does not have:
 * `buildSceneDepthWriterMaterial`'s own header says it plainly, "nothing in
 * this pass blends at all," an alpha TEST (`.discard()`), not a blend
 * factor. There is no "occluder wrote at half strength" state left to
 * simulate.
 */
export const DEPTH_PRESETS = Object.freeze({
  /** Healthy: only the background is drawn at the query point. Gate OPEN —
   * and, per `computeTieSafeExpectedDepth`'s own doc, this IS the tie case
   * every unoccluded pixel hits in production, not a lucky corner. */
  background: { label: 'bare background art (gate open)', ranks: [0] },
  /** Background (rank 0) AND a Tile / the Level's own foreground (rank 1)
   * BOTH drawn over the SAME area — exactly production's shape, where the
   * background is still there, just covered. `LessDepth` + a higher rank's
   * smaller stored depth means rank 1 genuinely WINS the real depth test at
   * this query point, exactly as it would in the real pass. CLOSED. */
  tileOver: { label: 'Tile or roof on top (gate closes)', ranks: [0, 1] },
  /** ⚠️ THE FAIL-OPEN CASE. Nothing drawn at all — the depth pass clears to
   * the far plane (1) and nothing real ever loses to that (`rankToDepthZ`'s
   * own doc). Must render, not vanish. */
  neverWritten: { label: 'depth pass wrote nothing here (cleared) — MUST still draw', ranks: [] },
});

/** Decode one IEEE-754 binary16 to a JS number — `scene.lit` is HalfFloat in
 * production and this bench matches it, so the readback arrives as raw u16.
 * Written out rather than pulled from a dependency: the bench is dependency-free
 * on purpose, and a wrong decode here would be an instrument that lies.
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

/**
 * three's `neutralToneMapping`, transcribed — the SAME curve `grade-present.js`
 * runs on every frame by default. Reported alongside the raw linear value
 * because ROUND 10 of this effect's own history is precisely the lesson that a
 * number measured before the global tonemap says nothing about what reaches the
 * screen (`specular-pattern.test.mjs` carries the Node twin of this).
 * @param {number[]} rgb @returns {number[]}
 */
export function neutralToneMap(rgb) {
  const StartCompression = 0.8 - 0.04;
  const Desaturation = 0.15;
  let [r, g, b] = rgb;
  const x = Math.min(r, Math.min(g, b));
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  r -= offset;
  g -= offset;
  b -= offset;
  const peak = Math.max(r, Math.max(g, b));
  if (peak < StartCompression) return [r, g, b];
  const d = 1 - StartCompression;
  const newPeak = 1 - (d * d) / (peak + d - StartCompression);
  const scale = newPeak / peak;
  r *= scale;
  g *= scale;
  b *= scale;
  const gAmt = 1 - 1 / (Desaturation * (peak - newPeak) + 1);
  return [r + (newPeak - r) * gAmt, g + (newPeak - g) * gAmt, b + (newPeak - b) * gAmt];
}

// ---------------------------------------------------------------------------
// Mask scenarios — each paints an RGBA `_Specular` file, row 0 = world minY
// (the DataTexture convention this whole renderer uses: flipY false, top row
// first). Returns raw bytes, exactly what `vt/mask-image.js`'s 'rgb' mode
// hands the real subsystem.
// ---------------------------------------------------------------------------

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

const inRect = (u, v, u0, v0, u1, v1) => u >= u0 && u <= u1 && v >= v0 && v <= v1;

export const MASK_SCENARIOS = Object.freeze({
  /** One bright gold plate — the case the author's own live report described
   * ("a scene full of golden/brassy metal"). */
  goldPlate: (u, v) => (inRect(u, v, 0.3, 0.3, 0.7, 0.7) ? [230, 180, 60, 255] : [0, 0, 0, 0]),
  /** Grey steel — §10.1's own "worked only on gold" regression, as a scenario. */
  greySteel: (u, v) => (inRect(u, v, 0.3, 0.3, 0.7, 0.7) ? [170, 172, 178, 255] : [0, 0, 0, 0]),
  /** ⚠️ NO ALPHA CHANNEL AT ALL — the common authoring case (`_Specular`
   * painted as a flat greyscale JPEG/WEBP). Exercises the alpha-missing
   * fallback in the decode, which without it decodes the whole file to black. */
  noAlpha: (u, v) => (inRect(u, v, 0.3, 0.3, 0.7, 0.7) ? [200, 200, 200, 0] : [0, 0, 0, 0]),
  /** Scattered coin-sized specks — the case that made the island bake report
   * `islands: 0` before clustering landed. */
  coins: (u, v) => {
    const gx = Math.floor(u * 40);
    const gy = Math.floor(v * 40);
    const on = gx >= 12 && gx <= 28 && gy >= 12 && gy <= 28 && (gx * 7 + gy * 13) % 5 === 0;
    return on ? [235, 190, 70, 255] : [0, 0, 0, 0];
  },
  /** Several separate objects at different brightnesses — the per-island
   * parallax case, and the one where `cropWasteRatio` gets interesting. */
  mixed: (u, v) => {
    if (inRect(u, v, 0.08, 0.08, 0.3, 0.22)) return [235, 190, 70, 255]; // gold bar
    if (inRect(u, v, 0.6, 0.15, 0.9, 0.25)) return [180, 182, 190, 255]; // steel rail
    if (inRect(u, v, 0.15, 0.6, 0.35, 0.9)) return [90, 60, 40, 255]; // dark iron
    if (inRect(u, v, 0.62, 0.62, 0.88, 0.88)) return [250, 250, 250, 255]; // chrome
    return [0, 0, 0, 0];
  },
});

/**
 * Build the specular bench.
 * @param {object} args
 * @param {*} args.THREE @param {*} args.renderer @param {(m:string)=>void} args.log
 * @returns {object} the bench API (also parked on `window.specularBench`).
 */
export function createSpecularBench({ THREE, renderer, log }) {
  const { uniform, vec4, texture } = THREE.TSL;

  const state = {
    scenario: 'goldPlate',
    depthPreset: 'background',
    illum: 0.6,
    darknessFloor: 0,
    /** `SPECULAR_INCIDENT_KNEE`'s production default. Exposed on the bench
     * because the sweep that found the dead-below-0.75 bug is exactly the
     * sweep that has to be re-run to prove a knee change fixed it. */
    incidentKnee: 0.15,
    outdoors: 0,
    strength: 1,
    shimmerGain: 5.5,
    saturation: 1,
    islandSpread: 1,
    /** The base `scene.lit` this additive pass draws ONTO — production never
     * shows shine on black, and "is it visible" is a question about contrast
     * against the lit map, never about the raw value. */
    baseScene: 0.25,
    timeMs: 0,
    debugChannel: 0,
    zoom: 1,
  };

  const uViewRect = uniform(vec4(SPEC_RECT.minX, SPEC_RECT.minY, SPEC_RECT.maxX, SPEC_RECT.maxY));
  const uOutdoorsRect = uniform(vec4(SPEC_RECT.minX, SPEC_RECT.minY, SPEC_RECT.maxX, SPEC_RECT.maxY));
  const uTimeMs = uniform(0);

  /** @param {Uint8Array} data @param {number} w @param {number} h @param {boolean} nearest */
  const makeTex = (data, w, h, nearest = false) => {
    const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    const f = nearest ? THREE.NearestFilter : THREE.LinearFilter;
    t.minFilter = f;
    t.magFilter = f;
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.colorSpace = THREE.NoColorSpace; // RAW bytes — the mask carries no transfer curve
    t.flipY = false; // row 0 = minY, this renderer's own convention everywhere
    t.needsUpdate = true;
    return t;
  };

  const solidTex = (r, g, b, a) => makeTex(new Uint8Array([r, g, b, a]), 1, 1);

  let maskTexture = solidTex(0, 0, 0, 255);
  let islandPackTexture = makeTex(new Uint8Array([191, 128, 0, 0]), 1, 1, true);
  const illumTexture = solidTex(153, 153, 153, 255);
  const outdoorsTexture = solidTex(0, 0, 0, 255);
  const outdoorsTexNode = texture(outdoorsTexture);

  // ── THE DEPTH-AUTHORITY MINI SCENE — STAGE 3 (2026-08-05) ────────────────
  // A REAL depth pass, the SAME production pieces `vt/scene-depth.js` uses
  // (see this file's own import comment) — never a hand-typed byte standing
  // in for what a real depth test would decide. Two ranks are all this bench
  // needs: 0 (the background) and 1 (a Tile/roof occluder), both drawn full-
  // rect so any query point sees whichever `DEPTH_PRESETS` entry asks for.
  const DEPTH_MAX_RANK = 2;
  const backgroundExpectedDepth = computeTieSafeExpectedDepth(0, DEPTH_MAX_RANK);
  const depthTex = new THREE.DepthTexture(SCREEN_DIM, SCREEN_DIM, THREE.FloatType);
  const depthRt = new THREE.RenderTarget(SCREEN_DIM, SCREEN_DIM, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    depthBuffer: true,
    depthTexture: depthTex,
  });
  const depthCamera = new THREE.OrthographicCamera(
    SPEC_RECT.minX,
    SPEC_RECT.maxX,
    SPEC_RECT.maxY,
    SPEC_RECT.minY,
    DEPTH_PASS_NEAR,
    DEPTH_PASS_FAR
  );
  depthCamera.position.set(0, 0, DEPTH_PASS_CAMERA_Z);
  depthCamera.lookAt(0, 0, 0);
  depthCamera.updateProjectionMatrix();
  const depthQuadGeometry = new THREE.BufferGeometry();
  depthQuadGeometry.setAttribute(
    'position',
    new THREE.BufferAttribute(
      buildQuadPositions([
        { x: SPEC_RECT.minX, y: SPEC_RECT.minY },
        { x: SPEC_RECT.maxX, y: SPEC_RECT.minY },
        { x: SPEC_RECT.maxX, y: SPEC_RECT.maxY },
        { x: SPEC_RECT.minX, y: SPEC_RECT.maxY },
      ]),
      3
    )
  );
  depthQuadGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
  depthQuadGeometry.setIndex(Array.from(QUAD_INDICES));
  // `floorIndex`/`flags` are inert here — specular's own gate reads NEITHER
  // (see `computeSpecularDepthGate`'s own header for why no flags-bit hard
  // block is needed), so 0/0 is a correct placeholder, not a guess.
  const backgroundDepthMesh = buildSceneDepthProxyMesh({
    THREE,
    geometry: depthQuadGeometry,
    material: buildSceneDepthWriterMaterial({ THREE, floorIndex: 0, flags: 0 }),
    z: rankToDepthZ(0, DEPTH_MAX_RANK),
  });
  const occluderDepthMesh = buildSceneDepthProxyMesh({
    THREE,
    geometry: depthQuadGeometry,
    material: buildSceneDepthWriterMaterial({ THREE, floorIndex: 0, flags: 0 }),
    z: rankToDepthZ(1, DEPTH_MAX_RANK),
  });
  const depthScene = new THREE.Scene();

  /** Render exactly `ranks` into `depthTex`, clearing to the far plane (1)
   * first — `DEPTH_PRESETS.neverWritten`'s own fail-open case relies on this
   * clear happening EVERY call, not once at startup, so switching AWAY from
   * an occluded preset genuinely clears the previous preset's write rather
   * than leaving it stale underneath. @param {number[]} ranks */
  function renderDepthPass(ranks) {
    depthScene.clear();
    if (ranks.includes(0)) depthScene.add(backgroundDepthMesh);
    if (ranks.includes(1)) depthScene.add(occluderDepthMesh);
    const prevTarget = renderer.getRenderTarget();
    const prevClearDepth = renderer.getClearDepth();
    renderer.setRenderTarget(depthRt);
    renderer.setClearColor(0x000000, 0);
    renderer.setClearDepth(1);
    renderer.clear(true, true, true);
    renderer.render(depthScene, depthCamera);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearDepth(prevClearDepth);
  }

  // THE REAL MATERIAL. Built exactly as `specular-surface-subsystem.js` builds
  // it, with the same injected seam (`buildWorldSpaceOutdoorsGate`) the viewer
  // passes — no lab-local reimplementation of anything the shipped path owns.
  const surface = buildSpecularSurfaceMaterial({
    THREE,
    maskTexture,
    islandPackTexture,
    illumTexture,
    depthTexture: depthTex,
    uViewRect,
    uOutdoorsRect,
    outdoorsTexNode,
    buildOutdoorsGate: buildWorldSpaceOutdoorsGate,
    timeMsNode: uTimeMs,
  });

  // The world-space quad, same three helpers the subsystem uses.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
  geometry.setIndex(Array.from(QUAD_INDICES));
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));

  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(geometry, surface.specularMaterial);
  mesh.frustumCulled = false;
  scene.add(mesh);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  let rt = null;
  /** The world AABB the quad is cropped to — set by `applyScenario`. */
  let quadWorld = null;
  let maskUvBounds = null;
  let islandReport = null;
  let orientationFlip = false;

  /** The camera rect currently on screen — zoom 1 is the whole world rect. */
  function viewRect() {
    const cx = (SPEC_RECT.minX + SPEC_RECT.maxX) / 2;
    const cy = (SPEC_RECT.minY + SPEC_RECT.maxY) / 2;
    const halfW = ((SPEC_RECT.maxX - SPEC_RECT.minX) / 2) * state.zoom;
    const halfH = ((SPEC_RECT.maxY - SPEC_RECT.minY) / 2) * state.zoom;
    return { minX: cx - halfW, minY: cy - halfH, maxX: cx + halfW, maxY: cy + halfH };
  }

  /** Rebuild every screen-space input at the current settings. */
  function pushScreenBuffers() {
    // `buf:scene.illum` — Foundry's ambient is baked in upstream, so a "dark"
    // room is ~0.19, never 0. That is exactly what `uDarknessFloor` exists to
    // subtract, so the bench feeds the same shape rather than a clean zero.
    const lv = Math.round(Math.max(0, Math.min(1, state.illum)) * 255);
    illumTexture.image.data.set([lv, lv, lv, 255]);
    illumTexture.needsUpdate = true;

    const preset = DEPTH_PRESETS[state.depthPreset] ?? DEPTH_PRESETS.background;
    renderDepthPass(preset.ranks);

    const o = Math.round(Math.max(0, Math.min(1, state.outdoors)) * 255);
    outdoorsTexture.image.data.set([o, o, o, 255]);
    outdoorsTexture.needsUpdate = true;
  }

  /** Load a mask scenario: upload it, bake the REAL island pack from the same
   * bytes, crop the quad to the painted AABB — the subsystem's own sequence. */
  function applyScenario(nameOrPaint) {
    // A raw paint function is accepted as well as a named scenario — `selfTest`
    // needs a one-off orientation marker, and mutating the frozen scenario table
    // to smuggle one in is not a thing a test rig should do to its own subject.
    const paint = typeof nameOrPaint === 'function' ? nameOrPaint : MASK_SCENARIOS[nameOrPaint];
    if (typeof nameOrPaint === 'string') state.scenario = paint ? nameOrPaint : 'goldPlate';
    const { data, w, h } = rasterMask(paint ?? MASK_SCENARIOS.goldPlate);

    // The painted AABB, measured by MAX of RGB (never red — a blue-painted
    // steel object has r=0 and measuring by red crops it out of existence).
    let minU = 1;
    let minV = 1;
    let maxU = 0;
    let maxV = 0;
    let painted = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (Math.max(data[i], data[i + 1], data[i + 2]) > 0) {
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
    maskTexture = makeTex(data, w, h);
    surface.setMaskTexture(maskTexture);

    const spanX = SPEC_RECT.maxX - SPEC_RECT.minX;
    const spanY = SPEC_RECT.maxY - SPEC_RECT.minY;
    quadWorld = {
      minX: SPEC_RECT.minX + minU * spanX,
      minY: SPEC_RECT.minY + minV * spanY,
      maxX: SPEC_RECT.minX + maxU * spanX,
      maxY: SPEC_RECT.minY + maxV * spanY,
    };
    maskUvBounds = { minU, minV, maxU, maxV };
    surface.setMaskUvBounds(maskUvBounds);
    geometry.getAttribute('position').array.set(
      buildQuadPositions([
        { x: quadWorld.minX, y: quadWorld.minY },
        { x: quadWorld.maxX, y: quadWorld.minY },
        { x: quadWorld.maxX, y: quadWorld.maxY },
        { x: quadWorld.minX, y: quadWorld.maxY },
      ])
    );
    geometry.getAttribute('position').needsUpdate = true;

    // THE REAL BAKE — `buildSpecularIslandPack`, unmodified, on the same bytes.
    try {
      const pack = buildSpecularIslandPack({ rgba: data, width: w, height: h, spread: state.islandSpread });
      islandPackTexture.dispose();
      islandPackTexture = makeTex(pack.data, pack.w, pack.h, true);
      surface.setIslandPackTexture(islandPackTexture);
      surface.setIslandBakeStatus(pack.islandCount > 0 ? 2 : 1);
      islandReport = {
        grid: `${pack.w}x${pack.h}`,
        islands: pack.islandCount,
        droppedSmall: pack.droppedSmall,
        labelledTexels: pack.labelledTexels,
        preClusterComponents: pack.preClusterComponents,
      };
    } catch (err) {
      islandReport = { error: String(err?.message ?? err) };
      surface.setIslandBakeStatus(0);
    }
    return { paintedFraction: painted / (w * h), maskUvBounds, quadWorld, islandReport };
  }

  function pushLook() {
    surface.setStrength(state.strength);
    surface.setSaturation(state.saturation);
    surface.setShimmerGain(state.shimmerGain);
    surface.setDarknessFloor(state.darknessFloor, state.darknessFloor, state.darknessFloor);
    surface.setIncidentKnee(state.incidentKnee);
    // Constant across every preset — the background's own rank does not
    // change just because an occluder gets drawn somewhere else, exactly
    // like a real item's rank in production. `renderDepthPass` (called from
    // `pushScreenBuffers`, just above this function every `render()`) is
    // what actually varies per preset.
    surface.setExpectedDepth(backgroundExpectedDepth);
    surface.setDebugChannel(state.debugChannel);
    const v = viewRect();
    surface.setViewCentre((v.minX + v.maxX) / 2, (v.minY + v.maxY) / 2);
    uTimeMs.value = state.timeMs;
    mesh.material = state.debugChannel > 0 ? surface.debugMaterial : surface.specularMaterial;
  }

  async function render() {
    if (!rt) {
      rt = new THREE.RenderTarget(SCREEN_DIM, SCREEN_DIM, {
        // HalfFloat, matching `scene.lit` exactly — an 8-bit target would clip
        // every glint peak this effect is designed to push past 1.0, and then
        // report the clip as the shader's own answer.
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.NoColorSpace,
      });
    }
    pushScreenBuffers();
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
    // The BASE SCENE this additive pass lands on. Debug channels overwrite it
    // (One/Zero), so this only shows through on channel 0 — which is correct:
    // "is the shine visible" is a contrast question against the lit map.
    const base = state.debugChannel > 0 ? 0 : state.baseScene;
    renderer.setClearColor(new THREE.Color(base, base, base), 1);
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
  }

  /** The whole target, decoded from half-float, row 0 = screen TOP after the
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

  /** World XY → readback pixel, under the SAME camera rect the render used. */
  function worldToPixel(wx, wy) {
    const v = viewRect();
    const u = (wx - v.minX) / (v.maxX - v.minX);
    const t = (wy - v.minY) / (v.maxY - v.minY);
    return {
      px: Math.max(0, Math.min(SCREEN_DIM - 1, Math.round(u * (SCREEN_DIM - 1)))),
      py: Math.max(0, Math.min(SCREEN_DIM - 1, Math.round(t * (SCREEN_DIM - 1)))),
    };
  }

  /** @param {Float32Array} frame @param {number} wx @param {number} wy */
  function pixelAt(frame, wx, wy) {
    const { px, py } = worldToPixel(wx, wy);
    const i = (py * SCREEN_DIM + px) * 4;
    return { r: frame[i], g: frame[i + 1], b: frame[i + 2], a: frame[i + 3] };
  }

  async function samplePixel(wx, wy) {
    const frame = await readFrame();
    const p = pixelAt(frame, wx, wy);
    return { x: wx, y: wy, ...p, luma: 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b };
  }

  /** Mean/max/min over the PAINTED world AABB only — averaging in the empty
   * margin around the metal would dilute every reading toward zero and make a
   * healthy channel look broken. */
  function statsOverQuad(frame) {
    if (!quadWorld) return null;
    const a = worldToPixel(quadWorld.minX, quadWorld.minY);
    const b = worldToPixel(quadWorld.maxX, quadWorld.maxY);
    const x0 = Math.min(a.px, b.px);
    const x1 = Math.max(a.px, b.px);
    const y0 = Math.min(a.py, b.py);
    const y1 = Math.max(a.py, b.py);
    let sum = 0;
    let max = -Infinity;
    let min = Infinity;
    let n = 0;
    let peakRgb = [0, 0, 0];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * SCREEN_DIM + x) * 4;
        const l = 0.2126 * frame[i] + 0.7152 * frame[i + 1] + 0.0722 * frame[i + 2];
        sum += l;
        if (l > max) {
          max = l;
          peakRgb = [frame[i], frame[i + 1], frame[i + 2]];
        }
        if (l < min) min = l;
        n++;
      }
    }
    return { mean: sum / n, max, min, n, peakRgb };
  }

  /**
   * ⚠️ THE HEADLINE INSTRUMENT — every factor in the composite, measured.
   *
   * Renders one debug channel per term over the painted AABB and reports its
   * mean/max. Read it top to bottom: the FIRST row whose max is 0 is the term
   * that kills the product, and everything below it is a consequence rather
   * than a second bug (`feedback_count_silent_preconditions` — the failure mode
   * this effect has hit four separate times).
   */
  async function gateLadder() {
    // ⚠️ TWO KINDS OF CHANNEL, AND CONFLATING THEM MAKES THE LADDER LIE.
    // A CHAIN term multiplies into `shine`, so a zero in one IS the bug. An
    // INFORMATIONAL channel is a raw reading whose zero can be the correct
    // answer — `outdoors` is 0 on any indoor scene, and `depthDirect` reads
    // a small, non-zero stored-depth value on HEALTHY bare background art
    // (rank 0's own real depth, never literally zero — see `rankToDepthZ`'s
    // own doc for why every real rank lands strictly inside `(0,1)`). This
    // bench flagged its own predecessor (`attrDirect`) as a dead term once
    // already, the moment the OLD gate's polarity was inverted —
    // `feedback_instruments_must_not_lie` arriving for the instrument built
    // to catch it. Classify, don't special-case.
    const CHAIN = [
      'quad',
      'mask',
      'strength',
      'presence',
      'tint',
      'islands',
      'floorGate',
      'illum',
      'cellular',
      'shimmer',
      'sheen',
      'glint',
      'final',
    ];
    const INFORMATIONAL = ['depthDirect', 'outdoors', 'illumDirect'];
    const wanted = [...CHAIN, ...INFORMATIONAL];
    const byId = new Map(SPECULAR_DEBUG_CHANNELS.map((c) => [c.id, c]));
    const restore = state.debugChannel;
    const rows = [];
    try {
      for (const id of wanted) {
        const ch = byId.get(id);
        if (!ch) continue;
        state.debugChannel = ch.n;
        await render();
        const s = statsOverQuad(await readFrame());
        rows.push({
          n: ch.n,
          id,
          mean: Number(s.mean.toFixed(5)),
          max: Number(s.max.toFixed(5)),
          min: Number(s.min.toFixed(5)),
          peakRgb: s.peakRgb.map((v) => Number(v.toFixed(4))),
          kind: CHAIN.includes(id) ? 'chain' : 'info',
          // Only a CHAIN term can be "dead" — see the classification note above.
          DEAD: CHAIN.includes(id) && s.max <= 1e-6,
          zero: s.max <= 1e-6,
        });
      }
    } finally {
      state.debugChannel = restore;
      await render();
    }
    const firstDead = rows.find((r) => r.DEAD);
    return {
      scenario: state.scenario,
      depth: `${state.depthPreset} (expectedDepth=${backgroundExpectedDepth.toFixed(4)} for rank 0; storedDepth < expectedDepth means OCCLUDED — gate shuts)`,
      illum: state.illum,
      islands: islandReport,
      rows,
      verdict: firstDead
        ? `FIRST DEAD CHAIN TERM: '${firstDead.id}' (channel ${firstDead.n}) — everything below it is a consequence.`
        : 'no dead chain term — every factor in the composite is non-zero',
      infoZeros: rows
        .filter((r) => r.kind === 'info' && r.zero)
        .map((r) => r.id)
        .join(', '),
    };
  }

  /** The end-to-end question, in the units the screen uses: how much brighter
   * is the metal than the base scene AFTER the same tonemap `grade-present.js`
   * runs? A raw linear delta is not an answer (ROUND 10's own lesson). */
  async function visibilityReport() {
    const restore = state.debugChannel;
    state.debugChannel = 0;
    await render();
    const frame = await readFrame();
    const s = statsOverQuad(frame);
    // A point guaranteed OUTSIDE the painted AABB — the unlit reference.
    const off = pixelAt(frame, SPEC_RECT.minX + 10, SPEC_RECT.minY + 10);
    state.debugChannel = restore;
    const base = state.baseScene;
    const tmPeak = neutralToneMap(s.peakRgb);
    const tmBase = neutralToneMap([base, base, base]);
    const peakL = 0.2126 * tmPeak[0] + 0.7152 * tmPeak[1] + 0.0722 * tmPeak[2];
    const baseL = 0.2126 * tmBase[0] + 0.7152 * tmBase[1] + 0.0722 * tmBase[2];
    return {
      baseScene: base,
      offMetal: Number((0.2126 * off.r + 0.7152 * off.g + 0.0722 * off.b).toFixed(5)),
      onMetalMean: Number(s.mean.toFixed(5)),
      onMetalPeak: Number(s.max.toFixed(5)),
      onMetalMin: Number(s.min.toFixed(5)),
      postToneMap: { base: Number(baseL.toFixed(4)), peak: Number(peakL.toFixed(4)) },
      screenContrast: Number((peakL / Math.max(baseL, 1e-6)).toFixed(3)),
      note:
        'screenContrast is peak metal over the base scene AFTER neutralToneMapping. ' +
        'Under ~1.15 is not visible on a real map; the shimmer pattern needs its own ' +
        'range too — compare onMetalMin against onMetalPeak.',
    };
  }

  /**
   * ORIENTATION, VERIFIED NOT ASSUMED (`feedback_y_flip_recurring_risk` — a new
   * mapping is a new chance to be upside-down, and this bench introduces two).
   * Paints a mask whose metal sits only in the LOW-world-Y half, renders the
   * `strength` channel, and checks that the bright rows come back at the TOP.
   */
  async function selfTest() {
    const savedScenario = state.scenario;
    const savedChannel = state.debugChannel;
    const savedDepthPreset = state.depthPreset;
    const orientPaint = (_u, v) => (v < 0.45 ? [255, 255, 255, 255] : [0, 0, 0, 0]);
    try {
      applyScenario(orientPaint);
      state.depthPreset = 'background';
      // ⚠️ CHANNEL 'quad' (a CONSTANT, no texture read), not 'strength'. The
      // marker has to be the one thing that cannot itself be broken: the quad
      // is cropped to the painted AABB, so "which rows did the mesh cover" is a
      // pure-geometry answer. Using a mask-derived channel here made the rig's
      // own orientation check fail whenever the mask read was broken — an
      // instrument that stops working exactly when the subject does.
      state.debugChannel = SPECULAR_DEBUG_CHANNELS.find((c) => c.id === 'quad').n;
      await render();
      let frame = await readFrame();
      const top = pixelAt(frame, 1000, 400);
      const bottom = pixelAt(frame, 1000, 1800);
      if (!(top.r > 0.5 && bottom.r < 0.5)) {
        orientationFlip = !orientationFlip;
        frame = await readFrame();
        const t2 = pixelAt(frame, 1000, 400);
        const b2 = pixelAt(frame, 1000, 1800);
        const ok = t2.r > 0.5 && b2.r < 0.5;
        log?.(`specular selfTest: orientation flipped (orientationFlip=${orientationFlip}) -> ${ok ? 'PASS' : 'FAIL'}`);
        return ok;
      }
      log?.('specular selfTest: orientation OK, no flip needed');
      return true;
    } finally {
      state.depthPreset = savedDepthPreset;
      state.debugChannel = savedChannel;
      applyScenario(savedScenario);
      await render();
    }
  }

  /** Draw the current frame to a canvas, sRGB-encoded and tonemapped exactly as
   * `grade-present.js` would — so what the author sees in the pane is what the
   * same pixels would look like on a real map, not a raw linear buffer. */
  async function paint(canvas) {
    const frame = await readFrame();
    if (canvas.width !== SCREEN_DIM || canvas.height !== SCREEN_DIM) {
      canvas.width = SCREEN_DIM;
      canvas.height = SCREEN_DIM;
    }
    const out = new Uint8ClampedArray(SCREEN_DIM * SCREEN_DIM * 4);
    const tone = state.debugChannel === 0;
    for (let i = 0; i < SCREEN_DIM * SCREEN_DIM; i++) {
      let rgb = [frame[i * 4], frame[i * 4 + 1], frame[i * 4 + 2]];
      if (tone) rgb = neutralToneMap(rgb);
      for (let c = 0; c < 3; c++) {
        const lin = Math.max(0, Math.min(1, rgb[c]));
        // sRGB OETF, the same encode the present blit does.
        const enc = lin <= 0.0031308 ? lin * 12.92 : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055;
        out[i * 4 + c] = Math.round(enc * 255);
      }
      out[i * 4 + 3] = 255;
    }
    canvas.getContext('2d').putImageData(new ImageData(out, SCREEN_DIM, SCREEN_DIM), 0, 0);
  }

  /** A world-space scanline of final luma, for the profile plot. */
  async function profile({ from, to, steps = 140 }) {
    const frame = await readFrame();
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const p = pixelAt(frame, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
      pts.push({ vis: 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b });
    }
    return pts;
  }

  /**
   * A scanline across the painted AABB at whatever world-Y carries the most
   * signal — see `lab.js`'s own note on why the MIDDLE row is the wrong choice
   * for any scenario with more than one object in it.
   * @param {{steps?: number}} [opts]
   */
  async function profileBrightestRow({ steps = 140 } = {}) {
    const frame = await readFrame();
    if (!quadWorld) return [];
    let bestY = (quadWorld.minY + quadWorld.maxY) / 2;
    let bestSum = -1;
    const ROWS = 48;
    for (let j = 0; j <= ROWS; j++) {
      const wy = quadWorld.minY + ((quadWorld.maxY - quadWorld.minY) * j) / ROWS;
      let sum = 0;
      for (let i = 0; i <= 32; i++) {
        const p = pixelAt(frame, quadWorld.minX + ((quadWorld.maxX - quadWorld.minX) * i) / 32, wy);
        sum += 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b;
      }
      if (sum > bestSum) {
        bestSum = sum;
        bestY = wy;
      }
    }
    return profile({ from: { x: quadWorld.minX, y: bestY }, to: { x: quadWorld.maxX, y: bestY }, steps });
  }

  applyScenario(state.scenario);

  return {
    profileBrightestRow,
    state,
    SPEC_RECT,
    MASK_SCENARIOS,
    DEPTH_PRESETS,
    applyScenario,
    render,
    paint,
    profile,
    samplePixel,
    gateLadder,
    visibilityReport,
    selfTest,
    /**
     * THE GENERATED WGSL, for whichever material is currently attached.
     *
     * Added 2026-08-01, and it is the single highest-value thing in this bench:
     * every earlier round of this effect reasoned about what the TSL graph
     * "should" compile to. `renderer.debug.getShaderAsync` returns what it
     * ACTUALLY compiled to — which is how a variable that gets ASSIGNED inside
     * one conditional branch and READ from another becomes visible at all.
     */
    async dumpShader() {
      await render();
      const s = await renderer.debug.getShaderAsync(scene, camera, mesh);
      return { vertex: s.vertexShader, fragment: s.fragmentShader };
    },
    getIslandReport: () => islandReport,
    getQuadWorld: () => quadWorld,
    getMaskUvBounds: () => maskUvBounds,
    getStatus: () => ({
      ...state,
      quadWorld,
      maskUvBounds,
      islandReport,
      orientationFlip,
      outdoorsGateCompiled: surface.outdoorsGateCompiled,
      floorGateCompiled: surface.floorGateCompiled,
      backgroundExpectedDepth,
    }),
  };
}
