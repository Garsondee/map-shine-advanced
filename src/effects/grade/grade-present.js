/**
 * THE GRADE PRESENT MATERIAL — where the grade stack meets the frame.
 *
 * `post.grade` is a declared seam (`graph/passes.js`): grade the composed image,
 * create `buf:final`, present reads it. Per Grade.md §5 the first slice FOLDS
 * the grade into the PRESENT draw (present already samples `scene.lit`), exactly
 * as `light.visibility` is fused into `light.accumulate` — one fewer fullscreen
 * pass, identical maths. The grade LOGIC stays in `effects/grade/`.
 *
 * TWO scopes, in the fixed order Environment.md §2.3 / Grade.md §11 specify:
 *
 *   scene.lit (linear, fully lit + particles + flames)
 *     → ENVIRONMENTAL grade   (outdoor-mask-gated, from env)   "world is like"
 *     → ARTISTIC grade + TAIL (whole image, authored look)     "shot looks like"
 *          primary ops → tone map → 3D LUT
 *     → present (canvas sRGB encode)
 *
 * WHY THE TONE MAP IS COMPILE-TIME: it is a different three built-in `Fn` per
 * curve, baked into the node graph — you cannot swap `agxToneMapping` for
 * `acesFilmicToneMapping` through a uniform. So a tone-map CHANGE rebuilds the
 * fragment node (`rebuildFragment`), which is cheap and rare (an author picks a
 * film response once). The LUT, by contrast, is a texture + a strength uniform —
 * both live — so the LUT node is ALWAYS compiled in and gated by strength (0 =
 * a one-fetch no-op), never a recompile.
 *
 * Ships neutral: env grade identity, artistic grade identity, tone map `none`,
 * LUT strength 0 — the whole thing is `present(scene.lit)` unchanged until the
 * Colour Grade effect resolves its AgX default.
 *
 * @module effects/grade/grade-present
 */

import { buildGradeNode, IDENTITY_GRADE } from './grade-ops.js';
import { buildOutdoorsGate } from '../lighting/environmental-light.js';

/** Make the grade's uniform nodes (the primary ops + the live LUT strength). */
function makeGradeUniforms(TSL, withTail) {
  const { uniform, float, vec3 } = TSL;
  const u = {
    exposure: uniform(float(IDENTITY_GRADE.exposure)),
    contrast: uniform(float(IDENTITY_GRADE.contrast)),
    saturation: uniform(float(IDENTITY_GRADE.saturation)),
    vibrance: uniform(float(IDENTITY_GRADE.vibrance)),
    temperature: uniform(float(IDENTITY_GRADE.temperature)),
    tint: uniform(float(IDENTITY_GRADE.tint)),
    lift: uniform(vec3(...IDENTITY_GRADE.lift)),
    gamma: uniform(vec3(...IDENTITY_GRADE.gamma)),
    gain: uniform(vec3(...IDENTITY_GRADE.gain)),
  };
  if (withTail) u.lutStrength = uniform(float(0));
  return u;
}

/** Push a grade params object into its uniform nodes. No per-frame allocation. */
function writeGradeUniforms(u, params) {
  const p = { ...IDENTITY_GRADE, ...(params || {}) };
  u.exposure.value = Number(p.exposure) || 0;
  u.contrast.value = Number.isFinite(Number(p.contrast)) ? Number(p.contrast) : 1;
  u.saturation.value = Number.isFinite(Number(p.saturation)) ? Number(p.saturation) : 1;
  u.vibrance.value = Number(p.vibrance) || 0;
  u.temperature.value = Number(p.temperature) || 0;
  u.tint.value = Number(p.tint) || 0;
  const lift = p.lift || IDENTITY_GRADE.lift;
  const gamma = p.gamma || IDENTITY_GRADE.gamma;
  const gain = p.gain || IDENTITY_GRADE.gain;
  u.lift.value.set(lift[0], lift[1], lift[2]);
  u.gamma.value.set(gamma[0], gamma[1], gamma[2]);
  u.gain.value.set(gain[0], gain[1], gain[2]);
}

