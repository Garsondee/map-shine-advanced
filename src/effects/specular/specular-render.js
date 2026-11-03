/**
 * SHINE — the animated shimmer field, in TSL. THREE is INJECTED, never imported.
 *
 * `specular-pattern.js` is the maths in plain JS, asserted in Node; this is its
 * transcription. `specular-material.js` owns the mask decode's twin.
 *
 * ============================================================================
 * ⚠️ THIS REPLACED A PBR MODEL, AND THE REASON IS THE MEDIUM
 * ============================================================================
 * The previous version computed GGX lobes, Smith visibility, Schlick Fresnel
 * and a split-sum environment BRDF against a synthesised finite eye height. All
 * of it existed to recover angular variation, and **an orthographic camera over
 * a flat map has none** — `N`, `V`, and therefore `N·H`, are one number for the
 * entire screen. It shipped invisible four times; each round located a genuine
 * zero in a chain of THIRTEEN silent preconditions and fixed it, and the effect
 * still did not draw. It was not going to converge, because the medium cannot
 * carry the quantity the model computed.
 *
 * A 2D top-down map CAN carry a field: shimmers, gradients and patterns painted
 * across the metal the mask marks, sliding with the camera and evolving slowly.
 * That is what V2 did — the author confirms it looked right — and this is V2's
 * structure rebuilt on WebGPU, with one capability V2 never had (per-island
 * parallax) and its three mislabelled controls renamed to what they do.
 *
 * ============================================================================
 * ⚠️ THE `1 +` IS THE WHOLE EFFECT. DO NOT REMOVE IT.
 * ============================================================================
 *      shine = tint × (1 + shimmer) × incidentLight × strength
 *
 * That leading 1 is why V2 read as METAL and not as a glow: painted metal
 * always returns light in proportion to the scene lighting, and the shimmer
 * MODULATES that existing reflectance rather than adding an emissive term on
 * top of nothing. Delete it and every animated term becomes a product with
 * something that can be zero — which is precisely the disease that cost this
 * effect four rounds (`feedback_count_silent_preconditions`).
 *
 * It also means the preconditions for a lit pixel are now: mask non-zero,
 * strength above the presence edge, light above its floor. **Three.**
 *
 * @module effects/specular/specular-render
 */

import {
  SPECULAR_PRESENCE_EDGE0,
  SPECULAR_PRESENCE_EDGE1,
  SPECULAR_ALPHA_EPSILON,
  LUMA_601,
  LUMA_709,
} from './specular-material.js';
import {
  MIN_ROW_SPACING,
  SPREAD_TIGHT,
  SPREAD_LOOSE,
  CELL_JITTER,
  STREAK_RADIANS,
  SUN_BIAS_MIN,
  CELL_SCALE_DULL,
  CELL_SCALE_BRIGHT,
  SPECULAR_SHEEN_CEILING,
  SPECULAR_GLINT_CEILING,
  SPECULAR_INCIDENT_STEEPNESS,
  SPECULAR_INCIDENT_KNEE,
  SPECULAR_KNEE_SOFTNESS,
  SPECULAR_INCIDENT_GAIN,
  SPECULAR_FLICKER_AMOUNT,
  SPECULAR_FLICKER_SPEED,
  SPECULAR_FLICKER_SCALE_PX,
  SPECULAR_FLICKER_ROUGHNESS,
  SPECULAR_FLICKER_LOG_GAIN,
  BLOB_BLEND_WIDTH,
  BLOB_REACH_MIN_DISTANCE,
  BLOB_CUT_ONSET,
  SOFT_EXP_CLAMP,
  LAYER_UNION_POWER,
  softWindowParams,
} from './specular-pattern.js';
import { ISLAND_PARALLAX_RANGE } from './specular-islands.js';
import { SPECULAR_DEBUG_CHANNELS, SPECULAR_DEBUG_BOOST } from './specular.js';
import { buildDebugChannelColor, pickEquals } from '../debug-channel-select.js';
import { sharedFn } from '../../core/tsl-fn.js';

/**
 * Fraction of the authored file's resolution to upload for the SHIMMER's own
 * mask read.
 *
 * ⚠️ **RAISED 0.5 → 0.75 2026-08-03 (ROUND 16) — live report: "lower
 * resolution than the main texture it's based off which looks ugly."** At 0.5
 * a texel was ~2 world px; the main map art (`MASK_IMAGE_SCALE = 1` in
 * `vt/mask-image.js`) uploads at native res, so the shimmer mask was visibly
 * blockier than the surface it sits on. 0.75 brings a texel down to ~1.33
 * world px — not yet a full match, but a middle ground, NOT full native (1.0):
 * this mask is `'rgb'` (RGBA, four bytes per texel — the shimmer HSV decode in
 * `specular-material.js` genuinely needs all three colour channels, unlike
 * water's scalar-depth R8 mask), so cost scales with the SQUARE of this
 * fraction × 4 bytes. On a 10,650 × 4,950 map that is ~53 MB at 0.5, ~119 MB at
 * 0.75, and ~211 MB at 1.0 — a 4× jump from today for the last quarter of
 * sharpness, against this project's own device-loss history on large maps
 * (`keyhole-device-loss-large-map`). If 0.75 still reads as soft against the
 * albedo, raising this to 1.0 is a one-number change, same as water's.
 */
export const SPECULAR_MASK_IMAGE_SCALE = 0.75;

/**
 * How many shimmer layers. Matched V2 at THREE through Round 18; DOUBLED to
 * SIX (Round 19, 2026-08-03) on direct request: *"double the number of things
 * that are causing the shines to appear... focus on producing lots more that
 * are configured at a smaller size so they produce small but bright
 * sparkling regions."* Layers 0-2 are the original "broad sweep" set,
 * unchanged; layers 3-5 are new, tuned for a finer, denser field (see
 * `SPECULAR_LAYER_DEFAULTS`'s own per-layer comments).
 *
 * Safe to raise structurally: layers combine via MAX, not SUM (`buildShimmer
 * Terms` in `specular-render.js` — "corrected 2026-07-27" — its own header),
 * so an additional layer can only ever ADD a new place the field might light
 * up, never compound brightness where an existing layer already fires. The
 * relative motion BETWEEN layers at different parallax depths is most of what
 * sells "a highlight sweeping over a surface" rather than "a texture painted
 * on the map" — one layer reads as wallpaper, two reads flat; six reads as a
 * genuinely busier, richer field.
 *
 * The per-layer ALU cost is real (`shimmerLayer` calls `anisotropicBlob`,
 * itself several trig/hash ops) but it is NOT the dominant cost of this
 * effect — the 27-cell Worley + Perlin cellular base runs ONCE regardless of
 * layer count (`buildShimmerTerms`'s own header: "THE DOMINANT COST OF THE
 * WHOLE EFFECT"). Doubling layer count roughly doubles the cheap ALU part of
 * a C1-class pass, not the expensive C3-class texture-adjacent one.
 */
export const SPECULAR_LAYER_COUNT = 6;

/** Defaults, mirroring `SPECULAR_PARAMS` — the single source of truth for the
 * values; the schema quotes them. A change lands in both or neither. */
/**
 * ⚠️ RAISED 1 → 20 (ROUND 18, 2026-08-03) — THE FIRST LIVE-CONFIRMED VALUE
 * THIS EFFECT HAS EVER SHIPPED. The author dialled this to its OWN MAX on a
 * real scene, alongside the other Round 17 controls, and reported back "we
 * have a basic specular effect working again" — a screenshot of the actual
 * panel, not a request to try something. Shipping what worked, not a
 * conservative fraction of it: an author who never opens this panel should
 * see the effect the author actually confirmed, not a fainter version of it.
 *
 * ⚠️ LOWERED 20 → 3.79 (ROUND 22, 2026-09-09) — new live-tuned defaults; no
 * longer the schema's own max — the author's own dialled-in scene, recorded
 * exactly.
 *
 * ⚠️ RAISED 3.79 → 9.96 (ROUND 23, 2026-09-09) — new live-tuned defaults;
 * the author's own dialled-in scene, recorded exactly.
 */
// LOWERED 9.96 → 4.92 (ROUND 24, 2026-10-17) — new live-tuned defaults
export const SPECULAR_DEFAULT_STRENGTH = 5.5; // RAISED 4.92 → 5.5 (METAL BODY, 2026-11-02, mmp-9nb)
/**
 * ⚠️ RAISED FROM 1 TO 1.3 (ROUND 16, 2026-08-03) — now that the shader
 * actually honours values past 1 (see the tint mix's own comment), a MODEST
 * default oversaturation counteracts the global tonemap's known, measured
 * desaturation-under-compression WITHOUT touching anything — an author who
 * has never opened the Look panel now gets gold that survives brightening
 * without bleaching, matching the "brighter but still vibrant" ask directly.
 *
 * ⚠️ RAISED AGAIN, 1.3 → 2 = THE SCHEMA'S OWN MAX (ROUND 18, 2026-08-03) —
 * live-confirmed alongside `SPECULAR_DEFAULT_STRENGTH` above; see that
 * constant's header for the standard this round ships by.
 *
 * ⚠️ LOWERED 2 → 1.25 (ROUND 21, 2026-08-05) — new live-tuned defaults; no
 * longer the schema's own max, but still above 1, i.e. still a deliberate
 * oversaturation rather than a return to neutral colour.
 *
 * ⚠️ RAISED 1.25 → 2 = THE SCHEMA'S OWN MAX AGAIN (ROUND 22, 2026-09-09) —
 * new live-tuned defaults; the author's own dialled-in scene, recorded
 * exactly.
 */
// LOWERED 2 → 1.1 (ROUND 24, 2026-10-17)
export const SPECULAR_DEFAULT_SATURATION = 1.35; // RAISED 1.1 → 1.35 (METAL BODY, 2026-11-02, mmp-9nb)
/**
 * THE SHADOW-CONTRAST CURVE (2026-09-02, mythica-machina-press#432) — an
 * exponent on `decodeSpecularMask`'s own `strength` axis, direct author ask:
 * *"a ROH control to make the darker parts of the _Specular mask stronger so
 * that we get a higher contrast specular with less bleaching of the dark ink
 * lines that my maps artwork has."* Same family as `incidentKnee`/
 * `kneeSoftness`, requested in almost these exact words: *"give me lots of
 * RoH controls so that I can tune the curve."*
 *
 * Defaults to 1 — a mathematically exact pass-through (`x ** 1 === x`), so
 * every map painted before this control existed renders byte-identical to
 * today until an author actually reaches for it. Not yet live-tuned on a
 * real scene the way the rest of this file's defaults are — an honest
 * starting point rather than a guessed "better" one.
 *
 * ⚠️ RAISED 1 → 2.03 (ROUND 22, 2026-09-09) — new live-tuned defaults; no
 * longer the pass-through — the author's own dialled-in scene now pushes
 * dark-mask weight up deliberately, recorded exactly.
 *
 * ⚠️ LOWERED 2.03 → 1.74 (ROUND 23, 2026-09-09) — new live-tuned defaults;
 * still well above the pass-through, the author's own dialled-in scene,
 * recorded exactly.
 */
export const SPECULAR_DEFAULT_MASK_CONTRAST = 4.09; // RAISED 1.74 → 4.09 (ROUND 24, 2026-10-17)
/**
 * THE PATTERN'S WORLD SIZE, in px per pattern unit. **16384, V2's own default,
 * and it is much larger than it looks.**
 *
 * At this scale a layer at density 11 gives roughly 2.7 cells across a 4k map.
 * The tuned V2 look is therefore HUGE SOFT SHAPES drifting over the metal, not
 * micro-glitter — the fine detail comes from the cellular base's
 * strength-driven cell count, not from the layer lattice. Anyone reaching for
 * "more sparkle" should raise `density`, not lower this.
 *
 * ⚠️ LOWERED 16384 → 6528 (ROUND 18, 2026-08-03) — live-confirmed; see
 * `SPECULAR_DEFAULT_STRENGTH`'s header. A smaller pattern scale means MORE
 * cells across the same map, i.e. a busier, finer field — the opposite
 * direction from every earlier round's reasoning, and shipped anyway because
 * the author's own dialled-in scene is the standard, not the doc comment.
 *
 * ⚠️ RAISED 6528 → 10816 (ROUND 21, 2026-08-05) — new live-tuned defaults;
 * back toward fewer, larger cells across the map, though still well under
 * V2's original 16384.
 */
// RAISED 10816 → 11840 (ROUND 24, 2026-10-17)
export const SPECULAR_DEFAULT_PATTERN_SCALE_PX = 3500; // LOWERED 11840 → 3500 (METAL BODY, 2026-11-02, mmp-9nb)
/**
 * The master parallax gain. **1 = V2's measured ≈1:1 world-space slide**, i.e.
 * the shimmer is very nearly SCREEN-LOCKED and sweeps across the map as the
 * author pans, which is what a real reflection does and what a painted texture
 * conspicuously does not.
 *
 * ⚠️ RAISED 1 → 3 = THE SCHEMA'S OWN MAX (ROUND 18, 2026-08-03) —
 * live-confirmed; see `SPECULAR_DEFAULT_STRENGTH`'s header.
 *
 * ⚠️ LOWERED 3 → 0.9 (ROUND 21, 2026-08-05) — new live-tuned defaults; no
 * longer the schema's own max (`specular.test.mjs`'s own "defaults to its
 * own max" pin for this param was updated alongside, not left stale). Close
 * to V2's own ≈1:1 baseline (this constant's own opening paragraph) rather
 * than the exaggerated 3x slide Round 18 shipped.
 *
 * ⚠️ RAISED 0.9 → 3 = THE SCHEMA'S OWN MAX AGAIN (ROUND 22, 2026-09-09) —
 * new live-tuned defaults; back to the exaggerated slide, the author's own
 * dialled-in scene, recorded exactly.
 */
export const SPECULAR_DEFAULT_PARALLAX_STRENGTH = 1.61; // LOWERED 3 → 1.61 (ROUND 24, 2026-10-17)
/**
 * How far islands' hashed parallax may diverge. 1 = the full hashed range,
 * 0 = every island moves identically (exactly V2's behaviour).
 *
 * ⚠️ RAISED 1 → 2 = THE SCHEMA'S OWN MAX (ROUND 18, 2026-08-03) —
 * live-confirmed; see `SPECULAR_DEFAULT_STRENGTH`'s header. Values above 1
 * push islands' hashed parallax BEYOND the ±1 range each island's own hash
 * naturally lands in (`specular-islands.js`'s own header covers the ±2
 * bound this was designed against) — more per-object divergence than V2's
 * range ever offered, not merely "the full range V2 had."
 */
export const SPECULAR_DEFAULT_ISLAND_SPREAD = 2;
/**
 * The independent evolution's speed, in pattern units per second.
 *
 * 0.0025 moves the field about one twentieth of a layer-1 cell per second, so a
 * PARKED view visibly reorganises over ~20 s without ever looking like it is
 * scrolling. This is the author's "alive, camera leads": the camera stays the
 * dominant motion by an order of magnitude, and this keeps the surface from
 * ever being frozen.
 *
 * ⚠️ LOWERED TO EXACTLY 0 (ROUND 18, 2026-08-03) — live-confirmed; see
 * `SPECULAR_DEFAULT_STRENGTH`'s header. At `parallaxStrength` now defaulting
 * to its own max (above), camera pan alone is a great deal of motion — the
 * author's own working scene has the idle drift switched off entirely, not
 * merely slowed.
 *
 * ⚠️ RAISED 0 → 0.0015 (ROUND 23, 2026-09-09) — new live-tuned defaults; a
 * small idle drift is back, the author's own dialled-in scene, recorded
 * exactly.
 */
export const SPECULAR_DEFAULT_DRIFT_SPEED = 0.0015;
/** Global brightness breathing, ± this fraction. Small on purpose: a visible
 * pulse reads as a shader, an imperceptible one reads as a surface.
 *
 * ⚠️ RAISED 0.06 → 0.28 (ROUND 21, 2026-08-05) — new live-tuned defaults; a
 * clearly VISIBLE pulse now, a deliberate departure from this constant's own
 * "keep it small" opening line — the author's own dialled-in scene is the
 * standard, same posture every other Round 20 change takes. */
export const SPECULAR_DEFAULT_PULSE = 0.28;
/**
 * How much the shimmer may modulate the base reflectance. **Raised 4→5.5
 * (2026-07-27), alongside `SPECULAR_SHEEN_CEILING` dropping to 0.15** — the
 * two moves are one change: with the always-on sheen floor no longer eating
 * the tonemap's compression headroom (see that constant's own header), the
 * glint can actually use more of it, which is the "shines brighter" half of
 * the author's contrast request (the "dark parts stay dark" half is the
 * lowered sheen ceiling). V2 ran to ~16× and blew out through bloom, which is
 * a look worth having but not one to default all the way to.
 *
 * ⚠️ LOWERED 5.5 → 2.2 (ROUND 18, 2026-08-03) — live-confirmed; see
 * `SPECULAR_DEFAULT_STRENGTH`'s header. The one control in this round's
 * whole confirmed set that moved DOWN rather than up: with `sheenCeiling`
 * now defaulting to 1 (its own header) rather than 0.15, the base shine
 * alone carries far more of the look than it used to, so less shimmer
 * modulation on top reads as the right balance on the author's real scene —
 * not a contradiction of the reasoning above, a different equilibrium once
 * a NEIGHBOURING term moved this same round.
 *
 * ⚠️ RAISED 2.2 → 40 = THE SCHEMA'S OWN MAX (ROUND 21, 2026-08-05) — new
 * live-tuned defaults, and the mirror image of Round 18's own reasoning:
 * `SPECULAR_SHEEN_CEILING` is now exactly 0 this same round (the base shine
 * term is algebraically eliminated, see that constant's own header), so
 * shimmer modulation is the ONLY source of contrast left, and it now
 * defaults to the most it can possibly contribute.
 *
 * ⚠️ LOWERED 40 → 5.55 (ROUND 22, 2026-09-09) — new live-tuned defaults; no
 * longer the schema's own max — the author's own dialled-in scene, recorded
 * exactly.
 */
