/**
 * tsl-census.mjs — COUNT WHAT A SHADER IS MADE OF, WITHOUT A GPU (2026-10-27, epic mmp-fpu).
 *
 * Real TSL builds real node graphs in plain Node: the vendored three.webgpu.js
 * imports without a device, and a material's `positionNode` / `fragmentNode` /
 * ... are ordinary JS objects. Walking them tells you how big the shader WILL be
 * before any GPU exists, which is exactly what a unit test needs.
 *
 * ## Why this is the budget instrument
 *
 * A cold load of one scene lost the whole GPU device because a single candle
 * pipeline took 19.7 s to compile (`tools/shader-lab/cost-probe.js` measured it on
 * the real compiler). Compile time is not linear in graph size, so a test cannot
 * assert seconds — but it CAN assert the things that drive them, and those are
 * countable here:
 *
 *   - `noise`    — Perlin/MaterialX noise call sites (`FunctionOverloadingNode`).
 *                  Each one is inlined by the driver's compiler; this is the term
 *                  that exploded.
 *   - `unique`   — distinct nodes in the graph. A cruder size proxy, but it moves
 *                  with every unrolled loop and every duplicated sub-graph.
 *   - `textures` — texture reads (cheap to compile, limited to 16 per stage).
 *
 * The numbers are calibrated against the real compiler in `shader-budgets.json`
 * (see `src/effects/__tests__/shader-budget.test.mjs`): when a budget is set,
 * the GPU-measured size and compile time of the same material are written beside
 * it, so a reader can see what the census number MEANS.
 *
 * @module core/__tests__/tsl-census
 */

/** The node slots on a NodeMaterial that can carry a graph. */
export const MATERIAL_NODE_SLOTS = Object.freeze([
  'positionNode',
  'vertexNode',
  'colorNode',
  'fragmentNode',
  'opacityNode',
  'emissiveNode',
  'outputNode',
  'depthNode',
  'maskNode',
  'alphaTestNode',
  'mrtNode',
  'backdropNode',
  'normalNode',
  'lightsNode',
]);

/**
 * @typedef {object} Census
 * @property {number} unique - distinct nodes reachable from the roots.
 * @property {number} noise - noise (overloaded-function) call sites.
 * @property {number} textures - DISTINCT textures bound (the per-stage limit is 16).
 * @property {number} varyings - vertex→fragment varyings.
 * @property {Record<string, number>} byKind - count per node class.
 */

/**
 * Census one or more node graphs. Shared sub-graphs are counted ONCE — that is how
 * the shader is generated too (a node is emitted once per stage and reused).
 * @param {...any} roots - TSL nodes (anything with `.traverse`).
 * @returns {Census}
 */
export function census(...roots) {
  const seen = new Set();
  /** @type {Record<string, number>} */
  const byKind = {};
  /** DISTINCT textures read: `texture(t, uv).level(0)` makes two TextureNodes that bind one texture. */
  const sources = new Set();
  // ⚠️ NOT `node.traverse()`. three's traverse has no visited set — it re-walks a shared sub-graph once per
  // PATH to it — so on a real material (the candle flame, a water tier, the window) the walk is exponential
  // and never returns. Shaders share sub-graphs on purpose (a node is emitted once per stage), so this walks
  // each node once, which is also what the generated code does.
  const stack = roots.filter((root) => root && typeof root.getChildren === 'function');
  while (stack.length > 0) {
    const node = stack.pop();
    if (seen.has(node)) continue;
    seen.add(node);
    const kind = node.constructor?.name ?? '?';
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (kind === 'TextureNode' && node.value) sources.add(node.value);
    for (const child of node.getChildren()) if (child && typeof child.getChildren === 'function') stack.push(child);
  }
  return {
    unique: seen.size,
    noise: byKind.FunctionOverloadingNode ?? 0,
    textures: sources.size,
    varyings: byKind.VaryingNode ?? 0,
    byKind,
  };
}

/**
 * Census every graph a material carries.
 * @param {{[slot: string]: any}} material
 * @returns {Census}
 */
export function censusMaterial(material) {
  return census(...MATERIAL_NODE_SLOTS.map((slot) => material?.[slot]).filter(Boolean));
}
