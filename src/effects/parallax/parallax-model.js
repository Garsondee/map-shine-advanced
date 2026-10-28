/**
 * PARALLAX — the pure half: how high each layer sits above (or below) the floor being viewed,
 * how far that pushes it on screen, and the arithmetic every consumer shares. No THREE, no
 * Foundry: every function here is Node-tested.
 *
 * THE MODEL. The viewer's camera is orthographic: every layer is drawn flat, at scale 1. The Table
 * (`effects/table/table-model.js`) already pretends there is a pinhole eye `eyeH` px above the view
 * centre. Take that eye seriously and a layer `h` px above the viewed floor's plane lands on screen
 *
 *     p' = eye + (p − eye) · s,   s = eyeH / (eyeH − h)
 *
 * — outward when it is higher (a canopy, a roof, the floor above), inward when it is lower (the
 * floors beneath). The viewed floor is `h = 0`, so `s = 1` and it never moves: the grid, the
 * tokens and Foundry's own picking stay exact. Everything else slides against it as the view pans
 * (the eye follows the view centre), which is the depth cue.
 *
 * ONE SCALAR, THE VIEW HEIGHT. A layer's height is `(its elevation − viewElevation) · pxPerUnit`.
 * `viewElevation` is a plain number, so a floor change is just that number gliding from one floor's
 * base to the next: the old floor recedes, the new one settles into place, the table rim rises or
 * sinks — with no transition-specific drawing at all.
 *
 * @module effects/parallax/parallax-model
 */

import { tableEyeHeight } from '../table/table-model.js';

/** Elevation units a floor spans when the scene gives no usable band (Foundry's default level height). */
export const FALLBACK_FLOOR_SPAN = 10;

/**
 * The elevation each floor's plane sits at, one number per floor, in floor order. A floor with a
 * finite `elevationBottom` uses it; one without (the lowest level often has none) continues from the
 * floor below it, one span up — so the ladder is always strictly increasing and finite.
 *
 * @param {Array<{index:number, elevationBottom?:number|null, elevationTop?:number|null}>} floors
 * @returns {{ base: number[], span: number }} `base[i]` is floor `i`'s plane; `span` is the typical floor height.
 */
export function floorLadder(floors) {
  const list = Array.isArray(floors) ? floors : [];
  const spans = [];
  for (const f of list) {
    const b = f?.elevationBottom;
    const t = f?.elevationTop;
    if (Number.isFinite(b) && Number.isFinite(t) && t > b) spans.push(t - b);
  }
  spans.sort((a, b) => a - b);
  const span = spans.length ? spans[spans.length >> 1] : FALLBACK_FLOOR_SPAN;
  const base = [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i]?.elevationBottom;
    let v = Number.isFinite(b) ? b : i === 0 ? 0 : base[i - 1] + span;
    // Never let two floors share a plane (or run backwards): the table needs a real ladder.
    if (i > 0 && !(v > base[i - 1])) v = base[i - 1] + span;
    base.push(v);
  }
  return { base, span };
}

/**
 * The elevation of the plane the camera is on, for a (possibly fractional) viewed floor.
 * Fractional values interpolate between neighbouring floors' planes (the transition glide);
 * values past either end extrapolate one span per floor so a transition never stalls at the end.
 *
 * @param {{base:number[], span:number}} ladder
 * @param {number} floorPos - 0-based floor position, fractional allowed.
 */
export function viewElevationAt(ladder, floorPos) {
  const n = ladder.base.length;
  if (n === 0) return 0;
  const f = Number.isFinite(floorPos) ? floorPos : 0;
  if (f <= 0) return ladder.base[0] + f * ladder.span;
  if (f >= n - 1) return ladder.base[n - 1] + (f - (n - 1)) * ladder.span;
  const i = Math.floor(f);
  const t = f - i;
  return ladder.base[i] + (ladder.base[i + 1] - ladder.base[i]) * t;
}

/**
 * Smoothly limit a signed height so no layer ever gets a scale beyond `maxScale` (or its
 * reciprocal below), however many floors a scene stacks. `tanh` is the identity for small heights
 * and monotonic everywhere, so the order of the layers never flips.
 *
 * @param {number} h
 * @param {number} up - the most a layer may rise, px.
 * @param {number} down - the most a layer may sink, px.
 */
