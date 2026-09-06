/**
 * SHADER LAB — THE CLOUD BENCH.
 *
 * ============================================================================
 * WHY THIS EXISTS BEFORE ANY OF THE EFFECT IS WIRED
 * ============================================================================
 *
 * `bench-precip.js` records the author commissioning exactly this workflow, in
 * these words: *"it's a very large system so you might want to set yourself up
 * with the shader lab so that you can use that as a way to test the appearance
 * of the shaders as you develop and also allow you to throw different values at
 * the shader and check how it changes."* Its reason was that precipitation had
 * ~10 look dials whose correct values nobody knew.
 *
 * Clouds has EIGHTEEN per keyframe across FIVE keyframes, every one of them
 * derived from real cloud morphology and published technique, and not one of
 * them ever seen on a screen. `docs/planning/Clouds.md` §8 independently
 * reaches the same conclusion ("Shader Lab first"). Finding those values by
 * reloading Foundry is the slow loop this tool exists to abolish.
 *
 * ============================================================================
 * WHAT IS REAL HERE
 * ============================================================================
 *
 * REAL, imported and never transcribed: `src/world/cloud-field.js` — the
 * recipe table, the keyframe blend, the coverage calibration, and the entire
 * TSL graph. The bench supplies a quad, a camera and a view rect; every pixel
 * of shape comes from the production module. If a number in the recipe table
 * is wrong, the picture here is wrong in the same way the map will be.
 *
 * SYNTHETIC: the view rect (a plain world-px window, standing in for the
 * viewer's camera) and the wind (a bearing typed in, standing in for the
 * weather manager).
 *
 * ============================================================================
 * ⚠️ THE RENDER PATH NEVER TOUCHES THE ON-SCREEN CANVAS
 * ============================================================================
 *
 * Copied deliberately from `candle-lab.js#capture`, whose own header records
 * the finding: when the Browser pane is not the displayed one the page stops
 * compositing entirely, so a screenshot times out and `canvas.toBlob()` has no
 * guaranteed swap-chain contents. Everything here renders into its own
 * RenderTarget and reads back on the GPU queue, so it produces identical bytes
 * whether or not anybody is watching — which is the whole point
 * (`feedback_instruments_must_not_lie`).
 *
 * @module tools/shader-lab/cloud-lab
 */

import {
  CLOUD_KEYFRAMES,
  cloudRecipeFor,
  coverThreshold,
  createCloudUniforms,
  pushCloudUniforms,
  buildCloudFieldNode,
} from '../../src/world/cloud-field.js';
import { windFlowVector } from '../../src/world/wind-bake.js';
import { buildCloudTopsNode } from '../../src/effects/clouds/cloud-shade.js';
import { marchDirectionToSun } from '../../src/effects/lighting/sun-occlusion.js';

/** The views this bench can render. */
export const CLOUD_VIEWS = Object.freeze([
  'tops', // THE SPECTACLE — the field lit by the sun (effects/clouds/cloud-shade.js)
  'satellite', // white cloud on sky — the shape, as an eye reads it
  'shadow', // what the GROUND sees: the cloud's own key transmittance
  'coverage', // raw `cov`, greyscale — for measuring, not for looking
  'thickness',
  'base', // the pre-threshold shape, for the coverage calibration
]);

/**
 * Build the visualisation graph for one view over the real field.
 * @param {object} THREE @param {object} u @param {string} view @param {number} octaves
 */
