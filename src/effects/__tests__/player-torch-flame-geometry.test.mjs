/**
 * Node verification for effects/player-torch-flame-geometry.js. All pure —
 * no THREE, no Foundry.
 */
import {
  buildPlayerTorchFlameAnchors,
  computeTorchEmberArrays,
  PLAYER_TORCH_FLAME_SIZE_PX,
} from '../player-torch-flame-geometry.js';

const ALLOW_TORCH = { modes: { torch: true, flashlight: true } };
const DISALLOW_TORCH = { modes: { torch: false, flashlight: true } };

export function run(t) {
  const { ok } = t;

  // ======================================================================
  // buildPlayerTorchFlameAnchors
  // ======================================================================
  {
    const snaps = [
      { tokenId: 'a', x: 10, y: 20, mode: 'torch' },
      { tokenId: 'b', x: 30, y: 40, mode: 'flashlight' }, // filtered — not a torch
      { tokenId: 'c', x: 50, y: 60, mode: null }, // filtered — carries nothing
      { tokenId: 'd', x: NaN, y: 0, mode: 'torch' }, // filtered — non-finite position
    ];
    const out = buildPlayerTorchFlameAnchors(snaps, ALLOW_TORCH);
    ok('only the one real, allowed torch produces an anchor', out.length === 1);
    ok('the anchor carries the token position', out[0].x === 10 && out[0].y === 20);
    ok('the anchor carries the token id', out[0].id === 'a');
  }
  {
    // The flame rides the light: wherever the bearer holds the torch out to.
    const out = buildPlayerTorchFlameAnchors(
      [{ tokenId: 'a', x: 100, y: 200, mode: 'torch', offsetX: 30, offsetY: -40 }],
      ALLOW_TORCH
    );
    ok('a held torch’s flame is at the held position, not the token', out[0].x === 130 && out[0].y === 160);
    ok(
      'an unusable displacement leaves the flame on the token',
      buildPlayerTorchFlameAnchors([{ tokenId: 'a', x: 7, y: 8, mode: 'torch', offsetX: NaN }], ALLOW_TORCH)[0].x === 7
    );
  }
  {
    // A dying torch's flame (and, below, its embers) reddens.
    const at = (burn01) =>
      buildPlayerTorchFlameAnchors([{ tokenId: 'a', x: 1, y: 2, mode: 'torch', burn01 }], ALLOW_TORCH);
    ok('a full-burn flame keeps the default colour', at(1)[0].params === undefined);
    ok('a merely dim flame keeps its colour too', at(0.8)[0].params.useCustomColor === undefined);
    const dying = at(0.1)[0];
    ok(
      'a dying flame takes a custom colour…',
      dying.params.useCustomColor === true && /^#[0-9a-f]{6}$/.test(dying.params.customColor)
    );
    ok('…redder than amber (less green than #ffaa00)', parseInt(dying.params.customColor.slice(3, 5), 16) < 0xaa);
    ok(
      'the anchor carries its burn so the viewer can tell it changed',
      dying.burn01 === 0.1 && at(1)[0].burn01 === undefined
    );

    const arrays = computeTorchEmberArrays(
      [
        { x: 0, y: 0, id: 'amber' },
        { x: 0, y: 0, id: 'coal', params: { useCustomColor: true, customColor: '#c7301a' } },
      ],
      { emberCount: 2, sizePx: 10, colorHex: '#ffb347' }
    );
    const colorOf = (quad) => [arrays.colors[quad * 12], arrays.colors[quad * 12 + 1], arrays.colors[quad * 12 + 2]];
    ok(
      'embers default to the batch colour',
      Math.abs(colorOf(0)[0] - 1) < 1e-6 && Math.abs(colorOf(0)[1] - 0xb3 / 255) < 1e-6
    );
    ok(
      '…an anchor’s custom colour reddens only its own embers',
      Math.abs(colorOf(2)[1] - 0x30 / 255) < 1e-6 &&
        Math.abs(colorOf(3)[1] - 0x30 / 255) < 1e-6 &&
        Math.abs(colorOf(1)[1] - 0xb3 / 255) < 1e-6
    );
  }
  {
    // A torch that gutters: a smaller flame, then none.
    const at = (burn01) =>
      buildPlayerTorchFlameAnchors([{ tokenId: 'a', x: 1, y: 2, mode: 'torch', burn01 }], ALLOW_TORCH);
    ok(
      'a full-burn torch has the default flame (no size override)',
      at(1)[0].params === undefined && at(undefined)[0].params === undefined
    );
    const half = at(0.5)[0];
    ok(
      'a guttering torch has a smaller flame, by the same per-anchor size a candle uses',
      half.params.useCustomSize === true &&
        half.params.customSizePx < PLAYER_TORCH_FLAME_SIZE_PX &&
        half.params.customSizePx > PLAYER_TORCH_FLAME_SIZE_PX * 0.3
    );
    ok('a nearly-out flame is small but still there', at(0.05)[0].params.customSizePx > 0);
    ok('an out torch has no flame at all', at(0).length === 0 && at(0.01).length === 0);
    ok('the flame goes out at exactly the burn the light does', at(0.031).length === 1 && at(0.029).length === 0);
  }
  ok(
    'the GM disallowing torch on this scene produces zero anchors, even for a real torch token',
    buildPlayerTorchFlameAnchors([{ tokenId: 'x', x: 0, y: 0, mode: 'torch' }], DISALLOW_TORCH).length === 0
  );
  ok('a non-array input is total, not a throw', buildPlayerTorchFlameAnchors(null, ALLOW_TORCH).length === 0);
  ok(
    'an empty permissions object allows nothing (fail-closed)',
    buildPlayerTorchFlameAnchors([{ tokenId: 'x', x: 0, y: 0, mode: 'torch' }], {}).length === 0
  );

  // ======================================================================
  // computeTorchEmberArrays
  // ======================================================================
  {
    const anchors = [
      { x: 100, y: 200, id: 'tokA' },
      { x: 300, y: 400, id: 'tokB' },
    ];
    const out = computeTorchEmberArrays(anchors, { emberCount: 5, sizePx: 110 });
    ok('quadCount is emberCount * anchor count', out.quadCount === 10);
    ok('positions array is sized for exactly quadCount quads', out.positions.length === 10 * 4 * 3);
    ok(
      'every quad is centred on its OWN anchor, not the other one',
      (() => {
        // The first 5 quads belong to tokA (100,200); verify their bounding
        // box is centred there, not at tokB's position.
        let sumX = 0;
        let sumY = 0;
        for (let q = 0; q < 5; q++) {
          const p = q * 12;
          sumX += out.positions[p + 0] + out.positions[p + 3] + out.positions[p + 6] + out.positions[p + 9];
          sumY += out.positions[p + 1] + out.positions[p + 4] + out.positions[p + 7] + out.positions[p + 10];
        }
        const avgX = sumX / (5 * 4);
        const avgY = sumY / (5 * 4);
        return Math.abs(avgX - 100) < 1e-6 && Math.abs(avgY - 200) < 1e-6;
      })()
    );
  }
  {
    // Determinism — the same anchor id + ember index always yields the same
    // seed (so a re-run/rebuild never visibly resets an ember's phase).
    const a = computeTorchEmberArrays([{ x: 0, y: 0, id: 'stable' }], { emberCount: 3, sizePx: 20 });
    const b = computeTorchEmberArrays([{ x: 0, y: 0, id: 'stable' }], { emberCount: 3, sizePx: 20 });
    ok(
      'seeds are deterministic across separate calls with the same input',
      (() => {
        for (let i = 0; i < a.seeds.length; i++) {
          if (a.seeds[i] !== b.seeds[i]) return false;
        }
        return true;
      })()
    );
  }
  {
    // Independence — each ember within one torch gets its OWN seed (so they
    // don't all rise in perfect lockstep).
    const out = computeTorchEmberArrays([{ x: 0, y: 0, id: 'tok' }], { emberCount: 4, sizePx: 20 });
    const seedsByQuad = [0, 1, 2, 3].map((q) => out.seeds[q * 4]); // one vertex per quad is enough
    const distinct = new Set(seedsByQuad.map((s) => s.toFixed(6)));
    ok('the embers within one torch have at least two distinct phases', distinct.size >= 2);
  }
  {
    // Independence across DIFFERENT torches — two tokens must not share a
    // phase just because they happen to carry the same ember index.
    const outA = computeTorchEmberArrays([{ x: 0, y: 0, id: 'alpha' }], { emberCount: 1, sizePx: 20 });
    const outB = computeTorchEmberArrays([{ x: 0, y: 0, id: 'beta' }], { emberCount: 1, sizePx: 20 });
    ok('two different tokens desync even at the same ember index', outA.seeds[0] !== outB.seeds[0]);
  }
  ok(
    'emberCount 0 produces zero quads, not a throw',
    computeTorchEmberArrays([{ x: 0, y: 0, id: 'x' }], { emberCount: 0, sizePx: 20 }).quadCount === 0
  );
  ok(
    'an empty anchor list produces zero quads',
    computeTorchEmberArrays([], { emberCount: 5, sizePx: 20 }).quadCount === 0
  );
  ok(
    'a non-array anchors input is total, not a throw',
    computeTorchEmberArrays(null, { emberCount: 5, sizePx: 20 }).quadCount === 0
  );
  ok(
    'an anchor with a non-finite position is skipped, not baked as NaN',
    computeTorchEmberArrays([{ x: NaN, y: 0, id: 'x' }], { emberCount: 5, sizePx: 20 }).quadCount === 0
  );
}
