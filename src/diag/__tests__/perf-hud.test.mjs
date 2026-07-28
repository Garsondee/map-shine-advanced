/**
 * Node tests for perf-hud.js's pure half.
 *
 * The DOM half is browser-verified (CONVENTIONS.md §4 — don't fake a DOM just to
 * force a Node test). What IS testable, and load-bearing, is the RANKING: a
 * CPU-only zone must be able to reach the top of the list, or the HUD is blind
 * to exactly the sync-and-upload work that causes the hitches people notice.
 */
import { HUD_ROWS, HUD_TICK_MS, buildHudRows } from '../perf-hud.js';

const z = (id, { gpu = null, cpu = null } = {}) => ({
  id,
  gpu: gpu === null ? null : { sumMs: gpu, count: 100, maxMs: gpu / 100 },
  cpu: cpu === null ? null : { sumMs: cpu, count: 100, maxMs: cpu / 100 },
});

export function run(t) {
  const { ok } = t;

  // ---- empty and degenerate inputs -----------------------------------------
  {
    ok('no snapshot gives no rows', buildHudRows(null).rows.length === 0);
    ok('zero frames gives no rows', buildHudRows({ frames: 0, zoneStats: [z('a', { gpu: 1 })] }).rows.length === 0);
    ok('no zoneStats gives no rows', buildHudRows({ frames: 10, zoneStats: [] }).rows.length === 0);
    ok('an empty view reports null totals, not 0', buildHudRows(null).totalGpuMs === null);
  }

  // ---- ranking -------------------------------------------------------------
  {
    const view = buildHudRows({
      frames: 100,
      zoneStats: [
        z('light.drawIllum', { gpu: 40 }), //   0.40 ms/frame
        z('light.drawPointLights', { gpu: 150 }), // 1.50
        z('light.vegetationSync', { cpu: 220 }), //  2.20 CPU-only — must outrank both
        z('tick.camera', { cpu: 1 }), //             0.01
      ],
    });
    ok('rows are ranked by cost', view.rows[0].id === 'light.vegetationSync');
    ok('a CPU-only zone can top the list', view.rows[0].cpuMs === 2.2 && view.rows[0].gpuMs === null);
    ok('the second is the heaviest GPU zone', view.rows[1].id === 'light.drawPointLights');
    ok('a cheap zone sinks', view.rows[view.rows.length - 1].id === 'tick.camera');
    ok('per-frame amortisation is applied', view.rows[1].gpuMs === 1.5);
    ok('the frame count comes through', view.frames === 100);
  }

  // ---- passes are marked and are the only thing summed ---------------------
  {
    const view = buildHudRows({
      frames: 100,
      zoneStats: [
        z('pass.light.accumulate', { gpu: 200 }), // 2.0
        z('light.drawPointLights', { gpu: 150 }), // 1.5 — INSIDE the pass above
        z('pass.post.bloom', { gpu: 100 }), //       1.0
      ],
    });
    ok('a pass row is marked', view.rows.find((r) => r.id === 'pass.light.accumulate').isPass === true);
    ok('a leaf row is not', view.rows.find((r) => r.id === 'light.drawPointLights').isPass === false);
    ok('the pass label drops the prefix for display', view.rows.find((r) => r.isPass).label === 'light.accumulate');
    // GPU IS EXCLUSIVE — each row holds a disjoint slice, so all of them sum:
    // 2.0 + 1.5 + 1.0 = 4.5. Summing pass rows only (the first version) showed
    // "—" live, because a fully bracketed pass keeps no GPU time of its own.
    ok('the GPU total sums EVERY row, because the slices are disjoint', view.totalGpuMs === 4.5);
  }

  {
    // ...and CPU sums the PASSES only, because a CPU bracket is inclusive of its
    // children. The two columns genuinely have opposite nesting semantics.
    const view = buildHudRows({
      frames: 100,
      zoneStats: [
        { id: 'pass.light.accumulate', cpu: { sumMs: 200, count: 100, maxMs: 4 }, gpu: null },
        { id: 'light.pointLightUpdate', cpu: { sumMs: 150, count: 100, maxMs: 3 }, gpu: null },
      ],
    });
    ok('the CPU total sums PASSES only, or the child is counted twice', view.totalCpuMs === 2);
    ok('a fully bracketed pass reports no GPU total rather than 0', view.totalGpuMs === null);
  }

  // ---- truncation is counted, never silent --------------------------------
  {
    const many = Array.from({ length: HUD_ROWS + 7 }, (_, i) => z(`zone.${i}`, { gpu: (i + 1) * 10 }));
    const view = buildHudRows({ frames: 100, zoneStats: many });
    ok(`the HUD shows at most ${HUD_ROWS} rows`, view.rows.length === HUD_ROWS);
    ok('the rest are COUNTED, not silently dropped', view.hidden === 7);
    ok('the heaviest survives truncation', view.rows[0].id === `zone.${HUD_ROWS + 6}`);

    const custom = buildHudRows({ frames: 100, zoneStats: many }, { limit: 3 });
    ok('the limit is configurable', custom.rows.length === 3 && custom.hidden === HUD_ROWS + 4);
  }

  // ---- absence is null, never zero ----------------------------------------
  {
    const view = buildHudRows({ frames: 100, zoneStats: [z('light.vegetationSync', { cpu: 50 })] });
    ok('a zone with no GPU work reports null, not 0', view.rows[0].gpuMs === null);
    ok('...and its CPU number is real', view.rows[0].cpuMs === 0.5);
    ok('a view with no pass rows reports null totals, not 0', view.totalGpuMs === null);
  }

  // ---- the repaint rate honours "the monitor must not become the thing" ----
  {
    ok('the HUD repaints at 4Hz, matching the heartbeat strip', HUD_TICK_MS === 250);
    ok('the row count stays glanceable', HUD_ROWS === 10);
  }
}
