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
 *     `foundry/scene-regions.js#deriveRegionDarknessAdjusters` for the read
 *     and `region-geometry.js#selectRegionsForViewedFloor` for the per-frame
 *     filter against the CURRENTLY VIEWED floor's own elevation band
 *     (`foundry/active-scene-source.js#getActiveSceneFloors`'s
 *     `elevationBottom`/`elevationTop`) and, since 2026-11-09, the Region's
 *     own `levels` against the viewed Level. A prior version of this comment
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

// The pure CPU geometry (point-in-shape tests, darkness math, shape/hole
// resolution) moved to ./region-geometry.js on 2026-07-25 (size-ratchet
// god-object reversal); this file keeps the TSL per-fragment material
// builders. DARKNESS_ADJUST_MODES is the one enum both halves share.
import { DARKNESS_ADJUST_MODES, REGION_EDGE_TOLERANCE } from './region-geometry.js';

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
 * ⚠️ THE SOFT EDGE (2026-11-04) CHANGED WHERE THESE MATERIALS DRAW. They no
 * longer write a colour into `buf:scene.illum`. They write the REGION FIELD
 * (region-geometry.js's "THE SOFT EDGE" has the why): a small world-space
 * texture, drawn hard and in the same brightest-last order as before, holding
 * per texel `(a·c, b·c, c)`, with coverage `c` and the region's darkness
 * written as `a + b·base`. The viewer then blurs it
 * (`buildRegionFieldBlurMaterial`) and lays it over the ambient fill
 * (`buildRegionFieldOverlayMaterial`). Step 3 above still holds, but what is
 * overwritten is a field texel, not a screen pixel.
 *
 * A hole shape draws with `uCoverage = 0`, so it writes `(0,0,0)`: no region
 * here, and the ambient fill shows through untouched (before this change a
 * hole repainted the plain day/night mix, which dropped a global-light raise
 * in the hole; now it keeps it).
 */

/**
 * The shared "this region's darkness, as field coefficients" tail —
 * identical across every shape kind, so built once and called from each.
 * `select`-chained rather than a real switch (TSL has no statement-level
 * switch): a direct mirror of region-geometry.js#regionFieldCoefficients,
 * which a Node test checks against `applyDarknessAdjustment` for all modes.
 *
 * @param {*} TSL @param {*} args
 * @returns {*} vec4(a·c, b·c, c, 1) for a fragment INSIDE the shape.
 */
function computeRegionField(TSL, { uMode, uModifier, uCoverage }) {
  const { float, int, vec4, select, clamp } = TSL;
  const m = clamp(uModifier, float(0), float(1));
  const isOverride = uMode.equal(int(DARKNESS_ADJUST_MODES.OVERRIDE));
  const isBrighten = uMode.equal(int(DARKNESS_ADJUST_MODES.BRIGHTEN));
  const isDarken = uMode.equal(int(DARKNESS_ADJUST_MODES.DARKEN));
  const a = select(isOverride.or(isDarken), m, float(0));
  const b = select(isOverride, float(0), select(isBrighten.or(isDarken), float(1).sub(m), float(1)));
  return vec4(a.mul(uCoverage), b.mul(uCoverage), uCoverage, float(1));
}

/**
 * The region field's empty state, `(0,0,0)`: drawn over the whole field first
 * on every bake. A draw, not a clear, the same way `pointLightMergedZeroQuad`
 * does it, so the bake never depends on the renderer's clear colour or on
 * `autoClearColor` (both belong to the frame around it).
 * @param {{THREE: *}} args
 * @returns {*} a NodeMaterial for a fullscreen quad.
 */
export function buildRegionFieldZeroMaterial({ THREE }) {
  const { vec4, float } = THREE.TSL;
  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.fragmentNode = vec4(float(0), float(0), float(0), float(1));
  return material;
}

/**
 * ONE separable Gaussian pass over the region field: 13 taps (`taps` each
 * side) one texel apart along `uStepUv`, sigma `uSigmaTexels`. The field's
 * texels are sized so sigma is about two texels (region-geometry.js#
 * planRegionField), so one-texel taps are dense enough to leave no contour
 * lines and need no jitter. Weights are worked out in the shader from the
 * sigma uniform, so a re-planned field never rebuilds this material; a sigma
 * near zero collapses the kernel to its centre tap, a pass-through.
 * @param {{THREE: *, inputTexture: *, uStepUv: *, uSigmaTexels: *, taps: number}} args
 * @returns {*} a NodeMaterial for a fullscreen quad.
 */
export function buildRegionFieldBlurMaterial({ THREE, inputTexture, uStepUv, uSigmaTexels, taps }) {
  const { texture, uv, float, vec4, exp, max } = THREE.TSL;
  const src = texture(inputTexture);
  const twoSigmaSq = max(uSigmaTexels.mul(uSigmaTexels).mul(2), float(1e-4));
  let sum = src.sample(uv()).rgb;
  let weightSum = float(1);
  for (let k = 1; k <= taps; k++) {
    const w = exp(float(-(k * k)).div(twoSigmaSq));
    const off = uStepUv.mul(k);
    sum = sum.add(
      src
        .sample(uv().add(off))
        .rgb.add(src.sample(uv().sub(off)).rgb)
        .mul(w)
    );
    weightSum = weightSum.add(w.mul(2));
  }
  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.fragmentNode = vec4(sum.div(weightSum), float(1));
  return material;
}

/**
 * The blurred region field laid over `buf:scene.illum`'s ambient fill. Drawn
 * as ONE world-space quad covering the field's own rect (so it rasterises
 * only where regions are, and through the same camera, TAA jitter included,
 * as everything else in the pass). Per pixel:
 *
 *   c        = coverage (0 outside every region, 1 well inside, a ramp at an edge)
 *   d·c      = a·c + b·c · base          (the region darkness, still premultiplied)
 *   colour·c = c · daylight + (darkness - daylight) · d·c
 *   out      = colour·c + illum · (1 - c)   (premultiplied "over", by blend state)
 *
 * At `c = 1` this is exactly the old opaque overwrite, `mix(daylight,
 * darkness, adjusted)`; at `c = 0` the ambient fill is left as it was.
 *
 * Field UV follows the convention every world buffer here uses: a texture
 * drawn by a camera framed with `computeCameraFrustum(rect)` is read at
 * `uv = (world - rect.min) / rect.size`, the inverse of the
 * `world = mix(rect.min, rect.max, uv())` the fog field's quads use.
 *
 * @param {{THREE: *, fieldTexture: *, uFieldRect: *, uBaseDarkness01: *,
 *   uDaylightColor: *, uDarknessColor: *}} args - uFieldRect is vec4(minX, minY, maxX, maxY).
 * @returns {*} a NodeMaterial for a world-space quad.
 */
export function buildRegionFieldOverlayMaterial({
  THREE,
  fieldTexture,
  uFieldRect,
  uBaseDarkness01,
  uDaylightColor,
  uDarknessColor,
}) {
  const { texture, vec2, vec4, float, clamp, positionWorld, Fn } = THREE.TSL;
  const fragmentNode = Fn(() => {
    const fu = positionWorld.x.sub(uFieldRect.x).div(uFieldRect.z.sub(uFieldRect.x));
    const fv = positionWorld.y.sub(uFieldRect.y).div(uFieldRect.w.sub(uFieldRect.y));
    const s = texture(fieldTexture).sample(vec2(fu, fv));
    const c = clamp(s.b, float(0), float(1));
    const dc = s.r.add(s.g.mul(uBaseDarkness01));
    const colour = uDaylightColor.mul(c).add(uDarknessColor.sub(uDaylightColor).mul(dc));
    return vec4(colour, c);
  })();
  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  // Premultiplied "over" on colour; the target's own alpha is kept as it was.
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendEquationAlpha = THREE.AddEquation;
  material.blendSrcAlpha = THREE.ZeroFactor;
  material.blendDstAlpha = THREE.OneFactor;
  material.fragmentNode = fragmentNode;
  return material;
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
 * @returns {{material: *, uOrigin: *, uSize: *, uAnchor: *, uRotationRad: *,
 *   uMode: *, uModifier: *, uCoverage: *}}
 */
export function buildRegionRectangleMaterial({ THREE }) {
  const { uniform, float, int, vec2, cos, sin, positionWorld, Fn } = THREE.TSL;

  const uOrigin = uniform(vec2(0, 0));
  const uSize = uniform(vec2(100, 100));
  const uAnchor = uniform(vec2(0, 0));
  const uRotationRad = uniform(float(0));
  const uMode = uniform(int(0));
  const uModifier = uniform(float(0));
  const uCoverage = uniform(float(1));

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
    // Mirrors localRectangleContains(..., REGION_EDGE_TOLERANCE): the slack
    // keeps two edge-sharing rectangles from leaving a float-error gap pixel.
    const tol = float(REGION_EDGE_TOLERANCE);
    const inside = lx
      .greaterThanEqual(left.sub(tol))
      .and(lx.lessThanEqual(left.add(uSize.x).add(tol)))
      .and(ly.greaterThanEqual(top.sub(tol)))
      .and(ly.lessThanEqual(top.add(uSize.y).add(tol)));
    inside.not().discard();
    return computeRegionField(THREE.TSL, { uMode, uModifier, uCoverage });
  })();

  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.fragmentNode = fragmentNode;

  return { material, uOrigin, uSize, uAnchor, uRotationRad, uMode, uModifier, uCoverage };
}

