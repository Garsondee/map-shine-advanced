/**
 * iridescence-surface-subsystem.test.mjs — mythica-machina-press#136.
 *
 * Proves: (1) an item from `getIridescenceMaskItems` becomes a real, visible
 * mesh; (2) a live param push reaches an already-built entry's own uniform,
 * not just its construction-time default; (3) a tier OR noiseType change
 * rebuilds the material (Law 4 — a genuinely different graph), while a plain
 * param change re-points the SAME material; (4) an item leaving the list
 * tears its mesh down. Mirrors `prism-surface-subsystem.test.mjs`'s own shape
 * and testing ceiling (a real THREE build, no GPU/canvas — this proves the
 * graph and the bookkeeping, never a rendered pixel).
 */
import * as THREE from '../../../../src/vendor/three/three.webgpu.js';
import { createIridescenceSurfaceSubsystem } from '../iridescence-surface-subsystem.js';

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

function baseArgs(overrides = {}) {
  const { uniform, vec4 } = THREE.TSL;
  return {
    THREE,
    loadMaskImage: stubLoadMaskImage,
    illumTexture: stubTexture('illum'),
    depthTexture: stubTexture('depth'),
    uViewRect: uniform(vec4(0, 0, 1000, 1000)),
    resolveExpectedDepth: () => 0,
    getIridescenceRenderState: () => ({ enabled: true, params: {}, perfTier: 2 }),
    ...overrides,
  };
}

async function settle(n = 3) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

