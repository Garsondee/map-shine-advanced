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

import {
  maskKindById,
  makeLayerKey,
  compareLayerKeys,
  SORT_LAYERS,
  resolveElevationFloorIndex,
} from '../scene/index.js';
import { VEGETATION_KINDS, VEGETATION_PARAMS } from './vegetation.js';
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
 * WHERE A CANOPY SORTS — its host floor's own ground, plus a REAL, UNBOUNDED
 * height above it (2026-08-06, replacing the old passive-fraction model — see
 * `vegetation.js`'s own "HOW A KIND SORTS" section for the full history).
 *
 * Deliberately NOT clamped to `band.top`: a tall enough `heightFt` sorts the
 * canopy above its own floor's ceiling, so a real tree can correctly rank
 * above (or below) whatever floor happens to sit over it, exactly like a real
 * tree beside a real building. This is the whole point of the change — see
 * `vegetationHeightFt` for where `heightFt` itself comes from.
 *
 * Returns `null` — NOT a guessed number — when the band is unbounded or
 * inverted, or `heightFt` itself isn't a finite number. `top` is `+Infinity`
 * for any Level with no declared ceiling (Foundry's own `Level#
 * prepareBaseData` normalisation, which `foundry/scene-layers.js#
 * levelElevation` replicates) and `bottom` is `-Infinity` for one with no
 * declared floor, so "no usable band" is ORDINARY DATA, not an edge case: a
 * scene whose author never set an elevation band on their Level hits this on
 * every single item. `bottom + heightFt` mathematically only needs `bottom`
 * to be finite — `top` is still required here as a deliberate POLICY choice,
 * not a forced consequence of the formula, so an unbounded-ceiling floor keeps
 * exactly the same escape hatch (fall back to the host-relative nudge, warn)
 * it always has, rather than quietly gaining a new capability an author on an
 * unbounded floor never opted into. The caller falls back to the old
 * host-relative nudge and REPORTS it, rather than rendering a scene-destroying
 * number — the same posture `floorCeilings` already takes toward an
 * undeclared ceiling: surface the +Infinity so the author can set a band,
 * never chase a silent wrong answer.
 *
 * A ZERO-HEIGHT band (`bottom === top`, a legitimate Foundry Level) needs no
 * special case: the canopy still sorts at `bottom + heightFt`, genuinely above
 * its floor's single elevation point for any `heightFt > 0` — unlike the old
 * fraction model, this does NOT collapse onto the floor's own elevation.
 *
 * @param {{bottom: number, top: number}|null|undefined} band - the host floor's
 *   elevation band (`foundry/scene-layers.js#floorElevationBands`, or a
 *   `getActiveSceneFloors()` floor's `{elevationBottom, elevationTop}` mapped
 *   onto this shape by the caller).
 * @param {number} heightFt - real height above `band.bottom`, in the SAME
 *   units as `band` (Foundry scene distance units — see `vegetationHeightFt`).
 * @returns {number|null} the sort elevation, or null if the band or height is
 *   unusable. UNCLAMPED — may legitimately exceed `band.top`.
 */
export function vegetationCanopyElevation(band, heightFt) {
  const bottom = band?.bottom;
  const top = band?.top;
  if (!Number.isFinite(bottom) || !Number.isFinite(top)) return null;
  if (top < bottom) return null; // an inverted band is malformed data, not a band
  if (!Number.isFinite(heightFt)) return null;
  return bottom + heightFt;
}

/**
 * THE LIVE HEIGHT FOR ONE KIND — resolves `treeHeightFt`/`bushHeightFt`
 * (`vegetation.js#VEGETATION_PARAMS`) from the currently-live resolved params,
 * falling back to that param's own declared default when the live value is
 * missing or non-finite (mirrors every other live-param read in this effect —
 * never a silently-different second default living here).
 *
 * @param {import('./vegetation.js').VegetationKind} kind
 * @param {Record<string, number>|null|undefined} params - live, resolved
 *   `VEGETATION_PARAMS` values (`getVegetationRenderState().params` shape).
 * @returns {number} feet (the scene's own elevation units).
 */
export function vegetationHeightFt(kind, params) {
  const key = `${kind?.id}HeightFt`;
  const live = params?.[key];
  if (Number.isFinite(live)) return live;
  return VEGETATION_PARAMS[key]?.default ?? 0;
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
 * drawables sort below it they occupy `renderOrder` 0..n-1, so the overlay
 * lands somewhere strictly between `n-1` and `n` — the correct slot, expressed
 * in the same numbering everything else uses. No band, no capacity, no drift
 * from the law: change the comparator and this follows it automatically.
 *
 * `SORT_LAYERS.SCENE_EFFECTS` (250 < `TILES` 500) is what makes a TIE go to the
 * tile, which is the author's own rule — *"tiles at 10 would render above the
 * _Bush because they beat the priority"*. It also means the overlay sits above
 * level art (`SCENE` 0) at the same elevation, so a tree at its floor's top
 * draws over that floor's foreground/roof art. That is a real behaviour change
 * from the host-relative era and is deliberate: an author who wants roof art
 * above a canopy puts it on a TILE at the floor top (`TILES` 500 > 250).
 *
 * ⚠️ WHERE EXACTLY IN THAT GAP — NOT THE MIDPOINT, A PER-KIND SLOT (found
 * 2026-08-04, chasing an author report of `_Bush` drawing over `_Tree` on an
 * ordinary scene). `below` only counts REAL (non-vegetation) drawables — it
 * never compares one vegetation kind against another, because they are never
 * both members of `sortedItems`. So on a floor with no real drawable sitting
 * strictly between bush's elevation (its band's midpoint) and tree's
 * (its band's top) — a perfectly ordinary floor: just background art, no
 * intermediate tiles — `below` comes out IDENTICAL for both kinds despite
 * their different elevations, and a fixed `n - 0.5` would hand both meshes
 * the exact same `renderOrder` number. THREE has no law for that tie (this
 * module's whole point is to never depend on one); it falls to incidental
 * scene-graph/creation order, which is why the symptom looked like "bush
 * sometimes wins" rather than "always". The existing regression fixture never
 * caught this because it always seeded a tile at elevation 19 — between
 * bush's 10 and tree's 20 — which broke the tie by accident.
 *
 * Fix (2026-08-04): instead of always bisecting the gap, place the kind AT a
 * fixed point inside it that is itself ordered by a dedicated ground-to-sky
 * table (`VEG_SLOT_RANK`, below) — originally reused `passiveElevationFraction`
 * directly (the same field that already decided the two kinds' elevations
 * were different); that field no longer exists (2026-08-06, see
 * `vegetation.js`'s "HOW A KIND SORTS"), so the ordering now lives in its own
 * table, values UNCHANGED from the old fraction numbers for canopies. Two
 * kinds sharing one gap now get two distinct numbers inside it, in the same
 * relative order their elevations intend; two kinds NOT sharing a gap are
 * unaffected (still strictly separated by whichever real drawables sit
 * between them). `VEG_KIND_SLOT_MARGIN` keeps every slot strictly inside
 * `(n-1, n)` — never touching either boundary — so this can never newly
 * collide with a REAL drawable's own integer `renderOrder`.
 *
 * ============================================================================
 * GENERALIZED TO SERVE THE SHADOW TOO (2026-08-06)
 * ============================================================================
 * Originally canopy-only; the vegetation ground-shadow used to bypass this
 * entirely (`host.renderOrder + VEG_SHADOW_RENDER_ORDER_MAGNITUDE`, a bare
 * host-relative nudge) — the EXACT bug class this function was built to fix
 * for the canopy, left unfixed for the shadow (`Bug-Tracker.md` bug #2's own
 * "Deliberately NOT changed" section). A Case-2 overlay hosted on an ordinary
 * TILE (not a Level background, always pinned to its floor's exact bottom)
 * inherits whatever raw elevation the map author gave that specific tile —
 * which can legitimately sit anywhere within its own floor — leaving a bare
 * `+0.2` nudge with no real margin against a floor above. `opts.heightFt: 0`
 * anchors a shadow call at the host floor's own GROUND (a shadow lies on the
 * ground regardless of caster height); `opts.role: 'shadow'` selects the
 * shadow's own (lower) `VEG_SLOT_RANK` entries so a shadow can never
 * out-tiebreak any canopy when nothing real separates all four in one gap.
 *
 * @param {ReadonlyArray<{key: object, renderOrder: number}>} sortedItems - the
 *   draw list AFTER `sortByLayer`, still in sorted order.
 * @param {{key?: object, renderOrder: number}} hostItem - the drawable this
 *   overlay is painted onto; used only for the fallback and the tiebreak.
 * @param {import('./vegetation.js').VegetationKind} kind
 * @param {{bottom: number, top: number}|null|undefined} band - host floor band.
 * @param {object} [opts]
 * @param {number} [opts.heightFt] - real height above `band.bottom`. A canopy
 *   call passes `vegetationHeightFt(kind, params)`; a shadow call always
 *   passes `0` (ground level, independent of caster height).
 * @param {'canopy'|'shadow'} [opts.role='canopy'] - selects the tiebreak slot
 *   in `VEG_SLOT_RANK` — affects ONLY the sparse-gap tiebreak, never the
 *   computed elevation itself.
 * @param {number} [opts.fallbackNudge] - added to `hostItem.renderOrder` when
 *   the band is unusable (`fellBack: true`). Defaults to `kind.renderOrderNudge`
 *   (the canopy's own legacy fallback) — a shadow call must pass
 *   `VEG_SHADOW_RENDER_ORDER_MAGNITUDE` explicitly.
 * @returns {{renderOrder: number, elevation: number|null, fellBack: boolean}}
 *   `fellBack` is true when the band was unusable and the fallback nudge was
 *   used — the caller REPORTS that rather than swallowing it.
 */
const VEG_KIND_SLOT_MARGIN = 0.02;

// Ground-to-sky tiebreak order when nothing real separates two vegetation
// sub-items sharing one gap (the sparse-floor-tie class, Bug-Tracker.md bug
// #2, 2026-08-04 — generalized to cover the shadow too, 2026-08-06). Canopy
// values UNCHANGED from the original passiveElevationFraction numbers —
// preserves every existing canopy-vs-canopy tiebreak byte-for-byte. Shadow
// values are new and both sit below either canopy value: a shadow never
// conceptually outranks any canopy, tree's own or bush's.
const VEG_SLOT_RANK = Object.freeze({
  bush: Object.freeze({ shadow: 0.1, canopy: 0.5 }),
  tree: Object.freeze({ shadow: 0.2, canopy: 1.0 }),
});

export function vegetationOverlayRenderOrder(sortedItems, hostItem, kind, band, opts = {}) {
  const { heightFt, role = 'canopy', fallbackNudge } = opts;
  const elevation = vegetationCanopyElevation(band, heightFt);
  const nudge = Number.isFinite(fallbackNudge) ? fallbackNudge : (kind?.renderOrderNudge ?? 0);
  if (elevation === null) {
    return {
      renderOrder: (hostItem?.renderOrder ?? 0) + nudge,
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
  // Placed at a per-(kind,role) point inside the (below-1, below) gap — see
  // the doc comment above for why a fixed midpoint (`below - 0.5` for every
  // caller) let different vegetation sub-items collide onto one number.
  const fraction = VEG_SLOT_RANK[kind?.id]?.[role] ?? 0.5;
  const span = 1 - 2 * VEG_KIND_SLOT_MARGIN;
  const slot = VEG_KIND_SLOT_MARGIN + fraction * span;
  return { renderOrder: below - 1 + slot, elevation, fellBack: false };
}

/**
 * ============================================================================
 * VEGETATION JOINS THE DEPTH AUTHORITY (STAGE 2, 2026-08-04)
 * ============================================================================
 * A Case-2 tree/bush overlay (this module's own header, mode 2) has no `id`,
 * no `key`, and no membership in `foundry/scene-layers.js`'s collection
 * functions — it lives ONLY as `state.vegetationOverlays[kindId]` on its
 * HOST item's own residency-state object (`vt-pan-viewer.js#
 * ensureVegetationOverlay`). `scene/depth-authority.js#createDepthAuthority`
 * therefore never sees it as a real member and cannot give it a rank —
 * `docs/planning/Depth-Buffer.md` §9f names this the next planned consumer,
 * the moment after point-light occlusion locked the depth authority in as
 * "the only depth system allowed."
 *
 * This builds SYNTHETIC depth-authority items — one per (host, kind) pair
 * that actually has a discovered overlay — for the CALLER to concatenate
 * onto the real draw list before a SECOND `depthAuthority.rebuild(...)` call
 * (`vt-pan-viewer.js#updateResidencyUnguarded`'s own comment at that call
 * site has the exact reasoning for why it is a SECOND rebuild, not a
 * replacement of the first: `stampVegetationRenderOrders`'s own "how many
 * REAL items sort below" scan must never see these synthetic entries, or
 * every existing overlay's THREE `renderOrder` — a working, already-shipped
 * mechanism — would shift by however many vegetation items happen to
 * precede it).
 *
 * ⚠️ WHY A REAL, DENSE RANK — NOT `depthAuthority.rankOfElevation`'s QUERY
 * PATH. `rankOfElevation`/`rankOfKey` deliberately return an EXISTING real
 * item's own rank (the nearest one at-or-below), never mint a new distinct
 * integer (`depth-authority.js`'s own header: this is load-bearing for a
 * QUERY, e.g. "is anything above this light"). Borrowing that path for a
 * vegetation proxy MESH's own Z would draw it at the exact same Z as
 * whatever real item it borrowed the rank from — and `buf:scene.depth`'s
 * writer is `LessDepth` with NO blending, so an exact Z tie means only
 * whichever mesh happens to render first actually writes; the other's write
 * silently loses, order-dependent and unstable frame to frame. A real,
 * distinct array member — sorted by the SAME comparator as everything else
 * — has no such tie WITHIN one sort call.
 *
 * ============================================================================
 * ⚠️ 🐛 FIXED 2026-08-05 — "WITHIN ONE SORT CALL" WAS NOT THE SAME GUARANTEE
 * AS "BETWEEN TWO SORT CALLS", AND EVERY SAME-FLOOR, SAME-KIND BUSH TIES ON
 * EVERY REAL FIELD. Author-reported, live: "bushes flickering when I pan
 * the camera" (trees not mentioned — see below for why that asymmetry is
 * itself a clue, not a coincidence).
 * ============================================================================
 * `scene/layer-order.js#sortByLayer` stamps `tiebreak = index` — the item's
 * OWN POSITION IN THE INPUT ARRAY — UNCONDITIONALLY, on every call, for every
 * item, discarding whatever `tiebreak` a caller pre-set on `key` (confirmed
 * by reading the function body, not assumed: `item.key.tiebreak = index`).
 * That is exactly right WITHIN one call — the resulting order is a genuine
 * total order, no two items tie. It says NOTHING about whether two items'
 * RELATIVE tiebreak stays the same ACROSS TWO DIFFERENT CALLS, and this
 * function's own items are rebuilt fresh every residency pass, fed into a
 * SECOND `rebuild()` call whose OWN input is `[...items, ...vegDepthItems]`
 * — `items` itself being `buildItems(floorIndex)`'s raw, RESIDENCY-DEPENDENT
 * order from the FIRST rebuild. Panning changes which tiles are resident,
 * which reorders `items`, which reorders where each vegetation item lands in
 * the array `sortByLayer` re-indexes — silently reshuffling tiebreak for
 * every vegetation item, every pass, whether or not the SAME set of bushes
 * is still present.
 *
 * This is invisible for an ORDINARY tile: two tiles tying on elevation/
 * sortLayer/sort/zIndex is rare (each usually has its own authored
 * elevation). It is UNAVOIDABLE for vegetation: `passiveElevationFraction`
 * is a per-KIND constant, so EVERY bush on the SAME floor computes the
 * IDENTICAL elevation, the IDENTICAL `sortLayer` (`SCENE_EFFECTS`), and the
 * IDENTICAL `sort`/`zIndex` (both hardcoded 0 above) — an exact 4-way tie
 * among every same-floor bush, resolved ENTIRELY by a tiebreak that this bug
 * let drift with residency churn. Two bushes near the same light, tied and
 * reordering every pan-triggered pass, take turns reading as "above" the
 * light's own expected depth — the light's occlusion flickers on/off at
 * that spot, which reads as "the bush is flickering". A typical scene has
 * far more bushes sharing one floor than trees, which is why this news
 * arrived as a bush report and not a tree one — not because the bug is
 * bush-specific, it is a property of ANY same-kind, same-floor tie.
 *
 * THE FIX: sort the OUTPUT by its own stable `id` (`veg:<hostId>:<kindId>`,
 * built from a Foundry document id that does not change between residency
 * passes) before returning — see the end of this function. Two tied items'
 * RELATIVE order within `vegDepthItems` is then fixed forever regardless of
 * `items`'s own order or length, so `sortByLayer`'s re-indexing always
 * assigns them the SAME relative tiebreak, pass after pass. Proven with a
 * regression test that rebuilds the SAME two same-floor bushes behind two
 * DIFFERENT, shuffled `items` orderings (simulating exactly what a pan-
 * triggered residency reorder does) and asserts identical relative rank
 * both times — the class of test [[feedback_smooth_output_hides_ported_bugs]]
 * describes: a single fixed ordering could never have caught this.
 *
 * ⚠️ `levelId` IS SET TO THE HOST'S OWN RESOLVED FLOOR, NEVER LEFT TO
 * RE-DERIVE FROM THE SYNTHETIC ELEVATION. Originally this mattered because a
 * tree's OLD `passiveElevationFraction = 1` placed its synthetic
 * `key.elevation` EXACTLY at its floor's own `elevationTop` — precisely the
 * case `[[feedback_half_open_band_excludes_its_own_member]]` names: a
 * half-open `[bottom,top)` band would attribute that exact boundary value to
 * the FLOOR ABOVE, not the floor the canopy actually belongs to.
 * `resolveSceneDepthFloorIndex`'s own "membership first" branch (`vt/
 * scene-depth.js`) exists for exactly this — set `levelId` and the half-open
 * lookup is never even attempted. ⚠️ MATTERS MORE NOW, NOT LESS (2026-08-06):
 * with a real, unbounded `heightFt` (see `vegetationCanopyElevation`), the
 * synthetic elevation can land arbitrarily far into another floor's own
 * territory, not just at one boundary value — making this override the ONLY
 * thing standing between a tall tree's canopy and being silently reattributed
 * to the wrong floor for VISIBILITY purposes.
 *
 * An UNBOUNDED band (no declared `elevationTop`) is a NAMED gap, never a
 * fabricated number: `vegetationCanopyElevation` already returns `null`
 * there, and this function skips the pair entirely rather than guessing an
 * elevation — the SAME posture `stampVegetationRenderOrders` already takes
 * for its own, separate (THREE paint-order) concern.
 *
 * @param {ReadonlyArray<{id: string, key?: object, levelId?: string|null}>} items
 *   - the REAL, already-collected draw list (`buildItems(floorIndex)`'s own
 *   return, BEFORE `depthAuthority.rebuild` sorts it — order does not matter
 *   here, only membership/floor lookup does).
 * @param {ReadonlyArray<{id: string, elevationBottom?: number|null, elevationTop?: number|null}>} floors
 *   - `getActiveSceneFloors(...).floors`, resolved by the CALLER (this stays
 *   pure — no Foundry-global access of its own, matching every other
 *   function in this module).
 * @param {Map<string, {tree?: string|null, bush?: string|null}>|null|undefined} urlByItemId
 *   - `boot.js`'s own vegetation-discovery map (`getVegetationRenderState().
 *   urlByItemId`) — already scoped to `levelBackground`/`tile` hosts only
 *   (foregrounds excluded there), so this function does not re-check `item.kind`.
 * @param {Record<string, number>|null|undefined} params - live, resolved
 *   `VEGETATION_PARAMS` values (`getVegetationRenderState().params`) — feeds
 *   `vegetationHeightFt` for each kind's real height.
 * @returns {Array<{id: string, key: object, kind: 'vegetationOverlay', levelId: string|null, vegHostItemId: string, vegKindId: string}>}
 *   one synthetic item per (host, kind) pair with a discovered URL AND a
 *   bounded floor band — never a real item, never a guessed elevation.
 *   SORTED BY `id` — see this function's own "FIXED 2026-08-05" header for
 *   why a stable output order is load-bearing, not cosmetic: it is what
 *   keeps two same-floor, same-kind items' RELATIVE tiebreak identical
 *   across residency passes, regardless of `items`' own (residency-
 *   dependent) order.
 */
export function buildVegetationDepthItems(items, floors, urlByItemId, params) {
  if (!(urlByItemId instanceof Map) || urlByItemId.size === 0) return [];
  const bandById = new Map();
  for (const f of floors ?? []) {
    bandById.set(f.id, { bottom: f.elevationBottom ?? -Infinity, top: f.elevationTop ?? Infinity });
  }
  const out = [];
  for (const item of items ?? []) {
    const urls = urlByItemId.get(item?.id);
    if (!urls) continue;
    // Level art names its own floor; a tile does not — mirrors
    // `stampVegetationRenderOrders`'s own identical resolution, verbatim, so
    // the two consumers can never attribute one host to two different floors.
    const floorId = item.levelId || resolveElevationFloorIndex(floors, item.key?.elevation ?? 0)?.floor?.id || '';
    const band = bandById.get(floorId) ?? null;
    for (const kind of VEGETATION_KINDS) {
      const url = urls[kind.id];
      if (!url) continue;
      const elevation = vegetationCanopyElevation(band, vegetationHeightFt(kind, params));
      if (elevation === null) continue; // unbounded band - a named gap, never a guess
      out.push({
        id: `veg:${item.id}:${kind.id}`,
        key: makeLayerKey({ elevation, sortLayer: SORT_LAYERS.SCENE_EFFECTS, sort: 0, zIndex: 0 }),
        kind: 'vegetationOverlay',
        levelId: floorId || null,
        vegHostItemId: item.id,
        vegKindId: kind.id,
      });
    }
  }
  // ⚠️ LOAD-BEARING, NOT COSMETIC — see this function's own "FIXED 2026-08-05"
  // header. `sortByLayer` (inside the caller's own `depthAuthority.rebuild`)
  // stamps `tiebreak = index`, unconditionally, from THIS array's own
  // position once concatenated onto the real items — so two same-floor,
  // same-kind items (an exact tie on every other field) get a STABLE
  // relative tiebreak, pass after pass, ONLY if THEY land in the same
  // relative order every time. `items`' own order is residency-dependent
  // (shifts as panning changes which tiles are resident) and therefore
  // cannot be trusted to provide that; sorting by `id` — a Foundry document
  // id, unchanged between passes — can.
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
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
/**
 * How many vertices must span one clump before its per-clump variation can be
 * drawn without faceting.
 *
 * Nyquist says 2 samples per period is the bare minimum to represent a wave AT
 * ALL; 2 reconstructs it as a triangle wave, which through linear interpolation
 * across a mesh is precisely a row of flat triangular facets. 4 is the smallest
 * count that reads as a curve rather than as geometry.
 */
export const VEGETATION_MIN_VERTICES_PER_CLUMP = 4;

/**
 * ⭐ THE SMALLEST CLUMP THE VERTEX MESH CAN ACTUALLY DRAW (2026-09-04,
 * mythica-machina-press#505 round 2).
 *
 * ============================================================================
 * THE ARTEFACT THIS FIXES, AND WHY IT IS A SAMPLING BUG NOT A TUNING ONE
 * ============================================================================
 * Author, at Wind 1, with screenshots: *"sharp lines, triangles, even some
 * self intersections in the shadows"* — big flat-edged wedges across the
 * canopy.
 *
 * Straight edges and triangular facets in a warped sprite are the signature of
 * a displacement evaluated at MESH VERTICES and linearly interpolated across
 * the triangles between them. The bulk sway is `positionNode` — vertex stage —
 * and the mesh is tessellated to {@link VEGETATION_VERTEX_SPACING_PX} (60 px,
 * coarser on a tile big enough to hit {@link VEGETATION_MAX_SEGMENTS}). But
 * `clumpSizePx` defaulted to 150 and its slider bottoms out at 20:
 *
 * ```
 *   150 px clump / 60 px spacing = 2.5 vertices per clump   (default)
 *    20 px clump / 60 px spacing = 0.33 vertices per clump  (slider minimum)
 * ```
 *
 * At 2.5 the per-clump jitter is barely above Nyquist and reconstructs as
 * facets; at 0.33 the mesh cannot represent it at any amplitude. The dial let
 * an author ask for detail three times finer than the mesh could carry, and no
 * amplitude reduction fixes that — an under-sampled signal is under-sampled at
 * every amplitude.
 *
 * ⚠️ THIS IS THE SAMPLING TWIN OF {@link flutterFoldFreeAmplitudePx}. That one
 * bounds the displacement's GRADIENT so the warp stays injective; this one
 * bounds its SPATIAL FREQUENCY so the mesh can represent it. Both are derived
 * limits rather than tuned numbers, and both exist because the previous
 * attempts to fix the same visual symptom by reducing an amplitude could not
 * have worked.
 *
 * @param {number} authoredClumpSizePx - the `clumpSizePx` param's own value.
 * @param {number} [vertexSpacingPx] - the real spacing for the tile being
 *   drawn. Defaults to the target spacing; a tile large enough to hit the
 *   segment cap is coarser than that and keeps proportionally less margin,
 *   which is a known limit of feeding this through ONE shared uniform rather
 *   than a per-tile one.
 * @returns {number} the clump size to actually use.
 */
export function vegetationAliasFreeClumpSizePx(authoredClumpSizePx, vertexSpacingPx = VEGETATION_VERTEX_SPACING_PX) {
  const authored = Number(authoredClumpSizePx);
  const spacing = Number(vertexSpacingPx);
  const safeSpacing = Number.isFinite(spacing) && spacing > 0 ? spacing : VEGETATION_VERTEX_SPACING_PX;
  const floor = safeSpacing * VEGETATION_MIN_VERTICES_PER_CLUMP;
  if (!Number.isFinite(authored) || authored <= 0) return floor;
  return Math.max(authored, floor);
}

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
 * A driven damped-oscillator "spring-chase" step — Euler-integrated, the same
 * shape `docs/planning/Vegetation.md` §4 sketched and `vegetation.js`'s own
 * `deferredRungs` entry `'spring-response'` named and deferred: "a
 * critically-damped spring per swaying region so foliage lags the wind and
 * overshoots on release, instead of tracking it instantaneously." This
 * function is that spring, generalized over any scalar channel (used for both
 * the rotation angle and the lift offset — see `vt/vegetation-spring-gpu.js`,
 * the TSL port of this exact formula for the GPU integrate pass).
 *
 * `target` is NOT the raw forcing term itself — the caller pre-multiplies by
 * its own gain (e.g. `torque * torqueGain`) so steady-state amplitude depends
 * on that gain ALONE, never on `stiffness`/`damping` too. That keeps the two
 * families of dial orthogonal: one decides how far it swings, the other how
 * springy the swing feels.
 *
 * Critical damping (implicit unit mass) is `damping = 2*sqrt(stiffness)`. A
 * caller wanting the overshoot-and-settle behaviour asked for (Ingram,
 * 2026-08-27: "a 'spring' that encourages the plant to sway back in the
 * opposite rotational direction") keeps `damping` below that line —
 * deliberately underdamped, not critically/over-damped.
 *
 * ⚠️ EULER-INTEGRATED, NOT UNCONDITIONALLY STABLE — unlike every other
 * "spring-like" curve already in this codebase (`SPLAT_FOLLOW_REMAIN_PER_
 * SECOND` and friends are closed-form exponentials, stable for any `dt`).
 * This one can blow up for a large enough `dt` (a frame hitch) at a high
 * enough `stiffness` — the caller MUST clamp `dt` to a small ceiling before
 * calling this (a code constant, not a live param — see
 * `VEG_SPRING_MAX_DT_SEC` in `vt/vegetation-spring-gpu.js`), never pass a
 * raw, unclamped frame delta straight through.
 *
 * @param {number} value - current channel value (radians, or world px).
 * @param {number} velocity - current channel rate.
 * @param {number} target - where the spring is being driven toward THIS step.
 * @param {number} stiffness - pull-toward-target gain. Higher = faster,
 *   higher-frequency response.
 * @param {number} damping - velocity drag. Higher = less overshoot.
 * @param {number} dt - seconds, already clamped by the caller.
 * @returns {{value: number, velocity: number}}
 */
export function springChase(value, velocity, target, stiffness, damping, dt) {
  const v = Number.isFinite(value) ? value : 0;
  const vel = Number.isFinite(velocity) ? velocity : 0;
  const tgt = Number.isFinite(target) ? target : 0;
  const k = Number.isFinite(stiffness) ? stiffness : 0;
  const c = Number.isFinite(damping) ? damping : 0;
  const dtSafe = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const accel = k * (tgt - v) - c * vel;
  const newVelocity = vel + accel * dtSafe;
  const newValue = v + newVelocity * dtSafe;
  return { value: newValue, velocity: newVelocity };
}

/**
 * THE SHARED VEGETATION-SPRING GRID SPEC — one small world-space grid, sized
 * ONCE from the real scene bounds and the live `clumpSizePx` param, that the
 * torque/lift GPU integrate pass writes into and every vegetation mesh's
 * vertex shader reads back from (`vt/vegetation-spring-gpu.js`,
 * `vt-pan-viewer.js#tickVegetationSpring`).
 *
 * ⚠️ SCENE-WIDE, NOT PER-MESH — deliberately. `vegClumpHash`'s own cell
 * computation (`worldXY / clumpSizePx`, floored) is already a pure function
 * of world position with no per-mesh indexing at all; two vegetation meshes
 * (two separately painted tiles/overlays) standing near or overlapping each
 * other must resolve the SAME cell to the SAME spring state, or neighbouring
 * plants on different meshes would twist with completely uncorrelated
 * phases — a worse seam than the one this grid's own bilinear blending is
 * built to soften. Pass the real `dimensions.sceneRect`, never one mesh's own
 * placement.
 *
 * Resolved ONCE, at first construction, from whatever `clumpSizePx` reads at
 * that moment — the same "a live param reaches an already-built resource only
 * on next scene load" cadence `vegetationTierPlan` already documents. No live
 * regrid in this pass: nothing downstream (the render-target allocation, the
 * published texture's identity) is built to survive one.
 *
 * ⚠️ `originX`/`originY` ARE SNAPPED TO THE EXISTING WORLD-ALIGNED CLUMP
 * GRID, NOT THE RAW SCENE-RECT CORNER. The existing translation sway hashes
 * `cell = floor(worldXY / clumpSizePx)` — aligned to WORLD (0,0), not to
 * wherever a scene's own bounds happen to start. If this grid's origin were
 * the raw `sceneRect.x`/`.y` instead, its own cell boundaries would sit a
 * fractional cell-width off from the existing ones almost every time (any
 * scene whose rect doesn't start exactly on a `clumpSizePx` multiple) —
 * rotation would then pivot around a DIFFERENT point than the one the
 * translation/phase/amplitude jitter for the "same" visual clump already
 * uses, which is confusing even though nothing would be technically broken
 * (the two grids don't NEED to agree for correctness, only for the rotation
 * to visually belong to the same clump the rest of the effect already
 * decorrelates by cell). Snapping down to the nearest world-aligned multiple
 * of `cellSize` at or before the scene's own edge makes them agree for free.
 *
 * @param {{x: number, y: number, width: number, height: number}} sceneRect -
 *   the real scene bounds (`dimensions.sceneRect`), never a mesh's own footprint.
 * @param {number} clumpSizePx - the live `VEGETATION_PARAMS.clumpSizePx` value
 *   at construction time (world px per cell — same grid the existing
 *   translation sway already hashes into).
 * @returns {{cols: number, rows: number, originX: number, originY: number, cellSize: number}}
 *   `cols`/`rows` are always >= 1 (a degenerate/zero-size scene still gets a
 *   usable 1x1 grid rather than a divide-by-zero downstream). The grid's far
 *   edge (`originX + cols*cellSize`) always reaches at least `sceneRect.x +
 *   sceneRect.width` — the snap can only grow the covered area, never shrink it.
 */
export function vegetationSpringGridSpec(sceneRect, clumpSizePx) {
  const cellSize = Number.isFinite(clumpSizePx) && clumpSizePx > 0 ? clumpSizePx : 150;
  const rectX = Number.isFinite(sceneRect?.x) ? sceneRect.x : 0;
  const rectY = Number.isFinite(sceneRect?.y) ? sceneRect.y : 0;
  const width = Number.isFinite(sceneRect?.width) ? Math.abs(sceneRect.width) : 0;
  const height = Number.isFinite(sceneRect?.height) ? Math.abs(sceneRect.height) : 0;
  const originX = Math.floor(rectX / cellSize) * cellSize;
  const originY = Math.floor(rectY / cellSize) * cellSize;
  const cols = Math.max(1, Math.ceil((rectX + width - originX) / cellSize));
  const rows = Math.max(1, Math.ceil((rectY + height - originY) / cellSize));
  return { cols, rows, originX, originY, cellSize };
}

/**
 * THE PERFORMANCE-TIER PLAN — one vegetation rung translated into the four
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
 * shader loop when it does. `rotationLiftEnabled` (2026-08-27) gates the
 * WHOLE torque/spring rotation + wind-driven lift subsystem — the GPU
 * integrate/publish passes, their render targets, and the extra displacement
 * terms in `buildVegetationSwayDisplacementNode` — the same "don't even
 * construct it" pattern the shadow mesh already uses, extended to a whole
 * extra simulation pass rather than just a mesh. All four are graph/mesh/
 * pass-BUILD-time decisions, resolved once when a tile or overlay loads — the
 * same already-accepted limitation `vegetation.js`'s own
 * `live-disable-for-self-vegetation-tiles` deferred rung documents for sway/
 * wind response: a live performance-profile change reaches an already-built
 * tile/overlay only on its next scene load, never retroactively.
 *
 * ⚠️ TIER 3 REPRODUCES TODAY'S SHIPPED BEHAVIOUR EXACTLY — flutter on, the
 * shadow on at `VEG_SHADOW_SMEAR_TAPS` (6) stations — and tier 3 is what the
 * DEFAULT profile (`standard`) resolves to. That is deliberate: turning this
 * system on must not silently restyle every existing scene. Below `standard`
 * the picture genuinely simplifies (no shadow at all below `performance`, no
 * flutter below `low`); above it the shadow's smear gets finer than it has
 * ever been, and at the new top rung (6) rotation+lift joins in.
 *
 * @param {number} tier - a resolved rung (effect-cascade.js#resolveEffectTier).
 *   Clamped into the ladder, so a stale or malformed value degrades to a rung
 *   that exists rather than producing an uncompilable quality.
 * @returns {{flutterEnabled: boolean, shadowEnabled: boolean, shadowSmearTaps: number, rotationLiftEnabled: boolean}}
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
 *
 * `rotationLiftEnabled` (tier 6, 2026-08-27) is a NEW rung, not an extension
 * of tier 5 — tier 5's own reserved slot was earmarked in prose for a
 * DIFFERENT, specifically-named pair (self-shadow, true clump
 * differentiation); torque/spring rotation + lift is a genuinely new COST
 * CLASS (a whole extra simulation pass) rather than more of tier 5's existing
 * cost class (more shadow-smear taps in an already-built pass), so bundling
 * them would block promoting one down independently of the other later
 * (Law 3). Every earlier tier explicitly carries `rotationLiftEnabled: false`
 * — the same "0/false marks this tier never builds it at all" convention
 * `shadowSmearTaps: 0` already establishes, never an omitted field.
 */
const VEGETATION_TIER_PLANS = Object.freeze([
  Object.freeze({ flutterEnabled: false, shadowEnabled: false, shadowSmearTaps: 0, rotationLiftEnabled: false }), // 0 placed-and-swaying
  Object.freeze({ flutterEnabled: true, shadowEnabled: false, shadowSmearTaps: 0, rotationLiftEnabled: false }), // 1 shimmer
  Object.freeze({ flutterEnabled: true, shadowEnabled: true, shadowSmearTaps: 3, rotationLiftEnabled: false }), // 2 shadow-coarse
  Object.freeze({
    flutterEnabled: true,
    shadowEnabled: true,
    shadowSmearTaps: VEG_SHADOW_SMEAR_TAPS,
    rotationLiftEnabled: false,
  }), // 3 shadow-smooth — TODAY
  Object.freeze({ flutterEnabled: true, shadowEnabled: true, shadowSmearTaps: 9, rotationLiftEnabled: false }), // 4 shadow-finer
  Object.freeze({ flutterEnabled: true, shadowEnabled: true, shadowSmearTaps: 12, rotationLiftEnabled: false }), // 5 shadow-finest
  Object.freeze({ flutterEnabled: true, shadowEnabled: true, shadowSmearTaps: 12, rotationLiftEnabled: true }), // 6 torque-sway
]);
