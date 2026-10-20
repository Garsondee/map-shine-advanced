/**
 * FIRE — THE LONG LIFE OF A FIRE (2026-10-20). Pure maths, no THREE, Node-tested.
 *
 * A fire is not just burning or not. Outdoors, rain can put it out, the coals then smoulder for a while, the ash goes
 * cold, and — if the weather stays kind — a long time later it comes back to life, very slowly. That cycle is state, not
 * a function of the weather this instant (rain from ten minutes ago is why a fire is out now), so it lives here, one
 * small record per fire, stepped by the frame's `dt` with the weather AT that fire.
 *
 *     burning ──(soaked)──► out ──(coals cool)──► dead ──(long dry spell)──► rekindle ──(coughs to life)──► burning
 *        ▲                   │ (rain stops while the coals are still hot: it catches again)
 *        └───────────────────┘
 *
 * Two numbers come out of it: `vitality` (0..1, how big and bright the FLAME is) and `coal` (0..1, how hot the BED is).
 * A flame with no vitality still has its coals: rust orange fading to coal red over `smoulderSec`, cold ash after.
 *
 *  - Wetness is the memory. `wet` climbs while rain reaches the fire (open sky only: `rain01` is already the sky-gated
 *    number), and drains when it stops. A drizzle shrinks the flame while it lasts and it recovers; sustained rain soaks
 *    the fire and puts it out.
 *  - Wind alone never puts a fire out here (it bends and gutters it — the stress model); rain does. A fire that
 *    `canBeSnuffed = false` feels a quarter of the rain and keeps a floor of vitality, so it can only ever struggle.
 *  - Indoors (no sky) `rain01` is 0, so nothing ever happens: a hearth burns until the world ends.
 *
 * @module effects/fire/fire-billow-state
 */

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** The defaults, in seconds of the fire's clock (real seconds at world speed 1). All author-tunable. */
export const FIRE_LIFE = Object.freeze({
  /** Seconds of full rain to soak a fire through (a light drizzle takes proportionally longer). */
  douseSec: 28,
  /** Seconds for a soaked fire's wetness to drain once the rain has stopped. */
  drySec: 200,
  /** Seconds the coals of a put-out fire stay hot (rain hisses them out up to 4x faster). */
  smoulderSec: 150,
  /** Seconds the cold fire stays dead, counted only while it is dry, before it starts to come back. */
  rekindleDelaySec: 900,
  /** Seconds of the comeback itself: sparse glints, then the coals, then the flame coughing to life. */
  rekindleRampSec: 420,
  /** The floor of vitality for a fire that cannot be snuffed. */
  immuneFloor: 0.4,
});

/**
 * @typedef {object} FireLifeState
 * @property {'burning'|'out'|'dead'|'rekindle'} phase
 * @property {number} wet 0..1 soaked-ness
 * @property {number} vitality 0..1 the flame
 * @property {number} coal 0..1 the bed
 * @property {number} clock seconds in the current phase
 */

/** A new fire is burning. */
export function newFireLife() {
  return { phase: 'burning', wet: 0, vitality: 1, coal: 1, clock: 0 };
}

/**
 * One tick. Mutates and returns `state`.
 *
 * @param {FireLifeState} state
 * @param {number} dtSec the frame's delta (clamped to 0.25 s: a hidden tab must not jump a fire a minute ahead)
 * @param {object} w the weather AT this fire
 * @param {number} w.rain01 rain reaching it (precipitation x sky exposure), 0..1
 * @param {boolean} [w.snuffable=true] `canBeSnuffed`
 * @param {number} [w.rainResponse=1] the author's dial (0 = rain does nothing)
 * @param {number} [w.seed=0] for the rekindle's cough
 * @param {number} [w.timeSec=0] the fire clock, for the cough
 * @param {Partial<typeof FIRE_LIFE>} [life] overrides of `FIRE_LIFE`
 * @returns {FireLifeState}
 */
