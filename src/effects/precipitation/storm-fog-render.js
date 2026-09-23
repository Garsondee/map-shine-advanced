/**
 * THE STORM FOG — reduced visibility at the top of the weather's own
 * intensity, drawn as ONE combined quad rather than one per species
 * (mythica-machina-press#34/#314).
 *
 * ============================================================================
 * ⭐ WHY ONE QUAD, NOT ONE PER SPECIES LIKE THE CURTAIN
 * ============================================================================
 *
 * The curtain draws once per active population because a half-and-half sleet
 * genuinely shows both a rain-grey veil AND a snow-white veil, interleaved
 * (`curtain-render.js`'s own header). Fog is a different kind of quantity —
 * it is `precip-subsystem.js#stepMantle`'s own already-established rule
 * applied a second time: *"quantities add; appearances do not"*. Two stacked
 * translucent fog layers would double-darken visibility in a way one real
 * atmosphere never does, and blending two tints produces a colour belonging
 * to neither weather. So the SUBSYSTEM combines every active population's
 * `fog01` into one intensity (a weighted sum — a quantity) and picks the
 * heaviest population's own tint (an appearance) BEFORE calling {@link
 * createStormFog}'s `setFrame` — this module never sees per-species state at
 * all.
 *
 * ============================================================================
 * WHERE IT DRAWS
 * ============================================================================
 *
 * LAST in `precip-subsystem.js#scenes` — nearest the eye, in front of the
 * falling bodies and even the roofline drips. Real heavy fog sits between the
 * eye and literally everything else in the scene, including nearby rain.
 *
 * ⚠️ NOT A VISION INPUT, EVER — the identical rule `curtain-render.js` states
 * for the same reason: this writes `buf:scene.color` and nothing else, gates
 * on the SAME sky-reach mask (never shows indoors), and must never touch any
 * Pillar-11 vision input. "Reduced visibility" here means a picture that is
 * harder to see, never a smaller vision radius Foundry's own fog-of-war
 * enforces — the two systems must stay unaware of each other.
 *
 * @module effects/precipitation/storm-fog-render
 */
import { buildStormFogField } from './storm-fog-field.js';

/**
 * How opaque the fog gets at `intensity01 = 1` and `strength = 1`.
 *
 * ⚠️ MUCH HIGHER THAN THE CURTAIN's 0.34, and that is the whole point of
 * having a second mechanism — the curtain deliberately never obscures the
 * map (`curtain-render.js`: *"a curtain that hid the floor would be an
 * effect nobody could disable without also stopping the rain"*, precisely
 * because it draws whenever ANY veil is up). Storm-fog only ever draws at
 * the extreme top of each species' own `respond.fog` threshold (0.6-0.7+),
 * so a much stronger ceiling here does not cost the curtain's own always-on
 * legibility. Short of 1.0 on purpose — a token must never fully disappear
 * under weather, only read as hard to make out.
 */
const MAX_FOG_ALPHA = 0.82;

/**
 * Build the combined storm-fog quad.
 *
 * @param {object} deps
 * @param {*} deps.THREE - injected.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} deps.worldRect -
 *   the SCENE's bounds, exactly like the curtain's own quad.
 * @param {number} [deps.zDepth=0]
 * @param {number} [deps.renderOrder=0]
 * @param {*} [deps.openSkyTexture] - the injected 1×1 WHITE placeholder.
 * @returns {object}
 */
