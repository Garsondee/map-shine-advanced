/**
 * PLAYER VISION-MODE GRADE — the TSL node graph for the five looks
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
 * The hot-body mask's superellipse exponent: 2 = an ellipse inscribed in the
 * token's bounding box, →∞ = the bare box. 5 is a rounded rectangle — close
 * enough to the box that a square token's art is covered corner to corner,
 * smooth enough that the mask edge does not alias. See `buildTokenMaskNode`.
 */
const TOKEN_MASK_EXPONENT = 5;

/**
 * How many tokens the present material carries for the infravision hot-body
 * recolour. Fixed at shader-setup time and JS-unrolled (never a TSL `Loop`
 * over a `uniformArray` — see `buildTokenMaskNode`'s own header), so the
 * producer (`vt-pan-viewer.js#pushPlayerVisionTokens`) hands over at most this
 * many, nearest-to-the-anchor first. Eight covers every tabletop scene the
 * effect is meant for; a ninth body on screen simply does not glow.
 *
 * One slot is `(worldX, worldY, radiusX, radiusY)` — the token's own bounding
 * box, already in world pixels, because the recolour paints THE BOX THE TOKEN
 * OCCUPIES. An earlier `(x, y, radius, active)` shape could only ever draw a
 * disc, so a square token's recolour was permanently the wrong shape: either a
 * circle inside the art (corners untouched) or a circle larger than the art
 * (the "big soft blob" the 2026-10-15 live review rejected). `radiusX <= 0`
 * marks a slot unused, which `grade-present.js#setPlayerVisionTokens` writes
 * to every slot past this frame's count.
 */
export const PLAYER_VISION_TOKEN_SLOTS = 8;

/**
 * Animated per-pixel grain. The cell is hashed against a PER-FRAME RANDOM
 * offset rather than a fixed `(frame, frame·k)` step, so the field mutates in
 * place (flicker) instead of drifting in a consistent direction — the earlier
 * stepped form read as an obvious upward scroll after live review.
 * `density` < 1 keeps only a fraction of cells, giving sparse speckle instead
 * of a uniform noise field; the kept subset is re-rolled a few times a second
 * so it never reads as a fixed set of stuck pixels.
 * @param {*} TSL @param {*} uvNode @param {*} timeMs @param {number} speed
 * @param {number} [density=1] - fraction of pixels that carry grain, 0..1.
 * @returns {*} a scalar node, roughly -0.5..0.5.
 */
function buildGrainNode(TSL, uvNode, timeMs, speed, density = 1) {
  const { float, floor, vec2, screenSize, step } = TSL;
  const cell = floor(uvNode.mul(screenSize));
  const frame = floor(timeMs.mul(float(Math.max(0.1, speed) * 0.001)));
  // A random translation per frame (no coherent direction) = pure flicker.
  const jump = vec2(hash12(TSL, vec2(frame, float(11.7))), hash12(TSL, vec2(float(53.1), frame)));
  const value = hash12(TSL, cell.add(jump.mul(float(311.7)))).sub(float(0.5));
  if (!(density < 1)) return value;
  const selectorFrame = floor(timeMs.mul(float(0.001)).mul(float(7)));
  const selector = hash12(TSL, cell.add(vec2(float(91.3), selectorFrame)));
  return value.mul(step(float(1).sub(float(density)), selector));
}

/**
 * The 4-stop thermal false-colour ramp both infravision modes share —
 * cold→hot, the standard thermal-imaging progression, with ONE deliberate
 * departure from the textbook palette: the cold end is a NEUTRAL grey with
 * only the faintest cool cast, not the saturated purple/blue-violet real
 * thermal imagers use.
 *
 * That is a live-review change (2026-10-15), not a taste call. The shipped
 * palette's cool stops were near-black blue-violet, and the author's verdict on
 * a real scene was blunt: "the purple colour is a problem too. It's far far too
 * strong and obscures things." Two things had to change to fix it — the cool
 * stops stop being violet (`rampStops` below), AND the ramp stops being used as
 * the image's LEVEL at all: see `thermalHueAtLuminance`, which reads this
 * palette purely as a hue source and takes the brightness from the scene.
 *
 * `heat01` is the ALREADY-scaled (by `contrastPower`) 0..1 proxy — see this
 * module's header on why final composited luminance is the proxy used, not a
 * real per-object temperature (this renderer has none).
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

/**
 * THE THERMAL PALETTE AS A HUE SOURCE, NEVER AS A LEVEL — the palette colour
 * for `heat01`, re-scaled to exactly `luma`.
 *
 * This one function is the fix for the whole 2026-10-15 live review ("the scene
 * isn't brightened it's being obscured and made harder to see things in the
 * dark"). The first build REPLACED each pixel's colour with a ramp stop, so a
 * dim pixel's brightness came from whichever stop its heat landed on — near
 * black at the cool end — and every bit of the scene's own contrast was thrown
 * away with it. Dividing the palette by its own luminance and multiplying by
 * the scene's means the recolour is PURELY CHROMATIC: structure, detail,
 * legibility and relative brightness survive it exactly, so a recolour can
 * never obscure what the viewer could already see, no matter how strong the
 * palette tint is. A black pixel stays black for free (0 × anything = 0), which
 * is also what keeps fog-of-war out of the ramp's new, much brighter cool end.
 *
 * @param {*} TSL @param {*} heat01 @param {ReadonlyArray<readonly number[]>} stops - 4 rgb triples.
 * @param {*} luma - the display-encoded luminance the result must carry.
 * @returns {*} vec3 node whose luminance IS `luma`.
 */
