/**
 * Node tests for perf-strip.js's pure half (CONVENTIONS.md §4 — the DOM half
 * is browser-verified only).
 */
import {
  FPS_CRITICAL_RATIO,
  FPS_WARN_RATIO,
  HEALTH_CRITICAL_RATIO,
  HEALTH_WARN_RATIO,
  buildPerfStripModel,
  formatCount,
  healthLevel,
  snapRefreshHz,
} from '../perf-strip.js';

export function run(t) {
  const { ok } = t;

  // ---- healthLevel: the shared green/amber/red scale -----------------------
  {
    ok('null/NaN ratio is unknown, never a false 0', healthLevel(null) === 'unknown' && healthLevel(NaN) === 'unknown');
    ok(
      'at the critical threshold is still critical (< not <=)',
      healthLevel(HEALTH_CRITICAL_RATIO - 0.001) === 'critical'
    );
    ok('just above critical is warn', healthLevel(HEALTH_CRITICAL_RATIO + 0.001) === 'warn');
    ok('just below warn threshold is warn', healthLevel(HEALTH_WARN_RATIO - 0.001) === 'warn');
    ok('at/above the warn threshold is ok', healthLevel(HEALTH_WARN_RATIO) === 'ok');
    ok('full headroom is ok', healthLevel(1) === 'ok');
    ok('zero headroom is critical', healthLevel(0) === 'critical');
    ok(
      'custom thresholds are honoured (the FPS bar uses its own pair)',
      healthLevel(0.7, { warn: 0.85, critical: 0.6 }) === 'warn'
    );
  }

  // ---- snapRefreshHz: the refresh-rate proxy ---------------------------------
  {
    ok('non-finite input is null, not NaN', snapRefreshHz(NaN) === null && snapRefreshHz(0) === null);
    ok('a noisy reading snaps to the nearest common rate', snapRefreshHz(59.7) === 60);
    ok('144Hz jitter snaps to 144', snapRefreshHz(143.6) === 144);
    ok('240Hz jitter snaps to 240', snapRefreshHz(238.9) === 240);
    ok('an unusual rate outside tolerance is trusted, not forced', snapRefreshHz(50) === 50);
  }

  // ---- formatCount: glanceable, not a wall of digits ------------------------
  {
    ok('small counts print raw', formatCount(812) === '812');
    // 3200, not 3450 — a value exactly on a .x5 rounding boundary is at the
    // mercy of binary floating-point representation (the classic (1.005).
    // toFixed(2) trap); this only needs to prove the K suffix logic, not win
    // an argument with IEEE754.
    ok('thousands get a K suffix', formatCount(3200) === '3.2K');
    ok('millions get an M suffix', formatCount(1234567) === '1.2M');
    ok('non-finite is an em dash, never 0', formatCount(NaN) === '—');
  }

  // ---- buildPerfStripModel: FPS bar -----------------------------------------
  {
    // 60fps on a 60Hz-best-gap display is full health.
    const full = buildPerfStripModel({ fps: 60, bestGapMs: 1000 / 60, recentWorstMs: 10 });
    ok('healthy fps ratio is ~1', full.fps.ratio > 0.98);
    ok('healthy fps is ok', full.fps.level === 'ok');
    ok('the value text names the estimated refresh rate', full.fps.valueText === '60/60fps');
    ok('no hitch flag under the threshold', full.fps.hitching === false && full.fps.hitchText === null);

    // 38fps against a 60Hz best-gap — the screenshot's own numbers — is damaged.
    // FPS uses its OWN stricter thresholds (FPS_WARN/CRITICAL_RATIO), not the
    // VRAM-style ceiling ones, precisely so a 37% deficit like this does not
    // read as a healthy green bar.
    const damaged = buildPerfStripModel({ fps: 38, bestGapMs: 1000 / 60, recentWorstMs: 20 });
    ok('38 of 60 fps is a ~0.63 ratio', Math.abs(damaged.fps.ratio - 38 / 60) < 0.01);
    ok(
      `0.63 is below the FPS warn threshold (${FPS_WARN_RATIO}) but not the critical one (${FPS_CRITICAL_RATIO})`,
      damaged.fps.level === 'warn'
    );

    const bad = buildPerfStripModel({ fps: 20, bestGapMs: 1000 / 60, recentWorstMs: 15 });
    ok('20 of 60 fps (0.33) is below the FPS critical threshold', bad.fps.level === 'critical');

    const good = buildPerfStripModel({ fps: 58, bestGapMs: 1000 / 60, recentWorstMs: 12 });
    ok('58 of 60 fps is comfortably ok', good.fps.level === 'ok');

    const noEstimate = buildPerfStripModel({ fps: 45, bestGapMs: null, recentWorstMs: 5 });
    ok(
      'no refresh estimate yet is unknown, not a guessed 60',
      noEstimate.fps.ratio === null && noEstimate.fps.level === 'unknown'
    );
    ok('value text drops the "/Hz" half when there is no estimate', noEstimate.fps.valueText === '45fps');

    const hitch = buildPerfStripModel({ fps: 55, bestGapMs: 1000 / 60, recentWorstMs: 80 });
    ok('a gap over the 50ms default threshold flags a hitch', hitch.fps.hitching === true);
    ok('the hitch text names the worst gap', hitch.fps.hitchText === 'hitch 80ms');
  }

  // ---- buildPerfStripModel: VRAM bar (passthrough of vram-inventory's own verdict) ----
  {
    const noVram = buildPerfStripModel({ fps: 60, bestGapMs: 16.7 });
    ok('no vram data is unknown', noVram.vram.level === 'unknown' && noVram.vram.ratio === null);
    ok('no vram data shows an em dash, never 0MB', noVram.vram.valueText === '—');

    const ok1 = buildPerfStripModel({
      fps: 60,
      bestGapMs: 16.7,
      vram: { headroomFraction: 0.8, verdict: 'ok', estimatedTotalMb: 500, ceilingMb: 2500 },
    });
    ok('ok verdict maps to ok level', ok1.vram.level === 'ok');
    ok('value text is "used/ceiling"', ok1.vram.valueText === '500MB/2500MB');

    const tight = buildPerfStripModel({
      fps: 60,
      bestGapMs: 16.7,
      vram: { headroomFraction: 0.2, verdict: 'tight', estimatedTotalMb: 2000, ceilingMb: 2500 },
    });
    ok("tight verdict maps to warn level (the bar's vocabulary)", tight.vram.level === 'warn');
    ok('the raw verdict word survives as labelText', tight.vram.labelText === 'tight');

    const critical = buildPerfStripModel({
      fps: 60,
      bestGapMs: 16.7,
      vram: { headroomFraction: 0.05, verdict: 'critical', estimatedTotalMb: 2400, ceilingMb: 2500 },
    });
    ok('critical verdict maps to critical level', critical.vram.level === 'critical');
  }

  // ---- buildPerfStripModel: JS heap bar (Chrome-only, absent is null not unknown) ----
  {
    const noHeap = buildPerfStripModel({ fps: 60, bestGapMs: 16.7 });
    ok('no performance.memory means no heap row at all', noHeap.heap === null);

    const heap = buildPerfStripModel({
      fps: 60,
      bestGapMs: 16.7,
      heapUsedBytes: 900 * 1024 * 1024,
      heapLimitBytes: 1000 * 1024 * 1024,
    });
    ok('heap ratio is REMAINING headroom, not usage', Math.abs(heap.heap.ratio - 0.1) < 0.001);
    ok('90% used with a 1GB limit is critical headroom', heap.heap.level === 'critical');
  }

  // ---- buildPerfStripModel: detail lines and the silent-unless-wrong warning ----
  {
    const idle = buildPerfStripModel({
      fps: 60,
      bestGapMs: 16.7,
      avgGapMs: 16.7,
      recentWorstMs: 17,
      allTimeWorstMs: 30,
      vt: { active: false },
    });
    ok('an inactive viewer says so plainly', idle.detailLines.includes('VT: not running'));
    ok('a healthy webgpu backend raises no warning', idle.warnings.length === 0);

    const running = buildPerfStripModel({
      fps: 60,
      bestGapMs: 16.7,
      vt: {
        active: true,
        renderMode: 'msa',
        itemsLoaded: 8,
        mip: { requested: 2 },
        cacheStats: { residentPages: 105, capacityPages: 2048, misses: 0, evictions: 0 },
      },
      renderInfo: { drawCalls: 812, triangles: 1234567 },
    });
    ok(
      'an active viewer reports its own stats',
      running.detailLines.some((l) => l.includes('8 items'))
    );
    ok(
      'page-cache fill is reported',
      running.detailLines.some((l) => l.includes('105/2048'))
    );
    ok(
      'render info formats with K/M suffixes',
      running.detailLines.some((l) => l.includes('1.2M'))
    );

    const fallback = buildPerfStripModel({ fps: 60, bestGapMs: 16.7, backend: 'webgl2' });
    ok(
      'a WebGL2 fallback is a loud, explicit warning',
      fallback.warnings.some((w) => w.includes('WebGL2 fallback'))
    );

    const versioned = buildPerfStripModel({ fps: 60, bestGapMs: 16.7, version: '0.6.0-dev.0' });
    ok(
      'the version is prefixed with v, no "Stage N" phrasing anywhere near it',
      versioned.versionText === 'v0.6.0-dev.0'
    );
  }
}
