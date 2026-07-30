/**
 * THE VEGETATION-SHADOW SUBSYSTEM — the padded shadow quad, its per-kind pad,
 * and the per-frame sky sync, as one owned unit. Extraction step 2 of
 * `docs/planning/VT-Pan-Viewer-Extraction.md` (2026-07-25), following step 1's
 * `lighting/sun-shadow-subsystem.js` exactly.
 *
 * ============================================================================
 * THE RULE THIS FOLLOWS (Extraction plan §1)
 * ============================================================================
 *
 * "A subsystem is not extracted while it still reads closure state. No
 * explicit parameter list = it did not happen." Every input is named in
 * {@link createVegetationShadowSubsystem}'s destructured argument; nothing is
 * reached for from an enclosing scope, because there is no enclosing scope.
 *
 * ⚠️ `getShadowHandle` IS A GETTER, NOT A VALUE (Extraction plan trap #1).
 * `shadowHandle` is REASSIGNED in the viewer every time the sky changes
 * (`shadowHandle = createShadowHandle({...})`) — a handle is frozen at
 * construction and a rebake mints a new one with `version + 1`. Capturing the
 * value here would freeze every vegetation shadow at the sky it was built
 * under: the shadows would still move (the uniforms are still written every
 * frame) but they would move according to a sunrise that already happened.
 * That is the exact class as `feedback_residency_sync_vs_render_loop` and the
 * wind-overlay freeze `world/wind-access.js`'s own header describes.
 *
 * `dimensions` is taken as a VALUE because it is a `startVtPanViewer`
 * parameter that is never reassigned, and `.sceneRect` is read at call time —
 * so the live rect is always seen. `scene` likewise (`const scene = new
 * THREE.Scene()`, never reassigned).
 *
 * ============================================================================
 * WHY `setTileGeometry` AND `buildVegetationMaterial` ARE INJECTED
 * ============================================================================
 *
 * Both are viewer PRIMITIVES that legitimately stay behind:
 *
 * - `setTileGeometry` is used by every drawable, not just vegetation — it is
 *   the tile-quad builder. It takes `padPx` (defaulting to 0) precisely so
 *   this subsystem can ask for the grown quad without a second copy of the
 *   arithmetic existing.
 * - `buildVegetationMaterial` reads a large amount of viewer closure state
 *   (the wind handle's TSL node, the shared view/outdoors rect uniforms, the
 *   occlusion uniforms). Dragging it here would be a rewrite, and Extraction
 *   plan §6 is explicit: "Every extracted line should be the same line, in a
 *   new home, with its dependencies named." It is a later step's problem, or
 *   nobody's.
 *
 * ⚠️ SHARED UNIFORMS STAY SHARED (trap #2): this module constructs NO uniforms
 * of its own. It only WRITES into the `built.shadow` set that
 * `buildVegetationMaterial` already owns. There is deliberately not a single
 * `uniform(` call below.
 *
 * ============================================================================
 * NO `dispose()` — CHECKED, NOT ASSUMED (trap #3)
 * ============================================================================
 *
 * This subsystem holds no state: both functions are pure transforms over
 * arguments the caller owns. The meshes/geometries/materials it builds are
 * stored on the caller's own `t.shadow` record and live and die with that
 * item's state, so there is nothing here to tear down.
 *
 * ⚠️ Noted while extracting, deliberately NOT fixed in this commit (Extraction
 * plan §6: behaviour changes and extractions must never share a commit, or a
 * regression becomes unattributable): `t.shadow.mesh` / `.geometry` /
 * `.material` are never disposed anywhere in `vt-pan-viewer.js` — the same
 * leak class step 1 found for `sunShadowRt` (Extraction plan §7.2). That is a
 * viewer-side teardown fix, since the viewer owns the records.
 *
 * @module effects/vegetation-shadow-subsystem
 */

import { BASE_SOFTNESS_PX, maxThrowForHeightPx } from './shadow-access.js';
import { shadowPenumbraPx } from './lighting/light-visibility.js';
import { edgeRamp01 } from './lighting/sun-occlusion.js';

