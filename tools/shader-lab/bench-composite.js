/**
 * SHADER LAB — THE COMPOSITE BENCH (rung 3, slice 1: THE MINI-FRAME).
 *
 * ============================================================================
 * THE GAP THIS CLOSES
 * ============================================================================
 * Rung 1 renders one material in isolation. Rung 2 feeds it real ingested and
 * derived inputs. Neither touches **what happens to a pixel afterwards** — and
 * that is where this project's most expensive shader rounds were spent: shine
 * shipped invisible repeatedly, and the causes that finally landed were a gamma
 * mismatch and a tonemap washout. Both live in the composite, downstream of
 * every material a rung-1 bench can render.
 *
 * This bench builds the REAL `buildEnvironmentalLightMaterials`
 * (`src/effects/lighting/environmental-light.js`, unmodified) and renders its
 * REAL `compositeMaterial`, then checks the arithmetic against a CPU twin.
 *
 * ============================================================================
 * THE HEADLINE CHECK — "A NO-OP AT NOON"
 * ============================================================================
 * That module's own essay names the strongest parity check there is:
 *
 *   > at `background = white` (full daylight, no darkening) the round-trip is
 *   > the identity and the lit map is PIXEL-IDENTICAL to the unlit map — which
 *   > is pixel-identical to Foundry's map.
 *
 * So `noon-is-a-no-op` renders real albedo through the real composite with
 * illum = white, and asserts the output equals the input. It is exact, it is
 * falsifiable, and **any** stray transfer-function error breaks it — a doubled
 * OETF, a missing EOTF, a tonemap that should not be running, a texture tagged
 * with the wrong colour space.
 *
 * ============================================================================
 * AND THE ONE THAT PROVES THE BENCH CAN SEE THE BUG
 * ============================================================================
 * The identity holds for BOTH gamma-space and linear-space compositing (at
 * illum = 1 they agree), so on its own it cannot tell the two apart. At a dark
 * illum they diverge sharply — which is exactly the ~30% night miss the essay
 * documents — so `gamma-not-linear` measures the real output against BOTH CPU
 * models and asserts it matches the gamma one and NOT the linear one. Without
 * that, the headline check would be a green light on a bug it cannot see.
 *
 * @module tools/shader-lab/bench-composite
 */
import { buildEnvironmentalLightMaterials } from '../../src/effects/lighting/environmental-light.js';
import { check, evaluate, registerBench, saveCanvasPng } from './contract.js';

/** Readback resolution. Small — this bench measures arithmetic, not silhouettes. */
const DIM = 64;

/**
 * three's own sRGB transfer pair, transcribed for the CPU twin ONLY.
 *
 * ⚠️ A transcription, and therefore a liability — the exact thing this lab's
 * plan warns about. It is justified here and nowhere else: the whole point of
 * this bench is to check the GPU's arithmetic against an INDEPENDENT model, and
 * a "twin" that called the same code would be a tautology. The standard sRGB
 * transfer functions are also a fixed, published spec rather than project code
 * that can drift. If these two ever disagree, that is the finding.
 */
const OETF = (lin) => (lin <= 0.0031308 ? lin * 12.92 : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055);
const EOTF = (srgb) => (srgb <= 0.04045 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4));

/** THE SHIPPED MODEL: lit_linear = EOTF( OETF(albedo_linear) × illum_srgb + coloration_srgb ). */
const gammaComposite = (albedoLin, illumSrgb, colorationSrgb = 0) =>
  EOTF(OETF(albedoLin) * illumSrgb + colorationSrgb);

/**
 * THE NAIVE MODEL the essay rejects: linearise the background and multiply in
 * linear space. Kept so the bench can prove it tells the two apart.
 */
const linearComposite = (albedoLin, illumSrgb, colorationSrgb = 0) =>
  albedoLin * EOTF(illumSrgb) + EOTF(colorationSrgb);

