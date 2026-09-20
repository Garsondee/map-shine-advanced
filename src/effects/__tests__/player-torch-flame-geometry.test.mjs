/**
 * Node verification for effects/player-torch-flame-geometry.js. All pure —
 * no THREE, no Foundry.
 */
import { buildPlayerTorchFlameAnchors, computeTorchEmberArrays } from '../player-torch-flame-geometry.js';

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