export function softCapHeight(h, up, down) {
  if (!Number.isFinite(h)) return 0;
  if (h >= 0) return up > 0 ? up * Math.tanh(h / up) : 0;
  return down > 0 ? -down * Math.tanh(-h / down) : 0;
}

/**
 * The scale of a layer `h` px above the viewed plane, for an eye `eyeH` px up. `h = 0` is exactly 1.
 * @param {number} h @param {number} eyeH
 */
export function parallaxScale(h, eyeH) {
  if (!(eyeH > 0)) return 1;
  const d = eyeH - h;
  return d > eyeH * 0.25 ? eyeH / d : 4;
}

/**
 * Where a point goes: scaled about the eye.
 * @param {{x:number,y:number}} p @param {{x:number,y:number}} eye @param {number} s
 */
export function displacePoint(p, eye, s) {
  return { x: eye.x + (p.x - eye.x) * s, y: eye.y + (p.y - eye.y) * s };
}

/**
 * A scaled-about-the-eye quad is another quad: new centre, new size. Exactly what the viewer's
 * unit-plane meshes need, with no change to their shaders.
 * @param {{x:number,y:number}} pos - the mesh's own position.
 * @param {{x:number,y:number}} size - the mesh's own scale.
 */
export function displaceQuad(pos, size, eye, s) {
  const c = displacePoint(pos, eye, s);
  return { x: c.x, y: c.y, sx: size.x * s, sy: size.y * s };
}

/**
 * The inverse of `displacePoint`: the point of a layer's own plane that lands on screen point `p`.
 * What a screen-space lookup needs to find the world position BEHIND a displaced pixel.
 * @param {{x:number,y:number}} p @param {{x:number,y:number}} eye @param {number} s
 */
export function undisplacePoint(p, eye, s) {
  const k = s > 1e-6 ? 1 / s : 1;
  return { x: eye.x + (p.x - eye.x) * k, y: eye.y + (p.y - eye.y) * k };
}

/**
 * The share of the Table's edge shadow (its board AO) a layer `h` px above the viewed plane keeps:
 * all of it on the floor and below, falling in a straight line to `treeShade` at the canopy's height
 * `refH`, and no lower above it. A raised layer stands up out of the crease the brass makes, so it
 * sits in less of its shadow (the author, 2026-10-28: *"until trees only get 15% of the AO strength"*).
 * @param {number} h @param {number} refH @param {number} treeShade - 0..1.
 */
export function raisedEdgeShade(h, refH, treeShade) {
  if (!(h > 0) || !(refH > 0)) return 1;
  return 1 - (1 - treeShade) * Math.min(1, h / refH);
}

/**
 * THE EDGE-SHADOW LADDER. The Table's edge shadow is one blended mesh drawn after everything, so it
 * darkens whatever is on top at each pixel by the same amount. To shade a raised layer less, the
 * shadow is split into steps drawn BETWEEN the layers: a pixel whose top layer is in band `j` is
 * darkened only by the steps drawn after it, and they multiply out to exactly that band's share:
 *
 *     ∏ (1 − occ·fⱼ)/(1 − occ·fⱼ₊₁)  ×  (1 − occ·f_last)  =  1 − occ·fⱼ
 *
 * Painter's order means a layer drawn later can never keep MORE shadow than one drawn before it, so
 * the shares are taken as a running minimum along the draw order, then rounded to `maxSteps` bands
 * between 1 and `treeShade` (the tallest canopy lands on `treeShade` exactly).
 *
 * @param {Array<{order:number, shade:number}>} layers - each drawn layer's `renderOrder` and share.
 * @param {number} treeShade - the least share (0..1); 1 needs no ladder.
 * @param {number} [maxSteps]
 * @returns {{ steps: Array<{order:number, from:number, to:number}>, last:number }} each step is drawn
 *   at `order` and hands the layers after it from share `from` down to `to`; `last` is the share the
 *   final (whole-frame) shadow applies.
 */
