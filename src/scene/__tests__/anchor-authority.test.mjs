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
