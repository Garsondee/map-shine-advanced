/**
 * @fileoverview vt/albedo-clarity.js — the CAS (Contrast Adaptive Sharpening)
 * repair for minified art, split out of vt-pan-viewer.js (2026-08-15) so the
 * shader lab can import the real node-building functions directly. The rest
 * of that file pulls in Foundry-specific machinery transitively
 * (`foundry/index.js`, the scene/graph doors) that a standalone lab page has
 * no business loading; this module has none of that — THREE arrives by
 * parameter, nothing here touches `game`/`canvas`/settings. Consumed by
 * `vt-pan-viewer.js`'s `buildWholeImageMaterial` (the shipped call site) and
 * by `tools/shader-lab/bench-albedo-clarity.js` (the second consumer that
 * forced this seam — same shape as the caster-packing extraction the shader
 * lab's own growth doc already records paying off once).
 *
 * `shouldUseFullAlbedoClarity()` — the profile-tier gate that decides which
 * of these two node builders a material compiles with — stays in
 * `vt-pan-viewer.js`, deliberately: it reads `readSetting`/`profileRank`,
 * which ARE Foundry-coupled, and extracting it here would drag that coupling
 * straight back in.
 *
 * ===========================================================================
 * ALBEDO CLARITY — "when I zoom out the dark outlines get mushed and the image
 * goes low-contrast; PIXI stays sharp" (author, 2026-07-28). This is the THIRD
 * round on this one complaint. The mip chain and pixel-ratio parity (both
 * 2026-07-19) were the first two — both real fixes, both still not enough.
 *
 * WHY THE FIRST TWO COULD NOT CLOSE IT. Both asked "which mip level does MSA
 * sample?" and made that answer match PIXI. Neither asked what minification
 * COSTS once the level is already right — and the answer is that a correctly
 * prefiltered minified image is genuinely, unavoidably softer than its source.
 * Each texel of a level-2 mip is the average of 16 source texels, so a one-texel
 * ink outline that was solid black becomes one sixteenth of a light grey cell.
 * That is not a sampler bug. It is what prefiltering IS, and PIXI pays it too.
 *
 * MEASURED FIRST, so this is not a fourth plausible story (memory:
 * feedback_measure_the_output_not_the_equation, feedback_plausible_diagnosis_rots).
 * Running the project's OWN BC1 encoder over synthetic pen art at LOD 1.4 — the
 * author's actual zoom-out — against a simulated PIXI chain:
 *   PIXI (gamma mips, no BC, gamma filter)   RMS contrast 44.8
 *   MSA  (gamma mips, BC1,  linear filter)   RMS contrast 41.2   (-8%)
 *   isolate BC1 only                         RMS contrast 48.0   (BC1 RAISES it)
 *   isolate sRGB-vs-gamma filtering          RMS contrast 37.9   (-15%)
 * BC1 was exonerated outright; the filtering colour space is real but small.
 * The whole MSA-vs-PIXI texture-path gap is ~8% — nowhere near what the author
 * is describing. So the loss is inherent to minification, and no better sampler
 * can recover it. Something has to PUT THE CONTRAST BACK.
 *
 * THE TECHNIQUE: AMD FidelityFX CAS (Contrast Adaptive Sharpening) — the modern
 * standard for precisely this. It restores local contrast without the haloing a
 * plain unsharp mask produces and without amplifying flat-area noise. Its `amp`
 * term eases the sharpening off as a neighbourhood approaches black or white,
 * which is exactly what keeps ink outlines from ringing into haloes.
 *
 * THREE THINGS THAT MAKE THIS A REPAIR RATHER THAN A BLANKET SHARPEN:
 *
 *  1. THE KERNEL IS SCREEN-SPACE, NOT TEXTURE-SPACE. The four taps sit at
 *     ±dFdx/±dFdy — exactly one OUTPUT pixel away, at every zoom. A
 *     texture-space kernel would sharpen a fixed count of texels and so change
 *     character as you zoom; this one always sharpens what the display actually
 *     resolves. The derivatives are taken in strictly uniform control flow (no
 *     branch above them): divergent-flow derivatives are undefined behaviour,
 *     the trap water-body.js carries its own warning about.
 *
 *  2. IT ENGAGES ONLY UNDER MINIFICATION. `texelsPerPixel` is the real
 *     footprint read off those derivatives, and the gate is 0 at 1:1, ramping
 *     in as the art begins to minify. At or above 1:1 there is no lost detail
 *     to recover and sharpening would only add ringing — which is why zoomed-in
 *     views come out of this completely untouched.
 *
 *  3. IT SHARPENS IN A PERCEPTUAL SPACE, NOT LINEAR LIGHT. Samples arrive
 *     linear (the art is an sRGB-format texture, so the hardware decodes before
 *     it filters). Sharpening there would fight the eye: linear-light
 *     differences are not what "contrast" means to a viewer, and dark ink on
 *     light paper — the exact case in question — is where the two spaces
 *     diverge hardest. A gamma-2.0 round trip (sqrt in, square out) is a
 *     branch-free stand-in for sRGB at a fraction of a real transfer pair's
 *     cost, and it puts the CAS maths in the same space PIXI's whole renderer
 *     happens to work in.
 *
 * ALPHA IS DELIBERATELY LEFT ALONE. Ringing a cutout's alpha would fringe every
 * prop silhouette against the floor showing through it — a worse artefact than
 * the softness being repaired.
 * ===========================================================================
 *
 * @module vt/albedo-clarity
 */

