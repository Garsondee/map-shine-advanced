/**
 * WALL SEGMENTS — the one place `canvas.scene.walls` is read (`foundry/
 * adapter-only`). Feeds Wind.md Tier 1's structure bake (`world/wind-
 * bake.js#rasterizeWallsToGrid`): a coarse wind field needs to know which
 * cells air cannot cross, and a wall (closed) or a door (open/closed) is
 * exactly that boundary — the SAME data Foundry's own `ClockwiseSweepPolygon`
 * already reads for light/sight, but flattened here to plain segments a
 * grid rasterizer can consume, rather than a per-point visibility sweep
 * (`scene-wall-clip.js`'s own job, a different question).
 *
 * FIELD NAMES VERIFIED AGAINST SOURCE (not guessed) —
 * `common/documents/wall.mjs` + `common/constants.mjs`:
 *   c      : [x1,y1,x2,y2] — the segment's own endpoints, canvas px.
 *   move   : WALL_MOVEMENT_TYPES — NONE(0) = does not collide with movement,
 *            NORMAL(20) = collides. Only TWO values exist for `move` — it is
 *            a genuinely binary field, schema default NORMAL(20).
 *   door   : WALL_DOOR_TYPES — NONE(0) = not a door at all.
 *   ds     : WALL_DOOR_STATES — CLOSED(0) / OPEN(1) / LOCKED(2).
 *   levels : a real `Set` of Level ids (SceneLevelsSetField extends SetField)
 *            — EMPTY means "every Level" (verified, `scene-wall-clip.js`'s
 *            own header already established this convention for the same
 *            per-floor wall scoping).
 *
 * SOLIDITY RULE (`deriveWallSolid`, the pure half): a wall blocks wind iff it
 * blocks MOVEMENT at all (`move !== NONE`) and it is not currently an open
 * door — MOVEMENT alone, deliberately NOT `sight` (2026-07-22, author's own
 * correction after a same-day round-trip: "we need to block wind only when
 * a wall blocks movement... transparent glass walls that block movement
 * block wind but not vision" — a wall being visually see-through says
 * nothing about whether air passes through it; a closed glass window is
 * physically airtight regardless of `sight:NONE`. A brief same-day detour
 * DID require BOTH move and sight to block, on the theory that "transparent"
 * meant wind-permeable like a fence — WRONG per the author's own physical
 * intuition, reverted). A wall authored with `move: NONE` (a purely
 * decorative, walk-through outline) still lets air through — the same
 * physical intuition Wind.md §4 states plainly ("doors are walls with a
 * toggle").
 *
 * APERTURE RULE (`deriveWallAperture`, 2026-08-03, `docs/planning/
 * Aperture-Gobo.md`): a wall is an aperture — solid enough to stand in a
 * doorway's frame, but a window for LIGHT — iff it blocks movement AND its
 * `light` sense is `PROXIMITY`.
 *
 * ⚠️ CORRECTED LIVE, 2026-08-03, same session — the FIRST cut of this
 * predicate used `light: NONE`, reasoned from the schema alone ("None" reads
 * as the plain-English choice for "doesn't block"). The author corrected
 * this directly, from actually authoring windows in Foundry, not from the
 * spec: **`light: PROXIMITY` is Foundry's own real convention for a
 * window** — a wall that stays opaque to light until a source sits within
 * its own `threshold.light` distance, at which point light passes. `light:
 * NONE` is a much blunter, rarer choice (permanently transparent to light,
 * used for all kinds of things that are not windows — decorative dividers,
 * terrain edges, whatever else a map author never meant this effect to
 * touch). Matching on `NONE` MASSIVELY over-matched on a real map (317
 * aperture candidates found across the scene, 189 dropped by the per-light
 * cap) and produced visible knock-on effects on ordinary terrain walls that
 * were never meant to be windows at all — exactly the class of bug
 * `feedback_membership_beats_derived_threshold` warns about: `NONE` LOOKED
 * like the right membership test without being the authored one.
 *
 * This is the SAME `move` half `deriveWallSolid` already reads, plus a THIRD
 * field neither existing predicate touches: `light` (`common/documents/
 * wall.mjs`, verified against source same as every other field here) is its
 * own `EDGE_SENSE_TYPES` field, schema default `NORMAL` — meaning an
 * ORDINARY, never-touched wall blocks light exactly like it blocks movement,
 * and `light: PROXIMITY` is a real, deliberate authoring choice (a GM
 * explicitly marking a window), never the resting state of an unedited wall.
 * `sight` is deliberately not read here, same reasoning as `deriveWallSolid`'s
 * own: a leaded-glass window that blocks SIGHT while passing LIGHT is a real
 * thing an author can draw, and it is still an aperture for this module's
 * purposes — light is the only sense this predicate answers for. The
 * `threshold.light` DISTANCE itself is deliberately NOT re-read or
 * re-enforced here — Foundry's own sweep already decides whether a given
 * light source is close enough for light to actually cross this wall (that
 * is what shapes `source.shape.points`, the SAME polygon this whole effect's
 * mesh is built from); this predicate only answers "is this wall the KIND of
 * wall a window pattern belongs on", never "is light passing through it
 * right now" — that second question is Foundry's alone to answer, and it
 * already has, by the time a light's mesh even exists to draw on.
 *
 * @module foundry/scene-walls
 */

