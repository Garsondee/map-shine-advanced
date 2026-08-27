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
 *
 * @param {string} userSetting - `'auto'`, or a numeric string matching one of
 *   `allowedScales` (e.g. `'0.75'`).
 * @param {number} governorScale - `RenderScaleGovernor#scale`, read only when
 *   `userSetting === 'auto'`.
 * @param {readonly number[]} allowedScales - the real ladder
 *   (`SCALE_LADDER`, `graph/index.js`) a fixed choice is validated against.
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