/** Live clarity settings. ONE shared uniform pair drives every whole-image
 * material (memory: keyhole-vt-pan-viewer-extraction trap 2 — shared uniforms
 * must stay shared; per-material copies would make the setter update only
 * whichever material happened to be built last). Default ON, per
 * feedback_default_on_new_features. */
const ALBEDO_CLARITY_DEFAULTS = {
  /** CAS sharpening strength. 0 = off; 0.2 is stock FidelityFX CAS at maximum.
   * Pen-and-ink map art tolerates — and wants — a little more than photographic
   * content, so the default sits just above stock. Range 0..0.5. */
  sharpness: 0.22,
  /** Minification (source texels per output pixel) where sharpening starts. 1.0
   * = the moment the art stops being pixel-exact. */
  gateLo: 1.0,
  /** Minification where sharpening reaches full strength. */
  gateHi: 1.8,
  /**
   * THE FAR ROLL-OFF (author, 2026-07-28: "large zoom out makes areas look a bit
   * pixelated"). Past a point, every screen pixel is showing roughly one mip
   * texel, so there is no sub-pixel detail left to recover and sharpening starts
   * emphasising the texel grid itself instead — which reads as pixelation. These
   * two ease the strength back down toward `farFloor` once minification passes
   * `farLo`, reaching it at `farHi`.
   *
   * RETUNED 2026-08-30 ([[project_albedo_zoom_out_clarity_audit_2026-08-30]]
   * §2.3): the ORIGINAL 6.0/16.0 pair meant that on the author's own 6750²
   * ground — whole-map view ≈5.4 texels/px — full, unattenuated strength
   * covered every zoom level the author was actively complaining about; the
   * roll-off this comment describes never engaged until PAST the complaint
   * range. Pulled in so the roll-off actually starts inside a normal
   * zoomed-out view instead of only beyond a whole-map one.
   */
  farLo: 2.5,
  farHi: 6.0,
  /** Fraction of `sharpness` still applied at and beyond `farHi`. 1 = no
   * roll-off at all; 0 = sharpening fully off at extreme zoom-out. */
  farFloor: 0.35,
};
const _albedoClarity = { ...ALBEDO_CLARITY_DEFAULTS, enabled: true };
/** @type {{ sharpen: any, gate: any }|null} */
let _albedoClarityUniforms = null;

/**
 * The Make-panel card's schema (validated by core/params-schema.js; consumed
 * by `boot.js`'s `buildAlbedoClarityPanel`, which is what satisfies
 * `params/no-dead-controls` — every key here is read again over there via
 * `getValue`/`onChange`). Ranges mirror `setAlbedoClarity`'s own clamps
 * exactly, so a slider can never reach a value the setter would silently
 * clamp out from under it. `enabled` is deliberately NOT a key here — it's
 * the card's own on/off, the same shape Grade's card uses, not a `_PARAMS`
 * entry (see `getAlbedoClarity`'s own `enabled` field for where it lives).
 * @type {Record<string, object>}
 */
