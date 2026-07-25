/**
 * THE SKY-REACH SERVICE — "what is between this point and the open sky?", asked
 * once, answered for everyone.
 *
 * ============================================================================
 * WHY A SERVICE AND NOT JUST ANOTHER `sampleWorld` CALL
 * ============================================================================
 *
 * Author, 2026-07-24: *"repairing sky reach because it needs to be an API /
 * service for other things like rain drops when we get to that stage as well as
 * being a producer for this shadow."*
 *
 * That is a structural instruction, and this project already has the receipts
 * for why. `skyReach` is a raw derived grid on the mask authority, and the LAST
 * time two consumers each reached for a raw mask product themselves, they picked
 * DIFFERENT ONES: the candle's wind exposure and the wind overlay disagreed
 * about whether "sheltered" meant `skyReach` or raw `outdoors` (2026-07-21, both
 * fixed the same day, both fixed by hand). A grid anyone can sample is a grid
 * everyone samples slightly differently.
 *
 * So this is the same shape as `world/wind-access.js` and
 * `effects/shadow-access.js`: ONE door, built in ONE place, handing out the
 * questions rather than the data. Rain will ask `isCovered`; the cast-shadow
 * bake asks `heightField`; a future weather-spawn asks `openSkyAt`. None of them
 * spells `skyReach`, so none of them can pick the wrong product.
 *
 * ============================================================================
 * THE THREE QUESTIONS, AND WHY THEY ARE DIFFERENT QUESTIONS
 * ============================================================================
 *
 *   openSkyAt(x, y)     0..1 — "can the sky see this point?" `outdoors ∧ ¬cover`.
 *                       Weather SPAWN, sky ambient, anything that cares whether
 *                       a texel is under the firmament.
 *   coverHeightAt(x, y) world px — "how HIGH is the thing above me?" A raindrop
 *                       under a bridge needs the deck's altitude, not merely the
 *                       fact of it; so does a shadow's throw. This is the piece
 *                       `skyReach` alone could never answer, and the reason the
 *                       caster height field exists.
 *   isCovered(x, y)     boolean — the same question with the threshold decided
 *                       ONCE, here, instead of five consumers each picking their
 *                       own `> 0.5`.
 *
 * ⚠️ It deliberately does NOT re-export "is this indoors" — that is raw
 * `outdoors`, a genuinely different question (a walled room with nothing above
 * it is indoors AND has open sky reach), and conflating the two is precisely the
 * 2026-07-21 bug named above. Ask the mask authority for `outdoors` when you
 * mean shelter from wind; ask this when you mean shelter from the SKY.
 *
 * ============================================================================
 * ⚠️ ABSENCE IS NOT ZERO, AND THIS DOOR REFUSES TO PRETEND OTHERWISE
 * ============================================================================
 *
 * Every reading carries provenance. `coverHeightAt` returns `{heightPx,
 * known}` — `known: false` means the art that would answer this has not been
 * ingested, which is a DIFFERENT fact from "nothing is above you" and produces a
 * different correct behaviour (rain should keep falling, not mysteriously stop).
 * The whole `coverAbove ≡ 0` defect this service was built alongside
 * (vt/coarse-alpha.js's header) survived an entire engine retirement precisely
 * because "no data" and "no cover" were the same number.
 *
 * @module scene/sky-reach-access
 */

/**
 * A texel is "covered" at or above this much accumulated opacity. 0.5 rather
 * than "any non-zero": the coarse grid box-averages, so the fringe texels of any
 * silhouette carry partial coverage, and treating those as solid would inflate
 * every roof by a texel in every direction. Chosen, stated, and shared —
 * the point of putting it here is that there is exactly one of it.
 */
export const COVERED_THRESHOLD = 0.5;

/**
 * @typedef {object} SkyReachAccess
 * @property {number} version - the mask authority's products version; a consumer
 *   caching anything derived from this stores it and refreshes when it moves
 *   (the same discipline `world/wind-access.js` documents).
 * @property {(floorIndex: number, x: number, y: number) => number} openSkyAt
 * @property {(floorIndex: number, x: number, y: number) => {heightPx: number, known: boolean}} coverHeightAt
 * @property {(floorIndex: number, x: number, y: number) => boolean} isCovered
 * @property {(floorIndex: number) => object|null} heightField
 * @property {(floorIndex: number) => object} status
 */

