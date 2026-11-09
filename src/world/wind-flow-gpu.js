/**
 * world/wind-flow-gpu.js — LIVING WIND on the GPU: the TSL port of `world/wind-flow.js`, pass for pass
 * (mmp-vm1.1, 2026-11-09). Read that file's header first: it is the Node-tested reference and says what each
 * step is and why.
 *
 * Every pass is a full-grid QuadMesh over the wind grid (`uv()` v = 0 is the grid's top row, which is world
 * `origin.y` — `wind-field-bake.js#buildWindFieldBakeMaterial`), reading one RGBA16F state texture and writing
 * another. Velocity is kept in the FIELD'S OWN DIAL UNITS (× 70 = m/s) end to end, so the projection's pressure
 * stays small enough for half floats (≈ U × a building's width in cells) and the output IS the baked field every
 * consumer already reads — no unit change anywhere downstream.
 *
 * State texture channels: RG = velocity (dial units), BA = the free-stream turbulence the force pass sampled, carried
 * through the swirl and projection passes so the compose pass can put it back where the solver made the air slow
 * (a wake, a doorway) without evaluating the noise twice.
 *
 * Re-pointable texture nodes are returned per pass (`*Nodes`): the caller ping-pongs render targets and sets
 * `node.value` to whichever texture is current before each render — the same scheme `wind-sim-gpu.js` uses.
 * No render targets, textures or renderer state here (`gpu/allocator-only`, `renderer-state/graph-only`): the
 * viewer owns those and runs the passes.
 *
 * @module world/wind-flow-gpu
 */

import { sampleWind, computeWindTurbulence, WIND_DEFAULT_PIXELS_PER_METRE } from './wind-field.js';
import { WIND_DIAL_MAX_METRES_PER_SECOND } from './wind-scale.js';
import { WIND_FLOW_DEFAULTS } from './wind-flow.js';

/**
 * The tier ladder (a build-time choice, `tsl/no-uniform-gates`): how many Jacobi iterations a step gets, whether the
 * swirl pass runs, and the most steps one frame may take. `null` = the solver is off and the analytic bake stands.
 */
export const WIND_FLOW_TIERS = Object.freeze({
  low: null,
  performance: Object.freeze({ jacobi: 8, swirl: false, maxSteps: 1 }),
  standard: Object.freeze({ jacobi: 12, swirl: true, maxSteps: 1 }),
  quality: Object.freeze({ jacobi: 20, swirl: true, maxSteps: 2 }),
  extreme: Object.freeze({ jacobi: 30, swirl: true, maxSteps: 3 }),
});

/** @param {string} [tier] @returns {{jacobi:number, swirl:boolean, maxSteps:number}|null} */
export function windFlowTierPlan(tier) {
  if (!tier || !(tier in WIND_FLOW_TIERS)) return WIND_FLOW_TIERS.standard;
  return WIND_FLOW_TIERS[tier];
}

/**
 * How strongly the free-stream turbulence is put back where the solver made the air slow, as a multiple of the open
 * field's own intensity: a wake or a doorway is MORE turbulent than open ground (lee σ ≈ 0.25-0.4 U, against
 * 0.15-0.3 U in the open — Hunt et al. 1978; the doorway shear peak of the analytic model, 0.75, is the same idea).
 */
export const WIND_FLOW_WAKE_TURBULENCE_GAIN = 1.8;

/** Shared helpers, built per material (TSL nodes cannot cross materials). */
function gridHelpers(TSL, { cols, rows }) {
  const { uv, vec2, float, clamp, length } = TSL;
  const uv0 = uv();
  const tx = 1 / Math.max(1, cols);
  const ty = 1 / Math.max(1, rows);
  /** uv of the neighbour (dx, dy) cells away, clamped into the grid. */
  const at = (dx, dy) => clamp(uv0.add(vec2(dx * tx, dy * ty)), vec2(0, 0), vec2(1, 1));
  /** 1 when (dx, dy) leaves the grid (the clamp moved it), else 0 — branch-free, as wind-sim-gpu's relax does. */
  const offGrid = (dx, dy) => {
    const raw = uv0.add(vec2(dx * tx, dy * ty));
    return clamp(length(raw.sub(clamp(raw, vec2(0, 0), vec2(1, 1)))).mul(float(1e6)), float(0), float(1));
  };
  return { uv0, tx, ty, at, offGrid };
}