export const ALBEDO_CLARITY_PARAMS = Object.freeze({
  sharpness: {
    type: 'float',
    min: 0,
    max: 0.5,
    step: 0.01,
    default: ALBEDO_CLARITY_DEFAULTS.sharpness,
    category: 'Look',
    label: 'Sharpness',
    help: 'How strongly zoomed-out art gets its lost contrast restored. Higher looks crisper but can start to look harsh; 0 leaves the image untouched without needing a scene reload.',
  },
  gateLo: {
    type: 'float',
    min: 0,
    max: 4,
    step: 0.05,
    default: ALBEDO_CLARITY_DEFAULTS.gateLo,
    category: 'Technical',
    label: 'Ramp-in start',
    help: 'Minification (source texels per screen pixel) where sharpening starts engaging. 1.0 = the moment art stops being pixel-exact.',
  },
  gateHi: {
    type: 'float',
    min: 0,
    max: 6,
    step: 0.05,
    default: ALBEDO_CLARITY_DEFAULTS.gateHi,
    category: 'Technical',
    label: 'Ramp-in full strength',
    help: 'Minification where sharpening reaches full strength (Sharpness, unattenuated).',
  },
  farLo: {
    type: 'float',
    min: 0,
    max: 30,
    step: 0.5,
    default: ALBEDO_CLARITY_DEFAULTS.farLo,
    category: 'Technical',
    label: 'Roll-off start',
    help: 'Minification where the far roll-off starts easing strength back down toward Far-zoom floor, for extreme zoom-outs where sharpening would emphasise the texel grid instead of real detail.',
  },
  farHi: {
    type: 'float',
    min: 0,
    max: 40,
    step: 0.5,
    default: ALBEDO_CLARITY_DEFAULTS.farHi,
    category: 'Technical',
    label: 'Roll-off end',
    help: 'Minification where the far roll-off finishes — strength settles at Far-zoom floor from here on out.',
  },
  farFloor: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    default: ALBEDO_CLARITY_DEFAULTS.farFloor,
    category: 'Technical',
    label: 'Far-zoom floor',
    help: 'Fraction of Sharpness still applied at and beyond Roll-off end. 1 = no roll-off at all; 0 = sharpening fully off at extreme zoom-out.',
  },
});

/**
 * The shared clarity uniforms, created on first use (THREE arrives by parameter
 * throughout this file — it is dynamically imported inside the factory, so a
 * module-level `uniform(...)` at load time is not available).
 * @param {*} THREE @returns {{ sharpen: any, gate: any }}
 */
function albedoClarityUniforms(THREE) {
  if (_albedoClarityUniforms === null) {
    const { uniform, float, vec4 } = THREE.TSL;
    _albedoClarityUniforms = {
      sharpen: uniform(float(_albedoClarity.enabled ? _albedoClarity.sharpness : 0)),
      // (gateLo, gateHi, farLo, farHi) — the ramp-in pair and the roll-off pair.
      gate: uniform(vec4(_albedoClarity.gateLo, _albedoClarity.gateHi, _albedoClarity.farLo, _albedoClarity.farHi)),
      farFloor: uniform(float(_albedoClarity.farFloor)),
    };
  }
  return _albedoClarityUniforms;
}

/**
 * Tune albedo clarity live — no rebuild, no scene reload (the uniforms are
 * shared, so one write reaches every item on screen).
 *
 * `enabled` drives the live uniform to 0 instantly (this frame, on screen)
 * without touching the stored `sharpness` value, so re-enabling restores
 * exactly what was there before. It does NOT by itself remove the shader's
 * neighbour taps — that is `shouldUseFullAlbedoClarity()`'s job, in
 * `vt-pan-viewer.js`, which composes with this flag and only takes effect on
 * the next material build (see that function's own doc for why).
 *
 * @param {{sharpness?:number, gateLo?:number, gateHi?:number, enabled?:boolean}} next
 * @returns {{sharpness:number, gateLo:number, gateHi:number, enabled:boolean, applied:boolean}}
 *   `applied:false` means no material has been built yet, so the values are
 *   stored and will be picked up when one is — NOT that the call was ignored
 *   (memory: feedback_instruments_must_not_lie).
 */
export function setAlbedoClarity(next = {}) {
  if (Number.isFinite(next.sharpness)) _albedoClarity.sharpness = Math.max(0, Math.min(0.5, next.sharpness));
  if (Number.isFinite(next.gateLo)) _albedoClarity.gateLo = Math.max(0, next.gateLo);
  if (Number.isFinite(next.gateHi)) _albedoClarity.gateHi = Math.max(0.01, next.gateHi);
  if (Number.isFinite(next.farLo)) _albedoClarity.farLo = Math.max(0, next.farLo);
  if (Number.isFinite(next.farHi)) _albedoClarity.farHi = Math.max(0.01, next.farHi);
  if (Number.isFinite(next.farFloor)) _albedoClarity.farFloor = Math.max(0, Math.min(1, next.farFloor));
  if (typeof next.enabled === 'boolean') _albedoClarity.enabled = next.enabled;
  // Keep both ramps well-ordered whichever end the caller moved. A smoothstep
  // with hi <= lo is a hard step, which would pop as you zoom rather than fade.
  if (_albedoClarity.gateHi <= _albedoClarity.gateLo) _albedoClarity.gateHi = _albedoClarity.gateLo + 0.01;
  if (_albedoClarity.farHi <= _albedoClarity.farLo) _albedoClarity.farHi = _albedoClarity.farLo + 0.01;
  if (_albedoClarityUniforms) {
    _albedoClarityUniforms.sharpen.value = _albedoClarity.enabled ? _albedoClarity.sharpness : 0;
    _albedoClarityUniforms.gate.value.set(
      _albedoClarity.gateLo,
      _albedoClarity.gateHi,
      _albedoClarity.farLo,
      _albedoClarity.farHi
    );
    _albedoClarityUniforms.farFloor.value = _albedoClarity.farFloor;
  }
  return { ..._albedoClarity, applied: _albedoClarityUniforms !== null };
}

