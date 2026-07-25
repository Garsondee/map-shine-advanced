/**
 * LIGHT VISIBILITY — the pure core of the shadow half (`light.visibility`).
 *
 * THE ONE SENTENCE (docs/planning/Light-and-Shadow.md §0): shadow is not a
 * thing you paint onto the scene — it is the ABSENCE OF A SPECIFIC LIGHT. Every
 * light carries its OWN visibility term; the sun's term min-combines producers
 * that all mean the same thing (authored `_Shadow` ∧ building ∧ sky-reach ∧
 * cloud), and then:
 *
 *     illum = skyAmbient × skyVisibility + Σ ( light_i × visibility_i )
 *
 * This module is the CPU-pure, Node-tested heart of that pass — the same split
 * environmental-light.js already uses (pure ambient-ladder math here, the TSL
 * material build + frame-loop wiring in vt-pan-viewer.js). It follows the
 * `frame.snapshot` precedent (graph/passes.js): the pure core is BUILT and
 * tested; the GPU producer that fills `buf:scene.vis` and the wiring that makes
 * `light.accumulate` multiply the ambient/sun fill by it stay a seam
 * (lighting-pass.js still throws) until they can be verified LIVE against real
 * Foundry data with the pixel probe — a mask sampled world→screen is exactly
 * the Y-flip class this codebase treats as never-solved (memory:
 * feedback_y_flip_recurring_risk), so its correctness is not something a Node
 * test can assert. What a Node test CAN pin lives here.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TWO CLUSTERS, ONE MEANING
 *
 * 1. THE SUN-VISIBILITY MODEL — {@link combineVisibility},
 *    {@link authoredShadowVisibility}, {@link composeSunTermWithMaxLight}.
 *    Producers min-combine because they share ONE semantic (there are no
 *    opacity knobs to fight over — Light-and-Shadow.md §4.1). Composition with
 *    point lights is a plain per-channel MAX (the frame loop draws point-light
 *    meshes into the SAME `buf:scene.illum` the ambient fill wrote), which is
 *    WHY the doctrine needs no lift: a torch standing in a painted shadow is
 *    lit because its own light MAXes back over the darkened sun term — not
 *    because an inverse system un-darkened the shadow near it. That claim is
 *    encoded as an executable invariant in this module's test.
 *
 * 2. THE OFFSET-PROJECTION for a SCREEN-SPACE occluder — {@link
 *    projectShadowOffset}, {@link shadowPenumbraPx}, {@link
 *    projectOccluderShadow}. This is the geometry of the "UI casts a shadow on
 *    the world" wishlist (an open character sheet / context menu / journal
 *    floating above the map, throwing a soft offset shadow). It is doctrinally
 *    a visibility PRODUCER, NOT a post-process darken: the projected stamp
 *    lowers the sun/workspace-light visibility inside its footprint, min-
 *    combined with every other producer, and is then multiplied onto that
 *    light's contribution — never onto composed scene colour. Modeling it any
 *    other way (a dark quad composited over the final image) is precisely the
 *    `tCombinedShadow` fossil the build wall forbids (shadow/no-lift-no-combine
 *    in tools/verify-structure.mjs). A UI panel over a torch-lit floor is a
 *    proof case: the torch MAXes back, so the shadow correctly fades where the
 *    floor is already lit — free, and only because it is a visibility term.
 *
 * @module effects/lighting/light-visibility
 */

/** Fully lit — the identity/absence value of any visibility term (nothing
 * blocks the light). Absent producers, and any non-finite reading, resolve to
 * this so a missing or broken producer can never DARKEN (fail-safe, matching
 * world/sun.js's "broken input reads as neutral, never NaN downstream"). */
export const SUN_VISIBILITY_LIT = 1;

/** Fully shadowed — no light of this term reaches the pixel. */
export const SUN_VISIBILITY_SHADOW = 0;

/**
 * A fixed, decorative "workspace light" for UI-cast shadows — chosen so open
 * windows throw a consistent, readable shadow REGARDLESS of the scene's in-world
 * time of day. UI chrome is not a world object; tying its shadow to `env.sun`
 * would make character-sheet shadows vanish at noon (sun overhead → zero offset)
 * and rake across the screen at dusk, which reads as a bug, not a feature. A
 * soft key from the upper-left at a high-ish elevation is the stage-lighting
 * default (the same instinct as world/sun.js's `noonAzimuthDeg`). Callers that
 * WANT the in-world sun can pass `env.sun`'s azimuth/elevation instead — the
 * projection functions take the light as parameters, not this constant.
 */
