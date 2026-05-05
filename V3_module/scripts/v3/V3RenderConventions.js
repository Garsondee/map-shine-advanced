/**
 * Single source of truth for Foundry canvas data → Three.js sampling fixes.
 *
 * Any code that draws Foundry level backgrounds through Three should take
 * orientation from here — do not scatter `1.0 - uv.y` or `flipY` toggles
 * elsewhere (extend this object and wire one uniform path in the compositor).
 */

/**
 * `THREE.TextureLoader` leaves this `true` by default — keep it that way for all
 * level PNGs (albedo + suffixed masks) so GPU row order matches the sandwich and
 * debug-overlay shaders, which both apply `uFlipBackgroundY` to `mapUv` the same way.
 * Setting `flipY = false` on masks while backgrounds use `true` inverts masks vs map.
 */
export const V3_LEVEL_TEXTURE_FLIP_Y = true;

/** @type {Readonly<{ flipBackgroundTextureY: boolean }>} */
export const V3_RENDER_CONVENTIONS = Object.freeze({
  /**
   * After world space → `mapUv` in [0,1], flip texture V so map art matches
   * the Foundry canvas (scene Y is down; GL image rows vs UV expectations).
   * Runtime override: `V3Shine.setUniforms({ flipBackgroundTextureY: false })`.
   */
  flipBackgroundTextureY: true,
});
