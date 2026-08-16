/**
 * WEATHER EVENTS — the magical overlay layer (Weather-Manager.md §6.1-§6.2).
 *
 * ============================================================================
 * WHAT THIS MODULE IS, AND WHERE IT STOPS
 * ============================================================================
 *
 * An event is a named, closed-list drama (`ash-storm`, `eclipse`, ...) that
 * rides ON TOP of whatever the base weather (Director or Almanac, LAW 1 —
 * overlays are mode-agnostic) is already doing, for a while, then goes away.
 * §6.1's own words: "everything about an event is still state evolving
 * continuously" — there is no event bus and no callback, just an envelope
 * (attack/sustain/release) that a consumer reads as numbers ramping.
 *
 * This module owns the PURE MATH: the closed list of kinds, each kind's
 * authored defaults, the envelope's phase/progress arithmetic, and how one
 * override composes onto one axis value. It knows nothing about `WEATHER_AXES`
 * or the manager's own state — `world/weather.js#addEvent` is where an
 * override's `axis` gets checked against the real axis table, exactly as
 * `resolveArchetype`/`resolveBiome` live apart from the manager that validates
 * archetype/biome ids against ITS OWN knowledge. That split keeps this module
 * importable by `weather.js` without a cycle back.
 *
 * ⚠️ ONLY `ash-storm` MOVES A PIXEL THIS SLICE. Its `cover`/`type` overrides
 * land on axes `weather.js` already owns. The other eight kinds are fully
 * mechanical — addable, they ramp through their envelope, they clean up on
 * schedule — but carry `overrides: []` because their real payload needs
 * machinery slice 4 does not build:
 *   - `blood-moon`, `eclipse`      → need the moon / `env.skyKey` (slice 5)
 *   - `aurora`, `volcanic-unrest`,
 *     `mana-storm`                 → need the patchy sky illuminant (§6.3, slice 6)
 *   - `gloom`, `radiance`,
 *     `sky-flash`                  → need a veil/fill override surface on
 *                                     `sky-access.js`, which does not exist yet
 * `illuminant`/`precipKindOverride`/`particleArchetype`/`a11yFlash` are
 * carried as data on every kind that names one in §6.2, unconsumed, exactly
 * the `frontScripts`/`eventRates` pattern `weather-biomes.js` already uses for
 * fields with no reader yet (`feedback_unconsumed_api_rots_silently`) — ship
 * the data, mark the gap, let the slice that builds the consumer wire it.
 *
 * @module world/weather-events
 */

/**
 * The closed list of event kinds (Weather-Manager.md §6.2 table). An unknown
 * kind is refused by {@link resolveEventKind} rather than accepted and doing
 * nothing (`feedback_category_string_must_be_in_closed_list`).
 */
export const EVENT_KINDS = Object.freeze([
  'ash-storm',
  'aurora',
  'blood-moon',
  'eclipse',
  'volcanic-unrest',
  'mana-storm',
  'gloom',
  'radiance',
  'sky-flash',
]);

/**
 * The five ops an override may apply, and each one's identity element — the
 * value that would make the op a no-op. Not used by the runtime blend (see
 * {@link composeOverride}'s own note on why it lerps the RESULT instead), but
 * documented and exported so a test can assert every op is genuinely a no-op
 * at its own neutral, and so a future caller has it without re-deriving it
 * (`feedback_blend_neutral_element_is_per_blend` — the neutral is a property
 * of the op, not a global constant).
 */
export const OVERRIDE_OPS = Object.freeze(['set', 'max', 'min', 'add', 'mul']);

/** @type {Readonly<Record<string, number|undefined>>} */
export const OP_NEUTRAL = Object.freeze({
  set: undefined, // 'set' has no numeric identity — it is inherently an override.
  max: -Infinity,
  min: Infinity,
  add: 0,
  mul: 1,
});

