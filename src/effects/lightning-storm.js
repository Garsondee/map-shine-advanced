/**
 * STORM LIGHTNING — the landscape lightning a thunderstorm makes on its own (mmp-63o.2, mmp-63o.11, mmp-63o.33).
 *
 * Ingram, 2026-11-07/08: lightning is its own weather slider; each strike throws strong light across the whole
 * scene — natural by day, dramatic at night — shines in through the windows and brightens the `_Window` light,
 * "a dramatic to watch realistic feeling animated weather effect".
 *
 * Before this the anchored bolt (`lightning.js`) was the only lightning: a GM had to place two anchors, and nothing
 * the storm itself did ever flashed. V2's `WeatherLightningEffectV2` (the screen flash) never got a V3 equivalent.
 *
 * WHAT A STRIKE IS (the physics this follows):
 *   - Most lightning never reaches the ground: a flash INSIDE the cloud lights it from within, 2–5 soft pulses over
 *     half a second, no bolt to see ({@link STORM_KIND_SKY}).
 *   - A GROUND strike is a dim stepped leader (10–50 ms) and then 1–4 RETURN STROKES 40–80 ms apart, each a
 *     near-instant blaze that dies in tens of milliseconds, with a short continuing-current glow behind it — so the
 *     light flickers two to four times in a third of a second and fades on an exponential tail
 *     ({@link STORM_KIND_GROUND}).
 *   - The light is cold blue-white ({@link STORM_FLASH_RGB}).
 *
 * THE SCHEDULE IS A FUNCTION OF A SHARED CLOCK, NOT OF THIS CLIENT. Time is cut into {@link STORM_SLOT_MS} slots;
 * whether slot `k` holds a strike, where, and how it flickers is a hash of `(seed, k)` and the lightning axis — so
 * every client reading the same server clock sees the same strike at the same place, and a recorded video replays
 * it exactly. A strike is only ADOPTED while it is fresh ({@link STORM_ADOPT_MS}), so moving the slider mid-storm
 * never makes a half-finished strike pop into existence.
 *
 * WHAT THIS MODULE HANDS ON (per frame, {@link createStormLightning}#step): one flash level and colour for the
 * outdoor light, a position and reach for its falloff, a direction for the window beams, a weight saying how much
 * of the light at this moment is the flash (so by day it barely moves anything), and — for a ground strike — the
 * bolt and the point light. Pure: no THREE, no Foundry, no clock of its own (the caller passes time in).
 *
 * @module effects/lightning-storm
 */

import { mixSeed, createRng, randFloat, randFloatRange } from './lightning-geometry.js';

/** The schedule's slot length. Short enough that two strikes can fall close together, long enough to be cheap. */
export const STORM_SLOT_MS = 250;
/** A strike is adopted only within this long of its start (one or two frames at any real frame rate). */
export const STORM_ADOPT_MS = 160;
/** Slots looked back over when adopting (the adopt window is shorter than a slot, so one is enough; two is safe). */
const LOOKBACK_SLOTS = 2;
/**
 * How far ahead the next scheduled strike is looked up (3 s). The strike's building shadows are a baked field, so
 * the viewer bakes the NEXT strike's shadows while the sky is still dark, and the field is ready when it lands.
 */
export const STORM_LOOKAHEAD_SLOTS = 12;

export const STORM_KIND_SKY = 'sky';
export const STORM_KIND_GROUND = 'ground';

/** Cold blue-white, roughly 8000 K, in linear RGB at unit luminance (Rec.709 weights). */
export const STORM_FLASH_RGB = Object.freeze([0.84, 0.94, 1.32]);

/**
 * The storm dials (mirrored by `lightning.js#LIGHTNING_PARAMS`, 'Storm' section). Exported so the tests and the
 * viewer's fallbacks read one table.
 */