// RAISED 5.55 → 12.65 (ROUND 24, 2026-10-17)
export const SPECULAR_DEFAULT_SHIMMER_GAIN = 17; // RAISED 12.65 → 17 (METAL BODY, 2026-11-02, mmp-9nb)
/**
 * THE LIGHT FLOOR. **0, corrected DOWN from 0.18 (2026-07-27) on direct live
 * feedback: metal was reading as SELF-ILLUMINATING in genuinely dark rooms —
 * "boosting those areas so they become brighter, which isn't physically
 * correct."** That is exactly what a floor here does, and the reasoning that
 * shipped it was wrong in a way worth stating plainly so it does not come back.
 *
 * The comment this replaces argued from `feedback_count_silent_preconditions`
 * — "incidentLight multiplies every term, so a zero here is a zero everywhere,
 * exactly the shape that cost this effect four rounds." **That argument is
 * about a BROKEN WIRE, not about genuine darkness**, and the floor could not
 * tell the two apart: it raised the incident term identically whether `illum`
 * was 0 because a mask never loaded, or 0 because the room is legitimately
 * unlit. The first case is a bug worth a floor; the second is the correct
 * answer, and flooring it is the bug.
 *
 * It is ALSO redundant with the mechanism it was meant to imitate — Foundry's
 * own ambient darkness colour (`ambientDarkness`, non-black by default) is
 * already baked into `buf:scene.illum` upstream
 * (`foundry/scene-environment.js`), so `illum` was rarely exactly 0 to begin
 * with. Stacking 0.18 on top of an already-nonzero floor is what pushed
 * ordinary unlit rooms from "believably dim" to "visibly glowing."
 *
 * The composite has no division by `incidentLight` anywhere (see the header),
 * so 0 is numerically safe — a genuinely dark pixel now genuinely renders as
 * 0, not as a NaN. What actually lights indoor metal is unchanged and was
 * already correct: `buf:scene.illum` already carries point lights (MAX-
 * blended in) and window light (additively composited into the SAME buffer,
 * before this pass runs — `effects/window`) — this effect needed no new
 * plumbing to respond to either, only to stop OVERRIDING their absence.
 * Outdoors, `illum` already tracks the sky's own day/night mix
 * (`mix(ambientDaylight, ambientDarkness, darknessLevel)`). Kept as an author
 * param, default 0, for anyone who wants a stylised "never quite black" look.
 */
export const SPECULAR_DEFAULT_LIGHT_FLOOR = 0;
/** How strongly the sun's azimuth favours grain running across it, outdoors.
 * 1 = V2's full 0.35→1 brushed-metal swing over a day.
 *
 * ⚠️ LOWERED 1 → 0.99 (ROUND 21, 2026-08-05) — new live-tuned defaults;
 * functionally identical to V2's own full swing, not a meaningfully
 * different behaviour — the author's own dialled-in scene, recorded exactly
 * rather than rounded back to 1.
 *
 * ⚠️ RAISED 0.99 → 1 = THE SCHEMA'S OWN MAX (ROUND 23, 2026-09-09) — new
 * live-tuned defaults; back to V2's own full swing exactly. */
export const SPECULAR_DEFAULT_SUN_BIAS = 1;

/**
 * ============================================================================
 * THE METAL BODY (2026-11-02, mmp-9nb) — two features + a retune
 * ============================================================================
 * Author: *"make metallic surfaces feel more shiny metallic and metal like…
 * stronger over subtle… a single colour mask… consider water specularity."*
 *
 * THE DIAGNOSIS (lab, Big Bank's gold mermaid statue `Vault_Treasure_05` and
 * Goblin Alchemist's copper, real masks through the production loader): metal
 * read as YELLOW-LIT PAINT. Three measured causes —
 *   1. the shine only ever ADDED light, so there was no dark reflection for a
 *      glint to stand against (metal p90−p10 display contrast 0.56);
 *   2. the pattern (11840 px) was eight times a 1500 px treasure: the whole
 *      statue sat inside ONE flat shimmer blob;
 *   3. nothing used the mask's own SHAPE — the sculpted edges it describes
 *      never caught any light.
 *
 * FEATURE A — MIRROR DEPTH (`mirrorDepth`). Polished metal returns almost no
 * plain diffuse light; what it is not reflecting reads dark. The pass is now
 * PREMULTIPLIED (`dst × (1 − darken) + shine`) and darkens the lit floor under
 * the metal between reflections, putting back a little `tint²` (deep amber on
 * gold, red-brown on copper — `TROUGH_RETURN`) so the troughs read as dim
 * coloured reflections, not as the art scaled toward olive (round 2's fault).
 *
 * FEATURE B — EDGE RELIEF (`reliefStrength`, `reliefWidthPx`). The painted
 * value is read as height (bright = proud, the author's ink lines = grooves);
 * four world-px taps give a bevel normal, lit from where the light really is:
 * the light buffer's own slope indoors (brighter side = toward the lamp), the
 * sun outdoors, a quiet top-left key otherwise. Light-facing flanks catch a
 * pale bevel; the far flanks fall into shade (via the same darkening alpha).
 *
 * THE RETUNE — glint focus (`pow` pivoted on the field's MEASURED peak,
 * `SHIMMER_REF_PEAK`, because the six-layer union never gets near 1: p99 ≈
 * 0.31-0.38), a warm hot core (half-way to grey, never to grey — full grey
 * turned gold to pewter), pattern 11840 → 3500, and strength / saturation /
 * shimmer gain raised to put the average brightness and colour BACK where they
 * were once the troughs darken.
 *
 * MEASURED on the statue under a lamp pool (display space, metal pixels only):
 *   today        mean 0.426  contrast p90−p10 0.562  saturation 0.444
 *   these values mean 0.412  contrast p90−p10 0.619  saturation 0.440
 * i.e. the same brightness and colour, ten per cent more contrast, and it now
 * reads as polished gold. Slab (no mask edges): steepest per-pixel step 0.055
 * at 1:1 (cap for "a visible line" is 0.10) — the field stays soft. Cost
 * unchanged within noise (all-metal 1024² 1.04 → 1.0 ms).
 *
 * WATER (the agreement the author asked for): both are additive light in the
 * same linear HDR buffer through the same tonemap and bloom; at golden hour
 * and at night they already agree because `illum` carries the same sky. The
 * one disagreement was CLOUD — water's sun glint follows `key.strength = day ×
 * (1 − cloud)` and dies under overcast, metal kept full sun-like glints. Metal's
 * OUTDOOR glints now follow the same term (`outdoorGlintResponse`,
 * specular-material.js): overcast relaxes them into a broad satin at 45 %.
 * Absolute peaks deliberately differ: water's glint is the sun's mirror IMAGE
 * (GGX, ~40× HDR in a few pixels), metal's is a broad sheen (~3-4× HDR).
 */
export const SPECULAR_DEFAULT_RELIEF_STRENGTH = 2;
export const SPECULAR_DEFAULT_RELIEF_WIDTH_PX = 3;
export const SPECULAR_DEFAULT_MIRROR_DEPTH = 0.6;
export const SPECULAR_DEFAULT_GLINT_FOCUS = 2;
export const SPECULAR_DEFAULT_HOT_CORE = 0.4;
export const SPECULAR_DEFAULT_COLOUR_RESPONSE = 1;
export const SPECULAR_DEFAULT_CAMERA_GLINT = 1;
export const SPECULAR_DEFAULT_REFLECTION_BEND = 1;
export const SPECULAR_DEFAULT_SPARKLE = 1;
export const SPECULAR_DEFAULT_SPARKLE_SIZE_PX = 7;
export const SPECULAR_DEFAULT_PAN_FLARE = 0.5;
/** World px over which the LIGHT's own gradient is read for relief's key
 * direction indoors — wide enough to see a lamp's falloff, narrow enough that
 * two lamps either side of a statue still light opposite flanks. */
const RELIEF_LIGHT_PROBE_PX = 96;
/** The fallback key when neither the light nor the sun gives a direction:
 * classic top-left (world y is down). */
const RELIEF_DEFAULT_KEY = [-0.6, -0.8];
/** Where the six-layer shimmer union actually peaks over real metal — measured
 * with `specLab.stats` on Big Bank's gold statue at three pattern sizes
 * (p99 0.31-0.38, max 0.31-0.45; 2026-11-02). Focus and mirror pivot on it. */
const SHIMMER_REF_PEAK = 0.35;
/** How much saturated metal colour returns in the darkened troughs, per unit of
 * darkening (× strength × light). Small: it recolours, it must not refill. */
const TROUGH_RETURN = 0.45;
/** METAL BY COLOUR (2026-11-02): how much further bright NEUTRAL paint (silver,
 * steel, chrome) goes than gold — deeper mirror, tighter and brighter glints.
 * First pass (+0.5 / ×1.75 / none) left the Bank's steel coin purses still
 * reading as grey; these read as polished steel beside the gold. */
const CHROME_MIRROR_GAIN = 0.8;
const CHROME_FOCUS_GAIN = 1;
const CHROME_GLINT_GAIN = 0.4;
/** ROUND 2 (2026-11-02) — the pan features. Tuned in the lab on the Bank tiles. */
/** Eye height in view-widths — MUST equal water's (`WATER_TIER3_VIEWER_HEIGHT`,
 * pinned by a test) so metal and water highlights move by one geometry. */
export const SPECULAR_EYE_HEIGHT = 1;
/** A lamp's assumed height for the camera highlight (vertical part of its unit
 * vector): the light buffer knows where a lamp is, not how high. ~37°. */
const LAMP_ELEVATION_Z = 0.85;
const CAMERA_GLINT_SHININESS = 160;
const CAMERA_GLINT_GAIN = 2.5;
/** World px of reflection offset per unit slope at bend 1. */
const BEND_PX = 220;
/** Extra parallax on a fully tilted flank at bend 1. */
const BEND_PARALLAX = 1.2;
const SPARKLE_MIN_SCREEN_PX = 3;
const SPARKLE_JITTER = 0.2;
const SPARKLE_RADIUS = 0.2;
const SPARKLE_FACET_TILT = 1.2;
const SPARKLE_SHININESS = 60;
const SPARKLE_DENSITY = 0.55;
const SPARKLE_GAIN = 14;
/** Brightness added to camera-keyed highlights at full pan speed and flare 1. */
const PAN_FLARE_GAIN = 0.6;
/** The most of the lit floor under the metal that darkening may take. */
const MIRROR_MAX_DARKEN = 0.85;

/**
 * Per-layer defaults, transcribed from V2's tuned values.
 *
 * ⚠️ **`parallaxDepth` on layer 3 is NEGATIVE and that is not a typo.** It
 * counter-moves against the other two, and the resulting relative slide is the
 * single strongest cue that the highlights sit *on* a surface rather than *in*
 * the texture. V2 shipped exactly this and it is the first thing to restore if
 * the effect ever reads flat.
 *
 * `streak` is V2's "Scatter" — the per-cell hashed rotation, and the real
 * streak control. `rowSpacing` is V2's "Elongation", which elongates nothing.
 * `contrast` is V2's "Cluster size", which is not a size. See
 * `specular-pattern.js`'s header for the algebra behind all three.
 *
 * ⚠️ **`contrast` RAISED FROM ~0.5-0.6 TO 0.8 ON ALL THREE LAYERS (ROUND 15,
 * 2026-08-03)** — the actual fix for "either entirely ON or entirely OFF...
 * we want gradients of brighter shiny metal which pierce through" (the
 * SHEEN ceiling was tried first and reverted — see `SPECULAR_SHEEN_CEILING`'s
 * own doc for why that was the wrong axis). `contrast` sets `shimmerLayer`'s
 * smoothstep window (`lo/hi` in `specular-pattern.js#shimmerLayer` — "0 = a
 * narrow window (sparse hard glints), 1 = a wide one (broad connected
 * sheen)"): at the old ~0.5-0.6 defaults the shimmer/glint field measured, on
 * a real gold-plate bench (Shader Lab, `bench-specular.js#gateLadder`), a
 * MEAN under 5% of its own MAX — i.e. a sparse field of isolated bright dots
 * over an otherwise near-zero surface, which is what reads as "binary" (a
 * point is either a dot or it's nothing, no gradient between). At 0.8, the
 * SAME bench on the SAME gold plate measured the mean rise to ~9-10% of max
 * — roughly DOUBLING the "fill factor" — while the max itself stayed flat
 * (~0.61-0.74 before and after), i.e. the pattern genuinely covers more of
 * the surface with SOME visible response instead of just isolated hotspots,
 * without blowing out the peaks any harder. Confirmed via the REAL shader on
 * real WebGPU, not hand arithmetic — but still a first, reasoned value (not
 * a swept optimum): 0.9+ was not verified due to a bench-interaction issue
 * this round, so there may be more headroom left in this same direction.
 * **This does NOT touch the SEPARATE "gold washes toward white" finding** —
 * see `SPECULAR_SHEEN_CEILING`'s doc for that one (a property of the global
 * tonemap's own built-in desaturation-under-compression, not this file).
 *
 * ⚠️ **LAYERS 3-5 ADDED (ROUND 19, 2026-08-03)** — direct request: "double
 * the number of things that are causing the shines to appear... focus on
 * producing lots more that are configured at a smaller size so that they
 * produce small but bright sparkling regions." Layers 0-2 above are
 * UNCHANGED — the original "broad sweep" set. Layers 3-5 are a second,
 * distinct set: higher `density` (more, smaller cells — density scales the
 * pattern-space frequency directly, so a higher value shrinks each cell's
 * real-world footprint), tighter `rowSpacing` (rows packed closer together,
 * for a denser field rather than widely-spaced lines), moderate `softness`
 * (NOT the tightest possible — see the warning below on why), and `contrast`
 * raised to 0.85 (above the already-fixed 0.8, for extra transition-width
 * margin — see the analysis below).
 *
 * ⚠️ **WHY DENSITY IS MODERATE, NOT EXTREME — THE SAME REQUEST ALSO SAID
 * "STRICTLY... NEVER... SHARP CLEAN DEFINED EDGES... CUT OFF ANGLES."** A
 * smaller blob is not more likely to have a HARDER edge in the maths — the
 * smoothstep transition is exactly as continuous at any size — but it IS
 * physically compressed into fewer screen pixels, and past a certain point a
 * GPU fragment shader cannot resolve a transition that has become narrower
 * than roughly one pixel's footprint: that is ALIASING, and it looks exactly
 * like a hard, jagged edge even though the underlying function never stopped
 * being smooth. This project's OWN manifest already names this exact risk —
 * `SPECULAR.deferredRungs.sparkle`: *"footprint-aware glint: count
 * microfacets per pixel from fwidth(worldPos)... so sparkle RESOLVES with
 * zoom instead of aliasing the way V2's fixed world lattice did."* That
 * footprint-aware system is NOT built here — this is a scope-appropriate
 * response to "more, smaller, no hard edges" within the EXISTING
 * architecture's safe range, not the specialised anti-aliased microfacet
 * rung. Density was chosen high enough to read as genuinely finer than
 * layers 0-2, deliberately short of the extreme end where aliasing becomes
 * likely at typical play zoom.
 *
 * ⚠️ **THE CONTRAST-WIDTH ANALYSIS, DONE PROPERLY.** `shimmerLayer`'s window
 * is `[mix(0.55,0.08,c), mix(0.95,0.45,c)]` — its WIDTH in blob-VALUE space is
 * nearly constant (~0.40 → ~0.37) across the whole contrast range, so
 * contrast is NOT primarily a "how wide is the gradient" knob, it is a
 * coverage knob (where in the blob's own falloff the ramp sits). But the blob
 * itself is `exp(-r²·k)`, so the SPATIAL width of that same value-window
 * (∝ √(-ln(lo)) − √(-ln(hi))) DOES grow with contrast: ≈0.55 at contrast 0,
 * ≈0.70 at contrast 1 — a real, ~27% wider spatial transition at higher
 * contrast, for the SAME softness. Raising the shipped default to 0.85 (and
 * the schema's own minimum — see `specular.js`) banks that margin on every
 * layer, existing and new, rather than only reasoning about it in a comment.
 */