/** Restore every clarity control to its shipped default — the way back from a
 * tuning session that went somewhere odd. */
export function resetAlbedoClarity() {
  return setAlbedoClarity({ ...ALBEDO_CLARITY_DEFAULTS, enabled: true });
}

/** Current albedo-clarity settings, plus whether they are actually bound to a
 * live material yet. @returns {{sharpness:number, gateLo:number, gateHi:number, enabled:boolean, applied:boolean}} */
export function getAlbedoClarity() {
  return { ..._albedoClarity, applied: _albedoClarityUniforms !== null };
}

/**
 * Is the persistent, user-facing enable flag currently on? Read by
 * `shouldUseFullAlbedoClarity()` in `vt-pan-viewer.js` — a plain function
 * rather than exporting `_albedoClarity` itself, so the state stays private
 * and every reader goes through the same door.
 * @returns {boolean}
 */
export function isAlbedoClarityEnabled() {
  return _albedoClarity.enabled !== false;
}

/**
 * THE CAS (Contrast Adaptive Sharpening) CORE — five ALREADY GAMMA-2.0-ENCODED
 * samples (center + 4 neighbours) in, sharpened linear rgb out. Extracted
 * 2026-08-27 (previously inlined at the tail of `buildAlbedoClarityNode`) so
 * `buildPostUpscaleSharpenNode` below can share the identical algorithm.
 *
 * LUMA-LOCKED (2026-08-30 — [[project_albedo_zoom_out_clarity_audit_2026-08-30]]
 * §1C), replacing a KNOWN, CHARACTERISED per-channel rainbow-fringing bug: the
 * ORIGINAL version ran the whole `mn`/`mx`/`amp`/`w` algebra as `vec3` — R, G
 * and B each got their OWN independently-computed sharpen weight from their
 * OWN local min/max, so a coloured edge got a HUE shift, not just a brightness
 * one (measured: a tan/wine-red edge moved R/G/B by -43%/-83%/-53% at the same
 * boundary texel — `tools/shader-lab/bench-albedo-clarity.js`'s
 * `chromatic-fringing-on-a-coloured-edge` scenario). A same-session
 * (2026-08-15) attempt at a shared-weight fix in GAMMA space was abandoned:
 * squaring a shared gamma-space delta back to linear does not produce a
 * uniform proportional change per channel once the three channels' own
 * squared values diverge, so the fringing came back one step downstream.
 *
 * THIS version derives a single scalar LUMA-based GAIN (never per-channel)
 * and MULTIPLIES it into every channel of the LINEAR center sample.
 * Multiplicative, not additive — this matters and was gotten wrong once
 * before shipping (see the two attempts recorded below), because a
 * multiplicative scale is the one operation that preserves R:G:B RATIOS
 * exactly, which is what "hue and saturation unchanged" actually means
 * colorimetrically. An additive shift does not: it changes those ratios,
 * it just does so uniformly rather than divergently.
 *
 * TWO ATTEMPTS, gotten wrong before this one, both worth recording:
 *
 * 1. A shared delta added in GAMMA space (2026-08-15, same-session as the
 *    bug's discovery): squaring a shared gamma-space delta back to linear
 *    does not produce a uniform proportional change per channel once the
 *    three channels' own squared values diverge — the fringing reappeared
 *    one step downstream. Abandoned, unshipped.
 *
 * 2. A shared delta added in LINEAR space (2026-08-30, this session's own
 *    first draft): computed correctly in the abstract, but ADDITIVE means
 *    the delta is calibrated to whichever channel needs the most correction
 *    and then applied at full strength to every channel regardless of ITS
 *    OWN magnitude. Measured live on this file's own bench fixture (a dim,
 *    desaturated red — R,G,B ≈ 0.099/0.011/0.015 linear): a delta sized
 *    correctly for R's own 0.099 collapsed G and B — both under 0.015 —
 *    to exactly 0, a WORSE spread (0.9) than the bug being fixed (0.4).
 *    Caught by re-running `chromatic-fringing-on-a-coloured-edge` before
 *    shipping, not assumed safe from the algebra alone. Replaced by this
 *    multiplicative version, which scales every channel by the SAME
 *    fraction of its own value instead of shifting all three by the same
 *    absolute amount.
 *
 * ⚠️ THE SUBTLE PART shared with both attempts, still true here: `gain` is
 * `sharpenedLumaProxy² ÷ UNSHARPENED lumaProxy²`, NOT `÷ linearCenter's own
 * TRUE luma`. `lumaProxy` (`lC` below) is a luma of per-channel SQUARE
 * ROOTS — `luma(√r,√g,√b)² ≠ luma(r,g,b)` for any non-grey colour
 * (Jensen's-inequality gap, equality only when r=g=b). Dividing by the TRUE
 * linear luma would introduce a small but real gain ≠ 1 on every flat,
 * COLOURED region — zero local contrast to restore, yet a nonzero gain,
 * purely from the colour of the pixel. Dividing by the UNSHARPENED value
 * run through the SAME proxy formula cancels that gap exactly: on a flat
 * neighbourhood `lSharpenedGamma === lC` algebraically (see `w`'s own
 * comment below), so `gain` is EXACTLY 1 for every colour, not only grey.
 *
 * `gain` is capped (`GAIN_CEILING`) as a numerical backstop for a near-black
 * pixel next to a genuinely bright edge, where `lC` in the divisor can
 * approach zero — `amp`'s own ringing brake bounds `w`, not the DIVISION
 * this core performs on top of it, so this is a second, independent guard
 * rather than a redundant one.
 *
 * One accepted behaviour change from the original: `amp` (the ringing brake)
 * now reads the neighbourhood's LUMA proximity to black/white, not each
 * channel's own — a direct, intended consequence of no longer treating
 * channels independently, not a new defect.
 *
 * @param {*} THREE
 * @param {{eC:*, eL:*, eR:*, eU:*, eD:*}} samples - gamma-2.0-encoded center +
 *   four neighbour samples (rgb only — alpha is each caller's own concern).
 * @param {*} strengthNode - the EFFECTIVE per-fragment sharpen weight, already
 *   combining whatever gating/strength uniform the caller uses (e.g.
 *   `buildAlbedoClarityNode`'s `uSharpen * gate`; `buildPostUpscaleSharpenNode`'s
 *   plain external strength, no per-pixel gate at all — see its own header).
 * @param {*} linearCenter - the UNSHARPENED linear-space center sample
 *   (`c.rgb` at both call sites, already available before `enc()` runs) —
 *   the shared gain multiplies THIS, never re-derived from `eC`.
 * @returns {*} vec3 LINEAR rgb, clamped non-negative.
 */
