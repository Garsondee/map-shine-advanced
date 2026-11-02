/**
 * FOUNDRY'S GRID AND SCENE OUTLINE, DRAWN BY MSA — a line-for-line TSL port of v14's `GridShader`
 * (`client/canvas/rendering/shaders/grid/grid.mjs`) and of `InterfaceCanvasGroup#drawOutline`
 * (`client/canvas/groups/interface.mjs`), folded into the present draw.
 *
 * WHY MSA DRAWS THEM AT ALL (the author, 2026-11-02: *"the grid lines and edges of the map are also not
 * getting effected correctly, because it's still the PIXI stuff … bring the grid rendering into threejs
 * and just make sure that it's a perfect copy of what Foundry would want"*): Foundry draws both on its
 * PIXI canvas, stacked over MSA's. That canvas never sees MSA's lens warp or Parallax's floor scale, so
 * the grid stayed straight while the map under it bowed and the squares drifted off the art's squares
 * toward the frame's corners.
 *
 * WHERE IN THE FRAME, AND WHY THERE: Foundry puts both in its `interface` group, which renders AFTER
 * `primary` (the map), `effects` (lighting) and `visibility` (the fog). So a grid line is never lit,
 * never darkened, never graded and never fogged: a never-explored square still shows its lines. The
 * present is the one draw that comes after all of MSA's equivalents, so the overlay is composited last,
 * over the finished picture, at the same lens-warped position the picture's own pixels came from.
 * PIXI blends in display (sRGB) space; this does too — linear in, sRGB blend, linear out — so a line's
 * anti-aliased edge and its alpha land on exactly the bytes Foundry's canvas would have produced.
 *
 * WHAT IS PORTED: every built-in style (`CONFIG.Canvas.gridStyles`: solid/dashed/dotted lines,
 * square/diamond/round points) on every grid type (square, the four hexagonal layouts). The type and
 * style are JS-time branches — a different grid is a different graph, rebuilt on change, the same
 * shape the present's tone map already uses. A style a module registers with its OWN shader class is
 * never guessed at: `foundry/scene-grid.js` leaves that grid to Foundry.
 *
 * @module effects/grid/foundry-grid-render
 */

/** `CONST.GRID_TYPES` (v14 `common/constants.mjs`). */
export const FOUNDRY_GRID_TYPES = Object.freeze({
  GRIDLESS: 0,
  SQUARE: 1,
  HEXODDR: 2,
  HEXEVENR: 3,
  HEXODDQ: 4,
  HEXEVENQ: 5,
});

/** `GridShader.DRAW_GRID_FUNCTION`'s style constants (the `style` uniform). */
export const FOUNDRY_GRID_STYLES = Object.freeze({
  LINE_SOLID: 0,
  LINE_DASHED: 1,
  LINE_DOTTED: 2,
  POINT_SQUARE: 3,
  POINT_DIAMOND: 4,
  POINT_ROUND: 5,
});

const SQRT3 = Math.sqrt(3);
const SQRT1_3 = 1 / Math.sqrt(3);
const SQRT1_2 = Math.SQRT1_2;

/**
 * The compile-time shape of a grid, or null when there is nothing this port can draw (gridless, or a
 * type/style it does not know). Two grids with the same key share one compiled graph.
 * @param {number} type @param {number} style
 * @returns {string|null}
 */
export function foundryGridShapeKey(type, style) {
  const t = Number(type);
  const s = Number(style);
  if (!Number.isInteger(t) || t < FOUNDRY_GRID_TYPES.SQUARE || t > FOUNDRY_GRID_TYPES.HEXEVENQ) return null;
  if (!Number.isInteger(s) || s < FOUNDRY_GRID_STYLES.LINE_SOLID || s > FOUNDRY_GRID_STYLES.POINT_ROUND) return null;
  return `${t}:${s}`;
}

/**
 * The overlay's uniforms. Only `.value`s change per frame; the graph is built once per grid shape.
 * @param {*} TSL
 */
