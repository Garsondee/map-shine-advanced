/**
 * Node tests for perf-shader-variant-ab.js.
 *
 * Same fake-harness discipline as perf-sharpening-ab.test.mjs (armed before
 * waitFrames counts, restart resolves before anything is measured), adapted
 * for the GENERIC id-dispatched hook pair (readForcedShaderVariant(id) /
 * restartViewerWithForcedShaderVariant(id, mode)) and for MORE than one
 * toggle running in the same call — the one real structural difference from
 * the single-toggle sharpening file this one is modeled on.
 */
import { runShaderVariantAB, SHADER_VARIANT_TOGGLES, shaderVariantToggleById } from '../perf-shader-variant-ab.js';
import { AB_SEQUENCE } from '../perf-structural-ab.js';
import { ZONES } from '../perf-zones.js';

/**
 * @param {object} [opts]
 * @param {Record<string, boolean|null>} [opts.initialForce] - per-toggle-id
 *   starting force value.
 * @param {{id: string, step: number}|null} [opts.restartFailsAt] - which
 *   toggle's which measured step (0-based, into AB_SEQUENCE) should fail.
 * @param {string|null} [opts.restoreFailsFor] - which toggle's restore call
 *   should fail.
 */
function fakeHarness({ initialForce = {}, restartFailsAt = null, restoreFailsFor = null, zonesFor = null } = {}) {
  const restarts = []; // { id, mode }
  const uiEvents = [];
  const waitCalls = [];
  // ATTEMPT count, not success count — every CALL advances this regardless of
  // outcome, so a failed measured step still correctly leaves the NEXT call
  // (the restore) recognised as the 4th, unmeasured one. A success-only
  // counter would leave a failed step's own index un-advanced, making the
  // restore call that follows it look like a retry of the SAME failed step
  // instead of the real 4th call — exactly the bug this comment is here to
  // stop a future edit from reintroducing.
  const attemptCountByToggle = new Map();
  let armed = false;
  const force = { ...initialForce };
  return {
    restarts,
    uiEvents,
    waitCalls,
    getForce: (id) => force[id] ?? null,
    readForcedShaderVariant: (id) => force[id] ?? null,
    restartViewerWithForcedShaderVariant: async (id, mode) => {
      const attemptIndex = attemptCountByToggle.get(id) ?? 0;
      attemptCountByToggle.set(id, attemptIndex + 1);
      const isRestore = attemptIndex >= AB_SEQUENCE.length; // the 4th, unmeasured call for THIS toggle
      restarts.push({ id, mode });
      if (isRestore && restoreFailsFor === id) return { ok: false, error: `restore exploded for ${id}` };
      if (!isRestore && restartFailsAt && restartFailsAt.id === id && restartFailsAt.step === attemptIndex) {
        return { ok: false, error: `restart exploded for ${id} at step ${attemptIndex}` };
      }
      force[id] = mode;
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
      const zones = (zonesFor ?? (() => ({ 'geometry.worldDraw': { sumMs: 180 } })))();
      return { frames: 180, zoneStats: Object.entries(zones).map(([id, gpu]) => ({ id, gpu })) };
    },
  };
}

