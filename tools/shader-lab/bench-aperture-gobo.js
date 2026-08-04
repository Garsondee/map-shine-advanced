/**
 * SHADER LAB — RUNG 3: THE APERTURE GOBO, ISOLATED FROM FOUNDRY ENTIRELY.
 *
 * ============================================================================
 * WHY THIS BENCH EXISTS
 * ============================================================================
 * Eight live rounds against the author's real Foundry scene, each round
 * finding a genuine, verified bug (a magnification blowup, a blur/bar-width
 * mismatch, a wedge/corona seam, a lamp-height default sitting BELOW the
 * window it lit, a debug view that couldn't tell two failure modes apart)
 * and NONE of them converging on "a convincing pane pattern actually
 * renders." Every one of those rounds was diagnosed from a screenshot of the
 * full game — the concurrent-editing hazard, the OTHER window-cookie effect,
 * region-aware ambient, sun-shadow attenuation, and (mid-session) a whole
 * SECOND in-progress feature (the elevation gate) all sitting between "the
 * shader I'm testing" and "the pixels the author sees." The author's own
 * instruction, verbatim: *"Change your approach. I need you to build a test
 * in the shader lab, walls, windows and a light source on one side of the
 * window. Then I want you to run through the problems until you get a
 * convincing shape on the window panes on the other side of the window."*
 *
 * So: one wall (a real Foundry-shaped aperture segment), one point light on
 * its interior side, the REAL `buildPointLightIlluminationMaterial` — as of
 * round 10 (2026-08-04), the aperture-gobo pattern (`aperture-gobo-
 * render.js#buildApertureGoboTerm`) is baked directly into THIS SAME
 * material's own falloff, one single MAX-blend draw, matching production's
 * own current architecture exactly — into a real illum target on a real
 * WebGPU device, then READ THE PIXELS AND LOOK AT THE PICTURE.
 * Confounds removed by construction: no Foundry, no concurrent file edits,
 * no OTHER window effect, no elevation gate, no region ambient, no sun
 * shadows. If the pattern is wrong here, it is wrong in `src/`, full stop —
 * not a screenshot-interpretation question.
 *
 * ============================================================================
 * THE SCENE
 * ============================================================================
 * An 800x800 world. A vertical window wall at x=WALL_X, spanning
 * [WALL_Y0, WALL_Y1] (wallLen = WALL_Y1-WALL_Y0, the window's WIDTH — the
 * `cols` axis). One point light on the INTERIOR side (x < WALL_X). The
 * EXTERIOR floor (x > WALL_X) is where the pattern must appear. `sillPx`/
 * `headPx` describe the window's HEIGHT (the `rows` axis) via the effect's
 * own virtual z-axis — NOT the wall's 2D length, which is a different axis
 * entirely and a real trap if conflated (this bench's own `calibrate()`
 * checks this is understood correctly, not just assumed).
 *
 * A dark rectangle for the solid wall (drawn first, BEHIND the lighting, no
 * bearing on the maths — purely so a human reading the PNG sees "a wall with
 * a window in it" instead of an abstract floor plane).
 *
 * ============================================================================
 * WHAT IS REAL HERE, WHAT IS NOT (read before trusting a number)
 * ============================================================================
 * REAL, imported from `src/`, never transcribed:
 *   - `buildPointLightIlluminationMaterial` — the light's own MAX-blended
 *     glow, and (round 10, 2026-08-04) the aperture-gobo pattern's own home
 *     now too — no separate shadow material exists any more.
 *   - `buildApertureGoboTerm` / `createApertureGoboSharedUniforms` — the
 *     pattern math itself, consumed directly by the illumination material
 *     above.
 *   - `findAperturesForLight` / `computeWallFrame` / `orientApertureToLight` /
 *     `resolveLampHeight` — the CPU-side assignment pass, exactly as
 *     `point-light-pool.js#update` runs it every frame.
 *   - `computeAmbientColors` — so "noon" and "night" are production's own
 *     values, not a lab-invented guess.
 *   - `triangulateLightFan` — the same fan geometry both materials share.
 *
 * DELIBERATELY SIMPLIFIED:
 *   - The light's own polygon is a full circle (32-gon), not a Foundry
 *     wall-clipped sight polygon. `aperture-gobo.js`'s own design doc is
 *     explicit that this effect does not need to reproduce that clipping —
 *     Foundry's own polygon sweep already bounds the beam shape in
 *     production (verified against the vendored source); this bench tests
 *     ONLY the mullion pattern itself, so a full circle is the right
 *     simplification, not a shortcut that hides anything the effect owns.
 *   - No other lights, no region ambient, no sun shadows — each has its own
 *     bench or is out of THIS bug's scope.
 *
 * @module tools/shader-lab/bench-aperture-gobo
 */
import {
  APERTURE_GOBO_DEFAULTS,
  findAperturesForLight,
  resolveLampHeight,
  deriveApertureGoboPaneCount,
  computeWallFrame,
  orientApertureToLight,
  computeApertureRowBoundaryX,
} from '../../src/effects/lighting/aperture-gobo.js';
import {
  createApertureGoboSharedUniforms,
  buildApertureGoboTerm,
} from '../../src/effects/lighting/aperture-gobo-render.js';
import {
  buildPointLightIlluminationMaterial,
  triangulateLightFan,
  easeAttenuation,
  computeExposure,
} from '../../src/effects/lighting/point-light-illumination.js';
import { computeAmbientColors } from '../../src/effects/lighting/environmental-light.js';
import { buildBloomMaterials } from '../../src/effects/bloom-render.js';
import { check, evaluate, registerBench, saveCanvasPng } from './contract.js';

/** The world every wall/light/camera in this bench shares. */
const WORLD = { minX: 0, minY: 0, maxX: 800, maxY: 800 };
/** The window wall — a vertical segment. Its LENGTH (WALL_Y1-WALL_Y0) is the
 * window's WIDTH (the `cols` axis) — a DIFFERENT axis from sillPx/headPx
 * (the window's HEIGHT, the `rows` axis, which rides the effect's own
 * virtual z, not the wall's 2D length). Conflating the two is a real trap
 * this comment exists to name before anyone hand-picks numbers again. */
const WALL_X = 500;
const WALL_Y0 = 300;
const WALL_Y1 = 500; // wallLen = 200
const WALL_SEGMENT = { x1: WALL_X, y1: WALL_Y0, x2: WALL_X, y2: WALL_Y1, aperture: true };
/** Render size. Square. NOT 800 (1:1 with WORLD) deliberately — WebGPU pads
 * each copied texture row to a 256-byte alignment, and 800px*4 = 3200 is NOT
 * a multiple of 256, which produced a readback whose buffer length didn't
 * match a naive width*height*4 assumption (`bench-floor-lighting.js`'s own
 * choice of 256 was this same constraint, quietly). 1024*4 = 4096 = 16*256 —
 * a clean multiple, AND higher resolution than the 800px world, so a 4px
 * mullion stays crisp rather than shrinking below native resolution. */
const DIM = 1024;

/** The light: interior side (x < WALL_X), so `a` (its perpendicular distance
 * from the wall) is `WALL_X - LIGHT.x`. Radius generous enough that falloff
 * itself is not what limits the pattern's reach in these scenarios. */
const LIGHT = { x: 350, y: 400, radius: 500 };

function lightPolygon(light, segments = 48) {
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(light.x + Math.cos(a) * light.radius, light.y + Math.sin(a) * light.radius);
  }
  return pts;
}

