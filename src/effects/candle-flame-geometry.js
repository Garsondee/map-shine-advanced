/**
 * @fileoverview CANDLE FLAME — THE PURE HALF: colour parsing, per-anchor
 * override resolution, the light-source builder, anchor clustering, and the
 * batched flame billboard's vertex-array math. NONE of it touches THREE or
 * TSL, which is exactly why it carries the runtime's entire Node test suite
 * (`candle-flame-render.test.mjs`'s own header already said so before this
 * split existed as a file boundary) while the TSL material + THREE geometry
 * wrapper stay in `candle-flame-render.js`, browser-verified live.
 *
 * Split out on 2026-07-25 (the size-ratchet god-object reversal) — see that
 * file's header for the full "why a candle is not a particle" design and the
 * coordinate/Y-flip discipline both halves share.
 *
 * @module effects/candle-flame-geometry
 */

import { LIGHT_ELEVATION_UNCONFIGURED_SENTINEL } from './lighting/point-light-illumination.js';

/**
 * Parse a `#rrggbb` colour to linear-ish [r,g,b] in 0..1. Foundry stores light
 * colours as sRGB hex and its lighting shaders use them in gamma space (see
 * environmental-light.js's composite essay), so a straight byte→unit parse is
 * the right match — no decode. A malformed value falls back to a warm candle
 * orange rather than throwing (this feeds a render, never a stored value).
 * @param {string} hex @returns {[number, number, number]}
 */
export function hexToRgb01(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex ?? ''));
  if (!m) return [1, 0.667, 0];
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/**
 * ============================================================================
 * PER-CANDLE OVERRIDE RESOLUTION (2026-07-22, debug-panel FOH/ROH build)
 * ============================================================================
 * "Can we individually recolour candles?" — yes, plus size and light reach on
 * the author's own pick (scene/anchor-catalog.js's `useCustomX`/`customX`
 * pairs). These three pure functions are the SINGLE place "does this candle
 * override X, and to what" is decided — shared by the flame's per-vertex bake
 * (computeCandleFlameArrays) and the light-cluster grouping
 * (buildCandleLightSources) below, so the visible flame and the light it
 * casts can never disagree about a candle's own look. A `useCustomX` gate
 * (rather than a nullable value) exists because `core/params-schema.js` has
 * no "unset" sentinel — a colour must always be a valid #rrggbb — so
 * "inherit the shared value" has to be an explicit flag, never implied.
 */

/**
 * The EFFECTIVE flame/light colour (hex) for one candle anchor: its own
 * custom colour if it opted in, else the shared effect-wide colour every
 * un-customised candle uses.
 * @param {{params?: {useCustomColor?:boolean, customColor?:string}}} anchor
 * @param {string} globalColorHex
 * @returns {string}
 */
export function resolveAnchorColorHex(anchor, globalColorHex) {
  const p = anchor?.params;
  if (p?.useCustomColor === true && typeof p.customColor === 'string') return p.customColor;
  return typeof globalColorHex === 'string' ? globalColorHex : '#ffaa00';
}

/**
 * The EFFECTIVE flame size (px) for one candle anchor.
 * @param {{params?: {useCustomSize?:boolean, customSizePx?:number}}} anchor
 * @param {number} globalSizePx
 * @returns {number}
 */
export function resolveAnchorSizePx(anchor, globalSizePx) {
  const p = anchor?.params;
  const custom = Number(p?.customSizePx);
  if (p?.useCustomSize === true && Number.isFinite(custom) && custom > 0) return custom;
  const g = Number(globalSizePx);
  return Number.isFinite(g) && g > 0 ? g : 1;
}

/**
 * The EFFECTIVE light radius (px) for one candle anchor. 0 is a legitimate
 * override ("no light from just this one candle") — only a non-finite or
 * negative custom value falls back to the shared radius.
 * @param {{params?: {useCustomLightRadius?:boolean, customLightRadiusPx?:number}}} anchor
 * @param {number} globalLightRadiusPx
 * @returns {number}
 */
export function resolveAnchorLightRadiusPx(anchor, globalLightRadiusPx) {
  const p = anchor?.params;
  const custom = Number(p?.customLightRadiusPx);
  if (p?.useCustomLightRadius === true && Number.isFinite(custom) && custom >= 0) return custom;
  return Number(globalLightRadiusPx);
}

