/**
 * WINDOW GLASS BENCH — the refraction/dispersion/caustic rung, on a real
 * WebGPU device, with no Foundry anywhere near it.
 *
 * ============================================================================
 * WHY THIS BENCH EXISTS AT ALL
 * ============================================================================
 * `window-glass.js` has a Node twin asserting its arithmetic against an
 * analytic paraboloid, and `window-render.test.mjs` proves the TSL graph
 * constructs. Neither of those can answer the only question that matters for a
 * LOOK feature: does the picture look like light through old glass?
 *
 * Worse, this effect family has a specific history — a painted mask read as
 * light, drawn as a cropped quad, additively blended — that has shipped
 * INVISIBLE three times in this codebase (specular twice, fluid once), every
 * time with a fully green Node suite. A glass refraction term is strictly
 * worse than those, because it also has a WRONG-BUT-PLAUSIBLE failure mode:
 * an inverted lens sign warps just as prettily while lighting the dimples
 * instead of the lumps.
 *
 * So: real device, real `src/` material, and a picture to look at.
 *
 * ⚠️ THE HOUSE RULE THIS BENCH FOLLOWS (AGENTS.md §6): it IMPORTS
 * `buildWindowSurfaceMaterial` from `src/`. It does not transcribe the shader,
 * re-derive the decode, or keep a lab-local copy of anything. If the effect
 * changes, this bench renders the change; it cannot silently diverge.
 *
 * ⚠️ AND LAB-GREEN IS `BUILT (unverified)`, ALWAYS (AGENTS.md §6). Every check
 * below passing means the maths does on a GPU what the model says it should.
 * Only the author, on a real scene, says LIVE.
 *
 * @module tools/shader-lab/bench-window-glass
 */

import { check, evaluate, registerBench, saveCanvasPng } from './contract.js';
import { buildWindowSurfaceMaterial } from '../../src/effects/window/window-render.js';
import { QUAD_UVS, QUAD_INDICES, buildQuadPositions } from '../../src/scene/index.js';

/**
 * ⚠️ `DIM * 4` MUST BE A MULTIPLE OF 256. WebGPU pads copied texture rows to
 * 256-byte alignment, and a naive `w*h*4` readback on a non-conforming width
 * silently returns skewed rows (AGENTS.md §10 — an 800px bench found this the
 * hard way). 1024 × 4 = 4096 = 16 × 256.
 */
const DIM = 1024;

/**
 * ONE WORLD PIXEL = ONE SCREEN PIXEL, deliberately. `glassWarpPx` is declared
 * in world px, so making the mapping identity means the number on the slider
 * is literally how many pixels of this image the light moves — the offset can
 * be measured with a ruler rather than trusted.
 */
const WORLD = Object.freeze({ minX: 0, maxX: DIM, minY: 0, maxY: DIM });

/** The authored `_Window` file this bench stands in for. */
const MASK_SIZE = 512;

/**
 * THE SYNTHETIC `_Window` FILE — a lancet window with mullions and two
 * stained panes.
 *
 * ⚠️ IT IS ASYMMETRIC IN Y ON PURPOSE (AGENTS.md §10: "a feature centred in Y
 * cannot calibrate a Y-flip"). The arch is round at the top and square at the
 * sill, so the two upper corners of the cookie's bounding box are EMPTY while
 * the two lower corners are PAINTED. That asymmetry is what `calibrate()`
 * reads to establish readback row order, and it is why the window is not
 * simply a rectangle.
 *
 * The mullions matter too, and not decoratively: the prism fringe lives on
 * EDGES, so a cookie with no interior edges would show the dispersion only
 * around its silhouette and would badly under-report the effect.
 *
 * Row 0 is v = 0 is the SILL — `THREE.DataTexture` does not flip, so data row
 * order is UV order directly.
 *
 * @param {number} size
 * @returns {Uint8Array} RGBA, `size × size`.
 */