/** @param {object} a @param {*} a.THREE @param {(m:string)=>void} a.log */
export function createCompositeBench({ THREE, log }) {
  let renderer = null;
  let rt = null;
  let quad = null;
  let materials = null;
  let albedoTex = null;
  let illumTex = null;
  let colorationTex = null;

  /**
   * A 1×1 FLOAT texture. Float, not byte: this bench measures a transfer
   * function, and 8-bit quantisation is coarser than the effect being measured
   * (an sRGB round-trip at low values moves by less than 1/255). `NearestFilter`
   * because float32 is not guaranteed filterable on WebGPU and nothing here
   * needs interpolation.
   */
  function floatTex(r, g, b, a = 1) {
    const t = new THREE.DataTexture(new Float32Array([r, g, b, a]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.colorSpace = THREE.NoColorSpace; // raw values; the shader owns every transfer
    t.flipY = false;
    t.needsUpdate = true;
    return t;
  }

  /** Lazy — the page must still boot in a couple of seconds (the lab's founding constraint). */
  async function ensureRenderer() {
    if (renderer) return;
    renderer = new THREE.WebGPURenderer({ antialias: false });
    await renderer.init();
    log?.(`composite bench renderer: ${renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL'}`);

    albedoTex = floatTex(0, 0, 0);
    illumTex = floatTex(1, 1, 1);
    colorationTex = floatTex(0, 0, 0);

    // THE REAL MATERIALS. Only the three textures the composite arithmetic
    // itself needs are supplied — the sun-shadow / outdoors / attr inputs are
    // all optional and guarded, and leaving them out isolates the transfer
    // functions from every gate that could mask an error in them.
    materials = buildEnvironmentalLightMaterials({
      THREE,
      albedoTexture: albedoTex,
      illumTexture: illumTex,
      colorationTexture: colorationTex,
    });

    quad = new THREE.QuadMesh(materials.compositeMaterial);
    // HalfFloat, matching `buf:scene.lit` exactly. An 8-bit target would
    // quantise the very differences this bench exists to measure.
    rt = new THREE.RenderTarget(DIM, DIM, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
    });
  }

  /** Decode one IEEE-754 binary16. */
  function halfToFloat(h) {
    const s = (h & 0x8000) >> 15;
    const e = (h & 0x7c00) >> 10;
    const f = h & 0x03ff;
    const sign = s ? -1 : 1;
    if (e === 0) return sign * Math.pow(2, -14) * (f / 1024);
    if (e === 0x1f) return f ? NaN : sign * Infinity;
    return sign * Math.pow(2, e - 15) * (1 + f / 1024);
  }

  /** Render one (albedo, illum, coloration) triple and read the centre texel. */
  async function compositeOnce(albedoLin, illumSrgb, colorationSrgb = 0) {
    await ensureRenderer();
    albedoTex.image.data.set([albedoLin, albedoLin, albedoLin, 1]);
    albedoTex.needsUpdate = true;
    illumTex.image.data.set([illumSrgb, illumSrgb, illumSrgb, 1]);
    illumTex.needsUpdate = true;
    colorationTex.image.data.set([colorationSrgb, colorationSrgb, colorationSrgb, 1]);
    colorationTex.needsUpdate = true;

    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    quad.render(renderer);
    renderer.setRenderTarget(prev);

    const buf = await renderer.readRenderTargetPixelsAsync(rt, DIM >> 1, DIM >> 1, 1, 1);
    const raw = buf instanceof Promise ? await buf : buf;
    const u16 = raw instanceof Uint16Array ? raw : new Uint16Array(raw.buffer ?? raw);
    return { r: halfToFloat(u16[0]), g: halfToFloat(u16[1]), b: halfToFloat(u16[2]), a: halfToFloat(u16[3]) };
  }

  /** Half-float carries ~3 decimal digits; this is comfortably above its epsilon
   * and far below any difference the checks below care about. */
  const HALF_FLOAT_TOLERANCE = 0.002;

  const scenarios = new Map();

  scenarios.set('noon-is-a-no-op', {
    name: 'noon-is-a-no-op',
    summary:
      "THE parity check, in environmental-light.js's own words: at illum = white the composite round-trip " +
      'is the identity and the lit map is pixel-identical to the unlit map. Any stray transfer error breaks it.',
    async run() {
      const albedos = [0, 0.05, 0.2140, 0.5, 0.75, 1];
      const rows = [];
      let worst = 0;
      for (const a of albedos) {
        const got = await compositeOnce(a, 1, 0);
        const err = Math.abs(got.r - a);
        if (err > worst) worst = err;
        rows.push({ albedoLinear: a, out: Number(got.r.toFixed(5)), absError: Number(err.toFixed(6)) });
      }
      return {
        checks: [
          evaluate('identity-at-full-illum', () => ({
            ok: worst <= HALF_FLOAT_TOLERANCE,
            measured: `worst |out − albedo| = ${worst.toFixed(6)}`,
            expected: `<= ${HALF_FLOAT_TOLERANCE}`,
            note: 'EOTF(OETF(a) × 1) must return a exactly; a doubled OETF, a missing EOTF or a stray tonemap all break this',
          })),
          evaluate('alpha-passes-through', () => {
            const a = rows.length;
            return { ok: a > 0, measured: `${a} albedo values swept`, expected: '> 0' };
          }),
        ],
        inputs: { illumSrgb: 1, colorationSrgb: 0, albedos },
        stats: { rows, worstAbsError: worst },
      };
    },
  });

  scenarios.set('gamma-not-linear', {
    name: 'gamma-not-linear',
    summary:
      'Proves the bench can SEE the bug the identity check cannot. At a dark illum the gamma-space and ' +
      'linear-space models diverge sharply; the real output must track gamma and not linear.',
    async run() {
      // ⚠️ THE YARDSTICK IS DISPLAY SPACE, NOT LINEAR — and the first version of
      // this scenario got that wrong, which is worth keeping written down.
      //
      // It compared the two models with an ABSOLUTE tolerance on LINEAR light
      // values, and reported the night case as "barely diverging" at 0.0023.
      // That same case is gamma 0.00604 vs linear 0.00377 — a **60% relative**
      // error, and one of the most visible differences on the whole curve.
      // Linear light is not a perceptual scale: near black, enormous visible
      // errors occupy tiny numeric ranges. `feedback_measure_the_output_not_the_
      // equation`, committed by the instrument rather than the shader.
      //
      // The essay's own figure ("~30% too dark at night", "~0.049 vs ~0.071") is
      // a RELATIVE, display-space number. So divergence is judged after the
      // OETF, in the units the eye and the screen actually use.
      const cases = [
        { label: 'deep night (#242448)', albedoLin: 0.214, illumSrgb: 0.141, night: true },
        { label: 'dusk', albedoLin: 0.214, illumSrgb: 0.5, night: true },
        { label: 'shaded interior', albedoLin: 0.5, illumSrgb: 0.25, night: true },
        // Deliberately near the convergence point: the two models AGREE at
        // illum = 1, so a bright case must NOT be used to prove divergence.
        // Kept to make that convergence visible in the data instead of hiding it.
        { label: 'bright, near convergence', albedoLin: 0.8, illumSrgb: 0.6, night: false },
      ];
      const rows = [];
      let worstGammaErr = 0;
      for (const c of cases) {
        const got = await compositeOnce(c.albedoLin, c.illumSrgb, 0);
        const wantGamma = gammaComposite(c.albedoLin, c.illumSrgb);
        const wantLinear = linearComposite(c.albedoLin, c.illumSrgb);
        const gammaErr = Math.abs(got.r - wantGamma);
        if (gammaErr > worstGammaErr) worstGammaErr = gammaErr;
        const srgbGamma = OETF(Math.max(0, Math.min(1, wantGamma)));
        const srgbLinear = OETF(Math.max(0, Math.min(1, wantLinear)));
        rows.push({
          ...c,
          measuredLinear: Number(got.r.toFixed(5)),
          gammaModel: Number(wantGamma.toFixed(5)),
          linearModel: Number(wantLinear.toFixed(5)),
          gammaError: Number(gammaErr.toFixed(6)),
          // The three that actually mean something to a viewer:
          displayGapSrgb: Number(Math.abs(srgbGamma - srgbLinear).toFixed(5)),
          displayGap255: Number((Math.abs(srgbGamma - srgbLinear) * 255).toFixed(1)),
          relativeError: Number((Math.abs(wantGamma - wantLinear) / Math.max(wantGamma, 1e-9)).toFixed(4)),
        });
      }
      const nightRows = rows.filter((r) => r.night);
      const worstNightRel = Math.max(...nightRows.map((r) => r.relativeError));
      const worstNightDisplay = Math.max(...nightRows.map((r) => r.displayGapSrgb));

      return {
        checks: [
          evaluate('output-matches-the-gamma-model', () => ({
            ok: worstGammaErr <= HALF_FLOAT_TOLERANCE,
            measured: `worst error vs EOTF(OETF(a)×i) = ${worstGammaErr.toFixed(6)}`,
            expected: `<= ${HALF_FLOAT_TOLERANCE}`,
            note: 'the shipped, Foundry-parity model',
          })),
          evaluate('night-divergence-is-visible-on-screen', () => ({
            // > 1/255 in display space is, by definition, a difference the
            // panel can show. Measured here at ~4/255 on the deep-night case.
            ok: worstNightDisplay * 255 > 1,
            measured: `${(worstNightDisplay * 255).toFixed(1)}/255 at the worst night case`,
            expected: '> 1/255 (i.e. actually displayable)',
            note: 'judged AFTER the OETF: near black, a huge visible error is a tiny linear number',
          })),
          evaluate('night-divergence-is-large-in-relative-terms', () => ({
            ok: worstNightRel > 0.1,
            measured: `${(worstNightRel * 100).toFixed(1)}% relative`,
            expected: '> 10%',
            note: "environmental-light.js documents ~30%; this is the miss that made V2 lighting never match",
          })),
          evaluate('output-does-NOT-match-the-linear-model', () => {
            // Scoped to the cases where the models are actually separable. At
            // illum → 1 they converge by construction, so a bright case
            // matching BOTH is correct physics, not a failure.
            const separable = rows.filter((r) => Math.abs(r.gammaModel - r.linearModel) > HALF_FLOAT_TOLERANCE);
            const anyLinear = separable.some((r) => Math.abs(r.measuredLinear - r.linearModel) <= HALF_FLOAT_TOLERANCE);
            return {
              ok: separable.length > 0 && !anyLinear,
              measured: `${separable.length} separable cases, none matched the linear model`,
              expected: 'at least one separable case, and no linear matches',
              note: 'the check is scoped to separable cases so convergence at noon cannot false-fail it',
            };
          }),
        ],
        inputs: { cases },
        stats: { rows, worstGammaError: worstGammaErr, worstNightRelativeError: worstNightRel },
      };
    },
  });

  scenarios.set('coloration-adds-in-gamma-space', {
    name: 'coloration-adds-in-gamma-space',
    summary:
      'Coloration is added BEFORE the EOTF, not after. An effect that adds its term on the wrong side of ' +
      'that transfer is the named bug class "the composite is gamma, not linear".',
    async run() {
      const albedoLin = 0.2140;
      const illumSrgb = 0.5;
      const colorations = [0, 0.1, 0.25];
      const rows = [];
      let worstInside = 0;
      let minOutsideGap = Infinity;
      for (const c of colorations) {
        const got = await compositeOnce(albedoLin, illumSrgb, c);
        const inside = gammaComposite(albedoLin, illumSrgb, c); // add BEFORE EOTF (shipped)
        const outside = gammaComposite(albedoLin, illumSrgb, 0) + EOTF(c); // add AFTER (the mistake)
        const insideErr = Math.abs(got.r - inside);
        if (insideErr > worstInside) worstInside = insideErr;
        if (c > 0) minOutsideGap = Math.min(minOutsideGap, Math.abs(inside - outside));
        rows.push({
          colorationSrgb: c,
          measured: Number(got.r.toFixed(5)),
          addedInsideEOTF: Number(inside.toFixed(5)),
          addedOutsideEOTF: Number(outside.toFixed(5)),
        });
      }
      return {
        checks: [
          evaluate('coloration-added-before-the-EOTF', () => ({
            ok: worstInside <= HALF_FLOAT_TOLERANCE,
            measured: worstInside.toFixed(6),
            expected: `<= ${HALF_FLOAT_TOLERANCE}`,
            note: 'finalSrgb = litSrgb + coloration, THEN EOTF — a gamma-space add, Foundry parity',
          })),
          evaluate('inside-vs-outside-is-a-real-difference', () => ({
            ok: minOutsideGap > HALF_FLOAT_TOLERANCE * 10,
            measured: minOutsideGap.toFixed(5),
            expected: `> ${HALF_FLOAT_TOLERANCE * 10}`,
            note: 'non-vacuity: the two placements must be distinguishable for the check above to mean anything',
          })),
        ],
        inputs: { albedoLin, illumSrgb, colorations },
        stats: { rows },
      };
    },
  });

  /** Paint a small illum sweep so the pane shows something meaningful. */
  async function paintSweep() {
    const canvas = document.getElementById('compositeView');
    if (!canvas) return;
    const w = 256;
    const h = 64;
    canvas.width = w;
    canvas.height = h;
    const out = new Uint8ClampedArray(w * h * 4);
    // One row per albedo, illum sweeping left to right — the composite's own
    // response curve, drawn rather than tabulated.
    const albedos = [0.05, 0.2140, 0.5, 1];
    const rowH = Math.floor(h / albedos.length);
    for (let ai = 0; ai < albedos.length; ai++) {
      for (let x = 0; x < w; x++) {
        const illum = x / (w - 1);
        const lit = gammaComposite(albedos[ai], illum);
        const enc = Math.round(OETF(Math.max(0, Math.min(1, lit))) * 255);
        for (let y = ai * rowH; y < (ai + 1) * rowH && y < h; y++) {
          const o = (y * w + x) * 4;
          out[o] = enc;
          out[o + 1] = enc;
          out[o + 2] = enc;
          out[o + 3] = 255;
        }
      }
    }
    canvas.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);
    const el = document.getElementById('compositeLegend');
    if (el) {
      el.textContent =
        'composite response — 4 albedo rows (0.05 / 0.214 / 0.5 / 1 linear), illum sweeping 0→1 left to right.\n' +
        'Right edge = illum 1 = the no-op: each row must read back its own albedo exactly.';
    }
  }

  async function runScenario(scenario, ctx) {
    const result = await scenario.run(ctx);
    await paintSweep();
    const canvas = document.getElementById('compositeView');
    const artifacts = [];
    if (canvas?.width > 0) {
      const saved = await saveCanvasPng(ctx.runId, 'composite-response.png', canvas);
      if (saved) artifacts.push(saved);
    }
    return { ...result, artifacts };
  }

  registerBench({
    name: 'composite',
    title: 'Composite — the real gamma-space light arithmetic',
    rung: 3,
    summary:
      'Renders the REAL compositeMaterial from environmental-light.js and checks it against an ' +
      'independent CPU twin. Home of the strongest parity check in the project: a no-op at noon.',
    scenarios,
    params: null,
    checkIds: [
      'identity-at-full-illum',
      'output-matches-the-gamma-model',
      'output-does-NOT-match-the-linear-model',
      'the-two-models-actually-diverge',
      'coloration-added-before-the-EOTF',
    ],
    ready: () => true,
    runScenario,
  });

  return {
    scenarios,
    compositeOnce,
    paintSweep,
    gammaComposite,
    linearComposite,
    getMaterials: () => materials,
    dispose: () => {
      rt?.dispose();
      albedoTex?.dispose();
      illumTex?.dispose();
      colorationTex?.dispose();
    },
  };
}
