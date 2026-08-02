/**
 * VEGETATION — the PURE half: detection + the vertex-displacement curve.
 * No THREE, no TSL — Node-tested (CONVENTIONS §4), mirroring the split
 * `diag/wind-field-overlay.js` already uses (pure grid/geometry math here;
 * the mesh/material construction is browser-only glue in `vt/vt-pan-viewer.js`).
 *
 * ============================================================================
 * TWO ATTACHMENT MODES — both required (author, 2026-07-23)
 * ============================================================================
 *
 * 1. A TILE WHOSE OWN TEXTURE is `_Tree`/`_Bush`-suffixed (an artist drops
 *    `oak-cluster_Tree.webp` directly onto the map as a tile — the file IS
 *    the vegetation, no separate albedo). {@link detectSelfVegetationKind}
 *    is a pure string match against the item's own src, reusing the
 *    catalog's suffix list (`scene/mask-catalog.js` via the `scene/` door —
 *    `masks/authority-only` forbids spelling `_Tree`/`_Bush` here directly).
 *    No discovery, no probing — the answer is sitting in the URL already.
 *
 * 2. A PLAIN ALBEDO WITH A DISCOVERED SIBLING FILE (V2's original
 *    convention: `path/base.webp` + `path/base_Tree.webp`) — this needs an
 *    actual file-existence lookup, which is NOT this module's job. See
 *    `boot.js`'s discovery-extension (Vegetation.md's Case 2): the sibling
 *    URL, once found, is loaded as its own overlay texture by the SAME
 *    THREE-glue path case 1 uses — this module has nothing further to add
 *    for that case, since "does a sibling file exist" is a network question,
 *    not a pure one.
 *
 * ============================================================================
 * NO PER-MESH PHASE HASH — DELIBERATELY (the V2 reflex this project keeps
 * catching itself reaching for)
 * ============================================================================
 *
 * V2 needed a per-island phase hash because ITS wind was one global scalar
 * with zero spatial variation — every island would otherwise sway in
 * lockstep. `world/wind-access.js`'s handle has no such gap: `sampleWind`'s
 * own gust/flutter/turbulence noise is already a function of WORLD POSITION
 * (`world/wind-field.js#sampleWind`'s own `sx`/`sy` terms), so two meshes at
 * two different positions already read two different, organically-varying
 * leans from ONE `handle.node()` call each, with no extra hash needed. Adding
 * one here would be pure redundant complexity — the decorrelation this
 * effect wants is already a property of the field it reads.
 *
 * @module effects/vegetation-render
 */

import { maskKindById, makeLayerKey, compareLayerKeys, SORT_LAYERS } from '../scene/index.js';
import { VEGETATION_KINDS } from './vegetation.js';
import { VEG_SHADOW_SMEAR_TAPS } from './vegetation-shadow-subsystem.js';

/** Strip query/hash/directory/extension, case-preserved. Deliberately tiny and
 * local rather than importing `foundry/mask-discovery.js#splitArtUrl` — that
 * function returns a richer {dir,base,ext} shape for sibling-file candidate
 * generation (boot.js's job, case 2); this only ever needs "does the name
 * itself end with a suffix", and pulling in a whole zone door for four lines
 * of string-splitting would be the premature-abstraction mistake in reverse.
 * @param {string} url
 * @returns {string}
 */
function basenameNoExt(url) {
  const clean = String(url ?? '')
    .split('?')[0]
    .split('#')[0];
  const slash = clean.lastIndexOf('/');
  const file = slash >= 0 ? clean.slice(slash + 1) : clean;
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
}

/**
 * Case 1 (see this module's own header): does this URL's OWN basename already
 * end with a declared vegetation kind's mask suffix? Case-insensitive (art
 * pipelines mix case; `foundry/mask-discovery.js#matchMaskFiles` makes the
 * identical choice for the same reason — Windows-hosted servers serve
 * case-insensitively).
 *
 * @param {string} srcUrl - an item's own texture URL (e.g. a tile's `.src`).
 * @param {ReadonlyArray<import('./vegetation.js').VegetationKind>} [kinds]
 * @returns {import('./vegetation.js').VegetationKind|null} the matching kind,
 *   or null — never throws on a URL with no match (the overwhelmingly common
 *   case, every ordinary tile).
 */