/**
 * Per-kind authored defaults. `envelope`/`overrides`/`intensity01` are all
 * independently overridable per-instance by whatever `addEvent` caller wants
 * (a GM's "custom" mana-storm, a front script's own timing) — these are just
 * the sensible starting point so `addEvent({kind:'ash-storm'})` alone already
 * does something considered rather than nothing.
 *
 * Timings are real seconds (envelopes are presentation pacing, the same
 * clock family as the axis eases — see `weather.js`'s own CLOCK RULING) and
 * were picked to read as the thing they name: an ash cloud rolls in over half
 * a minute and holds until a GM ends it; a lightning flash is 300ms total and
 * needs no GM at all, so it is the one kind with a numeric (not `'held'`)
 * sustain and self-removes.
 */
export const EVENT_KIND_DEFAULTS = Object.freeze({
  'ash-storm': Object.freeze({
    intensity01: 0.85,
    envelope: Object.freeze({ attackSec: 30, sustainSec: 'held', releaseSec: 45 }),
    overrides: Object.freeze([
      Object.freeze({ axis: 'cloudCover01', op: 'max', value: 0.85 }),
      Object.freeze({ axis: 'cloudType01', op: 'set', value: 1.0 }), // stratus
    ]),
    illuminant: null,
    precipKindOverride: 'ash',
    particleArchetype: 'ashfall',
    a11yFlash: false,
  }),
  aurora: Object.freeze({
    intensity01: 0.7,
    envelope: Object.freeze({ attackSec: 20, sustainSec: 'held', releaseSec: 30 }),
    overrides: Object.freeze([]), // §6.3 patchy illuminant — slice 6.
    illuminant: null,
    precipKindOverride: null,
    particleArchetype: null,
    a11yFlash: false,
  }),
  'blood-moon': Object.freeze({
    intensity01: 1.0,
    envelope: Object.freeze({ attackSec: 60, sustainSec: 'held', releaseSec: 60 }),
    overrides: Object.freeze([]), // needs world/moon.js — slice 5.
    illuminant: null,
    precipKindOverride: null,
    particleArchetype: null,
    a11yFlash: false,
  }),
  eclipse: Object.freeze({
    intensity01: 1.0,
    envelope: Object.freeze({ attackSec: 90, sustainSec: 'held', releaseSec: 90 }),
    overrides: Object.freeze([]), // needs env.skyKey — slice 5.
    illuminant: null,
    precipKindOverride: null,
    particleArchetype: null,
    a11yFlash: false,
  }),
  'volcanic-unrest': Object.freeze({
    intensity01: 0.75,
    envelope: Object.freeze({ attackSec: 40, sustainSec: 'held', releaseSec: 60 }),
    overrides: Object.freeze([]), // patchy illuminant — slice 6.
    illuminant: null,
    precipKindOverride: 'embers',
    particleArchetype: null,
    a11yFlash: false,
  }),
  'mana-storm': Object.freeze({
    intensity01: 1.0,
    envelope: Object.freeze({ attackSec: 15, sustainSec: 'held', releaseSec: 20 }),
    overrides: Object.freeze([]), // the "custom" door — the caller supplies its own.
    illuminant: null,
    precipKindOverride: null,
    particleArchetype: null,
    a11yFlash: false,
  }),
  gloom: Object.freeze({
    intensity01: 0.8,
    envelope: Object.freeze({ attackSec: 20, sustainSec: 'held', releaseSec: 30 }),
    overrides: Object.freeze([]), // veil/fill override surface does not exist yet.
    illuminant: null,
    precipKindOverride: null,
    particleArchetype: null,
    a11yFlash: false,
  }),
  radiance: Object.freeze({
    intensity01: 0.8,
    envelope: Object.freeze({ attackSec: 20, sustainSec: 'held', releaseSec: 30 }),
    overrides: Object.freeze([]), // veil/fill override surface does not exist yet.
    illuminant: null,
    precipKindOverride: null,
    particleArchetype: null,
    a11yFlash: false,
  }),
  'sky-flash': Object.freeze({
    intensity01: 1.0,
    // 30ms + 50ms + 220ms = 300ms, §6.2's own number for the storm's flash.
    envelope: Object.freeze({ attackSec: 0.03, sustainSec: 0.05, releaseSec: 0.22 }),
    overrides: Object.freeze([]), // fill+veil spike — needs the same surface as gloom/radiance.
    illuminant: null,
    precipKindOverride: null,
    particleArchetype: null,
    a11yFlash: true, // carried faithfully for the future flash consumer to gate on.
  }),
});

