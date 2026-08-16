/**
 * Node tests for perf-sharpening-ab.js.
 *
 * Same shape as perf-structural-ab.test.mjs's own "LIVE RUN" block — a fake
 * harness that enforces the same ordering contract the real one does (armed
 * before waitFrames counts, restart resolves before anything is measured) —
 * adapted for a settle model that is "restart and trust the promise" rather
 * than "flip and wait N frames".
 */
import { runSharpeningAB, SHARPENING_WATCH_ZONES } from '../perf-sharpening-ab.js';
import { AB_SEQUENCE } from '../perf-structural-ab.js';
import { ZONES } from '../perf-zones.js';

/**
 * Minimal harness. `restarts` records each requested mode so restore can be
 * asserted; `waitCalls` pins the direct regression this whole family of
 * fakes exists to catch (perf-structural-ab.test.mjs's own comment explains
 * the 2026-08-12 incident this pattern is copied from).
 */
function fakeHarness({ initialForce = null, restartFails = -1, restoreFails = false, zonesFor = null } = {}) {
  const restarts = [];
  const uiEvents = [];
  const waitCalls = [];
  let restartCount = 0;
  let armed = false;
  let force = initialForce;
  return {
    restarts,
    uiEvents,
    waitCalls,
    getForce: () => force,
    readAlbedoClarityForce: () => force,
    restartViewerWithAlbedoClarityForce: async (mode) => {
      const isRestore = restartCount >= AB_SEQUENCE.length; // the 4th, unmeasured call
      restarts.push(mode);
      if (isRestore && restoreFails) return { ok: false, error: 'restore exploded' };
      if (!isRestore && restartCount === restartFails) return { ok: false, error: 'restart exploded' };
      restartCount++;
      force = mode;
      return { ok: true };
    },
    resetFrameStats: () => {},
    hideLiveUi: () => uiEvents.push('hide'),
    restoreLiveUi: () => uiEvents.push('restore'),
    armProfiler: () => {
      armed = true;
    },
    disarmProfiler: () => {
      armed = false;
    },
    waitFrames: async () => {
      waitCalls.push({ armed });
      if (!armed) throw new Error('perf profile: waited 30s for frames but only 0 were counted.');
    },
    setGpuZoneTimer: () => ({ armed: true }),
    getGpuZoneStatus: () => ({ frameGpuMs: { p50: 70, sampleCount: 60 } }),
    readProfile: () => {
      const zones = (zonesFor ?? (() => ({ 'geometry.worldDraw': { sumMs: 180 } })))(restartCount - 1, force);
      return { frames: 180, zoneStats: Object.entries(zones).map(([id, gpu]) => ({ id, gpu })) };
    },
  };
}

