/**
 * THE REAL CONSUMER TABLE for `weather.js#WEATHER_AXES` (mythica-machina-
 * press#390) — structured, checkable data replacing what was three
 * independently hand-maintained lists that had already drifted apart:
 * `WEATHER_AXES`'s own free-text `consumers` string (never validated against
 * anything), `tools/verify-structure.mjs`'s own separate hardcoded
 * `ui/no-dead-axis` pending-axis list (its own comment already admits it
 * doesn't know `cloudType01` has a UI reader), and `boot.js`'s fade-source
 * registration array (a THIRD independent hand-copy of the same two axis
 * names) — the exact "hand-maintained dispatch list forgets new effects"
 * shape this codebase names elsewhere, now happening to axis metadata
 * instead of effect wiring.
 *
 * ============================================================================
 * WHAT THIS FILE DOES AND DOES NOT DO
 * ============================================================================
 * This is a DECLARED fact table, verified by direct reading of the real
 * consumer files (file:line evidence in each entry's own comment) — NOT a
 * live runtime registry effects call into at boot time. That was a
 * deliberate choice over the alternative (each consumer file calling a
 * `registerAxisConsumer()` at construction time): `effects/shadow-access.js`
 * and `effects/sky-access.js` are constructed deep inside `vt/
 * vt-pan-viewer.js` — the single highest-risk, GPU-render-loop file in this
 * codebase — and adding a bookkeeping side-effect call there, however inert,
 * is a real-file edit to a file this project's own culture treats with
 * exceptional caution (fifteen rounds on one investigation,
 * `docs/planning/Light-Elevation-Occlusion-Failure.md`). A static, reviewed
 * table achieves the same catchable-drift property — {@link auditAxisConsumers}
 * below fails loudly the moment `WEATHER_AXES`'s own `consumerStatus` and
 * this table disagree — without touching that file at all. Migrating to a
 * live registration call is a legitimate later upgrade, not a compromise
 * this file forecloses; `hasRealConsumer`'s own signature does not change
 * either way.
 *
 * @module world/axis-consumer-registry
 */

/**
 * @typedef {{module: string, describe: string}} AxisConsumer
 */

/**
 * Every axis `weather.js#WEATHER_AXES` currently declares, mapped to its
 * REAL consumers — verified 2026-09-09 by direct reading, not copied from
 * any of the three lists this table replaces. An axis with an empty array
 * is genuinely unconsumed today (matches `consumerStatus: 'pending'`) —
 * absence from this object entirely is a DIFFERENT, worse claim ("nobody
 * has looked"), which {@link auditAxisConsumers} treats as its own problem.
 * @type {Readonly<Record<string, ReadonlyArray<Readonly<AxisConsumer>>>>}
 */
export const AXIS_CONSUMERS = Object.freeze({
  cloudCover01: Object.freeze([
    Object.freeze({ module: 'effects/shadow-access.js', describe: 'softens/fades sun-shadow casters' }),
    Object.freeze({ module: 'effects/sky-access.js', describe: 'key/fill/veil outdoor light mix' }),
    Object.freeze({ module: 'effects/grade/grade-ops.js', describe: 'environmental (auto) grade' }),
    Object.freeze({ module: 'boot.js (fadeSourceRegistry)', describe: "the weather board's fade/cue target" }),
  ]),
  precip01: Object.freeze([
    Object.freeze({
      module: 'effects/precipitation/precip-subsystem.js',
      describe: 'the real particle/mantle pipeline',
    }),
    Object.freeze({ module: 'boot.js (fadeSourceRegistry)', describe: "the weather board's fade/cue target" }),
  ]),
  temperature01: Object.freeze([
    Object.freeze({ module: 'world/weather.js#derivePrecipKind', describe: 'the rain/snow/sleet split' }),
    Object.freeze({ module: 'effects/precipitation/precip-subsystem.js', describe: "the mantle's dry-rate input" }),
  ]),
  // PENDING, genuinely — `world/cloud-field.js` (a real, 1200+ line
  // shape/shading/drift implementation) reads all three, but is exported
  // only through `world/index.js` and imported by NOTHING in `graph/
  // passes.js` or `boot.js` — a built module with zero wired consumers,
  // confirmed by grep, not assumed from `WEATHER_AXES`'s own claim.
  cloudType01: Object.freeze([]),
  cloudAltitudePx: Object.freeze([]),
  cloudScalePx: Object.freeze([]),
});

/**
 * @param {string} axisName
 * @returns {boolean} true when at least one real, verified consumer is on record.
 */
export function hasRealConsumer(axisName) {
  return (AXIS_CONSUMERS[axisName]?.length ?? 0) > 0;
}

/**
 * Cross-check `WEATHER_AXES`'s own declared `consumerStatus` against this
 * table. Call this from a Node test (see `axis-consumer-registry.test.mjs`)
 * so the exact drift this file exists to stop — an axis going live with
 * nobody updating `consumerStatus`, or `consumerStatus` claiming 'live' for
 * an axis this table has never heard a real consumer for — is a red test,
 * not a discovery six months later during another research pass.
 *
 * @param {Record<string, {consumerStatus?: string}>} axes - `WEATHER_AXES`.
 * @returns {string[]} problems found; empty means consistent.
 */
export function auditAxisConsumers(axes) {
  const problems = [];
  for (const [name, axis] of Object.entries(axes ?? {})) {
    if (!(name in AXIS_CONSUMERS)) {
      problems.push(
        `${name}: no entry in AXIS_CONSUMERS at all — add one (even an empty array) so a future audit covers it`
      );
      continue;
    }
    const has = hasRealConsumer(name);
    if (axis.consumerStatus === 'live' && !has) {
      problems.push(`${name}: WEATHER_AXES declares consumerStatus 'live' but AXIS_CONSUMERS lists no real consumer`);
    }
    if (axis.consumerStatus === 'pending' && has) {
      problems.push(
        `${name}: WEATHER_AXES declares consumerStatus 'pending' but AXIS_CONSUMERS lists ${AXIS_CONSUMERS[name].length} real consumer(s) — this axis went live and consumerStatus was never updated`
      );
    }
  }
  // The reverse gap: an AXIS_CONSUMERS entry for an axis WEATHER_AXES no
  // longer declares (a renamed or removed axis, this table left stale).
  for (const name of Object.keys(AXIS_CONSUMERS)) {
    if (!(name in (axes ?? {}))) {
      problems.push(
        `${name}: AXIS_CONSUMERS has an entry but WEATHER_AXES no longer declares this axis — stale, remove it`
      );
    }
  }
  return problems;
}