function thermalHueAtLuminance(TSL, heat01, stops, luma) {
  const { vec3, float, dot, max } = TSL;
  const hue = buildThermalRampNode(TSL, heat01, stops);
  const hueLuma = max(dot(hue, vec3(LUMA_R, LUMA_G, LUMA_B)), float(1e-4));
  return hue.mul(luma.div(hueLuma));
}

/** The display gamma this chain's linear colour is encoded with on its way to the
 * canvas. V2's night vision ran on its gamma-encoded display buffer, so its tuned
 * gain/gamma/maxLuma only mean what they meant when applied to encoded values:
 * encode, apply them, decode. (Applied to linear values they are far too weak,
 * which is what the first version of this grade did.) */
const DISPLAY_GAMMA = 2.2;

function encodeDisplay(TSL, linear) {
  const { vec3, float, pow, max } = TSL;
  return pow(max(linear, vec3(0, 0, 0)), float(1 / DISPLAY_GAMMA));
}

function decodeDisplay(TSL, encoded) {
  const { vec3, float, pow, max } = TSL;
  return pow(max(encoded, vec3(0, 0, 0)), float(DISPLAY_GAMMA));
}

/** Softly compress only the adapted-eye grade's overshoot. Night Vision keeps
 * V2's direct, saturated tube output rather than adding this shoulder. */
function softShoulder(TSL, encoded, knee = 0.8) {
  const { float, min, max, exp } = TSL;
  const room = 1 - knee;
  const over = max(encoded.sub(float(knee)), float(0));
  return min(encoded, float(knee)).add(
    float(1)
      .sub(exp(over.negate().div(float(room))))
      .mul(float(room))
  );
}

/** Stateless per-cell noise in 0..1 (the classic sin-dot hash; V2's `hash12`). */
function hash12(TSL, p) {
  const { float, vec3, dot, fract } = TSL;
  let p3 = fract(vec3(p.x, p.y, p.x).mul(float(0.1031)));
  p3 = p3.add(dot(p3, vec3(p3.y, p3.z, p3.x).add(float(33.33))));
  return fract(p3.x.add(p3.y).mul(p3.z));
}

/** 0 in true black, 1 once a pixel is genuinely lit. Fog of war and unlit void are
 * exactly black upstream; an amplifier must leave them black (a 1e-4 dither
 * multiplied by a gain of thousands is a green flicker over the unexplored). */
function presenceOf(TSL, Y) {
  const { float, smoothstep } = TSL;
  return smoothstep(float(0.002), float(0.02), Y);
}

/** Token-centered, token-world-space NV/light-adaptation field. Radius and
 * softness use token widths, so zoom changes the screen footprint, not map reach. */
function buildVisionFalloff(TSL, uvNode, preset, visionCenter, visionWorldSize, visionTokenSize) {
  const { vec2, float, max, min, length, smoothstep } = TSL;
  const center = visionCenter ?? vec2(0.5, 0.5);
  const screenSize = TSL.screenSize;
  const screenDelta = uvNode
    .sub(center)
    .mul(screenSize)
    .div(max(min(screenSize.x, screenSize.y), float(1)));
  const worldDelta = uvNode.sub(center).mul(visionWorldSize ?? vec2(1, 1));
  const fallbackTokenSize = max(min(screenSize.x, screenSize.y).div(float(20)), float(1));
  const tokenSize = visionTokenSize ?? fallbackTokenSize;
  const tokenDelta =
    visionWorldSize && visionTokenSize ? worldDelta.div(max(tokenSize, float(1))) : screenDelta.mul(float(20));
  const d = length(tokenDelta);
  const mask = (distance) =>
    float(1).sub(
      smoothstep(
        float(preset.eyepieceRadius - preset.eyepieceSoftness),
        float(preset.eyepieceRadius + preset.eyepieceSoftness),
        distance
      )
    );
  let open = mask(d);
  if (preset.eyepieceStyle === 'binocular') {
    const separation = float(preset.eyepieceSeparation ?? 0.26);
    const left = length(tokenDelta.sub(vec2(separation.negate(), float(0))));
    const right = length(tokenDelta.sub(vec2(separation, float(0))));
    open = max(mask(left), mask(right));
  }
  return open;
}

