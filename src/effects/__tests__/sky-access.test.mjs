/**
 * THE SKY HANDLE — the outdoor light, asserted rather than described.
 *
 * As of 2026-07-23 the sky owns only the directional warm/cool COLOUR of the
 * outdoor light. The desaturation it used to attempt (the additive "veil") was
 * the wrong mechanism — a light cannot drain chroma — and now lives in the
 * environmental grade (`effects/grade/`, tested there). What is asserted here is
 * the one job that IS a light's: the key/fill colour split, and that it ships as
 * a mathematical no-op.
 */
import { createSkyHandle, lightGoldenTint, luminance } from '../sky-access.js';
// The real sun, for the continuity sweep — a test is exempt from `zones/one-door`
// and this is the ACTUAL input the handle receives in production.
import { computeSun } from '../../world/sun.js';
// The shadow system's OWN azimuth convention, imported so the agreement between
// a highlight and the shadow cast by the same sun is a MEASUREMENT, not a
// comment — see the block at the bottom of this file.
import { shadowOffsetDirection } from '../lighting/light-visibility.js';

/** A stand-in for `env.sun` at a given hour-ish position. */
const sunAt = (elevationDeg, { dayFactor01, skyFactor01, twilight01 = 0, azimuthDeg = 180 } = {}) => ({
  elevationDeg,
  azimuthDeg,
  dayFactor01: dayFactor01 ?? (elevationDeg > 6 ? 1 : 0),
  skyFactor01: skyFactor01 ?? (elevationDeg > 0 ? 1 : 0),
  twilight01,
});

const NOON = sunAt(60, { dayFactor01: 1, skyFactor01: 1 });
const DUSK = sunAt(0, { dayFactor01: 0.32, skyFactor01: 0.74, twilight01: 1 });
const NIGHT = sunAt(-40, { dayFactor01: 0, skyFactor01: 0 });

