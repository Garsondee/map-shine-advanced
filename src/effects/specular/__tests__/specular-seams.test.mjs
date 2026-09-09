/**
 * specular-seams.test.mjs — `getSpecularMaskItems`, mythica-machina-press#538.
 *
 * The regression this file exists to catch: `getSpecularMaskUrl` (this same
 * module) is keyed by LEVEL id and cannot see a mask authored on a Tile — the
 * exact bug `fluid-registration.js#createFluidSeams`'s own header already
 * diagnosed and fixed for Fluid, one effect earlier. `getSpecularMaskItems`
 * is Specular's own fix; this proves a Tile-authored mask is discovered where
 * the floor-only door would have missed it, that a floor's OWN level-
 * background item is deliberately excluded (it stays on the existing door,
 * so a floor with `_Specular` painted into its background art is never
 * double-drawn), and that the usual item-population edge cases (hidden,
 * wrong floor, art not yet resolved) are all honoured.
 */
import { createSpecularSeams } from '../specular-seams.js';

/** A stub `maskAuthority` — only `authoredStatusForItem` is exercised here. */
function stubMaskAuthority(authoredByItemId) {
  return {
    authoredStatusForItem(itemId, _kindId) {
      const url = authoredByItemId[itemId];
      return url ? { source: 'authored', url } : { source: 'default', value: 0 };
    },
  };
}

const FLOOR0 = { index: 0, id: 'levelA' };
const FLOOR1 = { index: 1, id: 'levelB' };

export function run(t) {
  const { ok } = t;

  const items = [
    // The floor's OWN background — has a `_Specular` file, but must stay on
    // `getSpecularMaskUrl`'s own door, never appear here too.
    { id: 'level:levelA:background', kind: 'levelBackground', levelId: 'levelA', hidden: false },
    // The tile the floor-only lookup could never see.
    { id: 'tileA', kind: 'tile', visibleOnLevelIds: ['levelA'], hidden: false },
    // A tile on the same floor with no authored mask at all.
    { id: 'tileB', kind: 'tile', visibleOnLevelIds: ['levelA'], hidden: false },
    // A tile with a mask, but on a DIFFERENT floor.
    { id: 'tileC', kind: 'tile', visibleOnLevelIds: ['levelB'], hidden: false },
    // A tile with a mask, on the right floor, but hidden.
    { id: 'tileD', kind: 'tile', visibleOnLevelIds: ['levelA'], hidden: true },
    // A tile with a mask, on the right floor, visible — but its art has not
    // resolved a placement yet (getItemCorners returns null for it).
    { id: 'tileE', kind: 'tile', visibleOnLevelIds: ['levelA'], hidden: false },
  ];

  const authoredByItemId = {
    'level:levelA:background': 'mask://levelA_Specular.webp',
    tileA: 'mask://tileA_Specular.webp',
    tileC: 'mask://tileC_Specular.webp',
    tileD: 'mask://tileD_Specular.webp',
    tileE: 'mask://tileE_Specular.webp',
  };

  const cornersByItemId = {
    tileA: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ],
    tileB: [
      { x: 200, y: 0 },
      { x: 300, y: 0 },
      { x: 300, y: 100 },
      { x: 200, y: 100 },
    ],
    tileC: [
      { x: 400, y: 0 },
      { x: 500, y: 0 },
      { x: 500, y: 100 },
      { x: 400, y: 100 },
    ],
    tileD: [
      { x: 0, y: 200 },
      { x: 100, y: 200 },
      { x: 100, y: 300 },
      { x: 0, y: 300 },
    ],
    // tileE deliberately absent — its corners are not resolved yet.
  };

  const renderOrderByItemId = { tileA: 4.5 };

  const { getSpecularMaskItems } = createSpecularSeams({
    maskAuthority: stubMaskAuthority(authoredByItemId),
    getFloors: () => [FLOOR0, FLOOR1],
    getItems: () => items,
    getItemCorners: (item) => cornersByItemId[item.id] ?? null,
    getItemRenderOrder: (item) => renderOrderByItemId[item.id] ?? null,
  });

  const floor0Items = getSpecularMaskItems(0);
  ok('exactly one item qualifies on floor 0 — only the genuinely-attachable tile', floor0Items.length === 1);
  const [only] = floor0Items;
  ok('it is the tile a floor-only lookup could never see', only?.id === 'tileA');
  ok('its url is the discovered file, not fabricated', only?.url === 'mask://tileA_Specular.webp');
  ok('its corners are the item’s own resolved quad', Array.isArray(only?.corners) && only.corners.length === 4);
  ok('its renderOrder is the resolved value', only?.renderOrder === 4.5);

  ok(
    'the level BACKGROUND item never appears here, even though it has an authored file — ' +
      'it stays on getSpecularMaskUrl’s own door so a floor is never double-drawn',
    !floor0Items.some((i) => i.id === 'level:levelA:background')
  );
  ok('a tile with no authored mask is excluded', !floor0Items.some((i) => i.id === 'tileB'));
  ok('a tile authored on a DIFFERENT floor is excluded', !floor0Items.some((i) => i.id === 'tileC'));
  ok('a hidden tile is excluded even with a real mask', !floor0Items.some((i) => i.id === 'tileD'));
  ok(
    'a tile whose art has not resolved a placement yet defers to a later frame, not a crash',
    !floor0Items.some((i) => i.id === 'tileE')
  );

  const floor1Items = getSpecularMaskItems(1);
  ok('floor 1’s own tile is found independently of floor 0', floor1Items.length === 1 && floor1Items[0].id === 'tileC');

  ok('an unresolved floor index returns an empty list, never a throw', getSpecularMaskItems(99).length === 0);

  // ── UNWIRED SEAM INPUTS FAIL SAFE, NOT LOUD ─────────────────────────────
  // `getItems`/`getItemCorners` are optional constructor args (mirroring
  // `createFluidSeams`'s own shape) — a caller that never wires them (a Node
  // test harness with no viewer behind it) must see an empty, correct
  // answer, not a TypeError calling `undefined()`.
  const bare = createSpecularSeams({ maskAuthority: stubMaskAuthority(authoredByItemId), getFloors: () => [FLOOR0] });
  ok(
    'with no getItems/getItemCorners wired, getSpecularMaskItems returns [] rather than throwing',
    bare.getSpecularMaskItems(0).length === 0
  );
}