/**
 * PASS 1 — ADVECT + FORCE (reference: `flowAdvect` then `flowForce`). Reads the last velocity state, writes
 * `vec4(v*, freeTurbulence)`.
 *
 * @param {object} a
 * @param {*} a.THREE
 * @param {*} a.velTexture - initial state texture (re-pointed every step).
 * @param {*} a.solidMaskTexture - R = 1 in a wall cell (nearest).
 * @param {*} a.opennessTexture - A = exterior / open sky (nearest): where the driver pushes.
 * @param {{directionDeg:*, speed01:*, gustiness01?:*, pixelsPerMetre?:*, advection?:*}} a.ambient - live uniforms.
 * @param {{originX:number, originY:number, cellSize:number, cols:number, rows:number}} a.grid
 * @param {object} [a.opts] - overrides of WIND_FLOW_DEFAULTS.
 */
export function buildWindFlowForceMaterial({
  THREE,
  velTexture,
  solidMaskTexture,
  opennessTexture,
  ambient,
  grid,
  opts = {},
}) {
  const TSL = THREE.TSL;
  const { texture, vec2, vec4, float, uniform, clamp, max, exp, length, select, min } = TSL;
  const o = { ...WIND_FLOW_DEFAULTS, ...opts };
  const { uv0, tx, ty } = gridHelpers(TSL, grid);
  const uDtSec = uniform(float(0));
  const uTimeMs = uniform(float(0));
  const ppm = ambient.pixelsPerMetre ?? float(WIND_DEFAULT_PIXELS_PER_METRE);

  // The world point of this texel's centre.
  const worldXY = vec2(
    uv0.x.mul(float(grid.cellSize * grid.cols)).add(float(grid.originX)),
    uv0.y.mul(float(grid.cellSize * grid.rows)).add(float(grid.originY))
  );

  // ADVECT. Dial units → uv per second: × 70 m/s × px/m ÷ (cell px × cells).
  const selfNode = texture(velTexture, uv0);
  const v0 = selfNode.xy;
  const uvPerUnitSec = vec2(
    ppm.mul(float(WIND_DIAL_MAX_METRES_PER_SECOND / (grid.cellSize * grid.cols))),
    ppm.mul(float(WIND_DIAL_MAX_METRES_PER_SECOND / (grid.cellSize * grid.rows)))
  );
  const backUv = clamp(uv0.sub(v0.mul(uvPerUnitSec).mul(uDtSec)), vec2(0, 0), vec2(1, 1));
  const backNode = texture(velTexture, backUv);
  const vAdv = backNode.xy;

  // THE DRIVER — the analytic field with no geometry: mean × gust envelope + open-ground turbulence. Exactly what
  // `sampleWind` returns for a caller that passes the ambient and nothing baked.
  const driver = sampleWind(TSL, { centerXY: worldXY, time: uTimeMs, wind: ambient });
  // Its turbulence alone, kept for the compose pass (the same call `sampleWind` made inside; the compiler shares
  // nothing between them, so this costs a second stack — only in this one small pass).
  const freeTurb = computeWindTurbulence(TSL, {
    centerXY: worldXY,
    time: uTimeMs,
    openness: float(1),
    exteriorOpenness: float(1),
    windSpeed01: ambient.speed01,
    directionDeg: ambient.directionDeg,
    advectSpeed01: ambient.speed01,
    pixelsPerMetre: ambient.pixelsPerMetre,
    advection: ambient.advection,
  });

  // FORCE. Open sky relaxes toward the driver at |driver| / L (m/s ÷ m), roofed air is damped.
  const open = clamp(texture(opennessTexture, uv0).w, float(0), float(1));
  const kRelax = max(
    float(o.minRelaxPerSec),
    length(driver).mul(float(WIND_DIAL_MAX_METRES_PER_SECOND / Math.max(o.relaxLengthM, 1e-3)))
  );
  const relax = float(1)
    .sub(exp(kRelax.mul(uDtSec).negate()))
    .mul(open);
  const damp = float(1)
    .sub(exp(float(o.indoorDampPerSec).mul(uDtSec).negate()))
    .mul(float(1).sub(open));
  const forced = vAdv.add(driver.sub(vAdv).mul(relax)).sub(vAdv.mul(damp));

  // The outer ring of the grid IS the driver (inflow and outflow); a wall cell holds no air.
  const edge = min(min(uv0.x, float(1).sub(uv0.x)).div(float(tx)), min(uv0.y, float(1).sub(uv0.y)).div(float(ty)));
  const onEdge = edge.lessThan(float(1));
  const solid = texture(solidMaskTexture, uv0).x;
  const v1 = select(onEdge, driver, forced).mul(float(1).sub(solid));

  const material = new THREE.NodeMaterial();
  material.name = 'wind.flow.force';
  material.fragmentNode = vec4(v1, freeTurb);
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = THREE.NoBlending;
  return { material, quad: new THREE.QuadMesh(material), velNodes: [selfNode, backNode], uDtSec, uTimeMs };
}

