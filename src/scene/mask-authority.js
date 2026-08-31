/**
 * THE MASK AUTHORITY — the single source of truth for SERVING world-space
 * content layers: which authored masks exist per floor, composited from
 * EVERY item that hosts one (a Level's background, its foreground, or any
 * Tile — discovery's result), what every consumer gets where NOTHING was
 * authored at all (the catalog's absence defaults), and the derived
 * products computed from what has streamed (coverAbove, skyReach). One
 * instance, owned by boot, reset per scene.
 *
 * ============================================================================
 * WHERE IT SITS (two narrow seams, both injected — no new zone imports)
 * ============================================================================
 *
 *   foundry/mask-discovery  ──(setDiscovery)──▶ ┌──────────────┐
 *   foundry collectors      ──(reset/setItems)─▶│  AUTHORITY   │──▶ layersForItem ──▶ vt-pan-viewer
 *   vt-pan-viewer decodes   ──(ingestDecodedPage)▶│ (this file) │──▶ getDerived / sampleWorld / report
 *                                                └──────────────┘
 *
 * The renderer never imports this module and this module never imports the
 * renderer: boot (the composition root) hands the viewer two closures —
 * `extraLayersForItem` (what to stream) and `onPageDecoded` (tell me what
 * streamed). V2 wired the equivalent as twelve hand-listed
 * `?.setOutdoorsMask?.()` pushes from a god-object plus two parallel mask
 * services that each thought they were the source of truth
 * (`IndoorOutdoorMaskService` — its own header SAYS "single source of truth"
 * — running beside `MaskBindingController`, both live "during rollout",
 * forever). The difference here is not politeness, it is structure: suffix
 * knowledge is unownable elsewhere (the `masks/authority-only` wall), and the
 * serving API carries its provenance (`source: 'authored' | 'default'`) so a
 * default can never masquerade as data.
 *
 * ANY DRAWABLE IS A MASK HOST (2026-07-26, `keyhole-mask-any-item-decision`,
 * LOCKED): a Level's background, a Level's foreground, and any Tile can ALL
 * carry their own sibling mask file, and a floor's own mask grid is EVERY one
 * of its hosts' paint, composited together in the SAME draw order the
 * visible art itself paints in (`scene/layer-order.js#compareLayerKeys`) — a
 * LATER host overwrites an EARLIER one wherever their own footprints overlap
 * (`mask-derive.js#rasterizeAuthored`/`compositeItemOverwrite`; never a
 * max-composite — the author's own worked example needs a Tile to be able to
 * paint something DARKER too, not just brighter: *"I want to blow the corner
 * of a building open... a tile with the corner blown off in the artwork AND
 * with its own `_Outdoors` mask... automatically overwrites the `_Outdoors`
 * so that suddenly the corner of the building is outside where previously it
 * was inside."* This is also what lets a floor with NO background or
 * foreground art at all — built entirely of Tiles — get full mask support
 * exactly as a background-image-based floor does: it simply starts from the
 * catalog's absent value and every Tile paints its own patch on top, the SAME
 * mechanism, zero or more contributing sources instead of always exactly one.
 *
 * `hostsOfFloor` resolves one floor's ordered host list; `authoredStatusForItem`
 * is the discovery-only door for a SPECIFIC item's own file (URL, no grid —
 * Specular's tier-0 hi-res read and Vegetation's own texture load both use
 * exactly this, never the composited grid); `authoredStatus` is a thin
 * convenience wrapper over it for the single most common case, "this level's
 * own background file".
 *
 * INGEST (the derived products' input path): the pager already decodes every
 * pack's coarsest mip on its way to the coarse pin — one ≤248²-payload page
 * that IS the whole item. The viewer offers each such page here (bitmap alive
 * only for the duration of the call), the authority extracts the channels the
 * catalog says derivations need (art alpha; the outdoors channel of the
 * packed trio), and drops the rest. No second fetch, no second decode, no GPU
 * readback, no cache pressure — the keyhole's own traffic, distilled.
 *
 * STALENESS IS LAZY, NOT SCHEDULED: any state change marks dirty; products
 * recompute on the next read (a few ms over ≤512² grids). No timer, no clock
 * read, no frame hook — and a read always reflects every ingest before it.
 *
 * KNOWN LIMITS, recorded not hidden:
 *   - Every mask-hosting item now streams its own extra pack layers
 *     (`layersForItem` widened alongside the decision above) — a scene with
 *     many masked Tiles issues more pack requests than it did before this
 *     landed. This is the SAME per-kind fetch pattern a floor's own
 *     background already had (nothing here newly over-fetches a KIND; more
 *     ITEMS can now trigger the existing pattern), just now paid by more items.
 *   - A mid-session Level background/foreground URL change, or a Tile's own
 *     art URL change, re-discovers only on scene restart (same limit as the
 *     viewer's own pack cache).
 *   - If a pack's coarsest page never decodes (hard load error), its item
 *     lands in `completeness.missingItemIds` — soft and reported, never
 *     guessed (§4.1: "not loaded yet means SOFT, not WRONG").
 *
 * @module scene/mask-authority
 */

import {
  MASK_KINDS,
  DERIVED_KINDS,
  ALBEDO_INPUT,
  CASTER_HEIGHT_SCALE_PX,
  validateMaskCatalog,
  maskKindById,
  derivedKindById,
  assembleLayerDescriptors,
  extractionPlanForLayer,
  rasterizedKinds,
} from './mask-catalog.js';
import { buildMaskAuthorityReport } from './mask-authority-report.js';
import {
  computeMaskGridSpec,
  deriveFloorProducts,
  sampleMaskGridWorld,
  extractContentWindow,
  sampleAuthoredSourcesAt,
  WATER_GRID_MAX_DIM,
} from './mask-derive.js';
import { compareLayerKeys, maskHostFloorIndices } from './layer-order.js';

const EXTRACT_ERROR_LOG_MAX = 10;

/**
 * ⚠️ THE PAINTED SELF-ALPHA RAMP (2026-08-31) — how many painted bytes it
 * takes for a brush stroke to count as FULLY covering, rather than partially
 * transparent. See `ingestPaintedMask`'s own SELF-ALPHA doc for the mechanism;
 * this constant is the fix for what that mechanism did WRONG.
 *
 * A painted layer has no alpha channel of its own, so its byte value doubles
 * as its own coverage. Feeding the SAME byte in as both the VALUE and the
 * ALPHA made `mask-derive.js#compositeItemOverwrite`'s source-over blend
 * SQUARE it: against fire's own transparent background (`absentValue` 0) the
 * composite `0×(1−a) + raw×a` with `raw === alpha === content` reduces to
 * exactly `content² / 255`. Two measured consequences, both invisible to the
 * author because the painter's own preview draws the RAW layer, unsquared:
 *
 *   - EVERY painted byte at or below 56 composited under 13/255, which is
 *     fire's own live sensitivity floor (`FIRE_PARAMS.maskSensitivity`
 *     default 0.05). The bottom ~20% of the Strength slider therefore painted
 *     something the preview showed and the render could never ignite.
 *   - A soft brush's edge falloff is ALREADY a smoothstep; squaring it again
 *     compounded into a visibly tighter stroke than the one painted.
 *
 * And it quietly broke this door's own stated "can only ever ADD" invariant:
 * for any PARTIAL painted value over existing non-zero background content (a
 * Photoshop-authored `_Fire.webp` underneath), `content²/255` pulls the
 * file's own value DOWN in the overlap instead of overwriting it — erosion,
 * from the one direction the doc promised could not erode.
 *
 * THE CURVE: `alpha = smoothstep(0, 16, content)`, applied ONCE at ingest.
 * Chosen, not tuned — the three properties it has to hold are all endpoint
 * properties, and this is the narrowest curve that holds them:
 *   1. `content 0 → alpha 0`, EXACTLY. Unpainted stays unpainted; a painted
 *      layer still cannot blank out what a file authored outside the stroke.
 *      (A curve that merely approaches 0 would erode the whole file mask by a
 *      hair everywhere, which is the bug above wearing a smaller hat.)
 *   2. `alpha 255` — a true, lossless overwrite — for every content ≥ 16, so
 *      the composite is the IDENTITY (`out === content`) across the entire
 *      realistic Strength range. Not "closer to linear": linear.
 *   3. A C1-continuous ramp over the last 16 bytes rather than a step at 1,
 *      so a soft brush's antialiased outer fringe still fades out instead of
 *      terminating on a hard edge. 16/255 is 6% intensity — a band already
 *      below fire's own sensitivity floor, so the ramp cannot cost the author
 *      any paint they could otherwise have seen.
 */
const PAINTED_ALPHA_RAMP_BYTES = 16;

/**
 * `PAINTED_ALPHA_RAMP_BYTES`' curve, evaluated once for all 256 byte values —
 * `ingestPaintedMask` runs this over a ≤4096²-texel painted grid (`scene/
 * paint-mask.js#PAINT_GRID_MAX_DIM`), so a table lookup rather than a
 * smoothstep per texel is the difference between a table scan and eight
 * million `Math.pow`s on the author's Save.
 * @type {Uint8Array}
 */