/**
 * Build ONE ellipse-shaped (circle is radiusX=radiusY) darkness region's
 * material — see `buildRegionRectangleMaterial`'s own header for the shared
 * design (per-shape uniforms, shared ambient endpoints, discard-outside).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @returns {{material: *, uOrigin: *, uRadii: *, uRotationRad: *, uMode: *,
 *   uModifier: *, uCoverage: *}}
 */
export function buildRegionEllipseMaterial({ THREE }) {
  const { uniform, float, int, vec2, cos, sin, positionWorld, Fn } = THREE.TSL;

  const uOrigin = uniform(vec2(0, 0));
  const uRadii = uniform(vec2(50, 50));
  const uRotationRad = uniform(float(0));
  const uMode = uniform(int(0));
  const uModifier = uniform(float(0));
  const uCoverage = uniform(float(1));

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
    return computeRegionField(THREE.TSL, { uMode, uModifier, uCoverage });
  })();

  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.fragmentNode = fragmentNode;

  return { material, uOrigin, uRadii, uRotationRad, uMode, uModifier, uCoverage };
}

/** Capacity, in polygon vertices, for a region polygon's fixed-capacity
 * point uniformArray — same fixed-forever-after-setup constraint as
 * `point-light-illumination.js#MAX_LIGHT_EDGES`, same truncate-gracefully
 * contract (`writeRegionPolygonPoints`).
 *
 * ⚠️ RAISED 32 → 256 (2026-07-29, author-reported: "polygon logic for
 * darkening breaks when you use more complex shapes"). The old value's own
 * reasoning ("regions are typically simple GM-drawn shapes... a smaller cap
 * suffices") assumed this cap degrades the way `MAX_LIGHT_EDGES` does —
 * cosmetically. It does not: a light's soft edge is a cheap analytic term
 * layered ON TOP OF real triangle geometry (exceeding the cap just softens
 * the edge a bit less), but a region polygon's `discard()` boundary *is*
 * these points — there is no separate hard geometry backing it. Past the
 * cap, the dropped tail vertices silently reconnect vertex[cap-1] straight
 * to vertex[0]; for any non-trivial outline that chord does not retrace the
 * authored shape at all. A hand-traced "complex" building (or one converted
 * from wall geometry) routinely has 40-100+ vertices — Foundry's own
 * `PolygonShapeData` schema (`common/data/data.mjs`) has no upper bound —
 * and 32 of them measurably misclassified interior points well inside the
 * true shape as outside it (region-geometry.test.mjs's own regression case).
 * 256 costs a few KB of uniform buffer; the per-fragment loop cost still
 * scales with the SHAPE's own actual point count (`uPointCount`), not this
 * capacity, so ordinary simple shapes pay nothing extra. If a scene ever
 * exceeds even 256, `getRegionDarknessInfo`'s `polygonPointsTruncated`
 * field (vt-pan-viewer.js) reports it — never silently again. */
