/**
 * REGION-DRIVEN DARKNESS — the "Adjust Darkness Level" region behavior
 * (2026-07-19, part of the same pass as the global light fix). Verified
 * against source: `common/documents/region-behavior.mjs`'s `coreTypes` list
 * names `adjustDarknessLevel` (built here) and `suppressWeather` (a
 * deliberate stub — `foundry/scene-regions.js`'s own header explains why);
 * `client/data/region-behaviors/adjust-darkness-level.mjs` gives the exact
 * schema (`mode`, `modifier`) and the three formulas below, verbatim.
 *
 * THE MECHANISM Foundry itself uses (verified against source): each
 * darkness-adjusting region gets its OWN mesh + shader
 * (`AdjustDarknessLevelRegionShader`/`IlluminationDarknessLevelRegionShader`),
 * baked into a per-pixel `darknessLevelTexture` every light's illumination
 * shader samples (`computedDarknessLevel = texture2D(darknessLevelTexture,
 * vSamplerUvs).r` — this project's own foundry-v14-lighting-audit.md §5a).
 * This module reproduces the SAME per-point math on the CPU/TSL side instead
 * of building a full render-to-texture pipeline for it — see
 * `vt-pan-viewer.js`'s region-mesh wiring for how a query point (a light's
 * origin, or a fragment's world position) reaches these functions.
 *
 * ⚠️ THE REAL BUG, FOUND AND FIXED 2026-07-19 (via the interactive pixel
 * probe, author-reported: "point 1 is outside the darkening region" yet its
 * `buf:scene.illum` readback matched the darkened region's colour exactly).
 * Every `buildRegionXxxMaterial()` below calls `.discard()` to clip a
 * fragment outside its true shape — but until this fix, EVERY ONE of them
 * called it PROCEDURALLY, at material-construction time (once, synchronously,
 * from `vt-pan-viewer.js#renderRegionShape`), not from inside a `Fn()`
 * callback. Verified against the vendored source: `discard()` compiles to
 * `Stack(node)`, and `Stack` is a SILENT NO-OP whenever the module-level
 * `currentStack` is null — which it always is at plain factory-call time,
 * since `currentStack` is only ever set by `NodeBuilder#addStack()`, called
 * by the framework DURING actual shader compilation (inside a `Fn`'s own
 * deferred callback, or a `NodeMaterial` subclass's own `setupXxx(builder)`
 * lifecycle method — never during an ordinary synchronous JS call). So
 * `discard()` here compiled to NOTHING, ever, since this module was first
 * built: every region mesh painted its FULL bounding quad — deliberately
 * OVERSIZED (`computeShapeMeshBounds` uses the shape's full DIAGONAL as both
 * half-width and half-height, a generous bound meant to be trimmed down by
 * `discard()`) — un-clipped, regardless of the true authored shape. Fixed by
 * wrapping each builder's containment-test + `discard()` + colour
 * computation in `Fn(() => {...})()`, deferring their execution to actual
 * shader-build time, when `currentStack` is correctly active (the SAME
 * discipline this file's own `Loop`/`.toVar()` polygon helpers, and
 * `point-light-illumination.js`'s SDF function, already used — it turns out
 * `discard()` needed it too, and nothing caught that this whole session
 * until a probe found a point ~1,150 world units outside a region's nearest
 * true edge reading as fully darkened). NOT yet author-confirmed live after
 * the fix — the fix is source-verified, not yet re-tested with the probe.
 *
 * SCOPE, named honestly (the same "ship the common case, document the rest"
 * bar `masks.occlusion`'s own RADIAL-only note sets) — RE-AUDITED 2026-07-19
 * against the real source rather than trusted from the earlier pass:
 *   - ✅ SHAPE CONTAINMENT (2026-07-19, was a real gap, now built): covers
 *     ALL EIGHT shapes Foundry's own region-drawing toolbar has a one-click
 *     button for — rectangle, ellipse (a circle is read as an ellipse with
 *     radiusX=radiusY=radius), polygon, cone (`pointInCone`, "round"
 *     curvature only — "flat"/"semicircle" fall back to round, a cosmetic
 *     gap), ring (`pointInRing`, always a full annulus — Ring has no
 *     rotation field in Foundry's own schema), line (`pointInLine`, a thick
 *     line segment anchored at ONE endpoint), emanation (`pointInEmanation`,
 *     a Minkowski-sum growth of a base shape — exact for circle/rectangle/
 *     polygon bases, an approximation for ellipse bases, unsupported for
 *     cone/line/token bases). `common/data/data.mjs`'s `BaseShapeData.TYPES`
 *     lists TWO more (`token`, `grid`) that are NOT region-drawing-tool
 *     shapes (used elsewhere — templates, auras) — those remain "never
 *     matches", correctly, not a gap. An EARLIER version of this comment
 *     claimed "the tool only produces" rectangle/ellipse/polygon — checked
 *     against source and found false; that's what prompted building the
 *     other four. None of this TSL/shader-side work has been live-verified
 *     in a browser yet — Node-tested only (CONVENTIONS.md §4's own boundary
 *     for what Node CAN verify) — confirm live before trusting it fully.
 *   - ✅ HOLE SUPPORT (2026-07-19, was a real gap, now built): a region with
 *     MULTIPLE shapes is UNION of its non-hole shapes MINUS the UNION of its
 *     `hole`-flagged shapes (`pointInRegionShapes`, below) — real Foundry's
 *     own per-shape `hole` boolean (`common/data/data.mjs`,
 *     `BaseShapeData.hole`, toggled via `regions.mjs`'s "fa-object-subtract"
 *     toolbar button). Deliberately NOT Foundry's exact geometry: real
 *     Foundry batches CONSECUTIVE shapes by hole/non-hole RUN and applies
 *     real ClipperLib CSG per run, order-dependent
 *     (`client/documents/region.mjs#_createClipperPolyTree`) — this module
 *     instead does one GLOBAL union-then-subtract across ALL of a region's
 *     shapes regardless of authoring order. Exact for the common case (one
 *     hole cut into one darkened area) and for any region whose non-hole and
 *     hole shapes don't themselves overlap in more exotic ways; a documented
 *     simplification, not a bug, for interleaved multi-run authoring. The
 *     GPU side (`vt-pan-viewer.js#updateRegionDarknessMeshes`) mirrors this
 *     as a two-pass draw: every non-hole shape, THEN every hole shape
 *     (globally last, across every region) reusing the SAME per-shape
 *     material with `uMode`/`uModifier` overridden to an exact
 *     `BRIGHTEN`/`modifier=0` identity — no new shader math, just draw
 *     order.
 *   - ✅ CORRECTED, was WRONG: gated by the region's own `elevation:
 *     {bottom,top}` (bottom/top `null` = Foundry's own "unrestricted", per
 *     `common/documents/region.mjs`'s own field comment) — see
 *     `foundry/scene-regions.js#deriveRegionDarknessAdjuster` for the read
 *     and `vt-pan-viewer.js#updateRegionDarknessMeshes` for the per-frame
 *     filter against the CURRENTLY VIEWED floor's own elevation band
 *     (`foundry/active-scene-source.js#getActiveSceneFloors`'s
 *     `elevationBottom`/`elevationTop`). A prior version of this comment
 *     said "not gated... no per-floor query dimension yet" — that was true
 *     when written and is fixed now: verified against source that real
 *     Foundry DOES gate this behavior by elevation (`adjust-darkness-
 *     level.mjs`'s own shader `_preRender`, testing against `canvas.masks.
 *     depth.renderTexture`'s per-pixel occlusion band) — this was never a
 *     safe-to-skip simplification, it was a real, visible multi-floor bug
 *     (a region on one floor darkened every floor). MSA's own gate is a
 *     per-FLOOR band-overlap test, not Foundry's per-PIXEL depth-mask test —
 *     a coarser but architecturally honest match for a floor-based viewer.
 *   - ✅ CORRECTED, was WRONG: multiple OVERLAPPING darkness-adjusting
 *     regions at one query point resolve by the MINIMUM (brightest) of every
 *     matching region's own independently-computed adjusted value — see
 *     `computeRegionAdjustedDarkness`'s own doc for the verified mechanism
 *     (`illumination-effects.mjs#invalidateDarknessLevelContainer`, sort-
 *     by-value-descending + opaque overwrite = min-wins) and
 *     `vt-pan-viewer.js#updateRegionDarknessMeshes` for the matching GPU-
 *     side draw-order fix. A prior version of this comment said "the LAST
 *     one (array order) wins... a documented approximation, not a verified
 *     match" — it was checked this pass and was simply wrong, not merely
 *     unverified: Foundry's real rule has nothing to do with array/creation
 *     order.
 *   - ⚠ GLOBAL ILLUMINATION'S OWN FLOOR-RAISE DOES NOT REACH INSIDE A
 *     REGION'S FOOTPRINT. `vt-pan-viewer.js`'s render order is: ambient fill
 *     (already raised by `computeGlobalLightFloor` where the global light is
 *     active) → region meshes OVERWRITE their own footprint with
 *     `mix(daylight,darkness,regionAdjustedDarkness)`, which does NOT
 *     re-incorporate the global light's own contribution → point lights
 *     MAX-blend on top of THAT. So a scene with Global Illumination ON and a
 *     region that also darkens/brightens the SAME area will show the
 *     region's own value there, not `max(regionValue, globalLightFloor)` —
 *     real Foundry's per-pixel `darknessLevelTexture` feeds every consumer
 *     (global light's gate included) from the SAME adjusted value, so this
 *     is a genuine, undecided interaction between two features built in the
 *     same pass, not a silent bug: reconciling it needs the region material
 *     to ALSO re-run `computeGlobalLightFloor`-equivalent math per-region
 *     (its own `uMode`/`uModifier`-style uniforms for the global light's
 *     enabled/window/luminosity/bright), not attempted this pass — narrow,
 *     two-features-active-in-the-same-spot edge case, not the common path.
 *
 * @module effects/lighting/region-darkness
 */