export function edgeShadeLadder(layers, treeShade, maxSteps = 3) {
  const lo = Math.min(1, Math.max(0, Number.isFinite(treeShade) ? treeShade : 1));
  if (!(lo < 1) || !Array.isArray(layers) || layers.length === 0) return { steps: [], last: 1 };
  const span = 1 - lo;
  const level = (b) => 1 - (span * b) / maxSteps;
  const sorted = layers
    .filter((l) => l && Number.isFinite(l.order) && Number.isFinite(l.shade))
    .sort((a, b) => a.order - b.order);
  const steps = [];
  let band = 0;
  let prevOrder = -Infinity;
  for (const l of sorted) {
    const share = Math.min(1, Math.max(lo, l.shade));
    const b = Math.max(band, Math.round(((1 - share) / span) * maxSteps));
    if (b > band) {
      // Halfway to the previous layer, so the step sorts strictly between the two.
      const at =
        prevOrder < l.order ? (Number.isFinite(prevOrder) ? (prevOrder + l.order) / 2 : l.order - 0.5) : l.order;
      steps.push({ order: at, from: level(band), to: level(b) });
      band = b;
    }
    prevOrder = l.order;
  }
  return { steps, last: level(band) };
}

/**
 * Everything the subsystem needs for one frame, from the card's params and the view.
 *
 * Sizes are percentages of the board's shorter side (a table's recess is in proportion to its
 * board, whether that board is 20 squares or 120), like every Table size.
 *
 * @param {object} params - the card's resolved params (missing keys take `defaults`).
 * @param {object} defaults - the schema defaults.
 * @param {object} ctx
 * @param {Array} ctx.floors - the scene's floors (`getActiveSceneFloors`).
 * @param {number} ctx.floorPos - the viewed floor, 0-based, fractional while a transition glides.
 * @param {number} ctx.boardMinSidePx
 * @param {number} ctx.halfSpanPx - half the world height on screen.
 * @param {number} ctx.fovDeg - the Table's perspective, so the rim and the layers agree.
 * @param {number} [ctx.extraTopAbove] - how far above the highest floor's plane the tallest thing that
 *   is not a floor stands (the highest canopy), so the table top can clear it as well as the roofs.
 * @param {number} [ctx.canopyFt] - the tallest canopy's height above its own floor (feet): the layer
 *   the edge shadow fades to `treeEdgeShadow` at. Absent, the stack's top stands in for it.
 * @param {number} [ctx.tableTopPx] - the Table's own top height above the board, px, while the Table
 *   is on and the stack follows it. The stack is then FITTED to the frame: when the tallest layer would
 *   stand lower than the table top, every raised layer is lifted in proportion until the tallest one
 *   is exactly level with it (the author, 2026-10-28: the trees should reach *"the top of the brass
 *   element and not the side"*). A stack taller than the table instead deepens the recess, as before.
 */
