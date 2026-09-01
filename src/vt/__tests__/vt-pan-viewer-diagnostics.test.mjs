/**
 * vt-pan-viewer-diagnostics.test.mjs — the pure helpers extracted from
 * `_active.getDiagnostics()` (extraction step 5). `buildViewerDiagnostics`
 * itself is NOT tested here: it reads renderer/cache/subsystem objects real
 * enough to need extensive mocking for little signal, the same reasoning
 * that keeps `sun-shadow-subsystem.js`/`point-light-pool.js` browser-only
 * (CONVENTIONS §4). `percentileMs`, `sampleDiagnostics` and `buildDrawList`
 * take only plain data as input, so they get real coverage for free.
 */
import { percentileMs, sampleDiagnostics, buildDrawList } from '../vt-pan-viewer-diagnostics.js';

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

  // --- buildDrawList — uniforms (mythica-machina-press#104 verification) ----
  // `appearance` lives at `state.wholeImage.tiles[N].appearance` (see
  // buildWholeImageMaterial's return shape) — NEVER at the top-level `state`
  // itself. A prior version of this reader looked at `state?.appearance`
  // directly, which does not exist on the per-item state object (its real
  // shape: item/packs/layerErrors/imageSize/placement/worldBounds/geometry/
  // material/mesh/hoverFade/occluded) — so `uniforms` read null for every
  // item, always, regardless of what the shader was actually doing.
  const fakeVec = (arr) => ({ value: { toArray: () => arr } });
  const fakeAppearance = {
    uOcclusionWeights: fakeVec([0, 0, 0, 0]),
    uOcclusionElevation: { value: 1 },
    uAlpha: { value: 0.5 },
    uUnoccludedAlpha: { value: 1 },
    uOccludedAlpha: { value: 0 },
    uTint: fakeVec([1, 0, 0]),
  };
  const baseItem = {
    id: 'token:a',
    renderOrder: 0,
    kind: 'token',
    key: { elevation: 0, sortLayer: 700, sort: 0, zIndex: 0 },
  };
  {
    const itemStates = new Map([['token:a', { wholeImage: { tiles: [{ appearance: fakeAppearance }] } }]]);
    const [row] = buildDrawList({ lastItems: [baseItem], itemStates });
    t.ok('uniforms reads the real tint/alpha from wholeImage.tiles[].appearance', row.uniforms !== null);
    t.ok('tint round-trips', row.uniforms.tint[0] === 1 && row.uniforms.tint[1] === 0);
    t.ok('alpha round-trips (this is item.alpha as seeded into uAlpha)', row.uniforms.alpha === 0.5);
  }
  {
    // The OLD, broken read path — a stray top-level `appearance` — must NOT
    // be picked up by the fixed reader; only the nested per-tile one counts.
    const itemStates = new Map([['token:a', { appearance: fakeAppearance, wholeImage: { tiles: [{}] } }]]);
    const [row] = buildDrawList({ lastItems: [baseItem], itemStates });
    t.ok(
      'a stray top-level `appearance` is ignored — only wholeImage.tiles[].appearance counts',
      row.uniforms === null
    );
  }
  {
    // No wholeImage yet (item still loading) — must report null, not throw.
    const itemStates = new Map([['token:a', {}]]);
    const [row] = buildDrawList({ lastItems: [baseItem], itemStates });
    t.ok('an item with no wholeImage yet reports null uniforms, not a crash', row.uniforms === null);
  }
  {
    // No state at all for this id — must report null, not throw.
    const [row] = buildDrawList({ lastItems: [baseItem], itemStates: new Map() });
    t.ok('an item with no state at all reports null uniforms, not a crash', row.uniforms === null);
  }
}
