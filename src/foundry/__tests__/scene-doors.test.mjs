/**
 * scene-doors.test.mjs — `deriveDoorSnapshot` + `normalizeDoorAnimationType`
 * (pure), plus the no-Foundry guard clauses of `readSceneDoors`/
 * `watchDoorGraphics`. The live reads touch `canvas.scene.walls` / `Hooks` and
 * are browser-verified, same posture as every other `read*`/watch here — but
 * Node genuinely has neither global, so those guards are exercised for real.
 */
import { deriveDoorSnapshot, normalizeDoorAnimationType, readSceneDoors, watchDoorGraphics } from '../scene-doors.js';
import { DOOR_ANIMATION_TYPES } from '../../effects/door-graphics-render.js';

/** A minimal renderable-door fixture: a door with an animation texture. */
function doorWall(overrides = {}) {
  return {
    wallId: 'w1',
    c: [100, 100, 200, 100],
    door: 1, // DOOR
    ds: 0, // CLOSED
    animation: {
      type: 'swing',
      texture: 'doors/oak.webp',
      double: false,
      direction: 1,
      duration: 750,
      flip: false,
      strength: 1,
    },
    textureGridSize: 200,
    ...overrides,
  };
}

export function run(t) {
  const { ok } = t;

  // ── normalizeDoorAnimationType — Foundry's "unknown → swing" fallback ──────
  for (const type of Object.keys(DOOR_ANIMATION_TYPES)) {
    ok(`'${type}' is a recognized animation type (kept as-is)`, normalizeDoorAnimationType(type) === type);
  }
  ok('an unknown type falls back to swing (never renders nothing)', normalizeDoorAnimationType('teleport') === 'swing');
  ok(
    "the legacy 'sliding' alias is NOT special-cased — it falls back to swing like Foundry",
    normalizeDoorAnimationType('sliding') === 'swing'
  );
  ok('case + whitespace are tolerated', normalizeDoorAnimationType('  SWING ') === 'swing');
  ok(
    'a non-string falls back to swing',
    normalizeDoorAnimationType(null) === 'swing' && normalizeDoorAnimationType(7) === 'swing'
  );

  // ── deriveDoorSnapshot — what is (and is not) a renderable door ────────────
  {
    const s = deriveDoorSnapshot(doorWall());
    ok('a textured door yields a snapshot', s !== null);
    ok('endpoints are unpacked from c', s.x1 === 100 && s.y1 === 100 && s.x2 === 200 && s.y2 === 100);
    ok('open state is derived from ds (CLOSED → false)', s.ds === 0 && s.open === false);
    ok('the animation config is normalized', s.animation.type === 'swing' && s.animation.texture === 'doors/oak.webp');
  }

  ok('an OPEN door reads open:true', deriveDoorSnapshot(doorWall({ ds: 1 }))?.open === true);
  ok(
    'a LOCKED door is a valid (closed-looking) door, open:false',
    deriveDoorSnapshot(doorWall({ ds: 2 }))?.open === false
  );

  // Skips (return null): not a door, no texture, bad endpoints, no id.
  ok('a plain wall (door NONE) is not a door graphic', deriveDoorSnapshot(doorWall({ door: 0 })) === null);
  ok(
    'a door with NO animation texture is skipped (keeps Foundry’s control icon)',
    deriveDoorSnapshot(doorWall({ animation: { type: 'swing' } })) === null
  );
  ok(
    'an empty-string texture is treated as no texture',
    deriveDoorSnapshot(doorWall({ animation: { type: 'swing', texture: '' } })) === null
  );
  ok(
    'malformed endpoints are skipped',
    deriveDoorSnapshot(doorWall({ c: [1, 2, 3] })) === null &&
      deriveDoorSnapshot(doorWall({ c: [1, 2, 3, NaN] })) === null
  );
  ok('a door with no id is skipped (no stable mesh key)', deriveDoorSnapshot(doorWall({ wallId: null })) === null);
  ok(
    'null/garbage input is safe (returns null, never throws)',
    deriveDoorSnapshot(null) === null && deriveDoorSnapshot(42) === null
  );

  // Schema defaults fill in missing animation fields (matches a real WallDocument).
  {
    const s = deriveDoorSnapshot({
      wallId: 'w2',
      c: [0, 0, 100, 0],
      door: 1,
      ds: 0,
      animation: { type: 'swing', texture: 'd.webp' },
    });
    ok('missing direction → schema default 1', s.animation.direction === 1);
    ok('missing double → false', s.animation.double === false);
    ok('missing duration → schema default 750', s.animation.duration === 750);
    ok('missing strength → schema default 1', s.animation.strength === 1);
    ok('missing textureGridSize → CONFIG default 200 (not 100)', s.textureGridSize === 200);
  }

  // Field coercion honesty: direction is a strict {-1,1} choice; strength clamps to [0,2].
  ok(
    'direction −1 is kept',
    deriveDoorSnapshot(doorWall({ animation: { ...doorWall().animation, direction: -1 } }))?.animation.direction === -1
  );
  ok(
    'a bogus direction (e.g. 3) reads as the schema default 1',
    deriveDoorSnapshot(doorWall({ animation: { ...doorWall().animation, direction: 3 } }))?.animation.direction === 1
  );
  ok(
    'strength above 2 clamps to 2',
    deriveDoorSnapshot(doorWall({ animation: { ...doorWall().animation, strength: 9 } }))?.animation.strength === 2
  );
  ok(
    'negative strength clamps to 0',
    deriveDoorSnapshot(doorWall({ animation: { ...doorWall().animation, strength: -3 } }))?.animation.strength === 0
  );
  ok(
    'an unknown animation type is normalized to swing in the snapshot',
    deriveDoorSnapshot(doorWall({ animation: { ...doorWall().animation, type: 'zoom' } }))?.animation.type === 'swing'
  );

  // ── readSceneDoors — no-canvas guard exercised for real ───────────────────
  {
    const r = readSceneDoors();
    ok(
      'no canvas (Node) → empty door list, source default, never throws',
      Array.isArray(r.doors) && r.doors.length === 0 && r.source === 'default'
    );
    ok('the reason names what is missing', typeof r.reason === 'string' && r.reason.length > 0);
    ok('a levelId argument is also safe with no canvas', readSceneDoors('Level.abc').doors.length === 0);
  }

  // ── watchDoorGraphics — no-Hooks guard exercised for real ─────────────────
  {
    const w = watchDoorGraphics(() => {});
    ok('no Hooks global (Node) → registered:false, never throws', w.registered === false);
    ok('the reason names what is missing', typeof w.reason === 'string' && w.reason.length > 0);
    ok('a missing/undefined callback is also safe', watchDoorGraphics().registered === false);
  }
}
