/**
 * Node verification for graph/passes.js — the pass list as an executable plan.
 *
 * Three kinds of proof:
 *   1. The declared graph is VALID (every pipe visible, one producer per file,
 *      nothing consumed before it exists).
 *   2. The V2 absorption accounting holds — the 48→~12 collapse cannot silently
 *      drop an effect family.
 *   3. THE NEGATIVE PROOF: V2's real diseases, declared as passes, are REJECTED
 *      by the validator — the mess is not merely discouraged, it is unwritable.
 */
import { PASSES, STAGES, validatePassGraph } from '../passes.js';

export function run(t) {
  // ---- 1. the real graph validates -----------------------------------------
  {
    const r = validatePassGraph(PASSES);
    t.ok(`THE PASS LIST IS A VALID GRAPH (${r.errors.join(' | ') || 'no errors'})`, r.ok);
    t.ok('a sane number of passes (10-14, the promised ~10-12)', PASSES.length >= 10 && PASSES.length <= 14);
    t.ok(
      'every stage used is declared',
      PASSES.every((p) => STAGES.includes(p.stage))
    );
    t.ok(
      'every pass has an intent note',
      PASSES.every((p) => p.note && p.note.length > 40)
    );
    t.ok(
      'status is honest vocabulary only',
      PASSES.every((p) => ['live', 'seam', 'future'].includes(p.status))
    );
  }

  // ---- 2. the absorption accounting ----------------------------------------
  {
    const absorbed = new Set(PASSES.flatMap((p) => p.absorbs));
    t.ok(`the V2 collapse is accounted for (${absorbed.size} distinct systems absorbed, >= 45)`, absorbed.size >= 45);
    // The named giants from the audits must each have a home:
    for (const giant of [
      'FloorCompositor',
      'WeatherParticles(sim)',
      'LightingEffectV2',
      'ShadowManagerV2',
      'WaterEffectV2',
      'SpecularEffectV2',
      'ColorCorrectionEffectV2',
      'GpuSceneMaskCompositor',
    ]) {
      t.ok(`'${giant}' has a home in the pass list`, absorbed.has(giant));
    }
    // And the lift is DELETED, not absorbed — the wrong noun leaves no heir.
    t.ok(
      'DynamicLightShadowLift is marked DELETED, not carried forward',
      PASSES.some((p) => p.absorbs.some((a) => a.includes('DynamicLightShadowLift(DELETED')))
    );
  }

  // ---- 3. load-bearing wiring facts -----------------------------------------
  {
    const byId = new Map(PASSES.map((p) => [p.id, p]));
    t.ok(
      'exactly ONE pass creates buf:scene.color (the one-producer rule, on the main buffer)',
      PASSES.filter((p) => p.creates.includes('buf:scene.color')).length === 1
    );
    t.ok(
      'light accumulation READS res:vis — light-linking is wired, not implied',
      byId.get('light.accumulate').reads.includes('res:vis')
    );
    t.ok(
      'the visibility pass never touches the composed image (shadow modulates LIGHT, never color)',
      ![...byId.get('light.visibility').reads, ...byId.get('light.visibility').modifies].includes('buf:scene.color')
    );
    t.ok('the env snapshot is created before anything reads it', PASSES[0].creates.includes('res:env'));
    t.ok(
      'present reads only the final buffer (nothing sneaks past the grade)',
      byId.get('present.composite').reads.length === 1 && byId.get('present.composite').reads[0] === 'buf:final'
    );
  }

  // ---- 4. THE NEGATIVE PROOF — V2's diseases are unwritable -----------------
  {
    // V2's ACTUAL knot: Lighting read Fire's glow; Fire read Lighting's params.
    // Declared honestly as two passes, each consuming the other's output:
    const knot = [
      {
        id: 'fire',
        stage: 'frame',
        kind: 'gpu',
        status: 'future',
        owns: 'the V2 knot, half A',
        creates: ['res:fireGlow'],
        reads: ['res:lightingParams'],
        modifies: [],
        absorbs: ['x'],
        note: 'Fire reads Lighting params through the global — 45+ chars of note here.',
      },
      {
        id: 'lighting',
        stage: 'frame',
        kind: 'gpu',
        status: 'future',
        owns: 'the V2 knot, half B',
        creates: ['res:lightingParams'],
        reads: ['res:fireGlow'],
        modifies: [],
        absorbs: ['x'],
        note: 'Lighting reads Fire private glow buckets — 45+ chars of note here.',
      },
    ];
    const r = validatePassGraph(knot);
    t.ok('THE LIGHTING↔FIRE KNOT IS UNWRITABLE (cycle rejected as read-before-create)', !r.ok);
    t.ok(
      '...and the error NAMES the missing pipe',
      r.errors.some((e) => e.includes("reads 'res:lightingParams'"))
    );
  }
  {
    // V2's 70 private RTs = many writers of overlapping buffers. Two creators:
    const twoOwners = [
      {
        id: 'a',
        stage: 'frame',
        kind: 'gpu',
        status: 'future',
        owns: 'two-owners test case A',
        creates: ['buf:shadow'],
        reads: [],
        modifies: [],
        absorbs: ['x'],
        note: 'first creator of the shadow buffer — this one is legitimate here.',
      },
      {
        id: 'b',
        stage: 'sims',
        kind: 'gpu',
        status: 'future',
        owns: 'two-owners test case B',
        creates: ['buf:shadow'],
        reads: [],
        modifies: [],
        absorbs: ['x'],
        note: 'second creator of the same buffer — the disease being tested for.',
      },
    ];
    const r = validatePassGraph(twoOwners);
    t.ok('TWO OWNERS OF ONE BUFFER IS UNWRITABLE', !r.ok && r.errors.some((e) => e.includes('ONE producer')));
  }
  {
    // Sneaky mutation: modifying a buffer you also created (hides ordering).
    const selfModify = [
      {
        id: 'a',
        stage: 'frame',
        kind: 'gpu',
        status: 'future',
        owns: 'self-modify test case',
        creates: ['buf:x'],
        reads: [],
        modifies: ['buf:x'],
        absorbs: ['x'],
        note: 'creates and modifies the same buffer in one declaration — ambiguous.',
      },
    ];
    t.ok('CREATE+MODIFY IN ONE PASS IS UNWRITABLE', !validatePassGraph(selfModify).ok);
  }
  {
    // Stage disorder: a post pass declared before geometry.
    const disorder = [
      {
        id: 'a',
        stage: 'post',
        kind: 'gpu',
        status: 'future',
        owns: 'stage disorder test case',
        creates: ['buf:x'],
        reads: [],
        modifies: [],
        absorbs: ['x'],
        note: 'declared in post, followed by a geometry pass — order violation.',
      },
      {
        id: 'b',
        stage: 'geometry',
        kind: 'gpu',
        status: 'future',
        owns: 'stage disorder test case',
        creates: ['buf:y'],
        reads: [],
        modifies: [],
        absorbs: ['x'],
        note: 'geometry after post is a frame-order violation and must fail.',
      },
    ];
    t.ok('STAGE DISORDER IS UNWRITABLE', !validatePassGraph(disorder).ok);
  }
  {
    // The global-bus ghost: a read with no namespace (i.e. "I'll just grab it").
    const ghost = [
      {
        id: 'a',
        stage: 'frame',
        kind: 'gpu',
        status: 'future',
        owns: 'namespace test case',
        creates: ['window.MapShine'],
        reads: [],
        modifies: [],
        absorbs: ['x'],
        note: 'a resource named like a global — must be rejected by the grammar.',
      },
    ];
    t.ok('UN-NAMESPACED RESOURCES ARE UNWRITABLE (no global-bus ghosts)', !validatePassGraph(ghost).ok);
  }
}