/**
 * Build the sky-reach service over a mask authority.
 *
 * Takes the authority itself rather than loose closures on purpose: this module
 * lives in the same zone, the authority IS the one legal source for these
 * products (`masks/authority-only`), and handing in `sampleWorld` alone would
 * let a caller construct a service over something that merely looks like one.
 *
 * @param {object} args
 * @param {object} args.maskAuthority - `scene/mask-authority.js`'s instance.
 * @param {(err: Error, context: string) => void} [args.onRequiredMaskMissing] -
 *   called instead of throwing when a floor has no `_Outdoors` at all. The
 *   caller decides how loudly to degrade (boot already owns one throttled
 *   warning for this — the safety slide, announced, never silent). Omitted =
 *   the throw propagates, which is the right default for a new consumer.
 * @returns {Readonly<SkyReachAccess>}
 */
export function createSkyReachAccess({ maskAuthority, onRequiredMaskMissing = null }) {
  if (!maskAuthority) throw new Error('createSkyReachAccess: maskAuthority is required');
  const scalePx = maskAuthority.casterHeightScalePx ?? 0;

  /** Run a read, routing a required-mask failure to the injected handler. */
  function guarded(fn, context, fallback) {
    if (!onRequiredMaskMissing) return fn();
    try {
      return fn();
    } catch (err) {
      onRequiredMaskMissing(err, context);
      return fallback;
    }
  }

  /**
   * 0..1 — how much of the open sky reaches this world point on this floor.
   * 1 = full firmament, 0 = something solid (or an authored indoor painting) is
   * between it and the sky.
   */
  function openSkyAt(floorIndex, x, y) {
    return guarded(() => maskAuthority.sampleWorld('skyReach', floorIndex, x, y), 'openSkyAt', 1);
  }

  /**
   * How high above THIS floor the nearest thing overhead sits, in world px.
   *
   * `known: false` means no art has been ingested for the items that would
   * answer — see this module's header for why that is reported rather than
   * folded into a zero. A caller that does not care may read `heightPx` alone;
   * one that spawns rain should not.
   */
  function coverHeightAt(floorIndex, x, y) {
    const v = guarded(() => maskAuthority.sampleWorld('casterHeight', floorIndex, x, y), 'coverHeightAt', 0);
    const missing = statusOf(floorIndex).missingItemCount;
    return { heightPx: v * scalePx, known: missing === 0 };
  }

  /** The covered/uncovered decision, with the threshold made once (see COVERED_THRESHOLD). */
  function isCovered(floorIndex, x, y) {
    return openSkyAt(floorIndex, x, y) < 1 - COVERED_THRESHOLD;
  }

  /**
   * The floor's whole occluder height field, for a consumer that needs all of it
   * at once (the cast-shadow bake uploads it as a texture). Returns the derived
   * product's grid + its three unmerged producer channels, or null for an
   * unknown floor.
   */
  function heightField(floorIndex) {
    const product = guarded(() => maskAuthority.getDerived('casterHeight', floorIndex), 'heightField', null);
    if (!product) return null;
    return {
      grid: product.grid,
      channels: product.channels ?? null,
      scalePx,
      version: product.version,
      completeness: product.completeness,
    };
  }

  /**
   * What this floor actually knows — the block a report prints so "there is no
   * shadow" and "there is nothing above you" can never look the same
   * (feedback_instruments_must_not_lie).
   */
  function statusOf(floorIndex) {
    const product = guarded(
      () => maskAuthority.getDerived('skyReach', floorIndex, { acknowledgeMissingRequired: true }),
      'status',
      null
    );
    const c = product?.completeness ?? null;
    return {
      floorIndex,
      known: !!product,
      missingItemCount: c?.missingItemIds?.length ?? 0,
      expectedItemCount: c?.expectedItemIds?.length ?? 0,
      overheadItemCount: c?.overheadItemIds?.length ?? 0,
      skyReachItemCount: c?.skyReachItemIds?.length ?? 0,
      // THE IDs, not just counts (2026-07-25): "sky-reach isn't working" is
      // almost always "the item you expect to be casting is not in this list",
      // and a bare count cannot tell you WHICH item is missing. The author's
      // bridge deck is the exact case — is `Tower_Bridge_Middle`'s background
      // actually counted as above the ground floor, or not?
      skyReachItemIds: c?.skyReachItemIds ?? [],
      overheadItemIds: c?.overheadItemIds ?? [],
      missingItemIds: c?.missingItemIds ?? [],
      ceilingElevation: c?.ceilingElevation ?? null,
      bottomElevation: c?.bottomElevation ?? null,
      outdoorsSource: c?.outdoorsSource ?? null,
    };
  }

  return Object.freeze({
    get version() {
      return maskAuthority.getProductsVersion();
    },
    openSkyAt,
    coverHeightAt,
    isCovered,
    heightField,
    status: statusOf,
  });
}