/**
 * Build the present material with the grade stack folded in.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.litTexture - `scene.lit`'s texture (linear, the composed frame).
 * @param {*} [args.outdoorsTexNode] - the SHARED `_Outdoors` node (see the note
 *   in the previous version: sharing the node is what makes a mask rebake reach
 *   the grade too).
 * @param {*} [args.uViewRect] @param {*} [args.uOutdoorsRect] - the SHARED gate uniforms.
 * @param {*} [args.lutTexture] - a placeholder identity 3D LUT texture, so the
 *   LUT node always compiles; `setLut` swaps its `.value` in. Omit → no LUT node.
 * @returns {{ material, presentTexNode, setEnvGrade, setArtGrade, setLut, rebindLit, gateCompiled }}
 */
export function buildGradePresentMaterial({
  THREE,
  litTexture,
  outdoorsTexNode,
  uViewRect,
  uOutdoorsRect,
  lutTexture,
}) {
  const TSL = THREE.TSL;
  const { texture, vec4, mix } = TSL;

  const presentTexNode = texture(litTexture);
  const uEnv = makeGradeUniforms(TSL, false);
  const uArt = makeGradeUniforms(TSL, true);
  const lutTexNode = lutTexture ? TSL.texture3D(lutTexture) : null;

  const outdoors = buildOutdoorsGate(TSL, { uViewRect, uOutdoorsRect, outdoorsTexNode });

  const material = new THREE.NodeMaterial();
  material.depthTest = false;
  material.depthWrite = false;

  /** The tone-map curve currently BAKED into the fragment (a compile-time
   * choice — see the header). Rebuilt when it changes. */
  let currentToneMapping = 'none';

  /** (Re)build the fragment node for the current tone-map selection. The env
   * grade and the LUT are unaffected (they are uniform/texture-driven). */
  function rebuildFragment() {
    const lit = presentTexNode.rgb; // linear
    // ENVIRONMENTAL grade, outdoor-gated. No tail on this scope (Grade.md §13).
    const gradedEnv = buildGradeNode(TSL, lit, uEnv);
    const afterEnv = outdoors ? mix(lit, gradedEnv, outdoors) : lit;
    // ARTISTIC grade + the whole-frame TAIL (tone map + LUT).
    const gradedArt = buildGradeNode(TSL, afterEnv, uArt, {
      toneMapping: currentToneMapping,
      lutTexture: lutTexNode,
      lutStrength: uArt.lutStrength,
    });
    material.fragmentNode = vec4(gradedArt, presentTexNode.a);
    material.needsUpdate = true;
  }
  rebuildFragment();

  return {
    material,
    presentTexNode,
    /** Push this frame's environmental grade (resolved from env). */
    setEnvGrade: (params) => writeGradeUniforms(uEnv, params),
    /**
     * Push the artistic grade. `gradeParams` are the primary ops; `tail` is
     * `{toneMapping, lutStrength}`. Rebuilds the fragment ONLY if the tone-map
     * curve changed (compile-time), else just writes uniforms.
     */
    setArtGrade: (gradeParams, tail = {}) => {
      writeGradeUniforms(uArt, gradeParams);
      if (uArt.lutStrength)
        uArt.lutStrength.value = Number.isFinite(Number(tail.lutStrength)) ? Number(tail.lutStrength) : 0;
      const nextTone = tail.toneMapping || 'none';
      if (nextTone !== currentToneMapping) {
        currentToneMapping = nextTone;
        rebuildFragment();
      }
    },
    /** Swap the 3D LUT texture (a parsed .cube uploaded as a Data3DTexture). */
    setLut: (tex) => {
      if (lutTexNode && tex) lutTexNode.value = tex;
    },
    /** Re-point at a freshly-allocated lit target (resize). */
    rebindLit: (tex) => {
      presentTexNode.value = tex;
      material.needsUpdate = true;
    },
    gateCompiled: !!outdoors,
  };
}
