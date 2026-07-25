/**
 * THE DOOR READER — reads `canvas.scene.walls` for the door-graphics effect
 * (`effects/door-graphics.js` declares it; `effects/door-graphics-render.js`
 * does the parity math; `vt/vt-pan-viewer.js` owns the GPU lifecycle). A door
 * is just a Wall with `door !== NONE` and an authored `animation.texture` — the
 * fancy animated leaf Foundry itself draws with `DoorMesh`
 * (client/canvas/containers/elements/door-mesh.mjs). A plain door with no
 * texture keeps Foundry's own PIXI control icon and is skipped here.
 *
 * WHY A SEPARATE READER FROM `scene-walls.js`: that file flattens every wall to
 * a wind-solidity SEGMENT (`{x1..y2, solid, blocksExterior}`) for the wind bake
 * — it deliberately throws away the door's texture, animation type, double flag
 * and open state, because the wind sim does not care (Wind.md §4: "doors are
 * walls with a toggle... no door-specific code in the sim"). The GRAPHIC needs
 * exactly those discarded fields, so it gets its own reader rather than bloating
 * the wind one with fields only one consumer wants.
 *
 * FIELD NAMES VERIFIED AGAINST SOURCE (not guessed) —
 * `common/documents/wall.mjs` + `common/constants.mjs` + `client/config.mjs`:
 *   c         : [x1,y1,x2,y2] — endpoints, canvas px.
 *   door      : WALL_DOOR_TYPES — NONE(0) / DOOR(1) / SECRET(2).
 *   ds        : WALL_DOOR_STATES — CLOSED(0) / OPEN(1) / LOCKED(2).
 *   levels    : a real `Set` of Level ids — EMPTY means "every Level" (the same
 *               per-floor scoping convention `scene-walls.js`/`scene-wall-clip.js`
 *               already established).
 *   animation : SchemaField { direction(∈{-1,1}, init 1), double(init false),
 *               duration(+int, init 750), flip(init false), strength([0,2], init
 *               1), type(init "swing"), texture(FilePath, nullable), flip }.
 *               (`common/documents/wall.mjs`.) `type` is validated against
 *               `CONFIG.Wall.animationTypes` (config.mjs:2509) exactly as
 *               `DoorMesh#configure` does — an unknown type falls back to
 *               "swing", never renders nothing.
 *   flags.core.textureGridSize : the door texture's native grid size; falls back
 *               to `CONFIG.Wall.textureGridSize` (config.mjs:2717 = 200), NOT the
 *               100 a legacy build assumed.
 *
 * Split pure-vs-live the SAME way `scene-lights.js`/`scene-walls.js` do:
 * `deriveDoorSnapshot` is the testable validation logic (returns `null` to SKIP
 * a wall that is not a renderable door — the same "return null to skip a
 * degenerate source" convention `deriveLightSnapshot` uses), and
 * `readSceneDoors`/`watchDoorGraphics` are the live, impure halves. Never
 * throws — a live Foundry API surprise degrades to an empty list, never takes a
 * render/read frame down with it.
 *
 * @module foundry/scene-doors
 */

// Verified against `common/constants.mjs` — kept as local numbers (not a live
// read of the global CONST) so `deriveDoorSnapshot` stays pure and Node-testable
// with no Foundry environment at all. Defaults match the SCHEMA's own defaults
// (`common/documents/wall.mjs`).
const WALL_DOOR_NONE = 0; // CONST.WALL_DOOR_TYPES.NONE — not a door at all
const WALL_DOOR_STATE_OPEN = 1; // CONST.WALL_DOOR_STATES.OPEN

/** BaseWall.animation schema defaults (`common/documents/wall.mjs:86-92`). */
const ANIM_DIRECTION_DEFAULT = 1;
const ANIM_DURATION_DEFAULT = 750;
const ANIM_STRENGTH_DEFAULT = 1;
const ANIM_STRENGTH_MIN = 0;
const ANIM_STRENGTH_MAX = 2;
const ANIM_TYPE_DEFAULT = 'swing';

/** `CONFIG.Wall.textureGridSize` (`client/config.mjs:2717`). */
const TEXTURE_GRID_SIZE_DEFAULT = 200;

