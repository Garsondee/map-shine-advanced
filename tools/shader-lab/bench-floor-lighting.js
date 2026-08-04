/**
 * SHADER LAB — RUNG 3: MULTI-FLOOR POINT-LIGHT OCCLUSION.
 *
 * ============================================================================
 * WHY THIS BENCH EXISTS
 * ============================================================================
 * Three rounds of "fixed it" on the light/elevation gate died on the author's
 * real scene, each time after a confident by-hand trace of arithmetic that was
 * genuinely correct. The arithmetic was never the problem. Every one of those
 * rounds reasoned about a shader WITHOUT EVER RENDERING IT, which is the exact
 * failure `feedback_plausible_diagnosis_rots` and this lab's own charter exist
 * to stop. The author's instruction, verbatim: *"No more half measures. You
 * have the Shader Lab — you need to enhance that to work with real layers of
 * map, create a light and see if you can get the logic to work."*
 *
 * So: a real three-floor building out of primitives, a real `buf:scene.attr`
 * written by the REAL production encoder, real point lights built by the REAL
 * `buildPointLightIlluminationMaterial`, MAX-blended into a real illum target
 * on a real WebGPU device — then READ THE PIXELS.
 *
 * ============================================================================
 * THE SCENE (the author's own spec, shape for shape)
 * ============================================================================
 * A 1000x1000 world. A square building, footprint x/y 300..700, three floors:
 *
 *   floor 2 "second"  band [20,30)  slab covers the FOOTPRINT only
 *   floor 1 "first"   band [10,20)  slab covers the FOOTPRINT only
 *   floor 0 "ground"  band [ 0,10)  ground covers the WHOLE map
 *
 * Outside the footprint there is no floor 1 or 2 at all — a genuine hole, the
 * orthographic hole-stack model's whole point (`keyhole-orthographic-hole-
 * stack-model`). Looking down from floor 2 outside the building you see the
 * GROUND, and whatever light lands on it.
 *
 * Three lights, each pinning one of the author's three requirements:
 *
 *   OUTSIDE      (150,150) elev 5,  r 260 — outdoors, nothing above it ever.
 *                MUST be visible from all three floors.
 *   INSIDE_GROUND(500,500) elev 5,  r 200 — sealed inside on the ground floor.
 *                MUST light floor 0, and MUST NOT light floors 1 or 2.
 *   FIRST_SPILL  (700,500) elev 15, r 260 — on floor 1, straddling the east
 *                wall. Viewed from floor 2 its INSIDE half must be occluded by
 *                floor 2's slab while its OUTSIDE half still lands on the
 *                ground. This is the one that proves the gate is doing real
 *                per-pixel work rather than blanket-killing cross-floor light.
 *
 * ============================================================================
 * WHAT IS REAL HERE AND WHAT IS NOT (read before trusting a number)
 * ============================================================================
 * REAL, imported from `src/`, never transcribed (`feedback_bench_must_build_
 * inputs_like_production` — three bugs in one day came from a lab assembling
 * its own inputs):
 *   - `resolveItemFloorAttrUniforms` — the floor-index + presence-bit encoder.
 *   - `packFloorAttr` — the exact RGBA packing of `buf:scene.attr`.
 *   - `getActiveSceneFloors` — fed a hand-built scene doc in the SAME shape
 *     Foundry's own `scene.levels` has, so real floor banding/sorting runs.
 *   - `buildPointLightIlluminationMaterial` — the material under test.
 *   - `resolveLightElevationRank` — the light side of the height comparison.
 *   - `triangulateLightFan` + the pool's own mesh placement (normalized fan,
 *     positioned to (x,y), scaled by radius).
 *   - `computeAmbientColors` — so `backgroundFloor` is production's value.
 *
 * DELIBERATELY SIMPLIFIED, and each one is a place a future bug could hide:
 *   - No walls/LOS: each light's polygon is a regular 32-gon, not a Foundry
 *     sight polygon. This bench asks a VERTICAL question; wall clipping is
 *     `bench-*`'s separate business.
 *   - No sun-shadow slots (`sunShadowSlotNodes: null`), so `backgroundFloor`
 *     is plain ambient. That path has its own bench.
 *   - The attr buffer is drawn with opaque quads in painter's order rather
 *     than alpha-blended MRT writes. Equivalent where alpha is 1, which is
 *     everywhere here; it does NOT exercise
 *     `feedback_alpha_blended_write_needs_wide_margin`.
 *
 * @module tools/shader-lab/bench-floor-lighting
 */
import {
  resolveItemFloorAttrUniforms,
  packFloorAttr,
  RECEIVER_ELEVATION_LEVELS,
  decodeReceiverElevationLevel,
  decodeOverheadBit,
  buildRealFloorAttrMrtNode,
} from '../../src/vt/scene-attr.js';
import {
  buildPointLightIlluminationMaterial,
  triangulateLightFan,
  easeAttenuation,
  computeExposure,
  elevationRank,
  LIGHT_ELEVATION_UNCONFIGURED_SENTINEL,
} from '../../src/effects/lighting/point-light-illumination.js';
import { resolveLightElevationRank } from '../../src/effects/lighting/point-light-pool.js';
import {
  buildPointLightColorationMaterial,
  computeColorationAlpha,
} from '../../src/effects/lighting/point-light-coloration.js';
import { buildCandleFlameMaterial, buildCandleFlameGeometry } from '../../src/effects/candle-flame-render.js';
import { buildLightningMaterial, buildLightningGeometry } from '../../src/effects/lightning-render.js';
import { computeLightningStrandArrays } from '../../src/effects/lightning-geometry.js';
import { computeAmbientColors } from '../../src/effects/lighting/environmental-light.js';
import { check, evaluate, registerBench, saveCanvasPng } from './contract.js';
// STAGE 0 (docs/planning/Depth-Buffer.md Β§9) — the REAL map, through the REAL
// collectors, never a hand-built item list. See this file's own "SCENARIO 7"
// header, far below, for why each of these specific functions and not a
// lab-local approximation.
import { collectLevelTextures } from '../../src/foundry/scene-layers.js';
import { sortByLayer } from '../../src/scene/layer-order.js';
import { computeQuadCorners } from '../../src/foundry/scene-geometry.js';
import { buildQuadPositions, QUAD_UVS, QUAD_INDICES } from '../../src/scene/world-quad.js';
import { loadMaskImageTexture } from '../../src/vt/mask-image.js';
import FIXTURE from './fixtures/tower-bridge.js';

/** The world rect every floor, light and camera in this bench shares. */
const WORLD = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
/**
 * The building's footprint — floors 1 and 2 exist ONLY here.
 *
 * ⚠️ DELIBERATELY NOT CENTRED IN Y (250..650 against a 0..1000 world), and
 * that asymmetry is load-bearing, not decoration. A Y-CENTRED footprint is
 * invariant under a vertical flip, so every probe against it reads the same
 * value whichever row order the GPU readback actually uses — a calibration
 * that cannot fail and therefore cannot inform. This bench shipped exactly
 * that for one run: `calibrate` reported OK, three checks passed, and all
 * three sat on the world's Y centre line where a flip makes no difference.
 * The one check that did NOT (the outdoor light at y=150) read ambient on
 * every floor, because the sampler was reading y=850. `feedback_calibration_
 * needs_a_contrast_guard`, one level up: contrast is not enough if the
 * contrast is symmetric about the axis being calibrated.
 */
const FOOTPRINT = { minX: 300, minY: 250, maxX: 700, maxY: 650 };
/** Render size. Square, and the SAME for attr and illum so `screenUV` maps 1:1. */
const DIM = 256;

/**
 * A Foundry-shaped scene document. `getActiveSceneFloors` reads `.levels` and
 * tolerates a plain array (its own `levelDocsOf` says so), so this exercises
 * the REAL banding/sorting/`elevationTop` resolution rather than a fabricated
 * floors array — the difference that `feedback_bench_must_build_inputs_like_
 * production` is about.
 */
const SCENE_DOC = {
  name: 'shader-lab three-floor building',
  levels: [
    {
      id: 'ground',
      name: 'Ground',
      background: { src: 'lab://ground.webp' },
      elevation: { bottom: 0, top: 10 },
      visibility: { levels: [] },
    },
    {
      id: 'first',
      name: 'First',
      background: { src: 'lab://first.webp' },
      elevation: { bottom: 10, top: 20 },
      visibility: { levels: [] },
    },
    {
      id: 'second',
      name: 'Second',
      background: { src: 'lab://second.webp' },
      elevation: { bottom: 20, top: 30 },
      visibility: { levels: [] },
    },
  ],
};

/**
 * The three floors as ITEMS, in the shape `resolveItemFloorAttrUniforms`
 * consumes (`item.levelId` + `item.key.elevation` + `item.kind`). `levelId` is
 * what makes floor MEMBERSHIP authoritative rather than derived from a
 * half-open elevation band (`feedback_half_open_band_excludes_its_own_member`).
 */
const FLOOR_ITEMS = [
  { levelId: 'ground', kind: 'levelBackground', key: { elevation: 0 }, rect: WORLD, floorIndex: 0 },
  { levelId: 'first', kind: 'levelBackground', key: { elevation: 10 }, rect: FOOTPRINT, floorIndex: 1 },
  { levelId: 'second', kind: 'levelBackground', key: { elevation: 20 }, rect: FOOTPRINT, floorIndex: 2 },
];

/** The author's three lights. `elevation` is the RAW Foundry document field. */
const LIGHTS = [
  { id: 'OUTSIDE', x: 150, y: 150, radius: 260, elevation: 5, expectFloor: 0 },
  { id: 'INSIDE_GROUND', x: 500, y: 500, radius: 200, elevation: 5, expectFloor: 0 },
  { id: 'FIRST_SPILL', x: 700, y: 500, radius: 260, elevation: 15, expectFloor: 1 },
];

/** A light's polygon: a regular 32-gon. No walls in this bench — see the header. */
function lightPolygon(light, segments = 32) {
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(light.x + Math.cos(a) * light.radius, light.y + Math.sin(a) * light.radius);
  }
  return pts;
}

// ============================================================================
// STAGE 0 SUPPORT (docs/planning/Depth-Buffer.md Β§9) — loading and scanning
// the REAL tower-bridge art. Pure/standalone, like `lightPolygon` above; the
// scenario itself (far below) explains why this exists.
// ============================================================================

/**
 * Load one real art layer at the fixture's own EXPLORE scale, through the
 * REAL production loader (`vt/mask-image.js`) — never a lab-local `Image`/
 * `fetch` shortcut, so a real decode bug (a wrong colour space, a resize
 * artefact) shows up here exactly as it would in production.
 *
 * @param {*} THREE @param {string} dir @param {string} file @param {number} scale
 * @param {(msg:string)=>void} [log]
 * @returns {Promise<object>} `loadMaskImageTexture`'s own return shape.
 */
async function loadRealArtLayer(THREE, dir, file, scale, log) {
  const res = await loadMaskImageTexture({ url: `${dir}/${file}`, THREE, scale, channels: 'rgb' });
  if (!res) {
    throw new Error(`real-map: failed to load ${file} — see the console for the underlying fetch/decode error`);
  }
  log?.(
    `FLOOR-LIGHTING real-map: loaded ${file} at ${res.width}x${res.height} ` +
      `(native ${res.nativeWidth}x${res.nativeHeight}, scale ${scale})`
  );
  return res;
}

/** The alpha byte at one decoded texel of a `loadMaskImageTexture` result. */
function alphaAt(entry, px, py) {
  return entry.data[(py * entry.width + px) * 4 + 3];
}

/**
 * Find a world (x,y) whose small neighbourhood is robustly OPAQUE in every
 * `mustBeOpaque` layer and robustly TRANSPARENT in every `mustBeTransparent`
 * layer — i.e. an ACTUAL patch of real authored art matching the condition,
 * never a guessed coordinate and never a single antialiased-edge texel
 * mistaken for a real region (`feedback_read_the_producer_never_invent_its_
 * shape` — the fixture's OWN discipline for its mask content, applied here to
 * its art content instead).
 *
 * Scans on a STRIDE, not every texel: a real 0.25-scale layer is ~3.3M
 * texels, and this function is called several times per bench run. A stride
 * cannot miss a region wider than itself, and every candidate is validated
 * against a `halfWin`-texel window (not a single sample), so a stride does
 * not risk finding a false positive it would otherwise avoid.
 *
 * @param {object} args
 * @param {number} args.width @param {number} args.height - shared decode
 *   dimensions (every layer in this fixture shares one NATIVE size, so all
 *   loads at one `scale` decode to the identical width/height — no per-layer
 *   UV remapping needed).
 * @param {number} args.worldW @param {number} args.worldH
 * @param {object[]} [args.mustBeOpaque]
 * @param {object[]} [args.mustBeTransparent]
 * @param {number} [args.halfWin] - the validated window's half-size, in texels.
 * @param {number} [args.stride]
 * @param {number} [args.marginFrac] - fraction of width/height excluded from
 *   every edge, so a hit can never sit on the canvas boundary.
 * @param {boolean} [args.requireVerticalAsymmetry] - see this function's own
 *   "CALIBRATION NEEDS A CONTRAST GUARD" note just below. When true, a
 *   candidate is rejected if its OWN vertical mirror (`height-1-py`, same
 *   `px`) ALSO satisfies every `mustBeOpaque` condition β€” i.e. only accept a
 *   point that a straight-vs-flipped row mapping would actually disagree
 *   about. Irrelevant to an ordinary content search; only set this for a
 *   CALIBRATION anchor.
 * @returns {{x:number, y:number, px:number, py:number}|null} world
 *   coordinates of the FIRST qualifying region found, or `null` if none was
 *   — a real, reportable outcome (`feedback_instruments_must_not_lie`), never
 *   a fabricated fallback point.
 */
