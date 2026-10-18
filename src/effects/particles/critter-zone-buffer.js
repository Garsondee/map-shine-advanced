/**
 * THE CRITTER ZONE BUFFER — the one storage buffer a swarm perceives its world
 * through (`effects/critters/critter-zone.js` says what is in it and why).
 *
 * ⚠️ IT LIVES IN `effects/particles/` BECAUSE `particles/allocator-only` SAYS SO.
 * `instancedArray()` is particle-memory allocation and has exactly one legal
 * neighbourhood. The pure packing is `critter-zone.js#packZoneBuffer` (Node-tested);
 * this file is only the thin GPU shell that owns the allocation, the same
 * testable-core / thin-shell split `particle-arena.js` uses.
 *
 * ONE BUFFER, SEVERAL SECTIONS: the field's cells first, then one HOME section per
 * engine that shares the zone (flies and maggots share the `flies` zone; each has
 * its own slots, so each gets its own homes). The arena already binds seven of the
 * eight storage buffers WebGPU guarantees to a compute stage; this is the eighth.
 *
 * Allocated ONCE at the maximum size (a 512² derived grid plus every home
 * section). A storage buffer cannot be freed or grown, so every later zone is
 * written into it in place — the same "never free, always recycle" discipline as
 * the arena.
 *
 * @module effects/particles/critter-zone-buffer
 */
import { ZONE_CELL_STRIDE, packZoneBuffer, zoneBufferElementCount } from '../critters/critter-zone.js';

/**
 * @param {object} deps
 * @param {*} deps.THREE - injected.
 * @param {number} deps.maxCells - the most cells a field may have.
 * @param {number[]} deps.homeCapacities - slots per home section, in section order.
 * @returns {{node: *, backing: Float32Array, maxCells: number,
 *   sectionOffsets: number[], write: (field: object|null, homes: Array<Float32Array|null>) => {cellsWritten:number, truncated:boolean}}}
 */
export function createCritterZoneBuffer({ THREE, maxCells, homeCapacities }) {
  const total = zoneBufferElementCount(maxCells, homeCapacities);
  const node = THREE.TSL.instancedArray(total, 'vec4');
  const backing = node.value.array ?? node.value;
  if (backing.length !== total * ZONE_CELL_STRIDE) {
    throw new Error(
      `critter zone buffer: backing array is ${backing.length} floats, expected ${total * ZONE_CELL_STRIDE} ` +
        '(instancedArray no longer exposes a flat Float32Array — the packer and the kernel would disagree about layout)'
    );
  }
  /** vec4-element offset of each home section. */
  const sectionOffsets = [];
  let cursor = maxCells;
  for (const cap of homeCapacities) {
    sectionOffsets.push(cursor);
    cursor += Math.max(0, cap | 0);
  }

  /**
   * Write a field and each section's homes, then mark the buffer for upload.
   * @param {object|null} field - null clears the zone.
   * @param {Array<Float32Array|null>} homes - one entry per section (null = empty).
   */
  function write(field, homes) {
    const sections = sectionOffsets.map((offset, i) => ({
      offset,
      capacity: homeCapacities[i],
      homes: homes[i] ?? null,
    }));
    const result = packZoneBuffer(backing, field, maxCells, sections);
    node.value.needsUpdate = true;
    return result;
  }

  return { node, backing, maxCells, sectionOffsets, write };
}
