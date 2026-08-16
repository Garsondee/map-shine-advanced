/**
 * PRECIPITATION SUBSYSTEM — the lifecycle shell around the FALL runtime
 * (Precipitation.md §8).
 *
 * ============================================================================
 * WHAT THIS OWNS, AND WHAT IT DELIBERATELY DOES NOT
 * ============================================================================
 *
 * It owns: which species engines exist, which one is live this frame (derived
 * from `env.weather.precipKind`), pushing the per-frame response scalars into
 * them, and the view rect. It is the mirror of `effects/fire/fire-subsystem.js`
 * — a thin coordinator whose runtime lives in `effects/particles/` because the
 * `particles/allocator-only` wall requires every `instancedArray` call to.
 *
 * ⚠️ IT DOES NOT YET DRAW INTO THE LIVE FRAME, AND THAT IS DELIBERATE.
 * `Precipitation.md` LAW 3 is not optional: *"rain indoors is unrepresentable,
 * not discouraged"*. The sky-reach gate (`scene/sky-reach-access.js`, a door
 * built FOR this feature — its own 2026-07-24 header quotes the author saying
 * *"Rain will ask isCovered"*) is the next slice's work. Submitting this
 * subsystem's draw into `buf:scene.color` before that gate exists would put
 * rain inside every building on every map, which is a worse failure than not
 * shipping it yet.
 *
 * So this ships REACHABLE but not DRAWING: `boot.js` can build it, the console
 * can inspect it, `graph/passes.js` declares the gap as a `seam`, and the
 * shader lab renders the identical engines against a synthetic world. The one
 * thing nobody can do yet is see it in a real scene — which is exactly what
 * the status says.
 *
 * @module effects/precipitation/precip-subsystem
 */
import { createPrecipEngine } from '../particles/precip-runtime.js';
import { PRECIP_SPECIES, PRECIP_SPECIES_IDS, resolveSpeciesFrame, isBuiltSpecies } from './precip-species.js';
import { createLogger } from '../../core/log.js';

const log = createLogger('precip-subsystem');

/**
 * Which BUILT species a derived `precipKind` renders as.
 *
 * ⚠️ `sleet` MAPS TO A PAIR, NOT TO A ROW — it is a blend (Precipitation.md
 * §2.2), and the manager already hands us `precipMixWeight` telling us how much
 * of the COLD half is in it. P1 renders the dominant half and records the gap;
 * P5 splits the population per-particle by seed, which is the real answer.
 * Mapping it to `snow` outright would make a 0.49-weight sleet render as pure
 * rain and a 0.51 as pure snow — a hard flip in the middle of the band the
 * band exists to smooth.
 */
const KIND_TO_SPECIES = Object.freeze({
  rain: 'rain',
  snow: 'snow',
  sleet: null, // resolved by mix weight — see resolveActiveSpecies
  hail: null, // P5
  ash: null, // P6
  embers: null, // P6
});

/**
 * Which species should draw, given what the manager says is falling.
 * @param {string} precipKind @param {number} mixWeight
 * @returns {{speciesId: string|null, reason: string|null}}
 */
export function resolveActiveSpecies(precipKind, mixWeight = 0) {
  if (precipKind === 'sleet') {
    // The dominant half, until P5 can genuinely interleave both populations.
    return { speciesId: mixWeight >= 0.5 ? 'snow' : 'rain', reason: 'sleet renders as its dominant half until P5' };
  }
  const mapped = KIND_TO_SPECIES[precipKind];
  if (mapped && isBuiltSpecies(mapped)) return { speciesId: mapped, reason: null };
  if (Object.hasOwn(KIND_TO_SPECIES, precipKind)) {
    return { speciesId: null, reason: `'${precipKind}' is a real kind but its species is not built yet` };
  }
  return { speciesId: null, reason: `unknown precip kind '${precipKind}'` };
}

/**
 * @param {object} deps
 * @param {*} deps.THREE
 * @param {() => object} deps.getPrecipRenderState - the seam, mirroring
 *   `getFireRenderState`/`getLightningRenderState`: returns
 *   `{enabled, weather, worldRect, dayFactor01, tierScale}` each frame. A
 *   FUNCTION rather than a pushed object, so the subsystem never holds a stale
 *   snapshot and `boot.js` stays the composition root.
 * @param {object} [deps.windHandle]
 * @param {number} [deps.pxPerMeter]
 * @returns {object}
 */
