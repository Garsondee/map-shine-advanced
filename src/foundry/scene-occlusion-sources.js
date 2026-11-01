/**
 * GRID-GEOMETRY + POINTER READERS — narrow readers of Foundry's live
 * occlusion-relevant globals (scope broadened 2026-07-19 for the grid pair;
 * broadened again for `readMouseHoverPoint` fixing mythica-machina-press#470,
 * the tile hover-fade that never fired because nothing in this codebase read
 * Foundry's own live pointer state at all).
 *
 * `readGridDistancePixels` feeds the RADIAL occlusion disc radius formula,
 * replicated from `Token#getLightRadius` (`client/canvas/placeables/token.mjs:3818-3821`):
 *
 *   radiusPx = |occludable.radius| * distancePixels + externalRadius
 *
 * `canvas.dimensions.distancePixels` is Foundry's OWN pixels-per-grid-distance-
 * unit constant (already folding in grid size, grid distance and grid type) —
 * read verbatim rather than re-derived from `scene.grid.size`/`scene.grid.distance`,
 * so this can never quietly disagree with the value Foundry itself uses for the
 * identical formula.
 *
 * `readGridSizePixels` feeds the point-light soft-edge margin (docs/reference/
 * foundry-v14-lighting-audit.md §9): Foundry's own soft-edge inflate is
 * `EDGE_OFFSET * (canvas.grid.size / 100)` (`rendered-effect-source.mjs`) — a
 * FIXED px margin (8) scaled by the grid's own size relative to a 100px
 * reference square, so the antialiasing margin stays proportionally
 * consistent across differently-scaled maps. `canvas.grid.size` — "the size
 * of a grid space in pixels" (`common/grid/base.mjs`) — is a DIFFERENT number
 * from `distancePixels` (pixels PER GRID SQUARE, not pixels per distance
 * UNIT), read separately rather than derived from it.
 *
 * `readMouseHoverPoint` feeds the hover-fade hit test (`vt-pan-viewer.js`'s
 * per-frame occlusion-weight recompute): Foundry's own `canvas.mousePosition`
 * (`client/canvas/board.mjs:322`) is a plain, continuously-updated
 * `PIXI.Point` in world/stage coordinates, maintained by Foundry's own
 * interaction manager regardless of anything this project does — "Foundry
 * owns all input" is a locked decision here (`foundry/canvas-compositing.js`'s
 * header; `keyhole-input-model-decision`), so this READS Foundry's live value
 * rather than re-deriving pointer tracking from raw DOM events.
 * `canvas.mousePositionVisible`/`.mousePositionExplored` are Foundry's own
 * fog-of-war gates on whether hover should register AT ALL — replicated from
 * `PrimaryCanvasGroup#updateHoveredObjects` (`client/canvas/groups/
 * primary.mjs:544`): `if (!(canvas.mousePositionVisible ||
 * canvas.mousePositionExplored)) return;` — a player must be able to see or
 * have explored a tile's location before hovering it can reveal anything
 * underneath, or hover-fade would leak fog-of-war information for free.
 *
 * Split pure-vs-live the same way `canvas-compositing.js` and
 * `scene-environment.js` already do: `deriveDistancePixels`/`deriveGridSizePixels`/
 * `computeTokenOcclusionRadiusPx`/`deriveMouseHoverPoint` are Node-tested; the
 * `readGrid*`/`readMouseHoverPoint` functions touch the live `canvas` global
 * and are browser-only (verified via a debug report, not here).
 *
 * @module foundry/scene-occlusion-sources
 */

/** Foundry's default `grid.size` (px/square) — a neutral, documented fallback
 * for when `canvas.dimensions`/`canvas.grid` cannot be read, never a silent guess. */
const DEFAULT_DISTANCE_PIXELS = 100;

/**
 * @param {*} raw - whatever `canvas.dimensions.distancePixels` was.
 * @returns {{distancePixels: number, source: 'scene'|'default', reason: string|null}}
 */
export function deriveDistancePixels(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return { distancePixels: raw, source: 'scene', reason: null };
  }
  return {
    distancePixels: DEFAULT_DISTANCE_PIXELS,
    source: 'default',
    reason: `canvas.dimensions.distancePixels was ${JSON.stringify(raw)}, not a positive finite number — reading as ${DEFAULT_DISTANCE_PIXELS}, not guessed`,
  };
}

/** Live read. Never throws — see `deriveDarkness`'s sibling doc in scene-environment.js. */
export function readGridDistancePixels() {
  try {
    const dims = typeof canvas !== 'undefined' ? (canvas?.dimensions ?? null) : null;
    return deriveDistancePixels(dims?.distancePixels);
  } catch (err) {
    return {
      distancePixels: DEFAULT_DISTANCE_PIXELS,
      source: 'default',
      reason: `reading canvas.dimensions.distancePixels threw: ${err?.message ?? err}`,
    };
  }
}

