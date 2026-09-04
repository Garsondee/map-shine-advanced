/**
 * THE WIND FIELD DEBUG OVERLAY — the pure half. "A way to visualise the
 * field early on" (author, 2026-07-21): a live grid of arrows drawn over the
 * map, each reading the EXACT SAME wind handle (`world/wind-access.js`) the
 * candle flame and candle light read — so what you SEE here is provably the
 * same field driving the candles, not a second, illustrative approximation of
 * it (the very divergence Wind.md Tier 0 exists to kill).
 *
 * That guarantee used to rest on this file forwarding four separate arguments
 * (`ambientWind`/`bakedField`/`wallAvoidField`/`liveField`) exactly the way
 * three other call sites did. It didn't hold: this overlay is bug #2 in
 * `world/wind-access.js`'s own header — it kept a stale material across a
 * rebake and showed the startup bake's walls forever. Now there is ONE object
 * to pass, and a `version` on it that says when to rebuild (Wind.md §5.1).
 *
 * PURE GRID MATH ONLY. The THREE-touching arrow mesh + TSL material (the
 * live half) lives in `vt/vt-pan-viewer.js`, mirroring candle-flame-
 * render.js's own split (pure geometry math here, Node-tested; THREE/TSL
 * glue browser-verified live — CONVENTIONS §4).
 *
 * @module diag/wind-field-overlay
 */

/** A ceiling, not a target — high enough that the 1x-4x resolution lever
 * (Wind.md's own resolution knob, previewed here) has real room to run
 * before the cap-growth safety net kicks in and coarsens it back down. A
 * few thousand cheap additive quads is nothing for a modern GPU; this only
 * exists to protect an extreme zoomed-out view over a huge map. */
export const DEFAULT_WIND_OVERLAY_MAX_POINTS = 4000;

/**
 * Lay out a grid of sample points across a world-space rect, growing the
 * spacing (never truncating the grid into one corner) until the point count
 * fits `maxPoints` — so a huge view still gets a FULL, evenly-covered grid,
 * just a coarser one, rather than a silently-partial one (the "no silent
 * caps" rule: `capped` is returned so a caller can say so, never hide it).
 *
 * PINNED TO A FIXED WORLD LATTICE (2026-07-21, author-reported: "zooming in
 * and out doesn't move the grid in a way that seems pinned to the actual
 * map"). The earlier version centred the grid inside whatever rect it was
 * asked about — recomputing a fresh anchor point on every rebuild, so the
 * SAME world position landed at a different offset each time the view
 * changed, and the pattern visibly swam under pan/zoom. This version instead
 * snaps every point to an integer multiple of `spacingPx` measured from
 * world (0,0) — Foundry's own grid origin — so a given world position is
 * EITHER always a lattice point at a given spacing, or never one; panning
 * and zooming only changes which subset of that one fixed lattice is
 * currently in view, never the lattice itself. (Growing `spacingPx` to
 * satisfy the cap DOES change the lattice — a coarser spacing is a genuinely
 * different, coarser grid, the same way a mipmap LOD change is not a "swim".)
 *
 * @param {object} args
 * @param {number} args.minX @param {number} args.minY
 * @param {number} args.maxX @param {number} args.maxY - a world-space rect
 *   (e.g. the current camera view — `vt/view-state.js#viewToWorldRect`).
 * @param {number} [args.spacingPx=150] - desired spacing, world px. Pass the
 *   scene's own `gridSizePixels` (optionally divided by a resolution
 *   multiplier) to pin the arrows to the map's actual grid squares.
 * @param {number} [args.maxPoints] - a hard cap on point count.
 * @returns {{points: Array<{x:number,y:number}>, spacingPx: number, capped: boolean}}
 */