/**
 * Resolve a kind against the closed list. Fails OPEN — `ok:false` with a
 * reason, never a throw — the same shape `resolveArchetype`/`resolveBiome`
 * use, so `weather.js#addEvent` can refuse a typo'd kind without it ever
 * reaching `activeEvents`.
 * @param {string} kind
 * @returns {Readonly<{ok: boolean, defaults: object|null, reason: string|null}>}
 */
export function resolveEventKind(kind) {
  if (Object.hasOwn(EVENT_KIND_DEFAULTS, kind)) {
    return Object.freeze({ ok: true, defaults: EVENT_KIND_DEFAULTS[kind], reason: null });
  }
  return Object.freeze({ ok: false, defaults: null, reason: `unknown event kind '${kind}'` });
}

/** @param {number} v @returns {number} */
function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Where an envelope is right now, given how long it has run and (if a release
 * was explicitly triggered — see `weather.js#releaseEvent`) how long since.
 *
 * `sustainSec: 'held'` sustains at `progress01: 1` forever until
 * `elapsedSinceReleaseSec` stops being `null` — a GM's own hand ends it, the
 * same "an automated process does not get to decide this on its own" shape
 * pins already use for the Almanac's walk. A NUMERIC sustain needs no such
 * signal: it auto-advances into release on its own, which is what lets
 * `sky-flash` be fire-and-forget.
 *
 * A release may also be triggered early, mid-attack or mid-(numeric)-sustain
 * — `elapsedSinceReleaseSec != null` always wins over the natural schedule,
 * so "end this event now" behaves the same regardless of which phase it cut
 * off (a GM cutting an ash-storm short does not need to know which phase it
 * was in).
 *
 * @param {{attackSec: number, sustainSec: number|'held', releaseSec: number}} envelope
 * @param {number} elapsedSinceStartSec
 * @param {number|null} elapsedSinceReleaseSec - `null` until release triggers.
 * @returns {{phase: 'attack'|'sustain'|'release'|'done', progress01: number}}
 */
export function envelopePhase(envelope, elapsedSinceStartSec, elapsedSinceReleaseSec) {
  const attack = Number.isFinite(envelope?.attackSec) && envelope.attackSec > 0 ? envelope.attackSec : 0;
  const isHeld = envelope?.sustainSec === 'held';
  const sustain = isHeld
    ? Infinity
    : Number.isFinite(envelope?.sustainSec) && envelope.sustainSec >= 0
      ? envelope.sustainSec
      : 0;
  const release = Number.isFinite(envelope?.releaseSec) && envelope.releaseSec > 0 ? envelope.releaseSec : 0;
  const started = Number.isFinite(elapsedSinceStartSec) ? Math.max(0, elapsedSinceStartSec) : 0;

  if (elapsedSinceReleaseSec != null) {
    const sinceRelease = Math.max(0, elapsedSinceReleaseSec);
    if (sinceRelease >= release) return { phase: 'done', progress01: 0 };
    const p = release > 0 ? 1 - sinceRelease / release : 0;
    return { phase: 'release', progress01: clamp01(p) };
  }

  if (started < attack) {
    return { phase: 'attack', progress01: clamp01(attack > 0 ? started / attack : 1) };
  }
  const sinceSustainStart = started - attack;
  if (!isHeld && sinceSustainStart >= sustain) {
    const sinceReleaseStart = sinceSustainStart - sustain;
    if (sinceReleaseStart >= release) return { phase: 'done', progress01: 0 };
    const p = release > 0 ? 1 - sinceReleaseStart / release : 0;
    return { phase: 'release', progress01: clamp01(p) };
  }
  return { phase: 'sustain', progress01: 1 };
}