/**
 * THE PURKINJE SHIFT — the scotopic (rod) colouration BOTH low-light modes
 * share, applied only where the wearer is actually relying on rods (`dark` is
 * 1 in deep shadow and falls to 0 by `shadowKnee`).
 *
 * In mesopic/twilight light rods take over from cones and the eye's peak
 * sensitivity moves from ~555 nm (photopic, yellow-green) to ~507 nm
 * (scotopic, blue-green). The visible consequence — the one the author asked
 * for by name — is that blues and greens read RELATIVELY brighter while reds
 * go very dark (the classic "a red rose is black at dusk"). This is the whole
 * colouration mechanism for the low-light modes; it replaces the old mild
 * `mix(col, col*cool, ...)` tint, which was a hue nudge rather than a real
 * sensitivity change.
 *
 * Two moves, matching what the eye actually does, in this order:
 *   1. a per-channel rod GAIN (`rodGainRgb`) — red multiplied down, blue and
 *      green left alone or lifted slightly;
 *   2. desaturation toward a ROD-WEIGHTED grey (`rodLumaRgb`, blue-green
 *      heavy) instead of the ordinary photopic luminance, which is what makes
 *      a saturated red drain toward near-black rather than toward its own
 *      (photopically brighter) grey.
 *
 * Pure black stays pure black under both moves, so no extra `presence` gate is
 * needed here.
 *
 * @param {*} TSL @param {*} col - the vec3 to recolour.
 * @param {*} dark - 0..1 "how rod-dominated is this pixel" node.
 * @param {object} preset - a `VISION_MODE_PRESETS` low-light entry.
 * @returns {*} vec3 node.
 */
function buildPurkinjeNode(TSL, col, dark, preset) {
  const { vec3, float, dot, mix } = TSL;
  const amount = dark.mul(float(preset.purkinjeStrength));
  // 1 — rod gain: reds down, blue/green up.
  const gained = col.mul(mix(vec3(1, 1, 1), vec3(...preset.rodGainRgb), amount));
  // 2 — drain chroma toward a rod-weighted grey, so red leaves the image
  //     fastest and blue/green hold on longest.
  const rodGrey = dot(gained, vec3(...preset.rodLumaRgb));
  return mix(gained, vec3(rodGrey, rodGrey, rodGrey), amount.mul(float(preset.purkinjeDesaturation)));
}

/**
 * HOT-BODY TOKEN FOOTPRINT MASK — unique to the two thermal (infravision)
 * modes. Returns 1 for every screen pixel sitting over a visible token's own
 * bounding box, and 0 elsewhere, so the caller can recolour exactly the token's
 * pixels and nothing around them.
 *
 * WHAT CHANGED AND WHY (2026-10-15 live review: "Your illumination of tokens is
 * to put a light on them but this washes them out badly. Instead of placing a
 * 'light' over tokens maybe mutate the colours of the token"). This was
 * `buildTokenGlowNode`, which painted a soft RADIAL glow — a full-strength
 * disc out to 55-60% of the radius with a long tail to 115-120% — at the TOP of
 * the ramp (heat 0.78→1.0, i.e. near-white). Over a real token that read as a
 * flat orange LIGHT sitting on the art, wiping out its detail, and its circular
 * footprint hung off the corners of a square token. The mask is now the token's
 * own shape (a superellipse over the box's half-extents — a rounded rectangle,
 * see `TOKEN_MASK_EXPONENT`), stays at ONE strength across the whole footprint,
 * and is used only to blend a hue-shifted version of the token's OWN pixels
 * (`thermalHueAtLuminance`), never a colour of its own.
 *
 * `slots` is a fixed, JS-unrolled list of `vec4` nodes — `(worldX, worldY,
 * radiusX, radiusY)`, the token's own bounding box in world pixels, one per
 * visible token, nearest-first, capped at `PLAYER_VISION_TOKEN_SLOTS` — NOT a
 * TSL `Loop` over a `uniformArray`. That construct is live-confirmed broken on
 * this renderer (`point-light-illumination.js`'s own `edgeSoftFactor` note, and
 * `point-light-batching-design.md`'s Finding B); unrolled straight-line
 * arithmetic is the proven-safe shape every other many-input node in this
 * codebase uses.
 *
 * The result is a `presence`-gated colour, never a reveal: it only ever
 * repaints pixels the viewer can already see (Law 7 — see `player-vision-
 * modes.js#resolveActivePlayerVisionPreset`'s caller and this module's own
 * header on why the grade runs strictly after the vision mask).
 *
 * @param {*} TSL @param {*} uvNode - screen UV.
 * @param {*} viewRect - vec4 `(minX, minY, maxX, maxY)` world rect of the view.
 * @param {ReadonlyArray<*>} slots - `PLAYER_VISION_TOKEN_SLOTS` vec4 nodes.
 * @param {object} preset - a `VISION_MODE_PRESETS` infravision entry.
 * @returns {*|null} a 0..1 node, or null when the preset has the effect off /
 *   no slots exist.
 */
