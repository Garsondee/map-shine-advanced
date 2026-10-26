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

  // ── A LOOK PARAM CHANGE REACHES A TILE-MOTION ENTRY'S LIVE UNIFORM ──────
  // Direct author question (2026-09-09): "I change the settings for
  // metallic but they stay looking the same" on motion tiles. A full trace
  // found the wiring correct (no bug — this closes the coverage gap rather
  // than fixing a regression). The three tests above only prove ATTACHMENT
  // and positionNode wiring;
  // none of them prove a param pushed through `getSpecularRenderState()`
  // after the fact actually reaches the live shader uniform on an entry
  // that carries a positionNode, rather than getting silently stuck at
  // `buildSurfaceForEntry`'s own construction-time schema defaults (it does
  // not forward strength/etc. at build time — see that function's own body
  // — relying entirely on `sync()`'s "LOOK PARAMS" push block to apply the
  // live values afterward). THREE is injected specifically so a caller CAN
  // substitute pieces of it (this module's own header) — spy on
  // `THREE.TSL.uniform` to capture the real `uStrength` node
  // `buildSpecularSurfaceMaterial` creates, then read its `.value` back
  // after driving the subsystem exactly the way production does: one
  // `sync()` to attach (fires the async mask load), a settle, then a SECOND
  // `sync()` — the next real frame — which is what actually applies
  // `state.params` (see `loadAndBuild`'s own `lastParamsKey = ''` reset).
  {
    const capturedUniforms = [];
    const realUniform = THREE.TSL.uniform;
    const spyTHREE = {
      ...THREE,
      TSL: {
        ...THREE.TSL,
        uniform(val) {
          const node = realUniform(val);
          capturedUniforms.push(node);
          return node;
        },
      },
    };

    let renderState = { enabled: true, params: { strength: 111 } };
    const liveTm = makeTileMotionBag();
    const liveItem = {
      id: 'tileLiveParams',
      url: 'stub://tileLiveParams_Specular.webp',
      corners: squareCorners(400, 0, 100),
      renderOrder: 4,
    };
    const liveSub = createSpecularTileSurfaceSubsystem(
      baseArgs({
        THREE: spyTHREE,
        getSpecularMaskItems: (floorIndex) => (floorIndex === 0 ? [liveItem] : []),
        getItemTileMotion: () => liveTm,
        getSpecularRenderState: () => renderState,
      })
    );

    liveSub.sync(0, { minX: 0, minY: 0, maxX: 1000, maxY: 1000 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    liveSub.sync(0, { minX: 0, minY: 0, maxX: 1000, maxY: 1000 });

    const uStrength = capturedUniforms.find((n) => n?.value === 111);
    ok(
      'a tile-motion entry’s strength uniform reads the live params push, not the schema construction default',
      !!uStrength
    );

    renderState = { enabled: true, params: { strength: 222 } };
    liveSub.sync(0, { minX: 0, minY: 0, maxX: 1000, maxY: 1000 });
    ok(
      'changing the effect-wide strength param live-updates that SAME uniform on the tile-motion entry',
      uStrength?.value === 222
    );

    liveSub.dispose();
  }

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
  // HIDE, NEVER DISPOSE (loading audit P-05, 2026-10-25). It used to be torn down
  // on the spot, so a floor change threw away one floor's tiles and rebuilt the
  // other's from a cold fetch on the visible frames after the flip.
  const parkedMeshes = flip.scene.children.filter((c) => c.isMesh);
  ok(
    'a tile that leaves the mask list is PARKED — still loaded, no longer drawn',
    parkedMeshes.length === 1 && parkedMeshes[0].visible === false
  );
  ok('hasContent() agrees — nothing is drawn', flip.hasContent() === false);
  ok('getStatus reports zero attached tiles on the drawn floor', flip.getStatus().maskedTileCount === 0);
  ok('…and one parked', flip.getStatus().parkedTileCount === 1);

  items = [staticItem]; // it comes back (going back to the floor)
  flip.sync(0, { minX: 0, minY: 0, maxX: 1000, maxY: 1000 });
  ok(
    'a parked tile that returns is drawn again at once, from the SAME mesh (no reload)',
    flip.hasContent() === true && flip.scene.children.filter((c) => c.isMesh)[0] === parkedMeshes[0]
  );

  // PREFETCH: a floor that is not the drawn one can be warmed.
  const warm = createSpecularTileSurfaceSubsystem(
    baseArgs({ getSpecularMaskItems: () => [], getItemTileMotion: () => null })
  );
  warm.prefetchItems([staticItem]);
  ok('prefetch: not ready while the mask is still loading', warm.areItemsReady([staticItem]) === false);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  ok('prefetch: ready once loaded', warm.areItemsReady([staticItem]) === true);
  ok(
    'prefetch: loading did NOT present anything',
    warm.hasContent() === false && warm.getStatus().maskedTileCount === 0
  );
  warm.dispose();

  // THE CAP: a scene with very many masked tiles cannot grow without bound.
  {
    const many = Array.from({ length: 30 }, (_, i) => ({
      ...staticItem,
      id: `cap-${i}`,
      url: `stub://cap${i}_Specular.webp`,
    }));
    let capItems = many;
    const capped = createSpecularTileSurfaceSubsystem(
      baseArgs({ getSpecularMaskItems: () => capItems, getItemTileMotion: () => null })
    );
    capped.sync(0, { minX: 0, minY: 0, maxX: 1000, maxY: 1000 });
    for (let i = 0; i < 6; i++) await Promise.resolve();
    capItems = [];
    capped.sync(0, { minX: 0, minY: 0, maxX: 1000, maxY: 1000 });
    const left = capped.scene.children.filter((c) => c.isMesh).length;
    ok('the parked cap: 30 tiles left the floor, only the newest 24 stay resident', left === 24);
    capped.dispose();
  }

  staticSub.dispose();
  movingSub.dispose();
  debugSub.dispose();
  flip.dispose();
}