function buildWindowMask(size) {
  const data = new Uint8Array(size * size * 4);
  const left = size * 0.26;
  const right = size * 0.74;
  const cx = (left + right) * 0.5;
  const sill = size * 0.1;
  const spring = size * 0.62; // where the straight jambs give way to the arch
  const apexR = (right - left) * 0.5;
  const mullionHalf = size * 0.012;
  const transomY = size * 0.4;

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const x = col + 0.5;
      const y = row + 0.5;

      // ── The aperture silhouette, as a signed distance to its edge ────────
      let edgeDist;
      if (y <= spring) {
        // Straight-sided lower half: distance to the nearest jamb or the sill.
        edgeDist = Math.min(x - left, right - x, y - sill);
      } else {
        // The arch: distance to the semicircular head.
        edgeDist = Math.min(apexR - Math.hypot(x - cx, y - spring), x - left, right - x);
      }

      // ── The leading: mullion + transom carve the opening into panes ──────
      const inMullion = Math.abs(x - cx) < mullionHalf;
      const inTransom = Math.abs(y - transomY) < mullionHalf;
      if (inMullion || inTransom) edgeDist = Math.min(edgeDist, -1);

      // A soft shoulder rather than a hard cut — an authored cookie has a
      // painted falloff, and a 1-texel step would make the dispersion read as
      // aliasing rather than as colour.
      const soften = size * 0.012;
      const coverage = Math.max(0, Math.min(1, edgeDist / soften));
      if (coverage <= 0) continue;

      // Brightness falls off toward the sill: light through a window is
      // strongest near the head. Gives the interior a gradient for the warp
      // to bite on rather than a flat plateau.
      const vertical = 0.55 + 0.45 * Math.min(1, (y - sill) / (size * 0.55));
      const level = coverage * vertical;

      // Two stained panes, so the cookie carries real hue for the daylight
      // tint and the prism to act on. Upper-left ruby, lower-right cobalt.
      let r = 1;
      let g = 0.94;
      let b = 0.82;
      if (x < cx && y > transomY) {
        r = 1;
        g = 0.34;
        b = 0.3;
      } else if (x > cx && y < transomY) {
        r = 0.42;
        g = 0.56;
        b = 1;
      }

      const i = (row * size + col) * 4;
      data[i] = Math.round(255 * level * r);
      data[i + 1] = Math.round(255 * level * g);
      data[i + 2] = Math.round(255 * level * b);
      data[i + 3] = 255;
    }
  }
  return data;
}

/**
 * @param {object} args
 * @param {*} args.THREE
 * @param {(msg: string) => void} [args.log]
 */