export const MAX_REGION_POLYGON_POINTS = 256;

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
 * @returns {{material: *, points: object[], uPointCount: *, uMode: *,
 *   uModifier: *, uCoverage: *}}
 */
export function buildRegionPolygonMaterial({ THREE }) {
  const { uniform, uniformArray, float, int, vec2, positionWorld, Fn } = THREE.TSL;

  const points = Array.from({ length: MAX_REGION_POLYGON_POINTS }, () => new THREE.Vector2(0, 0));
  const pointsUniform = uniformArray(points, 'vec2');
  const uPointCount = uniform(int(0));
  const uMode = uniform(int(0));
  const uModifier = uniform(float(0));
  const uCoverage = uniform(float(1));

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
    return computeRegionField(THREE.TSL, { uMode, uModifier, uCoverage });
  })();

  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.fragmentNode = fragmentNode;

  return { material, points, uPointCount, uMode, uModifier, uCoverage };
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
 * @returns {{material: *, uOrigin: *, uRadius: *, uHalfAngleRad: *,
 *   uRotationRad: *, uFullCircle: *, uMode: *, uModifier: *, uCoverage: *}}
 */
export function buildRegionConeMaterial({ THREE }) {
  const { uniform, float, int, bool, vec2, mod, atan, positionWorld, Fn } = THREE.TSL;

  const uOrigin = uniform(vec2(0, 0));
  const uRadius = uniform(float(50));
  const uHalfAngleRad = uniform(float(Math.PI / 4));
  const uRotationRad = uniform(float(0));
  // A full-circle cone (authored angle >= 360deg) skips the angle test
  // entirely — mirrors pointInCone's own `angle >= 360` early return.
  const uFullCircle = uniform(bool(false));
  const uMode = uniform(int(0));
  const uModifier = uniform(float(0));
  const uCoverage = uniform(float(1));

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
    return computeRegionField(THREE.TSL, { uMode, uModifier, uCoverage });
  })();

  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.fragmentNode = fragmentNode;

  return { material, uOrigin, uRadius, uHalfAngleRad, uRotationRad, uFullCircle, uMode, uModifier, uCoverage };
}

