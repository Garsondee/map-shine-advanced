/**
 * lightning-storm.test.mjs — the storm's own lightning (mmp-63o.2/.11/.33): the rate curve, the deterministic
 * schedule, the return-stroke envelope (the realism numbers: 1–4 strokes 40–80 ms apart, a flicker that dies on an
 * exponential tail), the day/night level, the adopt-only-fresh rule and the forced Strike.
 */
import {
  STORM_SLOT_MS,
  STORM_ADOPT_MS,
  STORM_KIND_GROUND,
  STORM_KIND_SKY,
  STORM_DEFAULTS,
  STORM_FLASH_RGB,
  stormStrikeRatePerSec,
  planStormSlot,
  stormStrikeEnvelope,
  stormFlashShare,
  createStormLightning,
  stormBoltSource,
  stormShadowSun,
  stormStrikeLightSource,
  STORM_SHADOW_STROKE_JITTER_DEG,
} from '../lightning-storm.js';
import { marchDirectionToSun } from '../lighting/sun-occlusion.js';
import { createShadowHandle } from '../shadow-access.js';
import { storybookFlashPalette } from '../clouds/storybook-clouds.js';
import {
  resolveRoomLook,
  resolveRoomSunFrame,
  resolveRoomFlashFrame,
  blendRoomFrames,
} from '../window/window-room-light.js';

const SCENE = Object.freeze({ x: 0, y: 0, width: 10000, height: 10000 });
const luma = (c) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;

/** Run a storm over `seconds` at 60 fps and collect the frames. */
function runStorm(storm, { seconds, lightning01, dayFactor01 = 0, startMs = 1_000_000, fps = 60 }) {
  const frames = [];
  for (let i = 0; i < seconds * fps; i++) {
    const nowMs = startMs + (i * 1000) / fps;
    frames.push({
      nowMs,
      f: storm.step({ nowMs, lightning01, dayFactor01, ambientLum: 0.05, sceneRect: SCENE, gridPx: 100 }),
    });
  }
  return frames;
}

