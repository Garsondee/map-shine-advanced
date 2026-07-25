/**
 * Node verification for the particle arena's bookkeeping (docs/planning/
 * Particles.md §10). The GPU half (allocateBuffers) is browser-only and verified
 * live; the free-list and the budget math are pure, so they are proven here —
 * months before a buffer is allocated, the same posture as the schema test.
 */
import {
  ParticleArena,
  describeParticleArena,
  PARTICLE_ATTRIBUTES,
  BYTES_PER_PARTICLE,
  DEFAULT_BUDGET_BYTES,
} from '../particle-arena.js';

export function run(t) {
  // ---- the layout is exact and frozen --------------------------------------
  {
    t.ok('PARTICLE_ATTRIBUTES is frozen', Object.isFrozen(PARTICLE_ATTRIBUTES));
    t.ok(
      'each attribute descriptor is frozen',
      PARTICLE_ATTRIBUTES.every((a) => Object.isFrozen(a))
    );
    // vec2+vec2+float+float+float+vec4 = 8+8+4+4+4+16 = 44.
    t.ok(`BYTES_PER_PARTICLE is the exact sum of the layout (got ${BYTES_PER_PARTICLE})`, BYTES_PER_PARTICLE === 44);
  }

  // ---- describe: budget -> capacity, pure ----------------------------------
  {
    const d = describeParticleArena();
    t.ok('default budget derives a positive capacity', d.capacity > 0);
    t.ok(
      'capacity is floor(budget / bytesPerParticle)',
      d.capacity === Math.floor(DEFAULT_BUDGET_BYTES / BYTES_PER_PARTICLE)
    );
    t.ok('describe carries the attribute layout through', d.attributes === PARTICLE_ATTRIBUTES);

    const small = describeParticleArena({ budgetBytes: 44 * 100 });
    t.ok('a small explicit budget derives the expected capacity', small.capacity === 100);
  }

  // ---- reserve: contiguous, non-overlapping, first from 0 ------------------
  {
    const a = new ParticleArena({ budgetBytes: 44 * 1000 }); // 1000 slots
    t.ok('a fresh arena starts fully available', a.available === 1000 && a.used === 0);

    const r1 = a.reserve(100);
    t.ok('the first reservation starts at offset 0', r1.offset === 0 && r1.capacity === 100);
    t.ok('used/available track the reservation', a.used === 100 && a.available === 900);

    const r2 = a.reserve(250);
    t.ok('the second reservation is contiguous after the first', r2.offset === 100 && r2.capacity === 250);
    t.ok('reservations do not overlap', r1.offset + r1.capacity <= r2.offset);
    t.ok('used accumulates', a.used === 350);
  }

  // ---- reserve(0) is a harmless no-op handle -------------------------------
  {
    const a = new ParticleArena({ budgetBytes: 44 * 10 });
    const z = a.reserve(0);
    t.ok('reserve(0) yields an empty handle and consumes nothing', z.capacity === 0 && a.used === 0);
  }

  // ---- over-budget throws LOUD, with the numbers ---------------------------
  {
    const a = new ParticleArena({ budgetBytes: 44 * 10 }); // only 10 slots
    a.reserve(8);
    t.throws('reserving past the budget throws', () => a.reserve(5), 'particle budget');
    let msg = '';
    try {
      a.reserve(5);
    } catch (e) {
      msg = e.message;
    }
    t.ok('the error reports how much was free vs total', /2 of 10 slots free/.test(msg));
    t.ok('the error names the fix (raise budget / lower capacity)', /Particles\.md|capacity/.test(msg));
  }

  // ---- release returns space and lets it be re-reserved --------------------
  {
    const a = new ParticleArena({ budgetBytes: 44 * 1000 });
    const r = a.reserve(400);
    t.ok('used reflects the reservation', a.used === 400);
    a.release(r);
    t.ok('release returns the slots', a.used === 0 && a.available === 1000);
    const r2 = a.reserve(400);
    t.ok('the freed range is reusable (recycled, never grown)', r2.offset === 0);
  }

  // ---- first-fit fills a hole; coalescing merges neighbours ----------------
  {
    const a = new ParticleArena({ budgetBytes: 44 * 300 });
    const A = a.reserve(100); // [0,100)
    const B = a.reserve(100); // [100,200)
    const C = a.reserve(100); // [200,300)
    t.ok('arena is full', a.available === 0);

    a.release(A); // free [0,100)
    a.release(C); // free [200,300)
    t.ok('two disjoint holes freed', a.available === 200);

    const fit = a.reserve(80); // first-fit into A's hole
    t.ok('first-fit uses the earliest hole', fit.offset === 0 && fit.capacity === 80);

    // Now free B and the remainder of A's hole so [0,200) can coalesce into one.
    a.release(fit); // free [0,80) -> coalesces with leftover [80,100)
    a.release(B); // free [100,200) -> touches [0,100) => one range [0,200)
    const big = a.reserve(200); // only satisfiable if the two holes merged
    t.ok('adjacent freed ranges coalesced into one big range', big.offset === 0 && big.capacity === 200);
  }

  // ---- churn does not leak: everything released -> arena is whole again -----
  {
    const a = new ParticleArena({ budgetBytes: 44 * 500 });
    const handles = [];
    for (let i = 0; i < 5; i++) handles.push(a.reserve(50));
    for (const h of handles) a.release(h);
    t.ok('after full churn, used is 0', a.used === 0);
    // and the free-list is a single whole range again (a 500-slot reserve fits).
    const whole = a.reserve(500);
    t.ok('the arena coalesced back to one whole free range', whole.offset === 0 && whole.capacity === 500);
  }

  // ---- a double-release is reported, not silently corrupting ----------------
  {
    const a = new ParticleArena({ budgetBytes: 44 * 100 });
    const r = a.reserve(40);
    a.release(r);
    const usedBefore = a.used;
    a.release(r); // second release of the same handle: overlaps a free range
    t.ok('a double-release does not push used negative', a.used === usedBefore && a.used === 0);
  }

  // ---- allocateBuffers is present (browser-only; not run here) --------------
  {
    const a = new ParticleArena({ budgetBytes: 44 * 10 });
    t.ok('allocateBuffers exists as the one GPU-allocation door', typeof a.allocateBuffers === 'function');
    t.ok('buffers are null until allocated', a.buffers === null);
  }
}
