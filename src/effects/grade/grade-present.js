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
import {
  buildPlayerVisionGradeNode,
  PLAYER_VISION_GRADE_MODE_KEYS,
  PLAYER_VISION_TOKEN_SLOTS,
} from '../vision/player-vision-grade-render.js';
import { VISION_MODE_PRESETS } from '../vision/player-vision-modes.js';
// TEMPERATURE EFFECTS (2026-10-27) — frost frame + outdoor heat ripple, folded
// in here for the same reason the fire heat haze below is: both re-point the
// present's own sample position, and this is the one draw that already has
// the outdoors gate and the graded image at any UV.
import {
  createTemperatureUniforms,
  buildFrostNodes,
  applyFrostLayer,
  buildHeatRippleOffset,
} from '../temperature/temperature-render.js';
import { HEAT_TAP_Y_FREQ } from '../temperature/temperature-model.js';
// THE FOG HOLD (2026-10-27) — the vision gate's own reveal test, re-asked here
// so the grade never reaches into the fog (see `setFogHoldActive`).
import { sampleVisionRevealFactor, sampleExploredNode } from '../vision/vision-mask-render.js';

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
 * @param {*} [args.uOutdoorsExtent] - the environmental light's outdoors extent (the viewer's effects
 *   extent), so the outdoor grade reaches a parallax canopy overhanging the Table's recess wall.
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
 * @param {*} [args.temperatureNoiseTexture] - a repeat-wrapped placeholder for
 *   the Temperature Effects tile (`temperature-noise.js`); `setTemperatureNoise`
 *   swaps the real one in. Omit → frost and heat ripple never compile in.
 * @param {{maskTexture:*, illumTexture:*, exploredTexture:*, exploredSnapshotTexture?:*, uExploredRect:*, threshold:number, extraRevealed?:(uv:*)=>*}} [args.fogHold] -
 *   the vision gate's own inputs (`vision-mask-render.js`), so the present can
 *   keep the grade out of the fog. Omit → `setFogHoldActive` is a no-op.
 * @returns {{ material, presentTexNode, setEnvGrade, setArtGrade, setStylize, setPlayerVisionMode, setPlayerVisionTokens, setLut, setPostUpscaleSharpenActive, setFogHoldActive, setTemperatureEffects, setTemperatureNoise, rebindLit, gateCompiled }}
 */
