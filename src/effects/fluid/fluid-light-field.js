/**
 * THE GOO'S LIGHT ON THE MAP — a soft field shaped like the liquid itself, ADDED to the room's light
 * (2026-11-08, mmp-0t3.2).
 *
 * The author, 2026-11-06: *"During the evening on the Wizard Lair map I can see the _Fluid effect producing
 * perfect circles of light, I assume this is the 'self illuminating' part but it seems badly misjudged as an
 * approach to lighting."*
 *
 * WHAT WAS WRONG (measured on the Lair rig, 2026-11-08). The light used to be up to 14 Foundry-style point lights
 * per item — round 24-gons of 180-900 px — MAX-blended into `buf:scene.illum` like every lamp. Two faults:
 *   SHAPE  a disc around a cluster centre, whatever the pipe under it looked like.
 *   BLEND  MAX per channel: against a low, warm dusk ambient the pale cyan light wins on G and B inside one
 *          contour and loses outside it, so the disc has a hard rim and the sunset inside it turns grey.
 *
 * WHAT IT IS NOW. Many small EMITTERS sit on the liquid (one per ~140 px cell of goo, per tube), each carrying the
 * goo's own fill, energy and reagent colour from the CPU twin (`fluid-alchemy.js#stepFluidLightTwin`). Every
 * emitter spreads a smooth kernel (zero value AND zero slope at its reach — `fluidLightKernel`), and the kernels are
 * ADDED. A sum of many soft kernels laid along a pipe is the pipe blurred — the glow follows the tubes and swells
 * round the flasks, and there is no contour anywhere because nothing is compared with the ambient.
 *
 *   WALLS     each emitter's footprint is Foundry's own wall-clipped sweep from that emitter (the same
 *             `ClockwiseSweepPolygon` every lamp uses, so a PROXIMITY window still lets it through). A pipe outside
 *             a wall lights the yard, not the room behind it.
 *   DAYLIGHT  the add is scaled by how dark the room already is (`buf:scene.roomLight`, the ambient + sun shadow
 *             + darkness Regions copy the window light reads): a glow shows in a dim room and at night, and all
 *             but vanishes on a sunlit floor at noon — what the eye does, and what the MAX used to do by accident.
 *             Lamps are NOT in that copy, so the goo still adds on top of a torch.
 *   DENSITY   a flask is a dense cluster of emitters; its weights are eased down (`fluidLightWeights`) so a vat glows
 *             a little brighter than a pipe, not eight times.
 *
 * COST. One mesh per item (all emitters' fans in one buffer, one draw), one N×1 float texture rewritten per tick
 * (N ≤ 384). The wall sweeps run once per bake / floor / wall edit / reach change, a few per tick so a load never
 * stalls on them.
 *
 * Pure parts (emitters, weights, kernel, per-tick write) are Node-tested in `__tests__/fluid-light-field.test.mjs`.
 * The two THREE builders take `THREE` as an argument and run in the browser only.
 *
 * @module effects/fluid/fluid-light-field
 */

import { fluidReagentColor, sampleFluidTwin } from './fluid-alchemy.js';

/** One emitter per this many world px of goo, per tube (grown if a big mask would exceed the cap). */
export const FLUID_LIGHT_CELL_PX = 140;
/** Cap per masked item — every emitter is one wall sweep at bake time and one fan in the mesh. */
export const FLUID_LIGHT_MAX_EMITTERS = 384;
/** How far one emitter's light reaches at `lightRadius` 1, world px. */
export const FLUID_LIGHT_REACH_PX = 560;
/** The pipe a weight of 1 stands for: a straight pipe this wide, full of goo, sums to 1 on its centre line. */
export const FLUID_LIGHT_REF_PIPE_PX = 30;
/** How hard a dense cluster (a flask, a bundle of pipes) is eased toward the reference pipe's brightness. */
const DENSITY_EASE = 0.6;
/** Illumination added on a full, calm reference pipe at `light` 1 (gamma-space illum units, before daylight). */
export const FLUID_LIGHT_PEAK = 0.55;
/** How much of the glow full daylight takes away (`1 - DAY_DIM * luma(roomLight)`, floored at `DAY_FLOOR`). */
export const FLUID_LIGHT_DAY_DIM = 0.85;
export const FLUID_LIGHT_DAY_FLOOR = 0.1;
/** Brightness smoothing, seconds — the goo is lumpy; its light on the floor should breathe, not flicker. */
const LEVEL_TAU_S = 0.18;
/** The kernel's core sharpness: higher = a tighter bright halo on the pipe with the same reach. */
const KERNEL_CORE = 12;

