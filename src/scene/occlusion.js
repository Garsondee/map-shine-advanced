/**
 * @fileoverview scene/occlusion.js — the occlusion model: how a roof gets out of
 * the way so you can see (and click) the token underneath it.
 *
 * This is what makes overhead art usable rather than merely correct. Without it,
 * getting the layering right (scene/layer-order.js) produces a roof that
 * faithfully, permanently hides everything under it — technically accurate and
 * completely unplayable.
 *
 * Pure model only: mode semantics, the per-object weights, and the hover-fade
 * easing. No GPU, no Foundry globals, no DOM — all Node-testable. The screen-
 * space mask itself and the shader that consumes it live with the renderer.
 *
 * ## Foundry's design, which we adopt wholesale
 *
 * Verified against `client/canvas/layers/masks/occlusion.mjs`,
 * `client/canvas/primary/primary-occludable-object.mjs`, and the shader at
 * `client/canvas/rendering/shaders/samplers/primary/occlusion.mjs:16`.
 *
 * ONE RGBA screen-space mask carries all four modes at once:
 *
 *     R = Fade    G = Radial    B = Vision    A = Surface
 *
 * Each channel stores an **elevation index**, not a coverage value: occluders
 * (tokens, surfaces) draw their shapes with `mapElevation(elevation)` as the
 * channel value, composited with MIN blending so the LOWEST occluder wins at any
 * pixel. A drawable then tests, per pixel:
 *
 *     occluded = 1 - step(myElevation, maskValue)     // maskValue < mine → occlude me
 *     amount   = max over channels of (occluded[c] * myWeight[c])
 *     alpha   *= mix(unoccludedAlpha, occludedAlpha, amount)
 *
 * The elegance worth preserving: elevation comparison and shape coverage travel
 * in the SAME number. A roof at elevation 10 fades where a token at 5 stands,
 * and does not fade where a token at 20 stands, with no per-pair work — one
 * screen-space texture serves every drawable at every elevation.
 *
 * `mapElevation` quantises to at most **254 distinct elevations** (8-bit channel,
 * index 0 reserved). That is a real limit inherited on purpose: it is Foundry's,
 * and a scene with 254 distinct occluder elevations is not a thing.
 *
 * ## Why this is not blocked on Stage 5
 *
 * Occlusion needs token **documents** — position, elevation, and the vision
 * polygon Foundry already computes on the CPU — not token **rendering**. Keyhole
 * doesn't draw tokens yet (that's Stage 5's gameplay severance) and doesn't need
 * to: Foundry stays authoritative for vision (Keyhole.md §4.3), so this module
 * reads what's already there.
 *
 * @module scene/occlusion
 */

/**
 * Foundry's `CONST.OCCLUSION_MODES` (common/constants.mjs:1022), verbatim.
 *
 * These are **bitflags**, and in v14 a Tile's `occlusion.modes` is a **Set** that
 * gets OR'd into one value (`Tile#_refreshMesh`: `occlusion.modes.reduce((m, x)
 * => m |= x, NONE)`). A tile can legitimately be RADIAL|VISION at once. The
 * pre-v14 single `occlusion.mode` field is deprecated-but-shimmed; read `modes`.
 *
 * @enum {number}
 */
export const OCCLUSION_MODES = Object.freeze({
  /** Never fades, whatever stands under it. */
  NONE: 0,
  /** The WHOLE tile fades when a token moves under it. */
  FADE: 1,
  /** Partially revealed based on occluded surfaces (v14 Region surfaces). */
  SURFACE: 2,
  /** Reveals a disc around a token under it, sized by the token. */
  RADIAL: 4,
  /** Revealed by the token's field of vision — the "roof with windows" mode. */
  VISION: 8,
});

/** Index 0 is reserved as "no occluder"; 8-bit channels leave 254 usable slots. */
export const MAX_OCCLUSION_ELEVATIONS = 254;

/**
 * OR a Tile document's `occlusion.modes` Set into the single bitfield the
 * renderer uses. Replicates `Tile#_refreshMesh` (client/canvas/placeables/tile.mjs:364).
 *
 * @param {Iterable<number>|null|undefined} modes
 * @returns {number} a union of {@link OCCLUSION_MODES}.
 */
export function packOcclusionModes(modes) {
  let out = OCCLUSION_MODES.NONE;
  if (!modes) return out;
  for (const mode of modes) out |= mode | 0;
  return out;
}