// Verified against `common/constants.mjs` — kept as local numbers (not a
// live read of the global CONST) so `deriveWallSolid` stays pure and
// Node-testable with no Foundry environment at all. Defaults match the
// SCHEMA's own defaults (`common/documents/wall.mjs`), not an arbitrary
// choice — an ordinary wall that never explicitly set a field genuinely HAS
// that field's schema default at the document level, so a missing field
// here should read exactly the way a real, freshly-created wall document
// does. `move`'s own NORMAL value was WRONGLY recorded as `1` before
// 2026-07-22 — verified against source it is `20` (EDGE_SENSE_TYPES.NORMAL,
// `move` is defined as an alias of that same shared enum, not an
// independent 0/1 field). That mistake was harmless in practice (the only
// comparison ever made against it is `!== NONE`, never `=== NORMAL`), fixed
// here for honesty, not because it changed prior behaviour.
const WALL_MOVEMENT_NONE = 0; // CONST.WALL_MOVEMENT_TYPES.NONE === CONST.EDGE_SENSE_TYPES.NONE
const WALL_MOVEMENT_NORMAL = 20; // CONST.WALL_MOVEMENT_TYPES.NORMAL === CONST.EDGE_SENSE_TYPES.NORMAL — the schema's own default
const WALL_DOOR_NONE = 0; // CONST.WALL_DOOR_TYPES.NONE — the schema's own default
const WALL_DOOR_STATE_CLOSED = 0; // CONST.WALL_DOOR_STATES.CLOSED — the schema's own default
const WALL_DOOR_STATE_OPEN = 1; // CONST.WALL_DOOR_STATES.OPEN
// `light` is its OWN EDGE_SENSE_TYPES field (common/documents/wall.mjs:58-60,
// verified against source), kept as separate named constants from `move`'s
// even though the numeric values coincide — same one-constant-per-field style
// this file already uses for door/move. Schema default is NORMAL(20): an
// unedited wall blocks light exactly like it blocks movement. PROXIMITY(30)
// is Foundry's own real "window" sense — see deriveWallAperture's own header
// for why this replaced an initial (wrong) NONE(0) reading.
const WALL_LIGHT_NORMAL = 20; // CONST.EDGE_SENSE_TYPES.NORMAL — the schema's own default (blocks light)
const WALL_LIGHT_PROXIMITY = 30; // CONST.EDGE_SENSE_TYPES.PROXIMITY — Foundry's own window convention: opaque beyond threshold.light, passable within it
const WALL_DIR_BOTH = 0; // CONST.WALL_DIRECTIONS.BOTH === CONST.EDGE_DIRECTIONS.BOTH — the schema's own default (collides from both sides)

