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
 * `deriveRegionDarknessAdjusters` is the testable validation logic,
 * `readActiveDarknessRegions` is the live, impure gatherer. Never throws.
 *
 * EVERY BEHAVIOUR, NOT THE FIRST (2026-11-09, mmp-78u.22). Foundry makes one
 * darkness mesh per active behaviour (`adjust-darkness-level.mjs`
 * `#onBehaviorViewed`) and the minimum (brightest) adjusted value wins
 * whatever their order. So a Region with two darkness behaviours gives TWO
 * adjusters here, each with its own `key` (`<regionId>#<behaviour id>`), and the
 * existing min rule (`computeRegionAdjustedDarkness`, the field's brightest-last
 * draw) resolves them. This used to read only the first active one, so
 * "OVERRIDE .9 then .4" rendered 0.9 where Foundry shows 0.4 (lab IR-26).
 *
 * LEVELS (2026-11-09, mmp-78u.19). Each adjuster carries the Region's own
 * `levels` (ids; empty = every Level, `canvas-document.mjs#includedInLevel`).
 * Foundry only views a darkness behaviour on those Levels
 * (`board.mjs#handleRegionBehaviorViewedEvents`); the viewer applies that gate
 * with `effects/lighting/region-geometry.js#selectRegionsForViewedFloor`, using
 * `readRegionViewedLevelId` below for the viewed Level.
 *
 * @module foundry/scene-regions
 */

/** @param {*} v @returns {number} clamped to [0,1]; a non-finite input reads as 0 */
function clamp01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/**
 * Validate + normalize one raw region read into the adjusters `region-darkness.js`
 * consumes: ONE PER ACTIVE `adjustDarknessLevel` BEHAVIOUR (see this module's
 * header), or `[]` if the region contributes no darkness adjustment this frame
 * (hidden, no shapes, or no active darkness behaviour).
 *
 * @param {*} raw - `{regionId, hidden, shapes, elevationBottom, elevationTop,
 *   levels, behaviors: [{id, type, disabled, mode, modifier}]}`, already plucked
 *   from a live `RegionDocument` (or a Node-test stand-in with the same shape).
 *   `elevationBottom`/`elevationTop` are `null` when unrestricted — Foundry's
 *   own convention (`common/documents/region.mjs`'s `elevation` field
 *   comment: "Treat null as -Infinity"/"+Infinity" respectively). `levels` is
 *   the Region's Level ids (`SceneLevelsSetField`); empty or absent = every Level.
 * @returns {Array<{key: string, regionId: string, behaviorId: string, mode: number,
 *   modifier: number, shapes: object[], elevationBottom: number|null,
 *   elevationTop: number|null, levels: string[]}>}
 */
export function deriveRegionDarknessAdjusters(raw) {
  if (!raw || raw.hidden) return [];
  if (typeof raw.regionId !== 'string' || raw.regionId.length === 0) return [];
  const shapes = Array.isArray(raw.shapes) ? raw.shapes : null;
  if (!shapes || shapes.length === 0) return [];
  const behaviors = Array.isArray(raw.behaviors) ? raw.behaviors : [];
  // finite-or-null, NEVER clamp01'd — these are world elevation units (can be
  // negative, e.g. a basement), a completely different value class from the
  // mode/modifier fields below. A non-finite authored value (never expected,
  // but Foundry data can be malformed) reads as null (unrestricted) rather
  // than propagating a NaN into every downstream elevation-band comparison.
  const elevationBottom = Number.isFinite(raw.elevationBottom) ? raw.elevationBottom : null;
  const elevationTop = Number.isFinite(raw.elevationTop) ? raw.elevationTop : null;
  const levels = Array.isArray(raw.levels) ? raw.levels.filter((id) => typeof id === 'string' && id.length > 0) : [];
  const out = [];
  behaviors.forEach((b, index) => {
    if (!b || b.type !== 'adjustDarknessLevel' || b.disabled) return;
    // The behaviour's own document id keeps the key stable when a sibling
    // behaviour is added or removed; its position is the fallback.
    const behaviorId = typeof b.id === 'string' && b.id.length > 0 ? b.id : String(index);
    out.push({
      key: `${raw.regionId}#${behaviorId}`,
      regionId: raw.regionId,
      behaviorId,
      mode: Number.isInteger(b.mode) ? b.mode : 0,
      modifier: clamp01(b.modifier ?? 0),
      shapes,
      elevationBottom,
      elevationTop,
      levels,
    });
  });
  return out;
}

/**
 * Live read of every region with an active, non-hidden darkness-adjusting
 * behavior. Never throws — a Foundry API surprise here must never take a
 * render frame down with it (same reasoning as every other `readScene*`/
 * `readActive*` function in this zone).
 *
 * @returns {{regions: ReturnType<typeof deriveRegionDarknessAdjusters>,
 *   source: 'scene'|'default', reason: string|null}} one entry per active
 *   darkness BEHAVIOUR (a Region with two gives two, sharing its `regionId`).
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
            id: b?.id,
            type: b?.type,
            disabled: b?.disabled,
            mode: b?.system?.mode,
            modifier: b?.system?.modifier,
          }))
        : [];
      const adjusters = deriveRegionDarknessAdjusters({
        regionId: region?.id,
        hidden: region?.hidden,
        shapes: region?.shapes,
        // RegionDocument.elevation — common/documents/region.mjs — a real,
        // separate {bottom,top} field (verified against source, 2026-07-19,
        // the region-darkness elevation-gating fix). `?.elevation` itself
        // can legitimately be absent on a malformed/Node-test document;
        // deriveRegionDarknessAdjusters' own Number.isFinite guard handles
        // an absent/non-numeric bottom or top as "unrestricted".
        elevationBottom: region?.elevation?.bottom,
        elevationTop: region?.elevation?.top,
        // RegionDocument.levels — a Set of Level ids in v14 (SceneLevelsSetField).
        levels: region?.levels ? Array.from(region.levels) : [],
        behaviors,
      });
      for (const adjuster of adjusters) regions.push(adjuster);
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
 * The Level id a Region's `levels` are tested against this frame: the Level
 * MSA is drawing (`floorLevelId`, the viewer's current floor) when it is a real
 * Level of this scene, else Foundry's `canvas.level` (the single-floor
 * `'legacy'` case — the same fallback `scene-wall-clip.js` takes, with its
 * reasons). `null` when neither resolves: the caller then fails OPEN (every
 * Region stays active), never darkness-muting a scene on a lookup miss.
 * @param {string|null} floorLevelId
 * @returns {string|null}
 */
export function readRegionViewedLevelId(floorLevelId) {
  try {
    if (typeof canvas === 'undefined' || !canvas) return null;
    if (typeof floorLevelId === 'string' && floorLevelId && canvas.scene?.levels?.get?.(floorLevelId)) {
      return floorLevelId;
    }
    const id = canvas.level?.id;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
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
