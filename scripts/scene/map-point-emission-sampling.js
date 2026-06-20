/**
 * @fileoverview Shared emission-point sampling for map point groups.
 *
 * Shape semantics used by particle / glow effects:
 * - point: emit at each authored vertex
 * - line / rope polyline: emit along segment arc length
 * - area: emit throughout polygon interior (grid fill)
 *
 * @module scene/map-point-emission-sampling
 */

/**
 * @param {Array<{x?: number, y?: number}>} points
 * @param {number} [tolerancePx]
 * @returns {boolean}
 */
export function isClosedPolyline(points, tolerancePx = 48) {
  if (!Array.isArray(points) || points.length < 3) return false;
  const ax = Number(points[0]?.x);
  const ay = Number(points[0]?.y);
  const bx = Number(points[points.length - 1]?.x);
  const by = Number(points[points.length - 1]?.y);
  if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) {
    return false;
  }
  const bounds = computePointBounds(points);
  const scaleTol = bounds
    ? Math.max(48, Math.min(320, Math.hypot(bounds.width, bounds.height) * 0.12))
    : 48;
  const tol = Math.max(1, Number(tolerancePx) || scaleTol, scaleTol);
  return Math.hypot(bx - ax, by - ay) <= tol;
}

/**
 * @param {Array<{x?: number, y?: number}>} points
 * @returns {number}
 * @private
 */
function _openPolylineLength(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let len = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const ax = Number(points[i]?.x);
    const ay = Number(points[i]?.y);
    const bx = Number(points[i + 1]?.x);
    const by = Number(points[i + 1]?.y);
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) continue;
    len += Math.hypot(bx - ax, by - ay);
  }
  return len;
}

/**
 * @param {Array<{x?: number, y?: number}>} points
 * @returns {number}
 * @private
 */
function _signedPolygonArea(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    const xi = Number(points[i]?.x);
    const yi = Number(points[i]?.y);
    const xj = Number(points[j]?.x);
    const yj = Number(points[j]?.y);
    if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(xj) || !Number.isFinite(yj)) continue;
    area += xi * yj - xj * yi;
  }
  return area * 0.5;
}

/**
 * Whether an open line/rope polyline should emit as a filled area (e.g. 4-corner
 * regions drawn with the line tool but not snapped closed).
 *
 * @param {Array<{x?: number, y?: number}>} points
 * @returns {boolean}
 * @private
 */
function _shouldPromoteOpenPolylineToArea(points) {
  if (!Array.isArray(points) || points.length < 4) return false;

  const ax = Number(points[0]?.x);
  const ay = Number(points[0]?.y);
  const bx = Number(points[points.length - 1]?.x);
  const by = Number(points[points.length - 1]?.y);
  if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) {
    return false;
  }

  const gap = Math.hypot(bx - ax, by - ay);
  const openLen = _openPolylineLength(points);
  const closedPerim = openLen + gap;
  if (closedPerim <= 1e-4) return false;

  const bounds = computePointBounds(points);
  if (!bounds) return false;

  const gapRatio = gap / closedPerim;
  const absArea = Math.abs(_signedPolygonArea(points));
  const bboxArea = Math.max(1, bounds.width * bounds.height);

  if (gapRatio <= 0.22 && absArea > bboxArea * 0.06) return true;
  if (gapRatio <= 0.35 && absArea > bboxArea * 0.18 && points.length >= 4) return true;
  return false;
}

/**
 * Resolve how an authored group should emit regardless of legacy/mis-set types.
 *
 * @param {{type?: string, points?: Array<{x?: number, y?: number}>}} group
 * @returns {'point'|'line'|'area'}
 */
export function inferMapPointGroupEmissionShape(group) {
  const rawType = String(group?.type || 'point').toLowerCase().trim();
  const points = group?.points;
  const count = Array.isArray(points) ? points.length : 0;

  if (count >= 3) {
    if (rawType === 'area') return 'area';
    if (rawType === 'line' || rawType === 'rope') {
      if (isClosedPolyline(points)) return 'area';
      if (_shouldPromoteOpenPolylineToArea(points)) return 'area';
    }
  }
  if ((rawType === 'line' || rawType === 'rope') && count >= 2) return 'line';
  return 'point';
}

