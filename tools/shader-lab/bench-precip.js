/**
 * SHADER LAB — THE PRECIPITATION BENCH (rung 1→2).
 *
 * ============================================================================
 * WHY THIS EXISTS BEFORE THE EFFECT IS WIRED
 * ============================================================================
 *
 * The author, commissioning P1: *"it's a very large system so you might want to
 * set yourself up with the shader lab so that you can use that as a way to test
 * the appearance of the shaders as you develop and also allow you to throw
 * different values at the shader and check how it changes."*
 *
 * That is the whole brief for this file, and it is the right one: precipitation
 * has ~10 look dials whose correct values NOBODY KNOWS YET (`fallSlant01` most
 * of all — see `precip-runtime.js`'s header for why a physically-pure vertical
 * fall is nearly invisible under a top-down camera). Finding them by reloading
 * Foundry, waiting out a 52s cold BC decode and screenshotting a rainstorm is
 * the ten-round slow loop this whole tool was built (2026-07-30) to abolish.
 *
 * ============================================================================
 * THE ANIMATED HARNESS SHAPE — and the trap that makes it mandatory
 * ============================================================================
 *
 * Two harness shapes exist (`reference_shader_lab_tool`): the STATIC BAKE
 * (`lab.js` — one fullscreen quad, rendered offscreen, read back per refresh)
 * and the ANIMATED driver (`lightning-lab.js` — a real WebGPURenderer on its
 * own visible canvas, rendering every frame, exactly like production). A
 * particle population with its own spawn/fall/respawn lifecycle is emphatically
 * the second, so this follows `lightning-lab.js`.
 *
 * ⚠️ AND THEREFORE IT NEEDS A VIRTUAL CLOCK. `requestAnimationFrame` is FULLY
 * PAUSED — not throttled, STOPPED — whenever the Browser pane is not the
 * actively-displayed one (measured: 0 ticks across 300ms while unwatched), and
 * "nobody is currently looking at this pane" is the COMMON state while an agent
 * drives it by script. A driver that only advances via rAF is an instrument
 * that silently does nothing the moment it matters — exactly
 * `feedback_instruments_must_not_lie`. So {@link PrecipDriver#advance} is the
 * ONE place time moves and the real engine gets stepped; rAF is a thin
 * convenience wrapper over it, never the only path.
 *
 * ============================================================================
 * WHAT IS REAL HERE AND WHAT IS SYNTHETIC
 * ============================================================================
 *
 * REAL, imported from `src/` and never transcribed (AGENTS.md §6):
 *   - `createPrecipEngine` — the actual production runtime, its actual kernels,
 *     its actual draw material.
 *   - `PRECIP_SPECIES` / `resolveSpeciesFrame` — the actual species table and
 *     the actual response curves.
 *
 * SYNTHETIC, and named as such so no claim overreaches:
 *   - the world rect (a plain 2000×1500 box, not a real map's bounds)
 *   - the backdrop (a flat dark quad, so bodies are visible at all)
 *   - the wind (a hand-set ambient handle, not the real wind field)
 *   - NO sky-reach gate yet — that is task 19, and until it lands this bench
 *     shows rain falling everywhere including "indoors", which is CORRECT for
 *     what it currently measures and wrong for production. Stated here so a
 *     reader cannot mistake this bench's picture for a finished feature.
 *
 * @module tools/shader-lab/bench-precip
 */
import { evaluate, saveCanvasPng } from './contract.js';
import { createPrecipEngine } from '../../src/effects/particles/precip-runtime.js';
import {
  PRECIP_SPECIES,
  PRECIP_SPECIES_IDS,
  resolveSpeciesFrame,
} from '../../src/effects/precipitation/precip-species.js';

/** The synthetic world this bench rains on. Deliberately wide-ish so the
 * parallax has room to read; not a real map's bounds. */
const WORLD = Object.freeze({ minX: 0, minY: 0, maxX: 2000, maxY: 1500 });

/** Lab capacity, well under the species rows' production numbers (15k/20k).
 * A lab that runs the full production count is slower to iterate on and tells
 * you nothing extra about the LOOK — but see `full-capacity-compiles`, which
 * deliberately does run the real number, because "test at the REAL tier"
 * (AGENTS.md §6) has caught a device-loss in this tool before. */
