/**
 * SHADER LAB — TAA RESOLVE: DOES THE REPROJECTION FORMULA LAND ON THE
 * CORRECT WORLD POSITION, ON A REAL GPU, NOT JUST IN JS ALGEBRA?
 *
 * ============================================================================
 * SCOPE — what this bench proves and what it deliberately does NOT
 * ============================================================================
 * `computeReprojectTransform`'s own scale/offset arithmetic is already
 * Node-tested exactly (`src/vt/__tests__/taa-resolve.test.mjs`) — that part
 * needs no GPU. What a Node test CANNOT prove is whether the exact same
 * formula, compiled into a REAL TSL/WGSL shader and applied to a REAL
 * texture sample, lands on the texel the algebra predicts — this is
 * precisely the class of thing `mip-resample.js`'s own linearization fix
 * (this same session) turned out to need a real render to catch, twice, on
 * a design that looked correct on paper.
 *
 * `reprojection-lands-on-the-correct-stripe` below tests ONLY the
 * reprojection line itself — `prevUV = uvNode.mul(uReproject.xy).add(
 * uReproject.zw)`, copied VERBATIM from `buildTaaResolveNode` — through a
 * minimal standalone shader with NO neighbourhood clamp and NO blend. This
 * is deliberate, not a shortcut: at a flat interior probe point (the only
 * kind of point where a hand-predicted expected colour is unambiguous), the
 * REAL resolve node's clamp would clip a correctly-reprojected-but-distant
 * history sample back into the current frame's own local colour, masking
 * the exact signal this bench exists to read — the clamp would make a
 * WRONG UV direction look identical to a correct one. Isolating the formula
 * is what makes the test meaningful. The clamp/blend half is NOT
 * separately bench-verified here — it uses ordinary `min`/`max`/`clamp`/
 * `mix` TSL primitives in the same straightforward way already CONFIRMED
 * working, same session, by `bench-albedo-clarity.js`'s own
 * chromatic-fringing scenario (which leans on `TSL.min`/`TSL.max` just as
 * directly).
 *
 * This bench is PURELY X-axis (a vertical-stripe fixture, uniform down every
 * row) — deliberately sidesteps the Y-flip question entirely.
 * `taa-resolve.js`'s own header traces the Y case algebraically against
 * `updateCamera`'s documented convention (`computeCameraFrustum`'s literal
 * `top: worldRect.minY`) rather than guessing; X needs no such argument (u=0
 * ↔ left, u=1 ↔ right is the unflipped, universal case). This bench proves
 * the SURROUNDING mechanism — uniform packing, `.xy`/`.zw` swizzling, a
 * texture sample at a formula-derived offset UV, actually compiling and
 * running correctly on a real WebGPU device — which the Y axis shares
 * byte-for-byte; only the SIGN of what value lands in `.zw`'s Y half
 * differs, and that half is what `taa-resolve.js`'s own header defends from
 * source, not from this bench. Stated as an honest limit, not a hidden one.
 *
 * @module tools/shader-lab/bench-taa-resolve
 */
import { registerBench, evaluate, saveArtifact } from './contract.js';
import { computeReprojectTransform } from '../../src/vt/taa-resolve.js';

/** 4 vertical stripes, 16px each — DIM=64. Every row identical (no Y
 * variation at all), so this fixture cannot accidentally reveal anything
 * about the Y axis — see this file's own header. */
const DIM = 64;
const STRIPE_W = DIM / 4;
const OUT_DIM = 64; // 1:1 with the fixture — no minification needed for this test
const STRIPES = [
  [220, 20, 20, 255], // 0: red
  [20, 180, 20, 255], // 1: green
  [20, 20, 220, 255], // 2: blue
  [220, 200, 20, 255], // 3: yellow
];
const STRIPE_NAMES = ['red', 'green', 'blue', 'yellow'];

function makeImage(width, height, fn) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fn(x, y);
      const i = (y * width + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = a;
    }
  }
  return rgba;
}

function stripeFixture() {
  return makeImage(DIM, DIM, (x) => STRIPES[Math.min(3, Math.floor(x / STRIPE_W))]);
}

/** Which stripe index a UV.x falls in, hand-computed the same way the
 * fixture itself is laid out — the independent "what SHOULD this read"
 * oracle the render is checked against. */
function stripeAt(u) {
  const x = u * DIM;
  return Math.max(0, Math.min(3, Math.floor(x / STRIPE_W)));
}

