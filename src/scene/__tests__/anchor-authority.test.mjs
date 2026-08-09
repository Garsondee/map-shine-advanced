/**
 * anchor-authority.test.mjs — the authority validates on the way in (no repair
 * shop), serves per effect + floor, and reports what it dropped. These are the
 * invariants that keep a bad anchor from ever being stored or served.
 */
import { createAnchorAuthority, mergeAnchorSources, nearestAnchor } from '../anchor-authority.js';

const quietLog = { warn() {}, error() {}, info() {} };

export function run(t) {
  const auth = createAnchorAuthority({ log: quietLog });

  // --- a clean reset serves what it was given -----------------------------
  auth.reset({
    sceneKey: 'S1',
    anchors: [
      { id: 'a', kind: 'candleFlame', x: 100, y: 200, provenance: 'importedFromV2' },
      { id: 'b', kind: 'candleFlame', x: 300, y: 400, params: { intensity: 0.5 } },
    ],
  });
  let served = auth.anchorsForEffect('candleFlame');
  t.ok('both candles served', served.length === 2);
  t.ok('positions preserved', served.find((a) => a.id === 'a')?.x === 100);
  t.ok('per-anchor intensity preserved', served.find((a) => a.id === 'b')?.params.intensity === 0.5);
  t.ok('absent intensity gets the catalog default (1)', served.find((a) => a.id === 'a')?.params.intensity === 1);
  t.ok('provenance is carried', served.find((a) => a.id === 'a')?.provenance === 'importedFromV2');
  t.ok('an author anchor defaults to authored provenance', served.find((a) => a.id === 'b')?.provenance === 'authored');
  t.ok('an unknown effect serves nothing', auth.anchorsForEffect('ghost').length === 0);

  // --- validate-at-write: bad candidates are dropped AND reported ---------
  auth.reset({
    sceneKey: 'S2',
    anchors: [
      { id: 'ok', kind: 'candleFlame', x: 10, y: 20 },
      { id: 'nokind', kind: 'dragonFire', x: 1, y: 1 },
      { id: 'nan', kind: 'candleFlame', x: 'left', y: 5 },
      { kind: 'candleFlame', x: 1, y: 1 }, // no id
    ],
  });
  served = auth.anchorsForEffect('candleFlame');
  t.ok('only the valid anchor is served', served.length === 1 && served[0].id === 'ok');
  const report = auth.getReport();
  t.ok('the three bad candidates are counted as rejected', report.counters.rejected >= 3);
  t.ok(
    'an unknown kind is named in the reject log',
    report.rejected.some((r) => String(r.reason).includes('dragonFire'))
  );
  t.ok(
    'a non-finite position is named',
    report.rejected.some((r) => String(r.reason).includes('non-finite'))
  );
  t.ok(
    'a missing id is named',
    report.rejected.some((r) => String(r.reason).includes('id'))
  );

  // --- an out-of-range param clamps? no — it is reported, default kept ----
  auth.reset({ sceneKey: 'S3', anchors: [{ id: 'hot', kind: 'candleFlame', x: 0, y: 0, params: { intensity: 9 } }] });
  const hot = auth.anchorsForEffect('candleFlame')[0];
  // hydrateParams CLAMPS out-of-range numbers on the write path (params-schema.js)
  t.ok('an over-range intensity is clamped to the max (1), not dropped', hot.params.intensity === 1);

  // --- enabled:false is stored but not served ------------------------------
  auth.reset({
    sceneKey: 'S4',
    anchors: [
      { id: 'on', kind: 'candleFlame', x: 0, y: 0 },
      { id: 'off', kind: 'candleFlame', x: 0, y: 0, enabled: false },
    ],
  });
  t.ok('a disabled candle is not served', auth.anchorsForEffect('candleFlame').length === 1);
  t.ok('but it is still counted in the report', auth.getReport().served === 2);

  // --- floor binding: locked filters by elevation, all-levels never does --
  auth.reset({
    sceneKey: 'S5',
    anchors: [
      { id: 'ground', kind: 'candleFlame', x: 0, y: 0, floorBinding: { mode: 'locked', bottom: 0, top: 10 } },
      { id: 'tower', kind: 'candleFlame', x: 0, y: 0, floorBinding: { mode: 'locked', bottom: 100, top: 200 } },
      { id: 'everywhere', kind: 'candleFlame', x: 0, y: 0, floorBinding: { mode: 'all-levels' } },
    ],
  });
  t.ok('no floor context serves all (including locked)', auth.anchorsForEffect('candleFlame').length === 3);
  const atGround = auth.anchorsForEffect('candleFlame', { elevation: 5 }).map((a) => a.id);
  t.ok(
    'at elevation 5: ground + all-levels, not tower',
    atGround.includes('ground') && atGround.includes('everywhere') && !atGround.includes('tower')
  );
  const atTower = auth.anchorsForEffect('candleFlame', { elevation: 150 }).map((a) => a.id);
  t.ok(
    'at elevation 150: tower + all-levels, not ground',
    atTower.includes('tower') && atTower.includes('everywhere') && !atTower.includes('ground')
  );

  // ==========================================================================
  // CROSS-FLOOR VISIBILITY (`floorVisibility`) — the fix for "candles attached
  // to a ground-floor element stop rendering their light or shape the moment I
  // move up a floor" (author, 2026-08-01), where a hole in the upper floor
  // should have exposed them.
  //
  // The floor context's `elevation` is the MIDPOINT of the floor being viewed
  // (boot.js#updateActiveFloorContext), so "standing on the floor above a 0..20
  // ground floor" arrives here as an elevation well past that band's top.
  // ==========================================================================
  {
    const band = { mode: 'locked', bottom: 0, top: 20 };
    auth.reset({
      sceneKey: 'S5b',
      anchors: [
        { id: 'default', kind: 'candleFlame', x: 0, y: 0, floorBinding: band },
        {
          id: 'above',
          kind: 'candleFlame',
          x: 0,
          y: 0,
          floorBinding: band,
          params: { floorVisibility: 'own-and-above' },
        },
        {
          id: 'always',
          kind: 'candleFlame',
          x: 0,
          y: 0,
          floorBinding: band,
          params: { floorVisibility: 'all-floors' },
        },
      ],
    });

    t.ok(
      'the param defaults to own-floor, so an untouched candle is unchanged',
      auth.anchorsForEffect('candleFlame').find((a) => a.id === 'default')?.params.floorVisibility === 'own-floor'
    );

    // ON its own floor every setting shows — the feature may only ever WIDEN.
    const onOwnFloor = auth.anchorsForEffect('candleFlame', { elevation: 10 }).map((a) => a.id);
    t.ok('on its own floor all three are served regardless of setting', onOwnFloor.length === 3);

    // THE REPORTED CASE: viewing from the floor above.
    const fromAbove = auth.anchorsForEffect('candleFlame', { elevation: 30 }).map((a) => a.id);
    t.ok(
      'from the floor ABOVE, a default candle still hides (today’s behaviour, deliberately kept)',
      !fromAbove.includes('default')
    );
    t.ok('from the floor ABOVE, an "own and above" candle is served — the bug, fixed', fromAbove.includes('above'));
    t.ok('from the floor ABOVE, an "all floors" candle is served', fromAbove.includes('always'));

    // BELOW the band stays hidden even for 'own-and-above': you cannot see a
    // candle on the floor above through its own ceiling.
    const fromBelow = auth.anchorsForEffect('candleFlame', { elevation: -50 }).map((a) => a.id);
    t.ok('from BELOW, "own and above" stays hidden — it widens upward only', !fromBelow.includes('above'));
    t.ok('from BELOW, "all floors" is still served', fromBelow.includes('always'));

    // An unrecognised value must degrade to the safe, pre-existing behaviour
    // rather than silently becoming "visible everywhere".
    auth.reset({
      sceneKey: 'S5c',
      anchors: [
        { id: 'junk', kind: 'candleFlame', x: 0, y: 0, floorBinding: band, params: { floorVisibility: 'wat' } },
      ],
    });
    t.ok(
      'an invalid floorVisibility falls back to the default and does NOT leak the candle across floors',
      auth.anchorsForEffect('candleFlame', { elevation: 30 }).length === 0
    );
  }

  // --- lightning's OWN floorVisibility (2026-08-05, ROUND 3) ----------------
  // Lightning hit the SAME "vanishes from the floor above" bug candle did
  // (author report), and got the identical param — but with a DIFFERENT
  // default than candle's 'own-floor'. The FIRST default tried, 'all-floors',
  // was itself a real bug: `floorMatches` treats 'all-floors' as a full
  // opt-out (returns true BEFORE the `e < binding.bottom` check even runs),
  // so a bolt was offered to the renderer on a floor genuinely BELOW its own
  // — visible looking "up" through solid floors, which this project's own
  // hole-stack model says can never happen (author: "we need to make sure
  // candles, lightning and everything else that is 'ABOVE' the camera's POV
  // isn't visible"). `'own-and-above'` is the correct default: it still
  // reaches every floor ABOVE the bolt (the original ask — "storm visible
  // looking down from anywhere"), but goes through the SAME below-hiding
  // check candle already relies on.
  {
    auth.reset({
      sceneKey: 'S5d',
      anchors: [{ id: 'bolt', kind: 'lightning', x: 0, y: 0, floorBinding: { mode: 'locked', bottom: 0, top: 20 } }],
    });
    t.ok(
      'an untouched bolt defaults to own-and-above — visible on its own floor and looking down from above',
      auth.anchorsForEffect('lightning', { elevation: 10 }).length === 1 &&
        auth.anchorsForEffect('lightning', { elevation: 30 }).length === 1
    );
    t.ok(
      'an untouched bolt is NOT visible from a floor below its own, even at the new default — the exact ROUND 3 regression',
      auth.anchorsForEffect('lightning', { elevation: -10 }).length === 0
    );
  }
  {
    auth.reset({
      sceneKey: 'S5e',
      anchors: [
        {
          id: 'bolt-restricted',
          kind: 'lightning',
          x: 0,
          y: 0,
          floorBinding: { mode: 'locked', bottom: 0, top: 20 },
          params: { floorVisibility: 'own-floor' },
        },
      ],
    });
    t.ok(
      'an author can still opt a bolt back into strict own-floor-only visibility',
      auth.anchorsForEffect('lightning', { elevation: 30 }).length === 0 &&
        auth.anchorsForEffect('lightning', { elevation: 10 }).length === 1
    );
  }
  {
    auth.reset({
      sceneKey: 'S5f',
      anchors: [
        {
          id: 'bolt-unrestricted',
          kind: 'lightning',
          x: 0,
          y: 0,
          floorBinding: { mode: 'locked', bottom: 0, top: 20 },
          params: { floorVisibility: 'all-floors' },
        },
      ],
    });
    t.ok(
      'an author can still explicitly opt a bolt into all-floors (including below) if they genuinely want that look',
      auth.anchorsForEffect('lightning', { elevation: -10 }).length === 1
    );
  }

  // --- reset is wholesale; a fresh scene forgets the last ------------------
  auth.reset({ sceneKey: 'S6', anchors: [] });
  t.ok('a reset to empty serves nothing', auth.anchorsForEffect('candleFlame').length === 0);
  t.ok('the report reflects the new scene key', auth.getReport().sceneKey === 'S6');

  // --- addAnchor: live-authoring counterpart to reset ----------------------
  auth.reset({ sceneKey: 'S7', anchors: [{ id: 'old', kind: 'candleFlame', x: 0, y: 0 }] });
  const added = auth.addAnchor({ id: 'new', kind: 'candleFlame', x: 50, y: 60, params: { intensity: 0.7 } });
  t.ok('addAnchor returns the resolved anchor', added?.id === 'new' && added.params.intensity === 0.7);
  t.ok('addAnchor does not clobber existing anchors', auth.anchorsForEffect('candleFlame').length === 2);
  const rejectedAdd = auth.addAnchor({ id: 'bad', kind: 'candleFlame', x: 'nope', y: 0 });
  t.ok('addAnchor rejects an invalid candidate (returns null)', rejectedAdd === null);
  t.ok('a rejected add is not served', auth.anchorsForEffect('candleFlame').length === 2);
  const upserted = auth.addAnchor({ id: 'new', kind: 'candleFlame', x: 99, y: 99 });
  t.ok('addAnchor upserts by id', upserted.x === 99 && auth.anchorsForEffect('candleFlame').length === 2);

  // --- removeAnchor ----------------------------------------------------------
  t.ok('removeAnchor removes an existing anchor', auth.removeAnchor('new') === true);
  t.ok('it is gone from what is served', auth.anchorsForEffect('candleFlame').length === 1);
  t.ok('removeAnchor on a missing id is a no-op, not an error', auth.removeAnchor('new') === false);

  // --- updateAnchor: whole-result re-validated, params merge partially -----
  auth.reset({
    sceneKey: 'S8',
    anchors: [{ id: 'c1', kind: 'candleFlame', x: 10, y: 10, params: { intensity: 0.5, useCustomColor: false } }],
  });
  const recolored = auth.updateAnchor('c1', { params: { useCustomColor: true, customColor: '#00ff88' } });
  t.ok('updateAnchor applies a partial params patch', recolored?.params.useCustomColor === true);
  t.ok('updateAnchor keeps untouched params', recolored?.params.intensity === 0.5);
  const moved = auth.updateAnchor('c1', { x: 500, y: 600 });
  t.ok('updateAnchor can move a position', moved?.x === 500 && moved?.y === 600);
  t.ok('updateAnchor keeps params it was not asked to touch', moved?.params.customColor === '#00ff88');
  const snuffed = auth.updateAnchor('c1', { enabled: false });
  t.ok('updateAnchor can flip enabled', snuffed?.enabled === false);
  t.ok('a snuffed candle is no longer served', auth.anchorsForEffect('candleFlame').length === 0);
  const rejectedUpdate = auth.updateAnchor('c1', { x: 'nope' });
  t.ok('an invalid update is rejected (returns null)', rejectedUpdate === null);
  t.ok('updateAnchor on a missing id returns null', auth.updateAnchor('ghost', {}) === null);

  // --- mergeAnchorSources: the common case, no authoring yet ---------------
  const v2 = [
    { id: 'v2:g1:0', kind: 'candleFlame', x: 10, y: 20, params: { intensity: 1 } },
    { id: 'v2:g1:1', kind: 'candleFlame', x: 30, y: 40, params: { intensity: 1 } },
  ];
  t.ok('no authored payload -> V2 candidates pass through unchanged', mergeAnchorSources(v2, null).length === 2);
  t.ok('absent overrides/removed -> same', mergeAnchorSources(v2, {}).length === 2);

  // --- editing a V2-imported candle by its stable id ------------------------
  const editedColor = mergeAnchorSources(v2, {
    overrides: { 'v2:g1:0': { params: { useCustomColor: true, customColor: '#22cc66' } } },
  });
  const edited = editedColor.find((a) => a.id === 'v2:g1:0');
  t.ok('an edit to a V2 id layers onto that candidate', edited?.params.useCustomColor === true);
  t.ok('the edit does not lose the candidate’s own position', edited?.x === 10 && edited?.y === 20);
  t.ok('the edit merges params rather than replacing them', edited?.params.intensity === 1);
  t.ok('the untouched sibling candidate is unaffected', editedColor.find((a) => a.id === 'v2:g1:1')?.x === 30);

  // --- removing a V2-imported candle -----------------------------------------
  const afterRemove = mergeAnchorSources(v2, { removed: ['v2:g1:1'] });
  t.ok('a removed V2 id is dropped', afterRemove.length === 1 && afterRemove[0].id === 'v2:g1:0');

  // --- a brand-new authored anchor (id absent from V2 candidates) -----------
  const withNew = mergeAnchorSources(v2, {
    overrides: { 'authored:1': { kind: 'candleFlame', x: 1, y: 2, enabled: true, params: {} } },
  });
  t.ok('a new authored id is appended', withNew.length === 3 && withNew.some((a) => a.id === 'authored:1'));

  // --- removed wins even if also present in overrides (defensive) -----------
  const removedWinsOverOverride = mergeAnchorSources(v2, {
    overrides: { 'v2:g1:0': { params: { intensity: 0.1 } } },
    removed: ['v2:g1:0'],
  });
  t.ok('removed beats an override for the same id', !removedWinsOverOverride.some((a) => a.id === 'v2:g1:0'));

  // --- nearestAnchor: pure hit-testing for the placement UI -----------------
  const anchors = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 100, y: 0 },
    { id: 'c', x: 100, y: 100 },
  ];
  t.ok('finds the closest anchor within range', nearestAnchor(anchors, 5, 5, 50)?.id === 'a');
  t.ok('finds a farther one when it is the closest in range', nearestAnchor(anchors, 90, 10, 50)?.id === 'b');
  t.ok('returns null when nothing is within range', nearestAnchor(anchors, 500, 500, 50) === null);
  t.ok('an unbounded maxDist still picks the true nearest', nearestAnchor(anchors, 60, 40, Infinity)?.id === 'b');
  t.ok('an empty list returns null', nearestAnchor([], 0, 0, 100) === null);
}