function findRealArtRegion({
  width,
  height,
  worldW,
  worldH,
  mustBeOpaque = [],
  mustBeTransparent = [],
  halfWin = 5,
  stride = 10,
  marginFrac = 0.03,
  requireVerticalAsymmetry = false,
}) {
  const OPAQUE_MIN = 235; // clearly painted, past ordinary WebP block-compression noise
  const TRANSPARENT_MAX = 4; // clearly unpainted β€” mirrors mask-image.js's own MASK_CONTENT_EMPTY_BYTE posture
  const marginX = Math.floor(width * marginFrac);
  const marginY = Math.floor(height * marginFrac);
  const regionOk = (entry, px, py, wantOpaque) => {
    for (let dy = -halfWin; dy <= halfWin; dy++) {
      for (let dx = -halfWin; dx <= halfWin; dx++) {
        const x = px + dx;
        const y = py + dy;
        if (x < 0 || y < 0 || x >= entry.width || y >= entry.height) return false;
        const a = alphaAt(entry, x, y);
        if (wantOpaque && a < OPAQUE_MIN) return false;
        if (!wantOpaque && a > TRANSPARENT_MAX) return false;
      }
    }
    return true;
  };
  // ⚠️ CALIBRATION NEEDS A CONTRAST GUARD (`feedback_calibration_needs_a_
  // contrast_guard`), and a SINGLE mirrored texel is not a strong enough
  // guard. Measured live: a candidate at (px 79, py 127) had its OWN exact
  // mirror (py 1109) genuinely transparent β€” yet the SAME column reads
  // "opaque" across 76% of its total height, so a render/decode row-count
  // discrepancy of barely a dozen texels (2662-wide decode vs a
  // 64-rounded-up 2688-wide render target) was enough to land the ACTUAL
  // sampled mirror row back inside a DIFFERENT opaque band a few rows away.
  // A single coincidentally-transparent texel is not a discriminator; a
  // WIDE band that is uniformly the opposite condition is. This checks every
  // row in `Β±asymmetryBandTexels` around the mirror, not just the mirror
  // itself β€” tolerant of exactly the kind of off-by-a-dozen slop that broke
  // the single-texel version, and only accepts a candidate where NONE of
  // that band could plausibly satisfy the SAME condition being searched for.
  const ASYMMETRY_BAND_TEXELS = 30;
  const bandHasNoMatch = (entry, px, centerPy, wantOpaque) => {
    for (let dy = -ASYMMETRY_BAND_TEXELS; dy <= ASYMMETRY_BAND_TEXELS; dy++) {
      const y = centerPy + dy;
      if (y < 0 || y >= height) continue;
      if (regionOk(entry, px, y, wantOpaque)) return false;
    }
    return true;
  };
  const isUsableForCalibration = (px, py) => {
    if (!requireVerticalAsymmetry) return true;
    const mirrorPy = height - 1 - py;
    if (mustBeOpaque.some((e) => !bandHasNoMatch(e, px, mirrorPy, true))) return false;
    if (mustBeTransparent.some((e) => !bandHasNoMatch(e, px, mirrorPy, false))) return false;
    return true;
  };
  for (let py = marginY; py < height - marginY; py += stride) {
    for (let px = marginX; px < width - marginX; px += stride) {
      if (mustBeOpaque.some((e) => !regionOk(e, px, py, true))) continue;
      if (mustBeTransparent.some((e) => !regionOk(e, px, py, false))) continue;
      if (!isUsableForCalibration(px, py)) continue;
      return { x: ((px + 0.5) / width) * worldW, y: ((py + 0.5) / height) * worldH, px, py };
    }
  }
  return null;
}

/**
 * A whole-canvas world quad, geometry-for-geometry identical to how
 * production places Level background/foreground art (`bench-derive.js`'s own
 * `wholeWorldPlacement()` — the SAME fixture, the SAME "this art covers the
 * whole map" placement) β€” reused rather than a bare `PlaneGeometry`
 * (`quadMesh` above) specifically BECAUSE this mesh must carry a REAL `uv`
 * attribute: every earlier scenario in this file packs a constant/computed
 * value and never samples a texture, so `PlaneGeometry`'s default UVs were
 * never exercised. This one samples REAL art, so an incorrect UV winding
 * would silently flip or mirror it β€” exactly the risk
 * `feedback_y_flip_recurring_risk` exists to name. `computeQuadCorners` +
 * `buildQuadPositions` + `QUAD_UVS` + `QUAD_INDICES` are the SAME functions
 * `vt-pan-viewer.js`'s own whole-image materials build their geometry from,
 * so this mesh's UV mapping is correct by construction, not by a
 * lab-reasoned-through convention.
 *
 * @param {*} THREE @param {*} material @param {number} renderOrder
 * @returns {*} a `THREE.Mesh`, not yet added to a scene.
 */