const LAB_CAPACITY = 4000;

/**
 * The animated driver. One renderer, one canvas, one engine per species,
 * advanced by an explicit delta.
 */
class PrecipDriver {
  constructor({ THREE, log }) {
    this.THREE = THREE;
    this.log = log;
    this.renderer = null;
    this.camera = null;
    this.canvas = null;
    /** speciesId → engine. Both are built up front so switching is instant. */
    this.engines = new Map();
    this.activeSpecies = 'rain';
    this._rafId = null;
    this._active = true;
    this._virtualNowMs = 0;
    this._lastRafRealMs = null;
    this._measureRt = null;
    /** The synthetic wind handle — a plain object shaped like the real one's
     * `ambient` block, so the engine's by-reference uniform binding works
     * unchanged. NOT the real wind field (that is a P-later seam). */
    this.wind = null;

    /** Everything the panel drives. Axes on the left, look dials on the right —
     * the same split the production UI will have (axes belong to the weather
     * manager; look dials belong to the effect). */
    this.state = {
      // weather axes (manager-owned in production)
      precip01: 0.6,
      stormActivity01: 0,
      dayFactor01: 1,
      flash01: 0,
      windSpeed01: 0.25,
      windDirDeg: 90,
      // look dials (effect-owned)
      sizeScale: 1,
      fallSlant01: 0.62,
      slantDirDeg: 90,
      chaosScale: 1,
      streakScale: 1,
      cameraHeight: 1000,
      // view
      zoom: 1,
      paused: false,
    };
  }