/**
 * Build ONE ring-shaped darkness region's material — see
 * `buildRegionRectangleMaterial`'s own header for the shared design. NO
 * rotation uniform at all: Ring is always a full annulus (`pointInRing`'s
 * own doc — Ring overrides `_rotate()` as a no-op in Foundry's real source).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @returns {{material: *, uOrigin: *, uInnerRadius: *, uOuterRadius: *,
 *   uMode: *, uModifier: *, uCoverage: *}}
 */
export function buildRegionRingMaterial({ THREE }) {
  const { uniform, float, int, vec2, positionWorld, Fn } = THREE.TSL;

  const uOrigin = uniform(vec2(0, 0));
  const uInnerRadius = uniform(float(0));
  const uOuterRadius = uniform(float(50));
  const uMode = uniform(int(0));
  const uModifier = uniform(float(0));
  const uCoverage = uniform(float(1));

  // Wrapped in Fn() — see `buildRegionRectangleMaterial`'s own header for
  // why: `discard()` called outside a build-time stack context is a silent
  // no-op (verified against source), which is what let every region mesh
  // paint its full, un-clipped bounding quad until this fix.
  const fragmentNode = Fn(() => {
    const rel = positionWorld.xy.sub(uOrigin);
    const dist = rel.length();
    const inside = dist.greaterThanEqual(uInnerRadius).and(dist.lessThanEqual(uOuterRadius));
    inside.not().discard();
    return computeRegionField(THREE.TSL, { uMode, uModifier, uCoverage });
  })();

  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.fragmentNode = fragmentNode;

  return { material, uOrigin, uInnerRadius, uOuterRadius, uMode, uModifier, uCoverage };
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
 * @returns {{material: *, uOrigin: *, uLength: *, uWidth: *, uRotationRad: *,
 *   uMode: *, uModifier: *, uCoverage: *}}
 */
export function buildRegionLineMaterial({ THREE }) {
  const { uniform, float, int, vec2, cos, sin, positionWorld, Fn } = THREE.TSL;

  const uOrigin = uniform(vec2(0, 0));
  const uLength = uniform(float(100));
  const uWidth = uniform(float(20));
  const uRotationRad = uniform(float(0));
  const uMode = uniform(int(0));
  const uModifier = uniform(float(0));
  const uCoverage = uniform(float(1));

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
    return computeRegionField(THREE.TSL, { uMode, uModifier, uCoverage });
  })();

  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.fragmentNode = fragmentNode;

  return { material, uOrigin, uLength, uWidth, uRotationRad, uMode, uModifier, uCoverage };
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
 * @returns {{material: *, uOrigin: *, uSize: *, uAnchor: *, uRotationRad: *,
 *   uGrowRadius: *, uMode: *, uModifier: *, uCoverage: *}}
 */
export function buildRegionEmanationRectangleMaterial({ THREE }) {
  const { uniform, float, int, vec2, cos, sin, clamp, positionWorld, Fn } = THREE.TSL;

  const uOrigin = uniform(vec2(0, 0));
  const uSize = uniform(vec2(100, 100));
  const uAnchor = uniform(vec2(0, 0));
  const uRotationRad = uniform(float(0));
  const uGrowRadius = uniform(float(0));
  const uMode = uniform(int(0));
  const uModifier = uniform(float(0));
  const uCoverage = uniform(float(1));

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
    return computeRegionField(THREE.TSL, { uMode, uModifier, uCoverage });
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
    uCoverage,
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
 * @returns {{material: *, points: object[], uPointCount: *, uGrowRadius: *,
 *   uMode: *, uModifier: *, uCoverage: *}}
 */
export function buildRegionEmanationPolygonMaterial({ THREE }) {
  const { uniform, uniformArray, float, int, vec2, positionWorld, Fn } = THREE.TSL;

  const points = Array.from({ length: MAX_REGION_POLYGON_POINTS }, () => new THREE.Vector2(0, 0));
  const pointsUniform = uniformArray(points, 'vec2');
  const uPointCount = uniform(int(0));
  const uGrowRadius = uniform(float(0));
  const uMode = uniform(int(0));
  const uModifier = uniform(float(0));
  const uCoverage = uniform(float(1));

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
    return computeRegionField(THREE.TSL, { uMode, uModifier, uCoverage });
  })();

  const material = new THREE.NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.fragmentNode = fragmentNode;

  return { material, points, uPointCount, uGrowRadius, uMode, uModifier, uCoverage };
}
