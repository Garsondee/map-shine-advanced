/**
 * THE TORRENT FIELD — waves of lashing rain crossing the map, at the top of
 * the rain fader.
 *
 * Two live author requests shape it (2026-10-27). The first asked for *"a
 * screen space TSL WebGPU shader effect which adds more intensity to the rain
 * effect driven by the wind direction ... even more torrential depth"*. The
 * first cut answered with parallel streak columns along the wind, and the
 * second request is the correction:
 *
 *   *"The lines make no sense when wind values are low, you need to imagine
 *   your effect as slanting sheets and then make them proceed into the wind in
 *   waves. You want to break it up with lots of low frequency noise in order to
 *   produce proceeding, evolving waves which are being pushed by the wind
 *   field. The goal is to create the effect of waves of lashing rain crossing
 *   the map."*
 *
 * So the field is now TWO structures with two different anchors:
 *
 * ============================================================================
 * 1. THE WAVES — WORLD space, low frequency, the main event
 * ============================================================================
 *
 * Wave trains of rain broadside to the wind, crossing the MAP downwind. Each
 * front arrives with a hard leading edge (the lash) and tails off behind it;
 * every front has its own strength. They are broken up three ways, all low
 * frequency: a domain warp that bends and tears the fronts, a slow envelope
 * that lets whole stretches of the train die away, and — at low wind, where a
 * tidy train would be wrong — drifting cells instead of fronts. All of it
 * evolves on a third noise axis, so no wave is ever the same shape twice.
 *
 * ⭐ PUSHED BY THE WIND FIELD, LITERALLY: the waves travel at the wind's own
 * REAL speed (`world/wind-field.js#windTravelPxPerSec` — the pace the gust
 * fronts on the wind overlay travel at, 2026-10-27; it used to be a hand-set
 * 900 px/s that matched nothing), and that same gust envelope SURGES them —
 * moving in lockstep, so a red band on the overlay IS a lashing sheet of rain.
 *
 * The 0..1 LOOK ramps (gain, slant, streak length) key on the wind's Beaufort
 * strength (`windStrength01ForSpeed01`), which is what the old dial's 0..1 was,
 * so they read exactly as tuned at the same real speed.
 *
 * ============================================================================
 * 2. THE SLANTING SHEETS — SCREEN space, around a VANISHING POINT
 * ============================================================================
 *
 * Why the first cut's lines made no sense at low wind: rain falling straight
 * down, seen from above, does not streak sideways at all — it comes AT the eye,
 * and its streaks radiate from the point directly below. Wind tilts the fall,
 * and the point the streaks radiate from (the vanishing point of the rain's
 * own direction) slides UPWIND, `focal × tan(slant)` px from the centre. At a
 * gale it is so far off-screen that the streaks are nearly parallel, which is
 * the ONE case the first cut drew. So the streaks are laid out in polar
 * coordinates around that point: columns by ANGLE, segments by LOG radius,
 * moving outward. That gives one pattern that is correct at every wind speed:
 * radial dots-to-streaks in a calm, slanting sheets in a breeze, and parallel
 * lashing lines in a gale, with nothing to blend between.
 *
 * ⚠️ SCROLL IS INTEGRATED ON THE CPU, NEVER `time × speed` IN THE SHADER —
 * speed rides the wind, and `time × speed` lurches the whole field on every
 * change. {@link stepTorrentState} integrates in JS doubles and wraps on a
 * period the shader repeats on (streaks) or far past any session (waves).
 *
 * ⚠️ CONSTANTS ARE TUNED BY EYE in `tools/shader-lab`'s precip bench (the
 * `torrent` isolator, runs/torrent-look-*), not measured against footage.
 *
 * @module effects/precipitation/torrent-field
 */
import {
  windFlowVectorNode,
  windFlowVector,
  computeGustEnvelope,
  windTravelPxPerSec,
  windStrength01ForSpeed01,
  windStrength01Node,
} from '../../world/index.js';

/**
 * The three streak layers, FAR → NEAR. `colPx` is the column spacing and
 * `periodPx` the segment length, both measured at the reference radius (see
 * {@link TORRENT_VANISH_REF_PX}); perspective grows both outward. Nearer
 * layers are coarser, longer, faster, wider and brighter.
 */