/**
 * Is this wall a barrier to wind right now? Pure — no Foundry, no canvas —
 * so the rule is Node-tested independently of ever having a live scene.
 *
 * A one-way wall (`dir !== BOTH`) is treated as non-solid entirely (2026-09-03,
 * author request: wind particles were being blocked by one-way walls the
 * same as ordinary walls). Real Foundry movement collision only blocks a
 * one-way wall from ITS restricted side, which would need the wind's
 * direction of travel at this edge to reproduce properly; short of that,
 * treating it as fully open is closer to reality than treating it as fully
 * solid, and matches the simplicity of every other rule in this file.
 *
 * @param {{move?: number, door?: number, ds?: number, dir?: number}} [wall] - raw field
 *   values off a WallDocument (or a plain test fixture of the same shape).
 *   A missing field falls back to the SCHEMA's own default, not an
 *   arbitrary choice (see this file's own header). `sight` is deliberately
 *   NOT read — see this file's own header for why it must stay out of the
 *   wind-solidity question.
 * @returns {boolean}
 */
export function deriveWallSolid({ move, door, ds, dir } = {}) {
  const moveVal = Number.isFinite(move) ? move : WALL_MOVEMENT_NORMAL;
  const doorVal = Number.isFinite(door) ? door : WALL_DOOR_NONE;
  const dsVal = Number.isFinite(ds) ? ds : WALL_DOOR_STATE_CLOSED;
  const dirVal = Number.isFinite(dir) ? dir : WALL_DIR_BOTH;
  const blocksMovement = moveVal !== WALL_MOVEMENT_NONE;
  const isDoor = doorVal !== WALL_DOOR_NONE;
  const isOpenDoor = isDoor && dsVal === WALL_DOOR_STATE_OPEN;
  const isOneWay = dirVal !== WALL_DIR_BOTH;
  return blocksMovement && !isOpenDoor && !isOneWay;
}

/**
 * Would this wall be a barrier EVEN IF it had no door at all — i.e. ignoring
 * `door`/`ds` entirely, just "does `move` block." (2026-07-22, the
 * door-distance penetration falloff — author request: "the effect of the
 * wind drops off as it travels further away from the nearest door that is
 * open.") This is deliberately `deriveWallSolid`'s FIRST half only, never
 * subtracting the open-door carve-out: a door (open OR closed) still counts
 * as a barrier here, so `world/wind-enclosure.js`'s "classify EXTERIOR vs
 * reached-only-via-a-door" flood-fill can tell a courtyard (reachable
 * without crossing ANY door) apart from a room that is only connected
 * because a SPECIFIC door happens to be open right now — the falloff then
 * measures distance from THAT threshold. A non-door wall (`door: NONE`)
 * behaves identically to `deriveWallSolid` (there is no door state to
 * ignore); a `move: NONE` decorative wall still never blocks, same as always.
 *
 * @param {{move?: number}} [wall] - raw field values off a WallDocument (or
 *   a plain test fixture). A missing field falls back to the SCHEMA's own
 *   default (see this file's own header).
 * @returns {boolean}
 */
export function deriveWallBlocksExterior({ move } = {}) {
  const moveVal = Number.isFinite(move) ? move : WALL_MOVEMENT_NORMAL;
  return moveVal !== WALL_MOVEMENT_NONE;
}