export const STORM_DEFAULTS = Object.freeze({
  /** Strikes per second at full lightning, before the curve. */
  ratePerSec: 0.42,
  /** Multiplier on the strike rate (the card's 'How often'). */
  rateScale: 1,
  /** Share of strikes that reach the ground (the rest flash inside the cloud). Real storms: about a quarter. */
  groundShare: 0.35,
  /** Peak outdoor light a full strike adds at night, in ambient units (noon ambient is about 1). 1.6 blew the
   * stone yard out to white through the bloom on the Mansion (rig, 2026-11-08); 1 reads as lightning-lit. */
  brightness: 1,
  /** How much of that a strike adds in full daylight (a daytime flash is real but modest). */
  dayStrength: 0.3,
  /** Reach of the flash's bright core, in grid squares (beyond it the light falls to {@link STORM_FAR_SHARE}). */
  reachSquares: 45,
  /** How far a ground strike's point light reaches, in grid squares. */
  lightRadiusSquares: 60,
  /** How much stronger the ground strike's own point light is than the diffuse sky part. */
  pointLightShare: 0.7,
});

/** The share of a flash that still arrives far from the strike (the lit cloud base lights everything). */
export const STORM_FAR_SHARE = 0.45;
/** Sky (in-cloud) flashes are dimmer than a ground strike and reach further (the whole cloud glows). */
export const STORM_SKY_GAIN = 0.55;
export const STORM_SKY_REACH_MUL = 1.8;
/** The tallest a summed envelope may go (overlapping strokes of two strikes). */
const ENVELOPE_CEILING = 1.35;

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const num = (v, d) => (Number.isFinite(v) ? v : d);

/**
 * Strikes per second for a lightning level. A curve, not a line: the bottom of the slider is an occasional distant
 * flicker (0.1 → one about every 75 s), the top a furious storm (1 → one every ~2.4 s). 0 → none.
 * @param {number} lightning01 @param {number} [rateScale=1] @param {number} [ratePerSec]
 * @returns {number}
 */
export function stormStrikeRatePerSec(lightning01, rateScale = 1, ratePerSec = STORM_DEFAULTS.ratePerSec) {
  const l = clamp01(lightning01);
  if (l <= 0) return 0;
  return Math.max(0, ratePerSec) * Math.pow(l, 1.5) * Math.max(0, num(rateScale, 1));
}

/**
 * What slot `k` holds, or null. Deterministic: the same `(seed, slot)` and rate always give the same strike.
 * Positions are returned in the unit square (`u`, `v`); the caller maps them onto the scene.
 * @param {number} seed - uint32.
 * @param {number} slot - integer slot index (`floor(timeMs / STORM_SLOT_MS)`).
 * @param {{ratePerSec:number, groundShare:number}} a
 * @returns {null|{id:string, slot:number, startMs:number, kind:string, u:number, v:number, strokes:Array<{tMs:number, peak:number}>, durationMs:number, seed:number, boltAngle:number, boltLen01:number}}
 */
export function planStormSlot(seed, slot, { ratePerSec, groundShare }) {
  const p = Math.max(0, ratePerSec) * (STORM_SLOT_MS / 1000);
  if (!(p > 0)) return null;
  // The slot hashes as a uint32 (an epoch-millisecond clock gives slots past 2^31); the strike keeps the real one.
  const s = mixSeed(seed >>> 0, ((slot % 4294967296) + 4294967296) % 4294967296 >>> 0);
  const rng = createRng(s);
  if (randFloat(rng) >= Math.min(0.95, p)) return null;
  const offset = randFloat(rng) * STORM_SLOT_MS;
  const kind = randFloat(rng) < clamp01(groundShare) ? STORM_KIND_GROUND : STORM_KIND_SKY;
  return rollStrike(s, rng, slot, kind, slot * STORM_SLOT_MS + offset);
}

/**
 * The body of a strike — where it lands and how it flickers — from an rng already past the schedule's own rolls.
 * Shared by the schedule and by a forced strike (the Strike impulse), which skips the "is there one" roll.
 * @param {number} s - the strike's seed. @param {{state:number}} rng @param {number} slot
 * @param {string} kind @param {number} startMs
 */
