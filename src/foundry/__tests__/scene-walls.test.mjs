/**
 * scene-walls.test.mjs — `deriveWallSolid` (pure) + `watchSceneWallStructure`'s
 * no-Foundry guard clause. `readSceneWallSegments` touches `canvas.scene.walls`
 * live and is browser-verified, same posture as every other `read*` function
 * in this adapter — and `watchSceneWallStructure`'s actual `Hooks.on` wiring
 * is the same "browser-only, verified live" split canvas-lifecycle.test.mjs
 * documents for `registerCanvasTearDownWatchdog`. What Node CAN prove: Node
 * genuinely has no `Hooks` global, so the guard clause is exercised for real,
 * not mocked.
 */
import {
  deriveWallSolid,
  deriveWallBlocksExterior,
  watchSceneWallStructure,
  watchDoorOpenings,
} from '../scene-walls.js';

export function run(t) {
  const { ok } = t;

  // WALL_MOVEMENT_TYPES: NONE=0, NORMAL=20 (verified against common/constants.mjs
  // — move is an alias of the shared EDGE_SENSE_TYPES scale, NOT an independent
  // 0/1 field; a prior version of this file's own source used 1, which was
  // WRONG but harmless since the only comparison is `!== NONE`, never
  // `=== NORMAL`). WALL_DOOR_TYPES.NONE=0, WALL_DOOR_STATES: CLOSED=0/OPEN=1/LOCKED=2.

  ok('an ordinary wall (move blocks, not a door) is solid', deriveWallSolid({ move: 20, door: 0, ds: 0 }));
  ok(
    'a wall authored with move:NONE lets air through (it lets movement through too)',
    !deriveWallSolid({ move: 0, door: 0, ds: 0 })
  );

  // `sight` is DELIBERATELY NOT part of wind-solidity (2026-07-22, author's
  // own correction after a same-day round-trip: "we need to block wind only
  // when a wall blocks movement... transparent glass walls that block
  // movement block wind but not vision"). A sight-transparent window/railing
  // that still blocks MOVEMENT (glass, a solid rail) must stay wind-solid —
  // being see-through says nothing about air permeability. A brief same-day
  // detour required both move AND sight to block, on the wrong theory that
  // "transparent" meant wind-permeable like a fence; reverted, and
  // `deriveWallSolid` doesn't even accept a `sight` argument anymore.
  ok(
    'a sight-transparent wall (a window/railing, sight:NONE) that blocks MOVEMENT is still wind-solid',
    deriveWallSolid({ move: 20, door: 0, ds: 0 }) // sight is not a parameter at all — passing it would be ignored
  );

  ok('a CLOSED door is solid', deriveWallSolid({ move: 20, door: 1, ds: 0 }));
  ok('a LOCKED door is solid', deriveWallSolid({ move: 20, door: 1, ds: 2 }));
  ok('an OPEN door is NOT solid — air passes through', !deriveWallSolid({ move: 20, door: 1, ds: 1 }));
  ok('an OPEN secret door is also NOT solid', !deriveWallSolid({ move: 20, door: 2, ds: 1 }));
  ok('an open door with move:NONE is (redundantly) still not solid', !deriveWallSolid({ move: 0, door: 1, ds: 1 }));

  // Missing fields fall back to the SCHEMA's own defaults (move:NORMAL,
  // door:NONE, ds:CLOSED) — a document that never explicitly set these
  // genuinely reads as an ordinary solid wall, matching a real freshly-
  // created WallDocument, not an arbitrary "assume nothing" choice.
  ok(
    'an empty/malformed fixture reads as an ordinary solid wall (the schema defaults), never throws',
    deriveWallSolid({})
  );
  ok('no argument at all is also safe (never throws)', deriveWallSolid() === true);

  // deriveWallBlocksExterior (2026-07-22, the door-distance penetration
  // falloff) — `move` alone, `door`/`ds` never even accepted as arguments:
  // a door counts as a permanent barrier here REGARDLESS of open/closed
  // state, so the "is this genuinely reachable without crossing ANY door"
  // classification stays stable as doors open and close.
  ok('a plain wall blocks exterior classification, same as deriveWallSolid', deriveWallBlocksExterior({ move: 20 }));
  ok('a move:NONE wall never blocks exterior classification either', !deriveWallBlocksExterior({ move: 0 }));
  ok(
    'a CLOSED door blocks exterior classification (obviously — it is currently a wall)',
    deriveWallBlocksExterior({ move: 20 }) // door/ds are not parameters — a closed door is just move:NORMAL
  );
  ok('missing move falls back to the schema default (blocks), never throws', deriveWallBlocksExterior({}) === true);
  ok('no argument at all is also safe (never throws)', deriveWallBlocksExterior() === true);

  // watchSceneWallStructure — Node has no `Hooks` global at all, so this
  // exercises the real guard clause, not a mock of one.
  const watchResult = watchSceneWallStructure(() => {});
  ok('no Hooks global (Node) -> registered:false, never throws', watchResult.registered === false);
  ok('the reason names what is missing', typeof watchResult.reason === 'string' && watchResult.reason.length > 0);
  const watchResultNoCallback = watchSceneWallStructure();
  ok('a missing/undefined onChange callback is also safe (never throws)', watchResultNoCallback.registered === false);

  // watchDoorOpenings — same no-Hooks-global guard clause, exercised for real.
  const doorWatch = watchDoorOpenings(() => {});
  ok('no Hooks global (Node) -> registered:false, never throws', doorWatch.registered === false);
  ok('the reason names what is missing', typeof doorWatch.reason === 'string' && doorWatch.reason.length > 0);
  ok('a missing/undefined onDoorOpen callback is also safe (never throws)', watchDoorOpenings().registered === false);
}
