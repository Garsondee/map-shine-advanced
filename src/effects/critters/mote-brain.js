/**
 * MOTE BRAIN — a dust mote's motion, as a branch-free GPU kernel fragment.
 *
 * Same contract as `firefly-brain.js` (the runtime hands over a slot, takes back
 * its next state), a different temperament: a mote has no will. It is carried, and
 * everything it does is the air's doing. The brain's whole job is to be a good
 * piece of air:
 *
 *   position  (x, y) on the floor beneath it
 *   velocity  its drift, relaxing toward the air's velocity with some inertia
 *   custom    (height above the floor px, tumble phase 0..1, 0, 0)
 *   life, phase  UNUSED, and so never bound (`critter-runtime.js` `KINDS.mote.unused`):
 *             the wind-cell grid takes the eighth storage-buffer slot they would hold
 *
 * ============================================================================
 * THE AIR A MOTE LIVES IN — FOUR LAYERS, SUMMED INTO ONE TARGET VELOCITY
 * ============================================================================
 *
 *   1. THE WIND FIELD, WHERE IT IS. `windHandle.kernel()` is the SAME grid the fire
 *      and the gust ribbons read: openness (a sealed room is still air), the walls'
 *      deflection, the wind shadow behind buildings and the gust envelope for the
 *      coherent flow; plus the curl turbulence that the wind-grid peaks at a
 *      doorway. So a draught really does stream the dust through a door, and a
 *      closed room leaves it hanging. Scaled by the Beaufort strength curve exactly
 *      as `windHandle.strengthNode` does, then by the author's `windDrift` (px/s
 *      at a gale). With no wind handle (a lab, a windless scene) the map-wide
 *      `windPush` stands in.
 *   2. EDDIES. A divergence-free "fake curl" (`particles/curl-noise.js`' maths,
 *      driven by uniforms here) so neighbouring motes ride the same slow loops and
 *      the cloud keeps its swirling coherence. The mote's HEIGHT offsets the phase,
 *      so the layers shear against each other and panning shows parallax.
 *   3. A PRIVATE WANDER (two incommensurate sines per mote) so no two motes ever
 *      sit exactly in step with a neighbour.
 *   4. A TOKEN'S WAKE: a token walking through the cloud shoves the motes aside and
 *      spins them around itself.
 *
 * The velocity relaxes toward that target with a time constant of about a second
 * and a half (the `inertia` control): gusts are felt as a swelling, not a snap.
 *
 * ⚠️ THE KERNEL NEVER SAMPLES THE LIGHT. Compute-stage texture sampling has never
 * been proven in this renderer (`critter-zone-sample.js`), and the window light is
 * a texture. Whether a mote is lit is decided by the draw (`mote-render.js`), which
 * is where the beam gets its look; the motion here is the same lit or not.
 *
 * @module effects/critters/mote-brain
 */
import { TOKEN_SLOTS } from './critter-token.js';
import { windStrength01Node } from '../../world/index.js';

const TAU = Math.PI * 2;
/** A flake turns over at this many cycles a second at `tumble = 1` (before the per-mote spread). */
const TUMBLE_BASE_HZ = 0.12;
const TUMBLE_SPREAD_HZ = 0.5;

/**
 * @param {*} TSL
 * @param {object} deps
 * @param {(name: string) => *} deps.u - the uniform bank's `get`.
 * @param {{nearest: Function}} deps.zone - the zone sampler.
 * @param {{handle: object, cellBuffer: *}|null} [deps.wind] - the wind handle and the storage buffer
 *   holding its cells (`packWindCells`); null reads the map-wide `windPush` instead.
 * @returns {{update: (s: object) => object, spawn: (s: object) => object, lost: (s: object) => *}}
 */
