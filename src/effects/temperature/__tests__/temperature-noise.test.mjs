/**
 * Node verification for effects/temperature/temperature-noise.js — the baked
 * frost / ripple tile: deterministic, seamless, the right channels.
 */
import { buildTemperatureNoiseData, TEMPERATURE_NOISE_SIZE } from '../temperature-noise.js';

export function run(t) {
  const { ok } = t;
  const small = 128;
  const a = buildTemperatureNoiseData(small, 42);
  const b = buildTemperatureNoiseData(small, 42);
  const c = buildTemperatureNoiseData(small, 43);
  ok('RGBA8 at the asked size', a.size === small && a.data.length === small * small * 4);
  ok(
    'deterministic for a seed',
    a.data.every((v, i) => v === b.data[i])
  );
  ok(
    'a different seed is a different tile',
    a.data.some((v, i) => v !== c.data[i])
  );

  const ch = (d, k) => {
    const out = [];
    for (let i = k; i < d.length; i += 4) out.push(d[i]);
    return out;
  };
  const R = ch(a.data, 0);
  const G = ch(a.data, 1);
  const A = ch(a.data, 3);
  const lit = R.filter((v) => v > 100).length / R.length;
  ok('crystals cover part of the tile, not all of it', lit > 0.03 && lit < 0.6);
  const meanG = G.reduce((s, v) => s + v, 0) / G.length;
  ok('the slope channel is centred on flat (128)', Math.abs(meanG - 128) < 4);
  const minA = Math.min(...A);
  const maxA = Math.max(...A);
  ok('the smooth channel has real range', maxA - minA > 80);

  // ⭐ Seamless: the jump across the wrap is no bigger than a jump inside the
  // tile (the smooth channel is the one a seam would show in).
  const at = (x, y) => A[y * small + x];
  let wrapJump = 0;
  let innerJump = 0;
  for (let y = 0; y < small; y++) {
    wrapJump += Math.abs(at(small - 1, y) - at(0, y));
    innerJump += Math.abs(at(small / 2, y) - at(small / 2 - 1, y));
  }
  ok('⭐ tiles without a seam', wrapJump < innerJump * 2 + small);

  const t0 = Date.now();
  buildTemperatureNoiseData();
  const ms = Date.now() - t0;
  ok(`the full ${TEMPERATURE_NOISE_SIZE}² bake stays well under a second (${ms} ms)`, ms < 1000);
}
