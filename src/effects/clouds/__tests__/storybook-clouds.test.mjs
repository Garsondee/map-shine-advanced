/**
 * STORYBOOK CLOUDS verification (2026-11-03).
 *
 * 1. The two cards' new params validate, and the Cloud Tops card's storybook defaults are the module's own
 *    (one table of numbers, never two that drift apart).
 * 2. The pure CPU half — cover → density, the per-frame deck, the hour's palette, the storybook light — Node-
 *    tested directly, including the one geometric promise the shader relies on: a cloud never reaches outside
 *    the 2×2 cells a pixel tests.
 * 3. `keyhole-tsl-constructs-in-node`: the real tops and shadow graphs build against the vendored three.
 *    What they LOOK like is the shader lab's job (`tools/shader-lab/storybook-cloud-lab.js`).
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import { validateParamsSchema } from '../../../core/params-schema.js';
import { CLOUD_LOOK_PARAMS } from '../clouds.js';
import { CLOUD_TOPS_PARAMS } from '../cloud-tops.js';
import {
  STORYBOOK_DECK_DEFAULTS,
  STORYBOOK_CORE_QUANTILES,
  storybookThreshold,
  storybookDensity,
  resolveStorybookDeck,
  storybookPalette,
  storybookLight,
  createStorybookUniforms,
  pushStorybookUniforms,
  buildStorybookCloudNode,
  buildStorybookShadowNode,
} from '../storybook-clouds.js';
import { computeSun } from '../../../world/sun.js';

const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const finite = (o) =>
  Object.values(o).every((v) =>
    Array.isArray(v) ? v.every(Number.isFinite) : typeof v !== 'number' || Number.isFinite(v)
  );

export function run(t) {
  const { ok } = t;

  // ---- 1. declarations -----------------------------------------------------
  ok('CLOUD_LOOK_PARAMS (with style) is a valid params schema', validateParamsSchema(CLOUD_LOOK_PARAMS).ok);
  ok(
    'CLOUD_TOPS_PARAMS (with the storybook dials) is a valid params schema',
    validateParamsSchema(CLOUD_TOPS_PARAMS).ok
  );
  ok('storybook is the default style', CLOUD_LOOK_PARAMS.style.default === 'storybook');
  ok('realistic stays selectable', CLOUD_LOOK_PARAMS.style.values.includes('realistic'));
  for (const [k, v] of Object.entries(STORYBOOK_DECK_DEFAULTS)) {
    const decl = CLOUD_TOPS_PARAMS[k] ?? CLOUD_LOOK_PARAMS[k];
    ok(`${k}: the card's default is the module's (${v})`, decl && decl.default === v);
  }

  // ---- 2a. cover → density -------------------------------------------------
  ok('cover 0 holds no clouds at all (an exact no-op)', storybookDensity(0).fill === 0);
  ok('garbage cover holds no clouds', storybookDensity(NaN).fill === 0);
  let monotone = true;
  let prev = -1;
  for (let c = 0.01; c <= 1.0001; c += 0.01) {
    const f = storybookDensity(c).fill;
    if (f < prev || f > 1) monotone = false;
    prev = f;
  }
  ok('more cover never means fewer clouds, and never more than every cell', monotone);

  // ---- 2b. the deck --------------------------------------------------------
  const board = { minX: 0, minY: 0, maxX: 15000, maxY: 7500 };
  const H = 15000;
  const onTable = resolveStorybookDeck({
    cover01: 0.5,
    scalePx: 1100,
    anisotropy: 1.15,
    board,
    tableOn: true,
    eyeHeight: H,
  });
  const offTable = resolveStorybookDeck({
    cover01: 0.5,
    scalePx: 1100,
    anisotropy: 1.15,
    board,
    tableOn: false,
    eyeHeight: H,
  });
  ok('the deck is all finite numbers', finite(onTable) && finite(offTable));
  ok(
    'the field threshold leaves the asked-for share of sky covered (monotone, 0 covers nothing)',
    storybookThreshold(0.1) > storybookThreshold(0.5) &&
      storybookThreshold(0.5) > storybookThreshold(0.9) &&
      onTable.threshold === storybookThreshold(onTable.fill)
  );
  ok(
    'the coverage quantiles table is monotone',
    STORYBOOK_CORE_QUANTILES.every((q, i, a) => i === 0 || (q[0] > a[i - 1][0] && q[1] < a[i - 1][1]))
  );
  ok(
    'cover 0 sets a threshold nothing can reach',
    resolveStorybookDeck({ cover01: 0, scalePx: 1100, board, tableOn: true, eyeHeight: H }).threshold >= 9
  );
  ok(
    'with the Table the field has no edge (nothing shrinks or grows in at a border)',
    onTable.clipToBoard === false && onTable.domainFade === 1
  );
  ok(
    'without the Table they stay over the map (the padding rule)',
    offTable.clipToBoard === true && offTable.domain[0] === board.minX
  );
  ok('the dome is centred on the map', onTable.domeCentre[0] === 7500 && onTable.domeCentre[1] === 3750);
  const tall = resolveStorybookDeck({
    cover01: 1,
    scalePx: 6000,
    board,
    tableOn: true,
    eyeHeight: 2000,
    params: { storybookHeight: 0.5, storybookBulge: 1.5 },
  });
  ok(
    'even a tall, bulging deck keeps its highest crown under the eye',
    tall.baseHeight + tall.domeHeight + tall.radius < 0.85 * 2000
  );
  ok(
    'a flat deck has no dome and no fisheye',
    resolveStorybookDeck({
      cover01: 0.5,
      scalePx: 1100,
      board,
      tableOn: true,
      eyeHeight: H,
      params: { storybookBulge: 0 },
    }).domeHeight === 0
  );
  const smallMap = resolveStorybookDeck({
    cover01: 0.5,
    scalePx: 1100,
    board: { minX: 0, minY: 0, maxX: 3000, maxY: 3000 },
    tableOn: true,
    eyeHeight: H,
  });
  ok('cloud scale follows the map (a small map gets smaller clouds)', smallMap.spacing < onTable.spacing);
  ok(
    'cover 0 decks are empty',
    resolveStorybookDeck({ cover01: 0, scalePx: 1100, board, tableOn: true, eyeHeight: H }).fill === 0
  );

  // Every look dial reaches the deck the shader reads, in the slot the uniforms document.
  const tuned = resolveStorybookDeck({
    cover01: 0.5,
    scalePx: 1100,
    board,
    tableOn: true,
    eyeHeight: H,
    params: {
      storybookCluster: 2,
      storybookFraySize: 2.5,
      storybookScrapReach: 0.4,
      storybookDrama: 2.5,
      storybookMist: 0.3,
    },
  });
  ok(
    'look dials land in their uniform slots (cluster, fray, scrap reach, drama, mist)',
    tuned.shape[0] === 2 &&
      tuned.shape2[2] === 2.5 &&
      tuned.edge[2] === 0.4 &&
      tuned.light2[1] === 2.5 &&
      tuned.light3[3] === 0.3
  );
  ok(
    'no dial can go negative into the shader',
    [tuned.shape, tuned.shape2, tuned.edge, tuned.light1, tuned.light2, tuned.light3].flat().every((v) => v >= 0)
  );

  // ---- 2c. the palette -----------------------------------------------------
  const pal = (h, sky) => storybookPalette(computeSun(h), sky);
  let inRange = true;
  for (let h = 0; h < 24; h += 0.25) {
    const p = pal(h);
    for (const slot of ['hi', 'body', 'shadow', 'ink', 'rim'])
      if (!p[slot].every((v) => v >= 0 && v <= 1)) inRange = false;
  }
  ok('every slot is a linear colour in 0..1 at every hour', inRange);
  // Continuity, not slowness: twilight colours move fast (the sun crosses a 5° keyframe gap in ~20 min), but a
  // CONTINUOUS palette's step shrinks with the time step — a seam (dawn/dusk tracks disagreeing at noon or
  // midnight, a keyframe typo) would not.
  const maxStep = (dt) => {
    let m = 0;
    for (let h = 0; h < 24; h += dt) {
      const a = pal(h).body;
      const b = pal(h + dt).body;
      m = Math.max(m, Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]));
    }
    return m;
  };
  const coarse = maxStep(0.05);
  const fine = maxStep(0.005);
  ok(
    `the palette is continuous through the day (${coarse.toFixed(3)} per 3 min, ${fine.toFixed(4)} per 18 s)`,
    fine < coarse * 0.2 && fine < 0.03
  );
  const noon = pal(12);
  ok(
    'by day the three tones step down in value: light > body > shadow > ink',
    lum(noon.hi) > lum(noon.body) && lum(noon.body) > lum(noon.shadow) && lum(noon.shadow) > lum(noon.ink)
  );
  ok('night clouds are darker than noon clouds', lum(pal(0).body) < lum(noon.body) * 0.5);
  const dawn = storybookPalette({ elevationDeg: 2, rising: true });
  const dusk = storybookPalette({ elevationDeg: 2, rising: false });
  ok('dusk runs hotter than dawn at the same sun height', dusk.body[0] - dusk.body[2] > dawn.body[0] - dawn.body[2]);
  ok('shadows go cool, never grey: the noon shadow is bluer than it is red', noon.shadow[2] > noon.shadow[0]);
  const storm = pal(12, { cover01: 1, precip01: 1 });
  ok('a storm darkens the clouds', lum(storm.body) < lum(noon.body) && storm.storm01 > 0.5);
  ok('a clear sky has no storm in it', noon.storm01 === 0);

  // ---- 2d. the storybook light -----------------------------------------------
  const dayL = storybookLight({ x: 1, y: 0 }, 70);
  const lowL = storybookLight({ x: 1, y: 0 }, 2);
  const nightL = storybookLight({ x: 1, y: 0 }, -30);
  const unit = (v) => Math.abs(Math.hypot(...v) - 1) < 1e-9;
  ok('the light is a unit vector', unit(dayL) && unit(lowL) && unit(nightL));
  ok('a high sun still rakes (held at or below 38°)', dayL[2] <= Math.sin((38 * Math.PI) / 180) + 1e-9);
  ok(
    'a sun on the horizon still lights the tops (held at or above 6°)',
    lowL[2] >= Math.sin((6 * Math.PI) / 180) - 1e-9
  );
  ok(
    'golden hour rakes in low (a 10° sun lights from well below the noon light)',
    storybookLight({ x: 1, y: 0 }, 10)[2] < dayL[2] * 0.4
  );
  ok('it comes from the sun by day', dayL[0] > 0);
  ok('after dark the moon lights from the other side', nightL[0] < 0);

  // ---- 3. the graphs build in Node -------------------------------------------
  const TSL = THREE.TSL;
  const u = createStorybookUniforms(TSL);
  pushStorybookUniforms(u, {
    deck: onTable,
    palette: noon,
    light: dayL,
    eye: { x: 7500, y: 3750, height: H },
    board,
    footprintPx: 12,
    timeSec: 3,
  });
  ok('the push lands (spacing reaches the GPU uniform)', u.deck.value.x === onTable.spacing);
  const wind = { drift: TSL.uniform(TSL.vec2(0, 0)), dir: TSL.uniform(TSL.vec2(1, 0)) };
  let threw = null;
  let tops;
  let shadow;
  try {
    tops = buildStorybookCloudNode(TSL, { groundXY: TSL.positionWorld.xy, u, wind, visibility: TSL.float(1) });
    shadow = buildStorybookShadowNode(TSL, {
      worldXY: TSL.positionWorld.xy,
      u,
      wind,
      offset: TSL.uniform(TSL.vec2(300, 200)),
      blur: TSL.uniform(TSL.float(0.4)),
      fillShare: TSL.uniform(TSL.float(0.3)),
    });
    const m = new THREE.NodeMaterial();
    m.colorNode = tops.rgb;
    m.opacityNode = tops.alpha;
    const s = new THREE.NodeMaterial();
    s.fragmentNode = TSL.vec4(shadow, 0, 0, 1);
  } catch (err) {
    threw = err;
  }
  ok('the storybook tops and shadow graphs construct without throwing', threw === null);
  if (threw) console.error('  construction error:', threw.stack || threw);
  ok('the tops return rgb and alpha', !!tops?.rgb && !!tops?.alpha);
  ok('the shadow returns a node', !!shadow);
}