function buildWorldQuadMesh(THREE, material, renderOrder) {
  const rect = FIXTURE.worldRect;
  const placement = {
    x: (rect.minX + rect.maxX) / 2,
    y: (rect.minY + rect.maxY) / 2,
    width: rect.maxX - rect.minX,
    height: rect.maxY - rect.minY,
    anchorX: 0.5,
    anchorY: 0.5,
    rotation: 0,
  };
  const corners = computeQuadCorners(placement);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(buildQuadPositions(corners), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
  geo.setIndex([...QUAD_INDICES]);
  const mesh = new THREE.Mesh(geo, material);
  mesh.renderOrder = renderOrder;
  mesh.frustumCulled = false;
  return mesh;
}

export function createFloorLightingBench({ THREE, log }) {
  const { uniform, float, vec3, vec4, texture, mrt, output } = THREE.TSL;

  let renderer = null;
  let attrRt = null;
  let illumRt = null;
  let camera = null;
  /** Empirically established, never assumed (`feedback_y_flip_recurring_risk`). */
  let orientation = null;

  async function ensureRenderer() {
    if (renderer) return;
    renderer = new THREE.WebGPURenderer({ antialias: false });
    await renderer.init();
    // ONE camera for both the attr pass and the light pass. If these ever
    // diverge, `screenUV` stops indexing the attr buffer and every number
    // below silently becomes meaningless — the exact class of bug this bench
    // was built to catch, so it must not be reintroduced by the bench itself.
    camera = new THREE.OrthographicCamera(WORLD.minX, WORLD.maxX, WORLD.maxY, WORLD.minY, -1000, 1000);
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    attrRt = new THREE.RenderTarget(DIM, DIM, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      colorSpace: THREE.NoColorSpace,
    });
    illumRt = new THREE.RenderTarget(DIM, DIM, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
    });
    log?.(`FLOOR-LIGHTING: renderer backend ${renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL'}`);
  }

  /**
   * A world-rect quad.
   *
   * ⚠️ `renderOrder`, NOT z-position, decides painter's order here — and
   * getting that wrong is the first bug this bench found, in ITSELF. These
   * materials run `depthTest: false` (production's attr writers do too), so
   * the depth buffer cannot arbitrate; three then sorts opaque objects
   * FRONT-TO-BACK for early-z, which draws the top floor FIRST and lets the
   * ground floor — furthest from the camera — overwrite it last. Every floor
   * index came back 0 and the attr buffer looked convincingly like a shader
   * bug. `renderOrder` is consulted before the distance sort, so it is the
   * only reliable control. (`feedback_bench_must_build_inputs_like_production`
   * — an input the lab got wrong is indistinguishable from the thing under
   * test being broken.)
   */
  function quadMesh(rect, material, order) {
    const w = rect.maxX - rect.minX;
    const h = rect.maxY - rect.minY;
    const geo = new THREE.PlaneGeometry(w, h);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set((rect.minX + rect.maxX) / 2, (rect.minY + rect.maxY) / 2, 0);
    mesh.renderOrder = order;
    mesh.frustumCulled = false;
    return mesh;
  }

  /**
   * RENDER `buf:scene.attr` FOR ONE VIEWED FLOOR, through the real encoder.
   *
   * Floors ABOVE the viewed one are not drawn — Foundry's own rule, and the
   * reason the hole-stack model works at all: what you see at a pixel is the
   * topmost drawn surface at or below where you stand.
   */
  async function renderAttr(viewedFloorIndex) {
    const scene = new THREE.Scene();
    const disposables = [];
    for (const item of FLOOR_ITEMS) {
      if (item.floorIndex > viewedFloorIndex) continue;
      // THE REAL ENCODER. Everything about floor index and presence bits —
      // including the receiver-elevation sub-field the height gate reads —
      // is decided here by production code, not by this bench.
      const { uFloorIndex01, uPresenceBits01 } = resolveItemFloorAttrUniforms({
        THREE,
        item,
        viewedFloorIndex,
        sceneDoc: SCENE_DOC,
        logError: (m, e) => log?.(`FLOOR-LIGHTING attr encode: ${m} ${e}`),
      });
      const mat = new THREE.NodeMaterial();
      mat.transparent = false;
      mat.depthTest = false;
      mat.depthWrite = false;
      mat.side = THREE.DoubleSide;
      mat.fragmentNode = packFloorAttr(THREE.TSL, {
        floorIndex01: uFloorIndex01,
        outdoors01: float(1),
        presenceBits01: uPresenceBits01,
        solidityAlpha: float(1),
      });
      const mesh = quadMesh(item.rect, mat, item.floorIndex);
      scene.add(mesh);
      disposables.push(mesh.geometry, mat);
    }
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(attrRt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    await renderer.renderAsync(scene, camera);
    renderer.setRenderTarget(prev);
    const buf = await renderer.readRenderTargetPixelsAsync(attrRt, 0, 0, DIM, DIM);
    for (const d of disposables) d.dispose?.();
    return ArrayBuffer.isView(buf) ? buf : new Uint8Array(buf);
  }

  /**
   * RENDER THE THREE LIGHTS into an illum target, through the REAL material,
   * reading the REAL attr texture just rendered.
   */
  async function renderIllum(viewedFloorIndex, { lights = LIGHTS, ambientLevel = 0.12 } = {}) {
    const scene = new THREE.Scene();
    const disposables = [];
    const attrTexNode = texture(attrRt.texture);
    // Production ambient, from production code — this is the value a gated
    // light must fall back TO, so inventing it would invent the answer.
    const ambient = computeAmbientColors(
      { darkness01: 1 - ambientLevel, sky: null, globalLight: null, darknessLevel: 1 - ambientLevel },
      0
    );
    const bg = Array.isArray(ambient?.background) ? ambient.background : [ambientLevel, ambientLevel, ambientLevel];
    const built = [];
    for (const light of lights) {
      const uBackgroundColor = uniform(vec3(...bg));
      const uDimColor = uniform(vec3(0.55, 0.5, 0.42));
      const uBrightColor = uniform(vec3(1, 0.96, 0.86));
      const b = buildPointLightIlluminationMaterial({
        THREE,
        uBackgroundColor,
        uDimColor,
        uBrightColor,
        animation: null,
        uGlobalTimeMs: uniform(float(0)),
        falloffModel: 'foundry',
        sunShadowSlotNodes: null,
        attrTexNode,
        blendSunVisibilityAcrossFloors: null,
      });
      b.uRatio.value = 0.5;
      b.uAttenuationEased.value = easeAttenuation(0.5);
      b.uExposure.value = computeExposure(0.5);
      b.uEdgeCount.value = 0;
      b.uEdgeSoftMargin.value = 0;
      // THE LIGHT SIDE OF THE COMPARISON — real production resolver, fed the
      // real floors this scene doc produces.
      const floors = [
        { index: 0, id: 'ground', elevationBottom: 0, elevationTop: 10 },
        { index: 1, id: 'first', elevationBottom: 10, elevationTop: 20 },
        { index: 2, id: 'second', elevationBottom: 20, elevationTop: 30 },
      ];
      const rank = resolveLightElevationRank(light, floors);
      b.uLightElevationRank.value = rank;

      // Real fan, real placement — `point-light-pool.js`'s own two lines.
      const { array, vertexCount } = triangulateLightFan(lightPolygon(light), light.x, light.y, light.radius);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(array, 3));
      geo.setDrawRange(0, vertexCount);
      const mesh = new THREE.Mesh(geo, b.material);
      mesh.position.set(light.x, light.y, 0);
      mesh.scale.set(light.radius, light.radius, 1);
      mesh.frustumCulled = false;
      scene.add(mesh);
      disposables.push(geo, b.material);
      built.push({ id: light.id, rank, expectFloor: light.expectFloor });
    }
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(illumRt);
    // Clear to the ambient floor: MAX blending can only raise a fragment, so
    // the clear IS the "no light reaches here" baseline every check compares
    // against. Clearing to black would make ambient look like a light.
    renderer.setClearColor(new THREE.Color(bg[0], bg[1], bg[2]), 1);
    renderer.clear();
    await renderer.renderAsync(scene, camera);
    renderer.setRenderTarget(prev);
    const buf = await renderer.readRenderTargetPixelsAsync(illumRt, 0, 0, DIM, DIM);
    for (const d of disposables) d.dispose?.();
    return {
      bytes: ArrayBuffer.isView(buf) ? buf : new Uint8Array(buf),
      ambientByte: Math.round(bg[0] * 255),
      built,
    };
  }

  /**
   * RENDER THE COLORATION PASS — a light's SECOND mesh, sharing the SAME
   * geometry, carrying the visible coloured glow and every ANIMATED light
   * effect. The author's round-5 report was precisely that this half kept
   * painting through solid floors after the illumination half was fixed:
   * *"you aren't correctly occluding the animated light source."*
   *
   * Cleared to BLACK, not to ambient: coloration is an ADDITIVE channel that
   * never darkens anything, so "no contribution" here is a genuine zero — a
   * different neutral element from the illumination pass's ambient floor
   * (`feedback_blend_neutral_element_is_per_blend`).
   */
  async function renderColoration(lights = LIGHTS) {
    const scene = new THREE.Scene();
    const disposables = [];
    const attrTexNode = texture(attrRt.texture);
    for (const light of lights) {
      const b = buildPointLightColorationMaterial({
        THREE,
        albedoTexture: attrRt.texture, // stands in for buf:scene.color; only its LUMINANCE is read
        attrTexNode,
        animation: null,
        uGlobalTimeMs: uniform(float(0)),
        uRatio: uniform(float(0.5)),
        falloffModel: 'foundry',
      });
      b.uAttenuationEased.value = easeAttenuation(0.5);
      b.uColorationAlpha.value = computeColorationAlpha(0.5, 1);
      b.uLightColor.value.set(1, 0.4, 0.1);
      const floors = [
        { index: 0, id: 'ground', elevationBottom: 0, elevationTop: 10 },
        { index: 1, id: 'first', elevationBottom: 10, elevationTop: 20 },
        { index: 2, id: 'second', elevationBottom: 20, elevationTop: 30 },
      ];
      b.uLightElevationRank.value = resolveLightElevationRank(light, floors);
      const { array, vertexCount } = triangulateLightFan(lightPolygon(light), light.x, light.y, light.radius);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(array, 3));
      geo.setDrawRange(0, vertexCount);
      const mesh = new THREE.Mesh(geo, b.material);
      mesh.position.set(light.x, light.y, 0);
      mesh.scale.set(light.radius, light.radius, 1);
      mesh.frustumCulled = false;
      scene.add(mesh);
      disposables.push(geo, b.material);
    }
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(illumRt);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    await renderer.renderAsync(scene, camera);
    renderer.setRenderTarget(prev);
    const buf = await renderer.readRenderTargetPixelsAsync(illumRt, 0, 0, DIM, DIM);
    for (const d of disposables) d.dispose?.();
    return ArrayBuffer.isView(buf) ? buf : new Uint8Array(buf);
  }

  /** World (x,y) → readback index, honouring the empirically-found row order. */
  function sampleAt(bytes, x, y) {
    const fx = (x - WORLD.minX) / (WORLD.maxX - WORLD.minX);
    const fy = (y - WORLD.minY) / (WORLD.maxY - WORLD.minY);
    const px = Math.min(DIM - 1, Math.max(0, Math.floor(fx * DIM)));
    const rowFromBottom = Math.min(DIM - 1, Math.max(0, Math.floor(fy * DIM)));
    const row = orientation === 'flipped' ? DIM - 1 - rowFromBottom : rowFromBottom;
    const i = (row * DIM + px) * 4;
    return { r: bytes[i], g: bytes[i + 1], b: bytes[i + 2], a: bytes[i + 3] };
  }

  /**
   * ESTABLISH ROW ORDER EMPIRICALLY, from the attr buffer's own floor-index
   * channel (`feedback_y_flip_recurring_risk` — never assumed twice).
   *
   * ONE probe does it, and it is chosen so that the two possible row orders
   * give DIFFERENT answers — the property the first version of this function
   * lacked. Feed it the floor-2 attr. World (500, 300) sits inside the
   * footprint in both axes (x 300..700, y 250..650), so under the correct
   * orientation it reads the slab: floor index 2. Under a flipped readback
   * that same row is world y = 700, which is OUTSIDE the footprint (> 650),
   * so it reads the ground: floor index 0. Two distinct, predicted values.
   *
   * Anything else — equal values, or a third value — means the probe did not
   * land where this reasoning says, and it refuses to guess rather than
   * inventing a confident orientation from a frame with no usable signal
   * (`feedback_calibration_needs_a_contrast_guard`, and
   * `feedback_instruments_must_not_lie`).
   */
  function calibrate(attrFloor2Bytes) {
    const rowAt = (x, y, flip) => {
      const fx = (x - WORLD.minX) / (WORLD.maxX - WORLD.minX);
      const fy = (y - WORLD.minY) / (WORLD.maxY - WORLD.minY);
      const px = Math.min(DIM - 1, Math.floor(fx * DIM));
      const rowFromBottom = Math.min(DIM - 1, Math.floor(fy * DIM));
      const row = flip ? DIM - 1 - rowFromBottom : rowFromBottom;
      return attrFloor2Bytes[(row * DIM + px) * 4];
    };
    // Sanity first: the slab must exist at all. Centre is flip-invariant, so
    // this cannot answer the Y question — it only proves there IS a signal.
    const centre = rowAt(500, 450, false);
    const outsideX = rowAt(120, 450, false);
    if (centre !== 2 || outsideX !== 0) {
      throw new Error(
        `floor-lighting calibrate: the floor-2 attr is not what this bench built ` +
          `(centre=${centre} expected 2, outsideX=${outsideX} expected 0) — nothing downstream is trustworthy`
      );
    }
    const probe = rowAt(500, 300, false);
    if (probe === 2) orientation = 'straight';
    else if (probe === 0) orientation = 'flipped';
    else {
      throw new Error(
        `floor-lighting calibrate: Y probe at (500,300) read floor ${probe}, expected 2 (straight) or 0 (flipped)`
      );
    }
    log?.(`FLOOR-LIGHTING: orientation ${orientation} (centre=${centre}, outsideX=${outsideX}, probe=${probe})`);
    return orientation;
  }

  /** Paint a readback into a canvas so the author can SEE it, not just read numbers. */
  function paint(bytes, canvas, label) {
    canvas.width = DIM;
    canvas.height = DIM;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(DIM, DIM);
    img.data.set(bytes);
    ctx.putImageData(img, 0, 0);
    ctx.fillStyle = 'white';
    ctx.font = '12px monospace';
    ctx.fillText(label, 6, 16);
    return canvas;
  }

  // ==========================================================================
  // STAGE 0 (docs/planning/Depth-Buffer.md Β§9) β€” THE REAL MAP.
  // ==========================================================================
  // Cached across repeated runs of scenario 7 (below), the same posture
  // `ensureRenderer()` already takes for the shared device: loading 5 real
  // ~9 MB images and scanning ~3.3M texels several times over is real work,
  // and none of it changes between clicks of the same button.
  let realMap = null;
  /** Established empirically per THIS camera/RT pair β€” see `calibrateRealOrientation`. */
  let realOrientation = null;

  /**
   * Load the real map's 5 art layers, collect its 5 real draw items through
   * the REAL `collectLevelTextures` (never a hand-built item list β€” see this
   * file's own "SCENARIO 7" header for why that matters here specifically),
   * sort them with the REAL sort law, scan for the real test-light world
   * positions, and build a camera/render-target pair sized for the fixture's
   * OWN world rect (NOT the synthetic 1000x1000/DIM=256 pair `ensureRenderer`
   * builds above β€” a real 10650x4950 map needs its own).
   */
  async function ensureRealMapAssets() {
    if (realMap) return realMap;
    const scale = FIXTURE.exploreScale; // 0.25 β€” STATED, not silent (AGENTS.md Β§7).
    const findArt = (floorId, role) => FIXTURE.artLayers.find((a) => a.floorId === floorId && a.role === role);
    const bgU = findArt('underground', 'background');
    const fgU = findArt('underground', 'overhead');
    const bgM = findArt('middle', 'background');
    const fgM = findArt('middle', 'overhead');
    const bgR = findArt('roof', 'background'); // roof has NO overhead layer β€” nothing sits above it
    const [undergroundBg, undergroundFg, middleBg, middleFg, roofBg] = await Promise.all([
      loadRealArtLayer(THREE, FIXTURE.dir, bgU.file, scale, log),
      loadRealArtLayer(THREE, FIXTURE.dir, fgU.file, scale, log),
      loadRealArtLayer(THREE, FIXTURE.dir, bgM.file, scale, log),
      loadRealArtLayer(THREE, FIXTURE.dir, fgM.file, scale, log),
      loadRealArtLayer(THREE, FIXTURE.dir, bgR.file, scale, log),
    ]);

    // THE REAL SCENE DOCUMENT β€” `getActiveSceneFloors`/`collectLevelTextures`
    // both tolerate a plain array (`sortedLevels` uses each entry's own
    // `.index`, declared explicitly below so that path is taken
    // deterministically). Elevation bands are the FIXTURE's own,
    // author-ratified numbers (Β§ "AUTHOR-GIVEN 2026-08-01" above) β€” never
    // re-typed by hand a second time.
    const sceneDoc = {
      name: 'shader-lab real tower-bridge map (stage 0)',
      levels: FIXTURE.floors.map((floor) => {
        const bg = findArt(floor.id, 'background');
        const fg = findArt(floor.id, 'overhead');
        return {
          id: floor.id,
          index: floor.index,
          name: floor.label,
          elevation: floor.elevation,
          background: bg ? { src: `${FIXTURE.dir}/${bg.file}` } : {},
          foreground: fg ? { src: `${FIXTURE.dir}/${fg.file}` } : {},
          visibility: { levels: [] },
        };
      }),
    };

    // ⚠️ `visibleLevelIds` IS NOT OPTIONAL. Every level's own
    // `visibility.levels` is deliberately empty above, which under Foundry's
    // real per-level visibility rule (`isLevelVisible`) would collapse the
    // item list down to the VIEWED level's own art only β€” exactly the
    // `collectLevelTextures` bug this parameter's own doc names ("an entire
    // item list silently returned just the viewed floor's own background").
    // This scenario needs every real floor drawn AT ONCE regardless of which
    // one is "viewed", the same override `boot.js` uses to feed the mask
    // authority's view-independent physics.
    const { items: realItems, skipped } = collectLevelTextures(sceneDoc, {
      viewedLevelId: 'roof',
      visibleLevelIds: FIXTURE.floors.map((f) => f.id),
    });
    if (skipped.length) log?.(`FLOOR-LIGHTING real-map: collectLevelTextures skipped ${JSON.stringify(skipped)}`);
    if (realItems.length !== 5) {
      throw new Error(`real-map: expected 5 real draw items (3 backgrounds + 2 overheads), got ${realItems.length}`);
    }
    // THE REAL SORT LAW, not `item.floorIndex` β€” Underground's own overhead
    // (elevation 20, ITS OWN floor's top) and Middle's own background
    // (elevation 20, ITS OWN floor's bottom) TIE, and `compareLayerKeys`'s
    // sortLayer/sort/zIndex tie-break is the ONLY thing that decides which
    // one paints last (`scene/layer-order.js`'s own header has the worked
    // example). `sortByLayer` itself, never re-implemented here.
    sortByLayer(realItems);

    const texByKey = new Map([
      ['underground:levelBackground', undergroundBg.texture],
      ['underground:levelForeground', undergroundFg.texture],
      ['middle:levelBackground', middleBg.texture],
      ['middle:levelForeground', middleFg.texture],
      ['roof:levelBackground', roofBg.texture],
    ]);

    // THE FOUR TEST WORLD POSITIONS β€” FOUND in the real decoded alpha, never
    // guessed (see `findRealArtRegion`'s own header). `roofBg`/`middleBg`/
    // `middleFg` all decode to the SAME width/height at one `scale` (one
    // NATIVE size for the whole fixture), so one `dims` object serves every
    // search.
    const dims = { width: roofBg.width, height: roofBg.height, worldW: FIXTURE.worldRect.maxX, worldH: FIXTURE.worldRect.maxY };
    const solidRoof = findRealArtRegion({ ...dims, mustBeOpaque: [roofBg] });
    // ⚠️ REQUIRES `middleBg` opaque too, not just roof+overhead transparent β€”
    // otherwise a "nothing painted" hit outside the map's own canvas content
    // would pass trivially. This makes the point a genuine "the middle floor
    // is really here, and genuinely nothing is above it" location.
    const openSky = findRealArtRegion({ ...dims, mustBeOpaque: [middleBg], mustBeTransparent: [roofBg, middleFg] });
    const middleOverheadSolid = findRealArtRegion({ ...dims, mustBeOpaque: [middleFg] });
    // THE CALIBRATION ANCHOR β€” a SEPARATE search from `solidRoof` above, and
    // deliberately so: measured live, a column can be genuinely, robustly
    // opaque-roof at BOTH its near-top and near-bottom rows (real roofline
    // bands on either side of a gap), which makes a perfectly valid TEST
    // point completely USELESS for telling a straight readback from a
    // flipped one β€” both hypotheses predict the same "2" there. Calibration
    // needs a point picked FOR contrast, not merely for content
    // (`requireVerticalAsymmetry` β€” see `findRealArtRegion`'s own header).
    const calibPoint = findRealArtRegion({ ...dims, mustBeOpaque: [roofBg], requireVerticalAsymmetry: true });
    log?.(
      `FLOOR-LIGHTING real-map: solidRoof=${JSON.stringify(solidRoof)} openSky=${JSON.stringify(openSky)} ` +
        `middleOverheadSolid=${JSON.stringify(middleOverheadSolid)} calibPoint=${JSON.stringify(calibPoint)}`
    );

    const rect = FIXTURE.worldRect;
    const realCamera = new THREE.OrthographicCamera(rect.minX, rect.maxX, rect.maxY, rect.minY, -1000, 1000);
    realCamera.position.set(0, 0, 100);
    realCamera.lookAt(0, 0, 0);
    realCamera.updateProjectionMatrix();
    // ⚠️ MATCHES THE DECODED ART RESOLUTION EXACTLY (2662x1237 at
    // EXPLORE_SCALE), not a rounder/smaller number picked for looks. A
    // coarser render target was tried first (1024 wide, ~2.6Γ— downsampled
    // from the source) and produced a real, live-measured bug: a test point
    // verified robust (Β±5 texels) at DECODE resolution can straddle or
    // average away at a render target ~2.6Γ— coarser, so a genuinely
    // asymmetric calibration point still read ambiguously once rendered.
    // Every layer already decodes to `roofBg.width/height` (all 5 share one
    // NATIVE size β€” see `dims`, above), so using that SAME number here isn't
    // an arbitrary upsize, it removes an entire class of mismatch between
    // "where a point was found" and "what got rendered there".
    //
    // ⚠️ ROUNDED UP TO A MULTIPLE OF 64, not `roofBg.width` verbatim β€” WebGPU
    // requires a texture-to-buffer copy's bytes-per-row to be a multiple of
    // 256, i.e. width a multiple of 64 at 4 bytes/texel. `1024` (the first
    // version of this render target) satisfied this BY ACCIDENT; the decoded
    // art's own `2662` does not (`2662*4=10648`, not a multiple of 256) and
    // threw `RangeError: offset is out of bounds` the instant this target
    // tried to read back β€” three's own readback wrapper leaks the padded
    // stride through rather than silently stripping it. Rounding up costs at
    // most 63px of slack, irrelevant at this scale.
    const realDimW = Math.ceil(roofBg.width / 64) * 64;
    const realDimH = Math.max(1, Math.round(realDimW * ((rect.maxY - rect.minY) / (rect.maxX - rect.minX))));
    const realAttrRt = new THREE.RenderTarget(realDimW, realDimH, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      colorSpace: THREE.NoColorSpace,
    });
    const realIllumRt = new THREE.RenderTarget(realDimW, realDimH, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
    });

    realMap = {
      scale,
      realItems,
      texByKey,
      solidRoof,
      openSky,
      middleOverheadSolid,
      calibPoint,
      realCamera,
      realDimW,
      realDimH,
      realAttrRt,
      realIllumRt,
      sceneDoc,
      // The SAME floors table `resolveLightElevationRank` needs, DERIVED from
      // the fixture's own bands β€” never re-typed a third time.
      floorsForRank: FIXTURE.floors.map((f) => ({
        index: f.index,
        id: f.id,
        elevationBottom: f.elevation.bottom,
        elevationTop: f.elevation.top,
      })),
    };
    return realMap;
  }

  /**
   * RENDER `buf:scene.attr` FOR THE REAL MAP, all 5 real items at once
   * (Β§5a's "all floors, not just the viewed one" β€” this is testing whether a
   * light is occluded by content that EXISTS, independent of which floor a
   * player happens to be looking at). Through the REAL encoder, exactly like
   * `renderAttr` above β€” the only difference is `solidityAlpha` samples a
   * REAL loaded texture instead of a constant `float(1)`.
   */
  async function renderRealAttr() {
    const rm = realMap;
    const scene = new THREE.Scene();
    const disposables = [];
    for (const item of rm.realItems) {
      const tex = rm.texByKey.get(`${item.levelId}:${item.kind}`);
      if (!tex) throw new Error(`real-map: no loaded texture for ${item.levelId}:${item.kind}`);
      const { uFloorIndex01, uPresenceBits01 } = resolveItemFloorAttrUniforms({
        THREE,
        item,
        viewedFloorIndex: 2,
        sceneDoc: rm.sceneDoc,
        logError: (m, e) => log?.(`FLOOR-LIGHTING real-map attr encode: ${m} ${e}`),
      });
      const mat = new THREE.NodeMaterial();
      // ⚠️ `transparent = true`, NOT the synthetic scenarios' `false` above.
      // Their `renderAttr()` gets away with an opaque material because ITS
      // upper floors are smaller GEOMETRY (a footprint rect) β€” "outside the
      // slab" is a hole because nothing is DRAWN there, never because
      // something transparent was drawn and blended through. Every real item
      // here is a FULL-CANVAS quad (matching real Foundry Level art exactly),
      // so the ONLY thing that can let a lower floor show through is REAL
      // alpha blending on `packFloorAttr`'s own blend-driving 4th component
      // β€” which an opaque material never applies (it just overwrites,
      // unconditionally, regardless of its own alpha). First run of this
      // scenario copied the wrong sibling's setup and got exactly the
      // failure mode `AGENTS.md` Β§10 already named for scenario 5's own
      // trap #3: the WHOLE buffer read as Roof (2), literally 100% of
      // texels, because Roof draws last and an opaque material's "alpha"
      // is not meaningful output.
      mat.transparent = true;
      mat.depthTest = false;
      mat.depthWrite = false;
      mat.side = THREE.DoubleSide;
      // THE SAME `.level(float(0))` PIN production has carried since round
      // 10 β€” an implicitly-selected mip on a real, large texture reading
      // alpha β‰ˆ 0 over visibly opaque paint is a bug this bench must not
      // re-discover by skipping the fix that already exists for it.
      const solidityAlpha = texture(tex).level(float(0)).a;
      mat.fragmentNode = packFloorAttr(THREE.TSL, {
        floorIndex01: uFloorIndex01,
        outdoors01: float(1),
        presenceBits01: uPresenceBits01,
        solidityAlpha,
      });
      const mesh = buildWorldQuadMesh(THREE, mat, item.renderOrder);
      scene.add(mesh);
      disposables.push(mesh.geometry, mat);
    }
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rm.realAttrRt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    await renderer.renderAsync(scene, rm.realCamera);
    renderer.setRenderTarget(prev);
    const buf = await renderer.readRenderTargetPixelsAsync(rm.realAttrRt, 0, 0, rm.realDimW, rm.realDimH);
    for (const d of disposables) d.dispose?.();
    return ArrayBuffer.isView(buf) ? buf : new Uint8Array(buf);
  }

  /** RENDER THE TEST LIGHTS against the real attr buffer, through the REAL material. */
  async function renderRealIllum({ lights, ambientLevel = 0.12 }) {
    const rm = realMap;
    const scene = new THREE.Scene();
    const disposables = [];
    const attrTexNode = texture(rm.realAttrRt.texture);
    const ambient = computeAmbientColors(
      { darkness01: 1 - ambientLevel, sky: null, globalLight: null, darknessLevel: 1 - ambientLevel },
      0
    );
    const bg = Array.isArray(ambient?.background) ? ambient.background : [ambientLevel, ambientLevel, ambientLevel];
    const built = [];
    for (const light of lights) {
      const uBackgroundColor = uniform(vec3(...bg));
      const uDimColor = uniform(vec3(0.55, 0.5, 0.42));
      const uBrightColor = uniform(vec3(1, 0.96, 0.86));
      const b = buildPointLightIlluminationMaterial({
        THREE,
        uBackgroundColor,
        uDimColor,
        uBrightColor,
        animation: null,
        uGlobalTimeMs: uniform(float(0)),
        falloffModel: 'foundry',
        sunShadowSlotNodes: null,
        attrTexNode,
        blendSunVisibilityAcrossFloors: null,
      });
      b.uRatio.value = 0.5;
      b.uAttenuationEased.value = easeAttenuation(0.5);
      b.uExposure.value = computeExposure(0.5);
      b.uEdgeCount.value = 0;
      b.uEdgeSoftMargin.value = 0;
      const rank = resolveLightElevationRank(light, rm.floorsForRank);
      b.uLightElevationRank.value = rank;
      const { array, vertexCount } = triangulateLightFan(lightPolygon(light), light.x, light.y, light.radius);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(array, 3));
      geo.setDrawRange(0, vertexCount);
      const mesh = new THREE.Mesh(geo, b.material);
      mesh.position.set(light.x, light.y, 0);
      mesh.scale.set(light.radius, light.radius, 1);
      mesh.frustumCulled = false;
      scene.add(mesh);
      disposables.push(geo, b.material);
      built.push({ id: light.id, rank, elevation: light.elevation });
    }
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rm.realIllumRt);
    renderer.setClearColor(new THREE.Color(bg[0], bg[1], bg[2]), 1);
    renderer.clear();
    await renderer.renderAsync(scene, rm.realCamera);
    renderer.setRenderTarget(prev);
    const buf = await renderer.readRenderTargetPixelsAsync(rm.realIllumRt, 0, 0, rm.realDimW, rm.realDimH);
    for (const d of disposables) d.dispose?.();
    return { bytes: ArrayBuffer.isView(buf) ? buf : new Uint8Array(buf), ambientByte: Math.round(bg[0] * 255), built };
  }

  /** World (x,y) β†’ readback index for the REAL map's OWN camera/RT pair, honouring its OWN calibrated orientation. */
  function sampleRealAt(bytes, x, y) {
    const { realDimW: w, realDimH: h } = realMap;
    const rect = FIXTURE.worldRect;
    const fx = (x - rect.minX) / (rect.maxX - rect.minX);
    const fy = (y - rect.minY) / (rect.maxY - rect.minY);
    const px = Math.min(w - 1, Math.max(0, Math.floor(fx * w)));
    const rowFromBottom = Math.min(h - 1, Math.max(0, Math.floor(fy * h)));
    const row = realOrientation === 'flipped' ? h - 1 - rowFromBottom : rowFromBottom;
    const i = (row * w + px) * 4;
    return { r: bytes[i], g: bytes[i + 1], b: bytes[i + 2], a: bytes[i + 3] };
  }

  /**
   * ESTABLISH ROW ORDER EMPIRICALLY for the REAL camera/RT pair β€” its OWN
   * calibration, never assumed to match the synthetic bench's `calibrate()`
   * above (different world size, different render target, a fresh chance to
   * be upside-down β€” `feedback_y_flip_recurring_risk`). Grounded in a REAL,
   * independently-verified fact rather than a synthetic prediction: the
   * `solidRoof` world point was found by scanning the Roof layer's OWN
   * decoded alpha directly (no GPU involved), so it is known β€” independent of
   * this camera entirely β€” to be a spot where the Roof floor (index 2) must
   * be what `buf:scene.attr` reports. Whichever row mapping produces `2`
   * there is correct; if BOTH or NEITHER do, this refuses to guess.
   */
  function calibrateRealOrientation(attrBytes) {
    if (!realMap.calibPoint) {
      throw new Error(
        'real-map calibrate: no vertically-asymmetric roof point was found to calibrate against ' +
          '(see findRealArtRegion´s requireVerticalAsymmetry)'
      );
    }
    const { realDimW: w, realDimH: h } = realMap;
    const rect = FIXTURE.worldRect;
    const rowAt = (x, y, flip) => {
      const fx = (x - rect.minX) / (rect.maxX - rect.minX);
      const fy = (y - rect.minY) / (rect.maxY - rect.minY);
      const px = Math.min(w - 1, Math.floor(fx * w));
      const rowFromBottom = Math.min(h - 1, Math.floor(fy * h));
      const row = flip ? h - 1 - rowFromBottom : rowFromBottom;
      return attrBytes[(row * w + px) * 4];
    };
    // `calibPoint` (unlike `solidRoof`) is GUARANTEED, by construction, to
    // have a DIFFERENT reading under its own vertical mirror β€” see this
    // function's own guard above and `findRealArtRegion`'s
    // `requireVerticalAsymmetry`. So exactly one of these two SHOULD read 2;
    // anything else means the render-target/world mapping itself is broken
    // in some way this simple flip test cannot name, and this correctly
    // refuses to guess rather than picking an orientation on a coin flip.
    const straight = rowAt(realMap.calibPoint.x, realMap.calibPoint.y, false);
    const flipped = rowAt(realMap.calibPoint.x, realMap.calibPoint.y, true);
    if (straight === 2 && flipped !== 2) {
      realOrientation = 'straight';
    } else if (flipped === 2 && straight !== 2) {
      realOrientation = 'flipped';
    } else {
      throw new Error(
        `real-map calibrate: ambiguous at a point CONSTRUCTED to be asymmetric (straight=${straight}, ` +
          `flipped=${flipped}, expected exactly one to read 2) β€” the world/render-target mapping itself needs ` +
          're-checking, not just the flip direction'
      );
    }
    log?.(`FLOOR-LIGHTING real-map: orientation ${realOrientation} (straight=${straight}, flipped=${flipped})`);
  }

  const scenarios = new Map();

  /**
   * SCENARIO 1 — does the light material read the attr buffer AT ALL?
   *
   * This is the question three rounds of arithmetic never asked. It varies
   * ONLY the attr buffer (by switching viewed floor) and holds every light
   * uniform fixed. If the gate genuinely samples per-fragment, the illum
   * frame MUST change. If it does not change, the gate is reading something
   * that is not the fragment's own attr texel — and no amount of tuning the
   * comparison can matter.
   */
  scenarios.set('gate-reads-the-attr-buffer', {
    name: 'gate-reads-the-attr-buffer',
    summary: 'Vary ONLY buf:scene.attr (viewed floor) and prove the light material responds per-pixel.',
    async run(ctx) {
      await ensureRenderer();
      const checks = [];
      const attrForCalibration = await renderAttr(2);
      let calibration = 'OK';
      try {
        calibrate(attrForCalibration);
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'calibration', status: 'UNMEASURED', note: String(err?.message ?? err) }));
      }

      const frames = {};
      const attrs = {};
      for (const floor of [0, 1, 2]) {
        attrs[floor] = await renderAttr(floor);
        frames[floor] = await renderIllum(floor);
      }

      // --- the attr buffer itself must be right before anything reading it
      // can be judged. An input this bench got wrong would look exactly like
      // a shader bug (`feedback_bench_must_build_inputs_like_production`).
      checks.push(
        evaluate('attr-floor0-ground-everywhere', () => {
          const inside = sampleAt(attrs[0], 500, 500);
          const outside = sampleAt(attrs[0], 150, 150);
          return {
            ok: inside.r === 0 && outside.r === 0,
            measured: { inside: inside.r, outside: outside.r },
            expected: 0,
            note: 'viewing the ground floor, every pixel is floor 0',
          };
        })
      );
      checks.push(
        evaluate('attr-floor2-slab-inside-hole-outside', () => {
          const inside = sampleAt(attrs[2], 500, 500);
          const outside = sampleAt(attrs[2], 150, 150);
          return {
            ok: inside.r === 2 && outside.r === 0,
            measured: { inside: inside.r, outside: outside.r },
            expected: { inside: 2, outside: 0 },
            note: 'the building slab reads floor 2; outside it you see straight down to the ground',
          };
        })
      );
      checks.push(
        evaluate('attr-receiver-elevation-subfield-is-written', () => {
          const inside = sampleAt(attrs[2], 500, 500);
          const level = decodeReceiverElevationLevel(inside.b);
          return {
            ok: Number.isFinite(level) && level >= 0 && level < RECEIVER_ELEVATION_LEVELS,
            measured: { rawB: inside.b, level },
            expected: `0..${RECEIVER_ELEVATION_LEVELS - 1}`,
            note: 'the height sub-field the gate decodes is actually present in B',
          };
        })
      );

      // --- THE LOAD-BEARING CHECK -------------------------------------------
      // Inside the building at the sealed ground light's centre: on floor 0 it
      // must be lit; on floor 2 the slab is overhead so it must fall back to
      // ambient. Same light, same uniforms, ONLY the attr buffer differs.
      checks.push(
        evaluate('sealed-ground-light-is-occluded-when-viewed-from-above', () => {
          const onGround = sampleAt(frames[0].bytes, 500, 500).r;
          const onSecond = sampleAt(frames[2].bytes, 500, 500).r;
          return {
            ok: onGround > frames[0].ambientByte + 20 && onSecond <= frames[2].ambientByte + 8,
            measured: { onGround, onSecond, ambient: frames[0].ambientByte },
            expected: 'lit on floor 0, ambient on floor 2',
            note:
              'THE bug the author reported three times. If onSecond is still bright, the material is not ' +
              'reading the fragment´s own attr texel.',
          };
        })
      );
      checks.push(
        evaluate('the-frame-changes-at-all-between-floors', () => {
          let diff = 0;
          for (let i = 0; i < frames[0].bytes.length; i += 4) {
            if (Math.abs(frames[0].bytes[i] - frames[2].bytes[i]) > 8) diff++;
          }
          const pct = (diff / (DIM * DIM)) * 100;
          return {
            ok: pct > 1,
            measured: `${pct.toFixed(2)}% of pixels differ`,
            expected: '>1%',
            note: 'a gate that samples a CONSTANT texel produces identical frames — this is that detector',
          };
        })
      );

      const artifacts = [];
      const canvas = document.createElement('canvas');
      for (const floor of [0, 1, 2]) {
        paint(frames[floor].bytes, canvas, `illum, viewing floor ${floor}`);
        const f = await saveCanvasPng(ctx.runId, `illum-floor${floor}.png`, canvas);
        if (f) artifacts.push(f);
        paint(attrs[floor], canvas, `attr, viewing floor ${floor}`);
        const a = await saveCanvasPng(ctx.runId, `attr-floor${floor}.png`, canvas);
        if (a) artifacts.push(a);
      }

      return {
        checks,
        calibration,
        artifacts,
        inputs: { WORLD, FOOTPRINT, DIM, lights: LIGHTS, orientation },
        stats: {
          ranks: frames[0].built,
          ambientByte: frames[0].ambientByte,
          sentinel: LIGHT_ELEVATION_UNCONFIGURED_SENTINEL,
          expectedRanks: LIGHTS.map((l) => ({ id: l.id, rank: elevationRank(l.expectFloor, l.elevation % 10) })),
        },
      };
    },
  });

  /**
   * SCENARIO 2 — THE AUTHOR'S THREE REQUIREMENTS, one check each.
   * Only meaningful once scenario 1 is green; a gate that cannot read the
   * buffer will fail these for a reason that has nothing to do with them.
   */
  scenarios.set('the-authors-three-lights', {
    name: 'the-authors-three-lights',
    summary: 'Outside light seen from every floor; sealed light occluded; first-floor light spilling outdoors.',
    async run(ctx) {
      await ensureRenderer();
      const checks = [];
      let calibration = 'OK';
      try {
        calibrate(await renderAttr(2));
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'calibration', status: 'UNMEASURED', note: String(err?.message ?? err) }));
      }
      const frames = {};
      for (const floor of [0, 1, 2]) {
        await renderAttr(floor);
        frames[floor] = await renderIllum(floor);
      }
      const amb = frames[0].ambientByte;

      checks.push(
        evaluate('outside-light-visible-from-every-floor', () => {
          const v = [0, 1, 2].map((f) => sampleAt(frames[f].bytes, 150, 150).r);
          return {
            ok: v.every((x) => x > amb + 20),
            measured: v,
            expected: `all > ${amb + 20}`,
            note: 'nothing is ever above an outdoor light, so no floor may occlude it',
          };
        })
      );
      checks.push(
        evaluate('sealed-light-lights-its-own-floor-only', () => {
          const g = sampleAt(frames[0].bytes, 500, 500).r;
          const s = sampleAt(frames[2].bytes, 500, 500).r;
          return {
            ok: g > amb + 20 && s <= amb + 8,
            measured: { floor0: g, floor2: s, ambient: amb },
            expected: 'bright on 0, ambient on 2',
          };
        })
      );
      checks.push(
        evaluate('first-floor-light-spills-OUTSIDE-and-stays-visible-from-above', () => {
          // (820,500) is east of the footprint (max 700) and inside the
          // FIRST_SPILL radius (260 from x=700) — open sky above it on every
          // floor, so its ground must stay lit even viewed from floor 2.
          const out2 = sampleAt(frames[2].bytes, 820, 500).r;
          const out0 = sampleAt(frames[0].bytes, 820, 500).r;
          return {
            ok: out2 > amb + 15 && out0 > amb + 15,
            measured: { floor0: out0, floor2: out2, ambient: amb },
            expected: 'lit on both — there is no slab out here to occlude it',
            note: 'proves the gate is per-pixel, not a blanket cross-floor kill',
          };
        })
      );
      checks.push(
        evaluate('the-same-light-IS-occluded-where-the-slab-covers-it', () => {
          // (620,500) is INSIDE the footprint and within FIRST_SPILL's reach.
          // Viewed from floor 2 the slab is overhead ⇒ ambient.
          const in2 = sampleAt(frames[2].bytes, 620, 500).r;
          const out2 = sampleAt(frames[2].bytes, 820, 500).r;
          return {
            ok: in2 < out2 - 15,
            measured: { insideSlab: in2, outsideSlab: out2 },
            expected: 'inside must be markedly darker than outside, in the SAME frame',
            note: 'one light, one frame, two fates — the sharpest possible per-pixel evidence',
          };
        })
      );

      const artifacts = [];
      const canvas = document.createElement('canvas');
      for (const floor of [0, 1, 2]) {
        paint(frames[floor].bytes, canvas, `viewing floor ${floor}`);
        const f = await saveCanvasPng(ctx.runId, `authors-lights-floor${floor}.png`, canvas);
        if (f) artifacts.push(f);
      }
      return {
        checks,
        calibration,
        artifacts,
        inputs: { lights: LIGHTS, FOOTPRINT, orientation },
        stats: { ambientByte: amb, ranks: frames[0].built },
      };
    },
  });

  /**
   * SCENARIO 3 — THE ANIMATED / COLOURED HALF OF THE LIGHT.
   *
   * The author, after the illumination fix landed: *"You are now correctly
   * occluding the light polygon. But you aren't correctly occluding the
   * animated light source."* Same building, same lights, same gate — but
   * rendered through `buildPointLightColorationMaterial`, the SECOND mesh that
   * shares a light's geometry and carries its colour and animation.
   */
  scenarios.set('animated-coloration-is-occluded-too', {
    name: 'animated-coloration-is-occluded-too',
    summary: 'The coloured/animated half of a light must obey the same floor occlusion as its illumination.',
    async run(ctx) {
      await ensureRenderer();
      const checks = [];
      let calibration = 'OK';
      try {
        calibrate(await renderAttr(2));
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'calibration', status: 'UNMEASURED', note: String(err?.message ?? err) }));
      }
      const col = {};
      for (const floor of [0, 2]) {
        await renderAttr(floor);
        col[floor] = await renderColoration();
      }

      checks.push(
        evaluate('coloration-responds-to-the-attr-buffer-at-all', () => {
          let diff = 0;
          for (let i = 0; i < col[0].length; i += 4) if (Math.abs(col[0][i] - col[2][i]) > 8) diff++;
          const pct = (diff / (DIM * DIM)) * 100;
          return {
            ok: pct > 1,
            measured: `${pct.toFixed(2)}% of pixels differ`,
            expected: '>1%',
            note: 'the same constant-texel detector, pointed at the coloration material',
          };
        })
      );
      checks.push(
        evaluate('sealed-light-coloration-is-gone-from-above', () => {
          const g = sampleAt(col[0], 500, 500).r;
          const s2 = sampleAt(col[2], 500, 500).r;
          return {
            ok: g > 20 && s2 <= 8,
            measured: { floor0: g, floor2: s2 },
            expected: 'coloured on floor 0, black (additive zero) on floor 2',
          };
        })
      );
      checks.push(
        evaluate('outside-light-coloration-survives-every-floor', () => {
          const v = [0, 2].map((f) => sampleAt(col[f], 150, 150).r);
          return { ok: v.every((x) => x > 20), measured: v, expected: 'coloured on both — nothing above it' };
        })
      );
      checks.push(
        evaluate('coloration-is-cut-by-the-slab-edge-in-ONE-frame', () => {
          const inSlab = sampleAt(col[2], 620, 500).r;
          const outSlab = sampleAt(col[2], 820, 500).r;
          return {
            ok: inSlab < outSlab - 15,
            measured: { insideSlab: inSlab, outsideSlab: outSlab },
            expected: 'the building edge must show in the coloured glow exactly as it does in the illumination',
          };
        })
      );

      const artifacts = [];
      const canvas = document.createElement('canvas');
      for (const floor of [0, 2]) {
        paint(col[floor], canvas, `coloration, viewing floor ${floor}`);
        const f = await saveCanvasPng(ctx.runId, `coloration-floor${floor}.png`, canvas);
        if (f) artifacts.push(f);
      }
      return { checks, calibration, artifacts, inputs: { lights: LIGHTS, orientation }, stats: {} };
    },
  });

  /**
   * SCENARIO 4 — THE CANDLE FLAME AND LIGHTNING BOLT SPRITES.
   *
   * The author's next report, after coloration: *"Now do the candle flame
   * and lightning shaders too."* Both are SEPARATE batched meshes from a
   * point light's own pair (candle-flame-render.js / lightning-render.js),
   * each with its own per-vertex-baked `elevationRank` (`boot.js#getCandle
   * RenderState`/`getLightningRenderState`'s `resolveAnchorElevationRank`)
   * rather than a per-light uniform, since one draw call batches EVERY
   * active candle/strand and different anchors can legitimately sit on
   * different floors.
   */
  scenarios.set('candle-and-lightning-sprites-are-occluded', {
    name: 'candle-and-lightning-sprites-are-occluded',
    summary: 'The candle flame billboard and the lightning bolt ribbon obey the SAME floor occlusion as a light.',
    async run(ctx) {
      await ensureRenderer();
      const checks = [];
      let calibration = 'OK';
      try {
        calibrate(await renderAttr(2));
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'calibration', status: 'UNMEASURED', note: String(err?.message ?? err) }));
      }

      const attrTexNode = texture(attrRt.texture);
      const groundRank = elevationRank(0, 0); // floor 0, at its own ground — every anchor below is on this floor

      async function renderCandle(floor) {
        await renderAttr(floor);
        const scene = new THREE.Scene();
        const mat = buildCandleFlameMaterial({ THREE, uGlobalTimeMs: uniform(float(0)), quality: 0, attrTexNode });
        const anchors = [{ x: 500, y: 500, elevationRank: groundRank }]; // sealed, inside the footprint
        const { geometry } = buildCandleFlameGeometry(THREE, anchors, { sizePx: 120 });
        const mesh = new THREE.Mesh(geometry, mat.material);
        mesh.frustumCulled = false;
        scene.add(mesh);
        const prev = renderer.getRenderTarget();
        renderer.setRenderTarget(illumRt);
        renderer.setClearColor(0x000000, 1);
        renderer.clear();
        await renderer.renderAsync(scene, camera);
        renderer.setRenderTarget(prev);
        const buf = await renderer.readRenderTargetPixelsAsync(illumRt, 0, 0, DIM, DIM);
        geometry.dispose();
        mat.material.dispose();
        return ArrayBuffer.isView(buf) ? buf : new Uint8Array(buf);
      }

      async function renderLightning(floor) {
        await renderAttr(floor);
        const scene = new THREE.Scene();
        // ⚠️ NOT `spawnMs + durationMs` (t=1 exactly) — the envelope's own
        // `decay = (1-postT)²` and `connectSpike = exp(postT·-28)` BOTH go to
        // ~0 at full duration (a bolt has genuinely finished decaying by
        // then), so a first draft that picked t=1 rendered nothing and looked
        // exactly like an occlusion bug. t≈0.2 (just past the leader, near
        // the return-stroke's own brightness peak) is well-lit and non-
        // discarded — computeStrandEnvelope's own doc has the full formula.
        const uGlobalTimeMs = uniform(float(200));
        const mat = buildLightningMaterial({ THREE, uGlobalTimeMs, quality: 0, attrTexNode });
        const strand = {
          xs: [450, 550],
          ys: [500, 500],
          spawnMs: 0,
          durationMs: 1000,
          seed: 1,
          leaderFrac: 0.15,
          restrikeCount: 8,
          baseIntensity: 1,
          widthScale: 1,
          isBranch: false,
          parentSpawnMs: null,
          parentDurationMs: null,
          parentLeaderFrac: null,
          growthSpeed: 1,
          elevationRank: groundRank, // sealed, inside the footprint — same as the candle above
        };
        const arrays = computeLightningStrandArrays([strand], 4, 32);
        const geometry = buildLightningGeometry(THREE, arrays);
        const mesh = new THREE.Mesh(geometry, mat.material);
        mesh.frustumCulled = false;
        scene.add(mesh);
        const prev = renderer.getRenderTarget();
        renderer.setRenderTarget(illumRt);
        renderer.setClearColor(0x000000, 1);
        renderer.clear();
        await renderer.renderAsync(scene, camera);
        renderer.setRenderTarget(prev);
        const buf = await renderer.readRenderTargetPixelsAsync(illumRt, 0, 0, DIM, DIM);
        geometry.dispose();
        mat.material.dispose();
        return ArrayBuffer.isView(buf) ? buf : new Uint8Array(buf);
      }

      const candle0 = await renderCandle(0);
      const candle2 = await renderCandle(2);
      const bolt0 = await renderLightning(0);
      const bolt2 = await renderLightning(2);

      checks.push(
        evaluate('candle-flame-responds-to-the-attr-buffer-at-all', () => {
          let diff = 0;
          for (let i = 0; i < candle0.length; i += 4) if (Math.abs(candle0[i] - candle2[i]) > 8) diff++;
          const pct = (diff / (DIM * DIM)) * 100;
          return { ok: pct > 0.05, measured: `${pct.toFixed(3)}% of pixels differ`, expected: '>0.05%' };
        })
      );
      checks.push(
        evaluate('sealed-candle-flame-is-gone-from-above', () => {
          const g = sampleAt(candle0, 500, 500).r;
          const s2 = sampleAt(candle2, 500, 500).r;
          return {
            ok: g > 20 && s2 <= 8,
            measured: { floor0: g, floor2: s2 },
            expected: 'visible flame on floor 0, fully dark (additive zero) from above',
          };
        })
      );
      checks.push(
        evaluate('lightning-bolt-responds-to-the-attr-buffer-at-all', () => {
          let diff = 0;
          for (let i = 0; i < bolt0.length; i += 4) if (Math.abs(bolt0[i] - bolt2[i]) > 8) diff++;
          const pct = (diff / (DIM * DIM)) * 100;
          return { ok: pct > 0.05, measured: `${pct.toFixed(3)}% of pixels differ`, expected: '>0.05%' };
        })
      );
      checks.push(
        evaluate('sealed-lightning-bolt-is-gone-from-above', () => {
          const g = sampleAt(bolt0, 500, 500).r;
          const s2 = sampleAt(bolt2, 500, 500).r;
          return {
            ok: g > 20 && s2 <= 8,
            measured: { floor0: g, floor2: s2 },
            expected: 'visible bolt on floor 0, fully dark (additive zero) from above',
          };
        })
      );

      const artifacts = [];
      const canvas = document.createElement('canvas');
      paint(candle0, canvas, 'candle flame, viewing floor 0');
      artifacts.push(await saveCanvasPng(ctx.runId, 'candle-floor0.png', canvas));
      paint(candle2, canvas, 'candle flame, viewing floor 2');
      artifacts.push(await saveCanvasPng(ctx.runId, 'candle-floor2.png', canvas));
      paint(bolt0, canvas, 'lightning bolt, viewing floor 0');
      artifacts.push(await saveCanvasPng(ctx.runId, 'lightning-floor0.png', canvas));
      paint(bolt2, canvas, 'lightning bolt, viewing floor 2');
      artifacts.push(await saveCanvasPng(ctx.runId, 'lightning-floor2.png', canvas));

      return {
        checks,
        calibration,
        artifacts: artifacts.filter(Boolean),
        inputs: { orientation },
        stats: { groundRank },
      };
    },
  });

  /**
   * SCENARIO 5 — AN OCCLUSION-FADED ROOF MUST STAY PHYSICALLY SOLID.
   *
   * The author's live report, round 7: a point light's own room stayed LIT
   * from above the instant a token stood in it — because Foundry's own roof-
   * fade mechanic (`scene/occlusion.js`, `tile.occlusion.modes`) faded that
   * roof's ON-SCREEN alpha toward 0 so the player could see their character,
   * and `buf:scene.attr`'s solidity write (before this round) was built
   * from that SAME faded alpha — `output.a`, this material's own final,
   * post-occlusion result. Rounds 1-6 never modelled occlusion at all, which
   * is exactly why a lab-green fix still failed live.
   *
   * This exercises `buildRealFloorAttrMrtNode`'s NEW `solidityAlpha`
   * override DIRECTLY, through a REAL 2-attachment MRT render target
   * (matching `vt/scene-attr.js#describeSceneAttrMrt`'s own shape) — built
   * by hand here because `vt-pan-viewer.js`'s own allocator isn't
   * independently importable, but the MRT WIRING under test is the same
   * either way.
   */
  scenarios.set('occlusion-fade-does-not-defeat-solidity', {
    name: 'occlusion-fade-does-not-defeat-solidity',
    summary:
      'A roof rendered near-invisible on screen (Foundry´s own token-under-roof fade) must still write FULL ' +
      'solidity into buf:scene.attr — the two are different questions, not one number.',
    async run(ctx) {
      await ensureRenderer();
      const checks = [];
      let calibration = 'OK';
      try {
        calibrate(await renderAttr(2));
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'calibration', status: 'UNMEASURED', note: String(err?.message ?? err) }));
      }

      const mrtRt = new THREE.RenderTarget(DIM, DIM, {
        count: 2,
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
      });
      // NAMED to match `vt/scene-attr.js#describeSceneAttrMrt`'s own
      // attachments (`outputName: 'output'`/`'attr'`) — the real allocator
      // always sets this; a hand-built RenderTarget here must too, or
      // three's own MRT slot resolution has nothing to match `mrt({attr:
      // ...})`'s named key against.
      mrtRt.textures[0].name = 'output';
      mrtRt.textures[1].name = 'attr';

      const roofItem = FLOOR_ITEMS[2]; // floor 2, the same slab every other scenario uses
      // THE FIX UNDER TEST — a genuine top-level TSL node (not a closure
      // variable smuggled out of a Fn — that is the ORIGINAL, different trap
      // buildRealFloorAttrMrtNode's own doc warns about), asserting "this
      // roof is PHYSICALLY here" independent of how it renders on screen.
      const solidityAlpha = float(1);
      const mat = new THREE.NodeMaterial();
      // ⚠️ `transparent = true`, matching the REAL `buildWholeImageMaterial`
      // exactly — a THIRD trap this scenario found in itself. A first draft
      // left this `false` (copied from `renderAttr`'s own simpler, opaque-
      // fragmentNode material above, a different shape) and the low alpha
      // this scenario depends on read back as a flat 255 regardless of what
      // colorNode computed — an opaque material's alpha is not meaningful
      // output, so nothing downstream should be trusted to preserve it.
      mat.transparent = true;
      mat.depthTest = false;
      mat.depthWrite = false;
      mat.side = THREE.DoubleSide;
      // THE SIMULATED OCCLUSION FADE — stands in for a token under the roof
      // driving `occlusionAlphaFactor(occ)` toward 0. Deliberately NOT what
      // feeds `solidityAlpha` above: that decoupling is the entire claim
      // being tested.
      mat.colorNode = vec4(1, 1, 1, float(0.02));
      // ⚠️ `buildRealFloorAttrMrtNode` now returns `{mrtNode, floorAttrUniforms}`
      // (2026-08-03, a CONCURRENT author fix — `feedback_floor_index_resolved_
      // once_never_revisited` — for a real, separate live bug: an item's floor
      // index used to be resolved ONCE at build time and never refreshed,
      // which broke specular on a scene's newest floor). Every REAL call site
      // in `vt-pan-viewer.js` was updated the same round; this bench's own
      // call site, being outside that file, was not swept along and needed
      // the same update by hand. `floorAttrUniforms` is for the NEW per-frame
      // refresh path — this is a one-shot render, so it is built and ignored.
      const { mrtNode } = buildRealFloorAttrMrtNode({
        THREE,
        item: roofItem,
        viewedFloorIndex: 2,
        sceneDoc: SCENE_DOC,
        logError: (m, e) => log?.(`FLOOR-LIGHTING occlusion-fade: ${m} ${e}`),
        envLight: {}, // no outdoors gate needed for this check — buildWorldSpaceOutdoorsGate is null-safe
        solidityAlpha,
      });
      mat.mrtNode = mrtNode;
      const mesh = quadMesh(FOOTPRINT, mat, 0);
      const scene = new THREE.Scene();
      scene.add(mesh);

      // ⚠️ `renderer.setMRT(...)` IS NOT OPTIONAL — a second real trap this
      // scenario found in ITSELF, in the vendored three.webgpu.js source
      // (`NodeMaterial`'s fragment-stage build): when `renderer.getMRT()` is
      // null, `material.mrtNode` REPLACES the entire fragment output rather
      // than extending it — a `mrt({attr: ...})` with no `output` key then
      // writes NOTHING to slot 0 at all. Real production
      // (`vt-pan-viewer.js`) always wraps a REAL-WRITER render in
      // `renderer.setMRT(buildSceneAttrZeroMrt(THREE))` — `mrt({output,
      // attr: vec4(0,0,0,0)})` — first; THREE then MERGES that renderer-
      // level default with each material's own `mrtNode`, which is how
      // "output" (this material's own colour) reaches slot 0 for free while
      // "attr" is overridden per-material. Omitting this call is why a first
      // draft here read BOTH slots as if nothing had ever drawn.
      const zeroMrt = mrt({ output, attr: vec4(0, 0, 0, 0) });
      const prevMrt = renderer.getMRT();
      renderer.setMRT(zeroMrt);
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(mrtRt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      await renderer.renderAsync(scene, camera);
      renderer.setRenderTarget(prev);
      renderer.setMRT(prevMrt);
      // ⚠️ FULL-BUFFER READBACK + `sampleAt` (orientation-aware), NOT A RAW
      // GUESSED PIXEL COORDINATE — the FIRST real trap this scenario found in
      // itself. A first draft read 1×1 at `(DIM>>1, DIM>>1)` directly; this
      // very bench's OWN camera reads `orientation: 'flipped'` (established
      // by `calibrate()`, above), so a raw pixel coordinate with no flip
      // correction samples the WRONG world location. Every other scenario in
      // this file already routes through `sampleAt`; this one skipped it and
      // produced a confident, wrong "pass" on pure luck of what happened to
      // sit at the un-corrected coordinate. `feedback_y_flip_recurring_risk`
      // — verify orientation at every NEW mapping, no exceptions for a
      // "just this once, small" scenario.
      const colorBuf = await renderer.readRenderTargetPixelsAsync(mrtRt, 0, 0, DIM, DIM, 0);
      const attrBuf = await renderer.readRenderTargetPixelsAsync(mrtRt, 0, 0, DIM, DIM, 1);
      mesh.geometry.dispose();
      mat.dispose();

      const color = sampleAt(ArrayBuffer.isView(colorBuf) ? colorBuf : new Uint8Array(colorBuf), 500, 450);
      const attr = sampleAt(ArrayBuffer.isView(attrBuf) ? attrBuf : new Uint8Array(attrBuf), 500, 450);

      checks.push(
        evaluate('roof-is-visually-faded-to-near-invisible', () => {
          return {
            ok: color.a < 15,
            measured: { onScreenAlpha: color.a },
            expected: '<15 (the simulated occlusion fade — a token stands under this roof)',
            note: 'sanity check on the test rig itself: the fade must actually be happening',
          };
        })
      );
      checks.push(
        evaluate('attr-solidity-stays-full-DESPITE-the-visual-fade', () => {
          return {
            ok: attr.a > 240 && attr.r === 2,
            measured: { attrAlpha: attr.a, attrFloorIndex: attr.r },
            expected:
              'alpha >240 AND floor index === 2 — the roof is still PHYSICALLY here even though nobody can see it on screen',
            note: 'THE bug: before this fix, attr.a tracked color.a and a light under this roof stopped being occluded the instant a token walked in',
          };
        })
      );

      const artifacts = [];
      const canvas = document.createElement('canvas');
      paint(colorBuf, canvas, 'roof, on-screen (occlusion-faded)');
      artifacts.push(await saveCanvasPng(ctx.runId, 'occlusion-fade-onscreen.png', canvas));
      paint(attrBuf, canvas, 'roof, buf:scene.attr (must stay solid)');
      artifacts.push(await saveCanvasPng(ctx.runId, 'occlusion-fade-attr.png', canvas));

      return {
        checks,
        calibration,
        artifacts: artifacts.filter(Boolean),
        inputs: { roofItem, simulatedOnScreenAlpha: 0.02, orientation },
        stats: { color, attr },
      };
    },
  });

  /**
   * SCENARIO 6 — AN UNCONFIGURED LIGHT UNDER A COVER, NO ELEVATION AUTHORED
   * ANYWHERE. THE EXACT LANTERN-HOUSING REPORT.
   *
   * Round 7 fixed a real, confirmed bug and the author's screenshot STILL
   * showed the same lantern glowing under its own wooden housing —
   * unsurprising, since it was mathematically certain the fine height gate
   * cannot fire at all for a light whose `elevation` was never touched:
   * `LIGHT_ELEVATION_UNCONFIGURED_SENTINEL` pushes the comparison band to
   * ~1e6, provably beyond any real receiver rank. If neither the light nor
   * the housing tile has ever had elevation set — the likely state of a
   * decorative "lantern cover" authored before this feature existed — no
   * numeric height comparison could ever have occluded it, regardless of how
   * many times the arithmetic around it was corrected.
   *
   * This proves the round-8 fix: `PRESENCE_BIT_OVERHEAD` (`buildHeightGate
   * Node`'s own "ROUND 8" header) hard-blocks a light under genuine
   * foreground/roof content REGARDLESS of the light's own configured state.
   * Three covers, three different authoring stories:
   *   - a Level's own FOREGROUND layer — gets its elevation AUTOMATICALLY
   *     from the Level's own (already-mandatory) band, zero extra authoring.
   *   - a Tile explicitly raised to/above its floor's own top — the author's
   *     one deliberate action for a discrete "this is a roof too" object.
   *   - an ORDINARY tile at its default, unraised elevation — the regression
   *     guard: furniture/decoration must NOT block a light sitting on it.
   */
  scenarios.set('unconfigured-light-under-unconfigured-cover', {
    name: 'unconfigured-light-under-unconfigured-cover',
    summary:
      'The exact lantern-housing report: neither the light nor its cover has ever had elevation set. ' +
      'PRESENCE_BIT_OVERHEAD must occlude anyway; an ordinary same-height tile must not.',
    async run(ctx) {
      await ensureRenderer();
      const checks = [];
      // ⚠️ A FOURTH real trap, found running THIS scenario: `sampleAt` reads
      // the MODULE-LEVEL `orientation`, set ONLY by `calibrate()` — every
      // OTHER scenario in this file calls it first; this one initially did
      // not. Run this scenario FIRST after a fresh page load (`orientation`
      // still `null`) and `sampleAt` silently used the UN-flipped row
      // mapping — sampling a completely different world position than
      // intended, reading the plain ground everywhere and reporting "no
      // cover found" for all three fixtures identically. Confirmed via a
      // temporary readback of the raw attr byte actually sampled (`b: 0`,
      // i.e. ground, for every cover including the ones that should read
      // 169/128) — the ENCODER and the GATE were both already correct; only
      // this scenario's OWN coordinate mapping was not.
      let calibration = 'OK';
      try {
        calibrate(await renderAttr(2));
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'calibration', status: 'UNMEASURED', note: String(err?.message ?? err) }));
      }
      const groundTop = 10; // FLOOR_ITEMS[0]'s own band is [0,10) — the "floor top" a foreground item auto-adopts

      async function renderAttrWithCover(coverItem) {
        const scene = new THREE.Scene();
        const disposables = [];
        const allItems = coverItem ? [FLOOR_ITEMS[0], coverItem] : [FLOOR_ITEMS[0]];
        for (const item of allItems) {
          const { uFloorIndex01, uPresenceBits01 } = resolveItemFloorAttrUniforms({
            THREE,
            item,
            viewedFloorIndex: 0,
            sceneDoc: SCENE_DOC,
            logError: (m, e) => log?.(`FLOOR-LIGHTING unconfigured-cover attr encode: ${m} ${e}`),
          });
          const mat = new THREE.NodeMaterial();
          mat.transparent = false;
          mat.depthTest = false;
          mat.depthWrite = false;
          mat.side = THREE.DoubleSide;
          mat.fragmentNode = packFloorAttr(THREE.TSL, {
            floorIndex01: uFloorIndex01,
            outdoors01: float(1),
            presenceBits01: uPresenceBits01,
            solidityAlpha: float(1),
          });
          // renderOrder, not z: depthTest is off, matching renderAttr's own
          // documented trap (`AGENTS.md` §10) — the cover must draw AFTER the
          // ground so it is the one buf:scene.attr actually records here.
          const mesh = quadMesh(item.rect, mat, item === coverItem ? 1 : 0);
          scene.add(mesh);
          disposables.push(mesh.geometry, mat);
        }
        const prev = renderer.getRenderTarget();
        renderer.setRenderTarget(attrRt);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        await renderer.renderAsync(scene, camera);
        renderer.setRenderTarget(prev);
        const buf = await renderer.readRenderTargetPixelsAsync(attrRt, 0, 0, DIM, DIM);
        for (const d of disposables) d.dispose?.();
        return ArrayBuffer.isView(buf) ? buf : new Uint8Array(buf);
      }

      // THE UNCONFIGURED LIGHT — elevation omitted entirely, exactly like a
      // light nobody has ever opened the "Advanced" tab of the Light Config
      // sheet for. `resolveLightElevationRank` reads this as the sentinel.
      const unconfiguredLight = { id: 'LANTERN', x: 500, y: 450, radius: 200, elevation: 0 };
      const coverRect = { minX: 440, minY: 390, maxX: 560, maxY: 510 }; // a small housing, centred on the light
      // ⚠️ "beside the cover" must stay well within the light's OWN full-
      // brightness zone, or its NATURAL radial falloff (zero at radius=200
      // by design — Foundry's own attenuation curve) confounds "is this
      // occluded" with "is this just far from the light". A first draft
      // sampled (500,650) — distance 200, EXACTLY the light's own edge,
      // already dim from falloff alone — and every cover variant, including
      // the ordinary non-occluding one, read as "not reaching" there.
      // (500,560) is 110 units out — outside the housing (bottom edge 510)
      // but comfortably inside the light's own bright core.
      const besideX = 500;
      const besideY = 560;

      const covers = {
        levelForeground: {
          levelId: 'ground',
          kind: 'levelForeground',
          // NO elevation authored by this test — matches foundry/scene-
          // layers.js#consider('foreground') exactly: `ownElevation =
          // elevation.top`, assigned automatically from the Level's own,
          // already-mandatory band.
          key: { elevation: groundTop },
          rect: coverRect,
          floorIndex: 0,
        },
        raisedTile: {
          levelId: '',
          kind: 'tile',
          // The one deliberate author action this fix asks for: raise a
          // discrete cover tile's elevation to/above its floor's own top —
          // "mark this as a roof", not "compute an exact height vs a light".
          key: { elevation: groundTop },
          rect: coverRect,
          floorIndex: 0,
        },
        ordinaryTile: {
          levelId: '',
          kind: 'tile',
          // REGRESSION GUARD — an ordinary decorative tile, NEVER raised.
          key: { elevation: 0 },
          rect: coverRect,
          floorIndex: 0,
        },
      };

      const results = {};
      let ambientByte = null;
      for (const [name, cover] of Object.entries(covers)) {
        const attrBytes = await renderAttrWithCover(cover);
        const illum = await renderIllum(0, { lights: [unconfiguredLight] });
        ambientByte = illum.ambientByte; // same every iteration — real production value, never hardcoded
        results[name] = {
          underCover: sampleAt(illum.bytes, 500, 450).r,
          besideCover: sampleAt(illum.bytes, besideX, besideY).r,
          // The RAW attr byte this scenario's own render actually produced
          // under the cover — kept as a permanent sanity check, not just a
          // debug aid: it separates an ENCODER regression (this byte reads
          // wrong) from a GATE regression (this byte is right, but the light
          // still isn't occluded) — exactly the ambiguity that cost real
          // time finding this scenario's own missing `calibrate()` call.
          attrOverheadBitUnderCover: decodeOverheadBit(sampleAt(attrBytes, 500, 450).b),
        };
      }

      checks.push(
        evaluate('attr-overhead-bit-is-encoded-correctly-for-each-cover', () => ({
          ok:
            results.levelForeground.attrOverheadBitUnderCover === 1 &&
            results.raisedTile.attrOverheadBitUnderCover === 1 &&
            results.ordinaryTile.attrOverheadBitUnderCover === 0,
          measured: {
            levelForeground: results.levelForeground.attrOverheadBitUnderCover,
            raisedTile: results.raisedTile.attrOverheadBitUnderCover,
            ordinaryTile: results.ordinaryTile.attrOverheadBitUnderCover,
          },
          expected: '1, 1, 0 — the ENCODER half, independent of whether the light gate then reaches it',
        }))
      );
      checks.push(
        evaluate('level-foreground-cover-occludes-the-unconfigured-light', () => ({
          // Occluded reads as ambient — the CLEAR colour, since MAX blending
          // can only ever raise a fragment above it (same baseline every
          // other scenario in this file compares against; never a guessed
          // "near enough to zero" threshold).
          ok: results.levelForeground.underCover <= ambientByte + 8,
          measured: { ...results.levelForeground, ambientByte },
          expected: `underCover <= ${ambientByte + 8} — a Level´s own foreground, auto-elevated, needs ZERO extra authoring`,
        }))
      );
      checks.push(
        evaluate('deliberately-raised-tile-cover-occludes-the-unconfigured-light', () => ({
          ok: results.raisedTile.underCover <= ambientByte + 8,
          measured: { ...results.raisedTile, ambientByte },
          expected: `underCover <= ${ambientByte + 8} — the ONE action this fix asks of an author for a discrete cover object`,
        }))
      );
      checks.push(
        evaluate('ordinary-unraised-tile-does-NOT-occlude-the-same-light', () => ({
          ok: results.ordinaryTile.underCover > 100,
          measured: results.ordinaryTile,
          expected:
            'underCover >100 — the regression guard: furniture/decoration must not blank out a light sitting on it',
        }))
      );
      checks.push(
        evaluate('the-light-still-reaches-normally-just-outside-every-cover', () => ({
          ok: results.levelForeground.besideCover > 100 && results.raisedTile.besideCover > 100,
          measured: {
            levelForeground: results.levelForeground.besideCover,
            raisedTile: results.raisedTile.besideCover,
          },
          expected: '>100 — occlusion is per-pixel, not a blanket kill of the whole light',
        }))
      );

      const artifacts = [];
      const canvas = document.createElement('canvas');
      for (const [name, cover] of Object.entries(covers)) {
        await renderAttrWithCover(cover);
        const { bytes } = await renderIllum(0, { lights: [unconfiguredLight] });
        paint(bytes, canvas, `unconfigured light, cover=${name}`);
        const f = await saveCanvasPng(ctx.runId, `unconfigured-cover-${name}.png`, canvas);
        if (f) artifacts.push(f);
      }

      return {
        checks,
        calibration,
        artifacts: artifacts.filter(Boolean),
        inputs: { unconfiguredLight, coverRect, covers, orientation },
        stats: results,
      };
    },
  });

  /**
   * ============================================================================
   * SCENARIO 7 β€” STAGE 0 OF THE DEPTH-BUFFER REDESIGN: THE REAL MAP
   * REPRODUCES THE LIVE BUG (docs/planning/Depth-Buffer.md Β§9, stage 0)
   * ============================================================================
   * Author, 2026-08-04, after "no more fucking probes": build the fix's proof
   * "IN THE SHADER LAB. Because you can automatically test things there. Not
   * in Foundry. I already have the map in Foundry" (a live check already
   * exists there β€” this bench's job is to be AUTOMATIC, not to replace it).
   *
   * Every scenario ABOVE this one draws a synthetic building out of
   * rectangles. That is precisely the shape that let a real bug survive
   * THREE lab-green rounds (`feedback_bench_must_build_inputs_like_
   * production`) β€” a synthetic roof has no occlusion concept, no real alpha,
   * no real silhouette. This scenario draws the REAL "town river bridge" map
   * instead: `fixtures/tower-bridge.js`'s three real Level backgrounds
   * (Underground/Middle/Roof, author-ratified elevation bands
   * 0-20/20-40/40-∞) PLUS its two real `_Overhead` foreground layers β€”
   * through the REAL `collectLevelTextures` (never a hand-built item list:
   * this is the EXACT producer `vt-pan-viewer.js` calls, so a mis-elevated
   * foreground or a wrong sort tie-break is a bug in THIS bench's inputs, not
   * invented here), the REAL `resolveItemFloorAttrUniforms`/`packFloorAttr`
   * encoder, and the REAL `buildPointLightIlluminationMaterial` gate.
   *
   * ⚠️ THIS SCENARIO MUST FAIL, TODAY. If it passes, either the bench is
   * still lying (go find what synthetic shortcut crept back in) or the bug
   * is already fixed and this comment is stale β€” it is NOT a bug in the
   * scenario for `report.ok` to come back `false` here. That is the entire
   * point of building it BEFORE touching any production code
   * (Depth-Buffer.md's own "stage 0" table: "it should FAIL β€” reproducing
   * the live bug in the lab for the first time. If it passes, the bench is
   * still lying and nothing after this is trustworthy.").
   *
   * THE FAILING CASE, and why it is real, not invented: `resolveLightElevat
   * ionRank` maps a light whose Foundry `elevation` reads as the schema
   * default (0) to `LIGHT_ELEVATION_UNCONFIGURED_SENTINEL` β€” the fine height
   * gate can then never fire, BY DESIGN. The only other thing that can
   * occlude such a light is `PRESENCE_BIT_OVERHEAD`, which fires for a
   * Level's own FOREGROUND (it sits at its own floor's `elevation.top`, so
   * `isInForeground` is true by construction) but does NOT fire for an
   * ordinary Level BACKGROUND sitting on the floor ABOVE (its own elevation
   * is THAT floor's `elevation.bottom`, never >= that floor's own top). So:
   * an unconfigured light on the Middle floor, directly under a spot where
   * the ROOF's own plain background art is opaque β€” a whole floor and its
   * buildings β€” is occluded by NEITHER mechanism.
   * `docs/planning/Light-Elevation-Occlusion-Failure.md`'s "symptom 1" and
   * `docs/planning/Depth-Buffer.md` Β§0's source audit both name this exact
   * gap from reading code; this scenario is that same gap, reproduced
   * against real art instead of derived from reading source.
   *
   * FIVE LIGHTS, so the failure is attributable rather than a blanket
   * "nothing works" (which would prove nothing β€” see `the-authors-three-
   * lights` above for the identical discipline):
   *   ROOF_OPAQUE_UNCONFIGURED β€” Middle floor, elevation 0 (never touched),
   *     centred under a REAL opaque patch of Roof's plain background.
   *     **EXPECTED TO FAIL under today's code.**
   *   ROOF_OPAQUE_CONFIGURED β€” the SAME world position, elevation explicitly
   *     authored (middle.bottom + 5). The ordinary floor-index-dominant rank
   *     comparison (round 3's fix) already handles this correctly TODAY β€” a
   *     control proving the cross-floor mechanism itself works; only the
   *     SENTINEL path is broken.
   *   MIDDLE_OVERHEAD_UNCONFIGURED β€” Middle floor, elevation 0, centred under
   *     a REAL opaque patch of Middle's OWN `_Overhead` (same-floor roof).
   *     The overhead bit fires for same-floor foreground content regardless
   *     of numeric authoring (round 8's fix) β€” a control proving THAT
   *     mechanism still works; the bug is specifically the CROSS-floor +
   *     unconfigured combination.
   *   TOP_FLOOR_CONTROL β€” the Roof floor's OWN band (elevation 45), anywhere.
   *     Nothing exists above the topmost floor in a 3-floor map BY
   *     CONSTRUCTION, so this must stay lit under every version of this
   *     code, with no dependency on any alpha scan succeeding β€” the one
   *     control guaranteed to run even if the real art turns out to have no
   *     genuine alpha holes anywhere (plausible for a full background image;
   *     `_Outdoors` masks, not alpha, are this project's real indoor/outdoor
   *     signal β€” see the fixture's own `BLACK_MEANS_INDOORS` ruling).
   *   OPEN_SKY_UNCONFIGURED β€” Middle floor, elevation 0, centred where the
   *     Middle floor's OWN ground is real (`middleBg` opaque) AND both Roof's
   *     background and Middle's own overhead are transparent. Best-effort:
   *     `findRealArtRegion` may legitimately find nothing (see
   *     TOP_FLOOR_CONTROL's own note) β€” its checks are skipped, not failed,
   *     if so.
   *
   * All four SCANNED world positions are FOUND, not guessed β€” a scan of the
   * REAL decoded alpha of the relevant layer(s), the same "measure the
   * producer, never invent its shape" discipline `fixtures/tower-bridge.js`
   * itself already enforces for mask content. A scan that finds nothing
   * reports UNMEASURED (`evaluate`'s own contract), never a fabricated
   * coordinate.
   */
  scenarios.set('real-map-reproduces-the-live-bug', {
    name: 'real-map-reproduces-the-live-bug',
    summary:
      'STAGE 0 (docs/planning/Depth-Buffer.md): the REAL tower-bridge map, real _Overhead layers, real ' +
      'encoder, real gate. Must FAIL today β€” an unconfigured light under an ordinary upper-floor background ' +
      'is not occluded by anything.',
    async run(ctx) {
      await ensureRenderer();
      const checks = [];
      let calibration = 'OK';
      let rm;
      try {
        rm = await ensureRealMapAssets();
      } catch (err) {
        return {
          checks: [check({ id: 'real-map-assets-loaded', status: 'UNMEASURED', note: String(err?.message ?? err) })],
          calibration: 'FAILED',
          artifacts: [],
          inputs: {},
          stats: {},
        };
      }

      if (!rm.solidRoof || !rm.middleOverheadSolid) {
        checks.push(
          check({
            id: 'the-required-test-points-were-found-in-the-real-art',
            status: 'UNMEASURED',
            note:
              `solidRoof=${!!rm.solidRoof} middleOverheadSolid=${!!rm.middleOverheadSolid} ` +
              `openSky=${!!rm.openSky} calibPoint=${!!rm.calibPoint}`,
          })
        );
      }

      const attrBytes = await renderRealAttr();
      try {
        calibrateRealOrientation(attrBytes);
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'calibration', status: 'UNMEASURED', note: String(err?.message ?? err) }));
      }

      // --- the ENCODER, before anything reading it is judged β€” separates an
      // encoder regression from a gate regression, same discipline scenario 6
      // already established (`attrOverheadBitUnderCover`).
      if (rm.solidRoof) {
        checks.push(
          evaluate('attr-solid-roof-point-reads-floor-2', () => {
            const s = sampleRealAt(attrBytes, rm.solidRoof.x, rm.solidRoof.y);
            return {
              ok: s.r === 2,
              measured: s.r,
              expected: 2,
              note: 'sanity: the scanned "opaque roof" point must actually encode as the roof floor',
            };
          })
        );
        checks.push(
          evaluate('attr-solid-roof-point-has-NO-overhead-bit', () => {
            const s = sampleRealAt(attrBytes, rm.solidRoof.x, rm.solidRoof.y);
            return {
              ok: decodeOverheadBit(s.b) === 0,
              measured: decodeOverheadBit(s.b),
              expected: 0,
              note: "an ordinary Level BACKGROUND is never `isInForeground` β€” confirms WHY the overhead bit can't save this case",
            };
          })
        );
      }
      if (rm.middleOverheadSolid) {
        checks.push(
          evaluate('attr-middle-overhead-point-HAS-the-overhead-bit', () => {
            const s = sampleRealAt(attrBytes, rm.middleOverheadSolid.x, rm.middleOverheadSolid.y);
            return {
              ok: decodeOverheadBit(s.b) === 1,
              measured: decodeOverheadBit(s.b),
              expected: 1,
              note: "Middle's own `_Overhead` sits at its floor's own top β€” isInForeground fires automatically",
            };
          })
        );
      }

      // --- THE FIVE LIGHTS -----------------------------------------------
      const middleBand = FIXTURE.floors.find((f) => f.id === 'middle').elevation;
      const roofBand = FIXTURE.floors.find((f) => f.id === 'roof').elevation;
      const lights = [];
      if (rm.solidRoof) {
        lights.push({ id: 'ROOF_OPAQUE_UNCONFIGURED', x: rm.solidRoof.x, y: rm.solidRoof.y, radius: 300, elevation: 0 });
        lights.push({
          id: 'ROOF_OPAQUE_CONFIGURED',
          x: rm.solidRoof.x,
          y: rm.solidRoof.y,
          radius: 300,
          elevation: middleBand.bottom + 5,
        });
        // Nothing exists above the topmost floor in this 3-floor map BY
        // CONSTRUCTION β€” placed at the SAME (x,y) as the failing case purely
        // so it shares a frame with it; its own elevation, not its position,
        // is what makes it a control.
        lights.push({
          id: 'TOP_FLOOR_CONTROL',
          x: rm.solidRoof.x,
          y: rm.solidRoof.y,
          radius: 300,
          elevation: roofBand.bottom + 5,
        });
      }
      if (rm.middleOverheadSolid) {
        lights.push({
          id: 'MIDDLE_OVERHEAD_UNCONFIGURED',
          x: rm.middleOverheadSolid.x,
          y: rm.middleOverheadSolid.y,
          radius: 300,
          elevation: 0,
        });
      }
      if (rm.openSky) {
        lights.push({ id: 'OPEN_SKY_UNCONFIGURED', x: rm.openSky.x, y: rm.openSky.y, radius: 300, elevation: 0 });
      }

      // ⚠️ EACH LIGHT IS RENDERED IN ISOLATION, one at a time β€” NOT all five
      // together. `ROOF_OPAQUE_UNCONFIGURED`/`ROOF_OPAQUE_CONFIGURED`/
      // `TOP_FLOOR_CONTROL` deliberately share the SAME (x,y) (the whole
      // point is to compare their DIFFERENT elevations at the SAME receiver),
      // and the illumination material MAX-blends: sampling a shared pixel
      // from a combined render reports the BRIGHTEST of every overlapping
      // light there, so one light's bug (fully bright, unoccluded) silently
      // drowns out a co-located sibling's own, DIFFERENT, correct answer at
      // that exact texel. First run of this scenario combined all five and
      // reported `ROOF_OPAQUE_CONFIGURED` as bright/unoccluded even though
      // its own arithmetic (rank 1.15625 vs receiver rank 2.0, comfortably
      // past the fade band) says it must be dark β€” it wasn't wrong, it was
      // being read through its own unoccluded sibling's glow. A combined
      // render is still built afterward, purely for the human-facing
      // artifact, where overlap is expected and fine to SEE β€” just never to
      // sample a numeric check from.
      const byId = {};
      let ambientByte = 60;
      const built = [];
      for (const light of lights) {
        const solo = await renderRealIllum({ lights: [light] });
        ambientByte = solo.ambientByte;
        built.push(...solo.built);
        byId[light.id] = sampleRealAt(solo.bytes, light.x, light.y).r;
      }
      const combined = await renderRealIllum({ lights });
      const bytes = combined.bytes;

      // *** THE HEADLINE CHECK β€” THIS ONE MUST FAIL TODAY ***
      if (rm.solidRoof) {
        checks.push(
          evaluate('THE-LIVE-BUG-unconfigured-light-under-real-roof-is-NOT-occluded', () => {
            const v = byId.ROOF_OPAQUE_UNCONFIGURED;
            return {
              ok: v <= ambientByte + 8,
              measured: { value: v, ambientByte },
              expected:
                `<= ${ambientByte + 8} (occluded) β€” TODAY this reads BRIGHT: neither the sentinel-blocked fine ` +
                'gate nor the (unset) overhead bit can stop it. This is symptom 1, on the real map.',
            };
          })
        );
        checks.push(
          evaluate('control-configured-elevation-IS-occluded-at-the-SAME-point', () => {
            const v = byId.ROOF_OPAQUE_CONFIGURED;
            return {
              ok: v <= ambientByte + 8,
              measured: { value: v, ambientByte },
              expected: `<= ${ambientByte + 8} β€” the ordinary cross-floor rank comparison already works once elevation is authored`,
            };
          })
        );
        checks.push(
          evaluate('control-a-light-on-the-top-floor-is-never-occluded', () => {
            const v = byId.TOP_FLOOR_CONTROL;
            return {
              ok: v > ambientByte + 20,
              measured: { value: v, ambientByte },
              expected: `> ${ambientByte + 20} β€” nothing exists above the topmost floor in this map, ever`,
            };
          })
        );
      }
      if (rm.middleOverheadSolid) {
        checks.push(
          evaluate('control-same-floor-overhead-occludes-even-unconfigured', () => {
            const v = byId.MIDDLE_OVERHEAD_UNCONFIGURED;
            return {
              ok: v <= ambientByte + 8,
              measured: { value: v, ambientByte },
              expected: `<= ${ambientByte + 8} β€” round 8's overhead-bit fix already handles THIS case`,
            };
          })
        );
      }
      if (rm.openSky) {
        checks.push(
          evaluate('control-open-sky-stays-lit', () => {
            const v = byId.OPEN_SKY_UNCONFIGURED;
            return {
              ok: v > ambientByte + 20,
              measured: { value: v, ambientByte },
              expected: `> ${ambientByte + 20} β€” nothing genuinely overhead here, under any version of the gate`,
            };
          })
        );
      }

      const artifacts = [];
      const canvas = document.createElement('canvas');
      canvas.width = rm.realDimW;
      canvas.height = rm.realDimH;
      const ctx2d = canvas.getContext('2d');
      const paintLabel = (label) => {
        ctx2d.fillStyle = 'white';
        ctx2d.font = '14px monospace';
        ctx2d.fillText(label, 8, 20);
      };
      // THE ILLUM BUFFER paints AS-IS β€” its raw RGBA bytes ARE the rendered
      // scene's own colour, so there is nothing to remap; AGENTS.md Β§4's
      // "look at the picture" applies directly here.
      const paintIllum = (bytesToPaint, label) => {
        const img = ctx2d.createImageData(rm.realDimW, rm.realDimH);
        img.data.set(bytesToPaint);
        ctx2d.putImageData(img, 0, 0);
        paintLabel(label);
      };
      // ⚠️ THE ATTR BUFFER NEEDS REMAPPING TO BE READABLE AT ALL β€” its raw
      // bytes are NOT meant as a colour: R is a floor index (0/1/2, i.e.
      // pitch-black on a 0-255 scale), and this scenario's own `packFloorAttr`
      // call hardcodes G (outdoors) to a constant 255 everywhere something is
      // drawn. Painted with `img.data.set(...)` directly (this scenario's own
      // first attempt) the result is a near-uniform saturated green field β€”
      // technically correct data, completely illegible as a picture. Three
      // distinct grey bands per floor index, plus BLUE for "nothing drawn
      // here at all" (alpha=0), makes the actual floor structure visible at a
      // glance β€” which is what caught this scenario's OWN worst bug (the
      // whole buffer silently reading 100% floor 2) in about ten seconds,
      // versus the several rounds of arithmetic that found nothing.
      const paintAttr = (bytesToPaint, label) => {
        const img = ctx2d.createImageData(rm.realDimW, rm.realDimH);
        for (let i = 0; i < rm.realDimW * rm.realDimH; i++) {
          const r = bytesToPaint[i * 4];
          const a = bytesToPaint[i * 4 + 3];
          const grey = r === 0 ? 60 : r === 1 ? 150 : 250;
          img.data[i * 4] = a > 0 ? grey : 0;
          img.data[i * 4 + 1] = a > 0 ? grey : 0;
          img.data[i * 4 + 2] = a > 0 ? grey : 255;
          img.data[i * 4 + 3] = 255;
        }
        ctx2d.putImageData(img, 0, 0);
        paintLabel(label);
      };
      paintAttr(attrBytes, 'real map: buf:scene.attr β€” grey = floor 0/1/2 (dark→light), BLUE = nothing drawn');
      const a1 = await saveCanvasPng(ctx.runId, 'real-map-attr.png', canvas);
      if (a1) artifacts.push(a1);
      paintIllum(bytes, 'real map: illum, five test lights (combined β€” see checks for isolated per-light values)');
      const a2 = await saveCanvasPng(ctx.runId, 'real-map-illum.png', canvas);
      if (a2) artifacts.push(a2);

      return {
        checks,
        calibration,
        artifacts,
        inputs: {
          scale: rm.scale,
          worldRect: FIXTURE.worldRect,
          dim: { w: rm.realDimW, h: rm.realDimH },
          lights,
          testPoints: { solidRoof: rm.solidRoof, openSky: rm.openSky, middleOverheadSolid: rm.middleOverheadSolid },
          orientation: realOrientation,
        },
        stats: { ambientByte, ranks: built, byId },
      };
    },
  });

  const bench = {
    name: 'floor-lighting',
    title: 'Multi-floor point-light occlusion',
    rung: 3,
    summary:
      'A real three-floor building of primitives, a real buf:scene.attr from the production encoder, and the ' +
      'real point-light material MAX-blended on a real device. Answers "does the height gate read the ' +
      'fragment´s own attr texel" — which three rounds of arithmetic-only debugging never asked.',
    scenarios,
    checkIds: [
      'attr-floor0-ground-everywhere',
      'attr-floor2-slab-inside-hole-outside',
      'attr-receiver-elevation-subfield-is-written',
      'sealed-ground-light-is-occluded-when-viewed-from-above',
      'the-frame-changes-at-all-between-floors',
      'outside-light-visible-from-every-floor',
      'sealed-light-lights-its-own-floor-only',
      'first-floor-light-spills-OUTSIDE-and-stays-visible-from-above',
      'the-same-light-IS-occluded-where-the-slab-covers-it',
      'coloration-responds-to-the-attr-buffer-at-all',
      'sealed-light-coloration-is-gone-from-above',
      'outside-light-coloration-survives-every-floor',
      'coloration-is-cut-by-the-slab-edge-in-ONE-frame',
      'candle-flame-responds-to-the-attr-buffer-at-all',
      'sealed-candle-flame-is-gone-from-above',
      'lightning-bolt-responds-to-the-attr-buffer-at-all',
      'sealed-lightning-bolt-is-gone-from-above',
      'roof-is-visually-faded-to-near-invisible',
      'attr-solidity-stays-full-DESPITE-the-visual-fade',
      'attr-overhead-bit-is-encoded-correctly-for-each-cover',
      'level-foreground-cover-occludes-the-unconfigured-light',
      'deliberately-raised-tile-cover-occludes-the-unconfigured-light',
      'ordinary-unraised-tile-does-NOT-occlude-the-same-light',
      'the-light-still-reaches-normally-just-outside-every-cover',
      'attr-solid-roof-point-reads-floor-2',
      'attr-solid-roof-point-has-NO-overhead-bit',
      'attr-middle-overhead-point-HAS-the-overhead-bit',
      'THE-LIVE-BUG-unconfigured-light-under-real-roof-is-NOT-occluded',
      'control-configured-elevation-IS-occluded-at-the-SAME-point',
      'control-a-light-on-the-top-floor-is-never-occluded',
      'control-same-floor-overhead-occludes-even-unconfigured',
      'control-open-sky-stays-lit',
    ],
    ready: () => true,
    async runScenario(scenario, ctx) {
      return scenario.run(ctx);
    },
  };

  registerBench(bench);
  return bench;
}
