/**
 * Node verification for diag/orientation-probe.js — the Y-flip detector.
 *
 * The probe's JOB is to be believed when it says "Y-FLIPPED". So its diagnosis
 * logic is tested here against every transform it claims to distinguish,
 * INCLUDING the real one that shipped: the 2026-07-17 present-pass flip. An
 * instrument that guesses is worse than no instrument
 * (memory: feedback_instruments_must_not_lie).
 */
import { diagnoseOrientation, classifyPixel, PROBE_CORNERS } from '../orientation-probe.js';

/** The pattern as it appears when rendered CORRECTLY. */
const correct = Object.fromEntries(PROBE_CORNERS.map((c) => [c.name, c.label]));

export function run(t) {
  const { ok } = t;

  // --- the pattern itself must be able to DETECT a flip ---------------------
  // A symmetric pattern is why Y-flips hide: a grid, a radial glow and a blur
  // all look identical upside down. These assertions are what make the probe
  // capable of seeing anything at all.
  {
    const labels = PROBE_CORNERS.map((c) => c.label);
    ok('every corner is a DIFFERENT colour (a symmetric pattern cannot detect a flip)', new Set(labels).size === 4);
    const top = PROBE_CORNERS.filter((c) => c.v < 0.5).map((c) => c.label);
    const bottom = PROBE_CORNERS.filter((c) => c.v > 0.5).map((c) => c.label);
    ok('asymmetric on Y (top and bottom share no colour — a Y-flip is visible)', !top.some((l) => bottom.includes(l)));
    const left = PROBE_CORNERS.filter((c) => c.u < 0.5).map((c) => c.label);
    const right = PROBE_CORNERS.filter((c) => c.u > 0.5).map((c) => c.label);
    ok(
      'asymmetric on X too (so a Y-flip is distinguishable from a 180° rotation)',
      !left.some((l) => right.includes(l))
    );
  }

  // --- correct ---------------------------------------------------------------
  {
    const r = diagnoseOrientation(correct);
    ok('a correct render reports ok', r.ok === true);
    ok('...and says so plainly', /correct/.test(r.diagnosis));
  }

  // --- THE REAL BUG: Y-flip (top<->bottom) ----------------------------------
  // This is the exact failure the author saw on 2026-07-17.
  {
    const flipped = {
      topLeft: 'BLUE', // was bottomLeft
      topRight: 'YELLOW', // was bottomRight
      bottomLeft: 'RED', // was topLeft
      bottomRight: 'GREEN', // was topRight
    };
    const r = diagnoseOrientation(flipped);
    ok('a Y-flip is DETECTED', r.ok === false);
    ok('...and NAMED as a Y-flip, not just "wrong"', /Y-FLIPPED/.test(r.diagnosis));
    ok(
      '...and points at the actual cause (hand-rolled quad / PlaneGeometry)',
      /PlaneGeometry|QuadMesh/.test(r.diagnosis)
    );
    ok('...and warns against the tempting wrong fix', /compensating flip/i.test(r.diagnosis));
  }

  // --- X-flip, distinguished from Y -----------------------------------------
  {
    const r = diagnoseOrientation({
      topLeft: 'GREEN',
      topRight: 'RED',
      bottomLeft: 'YELLOW',
      bottomRight: 'BLUE',
    });
    ok('an X-flip is detected', r.ok === false);
    ok('...and named as X, NOT confused with Y', /X-FLIPPED/.test(r.diagnosis) && !/Y-FLIPPED/.test(r.diagnosis));
  }

  // --- 180°, distinguished from either single flip --------------------------
  {
    const r = diagnoseOrientation({
      topLeft: 'YELLOW',
      topRight: 'BLUE',
      bottomLeft: 'GREEN',
      bottomRight: 'RED',
    });
    ok('a 180° rotation is detected', r.ok === false);
    ok('...and named as BOTH axes, not one', /ROTATED 180/.test(r.diagnosis));
    ok('...and says to find TWO flips (the "two cancel into four" trap)', /Two flips/.test(r.diagnosis));
  }

  // --- garbage: must NOT be mislabelled as an orientation bug ---------------
  // If nothing rendered, or the wrong texture is bound, saying "Y-FLIPPED"
  // would send the next session hunting a flip that does not exist.
  {
    const r = diagnoseOrientation({ topLeft: null, topRight: null, bottomLeft: null, bottomRight: null });
    ok('an all-black/garbage read is NOT called a flip', r.ok === false && !/FLIPPED|ROTATED/.test(r.diagnosis));
    ok('...and redirects to the real suspects (sampling, not orientation)', /sampling itself/.test(r.diagnosis));
  }
  {
    const r = diagnoseOrientation({ ...correct, topLeft: 'GREEN' });
    ok('one wrong corner is not forced into a flip diagnosis', r.ok === false && !/FLIPPED|ROTATED/.test(r.diagnosis));
  }

  // --- pixel classification --------------------------------------------------
  {
    ok('exact red classifies as RED', classifyPixel(255, 0, 0) === 'RED');
    ok('exact yellow classifies as YELLOW', classifyPixel(255, 255, 0) === 'YELLOW');
    ok('slightly-off red (filtering / colour round-trip) still classifies', classifyPixel(230, 30, 20) === 'RED');
    ok('black classifies as NOTHING (never silently the nearest colour)', classifyPixel(0, 0, 0) === null);
    ok('mid-grey classifies as nothing', classifyPixel(128, 128, 128) === null);
    ok('RED is never confused with GREEN despite the slack', classifyPixel(255, 0, 0) !== 'GREEN');
  }
}
