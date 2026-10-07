/**
 * THE WIND GRID'S THREE TEXTURES — where they are allocated (`gpu/textures-in-vt-only`
 * keeps every `new …Texture(` in vt/) and, more importantly, WHICH FILTER EACH ONE
 * USES, which is the one non-obvious decision in the whole wind bake and is
 * pinned by `__tests__/wind-grid-textures.test.mjs` rather than living as an
 * unexplained pair of assignments.
 *
 * These are small, GRID-sized textures (at most 512 × 384 texels, ≤ 1.5 MB at
 * half-float RGBA) — nothing here is world-sized, which is what the rule exists
 * to police. `world/wind-structure.js#createWindGridState` owns their lifetime and
 * receives this factory object as a dependency, so the pure world/ module never
 * names a texture class.
 *
 * @module vt/wind-grid-textures
 */

/**
 * @param {*} THREE
 * @returns {{
 *   createOpennessTexture: (data: Uint16Array, cols: number, rows: number) => *,
 *   createWallAvoidTexture: (data: Uint16Array, cols: number, rows: number) => *,
 *   createSolidMaskTexture: (data: Uint8Array, cols: number, rows: number) => *,
 * }}
 */
export function createWindGridTextureFactory(THREE) {
  function dataTexture(data, cols, rows, type, filter) {
    const tex = new THREE.DataTexture(data, cols, rows, THREE.RGBAFormat, type);
    tex.minFilter = filter;
    tex.magFilter = filter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  return {
    /**
     * THE OPENNESS TEXTURE — B = openness, A = exteriorOpenness, R/G reserved zeros
     * (Tier 2's advect pass reads `.xy` as a transport velocity).
     *
     * ⚠️ NEAREST, NOT LINEAR — AND THAT IS THE LEAK'S SECOND HALF. Even with
     * `downsampleOpennessClasses` making a wall's own cell read sealed, a bilinear
     * fetch inside a room within half a cell (~12 px) of an outside wall still
     * averages in the OUTSIDE neighbour's centre texel: measured, a sealed room
     * read 0.46 openness at its own wall face. Openness is a connectivity fact
     * ("can outside air get HERE?"), not a quantity that has a meaningful value
     * between two cells — interpolating across a wall invents air that does not
     * exist. Nearest also makes the GPU read byte-identical to the CPU lookup every
     * particle kernel, the fire runtime and the wind probe already use
     * (`floor((x − origin) / cellSize)`), so "the probe says 0 here" and "the flame
     * is leaning here" can no longer disagree by half a cell.
     */
    createOpennessTexture: (data, cols, rows) =>
      dataTexture(data, cols, rows, THREE.HalfFloatType, THREE.NearestFilter),

    /**
     * THE WALL-AVOIDANCE TEXTURE — R/G = unit vector away from the nearest wall,
     * B = proximity, A = the wind shadow. LINEAR: these are smooth directional
     * fields, and interpolating a direction across a cell is exactly right.
     */
    createWallAvoidTexture: (data, cols, rows) =>
      dataTexture(data, cols, rows, THREE.HalfFloatType, THREE.LinearFilter),

    /**
     * TIER 2's SOLID MASK — a crisp 0/255 so the sim's relax pass can tell wall from
     * open at exactly the cell boundary. NEAREST (a linear blur would turn the
     * boundary into a fractional "half solid").
     */
    createSolidMaskTexture: (data, cols, rows) =>
      dataTexture(data, cols, rows, THREE.UnsignedByteType, THREE.NearestFilter),
  };
}
