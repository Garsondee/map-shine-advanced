/**
 * SHADER LAB — THE FIRE BENCH (rung 1: what does the noise actually cost).
 *
 * ============================================================================
 * WHY THIS BENCH EXISTS BEFORE ANY FIRE CODE DOES
 * ============================================================================
 *
 * The fire design (`docs/planning/Fire.md`) is a VERTICAL SLAB INTEGRAL: because
 * the viewer's camera is orthographic and looks exactly down −Z, every view ray
 * is parallel to world up, so "marching the fire volume" is a 1-D column
 * integral at a fixed (x,y) and every fragment integrates the SAME heights in
 * lockstep. Its entire cost is N evaluations of `fbmFloat` with a live third
 * coordinate.
 *
 * That makes one unanswered question load-bearing for the whole design, and it
 * is NOT answerable by reading source:
 *
 *   `mx_fractal_noise_float` has NO vec2 path. three.webgpu.js:53743 holds `p`
 *   as a `vec3` local, so it always resolves to `mx_perlin_noise_float_1`, the
 *   EIGHT-corner 3D variant — and `NodeBuilder.format` (:57770) silently pads a
 *   vec2 argument to `vec3(xy, 0.0)`. So every one of the ~40 existing
 *   `fbmFloat(TSL, someVec2, …)` call sites in `src/` already compiles to a 3D
 *   noise call with a constant z.
 *
 *   IF the downstream WGSL compiler folds that constant `0.0` through
 *   `mx_trilerp`, those existing calls really run 4 corners, and every slice
 *   fire adds costs DOUBLE what the plan budgeted.
 *   IF it does not fold, they already run 8, and fire's live third axis is FREE.
 *
 * `x * 0.0 → 0.0` is not an IEEE-safe rewrite (Inf/NaN), graphics compilers
 * usually do it anyway, and the call sits inside a real WGSL `for` loop whose
 * body mutates `p` — so "usually" is not good enough to bet a tier ladder on.
 * This bench measures it.
 *
 * ============================================================================
 * THE NON-VACUITY GATE — READ THIS BEFORE TRUSTING ANY VERDICT HERE
 * ============================================================================
 *
 * "Variant A and variant C measured the same" has TWO explanations: the third
 * axis is genuinely free, or this timer cannot resolve a cost difference at all.
 * Those are opposite conclusions from identical evidence, and a rig that cannot
 * tell them apart will confidently report the wrong one
 * (`feedback_instruments_must_not_lie`).
 *
 * So every scenario here first measures a difference it KNOWS must exist: six
 * octaves against three, which is twice the lattice hashes by construction. If
 * that separation does not show up, the timer is blind and every other check in
 * the run reports UNMEASURED rather than a number. This is the same
 * `detector-is-not-vacuous` discipline `bench-derive.js` uses.
 *
 * ============================================================================
 * MEASUREMENT HYGIENE
 * ============================================================================
 *
 * - REPEATS, not one call. One 3-octave fBm over 1024² is ~0.2 ms — close
 *   enough to the noise floor that a ratio between two of them is meaningless.
 *   Each variant evaluates the noise `REPEATS` times per pixel and sums, which
 *   lifts the signal an order of magnitude above the floor.
 * - EVERY REPEAT GETS A DISTINCT XY OFFSET, identically across all three
 *   variants. Identical arguments would be common-subexpression-eliminated down
 *   to one call and the repeat count would buy nothing.
 * - THE RESULT IS WRITTEN TO THE OUTPUT. An unconsumed noise value is dead code
 *   and compiles to nothing.
 * - WARM-UP FRAMES ARE DISCARDED. The first render pays shader compilation and
 *   pipeline creation, which is not what we are measuring.
 * - VARIANTS ARE MEASURED ROUND-ROBIN, NOT IN BLOCKS. ⚠️ Measured 2026-08-08, by
 *   this bench against itself: the first version timed each variant in its own
 *   block, and the SAME variant (liveZ @ 3 octaves) measured twice in one run
 *   came back 1.39 ms and 1.11 ms — 25% apart. The tell was in the spread:
 *   whichever variants were measured FIRST showed p95 ≈ 1.6 × p50 while the
 *   later ones showed p95 ≈ p50. That is GPU clock/power ramp, and in a block
 *   layout it lands entirely on whichever variant happens to go first — so the
 *   ratio between two blocks measures warm-up as much as it measures cost. Now
 *   every variant is sampled once per round, so drift of any kind moves all of
 *   them together and divides out of the ratio.
 * - MEDIAN, NOT MEAN. One scheduling hiccup should not move the verdict.
 * - Each sample AWAITS its own `resolveTimestampsAsync`, deliberately
 *   serialising CPU and GPU. `diag/perf-lab.js`'s own header records what
 *   happens otherwise: unthrottled measurement measured pipeline queue depth,
 *   not pass cost, and reported "41.90 ms" beside a felt frame time of 8.40 ms.
 *
 * @module tools/shader-lab/bench-fire
 */
import { registerBench, evaluate, check, saveCanvasPng } from './contract.js';
import { fbmFloat } from '../../src/effects/lighting/animations/tsl-noise-toolkit.js';
import { medianOf, percentileOf } from '../../src/diag/gpu-probe.js';
// THE REAL PRODUCTION CODE, imported and never transcribed (AGENTS.md §6).
import { computeCameraFrustum } from '../../src/scene/world-quad.js';
import { createWindHandle } from '../../src/world/index.js';
import {
  fireScaleChain,
  fireSlabPlan,
  fireSliceTable,
  computeFireQuadArrays,
  fireQuadSizePx,
} from '../../src/effects/fire/fire-geometry.js';
import { buildFireMaterial, buildFireGeometry } from '../../src/effects/fire/fire-render.js';
import {
  FLAME_ARCHETYPES,
  buildFlameShapeAlpha,
  buildFlameShading,
  buildLifeFade,
} from '../../src/effects/fire/fire-sprite.js';

/** Render dimension for every probe. 1024² = 1.048576 Mpx, so ms ≈ ms/Mpx. */
const DIM = 1024;
const MEGAPIXELS = (DIM * DIM) / 1e6;

/** How many independent fBm evaluations each probe fragment sums. */
const REPEATS = 8;

/** Discarded renders before sampling starts (shader compile, pipeline warm). */
const WARMUP_FRAMES = 12;
/** Timed renders per variant. Median of these is the reading. */
const SAMPLE_FRAMES = 40;

/** Spatial frequency of the probe field — arbitrary, but identical everywhere. */
const SPACE_FREQ = 6.0;

/**
 * Six octaves is exactly twice the lattice hashes of three. If the timer cannot
 * see THAT, it cannot see anything, and this is the ratio that says so.
 * Set well below the theoretical 2.0 so ordinary measurement slop passes.
 */
const VACUITY_MIN_RATIO = 1.5;

/**
 * Verdict thresholds for `live-z / const-z`.
 * Below FREE  → the third axis costs nothing (both already run 8 corners).
 * Above FOLDS → the constant z was being folded to 4 corners; fire pays double.
 * Between     → INCONCLUSIVE, reported as UNMEASURED, never rounded to a story.
 */
const RATIO_FREE_BELOW = 1.35;
const RATIO_FOLDS_ABOVE = 1.6;

