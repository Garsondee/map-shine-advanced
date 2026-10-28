/**
 * table-render.test.mjs — THE TSL GRAPH IS ACTUALLY CONSTRUCTED, IN NODE
 * (`keyhole-tsl-constructs-in-node`): the trace, the shading and the two
 * world-pass materials, and the frame values landing in the uniforms.
 */
import * as THREE from '../../../../src/vendor/three/three.webgpu.js';
import { markCompileDeferrable } from '../../../core/compile-policy.js';
import {
  createTableUniforms,
  applyTableFrame,
  buildTableTrace,
  buildTableShading,
  buildTableMaterials,
} from '../table-render.js';
import { resolveTableFrame } from '../table-model.js';

export function run(t) {
  const { ok } = t;
  const TSL = THREE.TSL;

  const u = createTableUniforms(TSL);
  ok('uniforms are created', !!u.eye && !!u.rect && !!u.rimColor && !!u.lampColor);
  const tr = buildTableTrace(TSL, { worldXY: TSL.vec2(10, 20), u });
  ok('trace builds', !!tr.floorLive && !!tr.overlayLive && !!tr.lipCover && !!tr.q);
  const shading = buildTableShading(TSL, tr, u);
  ok('shading builds', !!shading.rgb && !!shading.boardShade);

  const rect = { minX: 1000, minY: 800, maxX: 5000, maxY: 3200 };
  const frame = resolveTableFrame({}, { boardMinSidePx: 2400, halfSpanPx: 1200, eye: { x: 3000, y: 2000 } });
  applyTableFrame(u, frame, { rect, padX: 1000, padY: 800, worldPerPx: 2 });
  ok('eye pushed', u.eye.value.x === 3000 && u.eye.value.w === frame.eye[3]);
  ok('board pushed', u.rect.value.z === 5000 && u.rect.value.w === 3200);
  ok('rim width pushed', u.frame.value.z === frame.rimW);
  ok('pixel size pushed', u.seams.value.z === 2);

  const { floor, overlay } = buildTableMaterials(THREE, u, markCompileDeferrable);
  ok('the floor is opaque (sorts before every token and tile)', floor.transparent === false);
  ok('the overlay is blended', overlay.transparent === true);
  ok(
    'neither writes or tests depth',
    !floor.depthWrite && !floor.depthTest && !overlay.depthWrite && !overlay.depthTest
  );
  ok(
    '⭐ both are marked deferrable (GPU-SAFETY.md)',
    !!floor.userData.msaDeferCompile && !!overlay.userData.msaDeferCompile
  );
  ok(
    'both colour through colorNode, never a raw fragmentNode (the world pass is MRT)',
    !!floor.colorNode && !!overlay.colorNode && !floor.fragmentNode && !overlay.fragmentNode
  );
  ok('both discard early through maskNode', !!floor.maskNode && !!overlay.maskNode);
  ok('the overlay leaves the scene-attr buffer alone', !!overlay.mrtNode);
}