/** @param {number} occlusionMode @returns {boolean} does this object participate in occlusion at all? */
export function isOccludable(occlusionMode) {
  return occlusionMode > OCCLUSION_MODES.NONE;
}

/**
 * Is this object eligible to hover-fade at all? Replicates `Tile#_refreshMesh`
 * (client/canvas/placeables/tile.mjs:365) exactly:
 *
 *     this.mesh.hoverFade = (this.mesh.occlusionMode !== M.NONE) && !(this.mesh.occlusionMode & M.SURFACE);
 *
 * Two real Foundry rules, both worth stating explicitly rather than trusting
 * the bitwise expression to read itself: a NONE-mode object never fades on
 * hover (nothing to reveal), and a SURFACE-mode object never does either —
 * SURFACE is "revealed by Region", not by the pointer, and Foundry excludes
 * it even when combined with another mode (SURFACE|RADIAL is still
 * ineligible). This is Foundry's own design, not a bug this project is
 * choosing to skip: SURFACE stays visually inert here regardless (this
 * codebase has no Region/Surfaces implementation — see this module's own
 * header, "Why this is not blocked on Stage 5"), so the SURFACE half of this
 * gate is currently unreachable in practice, but it is reproduced anyway
 * because RADIAL|SURFACE and FADE|SURFACE are real, authorable combinations
 * a map author can still set, and getting this gate right now is cheaper
 * than re-deriving it later once SURFACE stops being inert.
 *
 * @param {number} occlusionMode - union of {@link OCCLUSION_MODES}.
 * @returns {boolean}
 */
export function isHoverFadeEligible(occlusionMode) {
  return occlusionMode !== OCCLUSION_MODES.NONE && !(occlusionMode & OCCLUSION_MODES.SURFACE);
}

/**
 * Build the elevation → [0,1] mapping table used by the mask.
 *
 * Replicates `CanvasOcclusionMask#mapElevation` (occlusion.mjs:138) and the table
 * construction in `_updateOcclusionMask`: the sorted set of distinct occluder
 * elevations, truncated to 254. `mapElevation` then returns `(i + 1) / 255` for
 * the first table entry >= the queried elevation, or exactly 1 if the elevation
 * is above every entry.
 *
 * @param {number[]} occluderElevations - every occluder's elevation (unsorted, dupes fine).
 * @returns {number[]} ascending distinct elevations, capped at 254 entries.
 */
export function buildElevationTable(occluderElevations) {
  const distinct = Array.from(new Set(occluderElevations)).sort((a, b) => a - b);
  if (distinct.length === 0) return [-Infinity]; // Foundry's own empty-case sentinel
  distinct.length = Math.min(distinct.length, MAX_OCCLUSION_ELEVATIONS);
  return distinct;
}

/**
 * Map an elevation into the mask's [0,1] encoding. Binary search, exactly
 * Foundry's (occlusion.mjs:138).
 *
 * @param {number[]} table - from {@link buildElevationTable}.
 * @param {number} elevation
 * @returns {number} in [0, 1], 8-bit quantised.
 */
export function mapElevation(table, elevation) {
  let i = 0;
  let j = table.length - 1;
  if (elevation > table[j]) return 1;
  while (i < j) {
    const k = (i + j) >> 1;
    if (table[k] >= elevation) j = k;
    else i = k + 1;
  }
  return (i + 1) / 255;
}

/**
 * @typedef {object} OcclusionState
 * @property {number} fade - weight for the mask's R channel, 0..1.
 * @property {number} radial - weight for G, 0..1.
 * @property {number} vision - weight for B, 0..1.
 * @property {number} surface - weight for A, 0..1.
 */

/**
 * The per-object channel weights. Replicates
 * `PrimaryOccludableObject#updateOcclusionState`
 * (primary-occludable-object.mjs:199) exactly, including its two non-obvious
 * behaviors, both of which are deliberate in Foundry and worth keeping:
 *
 * 1. **VISION degrades to FADE when no vision source is active.** A roof set to
 *    "reveal by token vision" would otherwise be permanently opaque for a GM with
 *    nothing selected — so with no vision sources it falls back to fading whole.
 * 2. **hover-fade rides whichever channel is live.** It maxes into `vision` when
 *    the vision mask is active and into `fade` otherwise, rather than getting a
 *    channel of its own.
 *
 * Note `fade` is gated on the object's own `occluded` boolean (from
 * {@link testTokenOcclusion}) rather than on the mask, because FADE has no
 * spatial variation — the whole tile fades or it doesn't. That's why the mask's R
 * channel is a constant 0 ("occlude everywhere") in Foundry: the gate is here.
 *
 * @param {object} args
 * @param {number} args.occlusionMode - union of {@link OCCLUSION_MODES}.
 * @param {boolean} args.occluded - is a token currently under this object?
 * @param {boolean} args.visionActive - does the occlusion mask have any vision source?
 * @param {number} [args.hoverFadeAmount] - 0..1 from {@link updateHoverFade}.
 * @returns {OcclusionState}
 */