export function computeWindOverlayGrid({
  minX,
  minY,
  maxX,
  maxY,
  spacingPx = 150,
  maxPoints = DEFAULT_WIND_OVERLAY_MAX_POINTS,
}) {
  const w = Number(maxX) - Number(minX);
  const h = Number(maxY) - Number(minY);
  if (!(Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0)) {
    return { points: [], spacingPx: 0, capped: false };
  }
  let spacing = Number.isFinite(spacingPx) && spacingPx > 0 ? spacingPx : 150;
  const cap = Number.isFinite(maxPoints) && maxPoints > 0 ? Math.floor(maxPoints) : DEFAULT_WIND_OVERLAY_MAX_POINTS;

  const lo = Number(minX);
  const loY = Number(minY);
  const hi = Number(maxX);
  const hiY = Number(maxY);
  let colStart = Math.floor(lo / spacing);
  let colEnd = Math.ceil(hi / spacing);
  let rowStart = Math.floor(loY / spacing);
  let rowEnd = Math.ceil(hiY / spacing);
  let cols = colEnd - colStart + 1;
  let rows = rowEnd - rowStart + 1;
  let capped = false;
  // Grow spacing (never drop points from an otherwise-fixed lattice) until
  // the total fits. Bounded iteration count — a pathological input converges
  // in a handful of steps (each grows the spacing 15%), never an infinite loop.
  for (let guard = 0; cols * rows > cap && guard < 200; guard++) {
    spacing *= 1.15;
    colStart = Math.floor(lo / spacing);
    colEnd = Math.ceil(hi / spacing);
    rowStart = Math.floor(loY / spacing);
    rowEnd = Math.ceil(hiY / spacing);
    cols = colEnd - colStart + 1;
    rows = rowEnd - rowStart + 1;
    capped = true;
  }
  const points = [];
  for (let r = rowStart; r <= rowEnd; r++) {
    for (let c = colStart; c <= colEnd; c++) {
      points.push({ x: c * spacing, y: r * spacing });
    }
  }
  return { points, spacingPx: spacing, capped };
}

/**
 * Lay out grid points at the REAL bake grid's own cell centers — the actual
 * `windOpennessGrid` cols/rows/cellSize/origin `bakeWindField` computed —
 * instead of `computeWindOverlayGrid`'s independent world-lattice (2026-07-23,
 * author: "make the overlay show the exact resolution accurately. I want to
 * be able to picture it accurately"). The OLD lattice's own "grow spacing
 * until point count fits maxPoints" (that function's own loop) silently
 * COARSENED the displayed density at a zoomed-out view with no signal that
 * anything had happened — the arrows/heatmap cells you saw at that point no
 * longer corresponded to any real computed cell at all, just an
 * independently-regenerated grid at whatever spacing happened to fit. This
 * version can't drift from the truth the same way: every returned point IS a
 * real bake cell's center (`col`/`row` included on each point for a caller
 * that wants them), and the ONLY coarsening available is `stride` — skip
 * every Nth real cell, evenly, in both axes — an HONEST "lower LOD", the same
 * mipmap-style degrade this file's OWN prior header already argued for
 * (`computeWindOverlayGrid`'s "Growing spacingPx... is a genuinely different,
 * coarser grid, the same way a mipmap LOD change is not a swim"), just
 * grounded in the real grid instead of a recomputed one. When the visible
 * area's own cell count already fits under `maxPoints` at `stride=1` (the
 * common case once reasonably zoomed in — this is a map-authoring tool, not
 * a flight simulator), the result is EXACTLY the real simulation grid, zero
 * discrepancy, by construction.
 *
 * @param {object} args
 * @param {number} args.cols @param {number} args.rows @param {number} args.cellSize
 * @param {number} args.originX @param {number} args.originY - the SAME fields
 *   `windOpennessGrid`/`bakeWindField`'s own grid spec carries.
 * @param {number} args.minX @param {number} args.minY
 * @param {number} args.maxX @param {number} args.maxY - the world-space rect
 *   to cover (already clamped to the scene's own bounds by the caller — see
 *   `vt/view-state.js#clampRectToBounds` — this function does not know or
 *   care where that rect came from).
 * @param {number} [args.stride=1] - a caller-requested MINIMUM stride (the
 *   repurposed `windOverlayResolution` knob — "show every Nth real cell",
 *   never finer than 1, since a real bake cell is already the finest truth
 *   there is to show).
 * @param {number} [args.maxPoints] - a hard cap on point count; `stride`
 *   grows further (never shrinks below the caller's own request) until the
 *   count fits.
 * @returns {{points: Array<{x:number,y:number,col:number,row:number}>, spacingPx: number, stride: number, capped: boolean}}
 */