export function detectSelfVegetationKind(srcUrl, kinds = VEGETATION_KINDS) {
  const base = basenameNoExt(srcUrl).toLowerCase();
  if (!base) return null;
  for (const kind of kinds) {
    const catalogKind = maskKindById(kind.maskKindId);
    if (!catalogKind) continue; // a misconfigured kind — validateVegetationKinds() catches this in tests, not here
    for (const suffix of catalogKind.suffixes) {
      if (base.endsWith(suffix.toLowerCase())) return kind;
    }
  }
  return null;
}

/**
 * Validate {@link VEGETATION_KINDS} against the real catalog — every declared
 * `maskKindId` must resolve, and (since `detectSelfVegetationKind` matches
 * whichever kind's suffix comes first) no two kinds may share a suffix. Pure
 * data validation, the same posture `validateMaskCatalog`/
 * `validateEffectManifest` already take toward their own declarations: a
 * malformed table is a RED TEST, never a runtime surprise.
 *
 * @param {ReadonlyArray<import('./vegetation.js').VegetationKind>} [kinds]
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateVegetationKinds(kinds = VEGETATION_KINDS) {
  const errors = [];
  const seenSuffixes = new Map(); // suffix (lowercase) -> kind id
  for (const kind of kinds) {
    const catalogKind = maskKindById(kind.maskKindId);
    if (!catalogKind) {
      errors.push(`kind '${kind.id}': maskKindId '${kind.maskKindId}' is not declared in scene/mask-catalog.js`);
      continue;
    }
    for (const suffix of catalogKind.suffixes) {
      const key = suffix.toLowerCase();
      const owner = seenSuffixes.get(key);
      if (owner && owner !== kind.id) {
        errors.push(`suffix '${suffix}' is reachable from both '${owner}' and '${kind.id}' — detection is ambiguous`);
      }
      seenSuffixes.set(key, kind.id);
    }
    if (!(Number.isFinite(kind.swayMultiplier) && kind.swayMultiplier >= 0)) {
      errors.push(`kind '${kind.id}': swayMultiplier must be a finite number >= 0`);
    }
    if (!Number.isFinite(kind.renderOrderNudge)) {
      errors.push(`kind '${kind.id}': renderOrderNudge must be a finite number`);
    }
    // A fraction OUTSIDE 0..1 would place the overlay outside its own floor's
    // band — i.e. sorted into a DIFFERENT floor's art. That is never a tuning
    // choice, always a typo, and it fails as a RED TEST rather than as a
    // baffling "my bushes render on the floor above" report.
    if (
      !(
        Number.isFinite(kind.passiveElevationFraction) &&
        kind.passiveElevationFraction >= 0 &&
        kind.passiveElevationFraction <= 1
      )
    ) {
      errors.push(`kind '${kind.id}': passiveElevationFraction must be a finite number within 0..1`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/* ============================================================================
 * THE FOLD-FREE FLUTTER BOUND (2026-08-01)
 * ============================================================================
 * Author-reported, with a screenshot at 100% wind: *"when vegetation flutters
 * at high wind speed it just liquifies"* — canopies stop reading as foliage and
 * turn into flowing streaks with the ink linework stirred away.
 *
 * WHY IT LIQUIFIES, AND WHY "IT PRESERVES AREA" WAS NOT PROTECTION. Flutter is
 * a domain warp: the fragment samples the art at `uv + d(uv)`. The displacement
 * `d` comes from `curlNoise2D`, which is divergence-free — and that property is
 * real but INFINITESIMAL. Divergence-free says the flow field conserves area
 * under an instantaneous push; it says nothing about a FINITE displacement.
 * Once the displacement's own gradient approaches 1, neighbouring samples cross
 * over each other, the map `x → x + d(x)` stops being injective, and the image
 * folds onto itself. Folding is exactly what "liquify" looks like, and no
 * amount of divergence-freeness prevents it.
 *
 * THE ACTUAL BOUND. For a displacement of amplitude `A` built from noise whose
 * features span a wavelength `λ`, the gradient is of order `2π·A/λ`, so the map
 * stays injective while
 *
 *     A  <  λ / 2π       ( ≈ 0.159 λ )
 *
 * The bug is that the shipped cap was a FIXED number in UV space
 * (`VEG_FLUTTER_UV_CAP = 0.005`) while the noise's wavelength is set in WORLD
 * space by `flutterSpaceFreq × flutterScale`. The two were never coupled, so
 * the safety margin silently depended on how big the tile happened to be and on
 * whatever the author had done to the frequency dial — a units mismatch, not a
 * mistuned number, which is why the previous round of retuning the amplitude
 * down did not close it.
 * ==========================================================================*/

