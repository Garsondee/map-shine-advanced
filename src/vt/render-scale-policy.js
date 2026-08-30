/**
 * RENDER-SCALE POLICY — the small, pure combining formula that turns
 * (Foundry's own reported resolution, MSA's own safety ceiling, the render-
 * scale governor's live decision, a player's own setting) into the two real
 * numbers `vt-pan-viewer.js` needs: the PRESENT pixel ratio (the actual
 * WebGPU drawing buffer / canvas — set once, matches Foundry, capped) and the
 * INTERNAL scale (what fraction of that buffer MSA actually renders into
 * before the free bilinear present-upscale — this is what the governor
 * steps).
 *
 * Kept out of `vt-pan-viewer.js` (20k+ lines) specifically so this formula —
 * the one piece of tonight's fix a future regression is most likely to get
 * subtly wrong — has its own name, its own tests, and nothing else to hide
 * behind.
 *
 * ============================================================================
 * TWO TIERS, NOT ONE — WHY THIS MODULE EXISTS AT ALL
 * ============================================================================
 * Before 2026-08-27, "resolution" meant one thing: `renderer.setPixelRatio()`
 * drove both the drawing buffer AND every screen-sized render target
 * together. A live measurement that night showed mirroring Foundry's own
 * CLIENT-scoped "Disable Resolution Scaling" setting uncapped could tank a
 * player's frame rate with zero involvement from MSA's own judgment. The fix
 * splits "how big is the canvas" (PRESENT — matches Foundry, always capped)
 * from "how many pixels does MSA actually shade" (INTERNAL — MSA's own,
 * governed, decision). The present pass already upscales the internal target
 * for free (bilinear `scene.lit` sampling) — see
 * `Performance-Ceiling-Analysis-2026-08-26.md` §2a for the full account of
 * why that upscale was already sitting there, unused for this purpose.
 *
 * @module vt/render-scale-policy
 */

/**
 * The PRESENT tier: the actual WebGPU drawing-buffer pixel ratio. Mirrors
 * Foundry's own resolved value (so a player who deliberately runs Foundry
 * LOWER is still respected — this is a ceiling, never a floor) but never
 * exceeds `maxPixelRatio`, regardless of what Foundry reports. Set once at
 * startup/resize; the governor never touches this value.
 *
 * @param {number} foundryResolution - `canvas.app.renderer.resolution`, or
 *   any non-finite/non-positive value to signal "unavailable" (falls back to
 *   `1`, the same defensive posture every other live `canvas.*` read in this
 *   codebase already takes).
 * @param {number} maxPixelRatio - the safety ceiling
 *   (`MAX_PIXEL_RATIO`, `vt-pan-viewer.js`).
 * @returns {number}
 */
export function resolvePresentPixelRatio(foundryResolution, maxPixelRatio) {
  const ceiling = Number.isFinite(maxPixelRatio) && maxPixelRatio > 0 ? maxPixelRatio : 1;
  return Number.isFinite(foundryResolution) && foundryResolution > 0 ? Math.min(foundryResolution, ceiling) : 1;
}

/**
 * The INTERNAL tier: what fraction of the present-tier drawing buffer MSA
 * actually renders into. `'auto'` follows the governor's own live decision;
 * any other value is a player's explicit, fixed choice — validated against
 * `allowedScales` (never trust an arbitrary setting string as a render
 * scale) rather than kept in a second, parallel lookup table that could drift
 * out of sync with the governor's own ladder.
 *
 * A fixed choice makes the governor fully inert for that player (no hidden
 * floor underneath it) — deliberate, matching how every other quality preset
 * in this codebase already behaves; the present-tier ceiling above still
 * protects a Fixed-mode player from Foundry's own opaque value regardless.
 * A fixed choice ABOVE 1.0 (`SUPERSAMPLE_CHOICES`) is the one case this
 * inertness matters for the OTHER direction too: it is real, deliberate extra
 * GPU cost the governor would never choose on its own, which is exactly why
 * it can only ever be reached as an explicit fixed choice, never `auto`.
 *
 * @param {string} userSetting - `'auto'`, or a numeric string matching one of
 *   `allowedScales` (e.g. `'0.75'`, or `'1.5'` for a fixed supersample).
 * @param {number} governorScale - `RenderScaleGovernor#scale`, read only when
 *   `userSetting === 'auto'`. Capped at 1 here regardless of `allowedScales`:
 *   the AUTO governor's own ladder never carries a supersample rung (see
 *   `SUPERSAMPLE_CHOICES`'s own header), so a value above 1 reaching this
 *   branch would mean the governor itself was misconfigured, not a case to
 *   silently accommodate.
 * @param {readonly number[]} allowedScales - the real, valid FIXED choices a
 *   fixed selection is validated against — `SCALE_LADDER` (`graph/index.js`)
 *   for a downscale, unioned with `SUPERSAMPLE_CHOICES` by the caller for a
 *   supersample.
 * @returns {number}
 */
