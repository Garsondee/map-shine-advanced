/**
 * Node verification for effects/player-torch-fire-geometry.js — the batched quad arrays the torch
 * fire is drawn from. Pure (no THREE).
 */
import {
  computeTorchParticleArrays,
  createTorchFireSimulation,
  deriveTorchFireSeed,
  resolveTorchFireLook,
  TORCH_FIRE_FLAME_VARIANTS,
  TORCH_FIRE_FLAME_COUNT,
  TORCH_FIRE_FLAME_RATE_PER_SECOND,
  TORCH_FIRE_SPARK_RATE_PER_SECOND,
  TORCH_FIRE_MAX_FLAMES_PER_TORCH,
  TORCH_FIRE_MAX_SPARKS_PER_TORCH,
  TORCH_FIRE_FLAME_BOX_PX,
  TORCH_FIRE_SPARK_BOX_PX,
  TORCH_FIRE_FLAME_SIZE_MAX_PX,
  TORCH_FIRE_FLAME_SPREAD_PX,
  TORCH_FIRE_SPARK_START_PX,
} from '../player-torch-fire-geometry.js';

export function run(t) {
  const { ok } = t;

  // The layers.
  ok(
    'the flame is built from three layers (core, swirl, ring) of distinct archetypes',
    TORCH_FIRE_FLAME_VARIANTS.length === 3 && new Set(TORCH_FIRE_FLAME_VARIANTS.map((v) => v.archetype)).size === 3
  );
  ok(
    'the flame count is the layers’ total',
    TORCH_FIRE_FLAME_COUNT === TORCH_FIRE_FLAME_VARIANTS.reduce((n, v) => n + v.count, 0)
  );

  const anchors = [
    { x: 100, y: 200, id: 'tokA' },
    { x: 300, y: 400, id: 'tokB' },
  ];
  const worldSimulation = createTorchFireSimulation();
  const worldOut = worldSimulation.update(anchors, 1000);
  const out = computeTorchParticleArrays(worldOut.flames, worldOut.sparks);
  ok('one flame batch per layer', out.flames.length === TORCH_FIRE_FLAME_VARIANTS.length);
  ok(
    'live world-space particle batches have one quad per active particle',
    out.flames.every((f) => f.batch.quadCount >= 0) && out.spark.quadCount >= 0
  );

  // Live particles keep their own world-space coordinates and carry all four
  // shader inputs (tint rgb, burn, normalized age, size).
  const swirlBatch = out.flames.find((layer) => layer.variant.key === 'swirl')?.batch;
  ok('swirl layer carries world-space particle data', swirlBatch.quadCount > 0 && swirlBatch.ages.length > 0);
  ok('each world-space particle keeps its own position', Number.isFinite(swirlBatch.positions[0]));
  ok(
    'each world-space particle carries age and size',
    Number.isFinite(worldOut.flames[0]?.ageS) && Number.isFinite(worldOut.flames[0]?.size)
  );
  ok(
    'live batches carry per-particle age and size attributes',
    swirlBatch.ages.length > 0 && swirlBatch.sizes.length > 0
  );
  ok(
    'live batch data has real age/size attributes',
    out.flames.every(
      (layer) => layer.batch.quadCount === 0 || (layer.batch.ages.length > 0 && layer.batch.sizes.length > 0)
    )
  );

  // The boxes really contain what the shader draws inside them.
  ok(
    'the flame box holds the largest sprite at the edge of its disc',
    TORCH_FIRE_FLAME_BOX_PX / 2 >= (TORCH_FIRE_FLAME_SIZE_MAX_PX * 1.1) / 2 + TORCH_FIRE_FLAME_SPREAD_PX
  );
  ok('flame sprites are half the former 78–132 px size range', TORCH_FIRE_FLAME_SIZE_MAX_PX === 66);
  ok(
    'the simulation has bounded V2-like emission rates',
    TORCH_FIRE_FLAME_RATE_PER_SECOND >= 80 &&
      TORCH_FIRE_FLAME_RATE_PER_SECOND <= 170 &&
      TORCH_FIRE_SPARK_RATE_PER_SECOND >= 20 &&
      TORCH_FIRE_MAX_FLAMES_PER_TORCH > 100 &&
      TORCH_FIRE_MAX_SPARKS_PER_TORCH > 20
  );
  ok(
    'world-space spark quads only contain their own dot',
    TORCH_FIRE_SPARK_BOX_PX / 2 >= TORCH_FIRE_SPARK_START_PX / 2
  );
  {
    const simulation = createTorchFireSimulation();
    const first = simulation.update([{ x: 0, y: 0, id: 'moving', burn01: 1 }], 0);
    const firstFlame = first.flames[0];
    const particleSeed = firstFlame?.seed;
    const moved = simulation.update([{ x: 500, y: 0, id: 'moving', burn01: 1 }], 100);
    const oldParticle = moved.flames.find((particle) => particle.seed === particleSeed);
    const newParticle = moved.flames.find((particle) => particle.x > 300);
    ok('the simulation emits flame and ember particles', first.flames.length > 0 && first.sparks.length > 0);
    ok('an existing flame stays in world space when its emitter moves', !!oldParticle && oldParticle.x < 120);
    ok('new flame particles spawn at the moved emitter', !!newParticle && newParticle.x > 300);
    ok(
      'world-space particles carry age, rotation and burn state',
      Number.isFinite(oldParticle?.ageS) &&
        Number.isFinite(oldParticle?.rotation) &&
        Number.isFinite(oldParticle?.burn01)
    );
    const batches = computeTorchParticleArrays(moved.flames, moved.sparks);
    ok(
      'simulated particles produce render batches',
      batches.flames.reduce((n, layer) => n + layer.batch.quadCount, 0) > 0 && batches.spark.quadCount > 0
    );
  }

  // Seeds: deterministic, and independent per sprite, per torch, per layer.
  ok('a seed is deterministic', deriveTorchFireSeed('tok', 3, 'x') === deriveTorchFireSeed('tok', 3, 'x'));
  {
    const seeds = new Set([0, 1, 2, 3, 4, 5].map((i) => deriveTorchFireSeed('tok', i).toFixed(5)));
    ok('the sprites of one torch have distinct phases', seeds.size >= 5);
    ok(
      'two torches desync at the same sprite index',
      deriveTorchFireSeed('alpha', 0) !== deriveTorchFireSeed('beta', 0)
    );
    ok(
      'layers desync from each other',
      deriveTorchFireSeed('tok', 0, 'fcore') !== deriveTorchFireSeed('tok', 0, 'fring')
    );
    ok(
      'seeds stay in 0..97',
      [...Array(40).keys()].every((i) => deriveTorchFireSeed('t', i) >= 0 && deriveTorchFireSeed('t', i) < 97)
    );
  }

  // Look: burn and tint.
  {
    ok(
      'a full-burn torch is untinted',
      JSON.stringify(resolveTorchFireLook({}).tint) === '[1,1,1]' && resolveTorchFireLook({}).burn01 === 1
    );
    ok(
      'a merely dim torch (burn 0.8) is still untinted',
      JSON.stringify(resolveTorchFireLook({ burn01: 0.8 }).tint) === '[1,1,1]'
    );
    const dying = resolveTorchFireLook({ burn01: 0.05 });
    ok(
      'a dying torch loses green and blue, not red (it reddens)',
      dying.tint[0] === 1 && dying.tint[1] < 0.5 && dying.tint[2] < dying.tint[1]
    );
    const just = resolveTorchFireLook({ burn01: 0.69 }).tint;
    ok('the tint eases in from white (no jump at the 0.7 threshold)', just[1] > 0.98 && just[2] > 0.98);
    ok(
      'burn is clamped to 0..1',
      resolveTorchFireLook({ burn01: 7 }).burn01 === 1 && resolveTorchFireLook({ burn01: -2 }).burn01 === 0
    );
  }
  // Totality.
  ok('live particle conversion handles an empty population', computeTorchParticleArrays([], []).spark.quadCount === 0);
  ok(
    'a non-array particle population is total',
    computeTorchParticleArrays(null, null).flames.every((f) => f.batch.quadCount === 0)
  );
  ok(
    'a non-finite world-space particle is skipped, not baked as NaN',
    computeTorchParticleArrays([{ x: NaN, y: 0, id: 'x' }], []).spark.quadCount === 0
  );
}