export function rollStrike(s, rng, slot, kind, startMs) {
  const u = randFloat(rng);
  const v = randFloat(rng);
  const strokes = [];
  let durationMs;
  if (kind === STORM_KIND_GROUND) {
    // The stepped leader, then the return strokes: 1–4, weighted toward 2–3, 40–80 ms apart.
    const r = randFloat(rng);
    const n = r < 0.2 ? 1 : r < 0.55 ? 2 : r < 0.85 ? 3 : 4;
    let t = randFloatRange(rng, 15, 50);
    for (let i = 0; i < n; i++) {
      strokes.push({ tMs: t, peak: i === 0 ? 1 : randFloatRange(rng, 0.5, 0.9) });
      t += randFloatRange(rng, 40, 80);
    }
    durationMs = strokes[strokes.length - 1].tMs + 900;
  } else {
    // In-cloud: 2–5 softer pulses, 50–140 ms apart, the brightest anywhere in the train.
    const n = 2 + Math.floor(randFloat(rng) * 4);
    let t = 0;
    for (let i = 0; i < n; i++) {
      strokes.push({ tMs: t, peak: randFloatRange(rng, 0.35, 1) });
      t += randFloatRange(rng, 50, 140);
    }
    durationMs = strokes[strokes.length - 1].tMs + 800;
  }
  return Object.freeze({
    id: `${s >>> 0}:${slot}`,
    slot,
    startMs,
    kind,
    u,
    v,
    strokes: Object.freeze(strokes.map((k) => Object.freeze(k))),
    durationMs,
    seed: mixSeed(s, 0x9e3779b9),
    boltAngle: randFloat(rng) * Math.PI * 2,
    boltLen01: randFloat(rng),
  });
}

/**
 * The light of one strike `tMs` after it began, 0..~1. Ground: the leader's faint glow, then each return stroke
 * as an instant rise with a fast core decay (22 ms) and a slower continuing current (110 ms), then an afterglow.
 * Sky: each pulse rises over 14 ms and dies over 70 ms with a soft 240 ms tail. Pure.
 * @param {{kind:string, strokes:Array<{tMs:number, peak:number}>}} strike @param {number} tMs @returns {number}
 */
export function stormStrikeEnvelope(strike, tMs) {
  if (!strike || !(tMs >= 0)) return 0;
  const strokes = strike.strokes ?? [];
  if (!strokes.length) return 0;
  let e = 0;
  if (strike.kind === STORM_KIND_GROUND) {
    const first = strokes[0].tMs;
    if (tMs < first) return 0.06 * (tMs / Math.max(first, 1));
    for (const k of strokes) {
      const dt = tMs - k.tMs;
      if (dt < 0) continue;
      e += k.peak * (0.72 * Math.exp(-dt / 22) + 0.28 * Math.exp(-dt / 110));
    }
    const last = strokes[strokes.length - 1].tMs;
    if (tMs > last) e += 0.07 * Math.exp(-(tMs - last) / 320);
  } else {
    for (const k of strokes) {
      const dt = tMs - k.tMs;
      if (dt < 0) continue;
      const rise = Math.min(1, dt / 14);
      e += k.peak * rise * (0.75 * Math.exp(-dt / 70) + 0.25 * Math.exp(-dt / 240));
    }
  }
  return Math.min(ENVELOPE_CEILING, e);
}

/**
 * How much of the light at a point is the flash, 0..1 — what the window beams turn by (a daytime flash must not
 * swing the sun's beam round). `flashLum` and `ambientLum` are luminances in the same units.
 * @param {number} flashLum @param {number} ambientLum @returns {number}
 */
export function stormFlashShare(flashLum, ambientLum) {
  const f = Math.max(0, num(flashLum, 0));
  const a = Math.max(0, num(ambientLum, 0));
  return f + a > 1e-6 ? f / (f + a + 0.04) : 0;
}

/** The empty frame — what every consumer reads when there is no lightning. */
export const STORM_IDLE = Object.freeze({
  active: false,
  flash01: 0,
  addRgb: Object.freeze([0, 0, 0]),
  windowAddRgb: Object.freeze([0, 0, 0]),
  x: 0,
  y: 0,
  reachPx: 1,
  farShare: 1,
  share01: 0,
  toLightX: 0,
  toLightY: 0,
  kind: null,
  strikeId: null,
  ground: null,
});

/**
 * The storm's per-client state: which strikes are live. Everything else is recomputed from the clock each frame.
 * @param {{seed?: number}} [opts]
 */