function sharpenCasCore(THREE, { eC, eL, eR, eU, eD }, strengthNode, linearCenter) {
  const TSL = THREE.TSL;
  const { vec3, float } = TSL;
  const GAIN_CEILING = 4.0;
  const luma709 = (v) => v.x.mul(0.2126).add(v.y.mul(0.7152)).add(v.z.mul(0.0722));
  const lC = luma709(eC);
  const lL = luma709(eL);
  const lR = luma709(eR);
  const lU = luma709(eU);
  const lD = luma709(eD);

  // `amp` is the ringing brake: it falls to zero as the neighbourhood's LUMA
  // approaches black OR white, so a solid ink line next to bare paper — the
  // highest-contrast case there is — gets restored without gaining a halo.
  const mn = TSL.min(lC, TSL.min(TSL.min(lL, lR), TSL.min(lU, lD)));
  const mx = TSL.max(lC, TSL.max(TSL.max(lL, lR), TSL.max(lU, lD)));
  const amp = TSL.saturate(TSL.min(mn, float(1).sub(mx)).div(TSL.max(mx, float(1e-4)))).sqrt();

  // w is NEGATIVE (neighbours subtracted) and the reciprocal renormalises, so a
  // flat neighbourhood comes through exactly unchanged: (l + 4lw)/(1+4w) = l —
  // true for ANY scalar l, which is what makes `gain` exactly 1 on a flat
  // neighbourhood regardless of colour (see this function's own header).
  const w = amp.mul(strengthNode).negate();
  const rcp = float(1).div(w.mul(4).add(1));
  const lSharpenedGamma = lC.add(lL.add(lR).add(lU).add(lD).mul(w)).mul(rcp);

  // Both terms through the SAME gamma²-proxy formula — see header. Never
  // divide by `linearCenter`'s own true luma directly.
  const gain = TSL.min(lSharpenedGamma.mul(lSharpenedGamma).div(TSL.max(lC.mul(lC), float(1e-6))), float(GAIN_CEILING));

  // The ONE shared gain, multiplied into every channel of the ORIGINAL
  // linear center — this is the whole fix: R:G:B ratios (hue, saturation)
  // are preserved exactly, because a multiplicative scale is the one
  // operation that cannot change them.
  return TSL.max(linearCenter.mul(gain), vec3(0));
}

