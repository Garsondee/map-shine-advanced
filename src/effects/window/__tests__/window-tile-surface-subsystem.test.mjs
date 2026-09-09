/**
 * window-tile-surface-subsystem.test.mjs — mythica-machina-press#538/#539.
 *
 * Proves: (1) a TILE-authored mask becomes a real, visible mesh — the
 * attachment half of the fix; (2) a tile with a LIVE tile-motion bag gets a
 * `positionNode` wired onto its material, while an ordinary static tile does
 * not — the transform-wiring half; (3) an item leaving the floor's mask list
 * tears its mesh down.
 *
 * Same ceiling every subsystem test in this tree already accepts
 * (`window-surface-subsystem.test.mjs`'s own header): nothing here proves
 * what a channel LOOKS like or what number a shader produces on real
 * hardware — only that the mesh, the material and this subsystem's own
 * bookkeeping agree about what should be on screen.
 */
import * as THREE from '../../../../src/vendor/three/three.webgpu.js';
import { createWindowTileSurfaceSubsystem } from '../window-tile-surface-subsystem.js';

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

export async function run(t) {
  const { ok } = t;
  const { uniform, vec4 } = THREE.TSL;

  // ── A STATIC TILE (no tile-motion) BECOMES A REAL, VISIBLE MESH ─────────
  const staticItem = {
    id: 'tileStatic',
    url: 'stub://tileStatic_Window.webp',
    corners: squareCorners(0, 0, 100),
    renderOrder: 2,
  };
  const staticSub = createWindowTileSurfaceSubsystem({
    THREE,
    getWindowMaskItems: (floorIndex) => (floorIndex === 0 ? [staticItem] : []),
    loadMaskImage: stubLoadMaskImage,
    createMaskTexture: (data, w, h) => {
      const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.needsUpdate = true;
      return tex;
    },
    depthTexture: stubTexture(),
    resolveExpectedDepth: () => 0,
    getItemTileMotion: () => null, // ordinary, unanimated tile
    uViewRect: uniform(vec4(0, 0, 1000, 1000)),
    getWindowRenderState: () => ({ enabled: true, params: {}, debugChannel: 0 }),
  });

  ok('nothing to draw before the first sync', staticSub.hasContent() === false);
  staticSub.sync(0);
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
    'getStatus reports this tile as attached, with tileMotionActive false',
    staticSub.getStatus().items[0]?.id === 'tileStatic' && staticSub.getStatus().items[0]?.tileMotionActive === false
  );

  // ── A LIVE TILE-MOTION TILE GETS A positionNode ─────────────────────────
  const tm = makeTileMotionBag();
  const movingItem = {
    id: 'tileMoving',
    url: 'stub://tileMoving_Window.webp',
    corners: squareCorners(200, 0, 100),
    renderOrder: 3,
  };
  const movingSub = createWindowTileSurfaceSubsystem({
    THREE,
    getWindowMaskItems: (floorIndex) => (floorIndex === 0 ? [movingItem] : []),
    loadMaskImage: stubLoadMaskImage,
    createMaskTexture: (data, w, h) => {
      const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.needsUpdate = true;
      return tex;
    },
    depthTexture: stubTexture(),
    resolveExpectedDepth: () => 0,
    getItemTileMotion: (item) => (item.id === 'tileMoving' ? tm : null),
    uViewRect: uniform(vec4(0, 0, 1000, 1000)),
    getWindowRenderState: () => ({ enabled: true, params: {}, debugChannel: 0 }),
  });
  movingSub.sync(0);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const movingMesh = movingSub.scene.children.find((c) => c.isMesh);
  ok('a tile-motion tile’s material carries a real positionNode', !!movingMesh?.material?.positionNode);
  ok('getStatus reports tileMotionActive true for it', movingSub.getStatus().items[0]?.tileMotionActive === true);

  // Picking a debug channel must not un-stick the animation — the SAME
  // positionNode has to follow onto the debug material too (proven directly
  // below, on a FRESH instance built with debugChannel already set, since
  // window-render.js assigns positionNode onto both materials at build time
  // — window-render.test.mjs's own "ALSO reaches the debug material"
  // assertion is the unit-level proof of that; this is the wiring-level one).
  const debugSub = createWindowTileSurfaceSubsystem({
    THREE,
    getWindowMaskItems: (floorIndex) => (floorIndex === 0 ? [movingItem] : []),
    loadMaskImage: stubLoadMaskImage,
    createMaskTexture: (data, w, h) => {
      const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.needsUpdate = true;
      return tex;
    },
    depthTexture: stubTexture(),
    resolveExpectedDepth: () => 0,
    getItemTileMotion: () => tm,
    uViewRect: uniform(vec4(0, 0, 1000, 1000)),
    getWindowRenderState: () => ({ enabled: true, params: {}, debugChannel: 5 }),
  });
  debugSub.sync(0);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const debugMesh = debugSub.scene.children.find((c) => c.isMesh);
  ok('on a debug channel the mesh still carries a real positionNode', !!debugMesh?.material?.positionNode);

  // ── AN ITEM LEAVING THE FLOOR'S LIST TEARS ITS MESH DOWN ────────────────
  let items = [staticItem];
  const flip = createWindowTileSurfaceSubsystem({
    THREE,
    getWindowMaskItems: (floorIndex) => (floorIndex === 0 ? items : []),
    loadMaskImage: stubLoadMaskImage,
    createMaskTexture: (data, w, h) => {
      const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.needsUpdate = true;
      return tex;
    },
    depthTexture: stubTexture(),
    resolveExpectedDepth: () => 0,
    getItemTileMotion: () => null,
    uViewRect: uniform(vec4(0, 0, 1000, 1000)),
    getWindowRenderState: () => ({ enabled: true, params: {}, debugChannel: 0 }),
  });
  flip.sync(0);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  ok('the tile is attached', flip.scene.children.filter((c) => c.isMesh).length === 1);

  items = []; // the tile left the floor (moved away, deleted, or the mask removed)
  flip.sync(0);
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