/**
 * Ray-casting point-in-polygon test.
 * @param {number} x
 * @param {number} y
 * @param {Array<{x?: number, y?: number}>} polygon
 * @returns {boolean}
 */
export function isPointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = Number(polygon[i]?.x);
    const yi = Number(polygon[i]?.y);
    const xj = Number(polygon[j]?.x);
    const yj = Number(polygon[j]?.y);
    if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(xj) || !Number.isFinite(yj)) continue;

    const crosses = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi) / Math.max(1e-6, (yj - yi)) + xi));
    if (crosses) inside = !inside;
  }
  return inside;
}

/**
 * @param {Array<{x?: number, y?: number}>} points
 * @returns {{minX:number,minY:number,maxX:number,maxY:number,width:number,height:number,centerX:number,centerY:number}|null}
 */
export function computePointBounds(points) {
  if (!Array.isArray(points) || points.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const p of points) {
    const x = Number(p?.x);
    const y = Number(p?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null;
  }

  const width = Math.max(0, maxX - minX);
  const height = Math.max(0, maxY - minY);
  return {
    minX,
    minY,
    maxX,
    maxY,
    width,
    height,
    centerX: minX + width * 0.5,
    centerY: minY + height * 0.5,
  };
}

/**
 * @param {number} width
 * @param {number} height
 * @param {{strideMin?: number, strideMax?: number, strideDivisor?: number}} [options]
 * @returns {number}
 */
export function resolveEmissionSampleStride(width, height, options = {}) {
  const min = Number.isFinite(options.strideMin) ? options.strideMin : 24;
  const max = Number.isFinite(options.strideMax) ? options.strideMax : 160;
  const divisor = Number.isFinite(options.strideDivisor) ? options.strideDivisor : 24;
  const maxDim = Math.max(1, width, height);
  return Math.max(min, Math.min(max, Math.floor(maxDim / divisor)));
}

/**
 * @param {{emission?: {intensity?: number}}} group
 * @param {{defaultValue?: number, min?: number, max?: number}} [options]
 * @returns {number}
 */
export function resolveMapPointEmissionIntensity(group, options = {}) {
  const defaultValue = Number.isFinite(options.defaultValue) ? options.defaultValue : 1.0;
  const min = Number.isFinite(options.min) ? options.min : 0.05;
  const max = Number.isFinite(options.max) ? options.max : 1.0;
  const i = Number(group?.emission?.intensity);
  if (!Number.isFinite(i)) return defaultValue;
  return Math.max(min, Math.min(max, i));
}

/**
 * @param {number[]} out
 * @param {number} x
 * @param {number} y
 * @param {number} intensity
 * @private
 */
function _pushTriple(out, x, y, intensity) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  out.push(x, y, intensity);
}

/**
 * @param {Array<{x?: number, y?: number}>} points
 * @param {number} intensity
 * @param {number[]} out
 * @private
 */
function _sampleDiscreteVertices(points, intensity, out) {
  for (const point of points) {
    _pushTriple(out, Number(point?.x), Number(point?.y), intensity);
  }
}

/**
 * @param {Array<{x?: number, y?: number}>} points
 * @param {number} intensity
 * @param {number} stepPx
 * @param {number[]} out
 * @private
 */
function _sampleLinePolyline(points, intensity, stepPx, out) {
  const xs = [];
  const ys = [];
  for (const point of points) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    xs.push(x);
    ys.push(y);
  }
  if (xs.length < 2) {
    if (xs.length === 1) _pushTriple(out, xs[0], ys[0], intensity);
    return;
  }

  const segCount = xs.length - 1;
  const segLens = new Float32Array(segCount);
  let totalLen = 0;
  for (let i = 0; i < segCount; i++) {
    const len = Math.hypot(xs[i + 1] - xs[i], ys[i + 1] - ys[i]);
    segLens[i] = len;
    totalLen += len;
  }

  if (totalLen <= 1e-4) {
    _pushTriple(out, xs[0], ys[0], intensity);
    return;
  }

  const step = Math.max(1, stepPx);
  const sampleCount = Math.max(2, Math.ceil(totalLen / step) + 1);
  let segIdx = 0;
  let segStart = 0;

  for (let p = 0; p < sampleCount; p++) {
    const target = (p / (sampleCount - 1)) * totalLen;
    while (segIdx < segCount - 1 && (segStart + segLens[segIdx]) < target) {
      segStart += segLens[segIdx];
      segIdx++;
    }

    const segLen = Math.max(1e-6, segLens[segIdx]);
    const localT = Math.max(0, Math.min(1, (target - segStart) / segLen));
    const x = xs[segIdx] + (xs[segIdx + 1] - xs[segIdx]) * localT;
    const y = ys[segIdx] + (ys[segIdx + 1] - ys[segIdx]) * localT;
    _pushTriple(out, x, y, intensity);
  }
}

