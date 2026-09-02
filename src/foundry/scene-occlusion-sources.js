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
 * `Token#getLightRadius(units) + externalRadius`, replicated from real
 * DOCUMENT data — no PIXI Token object needed. Foundry's real `externalRadius`
 * is a PIXI Token instance property (roughly the token's own visual half-size);
 * this uses the ALREADY-CARRIED `footprint` as a documented stand-in
 * (`max(width, height) / 2`), since this project draws from documents, not
 * placeable objects (Keyhole.md §4.3).
 *
 * @param {object} args
 * @param {{width:number, height:number}} args.footprint - tokenFootprint()'s return.
 * @param {number} args.occludableRadius - token.occludable.radius, grid distance units. 0 = no disc.
 * @param {number} args.distancePixels
 * @returns {number} radius in world/canvas pixels. Exactly 0 iff occludableRadius is 0.
 */
export function computeTokenOcclusionRadiusPx({ footprint, occludableRadius, distancePixels }) {
  if (!occludableRadius) return 0;
  const externalRadius = Math.max(footprint?.width ?? 0, footprint?.height ?? 0) / 2;
  return Math.abs(occludableRadius) * distancePixels + externalRadius;
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