/**
 * The light one emitter spreads, by distance over reach (0..1). 1 at the emitter, 0 with zero slope at 1 — so
 * there is no rim to see however many emitters overlap (`light-edge-fix-mmp-3kb`: never cut a light's whole output
 * off at a radius).
 * @param {number} x - distance / reach
 * @returns {number}
 */
export function fluidLightKernel(x) {
  if (!(x < 1)) return 0;
  const a = 1 - x * x;
  return (a * a) / (1 + KERNEL_CORE * x * x);
}

/** ∫ kernel over -1..1 — what a straight line of unit-weight goo sums to on its own centre line, per px of reach. */
export const FLUID_LIGHT_KERNEL_LINE_INTEGRAL = (() => {
  let s = 0;
  const n = 4000;
  for (let i = 0; i < n; i++) s += fluidLightKernel(Math.abs(-1 + (2 * (i + 0.5)) / n)) * (2 / n);
  return s;
})();

/** Bilinear map of a quad's corners (TL, TR, BR, BL) at (u, v). */
function quadPoint(corners, u, v) {
  const [tl, tr, br, bl] = corners;
  const topX = tl.x + (tr.x - tl.x) * u;
  const topY = tl.y + (tr.y - tl.y) * u;
  const botX = bl.x + (br.x - bl.x) * u;
  const botY = bl.y + (br.y - bl.y) * u;
  return { x: topX + (botX - topX) * v, y: topY + (botY - topY) * v };
}

/**
 * The emitters: every goo texel of the tube net binned into `cellPx` cells (in the item's own space), one emitter
 * per (cell, tube), at the centroid of the goo it stands for. Baked once per mask version.
 *
 * @param {object} net - `extractTubeNet`'s output.
 * @param {Array<{x:number,y:number}>} corners - the host quad's world corners (TL, TR, BR, BL).
 * @param {{cellPx?: number, maxEmitters?: number}} [opts]
 * @returns {Array<{x:number, y:number, row:number, s:number, areaPx:number}>}
 */
export function fluidLightEmitters(net, corners, opts = {}) {
  if (!net?.spec || !Array.isArray(corners) || corners.length !== 4) return [];
  const { w, h, texelW, texelH } = net.spec;
  if (!(w > 0) || !(h > 0)) return [];
  const maxEmitters = opts.maxEmitters ?? FLUID_LIGHT_MAX_EMITTERS;
  const texelArea = texelW * texelH;
  const spanW = net.spec.width ?? w * texelW;
  const spanH = net.spec.height ?? h * texelH;
  let cellPx = Math.max(texelW, texelH, opts.cellPx ?? FLUID_LIGHT_CELL_PX);
  for (let attempt = 0; attempt < 12; attempt++) {
    const cells = new Map();
    for (let y = 0; y < h; y++) {
      const ly = (y + 0.5) * texelH;
      const cy = Math.floor(ly / cellPx);
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const id = net.tubeIdByTexel[i];
        if (!id) continue;
        const lx = (x + 0.5) * texelW;
        const key = (Math.floor(lx / cellPx) * 4096 + cy) * 64 + (id % 64);
        let c = cells.get(key);
        if (!c) {
          c = { sx: 0, sy: 0, ss: 0, n: 0, row: id - 1 };
          cells.set(key, c);
        } else if (c.row !== id - 1) {
          // Two tubes whose ids collide mod 64 in one cell: keep them apart.
          const alt = key + 0.5;
          c = cells.get(alt) ?? { sx: 0, sy: 0, ss: 0, n: 0, row: id - 1 };
          cells.set(alt, c);
        }
        c.sx += lx;
        c.sy += ly;
        c.ss += net.sByTexel[i];
        c.n++;
      }
    }
    if (cells.size > maxEmitters) {
      cellPx *= 1.25;
      continue;
    }
    const out = [];
    for (const c of cells.values()) {
      if (!net.tubes[c.row]) continue;
      const p = quadPoint(corners, c.sx / c.n / spanW, c.sy / c.n / spanH);
      out.push({ x: p.x, y: p.y, row: c.row, s: c.ss / c.n, areaPx: c.n * texelArea });
    }
    return out;
  }
  return [];
}