export function run(t) {
  const { ok } = t;

  // --- the rate curve ---
  ok('no lightning = no strikes', stormStrikeRatePerSec(0) === 0);
  ok(
    'the rate rises with the slider',
    stormStrikeRatePerSec(0.3) < stormStrikeRatePerSec(0.6) && stormStrikeRatePerSec(0.6) < stormStrikeRatePerSec(1)
  );
  ok('full lightning is a strike every ~2-3 s', 1 / stormStrikeRatePerSec(1) > 2 && 1 / stormStrikeRatePerSec(1) < 3);
  ok('a tenth of the slider is a rare distant flicker (> 45 s apart)', 1 / stormStrikeRatePerSec(0.1) > 45);
  ok('How often scales the rate', Math.abs(stormStrikeRatePerSec(0.5, 2) - 2 * stormStrikeRatePerSec(0.5)) < 1e-12);

  // --- the schedule is a pure function of (seed, slot) ---
  {
    const a = planStormSlot(7, 1234, { ratePerSec: 4, groundShare: 0.35 });
    const b = planStormSlot(7, 1234, { ratePerSec: 4, groundShare: 0.35 });
    ok('same seed and slot give the same strike', JSON.stringify(a) === JSON.stringify(b));
    ok('rate 0 plans nothing', planStormSlot(7, 1234, { ratePerSec: 0, groundShare: 0.35 }) === null);
    let n = 0;
    let ground = 0;
    let strokesOk = true;
    let spacingOk = true;
    for (let k = 0; k < 4000; k++) {
      const p = planStormSlot(99, k, { ratePerSec: 1, groundShare: 0.35 });
      if (!p) continue;
      n++;
      if (p.kind === STORM_KIND_GROUND) {
        ground++;
        if (p.strokes.length < 1 || p.strokes.length > 4) strokesOk = false;
        for (let i = 1; i < p.strokes.length; i++) {
          const gap = p.strokes[i].tMs - p.strokes[i - 1].tMs;
          if (gap < 40 || gap > 80) spacingOk = false;
        }
        if (p.strokes[0].tMs < 15 || p.strokes[0].tMs > 50) spacingOk = false;
      }
      if (p.startMs < k * STORM_SLOT_MS || p.startMs >= (k + 1) * STORM_SLOT_MS) strokesOk = false;
    }
    // 4000 slots of 250 ms = 1000 s at 1 strike/s.
    ok('the schedule lands about the asked rate (1/s over 1000 s)', n > 900 && n < 1100);
    ok('about a third reach the ground', ground / n > 0.28 && ground / n < 0.42);
    ok('a ground strike has 1-4 return strokes, inside its slot', strokesOk);
    ok('return strokes are 40-80 ms apart after a 15-50 ms leader', spacingOk);
  }

  // --- the envelope: flicker, then an exponential tail ---
  {
    const g = {
      kind: STORM_KIND_GROUND,
      strokes: [
        { tMs: 30, peak: 1 },
        { tMs: 90, peak: 0.7 },
        { tMs: 155, peak: 0.6 },
      ],
    };
    const at = (ms) => stormStrikeEnvelope(g, ms);
    ok('the leader is a faint glow', at(15) > 0 && at(15) < 0.07);
    ok('the first return stroke is the blaze', at(30) > 0.95);
    ok('between strokes the light drops by more than half (a visible flicker)', at(85) < 0.5 * at(30));
    ok('the second stroke re-lights it', at(90) > 2 * at(85));
    ok('the third stroke too', at(155) > 1.6 * at(150));
    ok('it dies on a tail: dim at +400 ms, nearly gone at +1 s', at(555) < 0.12 && at(555) > 0.005 && at(1155) < 0.02);
    // Count the peaks a 60 fps camera sees (local maxima above 0.3).
    let peaks = 0;
    let prev = 0;
    let rising = false;
    for (let ms = 0; ms < 600; ms += 1000 / 60) {
      const e = at(ms);
      if (e > prev) rising = true;
      else if (rising && prev > 0.3) {
        peaks++;
        rising = false;
      } else rising = false;
      prev = e;
    }
    ok(`a 60 fps camera sees the strokes as separate flickers (2-4, saw ${peaks})`, peaks >= 2 && peaks <= 4);
    const sky = { kind: STORM_KIND_SKY, strokes: [{ tMs: 0, peak: 1 }] };
    ok(
      'a sky flash rises over a few frames instead of snapping',
      stormStrikeEnvelope(sky, 4) < 0.5 && stormStrikeEnvelope(sky, 16) > 0.7
    );
  }

  // --- the light share (window beams turn only when the flash dominates) ---
  ok('at night the flash is nearly all the light', stormFlashShare(1.5, 0.05) > 0.9);
  ok('by day it is a small share', stormFlashShare(0.4, 1) < 0.3);
  ok('no flash = no share', stormFlashShare(0, 1) === 0);

  // --- the storm over time ---
  {
    const storm = createStormLightning({ seed: 42 });
    const frames = runStorm(storm, { seconds: 120, lightning01: 1 });
    const lit = frames.filter((x) => x.f.active);
    const strikes = new Set(lit.map((x) => x.f.strikeId)).size;
    ok(`a full storm strikes often (${strikes} in 120 s)`, strikes > 25 && strikes < 80);
    ok(
      'the flash is cold blue-white',
      lit.every((x) => x.f.addRgb[2] > x.f.addRgb[0])
    );
    const peak = Math.max(...frames.map((x) => luma(x.f.addRgb)));
    ok(`a night strike adds about a day's light (peak ${peak.toFixed(2)})`, peak > 0.6 && peak < 2);
    const idle = runStorm(createStormLightning({ seed: 42 }), { seconds: 30, lightning01: 0 });
    ok(
      'lightning 0 never flashes',
      idle.every((x) => !x.f.active && x.f.addRgb[0] === 0)
    );
    const off = createStormLightning({ seed: 42 });
    const f = off.step({ nowMs: 5000, lightning01: 1, enabled: false, sceneRect: SCENE });
    ok('a disabled effect (photosensitive player) never flashes', !f.active && f.flash01 === 0);

    // Day vs night: the same storm, less light by day.
    const day = runStorm(createStormLightning({ seed: 42 }), { seconds: 120, lightning01: 1, dayFactor01: 1 });
    const dayPeak = Math.max(...day.map((x) => luma(x.f.addRgb)));
    ok(
      'by day the same strikes add a third of the night light',
      Math.abs(dayPeak / peak - STORM_DEFAULTS.dayStrength) < 0.05
    );

    // Two clients on the same clock see the same strikes.
    const twin = runStorm(createStormLightning({ seed: 42 }), { seconds: 120, lightning01: 1 });
    ok(
      'two clients on one clock see identical strikes',
      twin.every((x, i) => x.f.strikeId === frames[i].f.strikeId && x.f.flash01 === frames[i].f.flash01)
    );
  }

  // --- only fresh strikes are adopted (a slider move never pops in a half-done one) ---
  {
    // Find a slot that holds a strike at rate 4/s.
    let plan = null;
    for (let k = 100; !plan; k++)
      plan = planStormSlot(0x5713a1, k, { ratePerSec: stormStrikeRatePerSec(1, 10), groundShare: 0.35 });
    const late = createStormLightning();
    const f = late.step({
      nowMs: plan.startMs + STORM_ADOPT_MS + 50,
      lightning01: 1,
      sceneRect: SCENE,
      params: { rateScale: 10 },
    });
    ok('a strike first seen after its adopt window stays unseen', f.strikeId !== plan.id);
    const fresh = createStormLightning();
    const g = fresh.step({ nowMs: plan.startMs + 5, lightning01: 1, sceneRect: SCENE, params: { rateScale: 10 } });
    ok(
      'a strike seen at its start is adopted',
      g.strikeId === plan.id || fresh.status().live.some((s) => s.id === plan.id)
    );
  }

  // --- the forced strike (the Strike impulse) ---
  {
    const storm = createStormLightning();
    storm.force();
    const view = { minX: 1000, minY: 2000, maxX: 3000, maxY: 3000 };
    let f = storm.step({ nowMs: 10, lightning01: 0, sceneRect: SCENE, gridPx: 100, view });
    ok('Strike lands even with the slider at 0', storm.status().live.length === 1);
    ok(
      'a forced strike is a ground strike in the middle of the view',
      f.ground && f.ground.x >= 1500 && f.ground.x <= 2500 && f.ground.y >= 2250 && f.ground.y <= 2750
    );
    f = storm.step({ nowMs: 10 + f.ground.strokes[0].tMs, lightning01: 0, sceneRect: SCENE, gridPx: 100, view });
    ok('...and it blazes at its first return stroke', f.flash01 > 0.9);
    const bolt = stormBoltSource(f.ground, 100);
    ok('its bolt ends on the strike point', bolt.endX === f.ground.x && bolt.endY === f.ground.y);
    const len = Math.hypot(bolt.startX - bolt.endX, bolt.startY - bolt.endY);
    ok('its bolt is a foreshortened streak (4-9 squares)', len >= 400 && len <= 900);
    ok('the beams fall away from the strike', Math.abs(Math.hypot(f.toLightX, f.toLightY) - 1) < 1e-9);
    ok(
      'a forced strike passes the cold colour through',
      f.addRgb[2] / f.addRgb[0] === STORM_FLASH_RGB[2] / STORM_FLASH_RGB[0]
    );
  }

  // --- an epoch-millisecond clock (the wall-clock fallback) never overflows the slot hash ---
  {
    const storm = createStormLightning({ seed: 9 });
    const frames = runStorm(storm, { seconds: 60, lightning01: 1, startMs: 1_794_104_096_170 });
    ok(
      'an epoch-scale clock still strikes',
      new Set(frames.filter((x) => x.f.active).map((x) => x.f.strikeId)).size > 5
    );
  }

  // --- the next strike is known ahead, so its shadows can be baked before it lands ---
  {
    const storm = createStormLightning({ seed: 42 });
    let seenNext = null;
    let landed = false;
    for (let i = 0; i < 60 * 60 && !landed; i++) {
      const nowMs = 2_000_000 + (i * 1000) / 60;
      const f = storm.step({ nowMs, lightning01: 1, sceneRect: SCENE, gridPx: 100 });
      if (!f.active && f.next && !seenNext) seenNext = { ...f.next, at: nowMs };
      if (seenNext && f.active) {
        landed = f.strikeId === seenNext.id;
        if (!landed) seenNext = null;
      }
    }
    ok('the idle frame names the next strike, and that strike is the one that lands', landed);
    ok('...ahead of time', seenNext && seenNext.startMs > seenNext.at);
  }

  // --- the strike as a sun: shadows fall AWAY from it, long when far, short when overhead ---
  {
    const far = stormShadowSun({ x: 9000, y: 0, kind: STORM_KIND_GROUND }, { cx: 0, cy: 0, gridPx: 100 });
    const d = marchDirectionToSun(far.azimuthDeg);
    ok('the strike-sun stands where the strike is (east here)', d.x > 0.999 && Math.abs(d.y) < 1e-6);
    const near = stormShadowSun({ x: 600, y: 0, kind: STORM_KIND_GROUND }, { cx: 0, cy: 0, gridPx: 100 });
    ok('a far strike is low (long raking shadows), a near one high', far.elevationDeg < 20 && near.elevationDeg > 60);
    const cloud = stormShadowSun({ x: 9000, y: 0, kind: STORM_KIND_SKY }, { cx: 0, cy: 0, gridPx: 100 });
    ok('a flash inside the cloud is high overhead (short shadows)', cloud.elevationDeg >= 38);
    const s1 = stormShadowSun(
      { x: 9000, y: 0, kind: STORM_KIND_GROUND, seed: 77 },
      { cx: 0, cy: 0, gridPx: 100, stroke: 1, jitterDeg: 5 }
    );
    const s2 = stormShadowSun(
      { x: 9000, y: 0, kind: STORM_KIND_GROUND, seed: 77 },
      { cx: 0, cy: 0, gridPx: 100, stroke: 2, jitterDeg: 5 }
    );
    const swing = Math.abs(s1.azimuthDeg - s2.azimuthDeg);
    ok(
      'the shadows swing between strokes, by a few degrees',
      swing > 0.01 && swing <= 2 * STORM_SHADOW_STROKE_JITTER_DEG
    );
    const h = createShadowHandle({
      sun: far,
      weather: { shadowCloudCover01: 0 },
      atmosphereOverride: { softnessMul: 0.45, strengthMul: 1.35 },
    });
    const sunH = createShadowHandle({ sun: far, weather: { shadowCloudCover01: 0 } });
    ok(
      'the strike-sun handle is harder and darker than a sun at the same angle',
      h.atmosphere.softnessMul < sunH.atmosphere.softnessMul && h.depth01 > sunH.depth01
    );
    const c = h.forCaster({ heightPx: 300 });
    ok('a tree throws its shadow away from the strike (west)', c.offsetX < 0 && Math.abs(c.offsetY) < 1e-6);
    ok(
      'no override = the old handle exactly',
      JSON.stringify(createShadowHandle({ sun: far }).atmosphere) ===
        JSON.stringify(createShadowHandle({ sun: far, atmosphereOverride: null }).atmosphere)
    );
  }

  // --- the window beams swing round to stream away from the strike ---
  {
    const look = resolveRoomLook({});
    const sun = resolveRoomSunFrame({ elevationDeg: -20, azimuthDeg: 180, dayFactor01: 0 }, look);
    const flash = resolveRoomFlashFrame({ toLightX: 0, toLightY: 1 }, look);
    ok('at night the sun throws no beam', sun.throwLenPx === 0);
    ok(
      'the flash throws the beam away from the strike, the full drift',
      flash.throwY < 0 && Math.abs(flash.throwLenPx - look.maxDriftPx * look.drift) < 1e-9
    );
    ok('weight 0 is the sun frame itself', blendRoomFrames(sun, flash, 0) === sun);
    const half = blendRoomFrames(sun, flash, 0.5);
    ok('a half share is half the throw', Math.abs(half.throwY - flash.throwY / 2) < 1e-9);
  }

  // --- the cloud lights up from inside ---
  {
    const pal = {
      hi: [0.5, 0.5, 0.5],
      body: [0.2, 0.2, 0.2],
      shadow: [0.1, 0.1, 0.1],
      ink: [0, 0, 0],
      rim: [0.6, 0.6, 0.6],
    };
    ok('no flash = the same palette object', storybookFlashPalette(pal, [0, 0, 0], 1) === pal);
    const lit = storybookFlashPalette(pal, [1, 1, 1.4], 1);
    ok(
      'a flash lifts every slot, the body more than the shadow',
      lit.body[0] > pal.body[0] && lit.body[0] - pal.body[0] > lit.shadow[0] - pal.shadow[0]
    );
    ok('...cold (blue lifts most)', lit.body[2] - pal.body[2] > lit.body[0] - pal.body[0]);
  }

  // --- the strike's light: wall-clip radius constant for the strike (one sweep), brightness follows the flicker ---
  {
    const g = { id: 'g1', x: 1, y: 2, lightLevel: 0.8, lightRadiusPx: 6000, seed: 3 };
    const a = stormStrikeLightSource(g);
    const b = stormStrikeLightSource({ ...g, lightLevel: 0.2 });
    ok('the clip radius does not flicker', a.wallClipRadiusPx === b.wallClipRadiusPx && a.sourceId === b.sourceId);
    ok('the light does', a.alpha01 > b.alpha01 && a.luminosity01 > b.luminosity01);
    ok('a dead strike has no light', stormStrikeLightSource({ ...g, lightLevel: 0 }) === null);
  }
}