/**
 * Is this wall an APERTURE — solid to movement, but a window for LIGHT?
 * (`docs/planning/Aperture-Gobo.md` §2.1.) Pure — no Foundry, no canvas — so
 * this is Node-tested the same way `deriveWallSolid` is.
 *
 * `move !== NONE && light === PROXIMITY`. This is Foundry's OWN convention
 * for authoring a window — a wall that stops a token but lets light through
 * once a source sits within the wall's own `threshold.light` distance — not
 * a guess from the schema's field names (see this function's own module
 * header for the live correction this replaced: an earlier `light === NONE`
 * reading was plausible from the spec alone and wrong in practice, matching
 * far more walls than a map's actual windows). A `move: NONE` decorative
 * wall is never an aperture (there is nothing for a window to be cut INTO);
 * a wall whose `light` was never touched (schema default `NORMAL`) is never
 * an aperture either — an aperture is always a deliberate authored choice,
 * never the resting state of an unedited wall.
 *
 * @param {{move?: number, light?: number}} [wall] - raw field values off a
 *   WallDocument (or a plain test fixture). A missing field falls back to
 *   the SCHEMA's own default (see this file's own header), same discipline
 *   as `deriveWallSolid`/`deriveWallBlocksExterior`.
 * @returns {boolean}
 */
export function deriveWallAperture({ move, light } = {}) {
  const moveVal = Number.isFinite(move) ? move : WALL_MOVEMENT_NORMAL;
  const lightVal = Number.isFinite(light) ? light : WALL_LIGHT_NORMAL;
  return moveVal !== WALL_MOVEMENT_NONE && lightVal === WALL_LIGHT_PROXIMITY;
}

/**
 * Read every wall segment for the active scene, scoped to `levelId` the
 * SAME way `scene-wall-clip.js` already scopes candle light-clipping (an
 * empty `wall.levels` set means "every Level"). Never throws — a live
 * Foundry API surprise (no active scene, a malformed wall) degrades to an
 * empty list, never takes a render/bake down with it, same posture as every
 * other `read*` function in this adapter.
 *
 * @param {string|null} [levelId] - MSA's own tracked current-floor Level id
 *   (see `scene-wall-clip.js`'s header for why this is the preferred,
 *   NOT-`canvas.level`, source). `null`/absent reads every wall regardless
 *   of level scoping (the "no floor context yet" case).
 * @returns {Array<{x1:number, y1:number, x2:number, y2:number, solid:boolean, blocksExterior:boolean, aperture:boolean}>}
 */
export function readSceneWallSegments(levelId = null) {
  try {
    const walls = canvas?.scene?.walls;
    if (!walls) return [];
    const out = [];
    for (const wall of walls) {
      const levels = wall?.levels;
      if (levels && typeof levels.has === 'function' && levels.size > 0 && levelId != null && !levels.has(levelId)) {
        continue;
      }
      const c = wall?.c;
      if (!Array.isArray(c) || c.length !== 4 || !c.every((v) => Number.isFinite(v))) continue;
      out.push({
        x1: c[0],
        y1: c[1],
        x2: c[2],
        y2: c[3],
        solid: deriveWallSolid({ move: wall.move, door: wall.door, ds: wall.ds, dir: wall.dir }),
        blocksExterior: deriveWallBlocksExterior({ move: wall.move }),
        // APERTURE (2026-08-03, docs/planning/Aperture-Gobo.md §2.1) — the
        // ONE extra derived fact `effects/lighting/aperture-gobo.js` needs off
        // a raw wall, added here rather than a second `canvas.scene.walls`
        // reader (`foundry/adapter-only` — this file is already the one place
        // that reads it).
        aperture: deriveWallAperture({ move: wall.move, light: wall.light }),
      });
    }
    return out;
  } catch (err) {
    return [];
  }
}