export const SPECULAR_LAYER_DEFAULTS = Object.freeze([
  Object.freeze({
    density: 11,
    grainAngleDeg: 115,
    streak: 1.7,
    softness: 0.31,
    rowSpacing: 4,
    contrast: 0.85,
    strength: 1,
    parallaxDepth: 1,
  }),
  Object.freeze({
    density: 15.5,
    grainAngleDeg: 111,
    streak: 1.6,
    softness: 0.5,
    rowSpacing: 4,
    contrast: 0.85,
    strength: 0.8,
    parallaxDepth: 0.5,
  }),
  Object.freeze({
    density: 5,
    grainAngleDeg: 162,
    streak: 0.4,
    softness: 0.37,
    rowSpacing: 4,
    contrast: 0.85,
    strength: 0.6,
    parallaxDepth: -0.5,
  }),
  // ── NEW, ROUND 19 — the "small, bright, sparkling" set ───────────────────
  Object.freeze({
    density: 26,
    grainAngleDeg: 40,
    streak: 0.6,
    softness: 0.42,
    rowSpacing: 2.5,
    contrast: 0.85,
    strength: 0.65,
    parallaxDepth: 0.3,
  }),
  Object.freeze({
    density: 32,
    grainAngleDeg: 195,
    streak: 0.5,
    softness: 0.4,
    rowSpacing: 2,
    contrast: 0.85,
    strength: 0.6,
    parallaxDepth: -0.25,
  }),
  Object.freeze({
    density: 20,
    grainAngleDeg: 300,
    streak: 0.9,
    softness: 0.44,
    rowSpacing: 3,
    contrast: 0.85,
    strength: 0.55,
    parallaxDepth: 0.15,
  }),
]);

/**
 * A layer's soft window as the three floats its `uWindow` uniform carries —
 * `specular-pattern.js#softWindowParams`, with `contrast` clamped the way
 * `setLayerContrast` clamps it.
 * @param {number} contrast @returns {[number, number, number]} mid, sharp, peakInv
 */
function softWindowValues(contrast) {
  const { mid, sharp, peakInv } = softWindowParams(Math.min(1, Math.max(0, contrast)));
  return [mid, sharp, peakInv];
}

/**
 * THE PERFORMANCE-TIER LADDER — wired 2026-08-29.
 *
 * ============================================================================
 * THE GAP THIS CLOSES
 * ============================================================================
 * `specular.js#SPECULAR.tiers` has always declared five real rungs above the
 * presence floor (shimmer/parallax/life/islands/sunAndSky), each with a
 * `fromProfile` and a cost class — but `resolved.perfTier` was captured into
 * this effect's registration readout and dropped one step before it reached
 * `buildSpecularSurfaceMaterial`, so every rung ran unconditionally on every
 * profile. This is effect-cascade.js's own "14 effects declared a ladder
 * nobody read" shape, effect #15 — see docs/planning/
 * Effect-Tier-Gradient-Audit-2026-08-29.md for the audit that found it.
 *
 * `SPECULAR_DEFAULT_TIER` is asserted equal to what `DEFAULT_PERFORMANCE_
 * PROFILE` ('standard') actually resolves to (`effect-tier.test.mjs`'s own
 * anti-drift block) — which is 5, the top rung, so wiring this changes
 * NOTHING for anyone at standard/quality/extreme. Only `low`/`performance`
 * (both resolve to tier 3) lose `islands` and `sunAndSky` — a genuine,
 * intended look change for those two profiles, the whole point of the fix.
 */

/** The top rung `specular.js#SPECULAR.tiers` declares — five real rungs above
 * the unconditional presence floor. */
export const SPECULAR_MAX_TIER = 5;

/** The fallback tier for an unwired caller — see `specularTierPlan`'s own
 * header above. MUST equal what `resolveEffectTier(SPECULAR, {profile:
 * DEFAULT_PERFORMANCE_PROFILE})` resolves to; `effect-tier.test.mjs` pins it. */
export const SPECULAR_DEFAULT_TIER = 5;

/**
 * @param {number} [tier]
 * @returns {{tier: number, shimmerEnabled: boolean, parallaxEnabled: boolean,
 *   lifeEnabled: boolean, islandsEnabled: boolean, sunSkyEnabled: boolean}}
 */
export function specularTierPlan(tier) {
  const t = Number.isFinite(tier) ? Math.max(0, Math.min(SPECULAR_MAX_TIER, Math.floor(tier))) : SPECULAR_DEFAULT_TIER;
  return {
    tier: t,
    shimmerEnabled: t >= 1,
    parallaxEnabled: t >= 2,
    lifeEnabled: t >= 3,
    islandsEnabled: t >= 4,
    sunSkyEnabled: t >= 5,
  };
}

/**
 * Build the shimmer material.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.maskTexture - the authored `_Specular` file, RGBA, RAW bytes.
 *   ⚠️ Uploaded `NoColorSpace`: V2 decoded no transfer curve and every existing
 *   map was painted against that, so a "50% grey" texel means 0.5, not 0.21.
 * @param {*} args.islandPackTexture - `specular-islands.js`'s pack. RG = this
 *   texel's island parallax vector.
 * @param {*} args.illumTexture - `buf:scene.illum`.
 * @param {*} [args.depthTexture] - `buf:scene.depth`'s DEPTH attachment (a
 *   `THREE.DepthTexture`); null compiles the floor gate OUT entirely (a
 *   JS-time branch, never a uniform × 0) — see "THE FLOOR GATE" below for
 *   the STAGE 3 (2026-08-05) depth-authority gate this replaced `attrTexture`
 *   with, and why no flags/colour payload is needed alongside it.
 * @param {*} args.uViewRect - envLight's OWN view-rect uniform, shared rather
 *   than duplicated: two rects on different cadences is how two consumers of
 *   one frame stop agreeing where a world point is.
 * @param {*} args.uOutdoorsRect @param {*} args.outdoorsTexNode
 * @param {(TSL: *, args: object) => *} args.buildOutdoorsGate - injected, so
 *   "world XY → mask UV → sample" exists exactly once in the renderer.
 * @param {*} args.timeMsNode - THE shared clock (`uGlobalTimeMs`). Sim time, so
 *   the shimmer stops when Foundry pauses, like every other animation here.
 * @param {number} [args.tier] - the resolved performance-tier rung
 *   (`specularTierPlan`, above) — gates shimmer/parallax/life/islands/
 *   sunAndSky at JS-construction time. Defaults to `SPECULAR_DEFAULT_TIER`
 *   (today's unconditional look), so an unwired caller sees no change.
 * @param {*} [args.positionNode] - mythica-machina-press#538/#539: a per-
 *   TILE surface's LIVE tile-motion transform (`effects/tile-motion-nodes.js
 *   #buildTileMotionPositionNode`), assigned onto BOTH materials below so
 *   picking a debug channel never un-sticks the animation. `null`/omitted
 *   (every floor caller, today) leaves `positionNode` unset — byte-identical
 *   to this material's behaviour before this parameter existed. Every other
 *   `positionWorld` read in this file (the shimmer's world-space pattern,
 *   the illum sample, the floor gate) needs no change: once a live
 *   `positionNode` moves the vertex, THREE's own varying pass-through is
 *   what makes every fragment-stage `positionWorld` read follow it.
 * @param {*} [args.maskUvNode] - mythica-machina-press#538/#539: replaces
 *   the quad's own `uv()` as the base coordinate the crop (`uMaskUvBounds`)
 *   is applied to, for BOTH the mask sample and the island-pack sample
 *   (they already share one `maskUv` — see that node's own comment). A
 *   per-tile `texture`-mode surface passes `effects/tile-motion-nodes.js
 *   #buildTileMotionMaskUvNode`'s output here; every floor caller and every
 *   `transform`-mode/static tile omits it, leaving the lookup exactly
 *   `uv()` as before.
 * @returns {object} the material plus its setters.
 */
