/**
 * CAMERA GLARE — everything bright light does inside the lens, composed into ONE half-resolution texture the
 * present adds after the camera's curve (2026-11-08, epic mmp-ilo: "one camera, one look").
 *
 * Pure builder: THREE/TSL injected, no renderer, no targets (the viewer owns the target and the draw — the same
 * boundary bloom-render.js keeps). Everything here is driven by the BLOOM PYRAMID, which is built from the scene at
 * the camera's exposure (dynamic-range.js), so every term is light that really is too bright for the picture:
 *
 *   glare      = the bloom's energy-normalised PSF (bloom-render.js#glareAt: narrow core + faint wide tail)
 *   halation   = film's warm red fringe: a medium-radius warm glow from the bloom's mid mip      (mmp-ilo.8)
 *   dirt       = a dust/grease image ON the glass, lit only where bright light sits behind it    (mmp-ilo.6)
 *   starburst  = aperture diffraction spikes, only from the most extreme glints                  (mmp-ilo.14)
 *   streaks    = anamorphic horizontal streaks from the brightest sources                         (mmp-ilo.17)
 *   ghosts     = internal reflections mirrored through the frame centre (screen-space)            (mmp-ilo.12)
 *   leak       = a warm light leak from the sun's side at golden hour                             (mmp-ilo.13)
 *   rainbow    = prismatic chroma on the most extreme highlights                                  (mmp-ilo.21)
 *
 * LAW 4 (a feature that is off costs nothing): `features` decides which terms are CONSTRUCTED. The viewer rebuilds
 * this small material when the set of non-zero amounts changes (`cameraGlareFeatures`), never gating by a uniform.
 *
 * SCREEN SPACE: the output is in screen space (the present samples it at its own screen uv). The bloom pyramid
 * describes the UNWARPED frame (it is built before the lens), so every pyramid read goes through the lens warp —
 * the same `lensWarpUv` the present uses — and the glass-borne terms (dirt, leak, rainbow) read the plain screen uv.
 *
 * @module effects/camera-glare-render
 */

import { lensWarpUv } from './lens-render.js';

/** The glare terms a material can be built with, in a stable order (the structure key). */
export const CAMERA_GLARE_FEATURES = Object.freeze([
  'halation',
  'dirt',
  'starburst',
  'streaks',
  'ghosts',
  'leak',
  'rainbow',
]);

/** Starburst spokes (3 lines = 6 spokes, a hexagonal aperture) and taps per spoke. */
export const STAR_LINES = 3;
export const STAR_TAPS = 6;
/** Streak taps each side. */
export const STREAK_TAPS = 8;
/** Ghosts: scale of each mirrored copy about the centre (negative = mirrored) and its tint. */
export const GHOSTS = Object.freeze([
  Object.freeze({ s: -0.45, tint: [0.55, 0.75, 1.0] }),
  Object.freeze({ s: -0.9, tint: [1.0, 0.8, 0.5] }),
  Object.freeze({ s: -1.35, tint: [0.6, 1.0, 0.7] }),
  Object.freeze({ s: 0.35, tint: [0.9, 0.6, 1.0] }),
]);
/** Film halation's colour: the red/orange light a film base scatters back. */
export const HALATION_TINT = Object.freeze([1.0, 0.36, 0.12]);
/** Anamorphic streak colour (the classic cool blue). */
export const STREAK_TINT = Object.freeze([0.55, 0.75, 1.0]);
/** The warm leak colour. */
export const LEAK_TINT = Object.freeze([1.0, 0.62, 0.3]);

/**
 * Which features are on for a set of lens params (amount > 0). The viewer rebuilds when this changes.
 * @param {Record<string, unknown>} p lens params @returns {string[]}
 */
export function cameraGlareFeatures(p) {
  const n = (k) => (Number.isFinite(Number(p?.[k])) ? Number(p[k]) : 0);
  const on = {
    halation: n('halation') > 0,
    dirt: n('dirtAmount') > 0,
    starburst: n('starburstAmount') > 0,
    streaks: n('streakAmount') > 0,
    ghosts: n('ghostAmount') > 0,
    leak: n('leakAmount') > 0,
    rainbow: n('rainbowAmount') > 0,
  };
  return CAMERA_GLARE_FEATURES.filter((f) => on[f]);
}

/** The uv scale that "cover"-fits a 16:9 image to a screen of `aspect` (w/h), about the centre. */
export function coverScale(aspect) {
  const src = 16 / 9;
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : src;
  return a > src ? [1, src / a] : [a / src, 1];
}