export function run(t) {
  const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

  // ======================================================================
  // PARITY MODE — the default must be a mathematical no-op, or it silently
  // destroys the pixel-identical-to-Foundry-at-noon property.
  // ======================================================================
  {
    for (const [name, sun] of [
      ['noon', NOON],
      ['dusk', DUSK],
      ['night', NIGHT],
    ]) {
      for (const cloud of [0, 0.5, 1]) {
        const sky = createSkyHandle({ sun, weather: { cloudCover01: cloud } });
        const m = sky.ambientMultiplierRgb;
        t.ok(`parity @${name} cloud=${cloud}: multiplier is exactly [1,1,1]`, m[0] === 1 && m[1] === 1 && m[2] === 1);
      }
    }
    t.ok('and it says so', createSkyHandle({ sun: NOON }).neutral === true);
    t.ok('a dialled-in handle does not', createSkyHandle({ sun: NOON, realism01: 1 }).neutral === false);
  }

  // ======================================================================
  // THE DIVISION OF LABOUR — the sky owns COLOUR, darkness owns LEVEL.
  // The multiplier is luminance-normalised: it rotates hue without changing
  // how bright the outdoor light is (that is darkness01's job). If this fails,
  // two systems own brightness and V2's four-colourists problem is back.
  // ======================================================================
  {
    for (const [name, sun] of [
      ['noon', NOON],
      ['dusk', DUSK],
    ]) {
      for (const cloud of [0, 0.4, 1]) {
        const sky = createSkyHandle({ sun, weather: { cloudCover01: cloud }, realism01: 1 });
        // The tint mixes toward chromaOnly (unit luminance) and [1,1,1] (unit
        // luminance), so the result's luminance stays ≈1 — a pure hue rotation,
        // never a dimming. (Small drift is the mix of two unit-luma endpoints
        // through a non-linear space; it must stay tiny.)
        t.ok(
          `@${name} cloud=${cloud}: the multiplier does not change light LEVEL`,
          close(luminance(sky.ambientMultiplierRgb), 1, 0.05)
        );
      }
    }
  }

  // ======================================================================
  // NO DESATURATION HERE — the sky is a LIGHT, and a light cannot drain chroma.
  // The overcast greying is the environmental grade's job now (tested in
  // effects/grade/). What the sky STILL does is the key/fill colour split.
  // ======================================================================
  {
    // The author's "increase saturation during cloudless middays" starts as the
    // key/fill COLOUR SPLIT — a warm key against a cool fill. Assert the split
    // itself; the grade turns it into visible saturation downstream.
    const sky = createSkyHandle({ sun: NOON, weather: { cloudCover01: 0 }, realism01: 1 });
    const keyWarmth = sky.key.colorRgb[0] - sky.key.colorRgb[2];
    const fillCoolness = sky.fill.colorRgb[2] - sky.fill.colorRgb[0];
    t.ok('a clear noon key is warm (more red than blue)', keyWarmth > 0);
    t.ok('a clear noon fill is cool (more blue than red)', fillCoolness > 0);

    const overcastSky = createSkyHandle({ sun: NOON, weather: { cloudCover01: 1 }, realism01: 1 });
    const overcastSplit =
      Math.abs(overcastSky.key.colorRgb[0] - overcastSky.key.colorRgb[2]) +
      Math.abs(overcastSky.fill.colorRgb[2] - overcastSky.fill.colorRgb[0]);
    t.ok('overcast collapses the key/fill colour split', overcastSplit < keyWarmth + fillCoolness);
  }

  // ======================================================================
  // TIME OF DAY — "subtle recoloration based on time of day", as one curve.
  // ======================================================================
  {
    const noon = createSkyHandle({ sun: NOON, realism01: 1 });
    const dusk = createSkyHandle({ sun: DUSK, realism01: 1 });
    const warmthOf = (h) => h.key.colorRgb[0] - h.key.colorRgb[2];
    t.ok('the key is warmer at dusk than at noon', warmthOf(dusk) > warmthOf(noon));

    // Continuity: the sky must not pop anywhere in the day. A branchy colour
    // model is how a scene snaps hue at sunrise.
    //
    // Swept over the REAL `computeSun`, not the step-function stub above — the
    // first version of this test used the stub and "failed", but the jump was
    // the FIXTURE's (`dayFactor01: elevation > 6 ? 1 : 0`), not the sky's. A
    // continuity test against a discontinuous input proves nothing; against the
    // actual production input it proves the thing that matters.
    // Measured as a RATE (change per game-hour) rather than a per-step delta,
    // so the number means something on its own and the assertion does not
    // silently change strength if anyone edits the step size.
    const STEP_H = 0.01;
    let maxRatePerHour = 0;
    for (let h = 0; h < 24; h += STEP_H) {
      const a = createSkyHandle({ sun: computeSun(h), realism01: 1 }).ambientMultiplierRgb;
      const b = createSkyHandle({ sun: computeSun(h + STEP_H), realism01: 1 }).ambientMultiplierRgb;
      const jump = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
      maxRatePerHour = Math.max(maxRatePerHour, jump / STEP_H);
    }
    // Measured worst: ~0.77/hour at dusk until the golden-hour grade (2026-10-27,
    // "strong and exagerated") — that now swings neutral→deep orange across the
    // hour the sun climbs through −6°…+2°, ~2.6/hour at its steepest. A smooth
    // ramp, not a pop: the bug this guards read ~100/hour, so the bound still
    // sits two orders of magnitude under it.
    t.ok('the sky colour never lurches — no hue pop anywhere in the real day', maxRatePerHour < 4);
  }

  // GOLDEN HOUR (2026-10-27) — independent of realism01, off at noon, orange at dusk.
  {
    const noon = createSkyHandle({ sun: NOON, goldenHour01: 1 });
    t.ok(
      'golden grade is a no-op at noon even with the lever up',
      noon.neutral === true && noon.ambientMultiplierRgb.every((v) => v === 1)
    );
    const gold = createSkyHandle({ sun: computeSun(18 - 0.4), realism01: 0 });
    const m = gold.ambientMultiplierRgb;
    // (2× since GOLDEN_EFFECT_SCALE took the grade 20% down, 2026-10-28 — it was 2.5× at full strength.)
    t.ok(
      `golden hour is strongly warm WITHOUT the realism lever (R/B ×${(m[0] / m[2]).toFixed(2)})`,
      m[0] > m[2] * 2 && gold.neutral === false
    );
    // 2026-10-27 ("Golden hour in general is too bright"): low sun is weaker as
    // well as warmer — the one level term the sky owns (GOLDEN_LEVEL).
    t.ok('⭐ golden light is DIMMER than noon, not just warmer', luminance(m) < 0.85 && luminance(m) > 0.6);
    t.ok('…and its red channel is no longer blown far past noon', m[0] < 1.35);
    const off = createSkyHandle({ sun: computeSun(18 - 0.4), realism01: 0, goldenHour01: 0 });
    t.ok('the golden lever at 0 turns it fully off', off.neutral === true);
  }

  // THE AFTERGLOW → BLUE HOUR (2026-10-27, "immediately after golden hour the
  // colouration returns to normal long before it gets dark"). Sweep dusk from
  // golden hour to full dark: while the sky still gives light, the outdoor light
  // must never fall back to plain neutral white.
  {
    let worstNeutral = Infinity;
    let worstAt = null;
    for (let h = 18; h < 19.3; h += 0.02) {
      const sun = computeSun(h);
      if (sun.skyFactor01 < 0.25) break; // darkness past 0.75: night owns it from here
      const m = createSkyHandle({ sun }).ambientMultiplierRgb;
      const chroma = Math.max(...m) - Math.min(...m);
      if (chroma < worstNeutral) {
        worstNeutral = chroma;
        worstAt = h;
      }
    }
    t.ok(
      `⭐ no white-light gap between sunset and dark (least chroma ${worstNeutral.toFixed(2)} at ${worstAt?.toFixed(2)})`,
      worstNeutral > 0.25
    );
    const rose = createSkyHandle({ sun: computeSun(18 + 0.15) }).ambientMultiplierRgb;
    const blue = createSkyHandle({ sun: computeSun(18 + 0.7) }).ambientMultiplierRgb;
    t.ok('just after sunset the light is rose/warm', rose[0] > rose[1]);
    t.ok('deeper into twilight it is the blue hour', blue[2] > blue[0] * 1.4);
    t.ok(
      'the afterglow rides the Golden lever',
      createSkyHandle({ sun: computeSun(18.7), goldenHour01: 0 }).neutral === true
    );
    t.ok('and is gone at noon', createSkyHandle({ sun: NOON }).neutral === true);
  }

  // MOONLIGHT (2026-10-27) — an option, off by default, night-only, cool.
  {
    const night = computeSun(0);
    t.ok(
      'moonlight is off by default',
      createSkyHandle({ sun: night }).moonAddRgb.every((v) => v === 0)
    );
    const moon = createSkyHandle({ sun: night, moonlight01: 1 });
    t.ok('moonlight adds a cool light at night', moon.moonAddRgb[2] > moon.moonAddRgb[0] && moon.moonAddRgb[2] > 0.1);
    t.ok('and cools the outdoor multiplier', moon.ambientMultiplierRgb[2] > moon.ambientMultiplierRgb[0]);
    t.ok(
      'but never at noon',
      createSkyHandle({ sun: NOON, moonlight01: 1 }).moonAddRgb.every((v) => v === 0)
    );
  }

  {
    // Cloud kills the key light. That is what "overcast" means, and the shadow
    // handle's own cloud softening depends on the same fact.
    const clear = createSkyHandle({ sun: NOON, weather: { cloudCover01: 0 }, realism01: 1 });
    const overcast = createSkyHandle({ sun: NOON, weather: { cloudCover01: 1 }, realism01: 1 });
    t.ok('cloud kills the key', close(overcast.key.strength, 0, 1e-9) && clear.key.strength > 0.9);
    t.ok('cloud RAISES the fill — an overcast sky is a softbox', overcast.fill.strength > clear.fill.strength);
  }

  // ======================================================================
  // ONE SKY — the shadow character must come from the same object, not a
  // second derivation (env/one-sun's failure, re-run in the colour domain).
  // ======================================================================
  {
    const sky = createSkyHandle({ sun: DUSK, weather: { cloudCover01: 0.8 }, realism01: 1 });
    t.ok('the handle carries the shadow atmosphere', typeof sky.shadow?.softnessMul === 'number');
    t.ok('cloudy dusk shadows are soft', sky.shadow.softnessMul > 2);
    t.ok('and faint', sky.shadow.strengthMul < 0.5);
    t.ok(
      'the key points along the SAME azimuth the shadows use',
      close(sky.key.azimuthDeg, sky.shadow.azimuthDeg, 1e-9)
    );
  }

  // ======================================================================
  // ROBUSTNESS — a broken input must read as neutral, never as NaN reaching
  // a shader uniform.
  // ======================================================================
  {
    const finite = (rgb) => rgb.every((c) => Number.isFinite(c));
    for (const [name, spec] of [
      ['no arguments at all', {}],
      ['null sun', { sun: null, realism01: 1 }],
      ['garbage sun', { sun: { elevationDeg: NaN, dayFactor01: 'x', skyFactor01: undefined }, realism01: 1 }],
      ['garbage weather', { sun: NOON, weather: { cloudCover01: NaN }, realism01: 1 }],
      ['garbage realism', { sun: NOON, realism01: NaN }],
      ['dead of night, no light at all', { sun: NIGHT, realism01: 1 }],
    ]) {
      const sky = createSkyHandle(spec);
      t.ok(`${name}: multiplier is finite`, finite(sky.ambientMultiplierRgb));
      t.ok(`${name}: key direction is finite`, Number.isFinite(sky.key.dirX) && Number.isFinite(sky.key.dirY));
    }
    t.ok('an out-of-range realism clamps', createSkyHandle({ sun: NOON, realism01: 9 }).realism01 === 1);
    t.ok('the handle is frozen — a call sheet, not a scratchpad', Object.isFrozen(createSkyHandle({})));
    t.ok('version rides along for cache invalidation', createSkyHandle({ version: 7 }).version === 7);
  }

  {
    // Night has no sky light to have a colour. The multiplier must fall back to
    // neutral rather than dividing by zero — the scene is already dark by then,
    // and darkness owns that, not this.
    const sky = createSkyHandle({ sun: NIGHT, weather: { cloudCover01: 0.5 }, realism01: 1 });
    t.ok('a lightless sky gives a neutral multiplier', close(luminance(sky.ambientMultiplierRgb), 1, 1e-6));
  }

  {
    // ── A HIGHLIGHT MAY NEVER POINT AWAY FROM ITS OWN SHADOW ──────────────
    //
    // `key.dirX/dirY` carried that promise in a COMMENT from the day it was
    // written, and broke it in the same breath: it was `(cos az, sin az)`
    // while `shadowOffsetDirection` — the live, on-screen-verified one — is
    // `(−sin az, cos az)`, a 90° rotation plus a reflection apart. It never
    // rendered wrong because until `effects/specular`'s sun glint it had no
    // consumer at all, which is exactly how a latent convention bug survives:
    // nothing exercises it, so nothing contradicts the comment.
    //
    // These assertions are the mechanism the comment was standing in for. A
    // future refactor that re-derives either side independently fails HERE,
    // in Node, rather than on a map where the sun glints on the north face of
    // a building whose shadow falls east.
    let opposed = true;
    let unit = true;
    for (let az = 0; az < 360; az += 15) {
      const k = createSkyHandle({ sun: sunAt(45, { azimuthDeg: az }) }).key;
      const away = shadowOffsetDirection(az);
      // Exactly antiparallel: the key direction points TOWARD the light, the
      // shadow offset points AWAY from it. Dot product must be −1.
      if (!close(k.dirX * away.x + k.dirY * away.y, -1, 1e-9)) opposed = false;
      if (!close(Math.hypot(k.dirX, k.dirY), 1, 1e-9)) unit = false;
    }
    t.ok('the key direction is exactly OPPOSITE the shadow throw, at every azimuth', opposed);
    t.ok('…and stays a unit vector all the way round', unit);
  }

  // ======================================================================
  // A POINT LIGHT'S AMBIENT TONES CARRY THE GOLDEN TINT (author, 2026-10-27:
  // fire light "bleaching the colour of light towards white" at golden hour).
  // ======================================================================
  {
    const m = [1.6, 0.8, 0.3];
    const near = (a, b) => a.every((v, i) => close(v, b[i]));
    t.ok(
      'golden hour, open sky: the light carries the full sky multiplier',
      near(lightGoldenTint({ multiplierRgb: m, golden01: 0.8, outdoors01: 1 }), m)
    );
    t.ok('indoors: nothing to apply', lightGoldenTint({ multiplierRgb: m, golden01: 0.8, outdoors01: 0 }) === null);
    t.ok(
      'not golden hour (noon, night): nothing to apply',
      lightGoldenTint({ multiplierRgb: m, golden01: 0, outdoors01: 1 }) === null
    );
    t.ok(
      'a doorway blends halfway',
      near(lightGoldenTint({ multiplierRgb: m, golden01: 0.8, outdoors01: 0.5 }), [1.3, 0.9, 0.65])
    );
    t.ok(
      'malformed input never yields NaN',
      lightGoldenTint({ multiplierRgb: [NaN, 1, 1], golden01: 1 }) === null && lightGoldenTint() === null
    );
    const sky = createSkyHandle({ sun: { ...DUSK, golden01: 1 }, weather: { cloudCover01: 0 }, realism01: 0 });
    const tint = lightGoldenTint({ multiplierRgb: sky.ambientMultiplierRgb, golden01: sky.golden01, outdoors01: 1 });
    t.ok('the real golden grade yields a warm tint (red above blue)', tint !== null && tint[0] > tint[2] * 2);
  }
}