/**
 * Fraction of a wavelength the flutter displacement may reach. Below the
 * theoretical `1/2π ≈ 0.159` fold threshold with real margin, because the bound
 * is an order-of-magnitude estimate: the true gradient of a curl-noise field
 * has peaks above its RMS, and the amplitude is summed with the bulk sway that
 * is displacing the same vertices.
 */
export const VEG_FLUTTER_FOLD_SAFETY = 0.11;

/**
 * The largest flutter displacement, in WORLD px, that provably cannot fold the
 * art at a given noise frequency.
 *
 * This is the whole fix for the liquify: instead of a fixed cap that is safe at
 * one tile size and one frequency setting, the ceiling is DERIVED from the
 * frequency actually in use, so cranking "Flutter frequency" tightens the
 * amplitude automatically and the warp stays injective at every setting. The
 * shader mirrors this exact expression with `spaceFreq` as a live node — see
 * `vt-pan-viewer.js#buildVegetationMaterial`.
 *
 * @param {number} spaceFreq - the noise's world→noise scale
 *   (`kind.flutterSpaceFreq × flutterScale`); one feature spans `1/spaceFreq`
 *   world px.
 * @param {{safety?: number}} [opts]
 * @returns {number} world px. `Infinity` is never returned — a zero/degenerate
 *   frequency means "no spatial variation at all", which cannot fold anything,
 *   but a caller multiplying by Infinity would get NaN, so it clamps to 0
 *   (a constant offset carries no shimmer and is not worth drawing).
 */
export function flutterFoldFreeAmplitudePx(spaceFreq, { safety = VEG_FLUTTER_FOLD_SAFETY } = {}) {
  const f = Number(spaceFreq);
  if (!Number.isFinite(f) || f <= 1e-6) return 0;
  return safety / f;
}

/**
 * WHERE THIS KIND SORTS — its passive elevation inside the host floor's band.
 *
 * See `VegetationKind#passiveElevationFraction` for WHY vegetation sorts at its
 * own elevation instead of its host's (the author-ruled exception to the
 * host-relative render-order rule).
 *
 * Returns `null` — NOT a guessed number — when the band is unbounded or
 * inverted. `top` is `+Infinity` for any Level with no declared ceiling
 * (Foundry's own `Level#prepareBaseData` normalisation, which
 * `foundry/scene-layers.js#levelElevation` replicates) and `bottom` is
 * `-Infinity` for one with no declared floor, so "no usable band" is ORDINARY
 * DATA, not an edge case: a scene whose author never set an elevation band on
 * their Level hits this on every single item. `bottom + (top - bottom) * f`
 * would return `Infinity` or `NaN` there and sort the overlay above (or
 * nowhere near) the entire scene — so the caller falls back to the old
 * host-relative nudge and REPORTS it, rather than rendering a scene-destroying
 * number. That is the same posture `floorCeilings` already takes toward an
 * undeclared ceiling: surface the +Infinity so the author can set a band,
 * never chase a silent wrong answer.
 *
 * A ZERO-HEIGHT band (`bottom === top`, a legitimate Foundry Level) is fine and
 * needs no special case — every fraction collapses onto that one elevation, so
 * vegetation and its floor's art share it and `sortLayer` separates them.
 *
 * @param {import('./vegetation.js').VegetationKind} kind
 * @param {{bottom: number, top: number}|null|undefined} band - the host floor's
 *   elevation band (`foundry/scene-layers.js#floorElevationBands`, or a
 *   `getActiveSceneFloors()` floor's `{elevationBottom, elevationTop}` mapped
 *   onto this shape by the caller).
 * @returns {number|null} the sort elevation, or null if the band is unusable.
 */