/**
 * Build the camera-glare material.
 * @param {object} args
 * @param {*} args.THREE
 * @param {(uvNode:*) => *} args.glareAt bloom-render.js#glareAt (the PSF; already exposed and energy-normalised)
 * @param {*} args.midTexture the bloom's mid mip (a level-2 blur; halation + streaks)
 * @param {*} args.fineTexture the bloom's fine mip (level 1; starbursts)
 * @param {*} args.wideTexNode the bloom's OWN wide-band node (bloom-render.js `atmoTexNode`, re-pointed per tier)
 * @param {*} [args.dirtTexture] @param {*} [args.leakTexture] @param {*} [args.rainbowTexture] lens images (or
 *   placeholders: the returned nodes are re-pointed when the images arrive)
 * @param {string[]} [args.features] from {@link cameraGlareFeatures}
 * @param {object} [args.uniforms] reuse a uniform set across rebuilds ({@link createCameraGlareUniforms})
 * @param {((plainUv:*, warpedUv:*) => *)|null} [args.uvGuard] the lens's Table guard
 */
export function buildCameraGlareMaterial({
  THREE,
  glareAt,
  midTexture,
  fineTexture,
  wideTexNode,
  dirtTexture = null,
  leakTexture = null,
  rainbowTexture = null,
  features = [],
  uniforms,
  uvGuard = null,
}) {
  const TSL = THREE.TSL;
  const { uv, vec2, vec3, vec4, float, Fn, dot, clamp, smoothstep, length, texture } = TSL;
  const U = uniforms ?? createCameraGlareUniforms(THREE);
  const has = new Set(features);
  const midTexNode = texture(midTexture);
  const fineTexNode = texture(fineTexture);
  const dirtTexNode = has.has('dirt') && dirtTexture ? texture(dirtTexture) : null;
  const leakTexNode = has.has('leak') && leakTexture ? texture(leakTexture) : null;
  const rainbowTexNode = has.has('rainbow') && rainbowTexture ? texture(rainbowTexture) : null;
  if (!dirtTexNode) has.delete('dirt');
  if (!leakTexNode) has.delete('leak');
  if (!rainbowTexNode) has.delete('rainbow');
  const LUM = vec3(0.2126, 0.7152, 0.0722);
  const lum = (c) => dot(c, LUM);
  /** Keep only what is over `t` (a soft knee), preserving colour. */
  const over = (c, t) => {
    const l = lum(c).max(1e-4);
    return c.mul(l.sub(t).max(0).div(l));
  };

  const material = new THREE.NodeMaterial();
  material.depthTest = false;
  material.depthWrite = false;
  material.fragmentNode = Fn(() => {
    const s = uv();
    // The pyramid describes the unwarped frame: read it through the lens warp (the present's own maskUv).
    const w = lensWarpUv(TSL, s, U.d.x, uvGuard);
    const gain = U.d.y; // the glare budget's gain (also on the bloom's strength)
    let out = glareAt(w);
    const texel = vec2(U.d.z, U.d.w); // the fine mip's texel (uv)
    const aspect = U.c.z;
    const coverUv = s.sub(vec2(0.5, 0.5)).mul(vec2(U.e.z, U.e.w)).add(vec2(0.5, 0.5));
    let extra = vec3(0, 0, 0);

    if (has.has('halation')) {
      // The mid mip is a ~8 px blur of the over-threshold light: its warm tint around the core reads as film halation.
      const mid = midTexNode.sample(w).rgb;
      extra = extra.add(mid.mul(vec3(...HALATION_TINT)).mul(U.a.y.mul(0.35)));
    }
    if (has.has('dirt')) {
      // Dirt on the glass, lit by the light behind it: the WIDE glow (and a little of the core) at this point.
      const d = lum(dirtTexNode.sample(coverUv).rgb);
      const dirt = smoothstep(float(0.03), float(0.5), d);
      const light = wideTexNode.sample(w).rgb.add(midTexNode.sample(w).rgb.mul(0.15));
      extra = extra.add(light.mul(dirt).mul(U.a.x.mul(1.6)));
    }
    if (has.has('starburst')) {
      // Diffraction spikes from a hexagonal aperture: each spoke picks up the extreme light it points back at.
      const rot = U.c.w;
      let star = vec3(0, 0, 0);
      for (let k = 0; k < STAR_LINES; k++) {
        const ang = rot.add((k * Math.PI) / STAR_LINES);
        const dir = vec2(TSL.cos(ang), TSL.sin(ang).mul(aspect));
        for (let i = 1; i <= STAR_TAPS; i++) {
          const fall = Math.exp((-2.6 * i) / STAR_TAPS);
          const off = dir.mul(texel).mul(i * i * 0.9 + i * 1.5);
          const a = over(fineTexNode.sample(w.add(off)).rgb, U.a.w);
          const b = over(fineTexNode.sample(w.sub(off)).rgb, U.a.w);
          star = star.add(a.add(b).mul(fall));
        }
      }
      extra = extra.add(star.mul(U.a.z.mul(0.12)));
    }
    if (has.has('streaks')) {
      // Anamorphic: a long horizontal smear of the brightest light, cool blue.
      let st = vec3(0, 0, 0);
      const len = U.b.y.max(0.05);
      for (let i = 1; i <= STREAK_TAPS; i++) {
        const off = vec2(texel.x.mul(i * i * 1.6 + 2), 0).mul(len.mul(2));
        const fall = Math.exp((-2.2 * i) / STREAK_TAPS);
        const a = over(midTexNode.sample(w.add(off)).rgb, U.b.w.mul(0.6));
        const b = over(midTexNode.sample(w.sub(off)).rgb, U.b.w.mul(0.6));
        st = st.add(a.add(b).mul(fall));
      }
      extra = extra.add(
        lum(st)
          .mul(vec3(...STREAK_TINT))
          .mul(U.b.x.mul(0.1))
      );
    }
    if (has.has('ghosts')) {
      // Internal reflections: the frame's brightest light mirrored through the centre at a few scales, each tinted,
      // fading toward the frame edge (vignetted by the barrel).
      let gh = vec3(0, 0, 0);
      for (const g of GHOSTS) {
        const p = s.sub(vec2(0.5, 0.5)).mul(g.s).add(vec2(0.5, 0.5));
        const edge = float(1).sub(smoothstep(float(0.15), float(0.7), length(p.sub(vec2(0.5, 0.5)))));
        const src = over(wideTexNode.sample(lensWarpUv(TSL, p, U.d.x, uvGuard)).rgb, U.b.w);
        gh = gh.add(src.mul(vec3(...g.tint)).mul(edge));
      }
      extra = extra.add(gh.mul(U.b.z.mul(0.5)));
    }
    if (has.has('leak')) {
      // A warm light leak entering from the sun's side of the frame at golden hour (U.e.xy = toward the sun on
      // screen; U.c.x already carries golden hour × clear sky × amount).
      const side = clamp(
        dot(s.sub(vec2(0.5, 0.5)).mul(2), vec2(U.e.x, U.e.y))
          .mul(0.5)
          .add(0.5),
        0,
        1
      );
      const raw = leakTexNode.sample(coverUv).rgb;
      const img = raw.mul(raw); // the image is sRGB-encoded: ~linear
      extra = extra.add(
        img
          .mul(vec3(...LEAK_TINT))
          .mul(side.mul(side))
          .mul(U.c.x.mul(0.6))
      );
    }
    if (has.has('rainbow')) {
      // Prismatic chroma where the most extreme light sits behind it.
      const hot = lum(over(wideTexNode.sample(w).rgb, U.b.w.mul(0.5)));
      const rb = rainbowTexNode.sample(coverUv).rgb;
      extra = extra.add(
        rb
          .mul(rb)
          .mul(clamp(hot.mul(2), 0, 1.5))
          .mul(U.c.y)
      );
    }
    out = out.add(extra.mul(gain));
    return vec4(out, 1);
  })();
  material.name = `CameraGlare[${[...has].join(',') || 'psf'}]`;
  return { material, uniforms: U, dirtTexNode, leakTexNode, rainbowTexNode, features: [...has] };
}

/**
 * The packed uniforms (kept across rebuilds):
 *   a = (dirt, halation, starburst, starburst from)     b = (streaks, streak length, ghosts, flare from)
 *   c = (leak × golden, rainbow, aspect, star rotation) d = (lens distortion, budget gain, fine texel x, y)
 *   e = (sun dir on screen x, y, cover scale x, y)
 * @param {*} THREE
 */
export function createCameraGlareUniforms(THREE) {
  const { uniform } = THREE.TSL;
  return {
    a: uniform(new THREE.Vector4(0, 0, 0, 4)),
    b: uniform(new THREE.Vector4(0, 0.5, 0, 3)),
    c: uniform(new THREE.Vector4(0, 0, 16 / 9, 0.26)),
    d: uniform(new THREE.Vector4(0, 1, 1 / 960, 1 / 540)),
    e: uniform(new THREE.Vector4(1, 0, 1, 1)),
  };
}
