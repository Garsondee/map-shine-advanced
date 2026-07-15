/**
 * src/diag/soak.js — the Stage 0 soak harness (Keyhole §8, §10).
 *
 * `MapShine.soak(n)`: run n× load/switch/pan cycles and report context losses +
 * ledger peaks. This is the harness the stage gates lean on — e.g. Stage 1's
 * "ledger flat within budget through 20-cycle soak; zero context loss".
 *
 * Stage 0 honesty: there is nothing to load/switch/pan yet but the boot triangle,
 * so those three DRIVERS are stubs. Later stages register real drivers into
 * `MapShine.soakHooks` (the page cache registers `load`/`pan`, the floor model
 * registers `switchFloor`), and soak() picks them up automatically. What is REAL
 * right now: the cycle loop, WebGL context-loss accounting on the live canvas,
 * and an honest report that names which drivers are still stubs. It never claims
 * a clean soak it didn't actually run.
 */

const DRIVERS = ['load', 'switchFloor', 'pan'];

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
