/**
 * THE REGION READER — the one place `canvas.scene.regions` (and, via each
 * region's own `behaviors` embedded collection, its "Adjust Darkness Level"
 * behavior) is read (2026-07-19).
 *
 * Verified against source: `common/documents/region-behavior.mjs`'s
 * `coreTypes` lists TWELVE behavior types; only TWO are in this project's
 * current scope, matching the author's own framing ("just focusing on two
 * things, leaving the other as a stub to pick up when we do weather"):
 *   - `adjustDarknessLevel` — built here, feeds `effects/lighting/
 *     region-darkness.js`'s per-point math (schema: `client/data/region-
 *     behaviors/adjust-darkness-level.mjs`, `{mode, modifier}`).
 *   - `suppressWeather` — a DELIBERATE STUB. `readSuppressWeatherStub`
 *     exists only as the findable marker for "build this here" — it has no
 *     real consumer yet (world/environment.js's own `DEFAULT_WEATHER` is not
 *     wired into any simulation a region could suppress), so reading real
 *     data for it now would be designing for a hypothetical this project's
 *     own doctrine warns against (same reasoning `frame.snapshot`'s
 *     `res:view`/`res:scene` gave for staying `status:'future'` a session
 *     ago). Picked up for real alongside weather simulation, not before.
 *
 * Split pure-vs-live the same way every other `foundry/` reader does:
 * `deriveRegionDarknessAdjuster` is the testable validation logic,
 * `readActiveDarknessRegions` is the live, impure gatherer. Never throws.
 *
 * @module foundry/scene-regions
 */

/** @param {*} v @returns {number} clamped to [0,1]; a non-finite input reads as 0 */
function clamp01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/**
 * Validate + normalize one raw region read into the shape `region-darkness.js`
 * consumes, or `null` if it contributes no darkness adjustment this frame
 * (hidden, no shapes, or no ACTIVE `adjustDarknessLevel` behavior).
 *
 * @param {*} raw - `{regionId, hidden, shapes, elevationBottom, elevationTop,
 *   behaviors: [{type, disabled, mode, modifier}]}`, already plucked from a
 *   live `RegionDocument` (or a Node-test stand-in with the same shape).
 *   `elevationBottom`/`elevationTop` are `null` when unrestricted — Foundry's
 *   own convention (`common/documents/region.mjs`'s `elevation` field
 *   comment: "Treat null as -Infinity"/"+Infinity" respectively).
 * @returns {{regionId: string, mode: number, modifier: number, shapes: object[],
 *   elevationBottom: number|null, elevationTop: number|null}|null}
 */
export function deriveRegionDarknessAdjuster(raw) {
  if (!raw || raw.hidden) return null;
  if (typeof raw.regionId !== 'string' || raw.regionId.length === 0) return null;
  const shapes = Array.isArray(raw.shapes) ? raw.shapes : null;
  if (!shapes || shapes.length === 0) return null;
  const behaviors = Array.isArray(raw.behaviors) ? raw.behaviors : [];
  // Foundry allows more than one behavior of the same type on a region; this
  // reads the FIRST active one — a rare-edge-case simplification (multiple
  // adjustDarknessLevel behaviors on ONE region), named rather than silent.
  const active = behaviors.find((b) => b && b.type === 'adjustDarknessLevel' && !b.disabled);
  if (!active) return null;
  const mode = Number.isInteger(active.mode) ? active.mode : 0;
  // finite-or-null, NEVER clamp01'd — these are world elevation units (can be
  // negative, e.g. a basement), a completely different value class from the
  // mode/modifier fields above. A non-finite authored value (never expected,
  // but Foundry data can be malformed) reads as null (unrestricted) rather
  // than propagating a NaN into every downstream elevation-band comparison.
  const elevationBottom = Number.isFinite(raw.elevationBottom) ? raw.elevationBottom : null;
  const elevationTop = Number.isFinite(raw.elevationTop) ? raw.elevationTop : null;
  return {
    regionId: raw.regionId,
    mode,
    modifier: clamp01(active.modifier ?? 0),
    shapes,
    elevationBottom,
    elevationTop,
  };
}

/**
 * Live read of every region with an active, non-hidden darkness-adjusting
 * behavior. Never throws — a Foundry API surprise here must never take a
 * render frame down with it (same reasoning as every other `readScene*`/
 * `readActive*` function in this zone).
 *
 * @returns {{regions: Array<NonNullable<ReturnType<typeof deriveRegionDarknessAdjuster>>>,
 *   source: 'scene'|'default', reason: string|null}}
 */
export function readActiveDarknessRegions() {
  try {
    const collection = typeof canvas !== 'undefined' ? (canvas?.scene?.regions ?? null) : null;
    if (!collection) {
      return {
        regions: [],
        source: 'default',
        reason: 'no active scene (canvas.scene.regions is absent) — reading as zero regions, not guessed',
      };
    }
    const regions = [];
    for (const region of collection) {
      const behaviors = region?.behaviors
        ? [...region.behaviors].map((b) => ({
            type: b?.type,
            disabled: b?.disabled,
            mode: b?.system?.mode,
            modifier: b?.system?.modifier,
          }))
        : [];
      const adjuster = deriveRegionDarknessAdjuster({
        regionId: region?.id,
        hidden: region?.hidden,
        shapes: region?.shapes,
        // RegionDocument.elevation — common/documents/region.mjs — a real,
        // separate {bottom,top} field (verified against source, 2026-07-19,
        // the region-darkness elevation-gating fix). `?.elevation` itself
        // can legitimately be absent on a malformed/Node-test document;
        // deriveRegionDarknessAdjuster's own Number.isFinite guard handles
        // an absent/non-numeric bottom or top as "unrestricted".
        elevationBottom: region?.elevation?.bottom,
        elevationTop: region?.elevation?.top,
        behaviors,
      });
      if (adjuster) regions.push(adjuster);
    }
    return { regions, source: 'scene', reason: null };
  } catch (err) {
    return {
      regions: [],
      source: 'default',
      reason: `reading canvas.scene.regions threw: ${err?.message ?? err}`,
    };
  }
}

/**
 * THE DELIBERATE STUB — see this module's header. Always reads as "nothing
 * to suppress", honestly labelled `notBuilt: true` rather than silently
 * returning the same shape a real implementation would (which would let a
 * future caller mistake "always false" for "really checked and found none").
 *
 * @returns {{suppressed: false, notBuilt: true}}
 */
export function readSuppressWeatherStub() {
  return { suppressed: false, notBuilt: true };
}
