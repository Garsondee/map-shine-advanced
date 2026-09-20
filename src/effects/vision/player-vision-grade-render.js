/**
 * PLAYER VISION-MODE GRADE — the TSL node graph for the four looks
 * `player-vision-modes.js#VISION_MODE_PRESETS` declares (mythica-machina-
 * press#77 Stage 2b, #580).
 *
 * ⚠️ UNVERIFIED LIVE. This file builds real TSL/THREE node graphs — there is
 * no Node test for it (CONVENTIONS.md §4: "Browser-only code... gets
 * verified live via a debug-panel report instead"), and this pass has no
 * live Foundry/WebGPU session to render a frame with. `player-vision-
 * modes.js`'s own gate/preset logic (what this file merely reads numbers
 * from) IS Node-tested — this file is the untested TSL half.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS HOOKS INTO `grade/grade-present.js`, NOT `vision-mask-render.js`
 * OR `environmental-light.js` DIRECTLY
 * ─────────────────────────────────────────────────────────────────────────
 *
 * This is a PERSONAL VIEWING-DEVICE FILTER over the final image — like real
 * night-vision goggles, it should see whatever the wearer's eyes would
 * already see (post fog-of-war, post bloom, post the author's own colour
 * grade) and re-render THAT, not add a new light or change what is revealed.
 * `grade-present.js` is the exact right seam for that: it is the LAST
 * fullscreen pass before the canvas (`scene.lit` → env grade → artistic
 * grade + tone map/LUT → Stylize → present), so hooking here means:
 *   - the vision gate (`vision-mask-render.js`) has ALREADY zeroed anything
 *     this viewer cannot see, so a grade added here can never leak fog —
 *     `0 * anything = 0` regardless of what this file does to it;
 *   - bloom has already run, so Night Vision's characteristic blown-out
 *     highlights come along for free from the SAME bloom every other
 *     bright light already gets, rather than a second, hand-rolled one;
 *   - it is STRUCTURALLY IDENTICAL to the Stylize effect's own hook
 *     (`grade-present.js#buildStylizeNode`/`currentStyle`): a compile-time
 *     branch selected by a JS string, rebuilt only when the mode actually
 *     changes, EXACTLY the precedent this build was told to go find and
 *     copy rather than hacking a one-off into the vision/lighting passes.
 *
 * NOT a registered effect (`effects/registry.js`) — see this file's sibling
 * `player-vision-modes.js`'s own header for why: the registry's cascade
 * (GM/profile/player-enable → one resolved value for the WHOLE table) has no
 * way to express "a DIFFERENT answer per viewing client", which is this
 * feature's entire point. `grade-present.js#setPlayerVisionMode` is instead
 * called directly, once per frame, from a plain closure `boot.js` injects
 * (mirrors `getPlayerCarriedLightSources`'s own non-registry shape) — the
 * SAME "declares data, a setter wires it, boot.js supplies the live value"
 * shape the dispatch asked to look for, just without the registry's own
 * enable/param cascade, which does not apply to a per-viewer fact.
 *
 * @module effects/vision/player-vision-grade-render
 */

import { VISION_MODE_PRESETS, PLAYER_VISION_GRADE_MODE_KEYS } from './player-vision-modes.js';

/** Rec.709 luminance weights — the SAME constant `grade-ops.js#LUMA` uses,
 * duplicated rather than imported: this file must stay usable with only
 * `THREE.TSL` (no other effect's module) the way every other TSL builder in
 * `effects/vision/` already does (`vision-mask-render.js` takes the same
 * "THREE passed in, nothing else imported" shape) — importing `grade-ops.js`
 * here for one constant would be a real, avoidable coupling for three
 * numbers everyone already agrees on. */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/**
 * Animated per-pixel grain — `hash(seed)` (three's own TSL builtin, already
 * used elsewhere in the vendored build) keyed off screen position AND time,
 * so it flickers rather than sitting static on-screen (a static noise
 * pattern would read as a texture, not sensor grain).
 * @param {*} TSL @param {*} uvNode @param {*} timeMs @param {number} speed
 * @returns {*} a scalar node, roughly -0.5..0.5.
 */