function buildViewMaterial(THREE, u, view, octaves, sunU) {
  const TSL = THREE.TSL;
  const { uv, vec3, vec4, float, uniform, mix, clamp } = TSL;

  const uRect = uniform(TSL.vec4(0, 0, 4000, 3000));
  const worldXY = TSL.vec2(mix(uRect.x, uRect.z, uv().x), mix(uRect.y, uRect.w, uv().y));

  const field = buildCloudFieldNode(TSL, { worldXY, uniforms: u, octaves });
  const { cov, thickness, base } = field;

  let rgb;
  if (view === 'tops') {
    // The REAL shading module, over the REAL field. Sky colours stand in for
    // `sky-access.js`'s key/fill (which this bench has no handle for): a warm
    // sun disc and a blue dome, at roughly the strengths that module produces
    // at a clear mid-morning.
    const tops = buildCloudTopsNode(TSL, {
      worldXY,
      uniforms: u,
      buildField: buildCloudFieldNode,
      sun: { dirXY: sunU.dir, sinElev: sunU.sinElev, cosElev: sunU.cosElev, tanElev: sunU.tanElev },
      colors: { keyRgb: sunU.keyRgb, fillRgb: sunU.fillRgb },
      octaves,
    });
    // Composited over a sky so the alpha is visible as an alpha — the tops draw
    // over the map in production, and judging them on black would flatter them.
    const sky = vec3(0.1, 0.17, 0.31);
    rgb = mix(sky, tops.rgb, clamp(tops.alpha, 0, 1));
  } else if (view === 'satellite') {
    // A satellite read: deep sky blue behind, cloud white in front, the cloud's
    // own brightness rising with thickness so a thin veil reads as a veil.
    // A wide tonal range on purpose: this view is how a human judges the
    // field, and a cloud rendered as flat white is indistinguishable from a
    // cloud with no internal structure at all. Grey base, brightening well
    // past it with thickness, so interior variation is visible rather than
    // clipped away.
    const sky = vec3(0.09, 0.15, 0.28);
    const cloud = vec3(0.42, 0.46, 0.54).add(vec3(0.55, 0.52, 0.46).mul(clamp(thickness, 0, 1)));
    rgb = mix(sky, cloud, clamp(cov, 0, 1));
  } else if (view === 'shadow') {
    // THE PRIMARY DELIVERABLE — what the map's ground actually receives.
    // `0.30` is the fill's share of the outdoor light at clear noon, which is
    // the measured diffuse fraction under a cumulus shadow and the floor
    // `buildCloudKeyTransmittanceNode` derives from the sky handle in
    // production. Hard-coded here only because this bench has no sky handle.
    const vis = mix(float(1), float(0.3), clamp(thickness, 0, 1));
    rgb = vec3(vis, vis, vis);
  } else if (view === 'coverage') {
    rgb = vec3(cov, cov, cov);
  } else if (view === 'thickness') {
    rgb = vec3(thickness, thickness, thickness);
  } else {
    rgb = vec3(base, base, base);
  }

  const mat = new THREE.NodeMaterial();
  mat.depthTest = false;
  mat.depthWrite = false;
  mat.fragmentNode = vec4(rgb, float(1));
  mat.name = `Cloud_${view}`;
  return { mat, uRect };
}

/**
 * The driver. One renderer, one quad, one material per view (built lazily and
 * cached — a material rebuild is a shader compile, and doing one per frame
 * would make the instrument the dominant cost).
 */
export class CloudDriver {
  constructor({ THREE, canvas = null, octaves = 5 }) {
    this.THREE = THREE;
    this.octaves = octaves;
    this.renderer = new THREE.WebGPURenderer({ canvas: canvas ?? undefined, antialias: false, alpha: false });
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene = new THREE.Scene();
    this.u = createCloudUniforms(THREE.TSL);
    const T = THREE.TSL;
    // The sun, as the bench's stand-in for `effects/sky-access.js`.
    this.sunU = {
      dir: T.uniform(T.vec2(1, 0)),
      sinElev: T.uniform(T.float(0.5)),
      cosElev: T.uniform(T.float(0.866)),
      tanElev: T.uniform(T.float(0.577)),
      keyRgb: T.uniform(T.vec3(1.0, 0.93, 0.84)),
      fillRgb: T.uniform(T.vec3(0.46, 0.63, 1.0)),
    };
    this.materials = new Map();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.ready = this.renderer.init();
    this.state = {
      cloudType01: 0.55,
      cover01: 0.45,
      scalePx: 1100,
      windDeg: 90,
      windSpeedPxPerSec: 8,
      drift: { x: 0, y: 0 },
      boil: 0,
      viewPx: 6000,
      centre: { x: 0, y: 0 },
      sunAzimuthDeg: 135,
      sunElevationDeg: 35,
      keyRgb: [1.0, 0.93, 0.84],
      fillRgb: [0.46, 0.63, 1.0],
    };
  }

  /** Which backend actually came up — WebGPU where available, WebGL2 where not.
   * TSL compiles to both (Effects.md Law 8), so the shader code is identical
   * either way; only the compiled target differs. Reported so a run's
   * provenance says which one produced the picture. */
  get backend() {
    return this.renderer?.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2';
  }

