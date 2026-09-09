/**
 * specular-tile-surface-subsystem.test.mjs — mythica-machina-press#538/#539.
 *
 * Proves: (1) a TILE-authored mask becomes a real, visible mesh — the
 * attachment half of the fix; (2) a tile with a LIVE tile-motion bag gets a
 * `positionNode` wired onto its material, while an ordinary static tile does
 * not — the transform-wiring half; (3) an item leaving the floor's mask list
 * tears its mesh down. Mirrors `window-tile-surface-subsystem.test.mjs`'s
 * own shape; see that file's header for the testing ceiling this shares.
 */
import * as THREE from '../../../../src/vendor/three/three.webgpu.js';
import { buildWorldSpaceOutdoorsGate } from '../../lighting/environmental-light.js';
import { createSpecularTileSurfaceSubsystem } from '../specular-tile-surface-subsystem.js';

/** A 1×1 texture — enough for a node to reference; never sampled here. */
function stubTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

function squareCorners(x0, y0, size) {
  return [
    { x: x0, y: y0 },
    { x: x0 + size, y: y0 },
    { x: x0 + size, y: y0 + size },
    { x: x0, y: y0 + size },
  ];
}

async function stubLoadMaskImage() {
  return {
    texture: stubTexture(),
    contentBounds: { minU: 0, minV: 0, maxU: 1, maxV: 1 },
    data: new Uint8Array(4 * 4 * 4).fill(200),
    width: 4,
    height: 4,
    nativeWidth: 4,
    nativeHeight: 4,
    bytes: 64,
  };
}

/** A real tile-motion uniform bag — the SAME shape
 * `buildWholeImageMaterial` (vt-pan-viewer.js) builds. */
function makeTileMotionBag() {
  const { uniform, vec2 } = THREE.TSL;
  return {
    uMotionPivot: uniform(vec2(0, 0)),
    uMotionRot: uniform(vec2(1, 0)),
    uMotionTranslate: uniform(vec2(0, 0)),
    uTexPivotUV: uniform(vec2(0.5, 0.5)),
    uTexScrollUV: uniform(vec2(0, 0)),
    uTexRotUV: uniform(vec2(1, 0)),
  };
}

/** Everything the subsystem needs beyond THREE, shaped like
 * `vt-pan-viewer.js`'s own construction call. */
