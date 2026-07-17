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
  validateMaskCatalog,
  maskKindById,
  derivedKindById,
  assembleLayerDescriptors,
  extractionPlanForLayer,
} from './mask-catalog.js';
import {
  computeMaskGridSpec,
  deriveFloorProducts,
  sampleMaskGridWorld,
  maskGridMean,
  extractContentWindow,
} from './mask-derive.js';

const EXTRACT_ERROR_LOG_MAX = 10;

/** Item kinds that participate in cover derivation (never tokens — they move
 * constantly and are not architecture). */
const COVER_ITEM_KINDS = new Set(['levelBackground', 'levelForeground', 'tile']);

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

  const counters = { pagesOffered: 0, pagesIngested: 0, pagesIgnored: 0, extractErrorCount: 0 };
  const extractErrors = [];

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
   * @param {Array<{index:number, id:string, name:string, ceilingElevation:number}>} args.floors
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

    const floors = scene.floors.map((floor) => {
      const bgItem = backgroundItemOf(floor);
      const outdoors = bgItem ? (scene.ingests.get(`${bgItem.id}/outdoors`) ?? null) : null;
      return {
        index: floor.index,
        ceilingElevation: floor.ceilingElevation,
        outdoors: outdoors ? { placement: outdoors.placement, content: outdoors.content } : null,
      };
    });

    products = deriveFloorProducts({
      gridSpec: scene.gridSpec,
      items,
      floors,
      outdoorsAbsentValue: outdoorsKind?.absentValue ?? 1,
    });
    productsVersion = version;
    dirty = false;
  }

  /**
   * A derived product for one floor: the grids + completeness, always fresh.
   * @param {string} derivedId - 'coverAbove' | 'skyReach'
   * @param {number} floorIndex
   * @returns {{grid: import('./mask-derive.js').MaskGrid, completeness: object, version: number}|null}
   */
  function getDerived(derivedId, floorIndex) {
    if (!derivedKindById(derivedId))
      throw new Error(`unknown derived mask '${derivedId}' — declare it in scene/mask-catalog.js`);
    recomputeIfDirty();
    const floor = products.find((p) => p.index === floorIndex);
    if (!floor) return null;
    return { grid: floor[derivedId], completeness: floor.completeness, version: productsVersion };
  }

  /**
   * CPU query: the derived value 0..1 at a world (canvas-space) position —
   * "is this token under open sky?" costs one array read. Outside the scene
   * rect (or before any scene is set) the catalog's absent value answers.
   * @param {string} derivedId @param {number} floorIndex @param {number} wx @param {number} wy
   * @returns {number}
   */
  function sampleWorld(derivedId, floorIndex, wx, wy) {
    const kind = derivedKindById(derivedId);
    if (!kind) throw new Error(`unknown derived mask '${derivedId}' — declare it in scene/mask-catalog.js`);
    const product = getDerived(derivedId, floorIndex);
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

  /** The debug-panel report payload — the whole story, one click. */
  function getReport() {
    recomputeIfDirty();
    const tail = (u) => (typeof u === 'string' && u.length > 60 ? `…${u.slice(-57)}` : u);
    return {
      catalog: { ok: catalog.ok, errors: catalog.errors, kinds: MASK_KINDS.length, derived: DERIVED_KINDS.length },
      sceneKey: scene.sceneKey,
      grid: scene.gridSpec ? { w: scene.gridSpec.w, h: scene.gridSpec.h } : null,
      version,
      productsVersion,
      discovery: scene.discovery
        ? {
            method: scene.discovery.method ?? null,
            failures: scene.discovery.failures ?? [],
            probesAttempted: scene.discovery.probesAttempted ?? 0,
          }
        : 'NOT RUN — authored masks cannot exist yet this session',
      floors: scene.floors.map((floor) => {
        const found = scene.discovery?.byLevelId?.get(floor.id);
        const product = products.find((p) => p.index === floor.index);
        return {
          index: floor.index,
          name: floor.name,
          ceilingElevation: floor.ceilingElevation,
          authored: Object.fromEntries(
            MASK_KINDS.map((k) => {
              const url = found?.get(k.id);
              return [k.id, url ? tail(url) : `default(${k.absentValue})`];
            })
          ),
          derived: product
            ? {
                coverAbovePct: Math.round(maskGridMean(product.coverAbove) * 100),
                skyReachPct: Math.round(maskGridMean(product.skyReach) * 100),
                completeness: product.completeness,
              }
            : 'no products (floor unknown to derivation)',
        };
      }),
      ingest: { ...counters, extractErrors: [...extractErrors] },
      trackedItems: scene.items.size,
      ingestedContentGrids: scene.ingests.size,
    };
  }

  return {
    reset,
    setItems,
    setDiscovery,
    layersForItem,
    ingestDecodedPage,
    getDerived,
    sampleWorld,
    authoredStatus,
    getReport,
  };
}