export function resolveParallaxFrame(params, defaults, ctx) {
  const v = (k) => {
    const x = params?.[k];
    return x === undefined || x === null ? defaults[k] : x;
  };
  const side = Math.max(1, ctx.boardMinSidePx || 1000);
  const ladder = floorLadder(ctx.floors);
  const eyeH = tableEyeHeight(ctx.halfSpanPx, ctx.fovDeg);
  const strength = Math.max(0, v('strength'));
  const floorPx = (Math.max(0, v('floorHeightPct')) / 100) * side * strength;
  const pxPerUnit = floorPx / Math.max(1e-6, ladder.span);
  const maxScale = Math.max(1.001, v('maxScale'));
  const up = eyeH * (1 - 1 / maxScale);
  const down = eyeH * (maxScale - 1);
  const viewElev = viewElevationAt(ladder, ctx.floorPos);

  const n = ladder.base.length;
  const roof = n ? ladder.base[n - 1] + ladder.span : 0;
  const canopy = n && Number.isFinite(ctx.extraTopAbove) ? ladder.base[n - 1] + ctx.extraTopAbove : -Infinity;
  const topElev = Math.max(roof, canopy);
  const bottomElev = n ? ladder.base[0] : 0;

  const rawHeight = (elevation) => softCapHeight((elevation - viewElev) * pxPerUnit, up, down);
  // THE FIT: raised heights stretch (never shrink) so the tallest layer meets the table top exactly.
  // Only heights above the viewed plane: the floors beneath keep their depth, and the viewed floor stays 0.
  const naturalTop = Math.max(0, rawHeight(topElev));
  const fitTop = Number.isFinite(ctx.tableTopPx) && ctx.tableTopPx > 0 ? ctx.tableTopPx : 0;
  const lift = fitTop > 0 && naturalTop > 1e-6 && naturalTop < fitTop ? fitTop / naturalTop : 1;

  /** Height in px of a layer at `elevation` above the viewed plane (soft-capped, then fitted). */
  const heightOf = (elevation) => {
    const h = rawHeight(elevation);
    return h > 0 ? h * lift : h;
  };
  /** The on-screen scale of a layer at `elevation`. */
  const scaleOf = (elevation) => parallaxScale(heightOf(elevation), eyeH);
  const topHeight = Math.max(0, heightOf(topElev));
  const canopyH = Number.isFinite(ctx.canopyFt) ? heightOf(viewElev + ctx.canopyFt) : 0;
  const shadeRef = canopyH > 1e-6 ? canopyH : topHeight;
  const treeShade = Math.min(1, Math.max(0, v('treeEdgeShadow') ?? 1));
  return {
    enabled: strength > 0 && pxPerUnit > 0,
    eyeH,
    pxPerUnit,
    viewElev,
    ladder,
    heightOf,
    scaleOf,
    /** Px the highest floor's roof (or canopy) sits above the viewed plane — what the table top must clear. */
    topHeight,
    /** How much the raised heights were stretched to meet the table top (1 = not at all). */
    lift,
    /** The share of the Table's edge shadow a layer at `elevation` keeps (1 on the floor, `treeEdgeShadow` at canopy height). */
    edgeShadeOf: (elevation) => raisedEdgeShade(heightOf(elevation), shadeRef, treeShade),
    /** The share the tallest canopy keeps — the least any layer keeps. */
    treeShade,
    /** Px the lowest floor's plane sits below the viewed plane — how deep the recess must go. */
    bottomDepth: Math.max(0, -heightOf(bottomElev)),
    /** The scale of the lowest floor's plane — the smallest any layer gets, so the cull rect knows how far to reach. */
    lowestScale: scaleOf(bottomElev),
    /** The elevation of the top of floor `index` (the next floor's plane; one span up for the highest). */
    floorTop: (index) => {
      const i = Math.max(0, Math.min(n - 1, Number.isFinite(index) ? Math.round(index) : 0));
      return i + 1 < n ? ladder.base[i + 1] : (ladder.base[i] ?? 0) + ladder.span;
    },
    /** The elevation of floor `index`'s plane (the floor's own bottom, never a tile's). */
    floorBase: (index) =>
      ladder.base[Math.max(0, Math.min(n - 1, Number.isFinite(index) ? Math.round(index) : 0))] ?? 0,
  };
}

/** Smooth 0→1 ease for a floor change (zero slope at both ends, so it starts and settles softly). */
export function glideEase(t) {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/**
 * The viewed floor as a number that glides. Feed it the integer floor the viewer says it is on,
 * every frame; it returns the fractional floor to draw at. A change of target starts a glide from
 * wherever the number is NOW (so a second floor change mid-glide carries on smoothly instead of
 * snapping), over `durationSec`. Duration 0 snaps. The very first call adopts the target outright:
 * loading a scene is not a floor change.
 *
 * @returns {{ step(target:number, nowMs:number, durationSec:number): number, value(): number, active(): boolean, settle(target:number): void }}
 */
export function createFloorGlide() {
  let started = false;
  let target = 0;
  let from = 0;
  let value = 0;
  let t0 = 0;
  let durMs = 0;
  let moving = false;
  return {
    step(next, nowMs, durationSec) {
      const goal = Number.isFinite(next) ? next : 0;
      if (!started) {
        started = true;
        target = from = value = goal;
        return value;
      }
      if (goal !== target) {
        target = goal;
        from = value;
        t0 = nowMs;
        durMs = Math.max(0, durationSec) * 1000;
        moving = durMs > 0;
        if (!moving) value = goal;
      }
      if (moving) {
        const t = durMs > 0 ? (nowMs - t0) / durMs : 1;
        if (t >= 1) {
          value = target;
          moving = false;
        } else {
          value = from + (target - from) * glideEase(t);
        }
      }
      return value;
    },
    value: () => value,
    active: () => moving,
    /** Jump straight to `goal` with no glide (a scene change, a reload). */
    settle(goal) {
      started = true;
      target = from = value = Number.isFinite(goal) ? goal : 0;
      moving = false;
    },
  };
}