/**
 * Per-emitter weights for a reach: area / (what a full reference pipe sums to), eased down where emitters crowd
 * (flasks). A full straight reference pipe then sums to ~1 on its centre line; a vat to a little more.
 * @param {Array<{x:number,y:number,areaPx:number}>} emitters
 * @param {number} reachPx
 * @returns {Float32Array}
 */
export function fluidLightWeights(emitters, reachPx) {
  const n = emitters.length;
  const out = new Float32Array(n);
  if (!(reachPx > 0)) return out;
  const ref = FLUID_LIGHT_REF_PIPE_PX * reachPx * FLUID_LIGHT_KERNEL_LINE_INTEGRAL;
  for (let i = 0; i < n; i++) {
    const a = emitters[i];
    let d = 0;
    for (let j = 0; j < n; j++) {
      const b = emitters[j];
      d += b.areaPx * fluidLightKernel(Math.hypot(a.x - b.x, a.y - b.y) / reachPx);
    }
    const ease = d > ref ? Math.pow(ref / d, DENSITY_EASE) : 1;
    out[i] = (a.areaPx / ref) * ease;
  }
  return out;
}

/**
 * This tick's light per emitter, into `out` (RGBA per emitter: the colour × brightness × weight it adds at its own
 * position; A = the bare goo level, for the status report). Brightness follows the goo exactly as the old lights did
 * — `fill × (0.45 + 0.75 energy)` — so a drought still darkens its stretch and a reaction front still lights the
 * floor as it passes; only the shape and the blend changed.
 *
 * @param {object} args
 * @param {Array<{row:number, s:number}>} args.emitters
 * @param {Float32Array} args.weights - {@link fluidLightWeights}.
 * @param {{tubes: Array<{phi: Float64Array, reagent: Float64Array, energy: Float64Array}>}} args.twin
 * @param {{colors:number[][], count:number}} args.palette
 * @param {number} args.gain - `light` param × fade × {@link FLUID_LIGHT_PEAK}.
 * @param {Float32Array} args.smooth - per-emitter smoothed level (mutated; NaN = unset).
 * @param {number} args.dtSec
 * @param {Float32Array} args.out - length ≥ 4 × emitters.length.
 * @returns {{lit: number, sum: number}} emitters above a trace level, and the total added (for the report).
 */
export function writeFluidLightEmitters({ emitters, weights, twin, palette, gain, smooth, dtSec, out }) {
  const k = 1 - Math.exp(-Math.max(0, dtSec) / LEVEL_TAU_S);
  let lit = 0;
  let sum = 0;
  for (let i = 0; i < emitters.length; i++) {
    const e = emitters[i];
    const t = twin?.tubes?.[e.row];
    let level = 0;
    let rg = 0;
    let en = 0;
    if (t) {
      const phi = sampleFluidTwin(t.phi, e.s);
      en = sampleFluidTwin(t.energy, e.s);
      rg = sampleFluidTwin(t.reagent, e.s);
      level = Math.min(1.6, Math.max(0, phi) * (0.45 + 0.75 * Math.max(0, en)));
    }
    const prev = smooth[i];
    level = Number.isFinite(prev) ? prev + (level - prev) * k : level;
    smooth[i] = level;
    const base = fluidReagentColor(palette, rg);
    const hot = Math.min(1, Math.max(0, en) * 0.18);
    const g = Math.max(0, gain) * (weights[i] ?? 0) * level;
    const o = i * 4;
    for (let c = 0; c < 3; c++) {
      const col = Math.min(1, base[c] + (1 - base[c]) * hot);
      const v = Number.isFinite(col * g) ? col * g : 0;
      out[o + c] = v;
      sum += v;
    }
    out[o + 3] = level;
    if (level > 0.02) lit++;
  }
  return { lit, sum };
}