export function buildMoteBrain(TSL, { u, zone, wind = null }) {
  const { float, vec2, vec4, select, clamp, max, sin, cos, exp, fract, smoothstep, length } = TSL;

  const hash01 = (x) => fract(sin(x.mul(12.9898)).mul(43758.5453));
  const zero2 = vec2(0, 0);

  /**
   * The wind where a mote floats, in px/s, and how open the air is there.
   * @param {*} P - vec2 world position.
   * @param {*} windPush - the map-wide fallback, px/s.
   */
  function airAt(P, windPush) {
    if (!wind) return { flow: windPush, open: float(1) };
    const ambient = wind.handle.ambient;
    const k = wind.handle.kernel(TSL, { centerXY: P, time: u('windTimeMs'), cellBuffer: wind.cellBuffer });
    // The same strength curve `windHandle.strengthNode` applies: the dial is linear to 70 m/s now, and an
    // everyday breeze reads small in raw units.
    const scale = ambient ? windStrength01Node(TSL, ambient.speed01).div(max(ambient.speed01, float(1e-4))) : float(1);
    const coherent = k.coherent.mul(k.openness);
    const turbulence = ambient ? k.turbulence.mul(u('turbulenceGain')) : zero2;
    return { flow: coherent.add(turbulence).mul(scale).mul(u('windDrift')), open: k.openness };
  }

  /** A divergence-free eddy field, `particles/curl-noise.js`' maths with uniform scale and a per-layer phase. */
  function eddy(pos, t, scalePx) {
    const px = pos.x.div(scalePx);
    const py = pos.y.div(scalePx);
    const vx = sin(py.mul(2.13).add(t))
      .add(cos(py.mul(3.71).sub(t)))
      .mul(0.5);
    const vy = cos(px.mul(2.27).add(t))
      .add(sin(px.mul(3.43).sub(t)))
      .mul(0.5);
    return vec2(vx, vy);
  }

  function update(s) {
    const z = s.C.x;
    const tum = s.C.y;
    const dist = s.zs.distance; // signed px, > 0 inside the paint
    const range = max(u('range'), float(1));
    const hover = u('hoverHeight');
    const t = s.tSec;
    const a1 = s.seed01.mul(TAU);
    const a2 = s.seed01.mul(TAU * 2.3);
    const a3 = s.seed01.mul(TAU * 3.7);
    const drift = u('driftSpeed');

    // ── 1. the wind where it floats ──
    const air = airAt(s.P, s.windPush);
    // The map-wide agitation (a gale somewhere) only reaches a mote through open air: a sealed room's dust
    // does not churn because it is blowing outside.
    const agitation = float(1).add(s.agitation.sub(1).mul(air.open));
    const flowMag = length(air.flow).div(max(u('windDrift'), float(1)));

    // ── 2. eddies (the layer's height shears them) and 3. the private wander ──
    const eddyV = eddy(s.P.add(vec2(z.mul(0.8), z.mul(-0.6))), t.mul(u('eddySpeed')), u('swirlScale')).mul(
      u('swirl').mul(agitation).mul(drift)
    );
    const wander = vec2(sin(t.mul(0.63).add(a1)).add(sin(t.mul(1.17).add(a3)).mul(0.5)), cos(t.mul(0.81).add(a2)))
      .mul(drift)
      .mul(u('wanderAmount'));

    // ── the edge: a soft turn back toward the paint, hardest beyond the roaming range ──
    const outside = float(1).sub(smoothstep(range.negate(), range.mul(-0.4), dist));
    const homing = s.zs.grad.mul(outside).mul(max(drift.mul(u('homing')), float(20)));

    // ── 4. a token's wake: shoved aside and spun around it ──
    let tokenDist = float(1e9);
    let tokenAway = zero2;
    for (let i = 0; i < TOKEN_SLOTS; i++) {
      const delta = s.P.sub(u(`tokenPos${i}`));
      const d = length(delta);
      const nearer = d.lessThan(tokenDist);
      tokenAway = vec2(select(nearer, delta.x, tokenAway.x), select(nearer, delta.y, tokenAway.y));
      tokenDist = select(nearer, d, tokenDist);
    }
    const stir = float(1)
      .sub(smoothstep(float(0), u('tokenStartleRadius'), tokenDist))
      .mul(u('tokenStartleResponse'));
    const awayDir = tokenAway.div(max(tokenDist, float(1e-3)));
    const wake = awayDir
      .mul(u('tokenPush'))
      .add(vec2(awayDir.y.negate(), awayDir.x).mul(u('tokenSpin')))
      .mul(stir);

    // ── the velocity: relax toward the air's, with inertia ──
    const target = air.flow.add(eddyV).add(wander).add(homing).add(wake);
    const relax = float(1).sub(exp(s.dt.negate().div(max(u('inertia'), float(0.05)))));
    const V = s.V.add(target.sub(s.V).mul(relax));
    const P = s.P.add(V.mul(s.dt));

    // NO WALL. Dust that the air carries out of the room is gone: it fades out over the last stretch before
    // `range` beyond the paint (`C.z`, which the draw multiplies into its opacity) and is then recycled at its
    // home, so a draught through a doorway makes a stream through the room and not a heap against its far wall.
    // In still air the soft turn-back above keeps the cloud where it was painted.
    const fade = smoothstep(range.negate(), range.mul(-0.4), dist);

    // ── height: each mote has its own level in the air column; slow convection cells lift and lower it ──
    const level = hash01(s.seed01.mul(91.7).add(0.31));
    const base = hover.mul(u('minHeight').add(level.mul(float(1).sub(u('minHeight')))));
    const cells = sin(s.P.x.div(u('swirlScale').mul(1.7)).add(t.mul(0.21)).add(a2)).mul(
      cos(s.P.y.div(u('swirlScale').mul(1.3)).sub(t.mul(0.17)).add(a3))
    );
    const zTarget = clamp(base.add(cells.mul(hover).mul(u('convection')).mul(u('updraft'))), float(2), hover.mul(1.3));
    const zNext = z.add(zTarget.sub(z).mul(float(1).sub(exp(s.dt.negate().div(max(u('heightEase'), float(0.05)))))));

    // ── the flake turns over, faster in a draught; each mote at its own rate ──
    const rate = float(TUMBLE_BASE_HZ).add(hash01(s.seed01.mul(37.3).add(1.7)).mul(TUMBLE_SPREAD_HZ));
    const tumNext = fract(
      tum.add(
        s.dt
          .mul(rate)
          .mul(u('tumble'))
          .mul(float(1).add(flowMag.mul(1.5)))
      )
    );

    return { P, V, TMR: s.TMR, PH: s.PH, C: vec4(zNext, tumNext, fade, float(0)) };
  }

  /** A fresh mote: near its home, at a random level in the column and a random point in its tumble. */
  function spawn(s) {
    const ang = s.rnd(1).mul(TAU);
    const offset = vec2(cos(ang), sin(ang)).mul(s.rnd(2).mul(u('range')).mul(0.5));
    const cand = s.home.add(offset);
    const probe = zone.nearest(cand);
    const P = select(probe.distance.greaterThan(0), cand, s.home);
    const level = hash01(s.seed01.mul(91.7).add(0.31));
    const z = u('hoverHeight').mul(u('minHeight').add(level.mul(float(1).sub(u('minHeight')))));
    return { P, V: zero2, TMR: float(0), PH: float(0), C: vec4(z, s.rnd(4), float(1), float(0)) };
  }

  /** Out past the roaming range, carried off by the air or left behind by the paint: recycle at home. */
  function lost(s) {
    return s.zs.distance.lessThan(max(u('range'), float(1)).negate());
  }

  return { update, spawn, lost };
}

/** The tumble's constants, so the renderer and the tests read the numbers the kernel writes. */
export const MOTE_TUMBLE = Object.freeze({ baseHz: TUMBLE_BASE_HZ, spreadHz: TUMBLE_SPREAD_HZ });