/**
 * @param {Array<{x?: number, y?: number}>} polygon
 * @param {number} intensity
 * @param {number} stride
 * @param {boolean} includeVertices
 * @param {number[]} out
 * @private
 */
function _sampleAreaInterior(polygon, intensity, options, out) {
  const bounds = computePointBounds(polygon);
  if (!bounds) return;

  const area = Math.max(1, bounds.width * bounds.height);
  const maxSamples = Number.isFinite(options.areaMaxSamples) ? options.areaMaxSamples : 800;
  const target = Math.min(maxSamples, Math.max(16, Math.ceil(area / (48 * 48))));

  const tris = _triangulatePolygonEarClipping(polygon);
  let interiorCount = 0;
  if (tris.length > 0) {
    for (let i = 0; i < target; i++) {
      const pt = _sampleRandomPointFromTriangles(tris);
      if (!pt) continue;
      _pushTriple(out, pt.x, pt.y, intensity);
      interiorCount += 1;
    }
  }

  const spacing = Number.isFinite(options.areaSpacingPx)
    ? Math.max(8, options.areaSpacingPx)
    : resolveEmissionSampleStride(bounds.width, bounds.height, {
      ...options,
      strideMin: 16,
      strideMax: 96,
      strideDivisor: 16,
    });

  const gridTarget = Math.min(maxSamples, Math.max(16, Math.ceil(area / (spacing * spacing))));
  const gridSample = (xOffset, yOffset) => {
    for (let y = bounds.minY + yOffset; y <= bounds.maxY; y += spacing) {
      for (let x = bounds.minX + xOffset; x <= bounds.maxX; x += spacing) {
        if (!isPointInPolygon(x, y, polygon)) continue;
        _pushTriple(out, x, y, intensity);
        interiorCount += 1;
        if (interiorCount >= gridTarget + target) return;
      }
    }
  };

  if (interiorCount < Math.max(8, Math.floor(target * 0.5))) {
    gridSample(0, 0);
    if (interiorCount < Math.min(12, Math.floor(gridTarget / 4))) {
      gridSample(spacing * 0.5, spacing * 0.5);
    }
  }

  if (interiorCount === 0 && isPointInPolygon(bounds.centerX, bounds.centerY, polygon)) {
    _pushTriple(out, bounds.centerX, bounds.centerY, intensity);
    interiorCount += 1;
  }

  if (interiorCount < Math.max(8, Math.floor(target * 0.25)) && tris.length > 0) {
    const need = Math.min(target, Math.max(8, target - interiorCount));
    for (let i = 0; i < need; i++) {
      const pt = _sampleRandomPointFromTriangles(tris);
      if (!pt) continue;
      _pushTriple(out, pt.x, pt.y, intensity);
      interiorCount += 1;
    }
  }

  if (options.includeVertices !== false) {
    for (const p of polygon) {
      _pushTriple(out, Number(p?.x), Number(p?.y), intensity);
    }
  }
}

/**
 * Sample world-space emission triples [x, y, intensity, ...] from a map point group.
 *
 * @param {{type?: string, points?: Array<{x?: number, y?: number}>, emission?: {intensity?: number}}} group
 * @param {object} [options]
 * @returns {Float32Array|null}
 */