/**
 * PASS 2 — SWIRL (reference: `flowConfineVorticity`). Reads vec4(v*, turb), writes the same with v* nudged.
 * Curl is taken at the cell and its four neighbours (a 13-texel stencil) so |ω|'s gradient needs no extra pass.
 */
export function buildWindFlowSwirlMaterial({ THREE, velTexture, solidMaskTexture, grid, epsilon }) {
  const TSL = THREE.TSL;
  const { texture, vec2, vec4, float, uniform, abs, length } = TSL;
  const { uv0, at } = gridHelpers(TSL, grid);
  const uDtSec = uniform(float(0));
  const uEpsilon = uniform(float(epsilon ?? WIND_FLOW_DEFAULTS.vorticity));
  const nodes = [];
  const vel = (dx, dy) => {
    const n = texture(velTexture, at(dx, dy));
    nodes.push(n);
    const s = texture(solidMaskTexture, at(dx, dy)).x;
    return n.xy.mul(float(1).sub(s));
  };
  const cache = new Map();
  const v = (dx, dy) => {
    const k = `${dx},${dy}`;
    if (!cache.has(k)) cache.set(k, vel(dx, dy));
    return cache.get(k);
  };
  const curl = (cx, cy) =>
    v(cx + 1, cy)
      .y.sub(v(cx - 1, cy).y)
      .sub(v(cx, cy + 1).x.sub(v(cx, cy - 1).x))
      .mul(float(0.5));
  const w = curl(0, 0);
  const gx = abs(curl(1, 0))
    .sub(abs(curl(-1, 0)))
    .mul(float(0.5));
  const gy = abs(curl(0, 1))
    .sub(abs(curl(0, -1)))
    .mul(float(0.5));
  const len = length(vec2(gx, gy)).add(float(1e-5));
  const n = vec2(gx, gy).div(len);
  const selfNode = texture(velTexture, uv0);
  nodes.push(selfNode);
  const solid = texture(solidMaskTexture, uv0).x;
  const force = vec2(n.y.mul(w), n.x.mul(w).negate()).mul(uEpsilon).mul(uDtSec);
  const out = selfNode.xy.add(force).mul(float(1).sub(solid));
  const material = new THREE.NodeMaterial();
  material.name = 'wind.flow.swirl';
  material.fragmentNode = vec4(out, selfNode.zw);
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = THREE.NoBlending;
  return { material, quad: new THREE.QuadMesh(material), velNodes: nodes, uDtSec, uEpsilon };
}

/**
 * PASS 3 — DIVERGENCE (reference: `flowDivergence`) and the screening the Jacobi needs, in one target:
 * R = ∇·u (dial units per cell), G = k = 1/Lv² (cells) mixed by open sky (`escapeField`).
 */
export function buildWindFlowDivergenceMaterial({
  THREE,
  velTexture,
  solidMaskTexture,
  opennessTexture,
  grid,
  escapeCells,
  indoorEscapeCells,
}) {
  const TSL = THREE.TSL;
  const { texture, vec4, float, mix, clamp } = TSL;
  const { uv0, at, offGrid } = gridHelpers(TSL, grid);
  const nodes = [];
  const selfNode = texture(velTexture, uv0);
  nodes.push(selfNode);
  // A solid neighbour reads 0; off the grid reads the cell itself.
  const u = (dx, dy) => {
    const n = texture(velTexture, at(dx, dy));
    nodes.push(n);
    const s = texture(solidMaskTexture, at(dx, dy)).x;
    const og = offGrid(dx, dy);
    return mix(n.xy.mul(float(1).sub(s)), selfNode.xy, og);
  };
  const div = u(1, 0)
    .x.sub(u(-1, 0).x)
    .add(u(0, 1).y.sub(u(0, -1).y))
    .mul(float(0.5));
  const solid = texture(solidMaskTexture, uv0).x;
  const open = clamp(texture(opennessTexture, uv0).w, float(0), float(1));
  const kOut = escapeCells > 0 ? 1 / (escapeCells * escapeCells) : 0;
  const kIn = indoorEscapeCells > 0 ? 1 / (indoorEscapeCells * indoorEscapeCells) : 0;
  const k = mix(float(kIn), float(kOut), open);
  const material = new THREE.NodeMaterial();
  material.name = 'wind.flow.divergence';
  material.fragmentNode = vec4(div.mul(float(1).sub(solid)), k, 0, 1);
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = THREE.NoBlending;
  return { material, quad: new THREE.QuadMesh(material), velNodes: nodes };
}

