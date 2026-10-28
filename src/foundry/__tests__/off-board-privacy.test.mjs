/**
 * Node verification for foundry/off-board-privacy.js — the Table's privacy rule
 * for tokens on the velvet — and that `collectTokens` honours it.
 *
 * The author, 2026-10-27: *"Players should never have vision of what a GM has
 * placed in this area but can see their own tokens if they have ownership."*
 */
import { isOffBoardPoint, hideOffBoardToken, isTokenHiddenOffBoard } from '../off-board-privacy.js';
import { collectTokens } from '../scene-tokens.js';

// A 4000×3000 board at (1000, 500) inside its padding; grid 100.
const sceneRect = { x: 1000, y: 500, width: 4000, height: 3000 };
const mk = (id, extra = {}) => ({
  id,
  name: `Token ${id}`,
  x: 2000,
  y: 1500,
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
  isOwner: false,
  texture: { src: `${id}.webp`, tint: null },
  occludable: { radius: 0 },
  ...extra,
});

export function run(t) {
  const { ok } = t;

  // ---- where is "off the board"? -----------------------------------------
  ok('inside the scene rect is on the board', isOffBoardPoint(3000, 2000, sceneRect) === false);
  ok('left of the rect is on the velvet', isOffBoardPoint(500, 2000, sceneRect) === true);
  ok('above the rect is on the velvet', isOffBoardPoint(3000, 100, sceneRect) === true);
  ok('right of the rect is on the velvet', isOffBoardPoint(5200, 2000, sceneRect) === true);
  ok('below the rect is on the velvet', isOffBoardPoint(3000, 3600, sceneRect) === true);
  ok('no scene rect ⇒ nothing is off the board', isOffBoardPoint(0, 0, null) === false);

  // ---- the rule ------------------------------------------------------------
  const base = { privateTable: true, offBoard: true, isGM: false, isOwner: false };
  ok("⭐ a player never sees the GM's token on the table", hideOffBoardToken(base) === true);
  ok('⭐ a player sees their own token on the table', hideOffBoardToken({ ...base, isOwner: true }) === false);
  ok('the GM sees everything', hideOffBoardToken({ ...base, isGM: true }) === false);
  ok('on the board the rule does nothing', hideOffBoardToken({ ...base, offBoard: false }) === false);
  ok('a public table hides nothing', hideOffBoardToken({ ...base, privateTable: false }) === false);

  // ---- from a document -----------------------------------------------------
  const opts = { sceneRect, gridSize: 100, privateTable: true, isGM: false };
  ok(
    'a token centred on the velvet is hidden from a non-owner',
    isTokenHiddenOffBoard(mk('a', { x: 300, y: 1500 }), opts)
  );
  ok('…not from its owner', !isTokenHiddenOffBoard(mk('a', { x: 300, y: 1500, isOwner: true }), opts));
  ok('a token on the board is never hidden by this rule', !isTokenHiddenOffBoard(mk('a'), opts));
  // The centre decides: a 1×1 whose top-left is 40 px outside the edge has its centre inside.
  ok('the token centre decides, not its corner', !isTokenHiddenOffBoard(mk('a', { x: 960, y: 1500 }), opts));
  ok('…and a big token mostly outside is outside', isTokenHiddenOffBoard(mk('a', { x: 600, y: 1500, width: 4 }), opts));
  ok('the GM is never subject to it', !isTokenHiddenOffBoard(mk('a', { x: 300 }), { ...opts, isGM: true }));

  // ---- through collectTokens -----------------------------------------------
  const scene = {
    grid: { size: 100 },
    tokens: [
      mk('board'),
      mk('gm-on-table', { x: 300, y: 1500 }),
      mk('mine-on-table', { x: 300, y: 2000, isOwner: true }),
    ],
  };
  const common = { visibleLevelIds: ['ground'], knownLevelIds: ['ground'], viewedLevelId: 'ground' };
  const ids = (r) => r.items.map((i) => i.id).sort();
  const asPlayer = collectTokens(scene, { ...common, isGM: false, offBoard: { sceneRect, privateTable: true } });
  ok(
    "⭐ a player's draw list has the board token and their own, not the GM's",
    JSON.stringify(ids(asPlayer)) === JSON.stringify(['token:board', 'token:mine-on-table'])
  );
  ok(
    'the dropped one is reported with its reason',
    asPlayer.skipped.some((s) => s.id === 'gm-on-table' && /private Table/.test(s.reason))
  );
  const asGm = collectTokens(scene, { ...common, isGM: true, offBoard: { sceneRect, privateTable: true } });
  ok('the GM draws all three', asGm.items.length === 3);
  const publicTable = collectTokens(scene, { ...common, isGM: false, offBoard: { sceneRect, privateTable: false } });
  ok('a public table draws all three for a player', publicTable.items.length === 3);
  const noTable = collectTokens(scene, { ...common, isGM: false });
  ok('no Table (no offBoard option) changes nothing', noTable.items.length === 3);
}
