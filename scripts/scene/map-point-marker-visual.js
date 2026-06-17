/**
 * Shared map-point handle / preview marker geometry.
 * Compact rings so clustered candle flames remain easy to place.
 */

/** Outer white ring (inner radius, outer radius). */
export const MAP_POINT_MARKER_RING = Object.freeze({ inner: 4, outer: 6.5 });

/** Filled effect-color disc radius. */
export const MAP_POINT_MARKER_FILL_RADIUS = 3.25;

/** Center anchor dot radius. */
export const MAP_POINT_MARKER_CENTER_RADIUS = 1.25;

/** Cursor preview ring while drawing (inner, outer). */
export const MAP_POINT_CURSOR_RING = Object.freeze({ inner: 3, outer: 5.5 });

/** Ring/circle segment count (lower = simpler mesh). */
export const MAP_POINT_MARKER_SEGMENTS = 16;

/** World-space pick radius for group/handle hit tests. */
export const MAP_POINT_HIT_RADIUS = 10;

/**
 * Build a compact point marker group for helpers and draw previews.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} color - Hex color
 * @param {number} index - Point index (render order)
 * @param {{ groupId?: string, renderOrderBase?: number }} [options]
 * @returns {THREE.Group|null}
 */
export function createMapPointMarkerGroup(x, y, z, color, index, options = {}) {
  const THREE = window.THREE;
  if (!THREE) return null;

  const group = new THREE.Group();
  group.position.set(x, y, z);

  const ring = MAP_POINT_MARKER_RING;
  const segments = MAP_POINT_MARKER_SEGMENTS;
  const matOpts = {
    transparent: true,
    depthTest: false,
    side: THREE.DoubleSide,
  };

  const outerRing = new THREE.RingGeometry(ring.inner, ring.outer, segments);
  const outerMat = new THREE.MeshBasicMaterial({
    ...matOpts,
    color: 0xffffff,
    opacity: 0.92,
  });
  group.add(new THREE.Mesh(outerRing, outerMat));

  const innerCircle = new THREE.CircleGeometry(MAP_POINT_MARKER_FILL_RADIUS, segments);
  const innerMat = new THREE.MeshBasicMaterial({
    ...matOpts,
    color,
    opacity: 0.82,
  });
  const innerMesh = new THREE.Mesh(innerCircle, innerMat);
  innerMesh.position.z = 0.1;
  group.add(innerMesh);

  const centerDot = new THREE.CircleGeometry(MAP_POINT_MARKER_CENTER_RADIUS, Math.max(8, segments / 2));
  const centerMat = new THREE.MeshBasicMaterial({
    ...matOpts,
    color: 0x000000,
    opacity: 0.55,
  });
  const centerMesh = new THREE.Mesh(centerDot, centerMat);
  centerMesh.position.z = 0.2;
  group.add(centerMesh);

  const renderOrderBase = Number.isFinite(options.renderOrderBase) ? options.renderOrderBase : 1001;
  group.renderOrder = renderOrderBase + index;

  if (typeof options.groupId === 'string' && options.groupId.length > 0) {
    const data = {
      type: 'mapPointHandle',
      groupId: options.groupId,
      pointIndex: index,
    };
    group.userData = { ...(group.userData || {}), ...data };
    group.traverse((child) => {
      child.userData = { ...(child.userData || {}), ...data };
    });
  }

  return group;
}

/**
 * Build the cursor preview ring used while placing points.
 * @param {number} color - Hex color
 * @returns {THREE.Mesh|null}
 */
export function createMapPointCursorPreviewMesh(color) {
  const THREE = window.THREE;
  if (!THREE) return null;

  const ring = MAP_POINT_CURSOR_RING;
  const cursorGeo = new THREE.RingGeometry(ring.inner, ring.outer, MAP_POINT_MARKER_SEGMENTS);
  const cursorMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.75,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(cursorGeo, cursorMat);
}
