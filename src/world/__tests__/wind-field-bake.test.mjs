/**
 * wind-field-bake.test.mjs — the baked wind field (2026-10-27, epic mmp-fpu).
 *
 * What is pinned here, and why each matters:
 *
 *   1. THE MAPPING. A baked texel must mean the same world position the openness /
 *      wall textures mean by the same texel, or the baked field is the analytic
 *      field shifted by a cell — invisible in a unit test of "does it return a
 *      number", glaring on a map. The stub textures return their own coordinates,
 *      so a mapping error shows up as the wrong number.
 *   2. THE POINT OF IT. A consumer that asks for the baked field must contain NO
 *      noise at all; the analytic path contains ~18. Counted on real TSL graphs
 *      (`tsl-census.mjs`) — the thing that made one candle pipeline compile for 20 s.
 *   3. SAFETY OF ASKING. `baked: 'now'` on a handle that has no baked field (a lab,
 *      a test, the first frame, a windless scene) must build exactly what it built
 *      before. Passing the argument is always safe.
 *   4. THE BAKE PASS evaluates the same `sampleWind` — it is the one place the noise
 *      still lives.
 */
import * as THREE from '../../vendor/three/three.webgpu.js';
import { windGridUvNode, sampleBakedWindField, bakedSliceFor, buildWindFieldBakeMaterial } from '../wind-field-bake.js';
import { createWindHandle } from '../wind-access.js';
import { createWindAdvectionUniforms } from '../wind-field.js';
import { TSL_STUB as S, values } from './tsl-numeric-stub.mjs';
import { census, censusMaterial } from '../../core/__tests__/tsl-census.mjs';

const T = THREE.TSL;
const GRID = { originX: 100, originY: -50, cellSize: 25, cols: 8, rows: 4 };

const dataTexture = () => {
  const t = new THREE.DataTexture(
    new Uint16Array(GRID.cols * GRID.rows * 4),
    GRID.cols,
    GRID.rows,
    THREE.RGBAFormat,
    THREE.HalfFloatType
  );
  t.needsUpdate = true;
  return t;
};

const ambient = () => ({
  directionDeg: T.uniform(T.float(90)),
  speed01: T.uniform(T.float(0.3)),
  gustiness01: T.uniform(T.float(1)),
  pixelsPerMetre: T.uniform(T.float(65.6)),
  advection: createWindAdvectionUniforms(T),
});

const handleWith = ({ field = true, ambientWind = ambient() } = {}) => {
  const fieldTexture = dataTexture();
  const fieldLagTexture = dataTexture();
  return {
    fieldTexture,
    fieldLagTexture,
    handle: createWindHandle({
      version: 1,
      ambientWind,
      grid: GRID,
      opennessTexture: dataTexture(),
      wallAvoidTexture: dataTexture(),
      liveTexture: dataTexture(),
      fieldTexture: field ? fieldTexture : null,
      fieldLagTexture: field ? fieldLagTexture : null,
    }),
  };
};

const node = (h, extra = {}) =>
  h.node(T, { centerXY: T.vec2(T.float(300), T.float(20)), time: T.uniform(T.float(5000)), ...extra });

