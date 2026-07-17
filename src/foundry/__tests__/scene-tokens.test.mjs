/**
 * Node verification for foundry/scene-tokens.js — Token documents -> keyed draw items.
 *
 * The centrepiece is the "bridge" fixture at the bottom: a token standing UNDER a
 * roof tile, run end-to-end through collection and the real sort law. That stack
 * coming out in the right order is the precondition for testing occlusion at all
 * — which is exactly why tokens come before the mask producer.
 */
import {
  collectTokens,
  tokenFootprint,
  tokenContainsPoint,
  pickTokenAt,
  tokenOnLevel,
  resolveTokenLevel,
  DEFAULT_LEVEL_ID,
  diagnoseTokens,
  DEFAULT_TOKEN_ICON,
} from '../scene-tokens.js';
import { collectTiles, computeItemPlacement } from '../scene-layers.js';
import { sortByLayer, SORT_LAYERS } from '../../scene/layer-order.js';

/** A Token shaped like the real v14 document. width/height are GRID UNITS. */
const mkToken = (id, extra = {}) => ({
  id,
  name: `Token ${id}`,
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  elevation: 0,
  sort: 0,
  alpha: 1,
  rotation: 0,
  lockRotation: false,
  hidden: false,
  disposition: 0,
  level: 'ground',
  texture: { src: `${id}.webp`, tint: null },
  occludable: { radius: 0 },
  ...extra,
});

const mkScene = (tokens, grid = 100) => ({ grid: { size: grid }, tokens });