/**
 * WALL/DOOR STRUCTURAL-CHANGE WATCHER — closes Wind.md Tier 1's own recorded
 * follow-up: "NOT yet: createWall/updateWall/deleteWall auto-invalidation
 * (the manual 'Rebake' debug action stands in for now)." A door opening or
 * closing IS a WallDocument#update — Foundry's own `DoorControl#_onMouseDown`
 * (client/canvas/containers/elements/door-control.mjs, verified against
 * source) does exactly `this.wall.document.update({ds: ...})`, the same
 * document-update path any other wall edit takes. So subscribing to plain
 * Wall CRUD covers "a door opened" for free, with zero door-specific code —
 * exactly Wind.md §4's own claim ("doors are walls with a toggle... no
 * door-specific code in the sim").
 *
 * Lives here, not boot.js, for the same reason `canvas-lifecycle.js`'s
 * watchdog does (see that file's own header): a raw `Hooks.on(...)` call
 * outside `src/foundry/` is exactly what `foundry/adapter-only`'s ratchet
 * exists to catch (tools/verify-structure.mjs) — this file already owns
 * "read wall segments for the wind bake," so it is also the natural place to
 * announce "wall segments changed."
 *
 * `onChange` fires once per Foundry hook call — a bulk edit (scene import,
 * "align walls") fires one `createWall`/`updateWall`/`deleteWall` per
 * document touched, potentially several in the same synchronous tick (Wall
 * CRUD hooks fire from a plain `.map(fn => fn())` loop over the whole batch —
 * verified against `client/data/client-backend.mjs`, no `await` between
 * documents). COALESCING that burst into one rebake is the CALLER's job (it
 * knows what a rebake costs); this thin adapter just relays what Foundry
 * told it, unfiltered, same posture as every other `read*`/watch function in
 * this file.
 *
 * @param {(hook: 'createWall'|'updateWall'|'deleteWall') => void} onChange
 * @returns {{registered: boolean, reason: string|null}}
 */
export function watchSceneWallStructure(onChange) {
  if (typeof Hooks === 'undefined') {
    return { registered: false, reason: 'no Foundry Hooks global — not running inside Foundry' };
  }
  for (const hook of ['createWall', 'updateWall', 'deleteWall']) {
    Hooks.on(hook, () => onChange?.(hook));
  }
  return { registered: true, reason: null };
}

/**
 * DOOR-OPEN WATCHER — Wind.md Tier 2 §4's own trigger ("Foundry's door-open
 * hook fires → read the doorway's world centre and the wall segment's
 * normal"), which needs something `watchSceneWallStructure` above
 * deliberately does not give it: WHICH wall, and specifically the
 * closed→OPEN transition (not "changed", and not close→closed, or a
 * non-door wall edit — those are `watchSceneWallStructure`'s own job, the
 * slow structural rebake, not this one's fast transient impulse).
 *
 * `Hooks.on('updateWall', (doc, change, options, userId) => ...)` — the
 * hook's exact 4-arg shape verified against this project's own vendored
 * Foundry v14 source, not assumed: `client/data/client-backend.mjs`'s
 * `Hooks.callAll(\`update${type}\`, doc, change, options, userId)`, where
 * `change` is the DELTA (only the fields that actually changed) and `doc`
 * is the document AFTER the update was applied. `DoorControl#_onMouseDown`
 * (client/canvas/containers/elements/door-control.mjs, already cited by
 * `watchSceneWallStructure`'s own header) sends exactly `{ds: <new state>}`
 * — so `'ds' in change` is a real, narrow "the door state itself is what
 * changed on THIS update" test, not a guess.
 *
 * @param {(wallSegment: {x1:number,y1:number,x2:number,y2:number}) => void} onDoorOpen
 * @returns {{registered: boolean, reason: string|null}}
 */
export function watchDoorOpenings(onDoorOpen) {
  if (typeof Hooks === 'undefined') {
    return { registered: false, reason: 'no Foundry Hooks global — not running inside Foundry' };
  }
  Hooks.on('updateWall', (doc, change) => {
    if (!change || !('ds' in change)) return; // this update didn't touch the door state at all
    const doorVal = Number.isFinite(doc?.door) ? doc.door : WALL_DOOR_NONE;
    if (doorVal === WALL_DOOR_NONE) return; // not a door — 'ds' has no meaning on a plain wall
    if (change.ds !== WALL_DOOR_STATE_OPEN) return; // only the closed/locked -> OPEN transition gusts
    const c = doc?.c;
    if (!Array.isArray(c) || c.length !== 4 || !c.every((v) => Number.isFinite(v))) return;
    onDoorOpen?.({ x1: c[0], y1: c[1], x2: c[2], y2: c[3] });
  });
  return { registered: true, reason: null };
}