export function sampleMapPointGroupWorldTriples(group, options = {}) {
  const points = group?.points;
  if (!Array.isArray(points) || points.length === 0) return null;

  const intensity = resolveMapPointEmissionIntensity(group, options);
  const out = [];
  const shape = inferMapPointGroupEmissionShape(group);

  if (shape === 'area') {
    const bounds = computePointBounds(points);
    if (!bounds) return null;
    _sampleAreaInterior(points, intensity, options, out);
  } else if (shape === 'line') {
    const bounds = computePointBounds(points);
    if (!bounds) return null;
    const stepPx = Number.isFinite(options.lineStepPx)
      ? options.lineStepPx
      : resolveEmissionSampleStride(bounds.width, bounds.height, options);
    _sampleLinePolyline(points, intensity, stepPx, out);
  } else {
    _sampleDiscreteVertices(points, intensity, out);
  }

  return out.length ? new Float32Array(out) : null;
}

/**
 * Convert packed world triples to fire-style scene UV triples.
 *
 * @param {Float32Array} worldTriples
 * @param {number} sceneW
 * @param {number} sceneH
 * @param {number} sceneX
 * @param {number} sceneY
 * @returns {Float32Array}
 */
export function worldTriplesToFireSceneUvTriples(worldTriples, sceneW, sceneH, sceneX, sceneY) {
  const out = new Float32Array(worldTriples.length);
  for (let i = 0; i < worldTriples.length; i += 3) {
    const wx = worldTriples[i];
    const wy = worldTriples[i + 1];
    // FireMaskShape expects v pre-flipped: worldY = sceneY + (1 - v) * sceneH.
    out[i] = (wx - sceneX) / sceneW;
    out[i + 1] = 1.0 - ((wy - sceneY) / sceneH);
    out[i + 2] = worldTriples[i + 2];
  }
  return out;
}

/**
 * Sample scene-UV fire spawn triples [u, v, intensity, ...] from a map point group.
 *
 * @param {{type?: string, points?: Array<{x?: number, y?: number}>, emission?: {intensity?: number}}} group
 * @param {number} sceneW
 * @param {number} sceneH
 * @param {number} sceneX
 * @param {number} sceneY
 * @param {object} [options]
 * @returns {Float32Array|null}
 */
export function sampleMapPointGroupSceneUvTriples(group, sceneW, sceneH, sceneX, sceneY, options = {}) {
  const worldTriples = sampleMapPointGroupWorldTriples(group, options);
  if (!worldTriples) return null;
  return worldTriplesToFireSceneUvTriples(worldTriples, sceneW, sceneH, sceneX, sceneY);
}

/**
 * Sample emission points as plain objects for effects that need metadata per point.
 *
 * @param {{type?: string, points?: Array<{x?: number, y?: number}>, emission?: {intensity?: number}}} group
 * @param {object} [options]
 * @returns {Array<{x:number,y:number,intensity:number}>}
 */
export function sampleMapPointGroupEmissionPoints(group, options = {}) {
  const triples = sampleMapPointGroupWorldTriples(group, options);
  if (!triples) return [];

  const out = [];
  for (let i = 0; i < triples.length; i += 3) {
    out.push({
      x: triples[i],
      y: triples[i + 1],
      intensity: triples[i + 2],
    });
  }
  return out;
}

/**
 * Pick a random world point on a map-point line polyline (uniform by arc length).
 *
 * @param {Array<{x?: number, y?: number}>} points
 * @returns {{x:number,y:number}|null}
 */
export function sampleRandomWorldPointOnPolyline(points) {
  const xs = [];
  const ys = [];
  for (const point of points) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    xs.push(x);
    ys.push(y);
  }
  if (xs.length === 0) return null;
  if (xs.length === 1) return { x: xs[0], y: ys[0] };

  const segLens = [];
  let totalLen = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    const len = Math.hypot(xs[i + 1] - xs[i], ys[i + 1] - ys[i]);
    segLens.push(len);
    totalLen += len;
  }
  if (totalLen <= 1e-6) return { x: xs[0], y: ys[0] };

  let target = Math.random() * totalLen;
  let segIdx = 0;
  while (segIdx < segLens.length - 1 && target > segLens[segIdx]) {
    target -= segLens[segIdx];
    segIdx++;
  }
  const segLen = Math.max(1e-6, segLens[segIdx]);
  const localT = target / segLen;
  return {
    x: xs[segIdx] + (xs[segIdx + 1] - xs[segIdx]) * localT,
    y: ys[segIdx] + (ys[segIdx + 1] - ys[segIdx]) * localT,
  };
}