function buildGrainNode(TSL, uvNode, timeMs, speed) {
  const { hash, float } = TSL;
  const timeSeed = timeMs.mul(float(speed * 0.001));
  const seed = uvNode.x
    .mul(float(12.9898))
    .add(uvNode.y.mul(float(78.233)))
    .add(timeSeed);
  return hash(seed).sub(float(0.5));
}

/**
 * The 4-stop thermal false-colour ramp both infravision modes share —
 * cold→hot as purple→blue→orange→pale-yellow, a standard thermal-imaging
 * palette (not a from-scratch invention). `heat01` is the ALREADY-scaled
 * (by `contrastPower`) 0..1 proxy — see this module's header on why final
 * composited luminance is the proxy used, not a real per-object temperature
 * (this renderer has none).
 * @param {*} TSL @param {*} heat01 @param {ReadonlyArray<readonly number[]>} stops - 4 rgb triples.
 * @returns {*} vec3 node.
 */
function buildThermalRampNode(TSL, heat01, stops) {
  const { vec3, float, smoothstep, mix } = TSL;
  const c0 = vec3(...stops[0]);
  const c1 = vec3(...stops[1]);
  const c2 = vec3(...stops[2]);
  const c3 = vec3(...stops[3]);
  // Three mix stages across the four stops, each gated to its own third of
  // the range — the same "smoothstep between fixed stops" shape a manual
  // colour ramp always is, written out rather than a loop since there are
  // always exactly four stops here.
  const a = mix(c0, c1, smoothstep(float(0), float(0.33), heat01));
  const b = mix(a, c2, smoothstep(float(0.33), float(0.66), heat01));
  return mix(b, c3, smoothstep(float(0.66), float(1.0), heat01));
}

/** Night Vision — heavily green-monochrome, gained, grained, vignetted. */
function buildNightVisionNode(TSL, rgb, uvNode, timeMs) {
  const { vec2, vec3, float, dot, mix, clamp, distance } = TSL;
  const p = VISION_MODE_PRESETS.nightVision;
  const luma = dot(rgb, vec3(LUMA_R, LUMA_G, LUMA_B));
  const amplified = luma.mul(float(p.gain)).add(float(p.floorLift));
  const monochromeGreen = vec3(p.tintRgb[0], p.tintRgb[1], p.tintRgb[2]).mul(amplified);
  const gainedTrue = rgb.mul(float(p.gain)).add(float(p.floorLift));
  let out = mix(gainedTrue, monochromeGreen, float(p.tintMix01));
  if (p.grainAmount > 0) {
    out = out.add(buildGrainNode(TSL, uvNode, timeMs, p.grainSpeed).mul(float(p.grainAmount)));
  }
  if (p.vignetteStrength > 0) {
    // Distance from screen centre in uv space (0..~0.71 at the corners),
    // eased into a 0(centre)..1(edge) darkening factor past `vignetteRadius`
    // — the classic "eyepiece" edge softening.
    const radial = distance(uvNode, vec2(0.5, 0.5));
    const falloff = clamp(radial.sub(float(p.vignetteRadius)).mul(float(3)), float(0), float(1));
    const vignette = float(1).sub(falloff.mul(float(p.vignetteStrength)));
    out = out.mul(vignette);
  }
  return clamp(out, float(0), float(1));
}

/** Low-light Vision — gentle amplification, mild desaturation, near-neutral
 * tint, no grain/vignette (deliberately reads as "eyes adjusted", not NVG). */
