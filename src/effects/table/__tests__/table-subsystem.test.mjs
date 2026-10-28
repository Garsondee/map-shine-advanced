/**
 * table-subsystem.test.mjs — the two world meshes sit where the viewer needs them, follow the view,
 * and switch off cleanly; and the "padding is not fog" term builds inside the REAL vision gate,
 * the explored-dim quad and the sampler the present's fog hold uses.
 */
import * as THREE from '../../../../src/vendor/three/three.webgpu.js';
import { markCompileDeferrable } from '../../../core/compile-policy.js';
import { createTableSubsystem } from '../table-subsystem.js';
import { tableEffectsRect } from '../table-model.js';
import { buildLensCompositeMaterial } from '../../lens-render.js';
import {
  buildVisionGateMaterial,
  buildVisionExploredDimMaterial,
  sampleVisionRevealFactor,
} from '../../vision/vision-mask-render.js';

function stubTexture() {
  const tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.needsUpdate = true;
  return tex;
}

export function run(t) {
  const { ok } = t;
  const TSL = THREE.TSL;
  const uViewRect = TSL.uniform(TSL.vec4(0, 0, 1920, 1080));
  const table = createTableSubsystem({ THREE, markCompileDeferrable, uViewRect });
  const { floor, overlay } = table.meshes;

  ok('the floor sorts below the floor art (index 0)', floor.renderOrder < 0);
  ok('the overlay sorts above any sorted item', overlay.renderOrder > 100000);
  ok('both start hidden', !floor.visible && !overlay.visible);

  const scene = new THREE.Scene();
  table.attach(scene);
  table.attach(scene);
  const meshCount = 2 + table.meshes.steps.length;
  ok('attach is idempotent', scene.children.filter((c) => c.name === 'table').length === meshCount);
  ok(
    'there are board-shadow steps, all hidden at first',
    table.meshes.steps.length >= 3 && table.meshes.steps.every((m) => !m.visible)
  );

  const sceneRect = { x: 1000, y: 800, width: 4000, height: 2400 };
  const viewRect = { minX: 0, minY: 0, maxX: 2000, maxY: 1000 };
  const frame = (over = {}) => ({
    enabled: true,
    params: null,
    viewRect,
    sceneRect,
    drawHeightPx: 1000,
    ...over,
  });

  table.update(frame());
  ok('on: both meshes show', floor.visible && overlay.visible);
  ok('the planes cover the view (with a little to spare)', floor.scale.x > 2000 && floor.scale.y > 1000);
  ok('the planes are centred on the view', floor.position.x === 1000 && floor.position.y === 500);
  ok('info reports the eye above the board', table.info().on === true && table.info().eyeHeightPx > 0);
  ok('the defaults give a real recess and rim', table.info().depthPx > 0 && table.info().rimPx > 0);

  ok(
    'no ladder: no steps, the overlay keeps the whole shadow',
    table.info().shadeSteps === 0 && table.info().shadeLast === 1
  );

  // The parallax ladder: steps sort between the layers they split, the overlay keeps the top band's share.
  const ladder = {
    steps: [
      { order: 4.5, from: 1, to: 0.6 },
      { order: 9.5, from: 0.6, to: 0.15 },
    ],
    last: 0.15,
  };
  table.update(frame({ shade: ladder }));
  const [s0, s1, s2] = table.meshes.steps;
  ok('a ladder shows one step per entry', s0.visible && s1.visible && !s2.visible);
  ok('each step sorts where the ladder says', s0.renderOrder === 4.5 && s1.renderOrder === 9.5);
  ok('the overlay applies the top band’s share', table.info().shadeLast === 0.15 && table.info().shadeSteps === 2);
  ok(
    'steps are blended, deferrable and leave scene-attr alone',
    table.meshes.steps.every(
      (m) => m.material.transparent && !!m.material.userData.msaDeferCompile && !!m.material.mrtNode
    )
  );
  ok('the steps follow the view like the planes', s0.position.x === 1000 && s0.scale.x === floor.scale.x);
  table.update(frame());
  ok(
    'the ladder gone: steps hide, the overlay keeps all of it',
    !s0.visible && !s1.visible && table.info().shadeLast === 1
  );

  // THE EFFECTS EXTENT (the author, 2026-10-28: "doesn't leave a gap around the edge").
  const board = { minX: 1000, minY: 800, maxX: 5000, maxY: 3200 };
  const same = (a, b) => ['minX', 'minY', 'maxX', 'maxY'].every((k) => Math.abs(a[k] - b[k]) < 1e-6);
  ok('extent: nothing raised, the effects stop at the board', same(table.effectsRect(), board));
  table.update(frame({ stack: { topHeightPx: 40, floorDepthPx: 0 } }));
  const ext = table.effectsRect();
  const eyeH = table.info().eyeHeightPx;
  const depth = table.info().depthPx;
  // The eye (1000, 500) sits on the board's left edge and above its top edge: the far sides widen,
  // and the near ones never shrink below the board.
  ok('extent: raised layers widen the far sides', ext.maxX > board.maxX && ext.maxY > board.maxY);
  ok('extent: it never shrinks below the board', ext.minX === board.minX && ext.minY === board.minY);
  ok(
    '⭐ extent: it ends exactly at the brass’s inner edge (the board scaled about the eye to the table top)',
    same(ext, tableEffectsRect(board, { x: 1000, y: 500 }, eyeH, depth)) &&
      tableEffectsRect(board, { x: 3000, y: 2000 }, eyeH, depth).minX < board.minX &&
      Math.abs((ext.maxX - 1000) * ((eyeH - depth) / eyeH) - (board.maxX - 1000)) < 1e-6
  );
  table.update(frame({ enabled: false }));
  ok('extent: Table off, the effects stop at the board', same(table.effectsRect(), board));
  ok(
    'extent: no rise or a bad eye is the board itself',
    same(tableEffectsRect(board, { x: 0, y: 0 }, 100, 0), board) &&
      same(tableEffectsRect(board, { x: 0, y: 0 }, 10, 50), board)
  );

  table.update(frame({ enabled: false, shade: ladder }));
  ok('off: both meshes hide', !floor.visible && !overlay.visible);
  ok(
    'off: no step shows even with a ladder',
    table.meshes.steps.every((m) => !m.visible)
  );
  table.update(frame({ sceneRect: null }));
  ok('no scene rect: both hide', !floor.visible && !overlay.visible);
  table.update(frame({ viewRect: null }));
  ok('no view: both hide', !floor.visible && !overlay.visible);

  // The reveal builds inside every consumer of the vision rule.
  const reveal = table.revealedOutsideScene;
  ok('the reveal builds a node from a screen uv', !!reveal(TSL.uv()));
  const gate = buildVisionGateMaterial({
    THREE,
    maskTexture: stubTexture(),
    illumTexture: stubTexture(),
    threshold: 0.1,
    extraRevealed: reveal,
  });
  ok('the vision gate builds with it', !!gate.fragmentNode);
  const plain = buildVisionGateMaterial({
    THREE,
    maskTexture: stubTexture(),
    illumTexture: stubTexture(),
    threshold: 0.1,
  });
  ok('…and still builds without it (no Table ⇒ the old rule)', !!plain.fragmentNode);
  const dim = buildVisionExploredDimMaterial({
    THREE,
    maskTexture: stubTexture(),
    illumTexture: stubTexture(),
    threshold: 0.1,
    exploredTexture: stubTexture(),
    exploredSnapshotTexture: stubTexture(),
    uViewRect,
    uExploredRect: TSL.uniform(TSL.vec4(0, 0, 1, 1)),
    dimFactor: 0.35,
    extraRevealed: reveal,
  });
  ok('the explored-dim quad builds with it', !!dim.fragmentNode);
  const sampled = sampleVisionRevealFactor({
    THREE,
    maskTexture: stubTexture(),
    illumTexture: stubTexture(),
    screenUV: TSL.uv(),
    threshold: 0.1,
    extraRevealed: reveal,
  });
  ok("the sampler the present's fog hold uses builds with it", !!sampled.revealed && !!sampled.factor);

  // The lens guard builds inside the REAL lens material, at every tier, and is optional.
  for (const tier of [0, 1, 2, 3]) {
    let built = null;
    try {
      built = buildLensCompositeMaterial({
        THREE,
        sceneTexture: stubTexture(),
        lightBurnTexture: stubTexture(),
        overlayTexture: stubTexture(),
        overlayNextTexture: stubTexture(),
        resolutionWidth: 1920,
        resolutionHeight: 1080,
        tier,
        uvGuard: table.lensGuard,
      });
    } catch (err) {
      console.error('lens build with guard failed at tier', tier, err?.message);
    }
    ok(`the lens builds with the table guard (tier ${tier})`, !!built?.material);
  }

  table.dispose();
  ok('dispose detaches the meshes', scene.children.filter((c) => c.name === 'table').length === 0);
}
