/**
 * src/diag/soak.js — the Stage 0 soak harness (Keyhole §8, §10).
 *
 * `MapShine.soak(n)`: run n× load/switch/pan/zoom cycles and report context
 * losses + ledger peaks. This is the harness the stage gates lean on — e.g.
 * Stage 1's "ledger flat within budget through 20-cycle soak; zero context loss".
 *
 * Stage 0 honesty: at Stage 0 there was nothing to load/switch/pan yet but the
 * boot triangle, so DRIVERS started as stubs. Later stages register real
 * drivers into `MapShine.soakHooks` (the VT viewer registers `load`/`pan`/
 * `zoom`, the floor model registers `switchFloor`), and soak() picks them up
 * automatically. `zoom` (2026-07-17) drives ONE bounded, eased zoom step per
 * cycle through the SAME code path a real keyboard zoom key/wheel notch
 * uses — deliberately NOT `runZoomThrashTest`'s instant full-range jump,
 * which reaches states a real user cannot reproduce (confirmed live: the
 * author could not trigger its ghost artefact through 15-20s of deliberate
 * aggressive manual scroll-zooming). soak() is what tells you whether a bug
 * survives REALISTIC extended play; the thrash test is a separate, adversarial
 * max-stress tool for finding races fast — the two answer different questions
 * and neither substitutes for the other. What is REAL right now: the cycle
 * loop, WebGL context-loss accounting on the live canvas, and an honest report
 * that names which drivers are still stubs. It never claims a clean soak it
 * didn't actually run.
 */

const DRIVERS = ['load', 'switchFloor', 'pan', 'zoom'];

export function installSoak(MapShine) {
  // Later stages assign real functions here: { load(i), switchFloor(i), pan(i) }.
  MapShine.soakHooks = MapShine.soakHooks || {};

  let contextLosses = 0;
  let contextRestores = 0;

  /** Attach WebGL context-loss counters to a canvas (idempotent). */
  function watch(canvas) {
    if (!canvas || canvas.__soakWatched) return;
    canvas.__soakWatched = true;
    canvas.addEventListener('webglcontextlost', () => {
      contextLosses++;
      console.warn('[soak] webglcontextlost');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      contextRestores++;
      console.info('[soak] webglcontextrestored');
    });
  }

  async function soak(n = 5) {
    const t0 = performance.now();
    watch(MapShine.__heartbeat?.renderer?.domElement);

    const hooks = MapShine.soakHooks;
    const stubs = DRIVERS.filter((k) => typeof hooks[k] !== 'function');
    const startLosses = contextLosses;
    let ledgerPeak = 0;

    console.log(`[soak] running ${n} cycle(s)…${stubs.length ? ` (stub drivers: ${stubs.join(', ')})` : ''}`);
    for (let i = 0; i < n; i++) {
      for (const k of DRIVERS) {
        if (typeof hooks[k] === 'function') {
          try {
            await hooks[k](i);
          } catch (e) {
            console.error(`[soak] driver "${k}" threw on cycle ${i}:`, e);
          }
        }
      }
      // Ledger peak becomes real once diag/ledger is harvested (Stage 1); 0 until then.
      const p = MapShine.ledger?.peakPressure?.() ?? 0;
      if (p > ledgerPeak) ledgerPeak = p;
      await new Promise((r) => setTimeout(r, 0)); // yield to main between cycles
    }

    const report = {
      cycles: n,
      contextLosses: contextLosses - startLosses,
      contextRestores,
      ledgerPeak,
      durationMs: Math.round(performance.now() - t0),
      stubDrivers: stubs.length ? stubs.join(', ') : '(none — all live)',
      note: stubs.length
        ? 'harness + context-loss accounting are LIVE; load/switch/pan are Stage 1+ stubs, so this run only proves the rig, not a real soak.'
        : 'all drivers live — this is a real soak.',
    };
    (console.table || console.log).call(console, report);
    return report;
  }

  MapShine.soak = soak;
  MapShine.__soakWatch = watch; // let boot re-watch the canvas once it exists
  return soak;
}