export const DEFAULT_WORKSPACE_LIGHT = Object.freeze({
  /** Compass degrees, clockwise from screen-up (north). 315 = upper-left (NW). */
  azimuthDeg: 315,
  /** Degrees above the horizon. 55° keeps the offset short and the panel legible. */
  elevationDeg: 55,
  /** How far the panel "floats" above the map, in screen pixels — drives both
   * the offset length and the penumbra. A card-like lift. */
  heightPx: 26,
  /** How dark the shadow is at its core, 0..1 (a soft grey, not black). */
  strength01: 0.4,
  /** Cosmetic multiplier on the projected offset LENGTH only (author-requested
   * 2026-07-20 v4: "make the shadow offset x5"). Deliberately separate from
   * `heightPx`: heightPx alone still drives the penumbra (shadowPenumbraPx
   * never reads this), so throwing the shadow further doesn't also blur it
   * out — a purely cosmetic "how far", decoupled from the physical "how soft".
   * See projectShadowOffset's own `offsetScale` param. */
  offsetScale: 5,
});

/** @param {number} x @returns {number} clamped to [0,1]; non-finite → 0 */
export function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** @param {number} deg @returns {number} radians */
function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * Min-combine a set of visibility producers into one sun-visibility value.
 *
 * Producers share ONE semantic (this pixel's visibility of the sun/sky), so
 * they combine by `min` — the darkest producer wins, and there are NO per-source
 * opacity weights to tune against each other (Light-and-Shadow.md §4.1; the
 * absence of those weights is the whole point — they were V2's collision class).
 *
 * Absence is fully lit: an empty list → {@link SUN_VISIBILITY_LIT}, and any
 * `null`/`undefined`/non-finite entry is skipped (treated as "this producer has
 * nothing to say here", i.e. 1), never as 0 — a producer that fails to report
 * must not manufacture a shadow.
 *
 * @param {ReadonlyArray<number|null|undefined>} [values] - producer readings, each 0..1.
 * @returns {number} the combined visibility, 0..1.
 */
export function combineVisibility(values = []) {
  let min = SUN_VISIBILITY_LIT;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    const c = n < 0 ? 0 : n > 1 ? 1 : n;
    if (c < min) min = c;
  }
  return min;
}

/**
 * The authored `_Shadow` mask's contribution to sun visibility. The catalog
 * (scene/mask-catalog.js, kind `shadow`) defines it as: white = lit, black =
 * hand-painted shadow, ABSENT = nothing painted dark (fully lit). So the value
 * is just the mask luminance, clamped — with absence (a floor with no `_Shadow`
 * file, surfaced as `null`) resolving to fully lit. Stated as its own function
 * because "absent = 1, not 0" is the exact semantic a channel-packed mask gets
 * wrong when an unpacked absent layer reads as zero (memory: the mask authority
 * owns ABSENCE on purpose).
 *
 * @param {number|null|undefined} maskLuminance - the `_Shadow` channel, 0..1, or null if unpainted.
 * @returns {number} visibility 0..1 (1 where unpainted/lit).
 */
export function authoredShadowVisibility(maskLuminance) {
  if (maskLuminance === null || maskLuminance === undefined) return SUN_VISIBILITY_LIT;
  const n = Number(maskLuminance);
  if (!Number.isFinite(n)) return SUN_VISIBILITY_LIT;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Compose ONE light's shadowed contribution with the accumulated point-light
 * term, exactly as the frame loop does it: the ambient/sun fill is written as
 * `ambient × visibility`, then point-light meshes MAX-blend on top into the
 * same buffer. So the illumination at a pixel is:
 *
 *     illum = max( ambientTerm × sunVisibility , maxLightTerm )
 *
 * THE INVARIANT THIS PROVES (and its test asserts): a torch whose own
 * illumination (`maxLightTerm`) is at least the un-shadowed ambient makes the
 * sun's painted shadow irrelevant at that pixel — the result is the torch,
 * whatever `sunVisibility` was. No lift, no override strength, no shadow shader
 * reading a light buffer. The shadow gated its OWN light (the sun) and nothing
 * else; the torch was never darkened to begin with (Light-and-Shadow.md §1
 * step 3–4). This is the single scalar form of the model the wall protects.
 *
 * @param {number} ambientTerm - the sky/sun ambient magnitude at the pixel (a channel, ≥0).
 * @param {number} sunVisibility - 0..1 from {@link combineVisibility}.
 * @param {number} [maxLightTerm=0] - the accumulated point-light magnitude MAXed in after (≥0).
 * @returns {number} the composed illumination magnitude.
 */
export function composeSunTermWithMaxLight(ambientTerm, sunVisibility, maxLightTerm = 0) {
  const a = Number.isFinite(ambientTerm) ? ambientTerm : 0;
  const vis = clamp01(sunVisibility);
  const light = Number.isFinite(maxLightTerm) ? maxLightTerm : 0;
  return Math.max(a * vis, light);
}

/**
 * The unit direction, in SCREEN space, that a shadow is thrown by a light at
 * compass azimuth `azimuthDeg`.
 *
 * CONVENTION (documented because this is the Y-flip class — memory:
 * feedback_y_flip_recurring_risk — and the test pins every quadrant):
 *   - Screen axes: +x = right, +y = DOWN (DOM / getBoundingClientRect space).
 *   - Azimuth: compass degrees, clockwise from screen-up (north). Matches
 *     world/sun.js (noon = 180 = south). 0→up, 90→right, 180→down, 270→left.
 *   - The light is IN direction `azimuthDeg`; the shadow falls AWAY from it, so
 *     shadow direction = azimuth + 180°.
 * A compass azimuth `a` points at screen vector (sin a, −cos a); the shadow's
 * `a+180` therefore points at (−sin a, +cos a).
 *
 * @param {number} azimuthDeg - the LIGHT's azimuth (compass, cw from up).
 * @returns {{x:number, y:number}} unit vector the shadow is cast toward (+y down).
 */
export function shadowOffsetDirection(azimuthDeg) {
  const a = degToRad(Number.isFinite(azimuthDeg) ? azimuthDeg : 0);
  return { x: -Math.sin(a), y: Math.cos(a) };
}

/**
 * How far a screen-space occluder throws its shadow, and in which direction.
 *
 * An occluder floating `heightPx` above the ground plane, lit from `elevationDeg`
 * above the horizon, casts its shadow a horizontal distance `heightPx /
 * tan(elevation)` — zero when the light is straight overhead (90°), growing
 * without bound as the light nears the horizon. `offsetScale` then multiplies
 * that raw length (a purely cosmetic "how far", independent of `heightPx`,
 * which alone still drives the penumbra — see shadowPenumbraPx). The result is
 * clamped to `maxOffsetPx` AFTER scaling, so the cap still bounds the final
 * throw. The direction comes from {@link shadowOffsetDirection}.
 *
 * @param {object} args
 * @param {number} args.azimuthDeg - the light's compass azimuth (cw from up).
 * @param {number} args.elevationDeg - the light's elevation, (0, 90]; clamped into range.
 * @param {number} args.heightPx - how far the occluder floats above the map (screen px).
 * @param {number} [args.maxOffsetPx=512] - cap on the FINAL (post-scale) offset length.
 * @param {number} [args.offsetScale=1] - cosmetic multiplier on the raw offset length.
 *   Non-finite or ≤0 falls back to 1 (never inverts or zeros the shadow).
 * @param {boolean} [args.softKnee=false] - see {@link softenThrowPx}. OFF by
 *   default so the UI-shadow's hand-tuned behaviour is bit-identical; the world
 *   casters (`effects/shadow-access.js`) turn it ON.
 * @returns {{x:number, y:number, length:number}} the offset vector and its length (px).
 */
export function projectShadowOffset({
  azimuthDeg,
  elevationDeg,
  heightPx,
  maxOffsetPx = 512,
  offsetScale = 1,
  softKnee = false,
}) {
  const h = Number.isFinite(heightPx) && heightPx > 0 ? heightPx : 0;
  const maxLen = Number.isFinite(maxOffsetPx) && maxOffsetPx > 0 ? maxOffsetPx : 0;
  const scale = Number.isFinite(offsetScale) && offsetScale > 0 ? offsetScale : 1;
  // Clamp elevation to (0, 90]. At/above 90 the shadow is directly under the
  // occluder (length 0); at/below ~0 the light grazes and the offset saturates.
  const elevClamped = Math.min(90, Math.max(0, Number.isFinite(elevationDeg) ? elevationDeg : 90));
  const t = Math.tan(degToRad(elevClamped));
  // tan(90°) is enormous (→ length 0); tan(0°) is 0 (→ division saturates). Both
  // ends are handled by the clamp below, so no special-casing / Infinity leaks.
  const rawLen = t > 1e-6 ? h / t : maxLen;
  const scaled = Math.max(0, rawLen * scale);
  const length = softKnee ? softenThrowPx(scaled, maxLen) : Math.min(maxLen, scaled);
  const dir = shadowOffsetDirection(azimuthDeg);
  return { x: dir.x * length, y: dir.y * length, length };
}

/**
 * SOFTEN A SHADOW'S THROW toward a ceiling instead of chopping it there.
 *
 * Author, 2026-07-24, live report: *"the offset means that the tree shadows are
 * already too far away from their producers at dawn and dusk… we need to lower
 * the offset so that shadows don't become too detached from their producers."*
 *
 * The cause is `height / tan(elevation)` doing exactly what physics says: as the
 * sun approaches the horizon the tangent approaches zero and the throw runs
 * away. That is TRUE and it is also unusable on a top-down battlemap, where a
 * tree's shadow crossing half the map reads as a rendering fault rather than as
 * dusk. A hard `min()` does not fix it either — it makes every tall caster's
 * shadow land at the SAME distance for the last hour of daylight, so the whole
 * scene's shadows visibly snap into a line and then stop moving.
 *
 * This is the standard saturating knee: `raw · max / (raw + max)`. It is
 * essentially `raw` while raw ≪ max, bends over smoothly, and asymptotes to
 * `max` without ever reaching it — so shadows keep growing all the way to
 * sunset, just ever more slowly, and no two casters ever collapse onto the same
 * distance. Monotonic, branchless, and `f(0) = 0`.
 *
 * @param {number} rawPx - the physical throw.
 * @param {number} maxPx - the distance the throw asymptotes to. ≤0 disables (returns raw).
 * @returns {number} the compressed throw, in [0, maxPx).
 */
export function softenThrowPx(rawPx, maxPx) {
  const raw = Number.isFinite(rawPx) && rawPx > 0 ? rawPx : 0;
  const max = Number.isFinite(maxPx) && maxPx > 0 ? maxPx : 0;
  if (max === 0) return raw;
  if (raw === 0) return 0;
  return (raw * max) / (raw + max);
}

/**
 * The penumbra (soft-edge radius, px) of a screen-space occluder's shadow.
 *
 * Penumbra grows with how high the occluder floats (a higher card has a softer
 * shadow) and grows further as the light grazes (low elevation → long, soft
 * shadows). Both are monotonic and asserted in the test. Never below
 * `baseSoftnessPx`, so even a flush, overhead-lit panel keeps a faint feather
 * rather than a hard cutout.
 *
 * @param {object} args
 * @param {number} args.heightPx - occluder float height (screen px).
 * @param {number} args.elevationDeg - light elevation, (0, 90]; clamped.
 * @param {number} [args.baseSoftnessPx=6] - the minimum feather.
 * @param {number} [args.heightFactor=0.15] - softness added per px of height, always.
 * @param {number} [args.grazingFactor=0.5] - extra softness per px of height as the light lowers.
 * @returns {number} penumbra radius in px (≥ baseSoftnessPx).
 */
export function shadowPenumbraPx({
  heightPx,
  elevationDeg,
  baseSoftnessPx = 6,
  heightFactor = 0.15,
  grazingFactor = 0.5,
}) {
  const h = Number.isFinite(heightPx) && heightPx > 0 ? heightPx : 0;
  const base = Number.isFinite(baseSoftnessPx) && baseSoftnessPx > 0 ? baseSoftnessPx : 0;
  const elevClamped = Math.min(90, Math.max(0, Number.isFinite(elevationDeg) ? elevationDeg : 90));
  const grazing = 1 - Math.sin(degToRad(elevClamped)); // 0 overhead → 1 at the horizon
  return base + h * (heightFactor + grazingFactor * grazing);
}

/**
 * Project a screen-space occluder rect (an open UI window) into a shadow STAMP:
 * where its soft shadow lands, how soft, and how dark. This is the complete
 * geometry the UI-shadow producer needs; the GPU pass turns each stamp into a
 * feathered dark rounded-rect drawn into `buf:scene.vis` (min-combined with the
 * authored/building/sky-reach producers), never into scene colour.
 *
 * The returned rect is the occluder's own rect translated by the projected
 * offset; `penumbraPx` is the feather the renderer expands and blurs by. The
 * occluder's SIZE is preserved (a floating card's shadow is roughly its own
 * size, offset — not scaled), which keeps the effect cheap and stable as a
 * window is dragged.
 *
 * @param {object} args
 * @param {{x:number, y:number, w:number, h:number}} args.rect - the window's screen rect (px).
 * @param {number} args.azimuthDeg - workspace-light azimuth (compass, cw from up).
 * @param {number} args.elevationDeg - workspace-light elevation, (0, 90].
 * @param {number} args.heightPx - how high the window floats above the map (px).
 * @param {number} [args.strength01=DEFAULT_WORKSPACE_LIGHT.strength01] - core darkness, 0..1.
 * @param {number} [args.baseSoftnessPx=6] - minimum feather (px).
 * @param {number} [args.maxOffsetPx=512] - offset-length cap (px), applied AFTER offsetScale.
 * @param {number} [args.offsetScale=DEFAULT_WORKSPACE_LIGHT.offsetScale] - cosmetic multiplier
 *   on the offset length only (see projectShadowOffset); the penumbra is untouched by it.
 * @returns {{x:number, y:number, w:number, h:number, offsetX:number, offsetY:number, penumbraPx:number, strength01:number}}
 */
export function projectOccluderShadow({
  rect,
  azimuthDeg,
  elevationDeg,
  heightPx,
  strength01 = DEFAULT_WORKSPACE_LIGHT.strength01,
  baseSoftnessPx = 6,
  maxOffsetPx = 512,
  offsetScale = DEFAULT_WORKSPACE_LIGHT.offsetScale,
}) {
  const r = rect ?? { x: 0, y: 0, w: 0, h: 0 };
  const offset = projectShadowOffset({ azimuthDeg, elevationDeg, heightPx, maxOffsetPx, offsetScale });
  const penumbraPx = shadowPenumbraPx({ heightPx, elevationDeg, baseSoftnessPx });
  return {
    x: (Number.isFinite(r.x) ? r.x : 0) + offset.x,
    y: (Number.isFinite(r.y) ? r.y : 0) + offset.y,
    w: Number.isFinite(r.w) && r.w > 0 ? r.w : 0,
    h: Number.isFinite(r.h) && r.h > 0 ? r.h : 0,
    offsetX: offset.x,
    offsetY: offset.y,
    penumbraPx,
    strength01: clamp01(strength01),
  };
}

/**
 * How many UI windows can cast a shadow at once. A cap, not a scene limit: the
 * shader unrolls exactly this many stamp slots, and the reader stops filling
 * once it hits the cap (surfaced in the debug report, never silently dropped —
 * feedback_instruments_must_not_lie). Six cascading character sheets is already
 * an unusual table; more than that and the extras simply don't cast.
 */
export const MAX_UI_SHADOW_STAMPS = 6;

/**
 * Map ONE open window's viewport rect to a shadow STAMP in canvas-local,
 * top-down pixel space — the pure adapter between the DOM (viewport
 * `getBoundingClientRect` values, read live in vt-pan-viewer) and the shader's
 * uniform slots. Kept pure (plain rects in, plain numbers out) so the geometry
 * is Node-tested; the DOM read that produces `winRect`/`canvasRect` is the thin,
 * untestable half that stays in the frame loop.
 *
 * Both rects are `{left, top, width, height}` in the SAME viewport CSS-pixel
 * space, so subtracting the canvas origin lands the window in canvas-local
 * pixels; {@link projectOccluderShadow} then throws it by the workspace light.
 * The returned centre/half are what the shader's box-SDF reads.
 *
 * @param {{left:number, top:number, width:number, height:number}} winRect - the window (viewport px).
 * @param {{left:number, top:number, width:number, height:number}} canvasRect - MSA's canvas (viewport px).
 * @param {{azimuthDeg:number, elevationDeg:number, heightPx:number}} light - the workspace light.
 * @param {{strength01?:number, baseSoftnessPx?:number, maxOffsetPx?:number, offsetScale?:number}} [opts]
 * @returns {{centerX:number, centerY:number, halfX:number, halfY:number, penumbraPx:number, strength:number}}
 */
export function mapWindowRectToStamp(winRect, canvasRect, light, opts = {}) {
  const w = winRect ?? { left: 0, top: 0, width: 0, height: 0 };
  const c = canvasRect ?? { left: 0, top: 0, width: 0, height: 0 };
  const stamp = projectOccluderShadow({
    rect: { x: w.left - c.left, y: w.top - c.top, w: w.width, h: w.height },
    azimuthDeg: light?.azimuthDeg,
    elevationDeg: light?.elevationDeg,
    heightPx: light?.heightPx,
    strength01: opts.strength01 ?? DEFAULT_WORKSPACE_LIGHT.strength01,
    baseSoftnessPx: opts.baseSoftnessPx ?? 6,
    maxOffsetPx: opts.maxOffsetPx ?? 512,
    offsetScale: opts.offsetScale ?? DEFAULT_WORKSPACE_LIGHT.offsetScale,
  });
  return {
    centerX: stamp.x + stamp.w / 2,
    centerY: stamp.y + stamp.h / 2,
    halfX: stamp.w / 2,
    halfY: stamp.h / 2,
    penumbraPx: stamp.penumbraPx,
    strength: stamp.strength01,
  };
}

/**
 * Build the UI-shadow VISIBILITY NODE — the GPU half of the "open window casts
 * a shadow on the world" producer. BROWSER-ONLY (builds TSL; verified live via
 * the debug panel / an A/B toggle vs a bare scene, never a mocked THREE —
 * CONVENTIONS.md §4, same as buildPointLightIlluminationMaterial). The pure
 * geometry it consumes ({@link mapWindowRectToStamp}) is Node-tested above.
 *
 * NO MATERIAL, NO QUAD (v6, 2026-07-20 — author-measured PERFORMANCE FIX:
 * the v5 throttle cut the DOM-read cost but FPS barely recovered, proving the
 * dominant cost was never the DOM read — it was the EXTRA `render()` CALL
 * itself, running every frame regardless of throttling, on top of the four
 * `illumQuad`/`regionScene`/`lightScene`/`compositeQuad` calls already in the
 * same sequence. A whole extra render pass (pipeline bind + command encode +
 * submit) is real fixed overhead even for trivial GPU math. FIX: this returns
 * a bare TSL `visNode` — the SAME box-SDF-multiply expression as before, just
 * not wrapped in its own material — for the caller to multiply directly into
 * `environmental-light.js`'s EXISTING composite shader (which already runs
 * once, unconditionally, every frame). Folding it in adds a few ALU ops to an
 * already-happening pass instead of a whole new one — mathematically IDENTICAL
 * output (composite reads illum AFTER lights have MAX-blended in, same as the
 * v5 quad did), zero extra draw calls. This also now matches the EXISTING
 * precedent exactly: coloration is likewise added only inside the composite,
 * never written back into `buf:scene.illum` — UI-shadow now follows the same
 * shape rather than being the odd one out.
 *
 * `visNode` is `1` (lit) everywhere, dipping toward `0` inside each window's
 * projected, feathered shadow footprint (a box SDF softened by `smoothstep`
 * across the penumbra). Still no-lift (composited as a MULTIPLY on illum, so
 * a brighter light reads brighter through it) and never touches scene COLOUR.
 * With no windows open every slot's strength is 0, so `visNode` evaluates to a
 * uniform `1` and the multiply is a provable no-op.
 *
 * COORDINATES: canvas-local, top-down pixels (`screenUV × uResolution`;
 * `screenUV.y` is ALREADY top-down on this backend — vt-pan-viewer.js's
 * occlusion-mask comment proves it against the orientation self-test — so
 * `uFlipY` defaults OFF and only exists as an escape hatch,
 * feedback_y_flip_recurring_risk), the SAME space {@link mapWindowRectToStamp}
 * produces. `screenUV` is target/viewport-relative (not mesh-UV-relative), so
 * it lines up identically here as it did in the standalone quad — the SAME
 * fullscreen-quad-equals-screenUV equivalence this codebase already relies on
 * elsewhere (e.g. the occlusion mask sample).
 *
 * @param {object} args
 * @param {*} args.THREE - the renderer namespace (carries `.TSL`).
 * @returns {{
 *   visNode: *,
 *   setStamps: (stamps: Array<{centerX:number,centerY:number,halfX:number,halfY:number,penumbraPx:number,strength:number}>) => void,
 *   setResolution: (w: number, h: number) => void,
 *   setFlipY: (flip: boolean) => void,
 * }}
 */
export function buildUiShadowVisibility({ THREE }) {
  const { uniform, vec2, vec4, float, screenUV, max, min, length, smoothstep, mix } = THREE.TSL;

  const uResolution = uniform(vec2(1, 1));
  // 0 = screenUV.y used as-is (DEFAULT — it is already top-down here); 1 = flip.
  // The caller (vt-pan-viewer.js#_uiShadowState) sets this every enabled frame;
  // this initial value only matters before the first call.
  const uFlipY = uniform(float(0));
  // Two vec4 uniforms per slot: geom = (centerX, centerY, halfX, halfY) px;
  // soft = (penumbraPx, strength, _, _). Mutated in place each frame (no
  // per-frame allocation — the occlusion/illum passes' own uniform discipline).
  const uGeom = [];
  const uSoft = [];
  for (let i = 0; i < MAX_UI_SHADOW_STAMPS; i++) {
    uGeom.push(uniform(vec4(0, 0, 0, 0)));
    uSoft.push(uniform(vec4(0, 0, 0, 0)));
  }

  // Fragment position in canvas-local top-down px. mix() in FUNCTION form on
  // purpose: the `.mix()` method treats its receiver as the interpolant, a
  // silent trap (reference_tsl_method_chaining_trap) — mix(a, b, t) is correct.
  const fy = mix(screenUV.y, float(1).sub(screenUV.y), uFlipY);
  const fragPx = vec2(screenUV.x.mul(uResolution.x), fy.mul(uResolution.y));

  let vis = float(1);
  for (let i = 0; i < MAX_UI_SHADOW_STAMPS; i++) {
    const center = vec2(uGeom[i].x, uGeom[i].y);
    const half = vec2(uGeom[i].z, uGeom[i].w);
    const penumbra = max(uSoft[i].x, float(0.001)); // never 0 → smoothstep stays well-defined
    const strength = uSoft[i].y;
    // Box SDF (Inigo Quilez): d < 0 inside the rect, growing positive outside.
    // `.abs()` as a method — the proven-safe unary form (like `.max()`/`.negate()`
    // in point-light-illumination.js), NOT the `.mix()` receiver trap.
    const q = fragPx.sub(center).abs().sub(half);
    const d = length(max(q, vec2(0, 0))).add(min(max(q.x, q.y), float(0)));
    // 1 inside, easing to 0 across the penumbra just outside the edge.
    const occ = strength.mul(float(1).sub(smoothstep(float(0), penumbra, d)));
    vis = vis.mul(float(1).sub(occ)); // independent multiplicative attenuation per window
  }

  /** Push up to {@link MAX_UI_SHADOW_STAMPS} stamps; unused slots go strength 0
   * (a no-op factor of 1), so a closed window instantly stops casting. Call
   * with `[]` (or nullish) to explicitly clear every slot — required now that
   * `visNode` is ALWAYS evaluated (no draw to skip), e.g. when the feature is
   * disabled. */
  function setStamps(stamps) {
    for (let i = 0; i < MAX_UI_SHADOW_STAMPS; i++) {
      const s = stamps && stamps[i];
      if (s) {
        uGeom[i].value.set(s.centerX, s.centerY, s.halfX, s.halfY);
        uSoft[i].value.set(s.penumbraPx, s.strength, 0, 0);
      } else {
        uGeom[i].value.set(0, 0, 0, 0);
        uSoft[i].value.set(0, 0, 0, 0);
      }
    }
  }

  /** Canvas-local pixel resolution (CSS px — same unit the stamps use). */
  function setResolution(w, h) {
    uResolution.value.set(w > 0 ? w : 1, h > 0 ? h : 1);
  }

  /** The single Y-flip knob (see header). */
  function setFlipY(flip) {
    uFlipY.value = flip ? 1 : 0;
  }

  return { visNode: vis, setStamps, setResolution, setFlipY };
}
