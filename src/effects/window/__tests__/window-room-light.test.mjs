/**
 * window-room-light.test.mjs — SUN & ROOMS: the sun's throw, the per-window split into a moving beam and a static
 * share, the room-bound smear (CPU twin), and that the TSL port constructs inside the window material, with every
 * texture node reachable by `setRoomMap`.
 *
 * The house (rebuilt here, not imported across zones): a west room (400..1000, 300..1100) with a west window, a
 * north-east room with an east window, a south-east room with a south window. `NORTH` adds a north window to the west
 * room, for the window-by-window split.
 */
import * as THREE from '../../../../src/vendor/three/three.webgpu.js';
import {
  resolveRoomLook,
  resolveRoomSunFrame,
  evalRoomLightPixel,
  createWindowRoomLight,
  roomTapT,
  roomTapJitter,
  windowSunFacing,
  WINDOW_ROOM_TAPS,
  WINDOW_ROOM_GAP_SAMPLES,
  WINDOW_ROOM_DEFAULTS,
  WINDOW_ROOM_DIST_PX_PER_UNIT,
} from '../window-room-light.js';
import { buildWindowSurfaceMaterial } from '../window-render.js';
import { WINDOW_PARAMS, WINDOW_DEBUG_CHANNELS } from '../window.js';
import { marchDirectionToSun } from '../../lighting/sun-occlusion.js';
import { buildRoomMap, computeRoomMapGridSpec, ROOM_DIST_PX_PER_UNIT } from '../../../scene/index.js';

const W = (x1, y1, x2, y2, extra = {}) => ({ x1, y1, x2, y2, ...extra });
const WALLS = [
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
  W(1000, 300, 1000, 1100),
  W(1000, 700, 1600, 700),
];
const NORTH = [
  W(400, 300, 600, 300),
  W(600, 300, 800, 300, { reachWindow: true }),
  W(800, 300, 1600, 300),
  ...WALLS.slice(1),
];

function stubTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

const box = (x0, x1, y0, y1) => (x, y) => (x > x0 && x < x1 && y > y0 && y < y1 ? [1, 1, 1] : [0, 0, 0]);

