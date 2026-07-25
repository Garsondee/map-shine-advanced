/**
 * shadow-access.test.mjs — THE SHADOW HANDLE's atmospheric model.
 *
 * The load-bearing assertions here are the MONOTONICITY claims the module's own
 * header makes in prose: more cloud ⇒ softer AND fainter; lower sun ⇒ longer
 * AND softer; night ⇒ fainter than day; night-under-cloud ⇒ the softest and
 * faintest case of all. Those are the author's stated requirements
 * ("sharper when there are no clouds, softer as cloud increases... during night
 * shadows will be softer too and softest if there are clouds") — asserted here
 * rather than promised in a comment.
 *
 * The projection maths itself (`projectShadowOffset`/`shadowPenumbraPx`) is
 * already covered by the UI-shadow's own suite; this pins that the handle wires
 * it up correctly and layers the atmosphere on top in the right direction.
 */
import {
  createShadowHandle,
  shadowAtmosphere,
  CLOUD_SURVIVING_STRENGTH,
  maxThrowForHeightPx,
  MAX_THROW_HEIGHT_RATIO,
} from '../shadow-access.js';
import { softenThrowPx, projectShadowOffset } from '../lighting/light-visibility.js';

/** A caster ~a tree's height, so offsets/penumbrae are comfortably non-zero. */
const TREE = { heightPx: 70 };

/** Noon: sun high. `world/sun.js` gives elevation 60 / azimuth 180 at hour 12. */
const NOON = { elevationDeg: 60, azimuthDeg: 180, dayFactor01: 1 };
/** Dawn: sun on the horizon. Hour ~6 ⇒ elevation ~0, and dayFactor eased low. */
const DAWN = { elevationDeg: 4, azimuthDeg: 90, dayFactor01: 0.62 };
/** Night: sun well below the horizon, day factor fully out. */
const NIGHT = { elevationDeg: -40, azimuthDeg: 0, dayFactor01: 0 };

const CLEAR = { cloudCover01: 0 };
const OVERCAST = { cloudCover01: 1 };

