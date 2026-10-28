/**
 * Node verification for scene/room-map.js — the room map: walls drawn thick, rooms filled and numbered, indoors vs
 * outdoors, distance to the nearest wall, which way each room looks out, the facing lookup and the shared cache.
 *
 * The fixture is a small house on a 2000×1400 scene (100 px grid): outer walls (400,300)–(1600,1100), a dividing wall
 * at x=1000 with a DOOR in it, a wall at y=700 splitting the east half into a north-east and a south-east room, a
 * closet with no outside wall inside the west room, and one window per outer room — west, east and south.
 */
import {
  buildRoomMap,
  computeRoomMapGridSpec,
  createRoomMapCache,
  rasterizeRoomBarriers,
  labelRooms,
  roomIdAt,
  roomSunFacing,
  roomOutlookAt,
  encodeRoomIdsRgba,
  encodeRoomFieldRgba,
  decodeRoomVecByte,
  ROOM_DIST_PX_PER_UNIT,
  ROOM_EXTERIOR_WALL_WEIGHT,
  ROOM_MAP_MAX_DIM,
} from '../room-map.js';

const SCENE = { x: 0, y: 0, width: 2000, height: 1400 };
const W = (x1, y1, x2, y2, extra = {}) => ({ x1, y1, x2, y2, ...extra });

export function houseWalls() {
  return [
    // outer walls, with the three windows cut into them as their own segments
    W(400, 300, 1600, 300),
    W(1600, 300, 1600, 400),
    W(1600, 400, 1600, 550, { reachWindow: true }),
    W(1600, 550, 1600, 1100),
    W(1600, 1100, 1400, 1100),
    W(1400, 1100, 1200, 1100, { reachWindow: true }),
    W(1200, 1100, 400, 1100),
    W(400, 1100, 400, 800),
    W(400, 800, 400, 600, { reachWindow: true }),
    W(400, 600, 400, 300),
    // the dividing wall, with an OPEN door: a door still divides rooms
    W(1000, 300, 1000, 650),
    W(1000, 650, 1000, 750, { door: 1, ds: 1 }),
    W(1000, 750, 1000, 1100),
    W(1000, 700, 1600, 700),
    // the closet
    W(500, 400, 600, 400),
    W(600, 400, 600, 500),
    W(600, 500, 500, 500),
    W(500, 500, 500, 400),
  ];
}

export function houseMap(extra = {}) {
  const spec = computeRoomMapGridSpec({ sceneRect: SCENE, gridSizePixels: 100 });
  return buildRoomMap({ walls: houseWalls(), spec, ...extra });
}

