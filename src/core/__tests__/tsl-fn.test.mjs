/**
 * LAYOUT FUNCTIONS AND SHADER SIZE BUDGETS (2026-11-03, epic mmp-8gf.1) — `core/tsl-fn.js`.
 *
 *   1. The mechanism: a `layoutFn` helper called five times is ONE WGSL function and five calls; the same helper
 *      written as a plain arrow is five pasted copies. If three ever changes how layouts emit, this says so first.
 *   2. The budgets: the shaders that blew up before the layout pass are built for real (three's own WGSL builder,
 *      no GPU) and held under a size that their old form could never meet. Budgets sit ~25-35% above the size they
 *      shipped at, so ordinary growth passes and a re-pasted helper does not (the old sizes are in each line).
 *   3. The detector the pipeline governor runs on every heavy shader (`repeatShare`) separates the two.
 */
import * as THREE from '../../vendor/three/three.webgpu.js';
import { layoutFn, sharedFn, layoutLeaks } from '../tsl-fn.js';
import { computeWgsl, materialWgsl, fakeRenderer, stubTexture, wgslFunctionNames } from './wgsl-harness.mjs';
import { repeatShare, REPEAT_SHARE_WARN } from '../../vt/pipeline-governor.js';
import {
  allocateCritterBuffers,
  createCritterEngine,
  allocateWindCells,
} from '../../effects/particles/critter-runtime.js';
import { createCritterZoneBuffer } from '../../effects/particles/critter-zone-buffer.js';
import { critterTierPlan, CRITTER_TIER_COUNT } from '../../effects/critters/critter-species.js';
import { createWindHandle } from '../../world/index.js';
import { createWindowRain } from '../../effects/window/window-rain.js';
import { buildSpecularSurfaceMaterial } from '../../effects/specular/specular-render.js';
import { buildWorldSpaceOutdoorsGate } from '../../effects/lighting/environmental-light.js';

const TSL = THREE.TSL;
const { float, vec2, sin, fract, dot, uniform, vec4, texture } = TSL;

/** The critter UPDATE kernel of one kind, at the top rung (every feature on). */
function critterUpdateKernelChars(kind, family, wind) {
  const cap = 64;
  const memory = allocateCritterBuffers(THREE, cap);
  const zoneBuffer = createCritterZoneBuffer({ THREE, maxCells: 4096, homeCapacities: [cap] });
  const deps = {};
  if (wind) {
    const cols = 8;
    const rows = 8;
    deps.windHandle = createWindHandle({
      version: 1,
      ambientWind: { directionDeg: uniform(0), speed01: uniform(0.3) },
      grid: { originX: 0, originY: 0, cellSize: 25, cols, rows },
      cells: { openness: new Float32Array(cols * rows).fill(1) },
    });
    deps.windCells = allocateWindCells(THREE, cols * rows);
  }
  const tex = () => texture(stubTexture());
  const engine = createCritterEngine({
    THREE,
    kind,
    memory,
    zoneBuffer,
    plan: critterTierPlan(family, CRITTER_TIER_COUNT - 1),
    illumTexNode: tex(),
    colorationTexNode: tex(),
    depthTexNode: tex(),
    depthFlagsTexNode: tex(),
    ...deps,
  });
  engine.setZone({
    field: { originX: 0, originY: 0, cellW: 10, cellH: 10, cols: 20, rows: 20, signature: 1 },
    homesOffset: zoneBuffer.sectionOffsets[0],
    population: 16,
  });
  engine.setActive(16);
  const captured = [];
  const renderer = fakeRenderer(captured);
  engine.step(renderer, { dtSec: 0.016, tMs: 1000, worldRect: { minX: 0, minY: 0, maxX: 200, maxY: 200 } });
  // step() runs the seed kernel first on a fresh engine, then the update kernel: the update is the last one.
  return Math.max(...captured.map((n) => computeWgsl(n, renderer).length));
}