export function createPrecipitationSubsystem({ THREE, getPrecipRenderState, windHandle, pxPerMeter = 100 }) {
  /** @type {Map<string, object>} speciesId → engine, built lazily. */
  const engines = new Map();
  let activeSpeciesId = null;
  let lastReason = null;
  let seeded = false;

  /** Build one species' engine on first use — a clear map never allocates. */
  function engineFor(speciesId) {
    if (engines.has(speciesId)) return engines.get(speciesId);
    const engine = createPrecipEngine({
      THREE,
      speciesId,
      windHandle,
      pxPerMeter,
      // Above the lit composite (precipitation is in front of the world,
      // including roofs) — the real number is set when the draw is wired.
      renderOrder: 0,
    });
    engines.set(speciesId, engine);
    log.info(`built '${speciesId}' engine (capacity ${engine.capacity})`);
    return engine;
  }

  return {
    /**
     * Advance one frame. Safe to call every frame from the moment the viewer
     * exists — with `precip01 = 0` it allocates nothing, steps nothing and
     * draws nothing (LAW 5's teeth).
     * @param {*} renderer @param {number} dtRealSec @param {number} nowMs
     */
    sync(renderer, dtRealSec, nowMs) {
      const st = getPrecipRenderState?.() ?? null;
      if (!st || st.enabled === false) {
        activeSpeciesId = null;
        return;
      }
      const weather = st.weather ?? {};
      const precip01 = Number.isFinite(weather.precip01) ? weather.precip01 : 0;

      // ⚠️ A JS `if`, never a uniform set to zero (Effects.md Law 4). A clear
      // day must not allocate an engine, dispatch a kernel or submit a draw.
      if (!(precip01 > 0)) {
        activeSpeciesId = null;
        return;
      }

      const { speciesId, reason } = resolveActiveSpecies(weather.precipKind ?? 'rain', weather.precipMixWeight ?? 0);
      lastReason = reason;
      activeSpeciesId = speciesId;
      if (!speciesId) return;

      const engine = engineFor(speciesId);
      if (!seeded) {
        engine.init(renderer);
        seeded = true;
      }
      if (st.worldRect) engine.setWorldRect(st.worldRect);
      engine.setFrame(
        resolveSpeciesFrame(
          PRECIP_SPECIES[speciesId],
          {
            precip01,
            stormActivity01: weather.stormActivity01 ?? 0,
            dayFactor01: st.dayFactor01 ?? 1,
            flash01: st.flash01 ?? 0,
          },
          st.tierScale ?? 1
        )
      );
      engine.step(renderer, dtRealSec, nowMs);
    },

    /** The scene the draw pass renders, or null when nothing is falling. */
    get scene() {
      return activeSpeciesId ? (engines.get(activeSpeciesId)?.scene ?? null) : null;
    },

    /** Live look tuning, for the debug panel and the console. */
    setTuning(t) {
      for (const engine of engines.values()) engine.setTuning(t);
    },

    /**
     * What the debug panel and the perf report print. Every factor separately
     * (`feedback_count_silent_preconditions`) — "no rain is visible" has half a
     * dozen possible causes and a single boolean would name none of them.
     */
    getStatus() {
      const st = getPrecipRenderState?.() ?? null;
      return {
        wired: false,
        wiredNote:
          'BUILT + lab-verified, NOT drawing into the live frame yet: the sky-reach gate (LAW 3, ' +
          'rain must be unrepresentable indoors) lands first. graph/passes.js declares the seam.',
        enabled: st?.enabled !== false,
        precip01: st?.weather?.precip01 ?? null,
        precipKind: st?.weather?.precipKind ?? null,
        activeSpeciesId,
        reason: lastReason,
        builtEngines: [...engines.keys()],
        availableSpecies: PRECIP_SPECIES_IDS,
        engines: Object.fromEntries([...engines].map(([id, e]) => [id, e.debugState()])),
      };
    },
  };
}