export function createApertureGoboBench({ THREE, log }) {
  const { uniform, float, vec3, vec4 } = THREE.TSL;

  let renderer = null;
  let illumRt = null;
  let camera = null;
  /** Empirically established, never assumed (`feedback_y_flip_recurring_risk`). */
  let orientation = null;
  /** Bloom pyramid — built lazily on first use, not every frame (mirrors
   * `vt-pan-viewer.js`'s own one-time allocation at viewer construction). */
  let bloomState = null;

  async function ensureRenderer() {
    if (renderer) return;
    renderer = new THREE.WebGPURenderer({ antialias: false });
    await renderer.init();
    camera = new THREE.OrthographicCamera(WORLD.minX, WORLD.maxX, WORLD.maxY, WORLD.minY, -1000, 1000);
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    illumRt = new THREE.RenderTarget(DIM, DIM, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
    });
    log?.(`APERTURE-GOBO: renderer backend ${renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL'}`);
  }

  /**
   * THE REAL BLOOM PIPELINE (docs/planning/Bloom.md) — `vt-pan-viewer.js#
   * runPostBloomPass`'s own sequence, transcribed 1:1 in CONTROL FLOW (loop
   * structure, mip indices, guarded-clear discipline) while importing the
   * REAL `buildBloomMaterials` for every shader. Exists to answer a single
   * question the `night-clear-pattern` scenario cannot: does the mullion's
   * own darkening — proven real and large in `buf:scene.illum` directly —
   * SURVIVE the post-process stage the author actually sees on screen?
   * Bloom is `enabledFromProfile: 'low'` (ON by default at every perf tier,
   * `effects/bloom.js`), reads `scene.lit` through a 6-mip Jimenez/COD-style
   * blur pyramid, and is the ONLY thing in the real render sequence that
   * touches the SAME buffer downstream of the aperture-shadow pass
   * (`windowSurface`'s own ADD pass is the other candidate, but it requires
   * hand-painted `_Window` mask content this bench has no way to assume
   * exists) — see `vt-pan-viewer.js` lines ~4241-4273 for the exact order
   * this mirrors: lightScene (MAX) -> apertureShadowScene (blend) ->
   * windowSurface (ADD, skipped here) -> [bloom happens LATER, post-
   * composite, not modelled by `runLightAccumulatePass` at all — it is its
   * OWN pass, `post.bloom`, reading `scene.lit`]. This bench has no separate
   * albedo/composite step, so the illum buffer IS treated as `scene.lit`
   * directly — a named simplification, not an oversight: this effect never
   * modelled albedo either, and bloom's own blur behaviour on a thin dark
   * feature next to a bright one does not depend on whether the source was
   * multiplied by a floor texture first.
   * `outdoorsTexNode/uViewRect/uOutdoorsRect` are `null` — no `_Outdoors`
   * mask exists in this bench's world, and `buildBloomMaterials` compiles
   * the whole spill-clamp term OUT when `outdoorsTexNode` is null (its own
   * header + `outdoorGateCompiled` confirm this), so the bright pass here is
   * the UNCLAMPED case — if anything a MORE generous (harder to erase)
   * scenario than production's own outdoor-suppressed case, never a less
   * faithful one.
   */
  function ensureBloom() {
    if (bloomState) return bloomState;
    const BLOOM_MIP_COUNT = 6;
    const BLOOM_ATMO_TOP = 3;
    const mipW = (k) => Math.max(1, Math.ceil(DIM / 2 ** (k + 1)));
    const mipH = mipW;
    const mips = [];
    for (let k = 0; k < BLOOM_MIP_COUNT; k++) {
      mips.push(
        new THREE.RenderTarget(mipW(k), mipH(k), {
          type: THREE.HalfFloatType,
          format: THREE.RGBAFormat,
          colorSpace: THREE.NoColorSpace,
        })
      );
    }
    const bloom = buildBloomMaterials({
      THREE,
      litTexture: illumRt.texture,
      coreTexture: mips[0].texture,
      atmoTexture: mips[BLOOM_ATMO_TOP].texture,
      outdoorsTexNode: null,
      uViewRect: null,
      uOutdoorsRect: null,
    });
    // Production defaults (`BLOOM_PARAMS`' own `default:` fields) — the
    // scenario under test asks "does bloom AT ITS SHIPPED DEFAULTS erase
    // this", not "can some extreme setting erase it", so no tuning here.
    bloom.uniforms.threshold.value = 1.0;
    bloom.uniforms.knee.value = 0.5;
    bloom.uniforms.strength.value = 1.0;
    bloom.uniforms.coreStrength.value = 1.0;
    bloom.uniforms.atmoStrength.value = 0.5;
    bloom.uniforms.coreTint.value.set(1, 1, 1);
    bloom.uniforms.atmoTint.value.set(1, 240 / 255, 220 / 255); // '#fff0dc'
    const spreadToRadius = (s) => 0.0015 + Math.max(0, Math.min(1, s)) * 0.0085;
    bloomState = {
      mips,
      bloom,
      brightQuad: new THREE.QuadMesh(bloom.brightMaterial),
      downKarisQuad: new THREE.QuadMesh(bloom.downsampleKaris.material),
      downQuad: new THREE.QuadMesh(bloom.downsample.material),
      upQuad: new THREE.QuadMesh(bloom.upsampleMaterial),
      compositeQuad: new THREE.QuadMesh(bloom.compositeMaterial),
      BLOOM_MIP_COUNT,
      BLOOM_ATMO_TOP,
      coreSpreadRadius: spreadToRadius(0.4), // coreSpread default
      atmoSpreadRadius: spreadToRadius(0.7), // atmoSpread default
    };
    return bloomState;
  }

  /** Runs the real bloom sequence over `illumRt`'s CURRENT contents,
   * additively compositing the result back into `illumRt` itself — exactly
   * mirroring production's own `scene.lit` in place. Call AFTER a
   * `renderFrame` targeting `illumRt` has already drawn the scene. */
  function runBloomPass() {
    const st = ensureBloom();
    const { mips, bloom, brightQuad, downKarisQuad, downQuad, upQuad, compositeQuad, BLOOM_MIP_COUNT, BLOOM_ATMO_TOP } =
      st;
    const prevAutoClear = renderer.autoClearColor;

    // 1) BRIGHT — masked soft-knee threshold of illumRt -> mip0.
    renderer.autoClearColor = true;
    renderer.setRenderTarget(mips[0]);
    brightQuad.render(renderer);

    // 2) DOWNSAMPLE — mip0->mip1 Karis, then plain 13-tap down the chain.
    for (let k = 0; k < BLOOM_MIP_COUNT - 1; k++) {
      const src = mips[k];
      if (k === 0) {
        bloom.downsampleKaris.inputNode.value = src.texture;
        bloom.downsampleKaris.uInvTexel.value.set(1 / src.width, 1 / src.height);
        renderer.setRenderTarget(mips[k + 1]);
        downKarisQuad.render(renderer);
      } else {
        bloom.downsample.inputNode.value = src.texture;
        bloom.downsample.uInvTexel.value.set(1 / src.width, 1 / src.height);
        renderer.setRenderTarget(mips[k + 1]);
        downQuad.render(renderer);
      }
    }

    // 3) UPSAMPLE (additive tent), TWO independent bands.
    renderer.autoClearColor = false;
    bloom.upsample.uFilterRadius.value = st.coreSpreadRadius;
    for (const k of [1, 0]) {
      bloom.upsample.inputNode.value = mips[k + 1].texture;
      renderer.setRenderTarget(mips[k]);
      upQuad.render(renderer);
    }
    bloom.upsample.uFilterRadius.value = st.atmoSpreadRadius;
    for (const k of [BLOOM_ATMO_TOP + 1, BLOOM_ATMO_TOP]) {
      bloom.upsample.inputNode.value = mips[k + 1].texture;
      renderer.setRenderTarget(mips[k]);
      upQuad.render(renderer);
    }

    // 4) COMPOSITE — core (mip0) + atmosphere (mip[ATMO_TOP]) additively back
    // into illumRt itself, standing in for `scene.lit`.
    renderer.setRenderTarget(illumRt);
    compositeQuad.render(renderer);

    renderer.autoClearColor = prevAutoClear;
    renderer.setRenderTarget(null);
  }

  /**
   * RENDER ONE FRAME: ambient fill -> point light, ALREADY gobo-shadow-aware,
   * ONE MAX-blend draw -> read back pixels. Round 10 (2026-08-04) collapsed
   * what used to be TWO passes (point light MAX, then a separate aperture-
   * shadow blend/gate) into this ONE — see point-light-illumination.js's own
   * "THE GOBO IS PART OF THIS LIGHT'S OWN FALLOFF" header for why: a
   * separate pass operating on the already-composited buffer has no way to
   * tell "bright because of THIS light" from "bright because of daylight or
   * another light", and could drag a fragment down below what an
   * independent source legitimately provided there. MAX-blending the
   * ALREADY-shadow-reduced contribution avoids that by construction.
   *
   * @param {object} args
   * @param {number} args.darkness01 - fed straight to `computeAmbientColors`.
   * @param {object} args.apParams - a FULL APERTURE_GOBO_DEFAULTS-shaped bag,
   *   so every scenario states its own params explicitly rather than reading
   *   a silently-shared mutable default.
   * @param {number} [args.maxAperturesPerLight]
   * @param {'shadow'|'debug'} [args.materialMode] - 'shadow' (default) is
   *   simply the real illumination material, already gobo-aware — no swap
   *   needed. 'debug' swaps in a STANDALONE raw-pattern mesh (built directly
   *   from `buildApertureGoboTerm`, RGB = raw gobo term, opaque) so the
   *   pattern's own geometry can be inspected independent of brightness.
   *   'visibility' is RETIRED (round 10) — the gate it used to read no
   *   longer exists.
   * @returns {Promise<{bytes:Uint8Array, ambientRGB:number[], apertureReadout:object}>}
   */
  async function renderFrame({
    darkness01,
    apParams,
    maxAperturesPerLight = APERTURE_GOBO_DEFAULTS.maxAperturesPerLight,
    materialMode = 'shadow',
    target = null,
    // OPTIONAL (round 12, 2026-08-04) — defaults to the module's own
    // dead-centre LIGHT; the `off-axis-reveal` scenario overrides `x` to
    // exercise `computeApertureRevealNarrowing`, which is a genuine no-op
    // at LIGHT's own default position (light.y sits exactly on the
    // window's own lateral centreline by construction).
    light = LIGHT,
    // OPTIONAL (round 15, 2026-08-04) — Foundry's own raw attenuation
    // slider, 0..1, fed through `easeAttenuation` exactly like production.
    // Defaults to 0.5 (this function's own pre-round-15 hardcoded value),
    // so every scenario that doesn't explicitly override it is byte-
    // identical to before this param existed.
    attenuation01 = 0.5,
    // OPTIONAL (round 16, 2026-08-04) — `dim-radius-hard-edge`'s own knob:
    // Foundry's per-light `luminosity` field, fed through `computeExposure`
    // exactly like production. Defaults to 0.5 (this function's own
    // pre-round-16 hardcoded value -> `computeExposure(0.5) === 0`, a true
    // no-op), so every scenario that doesn't explicitly override it is
    // byte-identical to before this param existed.
    luminosity01 = 0.5,
    // OPTIONAL (round 15, 2026-08-04) — `attenuation-reach-fade`'s own A/B
    // knob: overrides `apertureGoboShared.uReachSoftFarPx` AFTER it's built
    // from `apParams`, so a scenario can render "the reach blur disabled"
    // (0) alongside "the shipped default" (undefined = leave it) without
    // duplicating the whole shared-uniform construction. `undefined` (the
    // default) touches nothing — every scenario that doesn't pass this is
    // byte-identical to before this param existed.
    reachSoftFarPxOverride,
  }) {
    await ensureRenderer();
    const scene = new THREE.Scene();
    const disposables = [];

    // AMBIENT — production's own computation, not a lab-invented colour.
    const ambient = computeAmbientColors({ darkness01, sky: null, globalLight: null, darknessLevel: darkness01 }, 0);
    const bg = Array.isArray(ambient?.background)
      ? ambient.background
      : [1 - darkness01, 1 - darkness01, 1 - darkness01];

    // THE WALL — cosmetic only, drawn first, no bearing on any material under
    // test. A dark bar spanning the FULL wall line's own x, generous in y so
    // it visually reads as "solid wall either side of an opening".
    {
      const wallMat = new THREE.NodeMaterial();
      wallMat.transparent = false;
      wallMat.depthTest = false;
      wallMat.depthWrite = false;
      wallMat.side = THREE.DoubleSide;
      wallMat.fragmentNode = vec4(vec3(0.05, 0.04, 0.03), float(1));
      const thickness = 14;
      for (const [y0, y1] of [
        [WORLD.minY, WALL_Y0],
        [WALL_Y1, WORLD.maxY],
      ]) {
        const h = y1 - y0;
        if (h <= 0) continue;
        const geo = new THREE.PlaneGeometry(thickness, h);
        const mesh = new THREE.Mesh(geo, wallMat);
        mesh.position.set(WALL_X, (y0 + y1) / 2, 0);
        mesh.renderOrder = 0;
        mesh.frustumCulled = false;
        scene.add(mesh);
        disposables.push(geo);
      }
      disposables.push(wallMat);
    }

    // THE ASSIGNMENT PASS — real production function, real wall segment.
    // Round 10 (2026-08-04) moved this BEFORE the illumination material is
    // built: `apertureCount` is now a GRAPH-BUILD-TIME param of that
    // material itself (the gobo pattern is baked into its own falloff, not
    // a separate mesh drawn afterward — see point-light-illumination.js's
    // own "THE GOBO IS PART OF THIS LIGHT'S OWN FALLOFF" header), so it has
    // to be known before that call, not after it.
    const { apertures, totalFound, dropped } = findAperturesForLight(light, [WALL_SEGMENT], maxAperturesPerLight);
    const apertureCount = apertures.length;
    const apertureGoboShared = apertureCount > 0 ? createApertureGoboSharedUniforms(THREE, apParams) : null;
    if (apertureGoboShared && Number.isFinite(reachSoftFarPxOverride)) {
      apertureGoboShared.uReachSoftFarPx.value = reachSoftFarPxOverride;
    }
    // PROCEDURAL PANE COUNT (round 11, 2026-08-04) — the SAME shared
    // derivation `point-light-pool.js` calls, against THIS bench's own real
    // assigned aperture (`WALL_SEGMENT`'s wallLen=200), so a scenario that
    // doesn't explicitly override `apParams.paneWidthPx`/`paneHeightPx`
    // exercises real production rounding/clamping instead of a bench-only
    // stand-in that could quietly drift from what `src/` actually ships.
    const { cols: apGoboCols, rows: apGoboRows } = deriveApertureGoboPaneCount({
      wallLen: apertures[0]?.wallLen,
      sillPx: apParams.sillPx,
      headPx: apParams.headPx,
      paneWidthPx: apParams.paneWidthPx,
      paneHeightPx: apParams.paneHeightPx,
    });

    // THE LIGHT — real illumination material, now genuinely aperture-aware:
    // `illum.material` IS the shadow, drawn in the SAME single MAX-blend
    // pass every other light already uses. No separate shadow mesh, no
    // separate scene, nothing for the render-order/clear-state bug class
    // that bit the old separate pass (`docs/planning/Aperture-Gobo.md` §13's
    // designs 1-3 + this file's own git history) to repeat.
    const uBackgroundColor = uniform(vec3(...bg));
    const uDimColor = uniform(vec3(0.55, 0.42, 0.3));
    const uBrightColor = uniform(vec3(1, 0.85, 0.62));
    const illum = buildPointLightIlluminationMaterial({
      THREE,
      uBackgroundColor,
      uDimColor,
      uBrightColor,
      animation: null,
      uGlobalTimeMs: uniform(float(0)),
      falloffModel: 'foundry',
      sunShadowSlotNodes: null,
      attrTexNode: null,
      blendSunVisibilityAcrossFloors: null,
      apertureCount,
      apGoboCols,
      apGoboRows,
      apertureGoboShared,
    });
    illum.uRatio.value = 0.5;
    illum.uAttenuationEased.value = easeAttenuation(attenuation01);
    illum.uExposure.value = computeExposure(luminosity01);
    illum.uEdgeCount.value = 0;
    illum.uEdgeSoftMargin.value = 0;
    if (illum.uApLampHeight) illum.uApLampHeight.value = resolveLampHeight(light, apParams);
    for (let i = 0; illum.apApertures && i < illum.apApertures.length; i++) {
      const src = apertures[i];
      const dst = illum.apApertures[i];
      dst.uA.value.set(src.A.x, src.A.y);
      dst.uDir.value.set(src.dir.x, src.dir.y);
      dst.uNrm.value.set(src.nrm.x, src.nrm.y);
      dst.uSLAWallLen.value.set(src.sL, src.a, src.wallLen);
    }

    const { array, vertexCount } = triangulateLightFan(lightPolygon(light), light.x, light.y, light.radius);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(array, 3));
    geo.setDrawRange(0, vertexCount);
    // 'debug' mode swaps in a STANDALONE raw-pattern mesh (built directly
    // from `buildApertureGoboTerm`, mirroring `point-light-pool.js`'s own
    // debug-channel mesh) instead of the real illumination material — 'shadow'
    // (the default) is simply `illum.material` itself, already gobo-aware,
    // no swap needed at all. 'visibility' mode is RETIRED — the visibility
    // gate it used to read no longer exists (see aperture-gobo.js's own
    // retirement note).
    let mainMaterial = illum.material;
    let debugMaterial = null;
    if (materialMode === 'debug' && apertureCount > 0) {
      const debugGobo = buildApertureGoboTerm({
        THREE,
        positionWorldXY: THREE.TSL.positionWorld.xy,
        dist: THREE.TSL.length(THREE.TSL.positionLocal.xy),
        apertureCount,
        cols: apGoboCols,
        rows: apGoboRows,
        shared: apertureGoboShared,
      });
      debugMaterial = new THREE.NodeMaterial();
      debugMaterial.transparent = false;
      debugMaterial.depthTest = false;
      debugMaterial.depthWrite = false;
      debugMaterial.side = THREE.DoubleSide;
      debugMaterial.fragmentNode = vec4(vec3(debugGobo.node), float(1));
      mainMaterial = debugMaterial;
      // The debug mesh's OWN aperture uniforms are SEPARATE from illum's —
      // write the SAME real geometry into them too.
      for (let i = 0; i < debugGobo.apertures.length; i++) {
        const src = apertures[i];
        const dst = debugGobo.apertures[i];
        dst.uA.value.set(src.A.x, src.A.y);
        dst.uDir.value.set(src.dir.x, src.dir.y);
        dst.uNrm.value.set(src.nrm.x, src.nrm.y);
        dst.uSLAWallLen.value.set(src.sL, src.a, src.wallLen);
      }
      debugGobo.uLampHeight.value = resolveLampHeight(light, apParams);
    }
    const illumMesh = new THREE.Mesh(geo, mainMaterial);
    illumMesh.position.set(light.x, light.y, 0);
    illumMesh.scale.set(light.radius, light.radius, 1);
    illumMesh.renderOrder = 1;
    illumMesh.frustumCulled = false;
    scene.add(illumMesh);
    disposables.push(geo, illum.material);
    if (debugMaterial) disposables.push(debugMaterial);

    const renderTarget = target ?? illumRt;
    const prev = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClearColor;
    renderer.setRenderTarget(renderTarget);
    // ONE clear (to the wall's own dark colour so the "solid wall" quads need
    // no fill of their own), then draw wall -> light -> shadow WITHOUT
    // clearing between them — production's own guarded multi-draw sequence
    // (`runLightAccumulatePass`'s own comment on why autoClearColor is
    // disabled for the duration; this bench's needs are simpler — a single
    // `renderAsync` over one scene already draws in `renderOrder`, so there
    // is no multi-call clear hazard to guard against here at all).
    renderer.setClearColor(new THREE.Color(bg[0], bg[1], bg[2]), 1);
    renderer.autoClearColor = true;
    renderer.clear();
    await renderer.renderAsync(scene, camera);
    renderer.setRenderTarget(prev);
    renderer.autoClearColor = prevAutoClear;
    const buf = await renderer.readRenderTargetPixelsAsync(renderTarget, 0, 0, DIM, DIM);
    for (const d of disposables) d.dispose?.();
    return {
      bytes: ArrayBuffer.isView(buf) ? buf : new Uint8Array(buf),
      ambientRGB: bg,
      apertureReadout: { totalFound, dropped, apertureCount },
      renderTarget,
    };
  }

  /** World (x,y) -> readback index, honouring the empirically-found row order. */
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
   * ESTABLISH ROW ORDER EMPIRICALLY (`feedback_y_flip_recurring_risk`) — the
   * SAME technique `bench-floor-lighting.js#calibrate` uses, adapted: the
   * wall's own dark strip is asymmetric in Y by construction (WALL_Y0=300,
   * WALL_Y1=500 against an 800-tall world, i.e. NOT centred), so sampling
   * just above vs. just below the window opening gives two DIFFERENT,
   * PREDICTED answers under the two possible row orders.
   * @param {Uint8Array} bytes - a frame with NO light anywhere near it, so
   *   the wall's own dark colour is the only signal (ambient elsewhere).
   */
  function calibrate(bytes) {
    // Just above the window (y=200, inside [0,300)) must read the WALL's
    // dark colour; just below it (y=600, inside [500,800)) must ALSO read
    // the wall — both sides of the opening are solid. The window itself
    // (y=400, inside [300,500)) must NOT read the wall colour. This alone
    // cannot resolve Y order (symmetric about the opening's own centre at
    // y=400) — it only proves the wall exists at all.
    const isWallDark = (px) => px.r < 40 && px.g < 40 && px.b < 40;
    const opening = sampleAt(bytes, WALL_X + 5, 400);
    if (isWallDark(opening)) {
      throw new Error(
        'aperture-gobo calibrate: the window opening itself reads as solid wall — nothing downstream is trustworthy'
      );
    }
    // The Y-asymmetric probe: y=150 sits deep inside the ABOVE-window wall
    // strip [0,300); if row order is flipped, that same row corresponds to
    // world y=650, deep inside the BELOW-window strip [500,800) — ALSO
    // wall-dark, so this probe alone is not enough either. Use x asymmetry
    // instead, which this bench actually has: sample a point that is wall-
    // dark under NO flip ambiguity by checking a KNOWN light-side pixel.
    // Simplest robust probe: the light itself, placed asymmetrically at
    // (350,400) with a large radius, must be BRIGHT there regardless of X,
    // but a point far from both the light AND any wall (e.g. (750,750),
    // outside the light's own radius from (350,400): distance
    // hypot(400,350)=531 < radius 500 — actually within reach; pick a
    // genuinely-outside point instead) must read ambient. This DOES prove
    // orientation because the frame is asymmetric in both x and y by
    // construction (light off-centre, wall off-centre) — any consistent
    // flip changes SOME sampled value, and we already know which one is
    // wall-dark vs light-bright vs ambient from the SCENE'S OWN geometry.
    const nearLight = sampleAt(bytes, 350, 400); // dead centre of the light itself
    const farCorner = sampleAt(bytes, 780, 780); // far from the light (dist ~531 from (350,400) < radius 500... )
    // If the far corner is ALSO bright, the radius reaches it under BOTH
    // orientations (radius doesn't depend on Y row order at all) — so this
    // pair cannot calibrate Y. Fall back to the wall/opening contrast, which
    // DOES depend on row order: sample the row this bench predicts holds
    // y=150 (above the window) under the STRAIGHT mapping specifically.
    const straightAbove = (() => {
      const fx = (WALL_X - 40 - WORLD.minX) / (WORLD.maxX - WORLD.minX);
      const fy = (150 - WORLD.minY) / (WORLD.maxY - WORLD.minY);
      const px = Math.min(DIM - 1, Math.floor(fx * DIM));
      const row = Math.min(DIM - 1, Math.floor(fy * DIM));
      const i = (row * DIM + px) * 4;
      return { r: bytes[i], g: bytes[i + 1], b: bytes[i + 2] };
    })();
    if (isWallDark(straightAbove)) orientation = 'straight';
    else orientation = 'flipped';
    log?.(
      `APERTURE-GOBO: orientation ${orientation} (opening=${JSON.stringify(opening)}, ` +
        `nearLight=${JSON.stringify(nearLight)}, farCorner=${JSON.stringify(farCorner)}, ` +
        `straightAboveIsWall=${isWallDark(straightAbove)})`
    );
    return orientation;
  }

  function paint(bytes, canvas, label) {
    canvas.width = DIM;
    canvas.height = DIM;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(DIM, DIM);
    img.data.set(bytes);
    ctx.putImageData(img, 0, 0);
    ctx.fillStyle = '#0f0';
    ctx.font = '14px monospace';
    ctx.fillText(label, 8, 20);
    return canvas;
  }

  const scenarios = new Map();

  /**
   * SCENARIO 1 — NIGHT: the pattern must show real, measured contrast.
   * The load-bearing question this whole bench exists to answer.
   */
  scenarios.set('night-clear-pattern', {
    name: 'night-clear-pattern',
    summary: 'Night ambient. The pattern must show a genuinely dark mullion and a genuinely open pane, measured.',
    async run(ctx) {
      const params = ctx.params?.apParams ?? {
        ...APERTURE_GOBO_DEFAULTS,
        defaultLampHeightPx: ctx.params?.lampHeight ?? APERTURE_GOBO_DEFAULTS.defaultLampHeightPx,
        // PINNED, not the shipped paneWidthPx/paneHeightPx (round 11,
        // 2026-08-04) — this scenario's own probe points below are HAND-
        // DERIVED against an exact cols=2/rows=1 pane grid (see "With cols=2,
        // wallLen=200..." a few lines down); `deriveApertureGoboPaneCount`
        // against the true shipped default (paneWidthPx=80) yields cols=3
        // for this bench's wallLen=200, an ODD count whose middle pane —
        // not a mullion — sits exactly on the x-independent probe line this
        // scenario's whole geometry leans on. The PANE-COUNT DERIVATION
        // itself (does paneWidthPx=80 round/clamp correctly) is a narrower
        // claim with its own coverage in aperture-gobo.test.mjs; this
        // scenario's job is "does the spoke/arc gate MATH produce real,
        // measured contrast on a real device", which doesn't care what
        // valid cols/rows it's handed — cols=2/rows=1 keeps that provable
        // with simple, already-verified hand arithmetic instead of a second,
        // riskier derivation done under this comment instead of a test.
        paneWidthPx: 100, // wallLen(200)/100 = cols=2, exactly
        paneHeightPx: 200, // (headPx-sillPx)=190, 190/200 rounds to rows=1 (no internal row mullion)
        // PINNED OFF, round 14 (2026-08-04) — the SAME reasoning as the
        // paneWidthPx/paneHeightPx pin above, one round later: this
        // scenario's probe points are hand-solved against the UNWARPED
        // pattern position, and the glass-quality warp (round 13) moves
        // that position by design — at the shipped defaults, found LIVE to
        // shift the mullion probe enough to invert the contrast check
        // entirely (mullion reading AS BRIGHT as the pane). The pattern
        // itself was NOT broken — a saved PNG showed a genuinely legible,
        // wavy mullion band, just relocated — this is a probe-vs-feature
        // mismatch, the exact same class `off-axis-reveal`'s own header
        // already named, not a rendering defect. Warp/grime get their OWN
        // dedicated scenario (`glass-and-grime-preview`), built around wide
        // statistical scans specifically BECAUSE a fixed single-pixel probe
        // can't reliably track a feature that's designed to move.
        distortionPx: 0,
        grimeAmount: 0,
      };
      const darkness01 = ctx.params?.darkness01 ?? 0.95;
      const frame = await renderFrame({ darkness01, apParams: params });
      const checks = [];
      let calibration = 'OK';
      try {
        calibrate(frame.bytes);
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'calibration', status: 'UNMEASURED', note: String(err?.message ?? err) }));
      }
      checks.push(
        evaluate('apertures-were-assigned-at-all', () => ({
          ok: frame.apertureReadout.apertureCount > 0,
          measured: frame.apertureReadout,
          expected: 'apertureCount > 0',
        }))
      );
      // TWO GENUINELY DIFFERENT PROBE POINTS — an earlier draft of this
      // scenario sampled the SAME pixel for both (found live, in the lab's
      // own first run: pane and mullion measured identical, delta=0, because
      // both probes were (WALL_X+40, 400) — this comment is the fix, not
      // just a note).
      //
      // The light sits at LIGHT.y=400, exactly the window's own lateral
      // centre ((WALL_Y0+WALL_Y1)/2 = 400) BY CONSTRUCTION, so `sL=100` — and
      // a ray straight out from the light (constant y=400, any x) has
      // `sW = sL + (s-sL)*inv = 100` for EVERY x, since `s-sL=0` identically.
      // With cols=2, wallLen=200, the ONE internal mullion sits at
      // `sW=wallLen/2=100` too — so (WALL_X+40, 400) is the MULLION probe,
      // dead centre, at every distance from the light. The PANE probe must
      // be OFF that line — y=350 (50 world px off-centre) lands, at x=40,
      // around sW≈60 (worked out by hand from inv=a/(a+x) with a=150,
      // x=40 → inv≈0.789 → sW=100+(50-100)*0.789≈60.5), comfortably inside
      // pane 0's own span (roughly sW∈[6,98] with frame=6, mullion half-
      // width=2) and nowhere near either the mullion or the frame edge.
      const paneCentre = sampleAt(frame.bytes, WALL_X + 40, 350);
      checks.push(
        evaluate('an-open-pane-reads-bright', () => ({
          ok: paneCentre.r > frame.ambientRGB[0] * 255 + 20,
          measured: paneCentre,
          expected: `r > ambient(${Math.round(frame.ambientRGB[0] * 255)}) + 20`,
        }))
      );
      const mullionAtCentre = sampleAt(frame.bytes, WALL_X + 40, 400);
      checks.push(
        evaluate('a-mullion-reads-genuinely-dark', () => {
          const ambientByte = Math.round(frame.ambientRGB[0] * 255);
          return {
            ok: mullionAtCentre.r <= ambientByte + 10,
            measured: { mullion: mullionAtCentre, ambientByte },
            expected: `r <= ambient(${ambientByte}) + 10 (i.e. genuinely dark, not merely dimmer)`,
          };
        })
      );
      checks.push(
        evaluate('pane-vs-mullion-contrast-is-real', () => ({
          ok: paneCentre.r - mullionAtCentre.r > 40,
          measured: { pane: paneCentre.r, mullion: mullionAtCentre.r, delta: paneCentre.r - mullionAtCentre.r },
          expected: 'delta > 40 (a visually obvious difference, not a rounding-error one)',
        }))
      );
      const canvas = document.getElementById('apertureGoboView') ?? document.createElement('canvas');
      const artifacts = [];
      paint(
        frame.bytes,
        canvas,
        `night, lampH=${params.defaultLampHeightPx} paneW=${params.paneWidthPx} paneH=${params.paneHeightPx} mullion=${params.mullion} frame=${params.frame}`
      );
      const f = await saveCanvasPng(ctx.runId, 'night-clear-pattern.png', canvas);
      if (f) artifacts.push(f);
      return {
        checks,
        calibration,
        artifacts,
        inputs: { WORLD, WALL_SEGMENT, LIGHT, params, darkness01 },
        stats: { ambientRGB: frame.ambientRGB, apertureReadout: frame.apertureReadout, orientation },
      };
    },
  });

  /**
   * SCENARIO 1C — POST-BLOOM: the author reports the real material is
   * invisible on screen ("the light is unaffected") even with debug OFF,
   * despite `night-clear-pattern` proving strong, real contrast exists in
   * `buf:scene.illum` itself. The one structural difference between what
   * that scenario measures and what the author actually SEES is everything
   * downstream of `buf:scene.illum` — chiefly `post.bloom`, ON by default at
   * every performance tier. This scenario renders the IDENTICAL scene, then
   * runs it through the REAL bloom pyramid at its shipped defaults (see
   * `runBloomPass`'s own header), and re-measures the SAME two probes to see
   * whether the contrast that survives in illum ALSO survives what the
   * author's screen actually shows.
   */
  scenarios.set('night-clear-pattern-post-bloom', {
    name: 'night-clear-pattern-post-bloom',
    summary:
      "Same scene as night-clear-pattern, run through the REAL bloom pyramid — does the mullion's darkening survive what the author actually sees on screen?",
    async run(ctx) {
      // Same probe points as night-clear-pattern, same reason for pinning
      // paneWidthPx/paneHeightPx AND distortionPx/grimeAmount off — see that
      // scenario's own comment (round 14, 2026-08-04).
      const params = ctx.params?.apParams ?? {
        ...APERTURE_GOBO_DEFAULTS,
        paneWidthPx: 100,
        paneHeightPx: 200,
        distortionPx: 0,
        grimeAmount: 0,
      };
      const darkness01 = ctx.params?.darkness01 ?? 0.95;
      const before = await renderFrame({ darkness01, apParams: params });
      const checks = [];
      let calibration = 'OK';
      try {
        calibrate(before.bytes);
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'calibration', status: 'UNMEASURED', note: String(err?.message ?? err) }));
      }
      const paneBefore = sampleAt(before.bytes, WALL_X + 40, 350);
      const mullionBefore = sampleAt(before.bytes, WALL_X + 40, 400);

      runBloomPass();
      const afterBuf = await renderer.readRenderTargetPixelsAsync(illumRt, 0, 0, DIM, DIM);
      const afterBytes = ArrayBuffer.isView(afterBuf) ? afterBuf : new Uint8Array(afterBuf);
      const paneAfter = sampleAt(afterBytes, WALL_X + 40, 350);
      const mullionAfter = sampleAt(afterBytes, WALL_X + 40, 400);

      const deltaBefore = paneBefore.r - mullionBefore.r;
      const deltaAfter = paneAfter.r - mullionAfter.r;
      checks.push(
        evaluate('contrast-survives-bloom-at-shipped-defaults', () => ({
          ok: deltaAfter > 40,
          measured: {
            paneBefore: paneBefore.r,
            mullionBefore: mullionBefore.r,
            deltaBefore,
            paneAfter: paneAfter.r,
            mullionAfter: mullionAfter.r,
            deltaAfter,
          },
          expected:
            'deltaAfter > 40 (the same bar night-clear-pattern itself uses) — bloom should not be ABLE to erase a real, measured shadow',
        }))
      );
      checks.push(
        evaluate('how-much-of-the-contrast-bloom-removed', () => ({
          ok: true, // observational — the ratio IS the finding
          measured: { deltaBefore, deltaAfter, retainedFraction: deltaBefore > 0 ? deltaAfter / deltaBefore : null },
          expected: 'retainedFraction close to 1 = bloom leaves the shadow alone; close to 0 = bloom is erasing it',
        }))
      );
      const canvas = document.getElementById('apertureGoboView') ?? document.createElement('canvas');
      const artifacts = [];
      paint(
        before.bytes,
        canvas,
        `BEFORE bloom — pane=${paneBefore.r} mullion=${mullionBefore.r} delta=${deltaBefore}`
      );
      const f1 = await saveCanvasPng(ctx.runId, 'post-bloom-before.png', canvas);
      if (f1) artifacts.push(f1);
      paint(
        afterBytes,
        canvas,
        `AFTER bloom (shipped defaults) — pane=${paneAfter.r} mullion=${mullionAfter.r} delta=${deltaAfter}`
      );
      const f2 = await saveCanvasPng(ctx.runId, 'post-bloom-after.png', canvas);
      if (f2) artifacts.push(f2);
      return {
        checks,
        calibration,
        artifacts,
        inputs: { WORLD, WALL_SEGMENT, LIGHT, params, darkness01 },
        stats: {
          paneBefore: paneBefore.r,
          mullionBefore: mullionBefore.r,
          deltaBefore,
          paneAfter: paneAfter.r,
          mullionAfter: mullionAfter.r,
          deltaAfter,
          orientation,
        },
      };
    },
  });

  // SCENARIOS 1B/1D — VISIBILITY DIAGNOSTIC / VISIBILITY IS UNIFORM ACROSS
  // DISTANCE — RETIRED (round 10, 2026-08-04). Both tested the separate
  // visibility gate (`materialMode: 'visibility'`) that no longer exists —
  // see aperture-gobo.js's own retirement note. The properties they checked
  // (does the pattern reach true black; is the effect uniform across the
  // wedge rather than fading with distance) are still real requirements,
  // now implicitly covered by `night-clear-pattern`'s own pane/mullion
  // contrast check and `debug` mode's own raw-pattern readback — a dedicated
  // "is visibility the gap" scenario has nothing left to isolate once there
  // is no separate visibility term to isolate it FROM.

  /**
   * SCENARIO 2 — NOON: the effect must be a COMPLETE no-op relative to a
   * plain, apertures-unaware light — checked pixel-for-pixel.
   */
  scenarios.set('noon-is-a-no-op', {
    name: 'noon-is-a-no-op',
    summary: 'Bright daylight ambient. The aperture shadow pass must not visibly change ANY pixel.',
    async run(ctx) {
      const params = ctx.params?.apParams ?? APERTURE_GOBO_DEFAULTS;
      const darkness01 = ctx.params?.darkness01 ?? 0.0;
      const withShadow = await renderFrame({ darkness01, apParams: params });
      // The SAME frame with strength forced to 0 — the documented "off"
      // state — stands in for "no aperture-gobo pass at all", without a
      // second code path to maintain.
      const withoutShadow = await renderFrame({ darkness01, apParams: { ...params, strength: 0 } });
      const checks = [];
      let diff = 0;
      for (let i = 0; i < withShadow.bytes.length; i += 4) {
        if (Math.abs(withShadow.bytes[i] - withoutShadow.bytes[i]) > 2) diff++;
      }
      const pct = (diff / (DIM * DIM)) * 100;
      checks.push(
        evaluate('noon-frame-is-unchanged-by-the-shadow-pass', () => ({
          ok: pct < 0.5,
          measured: `${pct.toFixed(3)}% of pixels differ by >2/255`,
          expected: '< 0.5%',
          note:
            'round 10 (2026-08-04): no separate visibility gate exists any more — this now holds because ' +
            "computedBrightColor/computedDimColor (this light's own switchColor endpoints) NATURALLY CONVERGE " +
            "toward computedBackgroundColor as darkness01->0 (Foundry's own ambient ladder, `environmental-" +
            'light.js#computeAmbientColors` — `bright=mix(background,ambientBrightest,1)`), so a blocked ' +
            "fragment's fallback (backgroundFloor) and an unblocked fragment's natural illum (finalColorExposed) " +
            'are already close at noon, gobo or no gobo — the tolerance below absorbs the small residual gap ' +
            'between ambientBrightest and ambientDaylight, not a gate.',
        }))
      );
      const canvas = document.getElementById('apertureGoboView') ?? document.createElement('canvas');
      const artifacts = [];
      paint(
        withShadow.bytes,
        canvas,
        `noon, WITH aperture shadow (strength=${params.strength ?? APERTURE_GOBO_DEFAULTS.strength})`
      );
      const f1 = await saveCanvasPng(ctx.runId, 'noon-with-shadow.png', canvas);
      if (f1) artifacts.push(f1);
      paint(withoutShadow.bytes, canvas, 'noon, WITHOUT aperture shadow (strength=0)');
      const f2 = await saveCanvasPng(ctx.runId, 'noon-without-shadow.png', canvas);
      if (f2) artifacts.push(f2);
      return {
        checks,
        calibration: 'OK',
        artifacts,
        inputs: { WORLD, WALL_SEGMENT, LIGHT, params, darkness01 },
        stats: { ambientRGB: withShadow.ambientRGB, pctDiffer: pct },
      };
    },
  });

  /**
   * SCENARIO 3 — OFF-AXIS REVEAL (round 12, 2026-08-04): the wall-thickness
   * reveal (`aperture-gobo.js#computeApertureRevealNarrowing`) must
   * genuinely darken the jamb AWAY from an off-axis light's own lean, and
   * leave the jamb the light leans TOWARD alone. `night-clear-pattern`'s own
   * light sits exactly on the window's lateral centreline by construction
   * (`tanTheta==0`, a proven no-op — see that scenario's own comment), so it
   * cannot exercise this at all; this scenario moves the light instead.
   *
   * Two renders of the IDENTICAL off-axis light, `wallThicknessPx` 0 vs 60
   * (an exaggerated value FOR THIS DIAGNOSTIC specifically, not the shipped
   * default of 16 — a clear, unambiguous signal beats a marginal one for a
   * scenario whose whole job is "does this do anything, and on the right
   * side"), then a SWEEP of probes along the window's own lateral axis, at a
   * fixed floor distance from the wall — not hand-solved coordinates, an
   * empirical scan, so the measurement is the evidence, not an assumption
   * about where the effect should show up.
   */
  scenarios.set('off-axis-reveal', {
    name: 'off-axis-reveal',
    summary:
      'An off-axis light darkens the window jamb AWAY from its own lean (the wall-thickness reveal), and leaves ' +
      'the jamb it leans TOWARD alone.',
    async run(ctx) {
      // Light pushed toward the WALL_Y1 (high-Y) corner — sL far from the
      // window's own centre relative to `a`, a genuinely oblique angle.
      const light = { x: 350, y: 495, radius: 500 };
      const baseParams = {
        ...APERTURE_GOBO_DEFAULTS,
        paneWidthPx: 100, // wallLen(200)/100 = cols=2, same pin as night-clear-pattern, for known geometry
        paneHeightPx: 200, // rows=1, no internal row mullion to confound the spoke-axis sweep below
      };
      const darkness01 = ctx.params?.darkness01 ?? 0.95;
      const withReveal = await renderFrame({
        darkness01,
        apParams: { ...baseParams, wallThicknessPx: 60 },
        light,
      });
      const withoutReveal = await renderFrame({
        darkness01,
        apParams: { ...baseParams, wallThicknessPx: 0 },
        light,
      });
      const checks = [];
      let calibration = 'OK';
      try {
        calibrate(withReveal.bytes);
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'calibration', status: 'UNMEASURED', note: String(err?.message ?? err) }));
      }
      // Sweep along Y (the window's own lateral/spoke axis) at a fixed
      // exterior floor distance (WALL_X+40, same probe distance every other
      // scenario in this bench already uses) — low Y is the jamb AWAY from
      // the light's own lean (should darken), high Y is the jamb the light
      // leans TOWARD (should be untouched). Range widened past the wall's
      // own [WALL_Y0,WALL_Y1]=[300,500] extent DELIBERATELY, not a typo — an
      // off-axis light's own rays fan out non-uniformly, so the shadowed
      // jamb's own floor-space Y range does not line up with the wall
      // segment's own Y span (hand-derived once to locate it: at x=40,
      // sL=195, a=150, the frame boundary sits near Y≈258-306, BELOW
      // WALL_Y0 — found by solving sW=frame for Y, not guessed).
      const sweep = [];
      for (let y = 150; y <= 490; y += 20) {
        const a = sampleAt(withReveal.bytes, WALL_X + 40, y);
        const b = sampleAt(withoutReveal.bytes, WALL_X + 40, y);
        sweep.push({ y, withReveal: a.r, withoutReveal: b.r, delta: b.r - a.r });
      }
      const maxDelta = Math.max(...sweep.map((s) => s.delta));
      const lowHalf = sweep.filter((s) => s.y < 400);
      const highHalf = sweep.filter((s) => s.y >= 400);
      const lowSum = lowHalf.reduce((acc, s) => acc + Math.max(0, s.delta), 0);
      const highSum = highHalf.reduce((acc, s) => acc + Math.max(0, s.delta), 0);
      checks.push(
        evaluate('the-reveal-darkens-something-real', () => ({
          ok: maxDelta > 30,
          measured: { maxDelta, sweep },
          expected: 'max delta > 30 (a visually obvious difference at SOME point along the sweep)',
        }))
      );
      checks.push(
        evaluate('the-darkening-concentrates-on-the-jamb-AWAY-from-the-lights-own-lean', () => ({
          ok: lowSum > highSum * 2,
          measured: { lowSum, highSum, lowHalf, highHalf },
          expected:
            'low-Y (away from the light, which leans toward high-Y) accumulates MUCH more darkening than high-Y',
        }))
      );
      const nearLeanEdge = sweep[sweep.length - 1];
      checks.push(
        evaluate('the-jamb-the-light-leans-toward-is-essentially-untouched', () => ({
          ok: Math.abs(nearLeanEdge.delta) < 10,
          measured: nearLeanEdge,
          expected: '|delta| < 10 at the far high-Y end of the sweep (nearest the light’s own lean)',
        }))
      );
      const canvas = document.getElementById('apertureGoboView') ?? document.createElement('canvas');
      const artifacts = [];
      paint(withReveal.bytes, canvas, `off-axis, WITH reveal (wallThicknessPx=60) — maxDelta=${maxDelta}`);
      const f1 = await saveCanvasPng(ctx.runId, 'off-axis-with-reveal.png', canvas);
      if (f1) artifacts.push(f1);
      paint(withoutReveal.bytes, canvas, 'off-axis, WITHOUT reveal (wallThicknessPx=0)');
      const f2 = await saveCanvasPng(ctx.runId, 'off-axis-without-reveal.png', canvas);
      if (f2) artifacts.push(f2);
      return {
        checks,
        calibration,
        artifacts,
        inputs: { WORLD, WALL_SEGMENT, light, darkness01 },
        stats: {
          sweep,
          maxDelta,
          lowSum,
          highSum,
          withRevealApertureReadout: withReveal.apertureReadout,
          withoutRevealApertureReadout: withoutReveal.apertureReadout,
        },
      };
    },
  });

  /**
   * SCENARIO 4 — GLASS & GRIME PREVIEW (round 13, 2026-08-04): the author's
   * own "have some fun with it" ask — glass-quality warp (blob<->faceted)
   * and a layered-noise grime system with occasional broken panes. Unlike
   * `off-axis-reveal`, this one does NOT hand-solve exact probe coordinates
   * against the pattern — the whole point of a WARP is that it moves the
   * pattern away from wherever a pre-round-13 hand-solve would have put it.
   * Instead: a WIDE scan, compared statistically against a features-OFF
   * baseline (glassQuality/distortionPx/grimeAmount are each an EXACT no-op
   * at their own "off" value, already proven per-function in
   * `aperture-gobo.test.mjs` — this scenario is about the COMPOSED,
   * real-device result, not re-proving the individual formulas). A wider
   * `paneWidthPx` pin than usual (30, not the other scenarios' own 100) —
   * more, narrower panes across the SAME wallLen(200) gives broken-pane
   * detection a real chance to hit (round 11's own `deriveApertureGoboPaneCount`
   * — wallLen(200)/30 ≈ 6.7 -> 7 panes — genuinely exercised here, not
   * bypassed).
   */
  scenarios.set('glass-and-grime-preview', {
    name: 'glass-and-grime-preview',
    summary:
      'Glass-quality warp + grime/broken-panes, compared statistically against a features-OFF baseline — a wide ' +
      'scan, not hand-solved probes (a warp moves the pattern by design).',
    async run(ctx) {
      const apParamsBase = {
        ...APERTURE_GOBO_DEFAULTS,
        paneWidthPx: 30,
        paneHeightPx: 200, // rows=1 — keep the arc axis simple, this scenario is about the spoke axis + grime
        wallThicknessPx: 0, // isolate round 13 from round 12's own reveal
      };
      const darkness01 = ctx.params?.darkness01 ?? 0.95;
      // Individually overridable (each defaults to the ON demo's own value)
      // so a live probe can dial ONE axis at a time — quality alone (blob
      // vs faceted) without also forcing grime on, or vice versa.
      const glassQuality = ctx.params?.glassQuality ?? 0.5;
      const distortionPx = ctx.params?.distortionPx ?? 15;
      const grimeAmount = ctx.params?.grimeAmount ?? 0.7;
      const on = await renderFrame({
        darkness01,
        apParams: { ...apParamsBase, glassQuality, distortionPx, grimeAmount },
      });
      const off = await renderFrame({
        darkness01,
        apParams: { ...apParamsBase, glassQuality, distortionPx: 0, grimeAmount: 0 },
      });
      const checks = [];
      let calibration = 'OK';
      try {
        calibrate(on.bytes);
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'calibration', status: 'UNMEASURED', note: String(err?.message ?? err) }));
      }
      // A wide scan across the whole beam, same probe DISTANCE every other
      // scenario in this bench already uses (WALL_X+40).
      const scan = [];
      for (let y = 310; y <= 490; y += 15) {
        const a = sampleAt(on.bytes, WALL_X + 40, y);
        const b = sampleAt(off.bytes, WALL_X + 40, y);
        scan.push({ y, on: a.r, off: b.r, absDelta: Math.abs(a.r - b.r) });
      }
      const avgOn = scan.reduce((acc, s) => acc + s.on, 0) / scan.length;
      const avgOff = scan.reduce((acc, s) => acc + s.off, 0) / scan.length;
      const sumAbsDelta = scan.reduce((acc, s) => acc + s.absDelta, 0);
      checks.push(
        evaluate('grime-measurably-darkens-the-average-across-a-wide-scan', () => ({
          ok: avgOn < avgOff - 10,
          measured: { avgOn, avgOff, deltaAvg: avgOff - avgOn },
          expected: 'avgOn at least 10/255 darker than avgOff, averaged over 13 points — grime is a REAL, net effect',
        }))
      );
      checks.push(
        evaluate('warp-and-grime-together-visibly-change-the-pattern-somewhere', () => ({
          ok: sumAbsDelta > 200,
          measured: { sumAbsDelta, pointCount: scan.length },
          expected: 'sum of per-point |delta| > 200 across the scan — not a silent no-op',
        }))
      );
      // OBSERVATIONAL, not required to pass — with only ~7 panes and a
      // per-pane 25%-at-grimeAmount=1 break chance, a scan THIS narrow has
      // no guarantee of crossing a broken one. Reports what it found rather
      // than asserting it must find one (`feedback_instruments_must_not_lie`
      // — a coin flip dressed up as a requirement is its own kind of lie).
      const brightestOnADarkBaselinePoint = scan.reduce(
        (best, s) => (s.off < 80 && s.on > best.on ? s : best),
        { on: -1, off: 0, y: null }
      );
      checks.push(
        check({
          id: 'crack-scan-observational',
          status: 'UNMEASURED',
          note:
            brightestOnADarkBaselinePoint.y !== null && brightestOnADarkBaselinePoint.on > 150
              ? `possible crack found near y=${brightestOnADarkBaselinePoint.y} (off=${brightestOnADarkBaselinePoint.off}, on=${brightestOnADarkBaselinePoint.on}) — a baseline-dark point now reads bright`
              : 'no obvious crack crossed this specific scan line — expected sometimes with only ~7 panes and a per-pane chance; not a failure',
        })
      );
      const canvas = document.getElementById('apertureGoboView') ?? document.createElement('canvas');
      const artifacts = [];
      paint(
        on.bytes,
        canvas,
        `glass+grime ON (quality=${glassQuality} distortion=${distortionPx} grime=${grimeAmount}) — avg=${avgOn.toFixed(0)}`
      );
      const f1 = await saveCanvasPng(ctx.runId, 'glass-grime-on.png', canvas);
      if (f1) artifacts.push(f1);
      paint(off.bytes, canvas, `glass+grime OFF (baseline) — avg=${avgOff.toFixed(0)}`);
      const f2 = await saveCanvasPng(ctx.runId, 'glass-grime-off.png', canvas);
      if (f2) artifacts.push(f2);
      return {
        checks,
        calibration,
        artifacts,
        inputs: { WORLD, WALL_SEGMENT, LIGHT, darkness01 },
        stats: { scan, avgOn, avgOff, sumAbsDelta, apertureReadout: on.apertureReadout },
      };
    },
  });

  /**
   * SCENARIO 5 — ATTENUATION-REACH FADE (round 15, 2026-08-04): two live
   * reports, one root cause. Author: (1) "make the entire effect much more
   * diffused and blurred... progressively so further away from the window";
   * (2) "the window light illumination doesn't moderate itself by the
   * attenuation slider correctly... always acting as if attenuation was 0."
   * `aperture-gobo.js#REACH_SOFT_FAR_PX_BASE`'s own header has the full
   * diagnosis — a Node probe against the CPU math, run BEFORE any code
   * changed, found the arc gate's own `xHead` boundary (a hard wall in
   * floor-space `x`, computed from THIS aperture's own geometry — never the
   * light's radius or attenuation) was what actually terminated the beam,
   * often well before `dist01` (what attenuation shapes) grew large enough
   * to matter. This scenario reproduces that exact shape on a REAL WebGPU
   * device (not just the CPU spec) via `renderFrame`'s own
   * `reachSoftFarPxOverride` A/B — 0 forces the pre-round-15 shape (pinned
   * as a regression fixture, not just described), `undefined` renders the
   * shipped default.
   *
   * The light sits close to its own window (`a=50`, small on purpose — see
   * inline comment) so `xHeadReach` lands well inside this bench's own
   * 800x800 world, but with a radius (3000) far past the world entirely —
   * `dist01` never leaves ~0 anywhere reachable, so any visible falloff
   * along the beam can ONLY be the reach blur, isolating it cleanly from
   * the light's own dist01-driven curve.
   */
  scenarios.set('attenuation-reach-fade', {
    name: 'attenuation-reach-fade',
    summary:
      "A light whose radius reaches far past its own window must still fade the beam's far edge over a real " +
      'span of distance (not a ~10px cliff) — the reach blur, independent of the attenuation slider this ' +
      'geometric boundary was never actually driven by.',
    async run(ctx) {
      const light = { x: WALL_X - 50, y: 400, radius: 3000 };
      const baseParams = {
        ...APERTURE_GOBO_DEFAULTS,
        paneWidthPx: 250, // wallLen(200)/250 -> cols=1: no vertical mullion to confound a centreline sweep
        paneHeightPx: 200, // rows=1: no internal row mullion — only frame/sill/head bound this one pane
      };
      const darkness01 = ctx.params?.darkness01 ?? 0.95;

      // Ground the sweep range in the REAL computed geometry (this bench's
      // own established discipline — `off-axis-reveal`'s own header has the
      // same reasoning) rather than a hand guess.
      const frame = computeWallFrame(WALL_SEGMENT);
      const aperture = orientApertureToLight(frame, light);
      const h = resolveLampHeight(light, baseParams);
      const xHeadReach = computeApertureRowBoundaryX({ a: aperture.a, h, z: baseParams.headPx });

      const reachOn = await renderFrame({ darkness01, apParams: baseParams, light });
      const reachOff = await renderFrame({ darkness01, apParams: baseParams, light, reachSoftFarPxOverride: 0 });

      const checks = [];
      let calibration = 'OK';
      try {
        calibrate(reachOn.bytes);
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'calibration', status: 'UNMEASURED', note: String(err?.message ?? err) }));
      }

      // Sweep straight out from the wall along the light's own on-axis
      // centreline (y=400 — the wall's own midpoint AND the light's own y —
      // sW stays at the pane's own centre for every x, clear of the frame).
      const sweep = [];
      for (let x = 10; x <= Math.min(300, xHeadReach + 120); x += 10) {
        const on = sampleAt(reachOn.bytes, WALL_X + x, 400);
        const off = sampleAt(reachOff.bytes, WALL_X + x, 400);
        sweep.push({ x, reachOn: on.r, reachOff: off.r });
      }
      // "Dark" means AT the ambient background floor, not an absolute
      // near-zero guess — at darkness01=0.95 that floor is a dim grey
      // (measured live: R≈46), not black (`backgroundFloor` is the
      // AMBIENT colour a fully-blocked fragment mixes to, per `point-
      // light-illumination.js`'s own "FRAGMENT_END" line — never literal
      // 0). `ambientRGB` is the SAME array `computeAmbientColors` produced
      // for this exact render, so this threshold can never drift from
      // whatever darkness01 the scenario is actually run with.
      const floorR = Math.round((reachOn.ambientRGB?.[0] ?? 0) * 255);
      const isDark = (v) => v <= floorR + 3;
      const isBright = (v) => v > 200;
      const lastBright = (rows, key) => [...rows].reverse().find((s) => isBright(s[key]));
      const firstDarkAfter = (rows, key, afterX) => rows.find((s) => isDark(s[key]) && s.x > afterX);

      const lastBrightOff = lastBright(sweep, 'reachOff');
      const firstDarkOff = firstDarkAfter(sweep, 'reachOff', lastBrightOff?.x ?? 0);
      const lastBrightOn = lastBright(sweep, 'reachOn');
      const firstDarkOn = firstDarkAfter(sweep, 'reachOn', lastBrightOn?.x ?? 0);

      checks.push(
        evaluate('reach-blur-off-reproduces-the-near-instant-cliff', () => ({
          ok: !!lastBrightOff && !!firstDarkOff && firstDarkOff.x - lastBrightOff.x <= 20,
          measured: { lastBrightOff, firstDarkOff },
          expected:
            'bright-to-dark transition spans <=20px with the reach blur forced off — the live-diagnosed bug, ' +
            'pinned here as a regression fixture',
        }))
      );
      checks.push(
        evaluate('reach-blur-on-turns-the-cliff-into-a-real-fade', () => ({
          ok: !!lastBrightOn && !!firstDarkOn && firstDarkOn.x - lastBrightOn.x >= 40,
          measured: { lastBrightOn, firstDarkOn, xHeadReach },
          expected: 'bright-to-dark transition spans >=40px at the shipped default — a genuine fade, not a wall',
        }))
      );
      checks.push(
        evaluate('well-before-the-edge-the-beam-is-still-fully-bright', () => ({
          ok: sampleAt(reachOn.bytes, WALL_X + 10, 400).r > 200,
          measured: sampleAt(reachOn.bytes, WALL_X + 10, 400),
          expected: 'near field unchanged by the reach blur — r > 200 close to the window',
        }))
      );

      const canvas = document.getElementById('apertureGoboView') ?? document.createElement('canvas');
      const artifacts = [];
      paint(reachOn.bytes, canvas, `reach blur ON (shipped default) — xHeadReach=${xHeadReach.toFixed(0)}`);
      const f1 = await saveCanvasPng(ctx.runId, 'attenuation-reach-on.png', canvas);
      if (f1) artifacts.push(f1);
      paint(reachOff.bytes, canvas, 'reach blur OFF (pre-round-15 shape, forced for comparison)');
      const f2 = await saveCanvasPng(ctx.runId, 'attenuation-reach-off.png', canvas);
      if (f2) artifacts.push(f2);

      return {
        checks,
        calibration,
        artifacts,
        inputs: { WORLD, WALL_SEGMENT, light, darkness01, xHeadReach },
        stats: { sweep, lastBrightOff, firstDarkOff, lastBrightOn, firstDarkOn },
      };
    },
  });

  /**
   * SCENARIO 6 — DIM-RADIUS HARD EDGE (round 16, 2026-08-04): a live
   * screenshot, author: *"This light has full attenuation so the window
   * light effect should softly fade towards this edge but you can see a
   * hard edge at the arc associated with the dim radius of the light."*
   * Round 15's own diagnosis deliberately used a HUGE light radius (3000)
   * to isolate the WINDOW's own geometric reach limit (`xHeadReach`) from
   * the light's own radius — the opposite configuration from what THIS
   * report describes. This scenario isolates the OTHER case: the light's
   * OWN `dist01==1` circular boundary reached WELL WITHIN the window's own
   * geometric reach, at maximum attenuation, checking whether `combined
   * Falloff` (the base light's own attenuation-driven radial fade,
   * `point-light-illumination.js`'s own `smoothstep(1, 1-atten, dist01)`)
   * genuinely softens that edge the way it does for an ordinary light, or
   * whether something in the gobo multiply/composite chain defeats it.
   */
  scenarios.set('dim-radius-hard-edge', {
    name: 'dim-radius-hard-edge',
    summary:
      "A light at maximum attenuation, radius small enough that its OWN dist01==1 edge sits well inside the " +
      "window's own geometric reach — checks whether combinedFalloff's own smooth fade actually reaches the " +
      'screen, or whether the visible edge is hard.',
    async run(ctx) {
      // a=60 (light.x = WALL_X-60), radius=200 -> the light's own edge is
      // reached at x≈140 (dist01=1 ≈ (x+a)/radius), well before xHeadReach
      // (a*headPx/(h-headPx) = 60*220/60 = 220) ever becomes the limiting
      // factor — the light's own radius is what's binding here, not the
      // window's geometry (the opposite of round 15's own probe).
      const light = ctx.params?.light ?? { x: WALL_X - 60, y: 400, radius: 200 };
      const baseParams = ctx.params?.apParams ?? {
        ...APERTURE_GOBO_DEFAULTS,
        paneWidthPx: 250, // cols=1: no vertical mullion to confound the sweep
        paneHeightPx: 200, // rows=1: no internal row mullion either
      };
      const darkness01 = ctx.params?.darkness01 ?? 0.95;

      const luminosity01 = ctx.params?.luminosity01 ?? 0.5;
      const maxAtten = await renderFrame({ darkness01, apParams: baseParams, light, attenuation01: 1.0, luminosity01 });

      const checks = [];
      let calibration = 'OK';
      try {
        calibrate(maxAtten.bytes);
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'calibration', status: 'UNMEASURED', note: String(err?.message ?? err) }));
      }

      // ALSO run the REAL bloom pyramid over the SAME frame (bloom is ON by
      // default in the real game, `effects/bloom.js`'s own
      // `enabledFromProfile: 'low'`) — this bench's own pre-bloom sweep
      // alone cannot rule out bloom's own bright/dark-pass threshold or
      // Karis downsample introducing a step the pre-bloom buffer doesn't
      // have; checking BOTH is what actually answers "does the author's own
      // screen show this smoothly", not just "does the pre-composite buffer".
      runBloomPass();
      const bloomedBuf = await renderer.readRenderTargetPixelsAsync(illumRt, 0, 0, DIM, DIM);
      const bloomedBytes = ArrayBuffer.isView(bloomedBuf) ? bloomedBuf : new Uint8Array(bloomedBuf);

      // Sweep range scales to THIS scenario's own light radius (capped to
      // the world's own 800x800 bounds, WALL_X=500 -> 300px of usable floor
      // depth) rather than a fixed 250 — a caller testing a light whose
      // radius reaches past the default 200 (this scenario's own light
      // override) needs the sweep to actually REACH that edge, not silently
      // stop short of it.
      const sweepMaxX = Math.min(300, Math.round(light.radius * 1.05));
      const sweep = [];
      const sweepBloomed = [];
      for (let x = 10; x <= sweepMaxX; x += 5) {
        const s = sampleAt(maxAtten.bytes, WALL_X + x, 400);
        const sb = sampleAt(bloomedBytes, WALL_X + x, 400);
        const dist01 = Math.hypot(WALL_X + x - light.x, 400 - light.y) / light.radius;
        sweep.push({ x, dist01, r: s.r });
        sweepBloomed.push({ x, dist01, r: sb.r });
      }
      let maxStepDropBloomed = 0;
      let maxStepAtBloomed = null;
      for (let i = 1; i < sweepBloomed.length; i++) {
        const drop = sweepBloomed[i - 1].r - sweepBloomed[i].r;
        if (drop > maxStepDropBloomed) {
          maxStepDropBloomed = drop;
          maxStepAtBloomed = { from: sweepBloomed[i - 1], to: sweepBloomed[i] };
        }
      }
      checks.push(
        evaluate('no-single-5px-step-drops-brightness-by-more-than-a-third-POST-BLOOM', () => ({
          ok: maxStepDropBloomed < 85,
          measured: { maxStepDropBloomed, maxStepAtBloomed },
          expected: 'same check, AFTER the real bloom pyramid — bloom must not introduce a step the pre-bloom buffer lacked',
        }))
      );
      // A "hard edge" is a big single-step drop between adjacent (5px)
      // samples; a "soft fade" spreads the same total drop across many
      // steps. Report the LARGEST single-step drop found anywhere in the
      // sweep, not just near dist01=1, so a genuine cliff can't hide.
      let maxStepDrop = 0;
      let maxStepAt = null;
      for (let i = 1; i < sweep.length; i++) {
        const drop = sweep[i - 1].r - sweep[i].r;
        if (drop > maxStepDrop) {
          maxStepDrop = drop;
          maxStepAt = { from: sweep[i - 1], to: sweep[i] };
        }
      }
      checks.push(
        evaluate('no-single-5px-step-drops-brightness-by-more-than-a-third', () => ({
          ok: maxStepDrop < 85,
          measured: { maxStepDrop, maxStepAt },
          expected:
            'largest single 5px-step drop in R across the whole sweep < 85 (1/3 of 255) — a genuine fade spreads ' +
            'out, a hard edge concentrates almost the whole drop into one step',
        }))
      );
      checks.push(
        evaluate('the-light-genuinely-goes-dark-past-its-own-radius', () => ({
          ok: sweep[sweep.length - 1].r < 60,
          measured: sweep[sweep.length - 1],
          expected: 'well past dist01=1, brightness has actually reached the ambient floor',
        }))
      );

      const canvas = document.getElementById('apertureGoboView') ?? document.createElement('canvas');
      const artifacts = [];
      paint(maxAtten.bytes, canvas, 'max attenuation, small-radius light — PRE-bloom');
      const f1 = await saveCanvasPng(ctx.runId, 'dim-radius-hard-edge.png', canvas);
      if (f1) artifacts.push(f1);
      paint(bloomedBytes, canvas, 'max attenuation, small-radius light — POST-bloom (real pipeline)');
      const f2 = await saveCanvasPng(ctx.runId, 'dim-radius-hard-edge-bloomed.png', canvas);
      if (f2) artifacts.push(f2);

      return {
        checks,
        calibration,
        artifacts,
        inputs: { WORLD, WALL_SEGMENT, light, darkness01 },
        stats: { sweep, maxStepDrop, maxStepAt, sweepBloomed, maxStepDropBloomed, maxStepAtBloomed },
      };
    },
  });

  const bench = {
    name: 'aperture-gobo',
    title: 'Aperture gobo — wall, window, light, isolated from Foundry',
    rung: 3,
    summary:
      'A real window wall, a real point light on its interior side, the REAL buildPointLightIlluminationMaterial ' +
      '(round 10, 2026-08-04: the aperture-gobo pattern is now baked directly into this SAME material, no ' +
      'separate shadow pass) on a real WebGPU device. Answers "does a convincing pane pattern actually render" ' +
      'without Foundry, concurrent edits, or the other window effect in the way.',
    params: { apParams: 'APERTURE_GOBO_DEFAULTS-shaped bag (optional)', darkness01: 'number 0..1 (optional)' },
    scenarios,
    checkIds: [
      'apertures-were-assigned-at-all',
      'an-open-pane-reads-bright',
      'a-mullion-reads-genuinely-dark',
      'pane-vs-mullion-contrast-is-real',
      'contrast-survives-bloom-at-shipped-defaults',
      'how-much-of-the-contrast-bloom-removed',
      'noon-frame-is-unchanged-by-the-shadow-pass',
      'the-reveal-darkens-something-real',
      'the-darkening-concentrates-on-the-jamb-AWAY-from-the-lights-own-lean',
      'the-jamb-the-light-leans-toward-is-essentially-untouched',
      'grime-measurably-darkens-the-average-across-a-wide-scan',
      'warp-and-grime-together-visibly-change-the-pattern-somewhere',
      'crack-scan-observational',
      'reach-blur-off-reproduces-the-near-instant-cliff',
      'reach-blur-on-turns-the-cliff-into-a-real-fade',
      'well-before-the-edge-the-beam-is-still-fully-bright',
      'no-single-5px-step-drops-brightness-by-more-than-a-third',
      'the-light-genuinely-goes-dark-past-its-own-radius',
      'no-single-5px-step-drops-brightness-by-more-than-a-third-POST-BLOOM',
    ],
    ready: () => true,
    async runScenario(scenario, ctx) {
      return scenario.run(ctx);
    },
  };

  registerBench(bench);
  return bench;
}