export function stepFireLife(state, dtSec, w = {}, life = FIRE_LIFE) {
  const L = { ...FIRE_LIFE, ...life };
  const dt = clamp(Number.isFinite(dtSec) ? dtSec : 0, 0, 0.25);
  const snuffable = w.snuffable !== false;
  const rain = clamp(Number.isFinite(w.rain01) ? w.rain01 : 0, 0, 1);
  const rainEff = rain * clamp(Number.isFinite(w.rainResponse) ? w.rainResponse : 1, 0, 2) * (snuffable ? 1 : 0.25);

  // wetness: the memory of the rain. It climbs at the rain's rate and drains when the rain eases.
  const drying = (1 - Math.min(1, rainEff * 2)) / Math.max(1, L.drySec);
  state.wet = clamp(state.wet + (rainEff / Math.max(1, L.douseSec)) * dt - drying * dt, 0, 1.15);
  state.clock += dt;

  const flameOf = (wet) => 1 - smoothstep(0.25, 1.0, wet);

  switch (state.phase) {
    case 'burning': {
      state.coal = 1;
      let v = flameOf(state.wet);
      if (!snuffable) v = Math.max(v, L.immuneFloor);
      // the flame follows its target quickly in the one direction and slowly in the other: a gust of rain knocks it
      // down at once, and the fire takes a moment to climb back
      state.vitality += (v - state.vitality) * (v < state.vitality ? 1 - Math.exp(-dt / 1.2) : 1 - Math.exp(-dt / 6));
      if (snuffable && state.wet >= 1.0 && state.vitality < 0.06) {
        state.phase = 'out';
        state.clock = 0;
        state.vitality = 0;
      }
      break;
    }
    case 'out': {
      state.vitality = 0;
      // the coals cool; rain hisses them out much faster
      state.coal = clamp(state.coal - (dt / Math.max(1, L.smoulderSec)) * (1 + 3 * rain), 0, 1);
      if (state.coal <= 0.02) {
        state.phase = 'dead';
        state.clock = 0;
        state.coal = 0;
      } else if (state.wet < 0.3 && state.coal > 0.45 && rain < 0.05) {
        // it was only almost out: with the rain gone, the hot coals catch the wood again
        state.phase = 'burning';
        state.clock = 0;
      }
      break;
    }
    case 'dead': {
      state.vitality = 0;
      state.coal = 0;
      // the clock counts only while it is dry; rain resets the wait
      if (state.wet > 0.5 || rain > 0.05) state.clock = 0;
      if (state.clock >= L.rekindleDelaySec) {
        state.phase = 'rekindle';
        state.clock = 0;
      }
      break;
    }
    case 'rekindle': {
      const ramp = clamp(state.clock / Math.max(1, L.rekindleRampSec), 0, 1);
      // first the bed, a glint at a time; then the flame coughs up out of it
      const seedPhase = (Number(w.seed) % 997) * 0.37;
      const cough =
        0.55 +
        0.45 *
          Math.sin((Number.isFinite(w.timeSec) ? w.timeSec : 0) * 1.7 + seedPhase) *
          Math.sin((Number.isFinite(w.timeSec) ? w.timeSec : 0) * 0.43 + seedPhase * 1.9);
      state.coal = clamp(smoothstep(0, 0.4, ramp) * (0.75 + 0.25 * cough), 0, 1);
      state.vitality = clamp(smoothstep(0.35, 1, ramp) * (0.35 + 0.65 * Math.max(0, cough)), 0, 1);
      if (rain > 0.3 && snuffable) {
        // rain came back: it relapses
        state.phase = 'out';
        state.clock = 0;
      } else if (ramp >= 1) {
        state.phase = 'burning';
        state.clock = 0;
        state.vitality = Math.min(state.vitality, 0.9);
      }
      break;
    }
    default:
      state.phase = 'burning';
  }
  state.vitality = clamp(state.vitality, 0, 1);
  return state;
}

/**
 * A book of lives, one per fire id, for a subsystem to step each frame. A fire that is merely off-screen keeps (and keeps
 * living) its state; nothing is ever forgotten except by `reset()`, because a fire put out by rain on another floor must still
 * be out when the party comes back, and the book only ever holds one tiny record per fire the session has seen.
 *
 * @returns {{step:(id:string, dtSec:number, w:object, life?:object)=>FireLifeState, get:(id:string)=>FireLifeState|undefined,
 *   set:(id:string, partial:object)=>void, size:()=>number, reset:()=>void,
 *   snapshot:(limit?:number)=>Array<{id:string, phase:string, wet:number, vitality:number, coal:number}>}}
 */
export function createFireLifeBook() {
  const lives = new Map();
  return {
    step(id, dtSec, w, life) {
      let s = lives.get(id);
      if (!s) {
        s = newFireLife();
        lives.set(id, s);
      }
      return stepFireLife(s, dtSec, w, life);
    },
    get: (id) => lives.get(id),
    /** Force a fire into a state (the lab, tests, and a future "light this fire" action). */
    set(id, partial) {
      const s = lives.get(id) ?? newFireLife();
      Object.assign(s, partial);
      lives.set(id, s);
    },
    size: () => lives.size,
    reset: () => lives.clear(),
    /** The first `limit` lives as plain rounded numbers: what `getFireStatus()` shows, so a fire's fate can be read live. */
    snapshot(limit = 12) {
      const out = [];
      for (const [id, s] of lives) {
        if (out.length >= limit) break;
        out.push({
          id,
          phase: s.phase,
          wet: +s.wet.toFixed(3),
          vitality: +s.vitality.toFixed(3),
          coal: +s.coal.toFixed(3),
        });
      }
      return out;
    },
  };
}