export function run(t) {
  const { ok } = t;

  // ==========================================================================
  // THE WATCH LIST IS A CONTRACT WITH THE TAXONOMY
  // ==========================================================================
  {
    const declared = new Set(ZONES.map((z) => z.id));
    for (const z of SHARPENING_WATCH_ZONES) {
      ok(`watches a zone that actually exists: ${z}`, declared.has(z));
    }
    ok(
      'geometry.worldDraw is watched — that is where the CAS taps live',
      SHARPENING_WATCH_ZONES.includes('geometry.worldDraw')
    );
  }

  return (async () => {
    // ========================================================================
    // LIVE RUN: ordering, restore, and the ON/OFF/ON shape
    // ========================================================================
    {
      const h = fakeHarness({ initialForce: null });
      const r = await runSharpeningAB(h, { measureFrames: 10 });
      ok('a live A/B reports that it ran', r.ran === true);
      // 3 measured restarts (true, false, true) + 1 restore (back to null).
      ok(
        '...it restarted true, false, true, then restored to the original (null)',
        h.restarts.join(',') === 'true,false,true,'
      );
      ok('...leaving the override exactly where it found it', h.getForce() === null);
      ok(
        'one toggle in the result, named albedoClarity',
        r.toggles.length === 1 && r.toggles[0].id === 'albedoClarity'
      );
      ok('...carrying the live state it started from', r.toggles[0].liveState === null);
      ok('...having taken the live UI down for its duration', h.uiEvents.join(',') === 'hide,restore');
      // Same direct regression pin perf-structural-ab.test.mjs uses: every
      // waitFrames call must happen while armed, or it is checking a fake of
      // a different, easier harness than the real one.
      ok('every waitFrames call happened while armed', h.waitCalls.length > 0 && h.waitCalls.every((c) => c.armed));
      ok('the method note says RESTARTED, not a live toggle', r.method.includes('RESTARTED'));
    }

    // A viewer that starts with a real force value must be restored to it,
    // not to null — restoring to "no override" would be a different state.
    {
      const h = fakeHarness({ initialForce: true });
      const r = await runSharpeningAB(h, { measureFrames: 10 });
      ok('an originally-forced-true state is restored to true, not null', h.getForce() === true);
      ok('...and the report says so', r.toggles[0].liveState === true);
    }

    // ========================================================================
    // A FAILED RESTART DURING MEASUREMENT REFUSES CLEANLY, AND STILL RESTORES
    // ========================================================================
    {
      const h = fakeHarness({ initialForce: false, restartFails: 1 }); // fails on the 'off' step
      const r = await runSharpeningAB(h, { measureFrames: 10 });
      ok('a mid-run restart failure is reported, not thrown', r.ran === false);
      ok('...named as the actual cause', r.note.includes('restart exploded'));
      // The failed step never incremented restartCount, so the loop's own
      // break still lets the outer finally attempt a restore.
      ok('...the UI still comes back even on this path', h.uiEvents.join(',') === 'hide,restore');
    }

    // ========================================================================
    // A FAILED RESTORE IS REPORTED, NEVER SWALLOWED — worse than a failed
    // measurement, because it can leave a real session on the wrong variant.
    // ========================================================================
    {
      const h = fakeHarness({ initialForce: null, restoreFails: true });
      const r = await runSharpeningAB(h, { measureFrames: 10 });
      ok('a failed restore surfaces as a real failure, not a silent swallow', r.ran === false);
      ok('...naming the restore specifically', r.note.includes('restore-to-original-state failed'));
      ok('...and the UI still comes back regardless', h.uiEvents.join(',') === 'hide,restore');
    }

    // ========================================================================
    // REFUSALS ARE NAMED, so "not supported" never reads as "found nothing"
    // ========================================================================
    {
      const none = await runSharpeningAB({}, {});
      ok('a harness with no restart hook refuses rather than throwing', none.ran === false);
      ok('...and names the reason as a wiring gap', none.skipped === 'harness-cannot-restart');
      ok('...never attempted any restart', none.toggles.length === 0);
    }

    // ========================================================================
    // THE REAL NUMBER: compareAbBlocks still does its own job underneath
    // ========================================================================
    {
      const h = fakeHarness({
        initialForce: null,
        zonesFor: (i) => {
          // step 0/2 = 'on' (full CAS, costs more); step 1 = 'off' (flat, cheaper).
          const onCost = { 'geometry.worldDraw': { sumMs: 180 * 27 }, 'geometry.depthDraw': { sumMs: 180 * 5 } }; // 27ms/frame
          const offCost = { 'geometry.worldDraw': { sumMs: 180 * 22 }, 'geometry.depthDraw': { sumMs: 180 * 5 } }; // 22ms/frame
          return i === 1 ? offCost : onCost;
        },
      });
      const r = await runSharpeningAB(h, { measureFrames: 180 });
      const tog = r.toggles[0];
      ok('a real cost delta comes back positive (full CAS costs more)', tog.deltaGpuMs > 0);
      ok('geometry.worldDraw is the biggest mover', tog.perZone[0].id === 'geometry.worldDraw');
      ok(
        'geometry.depthDraw shows ~0 delta — the confound check working',
        Math.abs(tog.perZone.find((z) => z.id === 'geometry.depthDraw').deltaMs) < 0.01
      );
    }
  })();
}
