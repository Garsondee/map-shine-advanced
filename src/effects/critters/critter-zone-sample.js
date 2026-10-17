/**
 * THE ZONE SAMPLER — the TSL transcription of `critter-zone.js#sampleZoneField`,
 * for use inside a compute kernel.
 *
 * Reads the zone buffer (a flat `vec4` storage buffer: coverage, signed distance,
 * gradient x, gradient y per cell — see `critter-zone.js`), bilinear over the four
 * nearest cell centres, edge-clamped, with the distance to the field's rectangle
 * subtracted so "farther out" still reads as farther out past the margin. The lab
 * compares this against the CPU twin on the real GPU; any disagreement is a
 * transcription bug, not a tolerance.
 *
 * Storage buffer, not texture, because a texture sampled from a compute kernel is
 * the thing this renderer has never been shown to do correctly
 * (`fire-spawn-points.js` records the live zero-readback).
 *
 * @module effects/critters/critter-zone-sample
 */

/**
 * @param {*} TSL
 * @param {object} a
 * @param {*} a.buffer - the zone storage node (`createCritterZoneBuffer().node`).
 * @param {(name: string) => *} a.u - the uniform bank's `get`.
 * @returns {{sample: (pos: *) => {coverage:*, distance:*, grad:*}, nearest: (pos: *) => {coverage:*, distance:*, grad:*}, home: (slot: *) => *}}
 */
export function buildZoneSampler(TSL, { buffer, u }) {
  const { float, vec2, clamp, floor, mix, max, length } = TSL;
  const origin = u('zoneOrigin');
  const cell = u('zoneCell');
  const dims = u('zoneDims');
  const homesOffset = u('homesOffset');

  const cellAt = (ix, iy) => {
    const cx = clamp(ix, 0, dims.x.sub(1));
    const cy = clamp(iy, 0, dims.y.sub(1));
    return buffer.element(cy.mul(dims.x).add(cx).toInt());
  };

  /** Distance from `pos` to the field's rectangle (0 inside it). */
  const overshoot = (pos) => {
    const endX = origin.x.add(dims.x.mul(cell.x));
    const endY = origin.y.add(dims.y.mul(cell.y));
    const ox = max(max(origin.x.sub(pos.x), pos.x.sub(endX)), 0);
    const oy = max(max(origin.y.sub(pos.y), pos.y.sub(endY)), 0);
    return length(vec2(ox, oy));
  };

  const unpack = (v, pos) => ({
    coverage: v.x,
    distance: v.y.sub(overshoot(pos)),
    grad: vec2(v.z, v.w),
  });

  /** Bilinear: 4 reads. For anything that steers by the gradient. */
  function sample(pos) {
    const uu = pos.x.sub(origin.x).div(cell.x).sub(0.5);
    const vv = pos.y.sub(origin.y).div(cell.y).sub(0.5);
    const i0 = floor(uu);
    const j0 = floor(vv);
    const fu = uu.sub(i0);
    const fv = vv.sub(j0);
    const c00 = cellAt(i0, j0);
    const c10 = cellAt(i0.add(1), j0);
    const c01 = cellAt(i0, j0.add(1));
    const c11 = cellAt(i0.add(1), j0.add(1));
    const v = mix(mix(c00, c10, fu), mix(c01, c11, fu), fv);
    return unpack(v, pos);
  }

  /** Nearest cell: 1 read. For cheap probes (is this candidate target inside?). */
  function nearest(pos) {
    const ix = floor(pos.x.sub(origin.x).div(cell.x));
    const iy = floor(pos.y.sub(origin.y).div(cell.y));
    return unpack(cellAt(ix, iy), pos);
  }

  /** The slot's home record: (x, y, zoneIndex, zoneAreaPx2). */
  function home(slotIndexFloat) {
    return buffer.element(homesOffset.add(float(slotIndexFloat)).toInt());
  }

  return { sample, nearest, home };
}