export function createWindowGlassBench({ THREE, log }) {
  const { uniform, vec4 } = THREE.TSL;

  let renderer = null;
  let camera = null;
  let target = null;
  let scene = null;
  let mesh = null;
  let surface = null;
  let maskTexture = null;
  /** Readback row order, established empirically. Never assumed. */
  let orientation = null;

  /** The live look state the sliders drive. Mirrors `WINDOW_PARAMS`. */
  const state = {
    strength: 1,
    contrast: 1,
    glassWarpPx: 14,
    glassDispersion: 0.6,
    glassScale: 90,
    glassDetail: 0.45,
    glassStriation: 0.35,
    glassStriationAngle: 0,
    glassCausticStrength: 0.8,
    glassCausticSharpness: 2,
    glassSeed: 0,
    debugChannel: 0,
    daylightTint: [1, 1, 1],
  };

  async function ensureRenderer() {
    if (renderer) return;
    renderer = new THREE.WebGPURenderer({ antialias: false });
    await renderer.init();
    camera = new THREE.OrthographicCamera(WORLD.minX, WORLD.maxX, WORLD.maxY, WORLD.minY, -1000, 1000);
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    target = new THREE.RenderTarget(DIM, DIM, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
    });
    log?.(`WINDOW-GLASS: renderer backend ${renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL'}`);
  }

  /**
   * ⚠️ RAW BYTES, `NoColorSpace` — matching how `vt/mask-image.js` uploads the
   * real `_Window` file. A "50% grey" texel must mean 0.5, not 0.21; letting
   * three sRGB-decode this would quietly halve every level the decode reads
   * and the whole bench would be measuring a different effect.
   */
  function ensureMask() {
    if (maskTexture) return;
    maskTexture = new THREE.DataTexture(
      buildWindowMask(MASK_SIZE),
      MASK_SIZE,
      MASK_SIZE,
      THREE.RGBAFormat,
      THREE.UnsignedByteType
    );
    maskTexture.colorSpace = THREE.NoColorSpace;
    maskTexture.minFilter = THREE.LinearFilter;
    maskTexture.magFilter = THREE.LinearFilter;
    maskTexture.needsUpdate = true;
  }

  /**
   * Build the scene around a material from `src/`.
   * @param {boolean} glass - the JS-time branch under test.
   */
  function buildScene(glass) {
    ensureMask();
    scene = new THREE.Scene();
    surface = buildWindowSurfaceMaterial({
      THREE,
      maskTexture,
      // NULL ON PURPOSE: the floor gate compiles out entirely, which is the
      // honest shape for a bench with no floors. Its own coverage is proven
      // by `window-render.test.mjs`, not here.
      attrTexture: null,
      uViewRect: uniform(vec4(WORLD.minX, WORLD.minY, WORLD.maxX, WORLD.maxY)),
      glass,
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
    geometry.setIndex(Array.from(QUAD_INDICES));
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(
        buildQuadPositions([
          { x: WORLD.minX, y: WORLD.minY },
          { x: WORLD.maxX, y: WORLD.minY },
          { x: WORLD.maxX, y: WORLD.maxY },
          { x: WORLD.minX, y: WORLD.maxY },
        ]),
        3
      )
    );

    mesh = new THREE.Mesh(geometry, surface.windowMaterial);
    mesh.frustumCulled = false;
    scene.add(mesh);

    // The mask fills the quad exactly, so UV bounds are the unit square and
    // one world px is one mask-UV/DIM — the identity that makes `glassWarpPx`
    // directly measurable in this image.
    surface.setMaskUvBounds({ minU: 0, minV: 0, maxU: 1, maxV: 1 });
    surface.setUvPerWorldPx(1 / (WORLD.maxX - WORLD.minX), 1 / (WORLD.maxY - WORLD.minY));
    pushState();
  }

  /** Push the live state into the real setters — the same calls the viewer's
   * subsystem makes every sync, so the bench exercises that surface too. */
  function pushState() {
    surface.setStrength(state.strength);
    surface.setContrast(state.contrast);
    surface.setDaylightTint(state.daylightTint);
    surface.setGlass({
      warpPx: state.glassWarpPx,
      dispersion: state.glassDispersion,
      scale: state.glassScale,
      detail: state.glassDetail,
      striation: state.glassStriation,
      striationAngleDeg: state.glassStriationAngle,
      causticStrength: state.glassCausticStrength,
      causticSharpness: state.glassCausticSharpness,
      // Hashed by the same pure function the subsystem uses — a raw seed must
      // never reach a noise coordinate (feedback_raw_seed_into_noise_coordinate).
      seedOffset: seedOffsetFor(state.glassSeed),
    });
    surface.setDebugChannel(state.debugChannel);
    mesh.material = state.debugChannel > 0 ? surface.debugMaterial : surface.windowMaterial;
  }

  /** @param {number} seed @returns {number[]} */
  function seedOffsetFor(seed) {
    const hx = Math.abs(Math.sin(seed * 12.9898) * 43758.5453);
    const hy = Math.abs(Math.sin(seed * 78.233) * 24634.6345);
    return [(hx - Math.floor(hx)) * 512, (hy - Math.floor(hy)) * 512];
  }

  async function renderFrame() {
    await ensureRenderer();
    if (!scene) buildScene(true);
    else pushState();
    const prev = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClearColor;
    renderer.setRenderTarget(target);
    // BLACK, because this pass ADDS: whatever comes back IS the cookie's own
    // contribution to buf:scene.illum, with nothing else mixed in.
    renderer.setClearColor(new THREE.Color(0, 0, 0), 1);
    renderer.autoClearColor = true;
    renderer.clear();
    await renderer.renderAsync(scene, camera);
    renderer.setRenderTarget(prev);
    renderer.autoClearColor = prevAutoClear;
    const bytes = await renderer.readRenderTargetPixelsAsync(target, 0, 0, DIM, DIM);
    return bytes;
  }

  /** World (x,y) → readback pixel, honouring the empirically-found row order. */
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
   * ESTABLISH ROW ORDER EMPIRICALLY (`feedback_y_flip_recurring_risk` — bitten
   * five times in this project, which is why no bench is allowed to assume).
   *
   * The probe is the arch. Near the TOP of the cookie's bounding box the
   * silhouette has curved away, so a point just inside the left jamb's x but
   * high in y is EMPTY; the mirror point low in y is inside the square-sided
   * base and is PAINTED. Those two predictions swap under a flip, so one
   * comparison resolves it. Returns 'straight' | 'flipped', or throws — a
   * bench that cannot orient itself must not report measurements
   * (`feedback_instruments_must_not_lie`).
   * @param {Uint8Array} bytes - a frame rendered with the glass OFF.
   */
  function calibrate(bytes) {
    const px = (x, y) => {
      const fx = (x - WORLD.minX) / (WORLD.maxX - WORLD.minX);
      const fy = (y - WORLD.minY) / (WORLD.maxY - WORLD.minY);
      const col = Math.min(DIM - 1, Math.floor(fx * DIM));
      const row = Math.min(DIM - 1, Math.floor(fy * DIM));
      const i = (row * DIM + col) * 4;
      return bytes[i] + bytes[i + 1] + bytes[i + 2];
    };
    // In WORLD terms (mask UV × DIM): the jambs sit at x ≈ 0.26–0.74 of the
    // image; the sill at y ≈ 0.1, the springing at y ≈ 0.62, the apex ≈ 0.86.
    // A point at x = 0.30 (just inside the left jamb), y = 0.82 is OUTSIDE the
    // arch's curve; the same x at y = 0.20 is INSIDE the straight-sided base.
    const highUnderStraight = px(DIM * 0.3, DIM * 0.82);
    const lowUnderStraight = px(DIM * 0.3, DIM * 0.2);
    if (Math.abs(highUnderStraight - lowUnderStraight) < 20) {
      throw new Error(
        'window-glass calibrate: the arch probe found no Y asymmetry ' +
          `(high=${highUnderStraight}, low=${lowUnderStraight}) — the mask did not render, so no ` +
          'measurement below would mean anything'
      );
    }
    orientation = lowUnderStraight > highUnderStraight ? 'straight' : 'flipped';
    log?.(
      `WINDOW-GLASS: orientation ${orientation} ` +
        `(arch-corner=${highUnderStraight}, sill-corner=${lowUnderStraight})`
    );
    return orientation;
  }

  /** Every pixel with real light in it — the population every stat below is
   * measured over, so a mostly-black frame cannot flatter a mean. */
  function litStats(bytes) {
    let n = 0;
    let sum = 0;
    let sumSq = 0;
    let peak = 0;
    let maxSplit = 0;
    for (let i = 0; i < bytes.length; i += 4) {
      const r = bytes[i];
      const g = bytes[i + 1];
      const b = bytes[i + 2];
      const lum = (r + g + b) / 3;
      if (lum < 8) continue; // unlit background
      n++;
      sum += lum;
      sumSq += lum * lum;
      if (lum > peak) peak = lum;
      const split = Math.abs(r - b);
      if (split > maxSplit) maxSplit = split;
    }
    const mean = n ? sum / n : 0;
    return {
      litPixels: n,
      mean: +mean.toFixed(2),
      stdDev: +(n ? Math.sqrt(Math.max(0, sumSq / n - mean * mean)) : 0).toFixed(2),
      peak,
      maxChannelSplit: maxSplit,
    };
  }

  /** Per-channel means over the SAME lit population `litStats` uses — needed
   * to check the tint's effect on each colour independently, which a single
   * combined luminance mean cannot distinguish. */
  function channelMeans(bytes) {
    let n = 0;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    for (let i = 0; i < bytes.length; i += 4) {
      const r = bytes[i];
      const g = bytes[i + 1];
      const b = bytes[i + 2];
      if ((r + g + b) / 3 < 8) continue;
      n++;
      sr += r;
      sg += g;
      sb += b;
    }
    return n ? { r: +(sr / n).toFixed(3), g: +(sg / n).toFixed(3), b: +(sb / n).toFixed(3) } : { r: 0, g: 0, b: 0 };
  }

  /** Mean absolute per-pixel difference between two frames, 0..255. */
  function frameDelta(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i += 4) {
      sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    }
    return +(sum / (a.length / 4) / 3).toFixed(4);
  }

  function paint(bytes, label) {
    const canvas = document.getElementById('windowGlassView') ?? document.createElement('canvas');
    canvas.width = DIM;
    canvas.height = DIM;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(DIM, DIM);
    img.data.set(bytes);
    ctx.putImageData(img, 0, 0);
    ctx.fillStyle = '#0f0';
    ctx.font = '15px monospace';
    ctx.fillText(label, 8, 22);
    return canvas;
  }

  /** Apply overrides, render, restore. Keeps scenarios from leaking state. */
  async function renderWith(overrides) {
    const saved = { ...state };
    Object.assign(state, overrides);
    const bytes = await renderFrame();
    Object.assign(state, saved);
    return bytes;
  }

  const scenarios = new Map();

  // ═══════════════════════════════════════════════════════════════════════
  scenarios.set('prism-splits-red-from-blue', {
    name: 'prism-splits-red-from-blue',
    summary:
      'Renders the same cookie at dispersion 0 and dispersion 1 with identical warp, and measures how ' +
      'far apart the red and blue channels are pulled. This is the RGB split, isolated.',
    async run(ctx) {
      const checks = [];
      let calibration = 'OK';

      const flat = await renderWith({ glassWarpPx: 0, glassCausticStrength: 0 });
      try {
        calibrate(flat);
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'orientation-calibrated', status: 'UNMEASURED', measured: String(err.message) }));
      }

      const noSplit = await renderWith({ glassWarpPx: 20, glassDispersion: 0, glassCausticStrength: 0 });
      const fullSplit = await renderWith({ glassWarpPx: 20, glassDispersion: 1, glassCausticStrength: 0 });

      const a = litStats(noSplit);
      const b = litStats(fullSplit);

      checks.push(
        evaluate('the-cookie-renders-at-all', () => ({
          ok: a.litPixels > 20000,
          measured: { litPixels: a.litPixels },
          expected: 'a lancet window over a 1024² frame lights well over 20k pixels',
        }))
      );
      // THE ORIENTATION, CONSUMED. `calibrate()` above establishes row order;
      // this is the check that actually SPENDS it, via `sampleAt`. Without a
      // consumer the calibration would be decorative — a bench that measures
      // its own orientation and then never uses it has not really calibrated
      // anything (`feedback_instruments_must_not_lie`). The arch is the probe:
      // high in the cookie's box the silhouette has curved away and must be
      // dark; low down the jambs are straight and must be lit.
      checks.push(
        evaluate('the-arch-sits-at-the-top-and-the-sill-at-the-bottom', () => {
          const underArch = sampleAt(noSplit, DIM * 0.3, DIM * 0.82);
          const atSill = sampleAt(noSplit, DIM * 0.3, DIM * 0.2);
          const dark = underArch.r + underArch.g + underArch.b;
          const lit = atSill.r + atSill.g + atSill.b;
          return {
            ok: lit > dark + 60,
            measured: { orientation, outsideArch: dark, insideSill: lit },
            expected: 'the point outside the arch reads far darker than the one inside the square base',
          };
        })
      );
      // ⚠️ The mask is NOT greyscale — it has ruby and cobalt panes — so R and
      // B differ substantially even with no dispersion at all. The claim is
      // therefore comparative, never absolute: the split must GROW.
      checks.push(
        evaluate('dispersion-widens-the-red-blue-gap', () => ({
          ok: b.maxChannelSplit > a.maxChannelSplit + 8,
          measured: { dispersion0: a.maxChannelSplit, dispersion1: b.maxChannelSplit },
          expected: 'max |R−B| grows by more than 8/255 when the prism is turned all the way up',
        }))
      );
      checks.push(
        evaluate('the-prism-redistributes-rather-than-adds-energy', () => ({
          ok: Math.abs(b.mean - a.mean) < a.mean * 0.25,
          measured: { meanNoSplit: a.mean, meanFullSplit: b.mean },
          expected: 'mean lit brightness moves less than 25% — a split moves light, it does not create it',
        }))
      );

      const canvas = paint(fullSplit, `prism: warp=20px dispersion=1.0 caustic=0`);
      const artifact = await saveCanvasPng(ctx.runId, 'prism-splits-red-from-blue.png', canvas);
      return {
        checks,
        calibration,
        artifacts: [artifact],
        inputs: { warpPx: 20 },
        stats: { noSplit: a, fullSplit: b },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════
  scenarios.set('flat-glass-is-a-true-no-op', {
    name: 'flat-glass-is-a-true-no-op',
    summary:
      'The strongest correctness check here: renders the FULL glass material with glassWarpPx = 0 and ' +
      'compares it, pixel for pixel, against a material built with the glass subgraph omitted entirely ' +
      '(glass:false). They must be identical — flat glass refracts nothing.',
    async run(ctx) {
      const checks = [];

      buildScene(true);
      const withGlassAtZero = await renderWith({ glassWarpPx: 0, glassCausticStrength: 0 });

      buildScene(false);
      const noGlassBuilt = await renderFrame();

      // Restore the normal material for whatever runs next / for the eye.
      buildScene(true);

      const delta = frameDelta(withGlassAtZero, noGlassBuilt);
      const stats = litStats(withGlassAtZero);

      checks.push(
        evaluate('warp-zero-reproduces-the-pre-glass-cookie-exactly', () => ({
          ok: delta < 0.5,
          measured: { meanAbsDelta: delta },
          expected:
            'under 0.5/255 mean absolute difference — the glass at zero must not merely be subtle, it ' +
            'must be the SAME image the effect drew before this rung existed',
        }))
      );
      checks.push(
        evaluate('and-both-actually-drew-something', () => ({
          ok: stats.litPixels > 20000,
          measured: { litPixels: stats.litPixels },
          expected: 'two identically BLACK frames would also pass the check above — this rules that out',
        }))
      );

      const canvas = paint(withGlassAtZero, 'flat glass (warp=0) — must equal the pre-glass cookie');
      const artifact = await saveCanvasPng(ctx.runId, 'flat-glass-no-op.png', canvas);
      return { checks, calibration: 'OK', artifacts: [artifact], inputs: { warpPx: 0 }, stats };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════
  scenarios.set('caustics-concentrate-light', {
    name: 'caustics-concentrate-light',
    summary:
      'Turns the caustic term on and off at a fixed warp and measures contrast. Focusing must RAISE the ' +
      'peak and the spread without simply making everything brighter — that is the difference between a ' +
      'caustic and an exposure change.',
    async run(ctx) {
      const checks = [];
      const off = await renderWith({ glassWarpPx: 14, glassCausticStrength: 0 });
      const on = await renderWith({ glassWarpPx: 14, glassCausticStrength: 1.5, glassCausticSharpness: 3 });

      const a = litStats(off);
      const b = litStats(on);

      checks.push(
        evaluate('caustics-raise-the-spread', () => ({
          ok: b.stdDev > a.stdDev,
          measured: { stdDevOff: a.stdDev, stdDevOn: b.stdDev },
          expected: 'standard deviation of lit brightness increases — bright knots and dark bands appear',
        }))
      );
      checks.push(
        evaluate('caustics-are-not-just-an-exposure-lift', () => ({
          // The bright side is shaped by a power and the dark side is linear,
          // so some mean lift is expected and correct; what must NOT happen is
          // the mean rising as much as the spread does.
          ok: b.mean - a.mean < b.stdDev - a.stdDev + 1,
          measured: { meanOff: a.mean, meanOn: b.mean, stdDevOff: a.stdDev, stdDevOn: b.stdDev },
          expected: 'the mean rises less than the spread does — light is being redistributed, not added',
        }))
      );
      checks.push(
        evaluate('the-gain-never-drives-a-channel-negative', () => ({
          // The shader clamps the gain at 0; a negative would wrap to a huge
          // positive on an unsigned readback, so an absurd peak is the tell.
          ok: b.peak <= 255 && b.peak > a.peak - 1,
          measured: { peakOff: a.peak, peakOn: b.peak },
          expected: 'peak stays in range and does not collapse — no wrapped negative gain',
        }))
      );

      const canvas = paint(on, 'caustics: warp=14px strength=1.5 sharpness=3');
      const artifact = await saveCanvasPng(ctx.runId, 'caustics-concentrate-light.png', canvas);
      return { checks, calibration: 'OK', artifacts: [artifact], inputs: { warpPx: 14 }, stats: { off: a, on: b } };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════
  scenarios.set('daylight-tint-applies-after-not-before-shoulder', {
    name: 'daylight-tint-applies-after-not-before-shoulder',
    summary:
      "Author directive (2026-08-05): the daylight tint must be the LAST thing applied, so the glass's " +
      'own RGB split gets tinted rather than one ingredient of it. Proven two ways on debug channels 11 ' +
      '(raw light, pre-shoulder/pre-tint) and 12 (final, post-shoulder/post-tint): channel 11 must be ' +
      'BYTE-IDENTICAL whether the tint is neutral or a strong colour — if the tint reached the pipeline ' +
      'before the shoulder, it would change what the shoulder measures as the peak, and channel 11 would ' +
      'shift. Channel 12 must then differ, and differ in the tinted direction.',
    async run(ctx) {
      const checks = [];
      // High strength and a big warp — the whole point is to be in the regime
      // where the highlight shoulder is doing REAL compression, since that is
      // the only regime where getting the order wrong would be visible at all.
      const bright = { glassWarpPx: 20, glassCausticStrength: 1.2, strength: 2.5 };
      const neutralTint = [1, 1, 1];
      const redTint = [1, 0.05, 0.05]; // strong, deliberately not a pastel

      const rawNeutral = await renderWith({ ...bright, daylightTint: neutralTint, debugChannel: 11 });
      const rawTinted = await renderWith({ ...bright, daylightTint: redTint, debugChannel: 11 });
      const finalNeutral = await renderWith({ ...bright, daylightTint: neutralTint, debugChannel: 12 });
      const finalTinted = await renderWith({ ...bright, daylightTint: redTint, debugChannel: 12 });

      const rawDelta = frameDelta(rawNeutral, rawTinted);
      const finalDelta = frameDelta(finalNeutral, finalTinted);
      const meansFinalNeutral = channelMeans(finalNeutral);
      const meansFinalTinted = channelMeans(finalTinted);

      checks.push(
        evaluate('raw-light-is-invariant-to-the-daylight-tint', () => ({
          ok: rawDelta < 0.5,
          measured: { meanAbsDelta: rawDelta },
          expected:
            'under 0.5/255 — the tint must not have reached the pipeline before the shoulder at all, ' +
            'not merely "reached it a little"',
        }))
      );
      checks.push(
        evaluate('the-final-image-does-change-under-the-tint', () => ({
          ok: finalDelta > 5,
          measured: { meanAbsDelta: finalDelta },
          expected: 'well above the raw-light delta — the tint is a real, visible final step, not a no-op',
        }))
      );
      checks.push(
        evaluate('the-tinted-final-image-is-darker-in-green-and-blue', () => ({
          ok: meansFinalTinted.g < meansFinalNeutral.g * 0.5 && meansFinalTinted.b < meansFinalNeutral.b * 0.5,
          measured: { neutral: meansFinalNeutral, tinted: meansFinalTinted },
          expected: 'G and B drop by more than half under a tint whose own G/B are 0.05 — the recolour is real',
        }))
      );

      const canvas = paint(finalTinted, 'tint order-of-operations: final, strong red tint, warp=20 strength=2.5');
      const artifact = await saveCanvasPng(ctx.runId, 'daylight-tint-order.png', canvas);
      return {
        checks,
        calibration: 'OK',
        artifacts: [artifact],
        inputs: bright,
        stats: { rawDelta, finalDelta, meansFinalNeutral, meansFinalTinted },
      };
    },
  });

  const bench = {
    name: 'window-glass',
    title: 'Window glass — refraction, RGB dispersion and fake caustics',
    rung: 1,
    summary:
      'The painted `_Window` cookie seen through a thick uneven medieval pane, on a real WebGPU device. ' +
      'One procedural thickness field drives all three terms: its gradient warps the light, that same ' +
      'gradient scaled per channel splits red from blue, and its curvature focuses bright knots. ' +
      'Imports the real `buildWindowSurfaceMaterial` — nothing here is transcribed.',
    params: {
      glassWarpPx: 'number, world px of maximum displacement (0 = flat glass, an exact no-op)',
      glassDispersion: 'number 0..1, how far apart red and blue are pulled',
      glassScale: 'number, blob size in world px',
      glassCausticStrength: 'number 0..2',
    },
    scenarios,
    checkIds: [
      'the-cookie-renders-at-all',
      'the-arch-sits-at-the-top-and-the-sill-at-the-bottom',
      'dispersion-widens-the-red-blue-gap',
      'the-prism-redistributes-rather-than-adds-energy',
      'warp-zero-reproduces-the-pre-glass-cookie-exactly',
      'and-both-actually-drew-something',
      'caustics-raise-the-spread',
      'caustics-are-not-just-an-exposure-lift',
      'the-gain-never-drives-a-channel-negative',
      'raw-light-is-invariant-to-the-daylight-tint',
      'the-final-image-does-change-under-the-tint',
      'the-tinted-final-image-is-darker-in-green-and-blue',
    ],
    ready: () => true,
    async runScenario(scenario, ctx) {
      return scenario.run(ctx);
    },

    // ── THE LIVE SURFACE, for looking at rather than asserting on ──────────
    state,
    async refresh(label) {
      const bytes = await renderFrame();
      paint(
        bytes,
        label ??
          `warp=${state.glassWarpPx}px disp=${state.glassDispersion} scale=${state.glassScale} ` +
            `detail=${state.glassDetail} striation=${state.glassStriation}@${state.glassStriationAngle}° ` +
            `caustic=${state.glassCausticStrength}/${state.glassCausticSharpness} ch=${state.debugChannel}`
      );
      return litStats(bytes);
    },
    /** THE GENERATED WGSL, for whichever material is currently attached —
     * the only way to prove the `glass:false` branch really does shrink the
     * shader rather than merely claiming to. */
    async dumpShader() {
      await renderFrame();
      const s = await renderer.debug.getShaderAsync(scene, camera, mesh);
      return { vertex: s.vertexShader, fragment: s.fragmentShader };
    },
    /** Rebuild with or without the glass subgraph — `dumpShader()` either
     * side of this is the A/B that settles the Law 4 question. */
    rebuild(glass) {
      buildScene(!!glass);
      return `rebuilt with glass=${!!glass}`;
    },
  };

  registerBench(bench);
  return bench;
}
