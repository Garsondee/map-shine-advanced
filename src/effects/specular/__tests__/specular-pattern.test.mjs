/**
 * specular-pattern.test.mjs — the shimmer maths, asserted where it can be read.
 *
 * A shimmer is a SMOOTH OUTPUT, and a smooth output hides a ported bug
 * indefinitely: every wrong version still looks like *something*, so the eye
 * cannot referee it (`feedback_smooth_output_hides_ported_bugs`). These
 * assertions are what stands between "the transcription is right" and "the
 * transcription produces plausible noise".
 *
 * ⚠️ Nothing here pins a VALUE. The hash is `Math.sin`-based and a GPU's `sin`
 * differs in the last bits, so value equality would be a test of the CPU rather
 * than of the algorithm. What is asserted is STRUCTURE — ranges, determinism,
 * decorrelation, and above all the three claims the module header makes about
 * V2's mislabelled controls, because those are exactly the claims that would be
 * silently wrong if the transcription drifted.
 */
import {
  hash12,
  anisotropicBlob,
  shimmerLayer,
  sunGrainBias,
  cellScaleForStrength,
  parallaxOffset,
  reinhardCeiling,
  reinhardCeilingRgb,
  incidentFromIllumRgb,
  steepenIncidentRgb,
  SUN_BIAS_MIN,
  CELL_SCALE_DULL,
  CELL_SCALE_BRIGHT,
  SPECULAR_SHEEN_CEILING,
  SPECULAR_GLINT_CEILING,
  SPECULAR_INCIDENT_STEEPNESS,
} from '../specular-pattern.js';
// The composite's own default gain — imported, not hand-typed, so the
// tonemap-survival test below tracks whatever `specular-render.js` actually
// ships rather than a number that can silently drift out of sync with it.
import { SPECULAR_DEFAULT_SHIMMER_GAIN } from '../specular-render.js';

const LUMA_709 = [0.2126, 0.7152, 0.0722];

/** The layer defaults, as a blob call. @param {object} o @returns {object} */
function blobArgs(o = {}) {
  return { u: 0.3, v: 0.7, grainX: 1, grainY: 0, density: 11, rowSpacing: 4, softness: 0.31, streak: 0, ...o };
}

/**
 * Find one blob's peak, then measure its half-maximum radius along the grain
 * and across it — in PATTERN space, which is where the header's isotropy claim
 * lives.
 *
 * Written as a peak-then-radius walk rather than as second moments over a fixed
 * window, and the first draft got exactly that wrong: the cell pitch ACROSS the
 * grain is `rowSpacing/density`, four times the pitch along it, so a window
 * sized for one cell along the grain samples a quarter of a cell across and
 * measures a blob that is simply cut off. Finding the peak first removes both
 * the window-size question and the per-cell jitter.
 *
 * @param {object} over @returns {{along: number, across: number, peak: number}}
 */
function blobRadii(over) {
  const rows = over.rowSpacing ?? 4;
  const at = (u, v) => anisotropicBlob(blobArgs({ ...over, u, v }));
  // Coarse scan over one whole cell in BOTH axes, at their own pitches.
  const spanU = 1 / 11;
  const spanV = rows / 11;
  let peak = -1;
  let pu = 0;
  let pv = 0;
  const N = 90;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const u = (i / N) * spanU;
      const v = (j / N) * spanV;
      const b = at(u, v);
      if (b > peak) {
        peak = b;
        pu = u;
        pv = v;
      }
    }
  }
  // Walk outward from the peak until the value halves. Fine steps, because the
  // half-max radius is the quantity being compared and a coarse step would
  // quantise the comparison into agreeing by accident.
  const step = spanU / 400;
  const radius = (du, dv) => {
    for (let k = 1; k < 4000; k++) {
      if (at(pu + du * k * step, pv + dv * k * step) < peak * 0.5) return k * step;
    }
    return Infinity;
  };
  return { along: radius(1, 0), across: radius(0, 1), peak };
}