const DEG2RAD = Math.PI / 180;

/** @param {number} v @param {number} fallback @returns {number} */
function num(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

/**
 * `RectangleShapeData`: origin `(x,y)`, an anchor (0..1 fraction of
 * width/height) locating the box relative to that origin, rotated around the
 * origin. Un-rotate the query point into the rectangle's own local space,
 * then test the anchor-offset axis-aligned box.
 *
 * @param {number} px @param {number} py
 * @param {{x:number,y:number,width:number,height:number,anchorX?:number,anchorY?:number,rotation?:number}} rect
 * @returns {boolean}
 */
export function pointInRectangle(px, py, rect) {
  const width = num(rect?.width, 0);
  const height = num(rect?.height, 0);
  if (!(width > 0) || !(height > 0)) return false;
  const x = num(rect.x, 0);
  const y = num(rect.y, 0);
  const anchorX = num(rect.anchorX, 0);
  const anchorY = num(rect.anchorY, 0);
  const rad = -num(rect.rotation, 0) * DEG2RAD;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - x;
  const dy = py - y;
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  const left = -anchorX * width;
  const top = -anchorY * height;
  return lx >= left && lx <= left + width && ly >= top && ly <= top + height;
}

/**
 * `EllipseShapeData`: center `(x,y)`, `radiusX`/`radiusY`, rotated around the
 * center. A `CircleShapeData` is the special case `radiusX === radiusY === radius`.
 *
 * @param {number} px @param {number} py
 * @param {{x:number,y:number,radiusX:number,radiusY:number,rotation?:number}} ellipse
 * @returns {boolean}
 */
export function pointInEllipse(px, py, ellipse) {
  const radiusX = num(ellipse?.radiusX, 0);
  const radiusY = num(ellipse?.radiusY, 0);
  if (!(radiusX > 0) || !(radiusY > 0)) return false;
  const x = num(ellipse.x, 0);
  const y = num(ellipse.y, 0);
  const rad = -num(ellipse.rotation, 0) * DEG2RAD;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - x;
  const dy = py - y;
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  const nx = lx / radiusX;
  const ny = ly / radiusY;
  return nx * nx + ny * ny <= 1;
}

/**
 * `PolygonShapeData`: a flat `[x0,y0,x1,y1,...]` WORLD-space point list — the
 * same standard ray-casting point-in-polygon test this module's sibling
 * (`point-light-illumination.js#makeSdPolygonEdgeDistance`) uses on the GPU
 * side, here on the CPU for a query point.
 *
 * @param {number} px @param {number} py @param {number[]} points
 * @returns {boolean}
 */
export function pointInPolygon(px, py, points) {
  if (!Array.isArray(points) || points.length < 6 || points.length % 2 !== 0) return false;
  const n = points.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i * 2];
    const yi = points[i * 2 + 1];
    const xj = points[j * 2];
    const yj = points[j * 2 + 1];
    if (![xi, yi, xj, yj].every(Number.isFinite)) continue;
    const crosses = yi > py !== yj > py;
    if (crosses) {
      const xIntersect = ((xj - xi) * (py - yi)) / (yj - yi) + xi;
      if (px < xIntersect) inside = !inside;
    }
  }
  return inside;
}

/**
 * `ConeShapeData` (`common/data/data.mjs:352-389`, verified): apex `(x,y)`,
 * `radius`, `angle` (the wedge's opening angle, degrees), `rotation` (the
 * direction of the wedge's own center axis, degrees). Foundry's angle
 * convention (`AngleField`, `common/data/fields.mjs`, and confirmed via
 * `getCone`/`getTranslatedPoint` in `common/grid/`): 0° = +x (east),
 * increasing angle sweeps CLOCKWISE on screen (Y is down, so this is the
 * same `atan2(dy,dx)` convention already used below — no sign flip needed,
 * unlike the rectangle/ellipse/line rotation transforms, which un-rotate a
 * POINT into local space rather than compare two angles directly).
 *
 * `curvature:"round"` (the schema default, and the ONLY variant implemented
 * here) is a true circular sector — apex, radius, bounded by two rays at
 * `rotation ± angle/2`. `"flat"`/`"semicircle"` (verbatim `curvature`
 * values, `client/data/shapes.mjs`) produce a straight-fronted wedge or an
 * inscribed semicircle respectively, both cosmetically different from round
 * — NOT implemented; this function treats every cone as round regardless of
 * its own `curvature` field. A documented gap, not a silent one.
 *
 * @param {number} px @param {number} py
 * @param {{x:number,y:number,radius:number,angle:number,rotation?:number}} cone
 * @returns {boolean}
 */
export function pointInCone(px, py, cone) {
  const radius = num(cone?.radius, 0);
  if (!(radius > 0)) return false;
  const x = num(cone.x, 0);
  const y = num(cone.y, 0);
  const dx = px - x;
  const dy = py - y;
  const distSq = dx * dx + dy * dy;
  if (distSq > radius * radius) return false;
  // The apex itself belongs to every cone regardless of its own angle/
  // rotation (atan2(0,0) is arbitrary — 0 — which would wrongly exclude the
  // apex for a wedge not centered on 0°; guard it explicitly).
  if (distSq < 1e-9) return true;
  const angle = num(cone.angle, 0);
  if (!(angle > 0)) return false; // a zero/negative-degree wedge covers nothing but its own apex
  if (angle >= 360) return true; // a full circle — already passed the radius test above
  const rotation = num(cone.rotation, 0);
  const angleToPointDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  // Minimal signed angular difference, normalized to (-180, 180] — handles
  // the 0°/360° wraparound correctly (e.g. rotation=350, angle=60 spans
  // [320,360)∪[0,20), which a naive min/max range check would miss).
  const diff = ((((angleToPointDeg - rotation + 180) % 360) + 360) % 360) - 180;
  return Math.abs(diff) <= angle / 2;
}

/**
 * `RingShapeData` (`common/data/data.mjs:405-425`, verified): center
 * `(x,y)`, `radius` (the ring's own "seam" radius), `innerWidth`,
 * `outerWidth`. Ring NEVER defines a `rotation` field and overrides
 * `_rotate()` as a no-op in Foundry's own source (`client/data/
 * shapes.mjs:1444`) — it is always a full annulus (donut), never an angular
 * segment. `innerRadius = radius - innerWidth`, `outerRadius = radius +
 * outerWidth` (`common/grid/base.mjs:680-684`, verified).
 *
 * @param {number} px @param {number} py
 * @param {{x:number,y:number,radius:number,innerWidth?:number,outerWidth?:number}} ring
 * @returns {boolean}
 */
export function pointInRing(px, py, ring) {
  const radius = num(ring?.radius, 0);
  if (!(radius > 0)) return false;
  const innerWidth = num(ring.innerWidth, 0);
  const outerWidth = num(ring.outerWidth, 0);
  const innerRadius = Math.max(0, radius - innerWidth);
  const outerRadius = radius + outerWidth;
  if (!(outerRadius > innerRadius)) return false; // a degenerate (zero-thickness, or inverted) ring covers nothing
  const x = num(ring.x, 0);
  const y = num(ring.y, 0);
  const dx = px - x;
  const dy = py - y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  return dist >= innerRadius && dist <= outerRadius;
}

