/**
 * Node verification for effects/precipitation/precip-glint.js: the pure maths of
 * the rain streaks' gradient-line glint (mmp-row). The shader evaluates the
 * same formulas from the same constants (precip-runtime.js `vGlint`), so what
 * is pinned here is the behaviour the brief asks for: lit near a light, nothing
 * by day, nothing when switched off, brightest toward the light, tinted by it,
 * varied per streak.
 */
import * as G from '../precip-glint.js';
import { PRECIPITATION_PARAMS } from '../precipitation.js';
import { PRECIP_SPECIES } from '../precip-species.js';

export function run(t) {
  const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
  const NIGHT_AMBIENT = [0.19, 0.19, 0.19];
  const DAY_AMBIENT = [1, 1, 1];
  // A torch's pool: warm, strong at one end of the streak, weaker at the other.
  const TORCH_NEAR = [0.95, 0.7, 0.4];
  const TORCH_FAR = [0.4, 0.3, 0.22];

  const base = {
    headRgb: TORCH_NEAR,
    tailRgb: TORCH_FAR,
    ambientRgb: NIGHT_AMBIENT,
    dayFactor01: 0,
    bodyHash: 0,
    phaseHash: 0.3,
    timeSec: 1.7,
    variation: 0, // steady, so assertions about the light are not entangled with the twinkle
  };

  // ---- settings exist with the stated defaults ------------------------------
  {
    const e = PRECIPITATION_PARAMS.rainLightEnabled;
    const s = PRECIPITATION_PARAMS.rainLightStrength;
    const g = PRECIPITATION_PARAMS.rainGlint;
    t.ok('rainLightEnabled: a bool, default ON', e?.type === 'bool' && e.default === true);
    t.ok(
      'rainLightStrength: a 0..2 float, default = the designed strength',
      s?.type === 'float' && s.min === 0 && s.max === 2 && s.default === G.GLINT_DEFAULT_STRENGTH
    );
    t.ok(
      'rainGlint: a 0..1 float, default = the designed variation',
      g?.type === 'float' && g.min === 0 && g.max === 1 && g.default === G.GLINT_DEFAULT_VARIATION
    );
    t.ok(
      'the three dials are in the Light category',
      [e, s, g].every((d) => d.category === 'Light')
    );
  }
  t.ok(
    'only the rain row opts into the glint',
    Object.entries(PRECIP_SPECIES).every(([id, s]) => !!s.light.glint === (id === 'rain'))
  );

  // ---- lit amount ------------------------------------------------------------
  t.ok('no excess light => not lit', G.litAmount(0, 0.19) === 0);
  t.ok('noise-level excess => not lit', G.litAmount(0.005, 0.19) === 0);
  t.ok('a strong light => fully lit', near(G.litAmount(2, 0.19), 1));
  {
    let prev = -1;
    let monotone = true;
    for (let x = 0; x <= 1; x += 0.05) {
      const v = G.litAmount(x, 0.19);
      if (v < prev) monotone = false;
      prev = v;
    }
    t.ok('lit amount never falls as the light grows (falloff follows the buffer)', monotone);
  }
  t.ok('a bright twilight ambient does not turn a sliver of excess into a glint', G.litAmount(0.05, 0.95) < 0.2);

  // ---- daylight fade ---------------------------------------------------------
  t.ok('full night => full strength', G.nightFade(0) === 1);
  t.ok('full day => zero', G.nightFade(1) === 0);
  t.ok('dusk is a ramp, not a switch', G.nightFade(0.75) > 0 && G.nightFade(0.75) < 1);

  // ---- where the core sits ---------------------------------------------------
  t.ok('flat light => the middle of the streak', near(G.glintPeak(0.3, 0.3), 0.5));
  t.ok('light nearer the head => core shifts toward the head', G.glintPeak(0.5, 0.2) > 0.5);
  t.ok('light nearer the tail => core shifts toward the tail', G.glintPeak(0.2, 0.5) < 0.5);
  t.ok('the core never leaves the streak (0.1..0.9)', near(G.glintPeak(5, 0), 0.9) && near(G.glintPeak(0, 5), 0.1));
  t.ok('no light at all => the middle, not NaN', near(G.glintPeak(0, 0), 0.5));

  // ---- the gradient along the line ------------------------------------------
  {
    const peak = 0.7;
    t.ok('the profile is 1 at the core', near(G.glintProfile(peak, peak), 1));
    t.ok(
      'it tapers toward both ends',
      G.glintProfile(0, peak) < G.glintProfile(0.4, peak) && G.glintProfile(1, peak) < G.glintProfile(0.85, peak)
    );
    t.ok('it is brighter on the side of the light', G.glintProfile(0.9, peak) > G.glintProfile(0.1, peak));
    t.ok(
      'it stays within 0..1',
      [0, 0.25, 0.5, 0.75, 1].every((x) => G.glintProfile(x, peak) >= 0 && G.glintProfile(x, peak) <= 1)
    );
    t.ok('it falls to exactly 0 beyond its half-width', G.glintProfile(peak + G.PROFILE_HALF_WIDTH + 0.01, peak) === 0);
    // monotone fall-off away from the core (a gradient, not a flat band)
    let ok = true;
    for (let d = 0; d < 0.6; d += 0.05)
      if (G.glintProfile(peak - d - 0.05, peak) > G.glintProfile(peak - d, peak)) ok = false;
    t.ok('and falls monotonically away from the core', ok);
  }

  // ---- tint ------------------------------------------------------------------
  {
    const warm = G.glintTint(0.8, 0.5, 0.2);
    t.ok(
      'the brightest channel of a light is the brightest of the tint',
      warm[0] === 1 && warm[0] > warm[1] && warm[1] > warm[2]
    );
    t.ok('the light colour tints the glint (warm light => red > blue)', warm[0] > warm[2]);
    t.ok(
      'the tint is eased toward white, never black',
      warm.every((v) => v >= G.TINT_WHITE_MIX - 1e-12)
    );
    t.ok(
      'no light => white',
      G.glintTint(0, 0, 0).every((v) => near(v, G.TINT_WHITE_MIX))
    );
  }

  // ---- per-streak variation and twinkle -------------------------------------
  {
    const gains = [];
    for (let i = 0; i < 40; i++) gains.push(G.glintGain(i / 40, (i * 0.37) % 1, 3.1, 0.6));
    t.ok('with variation, streaks do not all glint alike', Math.max(...gains) - Math.min(...gains) > 0.3);
    t.ok(
      'variation 0 => exactly 1 for every streak at every time',
      [0, 0.3, 0.9].every((b) => [0, 1.3, 77.7].every((s) => G.glintGain(b, 0.4, s, 0) === 1))
    );
    const over = [];
    for (let s = 0; s < 4; s += 0.05) over.push(G.glintGain(0.2, 0.5, s, 0.6));
    t.ok('a streak twinkles over time', Math.max(...over) - Math.min(...over) > 0.2);
    t.ok(
      'the twinkle is bounded (never negative, never blown out)',
      [...gains, ...over].every((g) => g >= 0 && g <= 1.6)
    );
    t.ok('the twinkle is deterministic', G.glintGain(0.3, 0.6, 5.5, 0.6) === G.glintGain(0.3, 0.6, 5.5, 0.6));
  }

  // ---- the whole vertex-stage result ----------------------------------------
  {
    const lit = G.glintVarying(base);
    t.ok("at night in a torch's pool a streak glints", lit.amount > 0.3);
    t.ok("and the glint is the torch's colour (warm)", lit.rgb[0] > lit.rgb[2]);
    t.ok('and its core sits toward the end nearer the light (head)', lit.peak > 0.5);
    t.ok(
      'the reverse streak glints at the other end',
      G.glintVarying({ ...base, headRgb: TORCH_FAR, tailRgb: TORCH_NEAR }).peak < 0.5
    );

    const farther = G.glintVarying({ ...base, headRgb: [0.3, 0.25, 0.2], tailRgb: [0.25, 0.2, 0.2] });
    t.ok('further from the light the glint is weaker', farther.amount < lit.amount);

    const dark = G.glintVarying({ ...base, headRgb: NIGHT_AMBIENT, tailRgb: NIGHT_AMBIENT });
    t.ok(
      'outside any light (illum = ambient) the rain is untouched: exact zeros',
      dark.amount === 0 && dark.rgb.every((v) => v === 0)
    );

    const day = G.glintVarying({ ...base, dayFactor01: 1 });
    t.ok('in full daylight the rain is untouched: exact zeros', day.amount === 0 && day.rgb.every((v) => v === 0));
    const dayAmbient = G.glintVarying({ ...base, ambientRgb: DAY_AMBIENT, headRgb: [1, 1, 1], tailRgb: [1, 1, 1] });
    t.ok(
      'and a daylit scene (illum = ambient = 1) is untouched even if the day factor were wrong',
      dayAmbient.amount === 0
    );

    const off = G.glintVarying({ ...base, enabled: false });
    t.ok("with the switch off the output is today's: exact zeros", off.amount === 0 && off.rgb.every((v) => v === 0));
    const zero = G.glintVarying({ ...base, strength: 0 });
    t.ok(
      "with the strength at 0 the output is today's: exact zeros",
      zero.amount === 0 && zero.rgb.every((v) => v === 0)
    );

    const unit = G.glintVarying({ ...base, strength: 1 });
    const strong = G.glintVarying({ ...base, strength: 2 });
    t.ok('the strength dial scales the glint', near(strong.amount, unit.amount * 2, 1e-9));

    const dusk = G.glintVarying({ ...base, dayFactor01: 0.75 });
    t.ok('dusk glints less than night, more than day', dusk.amount < lit.amount && dusk.amount > 0);

    // The default dial values, with the default twinkle, still produce a visible glint for most streaks.
    let visible = 0;
    for (let i = 0; i < 100; i++) {
      const g = G.glintVarying({
        ...base,
        variation: G.GLINT_DEFAULT_VARIATION,
        bodyHash: i / 100,
        phaseHash: (i * 0.618) % 1,
      });
      if (g.amount > 0.15) visible++;
    }
    t.ok('with the defaults most lit streaks visibly glint (tunable-free)', visible > 70);
  }
}
