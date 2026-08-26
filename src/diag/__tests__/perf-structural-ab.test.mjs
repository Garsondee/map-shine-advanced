/**
 * Node tests for perf-structural-ab.js.
 *
 * This module flips REAL pipeline state on a live viewer, so two of the blocks
 * below are not about arithmetic at all — they are about what happens when the
 * thing throws mid-flip. A structural A/B that leaves early-Z off after a failed
 * run does not produce a wrong number; it produces a rendering regression that
 * surfaces hours later with nothing pointing back here.
 *
 * The arithmetic blocks pin one thing above all: a delta smaller than the run's
 * own measured drift must NOT become a verdict. The effect sweep this module
 * replaces published exactly that kind of number for three captures running.
 */
import {
  AB_REPRESENTATIVE_TOLERANCE,
  AB_SEQUENCE,
  AB_SIGNIFICANCE_FACTOR,
  DEFAULT_AB_CYCLES,
  EDIT_CASCADE_WATCH_ZONES,
  STRUCTURAL_TOGGLES,
  aggregateAbCycles,
  buildAbSequence,
  compareAbBlocks,
  measureAmbientNoiseFloor,
  runEditCascadeStress,
  runStructuralAB,
  summariseAbBlock,
  toggleById,
} from '../perf-structural-ab.js';
import { ZONES } from '../perf-zones.js';

/** A block as compareAbBlocks consumes one. */
const block = (zones) => ({
  frames: 180,
  frameGpuMs: null,
  attributedGpuMs: Object.values(zones).reduce((a, b) => a + b, 0),
  gpuSampleCount: 60,
  zones,
});

/**
 * Minimal harness: records the flip order so restore can be asserted, AND
 * models the one contract that actually matters here — `waitFrames` only
 * counts while the profiler is armed, exactly like the real
 * `createProfiledFrameWaiter` (perf-session.js).
 *
 * ⚠️ THIS FAKE USED TO RESOLVE `waitFrames` UNCONDITIONALLY, and that is
 * precisely how the 2026-08-12 live regression shipped past 62 passing tests.
 * The real bug was `waitFrames(settleFrames)` called BEFORE `armProfiler` —
 * live, that meant the poll's `seen` count could never leave 0 no matter how
 * many real frames rendered, and the run timed out at 30s with an error that
 * blames "the viewer is probably not running" on a viewer rendering perfectly.
 * A fake that does not enforce the same ordering constraint the real harness
 * enforces is not a fake of the real harness — it is a fake of a DIFFERENT,
 * easier harness, and every test built on it is checking the wrong contract.
 */
function fakeHarness({ toggles = { earlyZComposition: true }, throwOnBlock = -1, zonesFor = null } = {}) {
  const flips = [];
  const uiEvents = [];
  // {armed} per waitFrames call — the direct regression pin. If this ever
  // contains a `false`, some call site is waiting on an unarmed profiler again.
  const waitCalls = [];
  let blockIndex = 0;
  let armed = false;
  const state = { ...toggles };
  return {
    flips,
    uiEvents,
    waitCalls,
    state,
    readStructuralToggle: (id) => (id in state ? state[id] : null),
    setStructuralToggle: (id, on) => {
      flips.push([id, on]);
      state[id] = on;
      return { changed: true };
    },
    waitFrames: async () => {
      waitCalls.push({ armed });
      if (!armed) {
        // The real waiter does not throw synchronously here — it polls for
        // WAIT_TIMEOUT_MS and THEN throws this exact wording. Throwing
        // immediately is a deliberate test simplification (no 30-second test),
        // not a claim that the real error is synchronous.
        throw new Error(
          'perf profile: waited 30s for frames but only 0 were counted. The viewer is probably not running — load a scene first.'
        );
      }
    },
    resetFrameStats: () => {},
    // The live HUD re-arms the profiler as a DIFFERENT owner ~4x/second, and
    // frame-profiler.arm() throws on an owner mismatch. The A/B must therefore
    // take the UI down for its own duration — and put it back even on a throw.
    hideLiveUi: () => uiEvents.push('hide'),
    restoreLiveUi: () => uiEvents.push('restore'),
    armProfiler: () => {
      if (blockIndex === throwOnBlock) throw new Error('arm exploded');
      armed = true;
    },
    disarmProfiler: () => {
      armed = false;
    },
    setGpuZoneTimer: () => ({ armed: true }),
    getGpuZoneStatus: () => ({ frameGpuMs: { p50: 70, sampleCount: 60 } }),
    readProfile: () => {
      const zones = (zonesFor ?? (() => ({ 'geometry.worldDraw': { sumMs: 180 } })))(blockIndex++, state);
      return { frames: 180, zoneStats: Object.entries(zones).map(([id, gpu]) => ({ id, gpu })) };
    },
  };
}

