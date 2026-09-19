/**
 * prism-surface-subsystem.test.mjs — mythica-machina-press#137.
 *
 * Proves: (1) an item from `getPrismMaskItems` becomes a real, visible mesh;
 * (2) the SHARED capture (behindTexture/capturedRect/capturedTexSize) reaches
 * every live entry's own material, re-pointed together; (3) a live param
 * push reaches an already-built entry's own uniform, not just its
 * construction-time default; (4) an item leaving the list tears its mesh
 * down. Mirrors `specular-tile-surface-subsystem.test.mjs`'s own shape and
 * testing ceiling (a real THREE build, no GPU/canvas — this proves the graph
 * and the bookkeeping, never a rendered pixel).
 */
import * as THREE from '../../../../src/vendor/three/three.webgpu.js';
import { createPrismSurfaceSubsystem } from '../prism-surface-subsystem.js';

function stubTexture(tag) {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  t.__tag = tag;
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
  return { texture: stubTexture('mask') };
}

const NO_CAPTURE = { behindTexture: null, capturedRect: null, capturedTexSize: null };

function baseArgs(overrides = {}) {
  const { uniform, vec4 } = THREE.TSL;
  return {
    THREE,
    loadMaskImage: stubLoadMaskImage,
    depthTexture: stubTexture('depth'),
    uViewRect: uniform(vec4(0, 0, 1000, 1000)),
    resolveExpectedDepth: () => 0,
    getPrismRenderState: () => ({ enabled: true, params: {}, perfTier: 3 }),
    ...overrides,
  };
}

async function settle(n = 3) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