/**
 * The door animation types Foundry ships (`CONFIG.Wall.animationTypes`,
 * config.mjs:2509) — the SAME set `effects/door-graphics-render.js` implements.
 * Duplicated here (not imported across the zone boundary) only as the VALIDATION
 * whitelist: an authored `type` outside this set falls back to the default,
 * exactly as `DoorMesh#configure` does. Kept in sync by
 * `door-graphics-render.js`'s own `DOOR_ANIMATION_TYPES` being the render-side
 * authority — a test pins the two to the same key set.
 */
const KNOWN_ANIMATION_TYPES = Object.freeze(['ascend', 'descend', 'slide', 'swing', 'swivel']);

/** @param {*} v @param {number} min @param {number} max @param {number} fallback @returns {number} */
function clampRange(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * Normalize an authored `animation.type` to one Foundry actually renders.
 * Mirrors `DoorMesh#configure`: `animation.type in CONFIG.Wall.animationTypes ?
 * animation.type : "swing"`. Case-insensitive + trimmed for author-typos'
 * sake, but the FALLBACK is the real parity behaviour (never render nothing for
 * a garbage type).
 *
 * @param {*} raw
 * @returns {string} one of {@link KNOWN_ANIMATION_TYPES}
 */
export function normalizeDoorAnimationType(raw) {
  if (typeof raw !== 'string') return ANIM_TYPE_DEFAULT;
  const s = raw.trim().toLowerCase();
  return KNOWN_ANIMATION_TYPES.includes(s) ? s : ANIM_TYPE_DEFAULT;
}

/**
 * Validate + normalize one raw wall read into the door-graphics snapshot the
 * runtime consumes, or `null` if this wall is not a renderable door (skip, not
 * draw — the same convention `deriveLightSnapshot` uses for a degenerate light).
 *
 * A wall is a renderable door iff it is a door at all (`door !== NONE`) AND has
 * an authored `animation.texture` (a plain door with no texture keeps Foundry's
 * PIXI control icon — MSA does not draw it). Everything else is normalized to
 * the schema defaults so a door that never touched a field reads exactly as a
 * freshly-created WallDocument would.
 *
 * @param {*} raw - `{wallId, c, door, ds, animation, textureGridSize}` plucked
 *   off a live WallDocument (or a plain Node-test fixture of the same shape).
 * @returns {{wallId: string, x1: number, y1: number, x2: number, y2: number,
 *   doorType: number, ds: number, open: boolean, textureGridSize: number,
 *   animation: {type: string, texture: string, double: boolean,
 *   direction: number, duration: number, flip: boolean, strength: number}}|null}
 */
export function deriveDoorSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const doorType = Number.isFinite(raw.door) ? raw.door : WALL_DOOR_NONE;
  if (doorType === WALL_DOOR_NONE) return null; // not a door — nothing to draw
  const anim = raw.animation;
  const texture = typeof anim?.texture === 'string' && anim.texture.length > 0 ? anim.texture : null;
  if (!texture) return null; // a plain (untextured) door keeps Foundry's control icon
  const c = raw.c;
  if (!Array.isArray(c) || c.length !== 4 || !c.every((v) => Number.isFinite(v))) return null;
  const wallId = raw.wallId === undefined || raw.wallId === null ? '' : String(raw.wallId);
  if (!wallId) return null; // no stable key to track this door's meshes by
  const ds = Number.isFinite(raw.ds) ? raw.ds : 0; // CLOSED
  // `direction` is a strict {-1,1} choice field — anything else reads as the
  // schema default rather than being silently clamped to ±1 arbitrarily.
  const direction = anim?.direction === -1 || anim?.direction === 1 ? anim.direction : ANIM_DIRECTION_DEFAULT;
  return {
    wallId,
    x1: c[0],
    y1: c[1],
    x2: c[2],
    y2: c[3],
    doorType,
    ds,
    open: ds === WALL_DOOR_STATE_OPEN,
    // flags.core.textureGridSize, falling back to CONFIG.Wall.textureGridSize
    // (200) — the door texture's own native grid size, controlling its vertical
    // scale (`door-graphics-render.js`: scaleY = gridSize / textureGridSize).
    textureGridSize:
      Number.isFinite(raw.textureGridSize) && raw.textureGridSize > 0 ? raw.textureGridSize : TEXTURE_GRID_SIZE_DEFAULT,
    animation: {
      type: normalizeDoorAnimationType(anim?.type),
      texture,
      double: !!anim?.double,
      direction,
      // +int schema, init 750 — the animation's own duration (ms). Foundry's
      // DoorMesh.animate uses THIS (the authored/default duration), not the
      // per-type config duration, so parity means reading it straight.
      duration: Number.isFinite(anim?.duration) && anim.duration > 0 ? anim.duration : ANIM_DURATION_DEFAULT,
      flip: !!anim?.flip,
      strength: clampRange(anim?.strength, ANIM_STRENGTH_MIN, ANIM_STRENGTH_MAX, ANIM_STRENGTH_DEFAULT),
    },
  };
}

