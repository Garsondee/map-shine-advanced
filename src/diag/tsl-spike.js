/**
 * @fileoverview diag/tsl-spike.js — THE SPIKE. Can TSL run our real renderer, on
 * BOTH backends, on this machine?
 *
 * Throwaway by design (docs/planning/Shaders.md §7.5). It touches nothing that
 * works, renders into its own offscreen canvas, and answers ONE question with
 * evidence instead of belief. Delete it once the decision is made either way.
 *
 * ## Why not a spinning triangle
 *
 * A triangle proves that Three initialised. It proves nothing about whether OUR
 * renderer can move. The core scene rendering (`vt/vt-sample.glsl.js`) does three
 * things that are exactly where a node-graph port would break, so the spike does
 * those three things and nothing else:
 *
 *   1. **`textureLoad` on an indirection texture** — an unfiltered integer-ish
 *      fetch used as a POINTER, not a colour. Nearest, never interpolated.
 *   2. **Sampling a `DataArrayTexture`** — our 512MB page atlas is a layered
 *      texture addressed as `(uv, layer)`. This is the single most likely thing to
 *      be missing or subtly different across backends: WGSL calls it
 *      `texture_2d_array`, GLSL calls it `sampler2DArray`, and the node system has
 *      to emit both from one graph.
 *   3. **A `Loop` with a dynamic index** — the coarse-fallback mip walk, which
 *      reads per-mip uniform arrays. Loops with non-constant bounds are where weak
 *      drivers historically misbehave, and weak drivers are this project's floor.
 *
 * If all three work on both backends, the port is mechanical. If any fails, we
 * have a reason to stay on classic WebGL, in writing, instead of a hunch.
 *
 * ## The verdict is a rendered pixel, not an absence of exceptions
 *
 * The spike reads the pixel back and checks it against a value computed on the
 * CPU. "It didn't throw" is exactly the standard legacy's inert `build:tsl` met
 * for however long it existed — it imported `TSL` from the classic build, got
 * `undefined`, silently did nothing, and called itself done. Nothing here counts
 * as working until a pixel proves it.
 *
 * @module diag/tsl-spike
 */

const VENDOR_URL = '../vendor/three/three.webgpu.js';

/** The layer whose colour we expect to come back, and the colour we put in it. */
const TARGET_LAYER = 2;
const LAYER_COLOURS = [
  [255, 0, 0, 255], // layer 0 — red   (wrong answer)
  [0, 255, 0, 255], // layer 1 — green (wrong answer)
  [0, 96, 255, 255], // layer 2 — blue  (the ONE the indirection points at)
  [255, 255, 0, 255], // layer 3 — yellow (wrong answer)
];

/**
 * Build the three-hard-parts scene and render one frame on one backend.
 * @param {any} THREE - the vendored node build's namespace.
 * @param {boolean} forceWebGL - true = WebGLBackend (the fallback), false = WebGPU.
 * @returns {Promise<object>} the result for this backend.
 */