function buildTokenMaskNode(TSL, uvNode, viewRect, slots, preset) {
  if (!slots?.length || !(preset.tokenStrength > 0)) return null;
  const { vec2, float, abs, max, pow, smoothstep, step } = TSL;
  const spanX = viewRect.z.sub(viewRect.x);
  const spanY = viewRect.w.sub(viewRect.y);
  const pixelWorld = vec2(viewRect.x.add(uvNode.x.mul(spanX)), viewRect.y.add(uvNode.y.mul(spanY)));
  const scale = float(Math.max(preset.tokenScale, 1));
  // One soft edge band, as a FRACTION of the (scaled) half-extent, so a big
  // token feathers by more world pixels than a small one without a second knob.
  const inner = float(1).sub(float(Math.min(Math.max(preset.tokenFeather01, 0.01), 0.9)));
  let mask = null;
  for (const slot of slots) {
    // `radiusX <= 0` is an unused slot (see PLAYER_VISION_TOKEN_SLOTS). The
    // floor keeps the divisions finite for it (a 1 px token is impossible) and
    // the `step` gate zeroes its contribution regardless of where the world
    // origin happens to be.
    const radiusX = max(slot.z, float(1)).mul(scale);
    const radiusY = max(slot.w, float(1)).mul(scale);
    const dx = abs(pixelWorld.x.sub(slot.x)).div(radiusX);
    const dy = abs(pixelWorld.y.sub(slot.y)).div(radiusY);
    // Superellipse distance: exponent 2 is an ellipse, →∞ is the bare box.
    // `TOKEN_MASK_EXPONENT` (5) is visually a rounded rectangle — it hugs a
    // square token's corners (an inscribed ellipse would leave ~21% of the art
    // un-recoloured) while staying smooth enough not to alias on the edge.
    const d = pow(
      pow(dx, float(TOKEN_MASK_EXPONENT)).add(pow(dy, float(TOKEN_MASK_EXPONENT))),
      float(1 / TOKEN_MASK_EXPONENT)
    );
    const slotMask = float(1)
      .sub(smoothstep(inner, float(1), d))
      .mul(step(float(0.5), slot.z));
    mask = mask ? max(mask, slotMask) : slotMask;
  }
  return mask;
}

/** Night Vision — V2's image-intensifier goggles, see `VISION_MODE_PRESETS.nightVision`.
 * The injected sampler re-evaluates the existing grade at refracted UVs, which
 * lets this late pass reproduce V2's barrel distortion and RGB edge separation. */