/**
 * `LineShapeData` (`common/data/data.mjs:441-461`, verified): `(x,y)` is
 * ONE ENDPOINT (the origin, not the center), `length`, `width`, `rotation`
 * (the direction FROM the origin TOWARD the far endpoint, degrees) — a
 * "thick line segment", exactly a rectangle anchored at its own start edge
 * and centered across its width (`common/grid/base.mjs:555-566`, `getLine`,
 * verified: destination = origin translated by `(rotation, length)`, the
 * rectangle offsets both endpoints perpendicular by `±width/2`). Same
 * un-rotate-the-query-point technique as `pointInRectangle`/`pointInEllipse`
 * above (negate rotation to un-rotate INTO local space, not TO it).
 *
 * @param {number} px @param {number} py
 * @param {{x:number,y:number,length:number,width:number,rotation?:number}} line
 * @returns {boolean}
 */
export function pointInLine(px, py, line) {
  const length = num(line?.length, 0);
  const width = num(line?.width, 0);
  if (!(length > 0) || !(width > 0)) return false;
  const x = num(line.x, 0);
  const y = num(line.y, 0);
  const rad = -num(line.rotation, 0) * DEG2RAD;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - x;
  const dy = py - y;
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  return lx >= 0 && lx <= length && ly >= -width / 2 && ly <= width / 2;
}

/**
 * The nearest-point-on-a-rotated-rectangle distance — the CPU building block
 * `pointInEmanation`'s own rectangle-base case needs (a rect's true
 * Minkowski sum with a disk of radius `r` is exactly "inside the rect, OR
 * within `r` of the rect's boundary" — this computes that boundary
 * distance). Same local-space transform as `pointInRectangle` (distances
 * are preserved under rotation, so computing in the un-rotated local frame
 * gives the identical answer to computing in world space).
 *
 * @param {number} px @param {number} py @param {object} rect - see `pointInRectangle`.
 * @returns {number} always >= 0.
 */
function distanceToRectangleBoundary(px, py, rect) {
  const width = num(rect?.width, 0);
  const height = num(rect?.height, 0);
  const x = num(rect.x, 0);
  const y = num(rect.y, 0);
  const anchorX = num(rect.anchorX, 0);
  const anchorY = num(rect.anchorY, 0);
  const rad = -num(rect.rotation, 0) * DEG2RAD;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - x;
  const dy = py - y;
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  const left = -anchorX * width;
  const top = -anchorY * height;
  const nx = Math.min(Math.max(lx, left), left + width);
  const ny = Math.min(Math.max(ly, top), top + height);
  const ddx = lx - nx;
  const ddy = ly - ny;
  return Math.sqrt(ddx * ddx + ddy * ddy);
}

/**
 * The nearest-point-on-a-polygon-boundary distance — the same building
 * block, for `pointInEmanation`'s polygon-base case. The CPU twin of
 * `point-light-illumination.js#makeSdPolygonEdgeDistance`'s own TSL
 * unsigned-distance term (same point-to-segment-clamp technique, here on
 * the CPU for a single query point instead of per-fragment on the GPU).
 *
 * @param {number} px @param {number} py @param {number[]} points - flat
 *   `[x0,y0,x1,y1,...]`, already validated by the caller.
 * @returns {number} always >= 0.
 */
function distanceToPolygonBoundary(px, py, points) {
  const n = points.length / 2;
  let minDistSq = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i * 2];
    const yi = points[i * 2 + 1];
    const xj = points[j * 2];
    const yj = points[j * 2 + 1];
    const ex = xj - xi;
    const ey = yj - yi;
    const wx = px - xi;
    const wy = py - yi;
    const eDotE = Math.max(ex * ex + ey * ey, 1e-12); // guard a zero-length edge, same as the TSL twin
    const t = Math.min(1, Math.max(0, (wx * ex + wy * ey) / eDotE));
    const cx = xi + ex * t;
    const cy = yi + ey * t;
    const ddx = px - cx;
    const ddy = py - cy;
    const distSq = ddx * ddx + ddy * ddy;
    if (distSq < minDistSq) minDistSq = distSq;
  }
  return Math.sqrt(minDistSq);
}

/**
 * `EmanationShapeData` (`common/data/data.mjs:317-335`, verified): a STATIC
 * authored shape, NOT live token tracking — it wraps a `base` shape (any
 * `BaseShapeData` subtype EXCEPT `emanation`/`ring`, per Foundry's own
 * schema) and grows it outward by `radius` pixels, a true Minkowski sum with
 * a disk (`client/data/shapes.mjs:1722+`; e.g. a circular base becomes
 * `getCircle(center, base.radius + this.radius)`, `shapes.mjs:1739`). Even
 * `RegionDocument.createTokenEmanation` (`client/documents/region.mjs:
 * 1268-1286`) BAKES the token's position into `base.x/y` at creation time —
 * later token movement re-writes the region's own shape data via a real
 * document update (`client/documents/token.mjs#computeAttachedRegionUpdates`),
 * it does not bind live to a moving transform at render time. So an
 * emanation shape read here is always a plain, static geometric definition.
 *
 * Exact per base type: circle/ellipse growth is exact (Minkowski sum of a
 * disk with a disk, or — for ellipse — an APPROXIMATION: true ellipse+disk
 * Minkowski sum has no simple closed form, so this widens both radii by
 * `radius` directly, which is exact only for a circular base and a close
 * approximation otherwise, most accurate at modest `radius` relative to the
 * base ellipse's own size). Rectangle/polygon growth is EXACT (inside the
 * base shape, OR within `radius` of its boundary — genuinely the Minkowski
 * sum with a disk for any convex-or-not polygon/rect). `cone`/`line`/
 * `token` bases are NOT implemented (never matches, never throws) — a
 * documented gap: these combinations are rare, and cone/line growth has no
 * equally simple boundary-distance shortcut without porting real offset-
 * polygon geometry. `ring`/`emanation` bases can't occur (excluded by
 * Foundry's own schema) and fall through the same `default`.
 *
 * @param {number} px @param {number} py
 * @param {{radius:number, base:object}} emanation
 * @returns {boolean}
 */
export function pointInEmanation(px, py, emanation) {
  const base = emanation?.base;
  if (!base) return false;
  const radius = Math.max(0, num(emanation.radius, 0));
  switch (base.type) {
    case 'circle': {
      const r = num(base.radius, 0) + radius;
      return pointInEllipse(px, py, { x: base.x, y: base.y, radiusX: r, radiusY: r });
    }
    case 'ellipse':
      return pointInEllipse(px, py, {
        x: base.x,
        y: base.y,
        radiusX: num(base.radiusX, 0) + radius,
        radiusY: num(base.radiusY, 0) + radius,
        rotation: base.rotation,
      });
    case 'rectangle':
      if (pointInRectangle(px, py, base)) return true;
      return radius > 0 && distanceToRectangleBoundary(px, py, base) <= radius;
    case 'polygon': {
      const points = base.points;
      if (!Array.isArray(points) || points.length < 6 || points.length % 2 !== 0) return false;
      if (pointInPolygon(px, py, points)) return true;
      return radius > 0 && distanceToPolygonBoundary(px, py, points) <= radius;
    }
    default:
      // cone/line/token bases (this function's own doc) — never matches.
      return false;
  }
}

/**
 * Dispatch ONE shape's own containment test by its `type` — the single
 * per-shape building block both the non-hole UNION pass and the HOLE
 * SUBTRACTION pass in `pointInRegionShapes` below share, so the type switch
 * itself is written exactly once.
 *
 * @param {number} px @param {number} py @param {object} shape
 * @returns {boolean}
 */
function pointInOneShape(px, py, shape) {
  switch (shape.type) {
    case 'rectangle':
      return pointInRectangle(px, py, shape);
    case 'ellipse':
      return pointInEllipse(px, py, shape);
    case 'circle':
      return pointInEllipse(px, py, { x: shape.x, y: shape.y, radiusX: shape.radius, radiusY: shape.radius });
    case 'polygon':
      return pointInPolygon(px, py, shape.points);
    case 'cone':
      return pointInCone(px, py, shape);
    case 'ring':
      return pointInRing(px, py, shape);
    case 'line':
      return pointInLine(px, py, shape);
    case 'emanation':
      return pointInEmanation(px, py, shape);
    default:
      // token/grid, or an unrecognized future type — never matches, never throws.
      return false;
  }
}