export function createFireBench({ THREE, log }) {
  let renderer = null;
  let rt = null;
  let scene = null;
  let camera = null;
  let mesh = null;
  let timestampSupport = null;
  const viewCanvas = document.getElementById('fireView') ?? null;

  /**
   * ⚠️ `trackTimestamp` IS CONSTRUCTOR-ONLY (three.webgpu.js:64637) and defaults
   * to false; `WebGPUBackend.init` then ANDs it with the adapter's
   * `timestamp-query` feature (:75258). A renderer built without the flag can
   * never be armed afterwards. Every other bench in this lab constructs without
   * it — correctly, since none of them measure time — which is exactly why this
   * one needs its own renderer rather than borrowing one.
   */
  async function ensureRenderer() {
    if (renderer) return;
    renderer = new THREE.WebGPURenderer({ antialias: false, trackTimestamp: true });
    await renderer.init();

    const backend = renderer.backend ?? null;
    const capable = backend?.trackTimestamp === true;
    timestampSupport = {
      capable,
      backend: backend?.isWebGPUBackend ? 'webgpu' : 'webgl2',
      reason: capable
        ? null
        : 'trackTimestamp is false after init(). The flag WAS requested at construction here, so this ' +
          'adapter genuinely lacks the timestamp-query feature. Every timing check in this bench will ' +
          'report UNMEASURED — which is the correct outcome, not a failure.',
    };
    log?.(`fire bench renderer: ${timestampSupport.backend}, timestamp-query ${capable ? 'AVAILABLE' : 'UNAVAILABLE'}`);

    rt = new THREE.RenderTarget(DIM, DIM, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
    });
    rt.texture.minFilter = THREE.NearestFilter;
    rt.texture.magFilter = THREE.NearestFilter;

    scene = new THREE.Scene();
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.NodeMaterial());
    mesh.frustumCulled = false;
    scene.add(mesh);
  }

  /**
   * THE THREE VARIANTS, and they differ in exactly one expression.
   *
   * The xy perturbation per repeat is IDENTICAL across modes — only the way the
   * third coordinate is constructed changes. Anything else differing would make
   * the ratio a measurement of that difference instead.
   *
   * @param {'vec2'|'constZ'|'liveZ'} mode
   * @param {number} octaves
   * @returns {{material: object, uTime: object}}
   */
  function buildProbeMaterial(mode, octaves) {
    const { Fn, vec2, vec3, vec4, float, uv, uniform } = THREE.TSL;
    const uTime = uniform(float(0));

    const material = new THREE.NodeMaterial();
    material.transparent = false;
    material.depthTest = false;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.fragmentNode = Fn(() => {
      const p = uv().mul(float(SPACE_FREQ));
      let acc = float(0);
      for (let i = 0; i < REPEATS; i++) {
        // Distinct per repeat, or the compiler collapses all REPEATS into one.
        const q = p.add(vec2(float(i * 0.137), float(i * 0.219)));
        let arg;
        if (mode === 'vec2') {
          // What ~40 existing src/ call sites do. Silently padded to vec3(q, 0).
          arg = q;
        } else if (mode === 'constZ') {
          // The same thing, written out. Should be identical to 'vec2'.
          arg = vec3(q, float(0));
        } else {
          // What the slab integral needs: a genuinely live third coordinate.
          arg = vec3(q, uTime.add(float(i * 0.311)));
        }
        acc = acc.add(fbmFloat(THREE.TSL, arg, { octaves }));
      }
      // Consumed, or it is dead code and compiles away entirely.
      const v = acc
        .mul(float(1 / REPEATS))
        .mul(float(0.5))
        .add(float(0.5));
      return vec4(v, v, v, float(1));
    })();
    return { material, uTime };
  }

  /**
   * Render ONE frame of a prepared variant and return its GPU pass time.
   *
   * `renderer.info.render.timestamp` is the sum of this frame's timestamped
   * render passes (three.webgpu.js:65119). One pass per frame here, so it IS
   * that pass's duration.
   *
   * @returns {Promise<number|null>}
   */
  async function renderOnce(variant, frame) {
    // Advance the live coordinate so 'liveZ' can never be constant-folded
    // across frames either.
    variant.uTime.value = frame * 0.01;
    mesh.material = variant.material;
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    // Awaiting here is the point: it serialises CPU and GPU so the reading is
    // pass cost, not queue depth. See this file's header.
    await renderer.resolveTimestampsAsync('render');
    const ms = renderer.info?.render?.timestamp;
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }

  /**
   * MEASURE SEVERAL VARIANTS AGAINST EACH OTHER, round-robin.
   *
   * Every variant is rendered once per round, so GPU clock ramp, thermal drift
   * and scheduler noise move all of them together and cancel in the ratio —
   * which is the only quantity this bench actually reports. See the header's
   * measurement-hygiene note for the 25% error the block layout produced.
   *
   * `spread` (p95/p50) is returned per variant as the run's own honesty check:
   * a variant whose spread is far above 1 was not measured on a settled GPU,
   * whatever its median says.
   *
   * @param {Array<{key: string, mode: string, octaves: number}>} specs
   * @returns {Promise<Record<string, {p50,p95,min,spread,samples}>|null>}
   */
  async function measureVariants(specs) {
    await ensureRenderer();
    if (!timestampSupport.capable) return null;

    const variants = specs.map((s) => ({ ...s, ...buildProbeMaterial(s.mode, s.octaves), samples: [] }));
    const previous = mesh.material;

    for (let frame = 0; frame < WARMUP_FRAMES + SAMPLE_FRAMES; frame++) {
      for (const v of variants) {
        const ms = await renderOnce(v, frame);
        if (frame >= WARMUP_FRAMES && ms !== null) v.samples.push(ms);
      }
    }

    mesh.material = previous;
    const out = {};
    for (const v of variants) {
      v.material.dispose();
      if (v.samples.length === 0) {
        out[v.key] = null;
        continue;
      }
      const p50 = medianOf(v.samples);
      const p95 = percentileOf(v.samples, 0.95);
      out[v.key] = {
        p50,
        p95,
        min: Math.min(...v.samples),
        spread: Number((p95 / Math.max(p50, 1e-6)).toFixed(3)),
        samples: v.samples.length,
      };
    }
    return out;
  }

  /** Paint the last probe to the visible canvas so the pane shows something real. */
  async function paintProbe(mode, octaves) {
    if (!viewCanvas) return;
    await ensureRenderer();
    const { material, uTime } = buildProbeMaterial(mode, octaves);
    const previous = mesh.material;
    mesh.material = material;
    uTime.value = 0.42;
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);

    const buf = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, DIM, DIM);
    const raw = buf instanceof Promise ? await buf : buf;
    const bytes = ArrayBuffer.isView(raw) ? new Uint8ClampedArray(raw.buffer ?? raw) : new Uint8ClampedArray(raw);
    const ctx = viewCanvas.getContext('2d');
    if (ctx && bytes.length >= DIM * DIM * 4) {
      const img = new ImageData(bytes.slice(0, DIM * DIM * 4), DIM, DIM);
      const tmp = document.createElement('canvas');
      tmp.width = DIM;
      tmp.height = DIM;
      tmp.getContext('2d').putImageData(img, 0, 0);
      ctx.clearRect(0, 0, viewCanvas.width, viewCanvas.height);
      ctx.drawImage(tmp, 0, 0, viewCanvas.width, viewCanvas.height);
    }
    mesh.material = previous;
    material.dispose();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // THE FIRE STAGE — real geometry, real material, real production camera
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * ⚠️ THE FIRE SITS OFF-CENTRE IN Y, DELIBERATELY.
   *
   * A Y-CENTRED FIXTURE CANNOT CALIBRATE A Y-FLIP. This lab has been bitten
   * twice — `bench-floor-lighting.js` had a Y-centred footprint whose every
   * orientation probe was invariant, so `calibrate` passed while telling you
   * nothing; `bench-block-compress.js` had a centred disc and reported
   * `mismatchesSameOrder: 0, mismatchesFlipped: 0`. A plume is the one thing in
   * this project with an unmistakable up, so it is worth putting somewhere the
   * answer can actually be read.
   */
  const STAGE_DIM = 1024;
  const STAGE_WORLD = Object.freeze({ minX: 0, minY: 0, maxX: 4096, maxY: 4096 });
  const FIRE_AT = Object.freeze({ x: 2048, y: 2600 });

  let stage = null;
  /** World rect currently framed. Changing it re-frames the camera, as a zoom would. */
  let framedWorld = STAGE_WORLD;

  /**
   * Re-frame the camera on a sub-rect of the world — the rig's zoom. Goes
   * through the REAL `computeCameraFrustum` so a zoomed frame flips Y exactly
   * the way production does, rather than through a second hand-rolled mapping
   * that could disagree with it.
   */
  function frameWorld(rect) {
    framedWorld = rect;
    const f = computeCameraFrustum(rect);
    stage.camera.left = f.left;
    stage.camera.right = f.right;
    stage.camera.top = f.top;
    stage.camera.bottom = f.bottom;
    stage.camera.updateProjectionMatrix();
  }

  /** A square world rect of `spanPx` centred on the fire. */
  function rectAroundFire(spanPx) {
    const h = spanPx / 2;
    return { minX: FIRE_AT.x - h, minY: FIRE_AT.y - h, maxX: FIRE_AT.x + h, maxY: FIRE_AT.y + h };
  }

  async function ensureStage() {
    await ensureRenderer();
    if (stage) return stage;
    const scene = new THREE.Scene();
    // The REAL frustum builder, so the Y-flip here is production's Y-flip.
    // `computeCameraFrustum` sets `top = worldRect.minY`, which is the single
    // place the whole renderer flips Y.
    const f = computeCameraFrustum(STAGE_WORLD);
    const camera = new THREE.OrthographicCamera(f.left, f.right, f.top, f.bottom, -1, 1);
    camera.updateProjectionMatrix();
    // ⚠️ HALF-FLOAT, MATCHING PRODUCTION'S `buf:scene.lit` — AND IT USED TO NOT
    // BE, WHICH MADE THIS BENCH LIE ABOUT EVERY HIGHLIGHT IT EVER RENDERED.
    // `describeSceneColor()` (vt-pan-viewer.js) is `THREE.HalfFloatType`: the
    // real buffer fire draws into is HDR and stores radiance above 1.0 happily,
    // which is exactly what makes a flame core bright enough to trip bloom's
    // threshold. This target was `UnsignedByteType` — it CLAMPED at 1.0, so the
    // hottest part of every fire flattened to a single saturated value here and
    // nowhere else. That artifact is why `FLAME_RADIANCE_GAIN` was lowered
    // 2.4 → 1.25 on 2026-08-08 to "stop the core blowing out into a flat disc":
    // the blowout was this render target, not the shader, and the fix made the
    // LIVE fire too dim to bloom at all.
    // `feedback_bench_must_build_inputs_like_production`, on the one property
    // nobody thought to check because it is a target format rather than an input.
    const target = new THREE.RenderTarget(STAGE_DIM, STAGE_DIM, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
    });
    target.texture.minFilter = THREE.NearestFilter;
    target.texture.magFilter = THREE.NearestFilter;
    stage = { scene, camera, target, mesh: null };
    return stage;
  }

  /**
   * Build and draw ONE fire through the real production path, and read the
   * frame back.
   *
   * @returns {Promise<{pixels: Uint8ClampedArray, gpuMs: number|null, plan: object, slices: number}>}
   */
  async function renderFire({
    diameterPx = 300,
    tier = 3,
    coverageRung = 3,
    posterize = 0.85,
    intensity = 1,
    fuel = 'wood',
    mPerPx = 0.01524,
    timeMs = 1234,
    samples = 1,
    wind = false,
    frameSpanPx = null,
    // THE MASK CLIP (2026-08-08) — `maskClip` is the per-fire vertex flag
    // (`fireParams.w`); `maskGrid` is a plain CPU shape `{data, w, h, rect}`
    // (RGBA Uint8Array, same shape `bakeFireMaskTexture` produces in
    // vt-pan-viewer.js) baked into a REAL DataTexture here so the scenario
    // exercises the exact `maskTexNode.sample(...)` code path production uses,
    // not a stand-in. `maskClip: true` with `maskGrid: null` is deliberately
    // allowed (asserts the fail-open default), same for the reverse.
    maskClip = false,
    maskGrid = null,
  } = {}) {
    const st = await ensureStage();
    const { uniform, float } = THREE.TSL;
    frameWorld(frameSpanPx ? rectAroundFire(frameSpanPx) : STAGE_WORLD);

    const chain = fireScaleChain(diameterPx, mPerPx, { fuel, intensity });
    const plan = fireSlabPlan(tier, coverageRung);
    const slices = fireSliceTable(plan, chain);
    const quadHalfPx = fireQuadSizePx(chain) / 2;

    const arrays = computeFireQuadArrays(
      [
        {
          x: FIRE_AT.x,
          y: FIRE_AT.y,
          diameterPx,
          intensity,
          fuel,
          windExposure: 1,
          expectedDepth: 0,
          color: '#FDBA35',
          maskClip,
        },
      ],
      { mPerPx }
    );

    const uGlobalTimeMs = uniform(float(timeMs));
    // ⚠️ THE NO-WIND CASE IS NOT THE INTERESTING ONE, and that is a fact about
    // the model rather than about the rig. With zero wind a plume rises
    // straight up, so from directly overhead the smoke sits exactly ON the
    // flame and the correct picture IS mostly smoke. The reference image shows
    // smoke crowning ONE SIDE — that is the SHEARED case, and it only exists
    // when there is wind. Scenarios that judge the look must pass `wind: true`.
    // ⚠️ `ambientWind`'s FIELDS ARE TSL NODES, NOT JS NUMBERS. `sampleWind`
    // does `wind.directionDeg.mul(...)` (wind-field.js:811), so a plain
    // `{directionDeg: 120}` has no `.mul` and the material builds to garbage —
    // it rendered a completely BLACK frame with no thrown error, which is
    // exactly what a wrong-shaped seam looks like from outside.
    const windHandle = wind
      ? createWindHandle({ ambientWind: { directionDeg: uniform(float(120)), speed01: uniform(float(0.55)) } })
      : null;
    let maskTexNode = null;
    let uMaskRect = null;
    if (maskGrid) {
      const tex = new THREE.DataTexture(
        maskGrid.data,
        maskGrid.w,
        maskGrid.h,
        THREE.RGBAFormat,
        THREE.UnsignedByteType
      );
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      maskTexNode = THREE.TSL.texture(tex);
      uMaskRect = uniform(
        THREE.TSL.vec4(maskGrid.rect.minX, maskGrid.rect.minY, maskGrid.rect.maxX, maskGrid.rect.maxY)
      );
    }

    const built = buildFireMaterial({
      THREE,
      uGlobalTimeMs,
      slabPlan: plan,
      sliceTable: slices,
      chain,
      quadHalfPx,
      windHandle,
      maskTexNode,
      uMaskRect,
    });
    built.uPosterize.value = posterize;

    const { geometry } = buildFireGeometry({ THREE, arrays });
    if (st.mesh) {
      st.scene.remove(st.mesh);
      st.mesh.geometry.dispose();
      st.mesh.material.dispose();
    }
    st.mesh = new THREE.Mesh(geometry, built.material);
    st.mesh.frustumCulled = false;
    st.scene.add(st.mesh);

    let gpuMs = null;
    for (let i = 0; i < Math.max(1, samples); i++) {
      renderer.setRenderTarget(st.target);
      renderer.setClearColor(new THREE.Color(0, 0, 0), 1);
      renderer.clear();
      renderer.render(st.scene, st.camera);
      renderer.setRenderTarget(null);
      if (timestampSupport?.capable) {
        await renderer.resolveTimestampsAsync('render');
        const ms = renderer.info?.render?.timestamp;
        if (Number.isFinite(ms) && ms > 0) gpuMs = ms;
      }
    }

    const buf = await renderer.readRenderTargetPixelsAsync(st.target, 0, 0, STAGE_DIM, STAGE_DIM);
    const raw = buf instanceof Promise ? await buf : buf;
    const pixels = decodeHdrReadback(raw);
    return { pixels, gpuMs, plan, slices: slices.length, chain, quadHalfPx };
  }

  /**
   * A half-float readback → a Float32Array in "255 = 1.0" units, UNCLAMPED.
   *
   * ⚠️ THE UNITS ARE DELIBERATELY 0..255-SCALED RATHER THAN 0..1, and the
   * UNCLAMPED part is the whole point. Keeping the familiar scale means every
   * existing check that compares against a byte value still reads the same, but
   * a flame core at 2.4× white now reports 612 instead of silently saturating
   * at 255 — which is precisely the information this bench was destroying when
   * its target was `UnsignedByteType` (see `ensureStage`'s note). Bloom's
   * threshold lives in 0..1 radiance, so "does this fire bloom" is now a
   * question this bench can actually answer: `maxLuma / 255 > threshold`.
   */
  function decodeHdrReadback(raw) {
    const out = new Float32Array(STAGE_DIM * STAGE_DIM * 4);
    if (!ArrayBuffer.isView(raw)) return out;
    // The WebGPU backend hands back a Uint16Array of IEEE-754 half floats for a
    // HalfFloatType target; anything else is already float-ish and passes through.
    if (raw instanceof Uint16Array) {
      for (let i = 0; i < out.length && i < raw.length; i++) out[i] = halfToFloat(raw[i]) * 255;
      return out;
    }
    for (let i = 0; i < out.length && i < raw.length; i++) {
      // A byte readback is already 0..255; a Float32 one is 0..1 radiance.
      out[i] = raw instanceof Float32Array ? raw[i] * 255 : raw[i];
    }
    return out;
  }

  /** IEEE-754 binary16 → Number. */
  function halfToFloat(h) {
    const sign = (h & 0x8000) >> 15;
    const exp = (h & 0x7c00) >> 10;
    const frac = h & 0x03ff;
    let v;
    if (exp === 0) v = frac * 2 ** -24;
    else if (exp === 0x1f) v = frac ? NaN : Infinity;
    else v = (frac / 1024 + 1) * 2 ** (exp - 15);
    return sign ? -v : v;
  }

  /**
   * HDR float pixels → 8-bit for a PNG or the canvas.
   *
   * ⚠️ TONE-MAPPED, NOT CLAMPED, and that distinction is the reason this
   * function exists rather than a `Math.min(255, v)`. A hard clamp is what the
   * old byte target did, and it is exactly what hid the highlight structure —
   * everything above 1.0 became the same white and the posterized bands in the
   * core were indistinguishable from a blowout. Reinhard keeps them ordered and
   * visible, so what is SAVED is an honest picture of what production's own
   * tone-mapped present pass will do with the same radiance.
   */
  function toDisplay8(pixels) {
    const out = new Uint8ClampedArray(STAGE_DIM * STAGE_DIM * 4);
    for (let i = 0; i < out.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const lin = Math.max(0, pixels[i + c] / 255);
        // ⚠️ PLAIN REINHARD, NO OUTPUT GAIN. The first version multiplied by 2
        // "so it isn't too dark", which put every radiance above 1.0 at or past
        // white — i.e. it re-introduced the exact clipping this whole HDR change
        // was made to remove, and the first render read as a featureless
        // saturated disc with all the lobe structure clipped away. A display
        // transform for INSPECTION must be monotonic over the entire range it
        // is asked to show; brightness is what the eye adapts to, clipping is
        // information that no longer exists.
        out[i + c] = Math.round(255 * (lin / (1 + lin)));
      }
      out[i + 3] = 255;
    }
    return out;
  }

  /**
   * Paint a readback to the visible canvas.
   *
   * ⚠️ `readRenderTargetPixelsAsync` returns rows BOTTOM-UP (GL convention)
   * while `putImageData` expects them top-down, so this flips. The flip is
   * applied here, once, at the display boundary — never inside a measurement,
   * where it would silently invert every coordinate-dependent number.
   */
  function paintPixels(pixels, label) {
    if (!viewCanvas) return;
    const ctx = viewCanvas.getContext('2d');
    if (!ctx) return;
    const display = toDisplay8(pixels);
    const flipped = new Uint8ClampedArray(STAGE_DIM * STAGE_DIM * 4);
    const rowBytes = STAGE_DIM * 4;
    for (let y = 0; y < STAGE_DIM; y++) {
      flipped.set(display.subarray((STAGE_DIM - 1 - y) * rowBytes, (STAGE_DIM - y) * rowBytes), y * rowBytes);
    }
    const tmp = document.createElement('canvas');
    tmp.width = STAGE_DIM;
    tmp.height = STAGE_DIM;
    tmp.getContext('2d').putImageData(new ImageData(flipped, STAGE_DIM, STAGE_DIM), 0, 0);
    ctx.clearRect(0, 0, viewCanvas.width, viewCanvas.height);
    ctx.drawImage(tmp, 0, 0, viewCanvas.width, viewCanvas.height);
    const el = document.getElementById('fireLegend');
    if (el && label) el.textContent = label;
  }

  /** Save a readback as a PNG artifact, flipped to top-down for a human reader. */
  async function savePixels(runId, file, pixels) {
    const tmp = document.createElement('canvas');
    tmp.width = STAGE_DIM;
    tmp.height = STAGE_DIM;
    // HDR floats → tone-mapped bytes BEFORE the row flip, so the flip stays a
    // pure memory operation on the format `ImageData` actually takes.
    const display = toDisplay8(pixels);
    const flipped = new Uint8ClampedArray(STAGE_DIM * STAGE_DIM * 4);
    const rowBytes = STAGE_DIM * 4;
    for (let y = 0; y < STAGE_DIM; y++) {
      flipped.set(display.subarray((STAGE_DIM - 1 - y) * rowBytes, (STAGE_DIM - y) * rowBytes), y * rowBytes);
    }
    tmp.getContext('2d').putImageData(new ImageData(flipped, STAGE_DIM, STAGE_DIM), 0, 0);
    return saveCanvasPng(runId, file, tmp);
  }

  /**
   * World (x,y) → an index into a BOTTOM-UP readback. Routed through one helper
   * so no scenario ever hand-picks a raw `(x,y)` — the trap
   * `bench-floor-lighting.js` records as its first of three.
   */
  function sampleAt(pixels, worldX, worldY) {
    const u = (worldX - framedWorld.minX) / (framedWorld.maxX - framedWorld.minX);
    const v = (worldY - framedWorld.minY) / (framedWorld.maxY - framedWorld.minY);
    const px = Math.round(clamp01(u) * (STAGE_DIM - 1));
    // Production's camera puts world minY at the TOP of the frame; the readback
    // is bottom-up. The two flips compose to "v maps straight to the row".
    const py = Math.round(clamp01(v) * (STAGE_DIM - 1));
    const i = (py * STAGE_DIM + px) * 4;
    return { r: pixels[i], g: pixels[i + 1], b: pixels[i + 2], a: pixels[i + 3], px, py };
  }

  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }

  /** Total lit energy and its centroid — the two numbers most shape checks need. */
  function frameStats(pixels) {
    let sum = 0;
    let sx = 0;
    let sy = 0;
    let lit = 0;
    let maxL = 0;
    for (let y = 0; y < STAGE_DIM; y++) {
      for (let x = 0; x < STAGE_DIM; x++) {
        const i = (y * STAGE_DIM + x) * 4;
        const l = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
        if (l > 6) lit++;
        if (l > maxL) maxL = l;
        sum += l;
        sx += x * l;
        sy += y * l;
      }
    }
    // Readback rows are bottom-up; convert the centroid row to world v so the
    // caller can reason in production coordinates.
    const cyRow = sum > 0 ? sy / sum : 0;
    return {
      meanLuma: Number((sum / (STAGE_DIM * STAGE_DIM)).toFixed(4)),
      litFraction: Number((lit / (STAGE_DIM * STAGE_DIM)).toFixed(5)),
      maxLuma: maxL,
      centroidWorldX: sum > 0 ? framedWorld.minX + (sx / sum / STAGE_DIM) * (framedWorld.maxX - framedWorld.minX) : 0,
      centroidWorldY: framedWorld.minY + (cyRow / STAGE_DIM) * (framedWorld.maxY - framedWorld.minY),
    };
  }

  const scenarios = new Map();

  // ───────────────────────────────────────────────────────────────────────────
  // THE SPRITE — V2's four bird's-eye archetypes, judged before anything is
  // wired. `src/effects/fire/fire-sprite.js` is where the look lives; if these
  // pictures do not convince, nothing built on top of them will.
  // ───────────────────────────────────────────────────────────────────────────

  /** Its own stage: ONE sprite filling the frame, no world rect, no camera flip
   * to reason about — this asks what the shape looks like, nothing else. */
  let spriteStage = null;
  async function ensureSpriteStage() {
    await ensureRenderer();
    if (spriteStage) return spriteStage;
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    camera.updateProjectionMatrix();
    // HalfFloat, matching production's `buf:scene.lit` — see `ensureStage`'s
    // own note on why a byte target here lied about every highlight.
    const target = new THREE.RenderTarget(STAGE_DIM, STAGE_DIM, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
    });
    target.texture.minFilter = THREE.NearestFilter;
    target.texture.magFilter = THREE.NearestFilter;
    spriteStage = { scene, camera, target, mesh: null };
    return spriteStage;
  }

  /**
   * Draw one archetype, full-frame, at one phase and one age.
   * @returns {Promise<Float32Array>} HDR pixels in "255 = 1.0" units.
   */
  async function renderSprite({ archetype, phase = 0, t01 = 0.12, temperature = 0.85, heat = 1, brightness = 1 }) {
    const st = await ensureSpriteStage();
    const { Fn, uv, float, uniform } = THREE.TSL;
    const uPhase = uniform(float(phase));
    const uT = uniform(float(t01));

    const material = new THREE.NodeMaterial();
    const shade = buildFlameShading(THREE.TSL, {
      t01: uT,
      heat: float(heat),
      brightness: float(brightness),
      temperature,
    });
    material.colorNode = Fn(() => shade.rgb)();
    material.opacityNode = Fn(() => {
      const shape = buildFlameShapeAlpha(THREE.TSL, {
        nx: uv().x,
        ny: uv().y,
        phase: uPhase,
        seed: float(0),
        archetype,
      });
      return shape.mul(shade.alpha).mul(buildLifeFade(THREE.TSL, uT, 0.14, 0.16));
    })();
    material.transparent = true;
    material.depthTest = false;
    material.depthWrite = false;
    // ⚠️ The silent-black trap — FrontSide culls the whole quad with no error.
    material.side = THREE.DoubleSide;
    material.blending = THREE.AdditiveBlending;
    material.toneMapped = false;

    if (st.mesh) {
      st.scene.remove(st.mesh);
      st.mesh.geometry.dispose();
      st.mesh.material.dispose();
    }
    st.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    st.mesh.frustumCulled = false;
    st.scene.add(st.mesh);

    renderer.setRenderTarget(st.target);
    renderer.setClearColor(new THREE.Color(0, 0, 0), 1);
    renderer.clear();
    renderer.render(st.scene, st.camera);
    renderer.setRenderTarget(null);
    const buf = await renderer.readRenderTargetPixelsAsync(st.target, 0, 0, STAGE_DIM, STAGE_DIM);
    return decodeHdrReadback(buf instanceof Promise ? await buf : buf);
  }

  scenarios.set('sprite-archetypes', {
    name: 'sprite-archetypes',
    summary:
      "V2's four bird's-eye flame archetypes, ported to per-fragment TSL, one PNG each at peak emission. " +
      'This is the look question, and it asserts almost nothing on purpose — the numbers here only catch a ' +
      "shape that failed to compile or came out empty. Taste is the author's.",
    async run({ runId }) {
      const artifacts = [];
      const checks = [];
      const stats = {};
      for (const archetype of FLAME_ARCHETYPES) {
        // t01 = 0.12 is the ignition pop — peak emission, the frame that has to
        // carry the effect.
        const pixels = await renderSprite({ archetype, phase: 0.7, t01: 0.12 });
        const s = frameStats(pixels);
        stats[archetype] = { maxLuma: Number(s.maxLuma.toFixed(1)), litFraction: s.litFraction };
        const png = await savePixels(runId, `sprite-${archetype}.png`, pixels);
        if (png) artifacts.push(png);
        // The only real assertion: it drew SOMETHING with fire's own chroma.
        checks.push(
          evaluate(`${archetype}-drew-a-shape`, () => ({
            ok: s.litFraction > 0.005 && s.litFraction < 0.95 && s.maxLuma > 40,
            measured: stats[archetype],
            expected: 'a non-empty, non-full-frame shape with real brightness',
            note: 'A zero here is a compile failure or a culled quad, not a taste problem. Read the PNG.',
          }))
        );
      }
      paintPixels(await renderSprite({ archetype: 'vortexSwirl', phase: 0.7, t01: 0.12 }), 'sprite — vortexSwirl');
      checks.push(
        check({
          id: 'which-archetype-reads-as-fire-is-the-authors-call',
          status: 'UNMEASURED',
          expected: 'the author, against the reference art',
          note: 'Four PNGs saved. The bench can prove they compile and are non-empty; it cannot prove they look like fire.',
        })
      );
      return { checks, artifacts, inputs: { archetypes: FLAME_ARCHETYPES, phase: 0.7, t01: 0.12 }, stats };
    },
  });

  scenarios.set('sprite-animation', {
    name: 'sprite-animation',
    summary:
      'One archetype across a full phase cycle plus a full life, to answer the two questions a still cannot: ' +
      'does the shape MORPH (rather than merely rotate), and does the ignition pop actually read?',
    async run({ runId }) {
      const artifacts = [];
      const archetype = 'vortexSwirl';
      const phases = [0, 1.57, 3.14, 4.71];
      const frames = [];
      for (const phase of phases) {
        const pixels = await renderSprite({ archetype, phase, t01: 0.12 });
        frames.push(pixels);
        const png = await savePixels(runId, `anim-phase-${phase.toFixed(2)}.png`, pixels);
        if (png) artifacts.push(png);
      }
      // Emission across life — the 0 → 4.0 pop in the first 12%.
      const lifeLuma = [];
      for (const t01 of [0.02, 0.12, 0.35, 0.7, 0.95]) {
        const pixels = await renderSprite({ archetype, phase: 0.7, t01 });
        lifeLuma.push({ t01, maxLuma: Number(frameStats(pixels).maxLuma.toFixed(1)) });
        const png = await savePixels(runId, `anim-life-${String(t01).replace('.', 'p')}.png`, pixels);
        if (png) artifacts.push(png);
      }

      // A shape that only ROTATES has the same lit area at every phase; one that
      // genuinely morphs does not. Cheap, but it separates the two cases.
      //
      // ⚠️ ONLY TWO OF THE FOUR ARE SUPPOSED TO MORPH, AND THE FIRST VERSION OF
      // THIS CHECK DID NOT KNOW THAT — it tested `vortexSwirl` alone and failed
      // it at 0.9% spread. That was the test being wrong, not the shape:
      // `vortexSwirl` and `convectionCrescent` feed phase ONLY into a rotation
      // angle, and a rotation preserves area exactly, by construction. The two
      // that pipe phase into their NOISE DOMAIN (`plasmaCore`, `thermalRing` —
      // via V2's `_fireAtlasAnimDrift` tX/tY) are the ones whose silhouette
      // genuinely changes. Both behaviours are V2's, deliberately: a fire made
      // only of morphing blobs boils, and one made only of rotators spins.
      // ⚠️ `vortexSwirl` MOVED FROM ROTATING TO MORPHING ON 2026-08-09, and that
      // is a deliberate look change rather than a drifted number. V2's version
      // was provably 2-fold symmetric (its twist depends only on radius, so
      // `alpha(p) == alpha(−p)` exactly) and the author called it on sight:
      // *"too symmetrical. It's a spiral and might look odd."* It now carries a
      // low-frequency domain warp and an asymmetric lobe bias, so its silhouette
      // genuinely changes with phase. `convectionCrescent` is the last true
      // rotator — its warp rides the alpha, not the domain.
      const MORPHING = ['plasmaCore', 'thermalRing', 'vortexSwirl'];
      const ROTATING = ['convectionCrescent'];
      const spreadOf = async (kind) => {
        const areas = [];
        for (const phase of phases) areas.push(frameStats(await renderSprite({ archetype: kind, phase })).litFraction);
        return { kind, areas, spread: (Math.max(...areas) - Math.min(...areas)) / Math.max(1e-6, Math.max(...areas)) };
      };
      const morphSpreads = [];
      for (const kind of [...MORPHING, ...ROTATING]) morphSpreads.push(await spreadOf(kind));
      const morphing = morphSpreads.filter((m) => MORPHING.includes(m.kind));
      const rotating = morphSpreads.filter((m) => ROTATING.includes(m.kind));

      return {
        checks: [
          evaluate('the-domain-warped-archetypes-genuinely-morph', () => ({
            ok: morphing.every((m) => m.spread > 0.02),
            measured: morphing.map((m) => ({ kind: m.kind, spread: Number(m.spread.toFixed(4)) })),
            expected: 'plasmaCore and thermalRing vary their lit area > 2% across a phase cycle',
            note: 'These two pipe the phase into their noise domain, so the silhouette itself changes.',
          })),
          evaluate('the-rotating-archetypes-hold-their-area', () => ({
            ok: rotating.every((m) => m.spread < 0.05),
            measured: rotating.map((m) => ({ kind: m.kind, spread: Number(m.spread.toFixed(4)) })),
            expected: 'convectionCrescent and vortexSwirl preserve area (< 5%) — they rotate, by design',
            note: 'Pinned so a future "fix" that makes everything morph is caught as the look change it is.',
          })),
          evaluate('the-ignition-pop-is-the-brightest-moment', () => ({
            ok: lifeLuma[1].maxLuma >= Math.max(...lifeLuma.map((l) => l.maxLuma)) - 1e-3,
            measured: { lifeLuma },
            expected: 'peak brightness at t=0.12, per FLAME_EMISSION_STOPS',
            note: 'The 0 → 4.0 spike in the first 12% of life is what reads as catching fire.',
          })),
        ],
        artifacts,
        inputs: { archetype, phases },
        stats: { lifeLuma, morphSpreads },
      };
    },
  });

  scenarios.set('particles-draw', {
    name: 'particles-draw',
    summary:
      'Stands the fire particle engine up on the real GPU: builds it, feeds it a painted spawn cloud, ' +
      'dispatches the compute kernel, and draws. Exists because NOTHING in the Node suite can run a TSL ' +
      'compute kernel — the whole simulation could fail to compile and 8,000 tests would stay green.',
    async run({ runId }) {
      const st = await ensureStage();
      const { createFireParticleEngine } = await import('../../src/effects/particles/particle-engine.js');
      const { extractFireSpawnPoints } = await import('../../src/effects/fire/fire-spawn-points.js');
      frameWorld(rectAroundFire(420));

      // ⚠️ A HEARTH-SIZED BLOB AT THE REAL DERIVATION RESOLUTION, because the
      // first version of this fixture was a ~960 px painted disc and that is why
      // this scenario looked fine while the live map did not. `real-fire-mask`
      // measures the author's actual hearths at 42-55 px across, on a grid whose
      // texels are ~20 world px — so a real fire is TWO OR THREE TEXELS, not
      // twenty-four. A fixture an order of magnitude larger than production
      // cannot see the density problem that only appears when every sprite lands
      // on top of every other one (`feedback_bench_must_build_inputs_like_production`).
      const N = 5;
      const texel = 20;
      const data = new Uint8Array(N * N);
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const dx = (x - N / 2) / (N * 0.22);
          const dy = (y - N / 2) / (N * 0.22);
          data[y * N + x] = dx * dx + dy * dy <= 1 ? 255 : 0;
        }
      }
      const grid = {
        spec: {
          x: FIRE_AT.x - (N * texel) / 2,
          y: FIRE_AT.y - (N * texel) / 2,
          width: N * texel,
          height: N * texel,
          w: N,
          h: N,
          texelW: texel,
          texelH: texel,
        },
        data,
      };
      const cloud = extractFireSpawnPoints(grid);

      const results = {};
      const artifacts = [];
      const checks = [];
      // ⚠️ FLAME AND EMBER TOGETHER, AT THE SUBSYSTEM'S OWN CAPACITIES AND SIZE
      // SCALE. Rendering flame alone is what hid the real problem: the author's
      // first live look reported *"the flames are all dots which are wobbling
      // around, they all have the same shape"* — which were the EMBERS
      // dominating, a mix question a single-layer scenario cannot ask.
      const spriteScale = Math.max(0.3, Math.min(2.5, (N * texel * 0.44) / 100));
      const built = [];
      let engine = null;
      let buildError = null;
      try {
        for (const spec of [
          { kind: 'flame', archetype: 'thermalRing', capacity: 48 },
          { kind: 'flame', archetype: 'plasmaCore', capacity: 48 },
          { kind: 'ember', archetype: null, capacity: 48 },
        ]) {
          const e = createFireParticleEngine({
            THREE,
            kind: spec.kind,
            archetype: spec.archetype,
            system: { id: `fire.${spec.kind}`, params: { capacity: spec.capacity } },
            worldRect: STAGE_WORLD,
            pxPerMeter: 100,
          });
          e.setSpawnPoints(cloud);
          // Per-FIRE active counts, matching the subsystem's own PER_FIRE table
          // — one hearth here, so one fire's worth of particles.
          e.setParams({
            intensity: 1,
            sizeScale: spec.kind === 'smoke' ? 1 : spriteScale,
            activeCount: spec.kind === 'ember' ? 10 : 12,
          });
          built.push(e);
        }
        engine = built[0];
        // Several steps so particles age, die and RESPAWN at least once — the
        // respawn path is where a bad buffer index or a NaN would first bite,
        // and a single step would never reach it.
        for (let i = 0; i < 12; i++) {
          for (const e of built) e.step(renderer, { dtSec: 0.05, tMs: 1000 + i * 50, worldRect: STAGE_WORLD });
        }
      } catch (err) {
        buildError = String(err?.message ?? err);
      }

      checks.push(
        evaluate('the-compute-kernel-builds-and-dispatches', () => ({
          ok: !buildError,
          measured: { error: buildError, state: engine?.debugState?.() ?? null },
          expected: 'createFireParticleEngine + 12 compute dispatches without throwing',
          note: 'A TSL compile error surfaces here and nowhere else — Node cannot run a kernel.',
        }))
      );

      if (engine && !buildError) {
        st.scene.clear();
        for (const e of built) st.scene.add(e.scene);
        renderer.setRenderTarget(st.target);
        renderer.setClearColor(new THREE.Color(0, 0, 0), 1);
        renderer.clear();
        renderer.render(st.scene, st.camera);
        renderer.setRenderTarget(null);
        const raw = await renderer.readRenderTargetPixelsAsync(st.target, 0, 0, STAGE_DIM, STAGE_DIM);
        const pixels = decodeHdrReadback(raw instanceof Promise ? await raw : raw);
        const s = frameStats(pixels);
        results.stats = s;
        results.debug = engine.debugState();
        paintPixels(pixels, `fire particles — flame/thermalRing, ${cloud.count} spawn points`);
        const png = await savePixels(runId, 'particles-flame.png', pixels);
        if (png) artifacts.push(png);

        checks.push(
          evaluate('particles-actually-drew', () => ({
            ok: s.litFraction > 0.001 && s.maxLuma > 20,
            measured: { litFraction: s.litFraction, maxLuma: Number(s.maxLuma.toFixed(1)) },
            expected: 'a non-empty frame',
            note: 'Zero here with a clean build means the DRAW is wrong (culling, blend, size), not the sim.',
          })),
          evaluate('particles-landed-on-the-painted-region', () => ({
            // The cloud is centred on the anchor, so the lit centroid should be
            // too. A large offset means the spawn buffer is being indexed or
            // unpacked wrongly — the single most likely failure in this wiring.
            ok: Math.hypot(s.centroidWorldX - FIRE_AT.x, s.centroidWorldY - FIRE_AT.y) < 260,
            measured: {
              centroid: [Math.round(s.centroidWorldX), Math.round(s.centroidWorldY)],
              anchor: [FIRE_AT.x, FIRE_AT.y],
            },
            expected: 'lit centroid within 260px of the painted blob',
          })),
          evaluate('the-spawn-cloud-reached-the-gpu', () => ({
            ok: (engine.debugState().spawnPoints ?? 0) > 0,
            measured: engine.debugState(),
            expected: 'a non-zero packed spawn-point count',
          }))
        );
      }

      return { checks, artifacts, inputs: { spawnPoints: cloud.count, capacity: 128 }, stats: results };
    },
  });

  scenarios.set('draws-at-all', {
    name: 'draws-at-all',
    summary:
      'The first honest question: does the real fire material compile and put light on the screen, in the ' +
      'right place, the right way up? Everything else in this bench is meaningless until this passes.',
    async run({ runId }) {
      const r = await renderFire({ diameterPx: 300, tier: 3, coverageRung: 3 });
      const s = frameStats(r.pixels);
      paintPixels(r.pixels, `fire — D=300px, tier 3, M=${r.plan.M}/N=${r.plan.N}, ${r.slices} slices`);
      const artifacts = [];
      const png = await savePixels(runId, 'fire-draws-at-all.png', r.pixels);
      if (png) artifacts.push(png);

      // The centre of the fire must be lit, and a far corner must not be. A
      // material that fails to compile renders nothing and every "is it shaped
      // right" check downstream would report a confident zero.
      const centre = sampleAt(r.pixels, FIRE_AT.x, FIRE_AT.y);
      const corner = sampleAt(r.pixels, STAGE_WORLD.minX + 40, STAGE_WORLD.minY + 40);

      return {
        checks: [
          evaluate('the-material-put-light-on-screen', () => ({
            ok: s.maxLuma > 24 && s.litFraction > 0.0005,
            measured: { maxLuma: s.maxLuma, litFraction: s.litFraction },
            expected: 'a non-trivial lit region',
            note: 'A zero here is a compile or blend failure, not a shape problem. Read the PNG.',
          })),
          evaluate('the-fire-is-lit-at-its-anchor', () => ({
            ok: centre.r + centre.g + centre.b > 60,
            measured: { r: centre.r, g: centre.g, b: centre.b },
            expected: 'the fire renders where the anchor is',
          })),
          evaluate('empty-space-stays-empty', () => ({
            ok: corner.r + corner.g + corner.b < 12,
            measured: { r: corner.r, g: corner.g, b: corner.b },
            expected: 'near-black far from the fire',
            note: 'Catches a quad whose soft edge never reaches zero — which reads as a visible rectangle.',
          })),
          // ⚠️ THIS CHECK USED TO BE `r >= g >= b`, AND IT PASSED GREY.
          // A render measuring (60, 56, 52) at the fire's own core satisfied
          // that ordering perfectly while looking like ash. An ordering test
          // cannot distinguish "warm" from "colourless" — it needs a MAGNITUDE.
          // Fire's defining colour property is a large red-blue separation, so
          // that is what gets measured (`feedback_instruments_must_not_lie`).
          evaluate('the-fire-core-is-strongly-chromatic', () => {
            const chroma = (centre.r - centre.b) / Math.max(centre.r, 1);
            return {
              ok: centre.r >= centre.g && centre.g >= centre.b && chroma > 0.45,
              measured: { r: centre.r, g: centre.g, b: centre.b, chroma: Number(chroma.toFixed(3)) },
              expected: 'r >= g >= b AND (r−b)/r > 0.45',
              note: 'A (60,56,52) grey satisfies the ordering and is not fire. The magnitude is the test.',
            };
          }),
          // ⚠️ THE Y-FLIP PROBE. The fire is deliberately off-centre in Y, so
          // its lit centroid has ONE correct answer and a flipped frame has a
          // measurably different one. A Y-centred fixture could not resolve this.
          evaluate('the-frame-is-not-y-flipped', () => {
            const err = Math.abs(s.centroidWorldY - FIRE_AT.y);
            const flippedErr = Math.abs(s.centroidWorldY - (STAGE_WORLD.maxY - FIRE_AT.y));
            return {
              ok: err < flippedErr && err < 600,
              measured: {
                centroidWorldY: Math.round(s.centroidWorldY),
                fireY: FIRE_AT.y,
                flippedWouldBe: STAGE_WORLD.maxY - FIRE_AT.y,
              },
              expected: `a centroid near y=${FIRE_AT.y}, not near y=${STAGE_WORLD.maxY - FIRE_AT.y}`,
              note: 'The fixture is off-centre in Y on purpose — a centred one cannot answer this at all.',
            };
          }),
        ],
        artifacts,
        inputs: { diameterPx: 300, tier: 3, coverageRung: 3, world: STAGE_WORLD, fireAt: FIRE_AT },
        stats: { ...s, plan: r.plan, gpuMs: r.gpuMs, quadHalfPx: Math.round(r.quadHalfPx) },
      };
    },
  });

  scenarios.set('real-fire-mask', {
    name: 'real-fire-mask',
    summary:
      "Runs the REAL painted _Fire masks from the author's own map through the real extractor, at the real " +
      'derivation resolution and below it. Exists because a texel-count speck filter silently deleted every ' +
      'fire on that map, and nothing else would have caught it.',
    async run() {
      const { extractFiresFromMask } = await import('../../src/effects/fire/fire-mask.js');
      // `MASK_GRID_MAX_DIM` — what the mask authority actually derives at.
      const SHIPPING_GRID = 512;
      const files = ['Tower_Bridge_Middle_Fire.webp', 'Tower_Bridge_Underground_Fire.webp'];
      const rows = [];
      const checks = [];

      for (const file of files) {
        const url = `/example_map/town river bridge/${file}`;
        let img = null;
        try {
          img = await new Promise((res, rej) => {
            const i = new Image();
            i.onload = () => res(i);
            i.onerror = () => rej(new Error(`could not load ${url}`));
            i.src = url;
          });
        } catch (err) {
          checks.push(
            check({
              id: `mask-loads:${file}`,
              status: 'UNMEASURED',
              note: `${err.message}. Without the authored file this scenario asserts nothing rather than passing.`,
            })
          );
          continue;
        }

        const sweep = [];
        for (const W of [SHIPPING_GRID, 256, 128]) {
          const H = Math.max(1, Math.round((W * img.height) / img.width));
          const c = document.createElement('canvas');
          c.width = W;
          c.height = H;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, W, H);
          const px = ctx.getImageData(0, 0, W, H).data;
          const data = new Uint8Array(W * H);
          let painted = 0;
          for (let i = 0; i < W * H; i++) {
            // Grey premultiplied by alpha — transparent means no fire, which is
            // the mask kind's own `absentValue: 0`.
            const v = Math.max(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]) * (px[i * 4 + 3] / 255);
            data[i] = v;
            if (v >= 64) painted++;
          }
          const spec = {
            x: 0,
            y: 0,
            width: img.width,
            height: img.height,
            w: W,
            h: H,
            texelW: img.width / W,
            texelH: img.height / H,
          };
          const fires = extractFiresFromMask({ spec, data });
          sweep.push({
            gridW: W,
            paintedTexels: painted,
            fires: fires.length,
            diameters: fires.map((f) => Math.round(f.diameterPx)).sort((a, b) => b - a),
          });
        }

        rows.push({ file, native: `${img.width}x${img.height}`, sweep });
        const shipping = sweep.find((s) => s.gridW === SHIPPING_GRID);

        // ⚠️ THE NON-VACUITY GUARD. "0 fires" is only a failure if there was
        // paint to find; an unpainted floor legitimately yields none.
        checks.push(
          shipping.paintedTexels > 0
            ? evaluate(`real-paint-yields-fire:${file}`, () => ({
                ok: shipping.fires > 0,
                measured: { paintedTexels: shipping.paintedTexels, fires: shipping.fires },
                expected: 'at least one fire from a floor that genuinely has paint on it',
                note:
                  `At the SHIPPING derivation width (${SHIPPING_GRID}, MASK_GRID_MAX_DIM). A texel-count speck ` +
                  'filter made this 0 while the paint was plainly there — the exact failure this scenario exists for.',
              }))
            : check({
                id: `real-paint-yields-fire:${file}`,
                status: 'pass',
                measured: { paintedTexels: 0 },
                expected: 'no fire from an unpainted floor',
                note: 'This floor has no fire painted on it, so finding none is correct.',
              })
        );

        if (shipping.paintedTexels > 0) {
          // Sizes must be plausible hearth/brazier scale, not one map-wide blob.
          checks.push(
            evaluate(`real-fires-are-hearth-scale:${file}`, () => ({
              ok: shipping.diameters.every((d) => d >= 8 && d <= 1200),
              measured: { min: Math.min(...shipping.diameters), max: Math.max(...shipping.diameters) },
              expected: '8–1200 px — a brazier through a burning building, never one map-spanning fire',
            }))
          );
        }
      }

      return {
        checks,
        inputs: { files, shippingGridWidth: SHIPPING_GRID, note: 'MASK_GRID_MAX_DIM is 512' },
        stats: { rows },
      };
    },
  });

  scenarios.set('style-plate', {
    name: 'style-plate',
    summary:
      'A close-up contact sheet for judging the LOOK against the reference image — three sizes, framed ' +
      'so the fire fills the frame, plus a posterize sweep. Produces pictures for a human, not numbers.',
    async run({ runId }) {
      const artifacts = [];
      const plates = [
        { px: 66, label: 'campfire-1m', span: 900 },
        { px: 200, label: 'bonfire-3m', span: 2200 },
        { px: 660, label: 'inferno-10m', span: 6000 },
      ];
      for (const p of plates) {
        const r = await renderFire({ diameterPx: p.px, tier: 3, coverageRung: 3, wind: true, frameSpanPx: p.span });
        const png = await savePixels(runId, `plate-${p.label}.png`, r.pixels);
        if (png) artifacts.push(png);
        if (p.px === 200) paintPixels(r.pixels, `style plate — ${p.label}, framed at ${p.span} px`);
      }
      // Posterize is the reference image's defining property, so it gets its own
      // A/B rather than a single value nobody can compare against anything.
      for (const post of [0, 0.5, 1]) {
        const r = await renderFire({
          diameterPx: 200,
          tier: 3,
          coverageRung: 3,
          wind: true,
          frameSpanPx: 2200,
          posterize: post,
        });
        const png = await savePixels(runId, `plate-posterize-${String(post).replace('.', 'p')}.png`, r.pixels);
        if (png) artifacts.push(png);
      }
      return {
        checks: [
          check({
            id: 'style-is-a-human-judgement',
            status: 'UNMEASURED',
            expected: 'the author, on a real scene',
            note:
              'This scenario deliberately asserts NOTHING. It exists to produce pictures to compare against ' +
              "the reference image. Taste is the lab's stated blind spot (Shader-Lab-Proving-Ground §7) and " +
              'a green check here would be a lie about who gets to decide.',
          }),
        ],
        artifacts,
        inputs: { plates, posterizeSweep: [0, 0.5, 1] },
        stats: { note: 'read the PNGs' },
      };
    },
  });

  scenarios.set('motion-check', {
    name: 'motion-check',
    summary:
      'Four frames of a hearth-scale fire across one puff cycle, plus how much of the silhouette actually ' +
      'reshapes frame to frame. Exists because "spiky" and "moves very slowly" (author, live, 2026-08-08) ' +
      'are a SHAPE complaint and a MOTION complaint that share one root cause (lobe spatial frequency) — ' +
      'this scenario is the motion half; `style-plate` is the shape half.',
    async run({ runId }) {
      const artifacts = [];
      // 48px — the middle of the author's real painted hearths (measured 42-55px
      // via `real-fire-mask`), not the 66px+ sizes `style-plate` uses.
      const diameterPx = 48;
      const chainForHz = await (async () => {
        const { fireScaleChain } = await import('../../src/effects/fire/fire-geometry.js');
        return fireScaleChain(diameterPx, 0.01524);
      })();
      const puffPeriodMs = 1000 / chainForHz.puffHz;
      const steps = [0, 0.25, 0.5, 0.75].map((f) => Math.round(f * puffPeriodMs));

      const frames = [];
      for (const timeMs of steps) {
        const r = await renderFire({ diameterPx, tier: 3, coverageRung: 3, timeMs, frameSpanPx: 500 });
        const png = await savePixels(runId, `motion-t${timeMs}.png`, r.pixels);
        if (png) artifacts.push(png);
        frames.push(r.pixels);
      }

      // A cheap reshaping proxy: of the texels that are "silhouette edge" in
      // EITHER of two consecutive frames (lit in one, unlit in the other, or
      // vice versa), as a fraction of texels lit in at least one — a static
      // pattern that only slides sideways scores near 0 here; a genuinely
      // reshaping cauliflower edge scores well above it.
      function edgeChurn(a, b) {
        let changed = 0;
        let litEither = 0;
        for (let i = 0; i < a.length; i += 4) {
          const litA = a[i] + a[i + 1] + a[i + 2] > 24;
          const litB = b[i] + b[i + 1] + b[i + 2] > 24;
          if (litA || litB) litEither++;
          if (litA !== litB) changed++;
        }
        return litEither > 0 ? changed / litEither : 0;
      }
      const churns = [];
      for (let i = 1; i < frames.length; i++) churns.push(edgeChurn(frames[i - 1], frames[i]));

      return {
        checks: [
          check({
            id: 'motion-is-a-human-judgement',
            status: 'UNMEASURED',
            expected: 'the author, on a real scene',
            note:
              `Edge churn between consecutive quarter-cycle frames: ${churns.map((c) => c.toFixed(3)).join(', ')} ` +
              '(fraction of the lit silhouette that toggled lit/unlit). Read alongside the saved PNGs — the ' +
              'number alone cannot say whether the reshaping READS as fire.',
          }),
        ],
        artifacts,
        inputs: { diameterPx, puffHz: chainForHz.puffHz, puffPeriodMs, steps },
        stats: { churns },
      };
    },
  });

  scenarios.set('mask-clip', {
    name: 'mask-clip',
    summary:
      'Proves the mask-clip gate on real WebGPU, through the exact production `maskTexNode.sample(...)` code ' +
      'path (not a stand-in): a fire painted into a LEFT-HALF-only region must read as biased left, and the ' +
      'SAME fire with the clip off must not. Exists because Node cannot compile a shader at all — the whole ' +
      "gate could have a WGSL error and every Node test would stay green. Author's own complaint, live, " +
      '2026-08-08, a half-circle fireplace opening: "the shape of the fire... doesn\'t conform to the shape ' +
      'of the actual mask... always been a perfect circle."',
    async run({ runId }) {
      const artifacts = [];
      const diameterPx = 200;
      const rectSpan = 900; // world px the mask grid covers, centred on FIRE_AT — comfortably bigger than the quad.
      const gridN = 96; // fine enough that the half-circle edge is not itself the thing under test.

      // A LEFT-HALF DISC — the shape a real "half circle of mask" fireplace
      // paints, per the author's own words. RGBA replicate of one grey byte,
      // the SAME layout `bakeFireMaskTexture` (vt-pan-viewer.js) produces.
      const data = new Uint8Array(gridN * gridN * 4);
      const cx = gridN / 2;
      const cy = gridN / 2;
      // ⚠️ SIZED TO THE FIRE, NOT TO THE GRID. A first version used 0.42×grid,
      // which made the painted region 3.7× the fire's own diameter — so the
      // silhouette noise (whose frequency is scaled to the FIRE) ran far too
      // fine across the actual burning area and the render came out as marbled
      // veins. On a real map `extractFiresFromMask` sets each fire's diameter
      // FROM its region's own width, so the two are always comparable; a
      // fixture that breaks that relationship is testing a case that cannot
      // happen (`feedback_synthetic_fixture_invariant_is_not_authored_art`).
      const r = (gridN * (diameterPx * 0.6)) / rectSpan;
      for (let y = 0; y < gridN; y++) {
        for (let x = 0; x < gridN; x++) {
          const dx = x - cx;
          const dy = y - cy;
          const inLeftHalfDisc = dx <= 0 && dx * dx + dy * dy <= r * r;
          const v = inLeftHalfDisc ? 255 : 0;
          const i = (y * gridN + x) * 4;
          data[i] = v;
          data[i + 1] = v;
          data[i + 2] = v;
          data[i + 3] = 255;
        }
      }
      const rect = {
        minX: FIRE_AT.x - rectSpan / 2,
        minY: FIRE_AT.y - rectSpan / 2,
        maxX: FIRE_AT.x + rectSpan / 2,
        maxY: FIRE_AT.y + rectSpan / 2,
      };
      const maskGrid = { data, w: gridN, h: gridN, rect };

      const frameSpanPx = 900;
      const clipped = await renderFire({ diameterPx, tier: 3, coverageRung: 3, frameSpanPx, maskClip: true, maskGrid });
      const unclipped = await renderFire({
        diameterPx,
        tier: 3,
        coverageRung: 3,
        frameSpanPx,
        maskClip: false,
        maskGrid,
      });
      const noMaskAtAll = await renderFire({
        diameterPx,
        tier: 3,
        coverageRung: 3,
        frameSpanPx,
        maskClip: true,
        maskGrid: null,
      });

      const sClipped = frameStats(clipped.pixels);
      const sUnclipped = frameStats(unclipped.pixels);
      const sNoMask = frameStats(noMaskAtAll.pixels);
      paintPixels(clipped.pixels, `fire — mask-clipped to a LEFT-HALF disc, D=${diameterPx}px`);

      artifacts.push(await savePixels(runId, 'mask-clip-clipped.png', clipped.pixels));
      artifacts.push(await savePixels(runId, 'mask-clip-unclipped-control.png', unclipped.pixels));
      artifacts.push(await savePixels(runId, 'mask-clip-nomask-flag-only.png', noMaskAtAll.pixels));

      // A left-half disc's own centroid sits a quarter of its radius left of
      // its bounding centre — comfortably more than noise/silhouette jitter,
      // so "did the clip visibly bias the fire left" is a real, checkable
      // number, not a coin flip.
      const shiftClipped = FIRE_AT.x - sClipped.centroidWorldX;
      const shiftUnclipped = Math.abs(FIRE_AT.x - sUnclipped.centroidWorldX);
      const shiftNoMask = Math.abs(FIRE_AT.x - sNoMask.centroidWorldX);

      return {
        checks: [
          evaluate('clipped-fire-is-biased-toward-the-painted-half', () => ({
            ok: shiftClipped > 15,
            measured: { centroidWorldX: sClipped.centroidWorldX, shiftPx: Number(shiftClipped.toFixed(1)) },
            expected: 'centroid shifted LEFT of the fire anchor by a real margin (> 15px)',
            note: 'A zero/near-zero shift here means the clip is not reaching the shader at all — read the PNG.',
          })),
          evaluate('maskClip-flag-false-ignores-the-mask', () => ({
            ok: shiftUnclipped < 8,
            measured: { centroidWorldX: sUnclipped.centroidWorldX, shiftPx: Number(shiftUnclipped.toFixed(1)) },
            expected: 'centroid stays near the anchor (< 8px) — an anchor-placed fire must never be clipped',
            note: 'This is the SAME mask texture as the clipped case, only the per-vertex flag differs.',
          })),
          evaluate('no-mask-wired-at-all-fails-open', () => ({
            ok: shiftNoMask < 8,
            measured: { centroidWorldX: sNoMask.centroidWorldX, shiftPx: Number(shiftNoMask.toFixed(1)) },
            expected: 'centroid stays near the anchor (< 8px) even with maskClip:true, when no texture is wired',
            note: '`feedback_gate_polarity_must_fail_open` — a caller that has not baked a mask yet must not go dark.',
          })),
          evaluate('the-clipped-fire-still-put-light-on-screen', () => ({
            ok: sClipped.litFraction > 0.001,
            measured: { litFraction: sClipped.litFraction },
            expected: 'clipping to a half-disc thins the fire, it does not black it out',
          })),
        ],
        artifacts: artifacts.filter(Boolean),
        inputs: { diameterPx, frameSpanPx, maskGrid: { w: gridN, h: gridN, rect } },
        stats: { sClipped, sUnclipped, sNoMask },
      };
    },
  });

  scenarios.set('the-reference-look', {
    name: 'the-reference-look',
    summary:
      "Renders the case the author's reference image actually depicts — a WIND-SHEARED plume, at three " +
      'sizes — and checks the two structural properties that separate it from a blob: the smoke crowns ' +
      'ONE side (it does not sit concentrically on the flame), and the flame core survives it.',
    async run({ runId }) {
      const artifacts = [];
      const rows = [];
      const checks = [];

      // 1 m campfire, 3 m bonfire, 10 m inferno — real sizes at 100 px per 5 ft.
      const sizes = [
        { px: 66, label: 'campfire-1m' },
        { px: 200, label: 'bonfire-3m' },
        { px: 660, label: 'inferno-10m' },
      ];

      for (const s of sizes) {
        const windy = await renderFire({ diameterPx: s.px, tier: 3, coverageRung: 3, wind: true });
        const calm = await renderFire({ diameterPx: s.px, tier: 3, coverageRung: 3, wind: false });
        const wStats = frameStats(windy.pixels);
        const cStats = frameStats(calm.pixels);

        const png = await savePixels(runId, `fire-${s.label}-windy.png`, windy.pixels);
        if (png) artifacts.push(png);
        if (s.px === 200) {
          const calmPng = await savePixels(runId, `fire-${s.label}-calm.png`, calm.pixels);
          if (calmPng) artifacts.push(calmPng);
          paintPixels(windy.pixels, `fire — ${s.label}, wind-sheared, tier 3 (M=${windy.plan.M}/N=${windy.plan.N})`);
        }

        // ⚠️ THE STRUCTURAL CLAIM OF THE WHOLE DESIGN, MEASURED.
        // A footprint cannot shear. If wind moves the lit centroid off the
        // anchor, the plume genuinely has height and the column integral is
        // buying what it was supposed to buy. If it does not, this is a
        // decorated blob and the slab integral is not earning its cost.
        const calmOffset = Math.hypot(cStats.centroidWorldX - FIRE_AT.x, cStats.centroidWorldY - FIRE_AT.y);
        const windOffset = Math.hypot(wStats.centroidWorldX - FIRE_AT.x, wStats.centroidWorldY - FIRE_AT.y);

        // ⚠️ THE NON-VACUITY GUARD, AND IT IS NOT OPTIONAL.
        // The first version of this check PASSED on two completely black
        // frames. The centroid of an empty frame is (0,0), which is 3310 px
        // from the anchor — so "the windy centroid moved further than the calm
        // one" was trivially satisfied by rendering nothing at all, and the
        // report said so in green. Any check comparing a derived statistic must
        // first establish that the statistic was derived from something.
        const bothRendered = wStats.litFraction > 0.0005 && cStats.litFraction > 0.0005;
        checks.push(
          bothRendered
            ? // ⚠️ THE THRESHOLD SCALES AS √D, NOT D, AND THAT IS PHYSICS.
              // Shear distance is wind × time-of-flight = wind × height/rise.
              // Height grows ~linearly with diameter but rise speed grows as
              // √D (`1.9·√D_m`), so shear grows as D/√D = √D — a bigger fire
              // shears proportionally LESS because it climbs out of the wind
              // faster. A linear threshold failed the 10 m inferno by 2 px
              // while the model was behaving exactly as designed.
              evaluate(`wind-shears-the-plume-off-the-anchor:${s.label}`, () => {
                const floorPx = Math.sqrt(s.px) * 1.5;
                return {
                  ok: windOffset > calmOffset + floorPx,
                  measured: {
                    windOffset: Math.round(windOffset),
                    calmOffset: Math.round(calmOffset),
                    diameterPx: s.px,
                  },
                  expected: `the windy centroid at least ${Math.round(floorPx)} px (∝ √D) further off-anchor than the calm one`,
                  note: 'A footprint cannot do this. It is the one thing the column integral is bought for.',
                };
              })
            : check({
                id: `wind-shears-the-plume-off-the-anchor:${s.label}`,
                status: 'UNMEASURED',
                measured: { windyLit: wStats.litFraction, calmLit: cStats.litFraction },
                expected: 'both frames to contain a fire before their centroids are compared',
                note: 'One or both frames rendered nothing. A centroid computed from an empty frame is (0,0) and would pass this check for the worst possible reason.',
              })
        );

        // The flame core must survive its own smoke. This is the check that
        // caught the opaque-grey-lid bug twice, so it stays.
        const core = sampleAt(windy.pixels, FIRE_AT.x, FIRE_AT.y);
        const chroma = (core.r - core.b) / Math.max(core.r, 1);
        checks.push(
          evaluate(`flame-core-survives-its-smoke:${s.label}`, () => ({
            ok: chroma > 0.45 && core.r > 90,
            measured: { r: core.r, g: core.g, b: core.b, chroma: Number(chroma.toFixed(3)) },
            expected: 'a bright, strongly chromatic core under the plume',
          }))
        );

        rows.push({
          size: s.label,
          diameterPx: s.px,
          windOffsetPx: Math.round(windOffset),
          calmOffsetPx: Math.round(calmOffset),
          core: { r: core.r, g: core.g, b: core.b },
          litFraction: wStats.litFraction,
          gpuMs: windy.gpuMs,
          plan: windy.plan.key,
        });
      }

      // Bigger fires must read as bigger — a silhouette that does not grow with
      // the authored diameter means the scale chain is not reaching the shader.
      checks.push(
        evaluate('bigger-fires-cover-more-screen', () => {
          const lit = rows.map((r) => r.litFraction);
          return {
            ok: lit[0] < lit[1] && lit[1] < lit[2],
            measured: lit,
            expected: 'strictly increasing coverage with diameter',
          };
        })
      );

      return {
        checks,
        artifacts,
        inputs: { sizes: sizes.map((s) => s.px), tier: 3, wind: 'ambient 0.55 @ 120°' },
        stats: { rows },
      };
    },
  });

  scenarios.set('noise-fold-ab', {
    name: 'noise-fold-ab',
    summary:
      'Does a LIVE third noise coordinate cost anything? Measures the real fbmFloat at 1024² in three ' +
      'variants — vec2(p), vec3(p, 0.0), vec3(p, uTime) — after first proving the timer can resolve a ' +
      'cost difference it knows exists. Decides whether fire pays 1× or 2× per slab slice.',
    async run({ runId }) {
      await ensureRenderer();

      if (!timestampSupport.capable) {
        return {
          checks: [
            check({
              id: 'timestamp-query-available',
              status: 'UNMEASURED',
              measured: false,
              expected: 'a WebGPU adapter exposing timestamp-query',
              note: timestampSupport.reason,
            }),
          ],
          inputs: { dim: DIM, repeats: REPEATS },
          stats: { timestampSupport },
        };
      }

      // ONE round-robin run covering the vacuity gate AND all three variants,
      // so every number below shares a single GPU thermal/clock history.
      const m = await measureVariants([
        { key: 'vec2', mode: 'vec2', octaves: 3 },
        { key: 'constZ', mode: 'constZ', octaves: 3 },
        { key: 'liveZ', mode: 'liveZ', octaves: 3 },
        { key: 'oct6', mode: 'liveZ', octaves: 6 },
      ]);
      const vec2Res = m?.vec2 ?? null;
      const constRes = m?.constZ ?? null;
      const liveRes = m?.liveZ ?? null;
      const oct6 = m?.oct6 ?? null;

      // ── THE NON-VACUITY GATE. Six octaves is twice the hashes of three. ──
      // `liveZ` IS the 3-octave arm, so the gate and the verdict now share it
      // rather than being two separately-timed blocks.
      const vacuityRatio = liveRes && oct6 ? oct6.p50 / liveRes.p50 : null;
      const detectorWorks = vacuityRatio !== null && vacuityRatio >= VACUITY_MIN_RATIO;

      const vacuityCheck = evaluate('detector-is-not-vacuous', () => ({
        ok: detectorWorks,
        measured: vacuityRatio === null ? null : Number(vacuityRatio.toFixed(3)),
        expected: `>= ${VACUITY_MIN_RATIO} (6 octaves is 2× the lattice hashes of 3)`,
        note:
          'If this fails, the timer cannot resolve a cost difference that MUST exist, so every ratio ' +
          'below is meaningless and reports UNMEASURED. A blind instrument reporting "no difference" ' +
          'is the failure mode this gate exists to catch.',
      }));

      const ratioLiveVsConst = liveRes && constRes ? liveRes.p50 / constRes.p50 : null;
      const ratioConstVsVec2 = constRes && vec2Res ? constRes.p50 / vec2Res.p50 : null;

      /** Turn the measured ratio into the design verdict, or refuse to. */
      let verdict = 'INCONCLUSIVE';
      if (detectorWorks && ratioLiveVsConst !== null) {
        if (ratioLiveVsConst < RATIO_FREE_BELOW) verdict = 'THIRD_AXIS_IS_FREE';
        else if (ratioLiveVsConst > RATIO_FOLDS_ABOVE) verdict = 'CONSTANT_Z_WAS_FOLDING';
      }

      // ⚠️ THE CHECK MEASURES DISPARITY, NOT JITTER — and the difference is the
      // whole point of the round-robin layout.
      //
      // An absolute p95/p50 spread only says "this machine has frame-to-frame
      // jitter", which every machine does and which CANCELS in a ratio when all
      // variants suffer it equally. What actually corrupts a ratio is jitter
      // landing UNEVENLY — one variant sampled during a clock ramp while another
      // was not. So the guard is the ratio of the widest spread to the narrowest.
      //
      // Measured 2026-08-08, this bench against itself: the block layout put
      // every variant's spread in a different regime and reported the vacuity
      // ratio as 1.597 against a theoretical 2.0. Round-robin brought the
      // spreads to 1.252/1.255/1.255/1.365 — disparity 1.09 — and the same
      // vacuity ratio landed on 2.000. The absolute spread barely moved; the
      // DISPARITY is what changed, and it is what the numbers track.
      const spreads = [vec2Res, constRes, liveRes, oct6].filter(Boolean).map((r) => r.spread);
      const worstSpread = spreads.length ? Math.max(...spreads) : null;
      const spreadDisparity = spreads.length ? Math.max(...spreads) / Math.max(Math.min(...spreads), 1e-6) : null;
      const checks = [
        evaluate('noise-affects-every-variant-equally', () => ({
          ok: spreadDisparity !== null && spreadDisparity <= 1.35,
          measured: spreadDisparity === null ? null : Number(spreadDisparity.toFixed(3)),
          expected: '<= 1.35 (widest p95/p50 ÷ narrowest, across every variant)',
          note:
            `Absolute spread was ${worstSpread?.toFixed(3)} — that is this machine's jitter and it cancels in a ` +
            'ratio. A HIGH disparity would mean one variant was sampled under different GPU conditions than ' +
            'another, which does not cancel. If this fails, raise WARMUP_FRAMES and re-run.',
        })),
        vacuityCheck,
      ];

      // A vec2 argument and an explicit vec3(q, 0.0) are the SAME WGSL after
      // NodeBuilder.format's silent pad. If these two ever diverge, the padding
      // story in this file's header is wrong and everything downstream of it is
      // built on a misreading.
      checks.push(
        detectorWorks
          ? evaluate('vec2-and-explicit-const-z-are-the-same-shader', () => ({
              ok: ratioConstVsVec2 !== null && Math.abs(ratioConstVsVec2 - 1) < 0.2,
              measured: ratioConstVsVec2 === null ? null : Number(ratioConstVsVec2.toFixed(3)),
              expected: '1.0 ± 0.2 — NodeBuilder.format pads vec2 to vec3(xy, 0.0)',
              note:
                'Confirms the silent-pad reading of three.webgpu.js:57770. A divergence here would mean ' +
                'the ~40 existing fbmFloat(vec2) call sites in src/ are NOT what this bench assumes.',
            }))
          : check({
              id: 'vec2-and-explicit-const-z-are-the-same-shader',
              status: 'UNMEASURED',
              note: 'detector-is-not-vacuous failed — no ratio from this timer is trustworthy',
            })
      );

      checks.push(
        detectorWorks && verdict !== 'INCONCLUSIVE'
          ? check({
              id: 'live-third-coordinate-cost',
              status: 'pass',
              measured: `${ratioLiveVsConst.toFixed(3)}× → ${verdict}`,
              expected: `< ${RATIO_FREE_BELOW} (free) or > ${RATIO_FOLDS_ABOVE} (folds)`,
              note:
                verdict === 'THIRD_AXIS_IS_FREE'
                  ? 'The constant 0.0 is NOT being folded — existing vec2 call sites already pay 8 corners, ' +
                    "so fire's live third axis costs nothing extra. The slab-integral slice counts in " +
                    'docs/planning/Fire.md stand as written.'
                  : "The constant 0.0 IS being folded to 4 corners. Every slab slice costs DOUBLE the plan's " +
                    'budget — halve every N in the tier ladder and re-derive the coverage bands.',
            })
          : check({
              id: 'live-third-coordinate-cost',
              status: 'UNMEASURED',
              measured: ratioLiveVsConst === null ? null : Number(ratioLiveVsConst.toFixed(3)),
              expected: `< ${RATIO_FREE_BELOW} (free) or > ${RATIO_FOLDS_ABOVE} (folds)`,
              note: detectorWorks
                ? `Ratio landed at ${ratioLiveVsConst?.toFixed(3)}, between the two thresholds. That is a real ` +
                  'reading and an ambiguous one — raise SAMPLE_FRAMES or REPEATS before calling it either way.'
                : 'detector-is-not-vacuous failed — this timer cannot resolve cost differences at all.',
            })
      );

      await paintProbe('liveZ', 3);
      const artifacts = [];
      const png = await saveCanvasPng(runId, 'noise-probe-liveZ-3oct.png', viewCanvas);
      if (png) artifacts.push(png);

      const perMpx = (r) => (r ? Number((r.p50 / MEGAPIXELS).toFixed(4)) : null);
      return {
        checks,
        artifacts,
        inputs: {
          dim: DIM,
          megapixels: Number(MEGAPIXELS.toFixed(4)),
          repeats: REPEATS,
          octaves: 3,
          warmupFrames: WARMUP_FRAMES,
          sampleFrames: SAMPLE_FRAMES,
          noiseSource: 'src/effects/lighting/animations/tsl-noise-toolkit.js#fbmFloat (imported, not transcribed)',
        },
        stats: {
          verdict,
          ratioLiveVsConst: ratioLiveVsConst === null ? null : Number(ratioLiveVsConst.toFixed(3)),
          ratioConstVsVec2: ratioConstVsVec2 === null ? null : Number(ratioConstVsVec2.toFixed(3)),
          vacuityRatio: vacuityRatio === null ? null : Number(vacuityRatio.toFixed(3)),
          worstSpread: worstSpread === null ? null : Number(worstSpread.toFixed(3)),
          spreadDisparity: spreadDisparity === null ? null : Number(spreadDisparity.toFixed(3)),
          gpuMs: { vec2: vec2Res, constZ: constRes, liveZ: liveRes, oct6 },
          // The number every estMsPerMp in the fire manifest rests on. One fBm
          // call, not REPEATS of them.
          msPerMpxPerFbm: {
            vec2: perMpx(vec2Res) === null ? null : Number((perMpx(vec2Res) / REPEATS).toFixed(4)),
            constZ: perMpx(constRes) === null ? null : Number((perMpx(constRes) / REPEATS).toFixed(4)),
            liveZ: perMpx(liveRes) === null ? null : Number((perMpx(liveRes) / REPEATS).toFixed(4)),
          },
          timestampSupport,
        },
      };
    },
  });

  scenarios.set('octave-cost-curve', {
    name: 'octave-cost-curve',
    summary:
      'Sweeps octaves 1..6 with a live third coordinate and fits cost per octave. Replaces the fire ' +
      "plan's DERIVED 0.008 ms/Mpx-per-lattice-hash constant with a measured one — every estMsPerMp in " +
      'the tier ladder rests on it.',
    async run() {
      await ensureRenderer();
      if (!timestampSupport.capable) {
        return {
          checks: [
            check({
              id: 'timestamp-query-available',
              status: 'UNMEASURED',
              measured: false,
              expected: 'a WebGPU adapter exposing timestamp-query',
              note: timestampSupport.reason,
            }),
          ],
          stats: { timestampSupport },
        };
      }

      // ⚠️ ROUND-ROBIN, not a 1→6 sweep. A sequential sweep hands the cold GPU
      // to octave 1, inflating the cheapest reading and FLATTENING the very
      // slope this scenario exists to measure — the same warm-up error the
      // sibling scenario caught in itself (see this file's header).
      const specs = [];
      for (let octaves = 1; octaves <= 6; octaves++) specs.push({ key: `o${octaves}`, mode: 'liveZ', octaves });
      const m = await measureVariants(specs);

      const rows = specs.map((s) => {
        const r = m?.[s.key] ?? null;
        return {
          octaves: s.octaves,
          gpuMsP50: r ? Number(r.p50.toFixed(4)) : null,
          spread: r ? r.spread : null,
          // Per SINGLE fbm call, per megapixel — the unit the manifest quotes.
          msPerMpxPerFbm: r ? Number((r.p50 / MEGAPIXELS / REPEATS).toFixed(5)) : null,
        };
      });

      const measured = rows.filter((r) => r.msPerMpxPerFbm !== null);
      // Least-squares slope over octave count. The intercept is the fixed cost
      // of everything that is not an octave (the uv math, the sum, the write).
      let slope = null;
      let intercept = null;
      if (measured.length >= 3) {
        const n = measured.length;
        const sx = measured.reduce((a, r) => a + r.octaves, 0);
        const sy = measured.reduce((a, r) => a + r.msPerMpxPerFbm, 0);
        const sxx = measured.reduce((a, r) => a + r.octaves * r.octaves, 0);
        const sxy = measured.reduce((a, r) => a + r.octaves * r.msPerMpxPerFbm, 0);
        slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
        intercept = (sy - slope * sx) / n;
      }

      const checks = [
        evaluate('cost-rises-monotonically-with-octaves', () => {
          const vals = measured.map((r) => r.msPerMpxPerFbm);
          let monotonic = true;
          for (let i = 1; i < vals.length; i++) if (vals[i] < vals[i - 1]) monotonic = false;
          return {
            ok: vals.length >= 3 && monotonic,
            measured: vals,
            expected: 'strictly non-decreasing — each octave is 8 more lattice hashes',
            note:
              'A non-monotonic curve means the readings are inside the noise floor, not that an octave is ' +
              'free. Raise SAMPLE_FRAMES before reading anything else in this scenario.',
          };
        }),
        evaluate('per-octave-slope-is-resolvable', () => ({
          ok: slope !== null && slope > 0,
          measured: slope === null ? null : Number(slope.toFixed(5)),
          expected: '> 0 ms/Mpx per octave',
          note:
            'This slope ÷ 8 is the measured cost of ONE lattice hash — the constant docs/planning/Fire.md ' +
            'currently derives as 0.008 ms/Mpx from two indirect anchors. Replace it with this number.',
        })),
      ];

      return {
        checks,
        inputs: { dim: DIM, repeats: REPEATS, mode: 'liveZ', sampleFrames: SAMPLE_FRAMES },
        stats: {
          rows,
          msPerMpxPerOctave: slope === null ? null : Number(slope.toFixed(5)),
          msPerMpxPerLatticeHash: slope === null ? null : Number((slope / 8).toFixed(6)),
          fixedCostMsPerMpx: intercept === null ? null : Number(intercept.toFixed(5)),
        },
      };
    },
  });

  registerBench({
    name: 'fire',
    title: 'Fire — slab-integral noise cost (rung 1)',
    rung: 1,
    summary:
      'Measures what fbmFloat actually costs with a constant vs live third coordinate, which decides ' +
      'the slice count of the whole fire slab integral. Every check is gated on a non-vacuity probe ' +
      'that proves the timer can see a cost difference before any ratio is believed.',
    scenarios,
    params: { dim: DIM, repeats: REPEATS, sampleFrames: SAMPLE_FRAMES },
    checkIds: [
      'the-material-put-light-on-screen',
      'the-fire-is-lit-at-its-anchor',
      'empty-space-stays-empty',
      'the-fire-core-is-strongly-chromatic',
      'the-frame-is-not-y-flipped',
      'noise-affects-every-variant-equally',
      'detector-is-not-vacuous',
      'vec2-and-explicit-const-z-are-the-same-shader',
      'live-third-coordinate-cost',
      'cost-rises-monotonically-with-octaves',
      'per-octave-slope-is-resolvable',
    ],
    ready: () => true,
    runScenario: (scenario, ctx) => scenario.run(ctx),
  });

  return {
    scenarios,
    measureVariants,
    buildProbeMaterial,
    paintProbe,
    renderFire,
    paintPixels,
    frameStats,
    sampleAt,
    getSupport: () => timestampSupport,
  };
}
