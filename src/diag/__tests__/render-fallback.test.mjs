/**
 * Tests for diag/render-fallback.js's `describeRenderMode` cache
 * (Testament Stage 4, 2026-08-11 — see that file's own header for why
 * caching a REPORTING readout is safe even though this module also owns a
 * real safety mechanism).
 *
 * This is the module's FIRST test file — its DOM-heavy paths
 * (`getComputedStyle`, real canvas geometry) stay verified live per
 * CONVENTIONS.md §4, but the caching wrapper itself is reachable through the
 * `canvas: null` path, which resolves without touching `document` at all —
 * a real code path (no MSA canvas ⇒ foundry-fallback), not a mock. Node's
 * native `performance.now()` (no jsdom needed) makes the time-based
 * expiry directly testable too.
 *
 * `clearFoundryFallback()` at the top of `run()` is defensive, not load-
 * bearing today (this file is not yet imported by any other suite in this
 * directory, so there is no cross-test state to inherit) — kept anyway
 * because `state` is module-level and mutable, and a future test importing
 * this module should not have to discover that the hard way.
 */
import { describeRenderMode, clearFoundryFallback, getFallbackState } from '../render-fallback.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function run(t) {
  clearFoundryFallback();

  // ── the DOM-free path this cache is actually testable through ─────────────
  const r0 = describeRenderMode({ canvas: null, loopActive: false });
  t.ok('no-canvas path resolves to foundry-fallback, no DOM touched', r0.renderMode === 'foundry-fallback');
  t.ok('no-canvas reason names the actual cause', /no MSA canvas/.test(r0.renderModeReason));

  // ── cache HIT: same args, called again immediately, returns the SAME object ──
  const r1 = describeRenderMode({ canvas: null, loopActive: false });
  t.ok('identical args, called again immediately, return the SAME object reference (a real cache hit)', r0 === r1);

  // ── cache MISS on loopActive changing, even with the same (null) canvas ───
  const r2 = describeRenderMode({ canvas: null, loopActive: true });
  t.ok('a changed loopActive is NOT served the previous answer', r2 !== r1);
  // Both null-canvas branches report foundry-fallback regardless of
  // loopActive (canvas absence is checked first) — the OBJECT differs
  // (proving recomputation happened) even though this particular field
  // doesn't.
  t.ok('recomputed answer is still correct for the new args', r2.renderMode === 'foundry-fallback');

  // ── cache MISS on canvas reference changing ────────────────────────────────
  const fakeCanvasA = {};
  const r3 = describeRenderMode({ canvas: fakeCanvasA, loopActive: true });
  const r4 = describeRenderMode({ canvas: fakeCanvasA, loopActive: true });
  t.ok('same fake canvas reference twice IS a cache hit', r3 === r4);
  const fakeCanvasB = {};
  const r5 = describeRenderMode({ canvas: fakeCanvasB, loopActive: true });
  t.ok('a DIFFERENT canvas reference is NOT served the previous answer', r5 !== r4);

  // ── cache expiry: the SAME args, after the throttle window, recompute ─────
  // A real sleep, not a fake clock — this file has no injected-clock seam
  // (performance.now() is called directly, which time/one-clock explicitly
  // allows in diag/), so this is the honest way to prove the window is real
  // rather than assuming the constant is wired to anything.
  const r6 = describeRenderMode({ canvas: null, loopActive: false });
  await sleep(280); // > DESCRIBE_RENDER_MODE_CACHE_MS (250)
  const r7 = describeRenderMode({ canvas: null, loopActive: false });
  t.ok('after the cache window elapses, the SAME args recompute (a fresh object)', r6 !== r7);
  t.ok('the recomputed answer is still correct', r7.renderMode === 'foundry-fallback');

  // ── the cache never masks a real fallback-state change ─────────────────────
  // fallback.active flows through getFallbackState() on every recompute
  // (never cached itself — only the DOM-derived fields are what the cache
  // exists to save), so once ANYTHING invalidates the cache (args or time),
  // a state change since the last read is visible.
  t.ok("fallback state starts inactive (cleared at this test's own top)", getFallbackState().active === false);
}