export function createStormFog({
  THREE,
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
  /** The combined populations' weighted `fog01` — see this module's own
   * header for why this is a SUM, not a per-species value. */
  const uIntensity01 = uniform(float(0));
  const uStrength = uniform(float(1));
  const uTint = uniform(vec3(0.7, 0.72, 0.76));
  /** V2's day/night scalar pair, the same one the curtain and every falling
   * body rides — fog lit like noon at midnight is the same "stops belonging
   * to the scene" mistake the curtain's own header names. */
  const uRgbMul = uniform(float(1));
  const uAlphaMul = uniform(float(1));

  const uSkyReachRect = uniform(vec4(0, 0, 1, 1));
  const uSkyReachHasBake = uniform(float(0));
  const openSkyPixel = openSkyTexture ?? null;
  const skyReachTex = openSkyPixel ? TSL.texture(openSkyPixel) : null;

  const spanX = Math.max(1, worldRect.maxX - worldRect.minX);
  const spanY = Math.max(1, worldRect.maxY - worldRect.minY);
  const geometry = new THREE.PlaneGeometry(spanX, spanY);
  geometry.translate((worldRect.minX + worldRect.maxX) / 2, (worldRect.minY + worldRect.maxY) / 2, zDepth);

  const material = new THREE.NodeMaterial();

  /** Axis-aligned quad spanning the scene rect — `positionGeometry.xy` IS
   * world space, same as the curtain's own `worldXY`. */
  const worldXY = positionGeometry.xy;

  const mist01 = buildStormFogField(TSL, {
    worldXY,
    timeMs: uTimeMs,
    windDirDeg: uWindDirDeg,
    windSpeed01: uWindSpeed01,
  });

  material.colorNode = Fn(() => uTint.mul(uRgbMul))();

  material.opacityNode = Fn(() => {
    // LAW 3, restated a second time in this system: an indoor pixel stays
    // CLEAR. Absence still means keep the fog — a constant 1 with no bake.
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
    return mist01
      .mul(uIntensity01)
      .mul(gate)
      .mul(uStrength)
      .mul(uAlphaMul)
      .mul(float(MAX_FOG_ALPHA))
      .clamp(float(0), float(1));
  })();

  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  /** ⚠️ DoubleSide — the flipped camera inverts winding, exactly the curtain's
   * own note. */
  material.side = THREE.DoubleSide;
  /** NORMAL, not additive — fog is air replacing what is behind it, the
   * identical reasoning the curtain's own header gives in full. */
  material.blending = THREE.NormalBlending;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  const scene = new THREE.Scene();
  scene.add(mesh);

  let intensity01 = 0;

  return {
    scene,

    /** @param {number} timeMs @param {object} [wind] */
    step(timeMs, wind) {
      uTimeMs.value = timeMs || 0;
      if (wind?.ambient) {
        const sp = wind.ambient.speed01?.value;
        const dg = wind.ambient.directionDeg?.value;
        if (Number.isFinite(sp)) uWindSpeed01.value = sp;
        if (Number.isFinite(dg)) uWindDirDeg.value = dg;
      }
    },

    /**
     * The frame's already-combined response scalars — see this module's own
     * header for why the subsystem computes these rather than this instance.
     * @param {{intensity01: number, tint?: number[], rgbMul?: number, alphaMul?: number}} frame
     */
    setFrame(frame) {
      intensity01 = Number.isFinite(frame?.intensity01) ? Math.max(0, Math.min(1, frame.intensity01)) : 0;
      uIntensity01.value = intensity01;
      if (Array.isArray(frame?.tint) && frame.tint.length === 3) uTint.value.set(...frame.tint);
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
      if (Number.isFinite(t.stormFogStrength)) uStrength.value = t.stormFogStrength;
    },

    /** Is there anything to draw? Zero intensity is the common case (below
     * every species' own fog threshold), and a JS `if` at the call site is
     * what makes Law 5 real here too. */
    get hasContent() {
      return intensity01 > 0 && uStrength.value > 0;
    },

    debugState() {
      return {
        intensity01,
        visible: this.hasContent,
        tint: [uTint.value.x, uTint.value.y, uTint.value.z],
        maxAlpha: MAX_FOG_ALPHA,
        strength: uStrength.value,
        wind: { speed01: uWindSpeed01.value, directionDeg: uWindDirDeg.value },
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