export function createFoundryGridUniforms(TSL) {
  const { uniform, float, vec2, vec3, vec4 } = TSL;
  return {
    /** Grid size, canvas px per grid space (`canvas.dimensions.size`). */
    size: uniform(float(100)),
    /** Line thickness in GRID units (`data.thickness / size`, as Foundry's `_preRender` passes it). */
    thickness: uniform(float(0.01)),
    /** Output px per grid unit — Foundry's `resolution` uniform (drawing-buffer px, not CSS px). */
    resolution: uniform(float(100)),
    /** The line colour, display (sRGB) 0..1, and the mesh's effective alpha. */
    color: uniform(vec3(0, 0, 0)),
    alpha: uniform(float(0)),
    /** The grid mesh's origin in canvas px (`meshDimensions.xy`; Foundry leaves it at 0,0). */
    origin: uniform(vec2(0, 0)),
    /** Where lines may draw, canvas px (minX, minY, maxX, maxY): Foundry's `masks.canvas` rect. */
    clip: uniform(vec4(0, 0, 0, 0)),
    /** The outline's two rects (canvas px, minX..maxY), its stroke width and its two alphas. */
    outlineCanvas: uniform(vec4(0, 0, 0, 0)),
    outlineScene: uniform(vec4(0, 0, 0, 0)),
    outlineWidth: uniform(float(4)),
    outlineAlpha: uniform(vec2(0, 0)),
    /** Output px per canvas px, for the outline's edge. */
    pxPerCanvas: uniform(float(1)),
    /** The plane the grid lies on: (eyeX, eyeY, scale) — Parallax draws a floor scaled by `scale`
     * about the eye, so canvas px = eye + (world − eye) / scale. (0, 0, 1) = unmoved. */
    plane: uniform(vec3(0, 0, 1)),
    /** MSA's look (`effects/grid/grid.js`): (width output px, fade-below px), (day, night) opacity, the
     * two inks (display space) and the switch-over luminance. Unused by Foundry's own styles. */
    look: uniform(vec2(1, 28)),
    lookOpacity: uniform(vec2(0.34, 0.16)),
    lookDarkInk: uniform(vec3(0.11, 0.09, 0.07)),
    lookLightInk: uniform(vec3(0.94, 0.9, 0.82)),
    lookPivot: uniform(float(0.32)),
  };
}

/**
 * Push one frame's grid and outline into the uniforms. No allocation.
 * @param {ReturnType<typeof createFoundryGridUniforms>} u
 * @param {object} a
 * @param {object|null} a.grid - `foundry/scene-grid.js#readFoundryGrid`'s `grid` (null = no grid lines).
 * @param {object|null} a.outline - its `outline` (null = no outline).
 * @param {number} a.pxPerCanvas - output (drawing-buffer) px per canvas px at the grid's plane.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} [a.clip] - overrides the grid's own
 *   clip rect (the Table keeps lines on the board).
 * @param {{x:number,y:number,scale:number}|null} [a.plane] - Parallax's eye and the grid floor's scale.
 * @param {ReturnType<typeof import('./grid.js').resolveGridLook>|null} [a.look] - MSA's look (null =
 *   Foundry's own style).
 */