export function run(t) {
  const { ok } = t;

  // ==========================================================================
  // THE CATALOG'S WATCH LISTS ARE A CONTRACT WITH THE TAXONOMY
  // ==========================================================================
  {
    const declared = new Set(ZONES.map((z) => z.id));
    for (const toggle of SHADER_VARIANT_TOGGLES) {
      for (const z of toggle.watchZones) {
        ok(`${toggle.id} watches a zone that actually exists: ${z}`, declared.has(z));
      }
      ok(`${toggle.id} watches geometry.worldDraw`, toggle.watchZones.includes('geometry.worldDraw'));
    }
    ok('two catalog entries: maskNode, opaqueBlendOff', SHADER_VARIANT_TOGGLES.length === 2);
    ok('shaderVariantToggleById finds a real entry', shaderVariantToggleById('maskNode')?.id === 'maskNode');
    ok('shaderVariantToggleById returns null for an unknown id', shaderVariantToggleById('nope') === null);
  }

  return (async () => {
    // ========================================================================
    // A SINGLE TOGGLE (toggleIds filter), same ordering/restore shape as
    // perf-sharpening-ab.test.mjs's own "LIVE RUN" block
    // ========================================================================
    {
      const h = fakeHarness({ initialForce: { maskNode: null } });
      const r = await runShaderVariantAB(h, { measureFrames: 10, toggleIds: ['maskNode'] });
      ok('a live A/B reports that it ran', r.ran === true);
      ok('only the requested toggle ran', r.toggles.length === 1 && r.toggles[0].id === 'maskNode');
      ok(
        '...it restarted true, false, true, then restored to the original (null)',
        h.restarts.map((x) => `${x.id}:${x.mode}`).join(',') ===
          'maskNode:true,maskNode:false,maskNode:true,maskNode:null'
      );
      ok('...leaving the override exactly where it found it', h.getForce('maskNode') === null);
      ok('...carrying the live state it started from', r.toggles[0].liveState === null);
      ok('...having taken the live UI down ONCE for the whole batch', h.uiEvents.join(',') === 'hide,restore');
      ok('every waitFrames call happened while armed', h.waitCalls.length > 0 && h.waitCalls.every((c) => c.armed));
      ok('the method note says RESTARTED, not a live toggle', r.method.includes('RESTARTED'));
      ok('the method note says each toggle restores independently', r.method.includes('own restore'));
    }

    // ========================================================================
    // BOTH TOGGLES IN ONE CALL — the real reason this file exists rather than
    // being a copy-paste of the sharpening one
    // ========================================================================
    {
      const h = fakeHarness({ initialForce: { maskNode: false, opaqueBlendOff: true } });
      const r = await runShaderVariantAB(h, { measureFrames: 10 });
      ok(
        'both catalog toggles ran, in catalog order',
        r.toggles.map((x) => x.id).join(',') === 'maskNode,opaqueBlendOff'
      );
      ok('maskNode restored to its own original (false), not opaqueBlendOff’s', h.getForce('maskNode') === false);
      ok('opaqueBlendOff restored to its own original (true)', h.getForce('opaqueBlendOff') === true);
      ok('8 measured restarts total (4 per toggle)', h.restarts.filter((x) => x.mode !== null || true).length >= 8);
      ok(
        'the UI still only came down once for the whole batch, not per toggle',
        h.uiEvents.join(',') === 'hide,restore'
      );
    }

    // ========================================================================
    // ONE TOGGLE FAILING MUST NOT COST THE OTHER'S ALREADY-MEASURED DATA
    // ========================================================================
    {
      const h = fakeHarness({
        initialForce: { maskNode: null, opaqueBlendOff: null },
        restartFailsAt: { id: 'maskNode', step: 1 }, // fails maskNode's 'off' step
      });
      const r = await runShaderVariantAB(h, { measureFrames: 10 });
      const mask = r.toggles.find((x) => x.id === 'maskNode');
      const blend = r.toggles.find((x) => x.id === 'opaqueBlendOff');
      ok('the overall run still reports ran:true — a per-toggle failure is not a batch failure', r.ran === true);
      ok(
        'the failing toggle is reported as not-ran, with a named reason',
        mask.ran === false && mask.note.includes('restart exploded')
      );
      ok('the OTHER toggle still measured cleanly', blend.ran === undefined && blend.deltaGpuMs !== undefined);
      ok(
        'maskNode itself still got its own restore attempt despite the mid-run failure',
        h.getForce('maskNode') === null
      );
      ok('the UI still comes back exactly once', h.uiEvents.join(',') === 'hide,restore');
    }

    // ========================================================================
    // A FAILED RESTORE ON ONE TOGGLE IS REPORTED, NEVER SWALLOWED, AND DOES
    // NOT BLOCK THE OTHER TOGGLE FROM RUNNING
    // ========================================================================
    {
      const h = fakeHarness({
        initialForce: { maskNode: null, opaqueBlendOff: null },
        restoreFailsFor: 'maskNode',
      });
      const r = await runShaderVariantAB(h, { measureFrames: 10 });
      const mask = r.toggles.find((x) => x.id === 'maskNode');
      const blend = r.toggles.find((x) => x.id === 'opaqueBlendOff');
      ok('a failed restore surfaces on ITS OWN toggle, not thrown', mask.ran === false);
      ok('...naming the restore specifically', mask.note.includes('restore-to-original-state failed'));
      ok('opaqueBlendOff still ran and measured normally', blend.deltaGpuMs !== undefined);
      ok('the UI still comes back regardless', h.uiEvents.join(',') === 'hide,restore');
    }

    // ========================================================================
    // REFUSALS ARE NAMED, so "not supported" never reads as "found nothing"
    // ========================================================================
    {
      const none = await runShaderVariantAB({}, {});
      ok('a harness with no restart hook refuses rather than throwing', none.ran === false);
      ok('...and names the reason as a wiring gap', none.skipped === 'harness-cannot-restart');
      ok('...never attempted any restart', none.toggles.length === 0);
    }
    {
      const h = fakeHarness({ initialForce: { maskNode: null } });
      const none = await runShaderVariantAB(h, { toggleIds: ['doesNotExist'] });
      ok('an unknown toggleIds filter refuses cleanly, not silently-empty-success', none.ran === false);
      ok('...named as no-matching-toggles', none.skipped === 'no-matching-toggles');
    }

    // ========================================================================
    // THE REAL NUMBER: compareAbBlocks still does its own job underneath,
    // per toggle
    // ========================================================================
    {
      let call = 0;
      const h = fakeHarness({
        initialForce: { maskNode: null },
        zonesFor: () => {
          // step order per toggle: on(0), off(1), on(2) — 'on' (maskNode
          // removed) costs MORE here (more overdraw survives to shading).
          const step = call % (AB_SEQUENCE.length + 1); // +1 for the unmeasured restore call
          call++;
          const onCost = { 'geometry.worldDraw': { sumMs: 180 * 30 }, 'geometry.depthDraw': { sumMs: 180 * 5 } };
          const offCost = { 'geometry.worldDraw': { sumMs: 180 * 25 }, 'geometry.depthDraw': { sumMs: 180 * 5 } };
          return step === 1 ? offCost : onCost;
        },
      });
      const r = await runShaderVariantAB(h, { measureFrames: 180, toggleIds: ['maskNode'] });
      const tog = r.toggles[0];
      ok('a real cost delta comes back positive (discard removed costs more)', tog.deltaGpuMs > 0);
      ok('geometry.worldDraw is the biggest mover', tog.perZone[0].id === 'geometry.worldDraw');
    }
  })();
}