export function run(t) {
  const { ok } = t;

  const cast = (sun, weather, caster = TREE) => createShadowHandle({ sun, weather }).forCaster(caster);

  // --- CLOUD: softer AND fainter, independently ----------------------------
  {
    const clear = cast(NOON, CLEAR);
    const cloudy = cast(NOON, OVERCAST);
    ok('overcast softens the edge (bigger penumbra than clear sky)', cloudy.penumbraPx > clear.penumbraPx);
    ok('overcast fades the shadow (weaker than clear sky)', cloudy.strength01 < clear.strength01);
    ok(
      'overcast does NOT extinguish the shadow entirely (a faint darkening survives)',
      cloudy.strength01 > 0 && cloudy.strength01 >= clear.strength01 * CLOUD_SURVIVING_STRENGTH * 0.99
    );
    ok(
      'cloud does not move the shadow — softening and throwing are independent',
      Math.abs(cloudy.offsetPx - clear.offsetPx) < 1e-9
    );
  }

  // --- CLOUD is monotonic across the whole range, not just at the ends -----
  {
    let prevPen = -Infinity;
    let prevStr = Infinity;
    let monotonic = true;
    for (const c of [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1]) {
      const s = cast(NOON, { cloudCover01: c });
      if (!(s.penumbraPx > prevPen) || !(s.strength01 < prevStr)) monotonic = false;
      prevPen = s.penumbraPx;
      prevStr = s.strength01;
    }
    ok('cloud softens/fades monotonically across the full 0..1 range', monotonic);
  }

  // --- SUN ELEVATION: dawn elongates AND softens (both EMERGENT, not coded) -
  {
    const noon = cast(NOON, CLEAR);
    const dawn = cast(DAWN, CLEAR);
    ok('a low (dawn) sun throws the shadow further than a high (noon) one', dawn.offsetPx > noon.offsetPx);
    ok('a low (dawn) sun also softens the edge (grazing light)', dawn.penumbraPx > noon.penumbraPx);
  }

  // --- NIGHT: fainter than day, and softer -------------------------------
  {
    const day = cast(NOON, CLEAR);
    const night = cast(NIGHT, CLEAR);
    ok('night is fainter than day', night.strength01 < day.strength01);
    ok('night is softer than day', night.penumbraPx > day.penumbraPx);
    ok('night still casts SOMETHING (moon/skyglow floor, never a hard cut to zero)', night.strength01 > 0);
  }

  // --- THE STATED ORDERING: night-under-cloud is the extreme --------------
  {
    const dayClear = cast(NOON, CLEAR);
    const dayCloud = cast(NOON, OVERCAST);
    const nightClear = cast(NIGHT, CLEAR);
    const nightCloud = cast(NIGHT, OVERCAST);
    ok(
      'night+cloud is the SOFTEST case (softer than night alone and than cloud alone)',
      nightCloud.penumbraPx > nightClear.penumbraPx && nightCloud.penumbraPx > dayCloud.penumbraPx
    );
    ok(
      'night+cloud is the FAINTEST case (fainter than night alone and than cloud alone)',
      nightCloud.strength01 < nightClear.strength01 && nightCloud.strength01 < dayCloud.strength01
    );
    ok('clear noon is the sharpest case of the four', dayClear.penumbraPx < nightCloud.penumbraPx);
  }

  // --- THE TWO PER-CASTER KNOBS, and what each is allowed to touch ---------
  {
    const tall = cast(NOON, CLEAR, { heightPx: 70 });
    const short = cast(NOON, CLEAR, { heightPx: 16 });
    ok('a taller caster throws its shadow further', tall.offsetPx > short.offsetPx);
    ok('a taller caster ALSO has a softer shadow (one property, two behaviours)', tall.penumbraPx > short.penumbraPx);

    // offsetScale is the deliberately-decoupled cosmetic knob: throw only.
    const near = cast(NOON, CLEAR, { heightPx: 70, offsetScale: 1 });
    const far = cast(NOON, CLEAR, { heightPx: 70, offsetScale: 3 });
    ok('offsetScale throws the shadow further', far.offsetPx > near.offsetPx);
    ok(
      'offsetScale does NOT change softness (throw and blur stay decoupled)',
      Math.abs(far.penumbraPx - near.penumbraPx) < 1e-9
    );
  }

  // --- direction actually follows the sun's azimuth -----------------------
  {
    const fromSouth = cast({ ...NOON, azimuthDeg: 180 }, CLEAR);
    const fromNorth = cast({ ...NOON, azimuthDeg: 0 }, CLEAR);
    ok(
      'the shadow direction flips when the sun moves to the opposite azimuth',
      Math.sign(fromSouth.offsetY) === -Math.sign(fromNorth.offsetY) && Math.abs(fromSouth.offsetY) > 1e-6
    );
  }

  // --- the handle's own shape (mirrors wind-access's contract) ------------
  {
    const h = createShadowHandle({ version: 4, sun: NOON, weather: CLEAR });
    ok('handle is frozen (a new sky makes a NEW handle, never a mutated one)', Object.isFrozen(h));
    ok('handle carries its version', h.version === 4);
    ok('handle exposes the resolved atmosphere for diagnostics', h.atmosphere.cloudCover01 === 0);
    ok('atmosphere is frozen too', Object.isFrozen(h.atmosphere));

    // A caster with no height casts nothing — and must not produce NaN.
    const flat = h.forCaster({ heightPx: 0 });
    ok('a zero-height caster throws no offset, without NaN', flat.offsetPx === 0 && Number.isFinite(flat.penumbraPx));
  }

  // --- defaults: a handle built with NOTHING must still be usable ---------
  {
    const bare = createShadowHandle();
    const s = bare.forCaster(TREE);
    ok(
      'an un-sourced handle defaults to overhead clear noon (finite, no NaN, no throw)',
      Number.isFinite(s.offsetPx) && Number.isFinite(s.penumbraPx) && s.strength01 > 0
    );
    ok('overhead sun (90°) throws essentially no shadow offset', s.offsetPx < 1e-6);
  }

  // --- shadowAtmosphere is independently usable (diagnostics/report) ------
  {
    const a = shadowAtmosphere(NIGHT, OVERCAST);
    ok('atmosphere reports its own multipliers', a.softnessMul > 1 && a.strengthMul < 1);
    ok('atmosphere tolerates entirely absent inputs', Number.isFinite(shadowAtmosphere(null, null).softnessMul));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // THE THROW COMPRESSION (2026-07-24, author live report: *"the offset means
  // that the tree shadows are already too far away from their producers at dawn
  // and dusk… we need to lower the offset"*)
  // ═══════════════════════════════════════════════════════════════════════
  {
    // The knee is what separates this from a hard clamp. A hard clamp makes
    // every tall caster's shadow land at the SAME distance for the last hour of
    // daylight, so the whole scene's shadows visibly snap into a line and stop
    // moving; the knee keeps them growing forever, just ever more slowly.
    ok('the knee barely touches a short throw', Math.abs(softenThrowPx(10, 1000) - 10) < 0.2);
    ok('the knee bends a throw approaching the ceiling', softenThrowPx(1000, 1000) < 1000 * 0.75);
    ok('the knee NEVER reaches the ceiling, however extreme the input', softenThrowPx(1e9, 500) < 500);
    ok(
      'the knee is monotonic — a lower sun always means a longer shadow',
      softenThrowPx(2000, 500) > softenThrowPx(1000, 500)
    );
    ok('zero in, zero out (noon stays noon)', softenThrowPx(0, 500) === 0);
    ok('a disabled ceiling passes the raw value through', softenThrowPx(123, 0) === 123);

    // HEIGHT-RELATIVE, not a flat cap — a bush and a cathedral must not throw
    // the same distance at dusk, or the one cue that tells a viewer how tall
    // things are is destroyed.
    ok('the ceiling scales with the caster', maxThrowForHeightPx(200) > maxThrowForHeightPx(20));
    ok('and is the declared multiple of its height', maxThrowForHeightPx(70) === 70 * MAX_THROW_HEIGHT_RATIO);
    ok('with the absolute ceiling still winning for an absurd caster', maxThrowForHeightPx(1e6, 4096) === 4096);

    // THE WHOLE POINT, end to end: at a raking sun a tree's shadow must stay
    // within a few tree-heights of the tree.
    const dawnHandle = createShadowHandle({ sun: { elevationDeg: 2, azimuthDeg: 90, dayFactor01: 0.5 } });
    const dawnCast = dawnHandle.forCaster(TREE);
    ok(
      'a tree at a 2° sun throws a BOUNDED shadow, not one across the whole map',
      dawnCast.offsetPx < maxThrowForHeightPx(TREE.heightPx)
    );
    ok(
      'and still throws further than the same tree at noon (the cue survives the fix)',
      dawnCast.offsetPx > createShadowHandle({ sun: NOON }).forCaster(TREE).offsetPx
    );

    // The UI-shadow must be untouched by all of this — it is a different light
    // with its own hand-tuned constants, and softKnee defaults OFF for exactly
    // that reason.
    const ui = projectShadowOffset({
      azimuthDeg: 315,
      elevationDeg: 55,
      heightPx: 26,
      maxOffsetPx: 400,
      offsetScale: 5,
    });
    ok(
      'projectShadowOffset without softKnee is the old hard-clamp behaviour',
      Math.abs(ui.length - (26 / Math.tan((55 * Math.PI) / 180)) * 5) < 1e-6
    );
  }
}