/**
 * How far a vegetation shadow's renderOrder sits from its owning item's, as a
 * plain MAGNITUDE — the two cases need opposite signs, which is why this is
 * not a signed offset a caller just adds.
 *
 * CASE 2 (a sibling-mask overlay): `item` IS the ground the shadow must
 * darken. The shadow must draw AFTER it (`+`), so the ground does not simply
 * overdraw and erase it — this was a real bug found 2026-07-23 alongside the
 * uniform-sync one: the shadow was built at `item.renderOrder - 0.5`, UNDER
 * its own ground, so the ground (opaque, drawn later at its own higher order)
 * painted straight over it. Nothing ever rendered wrong-looking; it rendered
 * NOTHING, silently.
 *
 * CASE 1 (a self-vegetation tile): `item` is the CANOPY itself, not the
 * ground — the real ground is a separate, earlier-drawn item this code does
 * not control. Here the shadow correctly draws BEFORE its own canopy (`-`), so
 * the canopy paints over the shadow only where they overlap.
 *
 * Deliberately SMALLER than `kind.renderOrderNudge` (0.5/0.6) so a shadow can
 * never accidentally outrank a SECOND kind's canopy on the same item (a
 * background painted with both `_Tree` and `_Bush`).
 */
export const VEG_SHADOW_RENDER_ORDER_MAGNITUDE = 0.2;

/**
 * How many stations the shadow sweep samples between the plant's feet and the
 * tip of its shadow (2026-07-24, the "shadows don't smear" fix).
 *
 * A COST constant, not a look one: the sweep's LENGTH is the sun's throw, so
 * more stations means a smoother streak over the same distance, never a longer
 * one. Six plus the base tap covers a shadow up to ~7 silhouette-widths long
 * without visible banding, and only the two ends pay for the 5-tap penumbra
 * cross, so the worst case is 6 + 2x5 = 16 fetches — well under the flutter
 * path's own budget on the canopy this replaces nothing of.
 *
 * Exported because `buildVegetationMaterial` (still in `vt-pan-viewer.js`)
 * builds exactly this many taps: the tap count and the LOD that sizes each
 * tap's blur against the gap to the next one MUST be the same number, and one
 * home for it is what guarantees that.
 *
 * ⚠️ THIS IS THE `standard`-TIER VALUE, NOT ALWAYS THE LIVE ONE (2026-07-29).
 * The performance-tier ladder (`vegetation-render.js#vegetationTierPlan`) now
 * resolves a PER-TIER tap count — fewer at `performance`, more at `quality`/
 * `extreme` — and `attachTileShadow`/the Case-2 inline build pass it into
 * `buildVegetationMaterial` as `smearTaps`, stashed onto the returned uniform
 * bag (`built.shadow.smearTaps`) so `syncUniforms`'s own gap/LOD math below
 * reads the SAME number the shader actually unrolled instead of silently
 * assuming this constant. This constant remains: the tier plan's own
 * `standard` row (index 3, today's default) is defined AS this value — one
 * value, one owner — and it is still the safe fallback wherever a resolved
 * tap count is not yet known.
 */
export const VEG_SHADOW_SMEAR_TAPS = 6;

/**
 * How much the far TIP of a swept shadow fades, at its most raking. A shadow's
 * tip dissolves into penumbra long before its foot does; without this a dawn
 * streak ends in a square edge at full strength, which reads as a rectangle of
 * paint. Scaled by `1 - sin(elevation)` at sync time, so noon (a compact
 * shadow with no streak to taper) applies none of it.
 */
const VEG_SHADOW_SMEAR_TAPER_MAX = 0.55;

/** Blur allowance in the shadow quad's pad, as a multiple of the base
 * feather — see {@link vegetationShadowPadPx} for why this is NOT the
 * atmospheric worst case (that cost 53× the fill area and 40 fps). */
const VEG_SHADOW_PAD_BLUR_MUL = 2;

/** Hard ceiling on the pad, px. A backstop against a very tall future caster
 * kind quietly reintroducing the overdraw blow-up. */
const VEG_SHADOW_MAX_PAD_PX = 320;

/** Ceiling on the smear's mip level. Past ~5 the sample is a featureless blob
 * anyway, and reading beyond a texture's real chain is undefined. */
const VEG_SHADOW_MAX_SMEAR_LOD = 5;

/**
 * A placement grown outward by `padPx` on every side, in its own LOCAL frame,
 * art position unchanged. The one definition, shared by the tiled
 * (`setTileGeometry`) and untiled (Case-2 overlay) shadow builds — two copies
 * of this arithmetic is exactly how the two would end up padding by different
 * amounts and only one of them matching its material.
 *
 * @param {object} placement
 * @param {number} padPx
 * @returns {object}
 */
export function padPlacement(placement, padPx) {
  const w = placement?.width ?? 1;
  const h = placement?.height ?? 1;
  return {
    ...placement,
    width: w + 2 * padPx * Math.sign(w || 1),
    height: h + 2 * padPx * Math.sign(h || 1),
  };
}