export function createStormLightning({ seed = 0x5713a1 } = {}) {
  /** id -> strike plan (+ world position), while it is still lighting anything. */
  const live = new Map();
  /** Ids already adopted and finished — never re-adopted if the clock or slider wobbles. Bounded. */
  const done = new Set();
  let forcedCount = 0;
  let pendingForce = null;
  let adoptedTotal = 0;
  let lastFrame = STORM_IDLE;
  /** The next scheduled strike (see {@link STORM_LOOKAHEAD_SLOTS}), recomputed once a slot. */
  let nextCache = { slot: NaN, rate: NaN, value: null };
  let idleCache = { next: null, frame: STORM_IDLE };

  function findNext(nowMs, rate, groundShare, place) {
    const slotNow = Math.floor(nowMs / STORM_SLOT_MS);
    if (nextCache.slot === slotNow && nextCache.rate === rate && (!nextCache.value || nextCache.value.startMs > nowMs))
      return nextCache.value;
    let value = null;
    if (rate > 0) {
      for (let k = slotNow; k <= slotNow + STORM_LOOKAHEAD_SLOTS; k++) {
        const plan = planStormSlot(seed, k, { ratePerSec: rate, groundShare });
        if (!plan || plan.startMs <= nowMs || live.has(plan.id) || done.has(plan.id)) continue;
        value = Object.freeze({
          id: plan.id,
          kind: plan.kind,
          startMs: plan.startMs,
          seed: plan.seed,
          ...place(plan.u, plan.v),
        });
        break;
      }
    }
    nextCache = { slot: slotNow, rate, value };
    return value;
  }

  /** The idle frame, carrying the next strike so its shadows can be baked ahead (one object per next strike). */
  function idleFrame(next) {
    if (!next) return STORM_IDLE;
    if (idleCache.next !== next) idleCache = { next, frame: Object.freeze({ ...STORM_IDLE, next }) };
    return idleCache.frame;
  }

  function rememberDone(id) {
    done.add(id);
    if (done.size > 64) done.delete(done.values().next().value);
  }

  /**
   * Queue a strike for the next step, wherever `at` says (world px) or near the middle of the view. Used by the
   * Strike impulse: it lands even with the slider at 0.
   * @param {{x?:number, y?:number, kind?:string}} [at]
   */
  function force(at = {}) {
    pendingForce = { ...at };
  }

  /**
   * One frame.
   * @param {object} a
   * @param {number} a.nowMs - the SHARED clock (server time), ms.
   * @param {number} a.lightning01 - the eased weather axis.
   * @param {boolean} a.enabled - the cascade's answer (photosensitive players get false).
   * @param {number} a.dayFactor01 - 1 = full day.
   * @param {number} a.ambientLum - the outdoor ambient's luminance now (what the flash is compared with).
   * @param {{x:number, y:number, width:number, height:number}} a.sceneRect - world px.
   * @param {number} a.gridPx - px per grid square.
   * @param {{minX:number, minY:number, maxX:number, maxY:number}|null} [a.view] - where a forced strike lands.
   * @param {object} [a.params] - the 'Storm' dials (STORM_DEFAULTS keys, card names mapped by the caller).
   * @param {number[]} [a.colorRgb] - the flash colour, linear, unit luminance.
   * @returns {object} the frame ({@link STORM_IDLE}'s shape).
   */
  function step({
    nowMs,
    lightning01,
    enabled = true,
    dayFactor01 = 0,
    ambientLum = 0,
    sceneRect,
    gridPx = 100,
    view = null,
    params = {},
    colorRgb = STORM_FLASH_RGB,
  }) {
    if (!enabled || !Number.isFinite(nowMs) || !sceneRect) {
      live.clear();
      pendingForce = null;
      lastFrame = STORM_IDLE;
      return lastFrame;
    }
    const P = {
      ...STORM_DEFAULTS,
      ...Object.fromEntries(Object.entries(params).filter(([, v]) => Number.isFinite(v))),
    };
    const rate = stormStrikeRatePerSec(lightning01, P.rateScale, P.ratePerSec);
    const place = (u, v) => {
      // A margin of a tenth of the map past each edge: strikes beyond the map still light it.
      const mx = sceneRect.width * 0.1;
      const my = sceneRect.height * 0.1;
      return {
        x: sceneRect.x - mx + u * (sceneRect.width + 2 * mx),
        y: sceneRect.y - my + v * (sceneRect.height + 2 * my),
      };
    };

    // ADOPT fresh strikes from the schedule.
    if (rate > 0) {
      const slotNow = Math.floor(nowMs / STORM_SLOT_MS);
      for (let k = slotNow - LOOKBACK_SLOTS; k <= slotNow; k++) {
        const plan = planStormSlot(seed, k, { ratePerSec: rate, groundShare: P.groundShare });
        if (!plan || live.has(plan.id) || done.has(plan.id)) continue;
        const age = nowMs - plan.startMs;
        if (age < 0 || age > STORM_ADOPT_MS) continue;
        live.set(plan.id, { ...plan, ...place(plan.u, plan.v) });
        adoptedTotal++;
      }
    }
    // A forced strike (the Strike impulse): a ground strike (unless asked for a sky flash) near the middle of the
    // view, starting now.
    if (pendingForce) {
      forcedCount++;
      const kind = pendingForce.kind === STORM_KIND_SKY ? STORM_KIND_SKY : STORM_KIND_GROUND;
      const fs = mixSeed(seed, 0xf00d + forcedCount);
      const plan = rollStrike(fs, createRng(fs), forcedCount, kind, nowMs);
      let x = pendingForce.x;
      let y = pendingForce.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        const box = view ?? {
          minX: sceneRect.x,
          minY: sceneRect.y,
          maxX: sceneRect.x + sceneRect.width,
          maxY: sceneRect.y + sceneRect.height,
        };
        x = box.minX + (box.maxX - box.minX) * (0.25 + 0.5 * plan.u);
        y = box.minY + (box.maxY - box.minY) * (0.25 + 0.5 * plan.v);
      }
      const id = `force:${forcedCount}`;
      live.set(id, { ...plan, id, x, y, forced: true });
      pendingForce = null;
    }

    const next = findNext(nowMs, rate, P.groundShare, place);
    if (!live.size) {
      lastFrame = idleFrame(next);
      return lastFrame;
    }

    // EVALUATE: sum the live strikes' light; the brightest one says where it comes from.
    let total = 0;
    let best = null;
    let bestE = 0;
    let ground = null;
    for (const [id, s] of live) {
      const t = nowMs - s.startMs;
      if (t > s.durationMs || t < -STORM_SLOT_MS * 4) {
        live.delete(id);
        rememberDone(id);
        continue;
      }
      const e = stormStrikeEnvelope(s, t) * (s.kind === STORM_KIND_SKY ? STORM_SKY_GAIN : 1);
      total += e;
      if (e >= bestE) {
        bestE = e;
        best = s;
      }
      if (s.kind === STORM_KIND_GROUND && (!ground || s.startMs > ground.startMs))
        ground = { ...s, env: e / 1, tMs: t };
    }
    if (!best) {
      lastFrame = idleFrame(next);
      return lastFrame;
    }
    // Which return stroke (or in-cloud pulse) of the brightest strike is lighting things now: -1 during the leader.
    const bestT = nowMs - best.startMs;
    let stroke = -1;
    for (const k of best.strokes) if (k.tMs <= bestT) stroke++;
    const flash01 = Math.min(ENVELOPE_CEILING, total);
    const day = clamp01(dayFactor01);
    const level = P.brightness * (P.dayStrength + (1 - P.dayStrength) * (1 - day));
    const rgb = Array.isArray(colorRgb) && colorRgb.length === 3 ? colorRgb : STORM_FLASH_RGB;
    // A ground strike hands part of its light to its own point light (hard shadows); the sky part stays diffuse.
    const diffuseShare = ground && ground.id === best.id ? 1 - clamp01(P.pointLightShare) * 0.6 : 1;
    const add = flash01 * level * diffuseShare;
    const addRgb = Object.freeze([rgb[0] * add, rgb[1] * add, rgb[2] * add]);
    // The windows see the whole flash — the lit cloud base and the strike alike — not only its diffuse share.
    const win = flash01 * level;
    const windowAddRgb = Object.freeze([rgb[0] * win, rgb[1] * win, rgb[2] * win]);
    const flashLum = flash01 * level;
    const reachPx = Math.max(1, P.reachSquares * gridPx * (best.kind === STORM_KIND_SKY ? STORM_SKY_REACH_MUL : 1));

    // Which way the light comes from, seen from the middle of the view (or the map): the window beams fall AWAY.
    const cx = view ? (view.minX + view.maxX) / 2 : sceneRect.x + sceneRect.width / 2;
    const cy = view ? (view.minY + view.maxY) / 2 : sceneRect.y + sceneRect.height / 2;
    const dx = best.x - cx;
    const dy = best.y - cy;
    const dl = Math.hypot(dx, dy);
    lastFrame = Object.freeze({
      active: flash01 > 1e-4,
      flash01,
      addRgb,
      windowAddRgb,
      x: best.x,
      y: best.y,
      reachPx,
      farShare: best.kind === STORM_KIND_SKY ? 0.7 : STORM_FAR_SHARE,
      share01: stormFlashShare(flashLum, ambientLum),
      // Straight overhead (a strike on the view's middle) still has to throw the beams somewhere: lean them south.
      toLightX: dl > 1 ? dx / dl : 0,
      toLightY: dl > 1 ? dy / dl : -1,
      kind: best.kind,
      strikeId: best.id,
      strikeSeed: best.seed >>> 0,
      stroke,
      next,
      ground: ground
        ? Object.freeze({
            id: ground.id,
            x: ground.x,
            y: ground.y,
            startMs: ground.startMs,
            tMs: ground.tMs,
            durationMs: ground.durationMs,
            strokes: ground.strokes,
            seed: ground.seed,
            boltAngle: ground.boltAngle,
            boltLen01: ground.boltLen01,
            env: ground.env,
            // The point light's brightness now, in the same ambient units as `addRgb`.
            lightLevel: ground.env * level * clamp01(P.pointLightShare),
            lightRadiusPx: Math.max(gridPx * 4, P.lightRadiusSquares * gridPx),
          })
        : null,
    });
    return lastFrame;
  }

  return {
    step,
    force,
    /** The last frame `step` returned. */
    get frame() {
      return lastFrame;
    },
    /** DIAGNOSTIC: what is live and how many have been adopted. */
    status: () => ({
      live: [...live.values()].map((s) => ({
        id: s.id,
        kind: s.kind,
        x: Math.round(s.x),
        y: Math.round(s.y),
        strokes: s.strokes.length,
      })),
      adoptedTotal,
      forcedCount,
    }),
  };
}