export function run(t) {
  const { ok } = t;

  // ======================================================================
  // THE CATALOG IS A CONTRACT WITH THE TAXONOMY
  // ======================================================================
  {
    ok('the sequence brackets OFF with two ONs', AB_SEQUENCE.join(',') === 'on,off,on');
    ok('...so the floor is measured from the same state twice', AB_SEQUENCE[0] === AB_SEQUENCE[2]);
    ok('at least one structural toggle is catalogued', STRUCTURAL_TOGGLES.length > 0);
    ok('toggleById finds a real one', toggleById('earlyZComposition')?.id === 'earlyZComposition');
    ok('toggleById returns null, never undefined, for a miss', toggleById('nope') === null);
    // Stage 2's own formal acceptance gate (S2.9) was designed but never run —
    // this closes that gap using the same mechanism earlyZComposition proved.
    ok(
      'point-light batching (Stage 2) is also catalogued',
      toggleById('pointLightBatching')?.id === 'pointLightBatching'
    );
    ok(
      'point-light batching needs no settle-time override, unlike earlyZComposition',
      toggleById('pointLightBatching').settleFrames === undefined
    );

    // EVERY watched zone must be a REAL declared zone. A typo here produces a
    // silently empty comparison — the toggle would report "no movers" and read
    // as "this changed nothing", which is the opposite of what happened.
    const declared = new Set(ZONES.map((z) => z.id));
    for (const tog of STRUCTURAL_TOGGLES) {
      for (const z of tog.watchZones) {
        ok(`${tog.id} watches a zone that actually exists: ${z}`, declared.has(z));
      }
      ok(`${tog.id} carries the question it answers`, typeof tog.question === 'string' && tog.question.length > 20);
    }
    // Early-Z takes effect on the NEXT residency pass, not synchronously, so a
    // default-length settle would measure a half-changed state.
    ok(
      'earlyZComposition settles longer than the default, because it applies asynchronously',
      toggleById('earlyZComposition').settleFrames >= 120
    );

    // EDIT_CASCADE_WATCH_ZONES is not a STRUCTURAL_TOGGLES entry (there is no
    // boolean to flip) but it is the same kind of contract with the zone
    // taxonomy, and just as easy to typo into a silently-empty comparison.
    ok('at least one edit-cascade watch zone is catalogued', EDIT_CASCADE_WATCH_ZONES.length > 0);
    for (const z of EDIT_CASCADE_WATCH_ZONES) {
      ok(`edit-cascade stress watches a zone that actually exists: ${z}`, declared.has(z));
    }
    ok(
      'fire is deliberately absent — light.fireSync is "conditional" cadence, not "bake", so it has no ' +
        'version-gated rebuild for a mask-authority bump to force',
      !EDIT_CASCADE_WATCH_ZONES.includes('light.fireSync')
    );
  }

  // ======================================================================
  // A DELTA INSIDE THE RUN'S OWN DRIFT IS NOT A RESULT
  // ======================================================================
  {
    // The two ON blocks disagree by 4ms; the ON/OFF delta is only 2ms.
    const r = compareAbBlocks({
      on1: block({ a: 40 }),
      off: block({ a: 42 }),
      on2: block({ a: 44 }),
      watchZones: ['a'],
    });
    ok('a delta inside the measured drift earns NO verdict', r.verdict === 'within-noise');
    ok('...and the floor came from the two ON blocks', r.noiseFloorMs === 4);
    ok('...the note says "could not tell", not "no difference"', r.note.includes('could not tell'));
    ok('...both ON readings are kept, not silently averaged away', r.onBlocks.join(',') === '40,44');
    ok('...the significance factor used is reported', r.significanceFactor === AB_SIGNIFICANCE_FACTOR);

    // Same drift, a delta that clears it comfortably.
    const win = compareAbBlocks({
      on1: block({ a: 40 }),
      off: block({ a: 60 }),
      on2: block({ a: 41 }),
      watchZones: ['a'],
    });
    ok('a delta well clear of the floor earns a verdict', win.verdict === 'pays-for-itself');
    ok('...ON is the mean of both ON blocks', win.onGpuMs === 40.5);
    ok('...delta is signed ON minus OFF, so cheaper reads negative', win.deltaGpuMs === -19.5);

    const lose = compareAbBlocks({
      on1: block({ a: 60 }),
      off: block({ a: 40 }),
      on2: block({ a: 61 }),
      watchZones: ['a'],
    });
    ok('a toggle that costs more than it saves says so', lose.verdict === 'costs-more-than-it-saves');
    ok('...and the delta is positive', lose.deltaGpuMs > 0);

    // A missing block is an absence, never a "no difference" result.
    const gone = compareAbBlocks({ on1: block({ a: 40 }), off: null, on2: block({ a: 40 }) });
    ok('a missing block yields "unmeasured", not a comparison', gone.verdict === 'unmeasured');
    ok('...with a null delta rather than a fabricated 0', gone.deltaGpuMs === null);
    ok('...and says so as an ABSENCE', gone.note.includes('ABSENCE'));
  }

  // ======================================================================
  // THE PER-ZONE TABLE IS THE EXPLANATION, NOT THE HEADLINE
  // ======================================================================
  {
    // The real early-Z shape: a prepass that exists only when ON, against a
    // world draw that gets cheaper in exchange.
    const r = compareAbBlocks({
      on1: block({ 'geometry.earlyZPrepass': 18, 'geometry.worldDraw': 23, 'light.drawIllum': 0.6 }),
      off: block({ 'geometry.earlyZPrepass': 0, 'geometry.worldDraw': 45, 'light.drawIllum': 0.6 }),
      on2: block({ 'geometry.earlyZPrepass': 18, 'geometry.worldDraw': 23, 'light.drawIllum': 0.6 }),
      watchZones: ['geometry.earlyZPrepass', 'geometry.worldDraw'],
    });
    ok('the trade nets out to a saving here', r.verdict === 'pays-for-itself');
    ok('the biggest MOVER sorts first, not the biggest zone', r.perZone[0].id === 'geometry.worldDraw');
    ok('...worldDraw gave back 22ms', r.perZone[0].deltaMs === -22);
    ok('...the prepass cost 18ms it did not pay before', r.perZone[1].deltaMs === 18);
    ok(
      'a zone that did not move is still listed, at the bottom',
      r.perZone[r.perZone.length - 1].id === 'light.drawIllum'
    );
    ok('...with a zero delta, which here IS a measurement', r.perZone[r.perZone.length - 1].deltaMs === 0);
    ok('watched zones are marked as such', r.perZone.find((z) => z.id === 'geometry.worldDraw').watched === true);
    ok('...and unwatched ones are not', r.perZone.find((z) => z.id === 'light.drawIllum').watched === false);

    // A zone present ONLY in the OFF state must not be dropped from the table.
    const asym = compareAbBlocks({
      on1: block({ a: 10 }),
      off: block({ a: 10, b: 7 }),
      on2: block({ a: 10 }),
      watchZones: [],
    });
    ok(
      'a zone that exists only in one state still appears',
      asym.perZone.some((z) => z.id === 'b')
    );
    ok(
      '...with the missing side counted as 0, which is true for it',
      asym.perZone.find((z) => z.id === 'b').onMs === 0
    );
  }

  // ======================================================================
  // A PARKED VIEW MUST NOT SILENTLY STAND IN FOR THE WHOLE ROUTE
  // ======================================================================
  {
    const args = {
      on1: block({ 'geometry.worldDraw': 23, 'geometry.earlyZPrepass': 18 }),
      off: block({ 'geometry.worldDraw': 45, 'geometry.earlyZPrepass': 0 }),
      on2: block({ 'geometry.worldDraw': 23, 'geometry.earlyZPrepass': 18 }),
      watchZones: ['geometry.worldDraw', 'geometry.earlyZPrepass'],
    };
    const agree = compareAbBlocks({
      ...args,
      routeZones: { 'geometry.worldDraw': 23.6, 'geometry.earlyZPrepass': 18.1 },
    });
    ok('a parked view matching the route is called representative', agree.representative.verdict === 'representative');
    ok('...and the verdict is allowed to generalise', agree.representative.note.includes('generalises'));

    const differ = compareAbBlocks({
      ...args,
      routeZones: { 'geometry.worldDraw': 60, 'geometry.earlyZPrepass': 18.1 },
    });
    ok('a parked view far from the route is called view-local', differ.representative.verdict === 'view-local');
    ok('...it names WHICH zone diverged', differ.representative.diverging.join(',') === 'geometry.worldDraw');
    ok('...and refuses to generalise', differ.representative.note.includes('must not be generalised'));
    ok(
      'the tolerance is what decides it',
      Math.abs(differ.representative.zones.find((z) => z.id === 'geometry.worldDraw').ratio - 1) >
        AB_REPRESENTATIVE_TOLERANCE
    );

    // No route data is UNKNOWN, never assumed-representative.
    const blind = compareAbBlocks(args);
    ok('with no route data the check is null, not a pass', blind.representative === null);
  }

  // ======================================================================
  // summariseAbBlock: absence stays absence
  // ======================================================================
  {
    const s = summariseAbBlock({
      profile: {
        frames: 100,
        zoneStats: [
          { id: 'a', gpu: { sumMs: 500 } },
          { id: 'b', gpu: null },
        ],
      },
      gpuStatus: { frameGpuMs: { p50: 12, sampleCount: 40 } },
    });
    ok('zone GPU is amortised per frame so blocks of different lengths compare', s.zones.a === 5);
    ok('a zone with no GPU sample is omitted, not zeroed', !('b' in s.zones));
    ok('attributed is the sum of what was actually measured', s.attributedGpuMs === 5);

    const empty = summariseAbBlock({ profile: { frames: 100, zoneStats: [] }, gpuStatus: null });
    ok('a block with no GPU zones reports null attributed, never 0', empty.attributedGpuMs === null);
    ok('...and a null frame total rather than a free frame', empty.frameGpuMs === null);
    ok('a wholly absent profile does not throw', summariseAbBlock({}).frames === 0);
  }

  // ======================================================================
  // buildAbSequence: cycles:1 is byte-identical to the original AB_SEQUENCE
  // ======================================================================
  {
    ok('cycles:1 (the default) reproduces AB_SEQUENCE exactly', buildAbSequence(1).join(',') === AB_SEQUENCE.join(','));
    ok('...and so does calling with no argument at all', buildAbSequence().join(',') === AB_SEQUENCE.join(','));
    ok('the library default is 1, unchanged behaviour for any existing caller', DEFAULT_AB_CYCLES === 1);
    ok(
      'cycles:2 walks 5 blocks, sharing the middle ON between both cycles',
      buildAbSequence(2).join(',') === 'on,off,on,off,on'
    );
    ok('cycles:3 walks 7 blocks', buildAbSequence(3).length === 7);
    ok(
      'a non-positive cycles count still yields at least one real cycle',
      buildAbSequence(0).join(',') === 'on,off,on'
    );
  }

  // ======================================================================
  // aggregateAbCycles: one window matches compareAbBlocks EXACTLY; multiple
  // windows use Math.max for the combined floor, never an average
  // ======================================================================
  {
    const w1 = {
      on1: block({ a: 40 }),
      off: block({ a: 60 }),
      on2: block({ a: 41 }),
    };
    const direct = compareAbBlocks({ ...w1, watchZones: ['a'] });
    const single = aggregateAbCycles({ windows: [w1], watchZones: ['a'] });
    ok(
      'a single window reproduces compareAbBlocks verbatim',
      single.verdict === direct.verdict && single.deltaGpuMs === direct.deltaGpuMs
    );
    ok(
      '...plus a perCycle[] field carrying that same one result',
      single.perCycle.length === 1 && single.perCycle[0].verdict === direct.verdict
    );

    // Two cycles that individually agree closely (small within-cycle floors)
    // but whose OWN deltas disagree with each other by a lot — the combined
    // floor must reflect that cross-cycle disagreement, not the small
    // within-cycle numbers alone.
    const cycleA = {
      on1: block({ a: 40 }),
      off: block({ a: 60 }), // delta = 40.5 - 60 = -19.5
      on2: block({ a: 41 }),
    };
    const cycleB = {
      on1: block({ a: 41 }),
      off: block({ a: 42 }), // delta = 40.5 - 42 = -1.5, a much smaller trade
      on2: block({ a: 40 }),
    };
    const multi = aggregateAbCycles({ windows: [cycleA, cycleB], watchZones: ['a'] });
    const withinFloorAvg =
      (compareAbBlocks({ ...cycleA, watchZones: ['a'] }).noiseFloorMs +
        compareAbBlocks({ ...cycleB, watchZones: ['a'] }).noiseFloorMs) /
      2;
    const crossSpread = Math.abs(-19.5 - -1.5); // 18
    ok(
      'the combined floor is the LARGER of within-cycle drift and cross-cycle spread',
      multi.noiseFloorMs === Math.max(withinFloorAvg, crossSpread)
    );
    ok(
      '...which here is the cross-cycle spread, not the (smaller) within-cycle average',
      multi.noiseFloorMs === crossSpread
    );
    ok('the combined delta is the mean of both cycles', multi.deltaGpuMs === (-19.5 + -1.5) / 2);
    ok('perCycle[] keeps both individual results, not just the combined one', multi.perCycle.length === 2);

    const empty = aggregateAbCycles({ windows: [] });
    ok('zero windows yields "unmeasured", not a fabricated comparison', empty.verdict === 'unmeasured');
  }

  // ======================================================================
  // LIVE RUN: ordering, restore, and refusal
  // ======================================================================
  return (async () => {
    {
      // includeAmbientCheck:false — this block pins TOGGLE flip/restore/count
      // mechanics specifically; the ambient pre-check (on by default) has its
      // own dedicated coverage further down and would otherwise shift this
      // fake's blockIndex-driven waitCalls count for no reason relevant here.
      const h = fakeHarness({ toggles: { earlyZComposition: true } });
      const r = await runStructuralAB(h, {
        toggleIds: ['earlyZComposition'],
        measureFrames: 10,
        includeAmbientCheck: false,
      });
      ok('a live A/B reports that it ran', r.ran === true);
      ok('...with no ambient check when disabled', r.ambientCheck === null);
      ok('...it flipped on, off, on, then restored', h.flips.map(([, v]) => (v ? 1 : 0)).join('') === '1011');
      ok('...leaving the viewer in the state it found it', h.state.earlyZComposition === true);
      ok('...and it says the camera was parked, not routing', r.cameraNote.includes('PARKED'));
      ok('one result per toggle', r.toggles.length === 1);
      ok('...carrying the live state it started from', r.toggles[0].liveState === true);
      // Without this the live perf HUD re-arms the profiler as owner 'hud'
      // mid-block and frame-profiler.arm() throws on the mismatch.
      ok('...having taken the live UI down for its duration', h.uiEvents.join(',') === 'hide,restore');
      // ⚠️ THE DIRECT REGRESSION PIN for the 2026-08-12 live failure: every
      // waitFrames call happened while the profiler was ARMED. Two per block
      // (settle, then measure) x three blocks = 6. If this ever contains a
      // `false`, some call site is waiting on an unarmed profiler again, and it
      // will time out live exactly like it did before this fake could catch it.
      ok('every waitFrames call happened while armed', h.waitCalls.length === 6 && h.waitCalls.every((c) => c.armed));
    }

    // Restore is in a `finally`. This is the block that matters most: a throw
    // must not strand the renderer in the OFF state.
    {
      // includeAmbientCheck:false — same reasoning as the block above: this
      // test's `throwOnBlock:1` targets the TOGGLE's own second block by
      // blockIndex, and the ambient pre-check's own two readProfile() calls
      // would shift that index before the toggle loop ever starts.
      const h = fakeHarness({ toggles: { earlyZComposition: true }, throwOnBlock: 1 });
      let threw = false;
      try {
        await runStructuralAB(h, {
          toggleIds: ['earlyZComposition'],
          measureFrames: 10,
          includeAmbientCheck: false,
        });
      } catch {
        threw = true;
      }
      ok('a throw mid-A/B propagates rather than being swallowed', threw === true);
      ok('...but the toggle is STILL restored to what it was', h.state.earlyZComposition === true);
      ok('...with the restore as the final flip', h.flips[h.flips.length - 1][1] === true);
      ok('...and the debug UI comes back even on the throw path', h.uiEvents.join(',') === 'hide,restore');
    }

    // A viewer that starts with the toggle OFF must be restored to OFF. Left
    // with the ambient check at its real default (on) — this doubles as
    // coverage that the pre-check doesn't disturb ordinary restore behaviour.
    {
      const h = fakeHarness({ toggles: { earlyZComposition: false } });
      await runStructuralAB(h, { toggleIds: ['earlyZComposition'], measureFrames: 10 });
      ok('an originally-OFF toggle is restored to OFF, not to the default', h.state.earlyZComposition === false);
    }

    // MULTIPLE CYCLES: a 2-cycle run walks 5 blocks (10 waitFrames calls, two
    // per block) and shares the middle ON between both cycles.
    {
      const h = fakeHarness({ toggles: { earlyZComposition: true } });
      const r = await runStructuralAB(h, {
        toggleIds: ['earlyZComposition'],
        measureFrames: 10,
        cycles: 2,
        includeAmbientCheck: false,
      });
      ok('cycles:2 flips on,off,on,off,on then restores', h.flips.map(([, v]) => (v ? 1 : 0)).join('') === '101011');
      ok('...five measured blocks, ten waitFrames calls (settle+measure per block)', h.waitCalls.length === 10);
      ok('...reported back as 2 cycles', r.toggles[0].cycles === 2);
      ok('...method names the cycle count', r.method.includes('2 cycles'));
    }

    // A default (cycles:1) run's method string stays exactly as it always
    // was — no "(N cycles)" suffix for the common case.
    {
      const h = fakeHarness({ toggles: { earlyZComposition: true } });
      const r = await runStructuralAB(h, {
        toggleIds: ['earlyZComposition'],
        measureFrames: 10,
        includeAmbientCheck: false,
      });
      ok('a single-cycle run does not mention cycles in its method string', !r.method.includes('cycles'));
    }

    // THE AMBIENT-NOISE PRE-CHECK, live: runs once before any toggle flip,
    // and every toggle carries a ratio against it.
    {
      const h = fakeHarness({ toggles: { earlyZComposition: true } });
      const r = await runStructuralAB(h, { toggleIds: ['earlyZComposition'], measureFrames: 10 });
      ok('the ambient check ran by default', r.ambientCheck?.measured === true);
      ok('...before the first real toggle flip', h.flips[0][0] === 'earlyZComposition');
      ok(
        'the toggle carries a ratio against the ambient floor',
        r.toggles[0].noiseFloorVsAmbientRatio === null || Number.isFinite(r.toggles[0].noiseFloorVsAmbientRatio)
      );
    }

    // measureAmbientNoiseFloor in isolation: two back-to-back readings of the
    // SAME (unflipped) state, no setStructuralToggle call at all.
    {
      const h = fakeHarness({ toggles: { earlyZComposition: true } });
      const r = await measureAmbientNoiseFloor(h, { settleFrames: 5, measureFrames: 10 });
      ok('a real measurement comes back', r.measured === true);
      ok('...as a non-negative jitter figure', r.ambientNoiseMs >= 0);
      ok('...having touched no toggle at all', h.flips.length === 0);
    }

    // Refusals must be NAMED, so "not supported" never reads as "found nothing".
    {
      const none = await runStructuralAB({}, {});
      ok('a harness with no toggle hook refuses rather than throwing', none.ran === false);
      ok('...and names the reason as a wiring gap', none.skipped === 'harness-cannot-toggle');
      ok('...explicitly not a measurement result', none.note.includes('not a measurement result'));

      const unreadable = await runStructuralAB({ setStructuralToggle: () => {}, readStructuralToggle: () => null }, {});
      ok('a toggle that cannot be READ is never flipped', unreadable.ran === false);
      ok('...because there would be nothing to restore it to', unreadable.skipped === 'no-readable-toggles');
    }

    // ====================================================================
    // EDIT-CASCADE STRESS: no boolean to flip — "on" is a burst of injected
    // edits, "off" is an equal-length window where nothing is touched.
    // ====================================================================
    {
      const none = await runEditCascadeStress({}, {});
      ok('no triggerEdit -> refuses rather than fabricating a result', none.ran === false);
      ok('...and names the gap', none.skipped === 'no-edit-trigger');
      ok('...never a measurement result', none.note.includes('not a measurement result'));
    }

    {
      const editCalls = [];
      const triggerEdit = async () => {
        editCalls.push(true);
      };
      // blockIndex 0 and 2 are the two BURST blocks (cycles:1 -> on,off,on);
      // 1 is the QUIET block in between. Bake zones fire large during a
      // burst and sit at zero at rest — the shape a real mask-authority
      // version bump forcing unnecessary rebakes would actually produce.
      const h = fakeHarness({
        zonesFor: (blockIndex) =>
          blockIndex % 2 === 0
            ? { 'light.sunShadowBake': { sumMs: 180 }, 'light.waterBodyBake': { sumMs: 360 } }
            : { 'light.sunShadowBake': { sumMs: 0 }, 'light.waterBodyBake': { sumMs: 0 } },
      });
      const r = await runEditCascadeStress(h, { triggerEdit, pings: 3, gapFrames: 2, settleFrames: 5 });

      ok('a live run reports that it ran', r.ran === true);
      ok('triggerEdit fired pings × (number of burst blocks), never during the quiet block', editCalls.length === 6);
      ok('burst reads measurably more expensive than quiet here', r.verdict === 'costs-more-than-it-saves');
      ok('...burstGpuMs is the elevated per-frame reading (1+2ms across the two watched zones)', r.burstGpuMs === 3);
      ok('...quietGpuMs is genuinely zero, not merely small', r.quietGpuMs === 0);
      ok('...delta is signed burst minus quiet', r.deltaGpuMs === 3);
      ok(
        'pings and gapFrames are echoed back for the report to show its own method',
        r.pings === 3 && r.gapFrames === 2
      );
      ok(
        'the method string speaks burst/quiet, not the shared on/off vocabulary',
        r.method.startsWith('burst→quiet→burst')
      );
      ok('no routeZones were supplied, so representativeness is null, not assumed', r.representative === null);
      ok('a single default cycle is reported', r.cycles === 1 && r.perCycle.length === 1);
      // Same UI/timing discipline runStructuralAB already proved live —
      // reused, not reinvented, for this second A/B-shaped mechanism.
      ok('the live UI is hidden for the run and restored after, even here', h.uiEvents.join(',') === 'hide,restore');
      ok('every waitFrames call happened while armed', h.waitCalls.length === 10 && h.waitCalls.every((c) => c.armed));
    }

    // A quiet run (triggerEdit exists but the zones never move) must earn
    // NO verdict, not a false "nothing to see here" pass silently treated
    // the same as "measurably safe" — within-noise is its own honest state.
    {
      const h = fakeHarness({ zonesFor: () => ({ 'light.sunShadowBake': { sumMs: 0 } }) });
      const r = await runEditCascadeStress(h, {
        triggerEdit: async () => {},
        pings: 2,
        gapFrames: 2,
        settleFrames: 5,
      });
      ok('zero movement in either state is a real, honest zero delta', r.deltaGpuMs === 0);
      ok('...reported as within-noise, not "pays for itself"', r.verdict === 'within-noise');
    }
  })();
}