export function writeFoundryGridUniforms(u, { grid, outline, pxPerCanvas, clip = null, plane = null, look = null }) {
  if (look) {
    u.look.value.set(look.widthPx, look.fadeBelowPx);
    u.lookOpacity.value.set(look.dayOpacity, look.nightOpacity);
    u.lookDarkInk.value.set(look.darkInk[0], look.darkInk[1], look.darkInk[2]);
    u.lookLightInk.value.set(look.lightInk[0], look.lightInk[1], look.lightInk[2]);
    u.lookPivot.value = look.pivot;
  }
  const px = Number.isFinite(pxPerCanvas) && pxPerCanvas > 0 ? pxPerCanvas : 1;
  u.pxPerCanvas.value = px;
  const s = plane && Number.isFinite(plane.scale) && plane.scale > 1e-4 ? plane.scale : 1;
  u.plane.value.set(s === 1 ? 0 : plane.x, s === 1 ? 0 : plane.y, s);
  if (grid) {
    const size = grid.sizePx > 0 ? grid.sizePx : 100;
    u.size.value = size;
    u.thickness.value = (grid.thicknessPx > 0 ? grid.thicknessPx : 0) / size;
    u.resolution.value = px * size;
    u.color.value.set(grid.color[0], grid.color[1], grid.color[2]);
    u.alpha.value = grid.alpha;
    u.origin.value.set(grid.mesh.x, grid.mesh.y);
    const c = clip ?? {
      minX: grid.mesh.x,
      minY: grid.mesh.y,
      maxX: grid.mesh.x + grid.mesh.width,
      maxY: grid.mesh.y + grid.mesh.height,
    };
    u.clip.value.set(c.minX, c.minY, c.maxX, c.maxY);
  } else {
    u.alpha.value = 0;
  }
  if (outline) {
    const r = outline.canvasRect;
    const s = outline.sceneRect;
    u.outlineCanvas.value.set(r.x, r.y, r.x + r.width, r.y + r.height);
    u.outlineScene.value.set(s.x, s.y, s.x + s.width, s.y + s.height);
    u.outlineWidth.value = outline.widthPx;
    u.outlineAlpha.value.set(outline.canvasAlpha, outline.sceneAlpha);
  } else {
    u.outlineAlpha.value.set(0, 0);
  }
}

/**
 * The grid's coverage × alpha at a canvas-px position — `GridShader`'s `drawGrid(vGridCoord, style,
 * thickness, color).a * alpha`, with `type` and `style` fixed at build time.
 * @param {*} TSL
 * @param {object} a
 * @param {*} a.canvasXY - vec2 node, canvas px.
 * @param {ReturnType<typeof createFoundryGridUniforms>} a.u
 * @param {number} a.type - `FOUNDRY_GRID_TYPES`.
 * @param {number} a.style - `FOUNDRY_GRID_STYLES`.
 * @returns {*} float node, 0..1.
 */
export function buildFoundryGridAlpha(TSL, { canvasXY, u, type, style }) {
  const { float, vec2, floor, abs, min, max, select, length } = TSL;
  const thickness = u.thickness;
  const { isSquare, lineCoverage, nearestVertex, edgeDistance, edgeOffset } = gridGeometry(TSL, type, u.resolution);

  // DRAW_GRID_FUNCTION
  const S = FOUNDRY_GRID_STYLES;
  const point = canvasXY.sub(u.origin).div(u.size); // vGridCoord
  let coverage;
  if (style === S.POINT_SQUARE) {
    const o = abs(nearestVertex(point).sub(point));
    coverage = lineCoverage(max(o.x, o.y), thickness);
  } else if (style === S.POINT_DIAMOND) {
    const o = abs(nearestVertex(point).sub(point));
    coverage = lineCoverage(o.x.add(o.y).mul(SQRT1_2), thickness);
  } else if (style === S.POINT_ROUND) {
    coverage = lineCoverage(length(point.sub(nearestVertex(point))), thickness);
  } else if (style === S.LINE_SOLID) {
    coverage = lineCoverage(edgeDistance(point), thickness);
  } else {
    const off = edgeOffset(point);
    let ox = off.x;
    let oz = off.z;
    if (style === S.LINE_DASHED && !isSquare) {
      const padding = thickness.mul((1 - SQRT1_3) * 0.5);
      ox = ox.add(padding);
      oz = oz.add(padding.mul(2));
    }
    const dy = off.y;
    const intervals = oz.mul(0.5).div(thickness);
    // `intervals < 0.5` is a runtime choice in Foundry's shader too (it rides the thickness uniform);
    // both sides are evaluated here, so the unused one is kept finite.
    const interval = thickness.mul(intervals.div(max(floor(intervals.add(0.5)), 1)).mul(2));
    const dx = ox.sub(floor(ox.div(interval).add(0.5)).mul(interval));
    const patterned =
      style === S.LINE_DOTTED
        ? lineCoverage(length(vec2(dx, dy)), thickness)
        : min(lineCoverage(dx, thickness), lineCoverage(dy, thickness));
    coverage = select(intervals.lessThan(0.5), lineCoverage(dy, thickness), patterned);
  }
  return select(insideClip(canvasXY, u), coverage.mul(u.alpha), float(0));
}