export function run(t) {
  // ── 1. THE MECHANISM ────────────────────────────────────────────────────
  const hashBody = ({ p }) => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453));
  const laid = layoutFn(TSL, 'msaTestHash', { p: 'vec2' }, 'float', hashBody);
  const inline = (p) => hashBody({ p });
  const P = vec2(uniform(1), uniform(2));
  const sum = (h) => [0, 1, 2, 3, 4].reduce((a, k) => a.add(h(P.add(k))), float(0));
  const withLayout = materialWgsl(vec4(sum(laid), 0, 0, 1)).fragment;
  const withoutLayout = materialWgsl(vec4(sum(inline), 0, 0, 1)).fragment;
  const names = wgslFunctionNames(withLayout);
  t.ok('a layoutFn helper is emitted as ONE WGSL function', names.filter((n) => n === 'msaTestHash').length === 1);
  t.ok('…and called once per use (1 declaration + 5 calls)', (withLayout.match(/msaTestHash\b/g) || []).length === 6);
  t.ok(
    'the inline form pastes the body per call (5 copies of the hash constant)',
    (withoutLayout.match(/43758\.5453/g) || []).length === 5
  );
  t.ok('…while the layout form carries it once', (withLayout.match(/43758\.5453/g) || []).length === 1);

  const s1 = sharedFn(TSL, 'msaTestShared', { x: 'float' }, 'float', ({ x }) => x.mul(2));
  const s2 = sharedFn(TSL, 'msaTestShared', { x: 'float' }, 'float', ({ x }) => x.mul(3));
  t.ok('sharedFn returns the SAME function for the same name (stable WGSL for every shader)', s1 === s2);
  let threw = false;
  try {
    layoutFn(TSL, 'bad name', {}, 'float', () => float(0));
  } catch {
    threw = true;
  }
  t.ok('a name that is not a WGSL identifier is refused', threw);

  // ── 2. THE BUDGETS ──────────────────────────────────────────────────────
  const budget = (label, chars, max, was) =>
    t.ok(`${label}: ${chars} chars ≤ ${max} (was ${was} before the layout pass)`, chars <= max);
  budget('fly update kernel', critterUpdateKernelChars('fly', 'fly'), 110_000, '391k');
  budget('firefly update kernel', critterUpdateKernelChars('firefly', 'firefly'), 70_000, '255k');
  budget('dust (mote) update kernel, wind grid', critterUpdateKernelChars('mote', 'mote', true), 72_000, '245k');

  const rain = createWindowRain({
    THREE,
    flowDirsTexture: stubTexture(),
    flowAuxTexture: stubTexture(),
    viewSpanNode: uniform(1000),
  });
  const r = rain.build({ maskGated: () => float(0.5) });
  const rainWgsl = materialWgsl(vec4(r.offsetPx, r.gain, 1)).fragment;
  budget('window rain on glass', rainWgsl.length, 62_000, '169k');
  const rainFns = wgslFunctionNames(rainWgsl);
  t.ok('window rain: every WGSL function name is unique in its shader', new Set(rainFns).size === rainFns.length);
  t.ok(
    'window rain: its four helpers are real functions',
    ['msaRainHash', 'msaRainValueNoise', 'msaRainSplatLayer', 'msaRainFacetFrame'].every((n) => rainFns.includes(n))
  );

  const spec = buildSpecularSurfaceMaterial({
    THREE,
    maskTexture: stubTexture(),
    islandPackTexture: stubTexture(),
    illumTexture: stubTexture(),
    depthTexture: stubTexture(),
    shapeTexture: stubTexture(),
    timeMsNode: uniform(float(0)),
    uViewRect: uniform(vec4(0, 0, 100, 100)),
    uOutdoorsRect: uniform(vec4(0, 0, 100, 100)),
    outdoorsTexNode: texture(stubTexture()),
    buildOutdoorsGate: buildWorldSpaceOutdoorsGate,
  });
  const specWgsl = materialWgsl(spec.specularMaterial).fragment;
  budget('specular surface (top tier, shape map)', specWgsl.length, 76_000, '81k');
  t.ok(
    'specular: the cell blob is one shared function',
    wgslFunctionNames(specWgsl).filter((n) => n === 'msaSpecCellBlob').length === 1
  );

  // ── 2b. A LAYOUT BODY READS ONLY ITS PARAMETERS ─────────────────────────
  // three caches a layout function's code per RENDERER, so one rain feeding two shaders through ONE renderer is
  // the live case that failed ("struct member nodeUniform1 not found"). Build it exactly that way.
  const shared = fakeRenderer();
  const rain2 = createWindowRain({
    THREE,
    flowDirsTexture: stubTexture(),
    flowAuxTexture: stubTexture(),
    viewSpanNode: uniform(1000),
  });
  const first = materialWgsl(vec4(rain2.build().offsetPx, 0, 1), shared).fragment;
  const second = materialWgsl(vec4(rain2.build({ maskGated: () => float(0.5) }).gain, 0, 0, 1), shared).fragment;
  t.ok(
    `window rain, first of two shaders: no layout body reads a binding (${JSON.stringify(layoutLeaks(first))})`,
    layoutLeaks(first).length === 0
  );
  t.ok(
    `window rain, second shader: none either (${JSON.stringify(layoutLeaks(second))})`,
    layoutLeaks(second).length === 0
  );
  t.ok('specular: no layout body reads a binding', layoutLeaks(specWgsl).length === 0);
  const uLeak = uniform(float(2));
  const leaky = layoutFn(TSL, 'msaTestLeaky', { x: 'float' }, 'float', ({ x }) => x.mul(uLeak));
  const leakWgsl = materialWgsl(vec4(leaky(float(1)), 0, 0, 1)).fragment;
  t.ok(
    'layoutLeaks catches a body that reads a uniform',
    layoutLeaks(leakWgsl).some((l) => l.name === 'msaTestLeaky')
  );

  // ── 3. THE DETECTOR ─────────────────────────────────────────────────────
  t.ok(
    `repeatShare: the fixed rain reads below the warning (${repeatShare(rainWgsl).toFixed(2)} < ${REPEAT_SHARE_WARN})`,
    repeatShare(rainWgsl) < REPEAT_SHARE_WARN
  );
  const pasted = [
    '@compute fn main() {',
    ...Array.from({ length: 400 }, (_, i) => `  nodeVar${i} = fract( sin( nodeVar${i + 1} * 43758.5453 ) );`),
    '}',
  ].join('\n');
  t.ok('repeatShare: a body pasted 400 times reads above it', repeatShare(pasted) >= REPEAT_SHARE_WARN);
}