/**
 * PASS 4 — ONE JACOBI ITERATION (reference: `flowJacobi`): p' = (Σ p_nb − div) / (4 + k). A wall neighbour reads
 * this cell's p (Neumann), off-grid reads 0 (open edge). R = p.
 */
export function buildWindFlowJacobiMaterial({ THREE, pressTexture, divTexture, solidMaskTexture, grid }) {
  const TSL = THREE.TSL;
  const { texture, vec4, float, mix } = TSL;
  const { uv0, at, offGrid } = gridHelpers(TSL, grid);
  const pressNodes = [];
  const selfNode = texture(pressTexture, uv0);
  pressNodes.push(selfNode);
  const pc = selfNode.x;
  const nb = (dx, dy) => {
    const n = texture(pressTexture, at(dx, dy));
    pressNodes.push(n);
    const s = texture(solidMaskTexture, at(dx, dy)).x;
    const og = offGrid(dx, dy);
    return mix(mix(n.x, pc, s), float(0), og);
  };
  const d = texture(divTexture, uv0);
  const p = nb(-1, 0).add(nb(1, 0)).add(nb(0, -1)).add(nb(0, 1)).sub(d.x).div(float(4).add(d.y));
  const solid = texture(solidMaskTexture, uv0).x;
  const material = new THREE.NodeMaterial();
  material.name = 'wind.flow.jacobi';
  material.fragmentNode = vec4(p.mul(float(1).sub(solid)), 0, 0, 1);
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = THREE.NoBlending;
  return { material, quad: new THREE.QuadMesh(material), pressNodes };
}

/** PASS 5 — PROJECT (reference: `flowSubtractGradient`): u = u* − ∇p; keeps the turbulence channels. */
export function buildWindFlowProjectMaterial({ THREE, velTexture, pressTexture, solidMaskTexture, grid }) {
  const TSL = THREE.TSL;
  const { texture, vec2, vec4, float, mix } = TSL;
  const { uv0, at, offGrid } = gridHelpers(TSL, grid);
  const pressNodes = [];
  const selfP = texture(pressTexture, uv0);
  pressNodes.push(selfP);
  const pc = selfP.x;
  const nb = (dx, dy) => {
    const n = texture(pressTexture, at(dx, dy));
    pressNodes.push(n);
    const s = texture(solidMaskTexture, at(dx, dy)).x;
    const og = offGrid(dx, dy);
    return mix(mix(n.x, pc, s), float(0), og);
  };
  const grad = vec2(nb(1, 0).sub(nb(-1, 0)), nb(0, 1).sub(nb(0, -1))).mul(float(0.5));
  const velNode = texture(velTexture, uv0);
  const solid = texture(solidMaskTexture, uv0).x;
  const out = velNode.xy.sub(grad).mul(float(1).sub(solid));
  const material = new THREE.NodeMaterial();
  material.name = 'wind.flow.project';
  material.fragmentNode = vec4(out, velNode.zw);
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = THREE.NoBlending;
  return { material, quad: new THREE.QuadMesh(material), velNodes: [velNode], pressNodes };
}

/**
 * PASS 6 — COMPOSE the baked field every consumer reads: the solver's velocity, plus the free-stream turbulence put
 * back where the solver made the air slow (a wake, a yard) or where it jets indoors, so sheltered air swirls instead
 * of lying dead. `uLagSec` > 0 writes the LAGGED slice: the same field read downstream by v·lag (Taylor: what passed
 * here lag seconds ago is now that far downwind).
 */
