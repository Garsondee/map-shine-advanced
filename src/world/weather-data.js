/**
 * THE ARCHETYPE TABLE — real skies, as data (docs/planning/Weather-Manager.md §3).
 *
 * ============================================================================
 * WHAT AN ARCHETYPE IS, AND WHAT IT IS NOT
 * ============================================================================
 *
 * An archetype is a NAMED POINT IN AXIS SPACE. `overcast` is not a mode, a
 * branch or a code path — it is the row `{cover: 0.95, type: 0.9, altitude:
 * 700, scale: 5000}` plus a label. Clicking it in the astrolabe's shelf sets
 * four targets and a string; the ease engine does the rest, and every consumer
 * downstream keeps reading the same four numbers it always read.
 *
 * ⚠️ LAW 2 (Weather-Manager.md §1): **no shader, effect or handle may ever
 * branch on `preset`.** It is a label of intent for the UI and for diagnostics.
 * The moment something reads `if (preset === 'storm')` there are two authorities
 * for what the weather is — the label and the axes — and they will disagree the
 * first time a GM nudges a slider. Consumers read axes, which are numbers that
 * can also be 0.3.
 *
 * ============================================================================
 * WHY THESE PARTICULAR ROWS — reproducing real cloud contours (§3.1)
 * ============================================================================
 *
 * The ten classical cloud genera collapse, for an orthographic bird's-eye
 * renderer, into a handful of procedural levers. Three of them live here as
 * axis values:
 *
 *   TYPE      cirrus(0) → cumulus(0.5) → stratus(1). Drives the noise basis:
 *             streaky domain-warped fBm at the low end, Worley billows in the
 *             middle, a low-contrast sheet at the top.
 *   ALTITUDE  the ONE knob of Clouds.md — shadow offset, softness, parallax,
 *             drift speed, how much sky is hidden. High cirrus is soft, faint
 *             and fast; low stratus is near, flat and slow.
 *   SCALE     feature size. Cirrus streaks run thousands of px; a mackerel sky
 *             is a few hundred; a storm cell is somewhere between.
 *
 * COVER carries the fourth: contrast peaks around 0.5–0.65 (V2's own finding,
 * `4c(1-c)`), which is why `broken` is the most dramatic sky in the list and
 * `overcast` — despite being the *most* cloud — has no cloud shadows at all.
 * It is all shadow.
 *
 * ============================================================================
 * FAIL-OPEN, LOUDLY (the gate-polarity rule)
 * ============================================================================
 *
 * `resolveArchetype` returns `clear` for an unknown id and REPORTS that it did.
 * A malformed or renamed archetype must never storm-lock a scene — a GM whose
 * map is stuck under a thunderstorm because of a typo has lost the map, not a
 * feature (`feedback_gate_polarity_must_fail_open`). But it must also not fail
 * *silently*: the caller gets `{ok: false, reason}` so a status report can say
 * which id was missing rather than showing a clear sky and no explanation
 * (`feedback_required_masks_fail_loud`'s posture, at a lower severity).
 *
 * Pure data + pure lookups. No Foundry, no DOM, no clock.
 *
 * @module world/weather-data
 */

/**
 * The label a sky wears once the GM has hand-adjusted an axis away from any
 * named row. Not a row itself — there is nothing to apply — which is why it
 * lives here as a constant rather than in {@link WEATHER_ARCHETYPES}.
 *
 * ⚠️ It exists so the stored label can never LIE. Without it, dragging the
 * cloud slider under an `overcast` scene would leave the scene still claiming
 * to be `overcast` while sitting at cover 0.2, and the shelf would light up a
 * button that no longer describes the sky. Same disease as a stale mode
 * readback, one level up.
 */
export const CUSTOM_PRESET = 'custom';

/**
 * The archetypes, in the order the shelf shows them: clear → thickening →
 * raining → extreme. That order is deliberate and it is information — the shelf
 * reads left-to-right as "how much sky is in the way", so a GM scanning it can
 * find the weather they want by severity rather than by hunting a name.
 *
 * `icon` is a single character the shelf renders; `blurb` is its tooltip.
 * Both live here rather than in the UI so a row is one edit, not two.
 */
