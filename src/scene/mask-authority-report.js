/**
 * THE MASK AUTHORITY'S REPORT — everything the authority knows about itself,
 * shaped for a human reading a debug panel.
 *
 * Extracted from `mask-authority.js` on 2026-07-25 when `createMaskAuthority`
 * crossed its frozen size budget and the size ratchet said so. Reporting was
 * the right thing to cut: it is a PURE function of state the authority already
 * holds, it changes for entirely different reasons than serving does (a new
 * field here is a debugging need, not a semantic one), and pulling it out
 * makes it testable without constructing an authority at all.
 *
 * The design rule this file inherits, and the reason it is this verbose:
 * **an instrument must not lie** (`feedback_instruments_must_not_lie`). Every
 * degraded state gets its own words rather than a number that could be
 * mistaken for a measurement — "MISSING — REQUIRED, sampling THROWS" instead
 * of `default(1)`, `'NOT RUN'` instead of an empty discovery object, an
 * explicit empty array instead of an absent field. V2's mask reporting printed
 * plausible numbers for masks that had never loaded, which is how "coverAbove
 * is zero" stayed unattributable for months.
 *
 * @module scene/mask-authority-report
 */

import { MASK_KINDS, DERIVED_KINDS, CASTER_HEIGHT_SCALE_PX } from './mask-catalog.js';
import { maskGridMean } from './mask-derive.js';

/** URLs are long and the tail is the informative half. */
function tailOf(u) {
  return typeof u === 'string' && u.length > 60 ? `…${u.slice(-57)}` : u;
}

/**
 * One floor's row: what was discovered, what is missing, and what the
 * derivation made of it.
 *
 * @param {object} args
 * @param {{index:number, id:string, name:string, ceilingElevation:number}} args.floor
 * @param {Map<string,string>|undefined} args.found - discovery's urls for this level.
 * @param {object|undefined} args.product - this floor's DerivedFloorProducts.
 * @param {string[]} args.requiredMasksMissing - authored kinds only (see below).
 * @returns {object}
 */
function floorRow({ floor, found, product, requiredMasksMissing }) {
  return {
    index: floor.index,
    name: floor.name,
    ceilingElevation: floor.ceilingElevation,
    authored: Object.fromEntries(
      MASK_KINDS.map((k) => {
        const url = found?.get(k.id);
        if (url) return [k.id, tailOf(url)];
        // A required kind's absence is no longer "served as a default"
        // (2026-07-21) — say so plainly rather than print a number
        // (`default(1)`) that would misdescribe what actually happens now.
        return [k.id, k.required ? 'MISSING — REQUIRED, sampling THROWS' : `default(${k.absentValue})`];
      })
    ),
    // Empty array = nothing required is missing on this floor (the common,
    // healthy case) — an explicit empty list, never absent, so a report reader
    // never has to wonder whether this was checked.
    requiredMasksMissing,
    derived: product
      ? {
          coverAbovePct: Math.round(maskGridMean(product.coverAbove) * 100),
          skyReachPct: Math.round(maskGridMean(product.skyReach) * 100),
          // THE CASTER HEIGHT FIELD, per producer, in world px — the ONE block
          // that answers "why is there no shadow" without a guess. A zero here
          // with a non-empty `skyReachItemIds` means the art arrived but casts
          // nothing (check the floor's elevation band); a zero WITH
          // `missingItemIds` means the art never arrived.
          casterHeightPx: {
            scalePx: CASTER_HEIGHT_SCALE_PX,
            building: Math.round(maskGridMean(product.casterChannels.building) * CASTER_HEIGHT_SCALE_PX),
            overhead: Math.round(maskGridMean(product.casterChannels.overhead) * CASTER_HEIGHT_SCALE_PX),
            skyReach: Math.round(maskGridMean(product.casterChannels.skyReach) * CASTER_HEIGHT_SCALE_PX),
            combinedMean: Math.round(maskGridMean(product.casterHeight) * CASTER_HEIGHT_SCALE_PX),
          },
          // The RAW outdoors mean (2026-07-21) — check THIS first when a
          // shelter effect looks wrong: if it reads 100 with no authored
          // outdoors art, nothing was painted for this floor at all, and that
          // is a content gap, not a code bug (see this floor's own
          // `authored.outdoors` field just above for provenance).
          outdoorsPct: Math.round(maskGridMean(product.outdoors) * 100),
          // Every `rasterize: true` kind that is not outdoors (water today),
          // with its PROVENANCE beside its mean — because an all-zero water
          // grid means two completely different things depending on whether a
          // mask was authored, and only one of them is a content gap.
          rasterized: Object.fromEntries(
            Object.entries(product.authored ?? {}).map(([id, grid]) => [
              id,
              `${Math.round(maskGridMean(grid) * 100)}% (${product.completeness.authoredSources?.[id] ?? 'unknown'})`,
            ])
          ),
          completeness: product.completeness,
        }
      : 'no products (floor unknown to derivation)',
  };
}

/**
 * The whole report. Every argument is state the authority already holds; this
 * function computes nothing it is not handed, so it can be called from a test
 * with plain objects.
 *
 * @param {object} args
 * @param {{ok: boolean, errors: string[]}} args.catalog - `validateMaskCatalog()`'s verdict.
 * @param {object} args.scene - the authority's scene state.
 * @param {Array<object>} args.products - the derived products, already fresh.
 * @param {number} args.version @param {number} args.productsVersion
 * @param {object} args.counters @param {Array<object>} args.extractErrors
 * @param {(levelId: string) => Set<string>} args.requiredMissingAuthoredIds -
 *   the authority's own check, injected rather than reimplemented.
 * @returns {object}
 */
export function buildMaskAuthorityReport({
  catalog,
  scene,
  products,
  version,
  productsVersion,
  counters,
  extractErrors,
  requiredMissingAuthoredIds,
}) {
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
    floors: scene.floors.map((floor) =>
      floorRow({
        floor,
        found: scene.discovery?.byLevelId?.get(floor.id),
        product: products.find((p) => p.index === floor.index),
        // Required-and-missing, ONLY the authored kinds themselves (not the
        // derived ids their absence also blocks) — the ACTIONABLE list: what
        // needs painting, not everything that will throw as a consequence.
        requiredMasksMissing: [...requiredMissingAuthoredIds(floor.id)],
      })
    ),
    ingest: { ...counters, extractErrors: [...extractErrors] },
    trackedItems: scene.items.size,
    ingestedContentGrids: scene.ingests.size,
  };
}