function buildLowLightNode(TSL, rgb) {
  const { vec3, float, dot, mix } = TSL;
  const p = VISION_MODE_PRESETS.lowLight;
  const luma = dot(rgb, vec3(LUMA_R, LUMA_G, LUMA_B));
  const lifted = rgb.mul(float(p.gain)).add(float(p.floorLift));
  const desaturated = mix(lifted, vec3(luma.mul(float(p.gain)).add(float(p.floorLift))), float(p.desaturate01));
  const tinted = mix(desaturated, desaturated.mul(vec3(p.tintRgb[0], p.tintRgb[1], p.tintRgb[2])), float(p.tintMix01));
  return tinted.clamp(0, 1);
}

/** Infravision / Active Infravision — the shared thermal ramp, differing
 * only in `contrastPower` (sharpness) and the active sweep band. */
function buildInfravisionNode(TSL, rgb, uvNode, timeMs, presetKey) {
  const { vec3, float, dot, smoothstep, sin } = TSL;
  const p = VISION_MODE_PRESETS[presetKey];
  const luma = dot(rgb, vec3(LUMA_R, LUMA_G, LUMA_B));
  const heat01 = luma.mul(float(p.contrastPower)).clamp(0, 1);
  let out = buildThermalRampNode(TSL, heat01, p.rampStops);
  if (p.grainAmount > 0) {
    out = out.add(buildGrainNode(TSL, uvNode, timeMs, p.grainSpeed).mul(float(p.grainAmount)));
  }
  if (p.scanAmount > 0) {
    // A bright band that sweeps top→bottom and loops — `fract` isn't needed
    // since `sin` already loops; using sin keeps the sweep's own edges soft
    // rather than snapping at the wrap point a raw fract-based sawtooth would.
    const timeSec = timeMs.mul(float(0.001));
    const sweepY = sin(timeSec.mul(float(p.scanSpeedHz * Math.PI * 2)))
      .mul(float(0.5))
      .add(float(0.5));
    const dist = uvNode.y.sub(sweepY).abs();
    const band = smoothstep(float(p.scanBandWidth), float(0), dist).mul(float(p.scanBrightness));
    out = out.add(vec3(band, band, band));
  }
  return out.clamp(0, 1);
}

/**
 * Build the graded colour for ONE mode, or `null` for `'none'`/an
 * unrecognized mode — the SAME "null means skip the mix entirely" contract
 * `grade-present.js#buildStylizeNode` already uses, so the caller's own
 * `visionGraded ?? <upstream colour>` fallback needs no special-casing here.
 *
 * @param {object} args
 * @param {*} args.THREE - carries `.TSL`.
 * @param {*} args.rgb - vec3 linear-ish colour node, the fully composited
 *   (env grade + artistic grade + tone map/LUT + Stylize) upstream colour —
 *   see this module's header for why THIS point in the chain.
 * @param {*} args.uv - a vec2 TSL node, screen-space 0..1 (pass `THREE.TSL.uv()`).
 * @param {string} args.mode - one of `PLAYER_VISION_GRADE_MODE_KEYS`, or `'none'`.
 * @param {*} args.timeMs - a float TSL node/uniform, milliseconds — drives
 *   grain/scan animation. Any monotonic clock is fine; the caller decides
 *   which (see `grade-present.js#setPlayerVisionMode`'s own doc for which
 *   one this codebase's caller actually uses).
 * @returns {*|null} vec3 node, or `null`.
 */
export function buildPlayerVisionGradeNode({ THREE, rgb, uv, mode, timeMs }) {
  if (!PLAYER_VISION_GRADE_MODE_KEYS.includes(mode)) return null;
  const TSL = THREE.TSL;
  if (mode === 'nightVision') return buildNightVisionNode(TSL, rgb, uv, timeMs);
  if (mode === 'lowLight') return buildLowLightNode(TSL, rgb);
  if (mode === 'infravision' || mode === 'activeInfravision') {
    return buildInfravisionNode(TSL, rgb, uv, timeMs, mode);
  }
  return null;
}

export { PLAYER_VISION_GRADE_MODE_KEYS };
