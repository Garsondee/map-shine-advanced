/**
 * Tests for vt/depth-proxy-material-pool.js.
 *
 * The pool exists to make DEFERRED-S1b's fix real (Testament P-007 addendum);
 * every assertion here is either pinning the SIGNATURE decisions read
 * directly out of `scene-depth.js`/the vendored three source (never assumed),
 * or sabotage-testing the mark-and-sweep lifecycle so a real correctness bug
 * — double-dispose, a leaked entry, a premature eviction of something still
 * in use — fails loudly here instead of live.
 */
import { computeDepthProxyMaterialSignature, createDepthProxyMaterialPool } from '../depth-proxy-material-pool.js';

export function run(t) {
  // ── signature: opaque items share ONE key across different textures ───────
  const texA = { uuid: 'tex-a' };
  const texB = { uuid: 'tex-b' };
  t.ok(
    'signature: two opaque items with DIFFERENT textures share ONE key — ' +
      "buildSceneDepthWriterMaterial's early-return branch never samples tex",
    computeDepthProxyMaterialSignature({ tex: texA, floorIndex: 1, flags: 0, alwaysOpaque: true }) ===
      computeDepthProxyMaterialSignature({ tex: texB, floorIndex: 1, flags: 0, alwaysOpaque: true })
  );
  t.ok(
    'signature: opaque ignores alphaThreshold too (the shader never reads it in that branch)',
    computeDepthProxyMaterialSignature({
      tex: texA,
      floorIndex: 1,
      flags: 0,
      alphaThreshold: 0.75,
      alwaysOpaque: true,
    }) ===
      computeDepthProxyMaterialSignature({
        tex: texA,
        floorIndex: 1,
        flags: 0,
        alphaThreshold: 0.9,
        alwaysOpaque: true,
      })
  );
  t.ok(
    'signature: no-tex (the "always solid" caller) matches the alwaysOpaque shape',
    computeDepthProxyMaterialSignature({ floorIndex: 2, flags: 0 }) ===
      computeDepthProxyMaterialSignature({ tex: texA, floorIndex: 2, flags: 0, alwaysOpaque: true })
  );

  // ── signature: alpha-tested items MUST differentiate by texture ───────────
  t.ok(
    'signature: two alpha-tested items with DIFFERENT textures get DIFFERENT keys — ' +
      'texture(tex) is genuinely sampled, sharing would render the wrong art',
    computeDepthProxyMaterialSignature({ tex: texA, floorIndex: 1, flags: 0, alphaThreshold: 0.75 }) !==
      computeDepthProxyMaterialSignature({ tex: texB, floorIndex: 1, flags: 0, alphaThreshold: 0.75 })
  );
  t.ok(
    'signature: alpha-tested items with the SAME texture+threshold+floor+flags match',
    computeDepthProxyMaterialSignature({ tex: texA, floorIndex: 1, flags: 0, alphaThreshold: 0.75 }) ===
      computeDepthProxyMaterialSignature({ tex: texA, floorIndex: 1, flags: 0, alphaThreshold: 0.75 })
  );
  t.ok(
    'signature: alpha-tested items DO differentiate on threshold — a different discard cutoff is a different graph',
    computeDepthProxyMaterialSignature({ tex: texA, floorIndex: 1, flags: 0, alphaThreshold: 0.75 }) !==
      computeDepthProxyMaterialSignature({ tex: texA, floorIndex: 1, flags: 0, alphaThreshold: 0.5 })
  );

  // ── signature: floorIndex/flags/colorWrite/positionNode all differentiate ──
  t.ok(
    'signature: different floorIndex differentiates',
    computeDepthProxyMaterialSignature({ tex: texA, floorIndex: 1, flags: 0, alphaThreshold: 0.75 }) !==
      computeDepthProxyMaterialSignature({ tex: texA, floorIndex: 2, flags: 0, alphaThreshold: 0.75 })
  );
  t.ok(
    'signature: different flags differentiates',
    computeDepthProxyMaterialSignature({ tex: texA, floorIndex: 1, flags: 0, alphaThreshold: 0.75 }) !==
      computeDepthProxyMaterialSignature({ tex: texA, floorIndex: 1, flags: 5, alphaThreshold: 0.75 })
  );
  t.ok(
    'signature: colorWrite:false (the S1.4 prepass twin) gets a DIFFERENT key than the real proxy — ' +
      'they can never share one material object (colorWrite is material-level state)',
    computeDepthProxyMaterialSignature({
      tex: texA,
      floorIndex: 1,
      flags: 0,
      alphaThreshold: 0.75,
      colorWrite: true,
    }) !==
      computeDepthProxyMaterialSignature({
        tex: texA,
        floorIndex: 1,
        flags: 0,
        alphaThreshold: 0.75,
        colorWrite: false,
      })
  );
  t.ok(
    'signature: a positionNode-bearing call is distinguished from one without',
    computeDepthProxyMaterialSignature({ tex: texA, floorIndex: 1, flags: 0, alphaThreshold: 0.75 }) !==
      computeDepthProxyMaterialSignature({
        tex: texA,
        floorIndex: 1,
        flags: 0,
        alphaThreshold: 0.75,
        positionNode: {},
        variantKey: 'veg:1',
      })
  );

  // ── variantKey: the anti-aliasing contract (2026-08-11) ───────────────────
  // Vegetation canopies now go THROUGH this pool. Each carries its own
  // positionNode animating its OWN item, so presence-only keying would map
  // them all to one shared material and sway every canopy to whichever one
  // built first — a wrong-picture bug visible only on screen. These pin that
  // the aliasing is impossible to express, not merely unlikely.
  t.ok(
    'signature: two canopies with DIFFERENT variantKeys never share a key',
    computeDepthProxyMaterialSignature({
      tex: texA,
      floorIndex: 1,
      flags: 0,
      alphaThreshold: 0.75,
      positionNode: {},
      variantKey: 'veg:1',
    }) !==
      computeDepthProxyMaterialSignature({
        tex: texA,
        floorIndex: 1,
        flags: 0,
        alphaThreshold: 0.75,
        positionNode: {},
        variantKey: 'veg:2',
      })
  );
  t.ok(
    'signature: the SAME canopy re-requested across passes gets the SAME key (the whole point of the fix)',
    computeDepthProxyMaterialSignature({
      tex: texA,
      floorIndex: 1,
      flags: 0,
      alphaThreshold: 0.75,
      positionNode: {},
      variantKey: 'veg:7',
    }) ===
      computeDepthProxyMaterialSignature({
        tex: texA,
        floorIndex: 1,
        flags: 0,
        alphaThreshold: 0.75,
        // A DIFFERENT node object — the caller caches it, but even if it did
        // not, identity of the node must not leak into the key or the pool
        // could never hit.
        positionNode: {},
        variantKey: 'veg:7',
      })
  );
  t.ok(
    'signature: a canopy and its colorWrite:false prepass twin stay distinct even at the same variantKey',
    computeDepthProxyMaterialSignature({
      tex: texA,
      floorIndex: 1,
      flags: 0,
      alphaThreshold: 0.75,
      positionNode: {},
      variantKey: 'veg:1',
    }) !==
      computeDepthProxyMaterialSignature({
        tex: texA,
        floorIndex: 1,
        flags: 0,
        alphaThreshold: 0.75,
        positionNode: {},
        variantKey: 'veg:1',
        colorWrite: false,
      })
  );
  t.ok(
    'signature: variantKey differentiates on the OPAQUE branch too',
    computeDepthProxyMaterialSignature({
      floorIndex: 1,
      flags: 0,
      alwaysOpaque: true,
      positionNode: {},
      variantKey: 'veg:1',
    }) !==
      computeDepthProxyMaterialSignature({
        floorIndex: 1,
        flags: 0,
        alwaysOpaque: true,
        positionNode: {},
        variantKey: 'veg:2',
      })
  );
  {
    // SABOTAGE: a positionNode with no variantKey must THROW, not return a
    // silently-aliasing key. This is the guard that makes the wrong-picture
    // bug unrepresentable.
    let threw = null;
    try {
      computeDepthProxyMaterialSignature({
        tex: texA,
        floorIndex: 1,
        flags: 0,
        alphaThreshold: 0.75,
        positionNode: {},
      });
    } catch (e) {
      threw = e;
    }
    t.ok('signature: a positionNode with no variantKey throws rather than aliasing', threw !== null);
    t.ok('...and the message names the real consequence', threw.message.includes('variantKey'));
  }
  t.ok(
    'signature: a call with NO positionNode still needs no variantKey (tiles are unaffected)',
    typeof computeDepthProxyMaterialSignature({ tex: texA, floorIndex: 1, flags: 0, alphaThreshold: 0.75 }) === 'string'
  );
  t.ok(
    'signature: falls back to tex.id when tex.uuid is absent, never collides with "notex"',
    computeDepthProxyMaterialSignature({ tex: { id: 7 }, floorIndex: 1, flags: 0, alphaThreshold: 0.75 }) !==
      computeDepthProxyMaterialSignature({ floorIndex: 1, flags: 0, alwaysOpaque: true })
  );

  // ── pool: basic hit/miss/build-only-on-miss ────────────────────────────────
  {
    const pool = createDepthProxyMaterialPool();
    let builds = 0;
    pool.beginPass();
    const m1 = pool.get('sig-a', () => {
      builds++;
      return { id: 'material-a' };
    });
    pool.endPass(() => {
      throw new Error('nothing should be disposed — sig-a was requested this pass');
    });

    pool.beginPass();
    const m2 = pool.get('sig-a', () => {
      builds++;
      return { id: 'should-not-build' };
    });
    const { kept, evicted } = pool.endPass(() => {
      throw new Error('nothing should be disposed — sig-a was requested again');
    });

    t.ok('pool: build() called exactly once for a signature requested twice', builds === 1);
    t.ok('pool: the SAME object is returned both times (real caching, not a copy)', m1 === m2);
    t.ok('pool: endPass reports 1 kept, 0 evicted when the signature repeats', kept === 1 && evicted === 0);
    t.ok('pool: stats() tracks one hit, one miss', pool.stats().hits === 1 && pool.stats().misses === 1);
  }

  // ── pool: mark-and-sweep eviction — the core correctness property ─────────
  {
    const pool = createDepthProxyMaterialPool();
    const disposed = [];
    pool.beginPass();
    pool.get('keep-me', () => ({ id: 'keep-me' }));
    pool.get('drop-me', () => ({ id: 'drop-me' }));
    pool.endPass((m) => disposed.push(m.id));
    t.ok('pool: first pass disposes nothing (everything just built is "used")', disposed.length === 0);

    // Pass 2: only 'keep-me' is requested again — 'drop-me' must be evicted.
    disposed.length = 0;
    pool.beginPass();
    pool.get('keep-me', () => {
      throw new Error('keep-me should have been a cache hit, not rebuilt');
    });
    pool.endPass((m) => disposed.push(m.id));
    t.ok(
      'pool: a signature NOT requested this pass gets disposed exactly once',
      disposed.length === 1 && disposed[0] === 'drop-me'
    );
    t.ok('pool: the kept entry survives — pool size is 1 after the sweep', pool.size() === 1);

    // Pass 3: nothing requested at all — the survivor must be evicted too.
    disposed.length = 0;
    pool.beginPass();
    pool.endPass((m) => disposed.push(m.id));
    t.ok(
      'pool: a pass with zero get() calls evicts everything still pooled',
      disposed.length === 1 && disposed[0] === 'keep-me'
    );
    t.ok('pool: pool is empty after a pass that used nothing', pool.size() === 0);
  }

  // ── pool: multiple items sharing ONE signature within a single pass ───────
  // The real caller (rebuildSceneDepthProxies) can have several tiles resolve
  // to the SAME signature (e.g. several opaque tiles on the same floor). The
  // sweep must dedupe correctly — dispose that ONE material once, not once
  // per caller.
  {
    const pool = createDepthProxyMaterialPool();
    pool.beginPass();
    const a = pool.get('shared', () => ({ id: 'shared-material' }));
    const b = pool.get('shared', () => ({ id: 'should-not-happen' }));
    const c = pool.get('shared', () => ({ id: 'should-not-happen-either' }));
    pool.endPass(() => {});
    t.ok('pool: three callers requesting the same signature in one pass all get the SAME object', a === b && b === c);

    // Now stop requesting it — must dispose exactly once, not three times.
    let disposeCount = 0;
    pool.beginPass();
    pool.endPass(() => {
      disposeCount++;
    });
    t.ok(
      'pool: a signature shared by multiple callers is disposed EXACTLY ONCE on eviction, never per-caller',
      disposeCount === 1
    );
  }

  // ── pool: sabotage — get()/endPass() outside a beginPass() bracket throws ──
  {
    const pool = createDepthProxyMaterialPool();
    t.throws(
      'pool: get() before any beginPass() throws rather than silently caching into nothing',
      () => pool.get('x', () => ({})),
      'beginPass'
    );
  }
  {
    const pool = createDepthProxyMaterialPool();
    t.throws('pool: endPass() without a matching beginPass() throws', () => pool.endPass(() => {}), 'beginPass');
  }

  // ── pool: disposeAll — full teardown, independent of pass state ───────────
  {
    const pool = createDepthProxyMaterialPool();
    pool.beginPass();
    pool.get('a', () => ({ id: 'a' }));
    pool.get('b', () => ({ id: 'b' }));
    pool.endPass(() => {});
    const disposed = [];
    pool.disposeAll((m) => disposed.push(m.id));
    t.ok('pool: disposeAll disposes every pooled entry', disposed.length === 2);
    t.ok('pool: disposeAll empties the pool', pool.size() === 0);
    // Must be safe to beginPass()/get()/endPass() again after a full teardown
    // (a scene switch tears down and rebuilds the whole viewer).
    pool.beginPass();
    const fresh = pool.get('a', () => ({ id: 'a-rebuilt' }));
    pool.endPass(() => {});
    t.ok(
      'pool: usable again after disposeAll — a fresh get() actually rebuilds, not a stale hit',
      fresh.id === 'a-rebuilt'
    );
  }

  // ── stats(): lifetime counters survive across passes, for the perf report ──
  {
    const pool = createDepthProxyMaterialPool();
    pool.beginPass();
    pool.get('x', () => ({}));
    pool.endPass(() => {});
    pool.beginPass();
    pool.get('x', () => ({})); // hit
    pool.get('y', () => ({})); // miss
    pool.endPass(() => {});
    const s = pool.stats();
    t.ok('stats: hits accumulate across passes', s.hits === 1);
    t.ok('stats: misses accumulate across passes', s.misses === 2);
    t.ok('stats: size reflects current occupancy, not lifetime', s.size === 2);
  }
}
