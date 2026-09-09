/**
 * axis-derivation.test.mjs — the generic "authored wins outright, else blend
 * across a value-space band" shape, pinned independently of any one caller.
 * `weather-precip.test.mjs` still pins `derivePrecipKind`'s own behaviour
 * end-to-end after it delegates here — this file proves the generic half in
 * isolation, using a DIFFERENT domain (a made-up "haze" axis) so a bug that
 * only shows up away from precipitation's own specific numbers isn't missed.
 */
import { deriveBandedKind } from '../axis-derivation.js';

export function run(t) {
  const { ok } = t;

  const HAZE_KINDS = ['auto', 'clear', 'mist', 'fog'];
  const derive = (authored, value) =>
    deriveBandedKind({
      authored,
      autoSentinel: 'auto',
      validAuthored: HAZE_KINDS,
      value,
      coldEdge: 0.2,
      warmEdge: 0.6,
      coldKind: 'clear',
      midKind: 'mist',
      warmKind: 'fog',
      mixWeightForAuthored: (k) => (k === 'fog' ? 1 : 0),
    });

  // ---- the derived band, mirroring derivePrecipKind's own edge rules ------
  {
    ok('below the cold edge is the cold answer', derive('auto', 0.05).kind === 'clear');
    ok('above the warm edge is the warm answer', derive('auto', 0.9).kind === 'fog');
    ok('the middle of the band is the mid answer', derive('auto', 0.4).kind === 'mist');
    ok('the COLD edge is IN the band, not below it', derive('auto', 0.2).kind === 'mist');
    ok('the WARM edge is IN the band, not above it', derive('auto', 0.6).kind === 'mist');
    ok('mixWeight is 1 (fully cold) at the cold edge', Math.abs(derive('auto', 0.2).mixWeight - 1) < 1e-9);
    ok('mixWeight is 0 (fully warm) at the warm edge', Math.abs(derive('auto', 0.6).mixWeight) < 1e-9);
    ok('mixWeight is 0.5 at the midpoint of the band', Math.abs(derive('auto', 0.4).mixWeight - 0.5) < 1e-9);
    ok(
      'mixWeight decreases monotonically across the band',
      derive('auto', 0.25).mixWeight > derive('auto', 0.55).mixWeight
    );
    ok('pure cold reports mixWeight 1', derive('auto', 0).mixWeight === 1);
    ok('pure warm reports mixWeight 0', derive('auto', 1).mixWeight === 0);
  }

  // ---- authored wins outright ----------------------------------------------
  {
    ok(
      'an authored answer wins at any value',
      derive('clear', 0.95).kind === 'clear' && derive('fog', 0.0).kind === 'fog'
    );
    ok('an authored answer says so', derive('clear', 0.9).authored === true);
    ok('a derived answer says so too', derive('auto', 0.9).authored === false);
    ok('authored fog reports the caller-supplied mixWeight (1)', derive('fog', 0.9).mixWeight === 1);
    ok('authored mist (the mid answer) reports the DEFAULT mixWeight (0)', derive('mist', 0.9).mixWeight === 0);
  }

  // ---- an unrecognised authored value degrades to derived, never a crash --
  {
    ok('an authored value outside validAuthored falls through to the band', derive('nonsense', 0.05).kind === 'clear');
  }

  // ---- default mixWeightForAuthored, and no validAuthored list -------------
  {
    const noList = deriveBandedKind({
      authored: 'anything',
      value: 0.5,
      coldEdge: 0.2,
      warmEdge: 0.6,
      coldKind: 'a',
      midKind: 'b',
      warmKind: 'c',
    });
    ok(
      'with no validAuthored list, any non-sentinel authored value is pinned',
      noList.kind === 'anything' && noList.authored === true
    );
    ok('the default mixWeightForAuthored reports 0', noList.mixWeight === 0);

    const autoDefault = deriveBandedKind({
      authored: 'auto',
      value: 0.5,
      coldEdge: 0.2,
      warmEdge: 0.6,
      coldKind: 'a',
      midKind: 'b',
      warmKind: 'c',
    });
    ok(
      "'auto' (the default sentinel) always falls through to the band",
      autoDefault.kind === 'b' && autoDefault.authored === false
    );
  }

  // ---- zero-width band: value sits exactly at both (coincident) edges -----
  // Neither `value < coldEdge` nor `value > warmEdge` fires, so this falls
  // to the mid-band arithmetic, where `span <= 0` takes the documented 0.5
  // fallback — the exact shape `derivePrecipKind`'s own comment describes
  // for a degenerate band, preserved here rather than special-cased away.
  {
    const flat = deriveBandedKind({
      authored: 'auto',
      value: 0.5,
      coldEdge: 0.5,
      warmEdge: 0.5,
      coldKind: 'a',
      midKind: 'b',
      warmKind: 'c',
    });
    ok('a zero-width band reports the mid answer', flat.kind === 'b');
    ok('...with the documented 0.5 fallback weight (span <= 0)', flat.mixWeight === 0.5);
  }
}