export function run(t) {
  const { ok } = t;
  const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

  // ── 1. THE MAPPING ───────────────────────────────────────────────────────
  {
    const cellCentre = (c, r) =>
      S.vec2(GRID.originX + (c + 0.5) * GRID.cellSize, GRID.originY + (r + 0.5) * GRID.cellSize);
    const [u, v] = values(windGridUvNode(S, GRID, cellCentre(3, 2)));
    ok(
      "the centre of cell (3,2) is at uv ((3+½)/cols, (2+½)/rows) — the openness texture's own mapping",
      near(u, 3.5 / 8) && near(v, 2.5 / 4)
    );
    const [u0, v0] = values(windGridUvNode(S, GRID, cellCentre(0, 0)));
    ok('cell (0,0) is the top-left texel', near(u0, 0.5 / 8) && near(v0, 0.5 / 4));
    const [uo, vo] = values(windGridUvNode(S, GRID, S.vec2(-9999, 9999)));
    ok('a position outside the grid reads its nearest edge cell, never a wrap', uo === 0 && vo === 1);

    // A stub texture that answers with its own coordinates: the read lands where the mapping says.
    const probeTexture = { sample: (uu, vv) => [uu * 100, vv * 100, 7, 1] };
    const read = values(sampleBakedWindField(S, { texture: probeTexture, grid: GRID, centerXY: cellCentre(5, 1) }));
    ok(
      'the baked read returns (u, v) of the right texel, and only two components',
      near(read[0], (5.5 / 8) * 100) && near(read[1], (1.5 / 4) * 100) && read.length === 2
    );
  }

  // ── 2. THE POINT OF IT: NO NOISE IN A CONSUMER ───────────────────────────
  {
    const { handle, fieldLagTexture, fieldTexture } = handleWith();
    ok(
      'a handle given the baked textures says so',
      handle.hasField === true && handle.fieldTexture === fieldTexture && handle.fieldLagTexture === fieldLagTexture
    );
    const analytic = census(node(handle));
    const nowRead = census(node(handle, { baked: 'now' }));
    const lagRead = census(node(handle, { baked: 'lagged' }));
    ok(`the analytic field carries ~18 noise call sites (${analytic.noise})`, analytic.noise >= 16);
    ok('the baked read carries NONE', nowRead.noise === 0 && lagRead.noise === 0);
    ok(
      `...and a fraction of the graph (${nowRead.unique} vs ${analytic.unique} nodes)`,
      nowRead.unique < analytic.unique / 20
    );
    ok('...as one texture read', nowRead.textures === 1);

    const strength = census(
      handle.strengthNode(T, {
        centerXY: T.vec2(T.float(300), T.float(20)),
        time: T.uniform(T.float(5000)),
        baked: 'now',
      })
    );
    ok('strengthNode takes the same shortcut', strength.noise === 0);

    const nodes = [];
    node(handle, { baked: 'lagged' }).traverse((n) => nodes.push(n));
    const lagTexNode = nodes.find((n) => n.constructor.name === 'TextureNode');
    ok('"lagged" reads the lagged slice, "now" the current one', lagTexNode?.value === fieldLagTexture);
    const nowNodes = [];
    node(handle, { baked: 'now' }).traverse((n) => nowNodes.push(n));
    ok(
      '...and "now" reads the now slice',
      nowNodes.find((n) => n.constructor.name === 'TextureNode')?.value === fieldTexture
    );
  }

  // ── 3. ASKING IS ALWAYS SAFE ─────────────────────────────────────────────
  {
    const none = handleWith({ field: false }).handle;
    ok('no baked textures → hasField is false', none.hasField === false);
    ok(
      '...and baked:"now" builds the analytic field it always built',
      census(node(none, { baked: 'now' })).noise >= 16
    );
    const windless = createWindHandle();
    ok(
      'a bake-less, ambient-less handle ignores baked entirely',
      census(node(windless, { baked: 'now' })).noise >= 0 && windless.hasField === false
    );
    const { handle } = handleWith();
    ok(
      'no baked argument → analytic, even when the field exists (the default is unchanged)',
      census(node(handle)).noise >= 16
    );
    ok('an unknown slice name falls back to analytic', census(node(handle, { baked: 'someday' })).noise >= 16);
    ok(
      'slice names map to the two textures',
      bakedSliceFor('now') === 'now' &&
        bakedSliceFor('lagged') === 'lag' &&
        bakedSliceFor(undefined) === null &&
        bakedSliceFor('x') === null
    );
    const ambientless = createWindHandle({ grid: GRID, fieldTexture: dataTexture(), fieldLagTexture: dataTexture() });
    ok('a field without a live ambient is not a field (nothing to have baked)', ambientless.hasField === false);
  }

  // ── 3b. THE HANDLE BUILDS ITS OWN BAKE PASS (wind/handle-only: no consumer names a field ref) ─────
  {
    const { handle } = handleWith();
    const built = handle.buildFieldBake(THREE);
    ok(
      'a handle with an ambient, a grid and a baked openness builds the pass',
      !!built?.material && !!built?.uBakeTimeMs
    );
    ok('...which evaluates the real field', censusMaterial(built.material).noise >= 16);
    ok('a bake-less, ambient-less handle has nothing to bake', createWindHandle().buildFieldBake(THREE) === null);
    const noOpenness = createWindHandle({ ambientWind: ambient(), grid: GRID });
    ok('a handle with no baked openness has nothing to bake either', noOpenness.buildFieldBake(THREE) === null);
  }
  // ── 4. THE BAKE PASS ─────────────────────────────────────────────────────
  {
    const amb = ambient();
    const { material, uBakeTimeMs } = buildWindFieldBakeMaterial(THREE, {
      ambient: amb,
      bakedField: { texture: dataTexture(), ...GRID },
      wallAvoidField: { texture: dataTexture(), ...GRID },
      liveField: { texture: dataTexture(), ...GRID },
      grid: GRID,
    });
    const c = censusMaterial(material);
    ok('the bake material evaluates the real field (it is the one place the noise lives)', c.noise >= 16);
    ok(
      'its only free input is the bake clock',
      uBakeTimeMs?.isUniformNode === true || typeof uBakeTimeMs?.value === 'number'
    );
    ok(
      'it writes no blending, depth or transparency',
      material.blending === THREE.NoBlending && material.depthTest === false && material.transparent === false
    );
    ok('it is named, so a crash breadcrumb can name it', material.name === 'wind.field.bake');
  }
}