export function computeWindOverlayGridFromBake({
  cols,
  rows,
  cellSize,
  originX,
  originY,
  minX,
  minY,
  maxX,
  maxY,
  stride = 1,
  maxPoints = DEFAULT_WIND_OVERLAY_MAX_POINTS,
}) {
  const empty = (spacingPx) => ({ points: [], spacingPx, stride: Math.max(1, Math.round(stride) || 1), capped: false });
  if (
    !(
      Number.isFinite(cols) &&
      cols > 0 &&
      Number.isFinite(rows) &&
      rows > 0 &&
      Number.isFinite(cellSize) &&
      cellSize > 0
    )
  ) {
    return empty(0);
  }
  const w = Number(maxX) - Number(minX);
  const h = Number(maxY) - Number(minY);
  if (!(Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0)) return empty(cellSize);

  const colLo = Math.max(0, Math.floor((Number(minX) - originX) / cellSize));
  const colHi = Math.min(cols - 1, Math.floor((Number(maxX) - originX) / cellSize));
  const rowLo = Math.max(0, Math.floor((Number(minY) - originY) / cellSize));
  const rowHi = Math.min(rows - 1, Math.floor((Number(maxY) - originY) / cellSize));
  if (colHi < colLo || rowHi < rowLo) return empty(cellSize);

  const cap = Number.isFinite(maxPoints) && maxPoints > 0 ? Math.floor(maxPoints) : DEFAULT_WIND_OVERLAY_MAX_POINTS;
  let s = Math.max(1, Math.round(stride) || 1);
  const countAt = (str) => Math.ceil((colHi - colLo + 1) / str) * Math.ceil((rowHi - rowLo + 1) / str);
  let capped = false;
  for (let guard = 0; countAt(s) > cap && guard < 64; guard++) {
    s += 1;
    capped = true;
  }

  const points = [];
  for (let row = rowLo; row <= rowHi; row += s) {
    for (let col = colLo; col <= colHi; col += s) {
      points.push({ x: originX + (col + 0.5) * cellSize, y: originY + (row + 0.5) * cellSize, col, row });
    }
  }
  return { points, spacingPx: cellSize * s, stride: s, capped };
}

/**
 * Compute the batched arrow billboard geometry arrays for a set of grid
 * points — ONE quad per point, baking `center` AND `windExposure` (the SAME
 * per-vertex trick candle-flame-render.js's `computeCandleFlameArrays`
 * already uses for its own anchors) so the material can sample `sampleWind`
 * per-quad with no per-point CPU work at DRAW time — the exposure sample
 * itself is real CPU work, but it happens ONCE per grid point when this
 * geometry is (re)built, not every frame.
 *
 * EXPOSURE (2026-07-21, author-reported: the overlay looked identically
 * turbulent indoors and outdoors) — `windExposure` on each point is
 * OPTIONAL, defaulting to 1 (fully outdoors) exactly like the candle
 * geometry's own "absent = the whole floor is outdoors" convention, so a
 * caller with no shelter sampler still renders (just without indoor/outdoor
 * contrast — the honest degrade this file's own header used to describe as
 * permanent; it is now the FALLBACK, not the only behaviour).
 *
 * @param {Array<{x:number, y:number, windExposure?:number}>} points
 * @param {{sizePx:number}} opts
 * @returns {{positions: Float32Array, uvs: Float32Array, centers: Float32Array, exposures: Float32Array, indices: Uint32Array, quadCount: number}}
 */
