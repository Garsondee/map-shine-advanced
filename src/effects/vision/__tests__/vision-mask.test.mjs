/**
 * Node verification for effects/vision/vision-mask.js — slice 2 of "MSA owns
 * vision/fog" (Testament Pillar 11).
 *
 * These are RULES tests, not arithmetic tests. `decideRevealed` is the CPU
 * twin of the shader that will rasterise it, and Law 7 makes this
 * player-facing information gating — so every clause is pinned against the
 * Foundry mechanism it ports, and every "must NOT reveal" case is asserted
 * explicitly rather than implied.
 */
import {
  decideRevealed,
  reconcileVisionMeshPool,
  decideFogGating,
  REVEAL_ILLUMINATION_THRESHOLD,
} from '../vision-mask.js';

/** A lit-daylight pixel, calibrated from the author's own probe (0.933-0.945). */
const DAYLIGHT = 0.94;
/** Deep night / unlit interior, far below the threshold. */
const UNLIT = 0.01;

/** The reported scenario: a token with NO darkvision, standing outdoors at noon. */
const outdoorNoon = (over = {}) => ({
  insideSightPolygon: false, // no darkvision — the exact case the author reported
  insideLightPolygon: true, // Foundry's default unlimited light perception
  illumination: DAYLIGHT,
  ...over,
});

