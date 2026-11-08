/**
 * THE GROUND MIST — the `fogDensity01` axis, drawn (mmp-63o.1, 2026-11-07).
 *
 * One quad over the scene rect, drawn by the precipitation subsystem but stepped BEFORE its clear-day early-out:
 * fog is weather with nothing falling, so it must draw at `precip01 = 0` (the bug this module fixes was exactly
 * that: the Fog mood drew nothing because the only fog renderer sat behind that early-out).
 *
 * ============================================================================
 * HOW IT IS LIT — BY THE GROUND'S OWN LIGHT
 * ============================================================================
 *
 * The mist's colour is a pale albedo times `buf:scene.illum`, the light the ground beneath it is lit by
 * (ambient × sun × cloud shadow + every lamp, golden-hour tint included). So the fog is white at noon, amber at
 * golden hour, blue-black at night, darker in a building's shadow, and GLOWS around a lamp, all from the one buffer
 * the ground uses (`weather-shade.js` reads the same buffer to darken rain). The illum is read through five taps
 * spread over a few percent of the screen: real fog scatters light, so a lamp pool's hard wall-shadow edge becomes a
 * soft halo in the mist. No illum (a lab, a bare pipeline) falls back to the frame's flat `lightRgb`.
 *
 * ============================================================================
 * WHERE IT IS ALLOWED — OUTDOORS, FEATHERED
 * ============================================================================
 *
 * The atmosphere gate (the plain `_Outdoors` gate the veil and storm fog use; a roof over open ground does not
 * clear the air) is read twice: a coarse blurred copy (`ground-mist-gate.js`, built once per bake) so the mist
 * thins toward a wall instead of stopping on its line, and a fog BANK pushes closer to the wall than a gap does
 * (V2's "building encroachment"); and the hard gate itself, so an indoor pixel stays CLEAR (Law 3): the feather
 * only ever eats into the outdoor side.
 *
 * ⚠️ NOT A VISION INPUT, EVER — the same rule `curtain-render.js` and `storm-fog-render.js` state: this writes
 * `buf:scene.color` and nothing else. Fog makes the picture harder to read, never a token's sight shorter.
 *
 * @module effects/precipitation/ground-mist-render
 */
import { buildGroundMistField } from './ground-mist-field.js';
import { buildMistGateGrid } from './ground-mist-gate.js';
import { createWindAdvectionUniforms, writeWindAdvectionUniforms } from '../../world/index.js';
import { markCompileDeferrable } from '../../core/compile-policy.js';

/** The mist's albedo: a pale, very slightly cool grey (lit by the ground's light, so this is its colour at noon). */
export const MIST_ALBEDO = Object.freeze([0.86, 0.88, 0.91]);
/** World px the atmosphere gate is feathered over, inward from every wall. */
export const MIST_WALL_FEATHER_PX = 180;
/** Screen-UV radius of the illum taps — the halo a lamp makes in the mist. */
export const MIST_LIGHT_SPREAD_UV = 0.018;
/** Density below this draws nothing at all (a JS `if`, not a zero uniform: Law 4). */
export const MIST_MIN_DENSITY = 0.002;

/**
 * Build the ground-mist quad.
 * @param {object} deps
 * @param {*} deps.THREE
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} deps.worldRect - the SCENE's bounds.
 * @param {number} [deps.zDepth=0]
 * @param {number} [deps.renderOrder=0]
 * @param {*} [deps.openSkyTexture] - the 1×1 white placeholder the gate starts on.
 * @param {*} [deps.illumTexture] - `buf:scene.illum` (screen-sized). Absent ⇒ lit by the frame's flat `lightRgb`.
 * @param {(grid: {data: Uint8Array, w: number, h: number}) => *} [deps.createGateTexture] - the texture door for the
 *   blurred gate (textures are made in `vt/` only — `gpu/textures-in-vt-only`). Absent ⇒ the mist keeps a hard edge.
 * @returns {object}
 */