  async init(canvas) {
    const THREE = this.THREE;
    this.canvas = canvas;
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: false, alpha: false });
    await this.renderer.init();
    this.log(`renderer backend: ${this.renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL'}`);
    // A dim blue-grey ground so pale bodies are legible. Not a real map.
    this.renderer.setClearColor(0x11151c, 1);

    // ⚠️ THE FLIPPED CAMERA, matching production exactly (`top = minY`). This
    // is not cosmetic: the flip inverts triangle winding, which is why every
    // runtime in `effects/particles/` sets `side: DoubleSide` and says so. A
    // lab camera with the conventional orientation would render the batch
    // happily and hide a bug that makes production draw nothing at all.
    this.camera = new THREE.OrthographicCamera(WORLD.minX, WORLD.maxX, WORLD.minY, WORLD.maxY, 0.1, 1000);
    this.camera.position.set(0, 0, 100);
    this.camera.updateProjectionMatrix();

    this.wind = {
      ambient: {
        speed01: THREE.TSL.uniform(THREE.TSL.float(this.state.windSpeed01)),
        directionDeg: THREE.TSL.uniform(THREE.TSL.float(this.state.windDirDeg)),
      },
    };

    for (const id of PRECIP_SPECIES_IDS) {
      const engine = createPrecipEngine({
        THREE,
        speciesId: id,
        worldRect: WORLD,
        capacity: LAB_CAPACITY,
        windHandle: this.wind,
        renderOrder: 10,
      });
      engine.setWorldRect(WORLD);
      engine.init(this.renderer);
      this.engines.set(id, engine);
    }

    this.applyState();
    this._fitCamera();

    this._frame = this._frame.bind(this);
    this._rafId = requestAnimationFrame(this._frame);
  }

  /** The engine currently on screen. */
  get engine() {
    return this.engines.get(this.activeSpecies) ?? null;
  }

  /**
   * Push the whole panel state into the real engine — through the SAME
   * `resolveSpeciesFrame` production will call, never a lab-local shortcut.
   * That is what makes a value found here transfer: the lab is driving the
   * production response model, not an approximation of it.
   */
  applyState() {
    const s = this.state;
    if (this.wind) {
      this.wind.ambient.speed01.value = s.windSpeed01;
      this.wind.ambient.directionDeg.value = s.windDirDeg;
    }
    for (const [id, engine] of this.engines) {
      const row = PRECIP_SPECIES[id];
      // Only the ACTIVE species gets a live count — the other's mesh stays
      // hidden, so a stray second population can never quietly contribute
      // pixels to a measurement.
      const active = id === this.activeSpecies;
      const frame = resolveSpeciesFrame(row, {
        precip01: active ? s.precip01 : 0,
        stormActivity01: s.stormActivity01,
        dayFactor01: s.dayFactor01,
        flash01: s.flash01,
      });
      // Scale the production count down to the lab's smaller capacity, so the
      // DENSITY on screen matches what production would show at this precip01
      // rather than being 4x too sparse.
      const scaled = { ...frame, liveCount: Math.round((frame.liveCount / row.capacity) * LAB_CAPACITY) };
      engine.setFrame(scaled);
      engine.setTuning({
        sizeScale: s.sizeScale,
        fallSlant01: s.fallSlant01,
        slantDirDeg: s.slantDirDeg,
        chaosScale: s.chaosScale,
        streakScale: s.streakScale,
        cameraHeight: s.cameraHeight,
      });
    }
  }

  _fitCamera() {
    const cx = (WORLD.minX + WORLD.maxX) / 2;
    const cy = (WORLD.minY + WORLD.maxY) / 2;
    const halfW = ((WORLD.maxX - WORLD.minX) / 2) * this.state.zoom;
    const halfH = ((WORLD.maxY - WORLD.minY) / 2) * this.state.zoom;
    this.camera.left = cx - halfW;
    this.camera.right = cx + halfW;
    // The flip, again — top is the SMALLER world Y.
    this.camera.top = cy - halfH;
    this.camera.bottom = cy + halfH;
    this.camera.updateProjectionMatrix();
    const rect = { minX: cx - halfW, maxX: cx + halfW, minY: cy - halfH, maxY: cy + halfH };
    for (const engine of this.engines.values()) engine.setWorldRect(rect);
  }

  set(partial) {
    Object.assign(this.state, partial);
    if ('zoom' in partial) this._fitCamera();
    this.applyState();
    return this.state;
  }

  setSpecies(id) {
    if (!this.engines.has(id)) return false;
    this.activeSpecies = id;
    this.applyState();
    return true;
  }

  /**
   * ⭐ THE ONE PLACE TIME ADVANCES — see this module's header for why rAF alone
   * would make this instrument silently do nothing whenever nobody is watching.
   * @param {number} deltaMs
   */
  advance(deltaMs) {
    const dt = Math.max(0, Number(deltaMs) || 0);
    this._virtualNowMs += dt;
    const engine = this.engine;
    if (!engine) return null;
    engine.step(this.renderer, dt / 1000, this._virtualNowMs);
    // Render EVERY engine's scene: the inactive one is hidden (liveCount 0 ⇒
    // mesh.visible false), so this costs nothing and keeps the draw path
    // identical whether one species or two are live — which is what production
    // will actually do when sleet blends them.
    this.renderer.render(engine.scene, this.camera);
    return this.readout();
  }

  _frame(realMs) {
    if (this._active && !this.state.paused) {
      const delta = this._lastRafRealMs === null ? 16 : realMs - this._lastRafRealMs;
      this._lastRafRealMs = realMs;
      // Clamp a huge gap (resuming after the pane was hidden) to one ordinary
      // step, so resuming never dumps a giant time-jump into the kernel.
      this.advance(Math.max(0, Math.min(250, delta)));
      this._updateLegend();
    } else {
      this._lastRafRealMs = realMs;
    }
    this._rafId = requestAnimationFrame(this._frame);
  }

  readout() {
    const engine = this.engine;
    return {
      speciesId: this.activeSpecies,
      virtualNowMs: Math.round(this._virtualNowMs),
      ...(engine?.debugState() ?? {}),
      axes: {
        precip01: this.state.precip01,
        stormActivity01: this.state.stormActivity01,
        dayFactor01: this.state.dayFactor01,
        flash01: this.state.flash01,
      },
    };
  }

  _updateLegend() {
    const el = document.getElementById('precipLegend');
    if (!el) return;
    const r = this.readout();
    el.textContent =
      `${r.speciesId}  live=${r.liveCount}/${r.capacity}  storage=${r.storageBuffers}/8 buffers  t=${(r.virtualNowMs / 1000).toFixed(1)}s\n` +
      `axes: precip=${r.axes.precip01.toFixed(2)} storm=${r.axes.stormActivity01.toFixed(2)} day=${r.axes.dayFactor01.toFixed(2)} flash=${r.axes.flash01.toFixed(2)}\n` +
      `look: slant=${r.tuning.fallSlant01.toFixed(2)} size=${r.tuning.sizeScale.toFixed(2)} streak=${r.tuning.streakScale.toFixed(2)} chaos=${r.tuning.chaosScale.toFixed(2)} camH=${r.tuning.cameraHeight}\n` +
      `⚠️ SYNTHETIC: no sky-reach gate yet — rain falls everywhere, including where a roof would stop it.`;
  }

  /**
   * Render into an offscreen target and count how many pixels the bodies
   * actually lit. The bench's ONE quantitative primitive: "is anything there,
   * and did it change" is most of what a look-tuning bench needs to assert,
   * and it is immune to the 1-D scanline trap (`findHoles`'s lesson — a line
   * through a 2-D artifact has lied to this project before).
   *
   * @param {number} [frames=30] - advance this many 16ms steps first, so a
   *   population that spawns staggered has settled into steady state.
   * @returns {Promise<{litPixels: number, totalPixels: number, meanLuma: number}>}
   */
  async measureCoverage(frames = 30) {
    const THREE = this.THREE;
    const W = 256;
    const H = 192;
    if (!this._measureRt) {
      this._measureRt = new THREE.RenderTarget(W, H, { depthBuffer: false, stencilBuffer: false });
    }
    for (let i = 0; i < frames; i++) this.advance(16);
    const engine = this.engine;
    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this._measureRt);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear();
    if (engine) this.renderer.render(engine.scene, this.camera);
    const raw = await this.renderer.readRenderTargetPixelsAsync(this._measureRt, 0, 0, W, H);
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.setClearColor(0x11151c, 1);

    let lit = 0;
    let sum = 0;
    for (let i = 0; i < raw.length; i += 4) {
      const luma = (raw[i] * 0.2126 + raw[i + 1] * 0.7152 + raw[i + 2] * 0.0722) / 255;
      sum += luma;
      // A deliberately low bar: bodies are thin and semi-transparent, so a
      // "was anything drawn" test that demands a bright pixel would report
      // zero for genuine light drizzle.
      if (luma > 0.02) lit++;
    }
    const totalPixels = raw.length / 4;
    return { litPixels: lit, totalPixels, meanLuma: sum / totalPixels };
  }

  // ⚠️ THERE IS DELIBERATELY NO `readBodies()`. A first cut of this file had
  // one — a per-body GPU buffer readback meant to answer "did bodies actually
  // descend" directly. It could not reach the arena's storage nodes from here
  // (the engine does not expose them, correctly), so it would have returned
  // `null`s wearing the shape of an answer. An instrument that reports nothing
  // in the format of a measurement is the exact failure
  // `feedback_instruments_must_not_lie` names, so it is absent rather than
  // stubbed. Motion questions are answered by `measureCoverage` across advanced
  // time instead; if a future scenario genuinely needs per-body state, the
  // honest fix is for the ENGINE to expose a debug read, not for the bench to
  // reach through it.
}