/**
 * This candle's ABSOLUTE world elevation (scene/Foundry units) — its own
 * floor's ground (`floorBinding.bottom`, already a real elevation value, not
 * an index: `scene/layer-order.js#resolveElevationFloorIndex` matches it
 * directly against `floor.elevationBottom`) plus its own authored `elevation`
 * param ("height off floor", `scene/anchor-catalog.js`, default 0). This is
 * the ONE number that lets a candle's cast light agree with its own flame
 * sprite about where it sits — see `point-light-pool.js#resolveAnchor
 * ElevationRank`'s doc for the flame's own (separate, OLD-gate) consumer of
 * the same `params.elevation` value.
 *
 * Returns `undefined` for an anchor with no locked floor band (`mode !==
 * 'locked'`, or a non-finite `bottom` — the 'all-levels'/unset case) — the
 * SAME opt-out posture `resolveAnchorElevationRank` already uses: an anchor
 * that never chose a floor has nothing real to add a height on top of, so it
 * stays unconfigured rather than silently resolving to a guess.
 * @param {{floorBinding?: {mode?:string, bottom?:number|null}, params?: {elevation?:number}}} anchor
 * @returns {number|undefined}
 */
export function resolveAnchorElevationWorldUnits(anchor) {
  const fb = anchor?.floorBinding;
  const bottom = Number(fb?.bottom);
  if (!fb || fb.mode !== 'locked' || !Number.isFinite(bottom)) return undefined;
  const h = Number(anchor?.params?.elevation);
  return bottom + (Number.isFinite(h) ? h : 0);
}

/**
 * A closed circular polygon around (cx, cy), as Foundry's own light shape format
 * (flat `[x0,y0,x1,y1,...]` world-space points) — the candle light's "shape",
 * standing in for the wall-clipped `source.shape.points` a real Foundry light
 * carries. No wall clipping in v1 (a candle just glows in a circle); walls
 * become a later rung the same way point-light-illumination.js's header frames
 * its own deferred rungs.
 * @param {number} cx @param {number} cy @param {number} radius @param {number} [segments]
 * @returns {number[]}
 */
export function candleCirclePolygon(cx, cy, radius, segments = CANDLE_LIGHT_SEGMENTS) {
  const n = Math.max(3, Math.floor(segments));
  const pts = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    const theta = (i / n) * Math.PI * 2;
    pts[i * 2] = cx + Math.cos(theta) * radius;
    pts[i * 2 + 1] = cy + Math.sin(theta) * radius;
  }
  return pts;
}

/**
 * A deterministic, position-derived pseudo-seed for a candle cluster's
 * flicker phase (light-animation-clock.js's own `computeAnimationTime`
 * consumes this the same way it consumes a real Foundry light's random
 * `animation.seed`) — same cluster position -> same seed every frame
 * (stable, no per-frame jitter of its own), different positions -> visibly
 * different phases (a room full of candles doesn't flicker in lockstep).
 * The exact classic GLSL-hash constants (`12.9898`/`78.233`/`43758.5453`)
 * don't matter for correctness here, only that the function is a stable,
 * well-mixed map from (x,y) to a value that LOOKS random — this is not a
 * cryptographic or even simulation-quality PRNG, just a phase offset.
 *
 * @param {number} x @param {number} y
 * @returns {number} a pseudo-random value, roughly in [0, 1000).
 */
export function deriveCandleSeed(x, y) {
  const raw = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return Math.abs(raw - Math.floor(raw)) * 1000;
}

/**
 * Map the candle `animationQuality` enum (candle-flame.js's param — `low`/
 * `standard`/`lavish`) to the integer tier candle-flicker.js's seed builders
 * gate on (0/1/2). Pure + total: an unknown/missing value falls back to the
 * richest tier (2), matching the param's own default — a corrupt stored value
 * shows the intended look, never a silent downgrade to the plainest one.
 *
 * @param {string} [name] - the resolved `animationQuality` param value.
 * @returns {number} 0 (low), 1 (standard), or 2 (lavish).
 */
export function candleAnimationQualityTier(name) {
  if (name === 'low') return 0;
  if (name === 'standard') return 1;
  return 2; // 'lavish' and any unknown/absent value → the default richest tier
}

/**
 * THE PERFORMANCE-TIER PLAN — one candle rung translated into the three knobs
 * that actually cost something. Pure, total, Node-tested; the effect's ladder
 * (candle-flame.js `CANDLE_FLAME.tiers`) is the prose, this is the arithmetic.
 *
 * ============================================================================
 * WHY CLUSTERING IS THE HEADLINE KNOB (measured 2026-07-29, not assumed)
 * ============================================================================
 *
 * A zone profile on a candle-heavy scene put `light.drawCandleFlame` — every
 * flame billboard in the scene — at **0.022 ms**, while `light.drawPointLights`
 * (6.57 ms) + `light.drawColoration` (6.54 ms) came to **13.1 ms of a 20.4 ms
 * frame, from 91 draw calls**; the effect sweep independently measured candles'
 * marginal cost at 13.15 ms, agreeing to 0.3%. **A candle costs what its LIGHT
 * costs — its flame is free**, because a `sizePx` 24 billboard covers ~576
 * world px² against a `lightRadiusPx` 400 (×1.25 boost ⇒ r=500) light's
 * ~785,000, drawn twice. Roughly 1,363× the area.
 *
 * So the lever that matters is the light COUNT, and the existing clustering
 * (candle-flame-geometry's own comment: "each light is a full Foundry-parity
 * mesh, so COUNT is what costs") is exactly the right dial. Cell size is
 * `radius × factor`, so a LARGER factor merges harder: quadrupling the factor
 * covers ~16× the area per cell.
 *
 * ⚠️ **TIER 3 REPRODUCES TODAY'S SHIPPED BEHAVIOUR EXACTLY** — flame quality 2,
 * light quality 2 (`lavish`), cluster factor 0.5 — and tier 3 is what the
 * DEFAULT profile (`standard`) resolves to. That is deliberate: turning this
 * system on must not silently restyle every existing scene. Below `standard`
 * the picture genuinely simplifies; at `extreme` it gets finer than it has ever
 * been. Nobody who never touches the setting sees any change at all.
 *
 * @param {number} tier - a resolved rung (effect-cascade.js#resolveEffectTier).
 *   Clamped into the ladder, so a stale or malformed value degrades to a rung
 *   that exists rather than producing an uncompilable quality.
 * @returns {{flameQuality: number, lightQuality: number, clusterFactor: number}}
 */