  materialFor(view) {
    if (!this.materials.has(view)) {
      this.materials.set(view, buildViewMaterial(this.THREE, this.u, view, this.octaves, this.sunU));
      // ⚠️ WARM-UP FLAG. A material's FIRST render is the one that compiles it,
      // and on the WebGL backend the very first `gl.readPixels` after that
      // compile came back all zeros — a fully black frame with no GL error
      // (`getError()` returned 0) and no console error, only TSL's own
      // variable-renaming warnings. Reading a second time returns the real
      // pixels. So the first draw of any new material is treated as a throwaway
      // (see `readTile`); an instrument that silently reports black as a
      // measurement is exactly the failure `feedback_instruments_must_not_lie`
      // names, and this one cost a round of chasing a shader bug that was not
      // there.
      this._cold = this._cold ?? new Set();
      this._cold.add(view);
    }
    return this.materials.get(view);
  }

  /** Push a frame's state into the real uniform pusher. */
  apply(patch = {}) {
    Object.assign(this.state, patch);
    const s = this.state;
    const recipe = cloudRecipeFor(s.cloudType01);
    const flow = windFlowVector(s.windDeg + recipe.shearDeg);
    pushCloudUniforms(this.u, {
      recipe,
      cover01: s.cover01,
      scalePx: s.scalePx,
      drift: s.drift,
      boil: s.boil,
      windDir: { x: flow.x, y: flow.y },
    });
    // THE SUN — azimuth through the ONE convention every consumer in this
    // engine resolves through (`sun-occlusion.js#marchDirectionToSun`), never
    // hand-rolled trig here.
    const d = marchDirectionToSun(s.sunAzimuthDeg);
    const e = (s.sunElevationDeg * Math.PI) / 180;
    this.sunU.dir.value.set(d.x, d.y);
    this.sunU.sinElev.value = Math.sin(e);
    this.sunU.cosElev.value = Math.cos(e);
    this.sunU.tanElev.value = Math.max(0.02, Math.tan(e));
    this.sunU.keyRgb.value.set(...s.keyRgb);
    this.sunU.fillRgb.value.set(...s.fillRgb);
    // THE CALIBRATION HOOK — overwrite the threshold the production pusher
    // just derived, so {@link calibrateThresholds} can search for the value
    // that makes coverage true while leaving `u.cover` (which the cell-polarity
    // bell reads) at the real target. Never set outside calibration.
    if (Number.isFinite(s.thresholdOverride)) this.u.threshold.value = s.thresholdOverride;
    // THE RECIPE ITERATION HOOK — for tuning ONE recipe field live against
    // the real GPU before touching `cloud-field.js`'s own source. Pass e.g.
    // `{ recipeOverride: { warp: 0.4 } }`; never used by production code, and
    // cleared automatically on the NEXT `apply()` that omits it (so a portrait
    // render's own internal `apply()` call can't accidentally inherit a stale
    // override from a previous experiment).
    if (s.recipeOverride) {
      for (const [key, val] of Object.entries(s.recipeOverride)) {
        if (this.u[key] && Number.isFinite(val)) this.u[key].value = val;
      }
    }
    return recipe;
  }

  /**
   * Render one tile offscreen and return its RGBA bytes.
   *
   * ⚠️ SYNCHRONOUS `gl.readPixels`, NOT `readRenderTargetPixelsAsync`, and
   * this is not a micro-optimisation — the async path NEVER RESOLVES here.
   * Measured in this environment, 2026-09-06: `requestAnimationFrame` fires
   * **zero** times in the Browser pane (confirmed with a counter over 600 ms,
   * with the pane fronted), and three's async readback waits on a fence it
   * polls from a frame callback. So the promise simply never settles and the
   * whole bench hangs with no error anywhere — the single most misleading
   * failure shape there is.
   *
   * `bench-precip.js`'s header already names the same root cause for its own
   * clock ("rAF is FULLY PAUSED — not throttled, STOPPED"); this is that same
   * fact arriving in the readback path. Reading the bound framebuffer directly
   * costs one synchronous stall per tile and always completes.
   *
   * ⚠️ Read BEFORE `setRenderTarget(null)` — the RT's framebuffer has to still
   * be the bound one.
   *
   * @returns {Uint8Array} RGBA, GL order (origin bottom-left).
   */
  readTile({ view = 'satellite', size = 256 } = {}) {
    const { mat, uRect } = this.materialFor(view);
    this.quad.material = mat;
    const s = this.state;
    const half = s.viewPx / 2;
    uRect.value.set(s.centre.x - half, s.centre.y - half, s.centre.x + half, s.centre.y + half);
    const rt = this.rtFor(size);
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.scene, this.camera);
    // The throwaway first draw — see `materialFor`.
    if (this._cold?.has(view)) {
      this._cold.delete(view);
      this.renderer.render(this.scene, this.camera);
    }
    const px = new Uint8Array(size * size * 4);
    const gl = this.renderer.backend.gl;
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
    this.renderer.setRenderTarget(prev);
    return px;
  }

  /** One render target per size, reused. Allocating and disposing a target per
   * tile is how a 25-tile contact sheet becomes 25 texture allocations. */
  rtFor(size) {
    if (!this._rts) this._rts = new Map();
    if (!this._rts.has(size)) {
      const THREE = this.THREE;
      this._rts.set(
        size,
        new THREE.RenderTarget(size, size, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat })
      );
    }
    return this._rts.get(size);
  }

  /** Mean of the red channel over a tile, 0..1 — the measurement the coverage
   * calibration is built on. */
  static meanRed(bytes) {
    let sum = 0;
    const n = bytes.length / 4;
    for (let i = 0; i < bytes.length; i += 4) sum += bytes[i];
    return sum / n / 255;
  }

  /** Standard deviation of the red channel, 0..1. */
  static stdRed(bytes) {
    const m = CloudDriver.meanRed(bytes) * 255;
    let acc = 0;
    const n = bytes.length / 4;
    for (let i = 0; i < bytes.length; i += 4) acc += (bytes[i] - m) * (bytes[i] - m);
    return Math.sqrt(acc / n) / 255;
  }
}