export function run(t) {
  // ---- footprint: the grid-units trap ------------------------------------
  {
    const f = tokenFootprint(mkToken('a', { x: 300, y: 500, width: 2, height: 3 }), 100);
    // 2x3 GRID SQUARES at grid size 100 == 200x300 PIXELS. If this ever returns
    // 2x3, someone has read width/height as pixels and every token on the board
    // will render sub-pixel and simply look absent.
    t.ok('footprint scales grid units by grid size', f.width === 200 && f.height === 300);
    t.ok('footprint x/y are pixels, used as-is', f.x === 300 && f.y === 500);
    // x/y is the TOP-LEFT of the footprint; the centre is derived. The texture is
    // centre-anchored (anchorX/anchorY 0.5), so the centre is what art hangs off.
    t.ok('footprint centre is derived, not the raw x/y', f.centerX === 400 && f.centerY === 650);
  }
  {
    const f = tokenFootprint(mkToken('a', { width: 0.5, height: 0.5 }), 100);
    t.ok('fractional grid units are legal (schema says positive, not integer)', f.width === 50 && f.height === 50);
  }
  {
    const f = tokenFootprint({}, 100);
    t.ok(
      'a token missing every field defaults to one grid square at the origin',
      f.width === 100 && f.height === 100 && f.x === 0
    );
  }

  // ---- computeItemPlacement TRACKS THE LIVE DOCUMENT, never a snapshot ----
  // (2026-07-17 — "the token stops just short of the final position"). The
  // real bug: `_placement` used to CACHE a footprint computed once at
  // collection time, and `computeItemPlacement` trusted it — so a token's
  // rendered position could go stale the moment the document moved again
  // without a fresh `collectTokens()` call, exactly as it did live (caught by
  // `documentSync.passLog`: four consecutive real passes reading an identical
  // position while the live document had already moved on). This proves the
  // fix structurally: mutate the SAME document object AFTER collection —
  // exactly what a document-hook race looks like — and confirm placement
  // still reflects the CURRENT value, not whatever was true when the item was
  // built.
  {
    const tok = mkToken('a', { x: 100, y: 100, width: 1, height: 1 });
    const scene = mkScene([tok]);
    const { items } = collectTokens(scene, { visibleLevelIds: ['ground'], viewedLevelId: 'ground' });
    const item = items[0];
    const textureSize = { width: 100, height: 100 };

    const before = computeItemPlacement(item, textureSize, {});
    t.ok('placement initially matches the document at collection time', before.x === 150 && before.y === 150);

    // THE DOCUMENT MOVES. No re-collection, no new item — the exact shape of
    // a document-hook race: the item object is unchanged, only the live
    // document it references has moved on.
    tok.x = 900;
    tok.y = 900;

    const after = computeItemPlacement(item, textureSize, {});
    t.ok(
      "a SECOND call, same item object, reflects the document's CURRENT position (900,900 centre 950,950)",
      after.x === 950 && after.y === 950
    );
    t.ok('the two calls actually differ — a test that cannot fail this proves nothing', before.x !== after.x);

    // The item carries NO cached footprint to go stale — this is the
    // structural guarantee, not just today's observed behaviour.
    t.ok('_placement carries no footprint field to cache', !('footprint' in item._placement));
    t.ok('_placement.gridSize is what survives — the input, not a derived snapshot', item._placement.gridSize === 100);
  }

  // ---- hit testing --------------------------------------------------------
  {
    const tok = mkToken('a', { x: 100, y: 100, width: 1, height: 1 });
    t.ok('point inside the footprint hits', tokenContainsPoint(tok, { x: 150, y: 150 }, 100));
    t.ok('top-left corner is inclusive', tokenContainsPoint(tok, { x: 100, y: 100 }, 100));
    // Half-open bounds: the far edge belongs to the NEXT token, so two adjacent
    // tokens never both claim the pixel on their shared edge.
    t.ok('bottom-right edge is exclusive', !tokenContainsPoint(tok, { x: 200, y: 200 }, 100));
    t.ok('point outside misses', !tokenContainsPoint(tok, { x: 99, y: 150 }, 100));
    t.ok(
      'a 2x2 token covers four squares',
      tokenContainsPoint(mkToken('b', { x: 0, y: 0, width: 2, height: 2 }), { x: 199, y: 199 }, 100)
    );
  }

  // ---- picking: topmost means LAST in paint order -------------------------
  {
    const scene = mkScene([mkToken('low', { x: 0, y: 0, sort: 0 }), mkToken('high', { x: 0, y: 0, sort: 5 })]);
    const { items } = collectTokens(scene, { visibleLevelIds: ['ground'] });
    const sorted = sortByLayer(items);
    const hit = pickTokenAt(sorted, { x: 50, y: 50 }, 100);
    // Two tokens exactly on top of each other: the click must select the one the
    // user can SEE, i.e. the last painted. Walking the same sorted list backwards
    // is what makes picking unable to disagree with the screen.
    t.ok('picks the topmost of two stacked tokens', hit?.id === 'token:high');
    t.ok('picks nothing on empty ground', pickTokenAt(sorted, { x: 5000, y: 5000 }, 100) === null);
  }

  // ---- collection ---------------------------------------------------------
  {
    const { items } = collectTokens(mkScene([mkToken('a')]), { visibleLevelIds: ['ground'] });
    t.ok('one token collected', items.length === 1);
    t.ok('id is namespaced', items[0].id === 'token:a');
    t.ok('kind is token', items[0].kind === 'token');
    t.ok('lands at SORT_LAYERS.TOKENS', items[0].key.sortLayer === SORT_LAYERS.TOKENS);
    t.ok('tokens sort above tiles', SORT_LAYERS.TOKENS > SORT_LAYERS.TILES);
  }
  {
    // token.level is a NATIVE v14 level id — the floor comes out of core's own
    // schema, with no tile-flag convention and no third-party module involved.
    // A token's level is SINGULAR (token.level). The tile helper reads a `levels`
    // SET and returns true when it finds none — so reusing it here silently put
    // every token on every floor. This test is why that never shipped.
    t.ok('tokenOnLevel matches the singular level field', tokenOnLevel({ level: 'ground' }, 'ground'));
    t.ok('tokenOnLevel rejects a different level', !tokenOnLevel({ level: 'upper' }, 'ground'));
    t.ok('a token with no level is not silently on every floor', !tokenOnLevel({}, 'ground'));
    const scene = mkScene([mkToken('g', { level: 'ground' }), mkToken('u', { level: 'upper' })]);
    const { items } = collectTokens(scene, { visibleLevelIds: ['ground'] });
    t.ok('a token on an unseen level is not collected', items.length === 1 && items[0].id === 'token:g');
    const both = collectTokens(scene, { visibleLevelIds: ['ground', 'upper'] });
    t.ok('both levels visible collects both', both.items.length === 2);
  }
  {
    const scene = mkScene([mkToken('h', { hidden: true })]);
    t.ok(
      'a hidden token is invisible to a player',
      collectTokens(scene, { visibleLevelIds: ['ground'], isGM: false }).items.length === 0
    );
    const gm = collectTokens(scene, { visibleLevelIds: ['ground'], isGM: true });
    // Foundry dims rather than hides for the GM, exactly as it does a hidden tile.
    t.ok('a hidden token is dimmed to 0.5 for the GM, not hidden', gm.items.length === 1 && gm.items[0].alpha === 0.5);
  }
  {
    const { items } = collectTokens(mkScene([mkToken('n', { texture: { src: null } })]), {
      visibleLevelIds: ['ground'],
    });
    t.ok("a token with no art falls back to Foundry's own default icon", items[0].src === DEFAULT_TOKEN_ICON);
  }
  {
    const { items } = collectTokens(mkScene([mkToken('r', { rotation: 90, lockRotation: true })]), {
      visibleLevelIds: ['ground'],
    });
    t.ok('lockRotation pins rotation to 0 regardless of the stored angle', items[0].rotation === 0);
  }
  {
    const { items } = collectTokens(mkScene([mkToken('o', { occludable: { radius: 3.5 } })]), {
      visibleLevelIds: ['ground'],
    });
    // Carried now so the mask producer is purely additive when it lands.
    t.ok('occludable.radius is carried through for the future mask producer', items[0].occludableRadius === 3.5);
  }
  {
    const { items, skipped } = collectTokens(mkScene([mkToken('z', { width: 0 })]), { visibleLevelIds: ['ground'] });
    t.ok('a degenerate footprint is skipped, not drawn', items.length === 0);
    t.ok('and the skip is reported with its reason', skipped.length === 1 && /GRID units/.test(skipped[0].reason));
  }
  {
    const { items } = collectTokens(mkScene([mkToken('g', { width: 2 })], 64), { visibleLevelIds: ['ground'] });
    t.ok('grid size comes from the scene', items[0].footprint.width === 128);
    const override = collectTokens(mkScene([mkToken('g', { width: 2 })], 64), {
      visibleLevelIds: ['ground'],
      gridSize: 100,
    });
    t.ok('an explicit gridSize overrides the scene', override.items[0].footprint.width === 200);
  }

  // ---- the defaultLevel0000 trap (found LIVE, not in review) --------------
  {
    // Foundry initialises token.level to the literal 'defaultLevel0000'. A scene
    // authored with its own levels has none by that id — so a strict equality
    // test drops the token from EVERY floor. That is exactly what happened live:
    // a token dragged onto a real 3-level scene never appeared and never reached
    // the draw list.
    t.ok('the default id is the real one from the v14 source', DEFAULT_LEVEL_ID === 'defaultLevel0000');
    t.ok(
      'a level the scene actually has is authoritative',
      resolveTokenLevel({ level: 'ground' }, ['ground', 'upper'], 'upper') === 'ground'
    );
    // A token that exists must be visible SOMEWHERE. Dropping a document because
    // its floor is unassigned fails invisibly and reads as a broken renderer.
    t.ok(
      'an unassigned token falls back to the viewed level rather than vanishing',
      resolveTokenLevel({ level: DEFAULT_LEVEL_ID }, ['ground', 'upper'], 'upper') === 'upper'
    );
    // Without the full level list there is no way to tell "unassigned" from "on a
    // hidden floor", so the fallback must NOT fire. Guessing here would drag an
    // upstairs token down onto the viewed floor.
    t.ok(
      'with no known level list, nothing is guessed',
      resolveTokenLevel({ level: DEFAULT_LEVEL_ID }, undefined, 'upper') === DEFAULT_LEVEL_ID
    );
    t.ok(
      'a token on a DELETED level also falls back rather than vanishing',
      resolveTokenLevel({ level: 'gone' }, ['ground'], 'ground') === 'ground'
    );
    t.ok('a token with no level at all falls back', resolveTokenLevel({}, ['ground'], 'ground') === 'ground');

    // End to end: the live repro. Real scene levels, token carrying the default.
    const scene = mkScene([mkToken('dropped', { level: DEFAULT_LEVEL_ID })]);
    const before = collectTokens(scene, { visibleLevelIds: ['cFSJ3W4gsqvGbb2A'] });
    t.ok('THE LIVE BUG reproduced: strict matching drops the dragged token entirely', before.items.length === 0);
    const after = collectTokens(scene, {
      visibleLevelIds: ['cFSJ3W4gsqvGbb2A'],
      knownLevelIds: ['cFSJ3W4gsqvGbb2A', 'WKlcCgaTb1lZZqVy'],
      viewedLevelId: 'cFSJ3W4gsqvGbb2A',
    });
    t.ok("with the scene's real levels known, the dropped token appears on the viewed floor", after.items.length === 1);
    t.ok(
      'and is recorded on the level it resolved to, not the bogus default',
      after.items[0].levelId === 'cFSJ3W4gsqvGbb2A'
    );

    // knownLevelIds must be the FULL list, not just the visible ones: a token on
    // a real but currently-hidden floor is assigned, and must NOT be dragged onto
    // the viewed floor as if it were unassigned.
    const upstairs = mkScene([mkToken('upstairs', { level: 'upper' })]);
    const kept = collectTokens(upstairs, {
      visibleLevelIds: ['ground'],
      knownLevelIds: ['ground', 'upper'],
      viewedLevelId: 'ground',
    });
    t.ok('a token on a real but hidden floor stays there, not pulled to the viewed one', kept.items.length === 0);
  }

  // ---- NO SILENT SKIPS (the bug behind the bug) --------------------------
  {
    // Three tokens vanished while the report said skippedItems: [] -- a bare
    // `continue` dropped them without a word, so collection looked clean while it
    // binned them. A silent skip is worse than a crash: it manufactures the
    // impression that nothing went wrong.
    const scene = mkScene([mkToken('here', { level: 'ground' }), mkToken('upstairs', { level: 'upper' })]);
    const { items, skipped } = collectTokens(scene, {
      visibleLevelIds: ['ground'],
      knownLevelIds: ['ground', 'upper'],
      viewedLevelId: 'ground',
    });
    t.ok('the visible token is collected', items.length === 1);
    t.ok('THE DROPPED TOKEN IS REPORTED, not silently binned', skipped.length === 1);
    t.ok('and the reason names the level it is on', /upper/.test(skipped[0].reason));
    t.ok('and names the visible levels it was tested against', /ground/.test(skipped[0].reason));
    t.ok('and carries the id, so it can be found in Foundry', skipped[0].id === 'upstairs');

    const hidden = collectTokens(mkScene([mkToken('h', { hidden: true })]), {
      visibleLevelIds: ['ground'],
      isGM: false,
    });
    t.ok(
      'a hidden token is reported too, not silently dropped',
      hidden.skipped.length === 1 && /GM/.test(hidden.skipped[0].reason)
    );
  }

  // ---- diagnoseTokens: raw vs resolved vs real ---------------------------
  {
    // The three ids that must be visible side by side: what the token SAYS, what
    // we RESOLVED it to, and what the scene actually HAS. The whole bug class is
    // those disagreeing, and all of them look identical from outside (the token
    // is simply absent) and like a broken renderer.
    const scene = mkScene([
      mkToken('assigned', { level: 'ground' }),
      mkToken('unassigned', { level: DEFAULT_LEVEL_ID }),
      mkToken('upstairs', { level: 'upper' }),
    ]);
    const d = diagnoseTokens(scene, {
      visibleLevelIds: ['ground'],
      knownLevelIds: ['ground', 'upper'],
      viewedLevelId: 'ground',
    });
    t.ok(
      'every token document is reported, including the dropped ones',
      d.tokenDocsFound === 3 && d.tokens.length === 3
    );
    const byId = Object.fromEntries(d.tokens.map((x) => [x.id, x]));
    t.ok('an assigned token reads as real and renders', byId.assigned.levelIsReal && byId.assigned.wouldRender);
    t.ok(
      "Foundry's default id is flagged as such, not as a real level",
      byId.unassigned.levelIsFoundryDefault && !byId.unassigned.levelIsReal
    );
    t.ok(
      'and it resolves onto the viewed floor',
      byId.unassigned.resolvedLevel === 'ground' && byId.unassigned.wouldRender
    );
    t.ok(
      'an upstairs token reads as real but does NOT render here',
      byId.upstairs.levelIsReal && !byId.upstairs.wouldRender
    );
    t.ok(
      'raw and resolved are both reported so a mismatch is visible',
      byId.upstairs.rawLevel === 'upper' && byId.upstairs.resolvedLevel === 'upper'
    );
  }

  // ---- THE BRIDGE: a token under a roof, through the real sort law --------
  {
    // The whole reason tokens come first. A roof tile at elevation 9 and a token
    // on the ground at elevation 0: the roof MUST paint over the token, because
    // "the token is hidden under the roof" is the state occlusion exists to undo.
    // If this order were wrong, any occlusion result would be untestable noise.
    const scene = {
      grid: { size: 100 },
      tokens: [mkToken('hero', { x: 100, y: 100, elevation: 0, level: 'ground' })],
      tiles: [
        {
          id: 'roof',
          elevation: 9,
          sort: 1,
          hidden: false,
          texture: { src: 'roof.webp' },
          occlusion: { modes: [1], alpha: 0 },
          levels: ['ground'],
        },
      ],
    };
    const tiles = collectTiles(scene, { visibleLevelIds: ['ground'] });
    const tokens = collectTokens(scene, { visibleLevelIds: ['ground'] });
    const order = sortByLayer([...tiles.items, ...tokens.items]).map((i) => i.id);
    // Elevation is the FIRST key in the law, so the roof at 9 beats the token at
    // 0 outright — sortLayer never even gets consulted. That is Foundry's rule,
    // and it is why a roof hides a token without anything else being involved.
    t.ok(
      'a roof at elevation 9 paints OVER a token at elevation 0',
      order.indexOf('tile:roof') > order.indexOf('token:hero')
    );

    // Same token, now standing ON the roof's floor. Equal elevation, so the law
    // falls through to sortLayer — where TOKENS (700) beats TILES (500), and the
    // token stands on top of the roof instead of under it.
    const onRoof = { ...scene, tokens: [mkToken('hero', { x: 100, y: 100, elevation: 9, level: 'ground' })] };
    const order2 = sortByLayer([
      ...collectTiles(onRoof, { visibleLevelIds: ['ground'] }).items,
      ...collectTokens(onRoof, { visibleLevelIds: ['ground'] }).items,
    ]).map((i) => i.id);
    t.ok(
      'at EQUAL elevation the token stands on top of the roof (sortLayer breaks the tie)',
      order2.indexOf('token:hero') > order2.indexOf('tile:roof')
    );
  }
}
