/**
 * water-flow-potential.test.mjs — THE CURRENT FROM WHAT THE MAP IS (2026-11-10, Lab · River): which bodies are open
 * (a link on the scene's edge) and which are closed, and the potential flow's physics on small fixtures: it follows a
 * channel round a bend, speeds up where it narrows, goes round a rock, and is still in a pond.
 */
import {
  analyseBodies,
  downsampleDepth,
  potentialGridDims,
  solvePotentialFlow,
  WATER_LINK_LEVEL,
  WATER_POTENTIAL_SPEED_HEADROOM,
} from '../water-flow-potential.js';

/** A depth grid of `w`×`h`, painted by a function (x, y) → 0..1. */
function paint(w, h, f) {
  const d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = f(x, y);
  return d;
}
const SOUTH = [0, 1];
const EAST = [1, 0];

export function run(t) {
  const ok = (name, cond) => t.ok(name, !!cond);

  // ── downsample + grid ──
  const bytes = new Uint8Array(40 * 20).fill(255);
  const ds = downsampleDepth(bytes, 40, 20, 10, 5);
  ok('a white mask downsamples to depth 1', ds.length === 50 && ds.every((v) => Math.abs(v - 1) < 1e-6));
  const g = potentialGridDims(6300, 5100);
  ok(
    `the potential grid keeps the aspect (${g.gw}x${g.gh})`,
    g.gw === 512 && Math.abs(g.gh / g.gw - 5100 / 6300) < 0.01
  );

  // ── bodies: links on the edge decide open and closed ──
  const W = 64;
  const H = 48;
  // a river across the top edge (columns 20..30), a cut-off pond in the middle, a bay touching the east edge by 2 cells
  const scene = paint(W, H, (x, y) => {
    if (x >= 20 && x <= 30 && y < 20) return 1; // river entering at the north edge
    if (Math.hypot(x - 40, y - 30) < 6) return 1; // a pond, cut off
    if (x >= 60 && y >= 10 && y <= 11) return 1; // a sliver on the east edge: below the link run length
    if (x >= 56 && y >= 38 && y <= 44) return 1; // a bay with a proper link on the east edge
    return 0;
  });
  const a = analyseBodies(scene, W, H);
  const river = a.bodies.find((b) => b.links.some((l) => l.edge === 'N' && l.cells >= 10));
  ok('the river touching the north edge is open', river && river.open);
  const pond = a.bodies.find((b) => b.cells > 100 && !b.linkCells && Math.abs(b.cells - Math.PI * 36) < 25);
  ok('a pond cut off from every edge is closed', pond && !pond.open && pond.linkCells === 0);
  const sliver = a.bodies.find((b) => b.links.some((l) => l.edge === 'E' && l.cells === 2));
  ok('a two-cell touch of the edge is not a link', sliver && !sliver.open);
  const bay = a.bodies.find((b) => b.links.some((l) => l.edge === 'E' && l.cells >= 7));
  ok('a bay with a full link on the edge is open', bay && bay.open);
  // a body only ever shallow at the edge is not linked: "fully white"
  const shallowEdge = paint(32, 32, (x, y) => (y < 10 && x > 8 && x < 20 ? WATER_LINK_LEVEL - 0.1 : 0));
  ok(
    'water at the edge that is not fully white does not link',
    analyseBodies(shallowEdge, 32, 32).bodies.every((b) => !b.open)
  );

  // ── a straight channel: flow along it, speed ∝ 1 / width ──
  const CW = 72;
  const CH = 48;
  const channel = (halfWidthAt) => paint(CW, CH, (x, y) => (Math.abs(y - 24) <= halfWidthAt(x) ? 1 : 0));
  const wide = solvePotentialFlow({ depth: channel(() => 8), gw: CW, gh: CH, dir: EAST });
  const mid = 24 * CW + 36;
  ok(
    `a channel open at both ends flows along it (vx ${wide.vx[mid].toFixed(2)})`,
    wide.vx[mid] > 0.9 && Math.abs(wide.vy[mid]) < 0.05
  );
  // narrowing in the middle: continuity speeds the water up
  const pinch = solvePotentialFlow({ depth: channel((x) => (x > 28 && x < 44 ? 3 : 8)), gw: CW, gh: CH, dir: EAST });
  ok(
    `water speeds up where the channel narrows (${pinch.vx[24 * CW + 36].toFixed(2)} vs ${pinch.vx[24 * CW + 12].toFixed(2)})`,
    pinch.vx[24 * CW + 36] > 1.7 * pinch.vx[24 * CW + 12]
  );
  // the flow turned to a bearing along the channel's other direction: a channel closed at one end flows not at all
  const deadEnd = solvePotentialFlow({
    depth: paint(CW, CH, (x, y) => (x < 50 && Math.abs(y - 24) <= 6 ? 1 : 0)),
    gw: CW,
    gh: CH,
    dir: EAST,
  });
  const deadMid = deadEnd.vx[24 * CW + 25];
  ok(
    `a channel open at one end only has no through-flow (|v| ${Math.abs(deadMid).toFixed(3)})`,
    Math.abs(deadMid) < 0.12
  );

  // ── a bend: the flow follows the channel, north edge in, east edge out ──
  const bendDepth = paint(60, 60, (x, y) => {
    const inVert = x >= 8 && x <= 16 && y <= 40; // comes down from the north edge
    const inHoriz = y >= 32 && y <= 40 && x >= 8; // turns east and leaves by the east edge
    return inVert || inHoriz ? 1 : 0;
  });
  const bend = solvePotentialFlow({ depth: bendDepth, gw: 60, gh: 60, dir: [0.6, 0.8] });
  const up = bend.vy[10 * 60 + 12];
  const out = bend.vx[36 * 60 + 40];
  ok(
    `the flow runs south down the first reach (vy ${up.toFixed(2)})`,
    up > 0.3 && Math.abs(bend.vx[10 * 60 + 12]) < 0.15
  );
  ok(
    `and east along the second, round the corner (vx ${out.toFixed(2)})`,
    out > 0.3 && Math.abs(bend.vy[36 * 60 + 40]) < 0.15
  );

  // ── a rock in a stream: stagnation behind it, acceleration beside it ──
  const rockDepth = paint(CW, CH, (x, y) => (Math.hypot(x - 36, y - 24) < 4 ? 0 : 1));
  const rock = solvePotentialFlow({ depth: rockDepth, gw: CW, gh: CH, dir: EAST });
  const side = rock.speed[(24 - 6) * CW + 36];
  const far = rock.speed[24 * CW + 6];
  const wake = rock.speed[24 * CW + 42];
  ok(`water speeds up past a rock (${side.toFixed(2)} vs ${far.toFixed(2)} upstream)`, side > 1.1 * far);
  ok(`and slows in its lee (${wake.toFixed(2)})`, wake < 0.75 * far);
  ok('a dry rock carries no flow', rock.speed[24 * CW + 36] === 0);

  // ── closed bodies are still, open ones move; speed01 is the pack's scale ──
  const both = solvePotentialFlow({
    depth: paint(CW, CH, (x, y) => (x >= 30 && x <= 42 ? 1 : Math.hypot(x - 14, y - 34) < 7 ? 1 : 0)),
    gw: CW,
    gh: CH,
    dir: SOUTH,
  });
  ok('a closed pond has zero current', both.speed[34 * CW + 14] === 0);
  ok('the open body beside it moves', both.speed[8 * CW + 36] > 0.5);
  const i = 8 * CW + 36;
  ok(
    'the RGBA pack holds vx, vy, speed01 and the land flag',
    both.rgba[i * 4] === both.vx[i] &&
      Math.abs(both.rgba[i * 4 + 2] - Math.min(1, both.speed[i] / WATER_POTENTIAL_SPEED_HEADROOM)) < 1e-6 &&
      both.rgba[(0 * CW + 0) * 4 + 3] === 1
  );

  // ── shallow reaches flow slower than the deep core beside them ──
  const bank = solvePotentialFlow({
    depth: paint(CW, CH, (x, y) => (Math.abs(y - 24) > 11 ? 0 : Math.abs(y - 24) > 5 ? 0.18 : 1)),
    gw: CW,
    gh: CH,
    dir: EAST,
  });
  ok(
    `a shallow bank flows slower than the deep core (${bank.speed[(24 + 8) * CW + 36].toFixed(2)} vs ${bank.speed[24 * CW + 36].toFixed(2)})`,
    bank.speed[(24 + 8) * CW + 36] < 0.8 * bank.speed[24 * CW + 36]
  );

  // ── determinism ──
  const again = solvePotentialFlow({ depth: rockDepth, gw: CW, gh: CH, dir: EAST });
  ok(
    'the solve is deterministic',
    again.vx.every((v, k) => v === rock.vx[k])
  );
}