/** `masks.canvas`: is a canvas-px position inside the clip rect? */
function insideClip(canvasXY, u) {
  return canvasXY.x
    .greaterThanEqual(u.clip.x)
    .and(canvasXY.x.lessThan(u.clip.z))
    .and(canvasXY.y.greaterThanEqual(u.clip.y))
    .and(canvasXY.y.lessThan(u.clip.w));
}

/**
 * MSA's own grid look (`effects/grid/grid.js`): its coverage at a canvas-px position, on Foundry's grid
 * geometry. Lines are `look.x` OUTPUT px wide whatever the zoom; dashes and dots are sized to the
 * square (6 dashes, 10 dots an edge, centred on the corners so a crossing reads as a mark); the whole
 * grid fades out once a square is smaller than `look.y` px. Colour is the composite's job (ink chosen
 * from the picture under the line).
 * @param {*} TSL
 * @param {{canvasXY:*, u:ReturnType<typeof createFoundryGridUniforms>, type:number, lineStyle:string}} a
 * @returns {*} float node, 0..1.
 */
export function buildGridLookAlpha(TSL, { canvasXY, u, type, lineStyle }) {
  const { float, vec2, floor, abs, max, clamp, select, length, smoothstep } = TSL;
  const res = u.resolution; // output px per grid unit = one square's size on screen
  const { lineCoverage, edgeDistance, edgeOffset } = gridGeometry(TSL, type, res);
  const point = canvasXY.sub(u.origin).div(u.size);
  const width = u.look.x.div(res); // grid units
  let coverage;
  if (lineStyle === 'dashed' || lineStyle === 'dotted') {
    const off = edgeOffset(point);
    const period = off.z.div(lineStyle === 'dashed' ? 6 : 10);
    const dx = off.x.sub(floor(off.x.div(period).add(0.5)).mul(period));
    if (lineStyle === 'dashed') {
      const along = clamp(period.mul(0.25).sub(abs(dx)).mul(res).add(0.5), 0, 1); // dash = half a period
      coverage = lineCoverage(off.y, width).mul(along);
    } else {
      const radius = max(width.mul(0.9), float(0.75).div(res)); // never under a 1.5 px dot
      coverage = clamp(
        radius
          .sub(length(vec2(dx, off.y)))
          .mul(res)
          .add(0.5),
        0,
        1
      );
    }
  } else {
    coverage = lineCoverage(edgeDistance(point), width);
  }
  const fadeAt = max(u.look.y, float(1e-3));
  const fade = select(u.look.y.lessThanEqual(0), float(1), smoothstep(fadeAt.mul(0.55), fadeAt, res));
  return select(insideClip(canvasXY, u), coverage.mul(fade), float(0));
}

/**
 * Foundry's grid GEOMETRY (`GridShader`'s anti-aliased line coverage and its square/hex distance
 * functions), with the grid type fixed at build time. Shared by Foundry's own styles and MSA's look.
 * @param {*} TSL @param {number} type - `FOUNDRY_GRID_TYPES`. @param {*} resolution - output px per grid unit.
 */