/** A polygon circle — an emitter's footprint until (or unless) Foundry's wall sweep replaces it. */
export function fluidLightCircle(x, y, r, n = 32) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  return pts;
}

/**
 * Every emitter's footprint as one triangle soup: a fan from the emitter over its (wall-clipped) polygon. A
 * visibility polygon is star-shaped about its own origin, so the fan is exact. Per vertex: world position, the
 * emitter's centre (`aCentre`) and its index (`aEmitter`, the texel the shader reads its light from).
 *
 * @param {*} THREE
 * @param {Array<{x:number,y:number}>} emitters
 * @param {Array<number[]|null>} polygons - flat [x0,y0,x1,y1,...] per emitter (null = skip).
 * @returns {*} a BufferGeometry
 */
export function buildFluidLightFieldGeometry(THREE, emitters, polygons) {
  let tris = 0;
  for (let i = 0; i < emitters.length; i++) {
    const p = polygons[i];
    if (p && p.length >= 6) tris += p.length / 2;
  }
  const pos = new Float32Array(tris * 9);
  const centre = new Float32Array(tris * 6);
  const index = new Float32Array(tris * 3);
  let v = 0;
  for (let i = 0; i < emitters.length; i++) {
    const p = polygons[i];
    if (!p || p.length < 6) continue;
    const { x, y } = emitters[i];
    const m = p.length / 2;
    for (let k = 0; k < m; k++) {
      const k2 = (k + 1) % m;
      const pts = [x, y, p[k * 2], p[k * 2 + 1], p[k2 * 2], p[k2 * 2 + 1]];
      for (let q = 0; q < 3; q++) {
        pos[v * 3] = pts[q * 2];
        pos[v * 3 + 1] = pts[q * 2 + 1];
        pos[v * 3 + 2] = 0;
        centre[v * 2] = x;
        centre[v * 2 + 1] = y;
        index[v] = i;
        v++;
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('aCentre', new THREE.BufferAttribute(centre, 2));
  geometry.setAttribute('aEmitter', new THREE.BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * The material: kernel × the emitter's light × how dark the room is, ADDED into `buf:scene.illum` (alpha kept).
 *
 * @param {object} args
 * @param {*} args.THREE
 * @param {*} args.emitTexture - N×1 RGBA float, {@link writeFluidLightEmitters}'s output.
 * @param {*} [args.roomLightTexture] - `buf:scene.roomLight` (screen space). Absent = no daylight dimming.
 * @returns {{material: *, uReachPx: *, uCount: *}}
 */
export function buildFluidLightFieldMaterial({ THREE, emitTexture, roomLightTexture = null }) {
  const { uniform, attribute, texture, vec2, vec3, vec4, float, positionWorld, screenUV, clamp, max, dot, Fn } =
    THREE.TSL;
  const uReachPx = uniform(FLUID_LIGHT_REACH_PX);
  const uCount = uniform(1);
  const fragmentNode = Fn(() => {
    const centre = attribute('aCentre', 'vec2');
    const idx = attribute('aEmitter', 'float');
    const x = clamp(positionWorld.xy.sub(centre).length().div(uReachPx), float(0), float(1));
    const a = float(1).sub(x.mul(x));
    const kernel = a.mul(a).div(float(1).add(x.mul(x).mul(KERNEL_CORE)));
    const light = texture(emitTexture).sample(vec2(idx.add(0.5).div(uCount), float(0.5))).rgb;
    let day = float(1);
    if (roomLightTexture) {
      const room = texture(roomLightTexture, screenUV).rgb;
      const luma = dot(room, vec3(0.2126, 0.7152, 0.0722));
      day = max(float(FLUID_LIGHT_DAY_FLOOR), float(1).sub(luma.mul(FLUID_LIGHT_DAY_DIM)));
    }
    return vec4(light.mul(kernel.mul(day)), float(0));
  })();
  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  // ADD the colour; leave the target's alpha as it was.
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquationAlpha = THREE.AddEquation;
  material.blendSrcAlpha = THREE.ZeroFactor;
  material.blendDstAlpha = THREE.OneFactor;
  material.fragmentNode = fragmentNode;
  return { material, uReachPx, uCount };
}