export function computeOcclusionState({ occlusionMode, occluded, visionActive, hoverFadeAmount = 0 }) {
  const M = OCCLUSION_MODES;
  const state = { fade: 0, radial: 0, vision: 0, surface: 0 };
  if (occlusionMode & M.FADE && occluded) state.fade = 1;
  if (occlusionMode & M.SURFACE) state.surface = 1;
  if (occlusionMode & M.RADIAL) state.radial = 1;
  if (occlusionMode & M.VISION) {
    if (visionActive) state.vision = 1;
    else if (occluded) state.fade = 1; // see this function's doc, point 1
  }
  if (visionActive) state.vision = Math.max(state.vision, hoverFadeAmount);
  else state.fade = Math.max(state.fade, hoverFadeAmount);
  return state;
}

/**
 * Does `token` occlude the object it's tested against? Replicates
 * `PrimaryOccludableObject#testOcclusion` (primary-occludable-object.mjs:268).
 *
 * The elevation test is **strict**: a token at exactly the object's elevation
 * does NOT occlude it (`token.elevation >= this.elevation → false`). That matters
 * for the common authoring case of a tile and a token both sitting at 0 — the
 * tile must not fade.
 *
 * `containsPoint` is supplied by the caller because a faithful hit-test is
 * alpha-thresholded against the real texture (Foundry's `containsCanvasPoint`
 * honours `texture.alphaThreshold`), which needs pixels this pure module has no
 * business holding.
 *
 * @param {object} args
 * @param {number} args.tokenElevation
 * @param {number} args.objectElevation
 * @param {Array<{x:number,y:number}>} args.testPoints - `Token#getOcclusionTestPoints()`.
 * @param {(p:{x:number,y:number}) => boolean} args.containsPoint - alpha-aware hit test.
 * @param {() => boolean} [args.boundsIntersect] - cheap early-out before any point test.
 * @returns {boolean}
 */
export function testTokenOcclusion({ tokenElevation, objectElevation, testPoints, containsPoint, boundsIntersect }) {
  if (tokenElevation >= objectElevation) return false;
  if (boundsIntersect && !boundsIntersect()) return false;
  for (const point of testPoints) {
    if (containsPoint(point)) return true;
  }
  return false;
}

/**
 * Does `grid` carry real, sampleable alpha data? The exact condition
 * {@link testItemHoverAlpha} treats as "no grid" (see its own FAIL OPEN
 * comment, just below) — factored out to its own name so
 * {@link testVegetationHoverAlpha} can test the identical condition for the
 * OPPOSITE (fail-CLOSED) purpose without a second, hand-copied version of it
 * silently drifting out of sync. Both callers are proven against this one
 * definition by this file's own test (`__tests__/occlusion.test.mjs`).
 *
 * @param {{w:number,h:number,data:Uint8Array}|null|undefined} grid
 * @returns {boolean}
 */
function hasUsableAlphaGrid(grid) {
  return !!(grid && grid.data && grid.w > 0 && grid.h > 0);
}