function gridGeometry(TSL, type, resolution) {
  const { float, vec2, vec3, floor, abs, min, max, clamp, select, atan, cos, sin, dot } = TSL;
  const PI = Math.PI;
  const T = FOUNDRY_GRID_TYPES;
  const isSquare = type === T.SQUARE;
  const isColumns = type === T.HEXODDQ || type === T.HEXEVENQ;
  const isEven = type === T.HEXEVENR || type === T.HEXEVENQ;

  // ANTIALIASED_STEP_FUNCTION / LINE_COVERAGE_FUNCTION (alignment 0.5).
  const antialiasedStep = (edge, x) => clamp(x.sub(edge).mul(resolution).add(0.5), 0, 1);
  const lineCoverage = (distance, th) =>
    antialiasedStep(th.mul(-0.5), distance).sub(antialiasedStep(th.mul(0.5), distance));

  // HEXAGONAL_FUNCTIONS (only the four the drawing functions call).
  const e = float(isEven ? 1 : 0);
  const pointToCube = (p) => {
    if (isColumns) {
      const q = p.x.mul(2 * SQRT1_3).sub(2 / 3);
      return vec2(q, q.add(e).mul(-0.5).add(p.y));
    }
    const r = p.y.mul(2 * SQRT1_3).sub(2 / 3);
    return vec2(r.add(e).mul(-0.5).add(p.x), r);
  };
  const cubeToPoint = (a) => {
    if (isColumns) return vec2(a.x.add(2 / 3).mul(SQRT3 / 2), a.x.add(e).mul(0.5).add(a.y));
    return vec2(a.y.add(e).mul(0.5).add(a.x), a.y.add(2 / 3).mul(SQRT3 / 2));
  };
  const cubeRound = (a) => {
    const q = a.x;
    const r = a.y;
    const s = q.negate().sub(r);
    const iq = floor(q.add(0.5));
    const ir = floor(r.add(0.5));
    const is = floor(s.add(0.5));
    const dq = abs(iq.sub(q));
    const dr = abs(ir.sub(r));
    const ds = abs(is.sub(s));
    const roundQ = dq.greaterThan(dr).and(dq.greaterThan(ds));
    const roundR = roundQ.not().and(dr.greaterThan(ds));
    return vec2(select(roundQ, ir.negate().sub(is), iq), select(roundR, iq.negate().sub(is), ir));
  };
  /** The hex centre nearest `p`, and `p`'s offset from it with that offset's angle. */
  const hexCentre = (p) => {
    const c = cubeToPoint(cubeRound(pointToCube(p)));
    const d = p.sub(c);
    return { c, d, a: atan(d.y, d.x) };
  };
  const sixth = PI / 3;

  // NEAREST_VERTEX_FUNCTION
  const nearestVertex = (p) => {
    if (isSquare) return floor(p.add(0.5));
    const { c, a } = hexCentre(p);
    const snapped = isColumns ? floor(a.div(sixth).add(0.5)).mul(sixth) : floor(a.div(sixth)).add(0.5).mul(sixth);
    return c.add(vec2(cos(snapped), sin(snapped)).mul(SQRT1_3));
  };

  // EDGE_DISTANCE_FUNCTION
  const edgeDistance = (p) => {
    if (isSquare) {
      const d = abs(p.sub(floor(p.add(0.5))));
      return min(d.x, d.y);
    }
    const a = pointToCube(p);
    const c = cubeRound(a).sub(a);
    const q = c.x;
    const r = c.y;
    const s = q.negate().sub(r);
    return float(2)
      .sub(
        abs(q.sub(r))
          .add(abs(r.sub(s)))
          .add(abs(s.sub(q)))
      )
      .mul(0.25);
  };

  // EDGE_OFFSET_FUNCTION — (offset along the nearest edge, distance from it, that edge's length).
  const edgeOffset = (p) => {
    if (isSquare) {
      const d = abs(p.sub(floor(p.add(0.5))));
      return vec3(max(d.x, d.y), min(d.x, d.y), 1);
    }
    const { d, a } = hexCentre(p);
    // The snap is the OTHER way round from nearestVertex's (an edge's normal, not a vertex).
    const snapped = isColumns ? floor(a.div(sixth)).add(0.5).mul(sixth) : floor(a.div(sixth).add(0.5)).mul(sixth);
    const n = vec2(cos(snapped), sin(snapped));
    return vec3(dot(d, vec2(n.y.negate(), n.x)).add(0.5 * SQRT1_3), float(0.5).sub(dot(d, n)), SQRT1_3);
  };

  return { isSquare, lineCoverage, nearestVertex, edgeDistance, edgeOffset };
}

/**
 * The scene outline's black alpha at a canvas-px position — `#drawOutline`: a `width`-px stroke laid
 * OUTSIDE each rect (`alignment: 1`), its corners cut by a BEVEL join, alpha `outlineAlpha.x` round the
 * padded canvas (0 when the scene has no padding) and `outlineAlpha.y` round the scene. Edges use the
 * grid's own anti-aliased step, which on pixel-aligned edges is the hard edge PIXI rasterises.
 * @param {*} TSL
 * @param {{canvasXY:*, u:ReturnType<typeof createFoundryGridUniforms>}} a
 * @returns {*} float node: the combined black alpha, PIXI-blended (the canvas stroke under the scene's).
 */