/**
 * @param {*} raw - whatever `canvas.grid.size` was.
 * @returns {{gridSizePixels: number, source: 'scene'|'default', reason: string|null}}
 */
export function deriveGridSizePixels(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return { gridSizePixels: raw, source: 'scene', reason: null };
  }
  return {
    gridSizePixels: DEFAULT_DISTANCE_PIXELS,
    source: 'default',
    reason: `canvas.grid.size was ${JSON.stringify(raw)}, not a positive finite number — reading as ${DEFAULT_DISTANCE_PIXELS}, not guessed`,
  };
}

/** Live read. Never throws — see `deriveDarkness`'s sibling doc in scene-environment.js. */
export function readGridSizePixels() {
  try {
    const grid = typeof canvas !== 'undefined' ? (canvas?.grid ?? null) : null;
    return deriveGridSizePixels(grid?.size);
  } catch (err) {
    return {
      gridSizePixels: DEFAULT_DISTANCE_PIXELS,
      source: 'default',
      reason: `reading canvas.grid.size threw: ${err?.message ?? err}`,
    };
  }
}

/**
 * A token's RADIAL occlusion disc radius, replicated from Foundry's own
 * `CanvasOcclusionMask#_updateOcclusionMask` (layers/masks/occlusion.mjs:209):
 *
 *     Math.max(token.externalRadius, token.getLightRadius(occludable.radius))
 *
 * with `externalRadius = min(width, height) / 2` (`Token#externalRadius`) and
 * `getLightRadius(u) = u === 0 ? 0 : (|u| * distancePixels + externalRadius) * sign(u)`.
 *
 * ⚠️ The `max` is the point: a token whose occlusion radius is the schema
 * default 0 still reveals a disc the size of the token itself. This used to
 * return 0 for that case, so no default token ever cut a RADIAL hole in any
 * roof (live bug 2026-11-01, "tile occlusion is completely broken").
 * @param {object} args
 * @param {{width:number, height:number}} args.footprint - the token's size in px.
 * @param {number} args.occludableRadius - token.occludable.radius, grid distance units.
 * @param {number} args.distancePixels
 * @returns {number} radius in world/canvas pixels, never below the token's own half-size.
 */
export function computeTokenOcclusionRadiusPx({ footprint, occludableRadius, distancePixels }) {
  const externalRadius = Math.min(footprint?.width ?? 0, footprint?.height ?? 0) / 2;
  const units = Number.isFinite(occludableRadius) ? occludableRadius : 0;
  const lightRadius = units === 0 ? 0 : (Math.abs(units) * distancePixels + externalRadius) * Math.sign(units);
  return Math.max(externalRadius, lightRadius);
}

/**
 * One occluding token, as the occlusion pass draws and tests it. Pure — the
 * live reader below plucks the raw values off Foundry's Token placeable.
 *
 * @param {object} raw
 * @param {string} raw.id
 * @param {number} raw.elevation
 * @param {{x:number,y:number}} raw.center
 * @param {{width:number,height:number}} raw.size
 * @param {number} raw.occludableRadius
 * @param {boolean} raw.visionActive
 * @param {{points?: number[], origin?: {x:number,y:number}}|null} raw.los - the token's vision polygon.
 * @param {Array<{x:number,y:number}>|null} raw.testPoints - `TokenDocument#getOcclusionTestPoints()`.
 * @param {number} distancePixels
 * @returns {{id:string, elevation:number, centerX:number, centerY:number, radiusPx:number,
 *   visionActive:boolean, los:{points:number[], originX:number, originY:number}|null,
 *   testPoints:Array<{x:number,y:number}>, minX:number, minY:number, maxX:number, maxY:number}|null}
 */
export function deriveOccludableToken(raw, distancePixels) {
  const cx = raw?.center?.x;
  const cy = raw?.center?.y;
  if (!raw?.id || !Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  const elevation = Number.isFinite(raw.elevation) ? raw.elevation : 0;
  const radiusPx = computeTokenOcclusionRadiusPx({
    footprint: raw.size,
    occludableRadius: raw.occludableRadius,
    distancePixels,
  });
  // Foundry tests several dense, wall-constrained points per token; fall back
  // to the centre only when they could not be read.
  const testPoints = (Array.isArray(raw.testPoints) ? raw.testPoints : []).filter(
    (p) => Number.isFinite(p?.x) && Number.isFinite(p?.y)
  );
  if (testPoints.length === 0) testPoints.push({ x: cx, y: cy });
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of testPoints) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const points = raw.visionActive ? raw.los?.points : null;
  const los =
    points && points.length >= 6
      ? {
          points,
          originX: Number.isFinite(raw.los.origin?.x) ? raw.los.origin.x : cx,
          originY: Number.isFinite(raw.los.origin?.y) ? raw.los.origin.y : cy,
        }
      : null;
  return {
    id: `token:${raw.id}`,
    elevation,
    centerX: cx,
    centerY: cy,
    radiusPx,
    // A token whose vision is on but has no usable polygon yet reveals by its
    // radial disc, exactly as Foundry treats a token with no vision.
    visionActive: !!los,
    los,
    testPoints,
    minX,
    minY,
    maxX,
    maxY,
  };
}