export const TORRENT_LAYERS = Object.freeze([
  Object.freeze({ colPx: 5, periodPx: 80, lenFrac: 0.4, halfWidthPx: 0.45, speedPxS: 1300, density: 0.5, alpha: 0.15 }),
  Object.freeze({
    colPx: 11,
    periodPx: 170,
    lenFrac: 0.45,
    halfWidthPx: 0.8,
    speedPxS: 2300,
    density: 0.32,
    alpha: 0.25,
  }),
  Object.freeze({
    colPx: 27,
    periodPx: 360,
    lenFrac: 0.5,
    halfWidthPx: 1.4,
    speedPxS: 3900,
    density: 0.15,
    alpha: 0.38,
  }),
]);

/** How far upwind the vanishing point sits at a full gale, in screen px —
 * `focal × tan(slant)`, chosen so a gale's streaks are all but parallel. */
export const TORRENT_VANISH_PX_AT_GALE = 5200;

/** The radius the column/segment sizes are calibrated at, and the floor on
 * the vanishing distance used for them: in a calm the point sits at the
 * centre, and sizes are then true at this many px from it. */
export const TORRENT_VANISH_REF_PX = 520;

/** The WAVES, world px. `spacingPx` is the gap between fronts; `warpPx` how
 * far the low-frequency warp bends them; `frontCut` how hard the leading edge
 * is (fraction of a spacing). */
export const TORRENT_WAVE = Object.freeze({
  spacingPx: 2100,
  warpPx: 1000,
  frontCut: 0.06,
  hazeAlpha: 0.42,
  leadAlpha: 0.1,
});

/** Segments per column before the streak hash repeats — and therefore the
 * period the CPU wraps each layer's scroll on. */
export const TORRENT_SEGMENT_WRAP = 64;

/** The waves have no hash to repeat on, so their offset wraps on a distance
 * no session reaches (hours at a gale), keeping float32 precise. */
export const TORRENT_WAVE_WRAP_PX = 10_000_000;

/** In a calm the streaks still move at this fraction of their gale speed: a
 * downpour with no wind still FALLS. */
export const TORRENT_CALM_SPEED_FLOOR = 0.35;

/** …and the field still draws at this fraction of its gale strength. Wind is
 * what drives it harder, not what turns it on. */
export const TORRENT_CALM_GAIN_FLOOR = 0.7;

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/**
 * The CPU twin of how hard the wind drives the field. PURE.
 * @param {number} windSpeed01
 * @returns {number} 0..1
 */
export function torrentWindGain(windSpeed01) {
  return TORRENT_CALM_GAIN_FLOOR + (1 - TORRENT_CALM_GAIN_FLOOR) * windStrength01ForSpeed01(windSpeed01);
}

/**
 * How fast the waves cross the map, world px/s — the wind's own real speed,
 * the same pace its gust fronts travel at. A floor keeps a near-calm's cells
 * drifting rather than frozen. PURE.
 * @param {number} windSpeed01 @param {number} [pixelsPerMetre]
 */
export function torrentWaveSpeedPxS(windSpeed01, pixelsPerMetre) {
  return Math.max(TORRENT_WAVE_MIN_PX_S, windTravelPxPerSec(clamp01(windSpeed01), pixelsPerMetre));
}
/** The calm floor on the waves' drift, world px/s (~1 m/s at 100 px / 5 ft). */
export const TORRENT_WAVE_MIN_PX_S = 60;

/**
 * Where the streaks radiate from: the vanishing point of the rain's own fall
 * direction, in SCREEN px from the view centre (world-axis-aligned, y down).
 * It sits UPWIND — a drop that started high and upwind is the one heading for
 * the point below you. PURE.
 *
 * @param {number} windSpeed01
 * @param {number} windDirDeg
 * @returns {{x:number, y:number, distPx:number, refPx:number}} `refPx` is the
 *   radius sizes are calibrated at: the distance, floored at the reference.
 */
export function torrentVanishingPoint(windSpeed01, windDirDeg) {
  const toward = windFlowVector(windDirDeg);
  const distPx = TORRENT_VANISH_PX_AT_GALE * windStrength01ForSpeed01(windSpeed01);
  return {
    x: -toward.x * distPx,
    y: -toward.y * distPx,
    distPx,
    refPx: Math.max(distPx, TORRENT_VANISH_REF_PX),
  };
}