export function buildSceneOutlineAlpha(TSL, { canvasXY, u }) {
  const { float, max, clamp } = TSL;
  const px = u.pxPerCanvas;
  const w = u.outlineWidth;
  const strokeAlpha = (rect) => {
    // Distance outside the rect along each axis (0 inside it on that axis).
    const dx = max(max(rect.x.sub(canvasXY.x), canvasXY.x.sub(rect.z)), float(0));
    const dy = max(max(rect.y.sub(canvasXY.y), canvasXY.y.sub(rect.w)), float(0));
    const outside = max(dx, dy);
    // In the band: outside the rect (by its SIGNED distance, so an inside pixel gets nothing), no
    // further out than `w`, and inside the bevel's cut across the corner.
    const signedOut = max(
      max(rect.x.sub(canvasXY.x), canvasXY.x.sub(rect.z)),
      max(rect.y.sub(canvasXY.y), canvasXY.y.sub(rect.w))
    );
    const enter = clamp(signedOut.mul(px).add(0.5), 0, 1);
    const within = clamp(w.sub(outside).mul(px).add(0.5), 0, 1);
    const bevel = clamp(w.sub(dx.add(dy)).mul(px).add(0.5), 0, 1);
    return enter.mul(within).mul(bevel);
  };
  const aCanvas = strokeAlpha(u.outlineCanvas).mul(u.outlineAlpha.x);
  const aScene = strokeAlpha(u.outlineScene).mul(u.outlineAlpha.y);
  // Two black strokes, the scene's drawn over the canvas's: 1 - (1 - a)(1 - b).
  return float(1).sub(float(1).sub(aCanvas).mul(float(1).sub(aScene)));
}

/**
 * Composite the outline and then the grid over a finished LINEAR colour, blending in display space the
 * way PIXI's canvas does (`premultiplied src + dst·(1 − a)`), and hand back linear. A pixel neither
 * touches comes back as the very same node value, so the overlay changes nothing it does not cover.
 * @param {*} TSL
 * @param {*} linearRgb - vec3 node.
 * @param {{gridAlpha:*|null, outlineAlpha:*|null, u:ReturnType<typeof createFoundryGridUniforms>}} a
 */
export function compositeFoundryOverlay(TSL, linearRgb, { gridAlpha, outlineAlpha, u, look = false }) {
  const { float, vec3, clamp, mix, select, dot, smoothstep, sRGBTransferOETF, sRGBTransferEOTF } = TSL;
  let display = sRGBTransferOETF(clamp(linearRgb, 0, 1));
  let total = float(0);
  if (outlineAlpha) {
    display = display.mul(float(1).sub(outlineAlpha));
    total = total.add(outlineAlpha);
  }
  if (gridAlpha && look) {
    // MSA's look: the ink is chosen from the picture under the line — dark ink on bright ground, pale
    // ink on dark ground, crossing over smoothly round the pivot, each with its own opacity.
    const lum = dot(display, vec3(0.2126, 0.7152, 0.0722));
    // A NARROW crossover: blended halfway, the two inks make a mid-tone about as bright as the ground
    // at the pivot, and the line vanishes there (seen live on a lamp-lit night interior).
    const bright = smoothstep(u.lookPivot.sub(0.04), u.lookPivot.add(0.04), lum);
    const ink = mix(u.lookLightInk, u.lookDarkInk, bright);
    const a = gridAlpha.mul(mix(u.lookOpacity.y, u.lookOpacity.x, bright));
    display = mix(display, ink, a);
    total = total.add(a);
  } else if (gridAlpha) {
    display = mix(display, u.color, gridAlpha);
    total = total.add(gridAlpha);
  }
  return select(total.greaterThan(0), sRGBTransferEOTF(display), vec3(linearRgb));
}