export function buildGradePresentMaterial({
  THREE,
  litTexture,
  outdoorsTexNode,
  uViewRect,
  uOutdoorsRect,
  uOutdoorsExtent = null,
  lutTexture,
  buildPostUpscaleSharpenNode,
  temperatureNoiseTexture,
  fogHold,
}) {
  const TSL = THREE.TSL;
  const { texture, vec2, vec3, vec4, mix, uv, dot, uniform, float, max, min, select } = TSL;

  const presentTexNode = texture(litTexture);
  const uEnv = makeGradeUniforms(TSL, false);
  const uArt = makeGradeUniforms(TSL, true);
  const lutTexNode = lutTexture ? TSL.texture3D(lutTexture) : null;

  const gateCompiled = !!outdoorsTexNode;

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
  let requestedPlayerVisionMode = 'none';
  let visionPowerTransition = { startMs: 0, from: 0, to: 0, durationMs: 0, flickerOnStart: false };
  /** Milliseconds, pushed every frame — drives grain/scan animation in the
   * active modes. A plain uniform, not a rebuild trigger: only the MODE
   * choice rebuilds the fragment, matching `uStylizeAmount`'s own split
   * between "structural choice" (rebuild) and "live value" (uniform only). */
  const uPlayerVisionTimeMs = uniform(float(0));
  /** The scene's darkness 0..1, pushed every frame: Night Vision and Low-light fade in as it rises
   * (V2's darkness gate), so a lit daytime map is left alone. Starts fully dark (always on). */
  const uPlayerVisionDarkness = uniform(float(1));
  /** The per-viewer NV tube's warm-up/shutdown envelope (V2). */
  const uPlayerVisionPower = uniform(float(0));
  /** World-pixel center of the selected/owned token for the NV falloff. */
  const uPlayerVisionAnchorWorld = uniform(vec2(0, 0));
  const uPlayerVisionAnchorValid = uniform(float(0));
  /** Selected token's world-space diameter; keeps the radius zoom-stable. */
  const uPlayerVisionTokenSize = uniform(float(100));
  /**
   * THE HOT-BODY COUNTER (2026-10-15) — `(worldX, worldY, radiusX, radiusY)`
   * per visible token: the token's own bounding box in world pixels, which is
   * the shape the infravision recolour paints. A fixed, JS-UNROLLED list of
   * plain `vec4` uniforms, never a `uniformArray` read through a TSL `Loop`
   * (live-confirmed broken on this renderer — see `player-vision-grade-
   * render.js#buildTokenMaskNode`'s own header). The nodes are created once
   * here and only their `.value`s are written per frame, so the mode's
   * compile-time fragment rebuild never has to know how many tokens are on
   * screen. `vt-pan-viewer.js#pushPlayerVisionTokens` is the only writer; slots
   * past the supplied count are left at `radiusX = 0`.
   */
  const uPlayerVisionTokens = Array.from({ length: PLAYER_VISION_TOKEN_SLOTS }, () => uniform(vec4(0, 0, 0, 0)));
  /**
   * HEAT HAZE (2026-10-20): a shimmer warp over every hot fire, applied to the final picture's sample position. `(worldX, worldY, radius,
   * strength)` per source and `(reach, speed, scale, 0)` beside it; a fixed JS-unrolled list (see the token list above for why never a
   * uniformArray loop). Slots past the supplied count have strength 0, and `uHeatActive` 0 skips the whole warp.
   */
  const HEAT_SLOTS = 8;
  const uHeat = Array.from({ length: HEAT_SLOTS }, () => uniform(vec4(0, 0, 1, 0)));
  const uHeatShape = Array.from({ length: HEAT_SLOTS }, () => uniform(vec4(2.6, 1, 1, 0)));
  const uHeatActive = uniform(float(0));
  const uHeatTime = uniform(float(0));

  /** TEMPERATURE EFFECTS — which of its two warp layers are COMPILED IN. A
   * structural choice, same shape as `sharpenActive`: off ⇒ not one node of
   * it exists, so a temperate scene's present is the shader it always was. */
  const uTemp = createTemperatureUniforms(TSL);
  const tempNoiseNode = temperatureNoiseTexture ? texture(temperatureNoiseTexture) : null;
  let frostCompiled = false;
  let heatRippleCompiled = false;

  /**
   * THE FOG HOLD — is it COMPILED IN (2026-10-27)? The author: *"when it is
   * dark it must be perfect solid black"*, and the Temperature grade must stay
   * *"only … in visible areas for that token and not extend into the Fog of
   * War"*. The vision gate (`vt-pan-viewer.js#runVisionGatePass`) blacks out
   * and dims `scene.lit` BEFORE bloom, so everything this material does after
   * it — the env grade's lift and exposure, the warm/cold split-tone, the
   * artistic grade — used to paint straight over the fog: never-seen ground
   * came out brown, and remembered ground brightened only where `_Outdoors`
   * was white. With the hold on, each pixel asks the gate's own question:
   *   revealed now          → graded, as before
   *   explored, not visible → exactly what the gate left (the dim memory)
   *   never explored        → solid black, bloom's spill included
   * Same compile-time shape as `sharpenActive`: off (MSA not owning vision)
   * means not one node of it exists.
   */
  let fogHoldActive = false;

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
    /** Rebuild the complete pre-vision image at an arbitrary screen UV. V2's
     * lens distortion and chromatic aberration refract the already graded
     * display image, so their taps must travel through the same grade/LUT/
     * stylize chain instead of sampling raw `scene.lit`. */
    const buildStyledAt = (sampleUv) => {
      const sampledLit =
        sharpenActive && buildPostUpscaleSharpenNode
          ? buildPostUpscaleSharpenNode(THREE, presentTexNode.value, sampleUv).rgb
          : presentTexNode.sample(sampleUv).rgb;
      // ENVIRONMENTAL grade, outdoor-gated. No tail on this scope (Grade.md §13).
      const outdoorsAt = buildOutdoorsGate(TSL, {
        uViewRect,
        uOutdoorsRect,
        outdoorsTexNode,
        uvNode: sampleUv,
        uExtentRect: uOutdoorsExtent,
      });
      const gradedEnv = buildGradeNode(TSL, sampledLit, uEnv);
      const afterEnv = outdoorsAt ? mix(sampledLit, gradedEnv, outdoorsAt) : sampledLit;
      // ARTISTIC grade + the whole-frame TAIL (tone map + LUT).
      const gradedArt = buildGradeNode(TSL, afterEnv, uArt, {
        toneMapping: currentToneMapping,
        lutTexture: lutTexNode,
        lutStrength: uArt.lutStrength,
      });
      // STYLIZE remains before the personal viewing-device optics.
      const styled = buildStylizeNode(gradedArt, currentStyle);
      const shot = styled ? mix(gradedArt, styled, uStylizeAmount) : gradedArt;
      if (!fogHoldActive) return shot;
      // THE FOG HOLD — see `fogHoldActive`. Asked at the SAME uv the picture
      // was sampled at, so frost refraction and heat ripple move the fog's
      // edge with the image instead of shearing it off.
      const { revealed } = sampleVisionRevealFactor({
        THREE,
        maskTexture: fogHold.maskTexture,
        illumTexture: fogHold.illumTexture,
        screenUV: sampleUv,
        threshold: fogHold.threshold,
        extraRevealed: fogHold.extraRevealed ?? null,
      });
      const { isExplored } = sampleExploredNode({
        THREE,
        exploredTexture: fogHold.exploredTexture,
        uViewRect,
        uExploredRect: fogHold.uExploredRect,
        screenUV: sampleUv,
        exploredSnapshotTexture: fogHold.exploredSnapshotTexture ?? null,
      });
      return select(revealed, shot, select(isExplored, sampledLit, vec3(0, 0, 0)));
    };
    // THE HEAT WARP: for each hot fire, a column of rising shimmer above it (screen up), strongest just over the flame and fading out
    // by `reach` radii; two octaves of slow noise pushed upward make the picture ripple.
    const heatOffsetUv = (() => {
      const { Fn, If, mx_noise_float, exp, smoothstep } = TSL;
      return Fn(() => {
        const viewSpanX = max(uViewRect.z.sub(uViewRect.x), float(1e-5));
        const viewSpanY = max(uViewRect.w.sub(uViewRect.y), float(1e-5));
        const pw = vec2(uViewRect.x.add(uv().x.mul(viewSpanX)), uViewRect.y.add(uv().y.mul(viewSpanY)));
        const total = vec2(0, 0).toVar();
        If(uHeatActive.greaterThan(0.5), () => {
          for (let i = 0; i < HEAT_SLOTS; i++) {
            const h = uHeat[i];
            const sh = uHeatShape[i];
            const r = max(h.z, float(8));
            const dx = pw.x.sub(h.x).div(r);
            const up = h.y.sub(pw.y).div(r); // screen up is -y: positive above the fire
            const across = exp(dx.mul(dx).mul(-1.3));
            const rise = smoothstep(float(-0.25), float(0.35), up).mul(
              float(1).sub(smoothstep(sh.x.mul(0.35), sh.x, up))
            );
            const w = across.mul(rise).mul(h.w);
            const f = sh.z.mul(0.06).div(r.mul(0.02));
            const tt = uHeatTime.mul(sh.y);
            const nx = mx_noise_float(vec3(pw.x.mul(f), pw.y.mul(f).add(tt.mul(1.9)), tt.mul(0.4)));
            const ny = mx_noise_float(vec3(pw.x.mul(f).add(17.3), pw.y.mul(f).add(tt.mul(1.6)), tt.mul(0.35).add(5.1)));
            const n2 = mx_noise_float(
              vec3(pw.x.mul(f).mul(2.3).add(3.1), pw.y.mul(f).mul(2.3).add(tt.mul(2.8)), tt.mul(0.6))
            );
            const amp = r.mul(0.16).mul(w);
            total.addAssign(vec2(nx.add(n2.mul(0.5)), ny.mul(0.7).add(n2.mul(0.3))).mul(amp));
          }
        });
        return vec2(total.x.div(viewSpanX), total.y.div(viewSpanY));
      })();
    })();
    // TEMPERATURE EFFECTS — only the layers currently showing are built.
    let sampleUv = uv().add(heatOffsetUv);
    let frost = null;
    if (tempNoiseNode && (frostCompiled || heatRippleCompiled)) {
      const viewSpanX = max(uViewRect.z.sub(uViewRect.x), float(1e-5));
      const viewSpanY = max(uViewRect.w.sub(uViewRect.y), float(1e-5));
      if (frostCompiled) {
        frost = buildFrostNodes(TSL, {
          uvNode: uv(),
          aspectNode: viewSpanX.div(viewSpanY),
          noiseTexNode: tempNoiseNode,
          u: uTemp,
        });
        sampleUv = sampleUv.add(frost.offsetUv);
      }
      if (heatRippleCompiled) {
        const worldXY = vec2(uViewRect.x.add(uv().x.mul(viewSpanX)), uViewRect.y.add(uv().y.mul(viewSpanY)));
        sampleUv = sampleUv.add(
          buildHeatRippleOffset(TSL, {
            worldXY,
            noiseTexNode: tempNoiseNode,
            gate: buildOutdoorsGate(TSL, { uViewRect, uOutdoorsRect, outdoorsTexNode }),
            u: uTemp,
            yFreq: HEAT_TAP_Y_FREQ,
          })
        );
      }
    }
    const styledAtSample = buildStyledAt(sampleUv);
    // Frost sits on the glass: over the finished shot, under the viewer's own
    // vision-mode device below.
    const afterStylize = frost ? applyFrostLayer(TSL, styledAtSample, frost, uTemp) : styledAtSample;
    // Convert the token's world-pixel center using the SAME live camera rect
    // the environmental gate uses. This stays aligned while panning/zooming;
    // computing UV on the JS side would trail the camera by a frame.
    let visionCenter = null;
    let visionWorldSize = null;
    let visionTokenSize = null;
    // EVERY grade mode now has a token-centered range (2026-10-15: the two
    // infravision modes joined NV and both low-light modes), so any active
    // mode — none is the only exception — needs the same world→UV mapping.
    if (currentPlayerVisionMode !== 'none') {
      const viewSpanX = max(uViewRect.z.sub(uViewRect.x), float(1e-5));
      const viewSpanY = max(uViewRect.w.sub(uViewRect.y), float(1e-5));
      visionWorldSize = vec2(viewSpanX, viewSpanY);
      const worldCenterUv = vec2(
        uPlayerVisionAnchorWorld.x.sub(uViewRect.x).div(viewSpanX),
        uPlayerVisionAnchorWorld.y.sub(uViewRect.y).div(viewSpanY)
      );
      visionCenter = mix(vec2(0.5, 0.5), worldCenterUv, uPlayerVisionAnchorValid);
      const fallbackTokenSize = max(min(viewSpanX, viewSpanY).div(float(20)), float(1));
      visionTokenSize = mix(fallbackTokenSize, uPlayerVisionTokenSize, uPlayerVisionAnchorValid);
    }
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
      darkness01: uPlayerVisionDarkness,
      modePower: uPlayerVisionPower,
      visionCenter,
      visionWorldSize,
      visionTokenSize,
      viewRect: uViewRect,
      tokenSlots: uPlayerVisionTokens,
      sampleRgbAt: buildStyledAt,
    });
    const finalRgb = visionGraded ?? afterStylize;
    material.fragmentNode = vec4(finalRgb, presentTexNode.a);
    material.needsUpdate = true;
  }

  function easedVisionPower(nowMs) {
    const transition = visionPowerTransition;
    if (transition.durationMs <= 0) return transition.to;
    const elapsed = Math.max(0, nowMs - transition.startMs);
    const t = Math.min(1, elapsed / transition.durationMs);
    const eased = t * t * (3 - 2 * t);
    let power = transition.from + (transition.to - transition.from) * eased;
    if (transition.flickerOnStart && t < 1) {
      const p = VISION_MODE_PRESETS.nightVision;
      if (p.powerFlickerEnabled) {
        const intensity = p.powerFlickerIntensity;
        power *= 1 - intensity * (0.55 + 0.45 * Math.sin((nowMs - transition.startMs) * 0.001 * (22 + 17 * intensity)));
      }
    }
    return Math.min(1, Math.max(0, power));
  }

  function beginVisionPowerTransition(from, to, nowMs, durationSeconds, flickerOnStart = false) {
    visionPowerTransition = {
      startMs: nowMs,
      from,
      to,
      durationMs: Math.max(0, Number(durationSeconds) || 0) * 1000,
      flickerOnStart,
    };
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
     * this setter only knows "which of the five names, or none" and "what
     * time is it," the same division of labour `setStylize` already has
     * between the cascade (elsewhere) and the uniform push (here). Rebuilds
     * ONLY if the mode actually changed (compile-time, same posture as
     * `setStylize`'s own `currentStyle` handling); `timeMs` alone never
     * rebuilds. An unrecognized/omitted mode is treated as `'none'` — fails
     * closed to "no grade" rather than risking a stale mode string wedging a
     * viewer into a permanent tint.
     * @param {string|null} mode @param {number} timeMs @param {number} [darkness01] the scene's darkness (omitted = fully dark)
     * @param {{x:number,y:number,tokenSizePx?:number}|null} [anchorWorld] selected token center/size in world pixels.
     */
    setPlayerVisionMode: (mode, timeMs, darkness01, anchorWorld) => {
      const next = PLAYER_VISION_MODE_NAMES_SAFE.has(mode) ? mode : 'none';
      const nowMs = Number.isFinite(Number(timeMs)) ? Number(timeMs) : 0;
      if (next !== requestedPlayerVisionMode) {
        const powerNow = easedVisionPower(nowMs);
        requestedPlayerVisionMode = next;
        if (next === 'none') {
          if (currentPlayerVisionMode === 'nightVision') {
            beginVisionPowerTransition(powerNow, 0, nowMs, VISION_MODE_PRESETS.nightVision.shutdownSeconds);
          } else {
            beginVisionPowerTransition(0, 0, nowMs, 0);
            currentPlayerVisionMode = 'none';
            rebuildFragment();
          }
        } else {
          const switchingFromNightVision = currentPlayerVisionMode === 'nightVision';
          if (next !== currentPlayerVisionMode) {
            currentPlayerVisionMode = next;
            rebuildFragment();
          }
          if (next === 'nightVision') {
            const warmupFrom = switchingFromNightVision ? powerNow : 0;
            beginVisionPowerTransition(warmupFrom, 1, nowMs, VISION_MODE_PRESETS.nightVision.warmupSeconds, true);
          } else {
            beginVisionPowerTransition(1, 1, nowMs, 0);
          }
        }
      }
      uPlayerVisionTimeMs.value = nowMs;
      const dark = Number(darkness01);
      uPlayerVisionDarkness.value = Number.isFinite(dark) ? Math.min(1, Math.max(0, dark)) : 1;
      const anchorX = Number(anchorWorld?.x);
      const anchorY = Number(anchorWorld?.y);
      if (Number.isFinite(anchorX) && Number.isFinite(anchorY)) {
        uPlayerVisionAnchorWorld.value.set(anchorX, anchorY);
        const tokenSize = Number(anchorWorld.tokenSizePx);
        if (Number.isFinite(tokenSize) && tokenSize > 0) uPlayerVisionTokenSize.value = tokenSize;
        else uPlayerVisionTokenSize.value = 100;
        uPlayerVisionAnchorValid.value = 1;
      } else {
        uPlayerVisionAnchorValid.value = 0;
      }
      const power = easedVisionPower(nowMs);
      uPlayerVisionPower.value = power;
      if (requestedPlayerVisionMode === 'none' && currentPlayerVisionMode !== 'none' && power <= 1e-3) {
        currentPlayerVisionMode = 'none';
        rebuildFragment();
      }
    },
    /**
     * Push this frame's visible tokens for the infravision hot-body recolour
     * (2026-10-15). `tokens[i]` is `{x, y, radiusX, radiusY}` in the SAME world
     * pixels `uPlayerVisionAnchorWorld` uses — the token's own bounding box,
     * which is the shape the recolour paints — ordered nearest-to-the-wearer
     * first, and `count` says how many of them are real this frame: a caller can
     * hand over its own persistent scratch array (which may be longer than
     * `PLAYER_VISION_TOKEN_SLOTS`) with no slicing and no per-frame allocation.
     * Every slot beyond `count` is switched OFF (`radiusX = 0`, which the shader
     * reads as "no token") so a token that walks off screen stops reading hot
     * the same frame. Never rebuilds the fragment — only uniform values change,
     * exactly the split `setPlayerVisionMode`'s own `timeMs` uses.
     * @param {ReadonlyArray<{x:number,y:number,radiusX:number,radiusY:number}>} [tokens]
     * @param {number} [count] - how many leading entries of `tokens` are valid.
     */
    setPlayerVisionTokens: (tokens = [], count = tokens.length) => {
      for (let i = 0; i < uPlayerVisionTokens.length; i++) {
        const slot = uPlayerVisionTokens[i].value;
        const t = i < count ? tokens[i] : null;
        if (t) slot.set(t.x, t.y, Math.max(Number(t.radiusX) || 0, 0), Math.max(Number(t.radiusY) || 0, 0));
        else slot.set(0, 0, 0, 0);
      }
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
    /**
     * Turn the fog hold on/off (2026-10-27) — see `fogHoldActive`. Rebuilds
     * only when the state flips; a no-op if built without `fogHold`. The
     * viewer turns it on while MSA owns vision and off when the gate hands
     * fog back to Foundry (then `scene.lit` is ungated and the mask stale).
     * @param {boolean} active
     */
    setFogHoldActive: (active) => {
      const next = !!active && !!fogHold;
      if (next !== fogHoldActive) {
        fogHoldActive = next;
        rebuildFragment();
      }
    },
    /** Is the fog hold compiled in right now — for diagnostics and tests. */
    fogHoldCompiled: () => fogHoldActive,
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
    /**
     * Set this frame's heat-haze sources: `[{x, y, r, s, reach?, speed?, scale?}]` (world px, strength 0..2), at most 8; none = no warp, no cost.
     * @param {Array<{x:number,y:number,r:number,s:number,reach?:number,speed?:number,scale?:number}>} sources
     * @param {number} timeSec
     */
    setHeatHaze: (sources = [], timeSec = 0) => {
      const n = Math.min(HEAT_SLOTS, Array.isArray(sources) ? sources.length : 0);
      let any = 0;
      for (let i = 0; i < HEAT_SLOTS; i++) {
        const s = i < n ? sources[i] : null;
        const strength = s && Number.isFinite(s.s) ? Math.max(0, s.s) : 0;
        uHeat[i].value.set(s?.x ?? 0, s?.y ?? 0, s?.r ?? 1, strength);
        uHeatShape[i].value.set(s?.reach ?? 2.6, s?.speed ?? 1, s?.scale ?? 1, 0);
        if (strength > 0) any = 1;
      }
      uHeatActive.value = any;
      uHeatTime.value = Number.isFinite(timeSec) ? timeSec % 1000 : 0;
    },
    /**
     * Push this frame's Temperature Effects warp (2026-10-27). `frost` /
     * `heatRipple` say which layers are SHOWING; flipping either rebuilds the
     * fragment (compile-time, same as `setPostUpscaleSharpenActive`), so the
     * caller should only flip them on real transitions. A no-op for both
     * layers when this material was built without a noise texture.
     * @param {{frost?: boolean, heatRipple?: boolean, frostCover?: number,
     *   frostShape?: number[], frostScale?: number, frostRefractUv?: number[],
     *   frostLook?: number[], frostTint?: number[], heatAmpUv?: number[],
     *   heatScroll?: number[], heatScale?: number}} s
     */
    setTemperatureEffects: (s = {}) => {
      const nextFrost = !!tempNoiseNode && s.frost === true;
      const nextHeat = !!tempNoiseNode && s.heatRipple === true;
      if (nextFrost !== frostCompiled || nextHeat !== heatRippleCompiled) {
        frostCompiled = nextFrost;
        heatRippleCompiled = nextHeat;
        rebuildFragment();
      }
      const setV = (node, arr) => {
        if (Array.isArray(arr) && arr.every(Number.isFinite)) node.value.set(...arr);
      };
      if (Number.isFinite(s.frostCover)) uTemp.frostCover.value = s.frostCover;
      setV(uTemp.frostShape, s.frostShape);
      if (Number.isFinite(s.frostScale)) uTemp.frostScale.value = s.frostScale;
      setV(uTemp.frostRefractUv, s.frostRefractUv);
      setV(uTemp.frostLook, s.frostLook);
      setV(uTemp.frostTint, s.frostTint);
      setV(uTemp.heatAmpUv, s.heatAmpUv);
      setV(uTemp.heatScroll, s.heatScroll);
      if (Number.isFinite(s.heatScale) && s.heatScale > 0) uTemp.heatScale.value = s.heatScale;
    },
    /** Swap in the baked Temperature Effects tile (same shape as `setLut`). */
    setTemperatureNoise: (tex) => {
      if (tempNoiseNode && tex) tempNoiseNode.value = tex;
    },
    /** Which Temperature Effects layers are compiled in right now — for diagnostics. */
    temperatureCompiled: () => ({ frost: frostCompiled, heatRipple: heatRippleCompiled }),
    gateCompiled,
  };
}
