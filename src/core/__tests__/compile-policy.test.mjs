/**
 * compile-policy.test.mjs — which pipelines may compile off the GPU's main thread (2026-10-27, epic mmp-fpu).
 *
 * The order of the rules is the contract: a one-shot pass must never be deferred (its first draw is its only
 * draw), a per-frame effect may always be, and an unmarked shader is deferred only when it is so large that the
 * alternative is the crash this exists to prevent.
 */
import {
  HEAVY_PIPELINE_CHARS,
  compilePolicyFor,
  markCompileDeferrable,
  markCompileSyncOnly,
} from '../compile-policy.js';

export function run(t) {
  const { ok } = t;
  const small = 5_000;
  const huge = HEAVY_PIPELINE_CHARS + 1;

  ok('an unmarked, small pipeline compiles as it always did', compilePolicyFor({}, small).mode === 'sync');
  ok(
    '...whatever the material is, even none at all',
    compilePolicyFor(null, small).mode === 'sync' && compilePolicyFor(undefined, undefined).mode === 'sync'
  );

  const flagged = markCompileDeferrable({}, 'candle flame');
  ok(
    'a per-frame effect may be deferred, however small',
    compilePolicyFor(flagged, small).mode === 'async' && compilePolicyFor(flagged, small).reason === 'flagged'
  );
  ok(
    'markCompileDeferrable returns the material and keeps the reason for the log',
    flagged.userData.msaDeferCompile === 'candle flame'
  );

  const oneShot = markCompileSyncOnly({}, 'sun shadow bake');
  ok(
    'a one-shot pass is never deferred...',
    compilePolicyFor(oneShot, small).mode === 'sync' && compilePolicyFor(oneShot, small).reason === 'sync-only'
  );
  ok(
    '...however large its shader — skipping its only draw would lose the result',
    compilePolicyFor(oneShot, huge * 3).mode === 'sync'
  );
  const both = markCompileDeferrable(markCompileSyncOnly({}));
  ok(
    'sync-only wins over deferrable (the safe reading of a contradiction)',
    compilePolicyFor(both, small).mode === 'sync'
  );

  ok(
    'an unmarked shader at the heavy threshold is deferred, and says why',
    compilePolicyFor({}, HEAVY_PIPELINE_CHARS).mode === 'async' &&
      compilePolicyFor({}, HEAVY_PIPELINE_CHARS).reason === 'heavy'
  );
  ok('one character below the threshold it is not', compilePolicyFor({}, HEAVY_PIPELINE_CHARS - 1).mode === 'sync');
  ok(
    'a non-finite size never defers anything by itself',
    compilePolicyFor({}, NaN).mode === 'sync' && compilePolicyFor({}, Infinity).mode === 'sync'
  );

  const reused = markCompileDeferrable({ userData: { keep: 1 } });
  ok(
    'marking preserves whatever userData the material already had',
    reused.userData.keep === 1 && reused.userData.msaDeferCompile === true
  );
  ok(
    'marking nothing is harmless',
    markCompileDeferrable(null) === null && markCompileSyncOnly(undefined) === undefined
  );
}
