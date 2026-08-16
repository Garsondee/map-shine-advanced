/**
 * THE IMPRESSION CURTAIN — precipitation as a MEDIUM, not as bodies
 * (Precipitation.md §3.4).
 *
 * ============================================================================
 * ⭐ WHY A FIELD AND NOT MORE PARTICLES
 * ============================================================================
 *
 * §1.1's medium law: a body has a position, a velocity and a life, and that IS
 * a particle row. A MEDIUM has no individuals. Zoomed out until drops are
 * sub-pixel, drawing 100k of them to depict *"greyness moving in bands"* is
 * paying per-body cost for a field-shaped picture — and worse, it produces the
 * exact zoom-out mush this project has a memory about
 * (`keyhole-zoom-out-clarity`).
 *
 * So the curtain is one translucent quad over the world, alpha from an analytic
 * field. Zero textures, zero render targets, no simulation — Clouds.md's
 * representation discipline, applied to its sibling phenomenon.
 *
 * ⚠️ THIS KILLS THE MUSH **BY DESIGN, NOT BY TUNING**: what you see at distance
 * was never made of dots, so there is no sampling rate at which it can alias.
 * The specimen tier's own zoom gate (Effects.md Law 7 — a JS `if`, never a
 * uniform set to zero) simply stops submitting a draw, and the curtain is
 * already carrying the picture.
 *
 * ============================================================================
 * ⭐ ONE FIELD, THREE CONSUMERS — see `squall-field.js`
 * ============================================================================
 *
 * The alpha here is `squall × veil01 × skyReach`, and `squall` is the SAME
 * expression the falling bodies and the splashes read. That is §3.4 job 2 and
 * it is the reason the field lives in its own module: if the veil and the
 * specimens ever computed their own bands, a downpour would show a dense band
 * of drops falling through a thin patch of veil.
 *
 * ============================================================================
 * WHERE IT DRAWS
 * ============================================================================
 *
 * In the precipitation pass, BETWEEN the splashes and the falling bodies. The
 * curtain is the FAR rain and the bodies are the NEAR rain, so the bodies must
 * be in front of it; the splashes are on the ground, so they are behind it.
 * Ordering is the subsystem's `scenes` array, because two scenes cannot be
 * depth-sorted against each other.
 *
 * ⚠️ NOT A VISION INPUT, EVER (§3.5, and `fogDensity01`'s own rule). It writes
 * `buf:scene.color` and nothing else. Structured obscuration is a PICTURE; flat
 * mist that hides things belongs to the manager's axis, and neither may touch a
 * Pillar-11 buffer.
 *
 * @module effects/precipitation/curtain-render
 */
import { buildSquallField } from './squall-field.js';

/**
 * ⭐ Per-species veil colour — §3.4's *"tinted per species (rain grey-blue,
 * sand ochre, snow white, ash brown-grey)"*.
 *
 * ⚠️ NOT ON THE SPECIES ROW, and that is deliberate rather than an oversight.
 * A row's `body.headRgba` is the colour of ONE DROP; this is the colour of a
 * kilometre of air full of them, which is a different physical quantity —
 * air-light, not albedo. Storing them in one field would be
 * `feedback_one_byte_two_quantities` with pixels. When P6 adds `sand` and
 * `ash`, they add rows HERE as well as there.
 */
const VEIL_TINT = Object.freeze({
  rain: Object.freeze([0.62, 0.68, 0.78]),
  snow: Object.freeze([0.92, 0.94, 0.98]),
});
const DEFAULT_TINT = Object.freeze([0.7, 0.72, 0.76]);

/**
 * How opaque the veil gets at `veil01 = 1` and a full band.
 *
 * ⚠️ LOW, AND IT HAS TO BE. The curtain's job is *"raining over there"*, not
 * *"the map is behind frosted glass"*. Anything that genuinely obscures the map
 * is the mist axis's business (`fogDensity01`), which is upstream, authored,
 * and — critically — the thing a GM can turn off. A curtain that hid the floor
 * would be an effect nobody could disable without also stopping the rain.
 */
const MAX_VEIL_ALPHA = 0.34;

/**
 * Build the curtain for one species.
 *
 * @param {object} deps
 * @param {*} deps.THREE - injected.
 * @param {string} [deps.speciesId='rain']
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} deps.worldRect -
 *   the SCENE's bounds. The quad spans exactly this, so the veil stops at the
 *   map edge like everything else in this system.
 * @param {number} [deps.zDepth=0]
 * @param {number} [deps.renderOrder=0]
 * @param {*} [deps.openSkyTexture] - the injected 1×1 WHITE placeholder.
 * @returns {object}
 */