export function buildSpecularSurfaceMaterial({
  THREE,
  maskTexture,
  islandPackTexture,
  illumTexture,
  depthTexture = null,
  positionNode = null,
  maskUvNode = null,
  uViewRect,
  uOutdoorsRect,
  outdoorsTexNode,
  buildOutdoorsGate,
  timeMsNode,
  strength = SPECULAR_DEFAULT_STRENGTH,
  saturation = SPECULAR_DEFAULT_SATURATION,
  maskContrast = SPECULAR_DEFAULT_MASK_CONTRAST,
  patternScalePx = SPECULAR_DEFAULT_PATTERN_SCALE_PX,
  parallaxStrength = SPECULAR_DEFAULT_PARALLAX_STRENGTH,
  driftSpeed = SPECULAR_DEFAULT_DRIFT_SPEED,
  pulse = SPECULAR_DEFAULT_PULSE,
  shimmerGain = SPECULAR_DEFAULT_SHIMMER_GAIN,
  lightFloor = SPECULAR_DEFAULT_LIGHT_FLOOR,
  sunBias = SPECULAR_DEFAULT_SUN_BIAS,
  sheenCeiling = SPECULAR_SHEEN_CEILING,
  glintCeiling = SPECULAR_GLINT_CEILING,
  incidentSteepness = SPECULAR_INCIDENT_STEEPNESS,
  incidentKnee = SPECULAR_INCIDENT_KNEE,
  kneeSoftness = SPECULAR_KNEE_SOFTNESS,
  incidentGain = SPECULAR_INCIDENT_GAIN,
  flickerAmount = SPECULAR_FLICKER_AMOUNT,
  flickerSpeed = SPECULAR_FLICKER_SPEED,
  flickerScalePx = SPECULAR_FLICKER_SCALE_PX,
  flickerRoughness = SPECULAR_FLICKER_ROUGHNESS,
  reliefStrength = SPECULAR_DEFAULT_RELIEF_STRENGTH,
  reliefWidthPx = SPECULAR_DEFAULT_RELIEF_WIDTH_PX,
  mirrorDepth = SPECULAR_DEFAULT_MIRROR_DEPTH,
  glintFocus = SPECULAR_DEFAULT_GLINT_FOCUS,
  hotCore = SPECULAR_DEFAULT_HOT_CORE,
  colourResponse = SPECULAR_DEFAULT_COLOUR_RESPONSE,
  shapeTexture = null,
  cameraGlint = SPECULAR_DEFAULT_CAMERA_GLINT,
  reflectionBend = SPECULAR_DEFAULT_REFLECTION_BEND,
  sparkle = SPECULAR_DEFAULT_SPARKLE,
  sparkleSizePx = SPECULAR_DEFAULT_SPARKLE_SIZE_PX,
  panFlare = SPECULAR_DEFAULT_PAN_FLARE,
  tier = SPECULAR_DEFAULT_TIER,
}) {
  const TSL = THREE.TSL;
  const {
    // `Fn`/`If` are the PRESENCE GATE's own requirement, not decoration: TSL
    // control flow is a silent no-op outside `Fn()`, so the gate below both
    // wraps AND constructs its maths inside one.
    Fn,
    If,
    texture,
    uv,
    vec2,
    vec3,
    vec4,
    float,
    uniform,
    positionWorld,
    smoothstep,
    step,
    clamp,
    max,
    min,
    abs,
    dot,
    mix,
    cos,
    sin,
    exp,
    pow,
    floor,
    fract,
    // The engine's OWN linearisation, the same one `environmental-light.js`'s
    // composite uses — see `incident` below for why a matching curve, not a
    // tuned exponent, is what stops metal glowing in a dark room.
    sRGBTransferEOTF,
    dFdx,
    dFdy,
    length,
    normalize,
    sqrt,
    mx_worley_noise_float,
    mx_noise_float,
    mx_hsvtorgb,
  } = TSL;
  // `mrt` is deliberately NOT destructured — this pass draws into `scene.lit`,
  // a single-attachment target, and `MRTNode` matches its keys against the
  // BOUND target's texture names: a key with no match yields an EMPTY output
  // struct, i.e. no fragment output at all. Not importing the symbol is the
  // cheapest way to make a future edit reach for this note first.

  // THE TIER — see specularTierPlan's own header for the wiring history this
  // closes. Read ONCE, here, so every gate below (shimmer/parallax/life/
  // islands/sunAndSky) agrees on the same rung for this one material build.
  const plan = specularTierPlan(tier);

  const uStrength = uniform(float(strength));
  const uSaturation = uniform(float(saturation));
  const uMaskContrast = uniform(float(maskContrast));
  const uPatternScale = uniform(float(patternScalePx));
  const uParallaxStrength = uniform(float(parallaxStrength));
  const uDriftSpeed = uniform(float(driftSpeed));
  const uPulse = uniform(float(pulse));
  const uShimmerGain = uniform(float(shimmerGain));
  const uLightFloor = uniform(float(lightFloor));
  const uSunBias = uniform(float(sunBias));
  // ⚠️ ROUND 17 (2026-08-03) — these three were fixed internal constants
  // through ROUND 16; promoted to live uniforms on direct request ("give me
  // very high ranges to boost the brightness of it... I'll fine tune it")
  // after the channel probe showed the shipped defaults crushing an
  // ordinarily-lit point to a few thousandths of its EOTF'd brightness (see
  // `SPECULAR_INCIDENT_STEEPNESS`'s own doc in `specular-pattern.js` for the
  // arithmetic). Defaulting to the SAME constants means an unwired/older
  // caller renders byte-identical to before — only a caller that now passes
  // these explicitly (the subsystem, once wired) can move them.
  const uSheenCeiling = uniform(float(sheenCeiling));
  const uGlintCeiling = uniform(float(glintCeiling));
  const uIncidentSteepness = uniform(float(incidentSteepness));
  const uIncidentKnee = uniform(float(incidentKnee));
  const uKneeSoftness = uniform(float(kneeSoftness));
  const uIncidentGain = uniform(float(incidentGain));
  const uFlickerAmount = uniform(float(flickerAmount));
  const uFlickerSpeed = uniform(float(flickerSpeed));
  const uFlickerScalePx = uniform(float(flickerScalePx));
  const uFlickerRoughness = uniform(float(flickerRoughness));
  // THE METAL BODY's knobs, PACKED (effects/uniform-budget caps this file at
  // 40 uniform() calls): x relief strength, y relief width px, z mirror depth,
  // w glint focus. Its sibling below carries hot core + the sky response.
  const uMetalBody = uniform(vec4(reliefStrength, reliefWidthPx, mirrorDepth, glintFocus));
  const uReliefStrength = uMetalBody.x;
  const uReliefWidthPx = uMetalBody.y;
  const uMirrorDepth = uMetalBody.z;
  const uGlintFocus = uMetalBody.w;
  /** x hot core; (y, z) = (gain, broaden) from `outdoorGlintResponse(sky)` —
   * (1, 0) = clear sky, which is also what an unwired caller gets; w colour
   * response (see METAL BY COLOUR below). */
  const uGlintLook = uniform(vec4(hotCore, 1, 0, colourResponse));
  const uHotCore = uGlintLook.x;
  const uColourResponse = uGlintLook.w;
  /** Foundry's OWN readability floor (`ambient.darkness`, pulled toward black
   * by `darknessRealism01`) — see `setDarknessFloor` below for the full
   * account. Defaults to (0,0,0): a caller that never wires this gets the
   * byte-identical old behaviour, matching every other optional uniform here. */
  const uDarknessFloor = uniform(vec3(0, 0, 0));
  const uViewCentre = uniform(vec2(0, 0));
  /** The sun's azimuth as a unit XY vector. From the sky handle, never derived
   * from the hour here (`env/one-sun`). */
  // xy = the horizontal unit vector toward the sun; z = the 3-vector's own
  // vertical component (sin elevation), for the camera highlight (2026-11-02).
  const uSunDir = uniform(vec3(1, 0, 0.5));
  // THE PAN LOOK (2026-11-02, round 2) — x camera highlight, y reflection bend,
  // z sparkle, w pan flare. Packed: this file is at the uniform-budget cap.
  const uPanLook = uniform(vec4(cameraGlint, reflectionBend, sparkle, panFlare));
  // THE PAN STATE, pushed per frame by the subsystem: xy the camera's travel
  // direction (unit), z how fast (0..1, eased), w sparkle size in map px.
  const uPanState = uniform(vec4(1, 0, 0, sparkleSizePx));
  /** The crop's extent in mask-UV space. THE ENTIRE mask lookup — see `maskUv`. */
  const uMaskUvBounds = uniform(vec4(0, 0, 1, 1));
  /** STAGE 3 (2026-08-05) — `computeTieSafeExpectedDepth`'s result for THIS
   * quad's own background item's rank (`depth-authority.js#rankOf`), pushed
   * by `setExpectedDepth` on the SAME cadence `setFloorIndex` used to have
   * (a floor change). Defaults to 0: with the depth texture cleared to the
   * far plane (1) until the first real depth pass runs, `depthHere(1) >=
   * uExpectedDepth(0)` always holds, so an unwired/not-yet-synced caller
   * fails OPEN (visible) — the same posture `uFloorIndex01` never had to
   * think about because JS-time-compiling the gate out entirely was doing
   * that job instead. See "THE FLOOR GATE" below. */
  const uExpectedDepth = uniform(float(0));
  /** THE ISLAND PACK'S OWN BAKE STATUS, for debug channel 6 — added 2026-07-27
   * so "channel 6 is black" can never again mean three different things at
   * once. 0 = still the 1×1 placeholder (never baked — the mask never loaded,
   * or the bake threw). 1 = baked, but found zero surviving islands (the mask
   * genuinely has nothing that clustered past the size floor). 2 = baked with
   * real islands. Pushed by the subsystem; see `setIslandBakeStatus`. */
  const uIslandBakeStatus = uniform(float(0));

  const layers = SPECULAR_LAYER_DEFAULTS.map((d) => ({
    uDensity: uniform(float(d.density)),
    uGrain: uniform(vec2(Math.cos((d.grainAngleDeg * Math.PI) / 180), Math.sin((d.grainAngleDeg * Math.PI) / 180))),
    uStreak: uniform(float(d.streak)),
    uSoftness: uniform(float(d.softness)),
    uRowSpacing: uniform(float(d.rowSpacing)),
    // The soft window's (mid, sharp, peakInv) — derived from `contrast` on the
    // CPU (`softWindowParams`), so the shader never takes a logarithm. Written
    // by `setLayerContrast` and nowhere else.
    uWindow: uniform(vec3(...softWindowValues(d.contrast))),
    uLayerStrength: uniform(float(d.strength)),
    uParallaxDepth: uniform(float(d.parallaxDepth)),
  }));

  // ── THE MASK UV — the quad's own `uv()`, remapped by the crop ────────────
  // Live-measured (2026-07-27): the world→mask remap this replaced returned
  // pure black in every pixel while the SAME texture sampled through `uv()`
  // rendered the whole map's gold. `uv()` cannot exceed 0..1, so this lookup
  // cannot leave the texture — correct by construction rather than by an
  // arithmetic identity that has to hold across two functions.
  // ⚠️ `maskUvNode ?? uv()` (mythica-machina-press#538/#539) — a per-tile
  // `texture`-mode surface's own scrolled/rotated coordinate substitutes for
  // the raw quad UV here; every existing (floor) caller passes nothing and
  // gets exactly `uv()`, so this crop math is otherwise untouched.
  const baseMaskUv = maskUvNode ?? uv();
  const maskUv = vec2(
    mix(uMaskUvBounds.x, uMaskUvBounds.z, baseMaskUv.x),
    mix(uMaskUvBounds.y, uMaskUvBounds.w, baseMaskUv.y)
  ).toVar('specMaskUv');
  const maskTexNode = texture(maskTexture, maskUv);
  const maskSample = maskTexNode.toVar('specMaskSample');

  // ── THE DECODE (unconditional — ladder tier 0, 'presence') ───────────────
  // The transcription of `decodeSpecularMask`. RAW values, no transfer curve.
  const luma601 = dot(maskSample.rgb, vec3(LUMA_601[0], LUMA_601[1], LUMA_601[2])).toVar('specLuma');
  const maskAlpha = clamp(maskSample.a, 0, 1);
  // The alpha-missing fallback: a greyscale `_Specular` with no alpha is the
  // common authoring case and would otherwise decode to pure black.
  const rawStrengthNode = maskAlpha.lessThan(float(SPECULAR_ALPHA_EPSILON)).select(luma601, luma601.mul(maskAlpha));
  // THE SHADOW-CONTRAST CURVE (mythica-machina-press#432) — transcription of
  // `decodeSpecularMask`'s own `Math.pow(rawStrength, contrast)`. At the
  // default (1) this is an exact pass-through; `pow`'s own guard against a
  // zero/negative exponent lives on the JS side (`Math.max(contrast, 1e-3)`)
  // and is mirrored by `setMaskContrast`'s clamp below, so the uniform this
  // reads can never carry a degenerate value in the first place.
  const strengthNode = pow(rawStrengthNode, uMaskContrast).toVar('specStrength');
  const presence = smoothstep(float(SPECULAR_PRESENCE_EDGE0), float(SPECULAR_PRESENCE_EDGE1), strengthNode).toVar(
    'specPresence'
  );

  // Re-normalised so the tint carries `strength` as its OWN luma — gold and
  // grey painted at the same brightness return the same amount of light, in
  // different colours. A naive `rgb × strength` would darken saturated paint
  // twice, once for being dark and once for being coloured.
  const luma709 = max(dot(maskSample.rgb, vec3(LUMA_709[0], LUMA_709[1], LUMA_709[2])), float(1e-4));
  const colored = maskSample.rgb.mul(strengthNode.div(luma709));
  // ⚠️ CLAMPED AT 1, NOT 2 — FOUND AND FIXED 2026-08-03 (ROUND 16). The FOH
  // schema (`specular.js#SPECULAR_PARAMS.saturation`) has ALWAYS declared
  // `max: 2` with help text that ALREADY promised *"above 1 pushes the colour
  // further than you painted it"* — but this line silently discarded anything
  // past 1, so that documented control was dead on arrival: no author-facing
  // value could ever reach it. `mix(grey, colored, t)` for `t` in (1,2]
  // legitimately EXTRAPOLATES past `colored` (further from grey in the SAME
  // direction, i.e. genuine oversaturation, not a new formula) — this is
  // exactly the seam-declared-but-unwired shape
  // (`feedback_seam_default_hides_unwired`), just one line deeper than usual.
  // NOW LOAD-BEARING for a SEPARATE reason (ROUND 15's tonemap finding): the
  // global "Neutral" tonemap desaturates any pixel that enters its own
  // compression zone, pulling every channel toward the SAME achromatic value
  // by an amount independent of how saturated the input was — so a MORE
  // saturated input survives that pull with MORE residual saturation than a
  // less-saturated one. Oversaturating here is the direct, principled
  // countermeasure to a KNOWN, measured downstream effect, not a blind boost.
  const tint = mix(vec3(strengthNode, strengthNode, strengthNode), colored, min(uSaturation, float(2))).toVar(
    'specTint'
  );

  // ── THE ISLAND PACK ───────────────────────────────────────────────────────
  // ⚠️ These in-file section labels used to say "TIER N" as PIPELINE
  // CONSTRUCTION ORDER, NOT the performance ladder — a numbering collision
  // the 2026-08-29 wiring audit flagged as actively misleading once real
  // tier gates (`plan.*Enabled`) exist in this same file. Removed rather
  // than renumbered: the real ladder tier a piece of maths belongs to is
  // named inline instead (e.g. "ladder tier 4, 'islands'" below), which
  // cannot drift out of sync with `specular.js#SPECULAR.tiers` the way a
  // second hand-maintained numbering could.
  //
  // ⚠️ SAMPLED AT THE UNSHIFTED COORDINATE, ALWAYS. Reading the pack through a
  // parallax-shifted uv is a feedback loop — the offset would depend on a texel
  // the offset chose — and it bleeds one island's motion across its neighbour's
  // boundary. The pack answers "which island owns THIS texel", which is a
  // question about where the texel is, not about where its pattern has slid to.
  //
  // ⚠️ UNCONDITIONAL, even below ladder tier 4 ('islands') — `packTexNode`
  // must always exist as a real texture-sampling node so `setIslandPackTexture`
  // has something to re-point on a bake, and the debug material's own
  // `islands`/`islandMotion` channels read it directly regardless of tier (a
  // developer picking those channels wants the real pack, not a stand-in).
  // What the REAL material sees is decided just below, at
  // `effectiveIslandParallax`.
  const packTexNode = texture(islandPackTexture, maskUv);
  const packSample = packTexNode.toVar('specPack');
  // Decoded from the byte encoding -- see `ISLAND_PARALLAX_RANGE` for why this
  // pack is bytes rather than floats (a live read-zero bug, and the same format
  // fluid's pack still uses).
  const islandParallax = packSample.rg
    .mul(float(2 * ISLAND_PARALLAX_RANGE))
    .sub(vec2(ISLAND_PARALLAX_RANGE, ISLAND_PARALLAX_RANGE))
    .toVar('specIsland');
  // LADDER TIER 4 ('islands') — below it, every texel takes the GLOBAL
  // parallax `(1, 0)`, the SAME placeholder value `specular-surface-
  // subsystem.js` uploads before any pack has baked (see that file's own
  // comment on the 1×1 placeholder) — so a tier-4 downgrade looks EXACTLY
  // like "no island pack baked yet", a state this shader already renders
  // correctly. This is a JS-time ternary choosing which NODE feeds the real
  // material's graph: below tier 4, `packTexNode`'s texture READ is never
  // reached by walking from `specularMaterial.colorNode` and is not compiled
  // into that material's shader at all — only into the always-real debug
  // material above, which already reads `islandParallax` directly.
  const effectiveIslandParallax = plan.islandsEnabled ? islandParallax : vec2(1, 0);

  // ── PATTERN SPACE ──────────────────────────────────────────────────────
  const tSec = timeMsNode.mul(float(0.001)).toVar('specTimeSec');
  const patternScale = max(uPatternScale, float(1)).toVar('specPatternScale');
  const worldUv = vec2(positionWorld.x, positionWorld.y).div(patternScale);
  // LADDER TIER 2 ('parallax'). `uViewCentre × islandParallax × strength /
  // patternScale` — at depth 1 this is V2's measured ≈1:1 world-space slide,
  // i.e. very nearly screen-locked. V2 buried the same relationship in a
  // magic 0.0006 that only came out at 1:1 because it cancelled against a
  // pattern scale of 16384. Below tier 2 the whole offset is zero — a
  // JS-time ternary, not a zeroed uniform, so the pattern is genuinely
  // camera-static.
  const parallaxBase = (
    plan.parallaxEnabled
      ? uViewCentre.mul(effectiveIslandParallax).mul(uParallaxStrength).div(patternScale)
      : vec2(0, 0)
  ).toVar('specParallax');
  // LADDER TIER 3 ('life'), drift half — the pulse half lives inside
  // `buildShimmerTerms` below, next to the term it modulates. ⚠️ TRAVEL, NOT A
  // PER-PIXEL DIRECTION × TIME. The drift is ONE vector, identical for every
  // pixel, which is what makes an unbounded `× tSec` safe. A per-pixel
  // direction multiplied by unbounded time fans out around every convex
  // feature and shipped live as "barcodes radiating from all surfaces"
  // (`water-field.js`'s own boxed warning, learned the expensive way).
  const drift = (plan.lifeEnabled ? vec2(float(0.8), float(0.6)).mul(uDriftSpeed.mul(tSec)) : vec2(0, 0)).toVar(
    'specDrift'
  );

  // ── OUTDOORS ─────────────────────────────────────────────────────────────
  // The SAME world-space read `buf:scene.attr`'s G channel uses — injected, so
  // there is exactly one copy of it. Null means no mask at all, which reads as
  // indoors, matching what `packFloorAttr` chooses for the same input.
  const outdoorsNode = buildOutdoorsGate(TSL, { uOutdoorsRect, outdoorsTexNode });
  const outdoors = (outdoorsNode ?? float(0)).toVar('specOutdoors');

  /** V2's hash12, transcribed. The sin form rather than `TSL.hash`, matching
   * `gust-runtime.js`'s own precedent — a two-line hash is the only kind that
   * can be transcribed into a CPU twin with confidence both sides agree.
   * @param {*} p @returns {*} */
  function hash12(p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))).mul(float(43758.5453)));
  }

  /**
   * ONE CELL'S BLOB EXPONENT — `specular-pattern.js#cellBlobExponent`.
   * @param {*} cell this cell's lattice index (vec2)
   * @param {*} off the point's offset from THIS cell's centre, in cells (vec2)
   * @param {*} rows @param {object} L @param {*} spreadMul
   * @returns {*}
   */
  function cellBlobExponent(cell, off, rows, L, spreadMul) {
    return cellBlobFn(cell, off, rows, L.uStreak, spreadMul);
  }
  // A SHARED layout function (`core/tsl-fn.js`): four cells x every shine layer called it, and each call was a
  // pasted copy of three hashes and a rotation (12 copies in one surface-response shader). It reads only its
  // arguments, so one function serves every layer and every shader.
  const cellBlobFn = sharedFn(
    TSL,
    'msaSpecCellBlob',
    { cell: 'vec2', off: 'vec2', rows: 'float', streak: 'float', spreadMul: 'float' },
    'float',
    ({ cell, off, rows, streak, spreadMul }) => cellBlobExponentBody(cell, off, rows, streak, spreadMul)
  );
  function cellBlobExponentBody(cell, off, rows, streak, spreadMul) {
    // ⚠️ ROTATE BEFORE THE STRETCH. Rotating a circle then stretching gives a
    // skewed ellipse with a real orientation; stretching then rotating gives
    // the same ellipse every time, merely turned — every glint on the map ends
    // up identically oriented, the lattice becomes readable, and it reads as
    // wallpaper. This ordering IS the streaking.
    const rot = hash12(cell.add(vec2(17.3, 91.7)))
      .sub(float(0.5))
      .mul(streak)
      .mul(float(STREAK_RADIANS));
    const c = cos(rot).toVar();
    const s = sin(rot).toVar();

    // Per-cell jitter, so the lattice is not readable as a grid.
    const jx = hash12(cell.add(vec2(127.1, 311.7)))
      .sub(float(0.5))
      .mul(float(CELL_JITTER));
    const jy = hash12(cell.add(vec2(269.5, 183.3)))
      .sub(float(0.5))
      .mul(float(CELL_JITTER));
    const rx = off.x.mul(c).sub(off.y.mul(s)).sub(jx);
    const ry = off.x.mul(s).add(off.y.mul(c)).sub(jy);
    const sy = ry.mul(rows);
    return rx.mul(rx).add(sy.mul(sy)).mul(spreadMul);
  }

  /** `specular-pattern.js#smoothMin` — `min(a, b)` exactly where the two differ
   * by `BLOB_BLEND_WIDTH` or more, a C¹ blend where they are closer.
   * @param {*} a @param {*} b @returns {*} */
  function smoothMin(a, b) {
    const w = float(BLOB_BLEND_WIDTH);
    const h = max(w.sub(abs(a.sub(b))), float(0)).div(w);
    return min(a, b).sub(h.mul(h).mul(w).mul(float(0.25)));
  }

  /**
   * THE BLOB FIELD'S EXPONENT — `specular-pattern.js#blobExponent`: the smooth
   * union of the four cells the point leans toward, so no blob is ever cut at a
   * cell border (the straight-edged slices the lab measured at a 0.59
   * display-luminance step in one pixel). Four is exact, not a heuristic — the
   * header of the pattern module and `softWindow`'s cut carry the proof.
   * @param {*} p @param {object} L @returns {{e: *, spreadMul: *}}
   */
  function blobExponent(p, L) {
    const rows = max(L.uRowSpacing, float(MIN_ROW_SPACING));
    const scale = max(L.uDensity, float(0.25));
    const perp = vec2(L.uGrain.y.negate(), L.uGrain.x);
    const along = dot(p, L.uGrain).mul(scale);
    const across = dot(p, perp).mul(scale).div(rows);

    const cell = vec2(floor(along), floor(across)).toVar();
    const off = vec2(along.sub(cell.x).sub(float(0.5)), across.sub(cell.y).sub(float(0.5))).toVar();
    // ±1 per axis: which side of its own cell's centre this point leans toward.
    // ARITHMETIC (`step`), not `select()` — this file's standing rule.
    const lean = vec2(
      step(float(0), off.x).mul(float(2)).sub(float(1)),
      step(float(0), off.y).mul(float(2)).sub(float(1))
    ).toVar();
    const dx = vec2(lean.x, float(0));
    const dy = vec2(float(0), lean.y);
    const spreadMul = mix(float(SPREAD_TIGHT), float(SPREAD_LOOSE), clamp(L.uSoftness, 0, 1)).toVar();

    const e00 = cellBlobExponent(cell, off, rows, L, spreadMul);
    const e10 = cellBlobExponent(cell.add(dx), off.sub(dx), rows, L, spreadMul);
    const e01 = cellBlobExponent(cell.add(dy), off.sub(dy), rows, L, spreadMul);
    const e11 = cellBlobExponent(cell.add(dx).add(dy), off.sub(dx).sub(dy), rows, L, spreadMul);
    return { e: smoothMin(smoothMin(e00, e10), smoothMin(e01, e11)).toVar(), spreadMul };
  }

  /**
   * THE SOFT WINDOW — `specular-pattern.js#softWindow`: a logistic in the blob's
   * exponent instead of a thresholded `smoothstep`, so a glint's edge is an
   * exponential skirt and not a cut. `L.uWindow` is (mid, sharp, peakInv).
   * @param {*} e @param {object} L @param {*} spreadMul @returns {*}
   */
  function softWindow(e, L, spreadMul) {
    const x = min(L.uWindow.y.mul(e.sub(L.uWindow.x)), float(SOFT_EXP_CLAMP));
    const s = min(float(1), L.uWindow.z.div(float(1).add(exp(x))));
    // Fade to exactly zero where the four-cell neighbourhood stops being exact
    // — `specular-pattern.js#blobCutExponent`, minus the blend width.
    const cut = spreadMul.mul(float(BLOB_REACH_MIN_DISTANCE * BLOB_REACH_MIN_DISTANCE)).sub(float(BLOB_BLEND_WIDTH));
    return s.mul(float(1).sub(smoothstep(cut.mul(float(BLOB_CUT_ONSET)), cut, e)));
  }

  /**
   * How much a layer's grain is favoured by the sun's azimuth — the ONLY route
   * the sun's direction has into this effect, since there is no half-vector to
   * put it in. A brushed surface throws its highlight ACROSS the grooves, hence
   * the perpendicular. Faded to 1 indoors, where there is no azimuth to be
   * relative to.
   * @param {object} L @returns {*}
   */
  function sunGrainBias(L) {
    // LADDER TIER 5 ('sunAndSky') — below it, no bias: every layer reads as
    // if grain angle never mattered to the sun, exactly what tier 4 already
    // draws (nothing here touches the composite below this rung).
    if (!plan.sunSkyEnabled) return float(1);
    const perp = vec2(L.uGrain.y.negate(), L.uGrain.x);
    const d = abs(dot(uSunDir.xy, perp));
    const bias = mix(float(SUN_BIAS_MIN), float(1), clamp(d, 0, 1));
    return mix(float(1), bias, outdoors.mul(uSunBias));
  }

  /** One full shimmer layer: its own parallax depth, seamless blob field, soft
   * window, sun bias. @param {object} L @returns {*} */
  function shimmerLayer(L) {
    const p = worldUv.sub(parallaxBase.mul(L.uParallaxDepth).mul(bendParallax)).add(drift).add(bendOffset);
    const { e, spreadMul } = blobExponent(p, L);
    return softWindow(e, L, spreadMul).mul(sunGrainBias(L)).mul(L.uLayerStrength);
  }

  // ── THE CELLULAR BASE — where the mask acts like roughness ───────────────
  // `cellScale = mix(2.5, 13, strength)`: a BRIGHTER mask gets FINER cells, so
  // a polished gold inlay breaks into fine glitter while dull pewter reads as
  // broad soft shapes — from one authored channel and no second mask. This is
  // V2's one roughness-like coupling and it is easy to miss in its source.
  //
  // Voronoi × Perlin, from the vendored MaterialX nodes rather than a
  // hand-rolled twin (Law 8, and it fixes a V2 bug for free: its CPU-baked 256²
  // noise texture had a wrap seam in the channel whose comment claimed it
  // tiled). The third coordinate is a slow time, the standard way to animate 2D
  // noise without a domain-warp fan.
  /**
   * EVERY EXPENSIVE PER-PIXEL TERM IN THIS EFFECT, IN ONE PLACE.
   *
   * Extracted 2026-07-28 (the performance audit) so it can be built TWICE from
   * ONE source: once inside the presence gate below for the real material, and
   * once ungated for the debug material's channels. Two hand-maintained copies
   * of this maths would be a `feedback_mode_forks_silently_drop_features` in
   * waiting — a tuning change landing in the shipped path but not the
   * diagnostic would make the diagnostic lie about the very thing it exists to
   * explain.
   *
   * Building it twice costs nothing at runtime: a node subgraph only emits into
   * a shader that actually reaches it, so the ungated copy exists only in the
   * debug material's WGSL.
   * @returns {{cellular: *, layered: *, shimmer: *}}
   */
  function buildShimmerTerms() {
    const cellScale = mix(float(CELL_SCALE_DULL), float(CELL_SCALE_BRIGHT), clamp(strengthNode, 0, 1));
    const basePos = vec3(
      worldUv.x
        .sub(parallaxBase.x.mul(float(0.35)))
        .add(drift.x)
        .mul(cellScale),
      worldUv.y
        .sub(parallaxBase.y.mul(float(0.35)))
        .add(drift.y)
        .mul(cellScale),
      tSec.mul(float(0.02))
    );
    // THE DOMINANT COST OF THE WHOLE EFFECT: a 3D Worley is a 3x3x3 = 27-cell
    // neighbourhood search, and `mx_noise_float` adds a 3D Perlin on top.
    const cellularTerm = smoothstep(
      float(0.28),
      float(0.72),
      mx_worley_noise_float(basePos, 1).mul(mx_noise_float(basePos).mul(float(0.5)).add(float(0.5)))
    ).toVar('specCellular');

    // ── COMBINE ────────────────────────────────────────────────────────────
    // ⚠️ MAX, NOT SUM, ACROSS LAYERS — corrected 2026-07-27 (three layers at
    // the time; six since Round 19, 2026-08-03 — the mechanism did not need
    // to change to accept more of them). A raw sum of independently-firing
    // layers STACKS wherever several happen to overlap (up to N× the
    // brightest single layer, right at the moment they all coincide), which
    // is precisely where the composite is most likely to blow past what the
    // shared tonemap can render without compressing — i.e. exactly the
    // "washed out" hot spots the live report named. MAX takes the brightest
    // contributor at each texel instead of stacking them, which is what
    // makes each layer read as its OWN distinct texture sharing one surface
    // rather than N lights adding up on it — the same property that made it
    // safe to DOUBLE the layer count later purely for more variety, with no
    // re-tuning of the ceilings this composite feeds into. Non-overlapping
    // regions (most of the area, since the layers sit at different parallax
    // depths and grain angles) are UNCHANGED: `max(a, 0, 0, ...) = a`,
    // identical to `sum`.
    //
    // ⚠️ NOW A 6-NORM, NOT A LITERAL `max` (soft-edge rework, 2026-10-18).
    // `max` has a crease wherever two layers' skirts cross, and with the shine
    // gain behind it that crease reads as a thin hard line — the exact thing
    // this pass must not draw. `(Σ vᵖ)^(1/p)` at p = 6 is within 12 % of `max`
    // wherever one layer dominates (so the paragraph above still holds — two
    // equal layers stack by 2^(1/6) = 1.12, not by 2) and smooth everywhere
    // else. `specular-pattern.js#unionLayers` is the twin.
    const raiseToUnionPower = (v) => {
      let r = v;
      for (let i = 1; i < LAYER_UNION_POWER; i++) r = r.mul(v);
      return r;
    };
    let layerPowerSum = raiseToUnionPower(shimmerLayer(layers[0]).toVar());
    for (let i = 1; i < SPECULAR_LAYER_COUNT; i++) {
      layerPowerSum = layerPowerSum.add(raiseToUnionPower(shimmerLayer(layers[i]).toVar()));
    }
    // 1e-37 (a normal f32) rather than 0: the root of an exact zero is the one
    // input `pow` is not defined for on every backend.
    const layeredTerm = pow(max(layerPowerSum, float(1e-37)), float(1 / LAYER_UNION_POWER));
    // LADDER TIER 3 ('life'), pulse half — see `drift`'s own comment above
    // for the other half. Below tier 3 this is a constant 1 (no breathing).
    const pulseNode = plan.lifeEnabled
      ? float(1)
          .sub(uPulse)
          .add(
            uPulse.mul(
              sin(tSec.mul(float(0.37)))
                .mul(float(0.5))
                .add(float(0.5))
            )
          )
      : float(1);
    // ⚠️ THE UNCONDITIONAL TAIL SHRANK FROM 0.22 TO 0.05 — corrected
    // 2026-07-27. `cellular` is a continuous field with genuine dark valleys
    // (its own smoothstep already clips ~28% of its range to exactly 0), but
    // wherever it IS nonzero this term used to add brightness regardless of
    // whether any authored LAYER was actually present — a broad, low-level
    // floor sitting UNDER the whole shimmer, independent of
    // density/streak/contrast tuning. That is a second, quieter contributor to
    // the same "everywhere glows a little" report the layer combine above
    // targets. A small trace survives rather than deleting the term outright:
    // it is what keeps the cellular TEXTURE faintly legible in the gaps between
    // layer peaks, which is the whole reason it rides UNDER the layers.
    const shimmerTerm = layeredTerm
      .mul(cellularTerm.mul(float(0.45)).add(float(0.55)))
      .add(cellularTerm.mul(float(0.05)))
      .mul(pulseNode);
    return { cellular: cellularTerm, layered: layeredTerm, shimmer: shimmerTerm };
  }

  // ── THE PRESENCE GATE ────────────────────────────────────────────────────
  // MEASURED 2026-07-28: this pass cost 3.4 ms, ~6x its own declared budget,
  // and its cost is ~93% fill (see docs/planning/Performance-Insights.md §3).
  // Every term above ran on EVERY pixel the quad covers and was then multiplied
  // by `coverage` (= `presence` x visibility) at the very end — so on this
  // scene roughly 70% of shaded pixels paid a 27-cell Worley, a 3D Perlin and
  // three shimmer layers to be multiplied by exactly zero. ⚠️ Measured at
  // three layers (2026-07-28); the layer count doubled to six Round 19
  // (2026-08-03) — the GATE below still skips the whole cost regardless of
  // how many layers exist, but the absolute ms figure has not been
  // re-measured against six.
  //
  // ⚠️ WHY THE GATE HAD TO MOVE THE MATHS INSIDE `Fn()`, NOT JUST WRAP IT.
  // `specularMaterial.colorNode` is a FLAT node graph, and TSL's `If()` is a
  // silent no-op outside `Fn()` (`keyhole-region-discard-noop-bug`) — an
  // earlier plan to "just add an If()" would have compiled, changed nothing,
  // measured nothing and looked like a fix. Equally, wrapping while leaving the
  // `.toVar()` terms built in the outer scope would have hoisted them straight
  // back out of the branch. The maths is CONSTRUCTED inside the callback, which
  // is the only arrangement that actually skips it.
  //
  // Visually lossless by construction: the gated-off value is 0, and 0 is
  // exactly what `shimmer * coverage` already produced there.
  // LADDER TIER 1 ('shimmer') — GATED HERE, AT JS-CONSTRUCTION TIME
  // (Effects.md Law 4): below tier 1, `buildShimmerTerms()` — the 27-cell
  // Worley + Perlin cellular base, "THE DOMINANT COST OF THE WHOLE EFFECT"
  // per that function's own header — is never even CALLED for THIS, the
  // real material, so none of it compiles into the shipped shader. The
  // debug material's own `cellular`/`shimmer` channels (below) call it
  // separately and are deliberately left ungated — see that call's own
  // comment.
  // ── THE SHAPE (2026-11-02, round 2) — the mask's broad form ─────────────
  // `specular-shape.js` bakes the blurred height's slope once per mask; here it
  // is turned from MASK axes into WORLD axes through the quad's own affine
  // derivatives (so a rotated or flipped tile still bends the right way), and
  // it feeds the bent reflections, the camera highlight and the sparkle. No
  // shape texture (an older caller) or below the shimmer tier → compiled out.
  // Top level, ON PURPOSE: derivatives need uniform control flow, and the
  // shimmer below reads these from inside its presence `If`.
  const dWorldX = dFdx(positionWorld.x);
  const dWorldY = dFdy(positionWorld.y);
  const safeDiv = (d) => abs(d).lessThan(float(1e-6)).select(float(1e-6), d);
  const uvPerWorldX = dFdx(maskUv).div(safeDiv(dWorldX)).toVar('specUvPerWorldX');
  const uvPerWorldY = dFdy(maskUv).div(safeDiv(dWorldY)).toVar('specUvPerWorldY');
  const shapeEnabled = plan.shimmerEnabled && !!shapeTexture;
  const shapeTexNode = shapeEnabled ? texture(shapeTexture, maskUv) : null;
  const shapeSlopeW = (
    shapeEnabled
      ? (() => {
          const sMask = shapeTexNode.rg.mul(float(2)).sub(vec2(1, 1));
          const ax = uvPerWorldX.div(max(length(uvPerWorldX), float(1e-9)));
          const ay = uvPerWorldY.div(max(length(uvPerWorldY), float(1e-9)));
          return vec2(dot(sMask, ax), dot(sMask, ay));
        })()
      : vec2(0, 0)
  ).toVar('specShapeSlope');
  // REFLECTION BEND: a curved mirror shows the world displaced by its own
  // slope, and the displacement grows as the eye moves — so each layer is
  // offset by the slope and its parallax is quickened on the steep flanks.
  // Reflections then curve around coins and domes and swirl as you pan.
  const bendOffset = shapeSlopeW
    .mul(uPanLook.y.mul(float(BEND_PX)))
    .div(patternScale)
    .toVar('specBendOffset');
  const bendParallax = float(1)
    .add(length(shapeSlopeW).mul(uPanLook.y).mul(float(BEND_PARALLAX)))
    .toVar('specBendPar');

  const shimmer = plan.shimmerEnabled
    ? Fn(() => {
        const out = float(0).toVar('specShimmerGated');
        If(presence.greaterThan(float(0)), () => {
          out.assign(buildShimmerTerms().shimmer);
        });
        return out;
      })().toVar('specShimmer')
    : float(0).toVar('specShimmer');

  // UNGATED, for the debug material only — see buildShimmerTerms' own header.
  // Deliberately ungated: channel 'cellular' exists to show whether the noise
  // FIELD is alive at all, and gating it would black out everywhere the mask is
  // unpainted — turning a "the field is dead" answer and a "there is no metal
  // here" answer into the same picture, which is the exact failure
  // `feedback_instruments_must_not_lie` names. The debug material is separate
  // and only built for a picked channel, so its cost is irrelevant.
  // (`layered` is returned by the builder but unused here — the debug channels
  // read `cellular` and the GATED `shimmer`, which is what actually ships.)
  const cellular = buildShimmerTerms().cellular;

  // ── (combine moved into buildShimmerTerms above) ─────────────────────────
  // ── THE LIGHT ────────────────────────────────────────────────────────────
  // `buf:scene.illum` at this fragment's own screen position — the exact
  // inverse of `buildOutdoorsGate`'s screen→world mapping, so the two provably
  // agree about where a world point lands on screen. A genuine upgrade on V2,
  // which sampled no lighting buffer at all and rebuilt up to 64 analytic light
  // discs in the shader; this is the real accumulation, wall-clipped, with
  // region darkness already applied.
  const viewSpanX = max(uViewRect.z.sub(uViewRect.x), float(1)).toVar('specViewSpanX');
  const viewSpanY = max(uViewRect.w.sub(uViewRect.y), float(1));
  const screenU = positionWorld.x.sub(uViewRect.x).div(viewSpanX);
  const screenV = positionWorld.y.sub(uViewRect.y).div(viewSpanY);
  const screenUv = vec2(clamp(screenU, 0, 1), clamp(screenV, 0, 1));
  const illumTexNode = texture(illumTexture);
  const illumSample = illumTexNode.sample(screenUv).rgb;
  // ═══════════════════════════════════════════════════════════════════════
  // ⚠️ FOUNDRY'S READABILITY FLOOR IS NOT LIGHT — SUBTRACTED BEFORE ANYTHING
  // ELSE. Root-caused 2026-07-27 by the author, unaided, from debug channel
  // 19 alone: *"[19 is] grey to white, not black to white, so if the grey
  // parts are boosting brightness as well as white then that might result in
  // a global floor lift"* — then confirmed by testing `MapShine.setDarkness
  // Realism(1)` and watching metal correctly go black.
  // ─────────────────────────────────────────────────────────────────────────
  // `buf:scene.illum` never reaches 0 in an unlit room: Foundry deliberately
  // floors the darkest the scene gets at `ambient.darkness` (this scene's is
  // `[0.188]³`) so GMs/players can still read the map — see
  // `environmental-light.js#computeAmbientBackground`'s own header. That floor
  // is a UI accommodation, not narrative light, and nothing that represents a
  // PHYSICAL reflection should treat it as something to reflect. `uDarknessFloor`
  // is exactly that endpoint, pulled toward black by the SAME
  // `darknessRealism01` lever the rest of the renderer already uses
  // (`vt-pan-viewer.js#runLightAccumulatePass`, the identical value pushed into
  // `uRegionDarknessColor`) — so this tracks whatever realism the author has
  // chosen automatically, with no second control: at `realism=1` the floor IS
  // black, the subtraction is a no-op, and behaviour is UNCHANGED from what the
  // author already tested and confirmed correct.
  //
  // Subtracting (never dividing or gating) is what keeps REAL light additive on
  // top of the floor: a torch in an otherwise-floored room still lifts `illum`
  // above `uDarknessFloor` by its own true contribution, and only that excess
  // reaches `incident`. Clamped at 0 because point lights only ever raise
  // `illum` (MAX-blended), so the floor is a lower bound, never crossed except
  // by floating-point noise this `max` absorbs for free.
  const illumAboveFloor = max(illumSample.sub(uDarknessFloor), vec3(0, 0, 0)).toVar('specIllumAboveFloor');
  // `uLightFloor` DEFAULTS TO 0 — see `SPECULAR_DEFAULT_LIGHT_FLOOR`'s own
  // corrected header for the live bug this default used to cause (metal
  // reading as self-illuminating in genuinely dark rooms). This `max()` is an
  // author-adjustable stylised floor now, not a structural guard: real light —
  // point lights, window light, the sky's own day/night mix — already reaches
  // `illum` before this pass runs, with no floor required to see it.
  const incidentRaw = max(illumAboveFloor, vec3(uLightFloor, uLightFloor, uLightFloor)).toVar('specIncidentRaw');
  // ═══════════════════════════════════════════════════════════════════════
  // ⚠️ THE ENGINE'S OWN TRANSFER CURVE — NOT A TUNED EXPONENT.
  // ═══════════════════════════════════════════════════════════════════════
  //
  // THIS IS THE FIX FOR "METAL SELF-ILLUMINATES IN THE DARK", measured rather
  // than guessed (2026-07-27, probe channels 12 vs 20 plus the author's own
  // reading of channel 20: *"it's grey to white, not black to white, so if the
  // grey parts are boosting brightness as well as white then that might result
  // in a global floor lift"* — exactly right, and this is why).
  //
  // `buf:scene.illum` does NOT reach 0 in an unlit room. Foundry's own
  // `ambientDarkness` is baked into it upstream, so a genuinely dark interior
  // measures ~0.19, not 0. Meanwhile `environmental-light.js` renders the
  // scene through a GAMMA-SPACE multiply:
  //
  //     lit = EOTF( OETF(albedo) x illum )
  //
  // so at that same pixel the visible surface lands at
  // `EOTF(OETF(0.730) x 0.188)` ≈ 0.019 — while this pass, adding in LINEAR
  // space straight off `illum`, was contributing ~0.03-0.12. Metal came out
  // 2-6x BRIGHTER than the surface it sits on. THIS PART is a UNIT MISMATCH,
  // not a missing gate — it is true at every illum value, lit or unlit, and
  // the fix below is a CURVE, not a subtraction. (`uDarknessFloor`, subtracted
  // ABOVE this comment, is a separate, second effect — Foundry's readability
  // floor specifically — and the two compose: floor removes what should never
  // have counted as light at all, EOTF then correctly scales what remains.)
  //
  // The correct factor falls straight out of the composite above: set
  // `albedo = 1` (a perfectly white surface) and `OETF(1) = 1`, leaving
  // `lit = EOTF(illum)`. So `EOTF(illum)` IS "what fraction of full brightness
  // does ANYTHING render at under this illumination" — in exactly the linear
  // space this pass adds into. Nothing is invented; it is the same curve the
  // rest of the frame already obeys.
  //
  // It replaces a hand-tuned `pow(luma, 1.7)` that was aimed at this symptom
  // and was simply too weak (0.188^1.7 = 0.058, still ~3x the surroundings;
  // the real EOTF gives 0.025, ~1.3x). Applying it PER CHANNEL rather than to
  // one luma scalar is deliberate and is not the hue-shift trap
  // (`feedback_...luminance` reasoning used for the CEILING below): this is the
  // literal inverse of the OETF the albedo path already takes per channel, so
  // matching it channel-for-channel is what keeps a coloured light's own tint
  // identical to what the scene shows. A luma-based version here would be the
  // deviation, not the safeguard.
  const incident = sRGBTransferEOTF(incidentRaw).toVar('specIncident');

  // ═══════════════════════════════════════════════════════════════════════
  // ⚠️ A SEPARATE, ARTISTIC GATE — NOT ANOTHER EXPONENT ON `incident` ITSELF.
  // ═══════════════════════════════════════════════════════════════════════
  // ROUND 16 (2026-08-03), live report: "we only get a specular shine in the
  // brighter areas of the map, near candles, point lights or outside at
  // noon. Shadows and lack of light should suppress the specular shine."
  //
  // `incident` above MUST stay exactly `EOTF(illumAboveFloor)` — its own
  // header explains why: that is the unique value that keeps metal's
  // brightness response synchronised with how the REST of the frame renders
  // under the same light, and "do not reintroduce a free exponent here"
  // means exactly this term. This is a DIFFERENT thing: a later, stylistic
  // multiplier — the same relationship the ceilings below already have to
  // the composite — that reads `incident` and decides how much of the
  // SHINE EFFECT's own highlight to let through, not how bright the pixel
  // physically is. `steepenIncidentRgb`'s own header in `specular-pattern.js`
  // has the full account, including why this is luminance-scaled rather than
  // per-channel (a colour-fidelity guard, not a brightness one).
  const incidentLuma = max(dot(incident, vec3(LUMA_709[0], LUMA_709[1], LUMA_709[2])), float(1e-6)).toVar(
    'specIncidentLuma'
  );
  // ⚠️ THE KNEE (2026-08-09) — `SPECULAR_INCIDENT_KNEE`'s own header carries
  // the bench measurement that forced it (metal algebraically dead below
  // illum ≈ 0.75, contrast exactly 1.000). In one line: `pow(x, S)` reaches 1
  // only at `x == 1`, so "full shine" was anchored at a perfectly white
  // fully-bright pixel, which no light in this engine short of noon sun
  // produces. `uIncidentKnee` moves that anchor down to a light level that
  // real lamps actually reach.
  //
  // ⚠️ THIS IS ALGEBRAICALLY IDENTICAL TO THE PREVIOUS CODE AT `knee == 1`,
  // which is what makes it safe to add under the author's live-tuned
  // steepness rather than a retune of it. Old: `mul = steepened/luma`, where
  // `steepened = luma^S + max(luma-1,0)`. For `luma <= 1` that is `luma^(S-1)`;
  // for `luma > 1` it is `luma/luma = 1`. New: `mul = min(luma/K,1)^(S-1)`,
  // which at `K = 1` is `min(luma,1)^(S-1)` — the same two branches, with the
  // saturating `min` replacing the explicit excess bookkeeping instead of
  // running alongside it.
  //
  // ⚠️ THE HARD `min(t,1)` IS ALSO WHY THE FLICKER DISAPPEARED (author, live,
  // 2026-08-09: *"No sign of candle flicker animation on specular surfaces"*,
  // reported in the same breath as *"far too much"* brightness). Both are ONE
  // symptom: once a candle's light clears the knee, `min` pins the response at
  // exactly 1 — so the shine is simultaneously clamped at maximum AND perfectly
  // FLAT, and the light's own flicker can no longer modulate anything. A curve
  // that saturates absolutely cannot transmit variation through the saturated
  // region. `uKneeSoftness` mixes that hard clamp toward an exponential
  // approach that NEVER quite reaches 1, so brightness rolls off gracefully
  // instead of clipping and the flicker keeps living all the way up.
  //
  // `1 - exp(-t)` rather than the textbook soft-min `t/(1+t^(1/s))^s`: that
  // form needs `pow` with an exponent of `1/s`, which for a small softness is
  // ~50 and overflows float32 for any `t` past a handful. This one is
  // unconditionally safe (the argument to `exp` is never positive), and
  // softness 0 still reproduces the hard clamp exactly.
  const kneeRaw = incidentLuma.div(max(uIncidentKnee, float(1e-4))).toVar('specKneeRaw');
  const kneeT = mix(
    min(kneeRaw, float(1)),
    float(1).sub(exp(kneeRaw.negate())),
    clamp(uKneeSoftness, float(0), float(1))
  ).toVar('specKneeT');
  // ── LIGHT-COUPLED FLICKER (2026-08-09) ───────────────────────────────────
  // The author's ask: *"A bit of organic animation on specular surfaces
  // illuminated by candles."*
  //
  // ⚠️ THIS IS NOT THE CANDLE'S OWN FLICKER RE-DERIVED. `buf:scene.illum` is a
  // MERGED buffer — every light in the scene MAX-blended together — so this
  // pass cannot ask "which lamp lit this pixel, and what is its animation
  // phase". Re-deriving per-candle flicker here would mean a second, parallel
  // copy of `candle-flicker.js` keyed off light positions this shader does not
  // have — exactly the "one value, two authorities" shape this project keeps
  // paying for. Instead this is an INDEPENDENT organic flutter, SCALED by how
  // strongly lit the pixel is, so it appears only where lamps actually reach
  // and fades out in ambient-lit and unlit areas on its own, with no knowledge
  // of the lights at all. The honest description is "metal shimmering in
  // nearby firelight", not "metal reflecting candle #7".
  //
  // Two octaves at right angles, phased apart, over WORLD position — so
  // neighbouring metal flutters independently instead of the whole map pulsing
  // as one; `uFlickerScalePx` sets how large a coherent patch is.
  const flickerUv = positionWorld.xy.div(max(uFlickerScalePx, float(1)));
  const flickerT = tSec.mul(uFlickerSpeed);
  const flickerA = mx_noise_float(vec2(flickerUv.x.add(flickerT), flickerUv.y.sub(flickerT.mul(float(0.7)))));
  const flickerB = mx_noise_float(
    vec2(flickerUv.y.mul(float(2.3)).sub(flickerT.mul(float(1.6))), flickerUv.x.mul(float(2.3)).add(float(11.7)))
  );
  const flickerNoise = mix(flickerA, flickerB, clamp(uFlickerRoughness, float(0), float(1)));
  // `kneeT` is the light-presence weight: ~0 where nothing lights this pixel,
  // ~1 under a lamp. Reusing it rather than inventing a second threshold means
  // the flutter can never appear anywhere the shine itself does not.
  // ⚠️ `exp`, NOT `max(1 + noise·amount·kneeT, 0)` (soft-edge rework,
  // 2026-10-18): the clamp zeroed the shine over a third of the area at the live
  // amount of 3 and the ramp back out of it was steep enough to read as a crisp
  // dark notch bitten into a glint. Strictly positive with a bounded log-gradient
  // — `specular-pattern.js#flickerFactor` has the arithmetic.
  const flicker = exp(flickerNoise.mul(uFlickerAmount).mul(kneeT).mul(float(SPECULAR_FLICKER_LOG_GAIN))).toVar(
    'specFlicker'
  );
  const shineResponse = incident
    .mul(pow(kneeT, max(uIncidentSteepness.sub(float(1)), float(0))))
    .mul(uIncidentGain)
    .mul(flicker)
    .toVar('specShineResponse');

  // ── THE FLOOR GATE — STAGE 3 (2026-08-05), THE DEPTH AUTHORITY ──────────
  // A JS-time branch: with no depth texture the whole lookup is compiled OUT
  // rather than multiplied by a one (`tsl/no-uniform-gates`), the same
  // posture the old `attrTexture`-gated version had.
  //
  // Replaces BOTH `floorMatch` (an attr.r floor-INDEX equality test) and
  // `backgroundVisible` (an attr.b presence-BIT read) with ONE ordinal
  // comparison, `point-light-illumination.js#buildDepthHeightGateNode`'s own
  // rank gate transcribed for a query that has real drawn geometry of its
  // own rather than a light's bare position. `specular-material.js#
  // computeSpecularDepthGate` is this line's CPU twin, asserted in Node —
  // its own header has the full account of why rank alone reproduces both
  // of the old gate's ANDed terms with no flags-bit hard block needed: a
  // Tile's `sortLayer` always outranks a Level's, and a Level's own
  // foreground/roof always outranks its own background at the same
  // elevation, so anything that used to flip
  // `PRESENCE_BIT_OCCLUDES_BACKGROUND` already sits at a strictly higher
  // rank than the background it covers.
  //
  // ⚠️ ARITHMETIC (`step`), NOT `select()` — this file's own hard-won rule
  // (see the debug-colour composite below, "ARITHMETIC, NOT select()"): a
  // `select()`-branched gate here would put `notOccluded` inside real WGSL
  // control flow again, the exact shape that cost this file twelve rounds
  // before. `step(edge, x) = x >= edge ? 1 : 0`, so `step(uExpectedDepth,
  // depthHere)` IS `computeSpecularDepthGate`'s `storedDepth < expectedDepth
  // ? 0 : 1` — same comparison, opposite argument order, zero branching.
  //
  // ⚠️ FAIL-OPEN SURVIVES THROUGH THE BUFFER, NOT A SECOND BRANCH — the old
  // gate's own comment said it best: "the gate is '1 UNLESS something is
  // covering me', not '1 WHERE my background is'." `uExpectedDepth`'s own
  // declaration above (and `computeTieSafeExpectedDepth`'s doc,
  // `vt/scene-depth.js`) carries that same discipline forward through the
  // tie-safe subtraction instead of an explicit "unwritten" special case.
  let visibility01 = float(1);
  let debugFloorGate = vec3(1, 1, 0);
  if (depthTexture) {
    const depthHere = texture(depthTexture, screenUv).toVar('specDepthHere');
    const notOccluded = step(uExpectedDepth, depthHere).toVar('specNotOccluded');
    visibility01 = notOccluded;
    debugFloorGate = vec3(notOccluded, depthHere, uExpectedDepth);
  }

  const coverage = presence.mul(visibility01).toVar('specCoverage');

  // ── RELIEF — the mask's own shape, lit from where the light really is ────
  // The painted value is read as HEIGHT: bright paint stands proud, the
  // author's dark ink lines are grooves. Its gradient is a bevel normal, and
  // the flank that faces the light catches a highlight while the far flank
  // falls into shade — engraving, rims and coin edges, from the one mask.
  // Taps are WORLD-px apart (the art's own scale, not the screen's), mapped to
  // mask UV through the quad's affine derivatives, so tiles rotated or
  // scrolled by tile-motion stay correct. Built at TOP level: derivatives and
  // implicit-LOD samples need uniform control flow, so none of this may move
  // inside the presence gate's `If`.
  // LADDER TIER 1 ('shimmer') and up, like the field itself: below it there
  // are no glints for the mirror to leave dark between, so the whole metal
  // body compiles OUT (JS-time) rather than darkening every metal pixel flat.
  const reliefTaps = [];
  const metalBodyEnabled = plan.shimmerEnabled;
  const { reliefLit, reliefShade, heightGrad, keyDir } = metalBodyEnabled
    ? (() => {
        const heightAt = (dx, dy) => {
          const node = texture(maskTexture, maskUv.add(uvPerWorldX.mul(dx)).add(uvPerWorldY.mul(dy))).level(float(0));
          reliefTaps.push(node);
          return dot(node.rgb, vec3(LUMA_601[0], LUMA_601[1], LUMA_601[2]));
        };
        // Never narrower than 1.5 SCREEN px: zoomed out, a 3-world-px tap falls
        // inside one pixel and the gradient of an unfiltered level-0 read sparkles
        // as the camera pans. Wider taps there simply give a broader bevel.
        const rw = max(uReliefWidthPx, abs(dWorldX).mul(float(1.5))).toVar('specReliefWidth');
        // ∇h, in "painted value per 2·width": ~1 across a hard painted edge.
        const heightGrad = vec2(
          heightAt(rw, float(0)).sub(heightAt(rw.negate(), float(0))),
          heightAt(float(0), rw).sub(heightAt(float(0), rw.negate()))
        ).toVar('specHeightGrad');

        // The key direction, toward the light, world space (y down). Indoors: the
        // light buffer's own slope (brighter side = toward the lamp). Outdoors: the
        // sun. Neither: a quiet top-left default so relief never vanishes.
        const probeU = float(RELIEF_LIGHT_PROBE_PX).div(viewSpanX);
        const probeV = float(RELIEF_LIGHT_PROBE_PX).div(viewSpanY);
        const illumLuma = (du, dv) =>
          dot(
            illumTexNode.sample(vec2(screenUv.x.add(du), screenUv.y.add(dv))).rgb,
            vec3(LUMA_709[0], LUMA_709[1], LUMA_709[2])
          );
        const lightGrad = vec2(
          illumLuma(probeU, float(0)).sub(illumLuma(probeU.negate(), float(0))),
          illumLuma(float(0), probeV).sub(illumLuma(float(0), probeV.negate()))
        ).toVar('specLightGrad');
        const lightGradLen = length(lightGrad);
        const lampConfidence = smoothstep(float(0.004), float(0.04), lightGradLen).mul(float(1).sub(outdoors));
        const lampDir = lightGrad.div(max(lightGradLen, float(1e-5)));
        const keyDir2 = lampDir
          .mul(lampConfidence)
          .add(uSunDir.xy.mul(outdoors))
          .add(vec2(RELIEF_DEFAULT_KEY[0], RELIEF_DEFAULT_KEY[1]).mul(float(0.25)));
        const keyDir = keyDir2.div(max(length(keyDir2), float(1e-5))).toVar('specReliefKey');
        // > 0 on the flank that faces the light (height falls toward it).
        const facing = dot(heightGrad, keyDir).negate().mul(float(4)).toVar('specReliefFacing');
        const reliefLit = clamp(facing, float(0), float(1));
        const reliefShade = clamp(facing.negate(), float(0), float(1));
        return { reliefLit, reliefShade, heightGrad, keyDir };
      })()
    : { reliefLit: float(0), reliefShade: float(0), heightGrad: vec2(0, 0), keyDir: vec2(0, -1) };

  const maskMax = max(max(maskSample.r, maskSample.g), maskSample.b).toVar('specMaskMax');

  // ── THE EYE — highlights that travel as the camera moves (round 2) ──────
  // The same eye water's sun glint uses (`water-light.js`: above the view
  // centre at one view-width × SPECULAR_EYE_HEIGHT), so a pan moves the gold's
  // highlights and the sea's glints by the same geometry.
  const halfVec = (() => {
    if (!shapeEnabled) return vec3(0, 0, 1);
    const eye = vec3(uViewCentre.x, uViewCentre.y, viewSpanX.mul(float(SPECULAR_EYE_HEIGHT)));
    const viewDir = normalize(eye.sub(vec3(positionWorld.x, positionWorld.y, float(0))));
    // The key, lifted off the ground: the sun at its real elevation outdoors,
    // a lamp at LAMP_ELEVATION_Z indoors (the light buffer has no height).
    const keyZ = mix(float(LAMP_ELEVATION_Z), max(uSunDir.z, float(0.05)), outdoors);
    const keyXY = keyDir.mul(sqrt(max(float(1).sub(keyZ.mul(keyZ)), float(0))));
    return normalize(normalize(vec3(keyXY.x, keyXY.y, keyZ)).add(viewDir));
  })().toVar('specHalfVec');

  // PAN FLARE: the subsystem eases the camera's speed into uPanState.z; while
  // the view moves, every camera-keyed highlight brightens a little.
  const flareAmt = clamp(uPanState.z.mul(uPanLook.w), float(0), float(1)).toVar('specFlareAmt');
  const flareGain = float(1).add(flareAmt.mul(float(PAN_FLARE_GAIN)));

  // CAMERA HIGHLIGHT: Blinn-Phong on the shape normal (plus a little of the
  // fine relief), so a dome's hotspot slides across it and pinches at the rim
  // as the eye passes. Flat metal faces straight up and stays dark here — this
  // lives only where the mask has FORM, which is what makes it read as a
  // reflection rather than a pattern.
  const camSpec = (
    shapeEnabled
      ? pow(
          max(dot(normalize(vec3(shapeSlopeW.add(heightGrad.mul(float(0.35))).negate(), float(1))), halfVec), float(0)),
          float(CAMERA_GLINT_SHININESS)
        )
      : float(0)
  ).toVar('specCamSpec');

  // SPARKLE: one soft point per world cell on bright paint, each cell a tiny
  // facet tilted at random. Which facets flash depends on the HALF VECTOR, and
  // so on the camera — a parked view is calm, a pan glitters (V2 shipped a
  // world-lattice sparkle that aliased and defaulted it off; this one's cell is
  // never smaller than SPARKLE_MIN_SCREEN_PX screen pixels and fades as it is
  // forced wider). The point stretches along the pan direction with the flare.
  const sparkleTerm = (() => {
    if (!shapeEnabled) return float(0);
    const pxPerScreen = abs(dWorldX);
    const cellSize = max(uPanState.w, pxPerScreen.mul(float(SPARKLE_MIN_SCREEN_PX))).toVar('specSparkleCell');
    const cellUv = vec2(positionWorld.x, positionWorld.y).div(cellSize);
    const cell = floor(cellUv);
    const jitter = vec2(hash12(cell.add(vec2(3.1, 7.7))), hash12(cell.add(vec2(5.3, 1.9))))
      .sub(vec2(0.5, 0.5))
      .mul(float(SPARKLE_JITTER));
    const off = fract(cellUv).sub(vec2(0.5, 0.5)).sub(jitter);
    const dir = uPanState.xy;
    const along = dot(off, dir).div(float(1).add(flareAmt));
    const across = dot(off, vec2(dir.y.negate(), dir.x));
    const r2 = along
      .mul(along)
      .add(across.mul(across))
      .div(float(SPARKLE_RADIUS * SPARKLE_RADIUS));
    const dotShape = exp(r2.mul(float(-3)));
    const tilt = vec2(hash12(cell.add(vec2(11.7, 2.3))), hash12(cell.add(vec2(8.9, 13.1))))
      .sub(vec2(0.5, 0.5))
      .mul(float(SPARKLE_FACET_TILT));
    const facetN = normalize(vec3(shapeSlopeW.negate().add(tilt), float(1)));
    const flash = pow(max(dot(facetN, halfVec), float(0)), float(SPARKLE_SHININESS));
    const live = step(hash12(cell.add(vec2(17.9, 4.4))), float(SPARKLE_DENSITY));
    // Glitter lives where the metal is BUSY — coin heaps, engraving, chased
    // edges — not on a smooth dome, where lone points read as dust (lab, round
    // 2). The fine relief gradient is that busyness, already computed.
    const busy = smoothstep(float(0.04), float(0.3), length(heightGrad));
    const eligible = smoothstep(float(0.5), float(0.85), maskMax).mul(busy.mul(float(0.85)).add(float(0.15)));
    const footprintFade = clamp(uPanState.w.div(cellSize), float(0.35), float(1));
    return flash.mul(dotShape).mul(live).mul(eligible).mul(footprintFade);
  })().toVar('specSparkle');

  // ── MIRROR — polished metal returns little diffuse light ─────────────────
  // What it does not reflect toward the eye reads DARK, which is the contrast
  // that separates chrome and gold from paint that merely glows. Darkens the
  // lit floor under the metal (premultiplied blend, `alpha` below) between
  // reflections; the glints ride on top additively.
  // The camera highlight and the sparkle are reflections too: never darken under them.
  const reflectWeight = max(
    smoothstep(float(0.02), float(SHIMMER_REF_PEAK), shimmer),
    smoothstep(float(0.02), float(0.4), camSpec.mul(uPanLook.x))
  );
  // ── METAL BY COLOUR — one mask, several metals ─────────────────────────
  // Author (2026-11-02): *"reproduce different metallic responses based on
  // colour."* The painted hue already says which metal; its saturation and
  // value say which FINISH. Bright NEUTRAL paint is silver/steel/chrome — the
  // most mirror-like metal there is: tighter glints, deeper reflections (the
  // Bank's steel coin purses read dull grey under one shared response). Dark
  // neutral paint is iron/pewter: satin, shallow. Saturated paint (gold,
  // copper, brass) keeps the tuned response. Weights, so mixed paint blends.
  const maskSat = maskMax.sub(min(min(maskSample.r, maskSample.g), maskSample.b)).div(max(maskMax, float(1e-4)));
  const neutralW = float(1).sub(smoothstep(float(0.12), float(0.35), maskSat));
  const chromeW = neutralW
    .mul(smoothstep(float(0.35), float(0.75), maskMax))
    .mul(uColourResponse)
    .toVar('specChromeW');
  const ironW = neutralW
    .mul(float(1).sub(smoothstep(float(0.2), float(0.5), maskMax)))
    .mul(uColourResponse)
    .toVar('specIronW');
  const mirrorByColour = float(1)
    .add(chromeW.mul(float(CHROME_MIRROR_GAIN)))
    .sub(ironW.mul(float(0.5)));
  const mirrorDarken = metalBodyEnabled
    ? uMirrorDepth.mul(mirrorByColour).mul(float(1).sub(reflectWeight)).mul(coverage).mul(strengthNode.sqrt())
    : float(0);
  const reliefDarken = uReliefStrength.mul(reliefShade).mul(float(0.45)).mul(coverage);
  const keepFloor = float(1)
    .sub(clamp(mirrorDarken, float(0), float(1)))
    .mul(float(1).sub(clamp(reliefDarken, float(0), float(1))));
  const darkenAlpha = clamp(float(1).sub(keepFloor), float(0), float(MIRROR_MAX_DARKEN)).toVar('specDarken');

  /** Exact transcription of `reinhardCeiling`/`reinhardCeilingRgb`: a
   * genuinely-bounded, luminance-preserving soft knee. See the pattern
   * module's own header for the curve and why it is luminance-based.
   * @param {*} rgb @param {*} ceiling @returns {*} */
  function ceilingCompress(rgb, ceiling) {
    const luma = dot(rgb, vec3(LUMA_709[0], LUMA_709[1], LUMA_709[2]));
    const compressed = ceiling.mul(luma).div(ceiling.add(luma));
    const scale = luma.lessThanEqual(float(1e-6)).select(float(1), compressed.div(luma));
    return rgb.mul(scale);
  }

  // ── THE COMPOSITE — SHEEN + GLINT, SEPARATELY CEILED ─────────────────────
  // ⚠️ SPLIT INTO TWO TERMS 2026-07-27, replacing one shared ceiling — the
  // live report was "washed out instead of intense and colourful", and
  // capping the WHOLE product to one modest ceiling flattened the very peaks
  // that are supposed to read as sharp, hot glints. V2's own structure is the
  // reason this split exists: `totalModulator = 1 + effectsOnly` is a BASE of
  // exactly 1 with the shimmer riding on top as the dramatic part, additively
  // blended with NO ceiling at all — V2's engine could afford that because it
  // ran no filmic tonemap on the final blit (a straight sRGB encode only), so
  // its highs simply clipped rather than desaturated. This renderer DOES run a
  // real tonemap by default (`grade-present.js`, `neutralToneMapping`) that
  // compresses-and-desaturates anything pushed too far — so the SHEEN (the
  // always-on base, no shimmer — what makes gold read as gold even with
  // nothing dramatic happening) is kept modest and genuinely BOUNDED, while
  // the GLINT (the shimmer's own contribution) keeps a MUCH higher ceiling —
  // high enough that a real peak still reaches bloom-worthy HDR territory and
  // blows out the way a real specular highlight is supposed to, the same
  // "amazing" V2 signature, just now confined to where shimmer actually peaks
  // instead of spread across the whole tinted area.
  //
  // ⚠️ "MODEST" WAS STILL TOO GENEROUS — `SPECULAR_SHEEN_CEILING` cut 1.4→0.15
  // (2026-07-27, own header has the numbers): even "bounded" sheen was
  // routinely enough, added to a normally-lit base pixel, to push the COMBINED
  // value past `neutralToneMapping`'s own compression threshold BEFORE glint
  // contributed anything — so the pattern's own contrast was being crushed by
  // the GLOBAL tonemap, invisibly to this pass. The split's shape (two
  // ceilings) was right; the sheen number alone wasn't low enough to leave
  // the glint any headroom.
  const sheenRaw = tint.mul(shineResponse).mul(uStrength).mul(coverage).toVar('specSheenRaw');
  const sheen = ceilingCompress(sheenRaw, uSheenCeiling).toVar('specSheen');

  // GLINT FOCUS: pow(shimmer, focus) keeps a peak's height and narrows its
  // skirt, so a broad wash tightens into a hot glint. HOT CORE: the top of a
  // glint pales toward the metal's own luminance — the way a real highlight
  // on gold clips toward pale yellow before the tonemap ever sees it.
  // Pivoted on the field's MEASURED peak, not on 1: the six-layer union tops
  // out near SHIMMER_REF_PEAK, so `pow(s, k)` alone would only ever dim it.
  const shimmerRel = max(shimmer, float(0)).div(float(SHIMMER_REF_PEAK));
  // THE SKY, outdoors only (`specular-material.js#outdoorGlintResponse`): a
  // daylight overcast relaxes the focus toward a broad satin and dims the
  // glint by the same cloud term water's sun glint follows.
  const skyBroaden = uGlintLook.z.mul(outdoors);
  const focusByColour = mix(
    max(uGlintFocus, float(0.25)).mul(float(1).add(chromeW.mul(float(CHROME_FOCUS_GAIN)))),
    float(1),
    ironW.mul(float(0.6))
  );
  const focusEff = mix(focusByColour, float(1), skyBroaden);
  const skyGain = mix(float(1), uGlintLook.y, outdoors);
  const focused = pow(shimmerRel, focusEff)
    .mul(float(SHIMMER_REF_PEAK))
    .mul(skyGain)
    .mul(float(1).add(chromeW.mul(float(CHROME_GLINT_GAIN))))
    .mul(flareGain)
    .toVar('specFocused');
  const tintLuma = dot(tint, vec3(LUMA_709[0], LUMA_709[1], LUMA_709[2]));
  // The core pales toward a WARM white — half way between the metal's own
  // colour and its grey — never all the way to grey, which turned gold to
  // pewter in the lab (round 2).
  const paleTint = mix(vec3(tintLuma, tintLuma, tintLuma), tint, float(0.5));
  const glintTint = mix(tint, paleTint, smoothstep(float(0.5), float(1.2), shimmerRel).mul(uHotCore));
  const glintRaw = glintTint
    .mul(focused.mul(uShimmerGain))
    .mul(shineResponse)
    .mul(uStrength)
    .mul(coverage)
    .toVar('specGlintRaw');
  const glint = ceilingCompress(glintRaw, uGlintCeiling).toVar('specGlint');

  // The lit flank of the relief, half-way to the pale highlight colour.
  const reliefTint = mix(tint, vec3(tintLuma, tintLuma, tintLuma), float(0.35));
  const relief = reliefTint
    .mul(reliefLit.mul(reliefLit))
    .mul(uReliefStrength)
    .mul(shineResponse)
    .mul(uStrength)
    .mul(coverage)
    .toVar('specRelief');

  // THE TROUGH COLOUR. A conductor colours what it reflects, and light that
  // bounces between metal surfaces is coloured twice — so the dim reflections
  // the mirror darkening leaves behind read as deep amber on gold and deep
  // red-brown on copper, not as the art scaled toward olive (round 2). `tint²`
  // over its own luma keeps the brightness and doubles the saturation.
  const tintSq = tint.mul(tint).div(max(tintLuma, float(1e-3)));
  const troughColour = tintSq
    .mul(clamp(mirrorDarken, float(0), float(1)))
    .mul(float(TROUGH_RETURN))
    .mul(shineResponse)
    .mul(uStrength)
    .mul(coverage)
    .toVar('specTrough');

  // The camera highlight and the sparkle: the pale highlight colour, the same
  // light response, strength, cloud term and flare as the glint.
  // Gold reflects GOLD: the metal's colour across the hotspot, paling only at
  // its very peak (the first draft was pale throughout and read as white wash).
  const camGlint = mix(tint, paleTint, smoothstep(float(0.5), float(1), camSpec))
    .mul(camSpec.mul(uPanLook.x).mul(float(CAMERA_GLINT_GAIN)))
    .mul(shineResponse)
    .mul(uStrength)
    .mul(coverage)
    .mul(skyGain)
    .mul(flareGain)
    .toVar('specCamGlint');
  const sparkleRgb = mix(paleTint, vec3(tintLuma, tintLuma, tintLuma), float(0.5))
    .mul(sparkleTerm.mul(uPanLook.z).mul(float(SPARKLE_GAIN)))
    .mul(shineResponse)
    .mul(uStrength)
    .mul(coverage)
    .mul(skyGain)
    .mul(flareGain)
    .toVar('specSparkleRgb');

  const shine = sheen
    .add(glint)
    .add(relief)
    .add(troughColour)
    .add(ceilingCompress(camGlint.add(sparkleRgb), uGlintCeiling))
    .toVar('specShine');

  /** @param {*} material */
  function configureShared(material) {
    material.transparent = true;
    // The painter's-algorithm contract every drawable here shares
    // (`scene/layer-order.js`): ascending renderOrder IS the layering, so depth
    // testing would only fight it.
    material.depthTest = false;
    material.depthWrite = false;
    // ⚠️ A negative scale (Foundry's horizontal-flip convention) reverses the
    // effective winding and FrontSide would cull the quad as a backface —
    // visible in every JS status field and invisible on screen, because face
    // culling is a GPU-side fact bookkeeping cannot see
    // (`feedback_doubleside_invisible_to_status_reports`).
    material.side = THREE.DoubleSide;
    material.blending = THREE.CustomBlending;
    material.blendEquation = THREE.AddEquation;
    material.blendEquationAlpha = THREE.AddEquation;
    // Destination alpha is left alone: `scene.lit`'s alpha is the level
    // composite's coverage, and nothing this pass computes is a statement
    // about that. `Zero·src + One·dst` is the identity on it.
    material.blendSrcAlpha = THREE.ZeroFactor;
    material.blendDstAlpha = THREE.OneFactor;
  }

  // ONE MESH, ADDITIVE — V2 had no diffuse knock-down and looked right without
  // one. The multiply pass this replaces was physically defensible and cost a
  // second material, a second draw, and another way to half-fail (suppression
  // with no highlight reads as a shader bug rather than as a missing mask).
  const specularMaterial = new THREE.NodeMaterial();
  // PREMULTIPLIED: `dst × (1 − darken) + shine`. At darken 0 this is exactly
  // the old additive `One/One`; the alpha factors (configureShared) still
  // leave the target's own alpha untouched.
  specularMaterial.colorNode = vec4(shine, darkenAlpha);
  // mythica-machina-press#538/#539 — see `positionNode`'s own JSDoc above.
  // Omitted (every floor caller) leaves THREE's own unset default, unchanged.
  if (positionNode) specularMaterial.positionNode = positionNode;
  configureShared(specularMaterial);
  specularMaterial.blendSrc = THREE.OneFactor;
  specularMaterial.blendDst = THREE.OneMinusSrcAlphaFactor;

  // ── THE INSTRUMENT — a third material no mesh draws until asked ──────────
  // `specular.js#SPECULAR_DEBUG_CHANNELS` holds the why and the reading guide.
  // Free when off: at channel 0 this material is attached to no mesh, so the
  // selector below is not in a draw call at all.
  const uDebugChannel = uniform(float(0));
  // Channel 20's own FRESH, unshared sample — see that channel's entry below
  // for why it must not reuse `depthHere` from inside THE FLOOR GATE above.
  const depthRawHere = depthTexture ? texture(depthTexture, screenUv) : float(0);
  const debugNodes = {
    quad: vec3(1, 0, 1),
    mask: maskSample.rgb,
    strength: vec3(strengthNode, strengthNode, strengthNode),
    presence: vec3(presence, presence, presence),
    tint,
    // ⚠️ A CATEGORICAL COLOUR PER ISLAND, not the raw pack channels. The first
    // version showed `(parallax.x, parallax.y, label/255)` directly and was
    // unreadable: forty islands all landed under 0.16 in blue, so every object
    // rendered the same colour and the ONE question this channel exists to
    // answer -- "are the islands distinct?" -- could not be answered from it.
    // A hashed hue at full saturation makes distinctness the FIRST thing the
    // eye reports. Black where no island owns the texel.
    //
    // ⚠️ SELF-DESCRIBING ON FAILURE, added 2026-07-27 -- "channel 6 is black"
    // used to be ambiguous between THREE different causes with no way to tell
    // them apart from the picture alone: the pack never baked, the bake found
    // nothing, or the bake worked and this patch of screen genuinely has no
    // metal. `uIslandBakeStatus` (pushed by the subsystem, never by this
    // shader) answers which one BEFORE the hue-per-island picture is even
    // shown, so a black screen is either a diagnostic colour that NAMES the
    // failure, or it is trustworthy black because the bake is known-good.
    // ⚠️ ARITHMETIC, NOT NESTED `select()` — the SAME trap as the channel
    // selector itself, one level down (`effects/debug-channel-select.js`).
    // The `select()` version buried `mx_hsvtorgb(packSample…)` in its innermost
    // else-branch, which is where `specPack`'s assignment would then be emitted
    // — leaving channel 7 (`islandMotion`), which reads the same pack var from
    // the main flow, staring at an unassigned zero. Three states, three 0/1
    // pickers, one sum: no branch, so the pack sample is built exactly once, in
    // the main flow, where both channels can see it.
    //   STATUS 0 -- still the placeholder. Never baked at all: the mask never
    //     loaded, or `buildSpecularIslandPack` threw. Loud magenta, the same
    //     "something is structurally wrong" colour channel 1 uses for a missing
    //     mesh, deliberately, so both read as the same class of problem.
    //   STATUS 1 -- baked, zero islands survived. Not a bug: the mask genuinely
    //     has nothing that clustered past the size floor on THIS floor. Amber,
    //     not red -- a data fact, not a code failure.
    //   STATUS 2 -- real islands: the hue-per-island picture.
    islands: vec3(1, 0, 1)
      .mul(pickEquals(TSL, uIslandBakeStatus, 0))
      .add(vec3(1, 0.6, 0).mul(pickEquals(TSL, uIslandBakeStatus, 1)))
      .add(mx_hsvtorgb(vec3(packSample.b, float(0.9), packSample.a)).mul(pickEquals(TSL, uIslandBakeStatus, 2))),
    // The motion itself, separately, because "distinct" and "moving correctly"
    // are two questions and one picture cannot answer both.
    islandMotion: vec3(
      islandParallax.x.mul(float(0.35)).add(float(0.5)),
      islandParallax.y.mul(float(0.35)).add(float(0.5)),
      float(0.25)
    ),
    floorGate: debugFloorGate,
    outdoors: vec3(outdoors, outdoors, outdoors),
    illum: shineResponse,
    cellular: vec3(cellular, cellular, cellular),
    shimmer: vec3(shimmer, shimmer, shimmer),
    sheen,
    glint,
    final: shine,
    finalBoosted: shine.mul(float(SPECULAR_DEBUG_BOOST)),
    maskUv: vec3(maskUv.x, maskUv.y, float(0)),
    patternUv: vec3(
      fract(worldUv.x.sub(parallaxBase.x).add(drift.x)),
      fract(worldUv.y.sub(parallaxBase.y).add(drift.y)),
      float(0)
    ),
    // ── THE ISOLATION CHANNEL (19) — a control, and it EARNED ITS KEEP ───────
    //
    // ⚠️ WHAT IT PROVED (2026-07-27): channel 10 (`illum`, through the shared
    // node chain — numbered 12 at the time, renumbered since) read exactly 0
    // at three points while THIS channel — the SAME
    // texture, the SAME `screenUv`, through a FRESH unshared node — read 0.866
    // / 0.189 / 0.188, correct and varying. That single comparison killed the
    // "no texture reaches this pass" theory outright and localised the fault to
    // the code BETWEEN them, which was a UI-shadow multiply added earlier the
    // same session on a bad measurement (see `incident` above). Without it, the
    // next move would have been another guess.
    //
    // ⚠️ ITS SIBLING WAS A BROKEN EXPERIMENT — kept as a warning, not repeated.
    // A `maskDirect: texture(maskTexture, maskUv)` shipped alongside this one
    // and read black, which looked like damning evidence and was in fact
    // MEANINGLESS: `maskTexture` is the 1x1 BLACK PLACEHOLDER captured at build
    // time, and only `maskTexNode`'s `.value` is ever repointed at the real
    // file (`setMaskTexture`). A second `texture()` node over that parameter
    // samples the placeholder forever and can only ever return black.
    // **A "control" that re-reads a swapped resource must go through the SAME
    // node whose value is swapped, or it is testing nothing.**
    // (`feedback_instruments_must_not_lie` — a fresh instance of it, invented
    // while hunting one.)
    illumDirect: texture(illumTexture, screenUv).rgb,
    // ── CHANNEL 20 — depth, RAW, THROUGH A FRESH NODE ────────────────────────
    // ⚠️ ADDED 2026-07-29 as `attrDirect`, RENAMED 2026-08-05 alongside THE
    // FLOOR GATE's own migration to `buf:scene.depth` — same control, same
    // reason it exists, new source. ROUND 12's OWN UNRESOLVED WARNING still
    // applies: `illumDirect` above is the reason this exists at all — Round
    // 7/8 (2026-07-27) found the DEBUG material can read STALE data for a
    // texture-derived channel even when the REAL effect material reads the
    // identical texture correctly, and closed with "do not trust a
    // texture-derived specular debug channel until this is fixed" — the
    // mechanism was never actually found, only worked around per-channel.
    // `floorGate` (channel 8) reads `depthTexture` through the SAME
    // `depthHere` node this material's OWN `visibility01` uses, so if that
    // still-open bug is alive, channel 8 could show "occluded" even while
    // the REAL pass reads it correctly — indistinguishable from a genuine
    // occlusion regression. This channel is the SAME control `illumDirect`
    // already is for `illum`: a FRESH, UNSHARED `texture()` call, so a
    // future report can diff this against `floorGate`'s own G channel
    // (the same raw depth, broadcast) exactly the way channel 19 vs channel
    // 12 localised the illum bug in one reading instead of a fourth guess.
    // `depthTexture` is never re-pointed after construction (unlike
    // `maskTexture`, which `setMaskTexture` DOES reassign) — so unlike the
    // `maskDirect` mistake this shares no risk of capturing a build-time
    // placeholder; a fresh node here reads the SAME real texture, always.
    depthDirect: vec3(depthRawHere, depthRawHere, depthRawHere),
  };
  // ⚠️ ARITHMETIC, NOT `select()` — and this is not a style choice. The
  // `select()` fold this replaces put every channel's maths inside its own
  // branch of real WGSL control flow, so each shared `.toVar()` was ASSIGNED in
  // whichever branch the graph walk reached first and read as an unassigned
  // (zero) `var<private>` in every other one. Twelve rounds of this effect's
  // history were spent re-diagnosing it off channel readings that were produced
  // that way — see `effects/debug-channel-select.js` for the dumped WGSL that
  // finally showed it, and channel 8's own note below for what it cost here.
  const debugColor = buildDebugChannelColor(TSL, {
    channels: SPECULAR_DEBUG_CHANNELS,
    nodes: debugNodes,
    uDebugChannel,
    label: 'specular',
  });
  const debugMaterial = new THREE.NodeMaterial();
  debugMaterial.colorNode = vec4(debugColor, 1);
  // Same live transform as the add pass, above — a debug channel must not
  // un-stick the animation (the mesh swaps material, never geometry).
  if (positionNode) debugMaterial.positionNode = positionNode;
  configureShared(debugMaterial);
  // OPAQUE where the effect ADDS: a diagnostic whose "this is zero" answer
  // rendered as *nothing added* would reproduce the ambiguity it removes.
  debugMaterial.blendSrc = THREE.OneFactor;
  debugMaterial.blendDst = THREE.ZeroFactor;

  /** @param {number} i @param {(L: object) => void} fn */
  const eachLayer = (i, fn) => {
    if (Number.isFinite(i) && layers[i]) fn(layers[i]);
  };

  return {
    specularMaterial,
    debugMaterial,
    maskTexNode,
    /** Relief's own taps of the SAME mask — exposed so a test can prove a mask
     * swap reaches them (a tap left on the old mask lights the old floor's
     * shapes on the new floor's metal). */
    reliefTapNodes: reliefTaps,
    /** Whether this build reads a shape map (tier ≥ 1 and one was passed). */
    shapeEnabled,
    packTexNode,
    layerCount: SPECULAR_LAYER_COUNT,
    /** The ladder rung this exact material was built for — see
     * specular-surface-subsystem.js's own `builtForTier`, which records THIS
     * rather than the requested tier (same discipline water's rebuild uses). */
    tier: plan.tier,
    /** THE ONE DOOR onto the mask texture — see `setMaskUvBounds` for why the
     * lookup is uv-based, and the subsystem for who calls this. */
    setMaskTexture(tex) {
      maskTexNode.value = tex;
      // The relief's four taps are their own texture nodes; they must follow.
      for (const tap of reliefTaps) tap.value = tex;
    },
    setIslandPackTexture(tex) {
      packTexNode.value = tex;
    },
    /** 0 = still the placeholder, 1 = baked with zero surviving islands, 2 =
     * baked with real islands. See `uIslandBakeStatus`'s own declaration for
     * why channel 6 needs this. @param {number} n */
    setIslandBakeStatus(n) {
      uIslandBakeStatus.value = Number.isFinite(n) ? Math.max(0, Math.min(2, Math.round(n))) : 0;
    },
    /** The crop's extent in MASK-UV space — the entire mask lookup.
     * @param {{minU:number,minV:number,maxU:number,maxV:number}} b */
    setMaskUvBounds(b) {
      uMaskUvBounds.value.set(b.minU, b.minV, b.maxU, b.maxV);
    },
    /** The camera's world-rect centre. Pushed EVERY frame and never gated on a
     * cached key: this is the whole reason a highlight moves when the author
     * pans, so a skip here would silently restore a painted-on look. */
    setViewCentre(cx, cy) {
      uViewCentre.value.set(cx, cy);
    },
    /** STAGE 3 (2026-08-05) — replaces `setFloorIndex`. Push
     * `computeTieSafeExpectedDepth(rank, maxRank)` for THIS quad's own
     * background item's rank, on the SAME cadence the old floor index used
     * (the subsystem's own `sync()`, whenever the viewed floor changes) —
     * see `uExpectedDepth`'s own declaration above. @param {number} depth */
    setExpectedDepth(depth) {
      uExpectedDepth.value = Number.isFinite(depth) ? depth : 0;
    },
    /** The sun's azimuth, as ONE unit vector — the only route its direction has
     * into this effect — plus, optionally, the key 3-vector's vertical part
     * (`keyLightDirection(sky.key)[2]`) for the camera highlight.
     * @param {number} dirX @param {number} dirY @param {number} [dirZ] */
    setSunDir(dirX, dirY, dirZ) {
      const len = Math.hypot(dirX, dirY);
      const z = Number.isFinite(dirZ) ? Math.min(1, Math.max(0, dirZ)) : uSunDir.value.z;
      if (len > 1e-6) uSunDir.value.set(dirX / len, dirY / len, z);
      else uSunDir.value.z = z;
    },
    /** Foundry's readability floor for THIS frame — `ambient.darkness` pulled
     * toward black by `darknessRealism01`, i.e. exactly `illumAboveFloor`'s
     * subtrahend above. Push the SAME triple `runLightAccumulatePass` computes
     * for `uRegionDarknessColor`, never a second derivation of it. Omitted =
     * (0,0,0), a provable no-op — old behaviour, byte-identical.
     * @param {number} r @param {number} g @param {number} b */
    setDarknessFloor(r, g, b) {
      // `Math.max(0, NaN)` is NaN, not 0 — a bad/late scene snapshot must not
      // paint a permanent NaN hole in an additive pass, same guard shape as
      // `setExpectedDepth`/`setSunDir` above.
      const safe = (v) => (Number.isFinite(v) ? Math.max(0, v) : 0);
      uDarknessFloor.value.set(safe(r), safe(g), safe(b));
    },
    setStrength(v) {
      uStrength.value = Math.max(0, v);
    },
    setSaturation(v) {
      uSaturation.value = Math.min(2, Math.max(0, v));
    },
    /** The shadow-contrast exponent (mythica-machina-press#432). Floored well
     * above 0, never at it — same reasoning as `setIncidentKnee`'s own guard:
     * `pow()` at a zero/negative exponent either degenerates to a flat 1
     * regardless of how dark the pixel is, or divides by a vanishing base, and
     * neither is "turn the curve off" (that is what 1 already means).
     * @param {number} v */
    setMaskContrast(v) {
      uMaskContrast.value = Math.max(1e-3, v);
    },
    setPatternScale(v) {
      uPatternScale.value = Math.max(1, v);
    },
    setParallaxStrength(v) {
      uParallaxStrength.value = v;
    },
    setDriftSpeed(v) {
      uDriftSpeed.value = Math.max(0, v);
    },
    setPulse(v) {
      uPulse.value = Math.min(1, Math.max(0, v));
    },
    setShimmerGain(v) {
      uShimmerGain.value = Math.max(0, v);
    },
    setLightFloor(v) {
      uLightFloor.value = Math.max(0, v);
    },
    setSunBias(v) {
      uSunBias.value = Math.min(1, Math.max(0, v));
    },
    /** How brightly the always-on base (no shimmer) may peak before
     * `ceilingCompress` reins it in. No upper clamp: a caller pushing this
     * far past the tonemap's own compression threshold gets exactly the
     * blown-out, saturating look that implies — not a hidden second ceiling
     * fighting the one just requested. @param {number} v */
    setSheenCeiling(v) {
      uSheenCeiling.value = Math.max(0, v);
    },
    /** How brightly the shimmer's own contribution may peak. @param {number} v */
    setGlintCeiling(v) {
      uGlintCeiling.value = Math.max(0, v);
    },
    /** How sharply the shine fades through dim/shadowed light before it
     * reaches the composite (`steepenIncidentRgb`'s own header has the
     * design). Floored well above 0, never at it: a `pow()` exponent at or
     * below 0 either divides by a vanishing base (negative) or degenerates
     * to a flat 1 regardless of how dark the pixel is (exactly 0) — both are
     * a real blow-up, not a stylistic extreme, so this keeps the knob inside
     * the region where the curve stays a curve. @param {number} v */
    setKneeSoftness(v) {
      uKneeSoftness.value = Math.min(1, Math.max(0, v));
    },
    setIncidentGain(v) {
      uIncidentGain.value = Math.max(0, v);
    },
    setFlickerAmount(v) {
      uFlickerAmount.value = Math.max(0, v);
    },
    setFlickerSpeed(v) {
      uFlickerSpeed.value = Math.max(0, v);
    },
    setFlickerScalePx(v) {
      uFlickerScalePx.value = Math.max(1, v);
    },
    setFlickerRoughness(v) {
      uFlickerRoughness.value = Math.min(1, Math.max(0, v));
    },
    /** `outdoorGlintResponse(sky)`'s result, pushed when the sky changes.
     * @param {{gain: number, broaden: number}} r */
    setSkyGlint(r) {
      const g = Number.isFinite(r?.gain) ? Math.min(1, Math.max(0, r.gain)) : 1;
      const b = Number.isFinite(r?.broaden) ? Math.min(1, Math.max(0, r.broaden)) : 0;
      uGlintLook.value.y = g;
      uGlintLook.value.z = b;
    },
    setReliefStrength(v) {
      uMetalBody.value.x = Math.max(0, v);
    },
    setReliefWidthPx(v) {
      uMetalBody.value.y = Math.max(0.25, v);
    },
    setMirrorDepth(v) {
      uMetalBody.value.z = Math.min(1, Math.max(0, v));
    },
    setGlintFocus(v) {
      uMetalBody.value.w = Math.max(0.25, v);
    },
    setHotCore(v) {
      uGlintLook.value.x = Math.min(1, Math.max(0, v));
    },
    /** The baked shape map (`specular-shape.js`), per mask. */
    setShapeTexture(tex) {
      if (shapeTexNode) shapeTexNode.value = tex;
    },
    setCameraGlint(v) {
      uPanLook.value.x = Math.max(0, v);
    },
    setReflectionBend(v) {
      uPanLook.value.y = Math.max(0, v);
    },
    setSparkle(v) {
      uPanLook.value.z = Math.max(0, v);
    },
    setPanFlare(v) {
      uPanLook.value.w = Math.min(1, Math.max(0, v));
    },
    setSparkleSizePx(v) {
      uPanState.value.w = Math.max(1, v);
    },
    /** The camera's eased motion, pushed per frame by the subsystem.
     * @param {{dirX: number, dirY: number, amount: number}} m */
    setPanMotion(m) {
      const len = Math.hypot(m?.dirX ?? 0, m?.dirY ?? 0);
      if (len > 1e-6) uPanState.value.set(m.dirX / len, m.dirY / len, uPanState.value.z, uPanState.value.w);
      uPanState.value.z = Number.isFinite(m?.amount) ? Math.min(1, Math.max(0, m.amount)) : 0;
    },
    setColourResponse(v) {
      uGlintLook.value.w = Math.min(1, Math.max(0, v));
    },
    setIncidentKnee(v) {
      // Clamped ABOVE 0: a knee of 0 would divide every light level to
      // infinity, saturating `kneeT` everywhere and silently disabling the
      // suppression curve entirely rather than "turning the knee off".
      uIncidentKnee.value = Math.min(1, Math.max(0.01, v));
    },
    setIncidentSteepness(v) {
      uIncidentSteepness.value = Math.max(0.05, v);
    },
    setLayerDensity(i, v) {
      eachLayer(i, (L) => (L.uDensity.value = Math.max(0.25, v)));
    },
    setLayerGrainAngle(i, deg) {
      eachLayer(i, (L) => L.uGrain.value.set(Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)));
    },
    setLayerStreak(i, v) {
      eachLayer(i, (L) => (L.uStreak.value = Math.max(0, v)));
    },
    setLayerSoftness(i, v) {
      eachLayer(i, (L) => (L.uSoftness.value = Math.min(1, Math.max(0, v))));
    },
    setLayerRowSpacing(i, v) {
      eachLayer(i, (L) => (L.uRowSpacing.value = Math.max(MIN_ROW_SPACING, v)));
    },
    setLayerContrast(i, v) {
      eachLayer(i, (L) => L.uWindow.value.set(...softWindowValues(v)));
    },
    setLayerStrength(i, v) {
      eachLayer(i, (L) => (L.uLayerStrength.value = Math.max(0, v)));
    },
    setLayerParallaxDepth(i, v) {
      eachLayer(i, (L) => (L.uParallaxDepth.value = v));
    },
    /** Which intermediate `debugMaterial` shows. 0 = off, and the CALLER is
     * what makes 0 free: it must DETACH the material rather than leave it
     * attached showing black. */
    setDebugChannel(n) {
      uDebugChannel.value = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
    },
    outdoorsGateCompiled: !!outdoorsNode,
    floorGateCompiled: !!depthTexture,
  };
}