export function computeWindOverlayArrays(points, { sizePx }) {
  const list = Array.isArray(points) ? points : [];
  const n = list.length;
  const positions = new Float32Array(n * 4 * 3);
  const uvs = new Float32Array(n * 4 * 2);
  const centers = new Float32Array(n * 4 * 2);
  const exposures = new Float32Array(n * 4);
  const indices = new Uint32Array(n * 6);
  const half = (Number.isFinite(sizePx) && sizePx > 0 ? sizePx : 1) / 2;
  let quadCount = 0;
  for (let i = 0; i < n; i++) {
    const cx = Number(list[i]?.x);
    const cy = Number(list[i]?.y);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
    const exRaw = Number(list[i]?.windExposure);
    const ex = Number.isFinite(exRaw) ? Math.min(1, Math.max(0, exRaw)) : 1;
    const q = quadCount;
    const p = q * 12;
    const uvo = q * 8;
    const co = q * 8;
    const eo = q * 4;
    const io = q * 6;
    const base = q * 4;
    positions[p + 0] = cx - half;
    positions[p + 1] = cy - half;
    positions[p + 2] = 0;
    positions[p + 3] = cx + half;
    positions[p + 4] = cy - half;
    positions[p + 5] = 0;
    positions[p + 6] = cx + half;
    positions[p + 7] = cy + half;
    positions[p + 8] = 0;
    positions[p + 9] = cx - half;
    positions[p + 10] = cy + half;
    positions[p + 11] = 0;
    uvs[uvo + 0] = 0;
    uvs[uvo + 1] = 0;
    uvs[uvo + 2] = 1;
    uvs[uvo + 3] = 0;
    uvs[uvo + 4] = 1;
    uvs[uvo + 5] = 1;
    uvs[uvo + 6] = 0;
    uvs[uvo + 7] = 1;
    for (let v = 0; v < 4; v++) {
      centers[co + v * 2] = cx;
      centers[co + v * 2 + 1] = cy;
      exposures[eo + v] = ex;
    }
    indices[io + 0] = base + 0;
    indices[io + 1] = base + 1;
    indices[io + 2] = base + 2;
    indices[io + 3] = base + 0;
    indices[io + 4] = base + 2;
    indices[io + 5] = base + 3;
    quadCount++;
  }
  return { positions, uvs, centers, exposures, indices, quadCount };
}

/**
 * Build (or fill) a THREE.BufferGeometry for the arrow billboards. Thin glue
 * — the math stays in `computeWindOverlayArrays` (Node-tested).
 * @param {*} THREE @param {Array<{x:number,y:number,windExposure?:number}>} points @param {{sizePx:number}} opts
 * @returns {{geometry: *, quadCount: number}}
 */