/**
 * How far outside its own art a vegetation shadow can reach, in world px.
 *
 * The two terms are the two things that push a shadow past its plant's
 * footprint: the THROW (bounded, not merely clamped — see
 * `effects/shadow-access.js#maxThrowForHeightPx`) and the PENUMBRA at its
 * softest (night under full cloud, the softest case the atmosphere model
 * produces). Both are functions of the kind's declared `shadowHeightPx` and
 * nothing else, so this is a per-kind constant — which is precisely what lets
 * the padded quad be built once.
 *
 * @param {import('./vegetation.js').VegetationKind} kind
 * @returns {number} px
 */
export function vegetationShadowPadPx(kind) {
  const h = kind?.shadowHeightPx ?? 0;
  const throwPx = maxThrowForHeightPx(h);
  // ⚠️ THE PAD IS PURE OVERDRAW — it multiplies every vegetation shadow's
  // FILL AREA. v1 sized it for the atmospheric WORST case (grazing-sun
  // penumbra × (1+CLOUD_SOFTEN) × (1+NIGHT_SOFTEN) = 12×): a 944px pad on a
  // ~300px tree = a 53× larger quad at up to 16 fetches/fragment, measured
  // live at 120fps → 80fps. Those extreme-blur cases are also the FAINTEST
  // the model produces (~2% strength), so clipping their invisible fringe
  // buys back an order of magnitude of fill for nothing. Hard-capped too.
  const softest = shadowPenumbraPx({ heightPx: h, elevationDeg: 0, baseSoftnessPx: BASE_SOFTNESS_PX });
  return Math.min(VEG_SHADOW_MAX_PAD_PX, throwPx + softest * VEG_SHADOW_PAD_BLUR_MUL);
}

/**
 * @param {object} deps
 * @param {object} deps.THREE - the injected THREE namespace (never imported).
 * @param {object} deps.scene - the viewer's one `THREE.Scene` (a `const`).
 * @param {object} deps.dimensions - the world rect owner; `.sceneRect` is read
 *   at call time, so the live rect is always seen.
 * @param {() => object} deps.getShadowHandle - ⚠️ A GETTER. See the module
 *   header: the handle is reassigned whenever the sky changes.
 * @param {Function} deps.setTileGeometry - the viewer's tile-quad builder,
 *   `(rec, placement, imageW, imageH, segments, padPx) => void`.
 * @param {Function} deps.buildVegetationMaterial - the viewer's vegetation
 *   material builder (reads viewer closure state; stays behind).
 * @returns {{attachTileShadow: Function, syncUniforms: Function}}
 */