/**
 * Is `(px,py)` inside a region's own shapes — UNION of the non-hole shapes,
 * minus (subtracting) the union of the `hole` shapes? See this module's
 * header for the union-not-real-CSG simplification this represents
 * (a GLOBAL hole subtraction across the whole region, not Foundry's exact
 * consecutive-shape-run/ClipperLib ordering — a documented approximation,
 * exact for the common case of a region with ONE hole cut into it, and for
 * any region where the non-hole and hole shapes don't themselves overlap in
 * a way that depends on authoring order).
 *
 * @param {number} px @param {number} py @param {object[]} shapes - each a raw
 *   `BaseShapeData`-shaped object carrying its own `type` discriminator
 *   (`'rectangle'|'circle'|'ellipse'|'polygon'|'cone'|'ring'|'line'|
 *   'emanation'|...` — Foundry's own `TypedSchemaField` injects this field
 *   onto every shape instance, verified against source, `common/data/
 *   fields.mjs`) and its own `hole` boolean (`BaseShapeData.hole`, verified
 *   real and applying uniformly to every shape type, `common/data/data.mjs`).
 * @returns {boolean}
 */
export function pointInRegionShapes(px, py, shapes) {
  if (!Array.isArray(shapes)) return false;
  let insideNonHole = false;
  for (const shape of shapes) {
    if (!shape || shape.hole) continue;
    if (pointInOneShape(px, py, shape)) {
      insideNonHole = true;
      break;
    }
  }
  if (!insideNonHole) return false;
  for (const shape of shapes) {
    if (!shape || !shape.hole) continue;
    if (pointInOneShape(px, py, shape)) return false; // a hole subtracts, regardless of authoring order
  }
  return true;
}

/**
 * A CONSERVATIVE world-space bounding box for one shape — for sizing/
 * positioning its mesh, NOT for the containment test itself (that's the
 * analytic per-fragment test in TSL below; a generous bound here only costs
 * a few extra discarded fragments, never a correctness issue — this
 * module's own TSL-section header explains why). Returns `null` for an
 * unsupported/malformed shape (the caller skips building a mesh for it,
 * matching `pointInRegionShapes`'s own "never matches" treatment).
 *
 * @param {object} shape
 * @returns {{cx:number, cy:number, halfWidth:number, halfHeight:number}|null}
 */
