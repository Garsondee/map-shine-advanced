/**
 * THE TORRENT — waves of lashing rain crossing the map at the top of the rain
 * fader, drawn as ONE combined quad (see `torrent-field.js` for the requests
 * and the picture: world-space waves, screen-space slanting sheets).
 *
 * ============================================================================
 * ⭐ A SCENE-RECT QUAD, NOT A POST PASS — AND WHY
 * ============================================================================
 *
 * The streaks are laid out in SCREEN pixels — `(worldXY − viewCentre) /
 * worldPxPerScreenPx` — so they read the same at any zoom: they are the water
 * between the eye and the map. The waves are WORLD space: they cross the map,
 * and must stay put on it when the camera pans. Both are drawn on the
 * same scene-rect quad storm-fog uses rather than a full-screen
 * drawn on the same scene-rect quad storm-fog uses rather than a full-screen
 * post pass, for one reason: LAW 3. A quad with a world position can sample
 * the outdoors gate, so a hall stays dry under a downpour; a post pass would
 * need a second, screen-space copy of that gate that could drift from the
 * first. Outside the scene rect (the padding) nothing rains, which is what
 * every other layer here already does.
 *
 * ⚠️ ONE QUAD, NOT ONE PER SPECIES — `storm-fog-render.js`'s own rule,
 * *"quantities add; appearances do not"*: the subsystem sums every active
 * population's weighted `torrent01` and hands this module one intensity. Only
 * rain carries a `respond.torrent` curve, so a sleet blend gets the rain
 * half's share and snow gets none.
 *
 * WHERE IT DRAWS: LAST in `precip-subsystem.js#scenes`, after storm-fog — the
 * nearest water to the eye sits in front of the fog, not behind it.
 *
 * ⚠️ NOT A VISION INPUT, EVER — the identical rule storm-fog and the curtain
 * state: this writes `buf:scene.color` and nothing else.
 *
 * @module effects/precipitation/torrent-render
 */
import {
  buildTorrentField,
  stepTorrentState,
  torrentWindGain,
  torrentVanishingPoint,
  TORRENT_WAVE,
} from './torrent-field.js';
import { buildWeatherShadeNode } from '../lighting/weather-shade.js';
import { createWindAdvectionUniforms, writeWindAdvectionUniforms } from '../../world/index.js';
import { markCompileDeferrable } from '../../core/compile-policy.js';

/** Overall ceiling on the layer's opacity at full intensity and strength 1. */
const MAX_TORRENT_ALPHA = 0.85;
/** Streak colour — near-white, a touch cool, the falling body's own head. */
const STREAK_RGB = Object.freeze([0.88, 0.92, 0.98]);

/**
 * @param {object} deps
 * @param {*} deps.THREE
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} deps.worldRect - the SCENE's bounds.
 * @param {number} [deps.zDepth=0]
 * @param {number} [deps.renderOrder=0]
 * @param {*} [deps.openSkyTexture] - the injected 1×1 WHITE placeholder.
 * @returns {object}
 */
