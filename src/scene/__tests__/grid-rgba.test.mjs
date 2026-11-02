/**
 * Node verification for scene/grid-rgba.js — the one-time RGBA expansion that
 * floor PREPARE runs off screen so the commit frame does not (loading audit P-06).
 *
 * What is defended: the expansion is byte-exact (R=G=B=value, A=255, fallback for
 * a short source), it is cached against the source array's IDENTITY, and a
 * different array — a re-derived grid — can never be served a stale expansion.
 */
import { expandGridToRgba, getGridRgbaStats } from '../grid-rgba.js';

export function run(t) {
  const { ok } = t;

  const grid = Uint8Array.from([0, 10, 200, 255]);
  const rgba = expandGridToRgba(grid, 2, 2, 7);
  ok('output is w*h*4 bytes', rgba.length === 16);
  ok(
    'each cell is replicated into R, G, B with alpha 255',
    [0, 1, 2, 3].every(
      (c) =>
        rgba[c * 4] === grid[c] && rgba[c * 4 + 1] === grid[c] && rgba[c * 4 + 2] === grid[c] && rgba[c * 4 + 3] === 255
    )
  );

  const before = getGridRgbaStats();
  const again = expandGridToRgba(grid, 2, 2, 7);
  const after = getGridRgbaStats();
  ok('the same array, same shape: the SAME bytes come back (a hit)', again === rgba && after.hits === before.hits + 1);

  // A re-derived grid is a different array: never served a stale expansion.
  const rederived = Uint8Array.from([0, 10, 200, 255]);
  const fresh = expandGridToRgba(rederived, 2, 2, 7);
  ok('a different array with equal contents is a miss (new bytes)', fresh !== rgba);
  ok(
    '…with equal values',
    fresh.every((v, i) => v === rgba[i])
  );

  // Edit-in-place keeps the identity, so the cache cannot see it. That is the
  // contract: the mask authority REPLACES products rather than mutating them.
  // (Stated here so nobody "fixes" the cache by hashing contents on the hot path.)
  ok('the cache is keyed by identity, not content', expandGridToRgba(grid, 2, 2, 7) === rgba);

  // Shape or fallback differing for the same array => a miss, not a wrong answer.
  const reshaped = expandGridToRgba(grid, 4, 1, 7);
  ok('same array, different shape => re-expanded', reshaped !== rgba && reshaped.length === 16);
  const otherFallback = expandGridToRgba(Uint8Array.from([5]), 2, 1, 99);
  ok(
    'a short source takes the caller’s fallback byte for the missing cell',
    otherFallback[4] === 99 && otherFallback[0] === 5
  );
  const fb255 = expandGridToRgba(Uint8Array.from([5]), 2, 1, 255);
  ok('…and each caller keeps ITS fallback (outdoors 255 vs fire 0)', fb255[4] === 255);

  // Plain arrays work too (the authority may serve either).
  const plain = expandGridToRgba([1, 2, 3, 4], 2, 2, 0);
  ok('a plain array expands the same way', plain[8] === 3 && plain[15] === 255);

  // The 32-bit store path (frame-rate round, 2026-11-02) must equal the plain byte loop exactly: every byte value,
  // then a random grid with a short tail that falls back.
  const reference = (data, w, h, fb) => {
    const out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const v = data[i] ?? fb;
      out.set([v, v, v, 255], i * 4);
    }
    return out;
  };
  const every = Uint8Array.from({ length: 256 }, (_, i) => i);
  const e1 = expandGridToRgba(every, 16, 16, 0);
  ok('all 256 byte values expand exactly as the byte loop does', reference(every, 16, 16, 0).every((v, i) => v === e1[i]));
  let s = 12345;
  const rand = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 24);
  const big = Uint8Array.from({ length: 300 * 200 - 37 }, rand);
  const e2 = expandGridToRgba(big, 300, 200, 131);
  ok('a random 300x200 grid with a short tail matches the byte loop', reference(big, 300, 200, 131).every((v, i) => v === e2[i]));
}