export function createGroundMist({
  THREE,
  worldRect = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
  zDepth = 0,
  renderOrder = 0,
  openSkyTexture = null,
  illumTexture = null,
  createGateTexture = null,
}) {
  const TSL = THREE.TSL;
  const { Fn, If, float, vec2, vec3, vec4, uniform, mix, smoothstep, positionGeometry, screenUV, dFdx, dFdy, max } =
    TSL;

  const uTimeMs = uniform(float(0));
  const uWindDirDeg = uniform(float(0));
  const uWindSpeed01 = uniform(float(0));
  const uAdvection = createWindAdvectionUniforms(TSL);
  const uDensity01 = uniform(float(0));
  const uAlbedo = uniform(vec3(...MIST_ALBEDO));
  /** Flat light for a pipeline without illum (lab, fallback) — linear RGB. */
  const uLightRgb = uniform(vec3(1, 1, 1));
  /** Where the painterly relief takes its light from, a unit vector in world XY (top-left by default). */
  const uLightDir = uniform(vec2(-0.6, 0.8));

  const uGateRect = uniform(vec4(0, 0, 1, 1));
  const uGateHasBake = uniform(float(0));
  const gateTex = openSkyTexture ? TSL.texture(openSkyTexture) : null;
  /** The blurred copy of the gate, and the world rect it covers (it can overhang the gate's by under a block). */
  const softTex = openSkyTexture ? TSL.texture(openSkyTexture) : null;
  const uSoftRect = uniform(vec4(0, 0, 1, 1));
  /** The blurred copy we built and own (disposed when the gate changes). */
  let softOwned = null;
  let lastGateKey = '';
  const illumTex = illumTexture ? TSL.texture(illumTexture) : null;

  const spanX = Math.max(1, worldRect.maxX - worldRect.minX);
  const spanY = Math.max(1, worldRect.maxY - worldRect.minY);
  const geometry = new THREE.PlaneGeometry(spanX, spanY);
  geometry.translate((worldRect.minX + worldRect.maxX) / 2, (worldRect.minY + worldRect.maxY) / 2, zDepth);

  const material = new THREE.NodeMaterial();
  markCompileDeferrable(material, 'ground mist');

  const worldXY = positionGeometry.xy;

  /** The gate at a world point, 1 outside the baked rect (fail open, as storm fog does). */
  const gateAt = (xy) => {
    const sx = xy.x.sub(uGateRect.x).div(uGateRect.z.sub(uGateRect.x).max(float(1)));
    const sy = xy.y.sub(uGateRect.y).div(uGateRect.w.sub(uGateRect.y).max(float(1)));
    const inside = sx
      .greaterThanEqual(float(0))
      .and(sx.lessThanEqual(float(1)))
      .and(sy.greaterThanEqual(float(0)))
      .and(sy.lessThanEqual(float(1)));
    const sampled = gateTex.sample(vec2(sx.clamp(float(0), float(1)), sy.clamp(float(0), float(1)))).r;
    return mix(float(1), sampled, uGateHasBake.mul(inside.select(float(1), float(0))));
  };

  /** The blurred gate (`ground-mist-gate.js`), 1 outside its rect. Falls back to the hard gate itself. */
  const softAt = (xy) => {
    const sx = xy.x.sub(uSoftRect.x).div(uSoftRect.z.sub(uSoftRect.x).max(float(1)));
    const sy = xy.y.sub(uSoftRect.y).div(uSoftRect.w.sub(uSoftRect.y).max(float(1)));
    const sampled = softTex.sample(vec2(sx.clamp(float(0), float(1)), sy.clamp(float(0), float(1)))).r;
    return mix(float(1), sampled, uGateHasBake);
  };

  /**
   * ONE fragment function, so the noise can be SKIPPED: the gate is read first (two taps), and the field — all the
   * cost — runs only where the mist can show (outside, and more than half a feather from a wall). The derivatives
   * and the illum taps sit OUTSIDE that branch (WGSL wants both in uniform control flow), reading the vars it set.
   */
  material.colorNode = Fn(() => {
    const hard = gateTex ? gateAt(worldXY) : float(1);
    const soft = gateTex ? softAt(worldXY) : float(1);
    const field = float(0).toVar('mistField');
    const cover = float(0).toVar('mistCover');
    const strand = float(0).toVar('mistStrand');
    const alpha = float(0).toVar('mistAlpha');
    If(
      soft
        .greaterThan(float(0.5))
        .and(hard.greaterThan(float(0)))
        .and(uDensity01.greaterThan(float(0))),
      () => {
        const m = buildGroundMistField(TSL, {
          worldXY,
          timeMs: uTimeMs,
          density01: uDensity01,
          windDirDeg: uWindDirDeg,
          windSpeed01: uWindSpeed01,
          advection: uAdvection,
        });
        field.assign(m.field);
        cover.assign(m.cover);
        strand.assign(m.strand);
        alpha.assign(m.alpha);
      }
    );

    // The hard gate keeps every indoor pixel clear; the blurred one fades the mist out over the last stretch of
    // outdoor ground before a wall (it is 0.5 on the wall line). A bank (thick cover) reaches nearer the wall than a
    // gap does — V2's "building encroachment".
    const gate = hard.mul(smoothstep(float(0.5), mix(float(1.0), float(0.8), cover), soft));
    // A little more fog toward the edges of the view than at its centre (V2's distance falloff, kept gentle): the
    // eye's attention, and the tokens, are mostly in the middle.
    const rc = screenUV.sub(vec2(0.5, 0.5)).length().mul(float(1.414));
    const edge = mix(float(0.86), float(1.12), smoothstep(float(0.25), float(1.0), rc));
    const opacity = alpha.mul(edge).mul(gate).clamp(float(0), float(0.92));

    // THICKNESS TONE: the heart of a bank is brighter (more light scattered back up), its thin edges a cooler grey.
    const thick = cover.mul(field).mul(strand.mul(float(0.5)).add(float(0.75)));
    const tone = mix(float(0.8), float(1.06), smoothstep(float(0.15), float(0.85), thick));
    const cool = mix(vec3(0.9, 0.95, 1.04), vec3(1, 1, 1), smoothstep(float(0.2), float(0.7), thick));
    // PAINTERLY RELIEF: the field's own slope, in world units (so it does not change with zoom), against a light.
    const pxPerScreen = max(dFdx(worldXY.x).abs().add(dFdy(worldXY.y).abs()).mul(float(0.5)), float(1e-3));
    const slope = vec2(dFdx(field), dFdy(field)).div(pxPerScreen).mul(float(520));
    const relief = slope.dot(uLightDir).clamp(float(-1), float(1));
    const lit = float(1).add(relief.mul(float(0.2)));
    let light = uLightRgb;
    if (illumTex) {
      // The ring is TURNED by the fog's own field: four fixed taps step at fixed offsets from a hard light edge (a
      // straight line in the mist, seen in the lab); turned by a smooth field, that step follows the fog's shape.
      const ang = field.mul(float(12.566));
      const o = vec2(ang.cos(), ang.sin()).mul(float(MIST_LIGHT_SPREAD_UV));
      const o2 = vec2(o.y.negate(), o.x);
      const at = (off) => illumTex.sample(screenUV.add(off)).rgb;
      light = at(vec2(0, 0))
        .mul(float(2))
        .add(at(o))
        .add(at(o.negate()))
        .add(at(o2))
        .add(at(o2.negate()))
        .mul(float(1 / 6));
    }
    return vec4(uAlbedo.mul(cool).mul(tone.mul(lit)).mul(light), opacity);
  })();

  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  /** DoubleSide: the flipped camera inverts winding (the curtain's own note). */
  material.side = THREE.DoubleSide;
  /** NORMAL blending — fog is air replacing what is behind it (the curtain's reasoning). */
  material.blending = THREE.NormalBlending;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  const scene = new THREE.Scene();
  scene.add(mesh);

  let density01 = 0;

  return {
    scene,
    mesh,

    /** @param {number} timeMs @param {object} [wind] - the wind handle (`ambient.speed01/directionDeg/advection`). */
    step(timeMs, wind) {
      uTimeMs.value = timeMs || 0;
      if (wind?.ambient) {
        const sp = wind.ambient.speed01?.value;
        const dg = wind.ambient.directionDeg?.value;
        if (Number.isFinite(sp)) uWindSpeed01.value = sp;
        if (Number.isFinite(dg)) uWindDirDeg.value = dg;
        writeWindAdvectionUniforms(uAdvection, wind.ambient.advection);
      }
    },

    /** @param {{density01: number, lightRgb?: number[], albedo?: number[], lightDir?: number[]}} frame */
    setFrame(frame) {
      density01 = Number.isFinite(frame?.density01) ? Math.max(0, Math.min(1, frame.density01)) : 0;
      uDensity01.value = density01;
      if (Array.isArray(frame?.lightRgb) && frame.lightRgb.length === 3) uLightRgb.value.set(...frame.lightRgb);
      if (Array.isArray(frame?.albedo) && frame.albedo.length === 3) uAlbedo.value.set(...frame.albedo);
      if (Array.isArray(frame?.lightDir) && frame.lightDir.length === 2) {
        const [x, y] = frame.lightDir;
        const len = Math.hypot(x, y);
        if (len > 1e-6) uLightDir.value.set(x / len, y / len);
      }
    },

    /**
     * The atmosphere gate (plain outdoors). A DataTexture's own bytes are coarsened and blurred into the soft copy
     * here, once per bake; a texture without CPU bytes keeps a hard edge (the soft copy is then the gate itself).
     */
    setSkyReachTexture(texture, rect) {
      if (!gateTex) return { armed: false, reason: 'no openSkyTexture injected' };
      // The subsystem re-arms every layer on either gate's change; rebuild the blur only when OUR gate changed.
      const key =
        texture && rect ? `${texture.uuid}:${texture.version}:${rect.minX},${rect.minY},${rect.maxX},${rect.maxY}` : '';
      if (key && key === lastGateKey) return { armed: true, rect, soft: 'unchanged' };
      lastGateKey = key;
      softOwned?.dispose();
      softOwned = null;
      if (!texture || !rect) {
        gateTex.value = openSkyTexture;
        softTex.value = openSkyTexture;
        uGateHasBake.value = 0;
        return { armed: false, reason: texture ? 'no rect supplied' : 'no texture supplied' };
      }
      gateTex.value = texture;
      uGateRect.value.set(rect.minX, rect.minY, rect.maxX, rect.maxY);
      const img = texture.image;
      const grid =
        createGateTexture && img?.data && img.width > 0 && img.height > 0
          ? buildMistGateGrid(img.data, img.width, img.height, rect, MIST_WALL_FEATHER_PX)
          : null;
      if (grid) {
        softOwned = createGateTexture(grid);
        softTex.value = softOwned;
        uSoftRect.value.set(grid.rect.minX, grid.rect.minY, grid.rect.maxX, grid.rect.maxY);
      } else {
        softTex.value = texture;
        uSoftRect.value.set(rect.minX, rect.minY, rect.maxX, rect.maxY);
      }
      uGateHasBake.value = 1;
      return { armed: true, rect, soft: grid ? `${grid.w}x${grid.h}` : 'hard (no CPU bytes)' };
    },

    /** Anything to draw? A clear day is the common case, and the caller's JS `if` is what makes it free. */
    get hasContent() {
      return density01 > MIST_MIN_DENSITY;
    },

    debugState() {
      return {
        density01,
        visible: this.hasContent,
        litBy: illumTex ? 'scene.illum' : 'flat lightRgb',
        wind: { speed01: uWindSpeed01.value, directionDeg: uWindDirDeg.value },
        gate: { inGraph: Boolean(gateTex), armed: uGateHasBake.value === 1 },
      };
    },

    dispose() {
      softOwned?.dispose();
      softOwned = null;
      geometry.dispose();
      material.dispose?.();
    },
  };
}