/**
 * Sample `tex` through the clarity filter: five screen-space taps, CAS in a
 * perceptual space, gated to minification. See this module's header for why
 * each of those three clauses is load-bearing.
 *
 * @param {*} THREE
 * @param {*} tex - the art texture (already sRGB-decoded on sample by the
 *   hardware, so `rgb` arrives LINEAR and leaves LINEAR — this is drop-in for a
 *   bare `texture(tex, uv)` and changes nothing downstream).
 * @param {*} uvNode - the FINAL uv node (uvScale already applied).
 * @param {*} uTexSizeNode - vec2 of the texture's own texel dimensions, i.e.
 *   what `uv * this` converts a UV derivative into a texel count. For the
 *   block-compressed path that is the PADDED size, because uv 1.0 addresses the
 *   padded width — not the logical width the uvScale crops back to.
 * @returns {{rgb:any, a:any}} linear rgb + the untouched source alpha.
 */
export function buildAlbedoClarityNode(THREE, tex, uvNode, uTexSizeNode) {
  const TSL = THREE.TSL;
  const { vec3, float, texture, dFdx, dFdy } = TSL;
  const { sharpen: uSharpen, gate: uGate, farFloor: uFarFloor } = albedoClarityUniforms(THREE);

  // UNIFORM CONTROL FLOW: nothing may branch above these two lines.
  const duvdx = dFdx(uvNode).toVar();
  const duvdy = dFdy(uvNode).toVar();

  // Source texels covered by one output pixel. >1 = minifying = detail is being
  // averaged away = there is something for the sharpen to put back.
  const fx = duvdx.mul(uTexSizeNode);
  const fy = duvdy.mul(uTexSizeNode);
  const texelsPerPixel = TSL.max(fx.dot(fx), fy.dot(fy)).sqrt().toVar();
  // Ramp IN as the art starts to minify, then ease back toward `farFloor` at
  // extreme zoom-out, where a screen pixel already shows about one mip texel and
  // sharpening would emphasise the texel grid rather than recover detail.
  // mix() in FUNCTION form deliberately: `a.mix(b, t)` silently evaluates as
  // mix(b, t, a) (memory: reference_tsl_method_chaining_trap).
  const rampIn = TSL.smoothstep(uGate.x, uGate.y, texelsPerPixel);
  const rollOff = TSL.smoothstep(uGate.z, uGate.w, texelsPerPixel);
  const gate = rampIn.mul(TSL.mix(float(1), uFarFloor, rollOff)).toVar();

  const c = texture(tex, uvNode).toVar();
  const sL = texture(tex, uvNode.sub(duvdx));
  const sR = texture(tex, uvNode.add(duvdx));
  const sU = texture(tex, uvNode.sub(duvdy));
  const sD = texture(tex, uvNode.add(duvdy));

  // Linear → gamma-2.0. The max() guards sqrt against a negative that a future
  // HDR-ish albedo source could introduce; on 8-bit art it never fires.
  const enc = (s) => TSL.max(s.rgb, vec3(0)).sqrt();
  const eC = enc(c).toVar();
  const eL = enc(sL);
  const eR = enc(sR);
  const eU = enc(sU);
  const eD = enc(sD);

  // CAS, via the shared core (sharpenCasCore, above) — combining `uSharpen`
  // (the player's own Sharpness control) with `gate` (the per-pixel
  // minification ramp computed above) into the ONE effective strength the
  // core expects. The former per-channel chromatic-fringing bug (author,
  // 2026-08-15: "too harsh / ringing, worse at some zoom levels") is fixed
  // at the shared-core level — see `sharpenCasCore`'s own header for the
  // luma-locked mechanism and the subtle Jensen's-gap mistake caught and
  // corrected before it shipped. `buildPostUpscaleSharpenNode` below
  // inherits the SAME fix via the shared core, with nothing further to do
  // there.
  const lin = sharpenCasCore(THREE, { eC, eL, eR, eU, eD }, uSharpen.mul(gate), c.rgb);
  return { rgb: lin, a: c.a };
}

/**
 * The bare 1-tap read `buildAlbedoClarityNode` degenerates to whenever
 * `uSharpen` is 0: `w = amp*0*gate = 0` ⇒ `rcp = 1` ⇒ `sharpened = eC` ⇒
 * `lin.mul(lin) = max(c.rgb,0).sqrt()² = max(c.rgb,0)`. Every one of the 4
 * neighbour taps, the two `dFdx`/`dFdy` derivative reads, and the CAS
 * contrast math is provably unreachable in that case — this function is
 * that same output with the unreachable work actually removed, not merely
 * multiplied by zero (a shader with an unconditional discard/branch still
 * pays for the code inside it regardless of the runtime value feeding it —
 * `buildSceneDepthWriterMaterial`'s own `alwaysOpaque` is the identical
 * argument applied to a different function, `scene-depth.js`).
 *
 * @param {*} THREE @param {*} tex @param {*} uvNode
 * @returns {{rgb:any, a:any}} SAME shape as `buildAlbedoClarityNode`'s own.
 */