/**
 * Apply one override to one base value, blended by how far into its envelope
 * the event currently is.
 *
 * ⚠️ LERPS THE RESULT, NOT TOWARD THE OP'S NEUTRAL. `lerp(base, op(base,
 * value), t)` satisfies "zero effect at t=0, full effect at t=1" for EVERY op
 * in {@link OVERRIDE_OPS} without needing a numeric neutral to lerp FROM —
 * which matters because `set` has none ({@link OP_NEUTRAL}`.set` is
 * `undefined`, on purpose). Lerping toward `-Infinity` to make `max` "start
 * from nothing" is not arithmetic; lerping the two REAL values the axis takes
 * at t=0 and t=1 always is.
 *
 * @param {number} baseValue
 * @param {{op: string, value: number}} override
 * @param {number} effectiveProgress01 - envelope progress × the event's own
 *   `intensity01` dial — see `applyEventOverrides`.
 * @returns {number}
 */
export function composeOverride(baseValue, override, effectiveProgress01) {
  const t = clamp01(effectiveProgress01);
  if (t <= 0) return baseValue;
  let applied;
  switch (override.op) {
    case 'set':
      applied = override.value;
      break;
    case 'max':
      applied = Math.max(baseValue, override.value);
      break;
    case 'min':
      applied = Math.min(baseValue, override.value);
      break;
    case 'add':
      applied = baseValue + override.value;
      break;
    case 'mul':
      applied = baseValue * override.value;
      break;
    default:
      return baseValue; // Unknown op — weather.js#addEvent already refuses these; a no-op is the safe fallback here.
  }
  if (t >= 1) return applied;
  return baseValue + (applied - baseValue) * t;
}

/**
 * Fold every active event's overrides onto a base axis-value map, in order.
 *
 * Sequential fold (event 2 composes onto event 1's already-composed result,
 * not onto the untouched base) so any number of simultaneous events on the
 * same axis produce one well-defined, order-deterministic number — the same
 * "define composition for N, not just for 2" discipline
 * `feedback_composite_only_terms_miss_shared_buffers` argues for elsewhere.
 * Order is `events`' own iteration order (insertion order for a `Map`), so a
 * caller that cares can control it by re-ordering how events were added.
 *
 * ⚠️ PURE — returns a NEW object, never mutates `baseState` or any event.
 * `weather.js` calls this only at snapshot/status read time, never against
 * its own internal `state`, so a walk or a GM's slider is never corrupted by
 * a transient event (`toSnapshotWeather`'s own note on why events are a
 * read-time overlay, not a second write path onto `state`).
 *
 * @param {Record<string, number>} baseState - axis name → value.
 * @param {Array<{spec: object, startedAtRealSec: number, releasedAtRealSec: number|null}>} events
 * @param {number} nowRealSec
 * @returns {Record<string, number>}
 */
export function applyEventOverrides(baseState, events, nowRealSec) {
  const out = { ...baseState };
  for (const ev of events) {
    const elapsedSinceStart = nowRealSec - ev.startedAtRealSec;
    const elapsedSinceRelease = ev.releasedAtRealSec == null ? null : nowRealSec - ev.releasedAtRealSec;
    const { phase, progress01 } = envelopePhase(ev.spec.envelope, elapsedSinceStart, elapsedSinceRelease);
    if (phase === 'done') continue;
    const effectiveProgress = progress01 * clamp01(ev.spec.intensity01);
    for (const ov of ev.spec.overrides) {
      if (!Object.hasOwn(out, ov.axis)) continue;
      out[ov.axis] = composeOverride(out[ov.axis], ov, effectiveProgress);
    }
  }
  return out;
}