export function candleTierPlan(tier) {
  const n = Number.isFinite(tier)
    ? Math.max(0, Math.min(CANDLE_TIER_PLANS.length - 1, Math.floor(tier)))
    : CANDLE_DEFAULT_TIER;
  return CANDLE_TIER_PLANS[n];
}

/**
 * The rung an ABSENT or malformed tier falls back to — deliberately today's
 * shipped look, never the cheapest one.
 *
 * ⚠️ Both possible defaults are dangerous if the seam is ever left unwired, and
 * they fail in opposite directions: fall back to 0 and an unwired caller
 * silently downgrades every candle in the game; fall back to the top and a weak
 * machine silently gets the most expensive rung. This picks "today's look"
 * (matching `candleAnimationQualityTier`'s own stated choice — a corrupt stored
 * value shows the intended look, never a silent downgrade) and then defends the
 * seam with a TEST instead of a hope, because a default that is merely correct
 * is exactly how `feedback_seam_default_hides_unwired` happens: declared,
 * defaulted, consumed, never passed, renders perfectly, control dead, tests
 * green.
 *
 * It is NOT a hardcoded 3: the test suite asserts this equals what the DEFAULT
 * performance profile resolves the real candle ladder to, so re-tuning a rung's
 * `fromProfile` cannot leave this constant behind pointing at a different look.
 */
export const CANDLE_DEFAULT_TIER = 3;

/**
 * The rungs, as data, index === tier. Kept beside `candleTierPlan` so the table
 * and its clamp cannot disagree about how many rungs exist.
 *
 * `clusterFactor` is a multiplier on the light radius to get the merge cell:
 * 2.0 turns a room of candles into one or two pools; 0.25 is very nearly one
 * light per candle. `flameQuality` feeds `buildCandleFlameMaterial`'s
 * build-time `quality` (0 calm · 1 life+wind+gutter+snuff · 2 + domain warp);
 * `lightQuality` feeds candle-flicker.js's own ladder (0 single-octave ·
 * 1 two-octave + temperature shift · 2 breathing core + edge turbulence).
 * All three are graph-BUILD-time — Effects.md Law 4: a tier that is off must
 * never be constructed, because a uniform set to zero still executes.
 */
const CANDLE_TIER_PLANS = Object.freeze([
  Object.freeze({ flameQuality: 0, lightQuality: 0, clusterFactor: 2.0 }), // 0 ember
  Object.freeze({ flameQuality: 0, lightQuality: 1, clusterFactor: 1.5 }), // 1 flicker
  Object.freeze({ flameQuality: 1, lightQuality: 1, clusterFactor: 1.0 }), // 2 life
  Object.freeze({ flameQuality: 2, lightQuality: 2, clusterFactor: 0.5 }), // 3 boil — TODAY
  Object.freeze({ flameQuality: 2, lightQuality: 2, clusterFactor: 0.25 }), // 4 perCandle
]);

/**
 * Map a candle cluster's aggregate STRENGTH (Σ per-anchor intensity, jittered
 * per-position so identical imports still vary — see buildCandleLightSources)
 * to the point-light params that carry brightness/reach. PURE + total, Node-
 * tested — the actual perceptual tuning lives here, one place, in named
 * constants (author's asks: a single candle much dimmer than today, ≈4
 * candles about right, more candles brighter AND reaching a bit further).
 *
 * The reference point is STRENGTH_REF (≈4): at that strength the light lands
 * near "today's look" (neutral exposure, the old coloration alpha). A single
 * candle (strength ≈1) falls to roughly a quarter of that; a big candelabra
 * rises above it. `radius` also carries the flat +25% the inverse-square
 * falloff needs (RADIUS_BOOST — right next to the flame is bright, but it
 * drops off fast, so the pool must reach a little further to light the room).
 *
 * @param {number} strength - Σ intensity × per-position variance (≥ ~0).
 * @param {number} baseRadius - the effect's `lightRadiusPx` param (px).
 * @returns {{radius:number, luminosity01:number, alpha01:number}}
 */
