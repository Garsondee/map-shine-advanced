/**
 * Node verification for effects/lighting/point-light-batch.js — S2.2's own
 * gate (`docs/holy/V4-Testament.md`: "Evidence: Node tests"). Pure CPU
 * bookkeeping, no THREE, no device — every assertion here is checkable
 * without a browser.
 */
import {
  BATCH_FALLOFF_MODELS,
  MAX_VERTEX_BUFFERS_PER_PIPELINE,
  computeBucketKey,
  canBatchLight,
  isColorationEligible,
  describeBucketVertexBuffers,
  createBucket,
  createBucketRegistry,
  partitionLightsForBatching,
} from '../point-light-batch.js';

export function run(t) {
  const { ok } = t;

  // ==========================================================================
  // computeBucketKey — §3.1's key, animation identity keyed on RESOLUTION
  // ==========================================================================
  ok(
    'two lights with the SAME resolved animation type key identically',
    computeBucketKey({
      animationType: 'candleFlicker',
      animationResolved: true,
      animationQuality: 2,
      falloffModel: 'inverseSquare',
      windPresent: true,
    }) ===
      computeBucketKey({
        animationType: 'candleFlicker',
        animationResolved: true,
        animationQuality: 2,
        falloffModel: 'inverseSquare',
        windPresent: true,
      })
  );
  ok(
    'two DIFFERENT unresolved (unported or absent) animation type strings key IDENTICALLY — the whole point of keying on resolution, not the raw string',
    computeBucketKey({
      animationType: 'reactivepulse',
      animationResolved: false,
      animationQuality: 0,
      falloffModel: 'foundry',
      windPresent: false,
    }) ===
      computeBucketKey({
        animationType: null,
        animationResolved: false,
        animationQuality: 0,
        falloffModel: 'foundry',
        windPresent: false,
      })
  );
  ok(
    'a resolved animation type and an unresolved one with the SAME raw string key DIFFERENTLY (resolution, not string, decides)',
    computeBucketKey({
      animationType: 'torch',
      animationResolved: true,
      animationQuality: 0,
      falloffModel: 'foundry',
      windPresent: false,
    }) !==
      computeBucketKey({
        animationType: 'torch',
        animationResolved: false,
        animationQuality: 0,
        falloffModel: 'foundry',
        windPresent: false,
      })
  );
  ok(
    'quality, falloffModel, and windPresent are each independent key dimensions',
    new Set([
      computeBucketKey({
        animationType: 'flame',
        animationResolved: true,
        animationQuality: 0,
        falloffModel: 'foundry',
        windPresent: false,
      }),
      computeBucketKey({
        animationType: 'flame',
        animationResolved: true,
        animationQuality: 1,
        falloffModel: 'foundry',
        windPresent: false,
      }),
      computeBucketKey({
        animationType: 'flame',
        animationResolved: true,
        animationQuality: 0,
        falloffModel: 'inverseSquare',
        windPresent: false,
      }),
      computeBucketKey({
        animationType: 'flame',
        animationResolved: true,
        animationQuality: 0,
        falloffModel: 'foundry',
        windPresent: true,
      }),
    ]).size === 4
  );
  ok(
    'a missing animationQuality defaults to the same key as an explicit 0',
    computeBucketKey({
      animationType: 'flame',
      animationResolved: true,
      falloffModel: 'foundry',
      windPresent: false,
    }) ===
      computeBucketKey({
        animationType: 'flame',
        animationResolved: true,
        animationQuality: 0,
        falloffModel: 'foundry',
        windPresent: false,
      })
  );
  ok(
    'no animation at all (animationResolved false, animationType null) — the plain-Foundry-light common case — produces a stable key',
    computeBucketKey({
      animationType: null,
      animationResolved: false,
      animationQuality: 0,
      falloffModel: 'foundry',
      windPresent: false,
    }) === 'none|q0|foundry|noWind'
  );

  // ==========================================================================
  // canBatchLight — admission
  // ==========================================================================
  ok(
    'a plain light with no apertures and a known falloff model is admissible',
    canBatchLight({ apertureCount: 0, falloffModel: 'foundry' })
  );
  ok(
    'an inverseSquare-falloff light with no apertures is admissible too',
    canBatchLight({ apertureCount: 0, falloffModel: 'inverseSquare' })
  );
  ok(
    'ANY aperture count above zero is inadmissible, unconditionally',
    !canBatchLight({ apertureCount: 1, falloffModel: 'foundry' }) &&
      !canBatchLight({ apertureCount: 4, falloffModel: 'foundry' })
  );
  ok(
    'an unrecognized falloffModel string is inadmissible — a closed list, not a negative check',
    !canBatchLight({ apertureCount: 0, falloffModel: 'somethingNew' })
  );
  ok(
    'a missing apertureCount is treated as 0 (admissible if the falloff model is known)',
    canBatchLight({ falloffModel: 'foundry' })
  );
  ok(
    'BATCH_FALLOFF_MODELS is exactly the two models this codebase actually produces',
    BATCH_FALLOFF_MODELS.length === 2 &&
      BATCH_FALLOFF_MODELS.includes('foundry') &&
      BATCH_FALLOFF_MODELS.includes('inverseSquare')
  );

  // ==========================================================================
  // isColorationEligible — §3.1's coloration membership
  // ==========================================================================
  ok('a coloured light is coloration-eligible', isColorationEligible({ hasColor: true, forceDefaultColor: false }));
  ok(
    'a colourless light with forceDefaultColor is STILL coloration-eligible',
    isColorationEligible({ hasColor: false, forceDefaultColor: true })
  );
  ok(
    'a colourless, non-forceDefaultColor light is NOT coloration-eligible',
    !isColorationEligible({ hasColor: false, forceDefaultColor: false })
  );
  ok('missing fields read as false, never throw', !isColorationEligible({}));

  // ==========================================================================
  // describeBucketVertexBuffers — §3.3's 8-buffer arithmetic, as code
  // ==========================================================================
  const illumFull = describeBucketVertexBuffers({ channel: 'illumination', animated: true, windPresent: true });
  ok(
    'the fully-loaded illumination layout is EXACTLY 8 buffers — the design doc´s own claim, checked live',
    illumFull.count === 8
  );
  ok(
    '8 buffers is still within the real pipeline limit (ok:true) — it sits AT the edge, not over it',
    illumFull.ok === true && MAX_VERTEX_BUFFERS_PER_PIPELINE === 8
  );
  const illumPlain = describeBucketVertexBuffers({ channel: 'illumination', animated: false, windPresent: false });
  ok(
    'a plain (unanimated, no-wind) illumination bucket needs only the 6 always-present buffers',
    illumPlain.count === 6 && illumPlain.ok === true
  );
  const colorFull = describeBucketVertexBuffers({ channel: 'coloration', animated: true, windPresent: true });
  ok(
    'the fully-loaded coloration layout is 6 buffers — fewer fields than illumination (no background/dim/bright triple)',
    colorFull.count === 6 && colorFull.ok === true
  );
  ok(
    'every described layout starts with position + aLocalUnit, in that order',
    illumFull.buffers[0] === 'position' && illumFull.buffers[1] === 'aLocalUnit'
  );
  ok(
    'animated-only adds exactly one buffer (aAnim) over the plain layout',
    describeBucketVertexBuffers({ channel: 'illumination', animated: true, windPresent: false }).count ===
      illumPlain.count + 1
  );
  ok(
    'wind-only adds exactly one buffer (aWind) over the plain layout',
    describeBucketVertexBuffers({ channel: 'illumination', animated: false, windPresent: true }).count ===
      illumPlain.count + 1
  );

  // ==========================================================================
  // createBucket — the span allocator
  // ==========================================================================
  {
    const bucket = createBucket();
    const r1 = bucket.reconcile([
      { sourceId: 'a', vertexCount: 10 },
      { sourceId: 'b', vertexCount: 5 },
    ]);
    ok('first reconcile of a fresh bucket is always a rebuild', r1.rebuilt === true);
    ok(
      'first alloc sizes capacity to exactly what was needed, no artificial doubling before any real size is known',
      r1.capacity === 15
    );
    ok(
      'members pack contiguously in the given order',
      r1.spans.get('a').start === 0 &&
        r1.spans.get('a').count === 10 &&
        r1.spans.get('b').start === 10 &&
        r1.spans.get('b').count === 5
    );
    ok('totalVertexCount is the sum of every member', r1.totalVertexCount === 15);

    const r2 = bucket.reconcile([
      { sourceId: 'a', vertexCount: 10 },
      { sourceId: 'b', vertexCount: 5 },
    ]);
    ok(
      'an IDENTICAL member list (same order, same sizes) reconciles as a no-op',
      r2.rebuilt === false && r2.grew === false
    );
    ok('capacity is unchanged on a no-op reconcile', r2.capacity === 15);

    const r3 = bucket.reconcile([
      { sourceId: 'a', vertexCount: 10 },
      { sourceId: 'b', vertexCount: 5 },
      { sourceId: 'c', vertexCount: 8 },
    ]);
    ok('adding a member forces a rebuild', r3.rebuilt === true);
    ok(
      'capacity DOUBLES (not just grows to exactly what is needed) once it must grow past its first allocation',
      r3.capacity === 30 && r3.grew === true
    );
    ok(
      'the new member is appended after the existing ones, still contiguous',
      r3.spans.get('c').start === 15 && r3.spans.get('c').count === 8
    );

    const r4 = bucket.reconcile([{ sourceId: 'a', vertexCount: 10 }]);
    ok('removing members forces a rebuild', r4.rebuilt === true);
    ok(
      'capacity NEVER shrinks — grow-only, matching point-light-pool.js´s own device-lost-fix precedent',
      r4.capacity === 30 && r4.grew === false
    );
    ok(
      'the sole remaining member repacks to start at 0',
      r4.spans.get('a').start === 0 && r4.spans.get('a').count === 10
    );

    const r5 = bucket.reconcile([{ sourceId: 'a', vertexCount: 12 }]);
    ok(
      'the SAME member with a DIFFERENT vertexCount (a re-triangulated shape) forces a rebuild even though membership itself did not change',
      r5.rebuilt === true
    );

    const r6 = bucket.reconcile([
      { sourceId: 'x', vertexCount: 10 },
      { sourceId: 'a', vertexCount: 12 },
    ]);
    ok(
      'the same TWO members in a DIFFERENT order forces a rebuild — span identity depends on order, not just set membership',
      r6.rebuilt === true
    );
  }
  {
    const bucket = createBucket();
    const neverTouched = bucket.reconcile([]);
    ok(
      'reconciling a bucket that NEVER had members, with an empty list, is a no-op — nothing to build either way',
      neverTouched.rebuilt === false && neverTouched.totalVertexCount === 0
    );
    bucket.reconcile([{ sourceId: 'a', vertexCount: 10 }]);
    const everyoneLeft = bucket.reconcile([]);
    ok(
      'EVERY MEMBER LEAVING (non-empty to empty) IS a real rebuild, not a no-op holdover of the old spans',
      everyoneLeft.rebuilt === true && everyoneLeft.totalVertexCount === 0
    );
    const again = bucket.reconcile([]);
    ok('reconciling empty twice in a row is a no-op the second time', again.rebuilt === false);
  }

  // ==========================================================================
  // createBucketRegistry — keyed bucket collection
  // ==========================================================================
  {
    const registry = createBucketRegistry();
    const b1 = registry.getOrCreateBucket('k1');
    const b1Again = registry.getOrCreateBucket('k1');
    ok('the SAME key returns the SAME bucket instance (state persists across frames)', b1 === b1Again);
    const b2 = registry.getOrCreateBucket('k2');
    ok('different keys get independent buckets', b1 !== b2);
    b1.reconcile([{ sourceId: 'a', vertexCount: 5 }]);
    b2.reconcile([{ sourceId: 'z', vertexCount: 9 }]);
    ok(
      'two buckets never share span state',
      b1.reconcile([{ sourceId: 'a', vertexCount: 5 }]).totalVertexCount === 5 &&
        b2.reconcile([{ sourceId: 'z', vertexCount: 9 }]).totalVertexCount === 9
    );
    ok('keys() enumerates every created bucket', [...registry.keys()].sort().join(',') === 'k1,k2');
    registry.deleteBucket('k1');
    ok(
      'deleteBucket removes it from enumeration (an emptied bucket key — e.g. an animation type nobody uses this frame — does not accumulate forever)',
      [...registry.keys()].join(',') === 'k2'
    );
  }

  // ==========================================================================
  // partitionLightsForBatching
  // ==========================================================================
  {
    const plain = (id, extra = {}) => ({
      sourceId: id,
      animationType: null,
      animationResolved: false,
      animationQuality: 0,
      falloffModel: 'foundry',
      windPresent: false,
      apertureCount: 0,
      hasColor: true,
      vertexCount: 6,
      ...extra,
    });
    const lights = [
      plain('a'),
      plain('b'),
      plain('c', {
        animationType: 'candleFlicker',
        animationResolved: true,
        falloffModel: 'inverseSquare',
        windPresent: true,
      }),
      plain('d', { hasColor: false }), // batchable, but NOT coloration-eligible
      plain('e', { apertureCount: 2 }), // inadmissible
      plain('f', { falloffModel: 'weird' }), // inadmissible
    ];
    const { illumMembers, colorMembers, excluded } = partitionLightsForBatching(lights);

    ok(
      'two plain lights sharing every key dimension land in the SAME illumination bucket',
      illumMembers.get('none|q0|foundry|noWind').length === 3
    ); // a, b, d — d is batchable, just not coloration-eligible
    ok('a differently-keyed light gets its own bucket', illumMembers.size === 2);
    ok(
      'excluded lights (aperture-lit, unknown falloff) are reported, not silently dropped',
      excluded.length === 2 && excluded.some((l) => l.sourceId === 'e') && excluded.some((l) => l.sourceId === 'f')
    );
    ok(
      'a colourless, non-forceDefaultColor light is admitted to its illumination bucket but excluded from coloration',
      colorMembers.get('none|q0|foundry|noWind').length === 2
    ); // a, b — not d
    ok(
      'every excluded light is untouched (not mutated) — same object identity as the input',
      excluded.every((l) => lights.includes(l))
    );
  }
}