export function buildWindFlowComposeMaterial({
  THREE,
  velTexture,
  opennessTexture,
  ambient,
  grid,
  wakeGain = WIND_FLOW_WAKE_TURBULENCE_GAIN,
}) {
  const TSL = THREE.TSL;
  const { texture, vec2, vec4, float, uniform, clamp, length, max, min } = TSL;
  const { uv0 } = gridHelpers(TSL, grid);
  const uLagSec = uniform(float(0));
  const ppm = ambient.pixelsPerMetre ?? float(WIND_DEFAULT_PIXELS_PER_METRE);
  const selfNode = texture(velTexture, uv0);
  const uvPerUnitSec = vec2(
    ppm.mul(float(WIND_DIAL_MAX_METRES_PER_SECOND / (grid.cellSize * grid.cols))),
    ppm.mul(float(WIND_DIAL_MAX_METRES_PER_SECOND / (grid.cellSize * grid.rows)))
  );
  const readUv = clamp(uv0.add(selfNode.xy.mul(uvPerUnitSec).mul(uLagSec)), vec2(0, 0), vec2(1, 1));
  const readNode = texture(velTexture, readUv);
  const v = readNode.xy;
  const turb = readNode.zw;
  const mean = max(ambient.speed01, float(1e-4));
  const rel = clamp(length(v).div(mean), float(0), float(1));
  const open = clamp(texture(opennessTexture, uv0).w, float(0), float(1));
  const opennessIn = clamp(texture(opennessTexture, uv0).z, float(0), float(1));
  // Outdoors: the slower the air than the wind, the more of the turbulence returns (a wake, a yard). Indoors: only a
  // moving jet carries it (a sealed room stays still).
  const shelterOut = float(1).sub(rel).mul(open);
  const jetIn = rel.mul(opennessIn).mul(float(1).sub(open));
  const amount = min(float(1), shelterOut.add(jetIn)).mul(float(wakeGain));
  const out = v.add(turb.mul(amount));
  const material = new THREE.NodeMaterial();
  material.name = 'wind.flow.compose';
  material.fragmentNode = vec4(out, 0, 1);
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = THREE.NoBlending;
  return { material, quad: new THREE.QuadMesh(material), velNodes: [selfNode, readNode], uLagSec };
}

/**
 * Everything at once, for one grid layout. The caller (the viewer) allocates the targets and runs the passes in
 * order: force → (swirl) → divergence → jacobi × n (warm-started from last step's pressure) → project → compose now
 * and lagged.
 *
 * @param {object} a
 * @param {*} a.THREE
 * @param {*} a.stateTexture - any valid RGBA16F texture of the grid size (re-pointed before every render).
 * @param {*} a.pressTexture @param {*} a.divTexture
 * @param {*} a.solidMaskTexture @param {*} a.opennessTexture
 * @param {object} a.ambient
 * @param {{originX:number, originY:number, cellSize:number, cols:number, rows:number}} a.grid
 * @param {string} [a.tier]
 * @param {object} [a.opts]
 */
export function buildWindFlowMaterials({
  THREE,
  stateTexture,
  pressTexture,
  divTexture,
  solidMaskTexture,
  opennessTexture,
  ambient,
  grid,
  tier,
  opts = {},
}) {
  const plan = windFlowTierPlan(tier);
  if (!plan) return null;
  const o = { ...WIND_FLOW_DEFAULTS, ...opts };
  const ppmGuess = WIND_DEFAULT_PIXELS_PER_METRE;
  const cellM = grid.cellSize / ppmGuess;
  const escapeCells = o.verticalEscapeM / Math.max(cellM, 1e-6);
  const indoorEscapeCells = o.indoorEscapeM / Math.max(cellM, 1e-6);
  const force = buildWindFlowForceMaterial({
    THREE,
    velTexture: stateTexture,
    solidMaskTexture,
    opennessTexture,
    ambient,
    grid,
    opts: o,
  });
  const swirl = plan.swirl
    ? buildWindFlowSwirlMaterial({ THREE, velTexture: stateTexture, solidMaskTexture, grid, epsilon: o.vorticity })
    : null;
  const divergence = buildWindFlowDivergenceMaterial({
    THREE,
    velTexture: stateTexture,
    solidMaskTexture,
    opennessTexture,
    grid,
    escapeCells,
    indoorEscapeCells,
  });
  const jacobi = buildWindFlowJacobiMaterial({ THREE, pressTexture, divTexture, solidMaskTexture, grid });
  const project = buildWindFlowProjectMaterial({
    THREE,
    velTexture: stateTexture,
    pressTexture,
    solidMaskTexture,
    grid,
  });
  const compose = buildWindFlowComposeMaterial({ THREE, velTexture: stateTexture, opennessTexture, ambient, grid });
  const all = [force, swirl, divergence, jacobi, project, compose].filter(Boolean);
  return {
    plan,
    force,
    swirl,
    divergence,
    jacobi,
    project,
    compose,
    dispose() {
      for (const p of all) p.material.dispose();
    },
  };
}
