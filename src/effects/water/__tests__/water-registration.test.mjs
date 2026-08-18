/**
 * water-registration.test.mjs — the ONE production wiring site for U6's
 * read-tracking proxy (docs/holy/UI-Testament.md §9). `param-read-health.
 * test.mjs` proves the generic module; this proves the actual seam: reading
 * a param off `getRenderState().params` marks it read, reading the same
 * param off `getReadout().params` (the UI card's own accessor) does NOT,
 * and `tint` — an own, shadowed property on the returned object, never
 * itself proxied — still counts as read.
 */
import { createEffectRegistry } from '../../registry.js';
import { createWaterRegistration } from '../water-registration.js';
import { WATER_PARAMS } from '../water.js';
import { getParamHealth, resetParamReadTracking } from '../../../diag/param-read-health.js';

function makeFakes() {
  return {
    effectRegistry: createEffectRegistry(),
    deriveEffectLayers: () => ({ profile: 'standard' }),
    readSetting: () => undefined,
    writeSetting: async () => undefined,
    moduleId: 'map-shine-advanced',
    effectEnableKey: (id, scope) => `${id}.${scope}.enabled`,
    log: { error: () => {} },
  };
}

export function run(t) {
  const { ok } = t;

  // ---- getRenderState() is the tracked read path ----------------------------
  {
    resetParamReadTracking('water');
    const water = createWaterRegistration(makeFakes());
    water.reapply(); // populate `readout` from a real cascade resolve

    const before = getParamHealth('water', WATER_PARAMS);
    ok(
      'before any getRenderState() read, water starts at 0 read (or whatever a prior test left — reset above)',
      before.read === 0
    );

    const state = water.getRenderState();
    void state.params.depth;
    void state.params.foam;

    // 3, not 2: getRenderState() ALWAYS touches `tint` internally to decode
    // it (see water-registration.js's own comment on why), on top of the
    // two keys this test explicitly reads.
    const after = getParamHealth('water', WATER_PARAMS);
    ok(
      'reading .depth and .foam off getRenderState().params marks those two, plus tint (decoded internally)',
      after.read === 3
    );
    ok('depth is not orphaned', !after.orphaned.includes('depth'));
    ok('foam is not orphaned', !after.orphaned.includes('foam'));
    ok(
      'tint is not orphaned (decoded on every getRenderState() call, whether or not a caller reads it)',
      !after.orphaned.includes('tint')
    );
    ok('an untouched param (e.g. chop) is still orphaned', after.orphaned.includes('chop'));
  }

  // ---- getReadout() (the UI card's OWN accessor) is NOT tracked -------------
  {
    resetParamReadTracking('water');
    const water = createWaterRegistration(makeFakes());
    water.reapply();

    // Simulate the FOH/ROH card's own getValue: (id) => readLive().params?.[id]
    void water.getReadout().params?.opacity;
    void water.getReadout().params?.sunGlint;

    const health = getParamHealth('water', WATER_PARAMS);
    ok(
      'reading params off getReadout() (UI display) does not mark them read — only getRenderState() does',
      health.read === 0
    );
  }

  // ---- tint: an own, shadowed property — still counts as read ---------------
  {
    resetParamReadTracking('water');
    const water = createWaterRegistration(makeFakes());
    water.reapply();
    water.getRenderState(); // tint is touched internally to decode it, even with no external read

    const health = getParamHealth('water', WATER_PARAMS);
    ok(
      'tint counts as read purely from getRenderState() decoding it — it is never left permanently orphaned',
      !health.orphaned.includes('tint')
    );
  }

  // ---- reads accumulate across multiple frames (multiple getRenderState calls) --
  {
    resetParamReadTracking('water');
    const water = createWaterRegistration(makeFakes());
    water.reapply();

    void water.getRenderState().params.depth; // frame 1 (+ tint, touched internally)
    void water.getRenderState().params.pollution; // frame 2 — a fresh call, fresh wrap (+ tint again, no-op in the Set)

    const health = getParamHealth('water', WATER_PARAMS);
    ok(
      'reads from separate getRenderState() calls (separate frames) accumulate: depth, pollution, tint',
      health.read === 3
    );
  }
}
