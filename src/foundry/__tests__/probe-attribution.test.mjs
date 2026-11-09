/**
 * foundry/probe-attribution.js — probe v2.1's Foundry facts (FRICTION #31) and context reader, against a
 * fake `canvas` shaped like Foundry v14's (client/canvas/sources: PointLightSource sourceType 'light',
 * GlobalLightSource 'GlobalLight' with sourceId 'globalLight', PointDarknessSource 'darkness' in
 * `darknessSources`; placeable sources id'd `${documentName}.${id}`).
 */
import { classifyProbeSource, readProbeAttribution, readProbeFoundryContext } from '../probe-attribution.js';

function withCanvas(canvas, fn) {
  const prior = globalThis.canvas;
  globalThis.canvas = canvas;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete globalThis.canvas;
    else globalThis.canvas = prior;
  }
}

class PointLightSource {
  static sourceType = 'light';
}
class GlobalLightSource {
  static sourceType = 'GlobalLight';
}
class PointDarknessSource {
  static sourceType = 'darkness';
}

/** A source whose shape is a circle of `r` px round (cx, cy) — `contains` is what readProbeAttribution asks. */
function source(Cls, sourceId, { x = 0, y = 0, r = 100, active = true, data = {}, shape = null } = {}) {
  const s = new Cls();
  s.sourceId = sourceId;
  s.active = active;
  s.data = { x, y, dim: r, bright: r / 2, color: null, ...data };
  s.shape = shape ?? { contains: (px, py) => Math.hypot(px - x, py - y) <= r };
  return s;
}

