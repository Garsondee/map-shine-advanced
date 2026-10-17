/**
 * MAGGOT BRAIN — a maggot's decisions, as a branch-free GPU kernel fragment.
 *
 * Same contract as `fly-brain.js`: the runtime hands over a slot's state and takes
 * back its NEXT state. A maggot has far less to decide than a fly, which is the
 * point of the character: it mostly WRITHES in place, now and then CRAWLS a body
 * length or two toward where the crowd is thickest, and stops again.
 *
 *   phase    0 WRITHE · 1 CRAWL
 *   life     the decision timer (seconds until the writhe ends / the crawl ends)
 *   custom   (heading, wave phase, excitement, crawl speed px/s)
 *
 * The WAVE PHASE is an accumulated angle, not a function of the clock: the body
 * renderer turns it into a travelling bend (`maggot-body.js`), and because the
 * phase integrates `ω·dt` with ω changing smoothly, a maggot that speeds up from a
 * writhe into a crawl accelerates its wriggle continuously instead of lurching
 * (`sin(ω(t)·t)` would lurch every time ω changed).
 *
 * ============================================================================
 * "CLUSTERING": THE CROWD FINDS ITS MIDDLE WITHOUT TALKING
 * ============================================================================
 *
 * Maggots swarm where the food is, which is the middle of the thing they are
 * eating. A GPU agent has no neighbour query, but it does have the zone field's
 * DEPTH: the signed distance to the rim, whose gradient points toward the zone's
 * spine. A crawling maggot biases its heading up that gradient with a strength that
 * fades out as it nears the middle (a fraction of the zone's own radius, recovered
 * from the zone's area), so a crowd forms in the deep interior and jostles there —
 * from one rule per maggot and no communication. `maggotClustering` is the weight.
 *
 * @module effects/critters/maggot-brain
 */
import { wrapAngle, safeAtan2 } from './critter-sdf.js';

const TAU = Math.PI * 2;
const PH_WRITHE = 0;
const PH_CRAWL = 1;

/** A crawl covers this many body lengths (min, max). */
const CRAWL_LENGTHS = [0.7, 2.0];
/** Crawl speed in body lengths per second, before the author's multiplier. */
const CRAWL_SPEED_LENGTHS = [0.5, 1.0];
/** Writhing pauses, seconds. */
const WRITHE_PAUSE = [0.9, 3.6];
/** Chance a finished writhe is followed by a crawl rather than another writhe. */
const CRAWL_CHANCE = 0.55;

/**
 * The wave phase is an accumulator, and an accumulator that only grows loses its fraction: at nine radians
 * a second a float32 has an ulp of 0.004 rad after an hour and 0.06 after a day, against steps of 0.15–0.3.
 * It is wrapped at a period the whole rig repeats over. The rig reads the phase at three rates — 1× (the
 * two lateral waves' first term and the squeeze), 1.37× (the second lateral wave) and 0.5× (the crawl's
 * heading sway) — and a wrap is invisible only if EVERY one of them has completed a whole number of
 * turns: 200 × 2π gives 200, 274 and 100. (Wrapping at 2π alone would put a seam in the 1.37× wave
 * every half minute.) A Node test holds this to the rig's own constants.
 */
export const WAVE_PERIOD = Math.PI * 2 * 200;
/** The crawl heading sways at this multiple of the wave phase (the third rate the wrap has to respect). */
export const CRAWL_SWAY_RATE = 0.5;

/**
 * @param {*} TSL
 * @param {object} deps
 * @param {(name: string) => *} deps.u - the uniform bank's `get`.
 * @param {{nearest: Function}} deps.zone - the zone sampler.
 * @returns {{update: (s: object) => object, spawn: (s: object) => object, lost: (s: object) => *}}
 */