export function run(t) {
  const { ok } = t;
  const look = resolveRoomLook({});

  // ── the dials ────────────────────────────────────────────────────────────
  ok(
    'defaults resolve from an empty params object',
    look.drift === WINDOW_ROOM_DEFAULTS.drift && look.smear === WINDOW_ROOM_DEFAULTS.smear
  );
  const paramDefaults = {
    sunDrift: 'drift',
    sunThrowHeightPx: 'throwHeightPx',
    sunMaxDriftPx: 'maxDriftPx',
    sunSmear: 'smear',
    sunSmearKeep: 'smearKeep',
    roomWallFadePx: 'wallFadePx',
    roomWallFadeStrength: 'wallFadeStrength',
    sunSideBoost: 'sideBoost',
    sunSideDim: 'sideDim',
    sunLowDeg: 'lowSunDeg',
    roomWallThicknessPx: 'wallThicknessPx',
  };
  ok(
    "every 'Sun & rooms' param exists, sits in that section, and its default matches WINDOW_ROOM_DEFAULTS",
    Object.entries(paramDefaults).every(
      ([p, d]) => WINDOW_PARAMS[p]?.category === 'Sun & rooms' && WINDOW_PARAMS[p].default === WINDOW_ROOM_DEFAULTS[d]
    )
  );
  ok('the distance unit is pinned to the room map', WINDOW_ROOM_DIST_PX_PER_UNIT === ROOM_DIST_PX_PER_UNIT);

  // ── the sun's throw ───────────────────────────────────────────────────────
  const noon = resolveRoomSunFrame({ elevationDeg: 60, azimuthDeg: 180, dayFactor01: 1 }, look);
  const dawn = resolveRoomSunFrame({ elevationDeg: 12, azimuthDeg: 90, dayFactor01: 1 }, look);
  const horizon = resolveRoomSunFrame({ elevationDeg: 1, azimuthDeg: 90, dayFactor01: 1 }, look);
  const night = resolveRoomSunFrame({ elevationDeg: -20, azimuthDeg: 0, dayFactor01: 0 }, look);
  ok(`noon throws short (${noon.throwLenPx.toFixed(0)} px)`, noon.throwLenPx > 60 && noon.throwLenPx < 80);
  ok(`dawn throws long (${dawn.throwLenPx.toFixed(0)} px)`, dawn.throwLenPx > 300);
  ok('a horizon sun is capped at the longest drift', Math.abs(horizon.throwLenPx - look.maxDriftPx) < 1e-6);
  ok(
    'at night nothing moves and nothing faces the sun',
    night.throwLenPx === 0 && night.lowSun01 === 0 && night.toSunX === 0 && night.toSunY === 0
  );
  const toSun = marchDirectionToSun(90);
  ok(
    'the beam lands AWAY from the sun',
    Math.abs(dawn.throwX + toSun.x * dawn.throwLenPx) < 1e-6 && Math.abs(dawn.throwY + toSun.y * dawn.throwLenPx) < 1e-6
  );
  ok(
    'the low-sun weight is full on the horizon and gone high up',
    horizon.lowSun01 > 0.99 &&
      resolveRoomSunFrame({ elevationDeg: 70, azimuthDeg: 0, dayFactor01: 1 }, look).lowSun01 === 0
  );
  ok(
    'the drift dial scales the throw, 0 = off',
    resolveRoomSunFrame({ elevationDeg: 12, azimuthDeg: 90 }, { ...look, drift: 0 }).throwLenPx === 0
  );
  ok(
    'jittered taps stay inside the smear, from (1 − smear) to the full drift',
    roomTapT(0, 0.6, -0.5) === 0.4 && Math.abs(roomTapT(WINDOW_ROOM_TAPS - 1, 0.6, 0.5) - 1) < 1e-9
  );
  let jMin = 1;
  let jMax = -1;
  for (let x = 0; x < 64; x++) {
    for (let y = 0; y < 64; y++) {
      const j = roomTapJitter(x, y);
      jMin = Math.min(jMin, j);
      jMax = Math.max(jMax, j);
    }
  }
  ok(
    `the jitter covers −0.5..0.5 (${jMin.toFixed(2)}..${jMax.toFixed(2)})`,
    jMin >= -0.5 && jMax < 0.5 && jMax - jMin > 0.9
  );
  ok('the jitter is fixed to world px', roomTapJitter(10.2, 7.9) === roomTapJitter(10.7, 7.1));
  ok(
    'a window faces a sun straight out of it, not one behind it',
    windowSunFacing({ x: -1, y: 0 }, { toSunX: -1, toSunY: 0 }) === 1 &&
      windowSunFacing({ x: -1, y: 0 }, { toSunX: 1, toSunY: 0 }) === 0 &&
      windowSunFacing(null, { toSunX: 1, toSunY: 0 }) === 0
  );

  // ── the CPU twin over real room maps ──────────────────────────────────────
  const spec = computeRoomMapGridSpec({ sceneRect: { x: 0, y: 0, width: 2000, height: 1400 }, gridSizePixels: 100 });
  // As the shader reads it: the id from the cell under the point, the distance and outlook bilinearly filtered.
  const roomFn = (map) => (x, y) => {
    const clampC = (c) => Math.min(spec.cols - 1, Math.max(0, c));
    const clampR = (r) => Math.min(spec.rows - 1, Math.max(0, r));
    const i =
      clampR(Math.floor((y - spec.minY) / spec.cellSize)) * spec.cols +
      clampC(Math.floor((x - spec.minX) / spec.cellSize));
    const fx = (x - spec.minX) / spec.cellSize - 0.5;
    const fy = (y - spec.minY) / spec.cellSize - 0.5;
    const c0 = Math.floor(fx);
    const r0 = Math.floor(fy);
    const tx = fx - c0;
    const ty = fy - r0;
    const bil = (arr) => {
      const g = (c, r) => arr[clampR(r) * spec.cols + clampC(c)];
      return (
        (g(c0, r0) * (1 - tx) + g(c0 + 1, r0) * tx) * (1 - ty) +
        (g(c0, r0 + 1) * (1 - tx) + g(c0 + 1, r0 + 1) * tx) * ty
      );
    };
    return { id: map.ids[i], distPx: bil(map.distPx), vec: { x: bil(map.outlook.x), y: bil(map.outlook.y) } };
  };
  const room = roomFn(buildRoomMap({ walls: WALLS, spec }));
  const roomN = roomFn(buildRoomMap({ walls: NORTH, spec }));
  const westFrame = resolveRoomSunFrame({ elevationDeg: 10, azimuthDeg: 270, dayFactor01: 1 }, look);
  ok('fixture: the west sun is to the west, the beam runs east', westFrame.toSunX < -0.99 && westFrame.throwX > 0);
  const px = (x, y, c, frame = westFrame, r = room, lk = look) =>
    evalRoomLightPixel({ x, y, sampleCookie: c, room: r, frame, look: lk });
  const still = { throwX: 0, throwY: 0, throwLenPx: 0, toSunX: 0, toSunY: 0, lowSun01: 0 };
  const westCookie = box(410, 560, 600, 800);
  ok(
    'no sun to face: the light is exactly as painted',
    px(480, 700, westCookie, still).rgb[0] === 1 && px(700, 700, westCookie, still).rgb[0] === 0
  );
  ok('the west room looks out west', room(700, 700).vec.x < -0.99);
  ok(
    'a low western sun streams the west window east across the room',
    px(800, 700, westCookie).rgb[0] > 0.3 && px(800, 700, westCookie, still).rgb[0] === 0
  );
  ok('…brighter than it was painted (sunny side)', px(800, 700, westCookie).rgb[0] > 1);
  ok('…and the painted spot itself empties', px(450, 700, westCookie).rgb[0] < 0.2);

  // WINDOW BY WINDOW: the north window in the same room faces away from a western sun — it stays and dims.
  const northCookie = box(600, 800, 310, 450);
  ok('fixture: the north window region looks out north', roomN(700, 360).vec.y < -0.9);
  const nHere = px(700, 380, northCookie, westFrame, roomN);
  const dimmed = 1 - westFrame.lowSun01 * look.sideDim;
  ok(
    `the north window's light stays put and dims (${nHere.rgb[0].toFixed(2)} vs ${dimmed.toFixed(2)})`,
    Math.abs(nHere.rgb[0] - dimmed) < 0.05
  );
  ok('…and does not slide east', px(900, 380, northCookie, westFrame, roomN).rgb[0] < 0.05);
  ok(
    "the dials reach it: 'Shaded side dim' 0 leaves it whole",
    px(700, 380, northCookie, westFrame, roomN, { ...look, sideDim: 0 }).rgb[0] > 0.95
  );

  // ROOM-BOUND: light by the dividing wall, streaming east, never lights the room beyond it.
  const byWall = box(850, 990, 600, 800);
  // Exactly zero on the open floor of the next room; inside a wall's own drawn band (under the wall art — at a T
  // junction a wall cell can carry the far room's id) the wall fade holds it to nothing visible.
  let leak = 0;
  let inWall = 0;
  for (let x = 1005; x < 1400; x += 5) {
    for (let y = 600; y < 800; y += 10) {
      const v = px(x, y, byWall).rgb[0];
      if (room(x, y).distPx < spec.cellSize) inWall = Math.max(inWall, v);
      else leak = Math.max(leak, v);
    }
  }
  ok(
    `no light crosses the wall into the next room (max ${leak}; inside the wall band ${inWall.toFixed(4)})`,
    leak === 0 && inWall < 0.002
  );
  // A north-eastern sun throws the east window's beam south-west, into the wall between the two east rooms.
  const neSun = resolveRoomSunFrame({ elevationDeg: 10, azimuthDeg: 60, dayFactor01: 1 }, look);
  const eastCookie = box(1440, 1590, 400, 560);
  ok(
    'fixture: the east window beams south-west under a north-eastern sun',
    px(1300, 640, eastCookie, neSun).rgb[0] > 0.2
  );
  let below = 0;
  for (let x = 1005; x < 1600; x += 7)
    for (let y = 715; y < 1095; y += 7) below = Math.max(below, px(x, y, eastCookie, neSun).rgb[0]);
  ok(`no light crosses into the south-east room (max ${below})`, below === 0);
  // SOFT: approaching the dividing wall, the beam fades rather than stopping.
  const midFrame = resolveRoomSunFrame({ elevationDeg: 40, azimuthDeg: 270, dayFactor01: 1 }, look);
  const xs = [940, 960, 975, 985];
  const drifting = xs.map((x) => px(x, 700, byWall, midFrame).rgb[0]);
  ok(
    `the beam thins out toward the wall instead of stopping (${drifting.map((v) => v.toFixed(2)).join(', ')})`,
    // (The twin reads distance per cell; the shader filters it, so on screen this is a smooth ramp.)
    // (The jitter moves each pixel's taps by up to half a spacing, so neighbouring values wobble by a few percent.)
    drifting[0] > 0.3 && drifting[0] > drifting[2] && drifting[3] < 0.35 && drifting[0] - drifting[3] > 0.3
  );

  // LINE OF SIGHT (the Compound's greenhouse doorway, 2026-10-28): a wall STUB inside one room. Behind it the beam is
  // shaded; past its end the beam carries on — and the shadow's edge is soft, not stepped.
  const stubRoom = roomFn(buildRoomMap({ walls: [...WALLS, W(700, 300, 700, 650)], spec }));
  const wide = box(410, 680, 350, 1050);
  const behind = px(850, 450, wide, westFrame, stubRoom);
  const past = px(850, 900, wide, westFrame, stubRoom);
  ok(
    `fixture: the stub does not split the room (${stubRoom(850, 450).id} = ${stubRoom(850, 900).id})`,
    stubRoom(850, 450).id === stubRoom(850, 900).id
  );
  ok(`the beam does not reach around a wall stub (${behind.rgb[0].toFixed(2)})`, behind.rgb[0] < 0.1);
  ok(`…and carries on past its end (${past.rgb[0].toFixed(2)})`, past.rgb[0] > 0.3);
  // Measured as the eye sees it — a few px averaged across the beam — so the taps' fine dither does not count as an
  // edge; the shadow itself must ramp over tens of px, not step.
  const at = (y) => {
    let s = 0;
    for (let dx = -6; dx <= 6; dx += 2) s += px(850 + dx, y, wide, westFrame, stubRoom).rgb[0];
    return s / 7;
  };
  const edge = [];
  for (let y = 600; y <= 820; y += 4) edge.push(at(y));
  const top = Math.max(...edge);
  const ramp = edge.filter((v) => v > 0.1 * top && v < 0.9 * top).length * 4;
  let jump = 0;
  for (let i = 1; i < edge.length; i++) jump = Math.max(jump, Math.abs(edge[i] - edge[i - 1]) / top);
  ok(
    `the stub's shadow edge is a ramp, not a step (${ramp} px from 10% to 90%, largest 4 px step ${(jump * 100).toFixed(0)}% of full)`,
    ramp >= 16 && jump < 0.25
  );

  // SHADED ROOM: the north-east room's east window faces away from a western sun — dimmed, not moved.
  const neLit = px(1500, 480, eastCookie);
  ok('the shaded east room is dimmed', neLit.rgb[0] > 0 && Math.abs(neLit.rgb[0] - dimmed) < 0.05);
  ok('…and its light does not slide', px(1395, 480, eastCookie).rgb[0] === 0);

  // ── the TSL port ─────────────────────────────────────────────────────────
  let handle = null;
  let built = null;
  let err = null;
  try {
    handle = createWindowRoomLight({ THREE, roomTexture: stubTexture(), fieldTexture: stubTexture() });
    const { uniform, vec4 } = THREE.TSL;
    built = buildWindowSurfaceMaterial({
      THREE,
      maskTexture: stubTexture(),
      depthTexture: stubTexture(),
      uViewRect: uniform(vec4(0, 0, 100, 100)),
      roomLight: handle,
      glass: true,
    });
  } catch (e) {
    err = e;
  }
  ok(`the window material CONSTRUCTS with the room term (${err ? err.message : 'clean'})`, err === null && !!built);
  if (!built) return;
  ok('the material reports the room term compiled', built.roomCompiled === true && built.roomLight === handle);
  const snap = handle.snapshot();
  ok(
    `id and field nodes exist for P, every tap and the clearance samples (${snap.idNodes} / ${snap.fieldNodes})`,
    snap.idNodes >= WINDOW_ROOM_TAPS + 1 && snap.fieldNodes >= 2 * WINDOW_ROOM_TAPS + WINDOW_ROOM_GAP_SAMPLES + 1
  );
  handle.setRoomMap({ roomTexture: stubTexture(), fieldTexture: stubTexture(), spec });
  handle.setFrame(westFrame);
  handle.setLook(look);
  const after = handle.snapshot();
  ok(
    'setRoomMap reaches the grid size and the frame reaches the throw and the sun',
    after.roomSize[0] === spec.cols && after.throw[0] === westFrame.throwX && after.toSun[0] === westFrame.toSunX
  );
  const withoutRoom = buildWindowSurfaceMaterial({
    THREE,
    maskTexture: stubTexture(),
    depthTexture: stubTexture(),
    uViewRect: THREE.TSL.uniform(THREE.TSL.vec4(0, 0, 100, 100)),
  });
  ok('omitting the handle compiles none of it', withoutRoom.roomCompiled === false);
  ok(
    'the four room debug channels are declared',
    ['rooms', 'roomWallDist', 'roomSun', 'roomGate'].every((id) => WINDOW_DEBUG_CHANNELS.some((c) => c.id === id))
  );
}
