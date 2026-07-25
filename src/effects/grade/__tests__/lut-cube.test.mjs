/**
 * THE .cube PARSER — proven against a hand-written cube. The red-fastest memory
 * order is the assertion that earns its keep: get it wrong and a LUT looks
 * plausibly-but-subtly off, the worst failure. A tiny 2³ cube is enough to pin
 * every cell.
 */
import { parseCubeLut, identityCubeLut } from '../lut-cube.js';

export function run(t) {
  const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

  // A hand-written 2×2×2 identity-ish cube, red fastest. 8 rows.
  const CUBE = `
# a comment
TITLE "test cube"
LUT_3D_SIZE 2
DOMAIN_MIN 0 0 0
DOMAIN_MAX 1 1 1
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

  {
    const lut = parseCubeLut(CUBE);
    t.ok('size parsed', lut.size === 2);
    t.ok('title parsed', lut.title === 'test cube');
    t.ok('domain defaults present', lut.domainMin[0] === 0 && lut.domainMax[0] === 1);
    t.ok('data is N³·4 RGBA', lut.data.length === 8 * 4);
    t.ok('alpha filled to 1', lut.data[3] === 1 && lut.data[31] === 1);

    // Red fastest: cell index 1 (the SECOND row) is (1,0,0) — red varies first.
    t.ok('cell 0 is black', close(lut.data[0], 0) && close(lut.data[1], 0) && close(lut.data[2], 0));
    t.ok('cell 1 (red-fastest) is (1,0,0)', close(lut.data[4], 1) && close(lut.data[5], 0) && close(lut.data[6], 0));
    // Cell 2 is (0,1,0) — green ticked once red wrapped.
    t.ok('cell 2 is (0,1,0)', close(lut.data[8], 0) && close(lut.data[9], 1) && close(lut.data[10], 0));
    // Last cell is white.
    t.ok('cell 7 is white', close(lut.data[28], 1) && close(lut.data[29], 1) && close(lut.data[30], 1));
  }

  // ---- malformed cubes throw LOUDLY, never half-parse ----------------------
  {
    t.throws?.('empty input throws', () => parseCubeLut(''), 'empty');
    t.throws?.('missing size throws', () => parseCubeLut('0 0 0\n1 1 1\n'), 'LUT_3D_SIZE');
    t.throws?.('wrong row count throws', () => parseCubeLut('LUT_3D_SIZE 2\n0 0 0\n1 1 1\n'), 'needs 8 rows');
    t.throws?.('a 1D LUT is rejected, not mis-parsed as 3D', () => parseCubeLut('LUT_1D_SIZE 16\n'), '1D');
    t.throws?.('a non-numeric data row throws', () => parseCubeLut('LUT_3D_SIZE 2\n0 0 x\n'), 'non-numeric');
    // Fallback for a runner without `throws`.
    if (!t.throws) {
      let threw = false;
      try {
        parseCubeLut('');
      } catch {
        threw = true;
      }
      t.ok('empty input throws (no-throws-helper fallback)', threw);
    }
  }

  // ---- the identity LUT is a genuine no-op layout --------------------------
  {
    const id = identityCubeLut(2);
    t.ok('identity size', id.size === 2);
    t.ok('identity cell 0 is black', id.data[0] === 0 && id.data[1] === 0 && id.data[2] === 0);
    t.ok('identity cell 1 maps red→red', id.data[4] === 1 && id.data[5] === 0);
    t.ok('identity last cell is white', id.data[28] === 1 && id.data[29] === 1 && id.data[30] === 1);
    const id3 = identityCubeLut(3);
    t.ok('a 3³ identity has the right cell count', id3.data.length === 27 * 4);
    // The centre cell of a 3³ identity is mid-grey.
    const c = 13; // (1,1,1) in a 3-cube, index 1 + 1*3 + 1*9 = 13
    t.ok('3³ centre is 0.5 grey', close(id3.data[c * 4], 0.5) && close(id3.data[c * 4 + 1], 0.5));
  }
}