async function runBackend(THREE, forceWebGL) {
  const label = forceWebGL ? 'webgl2' : 'webgpu';
  const t0 = performance.now();
  const out = { backend: label, ok: false, error: null };
  let renderer = null;

  try {
    const { TSL } = THREE;
    if (!TSL) throw new Error("the vendored build exposes no TSL namespace — this is legacy's build:tsl bug again");
    const { Fn, texture, textureLoad, uniform, vec2, vec4, int, ivec2, float, Loop, If } = TSL;
    for (const [name, fn] of Object.entries({
      Fn,
      texture,
      textureLoad,
      uniform,
      vec2,
      vec4,
      int,
      ivec2,
      float,
      Loop,
      If,
    })) {
      if (!fn) throw new Error(`TSL is missing "${name}" — the node language cannot express our sampler`);
    }

    // --- HARD PART 2: a layered atlas, exactly like the page atlas ------------
    const SIZE = 4;
    const layers = LAYER_COLOURS.length;
    const atlasData = new Uint8Array(SIZE * SIZE * layers * 4);
    for (let l = 0; l < layers; l++) {
      for (let i = 0; i < SIZE * SIZE; i++) {
        const o = (l * SIZE * SIZE + i) * 4;
        atlasData.set(LAYER_COLOURS[l], o);
      }
    }
    const atlas = new THREE.DataArrayTexture(atlasData, SIZE, SIZE, layers);
    atlas.format = THREE.RGBAFormat;
    atlas.type = THREE.UnsignedByteType;
    atlas.minFilter = THREE.NearestFilter;
    atlas.magFilter = THREE.NearestFilter;
    atlas.needsUpdate = true;

    // --- HARD PART 1: an indirection texture holding a POINTER, not a colour --
    // One texel, whose red channel encodes TARGET_LAYER. This is the page table
    // in miniature: a value that is looked up, not displayed.
    const indirData = new Uint8Array([TARGET_LAYER, 0, 0, 255]);
    const indirection = new THREE.DataTexture(indirData, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    indirection.minFilter = THREE.NearestFilter;
    indirection.magFilter = THREE.NearestFilter;
    indirection.needsUpdate = true;

    // --- HARD PART 3: a dynamic loop, like the coarse-fallback mip walk -------
    // Walks 0..maxMip and "resolves" at the level matching the uniform, proving a
    // non-constant-bounded loop with a runtime condition compiles on this backend.
    const uMaxMip = uniform(int(3));
    const uResolveAt = uniform(int(2));

    const spikeColour = Fn(() => {
      // textureLoad -> the pointer. .r is 0..1 normalised; x255 recovers the index.
      const ptr = textureLoad(indirection, ivec2(0, 0));
      const layer = ptr.r.mul(255).round().toInt();

      const found = int(0).toVar();
      Loop({ start: int(0), end: uMaxMip.add(int(1)), type: 'int', condition: '<' }, ({ i }) => {
        If(i.equal(uResolveAt), () => {
          found.assign(int(1));
        });
      });

      // Sample the ARRAY texture at the layer the indirection pointed to. Returns
      // magenta if the loop never resolved — the same tripwire vt-sample uses, so
      // a silent failure is visible rather than plausible.
      const sampled = texture(atlas, vec2(0.5, 0.5)).depth(layer);
      return vec4(sampled.rgb.mul(found.toFloat()).add(vec4(1, 0, 1, 1).rgb.mul(float(1).sub(found.toFloat()))), 1);
    });

    // --- render one frame ----------------------------------------------------
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    renderer = new THREE.WebGPURenderer({ canvas, antialias: false, forceWebGL });
    await renderer.init();

    out.actualBackend = renderer.backend?.isWebGPUBackend ? 'WebGPUBackend' : 'WebGLBackend';
    // The honest check: asking for WebGPU and silently getting WebGL would make
    // every later measurement a lie about which path it measured.
    out.honoredRequest = forceWebGL ? out.actualBackend === 'WebGLBackend' : out.actualBackend === 'WebGPUBackend';

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const material = new THREE.NodeMaterial();
    material.colorNode = spikeColour();
    material.depthTest = false;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    scene.add(mesh);

    const tCompile0 = performance.now();
    await renderer.compileAsync(scene, camera);
    out.compileMs = Math.round(performance.now() - tCompile0);

    await renderer.renderAsync(scene, camera);

    // GROUND TRUTH: read the pixel. Not throwing is not the standard.
    const buf = new Uint8Array(4);
    await renderer.readRenderTargetPixelsAsync(null, 4, 4, 1, 1, buf).catch(async () => {
      const gl = renderer.backend?.gl;
      if (gl) gl.readPixels(4, 4, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    });
    out.pixel = [buf[0], buf[1], buf[2], buf[3]];

    const want = LAYER_COLOURS[TARGET_LAYER];
    const near = (a, b) => Math.abs(a - b) <= 8; // sRGB/rounding slack, not a free pass
    out.expectedPixel = want;
    out.pixelCorrect = near(buf[0], want[0]) && near(buf[1], want[1]) && near(buf[2], want[2]);
    out.ok = out.pixelCorrect;
    if (!out.pixelCorrect) {
      out.diagnosis =
        buf[0] > 200 && buf[2] > 200 && buf[1] < 60
          ? 'MAGENTA — the dynamic Loop never resolved (hard part 3 failed)'
          : 'wrong colour — the indirection→array-layer lookup resolved to the wrong layer (hard part 1 or 2 failed)';
    }
  } catch (err) {
    out.error = `${err?.message || err}`;
    out.stack = err?.stack ?? null;
  } finally {
    try {
      renderer?.dispose?.();
    } catch (_) {}
    out.totalMs = Math.round(performance.now() - t0);
  }
  return out;
}

/**
 * Run the spike on both backends and report.
 *
 * @returns {Promise<object>} a report for the debug panel.
 */
export async function runTslSpike() {
  const report = { report: 'tsl-spike', generatedAt: new Date().toISOString() };
  try {
    report.webgpuAvailable = typeof navigator !== 'undefined' && !!navigator.gpu;

    const THREE = await import(/* @vite-ignore */ VENDOR_URL);
    report.vendorLoaded = true;
    report.hasTSL = !!THREE.TSL;
    report.hasWebGPURenderer = !!THREE.WebGPURenderer;
    report.hasNodeMaterial = !!THREE.NodeMaterial;
    if (!report.hasTSL || !report.hasWebGPURenderer) {
      report.verdict = "the vendored node build did not expose TSL/WebGPURenderer — legacy's build:tsl bug, again";
      return report;
    }

    // WebGL2 FIRST. It is the one that decides the question: if the fallback is
    // not solid, TSL cannot replace classic WebGLRenderer no matter how well
    // WebGPU performs, because the fallback is what the design-floor hardware gets.
    report.webgl2 = await runBackend(THREE, true);
    report.webgpu = report.webgpuAvailable
      ? await runBackend(THREE, false)
      : { backend: 'webgpu', ok: false, error: 'navigator.gpu is absent — this browser has no WebGPU' };

    report.verdict =
      report.webgl2.ok && report.webgpu.ok
        ? 'BOTH BACKENDS RENDER A CORRECT PIXEL — TSL can express the core sampler here; the port is mechanical.'
        : report.webgl2.ok
          ? 'WebGL2 works, WebGPU does not. TSL is still worth it (one source, and the fallback is the design-floor path) but WebGPU needs investigating on this machine.'
          : report.webgpu.ok
            ? 'WebGPU works but the WebGL2 FALLBACK does not. This is the blocking case: the fallback is what weak hardware gets, so classic WebGLRenderer stays until it is understood.'
            : 'NEITHER backend rendered a correct pixel. Do not port. Read the per-backend error/diagnosis.';
  } catch (err) {
    report.error = `${err?.message || err}`;
    report.stack = err?.stack ?? null;
    report.verdict = 'the spike itself failed to run — see error';
  }
  return report;
}