const PAINTED_ALPHA_LUT = (() => {
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const t = Math.min(1, v / PAINTED_ALPHA_RAMP_BYTES);
    lut[v] = Math.round(255 * t * t * (3 - 2 * t));
  }
  return lut;
})();

/** Item kinds that participate in cover derivation (never tokens — they move
 * constantly and are not architecture). */
const COVER_ITEM_KINDS = new Set(['levelBackground', 'levelForeground', 'tile']);

/**
 * Thrown by `getDerived`/`sampleWorld` for a `required` mask kind (currently
 * only `outdoors`) when NO file was ever discovered for a level — never for
 * "discovered but not yet decoded" (that is a normal, transient streaming
 * state; see `authoredStatus`'s own `source` field, which is what this check
 * reads). 2026-07-21, author directive: "the outdoors mask is a requirement
 * not an option... if no outdoors mask is discovered then you need to just
 * fail." Before this, absence silently served `absentValue` (1 = fully
 * outdoors) — which is EXACTLY what let a stale wind-exposure snapshot read a
 * genuinely-indoors, correctly-painted room as fully outdoors without
 * anyone finding out (memory: keyhole-wind-wake-turbulence's own addendum).
 * A silent numeric default that can masquerade as real data is the bug class
 * this error exists to kill — callers MUST catch this specifically (never a
 * bare catch-all) and degrade LOUDLY (the safety-slide doctrine: announce
 * always, never silently, never crash the whole viewer over one missing
 * content file) rather than let it vanish into a generic error handler.
 */
export class RequiredMaskMissingError extends Error {
  /**
   * @param {string} kindId - the required authored kind that is missing (e.g. 'outdoors').
   * @param {string} levelId
   * @param {string} floorName
   * @param {string} requestedId - the id actually being queried (may be `kindId` itself,
   *   or a DERIVED id that transitively depends on it, e.g. 'skyReach').
   */
  constructor(kindId, levelId, floorName, requestedId) {
    const kind = maskKindById(kindId);
    const suffix = kind?.suffixes?.[0] ?? `_${kindId}`;
    const lines = [
      `REQUIRED MASK MISSING: '${kindId}' has no authored '${suffix}' file for floor '${floorName}' (level '${levelId}').`,
      requestedId !== kindId ? `('${requestedId}' was requested, which is DERIVED from '${kindId}'.)` : '',
      '',
      `This is a CONTENT gap, not a code default — the catalog (scene/mask-catalog.js) declares '${kindId}' ` +
        'as a hard requirement, so absence is refused rather than silently served as a guessed value.',
      `Paint a '${suffix}' file for this level's background art before relying on indoor/outdoor behaviour here.`,
      '(A guided in-app painting dialogue is planned but not built yet — this loud failure is the interim behaviour.)',
    ].filter(Boolean);
    super(lines.join('\n'));
    this.name = 'RequiredMaskMissingError';
    /** @type {string} */
    this.kindId = kindId;
    /** @type {string} */
    this.levelId = levelId;
    /** @type {string} */
    this.floorName = floorName;
    /** @type {string} */
    this.requestedId = requestedId;
  }
}

/**
 * @param {object} options
 * @param {(bitmap: any) => {data: Uint8ClampedArray|Uint8Array, width: number, height: number}} options.readPageImageData -
 *   browser-only pixel access for a decoded page bitmap, INJECTED so this
 *   module stays fully Node-testable (boot supplies the OffscreenCanvas
 *   implementation; tests supply synthetic ImageData).
 * @param {{warn: Function, error: Function, info: Function}} options.log - the
 *   one log door (core/log.js), injected for the same reason.
 */
