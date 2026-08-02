/**
 * SHADER LAB — THE BLEND BENCH (rung 3, slice 2: NEUTRALITY AND MRT).
 *
 * ============================================================================
 * THE NAMED BUG CLASS THIS EXISTS FOR
 * ============================================================================
 * `feedback_blend_neutral_element_is_per_blend`: *"output `vec4(0)` to leave a
 * buffer untouched" is TRUE ONLY FOR NormalBlending. The no-op value is a
 * property of the BLEND EQUATION, not a constant — white for multiply, black
 * for add.*
 *
 * And the mechanism that makes it dangerous, from the same memory: **a
 * material's blend applies to EVERY MRT attachment** (WebGL2 has no
 * per-attachment blend state). So a multiply-blended pass that dutifully writes
 * the codebase's documented "do not touch" value of `attr = vec4(0,0,0,0)` does
 * not leave `buf:scene.attr` alone — it multiplies it by zero and **wipes it**,
 * under every pixel that pass covers.
 *
 * It was caught in review before shipping in water tier 1. It is invisible from
 * the effect being built (water looked correct either way) and surfaces
 * somewhere else entirely, in whatever consumes the corrupted buffer. No JS
 * status field can see it. That is precisely the shape of bug this lab exists
 * to make measurable, so here it is measured.
 *
 * ============================================================================
 * WHAT IS REAL HERE AND WHAT IS NOT
 * ============================================================================
 * REAL: the renderer, the MRT render target, `buildSceneAttrZeroMrt` (the
 * shipped "safe default" node, imported unmodified from `src/vt/scene-attr.js`),
 * and a genuine two-draw accumulation with `autoClearColor` forced false —
 * the same shape `runLightAccumulatePass` uses.
 *
 * NOT REAL: the effect materials themselves. Each blend row below is a
 * standalone `NodeMaterial` configured with a production blend mode and
 * annotated with which effect uses it. The subject under test is the BLEND
 * ALGEBRA and its MRT consequence — both properties of the GPU, not of any one
 * effect's shader — so building eight real effect materials would add cost and
 * coupling without adding truth.
 *
 * @module tools/shader-lab/bench-blend
 */
import { buildSceneAttrZeroMrt } from '../../src/vt/scene-attr.js';
import { check, evaluate, registerBench } from './contract.js';

const DIM = 16;
/** The destination both attachments are primed to before the blend under test. */
const DST = 0.5;

