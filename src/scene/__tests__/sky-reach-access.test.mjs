/**
 * sky-reach-access.test.mjs — THE SKY-REACH SERVICE (author's own instruction,
 * 2026-07-24: *"repairing sky reach because it needs to be an API / service for
 * other things like rain drops when we get to that stage as well as being a
 * producer for this shadow"*).
 *
 * The assertions that matter are about PROVENANCE, not arithmetic. This whole
 * service exists because the last time two consumers each reached for a raw mask
 * product themselves, they picked different ones (`skyReach` vs raw `outdoors`,
 * 2026-07-21, both fixed by hand) — and because "no data" and "no cover" being
 * the same number is what let `coverAbove ≡ 0` survive an engine retirement
 * unnoticed. So: does it distinguish unknown from open, does it route a missing
 * required mask to the handler instead of throwing at a caller who cannot fix
 * it, and does the covered threshold live in exactly one place.
 */

import { createSkyReachAccess, COVERED_THRESHOLD } from '../sky-reach-access.js';

/** A minimal stand-in for the mask authority — enough surface for the service,
 * nothing more, so this test cannot accidentally become a test of the authority. */
function fakeAuthority({ sky = 1, caster = 0, missing = [], throwOn = null } = {}) {
  const completeness = {
    missingItemIds: missing,
    expectedItemIds: ['a', 'b'],
    overheadItemIds: ['balcony'],
    skyReachItemIds: ['roof'],
    ceilingElevation: 10,
    bottomElevation: 0,
    outdoorsSource: 'authored',
  };
  return {
    casterHeightScalePx: 2048,
    getProductsVersion: () => 7,
    sampleWorld(id) {
      if (throwOn && id === throwOn) throw new Error('RequiredMaskMissing: outdoors');
      return id === 'skyReach' ? sky : caster;
    },
    getDerived(id) {
      if (throwOn && id === throwOn) throw new Error('RequiredMaskMissing: outdoors');
      return {
        grid: { spec: { w: 4, h: 4 }, data: new Uint8Array(16) },
        channels: id === 'casterHeight' ? { building: {}, overhead: {}, skyReach: {} } : null,
        completeness,
        version: 7,
        // `mask-derive.js` attaches this to EVERY product, regardless of `id`
        // — the fake must too, or a wrapper that drops it would pass anyway.
        outdoorsLedger: [{ order: 0, owner: 'level:fake:background', contentMeanByte: 220 }],
      };
    },
  };
}

/** @param {{ok:(name:string, cond:boolean)=>void, throws:Function}} t */
export function run(t) {
  // --- the three questions ------------------------------------------------
  {
    const open = createSkyReachAccess({ maskAuthority: fakeAuthority({ sky: 1 }) });
    t.ok('open sky reads 1', open.openSkyAt(0, 10, 10) === 1);
    t.ok('and is not "covered"', open.isCovered(0, 10, 10) === false);

    const under = createSkyReachAccess({ maskAuthority: fakeAuthority({ sky: 0 }) });
    t.ok('under a bridge reads 0', under.openSkyAt(0, 10, 10) === 0);
    t.ok('and IS covered', under.isCovered(0, 10, 10) === true);

    t.ok('the covered threshold is a declared constant, not five inline 0.5s', COVERED_THRESHOLD === 0.5);
  }

  // --- the height, which `skyReach` alone could never answer ---------------
  {
    // A caster reading half the scale = half of 2048 px above this floor. This
    // is the number a raindrop needs (how high is the deck I am falling
    // behind?) and the number the shadow march needs, and it is the reason the
    // caster height field exists at all rather than a second boolean.
    const svc = createSkyReachAccess({ maskAuthority: fakeAuthority({ caster: 0.5 }) });
    const h = svc.coverHeightAt(0, 10, 10);
    t.ok('cover height comes back in WORLD PX, not as a 0..1 mask value', Math.abs(h.heightPx - 1024) < 1);
    t.ok('and is marked KNOWN when every contributing item has been ingested', h.known === true);
  }

  // --- ⚠️ ABSENCE IS NOT ZERO ---------------------------------------------
  {
    const starved = createSkyReachAccess({ maskAuthority: fakeAuthority({ caster: 0, missing: ['upperFloor'] }) });
    const h = starved.coverHeightAt(0, 10, 10);
    t.ok(
      'a floor whose art has not arrived reports known:false — NOT "nothing above you"',
      h.heightPx === 0 && h.known === false
    );
    t.ok('and the status block names how many items are missing', starved.status(0).missingItemCount === 1);
  }

  // --- a missing REQUIRED mask degrades loudly, at the right layer ---------
  {
    const seen = [];
    const degraded = createSkyReachAccess({
      maskAuthority: fakeAuthority({ throwOn: 'skyReach' }),
      onRequiredMaskMissing: (err, context) => seen.push(context),
    });
    t.ok('the read returns the safe value instead of throwing at the caller', degraded.openSkyAt(0, 1, 1) === 1);
    t.ok('and the handler was told WHICH question failed', seen.includes('openSkyAt'));

    // Without a handler the throw propagates — the right default for a NEW
    // consumer, which should find out loudly rather than inherit a silent 1.
    const bare = createSkyReachAccess({ maskAuthority: fakeAuthority({ throwOn: 'skyReach' }) });
    t.throws(
      'with no handler the required-mask error still reaches the caller',
      () => bare.openSkyAt(0, 1, 1),
      'RequiredMaskMissing'
    );
  }

  // --- the field, and the version a cache keys on -------------------------
  {
    const svc = createSkyReachAccess({ maskAuthority: fakeAuthority() });
    const field = svc.heightField(0);
    t.ok('the height field serves its three unmerged producer channels', !!field.channels?.skyReach);
    t.ok('and the px scale a byte represents', field.scalePx === 2048);
    t.ok('the service exposes a version a consumer can cache against', svc.version === 7);
    // ⚠️ REGRESSION GUARD (2026-08-02): this wrapper reshapes `getDerived`'s
    // product into a narrower object, and `outdoorsLedger` — attached to
    // EVERY product unconditionally by `mask-derive.js` — was silently left
    // off the reshape. `boot.js#getCasterHeightField` reads it on every
    // floor that reaches this (non-degraded) path, so the sun-shadows
    // report's `casterField.outdoorsSources` read `null` for every floor
    // regardless of how many real sources actually fed it.
    t.ok(
      'heightField forwards outdoorsLedger — the field a wrapper reshape previously dropped',
      Array.isArray(field.outdoorsLedger) && field.outdoorsLedger[0]?.owner === 'level:fake:background'
    );
    t.ok(
      'the status block carries the floor’s elevation band',
      svc.status(0).bottomElevation === 0 && svc.status(0).ceilingElevation === 10
    );
  }

  // --- construction refuses to be built over nothing -----------------------
  t.throws(
    'a service without an authority throws at construction',
    () => createSkyReachAccess({}),
    'maskAuthority is required'
  );
}
