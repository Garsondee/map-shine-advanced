/**
 * vt-pan-viewer-diagnostics.test.mjs — the two pure helpers extracted from
 * `_active.getDiagnostics()` (extraction step 5). `buildViewerDiagnostics`
 * itself is NOT tested here: it reads renderer/cache/subsystem objects real
 * enough to need extensive mocking for little signal, the same reasoning
 * that keeps `sun-shadow-subsystem.js`/`point-light-pool.js` browser-only
 * (CONVENTIONS §4). `percentileMs` and `sampleDiagnostics` have zero free
 * variables beyond their own parameters, so they get real coverage for free.
 */
import { percentileMs, sampleDiagnostics } from '../vt-pan-viewer-diagnostics.js';

export async function run(t) {
  // --- percentileMs ---------------------------------------------------------
  t.ok('empty array reads null, never 0 (instruments must not lie)', percentileMs([], 0.5) === null);
  t.ok(
    'null/undefined samples also read null',
    percentileMs(null, 0.5) === null && percentileMs(undefined, 0.5) === null
  );
  t.ok(
    'a single sample is its own every percentile',
    percentileMs([42], 0.5) === 42 && percentileMs([42], 0.99) === 42
  );
  {
    const samples = [10, 20, 30, 40, 50];
    t.ok('p=0 (nearest-rank) reads the smallest sample', percentileMs(samples, 0) === 10);
    t.ok('p=1 reads the largest sample', percentileMs(samples, 1) === 50);
    t.ok('p=0.5 on 5 sorted samples is the middle one', percentileMs(samples, 0.5) === 30);
  }
  t.ok('input order does not matter — it sorts internally', percentileMs([50, 10, 30, 40, 20], 0.5) === 30);
  t.ok(
    'the original array is not mutated by the internal sort',
    (() => {
      const original = [5, 3, 1, 4, 2];
      percentileMs(original, 0.5);
      return original.join(',') === '5,3,1,4,2';
    })()
  );
  t.ok('rounds to 0.1ms', percentileMs([1.23, 4.56, 7.89], 1) === 7.9);

  // --- sampleDiagnostics -----------------------------------------------------
  t.ok('no pack at all returns an empty object, not a crash', Object.keys(sampleDiagnostics(undefined)).length === 0);
  t.ok('null pack also returns empty', Object.keys(sampleDiagnostics(null)).length === 0);
  {
    // buf is RGBA per texel; alpha>0 means resident. R/G pack the slot id
    // (low byte, high byte) — texel 0 resident at slot 0x0102, texel 1 empty,
    // texel 2 resident at slot 0x0304, texel 3 resident at slot 0x0102 again
    // (same slot as texel 0 — must count once in distinctSlotCount).
    const buf = new Uint8Array([
      0x02,
      0x01,
      0,
      255, // texel 0: slot 0x0102, resident
      0,
      0,
      0,
      0, //          texel 1: empty
      0x04,
      0x03,
      0,
      255, // texel 2: slot 0x0304, resident
      0x02,
      0x01,
      0,
      200, // texel 3: same slot as texel 0, resident (alpha>0)
    ]);
    const out = sampleDiagnostics({ buf });
    t.ok('totalTexels counts every RGBA quad', out.indirectionBuffer.totalTexels === 4);
    t.ok('residentTexels counts only alpha>0 texels', out.indirectionBuffer.residentTexels === 3);
    t.ok('distinctSlotCount de-duplicates repeated slots', out.indirectionBuffer.distinctSlotCount === 2);
    t.ok(
      'distinctSlotsSample carries the actual packed slot ids',
      out.indirectionBuffer.distinctSlotsSample.includes(0x0102) &&
        out.indirectionBuffer.distinctSlotsSample.includes(0x0304)
    );
  }
  {
    const allEmpty = new Uint8Array(16); // 4 texels, all alpha=0
    const out = sampleDiagnostics({ buf: allEmpty });
    t.ok('an all-empty buffer reports 0 resident, not a crash', out.indirectionBuffer.residentTexels === 0);
    t.ok('...and 0 distinct slots', out.indirectionBuffer.distinctSlotCount === 0);
  }
  {
    // distinctSlotsSample caps at 10 even with many more distinct slots.
    const n = 20;
    const buf = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      buf[i * 4] = i; // distinct low byte per texel -> distinct slot per texel
      buf[i * 4 + 3] = 255;
    }
    const out = sampleDiagnostics({ buf });
    t.ok('distinctSlotCount counts all 20, unclamped', out.indirectionBuffer.distinctSlotCount === 20);
    t.ok(
      'distinctSlotsSample is capped at 10 for report readability',
      out.indirectionBuffer.distinctSlotsSample.length === 10
    );
  }
}
