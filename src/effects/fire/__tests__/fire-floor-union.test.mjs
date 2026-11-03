/**
 * fire-floor-union.test.mjs — A FLOOR SEES THE FIRES BELOW IT, UNLESS ART COVERS THEM.
 *
 * Town River Bridge, 2026-11-03: the middle floor's painted fires vanished when the viewer climbed to the roof. The
 * union is what puts them back; its two promises are that open fire shows and that covered fire does not.
 */
import { unionVisibleFireGrid } from '../fire-floor-union.js';
import { extractFiresFromMask } from '../fire-mask.js';

const SPEC = { x: 0, y: 0, width: 200, height: 200, w: 10, h: 10, texelW: 20, texelH: 20 };
const grid = (cells, spec = SPEC) => {
  const data = new Uint8Array(spec.w * spec.h);
  for (const [c, r, v] of cells) data[r * spec.w + c] = v;
  return { spec, data };
};
const blob = (c0, r0, v = 255) => {
  const cells = [];
  for (let r = r0; r < r0 + 3; r++) for (let c = c0; c < c0 + 3; c++) cells.push([c, r, v]);
  return cells;
};

export function run(t) {
  const empty = grid([]);
  const open = grid([]); // nothing above: cover 0

  // A lower floor's open fire shows on a floor with no paint of its own.
  {
    const lower = grid(blob(2, 2));
    const { grid: g, contributors } = unionVisibleFireGrid(empty, [{ fire: lower, cover: open }]);
    t.ok('open lower fire reaches the viewed floor', contributors === 1 && g.data[3 * SPEC.w + 3] === 255);
    t.ok('the union is a new grid, the own grid is untouched', g !== empty && empty.data.every((v) => v === 0));
    t.ok('the fire is still found as a fire by the extractor', extractFiresFromMask(g).length === 1);
  }

  // Art over the fire hides it; half cover dims it.
  {
    const lower = grid(blob(2, 2));
    const covered = grid(blob(2, 2, 255));
    const r = unionVisibleFireGrid(empty, [{ fire: lower, cover: covered }]);
    t.ok('covered lower fire adds nothing', r.contributors === 0 && r.grid === empty);
    const half = unionVisibleFireGrid(empty, [{ fire: lower, cover: grid(blob(2, 2, 128)) }]);
    t.ok('half-covered fire is dimmed, not dropped', half.grid.data[3 * SPEC.w + 3] === 127);
  }

  // The viewed floor's own paint is never dimmed, and the stronger of the two wins.
  {
    const own = grid(blob(6, 6));
    const lower = grid(blob(2, 2, 100));
    const { grid: g } = unionVisibleFireGrid(own, [{ fire: lower, cover: open }]);
    t.ok('own paint survives untouched', g.data[7 * SPEC.w + 7] === 255);
    t.ok('lower paint is added beside it', g.data[3 * SPEC.w + 3] === 100);
    const both = grid(blob(2, 2, 40));
    const m = unionVisibleFireGrid(both, [{ fire: lower, cover: open }]);
    t.ok('where both paint, the brighter wins', m.grid.data[3 * SPEC.w + 3] === 100);
  }

  // Several floors below all contribute.
  {
    const a = grid(blob(0, 0));
    const b = grid(blob(6, 6));
    const { grid: g, contributors } = unionVisibleFireGrid(empty, [
      { fire: a, cover: open },
      { fire: b, cover: open },
    ]);
    t.ok('two lower floors both contribute', contributors === 2 && g.data[1 * SPEC.w + 1] === 255 && g.data[7 * SPEC.w + 7] === 255);
  }

  // Nothing to add keeps the caller's grid object, so identity-keyed caches hold.
  {
    t.ok('no lower floors returns the own grid itself', unionVisibleFireGrid(empty, []).grid === empty);
    t.ok('a floor with no fire paint contributes nothing', unionVisibleFireGrid(empty, [{ fire: grid([]), cover: open }]).grid === empty);
    t.ok('missing cover (cannot prove it is in view) contributes nothing', unionVisibleFireGrid(empty, [{ fire: grid(blob(2, 2)), cover: null }]).grid === empty);
    t.ok('missing fire grid is skipped', unionVisibleFireGrid(empty, [{ fire: null, cover: open }]).grid === empty);
    t.ok('null lowers is fine', unionVisibleFireGrid(empty, null).grid === empty);
  }

  // Mismatched grids are never mixed cell for cell.
  {
    const other = { ...SPEC, w: 5, h: 5 };
    const odd = grid(blob(0, 0), other);
    t.ok('a grid at another resolution is skipped', unionVisibleFireGrid(empty, [{ fire: odd, cover: odd }]).grid === empty);
  }

  // No own grid at all: the lower floor still shows.
  {
    const { grid: g } = unionVisibleFireGrid(null, [{ fire: grid(blob(2, 2)), cover: open }]);
    t.ok('works with no own grid', g && g.data[3 * SPEC.w + 3] === 255);
  }
}