/**
 * The bolt for a ground strike, as the anchored-bolt renderer's source: from a point in the cloud (offset sideways
 * by the channel's lean as seen from above — a tall channel foreshortens to a jagged streak of 4-9 squares) down to the
 * strike point. Pure.
 * @param {{id:string, x:number, y:number, seed:number, boltAngle:number, boltLen01:number}} ground
 * @param {number} gridPx
 * @returns {{linkId:string, seed:number, startX:number, startY:number, endX:number, endY:number, intensity:number, elevation:number}}
 */
export function stormBoltSource(ground, gridPx) {
  const len = gridPx * (4 + 5 * clamp01(ground.boltLen01));
  return {
    linkId: `storm:${ground.id}`,
    seed: ground.seed >>> 0,
    startX: ground.x + Math.cos(ground.boltAngle) * len,
    startY: ground.y + Math.sin(ground.boltAngle) * len,
    endX: ground.x,
    endY: ground.y,
    intensity: 1,
    elevation: 0,
  };
}

/**
 * THE STRIKE'S OWN LIGHT (mmp-63o.2): a ground strike lights the map from where it lands, so walls throw HARD shadows
 * pointing away from it and its light reaches indoors only through open doors and windows. A point light shaped for
 * the shared pool (`point-light-pool.js`, the same descriptor fire and the anchored bolt use), which wall-clips it
 * with Foundry's own sweep once per strike (`wallClipRadiusPx` is constant for the strike's whole life, so the clip
 * is cached). Brightness follows the strike's flicker every frame. Null when the light has died. Pure.
 * @param {{id:string, x:number, y:number, lightLevel:number, lightRadiusPx:number, seed:number}|null} ground
 * @param {{colorSrgb?: readonly number[]}} [o] - the flash colour in sRGB 0..1 (the pool's colour space).
 * @returns {object|null}
 */
