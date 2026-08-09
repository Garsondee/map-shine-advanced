/**
 * THE SHADOW BAND PLAN — `effects/lighting/shadow-bands.js`.
 *
 * ============================================================================
 * WHAT THIS SUITE IS ACTUALLY GUARDING
 * ============================================================================
 * This is the module that turned a hand-tuned slider into a derivation, so the
 * failure mode it exists to catch is not "the arithmetic is wrong" — it is
 * "the derivation quietly stopped running and nobody could tell." Every case
 * below therefore asserts `source` as well as the numbers: a plan that returns
 * plausible heights via the FALLBACK path is exactly as wrong as one that
 * returns bad heights, and only `source` tells them apart
 * ([[feedback_seam_default_hides_unwired]]).
 *
 * THE ANCHOR CASE is the author's own map, by real numbers, not a synthetic
 * fixture ([[feedback_synthetic_fixture_invariant_is_not_authored_art]]):
 * River Town Bridge bands three floors 0-20 / 20-40 / 40-∞ on Foundry's
 * default 100px/5ft grid, i.e. `distancePixels = 20`. That makes one storey
 * exactly 400 world px — which is ALSO the number the author arrived at by eye
 * for `aboveHeightPx` before this derivation existed. If a change to this
 * module ever makes floor 0's band 0 stop being 400 on that input, the
 * derivation has stopped agreeing with the picture the author already approved.
 */
import { resolveShadowBandPlan, SHADOW_BAND_COUNT, SHADOW_BAND_LAYER_INDICES } from '../shadow-bands.js';

/** The author's own scene, verbatim (`tools/shader-lab/fixtures/tower-bridge.js`
 * carries the same three bands). `elevationTop: null` on the roof is Foundry's
 * own "+Infinity" convention, not missing data — the top floor is unbounded. */
const TOWER_BRIDGE = [
  { index: 0, elevationBottom: 0, elevationTop: 20 },
  { index: 1, elevationBottom: 20, elevationTop: 40 },
  { index: 2, elevationBottom: 40, elevationTop: null },
];
/** Foundry's default grid: 100 px per 5-unit square ⇒ 20 px per unit. */
const PX_PER_UNIT = 20;
const WALL_PX = 260;

const plan = (floors, receiverFloorIndex, extra = {}) =>
  resolveShadowBandPlan({
    floors,
    receiverFloorIndex,
    pxPerElevationUnit: PX_PER_UNIT,
    wallHeightPx: WALL_PX,
    fallbackAboveHeightPx: 400,
    ...extra,
  });