/**
 * Live read of the tokens that occlude roofs RIGHT NOW: Foundry's own
 * `TokenLayer#_getOccludableTokens()` (layers/tokens.mjs:555) — controlled,
 * owned, hovered or highlighted per the world's token occlusion setting — never
 * simply "every token on the map". The old every-token rule faded a roof for a
 * GM with nothing selected, which Foundry never does.
 *
 * Reads the Token PLACEABLES on purpose, not just documents: which tokens
 * occlude, where each one is mid-animation, and its vision polygon are all
 * Foundry-owned runtime state (Foundry stays authoritative for vision,
 * Keyhole.md §4.3). Never throws; an unreadable canvas reads as no occluders.
 *
 * @returns {{tokens: Array<NonNullable<ReturnType<typeof deriveOccludableToken>>>, reason: string|null}}
 */
export function readOccludableTokens() {
  try {
    const layer = typeof canvas !== 'undefined' ? (canvas?.tokens ?? null) : null;
    if (!layer) return { tokens: [], reason: 'no token layer' };
    const list =
      typeof layer._getOccludableTokens === 'function' ? layer._getOccludableTokens() : (layer.controlled ?? []);
    const distancePixels = readGridDistancePixels().distancePixels;
    const tokens = [];
    for (const token of list ?? []) {
      const doc = token?.document;
      let testPoints = null;
      try {
        testPoints = doc?.getOcclusionTestPoints?.() ?? null;
      } catch (_) {
        testPoints = null;
      }
      const size = doc?.getSize?.() ?? { width: token?.w ?? 0, height: token?.h ?? 0 };
      const derived = deriveOccludableToken(
        {
          id: doc?.id ?? token?.id,
          elevation: doc?.elevation,
          center: token?.center,
          size,
          occludableRadius: doc?.occludable?.radius ?? 0,
          visionActive: !!token?.vision?.active,
          los: token?.vision?.los ?? null,
          testPoints,
        },
        distancePixels
      );
      if (derived) tokens.push(derived);
    }
    return { tokens, reason: null };
  } catch (err) {
    return { tokens: [], reason: `reading occludable tokens threw: ${err?.message ?? err}` };
  }
}

/**
 * @param {*} rawPoint - whatever `canvas.mousePosition` was (ideally `{x,y}`,
 *   a real PIXI.Point in practice).
 * @param {*} rawVisible - whatever `canvas.mousePositionVisible` was.
 * @param {*} rawExplored - whatever `canvas.mousePositionExplored` was.
 * @returns {{x:number, y:number, eligible:boolean}|null} `null` when there is
 *   no trustworthy point to act on — see {@link readMouseHoverPoint}'s doc for
 *   why that is the safe default here, unlike the grid readers above.
 */
export function deriveMouseHoverPoint(rawPoint, rawVisible, rawExplored) {
  const x = rawPoint?.x;
  const y = rawPoint?.y;
  if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) return null;
  return { x, y, eligible: !!(rawVisible || rawExplored) };
}

/**
 * Live read of Foundry's own continuously-updated pointer position, plus the
 * fog-of-war gate on whether it may register a hover at all. Never throws —
 * see `deriveDarkness`'s sibling doc in scene-environment.js.
 *
 * Returns `null` on any failure (no `canvas` yet, mid-teardown, a malformed
 * point) rather than a synthetic `{x:0, y:0}` the way the grid readers above
 * fall back to a documented default: unlike a pixels-per-unit constant, world
 * position (0,0) is REAL geometry — faking it risks a false hover hit exactly
 * at the scene's own origin. Every caller must treat `null` as "no hover this
 * frame", never as a point.
 *
 * @returns {{x:number, y:number, eligible:boolean}|null}
 */
export function readMouseHoverPoint() {
  try {
    const c = typeof canvas !== 'undefined' ? canvas : null;
    if (!c) return null;
    return deriveMouseHoverPoint(c.mousePosition, c.mousePositionVisible, c.mousePositionExplored);
  } catch (_) {
    return null;
  }
}