export function vegetationPassiveElevation(kind, band) {
  const bottom = band?.bottom;
  const top = band?.top;
  if (!Number.isFinite(bottom) || !Number.isFinite(top)) return null;
  if (top < bottom) return null; // an inverted band is malformed data, not a band
  const fraction = kind?.passiveElevationFraction;
  if (!Number.isFinite(fraction)) return null;
  return bottom + (top - bottom) * fraction;
}

/**
 * THE OVERLAY'S `renderOrder`, resolved through THE LAW rather than nudged.
 *
 * `sortByLayer` stamps every real drawable with `renderOrder = its index` — a
 * DENSE integer sequence. That density is exactly why the old
 * `host.renderOrder + kind.renderOrderNudge` could never work: the next
 * drawable above the host is always `host + 1`, and every nudge is < 1, so ANY
 * tile sorting above the host beat the vegetation by construction (the
 * author's 2026-08-01 report: a tile at elevation 0 / sort 1 drawing over
 * every bush and tree).
 *
 * So instead of inventing an offset, this asks the real comparator where the
 * vegetation's OWN key belongs in the already-sorted list. If `n` real
 * drawables sort below it they occupy `renderOrder` 0..n-1, so `n - 0.5` lands
 * the overlay strictly between `n-1` and `n` — the correct slot, expressed in
 * the same numbering everything else uses. No band, no capacity, no drift from
 * the law: change the comparator and this follows it automatically.
 *
 * `SORT_LAYERS.SCENE_EFFECTS` (250 < `TILES` 500) is what makes a TIE go to the
 * tile, which is the author's own rule — *"tiles at 10 would render above the
 * _Bush because they beat the priority"*. It also means the overlay sits above
 * level art (`SCENE` 0) at the same elevation, so a tree at its floor's top
 * draws over that floor's foreground/roof art. That is a real behaviour change
 * from the host-relative era and is deliberate: an author who wants roof art
 * above a canopy puts it on a TILE at the floor top (`TILES` 500 > 250).
 *
 * @param {ReadonlyArray<{key: object, renderOrder: number}>} sortedItems - the
 *   draw list AFTER `sortByLayer`, still in sorted order.
 * @param {{key?: object, renderOrder: number}} hostItem - the drawable this
 *   overlay is painted onto; used only for the fallback and the tiebreak.
 * @param {import('./vegetation.js').VegetationKind} kind
 * @param {{bottom: number, top: number}|null|undefined} band - host floor band.
 * @returns {{renderOrder: number, elevation: number|null, fellBack: boolean}}
 *   `fellBack` is true when the band was unusable and the legacy host-relative
 *   nudge was used — the caller REPORTS that rather than swallowing it.
 */
export function vegetationOverlayRenderOrder(sortedItems, hostItem, kind, band) {
  const elevation = vegetationPassiveElevation(kind, band);
  if (elevation === null) {
    return {
      renderOrder: (hostItem?.renderOrder ?? 0) + (kind?.renderOrderNudge ?? 0),
      elevation: null,
      fellBack: true,
    };
  }
  const key = makeLayerKey({
    elevation,
    sortLayer: SORT_LAYERS.SCENE_EFFECTS,
    sort: 0,
    zIndex: 0,
    // Inherit the HOST's tiebreak so two overlays that somehow tie on all four
    // real components still resolve deterministically (and identically on every
    // machine, every frame) instead of depending on iteration luck.
    tiebreak: hostItem?.key?.tiebreak ?? 0,
  });
  // The list is already sorted by this very comparator, so the count of
  // strictly-below entries IS the insertion index. A linear scan is honest here
  // — draw lists are tens of items, and a binary search would need the list's
  // sortedness to be re-proven at every call site that ever passes a filtered
  // copy.
  let below = 0;
  for (const it of sortedItems ?? []) {
    if (it?.key && compareLayerKeys(it.key, key) < 0) below++;
  }
  return { renderOrder: below - 0.5, elevation, fellBack: false };
}