/**
 * Does a point land on this object's actual painted art, thickly enough to
 * count as "there" for a hit test? The CPU mirror of Foundry's real
 * `PrimarySpriteMesh#containsCanvasPoint`/`#containsLocalPoint`
 * (primary-sprite-mesh.mjs:230-267): sample the alpha at this point and
 * compare against the object's own alpha threshold — `alpha >=
 * textureAlphaThreshold`, strictly greater-or-equal, matching Foundry's own
 * `#getTextureAlpha(x,y) >= textureAlphaThreshold` exactly.
 *
 * The caller supplies `u`/`v` already converted to this object's own 0..1
 * quad-local UV space (`scene/world-quad.js#worldToQuadUv` is the renderer's
 * real inverse-placement math for that step) rather than this function
 * taking a world point + placement itself: this module stays free of any
 * coordinate-geometry dependency on principle (this file is occlusion
 * SEMANTICS; world-quad.js is coordinate geometry; each stays about one
 * thing, matching this module's own "no GPU, no Foundry globals, no DOM"
 * header claim — a placement import would not violate that literally, but
 * would blur the boundary for no real gain).
 *
 * `grid` is the item's coarse alpha grid over its ENTIRE source image
 * (`vt/coverage-mesh.js`'s own `{w,h,data}` shape — the SAME grid that
 * module's `cellGridSpan` maps image-pixel-space onto via `(pixel/imageDim)
 * * gridDim`; since UV **is** `pixel/imageDim` by construction, indexing the
 * grid at `floor(u*w), floor(v*h)` is that identical mapping collapsed to
 * UV, not a second one invented here).
 *
 * ⚠️ FAIL-OPEN IS LOAD-BEARING HERE AND MUST STAY (mythica-machina-press#470,
 * third round, 2026-09-03) — do not "fix" this by making it fail closed like
 * {@link testVegetationHoverAlpha}, below. This function's callers use a
 * missing grid to mean "test against the HOST's own bounds instead", which
 * is always at least as big as the real art — fail-open there costs at most
 * a slightly-too-generous hit region for however long the async grid fetch
 * takes. `testVegetationHoverAlpha` reuses this SAME comparison for a
 * DIFFERENT contract, where the grid isn't a generous proxy, it IS the whole
 * test — see that function's own doc for why fail-open is actively wrong
 * there. One primitive, two callers, two genuinely different correct
 * defaults for a missing grid — see {@link testVegetationHoverAlpha},
 * immediately below, for the one where fail-open is dangerous.
 *
 * @param {object} args
 * @param {number} args.u @param {number} args.v - quad-local UV, 0..1 when on the quad.
 * @param {{w:number,h:number,data:Uint8Array}|null|undefined} args.grid
 * @param {number} args.alphaThreshold - 0..1, the item's own alpha threshold
 *   (`item.alphaThreshold`, `foundry/scene-layers.js`'s `tile.texture
 *   ?.alphaThreshold ?? 0.75`).
 * @returns {boolean}
 */
export function testItemHoverAlpha({ u, v, grid, alphaThreshold }) {
  // Off the quad entirely (a rotated tile's AABB is looser than its real
  // shape) — never a hit, regardless of the grid.
  if (!(u >= 0) || u > 1 || !(v >= 0) || v > 1) return false;
  // FAIL OPEN: no grid (not yet arrived, or never will) is drawn as a full
  // quad everywhere else in this codebase (vt-pan-viewer.js's own
  // `requestItemAlphaGrid` doc: "every reader treats 'no grid' as 'draw the
  // whole quad'") — a roof whose coarse alpha hasn't landed yet must still
  // be hoverable, not permanently un-fadeable for however long that async
  // request takes.
  if (!hasUsableAlphaGrid(grid)) return true;
  const gx = Math.min(grid.w - 1, Math.max(0, Math.floor(u * grid.w)));
  const gy = Math.min(grid.h - 1, Math.max(0, Math.floor(v * grid.h)));
  const alpha01 = grid.data[gy * grid.w + gx] / 255;
  return alpha01 >= alphaThreshold;
}