export function stormStrikeLightSource(ground, { colorSrgb = [0.82, 0.86, 1] } = {}) {
  if (!ground || !(ground.lightLevel > 0.004)) return null;
  const r = Math.max(64, num(ground.lightRadiusPx, 4000));
  const level = Math.min(1.5, Math.max(0, ground.lightLevel));
  const n = 32;
  const pts = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts[i * 2] = ground.x + Math.cos(a) * r;
    pts[i * 2 + 1] = ground.y + Math.sin(a) * r;
  }
  return {
    sourceId: `storm:${ground.id}`,
    ownerEffectId: 'lightning',
    x: ground.x,
    y: ground.y,
    radius: r,
    // Constant for the strike: the pool's wall-clip cache keys on it, so the sweep runs once per strike.
    wallClipRadiusPx: r,
    shapePoints: pts,
    // A small hot core and a long reach: a strike is a point source kilometres tall.
    ratio: 0.18,
    attenuation01: 0.75,
    // Proportional to the strike (the pool scales a light's colour by 2 x luminosity below 0.5). A first cut ran
    // it from 0.5 up, which pushes every fragment in the radius toward white: by day a modest strike laid a white
    // veil over the whole map (rig, 2026-11-08). Only a strike far brighter than its own reference goes past 0.5.
    luminosity01: clamp01(0.5 * Math.min(1, level) + 0.15 * Math.max(0, level - 1)),
    hasColor: true,
    alpha01: clamp01(0.75 * level),
    color: [colorSrgb[0], colorSrgb[1], colorSrgb[2]],
    falloffModel: 'inverseSquareWide',
    animation: { type: 'none', speedRaw: 0, intensityRaw: 0, reverse: false, seed: ground.seed >>> 0, quality: 0 },
  };
}