function buildNightVisionNode(
  TSL,
  rgb,
  uvNode,
  timeMs,
  darkness01,
  sampleRgbAt,
  modePower,
  visionCenter,
  visionWorldSize,
  visionTokenSize
) {
  const {
    vec2,
    vec3,
    float,
    dot,
    mix,
    clamp,
    max,
    min,
    pow,
    log2,
    smoothstep,
    sin,
    abs,
    fract,
    floor,
    length,
    screenSize,
  } = TSL;
  const p = VISION_MODE_PRESETS.nightVision;
  const lum = vec3(LUMA_R, LUMA_G, LUMA_B);
  const sample = (at) => (sampleRgbAt ? sampleRgbAt(clamp(at, vec2(0, 0), vec2(1, 1))) : rgb);
  const baseLinear = rgb;
  const base = encodeDisplay(TSL, baseLinear);

  // V2's radial barrel distortion and edge-weighted RGB channel separation.
  // Sampling is injected by grade-present so the optical warp sees the same
  // fully graded image, not the raw scene-lit texture.
  const opticalCenter = vec2(0.5, 0.5);
  const open = buildVisionFalloff(TSL, uvNode, p, visionCenter, visionWorldSize, visionTokenSize);
  const edgeNoiseBoost = float(1).add(float(p.noiseEdgeBoost).mul(float(1).sub(open)));
  const radial = uvNode.sub(opticalCenter);
  const distUv = opticalCenter.add(radial.mul(float(1).add(dot(radial, radial).mul(float(p.distortionAmount)))));
  const sourceUv = clamp(distUv, vec2(0, 0), vec2(1, 1));
  const caRadius = length(sourceUv.sub(opticalCenter));
  const caDirection = sourceUv.sub(opticalCenter).div(max(caRadius, float(1e-5)));
  const caEdge = pow(clamp(caRadius.mul(float(1.9)), float(0), float(1)), float(p.chromaticAberrationEdgePower));
  const caDelta = caDirection.mul(float(p.chromaticAberrationPx).mul(caEdge)).div(max(screenSize, vec2(1, 1)));
  const red = sample(clamp(sourceUv.add(caDelta), vec2(0, 0), vec2(1, 1))).r;
  const green = sample(sourceUv).g;
  const blue = sample(clamp(sourceUv.sub(caDelta), vec2(0, 0), vec2(1, 1))).b;
  let preGain = vec3(red, green, blue);
  // Preserve the unwarped pixel at a hard-black visibility edge. Without this
  // guard a neighboring explored pixel can be refracted into fog-of-war.
  const sampledY = dot(encodeDisplay(TSL, preGain), lum);
  preGain = mix(baseLinear, preGain, presenceOf(TSL, sampledY));
  const preDisplay = encodeDisplay(TSL, preGain);

  // V2's intensity amplifier: gamma-curved gain with a luminance cap, never
  // darkening its input. Inputs are in display-encoded space in both versions.
  const Y = max(dot(preDisplay, lum), float(1e-5));
  const amp = min(float(p.gain).mul(pow(Y.add(float(p.darkLift)), float(1 / p.gamma))), float(p.maxLuma));
  const present = presenceOf(TSL, dot(base, lum));
  const scale = mix(float(1), max(float(1), amp.div(Y)), presenceOf(TSL, Y));
  let col = preDisplay.mul(scale);

  // V2's Purkinje rod/cone crossover. Its shipped Night Vision strength is 0;
  // the data remains here so the same shader can support tuned profiles later.
  const preY = max(dot(col, lum), float(1e-6));
  const darkStart = float(p.purkinjeDarkStart);
  const brightEnd = max(float(p.purkinjeBrightEnd), darkStart.add(float(1e-5)));
  const coneMix = pow(smoothstep(darkStart, brightEnd, preY), float(p.purkinjeCurve));
  const postY = max(dot(col, lum), float(1e-6));
  const ampRatio = clamp(postY.div(preY), float(1), float(64));
  const ampDesat = clamp(log2(ampRatio).div(float(4)), float(0), float(1));
  const colorRetention = coneMix.mul(float(1).sub(ampDesat.mul(float(0.85))));
  const sat = mix(float(p.saturation), float(p.saturation).mul(colorRetention), float(p.purkinjeStrength));
  const gray = dot(col, lum);
  col = mix(vec3(gray, gray, gray), col, sat);
  const tint = vec3(Math.max(p.tintRgb[0], 0.001), Math.max(p.tintRgb[1], 0.001), Math.max(p.tintRgb[2], 0.001));
  col = mix(col, col.mul(tint), float(p.tintStrength));
  col = col.mul(float(p.brightness));

  // V2's separate burn-map contributes a soft, blurred highlight halo here.
  // This late grade cannot own the compositor's ping-pong history targets, so
  // reproduce its spatial threshold/blur/response in four taps; the normal
  // scene bloom remains upstream as an additional, broader glow.
  if (p.bloomEnabled && sampleRgbAt && p.bloomIntensity > 0) {
    const blur = float(p.bloomBlurPx).div(max(screenSize, vec2(1, 1)));
    const bloomAt = (at) => {
      const source = sample(at);
      const sourceLuma = dot(source, lum);
      const gate = smoothstep(
        float(p.bloomThreshold - p.bloomThresholdSoftness),
        float(p.bloomThreshold + p.bloomThresholdSoftness),
        sourceLuma
      );
      return source.mul(gate).mul(float(p.bloomResponse));
    };
    const bloom = bloomAt(uvNode.add(vec2(blur.x, 0)))
      .add(bloomAt(uvNode.sub(vec2(blur.x, 0))))
      .add(bloomAt(uvNode.add(vec2(0, blur.y))))
      .add(bloomAt(uvNode.sub(vec2(0, blur.y))))
      .mul(float(p.bloomIntensity * 0.25));
    col = col.add(bloom);
  }

  const timeSec = timeMs.mul(float(0.001));

  // Scanlines.
  const wave = sin(uvNode.y.mul(float(p.scanDensity)).add(timeSec.mul(float(p.scanSpeed))));
  const line = pow(abs(wave), mix(float(4), float(1), float(p.scanThickness)));
  col = col.mul(clamp(float(1).sub(float(p.scanIntensity).mul(line).mul(float(0.85))), float(0.15), float(1)));

  // Sensor noise, stronger in the dark. Two scales, each an in-place flicker
  // (see buildGrainNode) rather than a directional drift.
  const Y2 = dot(col, lum);
  const n1 = buildGrainNode(TSL, uvNode.mul(float(p.noiseScale)), timeMs, p.noiseSpeed);
  const n2 = buildGrainNode(TSL, uvNode.mul(float(p.noiseScale * 0.5)), timeMs, p.noiseSpeed * 1.8);
  const darkBoost = mix(
    float(1),
    float(1 + p.noiseLowLightBoost),
    float(1).sub(clamp(Y2.mul(float(2)), float(0), float(1)))
  );
  const flick = n1.add(n2);
  col = col.add(
    vec3(flick, flick, flick)
      .mul(float(p.noiseAmount * 0.35))
      .mul(darkBoost)
      .mul(edgeNoiseBoost)
      .mul(present)
  );

  // Phosphor shimmer: a slow whole-image pulse plus per-cell sparkle.
  const pulse = sin(timeSec.mul(float(p.phosphorFlickerSpeed * 6.2832)))
    .mul(float(0.5))
    .add(float(0.5));
  col = col.mul(
    max(float(0.15), float(1).sub(float(p.phosphorFlickerAmount).mul(float(0.35).add(pulse.mul(float(0.65))))))
  );
  const phosphorLuma = clamp(dot(col, lum), float(0), float(Math.max(p.maxLuma, 1)));
  const phosphorPresence = smoothstep(float(0.05), float(0.9), phosphorLuma);
  const cell = floor(uvNode.mul(screenSize).mul(float(p.phosphorSize)));
  const ph = hash12(TSL, cell.add(fract(timeSec.mul(float(11 + p.phosphorFlickerSpeed * 37)))));
  const gate = smoothstep(float(0), float(Math.min(1, p.phosphorDensity)), ph);
  const spark = ph.mul(float(2)).sub(float(1)).mul(gate);
  const sparkAmp = float(p.phosphorFlickerAmount * p.phosphorIntensity)
    .mul(float(0.02).add(phosphorPresence.mul(float(0.06))))
    .mul(edgeNoiseBoost);
  col = col.add(vec3(spark, spark, spark).mul(sparkAmp).mul(phosphorPresence).mul(present));

  // Never darker than what the eye already saw (V2's baseCol safety).
  col = max(col, base);

  const edge = vec3(...p.eyepieceColor);

  // Scene darkness plus the V2 warm-up/shutdown power envelope. The source
  // visibility gate is retained so optics/artifacts never reveal black fog.
  const darknessPower = smoothstep(float(p.darknessGateStart), float(p.darknessGateEnd), darkness01);
  const devicePower = darknessPower.mul(modePower ?? float(1));
  // First blend the enhanced image against the original. Applying the eyepiece
  // after this blend is essential: doing it before the baseCol safety mix makes
  // that later mix restore the unfiltered image over the black surround.
  const filtered = mix(base, max(col, base), devicePower.mul(present));
  const eyeAmount = devicePower.mul(float(p.eyepieceIntensity));
  const eyeOpen = mix(float(1), open, eyeAmount);
  let output = mix(edge, filtered, eyeOpen);
  // Bright light survives outside the personal vision radius. Otherwise the
  // circular black vignette would erase the very lamp/torch that should remain
  // visible beyond the viewer's token-centered night-vision reach.
  const litOutside = smoothstep(float(p.lightRevealStart), float(p.lightRevealEnd), dot(base, lum)).mul(
    float(1).sub(open)
  );
  output = mix(output, base, litOutside);
  return decodeDisplay(TSL, max(output, vec3(0, 0, 0)));
}