/**
 * @param {Array<{x?: number, y?: number}>} points
 * @returns {number}
 * @private
 */
function _computePolylineArcLength(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let totalLen = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const ax = Number(points[i]?.x);
    const ay = Number(points[i]?.y);
    const bx = Number(points[i + 1]?.x);
    const by = Number(points[i + 1]?.y);
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) continue;
    totalLen += Math.hypot(bx - ax, by - ay);
  }
  return totalLen;
}

/**
 * Whether a world-space point lies inside a map-point group's emission region.
 * Uses inferred shape (point / line / area), not raw group.type.
 *
 * @param {number} worldX
 * @param {number} worldY
 * @param {{type?: string, points?: Array<{x?: number, y?: number}>}} group
 * @param {number} [radiusPx=125]
 * @returns {boolean}
 */
export function isWorldPointInMapPointGroup(worldX, worldY, group, radiusPx = 125) {
  const points = Array.isArray(group?.points) ? group.points : [];
  if (points.length === 0) return false;

  const shape = inferMapPointGroupEmissionShape(group);
  const radius = Math.max(48, Number(radiusPx) || 125);
  const radiusSq = radius * radius;

  if (shape === 'area') {
    return isPointInPolygon(worldX, worldY, points);
  }

  if (shape === 'line') {
    for (let i = 0; i < points.length - 1; i++) {
      const ax = Number(points[i]?.x);
      const ay = Number(points[i]?.y);
      const bx = Number(points[i + 1]?.x);
      const by = Number(points[i + 1]?.y);
      if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) continue;
      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      if (lenSq <= 1e-6) {
        const ddx = worldX - ax;
        const ddy = worldY - ay;
        if (ddx * ddx + ddy * ddy <= radiusSq) return true;
        continue;
      }
      const t = Math.max(0, Math.min(1, ((worldX - ax) * dx + (worldY - ay) * dy) / lenSq));
      const px = ax + t * dx;
      const py = ay + t * dy;
      const distSq = (worldX - px) * (worldX - px) + (worldY - py) * (worldY - py);
      if (distSq <= radiusSq) return true;
    }
    return false;
  }

  for (const p of points) {
    const px = Number(p?.x);
    const py = Number(p?.y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    const dx = worldX - px;
    const dy = worldY - py;
    if (dx * dx + dy * dy <= radiusSq) return true;
  }
  return false;
}

/**
 * Resolve which floor indices a map-point group should appear on.
 *
 * @param {{metadata?: {levelBinding?: {mode?: string, bottom?: number, top?: number}}}} group
 * @param {Array<{elevationMin?: number, elevationMax?: number}>} floors
 * @returns {number[]}
 */
export function resolveMapPointGroupFloorIndices(group, floors) {
  if (!Array.isArray(floors) || floors.length === 0) return [0];

  const binding = group?.metadata?.levelBinding;
  const mode = String(binding?.mode || 'all-levels');
  if (mode !== 'locked') {
    return floors.map((_, idx) => idx);
  }

  const bottom = Number(binding?.bottom);
  const top = Number(binding?.top);
  if (!Number.isFinite(bottom) || !Number.isFinite(top)) {
    const activeFloor = window.MapShine?.floorStack?.getActiveFloor?.();
    const idx = Number.isFinite(activeFloor?.index) ? activeFloor.index : 0;
    return [idx];
  }

  const matched = [];
  for (let i = 0; i < floors.length; i++) {
    const floor = floors[i];
    const fMin = Number(floor?.elevationMin);
    const fMax = Number(floor?.elevationMax);
    if (!Number.isFinite(fMin) || !Number.isFinite(fMax)) continue;
    if (top >= fMin && bottom <= fMax) matched.push(i);
  }

  if (matched.length > 0) return matched;
  const activeFloor = window.MapShine?.floorStack?.getActiveFloor?.();
  const idx = Number.isFinite(activeFloor?.index) ? activeFloor.index : 0;
  return [idx];
}