export function run(t) {
  const { ok } = t;

  // ---- classifyProbeSource ----------------------------------------------------------------------
  const cls = (s) => classifyProbeSource(s);
  ok(
    "an AmbientLight's source is a light emitter (kind ambientLight)",
    JSON.stringify(cls(source(PointLightSource, 'AmbientLight.abc'))) ===
      JSON.stringify({ list: 'lights', kind: 'ambientLight' })
  );
  ok(
    "a token's light is a light emitter (kind tokenLight)",
    cls(source(PointLightSource, 'Token.t1')).kind === 'tokenLight'
  );
  ok(
    "a dragged light's preview source is still an ambient light",
    cls(source(PointLightSource, 'AmbientLight.abc.preview')).kind === 'ambientLight'
  );
  ok(
    "another module's point light stays in lights (MSA's light reader draws it too) as kind 'light'",
    JSON.stringify(cls(source(PointLightSource, 'my-module.glow'))) ===
      JSON.stringify({ list: 'lights', kind: 'light' })
  );
  const door = cls(source(PointLightSource, 'msa-vision:doorDaylight:wall42'));
  ok(
    "MSA's daylit-door marker is otherSources, kind msaVision, role doorDaylight (FRICTION #31)",
    door.list === 'otherSources' && door.kind === 'msaVision' && door.role === 'doorDaylight'
  );
  ok(
    "MSA's vision-only fire reach names its family",
    cls(source(PointLightSource, 'msa-vision:fire:f1')).role === 'fire'
  );
  ok(
    'the global light is otherSources by its id or by its class',
    cls(source(GlobalLightSource, 'globalLight')).kind === 'globalLight' &&
      cls(source(PointLightSource, 'globalLight')).kind === 'globalLight' &&
      cls(source(GlobalLightSource, 'x')).list === 'otherSources'
  );
  ok(
    'a darkness source is otherSources, kind darkness (even when a token owns it)',
    JSON.stringify(cls(source(PointDarknessSource, 'Token.t2'))) ===
      JSON.stringify({ list: 'otherSources', kind: 'darkness' })
  );
  ok('a null source never throws', cls(null).list === 'lights');

  // ---- readProbeAttribution ---------------------------------------------------------------------
  ok(
    'no canvas: empty lists, never throws',
    withCanvas(undefined, () => {
      const r = readProbeAttribution(10, 10);
      return r.darkness === null && r.lights.length === 0 && r.otherSources.length === 0 && r.skipped.length === 0;
    })
  );
  ok(
    'a canvas that is not ready reads nothing',
    withCanvas({ ready: false }, () => readProbeAttribution(10, 10).elevation === null)
  );

  const P = { x: 1000, y: 1000 };
  const lamp = source(PointLightSource, 'AmbientLight.lamp', { x: 1075, y: 1000, r: 360, data: { color: '#ffaa55' } });
  const farLamp = source(PointLightSource, 'AmbientLight.far', { x: 3000, y: 3000, r: 360 });
  const offLamp = source(PointLightSource, 'AmbientLight.off', { x: 1000, y: 1000, r: 360, active: false });
  const torch = source(PointLightSource, 'Token.hero', { x: 1000, y: 1100, r: 435 });
  const doorMark = source(PointLightSource, 'msa-vision:doorDaylight:w1', { x: 1005, y: 1000, r: 12 });
  const global = source(GlobalLightSource, 'globalLight', {
    data: { x: 0, y: 0, dim: 0, bright: 0, darkness: { min: 0, max: 0.5 } },
    shape: { contains: () => true },
  });
  const shadow = source(PointDarknessSource, 'AmbientLight.dark', { x: 900, y: 1000, r: 200 });
  const broken = source(PointLightSource, 'AmbientLight.broken', {
    shape: {
      contains: () => {
        throw new Error('bad polygon');
      },
    },
  });
  const region = {
    id: 'reg1',
    name: 'Interior',
    testPoint: () => true,
    behaviors: {
      contents: [
        { type: 'adjustDarknessLevel', system: { mode: 0, modifier: 0.9 } },
        { type: 'suppressWeather', system: {} },
        { type: 'teleport', disabled: true, system: {} },
      ],
    },
  };
  const canvas = {
    ready: true,
    level: { id: 'lvl1', elevation: { bottom: 0 } },
    scene: { id: 'scn1', regions: { contents: [region] } },
    effects: {
      getDarknessLevel: () => 0.9,
      lightSources: [lamp, farLamp, offLamp, torch, doorMark, global, broken],
      darknessSources: [shadow],
    },
  };
  const r = withCanvas(canvas, () => readProbeAttribution(P.x, P.y));
  ok('darkness and elevation are read', r.darkness === 0.9 && r.elevation === 1);
  ok(
    'the region and its enabled behaviours are listed',
    r.regions.length === 1 && r.regions[0].behaviors.join('+') === 'adjustDarknessLevel mode=0 mod=0.9+suppressWeather'
  );
  ok(
    '`lights` holds only the emitters containing the point: the lamp and the token torch (not far, not inactive)',
    r.lights.map((l) => l.id).join(',') === 'AmbientLight.lamp,Token.hero'
  );
  const lampRow = r.lights[0];
  ok(
    'a light row: kind, distance, radii and colour',
    lampRow.kind === 'ambientLight' &&
      lampRow.dist === 75 &&
      lampRow.dim === 360 &&
      lampRow.bright === 180 &&
      lampRow.color === '#ffaa55'
  );
  ok('the token torch is kind tokenLight', r.lights[1].kind === 'tokenLight');
  ok(
    '`otherSources` holds the door marker, the global light and the darkness source, each with its kind',
    r.otherSources.map((s) => `${s.kind}:${s.id}`).join(',') ===
      'msaVision:msa-vision:doorDaylight:w1,globalLight:globalLight,darkness:AmbientLight.dark'
  );
  const g = r.otherSources.find((s) => s.kind === 'globalLight');
  ok(
    'the global light has no distance or radius, and carries its darkness window',
    g.dist === null && g.dim === null && g.bright === null && JSON.stringify(g.darknessWindow) === '[0,0.5]'
  );
  ok('the door marker names its role', r.otherSources[0].role === 'doorDaylight' && r.otherSources[0].dist === 5);
  ok(
    'a source that throws is skipped and REPORTED with its reason, the rest still read',
    r.skipped.length === 1 &&
      r.skipped[0].what === 'source' &&
      r.skipped[0].id === 'AmbientLight.broken' &&
      r.skipped[0].reason === 'bad polygon'
  );
  ok(
    'the foundry block keys are the documented v2.1 shape',
    Object.keys(r).join(',') === 'elevation,darkness,regions,lights,otherSources,skipped'
  );
  const throwing = {
    ready: true,
    level: null,
    scene: {
      get regions() {
        throw new Error('no regions');
      },
    },
    effects: {
      getDarknessLevel: () => {
        throw new Error('no darkness');
      },
      get lightSources() {
        throw new Error('no lights');
      },
      darknessSources: null,
    },
  };
  const rt = withCanvas(throwing, () => readProbeAttribution(5, 5, 10));
  ok(
    'every unreadable piece is null or empty, named in skipped, and nothing throws',
    rt.elevation === 10 &&
      rt.darkness === null &&
      rt.lights.length === 0 &&
      rt.otherSources.length === 0 &&
      rt.skipped.map((s) => s.what).join(',') === 'darkness,regions,lightSources'
  );

  // ---- readProbeFoundryContext -----------------------------------------------------------------------
  const ctx = withCanvas({ ...canvas, stage: { pivot: { x: 4500, y: 3375 }, scale: { x: 0.8, y: 0.8 } } }, () =>
    readProbeFoundryContext()
  );
  ok(
    "the context reads the scene, the viewed level and Foundry's camera (stage pivot + scale)",
    ctx.sceneId === 'scn1' &&
      ctx.levelId === 'lvl1' &&
      JSON.stringify(ctx.camera) === JSON.stringify({ x: 4500, y: 3375, scale: 0.8, source: 'stage' }) &&
      ctx.errors.length === 0
  );
  ok(
    'no canvas: all null, never throws',
    withCanvas(undefined, () => {
      const c = readProbeFoundryContext();
      return c.sceneId === null && c.levelId === null && c.camera === null && c.errors.length === 0;
    })
  );
  const badCtx = withCanvas(
    {
      get scene() {
        throw new Error('scene gone');
      },
      level: { id: 'lvl2' },
      stage: { pivot: { x: NaN, y: 1 }, scale: { x: 1 } },
    },
    () => readProbeFoundryContext()
  );
  ok(
    'a throwing piece is null with its reason; a non-finite camera is null',
    badCtx.sceneId === null &&
      badCtx.levelId === 'lvl2' &&
      badCtx.camera === null &&
      badCtx.errors.length === 1 &&
      badCtx.errors[0] === 'sceneId: scene gone'
  );
}