export function run(t) {
  const { ok } = t;

  // ── THE SHAPE OF THE CONTRACT ────────────────────────────────────────
  {
    const p = plan(TOWER_BRIDGE, 0);
    ok(
      `a plan always returns exactly SHADOW_BAND_COUNT heights (${p.heightsPx.length} of ${SHADOW_BAND_COUNT})`,
      p.heightsPx.length === SHADOW_BAND_COUNT
    );
    ok(
      'the band layer indices are inside the 4-layer stack and distinct',
      SHADOW_BAND_LAYER_INDICES.length === SHADOW_BAND_COUNT &&
        new Set(SHADOW_BAND_LAYER_INDICES).size === SHADOW_BAND_COUNT &&
        SHADOW_BAND_LAYER_INDICES.every((i) => i >= 0 && i < 4)
    );
  }

  // ── THE ANCHOR: the author's own three-floor map ─────────────────────
  {
    const ground = plan(TOWER_BRIDGE, 0);
    ok(`ground floor derives from elevation, not the slider (source: ${ground.source})`, ground.source === 'elevation');
    // Band 0 = "everything above floor 0", carrying its LOWEST member's own
    // elevation (floor 1, at 20 units = 400px). This is the number the author
    // hand-tuned to before the derivation existed — see this file's header.
    ok(
      `band 0 on the ground floor is exactly one storey, 400px (got ${ground.heightsPx[0]})`,
      ground.heightsPx[0] === 400
    );
    // Band 1 = "everything above floor 1", i.e. the roof — and being the LAST
    // band it carries the TOP of the stack, not its own member's floor level.
    // The roof declares no `elevation.top`, so the top is roof + wall height:
    // (40 × 20) + 260 = 1060.
    ok(
      `band 1 on the ground floor reaches the top of the stack, 1060px (got ${ground.heightsPx[1]})`,
      ground.heightsPx[1] === 1060
    );
    ok(
      'and it says the top came from the wall height, not a declared elevation.top',
      ground.topOfStackSource === 'wallHeight' && ground.topOfStackPx === 1060
    );
    ok('nothing was merged — every band on this map is exact', ground.mergedFloorsAbove === 0);

    // ⚠️ THE HEADLINE ASSERTION. The whole ask was "a several-storey building
    // casts a much longer shadow": the far band must actually be LONGER than
    // the near one, and longer than the single authored slider it replaced.
    ok(
      `the far band is materially longer than the near one (${ground.heightsPx[1]} > ${ground.heightsPx[0]})`,
      ground.heightsPx[1] > ground.heightsPx[0] * 2
    );

    const middle = plan(TOWER_BRIDGE, 1);
    // Only one floor above, so band 0 IS the last band and carries the top:
    // (40 + 13 − 20) × 20 = 660.
    ok(
      `the middle floor's one band reaches the stack top, 660px (got ${middle.heightsPx[0]})`,
      middle.heightsPx[0] === 660
    );
    ok('the middle floor has no second band', middle.heightsPx[1] === 0);

    const roof = plan(TOWER_BRIDGE, 2);
    ok(
      `the roof gets no bands and says WHY, without falling back to the slider (source: ${roof.source})`,
      roof.source === 'nothing-above' && roof.heightsPx.every((h) => h === 0)
    );
  }

  // ── HEIGHTS RISE MONOTONICALLY AS THE RECEIVER DESCENDS ──────────────
  // A shadow seen from further down must never be SHORTER than the same
  // caster's shadow seen from a floor above it. This is the band twin of the
  // model's own "occlusion can only decrease with distance" law, and it is the
  // property a sign error in `(memberElev − receiverElev)` would break silently
  // (the shadow would still render, just backwards).
  {
    const tops = [0, 1, 2].map((f) => plan(TOWER_BRIDGE, f).topOfStackPx);
    ok(
      `the stack top grows as the receiver descends (${tops.join(' < ')})`,
      tops[2] === 0 && tops[1] < tops[0] && tops[1] > 0
    );
  }

  // ── A DECLARED elevation.top IS READ, NOT IGNORED ────────────────────
  {
    const capped = [
      { index: 0, elevationBottom: 0, elevationTop: 20 },
      { index: 1, elevationBottom: 20, elevationTop: 35 },
    ];
    const p = plan(capped, 0);
    // One floor above ⇒ band 0 is the last band ⇒ it carries the top, and the
    // top is the DECLARED 35, not 20 + wallHeight.
    ok(`a declared elevation.top wins over the wall-height stand-in (${p.heightsPx[0]}px)`, p.heightsPx[0] === 700);
    ok('and the plan says which source it used', p.topOfStackSource === 'elevationTop');
  }
  {
    // A degenerate top (at or below its own bottom) must NOT be trusted — it
    // would hand the last band a height of 0 and switch the tallest shadow in
    // the scene off entirely.
    const degenerate = [
      { index: 0, elevationBottom: 0, elevationTop: 20 },
      { index: 1, elevationBottom: 20, elevationTop: 20 },
    ];
    const p = plan(degenerate, 0);
    ok(
      `a top equal to its own bottom falls back to the wall-height stand-in rather than zeroing the band (${p.heightsPx[0]}px)`,
      p.topOfStackSource === 'wallHeight' && p.heightsPx[0] === 660
    );
  }

  // ── MORE FLOORS THAN BANDS: the cap must be VISIBLE ──────────────────
  {
    const fiveFloors = [0, 1, 2, 3, 4].map((i) => ({
      index: i,
      elevationBottom: i * 20,
      elevationTop: i === 4 ? null : (i + 1) * 20,
    }));
    const p = plan(fiveFloors, 0);
    ok('a five-floor stack still derives from elevation', p.source === 'elevation');
    ok(`band 0 is still the nearest floor above (${p.heightsPx[0]}px)`, p.heightsPx[0] === 400);
    // Top of stack = (80 + 13) × 20 = 1860. Band 1 swallows floors 2, 3 and 4,
    // so two of them (floors 2 and 3) are smeared at a height that is not their
    // own — and the plan must SAY so rather than rounding quietly.
    ok(`band 1 reaches the real top of a five-floor stack (${p.heightsPx[1]}px)`, p.heightsPx[1] === 1860);
    ok(
      `the merge is reported, not silent (${p.mergedFloorsAbove} floors swallowed by the last band)`,
      p.mergedFloorsAbove === 2
    );
  }

  // ── THE FALLBACK PATH, AND WHY EVERY CASE NAMES ITSELF ───────────────
  {
    const single = [{ index: 0, elevationBottom: 0, elevationTop: null }];
    const p = plan(single, 0);
    ok(
      'a one-floor scene has nothing above and says so — it does NOT invent a phantom storey from the slider',
      p.source === 'nothing-above' && p.heightsPx[0] === 0
    );
  }
  {
    // The legacy single-background scene: a Level list exists but carries no
    // authored elevations at all. `null` is NOT 0 here — treating it as ground
    // level would make a real upper floor cast nothing.
    const noElevations = [
      { index: 0, elevationBottom: null, elevationTop: null },
      { index: 1, elevationBottom: null, elevationTop: null },
    ];
    const p = plan(noElevations, 0);
    ok(
      `no authored elevations falls back to the slider AND explains itself (${p.source}: ${p.reason})`,
      p.source === 'fallback' && p.heightsPx[0] === 400 && typeof p.reason === 'string' && p.reason.length > 0
    );
  }
  {
    const p = plan(TOWER_BRIDGE, 0, { pxPerElevationUnit: 0 });
    ok(
      `an unreadable grid scale falls back rather than producing zero-height bands (${p.source})`,
      p.source === 'fallback' && p.heightsPx[0] === 400
    );
  }
  {
    const p = plan(null, 0);
    ok(`no floor list at all falls back (${p.source})`, p.source === 'fallback' && p.heightsPx[0] === 400);
    const off = plan(TOWER_BRIDGE, 7);
    ok(`a receiver index off the end falls back rather than throwing (${off.source})`, off.source === 'fallback');
    const negative = plan(TOWER_BRIDGE, -1);
    ok('a negative receiver index falls back rather than throwing', negative.source === 'fallback');
  }
  {
    // Two Levels sharing one bottom elevation — an AUTHORING state, not a code
    // state. The derived height would be 0, which would switch the cast off;
    // the slider is the honest answer, and the reason must say what happened.
    const stacked = [
      { index: 0, elevationBottom: 20, elevationTop: null },
      { index: 1, elevationBottom: 20, elevationTop: null },
    ];
    const p = plan(stacked, 0, { wallHeightPx: 0 });
    ok(
      `floors sharing one elevation fall back instead of baking a zero-height band (${p.source})`,
      p.source === 'fallback' && p.heightsPx[0] === 400
    );
  }

  // ── TOTALITY: no input shape may throw, and no output may be NaN ─────
  // This runs inside a bake, and a bake that throws is a black map.
  {
    const hostile = [
      undefined,
      null,
      [],
      [{}],
      [{ elevationBottom: Number.NaN }, { elevationBottom: 10 }],
      [{ elevationBottom: 0 }, { elevationBottom: Number.POSITIVE_INFINITY }],
      [{ elevationBottom: 0 }, { elevationBottom: -50 }],
    ];
    let threw = null;
    let bad = null;
    for (const floors of hostile) {
      for (const receiver of [-1, 0, 1, 99, 1.5, Number.NaN]) {
        for (const px of [PX_PER_UNIT, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
          let p;
          try {
            p = resolveShadowBandPlan({
              floors,
              receiverFloorIndex: receiver,
              pxPerElevationUnit: px,
              wallHeightPx: WALL_PX,
              fallbackAboveHeightPx: 400,
            });
          } catch (err) {
            threw ??= `${JSON.stringify(floors)} / ${receiver} / ${px}: ${err?.message}`;
            continue;
          }
          if (
            p.heightsPx.length !== SHADOW_BAND_COUNT ||
            p.heightsPx.some((h) => !Number.isFinite(h) || h < 0) ||
            !Number.isFinite(p.topOfStackPx)
          ) {
            bad ??= `${JSON.stringify(floors)} / ${receiver} / ${px} -> ${JSON.stringify(p.heightsPx)}`;
          }
        }
      }
    }
    ok(`no input shape throws (${threw ?? 'none did'})`, threw === null);
    ok(`no input shape produces a NaN or negative height (${bad ?? 'none did'})`, bad === null);
  }
}