export function buildWindOverlayGeometry(THREE, points, opts) {
  const { positions, uvs, centers, exposures, indices, quadCount } = computeWindOverlayArrays(points, opts);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('center', new THREE.BufferAttribute(centers, 2));
  geometry.setAttribute('windExposure', new THREE.BufferAttribute(exposures, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setDrawRange(0, quadCount * 6);
  return { geometry, quadCount };
}

// ── THE ARROW SHAPE (2026-07-21 rewrite) — a real arrow, not the earlier
// round-cone "teardrop" borrowed from the candle flame. Author-reported: the
// flame-like shape read as ambiguous (confusable with an actual candle on
// screen) and didn't compare direction between neighbouring cells crisply.
// A thin, uniform SHAFT + a distinct triangular HEAD, tuned by eye exactly
// like every other look constant in this codebase. ─────────────────────────
const SHAFT_RADIUS = 0.028; // thin shaft — concise, not a blob
const HEAD_START_T = 0.6; // the arrowhead flare begins here (fraction along the spine)
const HEAD_MAX_RADIUS = 0.09; // the flare's widest point (a real "shoulder", not a gentle taper)
const TIP_RADIUS = 0.012; // the very tip — a sharp point
const EDGE_SOFT = 0.035; // silhouette antialiasing width
const ARROW_SCALE = 0.42; // how far a full-strength gust extends the tip
const ARROW_MAX_TIP_FRACTION = 0.46; // the tip never visually extends past this (quad half-extent is 0.5)
const CALM_EMISSION = 0.4; // brightness floor at zero wind (the shaft stays visible)
// SATURATION TELL — when the RAW magnitude exceeds the visual length clamp,
// this arrow is showing LESS than the true value; an instrument must say so
// rather than look identical to a merely-strong-but-unclamped arrow
// (feedback_instruments_must_not_lie) — blended toward white in proportion
// to how far over the cap the true reading is.
const SATURATE_GLOW = 0.4;

// THE BEND (author's own ask: "I want to be able to see the 2D swirls as
// air moves around") — a SECOND `sampleWind` call, at a real world position
// a short distance further along the SAME direction, so a genuinely
// non-uniform local flow visibly CURVES the glyph instead of a straight
// arrow silently hiding it. Only the midpoint sample's component
// PERPENDICULAR to the main direction drives the bend — agreement (parallel
// flow) means "no local curl here" and the shaft stays straight; a strong
// crosswise difference bends it. Clamped so a strong shear reads as a
// visible curve, never a shape-breaking squiggle.
const MID_SAMPLE_WORLD_OFFSET = 70; // world px — small next to the gust field's own ~600px scale
const BEND_SCALE = 0.6;
const BEND_MAX = 0.12; // quad-fraction cap on the midpoint's sideways displacement

// COLOUR BY MAGNITUDE — a real sequential ramp (calm → moderate → strong),
// not brightness alone, so strength reads at a glance the same way a
// wind-speed map's colour legend does.
const COOL_TINT = [0.32, 0.46, 0.78]; // calm — a cool slate blue
const MID_TINT = [0.95, 0.78, 0.22]; // moderate — amber
const HOT_TINT = [0.97, 0.24, 0.16]; // strong — hot red

/**
 * Project `p` onto the segment [a,b] — the same round-cone building block
 * candle-flame-render.js's own material uses, factored out here so a
 * TWO-segment (bent) spine can reuse it without duplicating the projection
 * math. `t` is clamped to [0,1] (0 at `a`, 1 at `b`).
 * @param {*} TSL @param {*} p @param {*} a @param {*} b
 * @returns {{t: *, closest: *}}
 */
function projectOnSegment(TSL, p, a, b) {
  const { dot, clamp, float, max } = TSL;
  const ab = b.sub(a);
  const t = clamp(dot(p.sub(a), ab).div(max(dot(ab, ab), float(1e-6))), float(0), float(1));
  return { t, closest: a.add(ab.mul(t)) };
}

/**
 * Build the arrow's TSL material — a thin shaft with a distinct triangular
 * head, bent by a second real-world sample so LOCAL curvature (shear, the
 * edge of a swirl) shows in the glyph itself, coloured by magnitude on a
 * calm→moderate→strong ramp, with an honest "clipped" tell when the true
 * reading exceeds what the shape can show. Additive + no depth test, so it
 * reads over the lit map regardless of scene darkness.
 *
 * @param {{THREE: *, uGlobalTimeMs: *, windHandle: object}} args -
 *   `uGlobalTimeMs` is the ONE shared clock uniform (core/frame-clock.js via
 *   the viewer) — REQUIRED (unlike the flame's optional fallback: this tool
 *   has no reason to exist without a live, moving field). `windHandle` is
 *   `world/wind-access.js#createWindHandle`'s product — the ambient bias, the
 *   baked openness, the wall-avoidance field and Tier 2's transient are all
 *   carried INSIDE it, so this tool can no longer show a field assembled
 *   differently from the one the candles read. That property used to depend on
 *   four arguments being forwarded identically here and at three other call
 *   sites; now it is structural. See Wind.md §5.1.
 * @returns {{material: *}}
 */
export function buildWindArrowMaterial({ THREE, uGlobalTimeMs, windHandle }) {
  const { uv, attribute, vec2, vec3, vec4, float, length, dot, clamp, smoothstep, mix, max, min, select } = THREE.TSL;

  const centerXY = attribute('center', 'vec2');
  // Real per-point exposure (2026-07-21) — baked per-vertex the SAME way the
  // (The per-vertex `windExposure` attribute this used to read is no longer
  // consumed: `sampleWind`'s organic term was its only consumer and was
  // deleted with the spectrum rewrite — mythica-machina-press#499. The
  // geometry still bakes it; retiring that is a small follow-up, not a
  // correctness issue.)
  const sampleAt = (pos) =>
    windHandle.node(THREE.TSL, {
      centerXY: pos,
      time: uGlobalTimeMs,
    });

  // THE PRIMARY SAMPLE — this cell's own anchor, the SAME field every other
  // consumer reads.
  const gust = sampleAt(centerXY);
  const rawTip = gust.mul(float(ARROW_SCALE));
  // A strong prevailing wind + baked correction (Tier 1) can exceed the
  // organic noise's old ~[-1,1] range by a wide margin — clamp the TIP
  // LENGTH (not the shape math) so a gale saturates the arrow at the quad's
  // edge instead of overshooting it into an unreadable blob.
  const rawLen = length(rawTip);
  const tip = rawTip.mul(min(float(1), float(ARROW_MAX_TIP_FRACTION).div(max(rawLen, float(1e-6)))));

  // THE BEND — see this file's own header for the full reasoning. `tipDir`
  // degrades safely to (0,0) when the primary sample is ~zero (a calm cell),
  // which zeroes the bend too — a resting dot never acquires a phantom curve.
  const tipDir = tip.div(max(length(tip), float(1e-6)));
  const midWorldPos = centerXY.add(tipDir.mul(float(MID_SAMPLE_WORLD_OFFSET)));
  const vMid = sampleAt(midWorldPos);
  const perpDir = vec2(tipDir.y.negate(), tipDir.x);
  const rawBend = dot(vMid.mul(float(ARROW_SCALE)), perpDir).mul(float(BEND_SCALE));
  const bendAmount = clamp(rawBend, float(-BEND_MAX), float(BEND_MAX));
  const bend = perpDir.mul(bendAmount);

  // THE BENT 2-SEGMENT SPINE: anchor -> mid (displaced sideways) -> tip.
  const p0 = vec2(0, 0);
  const p2 = tip;
  const p1 = tip.mul(float(0.5)).add(bend);

  const p = uv().sub(vec2(0.5, 0.5));
  const seg1 = projectOnSegment(THREE.TSL, p, p0, p1);
  const seg2 = projectOnSegment(THREE.TSL, p, p1, p2);
  const dist1 = length(p.sub(seg1.closest));
  const dist2 = length(p.sub(seg2.closest));
  const onSeg2 = dist2.lessThan(dist1);
  const distToSpine = min(dist1, dist2);
  // h: this fragment's position along the WHOLE spine (0 at the anchor, 1 at
  // the tip) — segment 1 covers [0,0.5], segment 2 covers [0.5,1].
  const h = select(onSeg2, seg2.t.mul(float(0.5)).add(float(0.5)), seg1.t.mul(float(0.5)));

  // RADIUS — thin shaft, then a sharp flare into the arrowhead, tapering to
  // a point at the very tip. A PIECEWISE taper (not one smooth curve) is
  // what makes this read as an ARROWHEAD, not a teardrop.
  const shaftToHead = smoothstep(float(HEAD_START_T - 0.06), float(HEAD_START_T), h);
  const headTaper = smoothstep(float(HEAD_START_T), float(1), h);
  const radiusAt = mix(mix(float(SHAFT_RADIUS), float(HEAD_MAX_RADIUS), shaftToHead), float(TIP_RADIUS), headTaper);
  const signed = distToSpine.sub(radiusAt);
  const inside = float(1).sub(smoothstep(float(-EDGE_SOFT), float(0), signed));

  // COLOUR — a real sequential ramp by magnitude (see this file's own
  // header), measured from the PRE-CLAMP length so a saturated arrow still
  // reads as genuinely "hot", not however long the visual clamp left it.
  const magnitude = clamp(rawLen.div(float(ARROW_MAX_TIP_FRACTION)), float(0), float(1));
  const cool = vec3(COOL_TINT[0], COOL_TINT[1], COOL_TINT[2]);
  const midTint = vec3(MID_TINT[0], MID_TINT[1], MID_TINT[2]);
  const hot = vec3(HOT_TINT[0], HOT_TINT[1], HOT_TINT[2]);
  const lowHalf = clamp(magnitude.mul(float(2)), float(0), float(1));
  const highHalf = clamp(magnitude.mul(float(2)).sub(float(1)), float(0), float(1));
  const rampColor = mix(mix(cool, midTint, lowHalf), hot, highHalf);
  // The clip tell — see SATURATE_GLOW's own doc.
  const overCap = clamp(rawLen.div(float(ARROW_MAX_TIP_FRACTION)).sub(float(1)), float(0), float(2));
  const colorOut = mix(rampColor, vec3(1, 1, 1), clamp(overCap.mul(float(SATURATE_GLOW)), float(0), float(0.85)));

  const emission = inside.mul(mix(float(CALM_EMISSION), float(1), magnitude));

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.fragmentNode = vec4(colorOut, emission);

  return { material };
}

// ── THE FORCE HEATMAP (2026-07-21, author's own ask: "each grid space
// coloured from blue to red in line with the force of the wind at that
// space... might help sell things"). The arrows already show DIRECTION (and
// tint themselves by strength); this fills each grid cell with a flat colour
// keyed purely to MAGNITUDE, so overall wind FORCE reads at a glance across
// the whole map the way a weather map's colour wash does — strong pockets pop
// red, calm ones sink to a faint blue, even where an individual arrow is too
// short to judge. Drawn UNDER the arrows (a translucent wash, normal alpha —
// NOT the arrows' additive blend), so the arrows stay crisp on top. ─────────
const HEAT_COLD = [0.12, 0.42, 0.95]; // calm — blue
const HEAT_MID = [0.93, 0.9, 0.5]; // moderate — a warm pale (keeps the blue→red ramp readable through the middle)
const HEAT_HOT = [0.96, 0.19, 0.12]; // strong — red
// HALVED (2026-07-21, author-reported: the wash read too strong) — from an
// initial 0.1/0.55 guess down to 0.05/0.275.
const HEAT_ALPHA_CALM = 0.05; // a barely-there wash where the air is still (never a solid blue floor)
const HEAT_ALPHA_STRONG = 0.275; // a clear, but still see-through, red where it's blowing hard

/**
 * Build the heatmap cell's TSL material — a flat translucent fill per grid
 * cell, coloured blue→red by the LOCAL wind magnitude (the length of the
 * SAME `sampleWind()` the arrows and candles read), its opacity rising with
 * force so calm cells nearly vanish and strong cells read boldly. Meant to be
 * drawn on FULL-cell quads (`buildWindOverlayGeometry` at `sizePx ≈ spacing`)
 * BENEATH the arrow mesh.
 *
 * Deliberately shares `ARROW_SCALE`/`ARROW_MAX_TIP_FRACTION` with the arrow
 * material so "full strength" means the SAME magnitude in both — an arrow
 * saturating its length cap and its cell going full-red are the same event,
 * never two different thresholds the eye has to reconcile.
 *
 * @param {{THREE: *, uGlobalTimeMs: *, windHandle: object}} args -
 *   identical inputs to {@link buildWindArrowMaterial} (same clock, same one
 *   wind handle — the arrows and the heatmap CANNOT show different fields,
 *   because there is only one object to read).
 * @returns {{material: *}}
 */
export function buildWindHeatmapMaterial({ THREE, uGlobalTimeMs, windHandle }) {
  const { attribute, vec3, vec4, float, length, clamp, mix } = THREE.TSL;

  const centerXY = attribute('center', 'vec2');
  const gust = windHandle.node(THREE.TSL, {
    centerXY,
    time: uGlobalTimeMs,
  });

  // The SAME magnitude measure the arrow uses (see this function's own doc for
  // why they must agree) — pre-clamp length, normalised by the arrow's own
  // visual-length cap, so 1.0 = "as strong as the arrow can show".
  const magnitude = clamp(length(gust.mul(float(ARROW_SCALE))).div(float(ARROW_MAX_TIP_FRACTION)), float(0), float(1));

  const cold = vec3(HEAT_COLD[0], HEAT_COLD[1], HEAT_COLD[2]);
  const midTint = vec3(HEAT_MID[0], HEAT_MID[1], HEAT_MID[2]);
  const hot = vec3(HEAT_HOT[0], HEAT_HOT[1], HEAT_HOT[2]);
  const lowHalf = clamp(magnitude.mul(float(2)), float(0), float(1));
  const highHalf = clamp(magnitude.mul(float(2)).sub(float(1)), float(0), float(1));
  const heatColor = mix(mix(cold, midTint, lowHalf), hot, highHalf);
  const alpha = mix(float(HEAT_ALPHA_CALM), float(HEAT_ALPHA_STRONG), magnitude);

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  // Normal alpha (NOT additive) — a heatmap is an opaque-ish wash you read the
  // colour OF, not light you add; additive would wash every cell toward white
  // and destroy the blue-to-red reading the author asked for.
  material.blending = THREE.NormalBlending;
  material.fragmentNode = vec4(heatColor, alpha);

  return { material };
}