/** Passive or active scotopic vision, with the same token-centered radius as NV. */
function buildLowLightNode(
  TSL,
  rgb,
  uvNode,
  timeMs,
  darkness01,
  presetKey,
  visionCenter,
  visionWorldSize,
  visionTokenSize
) {
  const { vec3, float, dot, mix, max, smoothstep } = TSL;
  const p = VISION_MODE_PRESETS[presetKey];
  const lum = vec3(LUMA_R, LUMA_G, LUMA_B);
  const base = encodeDisplay(TSL, rgb);
  const Y = dot(base, lum);
  // 1 in deep shadow, fading to 0 by `shadowKnee`: the lift lands on shadows only.
  const dark = float(1).sub(smoothstep(float(0), float(p.shadowKnee), Y));
  const present = presenceOf(TSL, Y);
  const lift = float(1).add(float(p.shadowGain).mul(dark));
  let col = base.mul(lift).add(vec3(1, 1, 1).mul(float(p.darkLift)).mul(dark).mul(present));
  // SATURATION, 2026-10-15 (author: "make saturation much lower" for Low
  // Light; "less saturation but not as low as plain Low Light" for Active):
  // lit pixels keep `baseSaturation`, deep shadow drains to `darkSaturation`,
  // and the knee is the same `dark²` curve the lift uses so the two agree
  // about where "shadow" is.
  const gray = dot(col, lum);
  const sat = mix(float(p.baseSaturation), float(p.darkSaturation), dark.mul(dark));
  col = mix(vec3(gray, gray, gray), col, sat);
  // THE PURKINJE SHIFT replaces the old mild cool tint — it is a real rod
  // sensitivity change, not a hue nudge. See `buildPurkinjeNode`.
  col = buildPurkinjeNode(TSL, col, dark, p);
  if (p.noiseAmount > 0) {
    const noise = buildGrainNode(TSL, uvNode, timeMs, p.noiseSpeed, p.noiseDensity ?? 1);
    const lowLightBoost = float(1).add(dark.mul(float(p.noiseLowLightBoost)));
    col = col.add(vec3(noise, noise, noise).mul(float(p.noiseAmount)).mul(lowLightBoost).mul(present));
  }
  const darknessPower = smoothstep(float(p.darknessGateStart), float(p.darknessGateEnd), darkness01);
  const filtered = mix(base, max(col, base), darknessPower.mul(present));
  const open = buildVisionFalloff(TSL, uvNode, p, visionCenter, visionWorldSize, visionTokenSize);
  const eyeOpen = mix(float(1), open, darknessPower);
  let output = mix(vec3(0, 0, 0), filtered, eyeOpen);
  const litOutside = smoothstep(float(p.lightRevealStart), float(p.lightRevealEnd), Y).mul(float(1).sub(open));
  output = mix(output, base, litOutside);
  return decodeDisplay(TSL, softShoulder(TSL, output));
}