/**
 * Emission weight for particle budget scaling (sqrt-compressed, intensity-scaled).
 *
 * @param {{type?: string, points?: Array<{x?: number, y?: number}>, emission?: {intensity?: number}}} group
 * @param {Float32Array|null} [sampleTriples=null] - Precomputed pool; computed if omitted
 * @param {{lineReferencePx?: number, min?: number}} [options]
 * @returns {number}
 */
export function resolveMapPointGroupEmissionWeight(group, sampleTriples = null, options = {}) {
  const intensity = resolveMapPointEmissionIntensity(group, options);
  const shape = inferMapPointGroupEmissionShape(group);
  const minWeight = Number.isFinite(options.min) ? options.min : 0.06;
  const lineRef = Number.isFinite(options.lineReferencePx) ? options.lineReferencePx : 400;

  let raw = 1;
  if (shape === 'area') {
    const triples = sampleTriples ?? sampleMapPointGroupWorldTriples(group, options);
    const count = triples ? triples.length / 3 : 0;
    raw = Math.sqrt(Math.max(1, count));
  } else if (shape === 'line') {
    const arcLen = _computePolylineArcLength(group?.points);
    raw = Math.sqrt(Math.max(1, arcLen / Math.max(1, lineRef)));
  } else {
    const count = Array.isArray(group?.points) ? group.points.length : 0;
    raw = Math.sqrt(Math.max(1, count));
  }

  return Math.max(minWeight, raw * intensity);
}

/**
 * Canonical precomputed spawn pool for map-point particle effects.
 *
 * @param {{type?: string, points?: Array<{x?: number, y?: number}>, emission?: {intensity?: number}}} group
 * @param {object} [options]
 * @returns {{shape: 'point'|'line'|'area', triples: Float32Array|null}}
 */
export function buildMapPointGroupSpawnPool(group, options = {}) {
  const shape = inferMapPointGroupEmissionShape(group);
  const triples = sampleMapPointGroupWorldTriples(group, options);
  return { shape, triples };
}

/**
 * 2D cross product (AB x AC).
 * @private
 */
function _cross2(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/**
 * @param {number} px
 * @param {number} py
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @param {number} cx
 * @param {number} cy
 * @returns {boolean}
 * @private
 */
function _pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const c1 = _cross2(ax, ay, bx, by, px, py);
  const c2 = _cross2(bx, by, cx, cy, px, py);
  const c3 = _cross2(cx, cy, ax, ay, px, py);
  const hasNeg = (c1 < -1e-8) || (c2 < -1e-8) || (c3 < -1e-8);
  const hasPos = (c1 > 1e-8) || (c2 > 1e-8) || (c3 > 1e-8);
  return !(hasNeg && hasPos);
}

/**
 * @param {Array<{x:number,y:number}>} verts
 * @param {number[]} indices
 * @param {number} i
 * @param {number} winding
 * @returns {boolean}
 * @private
 */
function _isEar(verts, indices, i, winding) {
  const n = indices.length;
  if (n < 3) return false;

  const iPrev = indices[(i - 1 + n) % n];
  const iCurr = indices[i];
  const iNext = indices[(i + 1) % n];
  const ax = verts[iPrev].x;
  const ay = verts[iPrev].y;
  const bx = verts[iCurr].x;
  const by = verts[iCurr].y;
  const cx = verts[iNext].x;
  const cy = verts[iNext].y;

  const cross = _cross2(ax, ay, bx, by, cx, cy);
  if (winding > 0 && cross <= 1e-8) return false;
  if (winding < 0 && cross >= -1e-8) return false;

  for (let j = 0; j < n; j++) {
    const idx = indices[j];
    if (idx === iPrev || idx === iCurr || idx === iNext) continue;
    const p = verts[idx];
    if (_pointInTriangle(p.x, p.y, ax, ay, bx, by, cx, cy)) return false;
  }
  return true;
}

/**
 * Ear-clipping triangulation for simple polygons (convex or concave).
 *
 * @param {Array<{x?: number, y?: number}>} polygon
 * @returns {{ax:number,ay:number,bx:number,by:number,cx:number,cy:number,area:number}[]}
 */
export function triangulateMapPointPolygon(polygon) {
  return _triangulatePolygonEarClipping(polygon);
}