/**
 * VEGETATION'S OWN HOVER HIT TEST (mythica-machina-press#470, THIRD round,
 * live regression reported 2026-09-02, fixed 2026-09-03 — author, verbatim:
 * *"No matter where the mouse is any place within the scene bounds the
 * trees/bushes fade out."*). Identical alpha comparison to
 * {@link testItemHoverAlpha} against the identical grid shape, but with the
 * OPPOSITE answer when no usable grid is available: this FAILS CLOSED (never
 * a hit) where that one deliberately fails open.
 *
 * ⚠️ DO NOT "FIX" THIS BACK TO FAIL-OPEN BY ANALOGY WITH `testItemHoverAlpha`
 * — that function's own doc explains why fail-open is correct THERE, and
 * this doc explains why the identical default is wrong HERE. They are not
 * the same question with one right answer; they are two different questions
 * that happen to share a comparison.
 *
 * WHY THE TWO MUST DISAGREE. `testItemHoverAlpha`'s fail-open default was
 * written for callers where "no grid" means "test against the HOST's own
 * bounds instead" — always at least as big as the real art, so the cost of
 * guessing wrong is a slightly-too-generous hit region for however long an
 * async grid fetch takes (that function's own doc, verbatim: "a roof whose
 * coarse alpha hasn't landed yet must still be hoverable, not permanently
 * un-fadeable"). This function backs a DIFFERENT caller
 * (`vegetationOverlayContainsWorldPoint`, vt-pan-viewer.js) that reuses the
 * SAME grid shape for a different purpose: the grid isn't a proxy for a
 * smaller shape nested inside a bigger one, it IS the entire test, sampled
 * against the shared HOST quad's own bounds/placement — and a Case-2
 * `_Tree`/`_Bush` overlay can be hosted on an entire Level's BACKGROUND
 * image (`ensureVegetationOverlay`'s own measured note: "`_Tree` paints
 * 11.9% of its 12000² canvas" — one mask painted across a whole floor, not
 * one Tile per plant). Failing open there does not mean "slightly too
 * generous" — it means "the entire visible scene counts as a hit, always",
 * which is structurally the SAME CLASS of bug that has now shipped broken
 * TWICE (mythica-machina-press#470's original follow-up, which tested the
 * host's own grid instead of the vegetation's, shipped, broke live, and was
 * REVERTED; and round 2, c753bb5c, which tested the vegetation's own grid
 * correctly, shipped, and STAYED shipped, but still fell through to
 * fail-open whenever that grid came back missing — no revert needed this
 * time, since this fix lands in place of one). A vegetation entry with
 * no real alpha data to test against should simply never hover-fade —
 * indistinguishable from ordinary, unfaded vegetation, until real data
 * arrives — which is a vastly better failure mode than fading everywhere,
 * always, forever.
 *
 * CONFIRMED BY READING (2026-09-03), not assumed: `entry.coverageGrid` can
 * be null while `entry.status === 'ready'` (the mesh drawing normally)
 * through an entirely SILENT path, not an exceptional one —
 * `requestCoarseAlphaGrid` (vt/compressed-textures.js) resolves `null`,
 * NEVER rejects, for every one of: the worker failing to construct, a
 * fetch/decode failure for this one url happening INSIDE the worker (caught
 * there and turned into `{ok:false}`, never a thrown error on this side), or
 * `Worker#onerror` firing at any point in the page session for any job
 * (which also permanently latches that module's own `_unavailable` flag —
 * never reset for the rest of the session). `ensureVegetationOverlay`'s own
 * `try { await requestCoarseAlphaGrid(...) } catch { ingestLog.warn(...) }`
 * only fires on a THROWN rejection, which this degradation-first contract
 * ("DEGRADATION-FIRST... the caller gets `null`", compressed-textures.js's
 * own header) is specifically designed never to produce — so that existing
 * log line does not, in practice, catch this outcome. (`ensureVegetationOverlay`
 * now also logs the resolved-null outcome directly, once per entry, for
 * exactly this reason.) What remains genuinely UNCONFIRMED: which of the
 * failure paths above actually fired in the author's live session — that
 * would need the new diagnostic's output from a real repro, not a read of
 * the source. This fix does not depend on knowing which one it was.
 *
 * @param {object} args
 * @param {number} args.u @param {number} args.v - quad-local UV, 0..1 when on the quad.
 * @param {{w:number,h:number,data:Uint8Array}|null|undefined} args.grid - the
 *   VEGETATION's own coverage grid (`entry.coverageGrid`) — never the host's.
 * @param {number} args.alphaThreshold
 * @returns {boolean}
 */
export function testVegetationHoverAlpha({ u, v, grid, alphaThreshold }) {
  if (!hasUsableAlphaGrid(grid)) return false; // FAIL CLOSED — see this function's own doc for why
  return testItemHoverAlpha({ u, v, grid, alphaThreshold });
}

/**
 * @typedef {object} HoverFadeState
 * @property {boolean} hovered - is the pointer over this object right now?
 * @property {number} hoveredTime - when `hovered` last changed, in ms.
 * @property {boolean} faded - the settled state.
 * @property {boolean} fading - mid-animation?
 * @property {number} fadingTime - when the current animation started, in ms.
 * @property {number} occlusion - the 0..1 output.
 */

