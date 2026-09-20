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
 * Colour Grade effect resolves its own params. As of 2026-08-31 its resolved
 * `toneMapping` default is ALSO `'none'` (grade.js), so on a fresh scene this
 * construction-time state and the cascade's resolved state already agree —
 * no rebuild fires until an author actually picks a film response.
 *
 * @module effects/grade/grade-present
 */

import { buildGradeNode, IDENTITY_GRADE } from './grade-ops.js';
import { buildOutdoorsGate } from '../lighting/environmental-light.js';
import { STYLIZE_LOOK_NAMES } from '../stylize.js';
// PLAYER VISION-MODE GRADE (mythica-machina-press#77 Stage 2b, #580) — an
// intra-zone sibling import (`effects/vision/`), same "both live under
// effects/" allowance `environmental-light.js`'s own header already uses for
// its `../fluid/fluid-render.js` import. See that module's own header for
// the full "why here, not vision-mask-render.js/environmental-light.js"
// reasoning — the short version: this is the LAST fullscreen pass before the
// canvas, so it sees the fog gate and bloom's own work already done, and its
// `buildStylizeNode`/`currentStyle` pattern just below is the EXACT
// structural precedent this hook copies.
import { buildPlayerVisionGradeNode, PLAYER_VISION_GRADE_MODE_KEYS } from '../vision/player-vision-grade-render.js';

const STYLE_NAMES_SAFE = new Set(STYLIZE_LOOK_NAMES);
const PLAYER_VISION_MODE_NAMES_SAFE = new Set(PLAYER_VISION_GRADE_MODE_KEYS);

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
 * @param {(THREE:*, tex:*, uvNode:*) => {rgb:*, a:*}} [args.buildPostUpscaleSharpenNode] -
 *   INJECTED, never imported directly (`vt/albedo-clarity.js#buildPostUpscaleSharpenNode`)
 *   — `vt/` already legitimately imports `effects/` (`scene-attr.js`,
 *   `vt-pan-viewer.js`), so an `effects/` file importing back from `vt/`
 *   would be a genuine circular zone dependency, not just a `zones/one-door`
 *   paperwork violation (confirmed: `effects/index.js` already re-exports
 *   THIS function, so the cycle would be immediate). `vt-pan-viewer.js`
 *   passes the real builder in — same shape `outdoorsTexNode` etc. already
 *   use for "this material needs something from outside its own zone."
 *   Omit → the render-scale governor's post-upscale sharpen never compiles
 *   in, same as never calling `setPostUpscaleSharpenActive`.
 * @returns {{ material, presentTexNode, setEnvGrade, setArtGrade, setStylize, setLut, setPostUpscaleSharpenActive, rebindLit, gateCompiled }}
 */
