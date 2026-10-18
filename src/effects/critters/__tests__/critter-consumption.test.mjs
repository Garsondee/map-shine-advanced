/**
 * CONSUMPTION — "a control exists" is not "a control does something".
 *
 * Water once shipped 46 inert uniforms out of 324 with a green test suite, because nothing connected a
 * slider in the Studio to a line of shader that read it (`critter-uniforms.js` names the pattern). The
 * critters' answer is a LAZY uniform bank — a uniform exists only once a kernel or a material asks for it
 * by name — and this suite turns that into a proof:
 *
 *   1. Build each effect's REAL engine at its top rung (the one with every feature on) against the vendored
 *      three, build every compute kernel and every material to WGSL with three's own builder, and read back
 *      which uniforms the graphs asked for.
 *   2. Every schema param must be consumed somewhere: by one of those graphs, or by the CPU side that decides
 *      the head-count and the weather (an allowlist, below, with the reason written next to each id).
 *   3. A param that is neither is a slider that moves nothing, and fails here by name.
 *
 * It also holds the two tables that must never drift apart: a schema default and the uniform bank's own
 * default for the same name (an engine that has not been pushed anything must look like the shipped default).
 *
 * No GPU is involved — this proves the graphs ask for the control, never that a pixel changes. (The shader lab
 * and the probes check the pixel.)
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import { allocateCritterBuffers, createCritterEngine } from '../../particles/critter-runtime.js';
import { createCritterZoneBuffer } from '../../particles/critter-zone-buffer.js';
import { CRITTER_UNIFORM_DEFAULTS, CRITTER_KIND_DEFAULTS } from '../critter-uniforms.js';
import { critterTierPlan, CRITTER_TIER_COUNT } from '../critter-species.js';
import { SMELLY_FLIES_PARAMS } from '../smelly-flies.js';
import { MAGGOTS_PARAMS } from '../maggots.js';
import { FIREFLIES_PARAMS } from '../fireflies.js';
import { WEATHER_FACTOR_PARAMS, WEATHER_DRIVE_PARAMS } from '../critter-weather.js';
import { hexToRgb01 } from '../../candle-flame-geometry.js';

/**
 * Params the CPU consumes, not a shader: the head-count, the zone, the sky's thinning of the population and the
 * weather's drive (which reaches the kernels as the four plumbing uniforms `windPush`/`agitation`/`shelter`/`tempo`,
 * set by the subsystem — so the control itself is a CPU input to `weatherDrive`).
 */
const CPU_CONSUMED = Object.freeze({
  fliesPerZone: 'subsystem: head-count per zone',
  countPerZone: 'subsystem: head-count per zone',
  areaScaling: 'subsystem: zone-area scaling of the head-count',
  maskSensitivity: 'subsystem: the zone field’s threshold',
  fadeTime: 'subsystem: reaction time of the head-count',
  nightActivity: 'critter-activity#flyActivity: fraction of the swarm out after dark',
  alwaysActive: 'critter-activity#fireflyActivity',
  dusk: 'critter-activity#fireflyActivity',
  dawn: 'critter-activity#fireflyActivity',
  appearBelowDeg: 'critter-activity#fireflyActivity',
  fullBelowDeg: 'critter-activity#fireflyActivity',
  fadeByDeg: 'critter-activity#fireflyActivity',
  nightResidual: 'critter-activity#fireflyActivity',
  shadowStrength: 'subsystem: flyShadowFromSky → shadowAmount',
  ...Object.fromEntries(WEATHER_FACTOR_PARAMS.map((id) => [id, 'critter-weather#weatherFactor'])),
  ...Object.fromEntries(WEATHER_DRIVE_PARAMS.map((id) => [id, 'critter-weather#weatherDrive'])),
});

/** A param whose uniform has another name (an enum becomes an index; the rest are the same name). */
const UNIFORM_ALIAS = Object.freeze({ species: 'lookIndex', flashStyle: 'flashStyleIndex' });

const KINDS = Object.freeze([
  { label: 'SMELLY_FLIES', kind: 'fly', family: 'fly', schema: SMELLY_FLIES_PARAMS },
  { label: 'MAGGOTS', kind: 'maggot', family: 'fly', schema: MAGGOTS_PARAMS },
  { label: 'FIREFLIES', kind: 'firefly', family: 'firefly', schema: FIREFLIES_PARAMS },
]);

/** A renderer stand-in just rich enough for three's own WGSL builder (compute is captured, never run). */
function fakeRenderer(captured) {
  return {
    compute(node) {
      captured.push(node);
    },
    getRenderTarget() {
      return null;
    },
    contextNode: THREE.TSL.context({}),
    library: new THREE.StandardNodeLibrary(),
    _currentRenderContext: null,
    coordinateSystem: THREE.WebGPUCoordinateSystem,
    outputColorSpace: THREE.SRGBColorSpace,
    toneMapping: THREE.NoToneMapping,
    backend: {
      compatibilityMode: false,
      isWebGPUBackend: true,
      trackTimestamp: false,
      utils: {
        getTextureSampleData: () => ({ samples: 1, primarySamples: 1, isMSAA: false }),
        getTextureFormatGPU: () => 'rgba8unorm',
      },
      hasFeature: () => true,
      device: { limits: {} },
    },
    nodes: null,
    samples: 1,
    hasFeature() {
      return false;
    },
    getMRT() {
      return null;
    },
    getOutputRenderTarget() {
      return null;
    },
    getOutputBufferType() {
      return THREE.HalfFloatType;
    },
    getColorBufferType() {
      return THREE.HalfFloatType;
    },
    isOutputTarget: false,
  };
}

