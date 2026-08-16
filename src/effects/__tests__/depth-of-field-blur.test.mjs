/**
 * DEPTH OF FIELD — the floor-distance-to-blur maths, asserted.
 * Plan of record: `docs/planning/Depth-of-Field.md`.
 *
 * The load-bearing guarantee in this file: `computeDofAlpha` returns EXACTLY
 * 0 at/above the viewed floor, in every degenerate-input case, because that
 * zero is what leaves the current floor's own pixels byte-identical under
 * NormalBlending (`depth-of-field-render.js`'s own header) — a wrong default
 * here would mean the "never touch the current floor" promise silently
 * breaks for some input, not just an off-by-a-bit blur amount. Below the
 * viewed floor it is now a hard, strength-independent 1 (always a full
 * replace) — `strength` moved to `computeDofMipSample`, where it scales the
 * blur RADIUS instead of the composite's alpha, so it no longer produces a
 * sharp/blurred ghosting cross-fade at anything short of full strength.
 */
import { computeDofFloorsBelow, computeDofMipSample, computeDofAlpha } from '../depth-of-field-blur.js';

/** @param {{ok:(name:string, cond:boolean)=>void}} t */
export function run(t) {
  const { ok } = t;

  // ── computeDofFloorsBelow ──────────────────────────────────────────────
  {
    ok(
      'the current floor itself is zero floors below',
      computeDofFloorsBelow({ floorIndexHere: 2, viewedFloorIndex: 2 }) === 0
    );
    ok(
      'a floor ABOVE the viewed one is zero floors below, never negative',
      computeDofFloorsBelow({ floorIndexHere: 3, viewedFloorIndex: 1 }) === 0
    );
    ok('one floor down reads as 1', computeDofFloorsBelow({ floorIndexHere: 0, viewedFloorIndex: 1 }) === 1);
    ok('three floors down reads as 3', computeDofFloorsBelow({ floorIndexHere: 0, viewedFloorIndex: 3 }) === 3);
    ok(
      'an unwritten pixel (present:false) reads as zero, regardless of R — the (0,0,0,0) ' +
        'clear must never be mistaken for a genuine, far-below floor 0',
      computeDofFloorsBelow({ floorIndexHere: 0, viewedFloorIndex: 5, present: false }) === 0
    );
    ok(
      'present defaults to true (a caller with no depth-buffer alpha to check still gets a real answer)',
      computeDofFloorsBelow({ floorIndexHere: 0, viewedFloorIndex: 5 }) === 5
    );
    ok(
      'a non-integer floor index rounds rather than truncating oddly',
      computeDofFloorsBelow({ floorIndexHere: 0.49, viewedFloorIndex: 3.51 }) === 4
    );
    ok(
      'garbage inputs degrade to zero, never NaN',
      computeDofFloorsBelow({ floorIndexHere: NaN, viewedFloorIndex: undefined }) === 0
    );
  }

  // ── computeDofMipSample ─────────────────────────────────────────────────
  {
    ok(
      'zero floors below → lod 0, and the fraction is 0 (pure mip0, the least-blurred level)',
      (() => {
        const s = computeDofMipSample({ floorsBelow: 0, blurPerFloor: 1.2, maxBlur: 1, mipCount: 4 });
        return s.lod === 0 && s.frac === 0;
      })()
    );
    ok(
      'lod climbs linearly with floorsBelow, before the cap',
      (() => {
        const at = (n) => computeDofMipSample({ floorsBelow: n, blurPerFloor: 1, maxBlur: 1, mipCount: 4 }).lod;
        return at(1) === 1 && at(2) === 2;
      })()
    );
    ok(
      'lod0/lod1 straddle a fractional lod correctly, with a matching fractional part',
      (() => {
        const s = computeDofMipSample({ floorsBelow: 1, blurPerFloor: 1.5, maxBlur: 1, mipCount: 4 });
        // floorsBelow(1) * blurPerFloor(1.5) = 1.5 -> lod0=1, lod1=2, frac=0.5
        return s.lod0 === 1 && s.lod1 === 2 && Math.abs(s.frac - 0.5) < 1e-9;
      })()
    );
    ok(
      'lod is clamped at the top of the mip chain — a floor far below never asks for a level that does not exist',
      (() => {
        const s = computeDofMipSample({ floorsBelow: 999, blurPerFloor: 3, maxBlur: 1, mipCount: 4 });
        return s.lod === 3 && s.lod0 === 3 && s.lod1 === 3 && s.frac === 0;
      })()
    );
    ok(
      'AT the exact top of the chain, lod0 and lod1 coincide (never lod1 > topLod)',
      (() => {
        const s = computeDofMipSample({ floorsBelow: 3, blurPerFloor: 1, maxBlur: 1, mipCount: 4 });
        return s.lod0 === 3 && s.lod1 === 3;
      })()
    );
    ok(
      'maxBlur caps the reachable lod as a FRACTION of the range, not an absolute lod value',
      (() => {
        const s = computeDofMipSample({ floorsBelow: 999, blurPerFloor: 3, maxBlur: 0.5, mipCount: 5 });
        // topLod = 4, cap = 4 * 0.5 = 2
        return s.lod === 2;
      })()
    );
    ok(
      'maxBlur=0 holds every pixel at lod 0 regardless of distance — a real "off" switch for the reach',
      computeDofMipSample({ floorsBelow: 50, blurPerFloor: 2, maxBlur: 0, mipCount: 4 }).lod === 0
    );
    ok(
      'a single-mip chain (mipCount<=1) is total and always resolves to level 0',
      (() => {
        const s = computeDofMipSample({ floorsBelow: 10, blurPerFloor: 5, maxBlur: 1, mipCount: 1 });
        return s.lod === 0 && s.lod0 === 0 && s.lod1 === 0 && s.frac === 0;
      })()
    );
    ok(
      'garbage mipCount degrades to a single level rather than throwing or returning NaN indices',
      (() => {
        const s = computeDofMipSample({ floorsBelow: 3, blurPerFloor: 1, maxBlur: 1, mipCount: NaN });
        return Number.isFinite(s.lod) && Number.isFinite(s.lod0) && Number.isFinite(s.lod1);
      })()
    );
    ok(
      'negative/garbage blurPerFloor never produces a negative lod',
      computeDofMipSample({ floorsBelow: 5, blurPerFloor: -3, maxBlur: 1, mipCount: 4 }).lod === 0
    );
    ok(
      'lod is monotonic in floorsBelow — a further-below floor is never LESS blurred',
      (() => {
        const lodAt = (n) => computeDofMipSample({ floorsBelow: n, blurPerFloor: 0.7, maxBlur: 1, mipCount: 5 }).lod;
        let prev = -1;
        let monotonic = true;
        for (let n = 0; n <= 20; n++) {
          const v = lodAt(n);
          if (v < prev) monotonic = false;
          prev = v;
        }
        return monotonic;
      })()
    );
    ok(
      'strength scales the RADIUS: half strength halves the lod reached at a given distance',
      (() => {
        const s = computeDofMipSample({ floorsBelow: 2, strength: 0.5, blurPerFloor: 1, maxBlur: 1, mipCount: 5 });
        return s.lod === 1;
      })()
    );
    ok(
      'strength=0 holds every below-floor pixel at lod 0 — a real "no blur" switch, not an opacity of 0',
      computeDofMipSample({ floorsBelow: 50, strength: 0, blurPerFloor: 2, maxBlur: 1, mipCount: 4 }).lod === 0
    );
    ok(
      'strength is clamped into [0,1] — an out-of-range stored value cannot over- or under-shoot the ramp',
      computeDofMipSample({ floorsBelow: 3, strength: 5, blurPerFloor: 1, maxBlur: 1, mipCount: 5 }).lod ===
        computeDofMipSample({ floorsBelow: 3, strength: 1, blurPerFloor: 1, maxBlur: 1, mipCount: 5 }).lod &&
        computeDofMipSample({ floorsBelow: 3, strength: -5, blurPerFloor: 1, maxBlur: 1, mipCount: 5 }).lod === 0
    );
    ok(
      'a non-finite strength defaults to 1 (the schema default), never a silent zero — a broken param must not ' +
        'read as "effect off"',
      (() => {
        const withNaN = computeDofMipSample({
          floorsBelow: 3,
          strength: NaN,
          blurPerFloor: 1,
          maxBlur: 1,
          mipCount: 5,
        });
        const withOne = computeDofMipSample({ floorsBelow: 3, strength: 1, blurPerFloor: 1, maxBlur: 1, mipCount: 5 });
        return withNaN.lod === withOne.lod;
      })()
    );
    ok(
      'an omitted strength (a caller not yet passing it) also degrades to 1, not 0',
      computeDofMipSample({ floorsBelow: 2, blurPerFloor: 1, maxBlur: 1, mipCount: 5 }).lod === 2
    );
  }

  // ── computeDofAlpha — THE "NEVER TOUCH THE CURRENT FLOOR" GUARANTEE ─────
  {
    ok(
      'zero floors below -> alpha is EXACTLY 0 even with a nonzero lod',
      computeDofAlpha({ floorsBelow: 0, lod: 2 }) === 0
    );
    ok(
      'a negative floorsBelow (should never happen, but total) is also alpha 0',
      computeDofAlpha({ floorsBelow: -1, lod: 2 }) === 0
    );
    ok(
      'a floor below with a nonzero lod -> alpha is EXACTLY 1, a full replace, never a fractional cross-fade',
      computeDofAlpha({ floorsBelow: 1, lod: 0.01 }) === 1 && computeDofAlpha({ floorsBelow: 5, lod: 3 }) === 1
    );
    ok(
      'a floor below but lod EXACTLY 0 (strength/blurPerFloor/maxBlur all landed the ramp at zero) -> alpha 0 — ' +
        'mip0 is a softened half-res sample, not a sharp source, so "no blur requested" must mean "untouched," ' +
        'not "replaced by the least-blurred mip anyway"',
      computeDofAlpha({ floorsBelow: 1, lod: 0 }) === 0
    );
    ok(
      'end-to-end: every slider at 0 (strength, blurPerFloor, maxBlur) drives lod to 0, and that ' +
        'lod-of-0 disables the replace outright — the actual bug this test set exists to catch',
      (() => {
        const { lod } = computeDofMipSample({ floorsBelow: 3, strength: 0, blurPerFloor: 0, maxBlur: 0, mipCount: 4 });
        return computeDofAlpha({ floorsBelow: 3, lod }) === 0;
      })()
    );
  }
}