export function createTaaResolveBench({ THREE, log }) {
  let renderer = null;
  let camera = null;
  let outRt = null;

  async function ensureRenderer() {
    if (renderer) return;
    renderer = new THREE.WebGPURenderer({ antialias: false });
    await renderer.init();
    renderer.toneMapping = THREE.NoToneMapping;
    camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0.01, 10);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    // SRGBColorSpace on the TARGET itself — see bench-albedo-clarity.js's
    // own header for why this specific lever (not renderer.outputColorSpace,
    // measurably inert on an offscreen RenderTarget) is the real one.
    outRt = new THREE.RenderTarget(OUT_DIM, OUT_DIM, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      colorSpace: THREE.SRGBColorSpace,
      depthBuffer: false,
    });
    log?.(`TAA-RESOLVE: backend ${renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL'}`);
  }

  function uploadStripeTexture(image) {
    const tex = new THREE.DataTexture(image, DIM, DIM, THREE.RGBAFormat, THREE.UnsignedByteType);
    // flipY:false — v=0 addresses the FIRST stored row, matching this
    // project's own art-upload convention (irrelevant here anyway: every
    // row is identical, see this file's header).
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    // NEAREST — no blur across a stripe boundary, so a probe read is never
    // ambiguous between two adjacent stripes.
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Render `prevUV = uv().mul(uReproject.xy).add(uReproject.zw)` against
   * `historyTex` — the EXACT line `buildTaaResolveNode` uses, copied
   * verbatim, no clamp, no blend, no current-frame tap at all. Reads back
   * the full buffer.
   */
  async function renderReprojectionOnly(historyTex, reprojectValues) {
    await ensureRenderer();
    const { Fn, uniform, vec4, texture, uv } = THREE.TSL;
    const uReproject = uniform(vec4(...reprojectValues));
    const material = new THREE.NodeMaterial();
    material.colorNode = Fn(() => {
      const prevUV = uv().mul(uReproject.xy).add(uReproject.zw);
      return texture(historyTex, prevUV);
    })();
    material.transparent = true;
    material.blending = THREE.NoBlending;
    material.depthTest = false;
    material.depthWrite = false;
    const geo = new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(0.5, 0.5, 0);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    renderer.setRenderTarget(outRt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    await renderer.renderAsync(scene, camera);
    renderer.setRenderTarget(null);
    const buf = await renderer.readRenderTargetPixelsAsync(outRt, 0, 0, OUT_DIM, OUT_DIM);
    geo.dispose();
    material.dispose?.();
    return ArrayBuffer.isView(buf) ? buf : new Uint8Array(buf);
  }

  function stripeAtPixel(buf, px, py) {
    const i = (py * OUT_DIM + px) * 4;
    const rgb = [buf[i], buf[i + 1], buf[i + 2]];
    let best = -1;
    let bestDist = Infinity;
    for (let s = 0; s < 4; s++) {
      const d = STRIPES[s].slice(0, 3).reduce((acc, c, k) => acc + (c - rgb[k]) ** 2, 0);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return { stripe: best, rgb, matchError: Math.sqrt(bestDist) };
  }

  async function saveComparison(runId, name, buf) {
    const canvas = document.createElement('canvas');
    canvas.width = OUT_DIM;
    canvas.height = OUT_DIM;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(OUT_DIM, OUT_DIM);
    img.data.set(buf);
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) return null;
    const file = `${name}.png`;
    const res = await saveArtifact(runId, file, blob);
    return res?.ok ? file : null;
  }

  const scenarios = new Map();

  scenarios.set('bare-value-swap-redirects-without-rebuild', {
    name: 'bare-value-swap-redirects-without-rebuild',
    summary:
      "URGENT, added 2026-08-31 in response to a live report (full-screen wobble with TAA on): does " +
      "grade-present.js#setLitSource's bare `presentTexNode.value = tex` (deliberately no `needsUpdate`, " +
      "unlike its sibling rebindLit) actually redirect an ALREADY-COMPILED NodeMaterial to sample the NEW " +
      'texture on the very next render — or does the compiled shader keep sampling the texture it was ' +
      'built against? Two renders of the SAME material, ONE bare value-swap between them, no other change.',
    async run(ctx) {
      await ensureRenderer();
      const { texture, vec4, uv } = THREE.TSL;

      // NOTE: uploadStripeTexture hardcodes the module-level DIM (64) as the
      // texture's own width/height regardless of the image array's real
      // size — a 4x4 fixture here previously produced a 64x64-claimed
      // upload backed by only 4x4 worth of data (an invalid upload reading
      // back as black on both sides of the swap, a false "broken" result
      // caught by re-checking against a trivial control, not trusted from
      // one run). Use DIM x DIM fixtures, matching what the helper expects.
      const redTex = uploadStripeTexture(makeImage(DIM, DIM, () => [255, 0, 0, 255]));
      const greenTex = uploadStripeTexture(makeImage(DIM, DIM, () => [0, 255, 0, 255]));

      // EXACT shape of grade-present.js: `const presentTexNode = texture(litTexture);`
      // then later `material.fragmentNode = vec4(...presentTexNode.rgb...)`.
      const presentTexNode = texture(redTex, uv());
      const material = new THREE.NodeMaterial();
      material.colorNode = vec4(presentTexNode.rgb, 1);
      material.transparent = false;
      material.depthTest = false;
      material.depthWrite = false;
      const geo = new THREE.PlaneGeometry(1, 1);
      const mesh = new THREE.Mesh(geo, material);
      mesh.position.set(0.5, 0.5, 0);
      mesh.frustumCulled = false;
      const scene = new THREE.Scene();
      scene.add(mesh);

      async function renderOnce() {
        renderer.setRenderTarget(outRt);
        renderer.setClearColor(0x000000, 1);
        renderer.clear(true, false, false);
        await renderer.renderAsync(scene, camera);
        renderer.setRenderTarget(null);
        const buf = await renderer.readRenderTargetPixelsAsync(outRt, 0, 0, OUT_DIM, OUT_DIM);
        return ArrayBuffer.isView(buf) ? buf : new Uint8Array(buf);
      }

      const bufBefore = await renderOnce();

      // THE SWAP UNDER TEST — bare .value=, no needsUpdate, exactly setLitSource's own line.
      presentTexNode.value = greenTex;

      const bufAfter = await renderOnce();

      geo.dispose();
      material.dispose?.();
      redTex.dispose();
      greenTex.dispose();

      const centerOf = (buf) => {
        const i = (Math.floor(OUT_DIM / 2) * OUT_DIM + Math.floor(OUT_DIM / 2)) * 4;
        return [buf[i], buf[i + 1], buf[i + 2]];
      };
      const before = centerOf(bufBefore);
      const after = centerOf(bufAfter);

      return {
        checks: [
          evaluate('first render shows the INITIAL texture (red)', () => ({
            ok: before[0] > 200 && before[1] < 50 && before[2] < 50,
            measured: before,
            expected: 'roughly [255,0,0] — non-vacuity: if this fails the harness itself is broken',
          })),
          evaluate('SECOND render, after the bare .value swap, shows the NEW texture (green)', () => ({
            ok: after[1] > 200 && after[0] < 50 && after[2] < 50,
            measured: after,
            expected:
              "roughly [0,255,0] — if this reads red instead (unchanged from 'before'), a bare .value swap " +
              'does NOT redirect an already-compiled material on this renderer/version, which would mean ' +
              "setLitSource's entire mechanism is broken and TAA's resolved output never reaches present at all",
            note:
              after[1] > 200
                ? 'CONFIRMED: the swap mechanism works — present redirection is not the cause of the reported wobble'
                : 'CONFIRMED BROKEN: this is very likely the reported full-screen wobble — see grade-present.js#setLitSource',
          })),
        ],
        calibration: 'OK',
        inputs: {},
        stats: { before, after },
      };
    },
  });

  scenarios.set('reprojection-lands-on-the-correct-stripe', {
    name: 'reprojection-lands-on-the-correct-stripe',
    summary:
      "A pure X-axis camera pan, expressed as the SAME computeReprojectTransform this session's Node " +
      'tests already verify algebraically — does sampling history through the ACTUAL shader formula, on ' +
      'a real GPU, land on the texel that algebra predicts? Three probe points, three independently ' +
      'hand-computed expected stripes.',
    async run(ctx) {
      // A pure pan: history frustum shifted LEFT of current by exactly 20%
      // of its own span (f.left=0 vs fPrev.left=-2, span 10) — the SAME
      // shape of scenario taa-resolve.test.mjs's own "pure pan right by 2/10
      // of the span gives offsetX=0.2" case, now run through a real shader
      // instead of pure JS.
      const f = { left: 0, right: 10, top: 5, bottom: -5 };
      const fPrev = { left: -2, right: 8, top: 5, bottom: -5 };
      const transform = computeReprojectTransform(f, fPrev);

      const historyImg = stripeFixture();
      const historyTex = uploadStripeTexture(historyImg);
      const buf = await renderReprojectionOnly(historyTex, [
        transform.scaleX,
        transform.scaleY,
        transform.offsetX,
        transform.offsetY,
      ]);
      historyTex.dispose();

      // Three probe points, well inside a stripe's interior (not near a
      // boundary — NEAREST filtering makes the boundary itself a coin flip
      // between two adjacent texels, which would be a fixture problem, not
      // a shader one).
      const probes = [0.1, 0.4, 0.7].map((u) => ({
        u,
        expectedPrevU: u * transform.scaleX + transform.offsetX,
      }));

      const py = Math.floor(OUT_DIM / 2);
      const results = probes.map(({ u, expectedPrevU }) => {
        const px = Math.min(OUT_DIM - 1, Math.floor(u * OUT_DIM));
        const { stripe, rgb, matchError } = stripeAtPixel(buf, px, py);
        const expectedStripe = stripeAt(expectedPrevU);
        return { u, expectedPrevU, expectedStripe, gotStripe: stripe, rgb, matchError };
      });

      const artifact = await saveComparison(ctx.runId, 'reprojection-stripe', buf);

      return {
        checks: results.map((r, i) =>
          evaluate(`probe-${i}-at-u=${r.u}-reprojects-to-${STRIPE_NAMES[r.expectedStripe]}`, () => ({
            ok: r.gotStripe === r.expectedStripe,
            measured: {
              gotStripe: STRIPE_NAMES[r.gotStripe] ?? 'no-clean-match',
              gotRgb: r.rgb,
              nearestFixtureColourDistance: r.matchError,
            },
            expected: `stripe '${STRIPE_NAMES[r.expectedStripe]}' — hand-computed: prevU = ${r.u} * ${transform.scaleX.toFixed(3)} + ${transform.offsetX.toFixed(3)} = ${r.expectedPrevU.toFixed(3)}`,
            note:
              r.gotStripe === r.expectedStripe
                ? 'the ACTUAL COMPILED SHADER reprojects to the same texel the JS algebra predicts'
                : "MISALIGNED — either the UV-direction assumption is wrong, or something in the formula's " +
                  "GPU compilation disagrees with the JS reference. See taa-resolve.js's own header before " +
                  'changing anything blind.',
          }))
        ),
        calibration: 'OK',
        artifacts: artifact ? [artifact] : [],
        inputs: { f, fPrev, transform },
        stats: { probes: results },
      };
    },
  });

  scenarios.set('identity-transform-is-a-true-passthrough', {
    name: 'identity-transform-is-a-true-passthrough',
    summary:
      'Positive control: scaleX=1,offsetX=0 (nothing moved) must reproject EVERY uv to itself exactly — ' +
      'if this fails, the bench harness itself is broken, not the formula under test.',
    async run(_ctx) {
      const historyImg = stripeFixture();
      const historyTex = uploadStripeTexture(historyImg);
      const buf = await renderReprojectionOnly(historyTex, [1, 1, 0, 0]);
      historyTex.dispose();

      let mismatches = 0;
      const py = Math.floor(OUT_DIM / 2);
      for (let px = 2; px < OUT_DIM - 2; px++) {
        // skip texels within 1px of a stripe boundary — a NEAREST sample
        // right at a boundary is a legitimate coin flip, not a bug.
        const u = (px + 0.5) / OUT_DIM;
        const distToBoundary = Math.min(...[16, 32, 48].map((b) => Math.abs(px - b)));
        if (distToBoundary < 2) continue;
        const { stripe } = stripeAtPixel(buf, px, py);
        if (stripe !== stripeAt(u)) mismatches++;
      }

      return {
        checks: [
          evaluate('identity transform reproduces the source exactly (harness sanity)', () => ({
            ok: mismatches === 0,
            measured: { mismatchedTexels: mismatches },
            expected: '0 — the render harness itself must be trustworthy before its other scenario means anything',
          })),
        ],
        calibration: mismatches === 0 ? 'OK' : 'SUSPECT',
        inputs: { reproject: [1, 1, 0, 0] },
      };
    },
  });

  const bench = {
    name: 'taa-resolve',
    scenarios,
    async runScenario(scenario, ctx) {
      return scenario.run(ctx);
    },
  };
  registerBench(bench);
  return bench;
}