function baseArgs(overrides = {}) {
  const { uniform, vec4 } = THREE.TSL;
  return {
    THREE,
    illumTexture: stubTexture(),
    depthTexture: stubTexture(),
    createMaskTexture: (data, w, h) => {
      const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.needsUpdate = true;
      return tex;
    },
    createPackTexture: (data, w, h) => {
      const tex = new THREE.DataTexture(new Uint8Array(data.length), w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.needsUpdate = true;
      return tex;
    },
    uViewRect: uniform(vec4(0, 0, 1000, 1000)),
    uOutdoorsRect: uniform(vec4(0, 0, 1000, 1000)),
    outdoorsTexNode: THREE.TSL.texture(stubTexture()),
    buildOutdoorsGate: buildWorldSpaceOutdoorsGate,
    timeMsNode: uniform(THREE.TSL.float(0)),
    loadMaskImage: stubLoadMaskImage,
    resolveExpectedDepth: () => 0,
    getSpecularRenderState: () => ({ enabled: true, params: {} }),
    ...overrides,
  };
}

export async function run(t) {
  const { ok } = t;

  // ── A STATIC TILE (no tile-motion) BECOMES A REAL, VISIBLE MESH ─────────
  const staticItem = {
    id: 'tileStatic',
    url: 'stub://tileStatic_Specular.webp',
    corners: squareCorners(0, 0, 100),
    renderOrder: 2,
  };
  const staticSub = createSpecularTileSurfaceSubsystem(
    baseArgs({
      getSpecularMaskItems: (floorIndex) => (floorIndex === 0 ? [staticItem] : []),
      getItemTileMotion: () => null,
    })
  );

  ok('nothing to draw before the first sync', staticSub.hasContent() === false);
  staticSub.sync(0, { minX: 0, minY: 0, maxX: 1000, maxY: 1000 });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  ok(
    'the subsystem builds exactly one mesh in its own scene',
    staticSub.scene.children.filter((c) => c.isMesh).length === 1
  );
  const staticMesh = staticSub.scene.children.find((c) => c.isMesh);
  ok('a Tile-authored mask becomes visible — the floor-only lookup could never see this', staticMesh?.visible === true);
  ok('hasContent() agrees', staticSub.hasContent() === true);
  ok('a static tile’s material carries NO positionNode', !staticMesh.material.positionNode);
  ok(
    'getStatus reports this tile as attached, with tileMotionActive false and a real island-bake status',
    staticSub.getStatus().items[0]?.id === 'tileStatic' &&
      staticSub.getStatus().items[0]?.tileMotionActive === false &&
      Number.isFinite(staticSub.getStatus().items[0]?.islandBakeStatus)
  );

  // `setDarknessFloor` must reach the live entry without throwing — the
  // floor subsystem's own passthrough, mirrored here.
  let darknessError = null;
  try {
    staticSub.setDarknessFloor(0.1, 0.1, 0.1);
  } catch (err) {
    darknessError = err;
  }
  ok(
    `setDarknessFloor runs cleanly against a live entry (${darknessError ? darknessError.message : 'clean'})`,
    darknessError === null
  );

  // ── A LIVE TILE-MOTION TILE GETS A positionNode ─────────────────────────
  const tm = makeTileMotionBag();
  const movingItem = {
    id: 'tileMoving',
    url: 'stub://tileMoving_Specular.webp',
    corners: squareCorners(200, 0, 100),
    renderOrder: 3,
  };
  const movingSub = createSpecularTileSurfaceSubsystem(
    baseArgs({
      getSpecularMaskItems: (floorIndex) => (floorIndex === 0 ? [movingItem] : []),
      getItemTileMotion: (item) => (item.id === 'tileMoving' ? tm : null),
    })
  );
  movingSub.sync(0, { minX: 0, minY: 0, maxX: 1000, maxY: 1000 });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const movingMesh = movingSub.scene.children.find((c) => c.isMesh);
  ok('a tile-motion tile’s material carries a real positionNode', !!movingMesh?.material?.positionNode);
  ok('getStatus reports tileMotionActive true for it', movingSub.getStatus().items[0]?.tileMotionActive === true);

  // Picking a debug channel must not un-stick the animation.
  const debugSub = createSpecularTileSurfaceSubsystem(
    baseArgs({
      getSpecularMaskItems: (floorIndex) => (floorIndex === 0 ? [movingItem] : []),
      getItemTileMotion: () => tm,
      getSpecularRenderState: () => ({ enabled: true, params: {}, debugChannel: 5 }),
    })
  );
  debugSub.sync(0, { minX: 0, minY: 0, maxX: 1000, maxY: 1000 });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const debugMesh = debugSub.scene.children.find((c) => c.isMesh);
  ok('on a debug channel the mesh still carries a real positionNode', !!debugMesh?.material?.positionNode);

  // ── AN ITEM LEAVING THE FLOOR'S LIST TEARS ITS MESH DOWN ────────────────
  let items = [staticItem];
  const flip = createSpecularTileSurfaceSubsystem(
    baseArgs({
      getSpecularMaskItems: (floorIndex) => (floorIndex === 0 ? items : []),
      getItemTileMotion: () => null,
    })
  );
  flip.sync(0, { minX: 0, minY: 0, maxX: 1000, maxY: 1000 });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  ok('the tile is attached', flip.scene.children.filter((c) => c.isMesh).length === 1);

  items = []; // the tile left the floor (moved away, deleted, or the mask removed)
  flip.sync(0, { minX: 0, minY: 0, maxX: 1000, maxY: 1000 });
  ok(
    'a tile that leaves the mask list is torn down, not left stale in the scene',
    flip.scene.children.filter((c) => c.isMesh).length === 0
  );
  ok('hasContent() agrees', flip.hasContent() === false);
  ok('getStatus reports zero attached tiles', flip.getStatus().maskedTileCount === 0);

  staticSub.dispose();
  movingSub.dispose();
  debugSub.dispose();
  flip.dispose();
}