/**
 * @param {Array<{x?: number, y?: number}>} polygon
 * @returns {{ax:number,ay:number,bx:number,by:number,cx:number,cy:number,area:number}[]}
 * @private
 */
function _triangulatePolygonEarClipping(polygon) {
  const verts = [];
  for (const p of polygon) {
    const x = Number(p?.x);
    const y = Number(p?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    verts.push({ x, y });
  }
  if (verts.length >= 2) {
    const fx = verts[0].x;
    const fy = verts[0].y;
    const lx = verts[verts.length - 1].x;
    const ly = verts[verts.length - 1].y;
    if (Math.hypot(lx - fx, ly - fy) <= 1) verts.pop();
  }
  if (verts.length < 3) return [];

  if (verts.length === 3) {
    const area = _triangleArea(verts[0].x, verts[0].y, verts[1].x, verts[1].y, verts[2].x, verts[2].y);
    if (area <= 1e-6) return [];
    return [{
      ax: verts[0].x,
      ay: verts[0].y,
      bx: verts[1].x,
      by: verts[1].y,
      cx: verts[2].x,
      cy: verts[2].y,
      area,
    }];
  }

  const winding = _signedPolygonArea(verts) >= 0 ? 1 : -1;
  const indices = verts.map((_, idx) => idx);
  const tris = [];
  let guard = 0;

  while (indices.length > 3 && guard++ < 4096) {
    let clipped = false;
    for (let i = 0; i < indices.length; i++) {
      if (!_isEar(verts, indices, i, winding)) continue;

      const n = indices.length;
      const iPrev = indices[(i - 1 + n) % n];
      const iCurr = indices[i];
      const iNext = indices[(i + 1) % n];
      const ax = verts[iPrev].x;
      const ay = verts[iPrev].y;
      const bx = verts[iCurr].x;
      const by = verts[iCurr].y;
      const cx = verts[iNext].x;
      const cy = verts[iNext].y;
      const area = _triangleArea(ax, ay, bx, by, cx, cy);
      if (area > 1e-6) {
        tris.push({ ax, ay, bx, by, cx, cy, area });
      }
      indices.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }

  if (indices.length === 3) {
    const a = verts[indices[0]];
    const b = verts[indices[1]];
    const c = verts[indices[2]];
    const area = _triangleArea(a.x, a.y, b.x, b.y, c.x, c.y);
    if (area > 1e-6) {
      tris.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, cx: c.x, cy: c.y, area });
    }
  }

  return tris;
}

/**
 * Pick a random point uniformly from a list of area-weighted triangles.
 * @param {{ax:number,ay:number,bx:number,by:number,cx:number,cy:number,area:number}[]} tris
 * @returns {{x:number,y:number}|null}
 * @private
 */
function _sampleRandomPointFromTriangles(tris) {
  if (!tris.length) return null;

  let totalArea = 0;
  for (const tri of tris) totalArea += tri.area;
  if (totalArea <= 1e-6) return null;

  let pick = Math.random() * totalArea;
  for (const tri of tris) {
    pick -= tri.area;
    if (pick <= 0) {
      return _sampleRandomPointInTriangle(tri.ax, tri.ay, tri.bx, tri.by, tri.cx, tri.cy);
    }
  }

  const last = tris[tris.length - 1];
  return _sampleRandomPointInTriangle(last.ax, last.ay, last.bx, last.by, last.cx, last.cy);
}

/**
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @param {number} cx
 * @param {number} cy
 * @returns {number}
 * @private
 */
function _triangleArea(ax, ay, bx, by, cx, cy) {
  return Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) * 0.5;
}

/**
 * Uniform random point in a triangle (barycentric trick).
 * @private
 */
function _sampleRandomPointInTriangle(ax, ay, bx, by, cx, cy) {
  let u = Math.random();
  let v = Math.random();
  if (u + v > 1) {
    u = 1 - u;
    v = 1 - v;
  }
  return {
    x: ax + u * (bx - ax) + v * (cx - ax),
    y: ay + u * (by - ay) + v * (cy - ay),
  };
}

