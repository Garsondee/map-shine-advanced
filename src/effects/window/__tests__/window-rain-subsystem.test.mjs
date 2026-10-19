/**
 * window-rain-subsystem.test.mjs — RAIN ON THE GLASS, AS THE SURFACE SUBSYSTEM
 * DRIVES IT.
 *
 * `window-rain.test.mjs` proves the drops' maths and `window-rain-flow.test.mjs`
 * proves the "which way is down" field. This proves the wiring between them and
 * the world, in Node, with every seam stubbed exactly as `vt-pan-viewer.js`
 * supplies it:
 *
 *   - rain is compiled only from the glass rung up (a JS-time branch, like glass);
 *   - the weather reaches the shader (rain kind, amount, clock, wind), and only
 *     RAIN counts - snow and hail do not wet a pane;
 *   - a frame is integrated once however many times a floor syncs against it;
 *   - the glass stays wet after the rain stops, then dries;
 *   - the flow field is derived LAZILY (a dry session never pays for it), only
 *     again when what it is derived from changes, and rewritten IN PLACE
 *     (a new texture object is a new binding and every consumer rebuilds);
 *   - a map with no outdoors mask still rains (splashes, no running drops).
 */
import * as THREE from '../../../../src/vendor/three/three.webgpu.js';
import { createWindowSurfaceSubsystem } from '../window-surface-subsystem.js';

const CELL = 20;
const GRID = 128;
const WORLD = GRID * CELL;

/** The house of window-rain-flow.test.mjs: a building with the SOUTH pool painted as a BLUE-only cookie. */
function houseFixture() {
  const spec = { x: 0, y: 0, width: WORLD, height: WORLD, w: GRID, h: GRID, texelW: CELL, texelH: CELL };
  const outdoors = new Uint8Array(GRID * GRID).fill(255);
  for (let y = 32; y < 96; y++) for (let x = 32; x < 96; x++) outdoors[y * GRID + x] = 0;
  const img = new Uint8Array(GRID * GRID * 4);
  for (let y = 84; y < 94; y++) {
    for (let x = 56; x < 72; x++) {
      const i = (y * GRID + x) * 4;
      img[i + 2] = 255; // blue only: the authority's R-only derived grid would call this EMPTY
      img[i + 3] = 255;
    }
  }
  return { spec, outdoors, img };
}

function rainyEnv({ precip01 = 0.8, kind = 'rain', mix = 0, tMs = 1000, dtSec = 0.016, wind = {} } = {}) {
  return {
    weather: { precip01, precipKind: kind, precipMixWeight: mix },
    time: { tMs, dtSec },
    wind: { directionDeg: 0, speed01: 0.4, gustiness01: 0.2, ...wind },
  };
}

function makeSubsystem({ state, house, envRef, outdoorsRef, counters }) {
  const { uniform, vec4 } = THREE.TSL;
  return createWindowSurfaceSubsystem({
    THREE,
    getWindowMaskUrl: () => 'stub://house_Window.webp',
    getWindowMaskRect: () => ({ minX: 0, minY: 0, maxX: WORLD, maxY: WORLD }),
    loadMaskImage: async () => ({
      texture: new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType),
      contentBounds: { minU: 0.4, minV: 0.6, maxU: 0.6, maxV: 0.8 },
      data: house.img,
      width: GRID,
      height: GRID,
      nativeWidth: GRID * 2,
      nativeHeight: GRID * 2,
      bytes: house.img.length,
    }),
    createMaskTexture: (data, w, h) => {
      counters.textures += 1;
      const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.needsUpdate = true;
      return tex;
    },
    depthTexture: null,
    uViewRect: uniform(vec4(0, 0, WORLD, WORLD)),
    cloudFactorNode: null,
    getWindowRenderState: () => state,
    getEnv: () => envRef.value,
    getWindowOutdoorsGrid: () => outdoorsRef.value,
  });
}

