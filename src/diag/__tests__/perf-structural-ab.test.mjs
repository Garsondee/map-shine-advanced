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
  STRUCTURAL_TOGGLES,
  compareAbBlocks,
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

/** Minimal harness: records the flip order so restore can be asserted. */
function fakeHarness({ toggles = { earlyZComposition: true }, throwOnBlock = -1, zonesFor = null } = {}) {
  const flips = [];
  const uiEvents = [];
  let blockIndex = 0;
  const state = { ...toggles };
  return {
    flips,
    uiEvents,
    state,
    readStructuralToggle: (id) => (id in state ? state[id] : null),
    setStructuralToggle: (id, on) => {
      flips.push([id, on]);
      state[id] = on;
      return { changed: true };
    },
    waitFrames: async () => {},
    resetFrameStats: () => {},
    // The live HUD re-arms the profiler as a DIFFERENT owner ~4x/second, and
    // frame-profiler.arm() throws on an owner mismatch. The A/B must therefore
    // take the UI down for its own duration — and put it back even on a throw.
    hideLiveUi: () => uiEvents.push('hide'),
    restoreLiveUi: () => uiEvents.push('restore'),
    armProfiler: () => {
      if (blockIndex === throwOnBlock) throw new Error('arm exploded');
    },
    disarmProfiler: () => {},
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
  // LIVE RUN: ordering, restore, and refusal
  // ======================================================================
  return (async () => {
    {
      const h = fakeHarness({ toggles: { earlyZComposition: true } });
      const r = await runStructuralAB(h, { toggleIds: ['earlyZComposition'], measureFrames: 10 });
      ok('a live A/B reports that it ran', r.ran === true);
      ok('...it flipped on, off, on, then restored', h.flips.map(([, v]) => (v ? 1 : 0)).join('') === '1011');
      ok('...leaving the viewer in the state it found it', h.state.earlyZComposition === true);
      ok('...and it says the camera was parked, not routing', r.cameraNote.includes('PARKED'));
      ok('one result per toggle', r.toggles.length === 1);
      ok('...carrying the live state it started from', r.toggles[0].liveState === true);
      // Without this the live perf HUD re-arms the profiler as owner 'hud'
      // mid-block and frame-profiler.arm() throws on the mismatch.
      ok('...having taken the live UI down for its duration', h.uiEvents.join(',') === 'hide,restore');
    }

    // Restore is in a `finally`. This is the block that matters most: a throw
    // must not strand the renderer in the OFF state.
    {
      const h = fakeHarness({ toggles: { earlyZComposition: true }, throwOnBlock: 1 });
      let threw = false;
      try {
        await runStructuralAB(h, { toggleIds: ['earlyZComposition'], measureFrames: 10 });
      } catch {
        threw = true;
      }
      ok('a throw mid-A/B propagates rather than being swallowed', threw === true);
      ok('...but the toggle is STILL restored to what it was', h.state.earlyZComposition === true);
      ok('...with the restore as the final flip', h.flips[h.flips.length - 1][1] === true);
      ok('...and the debug UI comes back even on the throw path', h.uiEvents.join(',') === 'hide,restore');
    }

    // A viewer that starts with the toggle OFF must be restored to OFF.
    {
      const h = fakeHarness({ toggles: { earlyZComposition: false } });
      await runStructuralAB(h, { toggleIds: ['earlyZComposition'], measureFrames: 10 });
      ok('an originally-OFF toggle is restored to OFF, not to the default', h.state.earlyZComposition === false);
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
  })();
}
