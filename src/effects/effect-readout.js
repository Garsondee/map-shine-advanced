/**
 * effect-readout.js — THE SHARED "resolve → store → project" PATTERN.
 *
 * ⚠️ WHY THIS EXISTS (2026-08-30, Effect-Tier-Gradient-Audit-2026-08-29.md's
 * round-2 finding on the transit-loss guard's own narrow coverage). Every
 * effect with a dedicated `*-registration.js` file (water/specular/window/
 * fluid) has this exact two-step shape as an independently-constructible,
 * Node-testable factory — `effect-tier-consumption.test.mjs` exercises the
 * REAL factory and proves `perfTier` survives the round trip. The other 8
 * multi-tier effects (bloom, depth-of-field, sun-shadows, candle, lightning,
 * fire, vegetation, precipitation) register inline inside `boot.js`'s
 * `install()` closure, hand-typing the identical two-step shape 8 separate
 * times with no factory a Node test could import — so a future silent
 * `perfTier` drop on any of them would only ever be caught by manual audit,
 * the exact failure this whole guard exists to prevent (it already happened
 * to specular, window, fluid AND bloom/depth-of-field, independently, before
 * each was fixed this session).
 *
 * These two functions are that missing factory, split rather than fused, so
 * `boot.js` can keep every effect's own readout VARIABLE, its own
 * `register()` call site, and every other place that reads that variable
 * (a console setter, a status line, a FOH/ROH card's `getReadout`) completely
 * untouched — only the two hand-typed OBJECT LITERALS (the exact shape that
 * silently dropped a field before) are replaced with a call to a tested pure
 * function. `boot.js` itself stays impossible to unit-test directly (it needs
 * a live Foundry `game` global this project's own Node harness never
 * constructs) — this does not change that. What it changes is that the two
 * places a field could previously go missing SILENTLY, inside an inline
 * object literal nobody runs a test against, now delegate to something that
 * IS tested — so the same field going missing would mean deleting a
 * function call, a far more conspicuous, harder-to-miss-in-review change
 * than a value quietly absent from a multi-line literal.
 *
 * @module effects/effect-readout
 */

/**
 * The FIRST half — what every inline effect's `effectRegistry.register(
 * MANIFEST, (resolved) => { xReadout = {...} })` callback body already does,
 * letter for letter. `resolved` is the cascade's own `ResolvedEffect`
 * (`registry.js`), carrying `perfTier`/`maxPerfTier`/`perfTierSource`
 * alongside `enabled`/`params` for EVERY effect, tiered or not.
 *
 * @param {{enabled: boolean, params: object|null, perfTier?: number,
 *   maxPerfTier?: number, perfTierSource?: string}} resolved
 * @returns {{enabled: boolean, params: object|null, perfTier: number|undefined,
 *   maxPerfTier: number|undefined, perfTierSource: string|undefined}}
 */
export function buildCascadeReadout(resolved) {
  return {
    enabled: resolved.enabled,
    params: resolved.params,
    perfTier: resolved.perfTier,
    maxPerfTier: resolved.maxPerfTier,
    perfTierSource: resolved.perfTierSource,
  };
}

/**
 * The SECOND half — what every inline effect's `getXRenderState` function
 * body already does, letter for letter, for the three fields the LIVE
 * render seam actually reads. Deliberately narrower than the readout itself:
 * `maxPerfTier`/`perfTierSource` are a UI-badge-only concern, read through
 * `getReadout()` by every FOH/ROH card instead (confirmed by direct reading
 * of `boot.js`'s own card-building code for water/specular/fluid AND every
 * inline effect alike — `effect-tier-consumption.test.mjs`'s own header has
 * the fuller account of this same contract, established the same day this
 * file's sibling functions were). A caller with extra viewer-internal fields
 * of its own (fire's `mPerPx`, precipitation's `weather`/`sceneBounds`, …)
 * spreads this result and adds them on top — this function only ever owns
 * the three fields every tiered effect shares.
 *
 * @param {{enabled: boolean, params: object|null, perfTier?: number}} readout
 * @returns {{enabled: boolean, params: object, perfTier: number|undefined}}
 */
export function projectCascadeRenderState(readout) {
  return {
    enabled: readout.enabled,
    params: readout.params ?? {},
    perfTier: readout.perfTier,
  };
}