export function candleClusterLightParams(strength, baseRadius) {
  const s = Number.isFinite(strength) && strength > 0 ? strength : 0.05;
  const r = Number.isFinite(baseRadius) && baseRadius > 0 ? baseRadius : 0;
  // Exposure: negative (dimmer than neutral) for a lone candle, ~0 at
  // STRENGTH_REF, positive (brighter) for a candelabra. luminosity01 =
  // (exposure+1)/2 (point-light-illumination.js#computeExposure's inverse).
  const exposure = clampNum(CANDLE_EXPO_PER_STRENGTH * (s - CANDLE_STRENGTH_REF), CANDLE_EXPO_MIN, CANDLE_EXPO_MAX);
  const luminosity01 = clampNum(0.5 + exposure / 2, 0.05, 1);
  // Coloration (warm-glow) strength scales linearly off the reference.
  const alpha01 = clampNum(CANDLE_ALPHA_BASE * (s / CANDLE_STRENGTH_REF), CANDLE_ALPHA_MIN, CANDLE_ALPHA_MAX);
  // Reach: the flat +25% (RADIUS_BOOST) plus a gentle sqrt growth with cluster
  // size, so a candelabra lights a bigger area without ballooning.
  const radiusFactor = clampNum(
    1 + CANDLE_RADIUS_PER_STRENGTH * (Math.sqrt(s) - 1),
    CANDLE_RADIUS_MIN_FACTOR,
    CANDLE_RADIUS_MAX_FACTOR
  );
  return { radius: r * CANDLE_RADIUS_BOOST * radiusFactor, luminosity01, alpha01 };
}