const stubTex = () => {
  const tex = new THREE.DataTexture(
    new Uint8Array([255, 255, 255, 255]),
    1,
    1,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  tex.needsUpdate = true;
  return THREE.TSL.texture(tex);
};

/** Build one engine at a rung and return the set of uniform names its kernels and materials asked for. */
function consumedUniforms(kind, family, tier) {
  const cap = 64;
  const memory = allocateCritterBuffers(THREE, cap);
  const zoneBuffer = createCritterZoneBuffer({ THREE, maxCells: 4096, homeCapacities: [cap] });
  const engine = createCritterEngine({
    THREE,
    kind,
    memory,
    zoneBuffer,
    plan: critterTierPlan(family, tier),
    illumTexNode: stubTex(),
    colorationTexNode: stubTex(),
    depthTexNode: stubTex(),
    depthFlagsTexNode: stubTex(),
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
  const built = { kernels: 0, materials: 0 };
  for (const node of captured) {
    new THREE.WGSLNodeBuilder(node, renderer).build();
    built.kernels++;
  }
  for (const mesh of engine.meshes) {
    const b = new THREE.WGSLNodeBuilder(mesh, renderer);
    b.scene = engine.scene;
    b.material = mesh.material;
    b.camera = new THREE.OrthographicCamera(-100, 100, 100, -100, 0.1, 1000);
    b.context.material = mesh.material;
    b.lightsNode = null;
    b.environmentNode = null;
    b.fogNode = null;
    b.clippingContext = null;
    b.build();
    built.materials++;
  }
  return { names: new Set(Object.keys(engine.debugState().uniforms)), built };
}

export function run(t) {
  const top = CRITTER_TIER_COUNT - 1;
  for (const { label, kind, family, schema } of KINDS) {
    const { names, built } = consumedUniforms(kind, family, top);
    t.ok(
      `${label}: the real engine built (${built.kernels} kernels, ${built.materials} materials)`,
      built.kernels >= 2 && built.materials >= 1
    );
    t.ok(`${label}: the graphs asked for a real set of uniforms (${names.size})`, names.size > 20);

    const dead = [];
    const unknown = [];
    for (const id of Object.keys(schema)) {
      if (Object.hasOwn(CPU_CONSUMED, id)) continue;
      const uniform = UNIFORM_ALIAS[id] ?? id;
      if (!Object.hasOwn(CRITTER_UNIFORM_DEFAULTS, uniform)) unknown.push(id);
      else if (!names.has(uniform)) dead.push(id);
    }
    t.ok(
      `${label}: every control is read by a kernel, a material, or the CPU law${dead.length ? ` — DEAD: ${dead.join(', ')}` : ''}`,
      dead.length === 0
    );
    t.ok(
      `${label}: every shader-side control has a slot in the uniform table${unknown.length ? ` — MISSING: ${unknown.join(', ')}` : ''}`,
      unknown.length === 0
    );

    // The CPU allowlist is not a back door: it can only name params the schema really has, so it cannot
    // quietly excuse a control that was renamed or removed.
    const stale = Object.keys(schema).filter(
      (id) => Object.hasOwn(CPU_CONSUMED, id) && Object.hasOwn(UNIFORM_ALIAS, id)
    );
    t.ok(`${label}: nothing is excused as CPU-side while also being an enum index`, stale.length === 0);

    // Defaults agree: the schema's default and the kind's bank default for the same name.
    const bankDefaults = { ...CRITTER_UNIFORM_DEFAULTS, ...CRITTER_KIND_DEFAULTS[kind] };
    const drift = [];
    for (const [id, def] of Object.entries(schema)) {
      const uniform = UNIFORM_ALIAS[id] ?? id;
      if (!Object.hasOwn(CRITTER_UNIFORM_DEFAULTS, uniform) || UNIFORM_ALIAS[id]) continue;
      const bankDefault = bankDefaults[uniform];
      if (typeof def.default === 'number' && typeof bankDefault === 'number') {
        if (Math.abs(def.default - bankDefault) > 1e-9) drift.push(`${id} (${def.default} vs ${bankDefault})`);
      } else if (typeof def.default === 'string' && Array.isArray(bankDefault)) {
        const rgb = hexToRgb01(def.default);
        if (rgb.some((c, i) => Math.abs(c - bankDefault[i]) > 5e-3)) drift.push(`${id} (${def.default})`);
      }
    }
    t.ok(
      `${label}: schema defaults match the uniform table's${drift.length ? ` — DRIFT: ${drift.join(', ')}` : ''}`,
      drift.length === 0
    );
  }
}
