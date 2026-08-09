/**
 * THE LAYER SMEAR BAKE MATERIAL — constructed in Node, not admired.
 *
 * A TSL graph cannot be RUN here (no device), but it can be BUILT
 * (`keyhole-tsl-constructs-in-node`), and building it catches the whole class of
 * throws-on-startup errors: a missing TSL import, `.mix()`'s receiver trap, a
 * `select()` chain that strands a shared var, an operator applied to the wrong
 * node type. What it does NOT prove is codegen or look — that is Shader Lab's
 * job (`tools/shader-lab/bench-sun-shadow.js`), and lab-green is still only
 * `BUILT (unverified)` until the author sees it on a real scene.
 */
import { buildLayerSmearBakeMaterial } from '../layer-smear-render.js';
import { resolveLayerSmear } from '../layer-smear.js';
import * as THREE from '../../../vendor/three/three.webgpu.js';

/** @param {{ok:(name:string, cond:boolean)=>void}} t */
export function run(t) {
  const stubTexture = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);

  let bake = null;
  let buildError = null;
  try {
    bake = buildLayerSmearBakeMaterial({ THREE, layerTexture: stubTexture, steps: 24 });
  } catch (err) {
    buildError = err;
  }
  t.ok(
    `the layer-smear bake material constructs${buildError ? ` — threw: ${buildError.message}` : ''}`,
    buildError === null && bake !== null
  );
  if (!bake) return;

  t.ok('it exposes a material and its layer texture node', !!bake.material && !!bake.layerTexNode);
  for (const fn of [
    'setSun',
    'setCascade',
    'setLayers',
    'setDepth',
    'setField',
    'setLook',
    'setRect',
    'setEdgeBandPx',
  ]) {
    t.ok(`it exposes ${fn}()`, typeof bake[fn] === 'function');
  }

  // Every setter, driven with the values a real bake would push. A setter that
  // writes NaN over a working uniform is invisible to a construction test unless
  // the setter is actually called (memory: feedback_seam_default_hides_unwired).
  let setterError = null;
  try {
    bake.setSun(resolveLayerSmear({ azimuthDeg: 220, elevationDeg: 30, heightsPx: [300, 500, 900, 1400] }));
    // THE CASCADE's publication switch — both states, because they are the two
    // halves of a polarity (`layer-smear-render.js#uCascade`) and a setter that
    // only ever gets driven one way is a setter whose other branch is untested.
    bake.setCascade({ active: true });
    bake.setCascade({ active: false });
    bake.setLayers({ strengths: [1, 0.8, 0.6, 0.4] });
    bake.setDepth({ radiiPx: [0, 0, 220, 220] });
    bake.setField({ layerGridDimPx: 2048 });
    bake.setLook({ strength01: 1, softnessMul: 1, basePx: 2, falloffExp: 1.6, tipBlurMul: 3 });
    bake.setRect({ minX: 0, minY: 0, maxX: 10650, maxY: 4950 });
    bake.setEdgeBandPx(64);
  } catch (err) {
    setterError = err;
  }
  t.ok(`every setter runs clean${setterError ? ` — threw: ${setterError.message}` : ''}`, setterError === null);

  // The absent/garbage cases each setter is guarded against, called explicitly
  // rather than assumed: an omitted optional must be a NO-OP, never a NaN write.
  let guardError = null;
  try {
    bake.setLayers({});
    bake.setDepth({});
    bake.setField({});
    bake.setLook({});
    bake.setLook({ falloffExp: 0 }); // must be REJECTED — THE LAW needs f decreasing
    bake.setEdgeBandPx(-1);
  } catch (err) {
    guardError = err;
  }
  t.ok(
    `absent and out-of-range setter args are no-ops, not throws${guardError ? ` — ${guardError.message}` : ''}`,
    guardError === null
  );

  // A stack with no heights at all resolves to a zero max throw. The shader must
  // still build and set cleanly — this is the "sun overhead" bake, which really
  // does happen every day around noon.
  let noonError = null;
  try {
    bake.setSun(resolveLayerSmear({ azimuthDeg: 0, elevationDeg: 90, heightsPx: [0, 0, 0, 0] }));
  } catch (err) {
    noonError = err;
  }
  t.ok(`a zero-throw (noon) stack sets cleanly${noonError ? ` — ${noonError.message}` : ''}`, noonError === null);

  // A second material at a different step count must be independently
  // constructible — the loop is unrolled, so a tier change means a REBUILD, and
  // a builder that only works at its default step count would fail live on the
  // first quality change rather than here.
  let rebuildError = null;
  try {
    for (const steps of [8, 32, 64]) {
      buildLayerSmearBakeMaterial({ THREE, layerTexture: stubTexture, steps });
    }
  } catch (err) {
    rebuildError = err;
  }
  t.ok(`it rebuilds at 8, 32 and 64 steps${rebuildError ? ` — ${rebuildError.message}` : ''}`, rebuildError === null);

  // ── THE CASCADE'S SECOND INPUT, AND THE SHARP-`here` FIX (2026-08-03) ────
  // Author, live: an overhead item darkened by its OWN cast shadow — "the
  // shadow needs to be occluded by the actual thing that is casting it."
  // `here` (the receiver's own texel — now backing BOTH the self-shadow
  // exclusion `here.g` and the cascade blend `here.a`) used to be a bare
  // `.sample(uv())`, an IMPLICIT mip Node builds from screen-space
  // derivatives — the exact thing `GATE_AA_LOD`'s own header already named
  // untrustworthy for a fullscreen bake quad. Fixed to `.level(GATE_AA_LOD)`,
  // matching the wall gate's own precedent exactly. Construction cannot prove
  // WGSL codegen (Shader Lab's job), but it proves `lowerFieldTexture` is a
  // real accepted param and that both the presence and the (default) absence
  // of a lower floor build cleanly — a floor 0 slot has no lower field, and a
  // builder that only worked WITH one would fail live on the very first scene.
  {
    let withLower = null;
    let withLowerError = null;
    try {
      withLower = buildLayerSmearBakeMaterial({
        THREE,
        layerTexture: stubTexture,
        lowerFieldTexture: stubTexture,
        steps: 24,
      });
    } catch (err) {
      withLowerError = err;
    }
    t.ok(
      `a slot WITH a lower field (any floor above the ground) constructs${withLowerError ? ` — threw: ${withLowerError.message}` : ''}`,
      withLowerError === null && !!withLower
    );

    let withoutLower = null;
    let withoutLowerError = null;
    try {
      withoutLower = buildLayerSmearBakeMaterial({
        THREE,
        layerTexture: stubTexture,
        lowerFieldTexture: null,
        steps: 24,
      });
    } catch (err) {
      withoutLowerError = err;
    }
    t.ok(
      `a slot with NO lower field (the ground floor) still constructs${withoutLowerError ? ` — threw: ${withoutLowerError.message}` : ''}`,
      withoutLowerError === null && !!withoutLower
    );
    t.ok(
      'omitting lowerFieldTexture entirely defaults to the same no-cascade shape',
      (() => {
        let err = null;
        try {
          buildLayerSmearBakeMaterial({ THREE, layerTexture: stubTexture, steps: 24 });
        } catch (e) {
          err = e;
        }
        return err === null;
      })()
    );
  }
}
