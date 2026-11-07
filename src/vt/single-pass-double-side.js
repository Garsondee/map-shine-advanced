/**
 * vt/single-pass-double-side.js — one pass for every transparent DoubleSide material (2026-11-07, mmp-a5e.14).
 *
 * THE TRAP. three's `Renderer.renderObject` draws a material that is `transparent` AND `side: DoubleSide` TWICE:
 * once with `side` set to BackSide, then again with FrontSide (three.webgpu.js, "transparentDoublePass" — meant
 * for closed 3D glass, where the far faces must blend before the near ones). Each pass is its own pipeline, so
 * every such shader is COMPILED twice and DRAWN twice, every frame.
 *
 * MSA sets DoubleSide on purpose and everywhere (62 sites): the viewer's camera frustum is flipped (top = minY),
 * which reverses triangle winding, and DoubleSide is how a quad survives that. On a flat quad one of the two
 * passes is culled entirely, so the picture is identical and only the cost doubles. Measured on Big Bank, warm
 * (Player1, 2026-11-07): the light accumulation pass (100 k chars, ~14 s) and four surface-response passes
 * (65-69 k chars, ~13 s each) were each compiled twice, the pair differing in exactly one pipeline-state field:
 * `material.side` 1 (Back) vs 0 (Front).
 *
 * THE FIX, ONE DOOR. `material.forceSinglePass = true` is three's own switch for this: DoubleSide drawn in ONE
 * pass with culling off — the same fragments for a flat mesh, in the same order. Rather than 62 hand edits (and
 * the 63rd effect that forgets), the renderer's `renderObject` is wrapped once, before any pipeline exists, and
 * sets the flag on every transparent DoubleSide material the first time it is drawn (or warmed by compileAsync:
 * three reads `this.renderObject` off the instance for both).
 *
 * What it would change: only a mesh whose own triangles overlap AND blend order-dependently (normal alpha) could
 * differ, by drawing its back-facing triangles first. MSA draws flat quads, fans and instanced sprites seen
 * from above, all facing one way; MAX and additive blends are order-free anyway.
 */

/** three's `DoubleSide` (constants.js) — a number, so this module needs no THREE import. */
export const DOUBLE_SIDE = 2;

/**
 * Would three draw this material in two passes? Mirrors the condition in three's `renderObject`.
 * @param {any} material @param {number} [doubleSide] @returns {boolean}
 */
export function isTwoPassMaterial(material, doubleSide = DOUBLE_SIDE) {
  return (
    !!material && material.transparent === true && material.side === doubleSide && material.forceSinglePass !== true
  );
}

/**
 * Wrap `renderer.renderObject` so no transparent DoubleSide material is ever drawn in two passes.
 * @param {any} renderer - a three WebGPURenderer (anything with a `renderObject` method).
 * @param {{doubleSide?: number}} [opts]
 * @returns {{report: () => {installed: boolean, converted: number, names: string[]}, uninstall: () => void}}
 */
export function installSinglePassDoubleSide(renderer, { doubleSide = DOUBLE_SIDE } = {}) {
  const original = renderer?.renderObject;
  let converted = 0;
  /** The first few names, for the load report (a name, else the type). */
  const names = [];
  // A/B lever for measuring, never a setting: a rig sets `globalThis.__msaTwoPassDoubleSide = true` before load to get
  // three's two-pass behaviour back (tools/test-world measurements, 2026-11-07).
  if (typeof original !== 'function' || globalThis.__msaTwoPassDoubleSide === true) {
    return { report: () => ({ installed: false, converted, names }), uninstall: () => {} };
  }

  function convert(material) {
    if (!isTwoPassMaterial(material, doubleSide)) return;
    material.forceSinglePass = true;
    converted++;
    if (names.length < 24) names.push(material.name || material.type || 'material');
  }

  function renderObject(object, scene, camera, geometry, material, ...rest) {
    convert(material);
    // three swaps in `scene.overrideMaterial` (a depth or shadow pass) and tests THAT material's side instead.
    if (scene?.overrideMaterial) convert(scene.overrideMaterial);
    return original.call(this, object, scene, camera, geometry, material, ...rest);
  }

  renderer.renderObject = renderObject;
  return {
    report: () => ({ installed: renderer.renderObject === renderObject, converted, names: names.slice() }),
    uninstall() {
      if (renderer.renderObject === renderObject) renderer.renderObject = original;
    },
  };
}
