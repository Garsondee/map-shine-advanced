/**
 * THE ALMANAC'S BIOMES (docs/planning/Weather-Manager.md §5.2-§5.3).
 *
 * What is proven here:
 *   - the ToD curves have the SHAPE the design table claims, not just a
 *     plausible-looking function;
 *   - every one of the 10 biomes is a well-formed graph: every edge points at
 *     a REAL archetype id, every weight is positive, every node the walk can
 *     enter has a way OUT, and the whole graph is strongly connected (no dead
 *     ends, no islands);
 *   - dwell data is complete and inside sane bounds for every biome;
 *   - resolveBiome fails open, the same posture resolveArchetype already has.
 */
import {
  TOD_CURVES,
  TOD_CURVE_NAMES,
  evalTodCurve,
  DEFAULT_DWELL_HOURS,
  WEATHER_BIOMES,
  WEATHER_BIOME_IDS,
  resolveBiome,
  isKnownBiome,
  biomeNodeIds,
  isBiomeStronglyConnected,
} from '../weather-biomes.js';
import { WEATHER_ARCHETYPE_IDS } from '../weather-data.js';

export function run(t) {
  // ---- the curve table itself ---------------------------------------------------
  {
    t.ok('five curves, closed list', TOD_CURVE_NAMES.length === 5);
    t.ok(
      'every curve returns a value in [0,1] across the whole clock',
      TOD_CURVE_NAMES.every((name) =>
        Array.from({ length: 96 }, (_, i) => i / 4).every((h) => {
          const v = TOD_CURVES[name](h);
          return v >= 0 && v <= 1;
        })
      )
    );
    t.ok(
      'flat is genuinely flat',
      [0, 6, 12, 18, 23.9].every((h) => TOD_CURVES.flat(h) === 1)
    );
  }

  // ---- convectiveAfternoon: peaks 14-18h ------------------------------------------
  {
    const c = TOD_CURVES.convectiveAfternoon;
    t.ok('at the stated peak (16h) it is near maximum', c(16) > 0.95);
    t.ok('at 3am it is near its floor', c(3) < 0.15);
    t.ok('16h beats 3am by a wide margin', c(16) > c(3) * 5);
    t.ok('it rises through the morning toward the peak', c(9) < c(12) && c(12) < c(15));
  }

  // ---- radiativeDawn: peaks 04-08h, dies by 10 ------------------------------------
  {
    const r = TOD_CURVES.radiativeDawn;
    t.ok('at the stated peak (6h) it is near maximum', r(6) > 0.95);
    t.ok('by 10h (the stated die-off) it has collapsed', r(10) < 0.15);
    t.ok('by mid-afternoon it is at its floor', r(15) < 0.1);
    t.ok('dawn beats mid-afternoon by a wide margin', r(6) > r(15) * 5);
  }

  // ---- monsoonClock: hard peak ~15-17h, narrower than convectiveAfternoon --------
  {
    const m = TOD_CURVES.monsoonClock;
    const c = TOD_CURVES.convectiveAfternoon;
    t.ok('at the stated peak (16h) it is near maximum', m(16) > 0.95);
    t.ok(
      'its floor is lower than the afternoon bump’s (a HARD peak)',
      TOD_CURVES.monsoonClock(3) < TOD_CURVES.convectiveAfternoon(3)
    );
    // "Narrower" means it falls off faster leaving the peak.
    t.ok('two hours off-peak, monsoonClock has faded further than convectiveAfternoon', m(19) < c(19));
  }

  // ---- nocturnalCalm: a TROUGH crossing midnight, not a peak -----------------------
  {
    const n = TOD_CURVES.nocturnalCalm;
    t.ok('at 2am (the trough centre) it is near its floor', n(2) < 0.25);
    t.ok('at noon it is near maximum', n(12) > 0.9);
    t.ok('the trough genuinely crosses midnight: 23h is also low', n(23) < 0.3);
    t.ok('...and so is 5h, the other side of midnight', n(5) < 0.3);
    t.ok('noon beats 2am by a wide margin', n(12) > n(2) * 3);
  }

  // ---- evalTodCurve: fails open ----------------------------------------------------
  {
    t.ok(
      'a known name evaluates the real curve',
      evalTodCurve('convectiveAfternoon', 16) === TOD_CURVES.convectiveAfternoon(16)
    );
    t.ok('an unknown name fails open to 1 (no bias), not a throw', evalTodCurve('not-a-curve', 16) === 1);
    t.ok('a missing name fails open the same way', evalTodCurve(undefined, 16) === 1);
  }

  // ---- dwell defaults ----------------------------------------------------------------
  {
    t.ok(
      'every archetype has a default dwell row',
      WEATHER_ARCHETYPE_IDS.every((id) => DEFAULT_DWELL_HOURS[id])
    );
    t.ok(
      'every default dwell is a sane, ordered triple',
      WEATHER_ARCHETYPE_IDS.every((id) => {
        const d = DEFAULT_DWELL_HOURS[id];
        return d.min > 0 && d.min <= d.mean && d.mean <= d.max;
      })
    );
    t.ok(
      'storms are the shortest-lived thing in the table',
      DEFAULT_DWELL_HOURS.thunderstorm.mean < DEFAULT_DWELL_HOURS.clear.mean
    );
  }

  // ---- ⭐ every biome, validated as a real graph --------------------------------------
  {
    t.ok('ten biomes, matching the plan’s roster', WEATHER_BIOMES.length === 10);
    t.ok('ids are unique', new Set(WEATHER_BIOME_IDS).size === WEATHER_BIOME_IDS.length);
    t.ok('the table is frozen', Object.isFrozen(WEATHER_BIOMES) && Object.isFrozen(WEATHER_BIOMES[0]));

    for (const biome of WEATHER_BIOMES) {
      const nodes = biomeNodeIds(biome);
      t.ok(`${biome.id}: has at least one edge`, biome.transitions.length > 0);
      t.ok(
        `${biome.id}: every edge references REAL archetype ids`,
        biome.transitions.every((e) => WEATHER_ARCHETYPE_IDS.includes(e.from) && WEATHER_ARCHETYPE_IDS.includes(e.to))
      );
      t.ok(
        `${biome.id}: every edge weight is a positive finite number`,
        biome.transitions.every((e) => Number.isFinite(e.weight) && e.weight > 0)
      );
      t.ok(
        `${biome.id}: every edge names a real ToD curve (or omits one for flat)`,
        biome.transitions.every((e) => e.todCurve === undefined || Object.hasOwn(TOD_CURVES, e.todCurve))
      );
      t.ok(
        `${biome.id}: no self-loop (an edge from a state to itself)`,
        biome.transitions.every((e) => e.from !== e.to)
      );
      // ⭐ THE LIVENESS GUARANTEE — a node with no way out freezes the walk the
      // moment it's entered, silently, with no error and no test that would
      // catch it except this one.
      t.ok(
        `${biome.id}: every node has an outgoing edge (no dead ends)`,
        nodes.every((n) => biome.transitions.some((e) => e.from === n))
      );
      t.ok(`${biome.id}: the graph is strongly connected (no dead ends, no islands)`, isBiomeStronglyConnected(biome));
      t.ok(
        `${biome.id}: dwellHours is COMPLETE — every archetype resolvable, not just the ones in the graph`,
        WEATHER_ARCHETYPE_IDS.every((id) => {
          const d = biome.dwellHours[id];
          return d && d.min > 0 && d.min <= d.mean && d.mean <= d.max;
        })
      );
      t.ok(
        `${biome.id}: archetypeWeights only names real ids with positive weight`,
        Object.entries(biome.archetypeWeights).every(([id, w]) => WEATHER_ARCHETYPE_IDS.includes(id) && w > 0)
      );
      t.ok(
        `${biome.id}: has a label and a blurb`,
        typeof biome.label === 'string' && typeof biome.blurb === 'string' && biome.blurb.length > 0
      );
      t.ok(`${biome.id}: tempByHour01 names a real curve`, Object.hasOwn(TOD_CURVES, biome.tempByHour01));
    }
  }

  // ---- the two "proof of data" biomes, specifically -------------------------------
  {
    const shadowfell = WEATHER_BIOMES.find((b) => b.id === 'shadowfell-verge');
    t.ok('shadowfell-verge has NO clear node — the gloom is structural', !biomeNodeIds(shadowfell).includes('clear'));
    t.ok(
      'shadowfell-verge clamps cover to a floor — the "permanent veil"',
      shadowfell.clamps?.cloudCover01?.min === 0.6
    );
    t.ok('it is STILL a valid, connected graph despite excluding clear', isBiomeStronglyConnected(shadowfell));

    const feywild = WEATHER_BIOMES.find((b) => b.id === 'feywild-glade');
    t.ok(
      'feywild-glade is a plain row in the same table — no special code path',
      Object.isFrozen(feywild) && Array.isArray(feywild.transitions)
    );
  }

  // ---- desert vs tropical-monsoon: the structural climate difference ---------------
  // The whole point of "adjacency lives in the graph": these two biomes should
  // disagree about what is even REACHABLE, not just about probabilities.
  {
    const desert = WEATHER_BIOMES.find((b) => b.id === 'desert');
    const monsoon = WEATHER_BIOMES.find((b) => b.id === 'tropical-monsoon');
    t.ok('desert never reaches steady-rain at all — no edge exists', !biomeNodeIds(desert).includes('steady-rain'));
    t.ok('tropical-monsoon DOES reach steady-rain', biomeNodeIds(monsoon).includes('steady-rain'));
    t.ok('desert has no snow edge (a hot biome cannot reach winter)', !biomeNodeIds(desert).includes('snow'));
    const boreal = WEATHER_BIOMES.find((b) => b.id === 'boreal-tundra');
    t.ok('boreal-tundra DOES reach snow', biomeNodeIds(boreal).includes('snow'));
  }

  // ---- resolveBiome: fails open, but with no fake default climate -----------------
  {
    const good = resolveBiome('desert');
    t.ok('a known id resolves', good.ok === true && good.biome.id === 'desert');
    t.ok('...with no reason', good.reason === null);

    const bad = resolveBiome('atlantis');
    t.ok('an unknown id fails to a NULL biome, not a fake default', bad.ok === false && bad.biome === null);
    t.ok('...and names the id in the reason', String(bad.reason).includes('atlantis'));
    t.ok('garbage input is equally safe', resolveBiome(null).biome === null && resolveBiome(42).biome === null);

    t.ok('isKnownBiome accepts real ids', isKnownBiome('temperate-coast') === true);
    t.ok('...and rejects nonsense', isKnownBiome('nope') === false && isKnownBiome(null) === false);
  }
}