export function createVegetationShadowSubsystem({
  THREE,
  scene,
  dimensions,
  getShadowHandle,
  setTileGeometry,
  buildVegetationMaterial,
}) {
  /**
   * Give a Case-1 self-vegetation TILE its own ground shadow — a twin mesh
   * carrying the same texture, the same tessellation and the same wind motion,
   * offset by the sun's throw and emitted as flat darkness.
   *
   * Case 2's overlays build their shadow inline (they construct both meshes in
   * one place); Case 1's tile meshes are built at TWO load paths (compressed +
   * raw fallback), so this exists to keep those two from drifting — the same
   * reason `buildOcclusionUniforms` was extracted.
   *
   * Stored on `t.shadow` so `refreshWholeImageItem` can drive it alongside the
   * tile's own mesh.
   *
   * @param {object} t - the tile record (already has geometry + placement).
   * @param {object} item @param {object} kind @param {object} params
   * @param {object} state @param {number} imageW @param {number} imageH
   * @param {number} segments @param {[number,number]} [uvScale]
   * @param {number} [smearTaps] - the resolved performance-tier smear-station
   *   count (`vegetation-render.js#vegetationTierPlan`). Defaults to
   *   `VEG_SHADOW_SMEAR_TAPS` (today's `standard`-tier value) so a caller that
   *   has not been updated to resolve a tier still gets a correct shadow.
   */
  function attachTileShadow(t, item, kind, params, state, imageW, imageH, segments, uvScale, smearTaps) {
    // THE PAD — how far outside the plant's own quad its shadow can ever
    // reach. Constant per KIND (the throw is bounded by
    // `maxThrowForHeightPx`, plus the penumbra at its softest), so the
    // geometry is built once and never rebuilt as the sun moves. A quad
    // rebuilt per sun step would be the `BufferAttribute has no dispose()`
    // trap (reference_bufferattribute_no_dispose_trap) on a timer.
    const padPx = vegetationShadowPadPx(kind);
    const w = Math.max(1, Math.abs(state.placement?.width ?? 1));
    const h = Math.max(1, Math.abs(state.placement?.height ?? 1));
    const shadowPadUv = [padPx / w, padPx / h];
    const taps = Number.isFinite(smearTaps) && smearTaps > 0 ? smearTaps : VEG_SHADOW_SMEAR_TAPS;
    const built = buildVegetationMaterial(t.tex, item, kind, params, {
      asShadow: true,
      uvScale,
      shadowPadUv,
      smearTaps: taps,
    });
    // How many ART TEXELS one world px covers — the smear LOD needs it to
    // size a station's blur against the gap to the next station (see
    // syncUniforms). Stashed on the uniforms object itself so the sync
    // signature stays "take the uniforms directly", the discipline that
    // function's own header insists on after a real desync bug.
    built.shadow.artTexelsPerWorldPx = imageW / w;
    // The SAME tap count the shader above actually unrolled — syncUniforms'
    // gap/LOD maths below must agree with it or the ladder-fix's "consecutive
    // stations overlap" guarantee breaks (see VEG_SHADOW_SMEAR_TAPS's own doc).
    built.shadow.smearTaps = taps;
    const shadowRec = { tile: t.tile, sub: null, geometry: new THREE.BufferGeometry(), segments: 0 };
    setTileGeometry(shadowRec, state.placement, imageW, imageH, segments, padPx);
    const mesh = new THREE.Mesh(shadowRec.geometry, built.material);
    mesh.frustumCulled = false;
    mesh.visible = false; // the refresh loop owns visibility
    scene.add(mesh);
    t.shadow = {
      mesh,
      geometry: shadowRec.geometry,
      rec: shadowRec,
      material: built.material,
      uniforms: built.shadow,
      // The shadow computes the SAME positionNode displacement as its own
      // canopy (buildVegetationMaterial builds it unconditionally, not
      // gated by asShadow) — so it carries its own full, independent motion
      // uniform set and must be synced too, or a live retune would desync
      // a plant from its own shadow.
      motion: built.motion,
      kind,
      padPx,
    };
  }

  /**
   * Push the CURRENT sky into one vegetation source's shadow uniforms.
   *
   * Resolved on the CPU, once per frame per source, from the shared shadow
   * handle — the sky changes far slower than a frame, and every caster asking
   * the SAME handle is what makes a tree's shadow and a future token's shadow
   * agree without either declaring a sun of its own
   * (`effects/shadow-access.js`'s whole reason to exist).
   *
   * The penumbra arrives in world px and is converted to UV here using the
   * source's own placement size, because the blur taps live in texture space
   * while the throw lives in world space (the throw is applied as a real
   * world-space vertex translation — see `buildVegetationMaterial`).
   *
   * RETURNS whether this shadow can draw anything at all this frame — i.e.
   * whether its EFFECTIVE strength (post-handle, not the raw param) is above
   * zero. A zero-strength shadow emits `vec4(0,0,0,0)`, which under this
   * material's NormalBlending cannot change a pixel, yet it still rasterises a
   * quad padded to ~1.29x the item's area and pays all 15 texture fetches per
   * fragment. The caller ANDs this with the residency pass's own on-screen
   * decision so the mesh is simply not drawn instead
   * (docs/planning/Performance-Insights.md §4).
   *
   * The effective value is used rather than `params.shadowStrength` on purpose:
   * anything the shadow handle zeroes (night, a future per-caster cutoff) then
   * stops costing fill for free, without this function learning why.
   *
   * ⚠️ One non-colour difference, stated rather than buried: while the mesh
   * draws, its fragments also emit the renderer-global `attr` MRT default. If
   * that attachment turns out to be unblended (an open question — see the
   * `buf:scene.attr` investigation), not drawing would stop a zero-write that
   * was never intended to land. That direction is the safe one, and it only
   * applies at strength 0, which is not the default.
   *
   * @param {object} uniforms - a `built.shadow` uniform set.
   * @param {import('./vegetation.js').VegetationKind} kind
   * @param {object} placement
   * @param {object} params - the live resolved vegetation params.
   * @returns {boolean} true if the shadow has non-zero strength and is worth drawing.
   */
  function syncUniforms(uniforms, kind, placement, params) {
    // Takes the uniforms object DIRECTLY rather than an owner it unwraps
    // itself — 2026-07-23, after a real bug: Case 1's own call site passed
    // `t.shadow` (already the shadow record) while this function did
    // `entry.shadow?.uniforms`, silently reading `t.shadow.shadow` (never
    // set) and returning early forever. `uShadowStrength` never left its
    // build-time default of 0, so the shadow was correctly invisible — the
    // uniform genuinely never carried a non-zero value. Every call site now
    // passes the SAME shape (`something.uniforms`), so this cannot recur.
    if (!uniforms) return false;
    const shadowHandle = getShadowHandle();
    const cast = shadowHandle.forCaster({
      heightPx: kind.shadowHeightPx,
      strength01: params?.shadowStrength ?? 0,
    });
    const w = Math.max(1, Math.abs(placement?.width ?? 1));
    const h = Math.max(1, Math.abs(placement?.height ?? 1));

    // THE MAP-EDGE RAMP (2026-07-24, author: *"we need to address how these
    // shadows interact with the edge of the map to avoid producing a gap in
    // the shadow as it moves around the edge of the scene. I don't mind if we
    // have a gradient at the edge of the scene which prevents the shadow
    // being offset"*). Their own suggested cure, taken literally: near the
    // boundary the throw is scaled toward zero, so a plant at the edge parks
    // its shadow under itself instead of sliding it off the map and leaving a
    // hole where the shadow used to be. Evaluated at the tile's CENTRE (one
    // ramp per plant, not per vertex) — the shadow is a whole object and
    // should not be torn in half by the ramp crossing its middle.
    const cx = placement?.x ?? 0;
    const cy = placement?.y ?? 0;
    const ramp = edgeRamp01({ x: cx, y: cy, rect: dimensions.sceneRect, bandPx: params?.edgeFadeWidthPx ?? 0 });
    const offX = cast.offsetX * ramp;
    const offY = cast.offsetY * ramp;

    // THE SWEEP VECTOR, in this tile's UV space: the full throw. The fragment
    // sweeps art-UV from 0 to this, so t=0 is the plant's own footprint (the
    // ground contact) and t=1 is the tip. This single uniform replaced the old
    // `uShadowOffset` vertex translation entirely — the mesh no longer moves,
    // which is what turned a detached sliding copy into a real streak.
    uniforms.uShadowSmearUv.value.set(offX / w, offY / h);
    // Smear taper rises as the sun lowers — a noon shadow is a compact blob
    // with nothing to taper, a dusk shadow is a long streak that must fade
    // out at its tip. `dayFactor01` is NOT the right driver here (it tracks
    // day/night, not sun height); elevation is.
    const elev = Math.max(0, Math.min(90, shadowHandle.atmosphere.elevationDeg));
    uniforms.uShadowSmearTaper.value = VEG_SHADOW_SMEAR_TAPER_MAX * (1 - Math.sin((elev * Math.PI) / 180));

    uniforms.uShadowPenumbraUv.value.set(cast.penumbraPx / w, cast.penumbraPx / h);
    uniforms.uShadowStrength.value = cast.strength01;

    // THE LADDER FIX's own number (see `alphaAt`'s doc in
    // buildVegetationMaterial). Each smear station must cover the GAP to the
    // next one, or a caster thinner than that gap lands as a separate copy —
    // the detached "ladder" the author photographed at dawn. The gap, in the
    // art's own texels, is the throw divided by the station count; the mip
    // level whose texels are that wide is its base-2 log. Clamped at 0 (never
    // sharpen past the base level) and at a sane ceiling (a mip that coarse
    // is a featureless blob already, and asking past the chain's end is
    // undefined).
    //
    // THE STATION COUNT MUST MATCH WHAT THE SHADER ACTUALLY UNROLLED, not
    // always this module's own default — a resolved performance tier can build
    // a DIFFERENT tap count (vegetation-render.js#vegetationTierPlan), stashed
    // on this exact uniform bag as `smearTaps` by `attachTileShadow`/the Case-2
    // inline build. Falling back to `VEG_SHADOW_SMEAR_TAPS` only covers a
    // caller that predates the tier plan (or the Node test fixture below).
    const artTexelsPerWorldPx = uniforms.artTexelsPerWorldPx ?? 1;
    const taps = uniforms.smearTaps ?? VEG_SHADOW_SMEAR_TAPS;
    const gapTexels = (cast.offsetPx / taps) * artTexelsPerWorldPx;
    uniforms.uShadowSmearLod.value = Math.max(0, Math.min(VEG_SHADOW_MAX_SMEAR_LOD, Math.log2(Math.max(1, gapTexels))));

    return cast.strength01 > 0;
  }

  return Object.freeze({ attachTileShadow, syncUniforms });
}