/** @param {{ok: Function}} t */
export function run(t) {
  const { ok } = t;

  // ── THE HASH ────────────────────────────────────────────────────────────
  ok(
    'hash12 stays in 0..1',
    [
      [0, 0],
      [1, 1],
      [-4, 17],
      [913, -22],
      [0.5, 0.5],
    ].every(([x, y]) => {
      const h = hash12(x, y);
      return h >= 0 && h < 1;
    })
  );
  ok('hash12 is deterministic', hash12(3, 7) === hash12(3, 7));
  // Decorrelated on BOTH axes: a hash that ignored one would make every cell in
  // a row identical, and the lattice would read as stripes rather than as
  // scatter — visible, and easy to ship.
  ok('hash12 varies with x', hash12(3, 7) !== hash12(4, 7));
  ok('hash12 varies with y', hash12(3, 7) !== hash12(3, 8));

  // ── THE BLOB ────────────────────────────────────────────────────────────
  const samples = [];
  for (let i = 0; i < 400; i++) samples.push(anisotropicBlob(blobArgs({ u: i * 0.013, v: i * 0.021 })));
  ok(
    'the blob stays in 0..1',
    samples.every((b) => b >= 0 && b <= 1)
  );
  ok('…and is not constant — it is a field, not a value', Math.max(...samples) - Math.min(...samples) > 0.5);
  ok('the blob is deterministic', anisotropicBlob(blobArgs()) === anisotropicBlob(blobArgs()));

  // ⚠️ THE HEADER'S CENTRAL CLAIM, MEASURED. `rowSpacing`'s two factors cancel
  // in pattern space, so at `streak = 0` the blob is ISOTROPIC no matter what
  // row spacing says. If a future edit "fixes" the stretch by removing one of
  // those factors, this is the assertion that catches it — and the symptom on
  // screen would be glints that stretch when you change row spacing, which
  // looks entirely reasonable and is wrong.
  const round = blobRadii({ streak: 0, rowSpacing: 4 });
  ok(
    'at streak 0 the blob is ROUND in pattern space, whatever rowSpacing says',
    Math.abs(round.along - round.across) < Math.max(round.along, round.across) * 0.15
  );
  const roundTight = blobRadii({ streak: 0, rowSpacing: 1 });
  ok(
    '…still round at a quarter of the row spacing',
    Math.abs(roundTight.along - roundTight.across) < Math.max(roundTight.along, roundTight.across) * 0.15
  );
  // AND the SAME size: rowSpacing must change where the rows sit, never how big
  // a glint is. If a future edit drops one of the two cancelling factors, the
  // blob starts stretching with row spacing — which looks entirely plausible
  // and is exactly the bug the header's algebra rules out.
  ok(
    'rowSpacing does not change the glint SIZE, only the row pitch',
    Math.abs(round.along - roundTight.along) < round.along * 0.15
  );

  // ⚠️ AND ITS COROLLARY: `streak` is what makes streaks. Measured as a rise in
  // the spread of the field rather than of one blob, because each cell rotates
  // by its OWN hash — the population becomes directional, not every member.
  let varRound = 0;
  let varStreaked = 0;
  for (let i = 0; i < 500; i++) {
    const u = i * 0.0031;
    const v = i * 0.0047;
    varRound += anisotropicBlob(blobArgs({ u, v, streak: 0 }));
    varStreaked += anisotropicBlob(blobArgs({ u, v, streak: 1.7 }));
  }
  ok('streak changes the field rather than leaving it alone', Math.abs(varRound - varStreaked) > 1e-3);

  // Row spacing DOES do the thing it is now named for: separate the rows. With
  // wider spacing, fewer samples along a line across the grain land on a blob.
  const countAcross = (rowSpacing) => {
    let n = 0;
    for (let i = 0; i < 400; i++) {
      if (anisotropicBlob(blobArgs({ u: 0.02, v: i * 0.002, rowSpacing, streak: 0 })) > 0.5) n++;
    }
    return n;
  };
  ok('wider rowSpacing puts fewer glints across the grain', countAcross(6) < countAcross(1));

  // Softness widens the Gaussian, which is the one thing its name promises.
  const hitsAt = (softness) => {
    let n = 0;
    for (let i = 0; i < 400; i++) {
      if (anisotropicBlob(blobArgs({ u: i * 0.0017, v: i * 0.0023, softness })) > 0.5) n++;
    }
    return n;
  };
  ok('higher softness covers more of the surface', hitsAt(1) > hitsAt(0));

  // ── THE CONTRAST WINDOW ─────────────────────────────────────────────────
  const covered = (contrast) => {
    let n = 0;
    for (let i = 0; i < 600; i++) {
      if (shimmerLayer(blobArgs({ u: i * 0.0019, v: i * 0.0029, contrast })) > 0.5) n++;
    }
    return n;
  };
  ok('a layer stays in 0..1', shimmerLayer(blobArgs({ contrast: 0.5 })) <= 1);
  // V2 called this "Cluster size"; it is a threshold, and a higher value lets
  // MORE of the blob through — which is why the corrected name is `contrast`
  // and the help text talks about coverage.
  ok('higher contrast covers more surface, monotonically', covered(0.9) > covered(0.5) && covered(0.5) > covered(0.1));

  // ── THE SUN ─────────────────────────────────────────────────────────────
  // The ONLY route the sun's direction has into a 2D effect. A brushed surface
  // throws its highlight ACROSS the grooves, so a grain perpendicular to the
  // light must win — get this backwards and the whole map dims at noon.
  const alongLight = sunGrainBias(1, 0, 0);
  const acrossLight = sunGrainBias(0, 1, 0);
  ok('grain across the light is favoured over grain along it', acrossLight > alongLight);
  ok('…and the dim end is the documented floor, not zero', Math.abs(alongLight - SUN_BIAS_MIN) < 1e-6);
  ok('…and the bright end is exactly 1', Math.abs(acrossLight - 1) < 1e-6);
  ok(
    'the bias is symmetric under a half-turn of the sun — a grain has no front',
    Math.abs(sunGrainBias(0.6, 0.8, 1.1) - sunGrainBias(0.6, 0.8, 1.1 + Math.PI)) < 1e-9
  );

  // ── THE MASK'S ROUGHNESS COUPLING ───────────────────────────────────────
  ok('a dull mask gets coarse cells', Math.abs(cellScaleForStrength(0) - CELL_SCALE_DULL) < 1e-9);
  ok('a bright mask gets fine cells', Math.abs(cellScaleForStrength(1) - CELL_SCALE_BRIGHT) < 1e-9);
  ok('…and it is monotonic between', cellScaleForStrength(0.7) > cellScaleForStrength(0.3));

  // ── PARALLAX ────────────────────────────────────────────────────────────
  // Depth 1 must be exactly the 1:1 case. V2 buried this in a magic 0.0006 that
  // only came out at 1:1 because it cancelled against a pattern scale of 16384,
  // which is precisely the kind of accidental calibration that breaks the first
  // time someone changes the other number.
  const p = parallaxOffset(16384, 0, 1, 0, 1, 16384);
  ok('depth 1 slides the pattern exactly one pattern unit per pattern width', Math.abs(p.u - 1) < 1e-9);
  ok('…and does not leak into the other axis', Math.abs(p.v) < 1e-9);
  const neg = parallaxOffset(16384, 0, -1, 0, 1, 16384);
  ok('a NEGATIVE depth counter-moves — the layer-3 signature', neg.u < 0);
  const half = parallaxOffset(16384, 0, 0.5, 0, 1, 16384);
  ok('depth scales the slide linearly', Math.abs(half.u - 0.5) < 1e-9);
  ok('a zero master strength freezes the pattern to the map', parallaxOffset(16384, 0, 1, 0, 0, 16384).u === 0);
  // A degenerate pattern scale must not divide by zero into an Infinity that
  // would propagate through an additive blend as a permanent white hole.
  ok(
    'a zero pattern scale is floored rather than dividing by zero',
    Number.isFinite(parallaxOffset(100, 100, 1, 1, 1, 0).u)
  );

  // ── THE HIGHLIGHT CEILING — live-diagnosed 2026-07-27 ────────────────────
  // Two live reports — "self-illuminating" and "washed out instead of
  // colourful" — turned out to be one overshoot: the composite had no ceiling
  // of its own, so ordinary settings routinely pushed 2-4+ per channel into a
  // shared tonemap that then had to compress it hard, which reads as
  // desaturation. See `reinhardCeiling`'s own header for the full account.
  // These assertions exercise the generic curve at the GLINT ceiling (the
  // larger of the two, and the more interesting range to probe "genuine
  // excess" against); `SPECULAR_SHEEN_CEILING` gets its own, separate check
  // further down, specifically for the property that makes splitting them
  // worthwhile: the sheen must compress far EARLIER than the glint.
  const C = SPECULAR_GLINT_CEILING;
  ok('zero luminance stays zero', reinhardCeiling(0, C) === 0);
  // ⚠️ BOUNDED FOR EVERY INPUT, not just "correct at one design point" — this
  // is what makes it safe against an author cranking every slider to its
  // schema max simultaneously, a combination nobody explicitly designed for
  // but the ceiling must survive regardless.
  // ⚠️ THE PROBE SCALES WITH `C`, NOT A FIXED CONSTANT (fixed at ROUND 21,
  // 2026-08-05 — `SPECULAR_GLINT_CEILING` jumped 28 → 200 and a probe of a
  // flat `1e9` stopped clearing `1e-6`: `C - reinhardCeiling(L, C) ≈ C²/L`
  // for `L >> C`, so a BIGGER ceiling needs a proportionally bigger probe to
  // land at the same absolute gap — a margin sized to today's C is exactly
  // the self-defeating shape `feedback_margin_sized_to_gap_is_self_
  // defeating` warns about. `L = C·1e9` keeps the gap at `≈ C/1e9`,
  // comfortably under `1e-6` for any ceiling this schema could plausibly
  // ship, not just the one that happened to be live when this was written.
  const farL = C * 1e9;
  ok('never reaches the ceiling', reinhardCeiling(farL, C) < C);
  ok('…and gets arbitrarily close', C - reinhardCeiling(farL, C) < 1e-6);
  ok(
    'strictly monotonic — brighter input never darkens the output',
    reinhardCeiling(2, C) > reinhardCeiling(1, C) && reinhardCeiling(10, C) > reinhardCeiling(2, C)
  );
  // NEAR-IDENTITY for ordinary, well-below-ceiling values — the curve must not
  // touch normal-strength shine, only genuine excess. Slope at the origin is
  // exactly 1 by construction (`ceiling·L/(ceiling+L)` differentiates to 1 at
  // L=0), checked numerically rather than assumed.
  const dL = 1e-4;
  const slope0 = (reinhardCeiling(dL, C) - reinhardCeiling(0, C)) / dL;
  ok('near-identity slope at the origin (ordinary shine is untouched)', Math.abs(slope0 - 1) < 1e-3);
  ok('a typical value is barely compressed', reinhardCeiling(0.3, C) / 0.3 > 0.9);
  // "Extreme" is relative to the ceiling under test, not a fixed number — at
  // ten times the glint ceiling itself, compression must be unmistakable.
  ok('a genuinely extreme value is compressed hard', reinhardCeiling(10 * C, C) / (10 * C) < 0.25);

  // ⚠️ HUE MUST SURVIVE EXACTLY — the reason this is luminance-based rather
  // than per-channel. A per-channel compression would compress a saturated
  // colour's DOMINANT channel hardest, shifting the hue toward neutral, which
  // is the opposite of "intense and colourful".
  const brightGold = [3.0, 2.298, 1.008]; // gold pushed 3x past its own tint
  const compressedGold = reinhardCeilingRgb(brightGold, LUMA_709, C);
  const hueRatio = (rgb) => rgb[0] / rgb[2];
  ok(
    'compressing a bright colour preserves its hue ratio exactly',
    Math.abs(hueRatio(brightGold) - hueRatio(compressedGold)) < 1e-9
  );
  ok('…and it is genuinely dimmer, not merely re-coloured', compressedGold[0] < brightGold[0]);
  // A NEUTRAL grey must compress to another neutral grey — no colour cast is
  // introduced by the compression itself.
  const greyOut = reinhardCeilingRgb([2, 2, 2], LUMA_709, C);
  ok(
    'a neutral input stays neutral',
    Math.abs(greyOut[0] - greyOut[1]) < 1e-9 && Math.abs(greyOut[1] - greyOut[2]) < 1e-9
  );

  // The near-zero branch must be a genuine PASS-THROUGH, not a divide that
  // happens to also land near zero — the TSL transcription takes the identical
  // branch (`shineLuma.lessThanEqual(1e-6).select(1, ...)`), and this is the
  // assertion that keeps the two from silently diverging at the edge.
  const tiny = [1e-8, 0.5e-8, 0];
  ok(
    'near-zero input passes through unchanged, not merely near-zero-output',
    reinhardCeilingRgb(tiny, LUMA_709, C).every((v, i) => v === tiny[i])
  );

  // ── TWO CEILINGS, NOT ONE — live-diagnosed 2026-07-27 ────────────────────
  // A single shared ceiling flattened genuine glint PEAKS to the same modest
  // level as the always-on base sheen, which is what "washed out instead of
  // intense" actually was: nothing was ever allowed to blow out the way a
  // real specular highlight does. The fix is not "raise the one ceiling" —
  // it is two ceilings, because sheen and glint are supposed to behave
  // differently on purpose.
  ok('the glint ceiling is genuinely higher than the sheen ceiling', SPECULAR_GLINT_CEILING > SPECULAR_SHEEN_CEILING);
  // The SAME raw value must compress FAR MORE under the sheen ceiling than
  // under the glint one — this is the property the split exists for, not
  // merely "two different numbers happen to be configured".
  const hotValue = 6;
  const sheenSide = reinhardCeiling(hotValue, SPECULAR_SHEEN_CEILING);
  const glintSide = reinhardCeiling(hotValue, SPECULAR_GLINT_CEILING);
  ok(
    'the same raw brightness reads far dimmer through the sheen ceiling than the glint one',
    sheenSide < glintSide * 0.6
  );
  // A genuinely bright GLINT must still be ALLOWED to reach bloom-worthy HDR
  // territory (well above 1.0) — that is the entire point of giving it its
  // own, much higher ceiling. If this regresses toward ~1, glints go back to
  // reading as a flat wash rather than as hot, sharp highlights.
  ok('a real glint peak still reaches clearly HDR territory (> 2)', reinhardCeiling(20, SPECULAR_GLINT_CEILING) > 2);
  // The sheen, by contrast, must stay MODEST even under a strong raw push —
  // it is the "always visible, never dramatic" base V2's own `1 +` structure
  // implies, not a second place for the effect to blow out. A raw 20 (already
  // clearly extreme input) must compress down to a SMALL fraction of the raw
  // value under the sheen's own low ceiling — not merely "less than infinity".
  ok(
    'the sheen compresses a strong push down to a small fraction of it',
    reinhardCeiling(20, SPECULAR_SHEEN_CEILING) / 20 < 0.08
  );

  // ══════════════════════════════════════════════════════════════════════
  // INCIDENT = EOTF(illum) — THE SELF-ILLUMINATION GUARD.
  // ══════════════════════════════════════════════════════════════════════
  // These are the AUTHOR'S OWN MEASURED NUMBERS (2026-07-27 channel probe),
  // asserted as BANDS against the scene's real rendered brightness rather than
  // as properties of a curve — `feedback_measure_the_output_not_the_equation`,
  // which this effect has now paid for twice. A curve that is "monotonic and
  // steepening" was ALREADY true of the 1.7 gamma this replaces, and metal
  // still glowed; only comparing against what the SCENE renders catches that.
  const eotf = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const oetf = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  /** What `environmental-light.js`'s composite ACTUALLY renders a surface at:
   * `lit = EOTF(OETF(albedo) x illum)`. The number metal must not exceed. */
  const sceneLitAt = (albedo, illum) => eotf(oetf(albedo) * illum);

  // The measured dark point: albedo 0.730, illum 0.188 — a genuinely unlit
  // room, where illum is NOT zero because Foundry bakes ambientDarkness in.
  const darkIllum = 0.188;
  const darkAlbedo = 0.73;
  const darkScene = sceneLitAt(darkAlbedo, darkIllum);
  const darkIncident = incidentFromIllumRgb([darkIllum, darkIllum, darkIllum])[0];

  // THE BUG, pinned: multiplying by RAW illum put metal far above its own
  // surroundings. This assertion fails if anyone reverts to the linear form.
  ok('RAW illum would render metal brighter than the surface it sits on (the bug)', darkIllum > darkScene * 2);
  // THE FIX: the transfer curve brings it into the scene's own range.
  ok('EOTF(illum) lands in the same order of magnitude as the lit scene', darkIncident < darkScene * 2);
  ok('…and is not crushed to nothing either — dim metal must still read as metal', darkIncident > darkScene * 0.5);
  // The 1.7 gamma that shipped and did NOT fix it, kept as a regression floor.
  ok('it is meaningfully darker than the 1.7 gamma that failed live', darkIncident < Math.pow(darkIllum, 1.7));

  // A genuinely LIT point (the author's measured 0.866) must be left nearly
  // alone — the fix must not be a global dimmer.
  const litIncident = incidentFromIllumRgb([0.866, 0.866, 0.866])[0];
  ok('a well-lit reading is barely touched (> 80% preserved)', litIncident > 0.866 * 0.8);
  ok('the curve is monotonic across the practical range', darkIncident < litIncident);
  ok(
    'true black stays exactly black — no artificial floor',
    incidentFromIllumRgb([0, 0, 0]).every((v) => v === 0)
  );
  ok(
    'the anchor at 1.0 is exactly 1.0 — full light is full light',
    Math.abs(incidentFromIllumRgb([1, 1, 1])[0] - 1) < 1e-9
  );

  // ══════════════════════════════════════════════════════════════════════
  // THE READABILITY-FLOOR SUBTRACTION — `specular-render.js`'s `uDarknessFloor`.
  // ══════════════════════════════════════════════════════════════════════
  // The author's OWN diagnosis, tested live: `MapShine.setDarknessRealism(1)`
  // made metal correctly read black. Root cause — Foundry never lets `illum`
  // reach 0 in an unlit room (it floors at `ambient.darkness`, this scene's
  // measured `[0.188]³`, for GM/player readability); EOTF alone still lets
  // that floor read as "some light" to reflect. The shader now computes
  // `EOTF(max(illum - darknessFloor, 0))` — this is that composition's CPU
  // twin, using the SAME `darknessFloor = ambient.darkness x (1-realism)`
  // `environmental-light.js#computeAmbientBackground` already defines.
  const withFloor = (illum, floor) => incidentFromIllumRgb(illum.map((c, i) => Math.max(c - floor[i], 0)));

  // Foundry-parity default (realism=0): floor EQUALS ambient.darkness, so a
  // point sitting exactly AT the floor (no torch, no window — pure readability
  // minimum) has ZERO excess. This is the assertion the author's live report
  // demands: darkness-floor-only metal must render with NO added brightness.
  const atFloorParity = withFloor([darkIllum, darkIllum, darkIllum], [darkIllum, darkIllum, darkIllum]);
  ok(
    'at the readability floor, in parity mode, incident is EXACTLY zero',
    atFloorParity.every((v) => v === 0)
  );

  // Realistic mode (realism=1): the floor collapses to (0,0,0), so this is a
  // PROVABLE NO-OP against the EOTF-only numbers already asserted above —
  // exactly why raising realism already looked correct to the author before
  // this fix existed, and why this fix cannot regress that tested behaviour.
  const atFloorRealistic = withFloor([darkIllum, darkIllum, darkIllum], [0, 0, 0]);
  ok(
    'at realism=1 the floor is a no-op — identical to EOTF alone, byte for byte',
    atFloorRealistic.every((v) => v === darkIncident)
  );

  // A REAL light source (a torch reading illum=0.6) in the SAME floored room
  // must still shine — the floor removes the readability minimum, never real
  // added light. This is the "subtract, don't gate" property: excess above
  // the floor is untouched by its presence.
  const torchIllum = 0.6;
  const litRoomFloor = withFloor([torchIllum, torchIllum, torchIllum], [darkIllum, darkIllum, darkIllum]);
  const litRoomNoFloor = incidentFromIllumRgb([torchIllum - darkIllum, torchIllum - darkIllum, torchIllum - darkIllum]);
  ok('a real light above the floor still produces real incident', litRoomFloor[0] > 0.05);
  ok(
    'and it matches EOTF of the excess exactly — the floor only ever subtracts',
    Math.abs(litRoomFloor[0] - litRoomNoFloor[0]) < 1e-9
  );

  // ⚠️ PER-CHANNEL IS CORRECT HERE, unlike the ceiling above. This curve is the
  // inverse of the OETF the albedo path already takes per channel, so a
  // coloured light must come through matching what the scene itself shows —
  // NOT hue-locked. Asserted so a future "consistency" pass does not
  // helpfully convert it to a luma scalar and desync it from the composite.
  const warm = incidentFromIllumRgb([0.9, 0.6, 0.3]);
  const sceneWarm = [0.9, 0.6, 0.3].map((c) => sceneLitAt(1, c));
  for (let i = 0; i < 3; i++) {
    ok(`channel ${i} matches the composite's own per-channel result exactly`, Math.abs(warm[i] - sceneWarm[i]) < 1e-9);
  }

  // ══════════════════════════════════════════════════════════════════════
  // STEEPEN INCIDENT — the ROUND 16 (2026-08-03) darkness-suppression gate.
  // ══════════════════════════════════════════════════════════════════════
  // Author's report: "we only get a specular shine in the brighter areas of
  // the map... Shadows and lack of light should suppress the specular
  // shine." This is a SEPARATE stage from `incidentFromIllumRgb` above —
  // that function must stay untouched (its own header explains why) — so
  // these assertions are about a DIFFERENT set of claims: the two anchors
  // hold for ANY steepness, the shape actually suppresses the middle of the
  // range, hue survives, and anything at or above full brightness is a
  // complete no-op.
  ok(
    'true black is still exactly black, for any steepness',
    steepenIncidentRgb([0, 0, 0], LUMA_709, SPECULAR_INCIDENT_STEEPNESS).every((v) => v === 0)
  );
  ok(
    'exactly full brightness is untouched, for any steepness',
    steepenIncidentRgb([1, 1, 1], LUMA_709, SPECULAR_INCIDENT_STEEPNESS).every((v) => Math.abs(v - 1) < 1e-9)
  );
  ok(
    'steepness = 1 is an identity — the old behaviour is a special case, not a separate code path',
    steepenIncidentRgb([0.42, 0.31, 0.05], LUMA_709, 1).every((v, i) => Math.abs(v - [0.42, 0.31, 0.05][i]) < 1e-9)
  );

  // THE ACTUAL ASK: a mid-range reading (a dim, ordinarily-lit room) must end
  // up MUCH smaller than it went in, at the shipped default.
  const dimRoom = steepenIncidentRgb([0.5, 0.5, 0.5], LUMA_709, SPECULAR_INCIDENT_STEEPNESS)[0];
  ok('a half-lit room is suppressed well below half', dimRoom < 0.25);
  ok('…but not gated to a hard zero — this is a curve, not a step (no Round 15 regression)', dimRoom > 0);

  // MONOTONIC: darker in stays darker out, across the whole suppressed range.
  const a = steepenIncidentRgb([0.3, 0.3, 0.3], LUMA_709, SPECULAR_INCIDENT_STEEPNESS)[0];
  const b = steepenIncidentRgb([0.6, 0.6, 0.6], LUMA_709, SPECULAR_INCIDENT_STEEPNESS)[0];
  const c = steepenIncidentRgb([0.9, 0.9, 0.9], LUMA_709, SPECULAR_INCIDENT_STEEPNESS)[0];
  ok('monotonic across the suppressed range', a < b && b < c);

  // ABOVE 1.0 (overlapping lights, a sunlit exterior): the excess is a pure
  // pass-through, never gated further — this only ever REMOVES shine from
  // dim areas, it does not also dim already-bright ones.
  const brightExterior = steepenIncidentRgb([1.4, 1.4, 1.4], LUMA_709, SPECULAR_INCIDENT_STEEPNESS)[0];
  ok(
    'above full brightness is untouched — the gate only ever suppresses dim areas',
    Math.abs(brightExterior - 1.4) < 1e-9
  );

  // HUE-PRESERVING: a coloured light's channel RATIOS survive exactly, the
  // same guarantee `reinhardCeilingRgb` makes and for the same reason — an
  // independent pow() per channel would oversaturate the weakest channel as
  // it dims, compounding the OTHER open complaint (colour fidelity) instead
  // of leaving it alone.
  const warmDim = steepenIncidentRgb([0.6, 0.4, 0.2], LUMA_709, SPECULAR_INCIDENT_STEEPNESS);
  ok(
    'channel ratios survive exactly — hue and saturation are untouched',
    Math.abs(warmDim[0] / warmDim[1] - 0.6 / 0.4) < 1e-9 && Math.abs(warmDim[1] / warmDim[2] - 0.4 / 0.2) < 1e-9
  );

  // A "sheen/glint contrast survives the tonemap at a well-lit interior
  // point" scenario lived here (2026-07-27 → 2026-08-31). RETIRED, not
  // silently deleted: `SPECULAR_INCIDENT_STEEPNESS` went to 200 (see this
  // file's own header), and at that steepness a well-lit-but-not-directly-lit
  // point (illum 0.866, this scenario's own test input) produces
  // `incidentAmt ≈ 4.8e-29` — sheen and glint both scale by that, so trough,
  // peak, and the unlit base luma all come out numerically identical. That's
  // not a contrast regression to chase; it's the new, author-confirmed
  // design: shine is now near-binary, meaningfully present only right next to
  // an actual light source, silent everywhere else. Live-confirmed
  // 2026-08-31 ("specular looks good with the 200 constant") — no scenario
  // like this one is meaningful to assert against any more, since "well-lit
  // ambient" and "unlit" now produce the same reading by design.
}
