/**
 * aperture-gobo-walls.test.mjs — the "Window light pattern" (aperture gobo)
 * against REAL wall layouts near a light (mmp-8nr, 2026-10-19).
 *
 * The author's report: "when a light source is close to walls it produces
 * hard lines inside the light that make no sense." Every other test of this
 * effect checks the gate math against ONE hand-oriented aperture; none built
 * a wall layout, asked Foundry's question ("is this floor point lit at all?")
 * and then checked the pattern against it. This file does exactly that:
 *
 *   - `litByFoundry(L, P, walls)` is a small, independent oracle for what
 *     Foundry's own sweep decides: P is lit iff the straight segment L->P
 *     crosses no light-blocking wall (an aperture is passable — the light is
 *     inside its `threshold.light`, the only case where the pattern shows).
 *   - `patternAt(L, P, walls)` runs the PRODUCTION path end to end:
 *     `findAperturesForLight` (assignment + orientation) then
 *     `computeApertureGoboForLight` (the combine).
 *
 * Two kinds of check:
 *   1. NO OPINION OFF THE GLASS — where the ray L->P never passes through any
 *      window segment, the pattern must leave Foundry's light alone (exactly
 *      1). A window has no say over light that never went through it.
 *   2. NO STEP WHERE THE GEOMETRY HAS NONE — walk a path whose every point
 *      Foundry lights and whose rays cross no wall, sample the pattern every
 *      0.5px, and require no jump between neighbours. A hard edge reads as a
 *      jump of ~1; the smooth ramps this effect is built from move < 0.25 per
 *      step at these scales.
 *
 * Every case is a named configuration from the mission's wall table; the
 * write-up (`quartermaster/shifts/2026-10-19/mmp-8nr.md`) lists them with
 * old/new results.
 */
import {
  APERTURE_GOBO_DEFAULTS,
  SOFT_FAR_PX_BASE,
  findAperturesForLight,
  computeApertureGoboForLight,
  computeApertureGoboTerm,
  computeApertureSegmentWeight,
  deriveApertureGoboPaneCount,
} from '../aperture-gobo.js';
import { deriveWallAperture } from '../../../foundry/scene-walls.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const H = APERTURE_GOBO_DEFAULTS.defaultLampHeightPx;

/** A wall in `readSceneWallSegments`' own shape. */
const solid = (x1, y1, x2, y2) => ({ x1, y1, x2, y2, solid: true, aperture: false });
const windowWall = (x1, y1, x2, y2) => ({ x1, y1, x2, y2, solid: true, aperture: true });

/** The production per-light params bag (`point-light-pool.js` builds the same
 * from the schema), with the pane count derived the production way. */
function paramsFor(wallLen) {
  const { cols, rows } = deriveApertureGoboPaneCount({
    wallLen,
    sillPx: APERTURE_GOBO_DEFAULTS.sillPx,
    headPx: APERTURE_GOBO_DEFAULTS.headPx,
    paneWidthPx: APERTURE_GOBO_DEFAULTS.paneWidthPx,
    paneHeightPx: APERTURE_GOBO_DEFAULTS.paneHeightPx,
  });
  return {
    wallLen,
    cols,
    rows,
    sillPx: APERTURE_GOBO_DEFAULTS.sillPx,
    headPx: APERTURE_GOBO_DEFAULTS.headPx,
    frame: APERTURE_GOBO_DEFAULTS.frame,
    mullion: APERTURE_GOBO_DEFAULTS.mullion,
    softFarPx: SOFT_FAR_PX_BASE * APERTURE_GOBO_DEFAULTS.softness,
    reachSoftFarPx: 48 * APERTURE_GOBO_DEFAULTS.softness,
    wallThicknessPx: APERTURE_GOBO_DEFAULTS.wallThicknessPx,
    // The two DARKENING knobs are off here: they darken by design (an
    // author-tuned vignette), which would mask the geometry this file tests.
    // `edge suppression on` gets its own case below.
    edgeSuppressPercent: 0,
    dimRadiusFadeStartPercent: 100,
    dimRadiusFadeEndPercent: 100,
  };
}

