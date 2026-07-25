/**
 * THE MASK AUTHORITY — the single source of truth for SERVING world-space
 * content layers: which authored masks exist per floor (discovery's result),
 * what every consumer gets where none exists (the catalog's absence
 * defaults), and the derived products computed from what has streamed
 * (coverAbove, skyReach). One instance, owned by boot, reset per scene.
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
 *   - Masks attach to LEVEL BACKGROUND art only (V2's authoring convention:
 *     masks are siblings of the floor's art file). Tiles/foregrounds/tokens
 *     contribute art ALPHA to coverAbove but carry no mask files of their own.
 *   - A mid-session Level background URL change re-discovers only on scene
 *     restart (same limit as the viewer's own pack cache).
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
import { computeMaskGridSpec, deriveFloorProducts, sampleMaskGridWorld, extractContentWindow } from './mask-derive.js';

const EXTRACT_ERROR_LOG_MAX = 10;

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
  };
  const extractErrors = [];

  /**
   * THE CASTER-HEIGHT INPUTS the derivation cannot know on its own — the scene's
   * distance→pixel conversion, the one authored building height, and the ROH
   * isolation toggles. Set by `setCasterHeightSpec`; until then `distancePixels`
   * is 0, which makes the two art-driven bands empty ON PURPOSE (a height field
   * built on a guessed grid scale would be wrong by a factor nobody could see).
   */
  const casterSpec = {
    distancePixels: 0,
    buildingHeightPx: 0,
    include: { building: true, overhead: true, skyReach: true },
  };

  function emptyScene() {
    return {
      sceneKey: null,
      gridSpec: null,
      floors: [], // {index, id, name, ceilingElevation}
      items: new Map(), // itemId -> collector item
      resolvePlacement: null, // (item, {width,height}) -> placement
      discovery: null, // mask-discovery result
      descriptorsByLevelId: new Map(), // levelId -> viewer layer descriptors
      ingests: new Map(), // `${itemId}/${contentId}` -> {content, placement}
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
    scene.descriptorsByLevelId = new Map();
    for (const [levelId, urlByKindId] of result?.byLevelId ?? new Map()) {
      scene.descriptorsByLevelId.set(levelId, assembleLayerDescriptors(urlByKindId));
    }
    touch();
  }

  /**
   * The viewer's `extraLayersForItem`. Masks ride level BACKGROUND art only
   * (see header); everything else streams albedo alone.
   * @param {object} item @returns {Array<object>}
   */
  function layersForItem(item) {
    if (item?.kind !== 'levelBackground') return [];
    return scene.descriptorsByLevelId.get(item.levelId) ?? [];
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
      for (const { contentId, channel } of plan) {
        const content = extractContentWindow(imageData, contentWindow, channel);
        scene.ingests.set(`${ownerId}/${contentId}`, { content, placement });
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

  /** The floor's background item (masks + outdoors content key off it). @param {{id:string}} floor */
  function backgroundItemOf(floor) {
    for (const item of scene.items.values()) {
      if (item.kind === 'levelBackground' && item.levelId === floor.id) return item;
    }
    return null;
  }

  function recomputeIfDirty() {
    if (!dirty || !scene.gridSpec) return;
    const outdoorsKind = maskKindById('outdoors');

    const items = [];
    for (const item of scene.items.values()) {
      const ingest = scene.ingests.get(`${item.id}/${ALBEDO_INPUT}`);
      items.push({
        id: item.id,
        elevation: item.key?.elevation ?? 0,
        hidden: !!item.hidden,
        placement: ingest?.placement ?? null,
        alpha: ingest?.content ?? null,
      });
    }

    // Every `rasterize: true` kind EXCEPT outdoors, which keeps its own field
    // (two derived products are built on it — see mask-derive's DeriveFloorInput).
    const extraRasterized = rasterizedKinds().filter((k) => k.id !== 'outdoors');

    const floors = scene.floors.map((floor) => {
      const bgItem = backgroundItemOf(floor);
      const outdoors = bgItem ? (scene.ingests.get(`${bgItem.id}/outdoors`) ?? null) : null;
      const authored = {};
      for (const kind of extraRasterized) {
        const ingest = bgItem ? (scene.ingests.get(`${bgItem.id}/${kind.id}`) ?? null) : null;
        // `absentValue` rides even when there is NO ingest — the entry must
        // still be present so the rasterizer fills with the KIND's absent
        // value rather than a positional default. (Dropping the entry to
        // `null` would make every unauthored kind fill 0 regardless of what
        // the catalog declares — correct for `water`, silently wrong for the
        // next kind with `absentValue: 1`.)
        authored[kind.id] = {
          placement: ingest?.placement ?? null,
          content: ingest?.content ?? null,
          absentValue: kind.absentValue,
        };
      }
      return {
        index: floor.index,
        ceilingElevation: floor.ceilingElevation,
        bottomElevation: floor.bottomElevation,
        outdoors: outdoors ? { placement: outdoors.placement, content: outdoors.content } : null,
        authored,
      };
    });

    products = deriveFloorProducts({
      gridSpec: scene.gridSpec,
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
   * Serving status for an AUTHORED kind on one floor — provenance made
   * explicit, so a default can never be mistaken for authored data.
   * @param {string} levelId @param {string} kindId
   * @returns {{source: 'authored', url: string}|{source: 'default', value: number}}
   */
  function authoredStatus(levelId, kindId) {
    const kind = maskKindById(kindId);
    if (!kind) throw new Error(`unknown mask kind '${kindId}' — declare it in scene/mask-catalog.js`);
    const url = scene.discovery?.byLevelId?.get(levelId)?.get(kindId);
    return url ? { source: 'authored', url } : { source: 'default', value: kind.absentValue };
  }

  /**
   * Which `required` AUTHORED kinds have no discovered file for this level —
   * NEVER "discovered but not yet decoded" (that reads `source: 'authored'`
   * from `authoredStatus`, a transient streaming state, not a gap). Cheap: a
   * handful of Map lookups over the small, fixed `MASK_KINDS` array.
   * @param {string} levelId
   * @returns {Set<string>}
   */
  function requiredMissingAuthoredIds(levelId) {
    const missing = new Set();
    for (const kind of MASK_KINDS) {
      if (!kind.required) continue;
      if (authoredStatus(levelId, kind.id).source === 'default') missing.add(kind.id);
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
      outdoorsIngested: bg ? scene.ingests.has(`${bg.id}/outdoors`) : false,
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

  return {
    reset,
    setItems,
    setDiscovery,
    layersForItem,
    ingestDecodedPage,
    ingestItemAlpha,
    /**
     * Set the caster-height inputs (docs/planning/Sun-Shadows.md §3.1). Marks
     * the products dirty only when something ACTUALLY changed — this is called
     * from a param apply that fires on every cascade resolve, and rebuilding a
     * 512² height field per slider tick is exactly the kind of hidden per-frame
     * work this project keeps finding.
     *
     * @param {{distancePixels?: number, buildingHeightPx?: number,
     *   include?: {building?: boolean, overhead?: boolean, skyReach?: boolean}}} spec
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
      const changed =
        nextDistance !== casterSpec.distancePixels ||
        nextBuilding !== casterSpec.buildingHeightPx ||
        nextInclude.building !== casterSpec.include.building ||
        nextInclude.overhead !== casterSpec.include.overhead ||
        nextInclude.skyReach !== casterSpec.include.skyReach;
      if (!changed) return false;
      casterSpec.distancePixels = nextDistance;
      casterSpec.buildingHeightPx = nextBuilding;
      casterSpec.include = nextInclude;
      touch();
      return true;
    },
    /** World px a `casterHeight` byte of 255 represents — every consumer needs
     * it to turn the served 0..1 value back into a height. */
    casterHeightScalePx: CASTER_HEIGHT_SCALE_PX,
    getDerived,
    sampleWorld,
    authoredStatus,
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