export const WEATHER_ARCHETYPES = Object.freeze([
  Object.freeze({
    id: 'clear',
    label: 'Clear',
    icon: '☀',
    blurb: 'Cloudless. Hard architectural shadows, maximum colour.',
    axes: Object.freeze({ cloudCover01: 0, cloudType01: 0.5, cloudAltitudePx: 1400, cloudScalePx: 1100 }),
  }),
  Object.freeze({
    id: 'streaks',
    label: 'Cirrus',
    icon: '🪶',
    blurb: 'High streaks, drifting fast. Faint soft bands cross the map.',
    axes: Object.freeze({ cloudCover01: 0.25, cloudType01: 0.0, cloudAltitudePx: 2800, cloudScalePx: 4000 }),
  }),
  Object.freeze({
    id: 'high-veil',
    label: 'Veil',
    icon: '🌤',
    blurb: 'Cirrostratus. A milky halo sky — wide, gentle dimming.',
    axes: Object.freeze({ cloudCover01: 0.35, cloudType01: 0.05, cloudAltitudePx: 3000, cloudScalePx: 4200 }),
  }),
  Object.freeze({
    id: 'fair-cumulus',
    label: 'Fair',
    icon: '⛅',
    blurb: 'Fair-weather cumulus. Crisp island shadows sailing across the map.',
    axes: Object.freeze({ cloudCover01: 0.35, cloudType01: 0.5, cloudAltitudePx: 1400, cloudScalePx: 1100 }),
  }),
  Object.freeze({
    id: 'mackerel',
    label: 'Mackerel',
    icon: '🐟',
    blurb: 'Altocumulus. Fine dappled grain, medium-soft.',
    axes: Object.freeze({ cloudCover01: 0.5, cloudType01: 0.4, cloudAltitudePx: 1900, cloudScalePx: 350 }),
  }),
  Object.freeze({
    id: 'broken',
    label: 'Broken',
    icon: '🌥',
    blurb: 'Stratocumulus. Moving HOLES of light — the most dramatic sky here.',
    axes: Object.freeze({ cloudCover01: 0.65, cloudType01: 0.7, cloudAltitudePx: 900, cloudScalePx: 700 }),
  }),
  Object.freeze({
    id: 'overcast',
    label: 'Overcast',
    icon: '☁',
    blurb: 'Flat grey lid. No cloud shadows — it is all shadow.',
    axes: Object.freeze({ cloudCover01: 0.95, cloudType01: 0.9, cloudAltitudePx: 700, cloudScalePx: 5000 }),
  }),
  Object.freeze({
    id: 'fog',
    label: 'Fog',
    icon: '🌫',
    blurb: 'Stratus at ground level. Shadows nearly gone; the air itself glows.',
    axes: Object.freeze({ cloudCover01: 0.7, cloudType01: 1.0, cloudAltitudePx: 300, cloudScalePx: 6000 }),
  }),
  Object.freeze({
    id: 'drizzle',
    label: 'Drizzle',
    icon: '🌦',
    blurb: 'Light nimbostratus. Silver gloom, wet sheen rising.',
    axes: Object.freeze({ cloudCover01: 1.0, cloudType01: 0.95, cloudAltitudePx: 550, cloudScalePx: 5000 }),
  }),
  Object.freeze({
    id: 'steady-rain',
    label: 'Rain',
    icon: '🌧',
    blurb: 'Nimbostratus. Dark, saturated, every glint dead.',
    axes: Object.freeze({ cloudCover01: 1.0, cloudType01: 1.0, cloudAltitudePx: 500, cloudScalePx: 5000 }),
  }),
  Object.freeze({
    id: 'snow',
    label: 'Snow',
    icon: '❄',
    blurb: 'Cold nimbostratus. Bright and flat.',
    axes: Object.freeze({ cloudCover01: 0.9, cloudType01: 0.95, cloudAltitudePx: 600, cloudScalePx: 4500 }),
  }),
  Object.freeze({
    id: 'gale',
    label: 'Gale',
    icon: '💨',
    blurb: 'Dry windstorm. Fast ragged streaks — the motion IS the look.',
    axes: Object.freeze({ cloudCover01: 0.3, cloudType01: 0.3, cloudAltitudePx: 2200, cloudScalePx: 2600 }),
  }),
  Object.freeze({
    id: 'thunderstorm',
    label: 'Storm',
    icon: '⛈',
    blurb: 'Cumulonimbus. A dark cell with its anvil streaming downwind.',
    axes: Object.freeze({ cloudCover01: 0.8, cloudType01: 0.6, cloudAltitudePx: 900, cloudScalePx: 1600 }),
  }),
]);

