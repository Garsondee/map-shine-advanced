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
 *   - `createPrecipEngine` — the actual production FALL runtime, its actual
 *     kernels, its actual draw material.
 *   - `createPrecipSplashEngine` — the actual production ARRIVAL runtime (P2),
 *     drawn in production's own order (splashes under the curtain) through the
 *     one `_drawLayers` method every measurement also goes through.
 *   - `PRECIP_SPECIES` / `resolveSpeciesFrame` — the actual species table and
 *     the actual response curves. The splash rate is the SAME resolved frame
 *     the curtain gets, which is the coupling §4.1 asks for.
 *
 * SYNTHETIC, and named as such so no claim overreaches:
 *   - the world rect (a plain 2000×1500 box, not a real map's bounds)
 *   - the backdrop (a flat dark quad, so bodies are visible at all)
 *   - the wind (a hand-set ambient handle, not the real wind field)
 *   - the sky-reach texture (`buildSkyReachTexture` — a hand-drawn building and
 *     canopy, not a real floor's bake). The GATE ITSELF is real and armed: both
 *     the fall and the arrival sample it, and `skyGate: false` is the
 *     fail-open state rather than a missing feature.
 *
 * @module tools/shader-lab/bench-precip
 */
import { evaluate, saveCanvasPng } from './contract.js';
import { createPrecipEngine } from '../../src/effects/particles/precip-runtime.js';
import { createPrecipSplashEngine } from '../../src/effects/particles/precip-splash-runtime.js';
import { createMantleRuntime } from '../../src/effects/precipitation/mantle-runtime.js';
import { createPrecipCurtain } from '../../src/effects/precipitation/curtain-render.js';
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
 * Where the synthetic building and a known-open patch sit, in 0..1 UV of the
 * world rect — see `buildSkyReachTexture` for why both are deliberately
 * off-centre. Kept slightly INSIDE the building's own edges (0.10-0.40 →
 * 0.14-0.36) so the measurement never straddles the fade at its rim and
 * reports a partial as a failure.
 */
const BUILDING_UV = Object.freeze({ u0: 0.14, u1: 0.36, v0: 0.16, v1: 0.41 });
/** A patch with nothing over it, far from both the building and the canopy. */
const OPEN_SKY_UV = Object.freeze({ u0: 0.05, u1: 0.3, v0: 0.62, v1: 0.92 });

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
    /** speciesId → FALL engine. Both are built up front so switching is instant. */
    this.engines = new Map();
    /**
     * speciesId → ARRIVAL engine (P2). Built for BOTH species deliberately,
     * even though snow's reports `ok: false` and draws nothing — that is the
     * assertion `arrival-only-rain-splashes` reads, and building it only for
     * rain would make "snow has no splashes" unfalsifiable here.
     */
    this.splashEngines = new Map();
    /** speciesId → IMPRESSION curtain (P4). */
    this.curtains = new Map();
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
      sizeScale: 1.1,
      fallSlant01: 1,
      slantDirDeg: 90,
      chaosScale: 3.5,
      streakScale: 1.1,
      windAirSpeedPxS: 2600,
      parallaxStreak01: 1,
      cameraHeight: 2000,
      // ⭐ THE ARRIVAL (P2) — splash look dials + the two layer isolators.
      // `fall`/`arrival` exist so a measurement can attribute a pixel: a
      // scenario that could not switch the curtain OFF would be reading the
      // sum of two effects and calling it one (`feedback_aggregate_cannot_
      // name_the_source`).
      fall: true,
      arrival: true,
      // ⭐ THE IMPRESSION TIER (P4) — a third isolator, same reason as the other
      // two: a measurement must be able to say WHICH layer lit a pixel.
      curtain: true,
      curtainStrength: 1,
      curtainBandDepth: 0.8,
      curtainBandScale: 1,
      gustiness01: 0.6,
      splashSizeScale: 1,
      splashAlphaScale: 1,
      splashPeakBoost: 2.75,
      splashSmearGain: 1,
      splashRateScale: 1,
      // view
      zoom: 1,
      paused: false,
      // ⭐ LAW 3 — the synthetic roof. See buildSkyReachTexture.
      skyGate: false,
    };
    this._skyReachTexture = null;
  }

  /**
   * A SYNTHETIC sky-reach texture: open sky (255) everywhere except one solid
   * rectangular "building" and one soft-edged "canopy", both deliberately
   * OFF-CENTRE in both axes.
   *
   * ⚠️ THE ASYMMETRY IS THE POINT, not decoration. A centred test feature
   * cannot calibrate a flip — `bench-floor-lighting.js` and
   * `bench-block-compress.js` have BOTH recorded this exact trap (a centred
   * fixture reported `mismatchesSameOrder: 0, mismatchesFlipped: 0` and the
   * orientation check passed while telling you nothing). With the building at
   * a known non-centre position, "the dry patch is in the wrong corner" is a
   * visible, diagnosable failure rather than an invisible one.
   *
   * Row 0 = minY, matching `MaskGrid`'s own convention and the `flipY: false`
   * default every other bake in this project relies on.
   */
  buildSkyReachTexture() {
    const THREE = this.THREE;
    if (this._skyReachTexture) return this._skyReachTexture;
    const W = 128;
    const H = 96;
    const data = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = x / (W - 1);
        const v = y / (H - 1);
        let open = 255;
        // A hard-edged building: x 0.10-0.40, y 0.12-0.45 (low-left, off-centre
        // in BOTH axes so a flip in either is visible).
        if (u > 0.1 && u < 0.4 && v > 0.12 && v < 0.45) open = 0;
        // A soft canopy up and right: a radial falloff, so the FADE (rather
        // than a step) is visible at its rim — LAW 3 says fades, never steps.
        const dx = (u - 0.72) / 0.18;
        const dy = (v - 0.7) / 0.18;
        const d = Math.hypot(dx, dy);
        if (d < 1) open = Math.min(open, Math.round(255 * Math.min(1, d * d)));
        const i = (y * W + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = open;
        data[i + 3] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this._skyReachTexture = tex;
    return tex;
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
        // ⭐ P4 — the squall field's travelling half IS the wind door's gust
        // envelope, so the synthetic handle has to carry gustiness too. Without
        // it the bands would be the slow cell alone: correct, and completely
        // still, which is not a squall.
        gustiness01: THREE.TSL.uniform(THREE.TSL.float(this.state.gustiness01)),
      },
    };

    // The 1×1 open-sky placeholder the gate falls back to. Created HERE
    // because `gpu/textures-in-vt-only` forbids `new THREE.*Texture` inside
    // `effects/` — see `precip-runtime.js`'s own note. A lab is a legitimate
    // owner; in production this comes from the viewer, which lives in vt/.
    const openSkyTexture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
    openSkyTexture.needsUpdate = true;
    // Held so the mantle scenario can take the SAME placeholder the engines
    // do — one representation of "no data", shared, exactly as in production.
    this.openSkyTexture = openSkyTexture;

    for (const id of PRECIP_SPECIES_IDS) {
      const engine = createPrecipEngine({
        THREE,
        speciesId: id,
        worldRect: WORLD,
        capacity: LAB_CAPACITY,
        windHandle: this.wind,
        renderOrder: 10,
        openSkyTexture,
      });
      engine.setWorldRect(WORLD);
      // The lab's synthetic "scene" is the whole world rect, so the clip is
      // armed but never bites — proving the code path runs without changing
      // any existing scenario's numbers.
      engine.setSceneBounds(WORLD);
      engine.init(this.renderer);
      this.engines.set(id, engine);

      // ⭐ THE ARRIVAL, on the SAME synthetic world and the SAME open-sky
      // placeholder. Sharing the placeholder is deliberate: production shares
      // one too, and a lab that gave each engine its own texture could not
      // catch a bug where two consumers of one texture disagree about it.
      const splash = createPrecipSplashEngine({
        THREE,
        speciesId: id,
        worldRect: WORLD,
        capacity: Math.min(LAB_CAPACITY, 3000),
        windHandle: this.wind,
        renderOrder: 9,
        openSkyTexture,
      });
      splash.setWorldRect(WORLD);
      splash.setSceneBounds(WORLD);
      if (splash.ok) splash.init(this.renderer);
      this.splashEngines.set(id, splash);

      const curtain = createPrecipCurtain({
        THREE,
        speciesId: id,
        worldRect: WORLD,
        renderOrder: 9.5,
        openSkyTexture,
      });
      this.curtains.set(id, curtain);
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
      this.wind.ambient.gustiness01.value = s.gustiness01;
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
      // LAW 3's gate, armed/disarmed live so the difference is one click.
      engine.setSkyReachTexture(s.skyGate ? this.buildSkyReachTexture() : null, WORLD);
      engine.setTuning({
        sizeScale: s.sizeScale,
        fallSlant01: s.fallSlant01,
        slantDirDeg: s.slantDirDeg,
        chaosScale: s.chaosScale,
        streakScale: s.streakScale,
        windAirSpeedPxS: s.windAirSpeedPxS,
        parallaxStreak01: s.parallaxStreak01,
        cameraHeight: s.cameraHeight,
        curtainBandDepth: s.curtainBandDepth,
        curtainBandScale: s.curtainBandScale,
      });

      // ⭐ THE ARRIVAL gets the SAME resolved frame the curtain did — that is
      // the coupling under test, not a lab convenience. `setFrame` divides by
      // the species' own capacity, so handing it the lab-scaled `liveCount`
      // would understate the splash rate by the lab/production ratio; it takes
      // the UNSCALED frame and the lab caps its own arena instead.
      // The curtain takes the SAME resolved frame the bodies do — `veil01` is
      // the species' own threshold curve, so drizzle hands zero here.
      const curtain = this.curtains.get(id);
      if (curtain) {
        curtain.setFrame(active ? frame : { veil01: 0, rgbMul: 1, alphaMul: 1 });
        curtain.setSkyReachTexture(s.skyGate ? this.buildSkyReachTexture() : null, WORLD);
        curtain.setTuning({
          curtainStrength: s.curtainStrength,
          curtainBandDepth: s.curtainBandDepth,
          curtainBandScale: s.curtainBandScale,
        });
      }

      const splash = this.splashEngines.get(id);
      if (splash?.ok) {
        splash.setFrame(frame);
        splash.setSkyReachTexture(s.skyGate ? this.buildSkyReachTexture() : null, WORLD);
        splash.setTuning({
          splashSizeScale: s.splashSizeScale,
          splashAlphaScale: s.splashAlphaScale,
          splashPeakBoost: s.splashPeakBoost,
          splashSmearGain: s.splashSmearGain,
          splashRateScale: s.splashRateScale,
          curtainBandDepth: s.curtainBandDepth,
          windAirSpeedPxS: s.windAirSpeedPxS,
        });
      }
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
    for (const engine of this.splashEngines.values()) engine.setWorldRect(rect);
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
    engine.step(this.renderer, dt / 1000, this._virtualNowMs, this.wind);
    const splash = this.splashEngines.get(this.activeSpecies);
    if (splash?.ok) splash.step(this.renderer, dt / 1000, this._virtualNowMs, this.wind);
    this.curtains.get(this.activeSpecies)?.step(this._virtualNowMs, this.wind);

    this._drawLayers();
    return this.readout();
  }

  /**
   * ⭐ THE ONE PLACE THE PICTURE IS DEFINED — the on-screen frame and every
   * measurement go through it, so a scenario can never measure a different
   * composition from the one the author is looking at.
   *
   * ⚠️ SPLASHES FIRST, THEN THE CURTAIN — production's order
   * (`precipitationSubsystem.scenes`), not this file's convenience. Two scenes
   * cannot be depth-sorted against each other, so the order of the two
   * `render()` calls IS the depth order, and a lab that drew them the other way
   * round would look right here and wrong on the map.
   */
  _drawLayers() {
    const engine = this.engine;
    const splash = this.splashEngines.get(this.activeSpecies);
    const curtain = this.curtains.get(this.activeSpecies);
    // GROUND → FAR AIR → NEAR AIR, exactly production's `scenes` order.
    if (this.state.arrival && splash?.ok) this.renderer.render(splash.scene, this.camera);
    if (this.state.curtain && curtain?.hasContent) this.renderer.render(curtain.scene, this.camera);
    if (this.state.fall && engine) this.renderer.render(engine.scene, this.camera);
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
      // ⭐ SEPARATE, never merged into the fall's block. "No splashes" and "no
      // rain" are different failures with different causes.
      arrival: this.splashEngines.get(this.activeSpecies)?.debugState() ?? null,
      curtain: this.curtains.get(this.activeSpecies)?.debugState() ?? null,
      layers: { fall: this.state.fall, arrival: this.state.arrival, curtain: this.state.curtain },
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
      `arrival: ${r.arrival?.splashes ? `${r.arrival.liveCount}/${r.arrival.capacity} splashes  elong=${r.arrival.wind.elongation.toFixed(2)}x bias=${r.arrival.wind.centreBias.toFixed(2)}` : 'none — this species settles, it does not splash'}\n` +
      `axes: precip=${r.axes.precip01.toFixed(2)} storm=${r.axes.stormActivity01.toFixed(2)} day=${r.axes.dayFactor01.toFixed(2)} flash=${r.axes.flash01.toFixed(2)}\n` +
      `look: slant=${r.tuning.fallSlant01.toFixed(2)} size=${r.tuning.sizeScale.toFixed(2)} streak=${r.tuning.streakScale.toFixed(2)} chaos=${r.tuning.chaosScale.toFixed(2)} camH=${r.tuning.cameraHeight}\n` +
      (r.skyGate?.armed
        ? `🏠 SKY-REACH GATE ARMED (synthetic roof) — LAW 3: no rain over the building or under the canopy.`
        : `⚠️ sky-reach gate DISARMED — rain falls everywhere, including where a roof would stop it (fail-open).`);
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
    // ⚠️ 512×384, not 256×192. The first cut counted TENS of lit pixels inside
    // the gate's test footprint, which is noise, not a measurement — two runs
    // of the identical scene differed by more than the effect being tested.
    // Quadrupling the pixel count is the cheapest way to make a sparse,
    // thin-bodied effect actually resolvable.
    const W = 512;
    const H = 384;
    if (!this._measureRt) {
      this._measureRt = new THREE.RenderTarget(W, H, { depthBuffer: false, stencilBuffer: false });
    }
    for (let i = 0; i < frames; i++) this.advance(16);
    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this._measureRt);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear();
    // ⚠️ THE SAME COMPOSITION THE SCREEN SHOWS — see `_drawLayers`. A
    // measurement that drew only the curtain while the panel showed both would
    // report a number nobody could reproduce by looking.
    this._drawLayers();
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

  /**
   * Coverage inside ONE sub-rectangle of the frame, in 0..1 UV of the world.
   *
   * ⚠️ EXISTS BECAUSE A WHOLE-FRAME NUMBER CANNOT ANSWER A LOCAL QUESTION.
   * "Did the roof stop the rain" and "did the rain get dimmer" produce the same
   * few-percent drop in whole-frame coverage
   * (`feedback_aggregate_cannot_name_the_source`), so the gate's own scenario
   * measures the footprint it should have emptied and a patch it should not
   * have touched, separately.
   *
   * ⚠️ THE V FLIP IS EXPLICIT AND CALIBRATED AGAINST THE CAMERA, not assumed.
   * The bench's camera is deliberately flipped (`top = minY`, matching
   * production), so world +Y runs DOWN the readback rows. A UV rect quoted in
   * world terms therefore maps to readback rows directly — but stating it is
   * the difference between a check that means something and one that passes by
   * luck (`feedback_y_flip_recurring_risk`, bitten five times in this project).
   *
   * @param {{u0:number,u1:number,v0:number,v1:number}} uvRect
   * @param {number} [frames=30]
   */
  async measureRegion(uvRect, frames = 30) {
    const THREE = this.THREE;
    // ⚠️ 512×384, not 256×192. The first cut counted TENS of lit pixels inside
    // the gate's test footprint, which is noise, not a measurement — two runs
    // of the identical scene differed by more than the effect being tested.
    // Quadrupling the pixel count is the cheapest way to make a sparse,
    // thin-bodied effect actually resolvable.
    const W = 512;
    const H = 384;
    if (!this._measureRt) {
      this._measureRt = new THREE.RenderTarget(W, H, { depthBuffer: false, stencilBuffer: false });
    }
    for (let i = 0; i < frames; i++) this.advance(16);
    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this._measureRt);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear();
    // ⚠️ THE SAME COMPOSITION THE SCREEN SHOWS — see `_drawLayers`. A
    // measurement that drew only the curtain while the panel showed both would
    // report a number nobody could reproduce by looking.
    this._drawLayers();
    const raw = await this.renderer.readRenderTargetPixelsAsync(this._measureRt, 0, 0, W, H);
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.setClearColor(0x11151c, 1);

    const x0 = Math.max(0, Math.floor(uvRect.u0 * W));
    const x1 = Math.min(W, Math.ceil(uvRect.u1 * W));
    const y0 = Math.max(0, Math.floor(uvRect.v0 * H));
    const y1 = Math.min(H, Math.ceil(uvRect.v1 * H));
    let lit = 0;
    let total = 0;
    let sum = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 4;
        const luma = (raw[i] * 0.2126 + raw[i + 1] * 0.7152 + raw[i + 2] * 0.0722) / 255;
        total++;
        sum += luma;
        if (luma > 0.02) lit++;
      }
    }
    // ⚠️ `meanLuma` WAS MISSING UNTIL P4 NEEDED IT, and its absence is a lesson
    // rather than an oversight. COVERAGE cannot see a band: a full-strength veil
    // lights every pixel in every band AND every lull, so `litPixels` reads
    // 100% either way and "is it banded?" is unanswerable. Intensity is the
    // only axis the question lives on — the instrument has to measure the
    // quantity the claim is about (`feedback_measure_the_output_not_the_equation`).
    return { litPixels: lit, totalPixels: total, meanLuma: total > 0 ? sum / total : 0, region: { x0, x1, y0, y1 } };
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
        // ⚠️ THE SPECIMEN TIER ALONE. This compares rain's streaks against
        // snow's flakes, and a full-frame veil drawn over both compresses the
        // difference toward zero — measured: relDiff fell from 0.73 to 0.083
        // the moment P4's curtain existed. The bodies are the subject; the
        // curtain is a different claim with its own scenario.
        driver.set({ precip01: 0.8, windSpeed01: 0.3, fall: true, arrival: false, curtain: false });
        results[id] = await driver.measureCoverage(40);
        const png = await saveCanvasPng(runId, `${id}.png`, driver.canvas);
        if (png) artifacts.push(png);
      }
      driver.set({ arrival: true, curtain: true });
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
   * ⭐ LAW 3 — rain indoors must be UNREPRESENTABLE. The gate's own scenario,
   * and the one that has to pass before this effect is allowed to draw into a
   * real scene at all.
   *
   * Measures COVERAGE INSIDE the synthetic building's own footprint rather than
   * whole-frame coverage: a whole-frame drop of a few percent is exactly what a
   * slightly-dimmer downpour also looks like, so it could not tell "the roof
   * works" from "the alpha changed" (`feedback_aggregate_cannot_name_the_source`).
   */
  scenarios.set('law3-no-rain-indoors', {
    name: 'law3-no-rain-indoors',
    summary: 'the sky-reach gate empties the building footprint, fades under the canopy, and fails OPEN when absent.',
    async run({ runId }) {
      driver.setSpecies('rain');
      driver.set({ precip01: 0.9, windSpeed01: 0.15, zoom: 1, skyGate: false });
      const open = await driver.measureRegion(BUILDING_UV, 30);
      const openWhole = await driver.measureCoverage(2);
      const disarmed = driver.engine.debugState().skyGate;
      const pngOpen = await saveCanvasPng(runId, 'gate-disarmed.png', driver.canvas);

      driver.set({ skyGate: true });
      const gated = await driver.measureRegion(BUILDING_UV, 30);
      const gatedWhole = await driver.measureCoverage(2);
      const armed = driver.engine.debugState().skyGate;
      const outside = await driver.measureRegion(OPEN_SKY_UV, 2);
      const pngGated = await saveCanvasPng(runId, 'gate-armed.png', driver.canvas);

      return {
        checks: [
          evaluate('gate-reports-disarmed-before-a-texture-arrives', () => ({
            ok: disarmed.armed === false,
            measured: disarmed.armed,
            expected: false,
          })),
          // ⚠️ THE POLARITY CHECK, and the more important half of LAW 3's
          // contract: absence must mean KEEP RAINING. A gate that failed
          // CLOSED would make every un-ingested map silently dry, which looks
          // exactly like "the effect is off" and would be found by a user
          // rather than by this bench.
          evaluate('⭐ fails OPEN — no texture means rain everywhere, not nowhere', () => ({
            ok: open.litPixels > 0,
            measured: open.litPixels,
            expected: '> 0 inside the footprint while disarmed',
          })),
          evaluate('gate-reports-armed-once-a-texture-arrives', () => ({
            ok: armed.armed === true,
            measured: armed.armed,
            expected: true,
          })),
          // ⚠️ THE BAR IS 5%, AND IT MEASURED **0**. Getting here took one real
          // bug fix rather than a loosened assertion, and the history is worth
          // keeping: the first cut sampled the gate at the body's GROUND
          // position (Precipitation.md §3.1's wording) and left **61%** of the
          // rain still drawn inside the building. A controlled sweep of
          // `cameraHeight` — which is exactly a sweep of M(h) — collapsed the
          // residual to 0.0% at M≈1.1 and restored it at M=2.5, isolating the
          // cause with no guesswork: the gate asked about one place while the
          // viewer looked at another. Sampling the DRAWN position fixed it
          // outright. A tolerance wide enough to pass the broken version would
          // have shipped rain falling through roofs.
          evaluate('⭐ LAW 3: no rain inside the building', () => ({
            ok: gated.litPixels <= open.litPixels * 0.05,
            measured: {
              before: open.litPixels,
              after: gated.litPixels,
              residualPct: Number(((100 * gated.litPixels) / Math.max(1, open.litPixels)).toFixed(1)),
            },
            expected: 'at most 5% of the ungated count',
          })),
          // Non-vacuity: the gate must empty the ROOF, not the whole frame.
          evaluate('detector-is-not-vacuous-open-sky-still-rains', () => ({
            ok: outside.litPixels > 0,
            measured: outside.litPixels,
            expected: '> 0 outside the footprint while armed',
            note: 'proves the dry footprint is the gate working, not the effect switching itself off',
          })),
          evaluate('the-frame-as-a-whole-still-rains', () => ({
            ok: gatedWhole.litPixels > openWhole.litPixels * 0.4,
            measured: { before: openWhole.litPixels, after: gatedWhole.litPixels },
            expected: 'most of the frame unaffected — a roof is local',
          })),
        ],
        inputs: { buildingUv: BUILDING_UV, openSkyUv: OPEN_SKY_UV },
        stats: { open, gated, openWhole, gatedWhole, outside },
        artifacts: [pngOpen, pngGated].filter(Boolean),
      };
    },
  });

  /**
   * ⭐ P2 — THE ARRIVAL. Splashes exist, land only where sky reaches, follow
   * the SAME rate the curtain does, and smear with the wind.
   *
   * ⚠️ EVERY CHECK MEASURES THE SPLASH LAYER ALONE (`fall: false`). A combined
   * frame cannot attribute a pixel, and the whole point of §4.1 is that the
   * splash population is its own statistical process — measuring the sum would
   * let a dead splash engine pass on the rain's pixels
   * (`feedback_aggregate_cannot_name_the_source`).
   */
  scenarios.set('arrival-splashes-land-where-sky-reaches', {
    name: 'arrival-splashes-land-where-sky-reaches',
    summary: 'the splash layer draws, thins with precip01, obeys the sky gate, and never fires for snow.',
    async run({ runId }) {
      driver.setSpecies('rain');
      // ⚠️ SPLASHES ONLY, AND `curtain: false` IS LOAD-BEARING. This scenario
      // predates P4 and said "the curtain is off" while only switching off the
      // FALL — so once the impression tier existed, `snow-settles-it-does-not-
      // splash` measured a full-frame veil and reported 196,608 splash pixels
      // for a species that has no splashes at all. A layer isolator that names
      // two of three layers is not an isolator
      // (`feedback_aggregate_cannot_name_the_source`, in my own instrument).
      // ⚠️ `curtainBandDepth: 0` IS PART OF THE ISOLATION, not tuning. P4 wired
      // the squall field into the splash rate (§4.1's third factor), so a fixed
      // probe region now sits in whichever BAND the field happens to put there
      // — and when P4's default depth rose to 0.8 this scenario's open-sky probe
      // landed in a lull and collapsed from 961 lit px to 39, because thinning
      // the splashes pushes their already-faint pixels under the detector's
      // 0.02 luma floor. A THRESHOLD CLIFF, not a linear scaling, and it made a
      // correct system look broken. The field has its own scenario; this one is
      // about the GATE, so it flattens the field to its identity (depth 0 = a
      // full, even rate) and measures the one variable it names.
      driver.set({
        fall: false,
        arrival: true,
        curtain: false,
        skyGate: false,
        precip01: 0.9,
        windSpeed01: 0,
        curtainBandDepth: 0,
      });
      const heavy = await driver.measureCoverage(40);
      const pngHeavy = await saveCanvasPng(runId, 'splash-heavy.png', driver.canvas);

      driver.set({ precip01: 0.25 });
      const light = await driver.measureCoverage(40);

      driver.set({ precip01: 0 });
      const clear = await driver.measureCoverage(20);

      // LAW 3 on the ARRIVAL: water must not appear on an indoor floor.
      driver.set({ precip01: 0.9, skyGate: false });
      const roofOpen = await driver.measureRegion(BUILDING_UV, 40);
      driver.set({ skyGate: true });
      const roofGated = await driver.measureRegion(BUILDING_UV, 40);
      const outside = await driver.measureRegion(OPEN_SKY_UV, 10);
      const pngGated = await saveCanvasPng(runId, 'splash-gated.png', driver.canvas);

      // Snow settles; it must produce no arrival engine work at all.
      driver.setSpecies('snow');
      driver.set({ skyGate: false, precip01: 0.9 });
      const snowSplash = await driver.measureCoverage(30);
      const snowState = driver.splashEngines.get('snow').debugState();

      driver.setSpecies('rain');
      driver.set({ fall: true, precip01: 0.6, skyGate: false, curtainBandDepth: 0.8 });

      return {
        checks: [
          evaluate('splashes-draw-at-all', () => ({
            ok: heavy.litPixels > 200,
            measured: heavy.litPixels,
            expected: '> 200 lit px with the curtain OFF',
          })),
          // ⚠️ THE ONE CHECK A BROKEN TSL GRAPH CANNOT PASS. A graph that
          // throws at build renders NOTHING while every Node test stays green
          // and the bundle stays clean — the exact failure that cost P1 a live
          // session (`TSL.texture(null)`).
          evaluate('rate-follows-precip01', () => ({
            ok: heavy.litPixels > light.litPixels * 1.5,
            measured: { heavy: heavy.litPixels, light: light.litPixels },
            expected: 'heavy > 1.5x light',
          })),
          evaluate('law5-clear-day-draws-no-splashes', () => ({
            ok: clear.litPixels === 0,
            measured: clear.litPixels,
            expected: '0 — a JS if, not a uniform set to zero',
          })),
          evaluate('law3-no-splashes-indoors', () => {
            const before = roofOpen.litPixels;
            const after = roofGated.litPixels;
            const remaining = before > 0 ? after / before : 0;
            return {
              ok: remaining < 0.08,
              measured: { before, after, remaining: Number(remaining.toFixed(3)) },
              expected: '< 8% of the ungated splashes survive under the roof',
            };
          }),
          evaluate('the-gate-is-local-not-a-global-dimmer', () => ({
            ok: outside.litPixels > 100,
            measured: outside.litPixels,
            expected: '> 100 — open sky keeps its splashes',
          })),
          // ⚠️ READS THE ENGINE'S OWN VERDICT **AND** THE PIXELS. `ok:false`
          // alone would pass even if the engine drew anyway, and zero pixels
          // alone would pass if snow's splashes were merely invisible. Two
          // different failures, two assertions.
          evaluate('snow-settles-it-does-not-splash', () => ({
            ok: snowState.splashes === false && snowSplash.litPixels === 0,
            measured: { splashes: snowState.splashes, litPixels: snowSplash.litPixels },
            expected: 'engine refuses AND draws nothing',
          })),
        ],
        inputs: { buildingUv: BUILDING_UV, openSkyUv: OPEN_SKY_UV },
        stats: { heavy, light, clear, roofOpen, roofGated, outside, snowSplash, snowState },
        artifacts: [pngHeavy, pngGated].filter(Boolean),
      };
    },
  });

  /**
   * ⭐ WIND SMEAR (§4.1) — *"lashing against the ground is precisely an impact
   * that cannot stay round"*.
   *
   * ⚠️ MEASURED AS AN AREA CHANGE, NOT AN EYEBALLED SHAPE. The quad stretches
   * along the wind and shrinks across it by `1/√smear`, so a correct
   * implementation moves total coverage very little while the LOOK changes a
   * lot — which means the honest assertions are (a) the reported smear factor
   * tracks wind speed, and (b) coverage does not COLLAPSE or EXPLODE, i.e. the
   * area compensation is really there. A naive "coverage grows with wind" check
   * would pass on a bug that only stretched.
   */
  scenarios.set('arrival-smears-with-wind', {
    name: 'arrival-smears-with-wind',
    summary: 'wind makes an impact ASYMMETRIC (crown thrown downwind), it does not motion-blur it.',
    async run({ runId }) {
      driver.setSpecies('rain');
      driver.set({ fall: false, arrival: true, curtain: false, skyGate: false, precip01: 0.9, windSpeed01: 0 });
      const calm = await driver.measureCoverage(40);
      const calmWind = driver.splashEngines.get('rain').debugState().wind;

      driver.set({ windSpeed01: 1 });
      const gale = await driver.measureCoverage(40);
      const galeWind = driver.splashEngines.get('rain').debugState().wind;
      const png = await saveCanvasPng(runId, 'splash-smear-gale.png', driver.canvas);

      driver.set({ fall: true, windSpeed01: 0.25, precip01: 0.6 });

      const ratio = calm.litPixels > 0 ? gale.litPixels / calm.litPixels : 0;
      return {
        checks: [
          evaluate('calm-is-round-and-centred', () => ({
            ok: Math.abs(calmWind.elongation - 1) < 1e-6 && Math.abs(calmWind.centreBias) < 1e-6,
            measured: calmWind,
            expected: 'elongation exactly 1, bias exactly 0 — no asymmetry without a reason',
          })),
          // ⭐ THE ASYMMETRY IS THE LOOK, THE ELONGATION IS NOT. Asserting both
          // BOUNDS on the stretch is the point: the author rejected the first
          // model on sight as *"weirdly elongated — remember the top down
          // perspective"*, and a top-down splash is a stationary impact, so an
          // affine stretch along the wind is motion blur for an object that
          // never moved. A test that only demanded "more than 1" would pass the
          // 4x lozenge that was wrong.
          evaluate('gale-biases-far-more-than-it-stretches', () => ({
            ok: galeWind.centreBias > 0.25 && galeWind.elongation > 1.2 && galeWind.elongation < 1.6,
            measured: galeWind,
            expected: 'bias > 0.25 while elongation stays inside 1.2..1.6 (an egg, never a streak)',
          })),
          evaluate('area-is-compensated-not-inflated', () => ({
            ok: ratio > 0.6 && ratio < 1.8,
            measured: Number(ratio.toFixed(3)),
            expected: '0.6..1.8 — the across-wind axis gives back what the along-wind axis takes',
          })),
        ],
        inputs: { windSpeed01: [0, 1] },
        stats: { calm, gale, calmWind, galeWind, ratio },
        artifacts: png ? [png] : [],
      };
    },
  });

  /**
   * ⭐ P4 — THE IMPRESSION CURTAIN (§3.4). Three jobs, three checks each.
   *
   * ⚠️ MEASURED WITH THE OTHER TWO LAYERS OFF. The curtain's whole claim is
   * that it carries the picture ALONE when the specimens sleep, so a
   * measurement that included them would be reading the sum and calling it the
   * veil (`feedback_aggregate_cannot_name_the_source`).
   */
  scenarios.set('curtain-carries-the-distance', {
    name: 'curtain-carries-the-distance',
    summary: 'the veil draws only above the veil threshold, bands with the wind, and stops at a roof.',
    async run({ runId }) {
      driver.setSpecies('rain');
      driver.set({ fall: false, arrival: false, curtain: true, skyGate: false, windSpeed01: 0.5, gustiness01: 0.7 });

      // §2.3: the veil curve is a THRESHOLD — a downpour greys the air, drizzle
      // does not. Rain's threshold sits at 0.5.
      driver.set({ precip01: 0.3 });
      const drizzle = await driver.measureCoverage(20);
      driver.set({ precip01: 1 });
      const downpour = await driver.measureCoverage(20);
      const pngVeil = await saveCanvasPng(runId, 'curtain.png', driver.canvas);

      /**
       * The bands must be BANDS — a flat veil is fog, not a squall.
       *
       * ⚠️ MEASURED **ACROSS** THE BANDS, AND THE FIRST CUT MEASURED **ALONG**
       * THEM AND CONCLUDED "FLAT". The cell is anisotropically stretched in the
       * travel direction (§3.4 — weather arrives in lines), so at the bench's
       * wind the bands run east-west and vary north-south. Two patches compared
       * left-to-right therefore sit inside the SAME band and differ by under
       * 1%, which reads as a broken field and is really a broken measurement.
       * A strip of ten ROWS shows two to three bands.
       */
      const rows = [];
      for (let k = 0; k < 10; k++) {
        rows.push(await driver.measureRegion({ u0: 0.05, u1: 0.95, v0: k / 10, v1: (k + 1) / 10 }, 1));
      }
      const lumas = rows.map((r) => r.meanLuma);

      // LAW 3 at the curtain: no veil over a roof.
      driver.set({ skyGate: true });
      const gated = await driver.measureRegion(BUILDING_UV, 20);
      driver.set({ skyGate: false });
      const ungated = await driver.measureRegion(BUILDING_UV, 20);

      // Depth 0 must be the IDENTITY — a flat, full-strength veil, not a blank
      // one. That is what `mix(1, raw, depth)` buys and it is easy to get
      // backwards.
      driver.set({ curtainBandDepth: 0 });
      const flat = await driver.measureCoverage(15);
      driver.set({ curtainBandDepth: 0.8, fall: true, arrival: true, precip01: 0.6, windSpeed01: 0.25 });

      return {
        checks: [
          evaluate('veil-is-silent-below-its-threshold', () => ({
            ok: drizzle.litPixels === 0,
            measured: drizzle.litPixels,
            expected: '0 — drizzle does not grey the air (§2.3)',
          })),
          // ⚠️ THE CHECK A BROKEN TSL GRAPH CANNOT PASS.
          evaluate('downpour-draws-a-veil', () => ({
            ok: downpour.litPixels > 20000,
            measured: downpour.litPixels,
            expected: '> 20k lit px with BOTH particle tiers switched off',
          })),
          evaluate('the-veil-is-banded-not-flat', () => {
            const mn = Math.min(...lumas);
            const mx = Math.max(...lumas);
            const spread = (mx - mn) / Math.max(1e-6, (mx + mn) / 2);
            return {
              ok: spread > 0.15,
              measured: Number(spread.toFixed(3)),
              expected: '> 15% peak-to-trough across ten rows perpendicular to the bands',
            };
          }),
          // ⚠️ A SPREAD ALONE CANNOT TELL A BAND FROM A GRADIENT — a smooth ramp
          // across the frame scores exactly as well as a squall does. Counting
          // REVERSALS is what distinguishes them, and it is the check that would
          // have caught the first (5× too coarse) cell frequency, which measured
          // as a monotonic ramp with no bands in it at all.
          evaluate('they-are-bands-not-a-gradient', () => {
            let turns = 0;
            for (let i = 2; i < lumas.length; i++) {
              if (Math.sign(lumas[i] - lumas[i - 1]) !== Math.sign(lumas[i - 1] - lumas[i - 2])) turns++;
            }
            return { ok: turns >= 2, measured: turns, expected: '>= 2 reversals (a ramp has 0)' };
          }),
          evaluate('law3-no-veil-over-a-roof', () => {
            const remaining = ungated.litPixels > 0 ? gated.litPixels / ungated.litPixels : 0;
            return {
              ok: remaining < 0.1,
              measured: { ungated: ungated.litPixels, gated: gated.litPixels },
              expected: '< 10% of the veil survives over the building',
            };
          }),
          // ⚠️ DEPTH 0 IS THE IDENTITY (a full flat veil), NOT NOTHING. The
          // field lerps FROM 1, so turning the bands off leaves exactly the
          // un-banded behaviour every consumer had before P4 — which is what
          // lets the dial reach zero without the weather going out.
          evaluate('zero-band-depth-is-the-identity-not-a-blank', () => ({
            ok: flat.litPixels >= downpour.litPixels,
            measured: { banded: downpour.litPixels, flat: flat.litPixels },
            expected: 'a flat field covers at least as much as a banded one',
          })),
        ],
        inputs: { veilThreshold: 0.5, buildingUv: BUILDING_UV },
        stats: { drizzle, downpour, rowLumas: lumas.map((v) => Number(v.toFixed(4))), gated, ungated, flat },
        artifacts: pngVeil ? [pngVeil] : [],
      };
    },
  });

  /**
   * ⭐ P3 — THE MANTLE (§5). The world's memory of weather, measured by READING
   * THE BUFFER rather than by looking at the overlay.
   *
   * ⚠️ THIS IS THE ONE PART OF PRECIPITATION NOBODY CAN ITERATE ON BY LOOKING:
   * a mantle bug takes GAME HOURS to appear. So the scenario drives the
   * integrator with synthetic game-hour deltas and reads the texels back
   * directly — "the snow channel rose from 0.02 to 0.71 over four game hours"
   * is a finding; "the courtyard looks whiter" is a hypothesis.
   *
   * The Node suite proves the RATES; this proves the GPU actually integrates
   * them, which is the half Node structurally cannot see (a TSL graph that
   * fails to construct renders nothing, silently, with every test green).
   */
  scenarios.set('mantle-remembers-the-weather', {
    name: 'mantle-remembers-the-weather',
    summary: 'snow accumulates where sky reaches, melts when it warms, and never lies under a roof.',
    async run() {
      const THREE = driver.THREE;
      const renderer = driver.renderer;
      const targets = [];
      const mantle = createMantleRuntime({
        THREE,
        createTarget: (w, h) => {
          const rt = new THREE.RenderTarget(w, h, {
            depthBuffer: false,
            stencilBuffer: false,
            type: THREE.UnsignedByteType,
            format: THREE.RGBAFormat,
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
          });
          targets.push(rt);
          return rt;
        },
        // The same bind/render/restore the viewer injects — including the MRT
        // unbind, so the lab exercises the production path rather than a
        // simpler one.
        renderStep: (quad, target) => {
          const prev = renderer.getRenderTarget();
          const prevMRT = renderer.getMRT?.() ?? null;
          renderer.setMRT?.(null);
          renderer.setRenderTarget(target);
          quad.render(renderer);
          renderer.setRenderTarget(prev);
          renderer.setMRT?.(prevMRT);
        },
        worldRect: WORLD,
        openSkyTexture: driver.openSkyTexture,
      });
      mantle.setMasks({ skyReach: { texture: driver.buildSkyReachTexture(), rect: WORLD } });

      const snowStay = PRECIP_SPECIES.snow.stay;
      /** Read the mantle at one world point, as 0..1 per channel. */
      const probe = async (uvx, uvy) => {
        const rt = mantle.debugTarget();
        const px = Math.min(rt.width - 1, Math.max(0, Math.round(uvx * (rt.width - 1))));
        const py = Math.min(rt.height - 1, Math.max(0, Math.round(uvy * (rt.height - 1))));
        const raw = await renderer.readRenderTargetPixelsAsync(rt, px, py, 1, 1);
        return { snow: raw[0] / 255, dust: raw[1] / 255, puddle: raw[2] / 255 };
      };
      /** Advance `hours` of GAME time in `steps` integrator ticks. */
      const advance = (hours, steps, inputs) => {
        for (let i = 1; i <= steps; i++) {
          // Each call carries enough REAL time to pass the cadence gate.
          mantle.step(1, (i * hours) / steps, inputs);
        }
      };

      // ── a cold blizzard over open ground ──
      const freezing = { stay: snowStay, precip01: 1, temperature01: 0.05, cloudCover01: 1 };
      mantle.seed({ ...freezing, hoursOfWeather: 0 });
      const atStart = await probe(0.17, 0.77);
      advance(4, 40, freezing);
      const snowed = await probe(0.17, 0.77);
      // The synthetic building sits at u 0.10-0.40, v 0.12-0.45.
      const indoors = await probe(0.25, 0.3);

      // ── then a mild, humid thaw ──
      //
      // ⚠️ MEASURED **DURING** THE THAW, NOT AFTER IT, and the first cut got
      // this wrong: it probed at full heat under a clear sky after four hours
      // and found no puddle, then called that a failure. It was not — at
      // `dryPerHour`'s maximum the meltwater evaporates about as fast as it
      // arrives, and four hours later the ground is legitimately dry. The
      // instrument was looking for a transient after it had passed
      // (`feedback_measure_the_output_not_the_equation`'s cousin: a correct
      // model can still be measured at the wrong moment). A mild humid thaw is
      // also the more representative weather.
      const thaw = { stay: null, precip01: 0, temperature01: 0.6, cloudCover01: 0.7 };
      advance(1.5, 15, thaw);
      const thawing = await probe(0.17, 0.77);
      advance(6, 60, thaw);
      const thawed = await probe(0.17, 0.77);

      for (const rt of targets) rt.dispose();

      return {
        checks: [
          evaluate('the-buffer-starts-empty', () => ({
            ok: atStart.snow < 0.05,
            measured: atStart,
            expected: 'snow < 0.05 with zero hours of weather behind it',
          })),
          // ⚠️ THE CHECK A BROKEN TSL GRAPH CANNOT PASS. A graph that throws at
          // build renders nothing while every Node test stays green.
          evaluate('snow-accumulates-over-game-hours', () => ({
            ok: snowed.snow > 0.5,
            measured: Number(snowed.snow.toFixed(3)),
            expected: '> 0.5 after 4 game hours of blizzard',
          })),
          evaluate('law3-no-snow-under-a-roof', () => ({
            ok: indoors.snow < 0.05,
            measured: Number(indoors.snow.toFixed(3)),
            expected: '< 0.05 inside the building, while the courtyard is deep',
          })),
          evaluate('warmth-melts-it-away-again', () => ({
            ok: thawed.snow < snowed.snow * 0.35,
            measured: { before: Number(snowed.snow.toFixed(3)), after: Number(thawed.snow.toFixed(3)) },
            expected: 'under 35% of the drift survives 4 warm hours',
          })),
          // ⭐ MELTWATER BECOMES PUDDLE — the one transfer between channels, and
          // what stops a thaw reading as snow simply being deleted.
          evaluate('meltwater-becomes-puddle-while-it-melts', () => ({
            ok: thawing.puddle > 0.02 && thawing.snow < snowed.snow,
            measured: { snow: Number(thawing.snow.toFixed(3)), puddle: Number(thawing.puddle.toFixed(3)) },
            expected: 'mid-thaw: the snow channel is falling AND the puddle channel is above zero',
          })),
          // …and the water goes too. A puddle that cannot dry is a permanent
          // scar on a map.
          evaluate('and-then-the-water-dries-too', () => ({
            ok: thawed.puddle < thawing.puddle,
            measured: { midThaw: Number(thawing.puddle.toFixed(3)), later: Number(thawed.puddle.toFixed(3)) },
            expected: 'the puddle drains once there is no more meltwater feeding it',
          })),
        ],
        inputs: { hoursSnowing: 4, hoursThawing: 7.5 },
        stats: { atStart, snowed, indoors, thawing, thawed, texels: `${mantle.texW}x${mantle.texH}` },
        artifacts: [],
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