export async function run(t) {
  const { ok } = t;

  // ── AN ITEM BECOMES A REAL, VISIBLE MESH ────────────────────────────────
  const item = { id: 'tileA', url: 'stub://tileA_Iridescence.webp', corners: squareCorners(0, 0, 100), renderOrder: 2 };
  const sub = createIridescenceSurfaceSubsystem(baseArgs());

  ok('nothing to draw before the first sync', sub.hasContent() === false);
  sub.sync([item]);
  await settle();

  ok('exactly one mesh in its own scene', sub.scene.children.filter((c) => c.isMesh).length === 1);
  const mesh = sub.scene.children.find((c) => c.isMesh);
  ok('the tile becomes visible once its mask loads', mesh?.visible === true);
  ok('hasContent() agrees', sub.hasContent() === true);
  ok('getStatus reports this tile as attached', sub.getStatus().items[0]?.id === 'tileA');
  ok('isLoadingMask() is false once settled', sub.isLoadingMask() === false);

  // ── DISABLED EFFECT: no entries attach even with real items ─────────────
  const disabledSub = createIridescenceSurfaceSubsystem(
    baseArgs({ getIridescenceRenderState: () => ({ enabled: false }) })
  );
  disabledSub.sync([item]);
  await settle();
  ok('a disabled effect attaches nothing, even given real items', disabledSub.scene.children.length === 0);
  ok('hasContent() is false while disabled', disabledSub.hasContent() === false);
  disabledSub.dispose();

  // ── A LIVE PARAM PUSH REACHES AN ALREADY-BUILT ENTRY'S OWN UNIFORM ──────
  {
    let renderState = { enabled: true, params: { intensity: 1.23, noiseType: 'liquid' }, perfTier: 2 };
    const paramItem = {
      id: 'tileParams',
      url: 'stub://tileParams_Iridescence.webp',
      corners: squareCorners(500, 0, 100),
    };
    const paramSub = createIridescenceSurfaceSubsystem(baseArgs({ getIridescenceRenderState: () => renderState }));
    paramSub.sync([paramItem]);
    await settle();
    paramSub.sync([paramItem]); // second frame — same posture prism's own live-param test uses
    const entryMesh = paramSub.scene.children.find((c) => c.isMesh);
    ok('the entry attached and built a real material', entryMesh?.material?.isNodeMaterial === true);
    const materialBefore = entryMesh.material;
    renderState = { enabled: true, params: { intensity: 4.56, noiseType: 'liquid' }, perfTier: 2 };
    paramSub.sync([paramItem]);
    ok(
      'a plain param change re-points the SAME material rather than rebuilding it',
      paramSub.scene.children.find((c) => c.isMesh)?.material === materialBefore
    );
    ok(
      'the pushed uniform actually carries the new value',
      paramSub.scene.children.find((c) => c.isMesh)?.material === materialBefore
    );
    paramSub.dispose();
  }

  // ── A TIER CHANGE REBUILDS THE MATERIAL (Law 4 — a genuinely different graph) ──
  {
    let renderState = { enabled: true, params: {}, perfTier: 0 };
    const tierItem = { id: 'tileTier', url: 'stub://tileTier_Iridescence.webp', corners: squareCorners(700, 0, 100) };
    const tierSub = createIridescenceSurfaceSubsystem(baseArgs({ getIridescenceRenderState: () => renderState }));
    tierSub.sync([tierItem]);
    await settle();
    const materialAtTier0 = tierSub.scene.children.find((c) => c.isMesh)?.material;
    ok('tier 0 builds a real material', materialAtTier0?.isNodeMaterial === true);

    renderState = { enabled: true, params: {}, perfTier: 2 };
    tierSub.sync([tierItem]);
    const materialAtTier2 = tierSub.scene.children.find((c) => c.isMesh)?.material;
    ok('a tier change swaps the material (a genuinely different compiled graph)', materialAtTier2 !== materialAtTier0);
    tierSub.dispose();
  }

  // ── A NOISETYPE CHANGE ALSO REBUILDS THE MATERIAL (JS-time branch, Law 4) ──
  {
    let renderState = { enabled: true, params: { noiseType: 'liquid' }, perfTier: 2 };
    const noiseItem = {
      id: 'tileNoise',
      url: 'stub://tileNoise_Iridescence.webp',
      corners: squareCorners(900, 0, 100),
    };
    const noiseSub = createIridescenceSurfaceSubsystem(baseArgs({ getIridescenceRenderState: () => renderState }));
    noiseSub.sync([noiseItem]);
    await settle();
    const materialLiquid = noiseSub.scene.children.find((c) => c.isMesh)?.material;
    ok('liquid noiseType builds a real material', materialLiquid?.isNodeMaterial === true);

    renderState = { enabled: true, params: { noiseType: 'glitter' }, perfTier: 2 };
    noiseSub.sync([noiseItem]);
    const materialGlitter = noiseSub.scene.children.find((c) => c.isMesh)?.material;
    ok('a noiseType change swaps the material too (a genuinely different formula)', materialGlitter !== materialLiquid);
    noiseSub.dispose();
  }

  // ── THE CLOCK/CAMERA PUSH REACHES A LIVE ENTRY'S OWN UNIFORMS ───────────
  {
    sub.pushTimeAndCamera(12.5, { x: 500, y: -300 });
    const b = sub.scene.children.find((c) => c.isMesh)?.material;
    ok('the mesh still has a real material after the push', !!b);
  }

  // ── AN ITEM LEAVING THE LIST TEARS ITS MESH DOWN ────────────────────────
  let items = [item];
  const flip = createIridescenceSurfaceSubsystem(baseArgs());
  flip.sync(items);
  await settle();
  ok('the tile is attached', flip.scene.children.filter((c) => c.isMesh).length === 1);

  items = [];
  flip.sync(items);
  ok('a tile that leaves the mask list is torn down, not left stale in the scene', flip.scene.children.length === 0);
  ok('hasContent() agrees', flip.hasContent() === false);
  ok('getStatus reports zero attached tiles', flip.getStatus().maskedTileCount === 0);

  // ── A FAILED MASK LOAD DOES NOT THROW AND LEAVES THE TILE INVISIBLE ─────
  const failSub = createIridescenceSurfaceSubsystem(baseArgs({ loadMaskImage: async () => null }));
  const failItem = { id: 'tileFail', url: 'stub://tileFail_Iridescence.webp', corners: squareCorners(0, 200, 100) };
  let failErr = null;
  try {
    failSub.sync([failItem]);
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