export function buildFlatAlbedoNode(THREE, tex, uvNode) {
  const { vec3, texture, max } = THREE.TSL;
  const c = texture(tex, uvNode);
  return { rgb: max(c.rgb, vec3(0)), a: c.a };
}

/**
 * ===========================================================================
 * POST-UPSCALE SHARPEN (2026-08-27) — a DIFFERENT problem than the rest of
 * this file, sharing the SAME algorithm.
 * ===========================================================================
 *
 * `buildAlbedoClarityNode` above repairs texture MINIFICATION — detail lost
 * because a source texel maps to less than one screen pixel. The render-scale
 * governor (`graph/v3-perf.js`, `vt/render-scale-policy.js`) introduces the
 * opposite case: MSA now sometimes renders at fewer pixels than it presents,
 * and the free bilinear upscale that recovers the display size (`grade-
 * present.js` sampling `scene.lit`) blurs exactly the way any bilinear
 * upscale does — a `Performance-Ceiling-Analysis-2026-08-26.md`-documented,
 * live-confirmed cost of the governor's own win (author, 2026-08-26: "the
 * slightly mushy graphics are a bit of a shame"). Nothing existed to repair
 * THIS blur before the governor did, because there was nothing to upscale.
 *
 * STRENGTH IS NOT A PER-PIXEL GATE, unlike `buildAlbedoClarityNode`'s own
 * `texelsPerPixel` ramp. That gate exists because a SINGLE material can show
 * both sharp and blurry regions in the same frame (a zoomed map has near and
 * far texels on screen at once) — the present pass has no such variation:
 * every fragment is upscaled by the exact same `internalScale`, so "how much
 * sharpening" has exactly one right answer per frame, known in advance the
 * instant the governor picks a scale. `resolvePostUpscaleSharpenStrength`
 * computes that answer; `setPostUpscaleSharpenStrength` pushes it as a plain
 * uniform, never re-derived per-pixel.
 *
 * DELIBERATELY NOT INDEPENDENTLY TUNED AGAINST THE EXISTING PASS STACKING
 * ON TOP OF IT. Both this and `buildAlbedoClarityNode` are the same
 * contrast-boost algorithm, and both can be active on the same frame (this
 * one repairs the upscale; that one still repairs whatever texture
 * minification remains even at a reduced internal resolution). Two
 * contrast boosts in a row risk compounding into something too harsh —
 * `POST_UPSCALE_SHARPEN_DEFAULTS.maxStrength` sits deliberately BELOW
 * `ALBEDO_CLARITY_DEFAULTS.sharpness`'s own shipped default for exactly this
 * reason. This is a FLAGGED risk, not a solved one: it needs a live visual
 * check stacking both passes on real art, not a static guess.
 * ===========================================================================
 */

const POST_UPSCALE_SHARPEN_DEFAULTS = Object.freeze({
  /** Strength at the governor's LOWEST rung (`SCALE_LADDER`'s smallest
   * value). Same units as `ALBEDO_CLARITY_DEFAULTS.sharpness` (0 = off, 0.2 =
   * stock FidelityFX CAS max) — deliberately BELOW that constant's own 0.22
   * shipped default, for the stacking risk this section's own header names. */
  maxStrength: 0.12,
});

/** Live post-upscale sharpen strength — a single scalar, not a settings-style
 * object like `_albedoClarity`: this is DERIVED (`resolvePostUpscaleSharpen
 * Strength`), never a player-facing control of its own. */
let _postUpscaleSharpenStrength = 0;
/** @type {{ strength: any }|null} */
let _postUpscaleSharpenUniforms = null;

/** The shared strength uniform, created on first use — same lazy-creation
 * reasoning `albedoClarityUniforms` gives (THREE arrives by parameter). */
function postUpscaleSharpenUniforms(THREE) {
  if (_postUpscaleSharpenUniforms === null) {
    const { uniform, float } = THREE.TSL;
    _postUpscaleSharpenUniforms = { strength: uniform(float(_postUpscaleSharpenStrength)) };
  }
  return _postUpscaleSharpenUniforms;
}

/**
 * Map the render-scale governor's `internalScale` to a post-upscale sharpen
 * strength. `1.0` (no upscale at all) → exactly `0` — the native path must
 * cost nothing; `grade-present.js` uses this comparison to decide whether to
 * even COMPILE the sharpen taps in at all, not merely to gate them at zero
 * (the SAME "removed, not multiplied by zero" argument `buildFlatAlbedoNode`'s
 * own doc makes, one level up). Below 1.0, ramps LINEARLY to `maxStrength` at
 * the ladder's lowest rung (`0.5`) — deliberately simple; the right curve
 * needs live tuning against real art, not a guess baked in on day one.
 * @param {number} internalScale
 * @returns {number}
 */