/** Infravision / Active Infravision — a brightness-preserving thermal
 * recolour plus the two things that make it a real sensing mode rather than a
 * flat tint: hot bodies (`buildTokenMaskNode` + `thermalHueAtLuminance`) and a
 * token-centered range identical to the amplification modes' (see
 * `buildVisionFalloff`).
 *
 * 2026-10-15, after live review — what this node does NOT do any more:
 *   - it never uses a ramp stop as a pixel's LEVEL. `thermalHueAtLuminance`
 *     gives every pixel the palette's HUE at the brightness it already had, so
 *     the mode is chromatically strong and photometrically incapable of
 *     obscuring anything (see that function's own header);
 *   - it never leaves a token as a coloured blob: the hot-body path is a colour
 *     mutation of the token's own pixels inside its own footprint, not a light
 *     painted over it.
 * The shadow lift below is the same shape both low-light modes use, applied at
 * a higher gain — "the scene isn't brightened" was a direct complaint. */
function buildInfravisionNode(
  TSL,
  rgb,
  uvNode,
  timeMs,
  presetKey,
  darkness01,
  visionCenter,
  visionWorldSize,
  visionTokenSize,
  viewRect,
  tokenSlots
) {
  const { vec3, float, dot, smoothstep, fract, abs, clamp, mix, max, pow } = TSL;
  const p = VISION_MODE_PRESETS[presetKey];
  const lum = vec3(LUMA_R, LUMA_G, LUMA_B);
  const base = encodeDisplay(TSL, rgb);
  // Display-referred luminance, because linear night luminance clusters near
  // zero and would collapse the whole palette into its coldest stop.
  const baseLuma = dot(base, lum);
  const presence = presenceOf(TSL, baseLuma);
  // 1 — BRIGHTEN. 1 in deep shadow, fading to 0 by `shadowKnee`: the lift
  //     lands on shadows only, so a lit pixel keeps the brightness it had and
  //     the mode can never darken the map.
  const dark = float(1).sub(smoothstep(float(0), float(p.shadowKnee), baseLuma));
  const lumaLifted = baseLuma
    .mul(float(1).add(float(p.shadowGain).mul(dark)))
    .add(float(p.darkLift).mul(dark).mul(presence));
  const heat01 = pow(clamp(lumaLifted.mul(float(p.thermalGain)), float(0), float(1)), float(p.thermalGamma))
    .mul(float(p.contrastPower))
    .clamp(0, 1);
  // 2 — RECOLOUR, keeping the scene's own structure (see
  //     `thermalHueAtLuminance`): `lifted` is the brightened original with its
  //     own hue, `tinted` is the same brightened luminance under the thermal
  //     palette's hue. Both carry `lumaLifted` exactly, so `tintStrength` —
  //     however high a mode pushes it — can only change COLOUR.
  const lifted = base.mul(lumaLifted.div(max(baseLuma, float(1e-4))));
  const tinted = thermalHueAtLuminance(TSL, heat01, p.rampStops, lumaLifted);
  let out = mix(lifted, tinted, float(p.tintStrength));
  // 3 — HOT BODIES (unique to the thermal modes). A body radiates: its own
  //     darkest pixels still read as a warm emitter (`tokenLumaFloor`), its lit
  //     pixels read hotter (`tokenHeatFromLuma`), and the whole footprint is
  //     brightened (`tokenGain`) — all through the SAME hue transfer, so every
  //     fold and highlight of the art survives the recolour.
  const mask = buildTokenMaskNode(TSL, uvNode, viewRect, tokenSlots, p);
  if (mask) {
    const bodyLuma = max(lumaLifted, float(p.tokenLumaFloor)).mul(float(p.tokenGain));
    const bodyHeat = clamp(float(p.tokenHeat).add(lumaLifted.mul(float(p.tokenHeatFromLuma))), float(0), float(1));
    const body = thermalHueAtLuminance(TSL, bodyHeat, p.rampStops, bodyLuma);
    out = mix(out, max(body, out), mask.mul(float(p.tokenStrength)));
  }
  if (p.grainAmount > 0) {
    out = out.add(buildGrainNode(TSL, uvNode, timeMs, p.grainSpeed).mul(float(p.grainAmount)));
  }
  if (p.scanAmount > 0) {
    // One-way top-to-bottom pass. The previous sine path reversed direction
    // twice per cycle and the reversed-edge smoothstep was undefined in WGSL,
    // which produced the bright wobbling white bar seen in live testing.
    const timeSec = timeMs.mul(float(0.001));
    const sweepY = fract(timeSec.mul(float(p.scanSpeedHz)));
    const dist = abs(uvNode.y.sub(sweepY));
    const band = float(1)
      .sub(smoothstep(float(0), float(p.scanBandWidth), dist))
      .mul(float(p.scanBrightness));
    out = out.add(vec3(0.18, 0.28, 0.48).mul(band));
  }
  // Fog and unlit void are exactly black upstream and stay black: the hue
  // transfer is proportional to luminance, so a black pixel is black before
  // this gate, and the gate then holds back the dim fringe a lift would
  // otherwise grey up (z of the explored map, and the fog border).
  const graded = mix(vec3(0, 0, 0), out.clamp(0, 1), presence);
  // THE TOKEN-CENTERED RANGE (2026-10-15, author's ask: "operate with a
  // similar 'range' to NVG which drops off around the token in a very smooth
  // long dropoff, but which doesn't cover up lights which are further away").
  // EXACTLY the falloff + bright-source reveal the amplification modes use —
  // same `buildVisionFalloff`, same `lightReveal` restore — so all five modes
  // now share one range geometry and only differ in what they paint inside it.
  const darknessPower = smoothstep(float(p.darknessGateStart), float(p.darknessGateEnd), darkness01);
  const open = buildVisionFalloff(TSL, uvNode, p, visionCenter, visionWorldSize, visionTokenSize);
  const eyeOpen = mix(float(1), open, darknessPower);
  let output = mix(vec3(0, 0, 0), graded, eyeOpen);
  const litOutside = smoothstep(float(p.lightRevealStart), float(p.lightRevealEnd), baseLuma).mul(float(1).sub(open));
  output = mix(output, base, litOutside);
  // BACK TO LINEAR, like `buildNightVisionNode`/`buildLowLightNode` both do —
  // everything above this line (the palette, the lift, `presence`) is
  // display-referred, and every number in these presets is a DISPLAY value
  // ("the coldest stop is a visible grey" means a visible grey on screen).
  // The infravision node was the one builder that skipped this, so its output
  // was encoded twice on the way to the canvas: that squashes the top of the
  // range and lifts shadows far too hard, which is exactly the flat pale haze
  // the 2026-10-15 live review would have been looking at.
  return decodeDisplay(TSL, output);
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
 * @param {(uv:*) => *} [args.sampleRgbAt] - rebuild the pre-vision graded image at a screen UV;
 *   used for V2's distortion, chromatic aberration and local highlight halo.
 * @param {string} args.mode - one of `PLAYER_VISION_GRADE_MODE_KEYS`, or `'none'`.
 * @param {*} [args.darkness01] - a float TSL node/uniform, the scene's darkness 0..1, which gates Night
 *   Vision and Low-light (they fade in as the scene darkens). Omitted means fully dark: always on.
 * @param {*} args.timeMs - a float TSL node/uniform, milliseconds — drives
 *   grain/scan animation. Any monotonic clock is fine; the caller decides
 *   which (see `grade-present.js#setPlayerVisionMode`'s own doc for which
 *   one this codebase's caller actually uses).
 * @param {*} [args.modePower] - the warm-up/shutdown power envelope for Night Vision.
 * @param {*} [args.visionCenter] - screen-UV center for the token-centered eyepiece falloff.
 * @param {*} [args.visionWorldSize] - visible world width/height in map pixels.
 * @param {*} [args.visionTokenSize] - selected token diameter in map pixels.
 * @param {*} [args.viewRect] - vec4 `(minX, minY, maxX, maxY)` world rect of the
 *   view, used by the infravision hot-body token mask to place token world
 *   positions on screen (`buildTokenMaskNode`).
 * @param {ReadonlyArray<*>} [args.tokenSlots] - `(worldX, worldY, radiusX,
 *   radiusY)` vec4 nodes, one per visible token's own bounding box; see
 *   `PLAYER_VISION_TOKEN_SLOTS`.
 * @returns {*|null} vec3 node, or `null`.
 */
export function buildPlayerVisionGradeNode({
  THREE,
  rgb,
  uv,
  mode,
  timeMs,
  darkness01,
  sampleRgbAt,
  modePower,
  visionCenter,
  visionWorldSize,
  visionTokenSize,
  viewRect,
  tokenSlots,
}) {
  if (!PLAYER_VISION_GRADE_MODE_KEYS.includes(mode)) return null;
  const TSL = THREE.TSL;
  const darkness = darkness01 ?? TSL.float(1);
  if (mode === 'nightVision')
    return buildNightVisionNode(
      TSL,
      rgb,
      uv,
      timeMs,
      darkness,
      sampleRgbAt,
      modePower,
      visionCenter,
      visionWorldSize,
      visionTokenSize
    );
  if (mode === 'lowLight' || mode === 'activeLowLight')
    return buildLowLightNode(TSL, rgb, uv, timeMs, darkness, mode, visionCenter, visionWorldSize, visionTokenSize);
  if (mode === 'infravision' || mode === 'activeInfravision') {
    return buildInfravisionNode(
      TSL,
      rgb,
      uv,
      timeMs,
      mode,
      darkness,
      visionCenter,
      visionWorldSize,
      visionTokenSize,
      viewRect,
      tokenSlots
    );
  }
  return null;
}

export { PLAYER_VISION_GRADE_MODE_KEYS };