/**
 * THE VERTEX-DISPLACEMENT CURVE — how much of the sampled wind lean reaches a
 * point at normalized height `v` up the mesh (0 = root/bottom edge, pinned;
 * 1 = canopy top/far edge, full sway). Quadratic ease-IN, not linear: real
 * canopy mass resists near its base and whips disproportionately at the tip,
 * so the bottom HALF of a quad should move noticeably less than a linear ramp
 * would give it, not just "a bit less" — `v*v` halves the midpoint's own
 * weight (0.25 vs 0.5) while leaving both ends exactly pinned/full. Cheap
 * (one multiply) and monotonic, which is all a Tier-1 rigid-mesh sway needs;
 * a real branch-bend curve is Tier 2's job once clump differentiation exists
 * (see `effects/vegetation.js`'s own `deferredRungs`).
 *
 * @param {number} v - 0..1 (values outside are clamped, never extrapolated —
 *   a UV can legitimately read slightly outside [0,1] at a seam).
 * @returns {number} 0..1.
 */
export function heightWeight01(v) {
  const c = v < 0 ? 0 : v > 1 ? 1 : v;
  return c * c;
}

/**
 * World px per vegetation mesh vertex — the tessellation target. Roughly one
 * vertex per tree-ish patch, which is what makes neighbouring plants able to
 * disagree about the wind at all.
 *
 * TIGHTENED 2026-07-23 (was 160, live-test author: "I can still see a lot of
 * polygon lines developing at high sway") — `vt-pan-viewer.js#build
 * VegetationMaterial` now samples wind ONCE per clump cell and moves every
 * vertex in that cell IDENTICALLY (the rigid-clump fix for gale self-
 * intersection), so the visible facets are the mesh's own triangle edges
 * crossing a clump-cell BOUNDARY, where displacement jumps discontinuously
 * between two differently-jittered cells. A coarse mesh (few vertices per
 * clump cell, `VEGETATION_VERTEX_SPACING_PX` ≈ `clumpSizePx`) spans that jump
 * across one or two huge triangles — visibly faceted. A finer mesh spreads
 * the SAME jump across many small triangles, and gives each clump cell's
 * OWN rigid interior enough vertices to actually read as one smooth,
 * undistorted patch rather than a single point.
 */
export const VEGETATION_VERTEX_SPACING_PX = 60;
/** Never tessellate below this (a small bush tile still wants a little give). */
export const VEGETATION_MIN_SEGMENTS = 4;
/**
 * Hard ceiling on segments per axis. 128 ⇒ 129² = 16,641 vertices for a whole
 * 12,000px map background — still trivial for a vertex stage (this is
 * WebGPU vertex-stage work, not a per-fragment cost), and bounded so a
 * gigantic map cannot silently turn one overlay into a million-vertex mesh.
 * Raised alongside the tightened spacing above, for the same reason.
 */
export const VEGETATION_MAX_SEGMENTS = 128;

/**
 * How many grid segments per axis this vegetation source should tessellate to.
 *
 * ============================================================================
 * WHY TESSELLATION IS THE FIX FOR "EVERYTHING SWAYS IDENTICALLY"
 * ============================================================================
 *
 * Author, 2026-07-23: *"All trees/bushes sway in the exact same direction the
 * exact same amount at the exact same time."* The mechanism was not a tuning
 * problem — the overlay was a FOUR-VERTEX quad, so a `_Tree` mask painted
 * across a whole map got exactly ONE wind sample for the entire forest. No
 * amount of parameter tuning can make one vector into many.
 *
 * Subdividing the quad gives each vertex its own world position, and
 * `foundry/scene-geometry.js#computeQuadCorners` already returns WORLD-space
 * corners with no mesh transform applied — so in the vertex shader
 * `positionLocal.xy` IS the world position, and every vertex can sample the
 * shared wind field exactly where it actually stands. No new attribute, no new
 * uniform, no CPU mask analysis. That is the whole fix.
 *
 * V2 reached the same conclusion (`legacy/compositor-v2/effects/
 * vegetation-clump-field.js#windDisplacedMeshSegments` returns 8–16 segments)
 * — kept here because it was right, with the resolution now derived from real
 * world size rather than texture dimensions.
 *
 * @param {number} worldW - the source's world-space width (px).
 * @param {number} worldH - world-space height (px).
 * @returns {number} segments per axis; the mesh is (n+1)² vertices.
 */
