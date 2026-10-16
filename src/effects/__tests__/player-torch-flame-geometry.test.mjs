/**
 * Node verification for effects/player-torch-flame-geometry.js (the torch ANCHORS: where a
 * torch's fire burns and how well). All pure — no THREE, no Foundry.
 */
import { buildPlayerTorchFlameAnchors } from '../player-torch-flame-geometry.js';

const ALLOW_TORCH = { modes: { torch: true, flashlight: true } };
const DISALLOW_TORCH = { modes: { torch: false, flashlight: true } };

export function run(t) {
  const { ok } = t;

  {
    const snaps = [
      { tokenId: 'a', x: 10, y: 20, mode: 'torch', aimAngleDeg: 90 },
      { tokenId: 'b', x: 30, y: 40, mode: 'flashlight', aimAngleDeg: 90 }, // filtered — not a torch
      { tokenId: 'c', x: 50, y: 60, mode: null }, // filtered — carries nothing
      { tokenId: 'd', x: NaN, y: 0, mode: 'torch', aimAngleDeg: 90 }, // filtered — non-finite position
      { tokenId: 'e', x: 5, y: 5, mode: 'torch' }, // filtered — nobody is steering it
    ];
    const out = buildPlayerTorchFlameAnchors(snaps, ALLOW_TORCH);
    ok('only the one real, allowed, steered torch produces an anchor', out.length === 1);
    ok('the anchor carries the token position', out[0].x === 10 && out[0].y === 20);
    ok('the anchor carries the token id', out[0].id === 'a');
  }
  {
    // NO AIM IS NO FIRE (2026-10-15) — the same gate the light itself uses.
    ok(
      'a torch nobody is holding out has no fire at all',
      buildPlayerTorchFlameAnchors([{ tokenId: 'a', x: 10, y: 20, mode: 'torch' }], ALLOW_TORCH).length === 0
    );
    ok(
      'and an unusable aim counts as none',
      [null, NaN, '90', Infinity].every(
        (aimAngleDeg) =>
          buildPlayerTorchFlameAnchors([{ tokenId: 'a', x: 10, y: 20, mode: 'torch', aimAngleDeg }], ALLOW_TORCH)
            .length === 0
      )
    );
  }
  {
    // The fire rides the light: wherever the bearer holds the torch out to.
    const out = buildPlayerTorchFlameAnchors(
      [{ tokenId: 'a', x: 100, y: 200, mode: 'torch', aimAngleDeg: 90, offsetX: 30, offsetY: -40 }],
      ALLOW_TORCH
    );
    ok('a held torch’s fire is at the held position, not the token', out[0].x === 130 && out[0].y === 160);
    ok(
      'an unusable displacement leaves the fire on the token',
      buildPlayerTorchFlameAnchors(
        [{ tokenId: 'a', x: 7, y: 8, mode: 'torch', aimAngleDeg: 90, offsetX: NaN }],
        ALLOW_TORCH
      )[0].x === 7
    );
  }
  {
    // A torch that gutters: a smaller, redder fire (the render reads burn01), then none.
    const at = (burn01) =>
      buildPlayerTorchFlameAnchors([{ tokenId: 'a', x: 1, y: 2, mode: 'torch', aimAngleDeg: 90, burn01 }], ALLOW_TORCH);
    ok(
      'a full-burn torch carries no burn (the fire reads it as 1)',
      at(1)[0].burn01 === undefined && at(undefined)[0].burn01 === undefined
    );
    ok('a guttering torch carries its burn so the viewer can tell it changed', at(0.5)[0].burn01 === 0.5);
    ok('a nearly-out torch is small but still there', at(0.05).length === 1 && at(0.05)[0].burn01 === 0.05);
    ok('an out torch has no fire at all', at(0).length === 0 && at(0.01).length === 0);
    ok('the fire goes out at exactly the burn the light does', at(0.031).length === 1 && at(0.029).length === 0);
  }
  ok(
    'the GM disallowing torch on this scene produces zero anchors, even for a real torch token',
    buildPlayerTorchFlameAnchors([{ tokenId: 'x', x: 0, y: 0, mode: 'torch', aimAngleDeg: 90 }], DISALLOW_TORCH)
      .length === 0
  );
  ok('a non-array input is total, not a throw', buildPlayerTorchFlameAnchors(null, ALLOW_TORCH).length === 0);
  ok(
    'an empty permissions object allows nothing (fail-closed)',
    buildPlayerTorchFlameAnchors([{ tokenId: 'x', x: 0, y: 0, mode: 'torch', aimAngleDeg: 90 }], {}).length === 0
  );
}
