/**
 * THE DEBUG ISOLATION VIEWS — pinned, because they silently stopped isolating.
 *
 * 2026-08-02: the "Shadows — building only" / "overhead only" / "sky-reach
 * only" views carried an `include: {building, overhead, skyReach}` flag that
 * gated what `deriveFloorProducts` WRITES. That was correct for the retired
 * march model, whose caster texture packed `coverBuilding`/`coverSkyReach`
 * directly. The layer-smear packing reads NEITHER — walls come from
 * `1 − outdoors`, sky-reach from `coverAbove` — so the flag stopped removing
 * anything and all three views rendered the identical picture as "all".
 *
 * Nothing failed. Nothing logged. The author used those views for hours to
 * localise a real artifact and got the same image every time
 * (`feedback_instruments_must_not_lie`). Isolation now multiplies the per-layer
 * STRENGTHS instead — the same mechanism Shader Lab's `layerIsolate` uses — and
 * these tests pin the property that actually matters: **each isolating view
 * must select a DIFFERENT, non-empty subset of the layers.** A future repack
 * that breaks the link again fails here instead of in the author's eyes.
 */
import { SUN_SHADOW_DEBUG_VIEWS, sunShadowDebugLayers, sunShadowDebugPaints } from '../sun-shadow-debug.js';
import { SHADOW_LAYER_COUNT, LAYER_OVERHEAD } from '../layer-smear.js';

export function run(t) {
  const { ok } = t;

  // ── THE DEFAULT IS "EVERYTHING ON" ───────────────────────────────────
  {
    const all = sunShadowDebugLayers('shadow-all');
    ok(
      'the "all" view multiplies every layer by 1 — a provable no-op, not a subtle re-weighting',
      all.length === SHADOW_LAYER_COUNT && all.every((v) => v === 1)
    );
    ok(
      'an unknown / "off" view is also a provable no-op',
      sunShadowDebugLayers('off').every((v) => v === 1) && sunShadowDebugLayers('no-such-view').every((v) => v === 1)
    );
  }

  // ── 🔒 EACH ISOLATION SELECTS A DIFFERENT, NON-EMPTY SUBSET ──────────
  // This is THE regression guard. The broken version failed it in the most
  // embarrassing possible way: every view returned the same thing.
  {
    const ids = ['shadow-building', 'shadow-overhead', 'shadow-skyreach'];
    const vectors = ids.map((id) => sunShadowDebugLayers(id));

    ok(
      'every isolating view keeps at least one layer — none is a blank screen',
      vectors.every((v) => v.some((s) => s > 0))
    );
    ok(
      'every isolating view REMOVES at least one layer — none is secretly "all"',
      vectors.every((v) => v.some((s) => s === 0))
    );

    const keys = vectors.map((v) => v.join(','));
    ok(
      `the three isolations are mutually DISTINCT (${keys.join(' | ')}) — the exact property the ` +
        'broken include-based version violated, silently',
      new Set(keys).size === ids.length
    );

    // And they must not overlap: a layer belongs to exactly one isolation, or
    // "only" is a lie in a second, quieter way.
    for (let layer = 0; layer < SHADOW_LAYER_COUNT; layer++) {
      const owners = vectors.filter((v) => v[layer] > 0).length;
      ok(`layer ${layer} is claimed by at most ONE "… only" view (claimed by ${owners})`, owners <= 1);
    }

    // Between them the three must cover every layer that "all" turns on, or
    // some part of the picture can never be isolated and diagnosed.
    const covered = new Array(SHADOW_LAYER_COUNT).fill(0);
    for (const v of vectors) for (let i = 0; i < SHADOW_LAYER_COUNT; i++) if (v[i] > 0) covered[i] = 1;
    ok(
      'between them the three isolations cover EVERY layer — nothing is undiagnosable',
      covered.every((c) => c === 1)
    );
  }

  // ── THE NAMES MEAN WHAT THE PACKING MEANS ────────────────────────────
  // A label claiming "overhead" for a different channel is the same class of
  // lie this file exists to stop, one level up from the vector arithmetic.
  {
    ok(
      'the overhead view selects exactly LAYER_OVERHEAD, the packing`s own G channel',
      sunShadowDebugLayers('shadow-overhead').every((s, i) => (i === LAYER_OVERHEAD ? s === 1 : s === 0))
    );
    ok(
      'the wall view selects layer 0 alone (the `1 − outdoors` R channel)',
      sunShadowDebugLayers('shadow-building').every((s, i) => (i === 0 ? s === 1 : s === 0))
    );
    ok(
      'the sky-reach view selects layers 2 AND 3 — B and A are one merged idea in this packing',
      sunShadowDebugLayers('shadow-skyreach').join(',') === '0,0,1,1'
    );
  }

  // ── THE ISOLATING VIEWS STILL ACTUALLY PAINT ─────────────────────────
  // Selecting a layer is useless if the view does not draw; `sunShadowDebugPaints`
  // is what puts the debug quad on screen at all.
  {
    ok(
      'every isolating view still paints over the scene',
      ['shadow-all', 'shadow-building', 'shadow-overhead', 'shadow-skyreach'].every((id) => sunShadowDebugPaints(id))
    );
    ok('"off" paints nothing', sunShadowDebugPaints('off') === false);
  }

  // ── NO VIEW CARRIES THE RETIRED `include` FLAG ───────────────────────
  // If one comes back, it will silently do nothing (the derivation no longer
  // reads it for these channels) — which is precisely how this broke.
  {
    ok(
      'no debug view still carries the retired derivation-gating `include` flag',
      SUN_SHADOW_DEBUG_VIEWS.every((v) => v.include === undefined)
    );
  }
}