export function vegetationMeshSegments(worldW, worldH) {
  const w = Number.isFinite(worldW) ? Math.abs(worldW) : 0;
  const h = Number.isFinite(worldH) ? Math.abs(worldH) : 0;
  const longest = Math.max(w, h);
  if (!(longest > 0)) return VEGETATION_MIN_SEGMENTS;
  const target = Math.round(longest / VEGETATION_VERTEX_SPACING_PX);
  return Math.max(VEGETATION_MIN_SEGMENTS, Math.min(VEGETATION_MAX_SEGMENTS, target));
}

/**
 * Build a tessellated quad's geometry buffers from its four WORLD-space
 * corners. Pure — returns plain typed arrays; the caller wraps them in a
 * `BufferGeometry` (this module stays THREE-free, CONVENTIONS §4).
 *
 * Corners arrive in `computeQuadCorners`' own order — UV (0,0), (1,0), (1,1),
 * (0,1) — and interior points are BILINEAR between them, so a rotated or
 * non-axis-aligned placement tessellates correctly rather than being
 * approximated by its bounding box. Winding matches `QUAD_INDICES`'
 * (0,1,2)/(0,2,3) convention per cell, so the tessellated mesh and the plain
 * 4-vertex quad face the same way.
 *
 * @param {Array<{x:number, y:number}>} corners - exactly 4, world space.
 * @param {number} segments - per axis, >= 1.
 * @returns {{positions: Float32Array, uvs: Float32Array, indices: Uint32Array, vertexCount: number}}
 */
export function buildTessellatedQuadGeometry(corners, segments) {
  if (!Array.isArray(corners) || corners.length !== 4) {
    throw new Error(`vegetation: expected 4 world corners, got ${corners?.length}`);
  }
  const n = Math.max(1, Math.floor(Number(segments) || 1));
  const side = n + 1;
  const vertexCount = side * side;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array(n * n * 6);

  const [c00, c10, c11, c01] = corners;
  for (let j = 0; j < side; j++) {
    const v = j / n;
    for (let i = 0; i < side; i++) {
      const u = i / n;
      // Bilinear: interpolate along the v=0 and v=1 edges, then between them.
      const topX = c00.x + (c10.x - c00.x) * u;
      const topY = c00.y + (c10.y - c00.y) * u;
      const botX = c01.x + (c11.x - c01.x) * u;
      const botY = c01.y + (c11.y - c01.y) * u;
      const idx = j * side + i;
      positions[idx * 3] = topX + (botX - topX) * v;
      positions[idx * 3 + 1] = topY + (botY - topY) * v;
      positions[idx * 3 + 2] = 0; // flat composite — see buildQuadPositions' own z=0 note
      uvs[idx * 2] = u;
      uvs[idx * 2 + 1] = v;
    }
  }

  let t = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * side + i;
      const b = a + 1;
      const c = a + side + 1;
      const d = a + side;
      indices[t++] = a;
      indices[t++] = b;
      indices[t++] = c;
      indices[t++] = a;
      indices[t++] = c;
      indices[t++] = d;
    }
  }

  return { positions, uvs, indices, vertexCount };
}