/**
 * The per-frame state step. PURE — returns the next state.
 *
 * @param {{scroll:number[], waveX:number, waveY:number, evolveSec:number}|null} state
 * @param {number} dtSec - real seconds.
 * @param {number} windSpeed01
 * @param {number} windDirDeg
 * @param {number} [pixelsPerMetre] - the scene's scale; defaults to 100 px / 5 ft.
 * @returns {{scroll:number[], waveX:number, waveY:number, evolveSec:number}}
 *   `scroll` — each layer's outward scroll in SEGMENTS; `waveX/Y` — the
 *   waves' downwind offset in world px; `evolveSec` — the waves' shape clock.
 */
export function stepTorrentState(state, dtSec, windSpeed01, windDirDeg, pixelsPerMetre) {
  const dt = Number.isFinite(dtSec) && dtSec > 0 ? Math.min(dtSec, 0.25) : 0;
  const k = TORRENT_CALM_SPEED_FLOOR + (1 - TORRENT_CALM_SPEED_FLOOR) * windStrength01ForSpeed01(windSpeed01);
  const scroll = TORRENT_LAYERS.map(
    (L, i) => ((state?.scroll?.[i] ?? 0) + (dt * L.speedPxS * k) / L.periodPx) % TORRENT_SEGMENT_WRAP
  );
  // A 2-D offset, not a scalar along the current wind axis: when the wind
  // turns, the waves already on the map keep their place and simply start
  // moving the new way, rather than the whole pattern swinging round.
  const toward = windFlowVector(windDirDeg);
  const step = dt * torrentWaveSpeedPxS(windSpeed01, pixelsPerMetre);
  return {
    scroll,
    waveX: ((state?.waveX ?? 0) + toward.x * step) % TORRENT_WAVE_WRAP_PX,
    waveY: ((state?.waveY ?? 0) + toward.y * step) % TORRENT_WAVE_WRAP_PX,
    evolveSec: ((state?.evolveSec ?? 0) + dt) % 100_000,
  };
}

/**
 * Build the torrent field as TSL nodes.
 *
 * ⚠️ TAKES `TSL` AND NODES, RETURNS NODES — no uniforms, no state, matching
 * `buildStormFogField`'s own contract for the identical reason.
 *
 * @param {object} TSL
 * @param {object} inputs
 * @param {*} inputs.screenPx - vec2, SCREEN px from the view centre (world-axis-aligned, y down).
 * @param {*} inputs.worldXY - vec2, world px.
 * @param {*} inputs.windDirDeg - float, compass bearing the wind blows TOWARD.
 * @param {*} inputs.windSpeed01 - float, 0..1.
 * @param {*} [inputs.gustiness01] - float, 0..1 — the wind handle's own. Absent
 *   ⇒ no surge term at all (a JS branch, `tsl/no-uniform-gates`).
 * @param {*} inputs.timeMs - float, the clock the gust envelope reads.
 * @param {object} [inputs.advection] - the wind's integrated advection uniforms,
 *   for the gust envelope (`world/wind-field.js#createWindAdvectionUniforms`) —
 *   the same CPU-integration this module's own waves already use, for the fronts.
 * @param {*} inputs.scroll - vec3, the layers' outward scroll (segments).
 * @param {*} inputs.waveOffset - vec2, the waves' world offset.
 * @param {*} inputs.evolveSec - float, the waves' shape clock.
 * @param {*} inputs.vanishPx - vec2, {@link torrentVanishingPoint}'s x/y.
 * @param {*} inputs.refPx - float, {@link torrentVanishingPoint}'s refPx.
 * @returns {{streak:*, haze:*, lead:*}} float nodes, 0..1 — light streak
 *   coverage, the waves' grey water, and the bright lash at each front.
 */