export function computeShapeMeshBounds(shape) {
  if (!shape) return null;
  switch (shape.type) {
    case 'rectangle': {
      const width = num(shape.width, 0);
      const height = num(shape.height, 0);
      if (!(width > 0) || !(height > 0)) return null;
      // The diagonal safely bounds the box regardless of rotation/anchor
      // (anchor is a 0..1 fraction of width/height, so the shifted box never
      // reaches beyond one full width/height past the origin either way).
      const diag = Math.sqrt(width * width + height * height);
      return { cx: num(shape.x, 0), cy: num(shape.y, 0), halfWidth: diag, halfHeight: diag };
    }
    case 'ellipse': {
      const radiusX = num(shape.radiusX, 0);
      const radiusY = num(shape.radiusY, 0);
      if (!(radiusX > 0) || !(radiusY > 0)) return null;
      const r = Math.max(radiusX, radiusY);
      return { cx: num(shape.x, 0), cy: num(shape.y, 0), halfWidth: r, halfHeight: r };
    }
    case 'circle': {
      const radius = num(shape.radius, 0);
      if (!(radius > 0)) return null;
      return { cx: num(shape.x, 0), cy: num(shape.y, 0), halfWidth: radius, halfHeight: radius };
    }
    case 'polygon': {
      const points = shape.points;
      if (!Array.isArray(points) || points.length < 6 || points.length % 2 !== 0) return null;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < points.length; i += 2) {
        const x = points[i];
        const y = points[i + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
      return {
        cx: (minX + maxX) / 2,
        cy: (minY + maxY) / 2,
        halfWidth: (maxX - minX) / 2,
        halfHeight: (maxY - minY) / 2,
      };
    }
    case 'cone': {
      // The whole disk, not just the wedge — generous, same "a few extra
      // discarded fragments, never a correctness issue" philosophy as every
      // other bound here (a true wedge-only bound would need the rotation/
      // angle to size tightly, not worth it for a bounding-quad hint).
      const radius = num(shape.radius, 0);
      if (!(radius > 0)) return null;
      return { cx: num(shape.x, 0), cy: num(shape.y, 0), halfWidth: radius, halfHeight: radius };
    }
    case 'ring': {
      const radius = num(shape.radius, 0);
      const outerRadius = radius + num(shape.outerWidth, 0);
      if (!(outerRadius > 0)) return null;
      return { cx: num(shape.x, 0), cy: num(shape.y, 0), halfWidth: outerRadius, halfHeight: outerRadius };
    }
    case 'line': {
      const length = num(shape.length, 0);
      const width = num(shape.width, 0);
      if (!(length > 0) || !(width > 0)) return null;
      // Same "diagonal from the origin corner" reasoning as rectangle above
      // — the line's own true worst-case extent from its origin endpoint is
      // sqrt(length² + (width/2)²) (origin is centered across width, not a
      // true corner); sqrt(length²+width²) is a safe, slightly more
      // generous bound, kept for consistency with this file's own style.
      const diag = Math.sqrt(length * length + width * width);
      return { cx: num(shape.x, 0), cy: num(shape.y, 0), halfWidth: diag, halfHeight: diag };
    }
    case 'emanation': {
      // Only for base types pointInEmanation actually implements — building
      // a mesh for an unsupported base (cone/line/token) would just be a
      // mesh that always discards; skip it at the source instead, matching
      // this function's own "unsupported shape has no bounds" contract.
      const base = shape.base;
      if (!base || !['circle', 'ellipse', 'rectangle', 'polygon'].includes(base.type)) return null;
      const baseBounds = computeShapeMeshBounds(base);
      if (!baseBounds) return null;
      const radius = Math.max(0, num(shape.radius, 0));
      return {
        cx: baseBounds.cx,
        cy: baseBounds.cy,
        halfWidth: baseBounds.halfWidth + radius,
        halfHeight: baseBounds.halfHeight + radius,
      };
    }
    default:
      return null;
  }
}

/**
 * Copy a flat WORLD-space `[x0,y0,x1,y1,...]` polygon into a caller-owned,
 * FIXED-CAPACITY array of mutable `{x,y}` points — the polygon material's
 * own `uniformArray` backing store. Same reuse/truncation contract as
 * `point-light-illumination.js#writeLightEdgePoints` (mutate in place, never
 * grow, truncate gracefully past capacity) — deliberately NOT normalized to
 * local/unit space (unlike that function): this shape's shader tests
 * directly against `positionWorld`, so the points stay in world space as-is.
 *
 * @param {number[]} points @param {Array<{x:number,y:number}>} outPoints
 * @returns {number} how many of `outPoints` were written (<= outPoints.length).
 */
export function writeRegionPolygonPoints(points, outPoints) {
  const n = Array.isArray(points) ? Math.floor(points.length / 2) : 0;
  const count = Math.min(n, outPoints.length);
  for (let i = 0; i < count; i++) {
    const x = points[i * 2];
    const y = points[i * 2 + 1];
    outPoints[i].x = Number.isFinite(x) ? x : 0;
    outPoints[i].y = Number.isFinite(y) ? y : 0;
  }
  return count;
}

/**
 * `AdjustDarknessLevelRegionBehaviorType.MODES` — verbatim from source
 * (`client/data/region-behaviors/adjust-darkness-level.mjs`).
 */
export const DARKNESS_ADJUST_MODES = Object.freeze({ OVERRIDE: 0, BRIGHTEN: 1, DARKEN: 2 });

/**
 * The three darkness-adjustment formulas, verbatim from source:
 *   OVERRIDE(0): darknessLevel = modifier
 *   BRIGHTEN(1): darknessLevel * (1 - modifier)
 *   DARKEN(2):   1 - (1 - darknessLevel) * (1 - modifier)
 * An unrecognized `mode` changes nothing (returns `darkness01` unmodified) —
 * never throws, never NaNs.
 *
 * @param {number} darkness01 @param {number} mode @param {number} modifier
 * @returns {number} the adjusted darkness, 0..1.
 */
export function applyDarknessAdjustment(darkness01, mode, modifier) {
  const base = Math.min(1, Math.max(0, num(darkness01, 0)));
  const m = Math.min(1, Math.max(0, num(modifier, 0)));
  switch (mode) {
    case DARKNESS_ADJUST_MODES.OVERRIDE:
      return m;
    case DARKNESS_ADJUST_MODES.BRIGHTEN:
      return base * (1 - m);
    case DARKNESS_ADJUST_MODES.DARKEN:
      return 1 - (1 - base) * (1 - m);
    default:
      return base;
  }
}

/**
 * Does a darkness-adjusting region's own elevation range overlap a floor's
 * elevation band? The elevation-gating half of the 2026-07-19 multi-floor
 * fix (see this module's own header SCOPE section for the full mechanism —
 * this is the pure, Node-testable overlap test; `vt-pan-viewer.js#update
 * RegionDarknessMeshes` calls it once per active region per frame against
 * the CURRENTLY VIEWED floor's own band, read via
 * `foundry/active-scene-source.js#getActiveSceneFloors`).
 *
 * `null` on either side of either range reads as Foundry's own convention
 * (`common/documents/region.mjs`'s `elevation` field comment, verified):
 * a `null` bottom is -Infinity, a `null` top is +Infinity — i.e. a region
 * (or a floor) with no elevation restriction authored overlaps everything.
 * This is why an ordinary region — the overwhelming common case, elevation
 * left untouched by the GM — is unaffected by this gate at all: both its
 * own bottom/top read as ±Infinity, so the overlap test is trivially true
 * for every floor, exactly matching the pre-this-fix (unconditional)
 * behaviour for every region that doesn't explicitly restrict elevation.
 *
 * Standard half-open-interval overlap (`aBottom <= bTop && bBottom <= aTop`)
 * — two ranges overlap unless one ends entirely before the other begins.
 *
 * @param {number|null} regionBottom @param {number|null} regionTop
 * @param {number|null} floorBottom @param {number|null} floorTop
 * @returns {boolean}
 */
export function regionOverlapsElevationBand(regionBottom, regionTop, floorBottom, floorTop) {
  const rBottom = Number.isFinite(regionBottom) ? regionBottom : -Infinity;
  const rTop = Number.isFinite(regionTop) ? regionTop : Infinity;
  const fBottom = Number.isFinite(floorBottom) ? floorBottom : -Infinity;
  const fTop = Number.isFinite(floorTop) ? floorTop : Infinity;
  return rBottom <= fTop && fBottom <= rTop;
}

/**
 * The scene darkness a query point ACTUALLY sees, after every darkness-
 * adjusting region it falls inside — the CPU/TSL-side stand-in for Foundry's
 * own per-pixel `darknessLevelTexture` sample (this module's header). No
 * matching region: `darkness01` passes through unchanged.
 *
 * OVERLAP RULE — CORRECTED (2026-07-19), verified against source (was a
 * guess, documented as one, and was wrong): a prior version of this function
 * used "last matching region in array order wins" — a bare overwrite. Real
 * Foundry does not compose regions by array/creation order at all.
 * `illumination-effects.mjs#invalidateDarknessLevelContainer` sorts region
 * meshes by their OWN adjusted darkness level, DESCENDING, with its own
 * comment stating the reason explicitly: "the final darkness level at a
 * point is the MINIMUM of the adjusted darkness levels" — then draws them
 * with a plain (non-additive) opaque overwrite, so the region computing the
 * LOWEST (brightest) adjusted value ends up drawn last and wins. This
 * function reproduces that OUTCOME directly (evaluate every matching
 * region's own adjusted value independently from the SAME base `darkness01`
 * — never chained/compounding through a running result — then take the
 * minimum), which is mathematically identical to Foundry's sort-then-
 * overwrite mechanism without needing to replicate the sort itself here.
 *
 * @param {number} px @param {number} py @param {number} darkness01
 * @param {Array<{mode:number, modifier:number, shapes:object[]}>} regions -
 *   `foundry/scene-regions.js#readActiveDarknessRegions`'s own `.regions`.
 * @returns {number}
 */
export function computeRegionAdjustedDarkness(px, py, darkness01, regions) {
  if (!Array.isArray(regions) || regions.length === 0) return darkness01;
  let result = null;
  for (const region of regions) {
    if (!region) continue;
    if (pointInRegionShapes(px, py, region.shapes)) {
      // Every match reads the ORIGINAL darkness01, never the running
      // `result` — each region's adjustment is independent, not a cascade.
      const adjusted = applyDarknessAdjustment(darkness01, region.mode, region.modifier);
      result = result === null ? adjusted : Math.min(result, adjusted);
    }
  }
  return result === null ? darkness01 : result;
}

/* -------------------------------------------- */
/*  TSL — per-pixel rendering (2026-07-19)       */
/* -------------------------------------------- */

/**
 * THE APPROACH (verified TSL primitives only, matching this project's own
 * `reference_tsl_method_chaining_trap`/`Loop`-inside-`Fn` discipline from
 * point-light-illumination.js's SDF work):
 *
 * Foundry rasterizes each darkness-adjusting region's TRUE shape into a
 * `darknessLevelTexture` every light samples per-pixel (this module's own
 * header). Rather than build a full render-to-texture + region-mesh-
 * triangulation pipeline, each region SHAPE gets a generously-oversized
 * WORLD-SPACE bounding quad (no precise triangulation needed — a shape's
 * true footprint is decided analytically, per-fragment, by the SAME
 * `pointInRectangle`/`pointInEllipse`/`pointInPolygon` logic above, just
 * expressed in TSL instead of JS) whose fragment shader:
 *   1. Tests whether `positionWorld.xy` (real fragment world position —
 *      verified present in the vendored TSL export list) is inside the
 *      TRUE shape;
 *   2. `discard()`s everywhere it is not, leaving whatever the ambient-fill
 *      pass already wrote completely untouched there;
 *   3. Where it IS inside: applies this region's OWN mode/modifier to the
 *      BASE scene darkness, mixes daylight/darkness by the result, and
 *      writes that — a bare overwrite, not a blend. Overlapping darkness
 *      regions therefore compose by DRAW ORDER — updateRegionDarknessMeshes
 *      (vt-pan-viewer.js) sorts them by their own adjusted-darkness value
 *      DESCENDING before assigning renderOrder, so the brightest region
 *      always draws last and wins (verified against Foundry's real
 *      mechanism, `computeRegionAdjustedDarkness`'s own doc has the full
 *      citation) — a value-based min-composite, NOT array/creation order,
 *      corrected 2026-07-19 (a prior version of this comment got that wrong).
 * The mesh's own size/position is ONLY a "which fragments even get tested"
 * hint — correctness comes entirely from the analytic test against WORLD
 * position, so a conservatively-oversized quad is always safe, never wrong.
 *
 * `discard()` verified against source as a method available via
 * `addMethodChaining("discard", Discard)`; `Loop`/`.toVar()`/`.assign()`
 * (needed for the polygon case) verified the same way the point-light SDF
 * shader's own header already documents — wrapped in their own `Fn`, not
 * called from procedural material-building code directly (this file's own
 * caution, carried over from that file).
 */

/**
 * The shared "apply this region's mode/modifier to the base darkness, mix
 * daylight/darkness by the result" tail — identical across all three shape
 * kinds, so built once and called from each. `select`-chained rather than a
 * real switch (TSL has no statement-level switch): only 3 constant modes
 * exist (`DARKNESS_ADJUST_MODES`), so this is a direct, exhaustive mirror of
 * `applyDarknessAdjustment`'s own JS `switch`, not an approximation of it.
 *
 * @param {*} TSL @param {*} args
 * @returns {*} the mixed daylight/darkness colour for a fragment INSIDE the shape.
 */
function computeRegionColor(TSL, { uMode, uModifier, uBaseDarkness01, uDaylightColor, uDarknessColor }) {
  const { float, int, mix, select } = TSL;
  const override = uModifier;
  const brighten = uBaseDarkness01.mul(float(1).sub(uModifier));
  const darken = float(1).sub(float(1).sub(uBaseDarkness01).mul(float(1).sub(uModifier)));
  const adjusted = select(
    uMode.equal(int(DARKNESS_ADJUST_MODES.OVERRIDE)),
    override,
    select(uMode.equal(int(DARKNESS_ADJUST_MODES.BRIGHTEN)), brighten, darken)
  );
  return mix(uDaylightColor, uDarknessColor, adjusted);
}

/**
 * Build ONE rectangle-shaped darkness region's material. Fresh per-shape
 * uniforms (mirrors point-light-illumination.js's per-light uniform
 * pattern); `uDaylightColor`/`uDarknessColor` are SHARED, caller-owned
 * (same ambient endpoints every light/region reads — not the pre-mixed
 * background, since this needs to re-mix with a DIFFERENT, per-fragment
 * darkness value).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uDaylightColor - shared vec3 uniform (sRGB), env's `ambient.daylight`.
 * @param {*} args.uDarknessColor - shared vec3 uniform (sRGB), env's `ambient.darkness`.
 * @returns {{material: *, uOrigin: *, uSize: *, uAnchor: *, uRotationRad: *,
 *   uMode: *, uModifier: *, uBaseDarkness01: *}}
 */
export function buildRegionRectangleMaterial({ THREE, uDaylightColor, uDarknessColor }) {
  const { uniform, float, int, vec2, vec4, cos, sin, positionWorld, Fn } = THREE.TSL;

  const uOrigin = uniform(vec2(0, 0));
  const uSize = uniform(vec2(100, 100));
  const uAnchor = uniform(vec2(0, 0));
  const uRotationRad = uniform(float(0));
  const uMode = uniform(int(0));
  const uModifier = uniform(float(0));
  const uBaseDarkness01 = uniform(float(0));

  // ───────────────────────────────────────────────────────────────────────
  // WHY THE WHOLE BODY IS WRAPPED IN Fn() (2026-07-19, THE REAL "a point far
  // outside every authored region still reads as darkened" BUG — found via
  // the interactive pixel probe, author-reported and reproduced with exact
  // world coordinates). `discard()`'s own implementation, verified against
  // the vendored source, is `Discard = (c) => (...).toStack()`, and
  // `Stack(node) { if (currentStack) currentStack.addToStack(node); }` — a
  // SILENT NO-OP whenever the module-level `currentStack` is null. That
  // variable is only ever set by `NodeBuilder#addStack()`, which the
  // framework calls automatically DURING actual shader compilation (e.g.
  // inside a ShaderNode/Fn's own deferred callback, `setupOutput()`:
  // `addStack(); this.call(builder); removeStack();`) — NEVER during a
  // plain, synchronous JS factory-function call like this one. Every
  // `buildRegionXxxMaterial()` here runs ONCE, procedurally, when a shape's
  // mesh is first created (`vt-pan-viewer.js#renderRegionShape`) — long
  // before the renderer ever builds this material's shader — so `discard()`
  // called directly at that point compiled to NOTHING, ever, since this
  // system was first built: every region mesh painted its FULL (deliberately
  // oversized, diagonal-based — see `computeShapeMeshBounds`) bounding quad
  // with its computed colour, un-clipped, regardless of the true authored
  // shape. Wrapping the containment test + `discard()` + colour computation
  // in `Fn(() => {...})()` defers their EXECUTION until the material's
  // fragment shader is actually built — inside the SAME `addStack`/
  // `removeStack` wrap `setupOutput()` uses — so `currentStack` is correctly
  // active exactly when `.discard()`'s own `.toStack()` call happens. This
  // is the SAME discipline `point-light-illumination.js`'s own SDF function
  // and this file's own polygon/emanation `Loop`-based helpers already used
  // for `Loop`/`.toVar()`/`.assign()` — it turns out `discard()` needed it
  // too, and nothing here caught that until a probe found a point 1000+
  // world units outside every rectangle reading the region's own colour.
  // ───────────────────────────────────────────────────────────────────────
  const fragmentNode = Fn(() => {
    const rel = positionWorld.xy.sub(uOrigin);
    const cosR = cos(uRotationRad.negate());
    const sinR = sin(uRotationRad.negate());
    const lx = rel.x.mul(cosR).sub(rel.y.mul(sinR));
    const ly = rel.x.mul(sinR).add(rel.y.mul(cosR));
    const left = uAnchor.x.negate().mul(uSize.x);
    const top = uAnchor.y.negate().mul(uSize.y);
    const inside = lx
      .greaterThanEqual(left)
      .and(lx.lessThanEqual(left.add(uSize.x)))
      .and(ly.greaterThanEqual(top))
      .and(ly.lessThanEqual(top.add(uSize.y)));
    inside.not().discard();
    const color = computeRegionColor(THREE.TSL, { uMode, uModifier, uBaseDarkness01, uDaylightColor, uDarknessColor });
    return vec4(color, float(1));
  })();

  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.fragmentNode = fragmentNode;

  return { material, uOrigin, uSize, uAnchor, uRotationRad, uMode, uModifier, uBaseDarkness01 };
}

/**
 * Build ONE ellipse-shaped (circle is radiusX=radiusY) darkness region's
 * material — see `buildRegionRectangleMaterial`'s own header for the shared
 * design (per-shape uniforms, shared ambient endpoints, discard-outside).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uDaylightColor @param {*} args.uDarknessColor
 * @returns {{material: *, uOrigin: *, uRadii: *, uRotationRad: *, uMode: *,
 *   uModifier: *, uBaseDarkness01: *}}
 */
export function buildRegionEllipseMaterial({ THREE, uDaylightColor, uDarknessColor }) {
  const { uniform, float, int, vec2, vec4, cos, sin, positionWorld, Fn } = THREE.TSL;

  const uOrigin = uniform(vec2(0, 0));
  const uRadii = uniform(vec2(50, 50));
  const uRotationRad = uniform(float(0));
  const uMode = uniform(int(0));
  const uModifier = uniform(float(0));
  const uBaseDarkness01 = uniform(float(0));

  // Wrapped in Fn() — see `buildRegionRectangleMaterial`'s own header for
  // why: `discard()` called outside a build-time stack context is a silent
  // no-op (verified against source), which is what let every region mesh
  // paint its full, un-clipped bounding quad until this fix.
  const fragmentNode = Fn(() => {
    const rel = positionWorld.xy.sub(uOrigin);
    const cosR = cos(uRotationRad.negate());
    const sinR = sin(uRotationRad.negate());
    const lx = rel.x.mul(cosR).sub(rel.y.mul(sinR));
    const ly = rel.x.mul(sinR).add(rel.y.mul(cosR));
    const nx = lx.div(uRadii.x);
    const ny = ly.div(uRadii.y);
    const inside = nx.mul(nx).add(ny.mul(ny)).lessThanEqual(float(1));
    inside.not().discard();
    const color = computeRegionColor(THREE.TSL, { uMode, uModifier, uBaseDarkness01, uDaylightColor, uDarknessColor });
    return vec4(color, float(1));
  })();

  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.fragmentNode = fragmentNode;

  return { material, uOrigin, uRadii, uRotationRad, uMode, uModifier, uBaseDarkness01 };
}

/** Starting/default capacity, in polygon EDGES, for a region polygon's
 * fixed-capacity point uniformArray — same fixed-forever-after-setup
 * constraint as `point-light-illumination.js#MAX_LIGHT_EDGES`, same
 * truncate-gracefully contract. Regions are typically simple GM-drawn
 * shapes, not wall-clipped sweeps, so a smaller cap suffices. */
export const MAX_REGION_POLYGON_POINTS = 32;

/**
 * The point-in-polygon crossing test, TSL side — the SAME algorithm as
 * `pointInPolygon` above (and this module's own sibling, point-light-
 * illumination.js's SDF shader), minus the distance computation this use
 * case doesn't need. Wrapped in its own `Fn` for the same reason that
 * file's `makeSdPolygonEdgeDistance` is (verified `Loop`/`.toVar()`
 * discipline, this file's own header).
 *
 * @param {*} TSL
 * @returns {*} `Fn(([p, poly, edgeCount]) => insideBool)`.
 */
function makePointInPolygonFn(TSL) {
  const { Fn, Loop, select, bool, int } = TSL;
  return Fn(([p, poly, edgeCount]) => {
    const inside = bool(false).toVar();
    Loop(edgeCount, ({ i }) => {
      const j = select(i.equal(int(0)), edgeCount.sub(int(1)), i.sub(int(1)));
      const pi = poly.element(i);
      const pj = poly.element(j);
      const crossesY = pi.y.greaterThan(p.y).notEqual(pj.y.greaterThan(p.y));
      const xIntersect = pj.x.sub(pi.x).mul(p.y.sub(pi.y)).div(pj.y.sub(pi.y)).add(pi.x);
      const crosses = crossesY.and(p.x.lessThan(xIntersect));
      inside.assign(select(crosses, inside.not(), inside));
    });
    return inside;
  });
}

/**
 * The minimum UNSIGNED distance from a point to a polygon's boundary — the
 * TSL twin of `distanceToPolygonBoundary` (the CPU function above), and a
 * close sibling of `point-light-illumination.js#makeSdPolygonEdgeDistance`
 * (identical point-to-segment-clamp technique, identical `Loop`/`.toVar()`
 * discipline, verified against the vendored source the same way that
 * file's own header already documents) MINUS that function's own inside/
 * outside sign — `buildRegionEmanationPolygonMaterial` already gets "inside
 * the base polygon" from `makePointInPolygonFn` above, separately, so this
 * only needs the raw boundary distance to test against the growth radius.
 *
 * @param {*} TSL
 * @returns {*} `Fn(([p, poly, edgeCount]) => unsignedDistance)`.
 */
function makeUnsignedPolygonEdgeDistanceFn(TSL) {
  const { Fn, Loop, select, int, float, min, max, dot, sqrt } = TSL;
  return Fn(([p, poly, edgeCount]) => {
    const minDistSq = float(1e12).toVar();
    Loop(edgeCount, ({ i }) => {
      const j = select(i.equal(int(0)), edgeCount.sub(int(1)), i.sub(int(1)));
      const pi = poly.element(i);
      const pj = poly.element(j);
      const e = pj.sub(pi);
      const w = p.sub(pi);
      // Guard a zero-length edge the SAME way makeSdPolygonEdgeDistance
      // does — floor the denominator rather than trust a backend's NaN-
      // propagation-through-min behaviour to be well-defined.
      const eDotE = max(dot(e, e), float(1e-12));
      const t = min(float(1), max(float(0), dot(w, e).div(eDotE)));
      const closest = pi.add(e.mul(t));
      const diff = p.sub(closest);
      minDistSq.assign(min(minDistSq, dot(diff, diff)));
    });
    return sqrt(minDistSq);
  });
}

/**
 * Build ONE polygon-shaped darkness region's material — see
 * `buildRegionRectangleMaterial`'s own header for the shared design.
 * `points` is a FIXED-CAPACITY (`MAX_REGION_POLYGON_POINTS`) array of real
 * `THREE.Vector2` instances, returned for the caller to mutate in place
 * every time this region's polygon changes (mirrors point-light-
 * illumination.js's `edgePoints` contract exactly — a `uniformArray`'s size
 * is fixed forever after its first `setup()`).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uDaylightColor @param {*} args.uDarknessColor
 * @returns {{material: *, points: object[], uPointCount: *, uMode: *,
 *   uModifier: *, uBaseDarkness01: *}}
 */
export function buildRegionPolygonMaterial({ THREE, uDaylightColor, uDarknessColor }) {
  const { uniform, uniformArray, float, int, vec2, vec4, positionWorld, Fn } = THREE.TSL;

  const points = Array.from({ length: MAX_REGION_POLYGON_POINTS }, () => new THREE.Vector2(0, 0));
  const pointsUniform = uniformArray(points, 'vec2');
  const uPointCount = uniform(int(0));
  const uMode = uniform(int(0));
  const uModifier = uniform(float(0));
  const uBaseDarkness01 = uniform(float(0));

  const pointInPolygon = makePointInPolygonFn(THREE.TSL);
  // Wrapped in Fn() — see `buildRegionRectangleMaterial`'s own header for
  // why: `discard()` called outside a build-time stack context is a silent
  // no-op (verified against source), which is what let every region mesh
  // paint its full, un-clipped bounding quad until this fix. (`pointInPolygon`
  // itself was ALREADY correctly Fn-wrapped for its own `Loop`/`.toVar()` —
  // this fix is specifically about the outer `discard()` call, which was not.)
  const fragmentNode = Fn(() => {
    const p = vec2(positionWorld.x, positionWorld.y);
    const inside = pointInPolygon(p, pointsUniform, uPointCount);
    inside.not().discard();
    const color = computeRegionColor(THREE.TSL, { uMode, uModifier, uBaseDarkness01, uDaylightColor, uDarknessColor });
    return vec4(color, float(1));
  })();

  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.fragmentNode = fragmentNode;

  return { material, points, uPointCount, uMode, uModifier, uBaseDarkness01 };
}

/**
 * Build ONE cone-shaped ("round" curvature only — see `pointInCone`'s own
 * doc) darkness region's material — see `buildRegionRectangleMaterial`'s
 * own header for the shared design. `uHalfAngleRad`/`uRotationRad` are pre-
 * converted to RADIANS on the CPU side (matching this file's own existing
 * rectangle/ellipse convention — no degree math in the shader at all).
 *
 * The angular test uses `mod()`, verified against the vendored WGSL output
 * (`tsl_mod_float`, `three.webgpu.js`) as GLSL-style `x - y*floor(x/y)` —
 * ALWAYS non-negative for a positive divisor, unlike WGSL's native `%`
 * (which is C-style/truncating and would give the WRONG wraparound answer
 * for a negative numerator). This is why the wraparound formula below is a
 * SINGLE `mod`, not the JS twin's double-mod-plus-360 dance — GLSL-style
 * mod already normalizes correctly in one step. `atan(y, x)` is TSL's own
 * 2-argument form, verified to compile to `atan2` on WebGPU
 * (`base-lighting`... no — `three.webgpu.js`'s own `MathNode` codegen,
 * `method === MathNode.ATAN && b !== null` → `method = 'atan2'`), matching
 * `Math.atan2(dy,dx)`'s own argument order exactly.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uDaylightColor @param {*} args.uDarknessColor
 * @returns {{material: *, uOrigin: *, uRadius: *, uHalfAngleRad: *,
 *   uRotationRad: *, uFullCircle: *, uMode: *, uModifier: *, uBaseDarkness01: *}}
 */
export function buildRegionConeMaterial({ THREE, uDaylightColor, uDarknessColor }) {
  const { uniform, float, int, bool, vec2, vec4, mod, atan, positionWorld, Fn } = THREE.TSL;

  const uOrigin = uniform(vec2(0, 0));
  const uRadius = uniform(float(50));
  const uHalfAngleRad = uniform(float(Math.PI / 4));
  const uRotationRad = uniform(float(0));
  // A full-circle cone (authored angle >= 360deg) skips the angle test
  // entirely — mirrors pointInCone's own `angle >= 360` early return.
  const uFullCircle = uniform(bool(false));
  const uMode = uniform(int(0));
  const uModifier = uniform(float(0));
  const uBaseDarkness01 = uniform(float(0));

  // Wrapped in Fn() — see `buildRegionRectangleMaterial`'s own header for
  // why: `discard()` called outside a build-time stack context is a silent
  // no-op (verified against source), which is what let every region mesh
  // paint its full, un-clipped bounding quad until this fix.
  const fragmentNode = Fn(() => {
    const rel = positionWorld.xy.sub(uOrigin);
    const distSq = rel.x.mul(rel.x).add(rel.y.mul(rel.y));
    const withinRadius = distSq.lessThanEqual(uRadius.mul(uRadius));

    const TWO_PI = float(Math.PI * 2);
    const angleToPoint = atan(rel.y, rel.x);
    const diff = mod(angleToPoint.sub(uRotationRad).add(float(Math.PI)), TWO_PI).sub(float(Math.PI));
    const withinAngle = uFullCircle.or(diff.abs().lessThanEqual(uHalfAngleRad));
    // The apex (distSq≈0) belongs to every cone regardless of angle — same
    // guard as pointInCone's own explicit epsilon check.
    const atApex = distSq.lessThan(float(1e-6));

    const inside = withinRadius.and(atApex.or(withinAngle));
    inside.not().discard();
    const color = computeRegionColor(THREE.TSL, { uMode, uModifier, uBaseDarkness01, uDaylightColor, uDarknessColor });
    return vec4(color, float(1));
  })();

  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.fragmentNode = fragmentNode;

  return { material, uOrigin, uRadius, uHalfAngleRad, uRotationRad, uFullCircle, uMode, uModifier, uBaseDarkness01 };
}

/**
 * Build ONE ring-shaped darkness region's material — see
 * `buildRegionRectangleMaterial`'s own header for the shared design. NO
 * rotation uniform at all: Ring is always a full annulus (`pointInRing`'s
 * own doc — Ring overrides `_rotate()` as a no-op in Foundry's real source).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uDaylightColor @param {*} args.uDarknessColor
 * @returns {{material: *, uOrigin: *, uInnerRadius: *, uOuterRadius: *,
 *   uMode: *, uModifier: *, uBaseDarkness01: *}}
 */
export function buildRegionRingMaterial({ THREE, uDaylightColor, uDarknessColor }) {
  const { uniform, float, int, vec2, vec4, positionWorld, Fn } = THREE.TSL;

  const uOrigin = uniform(vec2(0, 0));
  const uInnerRadius = uniform(float(0));
  const uOuterRadius = uniform(float(50));
  const uMode = uniform(int(0));
  const uModifier = uniform(float(0));
  const uBaseDarkness01 = uniform(float(0));

  // Wrapped in Fn() — see `buildRegionRectangleMaterial`'s own header for
  // why: `discard()` called outside a build-time stack context is a silent
  // no-op (verified against source), which is what let every region mesh
  // paint its full, un-clipped bounding quad until this fix.
  const fragmentNode = Fn(() => {
    const rel = positionWorld.xy.sub(uOrigin);
    const dist = rel.length();
    const inside = dist.greaterThanEqual(uInnerRadius).and(dist.lessThanEqual(uOuterRadius));
    inside.not().discard();
    const color = computeRegionColor(THREE.TSL, { uMode, uModifier, uBaseDarkness01, uDaylightColor, uDarknessColor });
    return vec4(color, float(1));
  })();

  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.fragmentNode = fragmentNode;

  return { material, uOrigin, uInnerRadius, uOuterRadius, uMode, uModifier, uBaseDarkness01 };
}

/**
 * Build ONE line-shaped (a thick line segment) darkness region's material —
 * see `buildRegionRectangleMaterial`'s own header for the shared design.
 * SAME local-space un-rotation technique as rectangle/ellipse, but `uOrigin`
 * is the line's START endpoint (not its center) and the local box runs
 * `[0,length]` along the rotated X axis rather than being anchor-offset —
 * `pointInLine`'s own doc has the full geometric derivation.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uDaylightColor @param {*} args.uDarknessColor
 * @returns {{material: *, uOrigin: *, uLength: *, uWidth: *, uRotationRad: *,
 *   uMode: *, uModifier: *, uBaseDarkness01: *}}
 */
export function buildRegionLineMaterial({ THREE, uDaylightColor, uDarknessColor }) {
  const { uniform, float, int, vec2, vec4, cos, sin, positionWorld, Fn } = THREE.TSL;

  const uOrigin = uniform(vec2(0, 0));
  const uLength = uniform(float(100));
  const uWidth = uniform(float(20));
  const uRotationRad = uniform(float(0));
  const uMode = uniform(int(0));
  const uModifier = uniform(float(0));
  const uBaseDarkness01 = uniform(float(0));

  // Wrapped in Fn() — see `buildRegionRectangleMaterial`'s own header for
  // why: `discard()` called outside a build-time stack context is a silent
  // no-op (verified against source), which is what let every region mesh
  // paint its full, un-clipped bounding quad until this fix.
  const fragmentNode = Fn(() => {
    const rel = positionWorld.xy.sub(uOrigin);
    const cosR = cos(uRotationRad.negate());
    const sinR = sin(uRotationRad.negate());
    const lx = rel.x.mul(cosR).sub(rel.y.mul(sinR));
    const ly = rel.x.mul(sinR).add(rel.y.mul(cosR));
    const halfWidth = uWidth.div(float(2));
    const inside = lx
      .greaterThanEqual(float(0))
      .and(lx.lessThanEqual(uLength))
      .and(ly.greaterThanEqual(halfWidth.negate()))
      .and(ly.lessThanEqual(halfWidth));
    inside.not().discard();
    const color = computeRegionColor(THREE.TSL, { uMode, uModifier, uBaseDarkness01, uDaylightColor, uDarknessColor });
    return vec4(color, float(1));
  })();

  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.fragmentNode = fragmentNode;

  return { material, uOrigin, uLength, uWidth, uRotationRad, uMode, uModifier, uBaseDarkness01 };
}

/**
 * Build ONE rectangle-BASE emanation's material — the Minkowski-sum-with-a-
 * disk growth `pointInEmanation`'s own rectangle case does on the CPU,
 * expressed in TSL: inside the (ungrown) rect, OR within `uGrowRadius` of
 * its boundary. `uOrigin`/`uSize`/`uAnchor`/`uRotationRad` describe the BASE
 * rect exactly like `buildRegionRectangleMaterial`'s own uniforms; only the
 * extra `uGrowRadius` + boundary-distance term is new.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uDaylightColor @param {*} args.uDarknessColor
 * @returns {{material: *, uOrigin: *, uSize: *, uAnchor: *, uRotationRad: *,
 *   uGrowRadius: *, uMode: *, uModifier: *, uBaseDarkness01: *}}
 */
export function buildRegionEmanationRectangleMaterial({ THREE, uDaylightColor, uDarknessColor }) {
  const { uniform, float, int, vec2, vec4, cos, sin, clamp, positionWorld, Fn } = THREE.TSL;

  const uOrigin = uniform(vec2(0, 0));
  const uSize = uniform(vec2(100, 100));
  const uAnchor = uniform(vec2(0, 0));
  const uRotationRad = uniform(float(0));
  const uGrowRadius = uniform(float(0));
  const uMode = uniform(int(0));
  const uModifier = uniform(float(0));
  const uBaseDarkness01 = uniform(float(0));

  // Wrapped in Fn() — see `buildRegionRectangleMaterial`'s own header for
  // why: `discard()` called outside a build-time stack context is a silent
  // no-op (verified against source), which is what let every region mesh
  // paint its full, un-clipped bounding quad until this fix.
  const fragmentNode = Fn(() => {
    const rel = positionWorld.xy.sub(uOrigin);
    const cosR = cos(uRotationRad.negate());
    const sinR = sin(uRotationRad.negate());
    const lx = rel.x.mul(cosR).sub(rel.y.mul(sinR));
    const ly = rel.x.mul(sinR).add(rel.y.mul(cosR));
    const left = uAnchor.x.negate().mul(uSize.x);
    const top = uAnchor.y.negate().mul(uSize.y);
    const right = left.add(uSize.x);
    const bottom = top.add(uSize.y);

    const insideBase = lx
      .greaterThanEqual(left)
      .and(lx.lessThanEqual(right))
      .and(ly.greaterThanEqual(top))
      .and(ly.lessThanEqual(bottom));

    const nx = clamp(lx, left, right);
    const ny = clamp(ly, top, bottom);
    const distToBoundary = lx
      .sub(nx)
      .pow(float(2))
      .add(ly.sub(ny).pow(float(2)))
      .sqrt();

    const inside = insideBase.or(distToBoundary.lessThanEqual(uGrowRadius));
    inside.not().discard();
    const color = computeRegionColor(THREE.TSL, { uMode, uModifier, uBaseDarkness01, uDaylightColor, uDarknessColor });
    return vec4(color, float(1));
  })();

  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.fragmentNode = fragmentNode;

  return {
    material,
    uOrigin,
    uSize,
    uAnchor,
    uRotationRad,
    uGrowRadius,
    uMode,
    uModifier,
    uBaseDarkness01,
  };
}

/**
 * Build ONE polygon-BASE emanation's material — same Minkowski-sum growth
 * as the rectangle case above (inside the base polygon, OR within
 * `uGrowRadius` of its boundary), reusing this file's own `makePointIn
 * PolygonFn` for the "inside" half and a NEW `Loop`-based min-distance-to-
 * edge function (the same point-to-segment-clamp technique as `point-light-
 * illumination.js#makeSdPolygonEdgeDistance`, verified `Loop`/`.toVar()`
 * discipline, this file's own header) for the boundary-distance half.
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.uDaylightColor @param {*} args.uDarknessColor
 * @returns {{material: *, points: object[], uPointCount: *, uGrowRadius: *,
 *   uMode: *, uModifier: *, uBaseDarkness01: *}}
 */
export function buildRegionEmanationPolygonMaterial({ THREE, uDaylightColor, uDarknessColor }) {
  const { uniform, uniformArray, float, int, vec2, vec4, positionWorld, Fn } = THREE.TSL;

  const points = Array.from({ length: MAX_REGION_POLYGON_POINTS }, () => new THREE.Vector2(0, 0));
  const pointsUniform = uniformArray(points, 'vec2');
  const uPointCount = uniform(int(0));
  const uGrowRadius = uniform(float(0));
  const uMode = uniform(int(0));
  const uModifier = uniform(float(0));
  const uBaseDarkness01 = uniform(float(0));

  const pointInPolygon = makePointInPolygonFn(THREE.TSL);
  const distToPolygonBoundary = makeUnsignedPolygonEdgeDistanceFn(THREE.TSL);
  // Wrapped in Fn() — see `buildRegionRectangleMaterial`'s own header for
  // why: `discard()` called outside a build-time stack context is a silent
  // no-op (verified against source), which is what let every region mesh
  // paint its full, un-clipped bounding quad until this fix.
  const fragmentNode = Fn(() => {
    const p = vec2(positionWorld.x, positionWorld.y);
    const insideBase = pointInPolygon(p, pointsUniform, uPointCount);
    const dist = distToPolygonBoundary(p, pointsUniform, uPointCount);
    const inside = insideBase.or(dist.lessThanEqual(uGrowRadius));
    inside.not().discard();
    const color = computeRegionColor(THREE.TSL, { uMode, uModifier, uBaseDarkness01, uDaylightColor, uDarknessColor });
    return vec4(color, float(1));
  })();

  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.fragmentNode = fragmentNode;

  return { material, points, uPointCount, uGrowRadius, uMode, uModifier, uBaseDarkness01 };
}
