/**
 * diag/param-read-health.js — THE READ-TRACKING PROXY (U6, docs/holy/
 * UI-Testament.md §9): "declared − read" as an automated, ongoing detector
 * for a control that quietly stopped being read. A DIFFERENT signal from
 * `core/params-schema.js#PARAM_STATUS`'s `status:'planned'` — that one is a
 * manual, day-one admission made at authoring time; this one watches a
 * LIVE param for going silently unread after having once worked. Neither
 * auto-flips the other (params-schema.js's own header says so).
 *
 * ============================================================================
 * WHERE THIS MUST WRAP — THE BOUNDARY THAT MAKES THE SIGNAL MEAN ANYTHING
 * ============================================================================
 *
 * The Testament's own U6 note: "the read-tracking proxy must wrap the
 * renderer's own read closures, not the effect's own internal per-frame
 * state reads, or everything looks falsely 'read'". Concretely, for water
 * (research, 2026-08-18), THREE semantically different call sites touch a
 * resolved params object, and only ONE of them is "the renderer actually
 * consumed this":
 *
 *   1. STORAGE HANDOFF — `effects/registry.js#resolveAndApply` calls
 *      `entry.apply(resolved)` once per cascade resolve; every effect just
 *      stores the WHOLE object (`readout.params = resolved.params`). No
 *      individual key is read here — wrapping at this seam and stopping
 *      would track nothing.
 *   2. RENDER CONSUMPTION — `water-registration.js#getRenderState()` is
 *      what `water-surface-subsystem.js#sync()` and `water-flow-
 *      subsystem.js` call, once per frame, to get the params they actually
 *      push into materials/uniforms. THIS is the boundary to wrap.
 *   3. UI DISPLAY — the FOH/ROH card's `getValue(id)` reads
 *      `effect.getReadout().params?.[id]` (a SEPARATE accessor,
 *      `getReadout()`, not `getRenderState()`) every time a control
 *      renders. Wrapping here would mark a param "read" the instant its
 *      slider is drawn, regardless of whether the shader ever touches it —
 *      exactly the false-positive the Testament's warning is about. Water's
 *      two accessors are already architecturally separate for an unrelated
 *      reason (`getRenderState` decodes `tint` to linear; `getReadout`
 *      returns the raw stored object) — this module rides that existing
 *      split rather than inventing a new one.
 *
 * ============================================================================
 * WHY A SPREAD BEFORE THE WRAP WOULD LIE ("FULLY READ" ON FRAME ONE)
 * ============================================================================
 *
 * `{...proxy}` invokes the `get` trap once for EVERY own enumerable key
 * (object spread reads `[[OwnPropertyKeys]]` then `[[Get]]`s each one) —
 * so wrapping BEFORE a `{...p, tint: ...}`-shaped spread (water/fluid/
 * window's own `getRenderState()`, all three, as of this research) would
 * mark every declared param "read" on the very first call, whether or not
 * `sync()` goes on to actually use each one. The caller must wrap LAST,
 * immediately before the true per-key reads, and any downstream derived-
 * field merge must preserve per-key laziness (e.g. `Object.assign(Object.
 * create(tracked), {derivedField: ...})` — a prototype delegation, not a
 * spread) rather than flattening the proxy into a plain object.
 *
 * @module diag/param-read-health
 */

/** effectId -> Set<paramKey> actually read via a tracked proxy, this session. */
const readSets = new Map();

/**
 * Wrap a resolved params object so every property GET is recorded against
 * `effectId`. Call this at the render-consumption boundary ONLY (see this
 * module's header) — never at storage handoff or UI display.
 *
 * Non-object input (null, a primitive) passes through unwrapped — there is
 * nothing to track a read on, and a caller handed `{}` `?? {}` a moment
 * earlier should not have to guard twice.
 *
 * @param {string} effectId - e.g. `'water'`, matching the manifest id.
 * @param {object} params - the resolved params object for this frame.
 * @returns {object} a Proxy over `params` (or `params` itself if not an object).
 */
export function wrapForReadTracking(effectId, params) {
  if (!params || typeof params !== 'object') return params;
  let seen = readSets.get(effectId);
  if (!seen) {
    seen = new Set();
    readSets.set(effectId, seen);
  }
  return new Proxy(params, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') seen.add(prop);
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * `declared - read` for one effect, against ITS OWN params schema.
 * `read` only ever grows within a session (a read is never "un-read") —
 * this is a "has this control ever been observed reaching the renderer"
 * signal, not a per-frame liveness check.
 *
 * A fresh scene/session with no render frame yet is a true, honest `read:
 * 0` — not an error state. The count climbs to match reality within one
 * frame of the render subsystem's first `sync()`.
 *
 * @param {string} effectId
 * @param {Record<string, object>} schema - the effect's params schema
 *   (e.g. `WATER_PARAMS`), keyed exactly like `validateParamsSchema` reads it.
 * @returns {{declared: number, read: number, orphaned: string[]}}
 */
export function getParamHealth(effectId, schema) {
  const declared = Object.keys(schema ?? {});
  const seen = readSets.get(effectId) ?? new Set();
  const orphaned = declared.filter((key) => !seen.has(key));
  return { declared: declared.length, read: declared.length - orphaned.length, orphaned };
}

/**
 * Clear tracked reads. `effectId` omitted clears every effect — mainly for
 * tests; nothing in the live renderer needs to reset this mid-session (a
 * param that was read once stays "observed reachable" for the rest of the
 * session, which is the intended, honest semantics above).
 * @param {string} [effectId]
 */
export function resetParamReadTracking(effectId) {
  if (effectId) readSets.delete(effectId);
  else readSets.clear();
}