/** Draw one tile's bytes into a 2D context at (dx, dy), flipping Y (GL origin
 * is bottom-left, canvas is top-left). */
function blit(ctx, bytes, size, dx, dy) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    const sy = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const si = (sy * size + x) * 4;
      const di = (y * size + x) * 4;
      out[di] = bytes[si];
      out[di + 1] = bytes[si + 1];
      out[di + 2] = bytes[si + 2];
      out[di + 3] = 255;
    }
  }
  ctx.putImageData(new ImageData(out, size, size), dx, dy);
}

/** POST a 2D canvas to the lab server as a PNG. */
async function postCanvas(canvas, run, file) {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const res = await fetch(`/__lab/artifact?run=${encodeURIComponent(run)}&file=${encodeURIComponent(file)}`, {
    method: 'POST',
    body: blob,
  });
  return res.json();
}

/**
 * THE CONTACT SHEET — every cloud type down one axis, every cover across the
 * other, one picture.
 *
 * This is the artefact the whole bench exists to produce: eighteen numbers per
 * keyframe are unreviewable as a table and obvious as a grid.
 */
export async function contactSheet(
  driver,
  {
    view = 'satellite',
    size = 256,
    covers = [0.15, 0.35, 0.5, 0.7, 0.9],
    types = null,
    run = 'cloud',
    file = null,
    label = true,
  } = {}
) {
  const rows = types ?? CLOUD_KEYFRAMES.map((k) => ({ at: k.at, name: k.name }));
  const pad = label ? 96 : 0;
  const top = label ? 28 : 0;
  const canvas = document.createElement('canvas');
  canvas.width = pad + covers.length * size;
  canvas.height = top + rows.length * size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#101216';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < covers.length; c++) {
      driver.apply({ cloudType01: rows[r].at, cover01: covers[c] });
      const bytes = driver.readTile({ view, size });
      blit(ctx, bytes, size, pad + c * size, top + r * size);
    }
  }

  if (label) {
    ctx.fillStyle = '#e8e8ea';
    ctx.font = '13px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    for (let r = 0; r < rows.length; r++) {
      ctx.fillText(rows[r].name, 6, top + r * size + size / 2);
    }
    ctx.textAlign = 'center';
    for (let c = 0; c < covers.length; c++) {
      ctx.fillText(`cover ${covers[c]}`, pad + c * size + size / 2, top / 2);
    }
    ctx.textAlign = 'left';
  }
  const name = file ?? `contact-${view}.png`;
  const posted = await postCanvas(canvas, run, name);
  return { ...posted, width: canvas.width, height: canvas.height, view, rows: rows.length, cols: covers.length };
}

/**
 * MEASURE THE COVERAGE CALIBRATION — does `mean(cov)` actually track
 * `cloudCover01`?
 *
 * This is the check that keeps a SPATIAL consumer and a SCALAR consumer
 * (`sky-access.js`'s `1 - cover`, the environmental grade) describing the same
 * weather. It also reports the base shape's own mean and standard deviation
 * per keyframe, which are the two numbers `coverThreshold` needs and which are
 * currently ESTIMATES in the recipe table — this is how they stop being
 * estimates.
 */