export function resolvePostUpscaleSharpenStrength(internalScale) {
  const s = Number.isFinite(internalScale) ? Math.max(0.5, Math.min(1, internalScale)) : 1;
  if (s >= 0.9995) return 0;
  const t = (1 - s) / 0.5; // 0 at scale 1.0, 1 at scale 0.5 (SCALE_LADDER's lowest rung)
  return Math.max(0, Math.min(1, t)) * POST_UPSCALE_SHARPEN_DEFAULTS.maxStrength;
}

/**
 * Push the post-upscale sharpen strength live (clamped to
 * `[0, POST_UPSCALE_SHARPEN_DEFAULTS.maxStrength]`) — called by
 * `vt-pan-viewer.js` whenever the governor's `internalScale` changes, with
 * `resolvePostUpscaleSharpenStrength`'s own output. The uniform write alone
 * is enough to change what's on screen next frame; `grade-present.js`'s own,
 * separate, coarser decision (whether the sharpen taps are compiled in AT
 * ALL) is made by comparing THIS value to zero, not driven from here.
 * @param {number} strength
 * @returns {number} the clamped value actually stored.
 */
export function setPostUpscaleSharpenStrength(strength) {
  const clamped = Number.isFinite(strength)
    ? Math.max(0, Math.min(POST_UPSCALE_SHARPEN_DEFAULTS.maxStrength, strength))
    : 0;
  _postUpscaleSharpenStrength = clamped;
  if (_postUpscaleSharpenUniforms) _postUpscaleSharpenUniforms.strength.value = clamped;
  return clamped;
}

/** @returns {number} the current post-upscale sharpen strength (diagnostics —
 * mirrors `getAlbedoClarity`'s own "current value, plus whether it's bound to
 * a live material yet" shape, minus the `applied` half since this value is
 * meaningful even before any material reads it). */
export function getPostUpscaleSharpenStrength() {
  return _postUpscaleSharpenStrength;
}

/**
 * The post-upscale sharpen itself: five screen-space taps of an ALREADY
 * upscaled image (present resolution, after the governor's free bilinear
 * upscale from its internal target), the SAME CAS core
 * `buildAlbedoClarityNode` uses (see this section's own header for why there
 * is no per-pixel gate here). Reaches into the SAME shared, module-level
 * uniform `setPostUpscaleSharpenStrength` writes — the caller never passes a
 * strength value in, exactly like `buildAlbedoClarityNode` reaches into its
 * own shared `albedoClarityUniforms` rather than taking one by parameter.
 *
 * @param {*} THREE
 * @param {*} tex - the present-resolution colour texture (`grade-present.js`'s
 *   own `presentTexNode`'s source, `scene.lit`).
 * @param {*} uvNode - the FINAL uv node.
 * @returns {{rgb:any, a:any}} SAME shape as `buildAlbedoClarityNode`'s own.
 */
export function buildPostUpscaleSharpenNode(THREE, tex, uvNode) {
  const TSL = THREE.TSL;
  const { vec3, texture, dFdx, dFdy } = TSL;
  const { strength } = postUpscaleSharpenUniforms(THREE);

  // UNIFORM CONTROL FLOW: nothing may branch above these two lines — same
  // requirement `buildAlbedoClarityNode`'s own comment states. A full-screen
  // present quad's own UV derivative is exactly one PRESENT pixel, so this is
  // the identical technique, self-adapting to whatever resolution THIS pass
  // renders at, with no manual texel-size computation needed.
  const duvdx = dFdx(uvNode).toVar();
  const duvdy = dFdy(uvNode).toVar();

  const c = texture(tex, uvNode).toVar();
  const sL = texture(tex, uvNode.sub(duvdx));
  const sR = texture(tex, uvNode.add(duvdx));
  const sU = texture(tex, uvNode.sub(duvdy));
  const sD = texture(tex, uvNode.add(duvdy));

  // Linear → gamma-2.0, same perceptual-space reasoning as
  // `buildAlbedoClarityNode`'s own `enc` — see this file's header §3.
  const enc = (s) => TSL.max(s.rgb, vec3(0)).sqrt();
  const eC = enc(c).toVar();
  const eL = enc(sL);
  const eR = enc(sR);
  const eU = enc(sU);
  const eD = enc(sD);

  const rgb = sharpenCasCore(THREE, { eC, eL, eR, eU, eD }, strength, c.rgb);
  return { rgb, a: c.a };
}