export function buildMaggotBrain(TSL, { u, zone }) {
  const { float, vec2, vec4, select, mix, clamp, min, max, sin, cos, sqrt, floor, smoothstep, mod } = TSL;

  const angDiff = (a, b) => wrapAngle(TSL, b.sub(a));
  const dir = (a) => vec2(cos(a), sin(a));
  const zero2 = vec2(0, 0);

  /**
   * @param {object} s - { P, V, TMR, S, C, PH, home, zoneArea, zs, dt, L, rnd }
   */
  function update(s) {
    const hdg = s.C.x;
    const wave = s.C.y;
    const exc = s.C.z;
    const speedPx = s.C.w;
    const isCrawl = floor(s.PH).greaterThan(0.5);
    const dist = s.zs.distance;
    const gradAng = safeAtan2(TSL, s.zs.grad.y, s.zs.grad.x);
    const wriggle = u('maggotWriggle');

    // How worked-up it is: a crawl is hard work; a writhe is an individual's own resting level.
    const restLevel = float(0.3).add(s.seed01.mul(0.35));
    const excTarget = select(isCrawl, float(1), restLevel);
    const excNext = exc.add(excTarget.sub(exc).mul(min(float(1), s.dt.mul(3))));
    // Wave angular speed: a slow ripple at rest, a fast one when working. Integrated, never a function of t.
    const omega = float(TAU)
      .mul(float(0.7).add(excNext.mul(1.5)))
      .mul(float(0.55).add(wriggle.mul(0.45)));
    const waveNext = mod(wave.add(omega.mul(s.dt)), WAVE_PERIOD);

    // ── timers and the next decision ──
    const tmr = s.TMR.sub(s.dt);
    const expired = tmr.lessThanEqual(0);

    // where to crawl next: three candidate headings biased up the depth gradient; take the first that stays inside
    const zoneR = sqrt(max(s.zoneArea, 1).div(Math.PI));
    // pull toward the middle: strong at the rim, gone by the time it is 70% of the way in
    const pull = float(1)
      .sub(clamp(dist.div(max(zoneR.mul(0.7), s.L)), 0, 1))
      .mul(u('maggotClustering'));
    const candidate = (k) => {
      const th0 = s.rnd(10 + k).mul(TAU);
      const th = th0.add(angDiff(th0, gradAng).mul(pull).mul(0.85));
      const len = s.L.mul(mix(float(CRAWL_LENGTHS[0]), float(CRAWL_LENGTHS[1]), s.rnd(14 + k)));
      const probe = zone.nearest(s.P.add(dir(th).mul(len)));
      return { th, len, ok: probe.distance.greaterThan(s.L.mul(0.5)) };
    };
    const c0 = candidate(0);
    const c1 = candidate(1);
    const c2 = candidate(2);
    const thNew = select(c0.ok, c0.th, select(c1.ok, c1.th, select(c2.ok, c2.th, gradAng)));
    const lenNew = select(c0.ok, c0.len, select(c1.ok, c1.len, select(c2.ok, c2.len, s.L)));
    const speedNew = s.L.mul(mix(float(CRAWL_SPEED_LENGTHS[0]), float(CRAWL_SPEED_LENGTHS[1]), s.rnd(18))).mul(
      u('maggotSpeed')
    );
    const goCrawl = s.rnd(20).lessThan(CRAWL_CHANCE).and(u('maggotSpeed').greaterThan(0.001));

    // ── WRITHE ──
    const startCrawl = expired.and(goCrawl);
    const writheTmr = select(
      expired,
      select(goCrawl, lenNew.div(max(speedNew, 1e-3)), mix(float(WRITHE_PAUSE[0]), float(WRITHE_PAUSE[1]), s.rnd(22))),
      tmr
    );
    const writhePh = select(startCrawl, float(PH_CRAWL), float(PH_WRITHE));
    const writheHdg = select(startCrawl, thNew, hdg);
    const writheSpeed = select(startCrawl, speedNew, float(0));

    // ── CRAWL ──
    // Inch along: the body's own contraction wave sets the pace, so the maggot visibly pulls itself forward.
    const pulse = float(1).add(sin(waveNext.sub(1.0)).mul(0.8));
    const rimNear = float(1).sub(smoothstep(float(0), s.L.mul(1.5), dist));
    const steer = angDiff(hdg, gradAng).mul(rimNear).mul(s.dt).mul(6);
    const crawlHdg = hdg.add(steer).add(sin(waveNext.mul(CRAWL_SWAY_RATE)).mul(0.5).mul(s.dt));
    const crawlStep = dir(crawlHdg).mul(speedPx).mul(pulse).mul(s.dt);
    const crawlDone = tmr.lessThanEqual(0);
    const crawlTmr = select(crawlDone, mix(float(WRITHE_PAUSE[0]), float(WRITHE_PAUSE[1]), s.rnd(24)), tmr);
    const crawlPh = select(crawlDone, float(PH_WRITHE), float(PH_CRAWL));

    return {
      P: select(isCrawl, s.P.add(crawlStep), s.P),
      V: select(isCrawl, dir(crawlHdg).mul(speedPx), zero2),
      TMR: select(isCrawl, crawlTmr, writheTmr),
      PH: select(isCrawl, crawlPh, writhePh),
      C: vec4(
        wrapAngle(TSL, select(isCrawl, crawlHdg, writheHdg)),
        waveNext,
        excNext,
        select(isCrawl, select(crawlDone, float(0), speedPx), writheSpeed)
      ),
    };
  }

  /** A fresh maggot: near its home, writhing, at its own phase of the wave. */
  function spawn(s) {
    const offset = dir(s.rnd(1).mul(TAU)).mul(sqrt(s.rnd(2)).mul(s.L).mul(3));
    const cand = s.home.add(offset);
    const probe = zone.nearest(cand);
    const P = select(probe.distance.greaterThan(s.L), cand, s.home);
    return {
      P,
      V: zero2,
      TMR: s.rnd(5).mul(WRITHE_PAUSE[1]),
      PH: float(PH_WRITHE),
      C: vec4(s.rnd(4).mul(TAU), s.rnd(6).mul(TAU), float(0.4), float(0)),
    };
  }

  /** Strayed outside the paint (it was repainted under it): recycle at home. */
  function lost(s) {
    return s.zs.distance.lessThan(s.L.mul(-2).sub(20));
  }

  return { update, spawn, lost };
}