export async function coverCalibration(driver, { size = 192, covers = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85] } = {}) {
  const out = [];
  for (const k of CLOUD_KEYFRAMES) {
    driver.apply({ cloudType01: k.at, cover01: 0.5 });
    const baseBytes = driver.readTile({ view: 'base', size });
    const baseMean = CloudDriver.meanRed(baseBytes);
    const baseStd = CloudDriver.stdRed(baseBytes);
    const measured = [];
    for (const c of covers) {
      driver.apply({ cloudType01: k.at, cover01: c });
      const bytes = driver.readTile({ view: 'coverage', size });
      measured.push({ target: c, actual: Number(CloudDriver.meanRed(bytes).toFixed(3)) });
    }
    // The exact-zero requirement: at cover 0 the field must be EXACTLY 0, not
    // approximately — a clear-sky frame has to be bit-identical to one with the
    // feature absent, which is what lets clouds default on.
    driver.apply({ cloudType01: k.at, cover01: 0 });
    const zero = CloudDriver.meanRed(driver.readTile({ view: 'coverage', size }));
    out.push({
      type: k.name,
      at: k.at,
      shippedMean: k.baseMean,
      shippedStd: k.baseStd,
      measuredMean: Number(baseMean.toFixed(3)),
      measuredStd: Number(baseStd.toFixed(3)),
      thresholdAt50: Number(coverThreshold(0.5, cloudRecipeFor(k.at)).toFixed(3)),
      zeroAtCoverZero: zero === 0,
      covers: measured,
      maxCoverError: Number(Math.max(...measured.map((m) => Math.abs(m.actual - m.target))).toFixed(3)),
    });
  }
  return out;
}

/**
 * ⭐ CALIBRATE THE COVERAGE THRESHOLD BY BISECTION — the measurement that makes
 * `cloudCover01` mean the same thing to this field as it already means to every
 * SCALAR consumer of the same axis.
 *
 * `docs/planning/Clouds.md` §8 and `reference/clouds/01-cloud-formation-field.md`
 * §4.7 both specify exactly this: bisect the threshold that gives
 * `mean(cov) = cover` at each keyframe and each cover, and ship the result.
 * The Gaussian model the module currently uses is only a starting guess, and
 * the first contact sheet showed how far off a guess can be — cover 0.5 read as
 * near-total overcast, because the Nubis remap LIFTS the base distribution well
 * above the 0.5 mean the guess assumed.
 *
 * Bisection rather than a closed form because the base distribution genuinely
 * depends on cover (the cell-polarity bell reads `u.cover`), so there is no
 * fixed distribution to invert — only a monotone function to search.
 *
 * @returns {Array<{type: string, at: number, rows: Array<{cover: number, threshold: number, achieved: number}>}>}
 */
export function calibrateThresholds(
  driver,
  { size = 160, covers = [0.05, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 0.97], iterations = 18 } = {}
) {
  const out = [];
  for (const k of CLOUD_KEYFRAMES) {
    const rows = [];
    for (const cover of covers) {
      // The base is bounded well inside [-1, 2] after every stage, so this
      // bracket cannot miss; `cov` is monotone DECREASING in the threshold.
      let lo = -1.5;
      let hi = 2.5;
      let achieved = 0;
      for (let i = 0; i < iterations; i++) {
        const mid = (lo + hi) / 2;
        driver.apply({ cloudType01: k.at, cover01: cover, thresholdOverride: mid });
        achieved = CloudDriver.meanRed(driver.readTile({ view: 'coverage', size }));
        if (achieved > cover) lo = mid;
        else hi = mid;
      }
      rows.push({ cover, threshold: Number(((lo + hi) / 2).toFixed(4)), achieved: Number(achieved.toFixed(3)) });
    }
    out.push({ type: k.name, at: k.at, rows });
  }
  driver.apply({ thresholdOverride: null });
  return out;
}

/** A single large render of one setting — for looking closely at one sky. */
export async function portrait(
  driver,
  { view = 'satellite', size = 768, run = 'cloud', file = 'portrait.png', patch = {} } = {}
) {
  driver.apply(patch);
  const bytes = driver.readTile({ view, size });
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  blit(canvas.getContext('2d'), bytes, size, 0, 0);
  return postCanvas(canvas, run, file);
}