/** A fresh hover-fade state. */
export function createHoverFadeState() {
  return { hovered: false, hoveredTime: 0, faded: false, fading: false, fadingTime: 0, occlusion: 0 };
}

/**
 * Foundry's `CONFIG.Canvas.hoverFade` (client/config.mjs:1125), verbatim —
 * verified directly against the vendored v14.367.0 client source (both the
 * unbundled `client/config.mjs:1125` and the built `public/scripts/
 * foundry.mjs:217661` agree). `duration` here is **750**, not the 500 an
 * earlier pass at wiring this up assumed — double-check against the
 * vendored source before trusting a remembered number, exactly the mistake
 * this constant now makes structurally impossible to repeat: every caller
 * reads it from here rather than re-typing the literal.
 */
export const HOVER_FADE_CONFIG = Object.freeze({ delay: 250, duration: 750 });

/** Foundry's `CanvasAnimation.easeInOutCosine`. */
export function easeInOutCosine(t) {
  return (1 - Math.cos(Math.PI * t)) * 0.5;
}

/**
 * Advance the hover-fade animation one frame. Replicates
 * `PrimaryOccludableObject#updateHoverFadeState` (primary-occludable-object.mjs:223).
 *
 * This is the behavior the author specifically called out: hovering a roof fades
 * it so you can see and click the token beneath. The `delay` before fading starts
 * is what stops a roof strobing as the pointer crosses it on the way somewhere
 * else, and the mid-flight reversal below is what stops it snapping when you
 * change your mind halfway through.
 *
 * Mutates and returns `state` (matching Foundry, which mutates per frame — this
 * runs for every occludable object every frame, so allocating is the wrong call).
 *
 * @param {HoverFadeState} state
 * @param {number} time - now, in ms (the ticker clock).
 * @param {{delay:number, duration:number}} config - Foundry's `CONFIG.Canvas.hoverFade`.
 * @returns {HoverFadeState} the same object.
 */
export function updateHoverFade(state, time, { delay, duration }) {
  if (state.fading) {
    if (time - state.fadingTime >= duration) state.fading = false;
  } else if (state.faded !== state.hovered) {
    const dt = time - state.hoveredTime;
    if (dt >= delay) {
      state.faded = state.hovered;
      if (dt - delay < duration) {
        state.fading = true;
        state.fadingTime = time;
      }
    }
  }
  let occlusion = 1;
  if (state.fading) {
    // Direction reversed mid-animation (pointer left before the fade finished):
    // reflect the elapsed time about the midpoint so the animation continues from
    // where it visually IS, instead of restarting and popping.
    if (state.faded !== state.hovered) {
      state.faded = state.hovered;
      state.fadingTime = time - (state.fadingTime + duration - time);
    }
    occlusion = easeInOutCosine((time - state.fadingTime) / duration);
  }
  state.occlusion = state.faded ? occlusion : 1 - occlusion;
  return state;
}

/**
 * The final alpha multiplier for one pixel — the CPU mirror of the shader's own
 * four lines (occlusion.mjs:16). Exists so the model can be tested for real
 * under Node rather than only asserted about in a comment; the shader remains
 * the thing that actually runs.
 *
 * @param {object} args
 * @param {{r:number,g:number,b:number,a:number}} args.maskSample - the mask at this pixel, 0..1 per channel.
 * @param {number} args.occlusionElevation - this object's {@link mapElevation} value.
 * @param {OcclusionState} args.state
 * @param {number} args.unoccludedAlpha
 * @param {number} args.occludedAlpha
 * @returns {number} the alpha multiplier.
 */
export function computeOcclusionAlpha({ maskSample, occlusionElevation, state, unoccludedAlpha, occludedAlpha }) {
  // step(edge, x) is 0 when x < edge, else 1. `1 - step` therefore means "the
  // occluder recorded here sits BELOW me", which is exactly when I should get
  // out of the way.
  const step = (edge, x) => (x < edge ? 0 : 1);
  const occ = {
    r: 1 - step(occlusionElevation, maskSample.r),
    g: 1 - step(occlusionElevation, maskSample.g),
    b: 1 - step(occlusionElevation, maskSample.b),
    a: 1 - step(occlusionElevation, maskSample.a),
  };
  const amount = Math.max(occ.r * state.fade, occ.g * state.radial, occ.b * state.vision, occ.a * state.surface);
  return unoccludedAlpha + (occludedAlpha - unoccludedAlpha) * amount; // mix()
}
