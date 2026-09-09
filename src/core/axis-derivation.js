/**
 * BANDED AXIS DERIVATION — the shape `world/weather.js#derivePrecipKind`
 * already implements for temperature→precip-kind, extracted so the NEXT
 * derived-from-one-axis feature (frost density from temperature, haze from
 * humidity, ...) doesn't re-derive the same "authored wins outright, else
 * blend across a threshold band" math from scratch (mythica-machina-
 * press#390).
 *
 * ============================================================================
 * WHY THIS IS NOT `weather-events.js#composeOverride`
 * ============================================================================
 * That function already generalizes a DIFFERENT band: an event's own TIME
 * envelope (attack/sustain/release progress, 0..1 by construction). This one
 * generalizes a VALUE-SPACE band — an arbitrary continuous axis (temperature,
 * humidity, wind speed, ...) split into a cold/mid/warm answer by two
 * threshold edges the caller supplies. The two are siblings in spirit (both
 * "blend across a declared window so nothing pops"), not the same function
 * wearing two names — forcing one to call the other would mean inventing a
 * fake progress01 out of a value-space position, which is exactly the kind
 * of "two things share a shape, so bolt them together" move this codebase's
 * own doctrine warns produces a worse abstraction than two small pure
 * functions kept apart.
 *
 * ============================================================================
 * WHY THIS LIVES IN `core/`, NOT `world/`
 * ============================================================================
 * Zero Foundry, zero weather-specific content — pure numeric banding, the
 * same "core/ never imports world/, world/ depends on core/" rule
 * `core/params-schema.js`'s own header already states for the identical
 * reason (`core/cues-schema.js` needing `FADEABLE_PARAM_TYPES` without
 * importing `world/fade-engine.js`). A future non-weather axis (a UI theme's
 * light/dark blend, a performance axis's quality band) can use this without
 * ever touching `world/`.
 *
 * @module core/axis-derivation
 */

/**
 * @typedef {object} BandedDerivation
 * @property {*} kind - the resolved answer: `authored` verbatim if pinned,
 *   otherwise one of `coldKind`/`midKind`/`warmKind`.
 * @property {number} mixWeight - 1 at the cold edge, 0 at the warm edge,
 *   interpolated linearly between. For an AUTHORED answer, whatever
 *   `mixWeightForAuthored` returns (default 0) — a caller that always wants
 *   0 for every authored value never has to pass this at all.
 * @property {boolean} authored - true when `authored` was actually pinned
 *   (not the sentinel, and a member of `validAuthored` when that list is
 *   given) — LAW: a derived answer never overwrites an authored one, and a
 *   consumer can tell which happened.
 */

/**
 * @param {object} args
 * @param {*} args.authored - the author's own pinned choice, or the sentinel
 *   meaning "let the axis decide" (`derivePrecipKind`'s `'auto'`).
 * @param {*} [args.autoSentinel='auto'] - the value of `authored` that means
 *   "not pinned".
 * @param {Array<*>} [args.validAuthored] - every value `authored` is allowed
 *   to be (the sentinel may or may not be included — both are checked
 *   separately). When omitted, ANY non-sentinel `authored` is accepted —
 *   the caller is trusted to have already validated it. When given, a
 *   value NOT in this list is treated exactly like the sentinel (falls
 *   through to the derived band) — `derivePrecipKind`'s own "an unrecognised
 *   stored value degrades to the derived answer, never a crash" behaviour.
 * @param {number} args.value - the continuous axis value, ALREADY clamped
 *   and defaulted by the caller — this function makes no assumption about
 *   the axis's natural range or a sensible fallback for a non-finite input
 *   (that is domain knowledge only the caller has, e.g. `derivePrecipKind`'s
 *   own "temperature01 defaults to 0.55, a temperate day").
 * @param {number} args.coldEdge - at or below this, fully `coldKind`.
 * @param {number} args.warmEdge - at or above this, fully `warmKind`.
 * @param {*} args.coldKind @param {*} args.midKind @param {*} args.warmKind -
 *   the three band answers. `midKind` is reported strictly BETWEEN the two
 *   edges — `derivePrecipKind`'s own "the cold/warm edge is IN the band, not
 *   below/above it" rule, preserved exactly.
 * @param {(authored: *) => number} [args.mixWeightForAuthored] - defaults to
 *   `() => 0`. `derivePrecipKind`'s own asymmetry (authored `'snow'` reports
 *   `mixWeight: 1`, every other authored kind reports `0`) is domain
 *   knowledge about what "fully cold" means for THAT axis — this function
 *   does not guess it.
 * @returns {Readonly<BandedDerivation>}
 */
export function deriveBandedKind({
  authored,
  autoSentinel = 'auto',
  validAuthored,
  value,
  coldEdge,
  warmEdge,
  coldKind,
  midKind,
  warmKind,
  mixWeightForAuthored = () => 0,
}) {
  const isPinned = authored !== autoSentinel && (!Array.isArray(validAuthored) || validAuthored.includes(authored));
  if (isPinned) {
    return Object.freeze({ kind: authored, mixWeight: mixWeightForAuthored(authored), authored: true });
  }
  // STRICT inequalities — `derivePrecipKind`'s own "the cold/warm edge is IN
  // the band, not below/above it" rule (Node-tested: `derivePrecipKind('auto',
  // coldEdge).kind === 'sleet'`, not the cold answer). An edge value falls
  // through to the mid-band arithmetic below, which correctly resolves to
  // mixWeight 1/0 exactly AT that edge — the same number, reached the same
  // way the original single-purpose function reached it.
  if (value < coldEdge) return Object.freeze({ kind: coldKind, mixWeight: 1, authored: false });
  if (value > warmEdge) return Object.freeze({ kind: warmKind, mixWeight: 0, authored: false });
  const span = warmEdge - coldEdge;
  const w = span > 0 ? 1 - (value - coldEdge) / span : 0.5;
  return Object.freeze({ kind: midKind, mixWeight: Math.min(1, Math.max(0, w)), authored: false });
}