/** Clamp helper (pure) — kept local so candleClusterLightParams stays total. */
function clampNum(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Candle light character (Foundry-parity light params tuned for a candle).
 * A small bright core = a gentle pool, not a torch. Luminosity + coloration
 * strength are NO LONGER fixed — they scale per cluster with burn strength
 * (candleClusterLightParams), so a lone candle and a candelabra differ. */
const CANDLE_LIGHT_RATIO = 0.15; // bright/radius: a small hot centre
const CANDLE_LIGHT_ATTENUATION = 0.75; // band softness (falloff itself is now inverse-square)
const CANDLE_LIGHT_SEGMENTS = 32; // circle polygon smoothness (no walls in v1)

// ── Per-cluster STRENGTH → brightness/reach (candleClusterLightParams) ──────
const CANDLE_STRENGTH_REF = 4; // "≈ today's look" strength (author: about 4 candles)
const CANDLE_RADIUS_BOOST = 1.25; // flat +25% reach for the inverse-square falloff
const CANDLE_EXPO_PER_STRENGTH = 0.14; // exposure gained per unit strength past the ref
const CANDLE_EXPO_MIN = -0.55; // a lone candle's floor (dim, not out)
const CANDLE_EXPO_MAX = 0.7; // a big candelabra's ceiling (bright, not blown out)
const CANDLE_ALPHA_BASE = 0.85; // coloration (warm-glow) strength AT the reference
const CANDLE_ALPHA_MIN = 0.12;
const CANDLE_ALPHA_MAX = 1.6;
const CANDLE_RADIUS_PER_STRENGTH = 0.15; // gentle sqrt reach growth with cluster size
const CANDLE_RADIUS_MIN_FACTOR = 0.85;
const CANDLE_RADIUS_MAX_FACTOR = 1.6;
/** Cluster cell size, as a fraction of the light radius. Candles closer than
 * this merge into ONE light — a chandelier's 8 flames become one warm pool
 * instead of 8 overlapping full-cost lights (the perf lever: each light is a
 * full Foundry-parity mesh, so COUNT is what costs). Flames stay per-candle. */
// ⚠️ MOVED, not deleted (2026-07-29). The cluster factor used to be this one
// constant at 0.5; it is now PER TIER, in `CANDLE_TIER_PLANS` above, because it
// is the single biggest performance dial this effect has (measured: 13.1 ms of
// a 20.4 ms frame lives in the candle LIGHTS, ~0.02 ms in their flames). Tier 3
// still carries 0.5 exactly, and tier 3 is what the default profile resolves
// to, so the shipped look is unchanged. One value, one owner — leaving a stale
// duplicate here is how two authorities on one number start disagreeing.

/**
 * Build the point-light SOURCE descriptors for a set of candle anchors — the
 * "connection between candle points and a point light we control". Each is
 * shaped EXACTLY like the Foundry light descriptors the viewer's light-mesh
 * pool reconciles (`{ sourceId, x, y, radius, shapePoints, ratio,
 * attenuation01, luminosity01, hasColor, alpha01, color }`), so candle lights
 * flow through the identical material/pool/MAX-blend/dispose path — they are
 * simply authored by us instead of read from `canvas.effects.lightSources`.
 *
 * Pure (no THREE, no Foundry): Node-testable, and the viewer just merges the
 * result into its existing light list.
 *
 * @param {Array<{id:string, x:number, y:number}>} anchors - served candle anchors.
 * @param {{lightRadiusPx:number, colorHex:string}} params
 * @returns {Array<object>} light source descriptors.
 */
export function buildCandleLightSources(
  anchors,
  { lightRadiusPx, colorHex, animationQuality, windResponse, perfTier }
) {
  // THE PERFORMANCE TIER SETS THE BASELINE; AN EXPLICIT PARAM STILL WINS.
  // `animationQuality` defaults to `'auto'` = "follow the profile" (candle-flame.js).
  // Any other value is the author saying so out loud, and Effects.md Law 5 is
  // explicit that tier comes from measurements AND explicit settings — so a
  // scene pinned to `lavish` keeps its look on a Low machine rather than being
  // silently overruled by a global slider it never opted into.
  const plan = candleTierPlan(perfTier);
  const qualityTier =
    animationQuality === undefined || animationQuality === null || animationQuality === 'auto'
      ? plan.lightQuality
      : candleAnimationQualityTier(animationQuality);
  const list = Array.isArray(anchors) ? anchors : [];
  const globalRadius = Number(lightRadiusPx);

  // SPLIT (2026-07-22): an anchor with an ACTIVE colour or light-radius
  // override never merges into the shared cluster light below — colour has
  // no sensible average across a cluster (a recoloured candle blended into
  // its neighbours' pool would tint them too), and a custom reach is a
  // deliberate per-candle choice, not something to smooth away. An
  // un-customised candle keeps clustering exactly as before this feature
  // existed (same call, same inputs, same output — the "a scene nobody has
  // customised looks byte-identical" promise this codebase holds for every
  // per-effect override knob it adds).
  const plain = [];
  const overridden = [];
  for (const a of list) {
    const p = a?.params;
    if (p?.useCustomColor === true || p?.useCustomLightRadius === true) overridden.push(a);
    else plain.push(a);
  }

  const out = [];

  // THE ORIGINAL PATH, UNCHANGED IN SHAPE: radius 0 (or ≤0) is the author's
  // "a flame with no light" for every un-customised candle — emit no sources
  // for them, rather than silently substituting a default (the param help
  // promises this).
  if (globalRadius > 0 && plain.length) {
    const color = hexToRgb01(colorHex);
    // THE 13 ms LEVER (see candleTierPlan's header for the measurement). A
    // larger factor merges harder: cell AREA goes as the factor squared, so
    // tier 0's 2.0 covers 16× tier 3's 0.5 and collapses a candle-lit room into
    // one or two pools instead of dozens of full-cost Foundry-parity meshes.
    const clusters = clusterCandleAnchors(plain, globalRadius * plan.clusterFactor);
    for (const c of clusters) out.push(buildOneLightSource(c, globalRadius, color, qualityTier, windResponse));
  }

  // Each overridden candle gets its OWN accurate, never-merged light. Its
  // effective radius can legitimately resolve to 0 ("no light from just this
  // one"), which correctly contributes nothing — same rule as the plain path,
  // applied per-candle instead of effect-wide.
  for (const a of overridden) {
    const radius = resolveAnchorLightRadiusPx(a, lightRadiusPx);
    if (!(radius > 0)) continue;
    const color = hexToRgb01(resolveAnchorColorHex(a, colorHex));
    const [cluster] = clusterCandleAnchors([a], 1); // a 1-element list always yields exactly one (singleton) cluster
    if (cluster) out.push(buildOneLightSource(cluster, radius, color, qualityTier, windResponse));
  }

  return out;
}

/**
 * Build one light-source descriptor from a cluster centroid — the shape every
 * candle light takes, shared by the bulk-clustered path and the per-override
 * singleton path in `buildCandleLightSources` above so both produce IDENTICAL
 * descriptor shapes (only which centroid/radius/colour feeds in differs).
 * @param {{x:number,y:number,id:string,intensity:number,exposure:number}} c - a `clusterCandleAnchors` centroid.
 * @param {number} baseRadius - this cluster's OWN resolved light radius (px).
 * @param {[number,number,number]} color - this cluster's OWN resolved colour, linear-ish 0..1.
 * @param {number} qualityTier @param {number} windResponse
 * @returns {object}
 */
function buildOneLightSource(c, baseRadius, color, qualityTier, windResponse) {
  // Per-position variance so a scene of identical-intensity candles still has
  // a WIDER spread of brightnesses (author's ask), not a uniform field.
  // deriveCandleSeed(x,y) ∈ [0,1000) → a stable [0.7,1.3) multiplier.
  const variance = 0.7 + (deriveCandleSeed(c.x, c.y) / 1000) * 0.6;
  const strength = c.intensity * variance;
  const { radius, luminosity01, alpha01 } = candleClusterLightParams(strength, baseRadius);
  return {
    // Stable id from the sorted member ids (a rounded-centroid fallback for a
    // memberless cluster) → the viewer's light pool REUSES the mesh across
    // frames instead of rebuilding it.
    sourceId: `candle:${c.id || `${Math.round(c.x)}_${Math.round(c.y)}`}`,
    x: c.x,
    y: c.y,
    // THE LIGHT'S OWN DEPTH-AUTHORITY ELEVATION (2026-08-05) — a real
    // Foundry-unit height (`clusterCandleAnchors`'s own averaged `c.elevation`,
    // built from `boot.js#getCandleRenderState`'s `resolveAnchorElevation
    // WorldUnits`), consumed exactly like a real Foundry light's own
    // `document.elevation` (`point-light-pool.js#update`'s `resolveExpectedDepth
    // (light.elevation)`). Previously always `undefined` here, which normalized
    // to absolute elevation 0 regardless of which floor the candle was really
    // on — the bug this field exists to close.
    elevation: c.elevation,
    radius,
    // Sky exposure, averaged across the cluster's members (Wind.md Tier 0)
    // — so this light's OWN lean (candle-flicker.js) can sample the SAME
    // shared wind field the flames already do, at the SAME shelter level.
    windExposure: c.exposure,
    // The effect's own `windResponse` param (Wind.md §8.1) — carried onto
    // EVERY light descriptor so candle-flicker.js's lean/gutter/snuff read
    // the SAME gain the flame material does. Defaults to 1 (the tuned
    // reference) if the caller omits it — an older, not-yet-updated caller
    // still gets today's look, never a silently wind-deaf light.
    windResponse: Number.isFinite(windResponse) ? windResponse : 1,
    shapePoints: candleCirclePolygon(c.x, c.y, radius),
    ratio: CANDLE_LIGHT_RATIO,
    attenuation01: CANDLE_LIGHT_ATTENUATION,
    luminosity01,
    hasColor: true,
    alpha01,
    color,
    // Physical bright-centre/fast-drop-off falloff (author's ask) instead of
    // Foundry's attenuation corona — the scaffold branches on this at build
    // time (point-light-illumination.js#inverseSquareFalloff).
    falloffModel: 'inverseSquare',
    // ANIMATED BY DEFAULT (2026-07-20, author's own direction): candles
    // get MSA's own `candleFlicker` type — a distinct registry entry
    // from Foundry's `torch` (effects/lighting/animations/candle-
    // flicker.js's own header explains why: candle lights are meant to
    // keep evolving independently). `seed` is derived from this cluster's
    // OWN position (deriveCandleSeed below) rather than a shared `0` —
    // Foundry desyncs identical lights via a random per-source seed
    // (light-animation-clock.js's own header), and candles have no
    // natural "random at creation" moment the way a live Foundry source
    // does, so a stable, POSITION-DERIVED pseudo-seed is the deterministic
    // equivalent (same cluster -> same seed every frame, so its flicker
    // phase doesn't jump around; DIFFERENT clusters -> different phases,
    // so a room full of candles doesn't flicker in unison).
    animation: {
      type: 'candleFlicker',
      speedRaw: 5,
      intensityRaw: 5,
      reverse: false,
      seed: deriveCandleSeed(c.x, c.y),
      // The light-pool animation richness tier (candle-flicker.js's own
      // quality ladder) — a graph-BUILD-time integer, resolved once here
      // from the effect's `animationQuality` enum param. The viewer reads
      // it off `light.animation.quality` and bakes the matching node graph;
      // changing it live rebuilds the light's materials (vt-pan-viewer.js).
      quality: qualityTier,
    },
  };
}

/**
 * Grid-bucket candle anchors into clusters (the perf lever — see
 * CANDLE_LIGHT_CLUSTER_FACTOR). Deterministic (same anchors → same clusters, in
 * a stable order via the sorted-id key), O(N), so it is cheap to run per frame
 * and the resulting `sourceId`s are stable for pool reuse. Non-finite / id-less
 * anchors are dropped (the light pool never sees a bad source).
 *
 * @param {Array<{id?:string, x:number, y:number, windExposure?:number, elevation?:number}>} anchors
 * @param {number} cellPx - bucket size in world px (anchors within a cell merge).
 * @returns {Array<{x:number, y:number, count:number, id:string, exposure:number, elevation:number}>} cluster centroids.
 */
export function clusterCandleAnchors(anchors, cellPx) {
  const list = Array.isArray(anchors) ? anchors : [];
  const size = Number.isFinite(cellPx) && cellPx > 0 ? cellPx : 1;
  const cells = new Map();
  for (const a of list) {
    const x = Number(a?.x);
    const y = Number(a?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const key = `${Math.floor(x / size)}:${Math.floor(y / size)}`;
    let c = cells.get(key);
    if (!c) {
      c = { sumX: 0, sumY: 0, n: 0, ids: [], intensity: 0, sumExposure: 0, sumElevation: 0 };
      cells.set(key, c);
    }
    c.sumX += x;
    c.sumY += y;
    c.n++;
    // Per-anchor burn intensity (scene/anchor-catalog.js's `candleFlame` param,
    // 0..1, imported from a V2 group's emission.intensity) — SUMMED across the
    // cluster so a candelabra of N flames is genuinely N× the light of one
    // candle (the author's "combine lots of candles → brighter spaces"). A
    // memberless/param-less anchor counts as a full candle (intensity 1), so a
    // plain `{id,x,y}` still clusters correctly (Node tests, older callers).
    const intn = Number(a?.params?.intensity);
    c.intensity += Number.isFinite(intn) ? intn : 1;
    // Per-anchor sky exposure (boot.js's own `outdoors` sample — the raw
    // authored mask, NOT `skyReach`, a different rain-occlusion-specific
    // product; see boot.js#getCandleRenderState's own note — matching
    // computeCandleFlameArrays' identical "absent = fully outdoors" default),
    // AVERAGED across the cluster (Wind.md Tier 0) so the cluster's LIGHT
    // sways by the same shelter its FLAMES already do — one candle poking
    // out a window and three sheltered ones nets a partly-exposed cluster,
    // rather than either extreme winning outright.
    const exRaw = Number(a?.windExposure);
    c.sumExposure += Number.isFinite(exRaw) ? Math.min(1, Math.max(0, exRaw)) : 1;
    // Per-anchor absolute elevation (boot.js's own `resolveAnchorElevation
    // WorldUnits` — a real Foundry-unit height), AVERAGED across the cluster
    // — the same "net a partly-exposed cluster rather than either extreme
    // winning outright" reasoning as sky exposure just above, applied to
    // height instead of shelter. A candle whose own height must never be
    // blended into its neighbours' already has an escape hatch: opting into
    // `useCustomLightRadius`/`useCustomColor` pulls it into the singleton
    // per-candle light path below, which never averages anything.
    const elRaw = Number(a?.elevation);
    c.sumElevation += Number.isFinite(elRaw) ? elRaw : 0;
    if (typeof a.id === 'string') c.ids.push(a.id);
  }
  const out = [];
  for (const c of cells.values()) {
    out.push({
      x: c.sumX / c.n,
      y: c.sumY / c.n,
      count: c.n,
      id: c.ids.slice().sort().join(','),
      intensity: c.intensity,
      exposure: c.sumExposure / c.n,
      elevation: c.sumElevation / c.n,
    });
  }
  return out;
}

/**
 * Compute the batched flame billboard geometry arrays for a set of anchors —
 * ONE quad per candle, baked in world space. PURE (no THREE): the vertex math
 * is the testable part; `buildCandleFlameGeometry` is the thin THREE wrapper.
 *
 * Per candle at (cx, cy): a SQUARE quad CENTRED on the wick (the anchor sits at
 * uv 0.5,0.5). The flame's round base draws at that centre and the tail can
 * sweep out in ANY direction — so the quad must surround the wick, not extend
 * off it. Side = `sizePx`. This quad is intentionally dumb/static: the teardrop
 * footprint AND its wind lean are entirely the material's job off the uv
 * (`buildCandleFlameMaterial`), never a geometry rebuild — this just gives the
 * shader a canvas centred on the anchor.
 *
 * PER-CANDLE WIND ATTRIBUTES (2026-07-20) — `center` (the wick's world xy,
 * identical on all 4 verts of a quad so it reads as a constant across the
 * flame) and `windExposure` (the raw `outdoors` mask at the wick — NOT
 * `skyReach`, a different, rain-occlusion-specific product; see
 * boot.js#getCandleRenderState's own note — 1 = open to the sky/wind,
 * 0 = sheltered indoors) are baked in so the GPU wind (`sampleWind`) can
 * bend each flame independently WITHOUT any per-flame CPU work — the whole
 * point of a batched billboard. `center` is baked rather than derived from
 * `position - (uv-0.5)*size` so the shader needs no size uniform. See
 * `sampleWind` (world/wind-field.js — the SHARED field, see that module's own
 * header for why this used to be a private function here).
 *
 * PER-ANCHOR OVERRIDES (2026-07-22) — `sizePx`/`colorHex` here are the
 * EFFECT-WIDE fallbacks; each anchor's actual size/colour/brightness is
 * resolved per-candle via `resolveAnchorSizePx`/`resolveAnchorColorHex`
 * (size only moves this function's own per-quad half-extent, already
 * computed per-anchor in the loop below — free) and baked into two NEW
 * per-vertex attributes, `flameColor`/`flameIntensity` (brightness, from the
 * anchor's existing `intensity` param — previously captured but never
 * actually read by the flame's own emission, only by its light's strength).
 * A scene where no candle overrides anything bakes the SAME global colour
 * onto every vertex it always implicitly rendered with, so this is additive,
 * not a behaviour change for the common case.
 *
 * @param {Array<{x:number, y:number, windExposure?:number, params?:object, elevationRank?:number}>} anchors
 * @param {{sizePx:number, colorHex?:string}} opts
 * @returns {{positions: Float32Array, uvs: Float32Array, centers: Float32Array, exposures: Float32Array, colors: Float32Array, intensities: Float32Array, elevationRanks: Float32Array, indices: Uint32Array, quadCount: number}}
 */
export function computeCandleFlameArrays(anchors, { sizePx, colorHex } = {}) {
  const list = Array.isArray(anchors) ? anchors : [];
  const n = list.length;
  const positions = new Float32Array(n * 4 * 3);
  const uvs = new Float32Array(n * 4 * 2);
  const centers = new Float32Array(n * 4 * 2);
  const exposures = new Float32Array(n * 4);
  const colors = new Float32Array(n * 4 * 3);
  const intensities = new Float32Array(n * 4);
  // THE FLAME'S OWN HEIGHT-GATE INPUT (2026-08-03) — `boot.js#getCandleRender
  // State`'s `resolveAnchorElevationRank`, baked flat across all 4 verts of
  // this candle's quad, same shape as exposures/intensities above. Defaults
  // to the SENTINEL (never 0) when absent — a Node test building arrays by
  // hand, or any caller that predates this field, must get the OLD "always
  // fully reaches" behaviour, never a silently-introduced occlusion.
  const elevationRanks = new Float32Array(n * 4);
  const indices = new Uint32Array(n * 6);
  let quadCount = 0;
  for (let i = 0; i < n; i++) {
    const anchor = list[i];
    const cx = Number(anchor?.x);
    const cy = Number(anchor?.y);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue; // authority guarantees finite; belt-and-braces
    // Exposure defaults to 1 (fully outdoors) — the mask catalog's own "absent
    // = the whole floor is outdoors" semantics, so an un-sampled candle sways.
    const exRaw = Number(anchor?.windExposure);
    const ex = Number.isFinite(exRaw) ? Math.min(1, Math.max(0, exRaw)) : 1;
    const half = resolveAnchorSizePx(anchor, sizePx) / 2;
    const [cr, cg, cb] = hexToRgb01(resolveAnchorColorHex(anchor, colorHex));
    const intnRaw = Number(anchor?.params?.intensity);
    const intensity = Number.isFinite(intnRaw) ? Math.min(1, Math.max(0, intnRaw)) : 1;
    const rankRaw = Number(anchor?.elevationRank);
    const rank = Number.isFinite(rankRaw) ? rankRaw : LIGHT_ELEVATION_UNCONFIGURED_SENTINEL;
    const q = quadCount;
    const p = q * 12;
    const uvo = q * 8;
    const co = q * 8;
    const clo = q * 12; // colour: 4 verts * 3 floats, same stride shape as positions
    const so = q * 4; // scalar (1-per-vertex) offset — shared by exposures + intensities
    const io = q * 6;
    const base = q * 4;
    // A square CENTRED on the wick (cx, cy) → the anchor is at uv (0.5, 0.5).
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
    // uv: (0,0) at one corner … (1,1) at the opposite; wick at (0.5, 0.5).
    uvs[uvo + 0] = 0;
    uvs[uvo + 1] = 0;
    uvs[uvo + 2] = 1;
    uvs[uvo + 3] = 0;
    uvs[uvo + 4] = 1;
    uvs[uvo + 5] = 1;
    uvs[uvo + 6] = 0;
    uvs[uvo + 7] = 1;
    // center (wick world xy) + exposure + colour + intensity — the SAME on
    // all 4 verts of this quad (a flat per-candle value, piggybacking on the
    // per-vertex attribute mechanism the batched draw already requires).
    for (let v = 0; v < 4; v++) {
      centers[co + v * 2] = cx;
      centers[co + v * 2 + 1] = cy;
      exposures[so + v] = ex;
      intensities[so + v] = intensity;
      elevationRanks[so + v] = rank;
      colors[clo + v * 3 + 0] = cr;
      colors[clo + v * 3 + 1] = cg;
      colors[clo + v * 3 + 2] = cb;
    }
    indices[io + 0] = base + 0;
    indices[io + 1] = base + 1;
    indices[io + 2] = base + 2;
    indices[io + 3] = base + 0;
    indices[io + 4] = base + 2;
    indices[io + 5] = base + 3;
    quadCount++;
  }
  return { positions, uvs, centers, exposures, colors, intensities, elevationRanks, indices, quadCount };
}