export function resolveInternalScale(userSetting, governorScale, allowedScales) {
  if (userSetting === 'auto') {
    return Number.isFinite(governorScale) && governorScale > 0 && governorScale <= 1 ? governorScale : 1;
  }
  const parsed = Number(userSetting);
  const ladder = Array.isArray(allowedScales) ? allowedScales : [];
  return Number.isFinite(parsed) && ladder.some((s) => Math.abs(s - parsed) < 1e-9) ? parsed : 1;
}

/**
 * Per-performance-tier frame-budget targets for the render-scale governor's
 * Auto mode (2026-08-27). Direct response to Ingram's own live test of
 * Phase 2: a single 60fps (`FRAME_BUDGET_MS`, 16.6ms) budget for EVERY tier
 * meant every tier's own measured native cost (`low` ~21ms through
 * `extreme` ~32ms — Performance-Ceiling-Analysis-2026-08-26.md's tier
 * sweep) sat above the governor's downscale trigger (`budget × highWater`,
 * 1.2), so Auto always hunted toward the ladder floor regardless of which
 * visual-fidelity tier a player had actually chosen — *"not enough force
 * pushing it towards higher quality,"* his own words, and *"if I'm in
 * extreme mode then naturally I'd want native resolution."*
 *
 * Each target fps is the SAME trade a player already made by picking that
 * tier in the first place — a speed-priority tier (`low`) chases a high
 * fps and so tolerates aggressive downscale; a fidelity-priority tier
 * (`extreme`) tolerates almost none. This extends that one existing
 * trade-off to also govern internal resolution rather than inventing a
 * second, competing one. `extreme`'s 30fps target (33.3ms) sits just above
 * its own measured native cost (~32ms), so a normal frame never crosses
 * `budget × highWater` (40ms) and Auto behaves like a Fixed 100% choice —
 * until something genuinely pushes the frame past it, at which point it
 * still protects the player exactly as the governor always has.
 *
 * Hand-typed rather than derived from `effects/effect-cascade.js`'s
 * `PERFORMANCE_PROFILES` (this module stays dependency-free by design —
 * see its own header) — coverage of all five tiers is pinned by this
 * module's own test instead of an import, the same tradeoff
 * `PASS_BUDGETS_MS` (`graph/v3-perf.js`) already makes for its own
 * hand-curated per-pass table.
 * @type {Record<string, number>}
 */
export const RENDER_SCALE_TIER_TARGET_FPS = {
  low: 60,
  performance: 55,
  standard: 45,
  quality: 36,
  extreme: 30,
};

/**
 * Resolve the render-scale governor's frame budget (ms) for a performance
 * profile tier. An unrecognised/missing profile resolves to `standard`'s
 * own target — the same "unknown profile behaves as standard" contract
 * `effects/effect-cascade.js#profileRank` already promises for every other
 * tiered consumer, kept here as a literal (see this module's own
 * dependency-free note above) rather than importing that function for a
 * single string constant.
 * @param {string} profile
 * @returns {number} ms
 */
export function resolveRenderScaleFrameBudgetMs(profile) {
  const fps = RENDER_SCALE_TIER_TARGET_FPS[profile] ?? RENDER_SCALE_TIER_TARGET_FPS.standard;
  return 1000 / fps;
}