/**
 * Live read of every renderable door on the active scene, scoped to `levelId`
 * the SAME way `scene-walls.js#readSceneWallSegments` scopes its segments (an
 * empty `wall.levels` set means "every Level"). Never throws — a Foundry API
 * surprise degrades to an empty list, same posture as every other `read*` here.
 *
 * @param {string|null} [levelId] - MSA's own tracked current-floor Level id.
 *   `null`/absent (or the single-floor `'legacy'` sentinel the caller maps to
 *   null) reads every door regardless of level scoping.
 * @returns {{doors: Array<NonNullable<ReturnType<typeof deriveDoorSnapshot>>>,
 *   source: 'scene'|'default', reason: string|null}}
 */
export function readSceneDoors(levelId = null) {
  try {
    const walls = typeof canvas !== 'undefined' ? (canvas?.scene?.walls ?? null) : null;
    if (!walls) {
      return {
        doors: [],
        source: 'default',
        reason: 'no active scene (canvas.scene.walls is absent) — reading as zero doors, not guessed',
      };
    }
    const doors = [];
    for (const wall of walls) {
      const levels = wall?.levels;
      if (levels && typeof levels.has === 'function' && levels.size > 0 && levelId != null && !levels.has(levelId)) {
        continue; // scoped to other floors only
      }
      const snap = deriveDoorSnapshot({
        wallId: wall?.id,
        c: wall?.c,
        door: wall?.door,
        ds: wall?.ds,
        animation: wall?.animation,
        textureGridSize: wall?.flags?.core?.textureGridSize,
      });
      if (snap) doors.push(snap);
    }
    return { doors, source: 'scene', reason: null };
  } catch (err) {
    return {
      doors: [],
      source: 'default',
      reason: `reading canvas.scene.walls threw: ${err?.message ?? err}`,
    };
  }
}

/**
 * DOOR-GRAPHICS CHANGE WATCHER — a door graphic must react to three things a
 * plain redraw does not distinguish, so it relays the Foundry hook verbatim and
 * lets the runtime decide (mirrors `scene-walls.js#watchSceneWallStructure`'s
 * "relay unfiltered, coalescing is the caller's job" posture):
 *   - `createWall`/`deleteWall` — a door appeared/vanished → build/destroy meshes.
 *   - `updateWall` — the caller inspects `change` to tell a STATE toggle
 *     (`'ds' in change` → animate open/close), a MOVE (`'c' in change` →
 *     reposition), or a CONFIG edit (`'animation' in change` → rebuild) apart.
 *
 * Lives here, not boot.js, for the same reason `scene-walls.js`'s watchers do:
 * a raw `Hooks.on(...)` outside `src/foundry/` is exactly what `foundry/
 * adapter-only` exists to catch. Never throws; returns a report rather than
 * assuming a Foundry environment (Node has no `Hooks` global — the guard clause
 * is genuinely exercised in tests).
 *
 * @param {(evt: {hook: 'createWall'|'updateWall'|'deleteWall', wallId: string,
 *   change: object|null}) => void} onChange
 * @returns {{registered: boolean, reason: string|null}}
 */
export function watchDoorGraphics(onChange) {
  if (typeof Hooks === 'undefined') {
    return { registered: false, reason: 'no Foundry Hooks global — not running inside Foundry' };
  }
  Hooks.on('createWall', (doc) => onChange?.({ hook: 'createWall', wallId: String(doc?.id ?? ''), change: null }));
  Hooks.on('updateWall', (doc, change) =>
    onChange?.({ hook: 'updateWall', wallId: String(doc?.id ?? ''), change: change ?? null })
  );
  Hooks.on('deleteWall', (doc) => onChange?.({ hook: 'deleteWall', wallId: String(doc?.id ?? ''), change: null }));
  return { registered: true, reason: null };
}