/** @type {readonly string[]} — the closed list, in shelf order. */
export const WEATHER_ARCHETYPE_IDS = Object.freeze(WEATHER_ARCHETYPES.map((a) => a.id));

/** Index for O(1) lookup. Built once; the table is frozen so it cannot drift. */
const BY_ID = new Map(WEATHER_ARCHETYPES.map((a) => [a.id, a]));

/** The row every failure falls back to. */
export const DEFAULT_ARCHETYPE_ID = 'clear';

/**
 * Look an archetype up by id, failing OPEN to `clear` and saying so.
 *
 * @param {string} id
 * @returns {Readonly<{ok: boolean, archetype: object, reason: string|null}>}
 *   `ok:false` carries the real reason; `archetype` is always usable, so a
 *   caller can render the fallback and report the problem in the same pass
 *   rather than choosing between them.
 */
export function resolveArchetype(id) {
  const found = typeof id === 'string' ? BY_ID.get(id) : undefined;
  if (found) return Object.freeze({ ok: true, archetype: found, reason: null });
  return Object.freeze({
    ok: false,
    archetype: BY_ID.get(DEFAULT_ARCHETYPE_ID),
    reason:
      id === CUSTOM_PRESET
        ? 'custom is a label, not an archetype — there is nothing to apply'
        : `unknown archetype id ${JSON.stringify(id)}`,
  });
}

/**
 * Is this id one the shelf can actually apply? `custom` is deliberately NOT —
 * it describes a sky that has been hand-edited away from every named row, and
 * "apply custom" has no meaning.
 * @param {string} id @returns {boolean}
 */
export function isApplicableArchetype(id) {
  return typeof id === 'string' && BY_ID.has(id);
}

/**
 * Which archetype (if any) a set of axis values currently sits on.
 *
 * Used to light the right button in the shelf, and to decide whether a hand
 * edit has moved the sky off its named row (⇒ {@link CUSTOM_PRESET}). Matching
 * on VALUES rather than trusting the stored label is what keeps the two from
 * disagreeing: the label is derived from where the axes actually are, so it
 * cannot describe a sky that is no longer there.
 *
 * ⚠️ Compares against TARGETS, never against eased state — mid-transition the
 * axes are between two skies, and a matcher fed the moving value would flicker
 * the shelf's highlight off and back on as the ease ran.
 *
 * @param {object} targets - axis name → value.
 * @param {number} [tolerance] - fractional slack per axis, relative to that
 *   axis's own range. Small but non-zero: a persisted value that round-tripped
 *   through JSON should still match the row it came from.
 * @returns {string} an archetype id, or {@link CUSTOM_PRESET}.
 */
export function matchArchetype(targets, tolerance = 0.02) {
  if (!targets || typeof targets !== 'object') return CUSTOM_PRESET;
  for (const a of WEATHER_ARCHETYPES) {
    let hit = true;
    for (const [axis, want] of Object.entries(a.axes)) {
      const got = Number(targets[axis]);
      if (!Number.isFinite(got)) {
        hit = false;
        break;
      }
      // Slack scales with the axis's own magnitude, so one tolerance number
      // works for a 0..1 cover and a 100..6000 altitude alike.
      const slack = Math.max(Math.abs(want), 1) * tolerance;
      if (Math.abs(got - want) > slack) {
        hit = false;
        break;
      }
    }
    if (hit) return a.id;
  }
  return CUSTOM_PRESET;
}