export function createTorrent({
  THREE,
  worldRect = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
  zDepth = 0,
  renderOrder = 0,
  openSkyTexture = null,
  /** `buf:scene.illum` — the torrent darkens in a building's shadow like the ground. Absent ⇒ compiled out. */
  illumTexture = null,
}) {
  const TSL = THREE.TSL;
  const { Fn, float, vec2, vec3, vec4, uniform, mix, max, positionGeometry } = TSL;

  const uTimeMs = uniform(float(0));
  const uWindDirDeg = uniform(float(0));
  const uWindSpeed01 = uniform(float(0));
  /** Copied from the wind handle each step rather than bound by reference:
   * the viewer can replace its handle, and this quad is built lazily. */
  const uGustiness01 = uniform(float(0));
  const uPixelsPerMetre = uniform(float(65.6));
  /** The wind's integrated travel, for the gust surge — copied in `step` like the rest. */
  const uAdvection = createWindAdvectionUniforms(TSL);
  /** The CPU-integrated state — see `torrent-field.js`'s header for why the
   * shader never multiplies time by speed itself. */
  const uScroll = uniform(vec3(0, 0, 0));
  const uWaveOffset = uniform(vec2(0, 0));
  const uEvolveSec = uniform(float(0));
  /** The rain's vanishing point (screen px from centre) and the radius the
   * streak sizes are calibrated at — `torrentVanishingPoint`. */
  const uVanishPx = uniform(vec2(0, 0));
  const uRefPx = uniform(float(520));
  /** World centre of the view, and world px per screen px — the two numbers
   * that turn a world position into a screen one. */
  const uViewCenter = uniform(vec2(0, 0));
  const uWorldPerPx = uniform(float(1));
  /** The combined intensity × the wind's own gain, set on the CPU. */
  const uGain = uniform(float(0));
  const uStrength = uniform(float(1));
  const uHazeTint = uniform(vec3(0.62, 0.68, 0.78));
  const uRgbMul = uniform(float(1));
  /** The golden-hour colour of the light (`sky-access.js#lightGoldenTint`), (1,1,1) when none. */
  const uSkyTint = uniform(vec3(1, 1, 1));
  const uAlphaMul = uniform(float(1));
  /** How lit the scene is — applied AFTER the √ below, so darkness is felt in full. */
  const uSceneLight = uniform(float(1));

  const uSkyReachRect = uniform(vec4(0, 0, 1, 1));
  const uSkyReachHasBake = uniform(float(0));
  const openSkyPixel = openSkyTexture ?? null;
  const skyReachTex = openSkyPixel ? TSL.texture(openSkyPixel) : null;

  const spanX = Math.max(1, worldRect.maxX - worldRect.minX);
  const spanY = Math.max(1, worldRect.maxY - worldRect.minY);
  const geometry = new THREE.PlaneGeometry(spanX, spanY);
  geometry.translate((worldRect.minX + worldRect.maxX) / 2, (worldRect.minY + worldRect.maxY) / 2, zDepth);

  const material = new THREE.NodeMaterial();

  markCompileDeferrable(material, 'rain torrent');
  const worldXY = positionGeometry.xy;
  const screenPx = worldXY.sub(uViewCenter).div(uWorldPerPx);

  const { streak, haze, lead } = buildTorrentField(TSL, {
    screenPx,
    worldXY,
    windDirDeg: uWindDirDeg,
    windSpeed01: uWindSpeed01,
    gustiness01: uGustiness01,
    pixelsPerMetre: uPixelsPerMetre,
    timeMs: uTimeMs,
    advection: uAdvection,
    scroll: uScroll,
    waveOffset: uWaveOffset,
    evolveSec: uEvolveSec,
    vanishPx: uVanishPx,
    refPx: uRefPx,
  });

  const hazeA = haze.mul(float(TORRENT_WAVE.hazeAlpha));
  // The light half: streaks plus the bright lash along each wave's front.
  const lightA = streak.add(lead.mul(float(TORRENT_WAVE.leadAlpha))).clamp(float(0), float(1));
  // One straight-alpha output from two layers: the grey water under the light.
  const outA = float(1).sub(float(1).sub(hazeA).mul(float(1).sub(lightA)));

  const shade = buildWeatherShadeNode(TSL, {
    illumTexNode: illumTexture ? TSL.texture(illumTexture) : null,
    uSceneLight,
  });

  material.colorNode = Fn(() => {
    // Both take the SQUARE ROOT of the day/night scalar. Rain's own day
    // `rgbMul` (0.5) is tuned for bodies on a dark lab ground — on a sunlit
    // lawn it dims a streak, and the grey water of a wave, to the grass's own
    // brightness and the torrent vanishes (measured in the lab bench,
    // 2026-10-27). √ keeps night dimmer than day without flattening the day.
    const lit = uRgbMul.max(float(0)).sqrt().mul(uSceneLight);
    const lift = shade ? lit.mul(shade) : lit;
    const hazeRgb = uHazeTint.mul(lift).mul(uSkyTint);
    const streakRgb = vec3(...STREAK_RGB)
      .mul(lift)
      .mul(uSkyTint);
    const premul = hazeRgb.mul(hazeA).mul(float(1).sub(lightA)).add(streakRgb.mul(lightA));
    return premul.div(max(outA, float(1e-4)));
  })();

  material.opacityNode = Fn(() => {
    // LAW 3 — an indoor pixel stays dry. Same gate code as storm-fog.
    let gate = float(1);
    if (skyReachTex) {
      const sx = worldXY.x.sub(uSkyReachRect.x).div(uSkyReachRect.z.sub(uSkyReachRect.x).max(float(1)));
      const sy = worldXY.y.sub(uSkyReachRect.y).div(uSkyReachRect.w.sub(uSkyReachRect.y).max(float(1)));
      const inside = sx
        .greaterThanEqual(float(0))
        .and(sx.lessThanEqual(float(1)))
        .and(sy.greaterThanEqual(float(0)))
        .and(sy.lessThanEqual(float(1)));
      const sampled = skyReachTex.sample(vec2(sx.clamp(float(0), float(1)), sy.clamp(float(0), float(1)))).r;
      gate = mix(float(1), sampled, uSkyReachHasBake.mul(inside.select(float(1), float(0))));
    }
    return outA
      .mul(uGain)
      .mul(gate)
      .mul(uStrength)
      .mul(uAlphaMul)
      .mul(float(MAX_TORRENT_ALPHA))
      .clamp(float(0), float(1));
  })();

  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  /** ⚠️ DoubleSide — the flipped camera inverts winding. */
  material.side = THREE.DoubleSide;
  material.blending = THREE.NormalBlending;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  const scene = new THREE.Scene();
  scene.add(mesh);

  let intensity01 = 0;
  let windSpeed01 = 0;
  let windDirDeg = 0;
  let state = null;
  let lastStepMs = null;

  return {
    scene,

    /**
     * Advance the scroll and read the wind. `dtSec` is derived from the clock
     * when not given, so a caller with only a timestamp still animates.
     * @param {number} timeMs @param {object} [wind] @param {number} [dtSec]
     */
    step(timeMs, wind, dtSec) {
      const now = timeMs || 0;
      uTimeMs.value = now;
      if (wind?.ambient) {
        const sp = wind.ambient.speed01?.value;
        const dg = wind.ambient.directionDeg?.value;
        const gu = wind.ambient.gustiness01?.value;
        if (Number.isFinite(sp)) windSpeed01 = uWindSpeed01.value = sp;
        if (Number.isFinite(dg)) windDirDeg = uWindDirDeg.value = dg;
        if (Number.isFinite(gu)) uGustiness01.value = gu;
        const ppm = wind.ambient.pixelsPerMetre?.value;
        if (Number.isFinite(ppm) && ppm > 0) uPixelsPerMetre.value = ppm;
        writeWindAdvectionUniforms(uAdvection, wind.ambient.advection);
      }
      const dt = Number.isFinite(dtSec) ? dtSec : lastStepMs === null ? 0 : (now - lastStepMs) / 1000;
      lastStepMs = now;
      state = stepTorrentState(state, dt, windSpeed01, windDirDeg, uPixelsPerMetre.value);
      uScroll.value.set(state.scroll[0], state.scroll[1], state.scroll[2]);
      uWaveOffset.value.set(state.waveX, state.waveY);
      uEvolveSec.value = state.evolveSec;
      const vp = torrentVanishingPoint(windSpeed01, windDirDeg);
      uVanishPx.value.set(vp.x, vp.y);
      uRefPx.value = vp.refPx;
      uGain.value = intensity01 * torrentWindGain(windSpeed01);
    },

    /**
     * Where the camera is looking — call every frame, with the UNCLAMPED view
     * rect (a rect clamped to the scene would slide the pattern at its edges).
     * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} viewRect
     * @param {number} [viewportWidthPx]
     */
    setView(viewRect, viewportWidthPx) {
      if (!viewRect || !(viewRect.maxX > viewRect.minX)) return;
      uViewCenter.value.set((viewRect.minX + viewRect.maxX) / 2, (viewRect.minY + viewRect.maxY) / 2);
      // Absent a viewport width the pattern falls back to world scale — still
      // a picture, never a divide by zero.
      uWorldPerPx.value =
        Number.isFinite(viewportWidthPx) && viewportWidthPx > 0
          ? Math.max(1e-6, (viewRect.maxX - viewRect.minX) / viewportWidthPx)
          : 1;
    },

    /** @param {{intensity01:number, tint?:number[], rgbMul?:number, alphaMul?:number}} frame */
    setFrame(frame) {
      intensity01 = Number.isFinite(frame?.intensity01) ? Math.max(0, Math.min(1, frame.intensity01)) : 0;
      uGain.value = intensity01 * torrentWindGain(windSpeed01);
      if (Array.isArray(frame?.tint) && frame.tint.length === 3) uHazeTint.value.set(...frame.tint);
      if (Number.isFinite(frame?.rgbMul)) uRgbMul.value = frame.rgbMul;
      if (Array.isArray(frame?.skyTintRgb) && frame.skyTintRgb.length === 3) uSkyTint.value.set(...frame.skyTintRgb);
      else uSkyTint.value.set(1, 1, 1);
      if (Number.isFinite(frame?.alphaMul)) uAlphaMul.value = frame.alphaMul;
      if (Number.isFinite(frame?.sceneLight01)) uSceneLight.value = frame.sceneLight01;
    },

    setSkyReachTexture(texture, rect) {
      if (!openSkyPixel) return { armed: false, reason: 'no openSkyTexture injected' };
      if (!texture || !rect) {
        skyReachTex.value = openSkyPixel;
        uSkyReachHasBake.value = 0;
        return { armed: false, reason: texture ? 'no rect supplied' : 'no texture supplied' };
      }
      skyReachTex.value = texture;
      uSkyReachRect.value.set(rect.minX, rect.minY, rect.maxX, rect.maxY);
      uSkyReachHasBake.value = 1;
      return { armed: true, rect };
    },

    setTuning(t = {}) {
      if (Number.isFinite(t.torrentStrength)) uStrength.value = t.torrentStrength;
    },

    /** Below rain's own torrent threshold this is the common case — a JS `if`
     * at the call site keeps it free (Law 5). */
    get hasContent() {
      return intensity01 > 0 && uStrength.value > 0;
    },

    debugState() {
      return {
        intensity01,
        gain: uGain.value,
        visible: this.hasContent,
        strength: uStrength.value,
        maxAlpha: MAX_TORRENT_ALPHA,
        worldPerPx: uWorldPerPx.value,
        wind: { speed01: uWindSpeed01.value, directionDeg: uWindDirDeg.value, gustiness01: uGustiness01.value },
        vanishPx: { x: uVanishPx.value.x, y: uVanishPx.value.y, refPx: uRefPx.value },
        skyGate: {
          hasPlaceholder: Boolean(openSkyPixel),
          inGraph: Boolean(skyReachTex),
          armed: uSkyReachHasBake.value === 1,
        },
      };
    },

    dispose() {
      geometry.dispose();
      material.dispose?.();
    },
  };
}
