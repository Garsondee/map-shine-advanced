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
    Object.freeze({
      module: 'world/cloud-field.js (via vt-pan-viewer.js)',
      describe: 'the rendered silhouette — capped at CLOUD_COVER_VISUAL_MAX for this reading only',
    }),
    Object.freeze({
      module: 'effects/lighting/environmental-light.js',
      describe: 'the cloud ground shadow on outdoor ambient (consumer #1)',
    }),
    Object.freeze({
      module: 'effects/window/window-render.js',
      describe: "window light's overcast blur (edge/contrast) + up-to-50% dim",
    }),
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
  // LIVE as of 2026-09-10 — `vt/vt-pan-viewer.js#updateEnvSnapshot` now
  // resolves the cloud recipe and pushes the field's uniforms every frame
  // (the "THE CLOUD FIELD" block, ticked unconditionally alongside the
  // weather/grade pushes), and the ground-shadow sample reads the deck's
  // own altitude for its sun-relative offset.
  cloudType01: Object.freeze([
    Object.freeze({
      module: 'world/cloud-field.js#cloudRecipeFor (via vt-pan-viewer.js)',
      describe: 'resolves the cirrus/altocumulus/cumulus/stratocumulus/stratus recipe blend',
    }),
  ]),
  cloudAltitudePx: Object.freeze([
    Object.freeze({
      module: 'effects/lighting/light-visibility.js#projectShadowOffset (via vt-pan-viewer.js)',
      describe: "the ground shadow's own sun-relative offset length (and, via that length, its streak span)",
    }),
  ]),
  cloudScalePx: Object.freeze([
    Object.freeze({
      module: 'world/cloud-field.js#pushCloudUniforms (via vt-pan-viewer.js)',
      describe: "the field's own feature wavelength — cell spacing, streak/erosion scale",
    }),
  ]),
});

/**
 * @param {string} axisName
 * @param {Record<string, ReadonlyArray<unknown>>} [consumersTable] - defaults
 *   to the real {@link AXIS_CONSUMERS}. Injectable so a test can exercise the
 *   "an axis has zero consumers" branch on a small fixture rather than
 *   depending on some REAL axis staying permanently unwired — a table that,
 *   by this file's own stated purpose, is expected to keep filling in over
 *   time (see `axis-consumer-registry.test.mjs`'s own header on why this
 *   parameter exists).
 * @returns {boolean} true when at least one real, verified consumer is on record.
 */
export function hasRealConsumer(axisName, consumersTable = AXIS_CONSUMERS) {
  return (consumersTable[axisName]?.length ?? 0) > 0;
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
 * @param {Record<string, ReadonlyArray<unknown>>} [consumersTable] - defaults
 *   to the real {@link AXIS_CONSUMERS} — see {@link hasRealConsumer}'s own
 *   doc on why this is injectable.
 * @returns {string[]} problems found; empty means consistent.
 */
export function auditAxisConsumers(axes, consumersTable = AXIS_CONSUMERS) {
  const problems = [];
  for (const [name, axis] of Object.entries(axes ?? {})) {
    if (!(name in consumersTable)) {
      problems.push(
        `${name}: no entry in AXIS_CONSUMERS at all — add one (even an empty array) so a future audit covers it`
      );
      continue;
    }
    const has = hasRealConsumer(name, consumersTable);
    if (axis.consumerStatus === 'live' && !has) {
      problems.push(`${name}: WEATHER_AXES declares consumerStatus 'live' but AXIS_CONSUMERS lists no real consumer`);
    }
    if (axis.consumerStatus === 'pending' && has) {
      problems.push(
        `${name}: WEATHER_AXES declares consumerStatus 'pending' but AXIS_CONSUMERS lists ${consumersTable[name].length} real consumer(s) — this axis went live and consumerStatus was never updated`
      );
    }
  }
  // The reverse gap: an AXIS_CONSUMERS entry for an axis WEATHER_AXES no
  // longer declares (a renamed or removed axis, this table left stale).
  for (const name of Object.keys(consumersTable)) {
    if (!(name in (axes ?? {}))) {
      problems.push(
        `${name}: AXIS_CONSUMERS has an entry but WEATHER_AXES no longer declares this axis — stale, remove it`
      );
    }
  }
  return problems;
}
