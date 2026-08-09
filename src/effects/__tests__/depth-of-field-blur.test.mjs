/**
 * DEPTH OF FIELD — the floor-distance-to-blur maths, asserted.
 * Plan of record: `docs/planning/Depth-of-Field.md`.
 *
 * The load-bearing guarantee in this file: `computeDofAlpha` returns EXACTLY
 * 0 at/above the viewed floor, in every degenerate-input case, because that
 * zero is what leaves the current floor's own pixels byte-identical under
 * NormalBlending (`depth-of-field-render.js`'s own header) — a wrong default
 * here would mean the "never touch the current floor" promise silently
 * breaks for some input, not just an off-by-a-bit blur amount.
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
  }

  // ── computeDofAlpha — THE "NEVER TOUCH THE CURRENT FLOOR" GUARANTEE ─────
  {
    ok('zero floors below -> alpha is EXACTLY 0', computeDofAlpha({ floorsBelow: 0, strength: 1 }) === 0);
    ok(
      'zero floors below is alpha 0 even at max strength and even with garbage strength',
      computeDofAlpha({ floorsBelow: 0, strength: 1 }) === 0 &&
        computeDofAlpha({ floorsBelow: 0, strength: NaN }) === 0 &&
        computeDofAlpha({ floorsBelow: 0, strength: -5 }) === 0
    );
    ok(
      'a negative floorsBelow (should never happen, but total) is also alpha 0',
      computeDofAlpha({ floorsBelow: -1, strength: 1 }) === 0
    );
    ok('one floor below at full strength -> alpha 1', computeDofAlpha({ floorsBelow: 1, strength: 1 }) === 1);
    ok('one floor below at half strength -> alpha 0.5', computeDofAlpha({ floorsBelow: 1, strength: 0.5 }) === 0.5);
    ok(
      'strength is clamped into [0,1] — an out-of-range stored value cannot over- or under-shoot',
      computeDofAlpha({ floorsBelow: 1, strength: 5 }) === 1 && computeDofAlpha({ floorsBelow: 1, strength: -5 }) === 0
    );
    ok(
      'a non-finite strength on a BELOW-floor pixel defaults to 1 (the schema default), never a silent zero — ' +
        'a broken param must not read as "effect off"',
      computeDofAlpha({ floorsBelow: 2, strength: NaN }) === 1
    );
  }
}