export function buildGradePresentMaterial({
  THREE,
  litTexture,
  outdoorsTexNode,
  uViewRect,
  uOutdoorsRect,
  lutTexture,
  buildPostUpscaleSharpenNode,
}) {
  const TSL = THREE.TSL;
  const { texture, vec3, vec4, mix, uv, dot, uniform, float } = TSL;

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
  /** Are the render-scale governor's post-upscale sharpen taps currently
   * COMPILED IN (2026-08-27)? A structural choice, same shape as
   * `currentToneMapping` — see `setPostUpscaleSharpenActive`'s own doc.
   * Ships `false`: neutral until the governor ever actually renders below
   * native, matching this whole file's "ships neutral" header promise. */
  let sharpenActive = false;
  /** The Stylize effect's `style` currently BAKED into the fragment
   * (mythica-machina-press#36) — same "different Fn per choice, so a
   * compile-time rebuild, not a uniform switch" reasoning as
   * `currentToneMapping` right above. `amount` (how much to blend the style
   * in) is a live uniform, `uStylizeAmount` below — it doesn't need a
   * rebuild, only the CHOICE of transform does. */
  let currentStyle = 'none';
  const uStylizeAmount = uniform(float(0));

  /** The player vision-mode grade currently BAKED into the fragment
   * (mythica-machina-press#77 Stage 2b) — same "different Fn per choice, so
   * a compile-time rebuild" reasoning as `currentStyle` right above, and
   * `'none'` is the identity exactly like `currentStyle`'s own default. This
   * one is PER-VIEWING-CLIENT, never GM-authored, so nothing here reads a
   * cascade/registry value — `setPlayerVisionMode` below is called directly
   * from a live per-frame closure (`grade-present.js`'s own header, and
   * `player-vision-grade-render.js`'s header, have the full reasoning). */
  let currentPlayerVisionMode = 'none';
  /** Milliseconds, pushed every frame — drives grain/scan animation in the
   * active modes. A plain uniform, not a rebuild trigger: only the MODE
   * choice rebuilds the fragment, matching `uStylizeAmount`'s own split
   * between "structural choice" (rebuild) and "live value" (uniform only). */
  const uPlayerVisionTimeMs = uniform(float(0));

  /**
   * The Stylize effect's per-style colour transform, applied to the fully
   * graded/tone-mapped/LUT'd colour (i.e. strictly AFTER Colour Grade's own
   * tail) — matching V2's own `post.grade absorbs SepiaEffectV2` placement.
   * `null` for 'none' (and any future not-yet-built style) so the caller can
   * skip the mix entirely rather than blending toward a no-op.
   * @param {*} rgb - the graded colour node to transform.
   * @param {string} style
   * @returns {*|null}
   */
  function buildStylizeNode(rgb, style) {
    if (style === 'sepia') {
      // The standard sepia matrix (W3C Filter Effects' own `feColorMatrix`
      // sepia values) — a real, published formula, not a from-scratch guess.
      // Clamped: the matrix's row sums exceed 1, so a bright input can
      // overshoot before this.
      const r = dot(rgb, vec3(0.393, 0.769, 0.189));
      const g = dot(rgb, vec3(0.349, 0.686, 0.168));
      const b = dot(rgb, vec3(0.272, 0.534, 0.131));
      return vec3(r, g, b).clamp(0, 1);
    }
    if (style === 'invert') {
      return vec3(1, 1, 1).sub(rgb);
    }
    return null;
  }

  /** (Re)build the fragment node for the current tone-map selection AND the
   * current post-upscale-sharpen active state. The env grade and the LUT are
   * unaffected (they are uniform/texture-driven). */
  function rebuildFragment() {
    // POST-UPSCALE SHARPEN (2026-08-27) — sharpens the RAW present-resolution
    // image BEFORE any grading, so colour grading applies on top unchanged
    // (see buildPostUpscaleSharpenNode's own header for why this repair
    // exists at all). Reads `presentTexNode.value` (the texture it is
    // CURRENTLY bound to, kept current by `rebindLit` below), not the
    // `litTexture` closure param directly — a resize that ever changed the
    // underlying texture object's identity between rebuilds must not leave
    // these taps sampling a stale reference the way a captured `litTexture`
    // could. Native path (`sharpenActive` false) pays NOTHING extra: `lit`
    // is `presentTexNode.rgb` exactly as before this feature existed.
    const lit =
      sharpenActive && buildPostUpscaleSharpenNode
        ? buildPostUpscaleSharpenNode(THREE, presentTexNode.value, uv()).rgb
        : presentTexNode.rgb; // linear
    // ENVIRONMENTAL grade, outdoor-gated. No tail on this scope (Grade.md §13).
    const gradedEnv = buildGradeNode(TSL, lit, uEnv);
    const afterEnv = outdoors ? mix(lit, gradedEnv, outdoors) : lit;
    // ARTISTIC grade + the whole-frame TAIL (tone map + LUT).
    const gradedArt = buildGradeNode(TSL, afterEnv, uArt, {
      toneMapping: currentToneMapping,
      lutTexture: lutTexNode,
      lutStrength: uArt.lutStrength,
    });
    // STYLIZE (mythica-machina-press#36) — strictly after Colour Grade's own
    // tail, so a picked style layers on top of exposure/tone-map/LUT rather
    // than competing with them. `null` (style 'none', the default) skips the
    // mix entirely — byte-identical to before this effect existed, same
    // "omitted input compiles to nothing" contract as `lutTexture` above.
    const styled = buildStylizeNode(gradedArt, currentStyle);
    const afterStylize = styled ? mix(gradedArt, styled, uStylizeAmount) : gradedArt;
    // PLAYER VISION-MODE GRADE — strictly LAST, after Colour Grade's own
    // tail AND Stylize, since this is the viewing client's own personal
    // device/eye filter over whatever the shot already looks like (see
    // `player-vision-grade-render.js`'s header). `null` (mode 'none', the
    // overwhelming common case — no GM, no picked mode, or the scene
    // disallows it) skips the mix entirely, same no-op contract as `styled`
    // just above: a frame with no active vision mode pays nothing extra here
    // beyond the one `currentPlayerVisionMode !== 'none'` JS-time branch.
    const visionGraded = buildPlayerVisionGradeNode({
      THREE,
      rgb: afterStylize,
      uv: uv(),
      mode: currentPlayerVisionMode,
      timeMs: uPlayerVisionTimeMs,
    });
    const finalRgb = visionGraded ?? afterStylize;
    material.fragmentNode = vec4(finalRgb, presentTexNode.a);
    material.needsUpdate = true;
  }
  rebuildFragment();

  return {
    material,
    presentTexNode,
    /** Push this frame's environmental grade (resolved from env). */
    setEnvGrade: (params) => writeGradeUniforms(uEnv, params),
    /**
     * Push the Stylize effect's resolved params (mythica-machina-press#36).
     * Rebuilds ONLY if `style` actually changed (compile-time, same posture
     * as `setArtGrade`'s tone-map handling) — `amount` alone never rebuilds.
     * @param {string} style @param {number} amount
     */
    setStylize: (style, amount) => {
      const next = STYLE_NAMES_SAFE.has(style) ? style : 'none';
      if (next !== currentStyle) {
        currentStyle = next;
        rebuildFragment();
      }
      uStylizeAmount.value = Number.isFinite(Number(amount)) ? Math.min(1, Math.max(0, Number(amount))) : 0;
    },
    /**
     * Push this frame's active player vision-mode grade (mythica-machina-
     * press#77 Stage 2b) — `mode` is the CALLER's already-gated answer
     * (`effects/vision/player-vision-modes.js#resolveActivePlayerVisionModePreset`'s
     * result, threaded through `boot.js`'s injected per-frame closure and
     * `vt-pan-viewer.js`'s own `pushPlayerVisionMode`), never resolved here —
     * this setter only knows "which of the four names, or none" and "what
     * time is it," the same division of labour `setStylize` already has
     * between the cascade (elsewhere) and the uniform push (here). Rebuilds
     * ONLY if the mode actually changed (compile-time, same posture as
     * `setStylize`'s own `currentStyle` handling); `timeMs` alone never
     * rebuilds. An unrecognized/omitted mode is treated as `'none'` — fails
     * closed to "no grade" rather than risking a stale mode string wedging a
     * viewer into a permanent tint.
     * @param {string|null} mode @param {number} timeMs
     */
    setPlayerVisionMode: (mode, timeMs) => {
      const next = PLAYER_VISION_MODE_NAMES_SAFE.has(mode) ? mode : 'none';
      if (next !== currentPlayerVisionMode) {
        currentPlayerVisionMode = next;
        rebuildFragment();
      }
      uPlayerVisionTimeMs.value = Number.isFinite(Number(timeMs)) ? Number(timeMs) : 0;
    },
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
    /**
     * Turn the render-scale governor's post-upscale sharpen taps on/off
     * (2026-08-27) — a STRUCTURAL choice (are the extra samples even
     * compiled in), not the strength itself (a separate live uniform inside
     * `buildPostUpscaleSharpenNode`'s own shared state — see that function's
     * header for why the two are split). Rebuilds ONLY when the active state
     * actually flips, the SAME "compile-time, rebuilt on change" mechanism
     * `setArtGrade`'s own tone-map handling already uses — the native
     * (inactive) path stays exactly as cheap as it always was. A no-op
     * (never activates) if this material was built without a
     * `buildPostUpscaleSharpenNode` injected.
     * @param {boolean} active
     */
    setPostUpscaleSharpenActive: (active) => {
      const next = !!active && !!buildPostUpscaleSharpenNode;
      if (next !== sharpenActive) {
        sharpenActive = next;
        rebuildFragment();
      }
    },
    /** Re-point at a freshly-allocated lit target (resize). */
    rebindLit: (tex) => {
      presentTexNode.value = tex;
      material.needsUpdate = true;
      // If the post-upscale sharpen is active, its own taps were built
      // against whatever `presentTexNode.value` was at the LAST rebuild —
      // force a fresh one so they never sample a stale texture object
      // identity a resize could (rarely, but see rebuildFragment's own
      // comment) have changed. The native path (sharpenActive false) is
      // untouched: this is a no-op call that costs nothing extra.
      if (sharpenActive) rebuildFragment();
    },
    /**
     * Re-point at a DIFFERENT, ALREADY-SAME-SHAPE texture, EVERY FRAME — no
     * `needsUpdate`, no rebuild (2026-08-30, TAA — Stage 5.6). Deliberately
     * distinct from `rebindLit` just above: that one exists for a RESIZE
     * (rare, the underlying texture's own dimensions changed, worth paying a
     * rebuild to be safe) — this one exists for the TAA resolve pass
     * re-pointing present at whichever history buffer it just wrote,
     * EVERY SINGLE FRAME, where a rebuild would be the exact "wasteful if
     * reused for a per-frame ping-pong swap" cost `taa-resolve.js`'s own
     * header names. Same identically-shaped/-formatted internal-tier
     * HalfFloat target either way (`scene.lit` or a TAA history buffer, both
     * built from `describeSceneColor()`), so a bare `.value =` is genuinely
     * sufficient — verified against the same "RenderTarget#setSize mutates
     * the SAME texture object in place" class of guarantee this file's own
     * `rebindLit` already leans on, just without the dimension change that
     * function exists to handle.
     * @param {*} tex
     */
    setLitSource: (tex) => {
      presentTexNode.value = tex;
    },
    /**
     * The texture `setLitSource`/`rebindLit` most recently pointed present
     * at — a plain read of the SAME backing value, for a LATER post-stage
     * pass that needs to keep chaining off whatever the pipeline has
     * arrived at so far (mythica-machina-press#57's `post.lens`: reads
     * this as its own input, writes a transformed copy, then calls
     * `setLitSource` again to hand the chain forward). Never mutates
     * anything itself — a getter paired with the existing setter, same
     * shape as `windHandle`'s own `.node()`/`.ambient` split (read vs.
     * write, two different doors on one piece of state).
     * @returns {*}
     */
    getLitSource: () => presentTexNode.value,
    gateCompiled: !!outdoors,
  };
}