export function run(t) {
  const { ok } = t;

  // ── the grid ──────────────────────────────────────────────────────────────
  const spec = computeRoomMapGridSpec({ sceneRect: SCENE, gridSizePixels: 100 });
  ok('eight cells per grid square on a small scene', spec.cellSize === 12.5 && spec.cols === 160 && spec.rows === 112);
  const huge = computeRoomMapGridSpec({ sceneRect: { x: 0, y: 0, width: 40000, height: 10000 }, gridSizePixels: 100 });
  ok(
    'a huge scene is capped on its long side',
    huge.cols <= ROOM_MAP_MAX_DIM && huge.cellSize >= 40000 / ROOM_MAP_MAX_DIM
  );

  // ── rooms ─────────────────────────────────────────────────────────────────
  const m = houseMap();
  const outside = roomIdAt(m, 100, 100);
  const west = roomIdAt(m, 750, 800);
  const ne = roomIdAt(m, 1300, 500);
  const se = roomIdAt(m, 1300, 900);
  const closet = roomIdAt(m, 550, 450);
  ok(`five rooms: outside, west, north-east, south-east, closet (got ${m.count})`, m.count === 5);
  ok(
    'every room has its own id',
    new Set([outside, west, ne, se, closet]).size === 5 && [outside, west, ne, se, closet].every((v) => v > 0)
  );
  ok('the open door does NOT merge west with the east rooms', west !== ne && west !== se);
  ok('a wall cell is room 0', roomIdAt(m, 1000, 500) === 0);
  ok('outside (touching the scene edge) is outdoors without a mask', m.outdoor[outside] === 1);
  ok('the rooms are indoors', !m.outdoor[west] && !m.outdoor[ne] && !m.outdoor[se] && !m.outdoor[closet]);
  ok('the corner just outside the window is outdoors', roomIdAt(m, 1700, 470) === outside);

  // ── gaps: a hand-placed gap of a few px is sealed; a doorway-sized hole is not ──
  const gapWalls = (gap) => [
    W(200, 200, 800, 200),
    W(800, 200, 800, 800),
    W(800, 800, 200, 800),
    W(200, 800, 200, 500 + gap),
    W(200, 500, 200, 200),
  ];
  const gspec = computeRoomMapGridSpec({ sceneRect: { x: 0, y: 0, width: 1000, height: 1000 }, gridSizePixels: 100 });
  const sealed = labelRooms(rasterizeRoomBarriers(gapWalls(4), gspec, 10), gspec.cols, gspec.rows);
  const leaky = labelRooms(rasterizeRoomBarriers(gapWalls(60), gspec, 10), gspec.cols, gspec.rows);
  ok(`a 4 px gap between wall ends is sealed (rooms ${sealed.count})`, sealed.count === 2);
  ok(`a 60 px hole lets the room join the outside (rooms ${leaky.count})`, leaky.count === 1);
  const thick = labelRooms(rasterizeRoomBarriers(gapWalls(30), gspec, 40), gspec.cols, gspec.rows);
  ok('a thicker wall seal closes a 30 px gap', thick.count === 2);
  const ghost = labelRooms(
    rasterizeRoomBarriers(
      [...gapWalls(0).slice(0, 2), { ...gapWalls(0)[2], roomBarrier: false }, ...gapWalls(0).slice(3)],
      gspec,
      10
    ),
    gspec.cols,
    gspec.rows
  );
  ok('a wall that stops nothing (roomBarrier:false) does not divide', ghost.count === 1);

  // ── the outdoors mask decides when there is one ────────────────────────────
  // A courtyard (an enclosed square with no roof): without the mask it reads as a room, with it as outdoors.
  const courtWalls = gapWalls(0);
  const cMapNoMask = buildRoomMap({ walls: courtWalls, spec: gspec });
  const og = { spec: { x: 0, y: 0, width: 1000, height: 1000, w: 10, h: 10 }, data: new Uint8Array(100).fill(255) };
  const cMapMask = buildRoomMap({ walls: courtWalls, spec: gspec, outdoors: og });
  const courtId = roomIdAt(cMapNoMask, 500, 500);
  ok('an enclosed square reads indoors with no mask', cMapNoMask.outdoor[courtId] === 0);
  ok('…and outdoors when the _Outdoors mask paints it open', cMapMask.outdoor[roomIdAt(cMapMask, 500, 500)] === 1);

  // ── distance to the nearest wall ──────────────────────────────────────────
  const di = (x, y) => m.distPx[Math.floor(y / spec.cellSize) * spec.cols + Math.floor(x / spec.cellSize)];
  ok(
    `the west room's middle is ~200-300 px from a wall (got ${di(760, 840).toFixed(0)})`,
    di(760, 840) > 190 && di(760, 840) < 300
  );
  ok('a wall cell is 0 px from a wall', di(1000, 500) === 0);
  ok('closer to the wall is nearer', di(1030, 900) < di(1150, 900));

  // ── outlook ───────────────────────────────────────────────────────────────
  const westFace = roomSunFacing(m.exposure, west, -1, 0);
  ok('the west room faces a western sun', westFace.facing > 0.99 && westFace.known === 1);
  ok('…and not an eastern one', roomSunFacing(m.exposure, west, 1, 0).facing === 0);
  ok('the north-east room (east window) faces an eastern sun', roomSunFacing(m.exposure, ne, 1, 0).facing > 0.99);
  ok('the south-east room (south window) faces a southern sun (+y)', roomSunFacing(m.exposure, se, 0, 1).facing > 0.99);
  ok('the south-east room does not face a northern sun', roomSunFacing(m.exposure, se, 0, -1).facing === 0);
  ok('the closet has no outlook (left alone)', roomSunFacing(m.exposure, closet, 1, 0).known === 0);
  ok('outdoors has no outlook', roomSunFacing(m.exposure, outside, 1, 0).known === 0);
  ok('the window rooms count as glazed', m.stats.windowRooms === 3);
  // A room with no window falls back to its outside walls, at reduced weight.
  const blind = buildRoomMap({ walls: houseWalls().map((w) => ({ ...w, reachWindow: false })), spec });
  const blindFace = roomSunFacing(blind.exposure, roomIdAt(blind, 750, 800), -1, 0);
  ok(
    'a windowless room is judged by its outside walls, at reduced weight',
    blindFace.known === ROOM_EXTERIOR_WALL_WEIGHT && blindFace.facing > 0.99
  );

  // ── the per-cell outlook: each cell knows which way ITS nearest windows look, as a vector ──
  const dirAt = (x, y) => roomOutlookAt(m, x, y);
  ok('the west room looks out west', dirAt(700, 800).x < -0.99);
  ok('the north-east room looks out east', dirAt(1300, 500).x > 0.99);
  ok('the south-east room looks out south (+y)', dirAt(1300, 900).y > 0.99);
  const len = (v) => Math.hypot(v.x, v.y);
  ok('the closet and the outdoors have no outlook', len(dirAt(550, 450)) === 0 && len(dirAt(100, 100)) === 0);
  ok(
    'walls carry their room: a wall cell has the id of a room beside it',
    [roomIdAt(m, 1000, 500)].length &&
      m.ids[Math.floor(500 / spec.cellSize) * spec.cols + Math.floor(1000 / spec.cellSize)] > 0
  );
  // Two windows in one room at right angles: each part of the room takes its nearer window's direction, and the
  // corner between them turns smoothly instead of switching on a line.
  const twin = buildRoomMap({
    walls: [
      W(400, 300, 600, 300),
      W(600, 300, 800, 300, { reachWindow: true }),
      W(800, 300, 1600, 300),
      ...houseWalls().slice(1),
    ],
    spec,
  });
  const twinDir = (x, y) => roomOutlookAt(twin, x, y);
  ok('by the north window it looks north', twinDir(700, 360).y < -0.95);
  ok('by the west window it looks west', twinDir(450, 950).x < -0.95);
  let maxJump = 0;
  for (let k = 0; k < 40; k++) {
    const a = twinDir(450 + k * 10, 900 - k * 12.5);
    const b = twinDir(460 + k * 10, 887.5 - k * 12.5);
    maxJump = Math.max(maxJump, Math.hypot(a.x - b.x, a.y - b.y));
  }
  ok(
    `walking from one window to the other the outlook changes smoothly (largest step ${maxJump.toFixed(3)})`,
    maxJump < 0.2
  );
  ok('the outlook never crosses into the next room', roomOutlookAt(twin, 1300, 500).x > 0.99);
  // Two windows facing OPPOSITE ways (the Compound's greenhouse): the vector must shrink through zero between them,
  // never flip on a line — so "faces an eastern sun" (its x) runs smoothly from −1 to +1.
  const opposed = buildRoomMap({
    walls: [
      W(200, 200, 1800, 200),
      W(1800, 200, 1800, 500),
      W(1800, 500, 1800, 700, { reachWindow: true }),
      W(1800, 700, 1800, 1200),
      W(1800, 1200, 200, 1200),
      W(200, 1200, 200, 700),
      W(200, 700, 200, 500, { reachWindow: true }),
      W(200, 500, 200, 200),
    ],
    spec,
  });
  let flip = 0;
  let prev = roomOutlookAt(opposed, 230, 600).x;
  for (let x = 240; x < 1780; x += 10) {
    const v = roomOutlookAt(opposed, x, 600).x;
    flip = Math.max(flip, Math.abs(v - prev));
    prev = v;
  }
  ok(
    `between opposite windows the outlook passes through zero, no flip (largest step ${flip.toFixed(3)})`,
    flip < 0.2 && roomOutlookAt(opposed, 230, 600).x < -0.9 && roomOutlookAt(opposed, 1770, 600).x > 0.9
  );

  // ── the bytes ──────────────────────────────────────────────────────────────
  const ids = encodeRoomIdsRgba(Int32Array.from([0, 3, 300]));
  ok('id bytes: the id splits low/high', ids[4] === 3 && ids[5] === 0 && ids[8] === 300 % 256 && ids[9] === 1);
  const field = encodeRoomFieldRgba(
    Float32Array.from([0, 50, 1000]),
    Float32Array.from([0, -1, 1]),
    Float32Array.from([0, 0.5, -1])
  );
  ok('field bytes: distance in units, clamped', field[4] === 50 / ROOM_DIST_PX_PER_UNIT && field[8] === 255);
  ok(
    'field bytes: the outlook vector round-trips',
    Math.abs(decodeRoomVecByte(field[5]) + 1) < 0.01 &&
      Math.abs(decodeRoomVecByte(field[6]) - 0.5) < 0.01 &&
      Math.abs(decodeRoomVecByte(field[1])) < 0.01
  );

  // ── the cache ─────────────────────────────────────────────────────────────
  let wallVersion = 0;
  let clock = 0;
  let reads = 0;
  const textures = [];
  const cache = createRoomMapCache({
    readWalls: () => {
      reads++;
      return houseWalls();
    },
    getSceneGeometry: () => ({ sceneRect: SCENE, gridSizePixels: 100 }),
    getWallVersion: () => wallVersion,
    createTexture: (data, w, h) => {
      const tex = {
        image: { data, width: w, height: h },
        disposed: false,
        dispose() {
          this.disposed = true;
        },
      };
      textures.push(tex);
      return tex;
    },
    now: () => clock,
    minRebuildMs: 250,
  });
  const e1 = cache.get(0);
  ok(
    'the cache builds on first ask (ids + field)',
    e1 && e1.map.count === 5 && reads === 1 && textures.length === 2 && !!e1.fieldTexture
  );
  ok('…and not again for the same walls', cache.get(0) === e1 && reads === 1);
  wallVersion = 1;
  clock = 100;
  ok('a wall edit inside the rebuild window keeps the old map up', cache.get(0) === e1 && reads === 1);
  clock = 400;
  const e2 = cache.get(0);
  ok(
    '…and rebuilds after it, reusing the texture in place',
    e2 !== e1 &&
      reads === 2 &&
      textures.length === 2 &&
      e2.texture === e1.texture &&
      e2.fieldTexture === e1.fieldTexture
  );
  ok('a new wall thickness rebuilds', (clock = 800) && cache.get(0, { thicknessPx: 20 }) !== e2);
  cache.drop(0);
  ok('dropping a floor disposes its texture', textures[0].disposed && cache.peek(0) === null);
}