export function buildTorrentField(TSL, inputs) {
  const {
    screenPx,
    worldXY,
    windDirDeg,
    windSpeed01: dialSpeed01,
    gustiness01,
    timeMs,
    scroll,
    waveOffset,
    evolveSec,
  } = inputs;
  const { pixelsPerMetre, advection } = inputs;
  // Every 0..1 LOOK ramp below keys on Beaufort strength (see the header);
  // only the gust envelope reads the raw dial, as the real field does.
  const windSpeed01 = windStrength01Node(TSL, dialSpeed01);
  const { vanishPx, refPx } = inputs;
  const { float, vec2, vec3, floor, fract, abs, sin, dot, mod, log, atan, length, pow } = TSL;
  const { smoothstep, mix, clamp, mx_noise_float: noise } = TSL;

  const toward = windFlowVectorNode(TSL, windDirDeg);
  const across = vec2(toward.y.negate(), toward.x);
  const hash = (x, y) => fract(sin(x.mul(127.1).add(y.mul(311.7))).mul(43758.5453));
  const n01 = (n) => n.mul(float(0.5)).add(float(0.5));

  // ── 1. THE WAVES (world) ────────────────────────────────────────────────
  const q = worldXY.sub(waveOffset);
  const qa = dot(q, toward);
  const qc = dot(q, across);
  const ev = evolveSec;
  // The tear: three octaves of slow warp bend each front and rip its edges.
  const warp = noise(vec3(qa.div(3400), qc.div(4600), ev.mul(0.035)))
    .add(noise(vec3(qa.div(1200), qc.div(1500), ev.mul(0.08).add(11))).mul(float(0.45)))
    .add(noise(vec3(qa.div(460), qc.div(520), ev.mul(0.16).add(5))).mul(float(0.22)))
    .mul(float(TORRENT_WAVE.warpPx));
  const phase = qa.add(warp).div(float(TORRENT_WAVE.spacingPx));
  const fr = fract(phase);
  const frontIdx = floor(phase);
  // Leading edge DOWNWIND (high `fr`): a point sees the cut-in first — the
  // lash — then the tail decaying behind it. Zero at both ends of `fr`, so a
  // per-front amplitude can change at the wrap without a seam.
  const cut = float(1).sub(smoothstep(float(1 - TORRENT_WAVE.frontCut), float(1), fr));
  // A BROAD body — most of a spacing is wave, rising to the front — so a
  // wave reads as a mass of water arriving, not a line drawn across the map.
  const pulse = pow(smoothstep(float(0.08), float(0.9), fr), float(1.3)).mul(cut);
  const frontAmp = float(0.4).add(hash(frontIdx, float(3.7)).mul(float(0.6)));
  // Whole stretches of the train fade out — long across the wind, longer
  // along — and a second, finer octave breaks each front into segments.
  const envelope = smoothstep(
    float(-0.35),
    float(0.45),
    noise(vec3(qa.div(7000), qc.div(3000), ev.mul(0.02).add(23))).add(
      noise(vec3(qa.div(2600), qc.div(1100), ev.mul(0.05).add(29))).mul(float(0.55))
    )
  );
  // Clumps: mid-frequency lumps that ride WITH the wave (same `q` frame), so
  // the water inside a front is uneven and churning rather than a gradient.
  const clump = smoothstep(float(-0.45), float(0.55), noise(vec3(qa.div(640), qc.div(480), ev.mul(0.18).add(17))));
  const train = pulse
    .mul(frontAmp)
    .mul(envelope)
    .mul(float(0.45).add(clump.mul(float(0.55))));
  // In a calm there is no wind to line fronts up: drifting, evolving cells,
  // warped by the same tear so they are ragged rather than round.
  const cq = vec3(qa.add(warp.mul(0.6)).div(1700), qc.sub(warp.mul(0.4)).div(1700), ev.mul(0.06).add(41));
  const cells = smoothstep(float(-0.3), float(0.5), noise(cq)).mul(float(0.5).add(clump.mul(float(0.5))));
  // Fronts dominate from a light breeze up — the author wants WAVES at every
  // wind speed; the cells only soften a near-calm's order.
  let wave = mix(cells, train, mix(float(0.55), float(1), windSpeed01));
  // ⭐ PUSHED BY THE WIND FIELD — the wind's own gust envelope surges the rain.
  if (gustiness01) {
    const gust = computeGustEnvelope(TSL, {
      centerXY: worldXY,
      time: timeMs,
      directionDeg: windDirDeg,
      gustiness01,
      speed01: dialSpeed01,
      pixelsPerMetre,
      advection,
    });
    // Stronger than it was (0.8→1.35): the waves and the gusts now travel
    // together, so this is the line that makes the overlay's red bands and the
    // heaviest rain the same place.
    wave = wave.mul(mix(float(0.55), float(1.55), smoothstep(float(0.75), float(1.6), gust)));
  }
  wave = clamp(wave, float(0), float(1));
  // The lash: a brighter rim along each front, broken by the same clumps.
  const lead = smoothstep(float(0.82), float(1 - TORRENT_WAVE.frontCut), fr)
    .mul(cut)
    .mul(frontAmp)
    .mul(envelope)
    .mul(clump);

  // ── 2. THE SLANTING SHEETS (screen, polar about the vanishing point) ─────
  const d = screenPx.sub(vanishPx);
  const r = length(d).max(float(1));
  // Angle measured from DOWNWIND, so at a gale the screen sits around angle 0
  // and `angle × ref` is just cross-wind px — the parallel case falls out.
  const ang = atan(dot(d, across), dot(d, toward).add(float(1e-3)));
  const crossPx = ang.mul(refPx);
  const logR = log(r.div(refPx));
  // Looking straight down the fall, rain comes AT the eye: no streaks within
  // a few hundred px of the vanishing point (and no sub-pixel columns there).
  const nearFade = smoothstep(float(60), float(380), r);
  const lenWind = float(0.55).add(windSpeed01.mul(float(0.7)));

  let streak = float(0);
  TORRENT_LAYERS.forEach((L, i) => {
    const sc = [scroll.x, scroll.y, scroll.z][i];
    const colF = crossPx.div(float(L.colPx));
    const col = floor(colF);
    const colFrac = fract(colF);
    const colSeed = hash(col, float(i * 17 + 3));
    // LOG radius, in segments at the reference radius: segments lengthen
    // outward (perspective) and the scroll moves them outward, faster at the
    // edge — rain falling past the eye.
    const u = logR
      .mul(refPx)
      .div(float(L.periodPx))
      .sub(sc)
      .add(colSeed.mul(float(TORRENT_SEGMENT_WRAP)));
    const seg = mod(floor(u), float(TORRENT_SEGMENT_WRAP));
    const fu = fract(u);
    const h = hash(col.add(float(31 * (i + 1))), seg);
    const h2 = hash(seg.add(float(7)), col);

    // The waves decide how MANY streaks there are, not just how bright.
    const density = float(L.density).mul(mix(float(0.12), float(2.0), wave));
    const present = h.lessThan(density).select(float(1), float(0));
    const len = clamp(
      float(L.lenFrac)
        .mul(lenWind)
        .mul(float(0.6).add(h2.mul(float(0.8)))),
      float(0.05),
      float(0.95)
    );
    const start = h2.mul(float(1).sub(len));
    const local = fu.sub(start).div(len);
    const inSpan = local
      .greaterThanEqual(float(0))
      .and(local.lessThanEqual(float(1)))
      .select(float(1), float(0));
    const along01 = smoothstep(float(0), float(1), local).mul(float(1).sub(smoothstep(float(0.9), float(1), local)));

    const center = float(0.5).add(colSeed.sub(float(0.5)).mul(float(0.6)));
    const dPx = abs(colFrac.sub(center)).mul(float(L.colPx));
    const across01 = float(1).sub(smoothstep(float(L.halfWidthPx * 0.5), float(L.halfWidthPx + 0.75), dPx));
    // `h < density` wherever a streak is present, so `h / density` is a free
    // second random in 0..1 — per-streak brightness variation.
    const bright = float(0.55).add(
      h
        .div(density.max(float(1e-3)))
        .min(float(1))
        .mul(float(0.45))
    );
    const swell = mix(float(0.15), float(1.3), wave);
    streak = streak.add(present.mul(inSpan).mul(along01).mul(across01).mul(bright).mul(swell).mul(float(L.alpha)));
  });
  streak = clamp(streak.mul(nearFade), float(0), float(1));

  // The water in a wave is a SHEET of streaks, not flat grey: a fine noise in
  // the same polar frame, stretched along the fall and moving with it.
  const u1 = logR.mul(refPx).div(float(TORRENT_LAYERS[1].periodPx)).sub(scroll.y);
  const fibre = mix(float(1), n01(noise(vec2(crossPx.div(3.5), u1.mul(0.55)))), nearFade);
  const haze = clamp(pow(wave, float(1.3)).mul(float(0.25).add(fibre.mul(float(0.75)))), float(0), float(1));

  return { streak, haze, lead: clamp(lead, float(0), float(1)) };
}