/**
 * THE PERFORMANCE-TIER PLAN — one vegetation rung translated into the two
 * knobs that actually cost something. Pure, total, Node-tested (via
 * `effect-tier.test.mjs`'s own anti-drift block — the same home
 * `candleTierPlan`'s equivalent check lives in, not a local test here); the
 * effect's ladder (`vegetation.js` `VEGETATION.tiers`) is the prose, this is
 * the arithmetic, index-aligned.
 *
 * `flutterEnabled` gates the ENTIRE per-fragment curl-noise block in
 * `buildVegetationMaterial` — built as a JS `if` around its construction
 * (Effects.md Law 4: a tier that is off must not be CONSTRUCTED, because a
 * uniform set to zero still executes every pixel). `shadowEnabled` gates
 * whether a tile/overlay gets a ground-shadow mesh built AT ALL;
 * `shadowSmearTaps` is how many smear stations THAT build unrolls into its
 * shader loop when it does. All three are graph/mesh-BUILD-time decisions,
 * resolved once when a tile or overlay loads — the same already-accepted
 * limitation `vegetation.js`'s own `live-disable-for-self-vegetation-tiles`
 * deferred rung documents for sway/wind response: a live performance-profile
 * change reaches an already-built tile/overlay only on its next scene load,
 * never retroactively.
 *
 * ⚠️ TIER 3 REPRODUCES TODAY'S SHIPPED BEHAVIOUR EXACTLY — flutter on, the
 * shadow on at `VEG_SHADOW_SMEAR_TAPS` (6) stations — and tier 3 is what the
 * DEFAULT profile (`standard`) resolves to. That is deliberate: turning this
 * system on must not silently restyle every existing scene. Below `standard`
 * the picture genuinely simplifies (no shadow at all below `performance`, no
 * flutter below `low`); above it the shadow's smear gets finer than it has
 * ever been.
 *
 * @param {number} tier - a resolved rung (effect-cascade.js#resolveEffectTier).
 *   Clamped into the ladder, so a stale or malformed value degrades to a rung
 *   that exists rather than producing an uncompilable quality.
 * @returns {{flutterEnabled: boolean, shadowEnabled: boolean, shadowSmearTaps: number}}
 */
export function vegetationTierPlan(tier) {
  const n = Number.isFinite(tier)
    ? Math.max(0, Math.min(VEGETATION_TIER_PLANS.length - 1, Math.floor(tier)))
    : VEGETATION_DEFAULT_TIER;
  return VEGETATION_TIER_PLANS[n];
}

/**
 * The rung an ABSENT or malformed tier falls back to — deliberately today's
 * shipped look, never the cheapest one. Both alternatives are dangerous in
 * opposite directions (candle-flame-geometry.js#CANDLE_DEFAULT_TIER's own doc
 * has the full argument): falling back to 0 would silently strip flutter and
 * shadows from every scene an unwired caller touches; falling back to the top
 * would silently hand a weak machine the most expensive rung.
 *
 * NOT a hardcoded 3 in spirit, only in value: `effect-tier.test.mjs` asserts
 * this equals what the DEFAULT performance profile resolves the real
 * vegetation ladder to, so re-tuning a rung's `fromProfile` cannot leave this
 * constant pointing at a different look than the ladder does.
 */
export const VEGETATION_DEFAULT_TIER = 3;

/**
 * The rungs, as data, index === tier. Kept beside `vegetationTierPlan` so the
 * table and its clamp cannot disagree about how many rungs exist.
 *
 * `shadowSmearTaps` only matters when `shadowEnabled` is true — 0 marks "this
 * tier never builds a shadow mesh at all", not a degenerate 0-station smear.
 * `buildVegetationMaterial`'s own `smearTaps` option defaults to
 * `VEG_SHADOW_SMEAR_TAPS` for exactly this reason: a call site that forgets to
 * check `shadowEnabled` first still gets a sane, working shadow rather than a
 * broken one — belt-and-braces, not a path this table means to exercise.
 */
const VEGETATION_TIER_PLANS = Object.freeze([
  Object.freeze({ flutterEnabled: false, shadowEnabled: false, shadowSmearTaps: 0 }), // 0 placed-and-swaying
  Object.freeze({ flutterEnabled: true, shadowEnabled: false, shadowSmearTaps: 0 }), // 1 shimmer
  Object.freeze({ flutterEnabled: true, shadowEnabled: true, shadowSmearTaps: 3 }), // 2 shadow-coarse
  Object.freeze({ flutterEnabled: true, shadowEnabled: true, shadowSmearTaps: VEG_SHADOW_SMEAR_TAPS }), // 3 shadow-smooth — TODAY
  Object.freeze({ flutterEnabled: true, shadowEnabled: true, shadowSmearTaps: 9 }), // 4 shadow-finer
  Object.freeze({ flutterEnabled: true, shadowEnabled: true, shadowSmearTaps: 12 }), // 5 shadow-finest
]);