export function run(t) {
  const { ok } = t;

  // ======================================================================
  // THE REPORTED BUG — this is the assertion the whole build exists for
  // ======================================================================
  ok(
    'THE BUG: a token outdoors at noon, far from any point light, IS revealed',
    decideRevealed(outdoorNoon()) === true
  );
  ok(
    'and it is revealed by BRIGHTNESS, not by being near a light — the whole point',
    decideRevealed(outdoorNoon({ distance: 999999 })) === true
  );

  // ======================================================================
  // ⚠️ THE REGRESSION THAT BLACKED OUT THE WHOLE MAP, PINNED
  // ======================================================================
  // The first live build ANDed the sight polygon into the rule:
  //     revealed = insideSight AND (... OR (light AND lit))
  // A token with no darkvision has `sight.range = 0`, and Foundry builds its
  // FOV polygon at `radius: 0` — a degenerate speck the size of the token. So
  // that AND made everything except the token's own square go black, which is
  // exactly what the author saw. The two polygons are UNIONED, never
  // intersected: each is already wall-clipped and already radius-bounded.
  ok(
    'THE REGRESSION: no darkvision (empty sight polygon) still reveals lit ground',
    decideRevealed(outdoorNoon({ insideSightPolygon: false })) === true
  );
  ok(
    'and an empty sight polygon can never veto the light route',
    decideRevealed({ insideSightPolygon: false, insideLightPolygon: true, illumination: DAYLIGHT }) === true
  );

  // ======================================================================
  // BLINDED — Foundry drops a blinded source from its light mask entirely
  // ======================================================================
  ok('a blinded source reveals nothing, even in daylight', decideRevealed(outdoorNoon({ blinded: true })) === false);
  ok(
    'a blinded source reveals nothing even inside its own sight polygon',
    decideRevealed(outdoorNoon({ blinded: true, insideSightPolygon: true })) === false
  );

  // ======================================================================
  // The SIGHT polygon IS illumination-independent — this is what darkvision IS
  // ======================================================================
  ok(
    'darkvision reveals in PITCH DARKNESS inside its own polygon',
    decideRevealed(outdoorNoon({ illumination: 0, insideSightPolygon: true, insideLightPolygon: false })) === true
  );
  ok(
    'outside BOTH polygons nothing is revealed, however bright',
    decideRevealed({ insideSightPolygon: false, insideLightPolygon: false, illumination: 1 }) === false
  );
  ok(
    'a token with no darkvision gets nothing from an unlit pixel',
    decideRevealed(outdoorNoon({ illumination: UNLIT })) === false
  );

  // ======================================================================
  // THE AUTHOR'S STATED IDEAL — dark outdoor areas must BLOCK vision
  // "We don't want to universally reveal everything outdoors."
  // ======================================================================
  ok(
    'a DARK outdoor pixel inside the light polygon is NOT revealed',
    decideRevealed(outdoorNoon({ illumination: UNLIT })) === false
  );
  ok(
    'exactly AT the threshold reveals (inclusive, no dead band at the boundary)',
    decideRevealed(outdoorNoon({ illumination: REVEAL_ILLUMINATION_THRESHOLD })) === true
  );
  ok(
    'a hair BELOW the threshold does not',
    decideRevealed(outdoorNoon({ illumination: REVEAL_ILLUMINATION_THRESHOLD - 1e-6 })) === false
  );
  ok(
    'the threshold sits well below real measured daylight (0.933 was the probe floor)',
    REVEAL_ILLUMINATION_THRESHOLD < 0.933
  );
  ok('and above pure black, so it is not a universal reveal', REVEAL_ILLUMINATION_THRESHOLD > 0);
  ok(
    'darkvision still beats an unlit pixel — the sight route ignores brightness',
    decideRevealed(outdoorNoon({ illumination: UNLIT, insideSightPolygon: true })) === true
  );

  // ======================================================================
  // Foundry already bounds each polygon — we never re-test a radius
  // ======================================================================
  ok(
    'outside the light polygon, brightness alone is not enough',
    decideRevealed(outdoorNoon({ insideLightPolygon: false })) === false
  );
  ok('a NaN illumination reads as unlit, not as lit', decideRevealed(outdoorNoon({ illumination: NaN })) === false);

  // ======================================================================
  // reconcileVisionMeshPool — a pool that only grows is a GPU leak
  // ======================================================================
  {
    const r = reconcileVisionMeshPool([{ sourceId: 'a' }, { sourceId: 'b' }], []);
    ok('an empty pool creates every source', r.create.length === 2 && r.keep.length === 0 && r.drop.length === 0);
  }
  {
    const r = reconcileVisionMeshPool([{ sourceId: 'a' }], ['a', 'b']);
    ok('a source that went away is DROPPED, not leaked', r.drop.length === 1 && r.drop[0] === 'b');
    ok('and the surviving one is kept, not recreated', r.keep.length === 1 && r.create.length === 0);
  }
  {
    const r = reconcileVisionMeshPool([], ['a', 'b']);
    ok('deselecting everything drops the whole pool', r.drop.length === 2 && r.create.length === 0);
  }
  {
    // A duplicate id in one frame must not make two meshes for one source,
    // NOR let the second occurrence mark the first as dropped.
    const r = reconcileVisionMeshPool([{ sourceId: 'a' }, { sourceId: 'a' }], ['a']);
    ok('a duplicated source id is handled once', r.keep.length === 1 && r.create.length === 0 && r.drop.length === 0);
  }
  {
    const r = reconcileVisionMeshPool([{ sourceId: 'a' }, { sourceId: '' }, null], []);
    ok('malformed entries are skipped, never thrown on', r.create.length === 1 && r.create[0] === 'a');
  }
  {
    // Draw order must be stable frame to frame — an unstable order is what
    // made vegetation flicker once already.
    const r = reconcileVisionMeshPool([{ sourceId: 'x' }, { sourceId: 'y' }, { sourceId: 'z' }], ['y']);
    ok('order follows the incoming sources, not pool insertion order', r.create.join(',') === 'x,z');
  }

  // ======================================================================
  // decideFogGating — the fail-CLOSED half is a player-safety rule
  // ======================================================================
  ok(
    'a GM with nothing selected is NOT gated — Foundry does the same',
    decideFogGating({ sourceCount: 0, isGM: true, readFailed: false }).gate === false
  );
  ok(
    'a GM controlling a token IS gated',
    decideFogGating({ sourceCount: 1, isGM: true, readFailed: false }).gate === true
  );
  ok(
    'a PLAYER with no vision source is STILL gated — never a free reveal',
    decideFogGating({ sourceCount: 0, isGM: false, readFailed: false }).gate === true
  );
  ok(
    'A FAILED READ for a player FAILS CLOSED, not open',
    decideFogGating({ sourceCount: 0, isGM: false, readFailed: true }).gate === true
  );
  ok(
    'and the reason says so, rather than reading like a normal quiet frame',
    decideFogGating({ sourceCount: 0, isGM: false, readFailed: true }).reason.includes('FAILED')
  );
  ok(
    'a failed read for a GM still leaves the GM unblinded',
    decideFogGating({ sourceCount: 0, isGM: true, readFailed: true }).gate === false
  );
}