/** How high the light of a strike stands, in grid squares, for its shadows: a ground strike's channel is seen low
 * and to one side (long raking shadows), a flash inside the cloud from high overhead (short ones). */
export const STORM_SHADOW_HEIGHT_SQUARES = Object.freeze({ ground: 20, sky: 45 });
/** The elevation range each kind's light may take, degrees. */
export const STORM_SHADOW_ELEVATION_DEG = Object.freeze({ ground: [12, 70], sky: [38, 80] });
/** The strike's shadows are hard (a point source kilometres away): the sun's penumbra times this. */
export const STORM_SHADOW_SOFTNESS = 0.45;
/** And dark: there is no sky fill in a flash — the shared core darkness times this (clamped to 1 by the model). */
export const STORM_SHADOW_STRENGTH_MUL = 1.35;

/**
 * THE STRIKE AS A SUN, for the shared shadow model (mmp-63o.2; Ingram 2026-11-08: "use a duplicate of the building
 * and veg shadows to throw the scene into relief"). Every shadow producer (the building bake, every tree and bush)
 * is driven by a sun azimuth and elevation, so a strike is described as one: standing where the strike is, seen from
 * the middle of the view, as high as its channel looks from there. `stroke` > 0 swings it by up to `jitterDeg`
 * (each return stroke takes a slightly different path, so the plant shadows shift between strokes). Pure.
 * @param {{x:number, y:number, kind:string, seed?:number}} strike
 * @param {{cx:number, cy:number, gridPx:number, stroke?:number, jitterDeg?:number}} at
 * @returns {{azimuthDeg:number, elevationDeg:number, dayFactor01:number, golden01:number, twilight01:number}}
 */
export function stormShadowSun(strike, { cx, cy, gridPx, stroke = 0, jitterDeg = 0 }) {
  const dx = strike.x - cx;
  const dy = strike.y - cy;
  const d = Math.hypot(dx, dy);
  // marchDirectionToSun(az) = (sin az, -cos az) must point at the strike, so the shadows fall away from it.
  const ux = d > 1 ? dx / d : 0;
  const uy = d > 1 ? dy / d : -1;
  let az = (Math.atan2(ux, -uy) * 180) / Math.PI;
  if (jitterDeg > 0 && stroke > 0) {
    const h = mixSeed((strike.seed ?? 0) >>> 0, stroke >>> 0);
    az += jitterDeg * ((h / 4294967296) * 2 - 1);
  }
  const sky = strike.kind === STORM_KIND_SKY;
  const height = (sky ? STORM_SHADOW_HEIGHT_SQUARES.sky : STORM_SHADOW_HEIGHT_SQUARES.ground) * Math.max(1, gridPx);
  const [lo, hi] = sky ? STORM_SHADOW_ELEVATION_DEG.sky : STORM_SHADOW_ELEVATION_DEG.ground;
  const elev = Math.min(hi, Math.max(lo, (Math.atan2(height, d) * 180) / Math.PI));
  return { azimuthDeg: ((az % 360) + 360) % 360, elevationDeg: elev, dayFactor01: 1, golden01: 0, twilight01: 0 };
}

/** Plant shadows swing by up to this much between return strokes (each stroke takes a slightly different path). */
export const STORM_SHADOW_STROKE_JITTER_DEG = 5;