/** Proper segment intersection (shared endpoints and collinear touches do not count). */
function segmentsCross(p1, p2, q1, q2) {
  const o = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = o(q1, q2, p1);
  const d2 = o(q1, q2, p2);
  const d3 = o(p1, p2, q1);
  const d4 = o(p1, p2, q2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Foundry's own answer, independently: lit iff no blocking wall crosses L->P. */
function litByFoundry(L, P, walls) {
  for (const w of walls) {
    if (w.aperture) continue; // within threshold.light: Edge#applyThreshold excludes it
    if (segmentsCross(L, P, { x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 })) return false;
  }
  return true;
}

/** Does the ray L->P pass through any window segment? */
function throughGlass(L, P, walls) {
  return walls.some((w) => w.aperture && segmentsCross(L, P, { x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }));
}

/** The production path: assignment, then the combine. */
function patternAt(L, P, walls, radius = 600) {
  const light = { x: L.x, y: L.y, radius };
  const { apertures } = findAperturesForLight(light, walls, APERTURE_GOBO_DEFAULTS.maxAperturesPerLight);
  const dist01 = Math.min(1, Math.hypot(P.x - L.x, P.y - L.y) / radius);
  const wallLen = apertures[0]?.wallLen ?? 100;
  return computeApertureGoboForLight(P, apertures, H, dist01, paramsFor(wallLen));
}

/** Sample a straight path every `step` px; report the largest neighbour jump
 * among points Foundry lights. */
function largestStep(L, from, to, walls, step = 0.5) {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const n = Math.max(2, Math.ceil(len / step));
  let prev = null;
  let worst = { jump: 0, at: null };
  for (let i = 0; i <= n; i++) {
    const P = { x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n };
    if (!litByFoundry(L, P, walls)) {
      prev = null;
      continue;
    }
    const g = patternAt(L, P, walls);
    if (prev !== null && Math.abs(g - prev) > worst.jump) worst = { jump: Math.abs(g - prev), at: P };
    prev = g;
  }
  return worst;
}

const fmt = (P) => (P ? `(${P.x.toFixed(1)}, ${P.y.toFixed(1)})` : '-');
const MAX_STEP = 0.25;

export function run(t) {
  const { ok } = t;

  // ==========================================================================
  // CASE A — A DOOR (open doorway) BESIDE A WINDOW IN THE SAME WALL.
  // Room is y<0. Wall line y=0: window x∈[0,120], doorway (no wall) x∈[140,220],
  // solid wall either side. Light in the room near both.
  // ==========================================================================
  {
    const walls = [
      solid(-300, 0, 0, 0),
      windowWall(0, 0, 120, 0),
      solid(120, 0, 140, 0),
      // doorway: x 140..220, no wall (an OPEN door is the same — Foundry drops
      // every sense of an open door to NONE, client/documents/wall.mjs:162)
      solid(220, 0, 500, 0),
    ];
    const L = { x: 120, y: -60 };
    const P = { x: 200, y: 40 }; // through the doorway
    ok('A: sanity — Foundry lights the point beyond the doorway', litByFoundry(L, P, walls));
    ok('A: sanity — that ray does NOT pass through the window', !throughGlass(L, P, walls));
    const g = patternAt(L, P, walls);
    ok(`A: light through the open doorway beside a window is left alone (pattern ${g.toFixed(3)}, want 1)`, g === 1);
    // Walking across the wall LINE inside the doorway: Foundry lights both
    // sides, nothing is in the way, so the pattern must not step there.
    const s = largestStep(L, { x: 180, y: -30 }, { x: 180, y: 30 }, walls);
    ok(
      `A: no hard line where the window's own line crosses the doorway (largest step ${s.jump.toFixed(3)} at ${fmt(s.at)})`,
      s.jump < MAX_STEP
    );
  }

  // ==========================================================================
  // CASE B — AN OUTDOOR LIGHT BY A BUILDING CORNER (round 14's report, "large
  // and outdoors... cut off at strange angles", inside the 400px cap). Building
  // [0,100]², window on its south wall. Light outside, east of the building.
  // ==========================================================================
  {
    const walls = [
      solid(0, 0, 100, 0),
      solid(100, 0, 100, 100),
      solid(0, 100, 0, 0),
      solid(0, 100, 40, 100),
      windowWall(40, 100, 60, 100),
      solid(60, 100, 100, 100),
    ];
    const L = { x: 150, y: 50 };
    const P = { x: 200, y: 160 };
    ok('B: sanity — Foundry lights open ground south-east of the building', litByFoundry(L, P, walls));
    const g = patternAt(L, P, walls);
    ok(`B: open ground beside a building is not cut by its window's line (pattern ${g.toFixed(3)}, want 1)`, g === 1);
    const s = largestStep(L, { x: 180, y: 80 }, { x: 180, y: 140 }, walls);
    ok(
      `B: no hard line along the extension of the south wall (largest step ${s.jump.toFixed(3)} at ${fmt(s.at)})`,
      s.jump < MAX_STEP
    );
  }

  // ==========================================================================
  // CASE C — A WINDOW SET IN FROM THE WALL LINE (an inward recess, a window
  // drawn a little inside a thick wall, a bay). Outer wall y=0; window on
  // y=-20 x∈[100,200] with jambs back to the outer wall; room is y<0.
  // ==========================================================================
  {
    const walls = [
      solid(-200, 0, 100, 0),
      solid(100, 0, 100, -20),
      windowWall(100, -20, 200, -20),
      solid(200, -20, 200, 0),
      solid(200, 0, 600, 0),
    ];
    const L = { x: 150, y: -150 };
    const P = { x: 320, y: -8 }; // inside the room, between the window's line and the outer wall
    ok('C: sanity — Foundry lights the strip of room along the outer wall', litByFoundry(L, P, walls));
    const g = patternAt(L, P, walls);
    ok(`C: the room beside a set-in window is not darkened (pattern ${g.toFixed(3)}, want 1)`, g === 1);
    const s = largestStep(L, { x: 330, y: -40 }, { x: 330, y: -2 }, walls);
    ok(
      `C: no hard line inside the room along the set-in window's line (largest step ${s.jump.toFixed(3)} at ${fmt(s.at)})`,
      s.jump < MAX_STEP
    );
  }

  // ==========================================================================
  // CASE D — AN L-SHAPED ROOM: the window's wall line runs on through the
  // room's other wing.
  // ==========================================================================
  {
    // Wing 1: x∈[0,200], y∈[0,200]; wing 2: x∈[200,400], y∈[100,200].
    // The window is on wing 2's north wall (y=100, x∈[250,350]); its line
    // y=100 runs on west through wing 1's interior.
    const walls = [
      solid(0, 0, 200, 0),
      solid(200, 0, 200, 100),
      solid(200, 100, 250, 100),
      windowWall(250, 100, 350, 100),
      solid(350, 100, 400, 100),
      solid(400, 100, 400, 200),
      solid(400, 200, 0, 200),
      solid(0, 200, 0, 0),
    ];
    const L = { x: 180, y: 160 };
    const P = { x: 100, y: 40 }; // wing 1, beyond the window's line as seen from L
    ok('D: sanity — Foundry lights wing 1', litByFoundry(L, P, walls));
    const g = patternAt(L, P, walls);
    ok(`D: the other wing of an L-shaped room is not darkened (pattern ${g.toFixed(3)}, want 1)`, g === 1);
    const s = largestStep(L, { x: 100, y: 140 }, { x: 100, y: 60 }, walls);
    ok(
      `D: no hard line across the room along the window's wall line (largest step ${s.jump.toFixed(3)} at ${fmt(s.at)})`,
      s.jump < MAX_STEP
    );
  }

  // ==========================================================================
  // CASE E — A GAP AT THE WINDOW'S END (the window does not reach the next
  // wall). Foundry lets light through the gap; the pattern must not put a
  // hard edge across that light. A SUB-PIXEL gap must stay dark (it is the
  // window frame's own shadow, not a real opening worth a bright sliver).
  // ==========================================================================
  {
    const walls = [solid(-200, 0, 0, 0), windowWall(0, 0, 120, 0), solid(150, 0, 400, 0)]; // 30px gap 120..150
    const L = { x: 60, y: -80 };
    const s = largestStep(L, { x: 100, y: 30 }, { x: 260, y: 30 }, walls, 0.25);
    ok(
      `E: no hard edge across light leaking through a 30px gap at the window end (largest step ${s.jump.toFixed(3)} at ${fmt(s.at)})`,
      s.jump < MAX_STEP
    );
    const P = { x: 60 + 75 * (110 / 80), y: 30 }; // the ray through the gap's centre, x=135 on the wall line
    ok(
      'E: sanity — that ray goes through the gap, not the glass',
      !throughGlass(L, P, walls) && litByFoundry(L, P, walls)
    );
    ok('E: light through the gap well clear of the frame reads fully open', patternAt(L, P, walls) === 1);
    const tiny = [solid(-200, 0, 0, 0), windowWall(0, 0, 120, 0), solid(120.4, 0, 400, 0)]; // 0.4px gap
    const Ptiny = { x: 120.2 + (120.2 - 60) * (30 / 80), y: 30 }; // on the ray through the gap's centre
    ok(
      `E: a sub-pixel gap at the window end stays in the frame's shadow (pattern ${patternAt(L, Ptiny, tiny).toFixed(3)})`,
      patternAt(L, Ptiny, tiny) < 0.5
    );
  }

  // ==========================================================================
  // CASE F — THE WORKING CASE IS UNCHANGED: a light in a sealed room, its
  // window patterned exactly as before. A single window crossed inside its
  // own segment must give exactly the single-aperture term.
  // ==========================================================================
  {
    const walls = [solid(-200, 0, 0, 0), windowWall(0, 0, 200, 0), solid(200, 0, 600, 0)];
    const L = { x: 90, y: -120 };
    const light = { x: L.x, y: L.y, radius: 600 };
    const { apertures } = findAperturesForLight(light, walls, 4);
    const p = paramsFor(200);
    let worst = 0;
    for (let x = 0; x <= 200; x += 7) {
      for (let y = 2; y <= 400; y += 13) {
        const P = { x: L.x + (x - L.x) * (1 + y / 120), y };
        const dist01 = Math.min(1, Math.hypot(P.x - L.x, P.y - L.y) / 600);
        const solo = computeApertureGoboTerm(P, apertures[0], H, dist01, p);
        const combined = computeApertureGoboForLight(P, apertures, H, dist01, p);
        // Inside the segment (well clear of its ends) the weight is 1, so the
        // combine must return the term itself, bit for bit.
        if (x >= 1 && x <= 199) worst = Math.max(worst, Math.abs(combined - solo.gobo));
      }
    }
    ok(`F: through the glass, the pattern is the old single-window term exactly (max diff ${worst})`, worst === 0);
  }

  // ==========================================================================
  // CASE G — DUPLICATE / OVERLAPPING WINDOW WALLS (a window drawn twice, or
  // two segments overlapping) must look exactly like one window.
  // ==========================================================================
  {
    const one = [solid(-200, 0, 0, 0), windowWall(0, 0, 200, 0), solid(200, 0, 600, 0)];
    const two = [...one, windowWall(0, 0, 200, 0)];
    const L = { x: 90, y: -120 };
    let worst = 0;
    for (let x = -50; x <= 250; x += 9) {
      for (let y = 3; y <= 300; y += 17) {
        const P = { x, y };
        worst = Math.max(worst, Math.abs(patternAt(L, P, one) - patternAt(L, P, two)));
      }
    }
    ok(`G: a duplicated window wall looks exactly like one (max diff ${worst})`, worst === 0);
  }

  // ==========================================================================
  // CASE H — A CORNER ROOM WITH WINDOWS ON TWO WALLS. Light through the east
  // window must keep the east window's own pattern, and is never touched by
  // the north window whose line it crosses beside the glass.
  // ==========================================================================
  {
    const walls = [
      solid(0, 0, 40, 0),
      windowWall(40, 0, 160, 0), // north window
      solid(160, 0, 200, 0),
      solid(200, 0, 200, 40),
      windowWall(200, 40, 200, 160), // east window
      solid(200, 160, 200, 200),
      solid(200, 200, 0, 200),
      solid(0, 200, 0, 0),
    ];
    const L = { x: 150, y: 100 };
    const light = { x: L.x, y: L.y, radius: 600 };
    const { apertures } = findAperturesForLight(light, walls, 4);
    const east = apertures.find((ap) => Math.abs(ap.A.x - 200) < 1e-9 && Math.abs(ap.dir.x) < 1e-9);
    ok('H: sanity — both windows assigned to the light', apertures.length === 2 && !!east);
    const P = { x: 300, y: -40 }; // beyond BOTH windows' lines; the ray is through the east glass only
    const dist01 = Math.hypot(P.x - L.x, P.y - L.y) / 600;
    const solo = computeApertureGoboTerm(P, east, H, dist01, paramsFor(120));
    const combined = patternAt(L, P, walls);
    ok(
      `H: light out of the east window keeps the east window's own pattern (${combined.toFixed(4)} vs ${solo.gobo.toFixed(4)})`,
      Math.abs(combined - solo.gobo) < 1e-12
    );
  }

  // ==========================================================================
  // CASE I — TWO WINDOWS IN SERIES (an interior glazed partition, then the
  // outer window): the darker of the two wins (a mullion of either shades).
  // ==========================================================================
  {
    const L = { x: 100, y: -200 };
    const inner = { x1: 0, y1: -100, x2: 200, y2: -100, solid: true, aperture: true };
    const outer = { x1: 0, y1: 0, x2: 200, y2: 0, solid: true, aperture: true };
    const light = { x: L.x, y: L.y, radius: 600 };
    const { apertures } = findAperturesForLight(light, [inner, outer], 4);
    const P = { x: 130, y: 60 };
    const dist01 = Math.hypot(P.x - L.x, P.y - L.y) / 600;
    const p = paramsFor(200);
    const terms = apertures.map((ap) => computeApertureGoboTerm(P, ap, H, dist01, p).gobo);
    const combined = computeApertureGoboForLight(P, apertures, H, dist01, p);
    ok(
      `I: windows in series — the darker window wins (${combined.toFixed(4)} vs ${Math.min(...terms).toFixed(4)})`,
      Math.abs(combined - Math.min(...terms)) < 1e-12
    );
  }

  // ==========================================================================
  // THE SEGMENT WEIGHT itself — 1 on the glass, 0 clear of it, smooth between.
  // ==========================================================================
  {
    ok('weight: 1 inside the segment', computeApertureSegmentWeight(50, 100, 2) === 1);
    ok(
      'weight: 1 exactly at either end',
      computeApertureSegmentWeight(0, 100, 2) === 1 && computeApertureSegmentWeight(100, 100, 2) === 1
    );
    ok(
      'weight: 0 a full ramp past either end',
      computeApertureSegmentWeight(-2, 100, 2) === 0 && computeApertureSegmentWeight(102, 100, 2) === 0
    );
    const mid = computeApertureSegmentWeight(-1, 100, 2);
    ok(`weight: halfway down the ramp at half the ramp width (${mid})`, Math.abs(mid - 0.5) < 1e-12);
    ok('weight: a ramp under 1px is floored at 1px', computeApertureSegmentWeight(-0.5, 100, 0) === 0.5);
    ok('weight: non-finite sW reads as off the glass', computeApertureSegmentWeight(NaN, 100, 2) === 0);
  }

  // ==========================================================================
  // CASE J — EDGE SUPPRESSION ON (the shipped 15%): still no hard line off the
  // glass. Suppression darkens the window's OWN throw; it must not leak onto
  // light that never went through the window.
  // ==========================================================================
  {
    const walls = [solid(-300, 0, 0, 0), windowWall(0, 0, 120, 0), solid(120, 0, 140, 0), solid(220, 0, 500, 0)];
    const L = { x: 120, y: -60 };
    const light = { x: L.x, y: L.y, radius: 600 };
    const { apertures } = findAperturesForLight(light, walls, 4);
    const p = { ...paramsFor(120), edgeSuppressPercent: 15, dimRadiusFadeStartPercent: 0, dimRadiusFadeEndPercent: 58 };
    const P = { x: 200, y: 40 };
    const g = computeApertureGoboForLight(P, apertures, H, Math.hypot(P.x - L.x, P.y - L.y) / 600, p);
    ok(`J: with the shipped suppression settings, doorway light is still left alone (${g.toFixed(3)})`, g === 1);
  }

  // ==========================================================================
  // DOORS — Foundry drops EVERY sense of an OPEN door to NONE
  // (client/documents/wall.mjs:162), so an open glass door passes light
  // unshaped; closed, locked and secret doors are walls like any other.
  // ==========================================================================
  {
    const WINDOW = { move: 20, light: 30 };
    ok('door: a plain proximity window is an aperture', deriveWallAperture({ ...WINDOW }));
    ok('door: a CLOSED glass door (door:1, ds:0) is an aperture', deriveWallAperture({ ...WINDOW, door: 1, ds: 0 }));
    ok('door: a LOCKED glass door (ds:2) is an aperture', deriveWallAperture({ ...WINDOW, door: 1, ds: 2 }));
    ok('door: a closed SECRET glass door (door:2) is an aperture', deriveWallAperture({ ...WINDOW, door: 2, ds: 0 }));
    ok(
      'door: an OPEN glass door is NOT an aperture (Foundry passes light through it unshaped)',
      !deriveWallAperture({ ...WINDOW, door: 1, ds: 1 })
    );
    ok('door: an OPEN secret glass door is NOT an aperture', !deriveWallAperture({ ...WINDOW, door: 2, ds: 1 }));
    ok(
      'door: a non-door wall with a stray ds value is still an aperture (ds only matters on a door)',
      deriveWallAperture({ ...WINDOW, door: 0, ds: 1 })
    );
  }
}