export function createPrecipCurtain({
  THREE,
  speciesId = 'rain',
  worldRect = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
  zDepth = 0,
  renderOrder = 0,
  openSkyTexture = null,
}) {
  const TSL = THREE.TSL;
  const { Fn, float, vec2, vec3, vec4, uniform, mix, positionGeometry } = TSL;

  const uTimeMs = uniform(float(0));
  const uWindDirDeg = uniform(float(0));
  const uWindSpeed01 = uniform(float(0));
  const uGustiness01 = uniform(float(0.5));
  /** The species' own `respond.veil(precip01)` — ZERO below its threshold, so
   * drizzle does not grey the air and a downpour does (§2.3). */
  const uVeil01 = uniform(float(0));
  const uBandDepth = uniform(float(0.8));
  const uBandScale = uniform(float(1));
  const uStrength = uniform(float(1));
  const uTint = uniform(vec3(...(VEIL_TINT[speciesId] ?? DEFAULT_TINT)));
  /** V2's scalar day/night lighting, the same pair the bodies ride — a veil
   * lit like noon at midnight is the single most obvious way an atmospheric
   * layer stops belonging to the scene. */
  const uRgbMul = uniform(float(1));
  const uAlphaMul = uniform(float(1));

  const uSkyReachRect = uniform(vec4(0, 0, 1, 1));
  const uSkyReachHasBake = uniform(float(0));
  const openSkyPixel = openSkyTexture ?? null;
  /** A SEPARATE `texture()` node from every other consumer's — a shared node
   * carries the wrong uv. Null ⇒ the gate compiles OUT rather than being built
   * around a null, which throws at graph-build, silently. */
  const skyReachTex = openSkyPixel ? TSL.texture(openSkyPixel) : null;

  const spanX = Math.max(1, worldRect.maxX - worldRect.minX);
  const spanY = Math.max(1, worldRect.maxY - worldRect.minY);
  const geometry = new THREE.PlaneGeometry(spanX, spanY);
  geometry.translate((worldRect.minX + worldRect.maxX) / 2, (worldRect.minY + worldRect.maxY) / 2, zDepth);

  const material = new THREE.NodeMaterial();

  /** The world position of this fragment. The quad is axis-aligned and spans
   * the scene rect, so `positionGeometry.xy` IS world space — no mapping, and
   * therefore no Y-flip to get wrong. */
  const worldXY = positionGeometry.xy;

  const squall = buildSquallField(TSL, {
    worldXY,
    timeMs: uTimeMs,
    directionDeg: uWindDirDeg,
    speed01: uWindSpeed01,
    gustiness01: uGustiness01,
    bandDepth: uBandDepth,
    scale: uBandScale,
  });

  material.colorNode = Fn(() => uTint.mul(uRgbMul))();

  material.opacityNode = Fn(() => {
    // ⭐ LAW 3, at the curtain. An indoor pixel must stay CLEAR — a veil drawn
    // over a hall is rain the player can see indoors just as surely as a drop
    // is, and §3.4 says so explicitly ("× skyReach so indoor pixels stay
    // clear"). Absence still means keep raining: with no bake this is a
    // constant 1.
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
    return squall
      .mul(uVeil01)
      .mul(gate)
      .mul(uStrength)
      .mul(uAlphaMul)
      .mul(float(MAX_VEIL_ALPHA))
      .clamp(float(0), float(1));
  })();

  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  /** ⚠️ DoubleSide — the flipped camera (`top = minY`) inverts winding and
   * `FrontSide` renders NOTHING, silently. The sixth surface in this codebase
   * to need this line. */
  material.side = THREE.DoubleSide;
  /**
   * ⚠️ NORMAL, NOT ADDITIVE. A curtain of rain is grey air BETWEEN the eye and
   * the world — it replaces what is behind it in proportion to its density.
   * Additive would make a downpour brighten the map it is supposed to be
   * greying, which is the wrong sign entirely and is exactly the mistake an
   * "atmosphere = glow" instinct produces.
   */
  material.blending = THREE.NormalBlending;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  const scene = new THREE.Scene();
  scene.add(mesh);

  let veil01 = 0;

  return {
    scene,
    speciesId,

    /** @param {number} timeMs @param {object} [wind] */
    step(timeMs, wind) {
      uTimeMs.value = timeMs || 0;
      // Re-read the handle EVERY frame rather than binding at build — the
      // viewer reassigns it when the wind field bakes, and a captured
      // reference goes dead silently. The fall runtime paid for that once.
      if (wind?.ambient) {
        const sp = wind.ambient.speed01?.value;
        const dg = wind.ambient.directionDeg?.value;
        const gu = wind.ambient.gustiness01?.value;
        if (Number.isFinite(sp)) uWindSpeed01.value = sp;
        if (Number.isFinite(dg)) uWindDirDeg.value = dg;
        if (Number.isFinite(gu)) uGustiness01.value = gu;
      }
    },

    /**
     * The frame's response scalars. `veil01` is the species' own threshold
     * curve, so a drizzle hands zero here and the curtain costs nothing.
     * @param {{veil01: number, rgbMul: number, alphaMul: number}} frame
     */
    setFrame(frame) {
      veil01 = Number.isFinite(frame?.veil01) ? Math.max(0, Math.min(1, frame.veil01)) : 0;
      uVeil01.value = veil01;
      if (Number.isFinite(frame?.rgbMul)) uRgbMul.value = frame.rgbMul;
      if (Number.isFinite(frame?.alphaMul)) uAlphaMul.value = frame.alphaMul;
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
      if (Number.isFinite(t.curtainStrength)) uStrength.value = t.curtainStrength;
      if (Number.isFinite(t.curtainBandDepth)) uBandDepth.value = t.curtainBandDepth;
      if (Number.isFinite(t.curtainBandScale)) uBandScale.value = Math.max(0.01, t.curtainBandScale);
    },

    /**
     * Is there anything to draw? Zero `veil01` is the COMMON case (every sky
     * below the species' threshold), and a JS `if` at the call site is what
     * makes §1.2's LAW 5 real — never a uniform set to zero.
     */
    get hasContent() {
      return veil01 > 0 && uStrength.value > 0;
    },

    debugState() {
      return {
        speciesId,
        veil01,
        visible: this.hasContent,
        tint: [...(VEIL_TINT[speciesId] ?? DEFAULT_TINT)],
        maxAlpha: MAX_VEIL_ALPHA,
        band: { depth: uBandDepth.value, scale: uBandScale.value, strength: uStrength.value },
        wind: {
          speed01: uWindSpeed01.value,
          directionDeg: uWindDirDeg.value,
          gustiness01: uGustiness01.value,
        },
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