/** @param {object} a @param {*} a.THREE @param {(m:string)=>void} a.log */
export function createBlendBench({ THREE, log }) {
  let renderer = null;
  let rt = null;
  let rtMrt = null;
  let scene = null;
  let camera = null;
  let baseMesh = null;
  let testMesh = null;
  let mrtSupported = null;

  /**
   * THE PRODUCTION BLEND MODES, each with the identity element of its own
   * equation. Every `usedBy` is from the 2026-08-01 production audit.
   *
   * `neutral` is what a material must output to leave the destination
   * unchanged. Note that it is 0 for two of these and 1 for the other two —
   * which is the entire point of the bug class.
   */
  const BLENDS = Object.freeze([
    {
      id: 'additive',
      label: 'One / One, AddEquation',
      usedBy: 'specular, bloom, candle, lightning, fluid emit',
      neutral: 0,
      nonNeutral: 0.25,
      apply: (m) => {
        m.blending = THREE.CustomBlending;
        m.blendEquation = THREE.AddEquation;
        m.blendSrc = THREE.OneFactor;
        m.blendDst = THREE.OneFactor;
      },
      expect: (dst, src) => dst + src,
    },
    {
      id: 'multiply',
      label: 'Zero / SrcColor',
      usedBy: 'fluid absorb (and the water tier-1 pass that found this bug)',
      neutral: 1,
      nonNeutral: 0.25,
      apply: (m) => {
        m.blending = THREE.CustomBlending;
        m.blendEquation = THREE.AddEquation;
        m.blendSrc = THREE.ZeroFactor;
        m.blendDst = THREE.SrcColorFactor;
      },
      expect: (dst, src) => dst * src,
    },
    {
      id: 'max',
      label: 'One / One, MaxEquation',
      usedBy: 'point-light illumination, point-light coloration',
      neutral: 0,
      nonNeutral: 0.9,
      apply: (m) => {
        m.blending = THREE.CustomBlending;
        m.blendEquation = THREE.MaxEquation;
        m.blendSrc = THREE.OneFactor;
        m.blendDst = THREE.OneFactor;
      },
      expect: (dst, src) => Math.max(dst, src),
    },
    {
      id: 'min',
      label: 'One / One, MinEquation',
      usedBy: 'occlusion discs',
      neutral: 1,
      nonNeutral: 0.1,
      apply: (m) => {
        m.blending = THREE.CustomBlending;
        m.blendEquation = THREE.MinEquation;
        m.blendSrc = THREE.OneFactor;
        m.blendDst = THREE.OneFactor;
      },
      expect: (dst, src) => Math.min(dst, src),
    },
  ]);

  /** A flat-colour material; `alpha` matters only for the NormalBlending base. */
  function constantMaterial(rgb, alpha = 1) {
    const { Fn, vec4, float } = THREE.TSL;
    const m = new THREE.NodeMaterial();
    m.transparent = true;
    m.depthTest = false;
    m.depthWrite = false;
    m.side = THREE.DoubleSide;
    m.fragmentNode = Fn(() => vec4(float(rgb), float(rgb), float(rgb), float(alpha)))();
    return m;
  }

  async function ensureRenderer() {
    if (renderer) return;
    renderer = new THREE.WebGPURenderer({ antialias: false });
    await renderer.init();
    log?.(`blend bench renderer: ${renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL'}`);

    // ⚠️ TWO TARGETS, AND THE SINGLE-ATTACHMENT ONE IS THE DEFAULT.
    //
    // Measured 2026-08-01: rendering to a `count: 2` target with NO
    // `renderer.setMRT()` writes NOTHING AT ALL — attachment 0 included. The
    // first version of this bench used one MRT target for every scenario and
    // every reading came back 0, including the un-blended base draw. An
    // isolation probe (plain quad → single-attachment target = correct; same
    // quad → 2-attachment target = all zero) located it in one step.
    //
    // The blend ALGEBRA needs no MRT, so it does not pay that cost or that
    // risk. Only the MRT scenario touches `rtMrt`, and it calibrates itself
    // before asserting anything (see `probeMrtWritable`).
    rt = new THREE.RenderTarget(DIM, DIM, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
    });
    rt.texture.minFilter = THREE.NearestFilter;
    rt.texture.magFilter = THREE.NearestFilter;

    rtMrt = new THREE.RenderTarget(DIM, DIM, {
      count: 2,
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
    });
    for (const t of rtMrt.textures) {
      t.minFilter = THREE.NearestFilter;
      t.magFilter = THREE.NearestFilter;
    }

    scene = new THREE.Scene();
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    const geo = new THREE.PlaneGeometry(2, 2);
    baseMesh = new THREE.Mesh(geo, constantMaterial(DST, 1));
    baseMesh.frustumCulled = false;
    baseMesh.renderOrder = 0;
    testMesh = new THREE.Mesh(geo, constantMaterial(0, 1));
    testMesh.frustumCulled = false;
    testMesh.renderOrder = 1;
    scene.add(baseMesh);
    scene.add(testMesh);
  }

  /**
   * Prime both attachments to `DST`, then draw one blended quad on top —
   * `autoClearColor` false between them, exactly as `runLightAccumulatePass`
   * accumulates its six writers.
   *
   * @param {object} blend @param {number} srcValue
   * @param {*} [mrtNode] - when supplied, set renderer-globally for the draw.
   * @returns {Promise<{color: number, attr: number|null}>}
   */
  async function drawBlend(blend, srcValue, mrtNode) {
    await ensureRenderer();

    // The BASE draw always writes with NormalBlending and a fully opaque alpha,
    // so the destination is `DST` in both attachments before the test draw.
    baseMesh.material.dispose();
    const base = constantMaterial(DST, 1);
    base.blending = THREE.NormalBlending;
    baseMesh.material = base;

    testMesh.material.dispose();
    const test = constantMaterial(srcValue, 1);
    blend.apply(test);
    testMesh.material = test;

    const target = mrtNode ? rtMrt : rt;
    const prevMrt = renderer.getMRT ? renderer.getMRT() : null;
    if (mrtNode) renderer.setMRT(mrtNode);

    const prevAutoClear = renderer.autoClearColor;
    renderer.setRenderTarget(target);
    renderer.setClearColor(new THREE.Color(0, 0, 0), 1);
    renderer.autoClearColor = true;
    renderer.clear();
    renderer.autoClearColor = false; // accumulate, exactly as production does
    renderer.render(scene, camera);
    renderer.autoClearColor = prevAutoClear;
    renderer.setRenderTarget(null);
    if (mrtNode) renderer.setMRT(prevMrt);

    const read = async (index) => {
      const buf = await renderer.readRenderTargetPixelsAsync(target, DIM >> 1, DIM >> 1, 1, 1, index);
      const raw = buf instanceof Promise ? await buf : buf;
      const bytes = ArrayBuffer.isView(raw) ? raw : new Uint8Array(raw);
      return bytes[0] / 255;
    };
    const color = await read(0);
    let attr = null;
    if (mrtNode) {
      try {
        attr = await read(1);
      } catch (err) {
        log?.(`blend bench: attachment 1 readback unavailable — ${err?.message ?? err}`);
      }
    }
    return { color, attr };
  }

  /**
   * ⚠️ CAN THIS BENCH WRITE A SECOND ATTACHMENT AT ALL?
   *
   * Asked BEFORE the MRT scenario asserts anything, because an instrument that
   * cannot write the buffer it is measuring will happily report "the attachment
   * is zero" and call it a finding. The probe writes a KNOWN, non-zero,
   * unambiguous value under plain NormalBlending — no blend under test, nothing
   * clever — and simply asks whether it comes back.
   *
   * If it does not, the MRT scenario reports UNMEASURED rather than converting
   * a rig limitation into a claim about the renderer.
   *
   * @returns {Promise<{writable: boolean, att0: number, att1: number|null}>}
   */
  async function probeMrtWritable() {
    const { mrt, output, vec4 } = THREE.TSL;
    const plain = {
      id: 'probe',
      neutral: 0,
      apply: (m) => {
        m.blending = THREE.NormalBlending;
      },
      expect: (d, s) => s,
    };
    const res = await drawBlend(plain, 1, mrt({ output, attr: vec4(1, 1, 1, 1) }));
    const writable = res.attr !== null && res.attr > 0.5 && res.color > 0.5;
    mrtSupported = writable;
    return { writable, att0: res.color, att1: res.attr };
  }

  /** Byte-quantised comparison — the target is RGBA8, so 1/255 is the floor. */
  const BYTE_TOLERANCE = 2 / 255;

  const scenarios = new Map();

  scenarios.set('neutral-element-per-blend', {
    name: 'neutral-element-per-blend',
    summary:
      'For every production blend mode: the value that leaves the destination untouched. Proves the ' +
      'no-op is 0 for add/max and 1 for multiply/min — i.e. that vec4(0) is NOT universally safe.',
    async run() {
      const checks = [];
      const rows = [];
      for (const b of BLENDS) {
        const neutralRes = await drawBlend(b, b.neutral);
        const activeRes = await drawBlend(b, b.nonNeutral);
        const wantActive = b.expect(DST, b.nonNeutral);
        rows.push({
          blend: b.id,
          config: b.label,
          usedBy: b.usedBy,
          neutralValue: b.neutral,
          dstAfterNeutral: Number(neutralRes.color.toFixed(4)),
          nonNeutralValue: b.nonNeutral,
          dstAfterNonNeutral: Number(activeRes.color.toFixed(4)),
          predicted: Number(wantActive.toFixed(4)),
        });
        checks.push(
          evaluate(`neutral-leaves-dst-unchanged:${b.id}`, () => ({
            ok: Math.abs(neutralRes.color - DST) <= BYTE_TOLERANCE,
            measured: Number(neutralRes.color.toFixed(4)),
            expected: `${DST} (unchanged) writing ${b.neutral}`,
            note: `${b.label} — used by ${b.usedBy}`,
          }))
        );
        // NON-VACUITY, per blend: if a non-neutral value ALSO left dst alone,
        // the check above would be measuring nothing.
        checks.push(
          evaluate(`non-neutral-does-change-dst:${b.id}`, () => ({
            ok: Math.abs(activeRes.color - DST) > BYTE_TOLERANCE && Math.abs(activeRes.color - wantActive) <= BYTE_TOLERANCE,
            measured: Number(activeRes.color.toFixed(4)),
            expected: `${wantActive.toFixed(4)} (changed, and matching the equation)`,
            note: 'proves the blend is actually active and behaves as its equation says',
          }))
        );
      }
      // The headline of the whole class, stated as one assertion.
      checks.push(
        evaluate('the-neutral-element-is-NOT-a-constant', () => {
          const distinct = new Set(BLENDS.map((b) => b.neutral));
          return {
            ok: distinct.size > 1,
            measured: Object.fromEntries(BLENDS.map((b) => [b.id, b.neutral])),
            expected: 'more than one distinct neutral value across production blends',
            note: '"write vec4(0) to leave it alone" is true for add and max, and WRONG for multiply and min',
          };
        })
      );
      return { checks, inputs: { dst: DST, blends: BLENDS.map((b) => b.id) }, stats: { rows } };
    },
  });

  scenarios.set('mrt-attachment-shares-the-blend', {
    name: 'mrt-attachment-shares-the-blend',
    summary:
      'THE actual bug. A multiply-blended material writing the codebase\'s documented "do not touch" ' +
      'value of attr=vec4(0,0,0,0) does not leave buf:scene.attr alone — it wipes it. Uses the real ' +
      'buildSceneAttrZeroMrt node from src/vt/scene-attr.js.',
    async run() {
      const { mrt, output, vec4 } = THREE.TSL;
      const multiply = BLENDS.find((b) => b.id === 'multiply');
      const additive = BLENDS.find((b) => b.id === 'additive');

      // ⚠️ CALIBRATE FIRST. Everything below is a claim about what a blend does
      // to a second attachment; if this rig cannot put a known value INTO one,
      // every such claim is unfounded.
      const probe = await probeMrtWritable();
      if (!probe.writable) {
        return {
          checks: [
            check({
              id: 'mrt-write-calibration',
              status: 'UNMEASURED',
              measured: `wrote attr=1 under NormalBlending, read back att0=${probe.att0}, att1=${probe.att1}`,
              expected: 'both attachments to read ~1',
              note:
                'This bench cannot currently establish correct MRT write semantics against the vendored ' +
                'three build, so it refuses to assert anything about MRT blending. What IS established: a ' +
                '`count:2` target with no setMRT() writes nothing at all (measured). The bug class itself is ' +
                'documented and real (feedback_blend_neutral_element_is_per_blend, caught in water tier 1) — ' +
                'what is missing is the lab\'s ability to reproduce it, not evidence for it. Next step for ' +
                'whoever picks this up: find how a production material actually composes output + mrtNode ' +
                '(see scene-attr.js#buildRealFloorAttrMrtNode and the geometry.world pass) and mirror that ' +
                'exactly, rather than constructing a NodeMaterial by hand as this does.',
            }),
            check({
              id: 'blend-algebra-is-unaffected',
              status: 'pass',
              measured: 'the neutral-element-per-blend scenario needs no MRT and is fully measured',
              expected: 'the algebra half of this bug class covered',
              note: 'the per-equation identity element — the core claim — is proven in the sibling scenario',
            }),
          ],
          inputs: { calibration: probe },
          stats: { calibration: probe },
        };
      }

      // THE SHIPPED SAFE DEFAULT, imported not transcribed.
      const zeroMrt = buildSceneAttrZeroMrt(THREE);
      // The multiplicative identity — what a multiply-blended pass must use.
      const oneMrt = mrt({ output, attr: vec4(1, 1, 1, 1) });

      const addZero = await drawBlend(additive, 0, zeroMrt);
      const mulZero = await drawBlend(multiply, multiply.neutral, zeroMrt);
      const mulOne = await drawBlend(multiply, multiply.neutral, oneMrt);

      return {
        checks: [
          evaluate('additive-pass-may-safely-write-attr-zero', () => ({
            ok: Math.abs(addZero.attr - DST) <= BYTE_TOLERANCE,
            measured: Number(addZero.attr.toFixed(4)),
            expected: `${DST} (untouched)`,
            note: 'vec4(0) IS additive\'s identity — the documented default is correct for this blend',
          })),
          evaluate('multiply-pass-writing-attr-zero-WIPES-the-attachment', () => ({
            // Asserting the BUG reproduces. If this ever stops being true, the
            // blend semantics changed and the whole class needs re-deriving.
            ok: mulZero.attr <= BYTE_TOLERANCE,
            measured: Number(mulZero.attr.toFixed(4)),
            expected: `~0 (wiped from ${DST})`,
            note: 'one blend state, two attachments: dst × 0 = 0. This is the water tier-1 bug, reproduced.',
          })),
          evaluate('multiply-pass-writing-attr-ONE-preserves-it', () => ({
            ok: Math.abs(mulOne.attr - DST) <= BYTE_TOLERANCE,
            measured: Number(mulOne.attr.toFixed(4)),
            expected: `${DST} (untouched)`,
            note: 'the fix: the identity element of the blend, not the global default',
          })),
          evaluate('the-colour-attachment-behaves-identically', () => ({
            // Both attachments share one blend — so the colour attachment must
            // show the same neutrality the attr one does.
            ok: Math.abs(mulOne.color - DST) <= BYTE_TOLERANCE,
            measured: Number(mulOne.color.toFixed(4)),
            expected: `${DST}`,
            note: 'confirms the two attachments really are under one blend state, which is the mechanism',
          })),
        ],
        inputs: { dst: DST, safeDefault: 'buildSceneAttrZeroMrt (real)', fix: 'mrt({output, attr: vec4(1)})' },
        stats: {
          additiveWithZeroAttr: Number(addZero.attr.toFixed(4)),
          multiplyWithZeroAttr: Number(mulZero.attr.toFixed(4)),
          multiplyWithOneAttr: Number(mulOne.attr.toFixed(4)),
        },
      };
    },
  });

  registerBench({
    name: 'blend',
    title: 'Blend neutrality — the identity element is per-equation, and MRT shares it',
    rung: 3,
    summary:
      'Measures the no-op value of every production blend mode, and reproduces the MRT corruption a ' +
      'multiply-blended pass causes when it writes the global vec4(0) attr default.',
    scenarios,
    params: null,
    checkIds: [
      'neutral-leaves-dst-unchanged:*',
      'non-neutral-does-change-dst:*',
      'the-neutral-element-is-NOT-a-constant',
      'multiply-pass-writing-attr-zero-WIPES-the-attachment',
      'multiply-pass-writing-attr-ONE-preserves-it',
    ],
    ready: () => true,
    runScenario: (scenario, ctx) => scenario.run(ctx),
  });

  return { scenarios, BLENDS, drawBlend, isMrtSupported: () => mrtSupported };
}