/** @param {{ok: Function}} t */
export async function run(t) {
  const { ok } = t;
  const house = houseFixture();
  const grid = () => ({ spec: house.spec, data: house.outdoors, version: 1 });

  // ── 1. Rain is compiled from the glass rung up, and only there ───────────
  {
    const state = { enabled: true, params: {}, debugChannel: 0, perfTier: 1 };
    const envRef = { value: null };
    const outdoorsRef = { value: grid() };
    const counters = { textures: 0 };
    const sub = makeSubsystem({ state, house, envRef, outdoorsRef, counters });
    sub.sync(0);
    await Promise.resolve();
    await Promise.resolve();
    ok('rain: the glass rung compiles rain', sub.getStatus().rain.compiled === true);
    state.perfTier = 0;
    sub.sync(0);
    ok('rain: the bare cookie rung does not construct any rain node', sub.getStatus().rain.compiled === false);
    ok('rain: and reports no uniforms then', sub.getStatus().rain.uniforms === null);
    envRef.value = rainyEnv();
    sub.sync(0);
    ok('rain: weather below the glass rung does nothing and does not throw', sub.getStatus().rain.compiled === false);
    state.perfTier = 1;
    sub.sync(0);
    ok('rain: coming back up to the glass rung rebuilds rain', sub.getStatus().rain.compiled === true);
  }

  // ── 2. A dry session pays nothing ────────────────────────────────────────
  {
    const state = { enabled: true, params: {}, debugChannel: 0, perfTier: 1 };
    const envRef = { value: rainyEnv({ precip01: 0 }) };
    const outdoorsRef = { value: grid() };
    const counters = { textures: 0 };
    const sub = makeSubsystem({ state, house, envRef, outdoorsRef, counters });
    sub.sync(0);
    await Promise.resolve();
    await Promise.resolve();
    for (let i = 0; i < 10; i++) {
      envRef.value = rainyEnv({ precip01: 0, tMs: 1000 + i * 16 });
      sub.sync(0);
    }
    const s = sub.getStatus().rain;
    ok('rain: a dry day has no presence', s.presence === 0 && s.rain01 === 0 && s.wet01 === 0);
    ok('rain: a dry day derives no flow field (lazy)', s.flow.attempts === 0 && s.flow.derived === false);
    ok(
      'rain: a dry day pushes dry uniforms',
      s.uniforms.presence === 0 && s.uniforms.cover === 0 && s.uniforms.dim === 1
    );
  }

  // ── 3. Rain reaches the shader; only rain counts ─────────────────────────
  {
    const state = { enabled: true, params: {}, debugChannel: 0, perfTier: 1 };
    const envRef = { value: null };
    const outdoorsRef = { value: grid() };
    const counters = { textures: 0 };
    const sub = makeSubsystem({ state, house, envRef, outdoorsRef, counters });
    sub.sync(0);
    await Promise.resolve();
    await Promise.resolve();

    envRef.value = rainyEnv({ precip01: 0.8, tMs: 5000, dtSec: 0.5, wind: { directionDeg: 90, speed01: 0.5 } });
    sub.sync(0);
    let s = sub.getStatus().rain;
    ok('rain: rain at 0.8 reaches the subsystem as 0.8', Math.abs(s.rain01 - 0.8) < 1e-9 && s.presence === 1);
    ok(
      'rain: the shader is told it is raining',
      s.uniforms.presence === 1 && s.uniforms.cover > 0 && s.uniforms.slider > 0
    );
    ok('rain: the sim clock is the env clock in seconds', Math.abs(s.uniforms.clock - 5) < 1e-9);
    ok('rain: the slide clock advances with the frame step', s.uniforms.slideClock > 0);
    ok(
      'rain: a wind blowing toward bearing 90 (east) flows +x (the one angle-to-vector conversion)',
      Math.abs(s.uniforms.windFlow[0] - 1) < 1e-9 && Math.abs(s.uniforms.windFlow[1]) < 1e-9
    );
    ok(
      'rain: wind strength and the windward dial reach the shader',
      s.uniforms.windBias > 0 && s.uniforms.windBias <= 1
    );

    envRef.value = rainyEnv({ precip01: 1, kind: 'snow', tMs: 6000, dtSec: 1 });
    for (let i = 0; i < 200; i++) {
      envRef.value = rainyEnv({ precip01: 1, kind: 'snow', tMs: 6000 + (i + 1) * 1000, dtSec: 1 });
      sub.sync(0);
    }
    s = sub.getStatus().rain;
    ok('rain: snow does not wet the glass (once what rain left has dried)', s.rain01 === 0 && s.presence === 0);

    envRef.value = rainyEnv({ precip01: 1, kind: 'sleet', mix: 0.25, tMs: 300000, dtSec: 1 });
    sub.sync(0);
    ok('rain: sleet counts as its warm share of rain', Math.abs(sub.getStatus().rain.rain01 - 0.75) < 1e-9);
    envRef.value = rainyEnv({ precip01: 1, kind: 'hail', tMs: 301000, dtSec: 1 });
    sub.sync(0);
    ok('rain: hail is not rain on glass', sub.getStatus().rain.rain01 === 0);
  }

  // ── 4. A frame is integrated once; the glass dries slowly ───────────────
  {
    const state = { enabled: true, params: {}, debugChannel: 0, perfTier: 1 };
    const envRef = { value: null };
    const outdoorsRef = { value: grid() };
    const counters = { textures: 0 };
    const a = makeSubsystem({ state, house, envRef, outdoorsRef, counters });
    const b = makeSubsystem({ state, house, envRef, outdoorsRef, counters });
    for (const s of [a, b]) {
      s.sync(0);
    }
    await Promise.resolve();
    await Promise.resolve();

    envRef.value = rainyEnv({ precip01: 1, tMs: 1000, dtSec: 2 });
    a.sync(0);
    const once = a.getStatus().rain.wet01;
    a.sync(0); // the same frame again: same tMs
    a.sync(0);
    ok(
      'rain: syncing the same frame again does not integrate it again (' + once.toFixed(3) + ')',
      a.getStatus().rain.wet01 === once
    );
    b.sync(0);
    ok('rain: two floors seeing the same frame wet their glass identically', b.getStatus().rain.wet01 === once);

    // Soak it, then stop the rain.
    for (let i = 1; i <= 60; i++) {
      envRef.value = rainyEnv({ precip01: 1, tMs: 1000 + i * 1000, dtSec: 1 });
      a.sync(0);
    }
    ok('rain: after a minute of rain the glass is soaked', a.getStatus().rain.wet01 > 0.95);
    envRef.value = rainyEnv({ precip01: 0, tMs: 100000, dtSec: 1 });
    a.sync(0);
    const stopped = a.getStatus().rain;
    ok(
      'rain: the instant the rain stops, beads still cling (presence stays on)',
      stopped.presence === 1 && stopped.rain01 === 0 && stopped.wet01 > 0.9
    );
    ok(
      'rain: lingering water is not a downpour (no impacts, no sheet)',
      stopped.uniforms.impact === 0 && stopped.uniforms.sheet === 0
    );
    for (let i = 1; i <= 400; i++) {
      envRef.value = rainyEnv({ precip01: 0, tMs: 100000 + i * 1000, dtSec: 1 });
      a.sync(0);
    }
    const dried = a.getStatus().rain;
    ok(
      'rain: and a few minutes later the glass has dried (' + dried.wet01.toFixed(4) + ')',
      dried.presence === 0 && dried.wet01 < 0.002
    );
  }

  // ── 5. The flow field: lazy, cached, and rewritten in place ─────────────
  {
    const state = { enabled: true, params: {}, debugChannel: 0, perfTier: 1 };
    const envRef = { value: null };
    const outdoorsRef = { value: grid() };
    const counters = { textures: 0 };
    const sub = makeSubsystem({ state, house, envRef, outdoorsRef, counters });
    sub.sync(0);
    await Promise.resolve();
    await Promise.resolve();
    ok('rain-flow: nothing is derived before it rains', sub.getStatus().rain.flow.attempts === 0);

    envRef.value = rainyEnv({ tMs: 1000 });
    sub.sync(0);
    let f = sub.getStatus().rain.flow;
    ok(
      'rain-flow: the first rain derives the field from the _Outdoors seam and the blue-only mask',
      f.derived === true && f.litCells > 0 && f.levels >= 1 && f.attempts === 1
    );
    ok('rain-flow: on the outdoors grid', f.grid === GRID + 'x' + GRID);
    const texturesAfterFirst = counters.textures;

    for (let i = 0; i < 20; i++) {
      envRef.value = rainyEnv({ tMs: 1016 + i * 16 });
      sub.sync(0);
    }
    ok('rain-flow: it is not re-derived frame after frame', sub.getStatus().rain.flow.attempts === 1);

    state.params = { rainCornerEasePx: 120 };
    envRef.value = rainyEnv({ tMs: 5000 });
    sub.sync(0);
    f = sub.getStatus().rain.flow;
    ok('rain-flow: nudging Corner blend re-derives it', f.attempts === 2 && f.derived === true);
    ok(
      'rain-flow: and rewrites the textures IN PLACE (no new texture, no new binding)',
      counters.textures === texturesAfterFirst
    );

    outdoorsRef.value = { ...grid(), version: 2 };
    envRef.value = rainyEnv({ tMs: 6000 });
    sub.sync(0);
    ok('rain-flow: a new _Outdoors product version re-derives it', sub.getStatus().rain.flow.attempts === 3);
    ok('rain-flow: still in place', counters.textures === texturesAfterFirst);

    // A tier change builds a fresh material, which must be handed the field already derived.
    state.perfTier = 0;
    sub.sync(0);
    state.perfTier = 1;
    envRef.value = rainyEnv({ tMs: 7000 });
    sub.sync(0);
    ok(
      'rain-flow: a tier rebuild keeps the derived field',
      sub.getStatus().rain.flow.derived === true && sub.getStatus().rain.flow.attempts === 3
    );
    ok(
      'rain-flow: the fresh handle was given the field rect',
      Math.abs(sub.getStatus().rain.uniforms.flowRect[2] - 1 / WORLD) < 1e-12
    );
  }

  // ── 6. No outdoors mask: it still rains, just with no running drops ──────
  {
    const state = { enabled: true, params: {}, debugChannel: 0, perfTier: 1 };
    const envRef = { value: rainyEnv({ tMs: 1000 }) };
    const outdoorsRef = { value: null };
    const counters = { textures: 0 };
    const sub = makeSubsystem({ state, house, envRef, outdoorsRef, counters });
    sub.sync(0);
    await Promise.resolve();
    await Promise.resolve();
    envRef.value = rainyEnv({ tMs: 2000 });
    sub.sync(0);
    const s = sub.getStatus().rain;
    ok('rain-flow: with no outdoors grid the rain still falls', s.presence === 1 && s.uniforms.cover > 0);
    ok(
      'rain-flow: and the field has no wall to run toward (no levels), only the gate',
      s.flow.derived === true && s.flow.levels === 0 && s.flow.attempts === 1
    );
    ok(
      'rain-flow: the shader is pointed at the gate field (a real rect)',
      s.uniforms.flowRect.some((v) => v !== 0)
    );
    outdoorsRef.value = grid();
    envRef.value = rainyEnv({ tMs: 3000 });
    sub.sync(0);
    ok('rain-flow: painting an outdoors mask later is picked up', sub.getStatus().rain.flow.derived === true);
  }

  // ── 7. The author's dials ────────────────────────────────────────────────
  {
    const state = { enabled: true, params: { rainResponse: 0 }, debugChannel: 0, perfTier: 1 };
    const envRef = { value: rainyEnv({ tMs: 1000 }) };
    const outdoorsRef = { value: grid() };
    const counters = { textures: 0 };
    const sub = makeSubsystem({ state, house, envRef, outdoorsRef, counters });
    sub.sync(0);
    await Promise.resolve();
    await Promise.resolve();
    envRef.value = rainyEnv({ tMs: 2000 });
    sub.sync(0);
    ok(
      'rain: Rain on the glass = 0 switches it off',
      sub.getStatus().rain.presence === 0 && sub.getStatus().rain.rain01 === 0
    );
    state.params = { rainResponse: 1, rainDropScalePx: 77, rainRefraction: 1.25 };
    envRef.value = rainyEnv({ tMs: 3000 });
    sub.sync(0);
    const u = sub.getStatus().rain.uniforms;
    ok('rain: the look dials reach the shader', u.scale === 77 && u.refract === 1.25);
    state.params = {};
    envRef.value = rainyEnv({ tMs: 4000 });
    sub.sync(0);
    ok('rain: missing dials fall back to the effect defaults', sub.getStatus().rain.uniforms.scale === 1.2);
  }
}
