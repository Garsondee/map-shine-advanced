/**
 * Node verification for the particle system contract.
 *
 * The engine does not exist yet, but a DECLARATION is data — so its rules can be
 * proven today, months before a pixel renders. Every rejection below is a V2
 * corpse the schema refuses to let back in.
 */
import { validateParticleSystem, EMITTER_SHAPES, BEHAVIORS, SPAWN_KINDS } from '../particle-system-schema.js';
import { NotBuiltError } from '../../../core/not-built.js';
import { registerParticleSystem, buildParticlePass, stepParticles } from '../particle-engine.js';

/** A minimal VALID declaration — rain, roughly. */
const validRain = () => ({
  id: 'weather.rain',
  visualWeight: 0.6,
  emitter: { shape: 'cone', gate: 'outdoors' },
  behaviors: [{ type: 'applyForce' }, { type: 'turbulenceField' }],
  spawn: { kind: 'area' },
  reads: ['res:windField', 'buf:scene.attr'],
  tiers: [{ n: 0 }, { n: 1 }, { n: 2 }],
  params: {},
});

export function run(t) {
  // ---- the engine is a locked door that TEACHES ----------------------------
  {
    let err;
    try {
      registerParticleSystem(validRain());
    } catch (e) {
      err = e;
    }
    t.ok('registerParticleSystem throws NotBuiltError', err instanceof NotBuiltError);
    t.ok('the error cites its governing doc', /Particles\.md/.test(err.message));
    t.ok('the error says what to do instead', /verify-structure|declaration/i.test(err.message));
    t.throws('buildParticlePass throws', () => buildParticlePass({}), 'NOT BUILT');
    t.throws('stepParticles throws', () => stepParticles(0.016), 'NOT BUILT');
  }

  // ---- the happy path ------------------------------------------------------
  {
    const r = validateParticleSystem(validRain());
    t.ok('a well-formed declaration validates', r.ok === true && r.errors.length === 0);
  }

  // ---- id must be namespaced ----------------------------------------------
  {
    const d = validRain();
    d.id = 'rain';
    t.ok('a bare id is rejected', !validateParticleSystem(d).ok);
  }

  // ---- behaviors are DATA, from the known vocabulary -----------------------
  {
    const d = validRain();
    d.behaviors = [{ type: 'summonCthulhu' }];
    const r = validateParticleSystem(d);
    t.ok('an unknown behavior is rejected', !r.ok);
    t.ok(
      'and the error lists the real vocabulary',
      r.errors.some((e) => e.includes('turbulenceField'))
    );
  }
  {
    const d = validRain();
    d.behaviors = 'a string, not an array';
    t.ok('behaviors-as-non-array is rejected (a system is data, not code)', !validateParticleSystem(d).ok);
  }

  // ---- reads: the contract's whole point -----------------------------------
  {
    const d = validRain();
    d.reads = ['scene.attr']; // missing the vt:/buf:/res: namespace
    t.ok('an un-namespaced read is rejected', !validateParticleSystem(d).ok);
  }
  {
    // THE knot-dissolving rule: you may name a resource, NEVER another effect.
    const d = validRain();
    d.reads = ['res:lightingEffect'];
    const r = validateParticleSystem(d);
    t.ok('naming another effect is rejected', !r.ok);
    t.ok(
      'and the error explains the Lighting<->Fire knot',
      r.errors.some((e) => /glowBucketsByFloor|another effect/i.test(e))
    );
  }

  // ---- spawn: extracted requires an extractor (no GPU readbacks) ------------
  {
    const d = validRain();
    d.spawn = { kind: 'extracted' }; // missing extractor
    const r = validateParticleSystem(d);
    t.ok('extracted spawn without an extractor is rejected', !r.ok);
    t.ok(
      'and the error points at decode-time extraction',
      r.errors.some((e) => /decode|worker/i.test(e))
    );
  }
  {
    const d = validRain();
    d.spawn = { kind: 'extracted', extractor: 'roof-edges' };
    t.ok('extracted spawn WITH an extractor validates', validateParticleSystem(d).ok);
  }

  // ---- tiers are a contiguous ladder ---------------------------------------
  {
    const d = validRain();
    d.tiers = [{ n: 0 }, { n: 2 }]; // gap
    t.ok('a non-contiguous tier ladder is rejected', !validateParticleSystem(d).ok);
  }
  {
    const d = validRain();
    d.tiers = [];
    t.ok('an empty tier ladder is rejected', !validateParticleSystem(d).ok);
  }

  // ---- the vocabularies are frozen (a data contract, not a suggestion) -----
  {
    t.ok('EMITTER_SHAPES is frozen', Object.isFrozen(EMITTER_SHAPES));
    t.ok('BEHAVIORS is frozen', Object.isFrozen(BEHAVIORS));
    t.ok('SPAWN_KINDS is frozen', Object.isFrozen(SPAWN_KINDS));
  }
}