/**
 * Build the bench + its scenarios.
 * @param {{THREE: *, log: (m: string) => void}} deps
 */
export function createPrecipBench({ THREE, log }) {
  const driver = new PrecipDriver({ THREE, log });

  const scenarios = new Map();

  /**
   * ⭐ LAW 5, THE ONE CHECK THAT GATES SHIPPING AT ALL: a clear day must cost
   * nothing and draw nothing. Precipitation.md LAW 5 is explicit — `precip01 = 0`
   * ⇒ zero compute dispatched, zero draws submitted, byte-identical to today.
   * If this ever fails, the effect is not shippable regardless of how good the
   * rain looks.
   */
  scenarios.set('law5-clear-day-draws-nothing', {
    name: 'law5-clear-day-draws-nothing',
    summary: 'precip01=0 ⇒ zero live bodies, zero lit pixels, mesh hidden.',
    async run({ runId }) {
      driver.setSpecies('rain');
      driver.set({ precip01: 0 });
      const clear = await driver.measureCoverage(30);
      const clearState = driver.engine.debugState();
      driver.set({ precip01: 0.8 });
      const raining = await driver.measureCoverage(30);
      const rainState = driver.engine.debugState();
      const png = await saveCanvasPng(runId, 'raining.png', driver.canvas);

      return {
        checks: [
          evaluate('clear-day-has-zero-live-bodies', () => ({
            ok: clearState.liveCount === 0,
            measured: clearState.liveCount,
            expected: 0,
          })),
          evaluate('clear-day-hides-the-mesh', () => ({
            ok: clearState.visible === false,
            measured: clearState.visible,
            expected: false,
            note: 'a hidden mesh is what makes the draw genuinely unsubmitted (Effects.md Law 4)',
          })),
          evaluate('clear-day-lights-zero-pixels', () => ({
            ok: clear.litPixels === 0,
            measured: clear.litPixels,
            expected: 0,
          })),
          // ⚠️ THE NON-VACUITY GUARD. Without this, a broken engine that draws
          // nothing at ANY intensity would pass every check above and the
          // bench would certify a completely dead effect as LAW-5-compliant.
          evaluate('detector-is-not-vacuous-rain-does-light-pixels', () => ({
            ok: raining.litPixels > 0,
            measured: raining.litPixels,
            expected: '> 0',
            note: 'proves the zero above is a real absence, not a blind instrument',
          })),
          evaluate('rain-has-live-bodies', () => ({
            ok: rainState.liveCount > 0,
            measured: rainState.liveCount,
            expected: '> 0',
          })),
        ],
        inputs: { world: WORLD, labCapacity: LAB_CAPACITY },
        stats: { clear, raining },
        artifacts: png ? [png] : [],
      };
    },
  });

  /**
   * The response curves, measured through the REAL engine rather than in Node:
   * §2.3's claim is that rain's quadratic count makes drizzle sparse, and this
   * checks it end-to-end (curve → liveCount → actual lit pixels on a real GPU).
   */
  scenarios.set('intensity-ramps-density', {
    name: 'intensity-ramps-density',
    summary: 'lit-pixel coverage rises monotonically with precip01, quadratically for rain.',
    async run({ runId }) {
      driver.setSpecies('rain');
      const steps = [0.2, 0.5, 0.8, 1.0];
      const measured = [];
      for (const p of steps) {
        driver.set({ precip01: p });
        measured.push({ precip01: p, ...(await driver.measureCoverage(24)) });
      }
      const png = await saveCanvasPng(runId, 'rain-full.png', driver.canvas);
      return {
        checks: [
          evaluate('coverage-rises-monotonically', () => {
            const lits = measured.map((m) => m.litPixels);
            const rising = lits.every((v, i) => i === 0 || v >= lits[i - 1]);
            return { ok: rising, measured: lits, expected: 'non-decreasing' };
          }),
          evaluate('drizzle-is-genuinely-sparser-than-downpour', () => {
            const first = measured[0].litPixels;
            const last = measured[measured.length - 1].litPixels;
            return { ok: last > first * 2, measured: { first, last }, expected: 'last > 2x first' };
          }),
          evaluate('quadratic-count-shows-up-as-sub-linear-coverage-at-half', () => {
            // rain's count curve is x², so precip 0.5 should be nearer a
            // QUARTER of full coverage than a half. Generous bound — overdraw
            // and the parallax make this not a clean ratio, but a LINEAR count
            // would land near 0.5 and fail this.
            const half = measured[1].litPixels;
            const full = measured[3].litPixels;
            const ratio = full > 0 ? half / full : 1;
            return { ok: ratio < 0.42, measured: Number(ratio.toFixed(3)), expected: '< 0.42 (linear would be ~0.5)' };
          }),
        ],
        inputs: { steps },
        stats: { measured },
        artifacts: png ? [png] : [],
      };
    },
  });

  /**
   * Both species compile and draw on real WebGPU, and are visually DIFFERENT.
   * §11's "species matrix" check: every row × every body mode compiles and
   * draws — the four-graphs-per-tier lesson from water, which Node cannot see.
   */
  scenarios.set('species-matrix', {
    name: 'species-matrix',
    summary: 'rain and snow both compile, draw, and produce measurably different frames.',
    async run({ runId }) {
      const results = {};
      const artifacts = [];
      for (const id of PRECIP_SPECIES_IDS) {
        driver.setSpecies(id);
        driver.set({ precip01: 0.8, windSpeed01: 0.3 });
        results[id] = await driver.measureCoverage(40);
        const png = await saveCanvasPng(runId, `${id}.png`, driver.canvas);
        if (png) artifacts.push(png);
      }
      return {
        checks: [
          ...PRECIP_SPECIES_IDS.map((id) =>
            evaluate(`${id}-draws-something`, () => ({
              ok: results[id].litPixels > 0,
              measured: results[id].litPixels,
              expected: '> 0',
            }))
          ),
          evaluate('rain-and-snow-are-measurably-different', () => {
            const a = results.rain.litPixels;
            const b = results.snow.litPixels;
            const rel = Math.abs(a - b) / Math.max(1, Math.max(a, b));
            return {
              ok: rel > 0.1,
              measured: { rain: a, snow: b, relDiff: Number(rel.toFixed(3)) },
              expected: 'relative difference > 0.1',
              note: 'two species that render identically would mean the table is not reaching the kernel',
            };
          }),
        ],
        inputs: { species: PRECIP_SPECIES_IDS },
        stats: results,
        artifacts,
      };
    },
  });

  /**
   * ⚠️ AT THE REAL PRODUCTION CAPACITY, not the lab's convenient small one.
   * AGENTS.md §6: a device-loss bug was invisible at Standard settings and only
   * appeared at Extreme's real numbers. 15k rain bodies is the shipped row.
   */
  scenarios.set('full-capacity-compiles', {
    name: 'full-capacity-compiles',
    summary: 'a REAL production-capacity engine (15k rain bodies) builds, seeds, steps and draws.',
    async run() {
      const t0 = performance.now();
      let engine = null;
      let buildErr = null;
      try {
        engine = createPrecipEngine({
          THREE,
          speciesId: 'rain',
          worldRect: WORLD,
          windHandle: driver.wind,
        });
        engine.setWorldRect(WORLD);
        engine.init(driver.renderer);
        engine.setFrame(resolveSpeciesFrame(PRECIP_SPECIES.rain, { precip01: 1 }));
        for (let i = 0; i < 10; i++) engine.step(driver.renderer, 0.016, i * 16);
        driver.renderer.render(engine.scene, driver.camera);
      } catch (err) {
        buildErr = String(err?.message ?? err);
      }
      const buildMs = Math.round(performance.now() - t0);
      return {
        checks: [
          evaluate('production-capacity-engine-builds-and-runs', () => ({
            ok: buildErr === null,
            measured: buildErr ?? 'ok',
            expected: 'no throw',
          })),
          evaluate('capacity-is-the-species-rows-own-number', () => ({
            ok: engine?.capacity === PRECIP_SPECIES.rain.capacity,
            measured: engine?.capacity ?? null,
            expected: PRECIP_SPECIES.rain.capacity,
          })),
          // Graph CONSTRUCTION time is the cheap early-warning for the
          // device-loss class this tool has caught before: ~1ms is healthy,
          // seconds is a forming crash.
          evaluate('graph-construction-is-not-pathological', () => ({
            ok: buildMs < 5000,
            measured: `${buildMs}ms`,
            expected: '< 5000ms',
          })),
        ],
        inputs: { capacity: PRECIP_SPECIES.rain.capacity },
        stats: { buildMs },
        artifacts: [],
      };
    },
  });

  return {
    name: 'precip',
    title: 'Precipitation — the FALL (P1)',
    rung: 1,
    summary:
      'Real createPrecipEngine + real species table on a real WebGPU device. Synthetic world/wind/backdrop; ' +
      'NO sky-reach gate yet (task 19), so bodies fall everywhere including where a roof would stop them.',
    scenarios,
    params: {
      note: 'live dials are on the panel or via window.precipBench.set({...}) — see checkIds for what run() asserts',
      axes: ['precip01', 'stormActivity01', 'dayFactor01', 'flash01', 'windSpeed01', 'windDirDeg'],
      look: ['sizeScale', 'fallSlant01', 'slantDirDeg', 'chaosScale', 'cameraHeight', 'zoom'],
    },
    checkIds: [...scenarios.values()].flatMap((s) => s.name),
    ready: () => driver.renderer !== null,
    driver,
    async runScenario(scenario, ctx) {
      if (!driver.renderer) throw new Error('precip bench not initialised — select the Precipitation effect first');
      return scenario.run(ctx);
    },
  };
}