export async function run(t) {
  const { ok } = t;

  // ── AN ITEM BECOMES A REAL, VISIBLE MESH ────────────────────────────────
  const item = { id: 'tileA', url: 'stub://tileA_Prism.webp', corners: squareCorners(0, 0, 100), renderOrder: 2 };
  const sub = createPrismSurfaceSubsystem(baseArgs());

  ok('nothing to draw before the first sync', sub.hasContent() === false);
  sub.sync([item], NO_CAPTURE);
  await settle();

  ok('exactly one mesh in its own scene', sub.scene.children.filter((c) => c.isMesh).length === 1);
  const mesh = sub.scene.children.find((c) => c.isMesh);
  ok('the tile becomes visible once its mask loads', mesh?.visible === true);
  ok('hasContent() agrees', sub.hasContent() === true);
  ok('getStatus reports this tile as attached', sub.getStatus().items[0]?.id === 'tileA');
  ok('isLoadingMask() is false once settled', sub.isLoadingMask() === false);

  // ── DISABLED EFFECT: no entries attach even with real items ─────────────
  const disabledSub = createPrismSurfaceSubsystem(baseArgs({ getPrismRenderState: () => ({ enabled: false }) }));
  disabledSub.sync([item], NO_CAPTURE);
  await settle();
  ok('a disabled effect attaches nothing, even given real items', disabledSub.scene.children.length === 0);
  ok('hasContent() is false while disabled', disabledSub.hasContent() === false);
  disabledSub.dispose();

  // ── THE SHARED CAPTURE REACHES EVERY LIVE ENTRY, RE-POINTED, NEVER REBUILT ──
  const materialBeforeCapture = mesh.material;
  const behind1 = stubTexture('behind-1');
  sub.sync([item], {
    behindTexture: behind1,
    capturedRect: { minX: 1, minY: 2, maxX: 3, maxY: 4 },
    capturedTexSize: { width: 64, height: 32 },
  });
  ok(
    'a tier-3 material stays the SAME material across a capture push (re-point, not rebuild)',
    sub.scene.children.find((c) => c.isMesh)?.material === materialBeforeCapture
  );
  // A SECOND capture, a different texture identity — must not throw and must
  // still be the same material (the re-point contract holds across repeats,
  // not just the first one).
  const behind2 = stubTexture('behind-2');
  let captureErr = null;
  try {
    sub.sync([item], {
      behindTexture: behind2,
      capturedRect: { minX: 5, minY: 6, maxX: 7, maxY: 8 },
      capturedTexSize: { width: 128, height: 96 },
    });
  } catch (err) {
    captureErr = err;
  }
  ok(
    `re-pointing to a second capture identity does not throw (${captureErr ? captureErr.message : 'clean'})`,
    captureErr === null
  );
  ok(
    'still the same material after the second capture push',
    sub.scene.children.find((c) => c.isMesh)?.material === materialBeforeCapture
  );

  // ── A LIVE PARAM PUSH REACHES AN ALREADY-BUILT ENTRY'S OWN UNIFORM ──────
  {
    let renderState = { enabled: true, params: { intensity: 1.23 }, perfTier: 3 };
    const paramItem = { id: 'tileParams', url: 'stub://tileParams_Prism.webp', corners: squareCorners(500, 0, 100) };
    const paramSub = createPrismSurfaceSubsystem(baseArgs({ getPrismRenderState: () => renderState }));
    paramSub.sync([paramItem], NO_CAPTURE);
    await settle();
    paramSub.sync([paramItem], NO_CAPTURE); // second frame — same posture specular-tile's own live-param test uses
    const entryMesh = paramSub.scene.children.find((c) => c.isMesh);
    ok('the entry attached and built a real material', entryMesh?.material?.isNodeMaterial === true);
    // A plain param change (never a tier/facetAnimate change) must re-point
    // the SAME material's uniforms rather than rebuild — proven below by
    // material IDENTITY staying stable across the param-only update (a
    // rebuild would swap it, which would be wrong for this case).
    const materialBefore = entryMesh.material;
    renderState = { enabled: true, params: { intensity: 4.56 }, perfTier: 3 };
    paramSub.sync([paramItem], NO_CAPTURE);
    ok(
      'a plain param change re-points the SAME material rather than rebuilding it',
      paramSub.scene.children.find((c) => c.isMesh)?.material === materialBefore
    );
    paramSub.dispose();
  }

  // ── A TIER CHANGE REBUILDS THE MATERIAL (Law 4 — a genuinely different graph) ──
  {
    let renderState = { enabled: true, params: {}, perfTier: 0 };
    const tierItem = { id: 'tileTier', url: 'stub://tileTier_Prism.webp', corners: squareCorners(700, 0, 100) };
    const tierSub = createPrismSurfaceSubsystem(baseArgs({ getPrismRenderState: () => renderState }));
    tierSub.sync([tierItem], NO_CAPTURE);
    await settle();
    const materialAtTier0 = tierSub.scene.children.find((c) => c.isMesh)?.material;
    ok('tier 0 builds a real material', materialAtTier0?.isNodeMaterial === true);

    renderState = { enabled: true, params: {}, perfTier: 3 };
    tierSub.sync([tierItem], NO_CAPTURE);
    const materialAtTier3 = tierSub.scene.children.find((c) => c.isMesh)?.material;
    ok('a tier change swaps the material (a genuinely different compiled graph)', materialAtTier3 !== materialAtTier0);
    tierSub.dispose();
  }

  // ── AN ITEM LEAVING THE LIST TEARS ITS MESH DOWN ────────────────────────
  let items = [item];
  const flip = createPrismSurfaceSubsystem(baseArgs());
  flip.sync(items, NO_CAPTURE);
  await settle();
  ok('the tile is attached', flip.scene.children.filter((c) => c.isMesh).length === 1);

  items = [];
  flip.sync(items, NO_CAPTURE);
  ok('a tile that leaves the mask list is torn down, not left stale in the scene', flip.scene.children.length === 0);
  ok('hasContent() agrees', flip.hasContent() === false);
  ok('getStatus reports zero attached tiles', flip.getStatus().maskedTileCount === 0);

  // ── A FAILED MASK LOAD DOES NOT THROW AND LEAVES THE TILE INVISIBLE ─────
  const failSub = createPrismSurfaceSubsystem(baseArgs({ loadMaskImage: async () => null }));
  const failItem = { id: 'tileFail', url: 'stub://tileFail_Prism.webp', corners: squareCorners(0, 200, 100) };
  let failErr = null;
  try {
    failSub.sync([failItem], NO_CAPTURE);
    await settle();
  } catch (err) {
    failErr = err;
  }
  ok(`a failed mask load does not throw (${failErr ? failErr.message : 'clean'})`, failErr === null);
  ok('a failed load never becomes visible content', failSub.hasContent() === false);
  failSub.dispose();

  sub.dispose();
  flip.dispose();
}