export function createMaskAuthority({ readPageImageData, log }) {
  const catalog = validateMaskCatalog();
  if (!catalog.ok) {
    // Tests gate this at build time; if it is ever wrong live anyway, say so
    // loudly and keep serving defaults — a broken catalog must degrade the
    // masks, never the session (the safety slide's stance, applied here).
    log.error('mask catalog INVALID — serving absence defaults only:', catalog.errors);
  }

  /** Scene-lifetime state; replaced wholesale by reset(). */
  let scene = emptyScene();
  let version = 0;
  let dirty = false;
  let products = []; // DerivedFloorProducts[], valid when !dirty
  let productsVersion = -1;
  // BAKE-GATE HEALTH (perf-instrumentation-audit-2026-08-12) — `recomputeIfDirty`
  // is the version-gated bake underneath nearly every derived-mask consumer
  // in this file; `bakeSkips` (dirty was already false — the products from
  // last time are still valid) vs `bakeRuns` (dirty was true — a real
  // recompute happened) is the SAME "bakes vs polls" shape
  // `water-body-subsystem.js#getStatus` already reports, and answers a
  // question §5.8 (docs/planning/Performance-Audit-2026-08.md) already
  // raised but never measured: a scene where `touch()` fires far more often
  // than the derived products actually need to change (the arity-1 CRUD-hook
  // bug that file names — ANY field write to ANY Tile/Level triggers this)
  // would show as a bakeRuns/bakeSkips ratio much higher than the real
  // content-change rate. `!scene.gridSpec` (scene not ready yet) is counted
  // as neither — no cache decision was possible, not a hit.
  let bakeRuns = 0;
  let bakeSkips = 0;

  const counters = {
    pagesOffered: 0,
    pagesIngested: 0,
    pagesIgnored: 0,
    extractErrorCount: 0,
    // The art-opacity door (ingestItemAlpha) counts separately from the page
    // ingest: they have different producers and different failure modes, and
    // conflating them is how "coverAbove is zero" stayed unattributable.
    alphaOffered: 0,
    alphaIngested: 0,
    alphaIgnored: 0,
    // ⚠️ DID THE MASK'S OWN ALPHA SURVIVE THE DECODE? (2026-08-02). The
    // "transparent means unpainted" fix composites `_Outdoors` source-over by
    // the mask file's own alpha — which silently does NOTHING if the decode
    // path hands back an all-opaque alpha channel (a block-compressed or
    // flattened page would). Shader Lab reads the file directly and sees real
    // transparency; production reads a VT page. If these two counts disagree
    // with the file's real content, that is the divergence, and without them
    // the fix is unfalsifiable from a report.
    maskPagesWithRealAlpha: 0,
    maskPagesFullyOpaque: 0,
  };
  const extractErrors = [];

  /**
   * THE CASTER-HEIGHT INPUTS the derivation cannot know on its own — the scene's
   * distance→pixel conversion, the one authored building height, and the ROH
   * isolation toggles. Set by `setCasterHeightSpec`; until then `distancePixels`
   * is 0, which makes the two art-driven bands empty ON PURPOSE (a height field
   * built on a guessed grid scale would be wrong by a factor nobody could see).
   *
   * `gridMaxDim` (0 = "use the shared `gridSpec`", the pre-2026-07-30 default)
   * is the ONE piece here that is not itself a caster-height fact — it is the
   * sun-shadow performance tier's own `casterGridDim`, threaded through so a
   * higher tier can rasterize a CRISPER caster silhouette without raising
   * `MASK_GRID_MAX_DIM` for water/specular/wind too. See `mask-derive.js#
   * deriveFloorProducts`'s own `casterGridSpec` doc for why this has to be a
   * SEPARATE grid rather than a bigger shared one.
   */
  const casterSpec = {
    distancePixels: 0,
    buildingHeightPx: 0,
    include: { building: true, overhead: true, skyReach: true },
    gridMaxDim: 0,
  };

  function emptyScene() {
    return {
      sceneKey: null,
      gridSpec: null,
      floors: [], // {index, id, name, ceilingElevation}
      items: new Map(), // itemId -> collector item
      resolvePlacement: null, // (item, {width,height}) -> placement
      discovery: null, // mask-discovery result
      descriptorsByItemId: new Map(), // item.id (ANY kind) -> viewer layer descriptors
      ingests: new Map(), // `${itemId}/${contentId}` -> {content, placement}
      // THE BRUSH'S OWN DOOR (2026-08-18) — see `ingestPaintedMask`'s own doc.
      // A THIRD ingest source, alongside file discovery and the VT decode
      // stream, keyed by FLOOR (not item — a painted layer covers the whole
      // scene rect, it has no single owning item the way a Level/Tile does).
      paintedIngests: new Map(), // `${floorIndex}/${kindId}` -> {content, alpha, placement}
    };
  }

  function touch() {
    version++;
    dirty = true;
  }

  /**
   * Begin serving a scene. Everything the authority knows about the previous
   * scene — including ingested content — is dropped; the pager's fresh coarse
   * pins re-feed it within the same load.
   *
   * @param {object} args
   * @param {string} args.sceneKey - stable identity for reports.
   * @param {{sceneRect?: {x:number,y:number,width:number,height:number}, width: number, height: number}} args.dimensions
   * @param {Array<{index:number, id:string, name:string, ceilingElevation:number,
   *   bottomElevation?:number}>} args.floors - `bottomElevation` is the floor's
   *   GROUND (`elevation.bottom`); the caster-height derivation measures a
   *   raised tile's height from it. Non-finite = "no ground declared", which
   *   empties the overhead band rather than assuming zero.
   * @param {Array<object>} args.items - the UNFILTERED collector items (every
   *   floor visible) — cover physics must not depend on what the user is
   *   currently viewing.
   * @param {(item: object, size: {width:number, height:number}) => object} args.resolvePlacement -
   *   `foundry/scene-layers.js#computeItemPlacement` closed over `dimensions`,
   *   injected by boot (scene/ must not import foundry/).
   */
  function reset({ sceneKey, dimensions, floors, items, resolvePlacement }) {
    scene = emptyScene();
    scene.sceneKey = sceneKey;
    const rect = dimensions.sceneRect ?? { x: 0, y: 0, width: dimensions.width, height: dimensions.height };
    scene.gridSpec = computeMaskGridSpec(rect);
    scene.floors = floors.map((f) => ({ ...f }));
    scene.resolvePlacement = resolvePlacement;
    setItems(items);
    touch();
  }

  /**
   * Refresh the item set (boot calls this from the same document hooks that
   * refresh the renderer's draw list). Ingested content for surviving ids is
   * kept; content for removed ids is dropped.
   * @param {Array<object>} items
   */
  function setItems(items) {
    const next = new Map();
    for (const item of items ?? []) {
      if (COVER_ITEM_KINDS.has(item.kind)) next.set(item.id, item);
    }
    for (const key of [...scene.ingests.keys()]) {
      const itemId = key.slice(0, key.lastIndexOf('/'));
      if (!next.has(itemId)) scene.ingests.delete(key);
    }
    scene.items = next;
    touch();
  }

  /**
   * Accept discovery's verdict on which authored mask files exist. Also
   * pre-assembles each floor's viewer layer descriptors (through the ONE
   * catalog assembly, same as the fixture) so `layersForItem` is a sync map
   * lookup on the streaming path.
   * @param {import('../foundry/mask-discovery.js').MaskDiscoveryResult|null} result
   */
  function setDiscovery(result) {
    scene.discovery = result;
    scene.descriptorsByItemId = new Map();
    // `result.byTargetId` is keyed by item id UNIFORMLY now — background,
    // foreground AND tile alike (2026-07-26, `keyhole-mask-any-item-
    // decision`, LOCKED; boot.js's own discovery-target list changed to
    // match). Every discovered target's descriptors are assembled here,
    // unconditionally: `layersForItem` now serves all three kinds, so there
    // is no "nobody will ever look this up" case left to skip.
    for (const [itemId, urlByKindId] of result?.byTargetId ?? new Map()) {
      scene.descriptorsByItemId.set(itemId, assembleLayerDescriptors(urlByKindId));
    }
    touch();
  }

  /**
   * The viewer's `extraLayersForItem`. A mask can ride ANY drawable's own art
   * now — a Level's background OR foreground, or a Tile (2026-07-26,
   * `keyhole-mask-any-item-decision`, LOCKED) — so this streams whatever
   * discovery found beside THIS item's own art, uniformly. Tokens (the only
   * OTHER item kind the viewer ever asks about) never reach `scene.
   * descriptorsByItemId` at all, since discovery is never fed a token, so
   * this falls through to `[]` for them without needing its own kind check.
   * @param {object} item @returns {Array<object>}
   */
  function layersForItem(item) {
    return scene.descriptorsByItemId.get(item?.id) ?? [];
  }

  /**
   * The viewer's `onPageDecoded`. Called (synchronously — the bitmap is
   * closed by the caller afterwards) for every decoded COARSEST-mip page.
   * Cheap for anything the derivations don't need: one Map lookup + one plan
   * lookup, no pixel work.
   *
   * @param {object} info
   * @param {string} info.ownerId - the item whose pack decoded this page.
   * @param {string} info.layerName - 'albedo', the packed-trio layer, or a kind id.
   * @param {{worldWidthPx:number, worldHeightPx:number, maxMip:number}} info.table
   * @param {{mip:number, px:number, py:number}} info.page
   * @param {{dx:number, dy:number, dw:number, dh:number}} info.contentWindow -
   *   decode-pool's `computePagePlacement` for this page: where real content
   *   sits inside the square page canvas.
   * @param {any} info.bitmap
   */
  function ingestDecodedPage({ ownerId, layerName, table, page, contentWindow, bitmap }) {
    counters.pagesOffered++;
    if (page.mip !== table.maxMip) {
      counters.pagesIgnored++;
      return;
    }
    const item = scene.items.get(ownerId);
    if (!item) {
      counters.pagesIgnored++; // tokens, or an item removed mid-flight
      return;
    }
    const plan = extractionPlanForLayer(layerName);
    if (plan.length === 0) {
      counters.pagesIgnored++;
      return;
    }
    try {
      const imageData = readPageImageData(bitmap);
      // The mask file's native size can differ from the albedo's; resolving
      // placement from THIS pack's own table keeps each content grid mapped
      // through the geometry the renderer itself would use for that file.
      const placement = scene.resolvePlacement(item, {
        width: table.worldWidthPx,
        height: table.worldHeightPx,
      });
      // ⚠️ THE MASK FILE'S OWN ALPHA RIDES ALONGSIDE ITS CHANNEL (2026-08-02).
      // Author's ruling, live: *"Transparent means unpainted — composite by
      // alpha. Transparent also means not inside a building."* Without this,
      // `compositeItemOverwrite` writes a value for EVERY texel inside the
      // mask's placement RECTANGLE, and a transparent pixel's colour channel
      // is 0 — which for `_Outdoors` reads as INDOORS, i.e. a solid,
      // shadow-casting wall wherever the author simply did not paint. That is
      // the phantom "shadow cast by a 0-alpha edge" they reported.
      //
      // ⚠️ THIS ONLY BECAME TRUE WHEN THE PACKER STOPPED OVERWRITING IT.
      // `_Outdoors` does not arrive as its own image: it is the G channel of a
      // packed RGBA trio, and the packer used to write `_Shadow`'s alpha into
      // the slot under the comment "identical across the trio by design" — an
      // invariant that holds for the synthetic torture world and for nothing an
      // author ever painted. So this read returned the WRONG file's
      // transparency from the day it landed. `vt/decode-pool.js#
      // compositePackedTexels` now hands the alpha slot to the one trio member
      // that composites by alpha, which is this one.
      //
      // Extracted ONCE per page, not once per channel: every `contentId` in
      // this plan comes from the SAME image, so they share one alpha grid.
      // (`extractionPlanForLayer` only ever yields RASTERIZED kinds, and the
      // trio has exactly one — enforced in `validateCatalog` — so "the page's
      // alpha" and "this content's alpha" cannot diverge here.)
      // A fully-opaque mask (the entirely-black `_Outdoors` an underground
      // scene is authored with) composites exactly as it did before — alpha
      // is 255 everywhere, so the blend below is a provable no-op there.
      const alpha = extractContentWindow(imageData, contentWindow, 'a');
      // Is this alpha REAL, or did the decode hand back a flattened page? One
      // pass over bytes already in hand. "Real" means at least one texel is
      // meaningfully transparent — an all-opaque page makes the source-over
      // composite a no-op, which is correct for a genuinely opaque mask and a
      // silent failure for one the author painted with transparency.
      let anyTransparent = false;
      for (let i = 0; i < alpha.data.length; i++) {
        if (alpha.data[i] < 247) {
          anyTransparent = true;
          break;
        }
      }
      if (anyTransparent) counters.maskPagesWithRealAlpha++;
      else counters.maskPagesFullyOpaque++;
      for (const { contentId, channel } of plan) {
        const content = extractContentWindow(imageData, contentWindow, channel);
        scene.ingests.set(`${ownerId}/${contentId}`, { content, placement, alpha });
      }
      counters.pagesIngested++;
      touch();
    } catch (err) {
      counters.extractErrorCount++;
      extractErrors.push({ ownerId, layerName, error: String(err?.message || err) });
      if (extractErrors.length > EXTRACT_ERROR_LOG_MAX) extractErrors.shift();
      log.error(`mask ingest failed for ${ownerId}/${layerName}:`, err);
    }
  }

  /**
   * THE ART-OPACITY DOOR (2026-07-24). The viewer calls this once per item with
   * that item's coarse alpha grid (`vt/coarse-alpha.js` — decoded at grid
   * resolution in the BC worker, never at world resolution).
   *
   * ⚠️ WHY THIS EXISTS AS ITS OWN DOOR rather than more `ingestDecodedPage`:
   * art opacity used to arrive through the albedo PACK's coarsest page, and
   * whole-image mode has no albedo pack — `ensureItemLoaded` says so in its own
   * comment. So from 2026-07-22 until this door landed, `alpha` was `null` for
   * EVERY item, `coverAbove` was uniformly zero on every floor, and `skyReach`
   * was silently just a copy of `outdoors`. A page-shaped API could not be fed
   * by a path that has no pages; pretending otherwise is how the gap survived a
   * whole engine retirement unnoticed (see vt/coarse-alpha.js's header).
   *
   * Idempotent — a re-decode (cache hit on a later scene load) simply overwrites.
   * A `null`/absent grid is NOT ingested: the derivation's own
   * `completeness.missingItemIds` is the honest record of "we do not know what
   * this item covers", and inventing a zero grid there would read as "it covers
   * nothing", which is the silent-numeric-default class this project bans.
   *
   * @param {object} info
   * @param {string} info.ownerId - the item this alpha belongs to.
   * @param {{w:number, h:number, data:Uint8Array}} info.grid - the coarse alpha grid.
   * @param {number} info.imageWidth - the SOURCE image's native width (placement
   *   resolves from the file's own size, exactly as `ingestDecodedPage` does with
   *   its pack table — the art's native size is what the renderer places by).
   * @param {number} info.imageHeight
   * @returns {boolean} true if it was stored.
   */
  function ingestItemAlpha({ ownerId, grid, imageWidth, imageHeight }) {
    counters.alphaOffered++;
    const item = scene.items.get(ownerId);
    if (!item || !grid?.data || !(grid.w > 0 && grid.h > 0)) {
      counters.alphaIgnored++;
      return false;
    }
    if (!(imageWidth > 0 && imageHeight > 0)) {
      counters.alphaIgnored++;
      return false;
    }
    try {
      const placement = scene.resolvePlacement(item, { width: imageWidth, height: imageHeight });
      scene.ingests.set(`${ownerId}/${ALBEDO_INPUT}`, {
        content: { w: grid.w, h: grid.h, data: grid.data },
        placement,
      });
      counters.alphaIngested++;
      touch();
      return true;
    } catch (err) {
      counters.extractErrorCount++;
      extractErrors.push({ ownerId, layerName: ALBEDO_INPUT, error: String(err?.message || err) });
      if (extractErrors.length > EXTRACT_ERROR_LOG_MAX) extractErrors.shift();
      log.error(`alpha ingest failed for ${ownerId}:`, err);
      return false;
    }
  }

  /**
   * THE BRUSH'S OWN INGEST DOOR (2026-08-18) — `ui/paint-mode.js`'s in-app
   * painter hands its own in-memory `MaskGrid` straight here, closing the
   * gap this file's own header used to name as two-doors-only: a painted
   * layer is neither a discovered file nor a decoded VT page, so faking it
   * through one of those two shapes (a synthetic page/bitmap) would mean
   * reverse-engineering `vt/decode-pool.js`'s own pack geometry for no real
   * reason — `scene/paint-mask.js`'s own header already establishes that a
   * painted layer is a `MaskGrid` "sized over the scene rect... the SAME
   * grid type the mask authority uses for its derived products", so it
   * needs its own door, not a disguise.
   *
   * FLOOR-SCOPED, not item-scoped, unlike every other source in this file:
   * a painted layer covers the WHOLE scene rect (`ui/paint-mode.js` masks
   * are per-floor, never per-item), so it is keyed `${floorIndex}/${kindId}`
   * and composited as one extra, synthetic "host" in `sourcesFor` below —
   * appended LAST in draw order, so the author's own most recent in-app
   * edit wins over file-based content wherever painted, the identical
   * "later host overwrites earlier" law `compositeItemOverwrite`'s own doc
   * already states for Tiles.
   *
   * SELF-ALPHA: the grid has no alpha channel of its own to carry (unlike a
   * real mask FILE, whose alpha rides alongside its colour channel from the
   * same decode), so its own byte value is the only honest stand-in for
   * coverage. An unpainted texel (byte 0) is fully TRANSPARENT under
   * `compositeItemOverwrite`'s existing "transparent means unpainted" law
   * (2026-08-02) — the file/earlier source shows through completely
   * unchanged there — while a painted texel overwrites. That is what lets
   * the author's brush only ever ADD fire (or whatever kind) on top of a
   * file, never silently blank out everything the file painted outside the
   * stroke.
   *
   * ⚠️ THE ALPHA IS DERIVED THROUGH A RAMP, NOT PASSED THROUGH RAW
   * (2026-08-31). Handing the same byte in as BOTH value and alpha squared
   * it in the composite and broke every one of the claims in the paragraph
   * above for partial values — see `PAINTED_ALPHA_RAMP_BYTES`' own doc for
   * the arithmetic, the two measured symptoms, and why 16 is the number.
   *
   * ⚠️ THE GRID IS COPIED, NOT ALIASED (2026-08-31). `grid.data` is
   * `ui/paint-mode.js`'s OWN live working buffer, which it mutates in place
   * (Clear is `layer.data.fill(0)`, Undo is `layer.data.set(snapshot)`) and
   * hands here only through its Save-time `onLayersChanged` — a SNAPSHOT
   * contract, never a subscription. Storing the reference made the two the
   * same array: the authority's already-ingested content changed underneath
   * it with no `touch()`, so the render stayed correct until some UNRELATED
   * event (any Tile/Wall CRUD, a streaming page decode, a slider) happened
   * to dirty the products — at which point unsaved or already-undone paint
   * appeared in, or vanished from, the live render with no correlation to
   * anything the author had just done. One `.slice()` is the whole fix; the
   * alpha derivation below allocates its own array for the same reason.
   *
   * `grid=null`/`undefined` forgets this floor+kind's painted content
   * entirely. Most callers never need that: an ALL-UNPAINTED grid (every
   * byte 0) already composites as a total no-op under self-alpha, so
   * `ui/paint-mode.js`'s own save() simply re-ingests every in-memory
   * layer on every save, painted-empty ones included, and a fully-erased
   * layer stops affecting anything on its own, automatically.
   *
   * @param {number} floorIndex
   * @param {string} kindId - a `rasterize: true` mask-catalog kind.
   * @param {{spec: {x:number,y:number,width:number,height:number,w:number,h:number}, data: Uint8Array}|null|undefined} grid
   */
  function ingestPaintedMask(floorIndex, kindId, grid) {
    const kind = maskKindById(kindId);
    if (!kind) throw new Error(`unknown mask kind '${kindId}' — declare it in scene/mask-catalog.js`);
    const key = `${floorIndex}/${kindId}`;
    if (!grid?.spec || !grid?.data) {
      if (scene.paintedIngests.delete(key)) touch();
      return;
    }
    // ONE pass, two arrays: the snapshot copy and its own derived coverage.
    // Both are the painter's grid size (≤ PAINT_GRID_MAX_DIM² bytes each) and
    // both are paid ONCE per Save, never per frame and never per recompute —
    // `onLayersChanged` is the only caller and it fires from `save()` alone.
    const data = grid.data.slice();
    const alphaData = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) alphaData[i] = PAINTED_ALPHA_LUT[data[i]];
    scene.paintedIngests.set(key, {
      content: { w: grid.spec.w, h: grid.spec.h, data },
      // SELF-ALPHA, RAMPED — see this function's own doc and
      // `PAINTED_ALPHA_RAMP_BYTES`. Same geometry as `content` by
      // construction, which is what lets `compositeItemOverwrite`'s
      // minifying box filter premultiply the two together index-for-index.
      alpha: { w: grid.spec.w, h: grid.spec.h, data: alphaData },
      // ⚠️ THE ONE PRODUCER THAT OPTS INTO THE MINIFYING BOX FILTER
      // (2026-08-31) — `mask-derive.js#compositeItemOverwrite`'s MINIFICATION
      // section. The painter's grid is `PAINT_GRID_MAX_DIM` (4096) against
      // `MASK_GRID_MAX_DIM`'s 512: ONE destination texel covers 64 source
      // texels, and the single bilinear tap that is correct for a magnifying
      // FILE mip turns a small brush dab into a coin flip on sub-texel phase
      // (measured: real signal survived ~27% of phases; the painter's own
      // preview showed it at 100% of them). Set HERE, on the source, rather
      // than inferred from geometry in the composite, because a small masked
      // Tile's own FILE minifies too and changing its long-standing
      // compositing behaviour is not part of this fix.
      areaAverage: true,
      placement: {
        x: grid.spec.x,
        y: grid.spec.y,
        width: grid.spec.width,
        height: grid.spec.height,
        anchorX: 0,
        anchorY: 0,
        rotation: 0,
      },
    });
    touch();
  }

  /** The floor's background item, specifically. @param {{id:string}} floor */
  function backgroundItemOf(floor) {
    for (const item of scene.items.values()) {
      if (item.kind === 'levelBackground' && item.levelId === floor.id) return item;
    }
    return null;
  }

  /**
   * EVERY item that can host this floor's OWN mask paint — background,
   * foreground (neither assumed — a tiles-only floor has NEITHER and gets
   * its masks entirely from its own tiles) and every visible, non-hidden
   * Tile — in ASCENDING draw order (`scene/layer-order.js#compareLayerKeys`,
   * the SAME comparator the visible art itself paints by). 2026-07-26,
   * `keyhole-mask-any-item-decision` (LOCKED): a floor's mask is no longer
   * "the one background item's file"; it is whatever every one of these
   * items painted, composited in this exact order
   * (`mask-derive.js#rasterizeAuthored`).
   *
   * A hidden (GM-only) item is excluded — same reasoning `coverAbove`
   * already applies elsewhere in this file: players' sky is canon, so a
   * GM-only prop must not silently change what a player experiences as
   * indoor/outdoor.
   *
   * @param {{id:string}} floor
   * @returns {object[]}
   */
  /**
   * `scene.floors`' own vocabulary (`bottomElevation`/`ceilingElevation`)
   * translated into the elevation-band shape `scene/layer-order.js` speaks
   * (`elevationBottom`/`elevationTop`, `getActiveSceneFloors`'s own field
   * names). Adapted HERE, at the one boundary between them, rather than
   * teaching the shared membership rule two vocabularies — a second name for
   * the same number is how the two drift.
   */
  function floorBands() {
    return scene.floors.map((f) => ({
      index: f.index,
      id: f.id,
      elevationBottom: Number.isFinite(f.bottomElevation) ? f.bottomElevation : null,
      elevationTop: Number.isFinite(f.ceilingElevation) ? f.ceilingElevation : null,
    }));
  }

  function hostsOfFloor(floor) {
    // ⚠️ MEMBERSHIP, NOT VISIBILITY (2026-08-02). This used to ask
    // `visibleOnLevelIds.includes(floor.id)` — Foundry's `includedInLevel`
    // DRAW rule, whose default (an empty `levels` set) means "present on every
    // level". That made an ordinary ground-floor prop with a blank `levels`
    // field a wall-source for EVERY floor, so the roof cast the ground floor's
    // buildings. `maskHostFloorIndices` is the same sentence this file's own
    // `recomputeIfDirty` has carried in a comment since 2026-07-26 ("a tile's
    // level set says which floors it APPEARS on, not which one it BELONGS
    // to"), finally executable and shared with the derivation path.
    const bands = floorBands();
    const hosts = [];
    for (const item of scene.items.values()) {
      if (item.hidden) continue;
      if (maskHostFloorIndices(item, bands).includes(floor.index)) hosts.push(item);
    }
    hosts.sort((a, b) => compareLayerKeys(a.key, b.key));
    return hosts;
  }

  function recomputeIfDirty() {
    if (!scene.gridSpec) return; // not ready yet — no cache decision was possible, not a hit
    if (!dirty) {
      bakeSkips += 1;
      return;
    }
    bakeRuns += 1;
    const outdoorsKind = maskKindById('outdoors');

    // A LEVEL'S OWN ART BELONGS TO EXACTLY ONE FLOOR, and that is a stronger
    // fact than its elevation number (2026-07-26). See `DeriveItemInput.
    // ownerFloorIndex` for the bug this fixes — a level background sits at its
    // level's `elevation.bottom`, so the moment a scene's bands overlap even
    // slightly, an upper floor's whole background stops counting as "above"
    // while its foreground still does. Tiles get NO owner index on purpose:
    // a tile's level set says which floors it APPEARS on, not which one it
    // belongs to (an empty set means every floor), so only its elevation can
    // answer whether it is a rug or a roof.
    const floorIndexByLevelId = new Map(scene.floors.map((f) => [f.id, f.index]));
    const items = [];
    for (const item of scene.items.values()) {
      const ingest = scene.ingests.get(`${item.id}/${ALBEDO_INPUT}`);
      const ownsLevel = item.kind === 'levelBackground' || item.kind === 'levelForeground';
      // ⚠️ A TILE'S OWN FLOOR VISIBILITY OUTRANKS ITS ELEVATION NUMBER, same
      // reasoning as `ownerFloorIndex` for level art (2026-07-26, round two —
      // see `DeriveItemInput.visibleFloorIndices`). Author-confirmed live:
      // a raised prop with a SPECIFIC, non-empty `levels` set naming this
      // floor was still crossing this floor's own ceiling elevation and
      // reading as sky-reach — "art from a different floor" — for the SAME
      // floor it is drawn on. `scene-layers.js#collectTiles` already computes
      // exactly which floors a tile is visible on (`visibleOnLevelIds`); this
      // was previously discarded here on the stated (and wrong) theory that
      // "an empty set means every floor, so only elevation can answer" — true
      // for the EMPTY-set case, false the moment a tile names specific floors.
      const visibleFloorIndices = Array.isArray(item.visibleOnLevelIds)
        ? item.visibleOnLevelIds.map((id) => floorIndexByLevelId.get(id)).filter((i) => i !== undefined)
        : null;
      items.push({
        id: item.id,
        elevation: item.key?.elevation ?? 0,
        hidden: !!item.hidden,
        placement: ingest?.placement ?? null,
        alpha: ingest?.content ?? null,
        ownerFloorIndex: ownsLevel ? (floorIndexByLevelId.get(item.levelId) ?? null) : null,
        visibleFloorIndices: ownsLevel ? null : visibleFloorIndices,
      });
    }

    // Every `rasterize: true` kind EXCEPT outdoors, which keeps its own field
    // (two derived products are built on it — see mask-derive's DeriveFloorInput).
    const extraRasterized = rasterizedKinds().filter((k) => k.id !== 'outdoors');

    const floors = scene.floors.map((floor) => {
      const hosts = hostsOfFloor(floor);
      // Every host's own ingest for a kind, in the SAME draw order `hosts`
      // is already sorted in — `rasterizeAuthored` composites them in that
      // order, a LATER host overwriting an earlier one within their shared
      // footprint (never a MAX — see that function's own doc). A host with
      // no ingest for this particular kind simply contributes nothing to
      // it; it may still contribute to a DIFFERENT kind.
      const sourcesFor = (kindId) => {
        const fileSources = hosts
          // `ownerId`/`kind` ride along so `mask-derive.js#describeAuthoredSources`
          // can NAME a source in the report. A ledger of anonymous rows answers
          // "one of these is wrong" and not "this one is" — which is the
          // difference between a diagnosis and another round of guessing.
          .map((item) => {
            const ingest = scene.ingests.get(`${item.id}/${kindId}`);
            return ingest ? { ...ingest, ownerId: item.id, ownerKind: item.kind } : null;
          })
          .filter((ingest) => ingest?.content && ingest?.placement);
        // THE PAINTED LAYER, if any, composites LAST — see `ingestPaintedMask`'s
        // own doc for why (the author's own most recent in-app edit wins).
        // FLOOR-scoped, not item-scoped, so this is looked up once per floor
        // here rather than per host above.
        const painted = scene.paintedIngests.get(`${floor.index}/${kindId}`);
        return painted ? [...fileSources, { ...painted, ownerId: 'painted', ownerKind: 'painted' }] : fileSources;
      };
      const authored = {};
      for (const kind of extraRasterized) {
        // `absentValue` rides even when NOTHING authored this kind — the
        // entry must still be present so the rasterizer fills with the
        // KIND's absent value rather than a positional default. (Dropping
        // the entry to `null` would make every unauthored kind fill 0
        // regardless of what the catalog declares — correct for `water`,
        // silently wrong for the next kind with `absentValue: 1`.)
        authored[kind.id] = { sources: sourcesFor(kind.id), absentValue: kind.absentValue };
      }
      return {
        index: floor.index,
        ceilingElevation: floor.ceilingElevation,
        bottomElevation: floor.bottomElevation,
        outdoors: sourcesFor('outdoors'),
        authored,
      };
    });

    products = deriveFloorProducts({
      gridSpec: scene.gridSpec,
      // `casterSpec.gridMaxDim > 0` (a sun-shadow tier's own `casterGridDim`)
      // rasterizes the caster channels at a SECOND, independent resolution —
      // see mask-derive.js#deriveFloorProducts's own `casterGridSpec` doc.
      // `scene.gridSpec` doubles as the rect input here: `computeMaskGridSpec`
      // only reads `.x/.y/.width/.height`, all of which it already carries.
      casterGridSpec: casterSpec.gridMaxDim > 0 ? computeMaskGridSpec(scene.gridSpec, casterSpec.gridMaxDim) : null,
      // WATER'S OWN RESOLUTION (2026-08-17) — see `WATER_GRID_MAX_DIM`'s own
      // doc in mask-derive.js: the shared 512px grid POINT-samples, so a rock
      // painted as a small hole in a large map's `_Water` mask can fall
      // between texel centres and never seed the shore-distance field at all.
      // Fixed (not tier-gated, unlike the caster spec above) — this is a
      // content-fidelity floor, not a perf/quality trade, and the bake is
      // already off the frame budget (`water-body-subsystem.js §1`).
      authoredGridSpecs: { water: computeMaskGridSpec(scene.gridSpec, WATER_GRID_MAX_DIM) },
      items,
      floors,
      outdoorsAbsentValue: outdoorsKind?.absentValue ?? 1,
      casterHeights: {
        scalePx: CASTER_HEIGHT_SCALE_PX,
        distancePixels: casterSpec.distancePixels,
        buildingHeightPx: casterSpec.buildingHeightPx,
        include: casterSpec.include,
      },
    });
    productsVersion = version;
    dirty = false;
  }

  /**
   * A product for one floor: the grid + completeness, always fresh. Accepts
   * EITHER a DERIVED id ('coverAbove'/'skyReach'/'casterHeight') or an AUTHORED
   * kind id declared `rasterize: true` in mask-catalog.js ('outdoors',
   * 'water') — see that flag's own doc for why a raw authored value needs to
   * be served independent of any derived product built from it, and
   * `DerivedFloorProducts` for where each one is stored.
   *
   * Returns `null` for an id that resolves to no grid at all, which now
   * includes a legal-but-unrasterized authored kind (`fire`, `tree`, …): those
   * have no per-floor product to serve, and `null` says so rather than
   * `{ grid: undefined }`.
   *
   * @param {string} id - a derived id, or a `rasterize: true` kind id
   * @param {number} floorIndex
   * @returns {{grid: import('./mask-derive.js').MaskGrid, completeness: object, version: number}|null}
   * @throws {RequiredMaskMissingError} for a `required` kind (or anything
   *   derived from one) when NO file was ever discovered for this floor's
   *   level — never for "discovered but not yet decoded" (see
   *   `assertMaskAvailable`'s own doc). Never thrown for an unresolvable
   *   `floorIndex` (falls through to the existing `return null` below,
   *   unchanged) — a bogus floor index is a different caller-side question
   *   than "this real floor has no painted mask."
   */
  function getDerived(id, floorIndex, { acknowledgeMissingRequired = false } = {}) {
    if (!derivedKindById(id) && !maskKindById(id)) {
      throw new Error(`unknown mask/derived id '${id}' — declare it in scene/mask-catalog.js`);
    }
    recomputeIfDirty();
    const floor = products.find((p) => p.index === floorIndex);
    if (!floor) return null;
    const floorMeta = scene.floors.find((f) => f.index === floorIndex);
    // `acknowledgeMissingRequired` — a NARROW, NAMED opt-out (2026-07-25), not
    // a weakening of the rule. The rule exists because a silent default can
    // masquerade as data in a POINT query, where a wrong answer is invisible.
    // Pass this ONLY when: `absentValue` is the honest degradation here, the
    // degradation is REPORTED to the author, and you want grids for a
    // whole-field render rather than a yes/no about a point. One caller today —
    // the sun-shadow bake, where an unpainted floor genuinely has no known
    // building footprints (that channel derives to zero: a fact, not a guess)
    // while upper-floor art still blocks the sky. Refusing would mean a bridge
    // casts no shadow on the river below it purely because a scene with no
    // interiors never had a mask painted.
    if (floorMeta && !acknowledgeMissingRequired) assertMaskAvailable(id, floorMeta.id, floorMeta.name);
    // A `rasterize: true` kind other than `outdoors` lives under `authored`,
    // keyed by kind id (mask-derive's DerivedFloorProducts). `outdoors` keeps
    // its own top-level field, so `floor[id]` still finds it — checking
    // `authored` FIRST would be equally correct today and would silently
    // shadow a future top-level product that shares a name, so it is second.
    const grid = floor[id] ?? floor.authored?.[id] ?? null;
    if (!grid) return null;
    return {
      grid,
      // `casterHeight` alone also serves its three UNMERGED producer channels —
      // the GPU bake packs them into RGB so the author's isolation toggles and
      // the pixel probe can tell building from overhead from sky-reach. Every
      // other id gets `null`, so a consumer can never accidentally read another
      // product's channels.
      channels: id === 'casterHeight' ? floor.casterChannels : null,
      // ⚠️ MUST ride alongside `channels`, not be left for a wrapper to bolt on.
      // `casterHeight`'s bytes are meaningless without the scale that turns them
      // back into world px, and `scene/sky-reach-access.js#heightField` used to
      // be the ONLY place that attached it (from `maskAuthority.casterHeightScalePx`,
      // read at ITS OWN construction). A caller that needs `acknowledgeMissingRequired`
      // (a floor with no authored `_Outdoors`) has to bypass that wrapper to pass
      // the flag — `boot.js#getCasterHeightField`'s degraded branch is exactly
      // this — and got back a `scalePx` of `undefined`, which silently zeroed
      // every height byte on the way out: `(maxByte/255) * (undefined ?? 0)` is
      // always `0`, no matter how tall the real casters are. The coverage/count
      // channels stayed healthy throughout, which is what made this invisible —
      // the exact shape `feedback_instruments_must_not_lie` names. Declared here,
      // at the one producer, so no second caller can rediscover the same gap.
      scalePx: id === 'casterHeight' ? CASTER_HEIGHT_SCALE_PX : null,
      // Rides with the grid, not bolted on by a wrapper — the same discipline
      // `scalePx` above had to learn the hard way.
      outdoorsLedger: floor.outdoorsLedger ?? null,
      completeness: floor.completeness,
      version: productsVersion,
    };
  }

  /**
   * CPU query: the value 0..1 at a world (canvas-space) position — "is this
   * token under open sky?" / "is this location outdoors?" — costs one array
   * read. Outside the scene rect (or before any scene is set) the catalog's
   * absent value answers. `id` may be a DERIVED product ('coverAbove'/
   * 'skyReach') or the raw AUTHORED 'outdoors' value (see `getDerived`'s own
   * doc) — both share this one entry point, same as everything else a
   * consumer might want to sample per-point.
   * @param {string} id @param {number} floorIndex @param {number} wx @param {number} wy
   * @returns {number}
   */
  function sampleWorld(id, floorIndex, wx, wy) {
    const kind = derivedKindById(id) ?? maskKindById(id);
    if (!kind) throw new Error(`unknown mask/derived id '${id}' — declare it in scene/mask-catalog.js`);
    const product = getDerived(id, floorIndex);
    if (!product) return kind.absentValue;
    const byte = sampleMaskGridWorld(product.grid, wx, wy);
    return byte === null ? kind.absentValue : byte / 255;
  }

  /**
   * ⚠️🔬 THE CROSS-FLOOR MASK STACK AT ONE WORLD POINT — every floor, every
   * mask kind, every contributing source, with alphas.
   *
   * Author's own commission, 2026-08-02, after three rounds of cross-floor
   * shadow diagnosis each costing a live report: *"I could click in one place
   * and it'll probe the values for all floors at once and even directly tell
   * you the _Outside values for each floor... you should make it give the
   * exact colour values for every point, for every floor and for every mask.
   * That's some real data baby! It should pick up tiles too and give their
   * exact values. Be sure to account for partially transparent layers and
   * their alphas."*
   *
   * WHY THIS BEATS THE REPORTS IT SUPPLEMENTS: `getReport`/the sun-shadow
   * report describe ONE floor's WHOLE grid in aggregate. Neither can answer
   * "why is this exact pixel dark on floor 2 but light on floor 1", which is
   * the question every cross-floor bug actually poses — and an aggregate
   * provably cannot name a contributor (`feedback_aggregate_cannot_name_the_source`).
   * This returns the per-SOURCE arithmetic at one point, per floor, so the two
   * floors' stacks sit side by side and the divergence is read off, not
   * theorised.
   *
   * PURE READ — recomputes derived products if stale (the same lazy contract
   * every other reader here has) and touches nothing else. Safe from a
   * console at any time.
   *
   * @param {number} worldX @param {number} worldY
   * @returns {object} `{ worldX, worldY, floors: [...] }`, one entry per floor.
   */
  function probeStackAt(worldX, worldY) {
    recomputeIfDirty();
    const bands = floorBands();
    const byteOf = (grid) => (grid ? sampleMaskGridWorld(grid, worldX, worldY) : null);

    return {
      worldX,
      worldY,
      // Stated so a reader never has to guess whether a byte is 0..1 or 0..255.
      units: 'every *Byte is 0..255 as stored; alphaByte 255 = fully opaque, 0 = unpainted',
      floors: scene.floors.map((floor) => {
        const product = products?.find((p) => p.index === floor.index) ?? null;
        const hosts = hostsOfFloor(floor);

        // WHICH ITEMS HOST THIS FLOOR AT ALL, and why — the answer to "should
        // this tile even be here", which is the bug class this probe was
        // commissioned for (an unrestricted ground-floor prop hosting the roof).
        const hostRows = hosts.map((item) => ({
          id: item.id,
          kind: item.kind,
          elevation: item.key?.elevation ?? null,
          levelId: item.levelId || null,
          levelsRestricted: item.levelsRestricted ?? null,
          visibleOnLevelIds: item.visibleOnLevelIds ?? null,
          // Which mask kinds this host actually ingested content for — an
          // item can host a floor and contribute to only some kinds.
          ingestedKinds: MASK_KINDS.filter((k) => scene.ingests.has(`${item.id}/${k.id}`)).map((k) => k.id),
        }));

        // EVERY AUTHORED KIND, composited, plus the per-source arithmetic that
        // produced it. `outdoors` keeps its own top-level product field; every
        // other rasterized kind lives under `authored` (see `getDerived`).
        const masks = {};
        for (const kind of MASK_KINDS) {
          const grid = kind.id === 'outdoors' ? product?.outdoors : (product?.authored?.[kind.id] ?? null);
          const sources = hosts
            .map((item) => {
              const ingest = scene.ingests.get(`${item.id}/${kind.id}`);
              return ingest ? { ...ingest, ownerId: item.id } : null;
            })
            .filter((s) => s?.content && s?.placement);
          const replay = sampleAuthoredSourcesAt(sources, kind.absentValue, worldX, worldY);
          masks[kind.id] = {
            // The grid's own answer and the replay's must agree; when they do
            // not, the packing/rasterization diverged from the sources and
            // THAT is the finding (they are computed independently on purpose).
            compositedByte: byteOf(grid),
            replayedByte: sources.length > 0 ? replay.value : null,
            absentByte: Math.round(kind.absentValue * 255),
            sourceCount: sources.length,
            sources: replay.rows,
          };
        }

        // THE DERIVED PRODUCTS, which no source list explains — they are
        // computed FROM the above (plus item art alpha), so a healthy
        // `outdoors` beside a wrong `skyReach` localises the fault to the
        // derivation rather than the masks.
        const derived = {};
        for (const d of DERIVED_KINDS) derived[d.id] = byteOf(product?.[d.id] ?? null);

        // THE LAYER-SMEAR CHANNELS, in the shader's own vocabulary, so this
        // probe and `casterField.channelStats` can be compared term for term
        // (`effects/lighting/sun-shadow-subsystem.js#packLayerTexelData`).
        const outdoorsByte = byteOf(product?.outdoors ?? null);
        const layerSmear = {
          wallsByte: outdoorsByte === null ? null : 255 - outdoorsByte,
          overheadByte: byteOf(product?.casterChannels?.coverOverhead ?? null),
          floorAboveByte: byteOf(product?.coverAbove ?? null),
          receiverGateByte: outdoorsByte,
          note: 'walls = 255 - outdoors; receiverGate IS outdoors (a pixel only receives shadow where it is outdoors)',
        };

        return {
          floorIndex: floor.index,
          id: floor.id,
          name: floor.name ?? null,
          bottomElevation: floor.bottomElevation ?? null,
          ceilingElevation: floor.ceilingElevation ?? null,
          band: bands.find((b) => b.index === floor.index) ?? null,
          hosts: hostRows,
          masks,
          derived,
          layerSmear,
        };
      }),
    };
  }

  /**
   * Serving status for an AUTHORED kind on ONE ITEM — provenance made
   * explicit, so a default can never be mistaken for authored data. Works
   * identically for a Level's background, a Level's foreground, OR a Tile
   * (2026-07-26, `keyhole-mask-any-item-decision`, LOCKED — the three item
   * kinds `foundry/scene-layers.js#collectSceneLayers` produces are ALL
   * first-class mask hosts, symmetrically; nothing here special-cases one).
   *
   * URL-only: this reads discovery's own verdict, never the ingest/
   * rasterization pipeline. For the FLOOR's own composited grid — which now
   * DOES merge every host's own paint together, in draw order, a later host
   * overwriting an earlier one within its own footprint — read
   * `getDerived`/`sampleWorld` instead (see `hostsOfFloor`'s own doc).
   *
   * @param {string} itemId @param {string} kindId
   * @returns {{source: 'authored', url: string}|{source: 'default', value: number}}
   */
  function authoredStatusForItem(itemId, kindId) {
    const kind = maskKindById(kindId);
    if (!kind) throw new Error(`unknown mask kind '${kindId}' — declare it in scene/mask-catalog.js`);
    const url = scene.discovery?.byTargetId?.get(itemId)?.get(kindId);
    return url ? { source: 'authored', url } : { source: 'default', value: kind.absentValue };
  }

  /**
   * `authoredStatusForItem`'s convenience wrapper for the single most common
   * case: "this LEVEL's own background file". A thin resolve-then-delegate,
   * reading the exact SAME underlying map — never a second, parallel lookup
   * (2026-07-26: this used to BE the only door, keyed by level id straight
   * into discovery's own map; now that discovery is keyed uniformly by item
   * id — see `foundry/mask-discovery.js`'s own header — this resolves the
   * level's background item first). A level with no background item at all
   * (a tiles-only floor) correctly serves the default here — its OWN masks
   * still exist, just not reachable through this specific, background-only
   * door; see `hostsOfFloor` for the floor-wide question.
   * @param {string} levelId @param {string} kindId
   * @returns {{source: 'authored', url: string}|{source: 'default', value: number}}
   */
  function authoredStatus(levelId, kindId) {
    const kind = maskKindById(kindId);
    if (!kind) throw new Error(`unknown mask kind '${kindId}' — declare it in scene/mask-catalog.js`);
    const bgItem = backgroundItemOf({ id: levelId });
    if (!bgItem) return { source: 'default', value: kind.absentValue };
    return authoredStatusForItem(bgItem.id, kindId);
  }

  /**
   * Which `required` AUTHORED kinds have NO discovered file from ANY host of
   * this floor — background, foreground, or any visible Tile (2026-07-26,
   * `keyhole-mask-any-item-decision`, LOCKED: a tiles-only floor whose
   * outdoors comes entirely from a Tile must not be flagged as missing it
   * just because it has no background item to check). NEVER "discovered but
   * not yet decoded" (that reads `source: 'authored'` from
   * `authoredStatusForItem`, a transient streaming state, not a gap). Cheap:
   * a handful of Map lookups over the small, fixed `MASK_KINDS` array, per
   * host of one floor.
   * @param {string} levelId
   * @returns {Set<string>}
   */
  function requiredMissingAuthoredIds(levelId) {
    const missing = new Set();
    const floor = scene.floors.find((f) => f.id === levelId);
    if (!floor) return missing;
    const hosts = hostsOfFloor(floor);
    for (const kind of MASK_KINDS) {
      if (!kind.required) continue;
      const anyAuthored = hosts.some((item) => authoredStatusForItem(item.id, kind.id).source === 'authored');
      if (!anyAuthored) missing.add(kind.id);
    }
    return missing;
  }

  /**
   * `requiredMissingAuthoredIds` PLUS every DERIVED kind that transitively
   * depends on one of them (e.g. `outdoors` missing blocks `skyReach` too,
   * since `skyReach`'s own `inputs` include `outdoors`) — one linear pass
   * over `DERIVED_KINDS` is enough because declaration order IS dependency
   * order (`validateMaskCatalog` forbids a forward reference), so no
   * recursion is needed to catch a chain more than one derived kind deep.
   * @param {string} levelId
   * @returns {Set<string>}
   */
  function blockedIdsForLevel(levelId) {
    const blocked = requiredMissingAuthoredIds(levelId);
    if (blocked.size === 0) return blocked;
    for (const d of DERIVED_KINDS) {
      if (d.inputs.some((input) => blocked.has(input))) blocked.add(d.id);
    }
    return blocked;
  }

  /**
   * Throw `RequiredMaskMissingError` iff `id` (an authored OR derived kind)
   * is blocked for this level — see `blockedIdsForLevel`'s own doc. A no-op
   * (never throws) for a kind that isn't `required` and doesn't depend on
   * one, which is every kind except `outdoors`/`skyReach` today.
   * @param {string} id @param {string} levelId @param {string} floorName
   */
  function assertMaskAvailable(id, levelId, floorName) {
    const blocked = blockedIdsForLevel(levelId);
    if (!blocked.has(id)) return;
    // Which ACTUAL required authored kind is the root cause — `id` itself if
    // it IS one, otherwise whichever missing authored kind `id` depends on
    // (there is exactly one today; MASK_KINDS' own uniqueness + the tiny
    // DERIVED_KINDS graph make a first-match correct, not just convenient).
    const rootKindId = maskKindById(id)?.required ? id : ([...blocked].find((b) => maskKindById(b)?.required) ?? id);
    throw new RequiredMaskMissingError(rootKindId, levelId, floorName, id);
  }

  /**
   * A THIRD provenance state, beyond `authoredStatus`'s authored/default —
   * "was this floor's outdoors content ever actually DECODED and ingested",
   * as opposed to merely discovered as a URL. Added 2026-07-22: a live report
   * showed `authoredStatus(...).source === 'authored'` (a real `_Outdoors`
   * file was found for the level) yet `sampleWorld('outdoors', ...)` still
   * read the absent-value fallback everywhere on that floor — a state
   * `authoredStatus` alone cannot distinguish, because discovery (finding a
   * URL) and ingest (decoding that file's actual pixels) are two separate
   * pipeline stages (this file's own header diagram: `setDiscovery` vs
   * `ingestDecodedPage`), and nothing before this exposed whether the SECOND
   * stage had ever actually run for a specific floor's specific content.
   * `outdoorsIngested` now asks across EVERY host of the floor (2026-07-26,
   * `keyhole-mask-any-item-decision`), not just the background — a tiles-
   * only floor whose outdoors comes entirely from a Tile must not report
   * `false` here just because it has no background item at all.
   *
   * @param {number} floorIndex
   * @returns {{floorFound:boolean, backgroundItemId:string|null, outdoorsIngested:boolean}}
   */
  function getIngestStatus(floorIndex) {
    const floor = scene.floors.find((f) => f.index === floorIndex);
    if (!floor) return { floorFound: false, backgroundItemId: null, outdoorsIngested: false };
    const bg = backgroundItemOf(floor);
    return {
      floorFound: true,
      backgroundItemId: bg?.id ?? null,
      outdoorsIngested: hostsOfFloor(floor).some((item) => scene.ingests.has(`${item.id}/outdoors`)),
    };
  }

  /** The debug-panel report payload — the whole story, one click. */
  function getReport() {
    recomputeIfDirty();
    return buildMaskAuthorityReport({
      catalog,
      scene,
      products,
      version,
      productsVersion,
      counters,
      extractErrors,
      requiredMissingAuthoredIds,
    });
  }

  /**
   * ONE-SHOT mask discovery's own summary (cache-completeness pass,
   * 2026-08-12) — see `foundry/mask-discovery.js`'s own header for why this
   * has no ongoing hit/miss pair to poll: `listingCache`/`probeMemo` are
   * function-LOCAL to `discoverAuthoredMasks`, discarded the instant it
   * returns. `scene.discovery` is the STORED result from the one run at
   * scene load (`setDiscovery` above), so this reads that instead of trying
   * to observe something that no longer exists. `null` before discovery has
   * ever run.
   */
  function getDiscoveryStats() {
    if (!scene.discovery) return null;
    // Defensive against `perFloor`/`failures` being absent, not just empty —
    // several existing tests build a `setDiscovery` payload by hand with
    // only the fields THEIR OWN assertions need (byTargetId/method), same
    // as any other partial-fixture risk this codebase already guards for
    // elsewhere. `Array.isArray` before `.length`/`.filter` turns a missing
    // field into an honest `null`, never a throw.
    const perFloor = Array.isArray(scene.discovery.perFloor) ? scene.discovery.perFloor : null;
    const failures = Array.isArray(scene.discovery.failures) ? scene.discovery.failures : null;
    return {
      method: scene.discovery.method ?? null,
      probesAttempted: Number.isFinite(scene.discovery.probesAttempted) ? scene.discovery.probesAttempted : null,
      floorsDiscovered: perFloor ? perFloor.length : null,
      floorsWithMasks: perFloor ? perFloor.filter((f) => f.found > 0).length : null,
      failures: failures ? failures.length : null,
    };
  }

  return {
    reset,
    setItems,
    setDiscovery,
    getDiscoveryStats,
    layersForItem,
    ingestDecodedPage,
    ingestItemAlpha,
    ingestPaintedMask,
    /**
     * Set the caster-height inputs (docs/planning/Sun-Shadows.md §3.1). Marks
     * the products dirty only when something ACTUALLY changed — this is called
     * from a param apply that fires on every cascade resolve, and rebuilding a
     * 512² height field per slider tick is exactly the kind of hidden per-frame
     * work this project keeps finding.
     *
     * @param {{distancePixels?: number, buildingHeightPx?: number,
     *   include?: {building?: boolean, overhead?: boolean, skyReach?: boolean},
     *   gridMaxDim?: number}} spec - `gridMaxDim` 0/absent = share `gridSpec`
     *   (today's behaviour); >0 = the caster channels rasterize at THIS
     *   resolution instead (`layer-smear.js#layerSmearTierPlan`'s
     *   `layerGridDim`, resolved by the caller before this call).
     * @returns {boolean} true if anything changed (and a rebuild is now pending).
     */
    setCasterHeightSpec(spec = {}) {
      const nextDistance = Number.isFinite(spec.distancePixels) && spec.distancePixels > 0 ? spec.distancePixels : 0;
      const nextBuilding =
        Number.isFinite(spec.buildingHeightPx) && spec.buildingHeightPx > 0 ? spec.buildingHeightPx : 0;
      const nextInclude = {
        building: spec.include?.building !== false,
        overhead: spec.include?.overhead !== false,
        skyReach: spec.include?.skyReach !== false,
      };
      const nextGridMaxDim = Number.isFinite(spec.gridMaxDim) && spec.gridMaxDim > 0 ? Math.floor(spec.gridMaxDim) : 0;
      const changed =
        nextDistance !== casterSpec.distancePixels ||
        nextBuilding !== casterSpec.buildingHeightPx ||
        nextInclude.building !== casterSpec.include.building ||
        nextInclude.overhead !== casterSpec.include.overhead ||
        nextInclude.skyReach !== casterSpec.include.skyReach ||
        nextGridMaxDim !== casterSpec.gridMaxDim;
      if (!changed) return false;
      casterSpec.distancePixels = nextDistance;
      casterSpec.buildingHeightPx = nextBuilding;
      casterSpec.include = nextInclude;
      casterSpec.gridMaxDim = nextGridMaxDim;
      touch();
      return true;
    },
    /** World px a `casterHeight` byte of 255 represents — every consumer needs
     * it to turn the served 0..1 value back into a height. */
    casterHeightScalePx: CASTER_HEIGHT_SCALE_PX,
    /**
     * The scene-wide building height, world px, live (reads `casterSpec`
     * directly rather than snapshotting — `setCasterHeightSpec` can change it
     * after construction). ROUND SEVEN (sun-occlusion.js): building height is
     * no longer baked into any PER-TEXEL caster channel — the march reads this
     * ONE number as a uniform, combined with the per-texel `outdoors` byte
     * already carried in the caster texture's own gate channel. A method, not
     * a plain property, for exactly the reason `buildingHeightPx` itself is
     * mutable and a snapshot would go stale the first time the slider moves.
     *
     * ⚠️ HONOURS `include.building` (2026-07-30 — the sun-shadow debug view's
     * isolation was a lie for every mode except "building only"). The march's
     * COLUMN test reads this uniform completely independently of any per-texel
     * caster channel, so `include: {building: false}` — which correctly zeroes
     * the PER-TEXEL `casterBuilding`/`coverBuilding` grids in
     * `deriveFloorProducts` — left this scalar untouched. "Shadows — sky-reach
     * only" and "— overhead only" therefore still ran the FULL column test on
     * top of their own restricted band contribution: the same clean shape
     * `shadow-building` shows on its own, unioned with a differently-edged
     * band shadow for the same structure, which is exactly the doubled
     * silhouette + bright seam the author found live. Zeroing here, at the
     * one place every caller already reads through, fixes every caller at
     * once rather than requiring each to remember to gate it separately.
     */
    getBuildingHeightPx() {
      return casterSpec.include.building ? casterSpec.buildingHeightPx : 0;
    },
    getDerived,
    sampleWorld,
    probeStackAt,
    authoredStatus,
    authoredStatusForItem,
    getReport,
    getIngestStatus,
    /**
     * The DERIVED products' own version counter — bumps only when
     * `recomputeIfDirty()` actually recomputes (a real content change),
     * unlike `version` (bumps on every `touch()`, including plain item-list
     * refreshes). A cheap O(1) integer read, safe to poll every frame — added
     * 2026-07-21 specifically so a consumer that CACHES a derived value (Wind
     * Tier 1's exposure grid) can detect "the underlying mask data changed"
     * without needing mask-authority itself to grow a push-notification
     * mechanism, which would contradict this file's own stated design
     * ("STALENESS IS LAZY, NOT SCHEDULED" — see this module's header).
     * Forces a recompute first (same as any other read) so the returned
     * number is never stale relative to ingests that already happened.
     */
    getProductsVersion() {
      recomputeIfDirty();
      return productsVersion;
    },
    /** BAKE-GATE HEALTH — see `bakeRuns`/`bakeSkips`' own declaration above.
     * Lifetime counters; a caller wanting one window's rate samples this
     * before and after, same convention as `depth-proxy-material-pool.js`'s
     * `stats()`. Deliberately NOT gated behind `recomputeIfDirty()` — this
     * reports the counters' CURRENT state, and forcing a recompute just to
     * read them would corrupt the very count being read. */
    getBakeStats() {
      return { bakeRuns, bakeSkips };
    },
    /**
     * Which floors have AUTHORED content for a `rasterize: true` kind — the
     * input `resolveWaterFloor` (effects/water/water-floor.js) needs to decide
     * whether the viewed floor has its own water or must borrow from below.
     *
     * "Authored" here means the completeness record says `authored`, NOT that
     * the grid is non-empty: a floor whose `_Water` mask exists but is painted
     * entirely black HAS water authoring (the author said "no water here"),
     * and must not silently borrow the river from the floor beneath. Those two
     * are the same all-zero grid and different facts — which is the whole
     * reason `authoredSources` is recorded separately from the data.
     *
     * @param {string} kindId - a `rasterize: true` kind ('water').
     * @returns {number[]} floor indices, ascending.
     */
    floorsWithAuthored(kindId) {
      recomputeIfDirty();
      return products
        .filter((p) =>
          kindId === 'outdoors'
            ? p.completeness.outdoorsSource === 'authored'
            : p.completeness.authoredSources?.[kindId] === 'authored'
        )
        .map((p) => p.index)
        .sort((a, b) => a - b);
    },
  };
}
