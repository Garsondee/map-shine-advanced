/**
 * prism-seams.test.mjs — `getPrismMaskItems`, mythica-machina-press#137.
 *
 * Mirrors `specular-seams.test.mjs`'s own job for `getSpecularMaskItems`, one
 * effect later: prove a Tile-authored `_Prism` mask is discovered, that a
 * hidden/wrong-floor/unresolved-art tile is excluded, and that unwired
 * optional seam inputs fail safe rather than throwing.
 */
import { createPrismSeams } from '../prism-seams.js';

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
    { id: 'tileA', kind: 'tile', visibleOnLevelIds: ['levelA'], hidden: false },
    { id: 'tileB', kind: 'tile', visibleOnLevelIds: ['levelA'], hidden: false }, // no authored mask
    { id: 'tileC', kind: 'tile', visibleOnLevelIds: ['levelB'], hidden: false }, // different floor
    { id: 'tileD', kind: 'tile', visibleOnLevelIds: ['levelA'], hidden: true }, // hidden
    { id: 'tileE', kind: 'tile', visibleOnLevelIds: ['levelA'], hidden: false }, // corners unresolved
    // A level's own background carries a `_Prism` file too, but Prism v1 has
    // no floor-level door at all (this module's own header) — it must never
    // surface here just because it happens to share an id shape with
    // specular's own excluded case.
    { id: 'level:levelA:background', kind: 'levelBackground', levelId: 'levelA', hidden: false },
  ];

  const authoredByItemId = {
    tileA: 'mask://tileA_Prism.webp',
    tileC: 'mask://tileC_Prism.webp',
    tileD: 'mask://tileD_Prism.webp',
    tileE: 'mask://tileE_Prism.webp',
    'level:levelA:background': 'mask://levelA_Prism.webp',
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

  const renderOrderByItemId = { tileA: 6.25 };

  const { getPrismMaskItems } = createPrismSeams({
    maskAuthority: stubMaskAuthority(authoredByItemId),
    getFloors: () => [FLOOR0, FLOOR1],
    getItems: () => items,
    getItemCorners: (item) => cornersByItemId[item.id] ?? null,
    getItemRenderOrder: (item) => renderOrderByItemId[item.id] ?? null,
  });

  const floor0Items = getPrismMaskItems(0);
  ok('exactly one item qualifies on floor 0', floor0Items.length === 1);
  const [only] = floor0Items;
  ok('it is the one genuinely attachable tile', only?.id === 'tileA');
  ok('its url is the discovered file, not fabricated', only?.url === 'mask://tileA_Prism.webp');
  ok('its corners are the item’s own resolved quad', Array.isArray(only?.corners) && only.corners.length === 4);
  ok('its renderOrder is the resolved value', only?.renderOrder === 6.25);

  ok(
    'the level BACKGROUND item never appears here — Prism v1 has no floor-level door at all',
    !floor0Items.some((i) => i.id === 'level:levelA:background')
  );
  ok('a tile with no authored mask is excluded', !floor0Items.some((i) => i.id === 'tileB'));
  ok('a tile authored on a DIFFERENT floor is excluded', !floor0Items.some((i) => i.id === 'tileC'));
  ok('a hidden tile is excluded even with a real mask', !floor0Items.some((i) => i.id === 'tileD'));
  ok(
    'a tile whose art has not resolved a placement yet defers to a later frame, not a crash',
    !floor0Items.some((i) => i.id === 'tileE')
  );

  const floor1Items = getPrismMaskItems(1);
  ok('floor 1’s own tile is found independently of floor 0', floor1Items.length === 1 && floor1Items[0].id === 'tileC');

  ok('an unresolved floor index returns an empty list, never a throw', getPrismMaskItems(99).length === 0);

  // ── UNWIRED SEAM INPUTS FAIL SAFE, NOT LOUD ─────────────────────────────
  const bare = createPrismSeams({ maskAuthority: stubMaskAuthority(authoredByItemId), getFloors: () => [FLOOR0] });
  ok(
    'with no getItems/getItemCorners wired, getPrismMaskItems returns [] rather than throwing',
    bare.getPrismMaskItems(0).length === 0
  );
}