/**
 * Pick a random world point inside a polygon.
 * Ear-clips the polygon into triangles, then picks a uniform random point
 * in an area-weighted triangle (works for convex and concave simple polygons).
 *
 * @param {Array<{x?: number, y?: number}>} polygon
 * @param {{maxAttempts?: number}} [options]
 * @returns {{x:number,y:number}|null}
 */
export function sampleRandomWorldPointInPolygon(polygon, options = {}) {
  const tris = _triangulatePolygonEarClipping(polygon);
  if (tris.length > 0) {
    const pt = _sampleRandomPointFromTriangles(tris);
    if (pt) return pt;
  }

  const bounds = computePointBounds(polygon);
  if (!bounds) return null;

  const bboxArea = Math.max(1, bounds.width * bounds.height);
  const defaultAttempts = Math.max(64, Math.min(512, Math.ceil(bboxArea / 2500)));
  const maxAttempts = Number.isFinite(options.maxAttempts) ? options.maxAttempts : defaultAttempts;
  for (let i = 0; i < maxAttempts; i++) {
    const x = bounds.minX + Math.random() * bounds.width;
    const y = bounds.minY + Math.random() * bounds.height;
    if (isPointInPolygon(x, y, polygon)) return { x, y };
  }

  if (isPointInPolygon(bounds.centerX, bounds.centerY, polygon)) {
    return { x: bounds.centerX, y: bounds.centerY };
  }
  return null;
}

/**
 * Pick a random emission site for a map point group (called per particle spawn).
 *
 * @param {{type?: string, points?: Array<{x?: number, y?: number}>, emission?: {intensity?: number}}} group
 * @param {object} [options]
 * @returns {{x:number,y:number,intensity:number}|null}
 */
export function sampleRandomWorldPointInMapPointGroup(group, options = {}) {
  const points = group?.points;
  if (!Array.isArray(points) || points.length === 0) return null;

  const intensity = resolveMapPointEmissionIntensity(group, options);
  const shape = inferMapPointGroupEmissionShape(group);

  if (shape === 'area') {
    const pt = sampleRandomWorldPointInPolygon(points, options);
    return pt ? { x: pt.x, y: pt.y, intensity } : null;
  }

  if (shape === 'line') {
    const pt = sampleRandomWorldPointOnPolyline(points);
    return pt ? { x: pt.x, y: pt.y, intensity } : null;
  }

  const idx = Math.floor(Math.random() * points.length);
  const p = points[idx];
  const x = Number(p?.x);
  const y = Number(p?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, intensity };
}

/**
 * Dense random scene-UV samples for fire glow clustering (not particle spawn sites).
 *
 * @param {{type?: string, points?: Array<{x?: number, y?: number}>, emission?: {intensity?: number}}} group
 * @param {number} sceneW
 * @param {number} sceneH
 * @param {number} sceneX
 * @param {number} sceneY
 * @param {object} [options]
 * @returns {Float32Array|null}
 */
export function sampleMapPointGroupGlowSceneUvTriples(group, sceneW, sceneH, sceneX, sceneY, options = {}) {
  const shape = inferMapPointGroupEmissionShape(group);
  if (shape !== 'area') {
    return sampleMapPointGroupSceneUvTriples(group, sceneW, sceneH, sceneX, sceneY, options);
  }

  const polygon = group?.points;
  if (!Array.isArray(polygon) || polygon.length < 3) return null;

  const intensity = resolveMapPointEmissionIntensity(group, options);
  const target = Number.isFinite(options.glowSampleCount)
    ? Math.max(8, Math.floor(options.glowSampleCount))
    : 96;
  const out = [];
  let added = 0;
  let attempts = 0;
  const maxAttempts = target * 24;

  while (added < target && attempts < maxAttempts) {
    attempts++;
    const pt = sampleRandomWorldPointInPolygon(polygon, { maxAttempts: 1 });
    if (!pt) continue;
    out.push(
      (pt.x - sceneX) / sceneW,
      1.0 - ((pt.y - sceneY) / sceneH),
      intensity,
    );
    added++;
  }

  if (out.length < 3) {
    return sampleMapPointGroupSceneUvTriples(group, sceneW, sceneH, sceneX, sceneY, options);
  }
  return new Float32Array(out);
}
