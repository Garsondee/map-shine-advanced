/**
 * present-rebuild-hold.test.mjs — a Look never blacks the canvas by recompiling the present.
 *
 * 2026-11-04, the author: "When selecting the 'Noir' look the screen goes black, I assume this is a shader
 * compiling ... make sure that any of these potentially problematic shader compilations are dealt with ... so
 * that they don't trigger multiple seconds of a black canvas". Noir was the one Look with its own film response
 * (ACES); the curve was baked into the present, so picking it rebuilt a ~50-90k-character shader that three does
 * not draw until it has compiled.
 *
 * Two guarantees, both on the real present material:
 *   1. THE FILM RESPONSE IS LIVE: no tone-map curve, and no starter Look, asks for a rebuild.
 *   2. A REBUILD HOLDS THE OLD SHAPE: once a shape has compiled, a rebuilt material is drawn only after its own
 *      compile (`prepare`) settles; the old material keeps drawing until then and is disposed after the swap. A
 *      newer rebuild supersedes one still compiling; a failed compile still swaps (the old behaviour is the floor).
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import { buildGradePresentMaterial } from '../grade-present.js';
import { TONE_MAP_NAMES, TONE_MAP_INDEX, toneMapIndex } from '../grade-ops.js';
import { STARTER_LOOKS } from '../../../core/looks-schema.js';

function stubTexture() {
  const tex = new THREE.DataTexture(new Uint8Array([0, 128, 128, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.needsUpdate = true;
  return tex;
}

function buildPresent() {
  const { uniform, vec4, texture } = THREE.TSL;
  return buildGradePresentMaterial({
    THREE,
    litTexture: stubTexture(),
    outdoorsTexNode: texture(stubTexture()),
    uViewRect: uniform(vec4(0, 0, 1920, 1080)),
    uOutdoorsRect: uniform(vec4(0, 0, 1920, 1080)),
  });
}

/** A `prepare` whose compiles the test settles by hand. */
function manualPrepare() {
  const calls = [];
  const prepare = (m) =>
    new Promise((resolve, reject) => {
      calls.push({ m, resolve, reject });
    });
  return { prepare, calls };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

export async function run(t) {
  const { ok } = t;

  // ---- 1. the film response is a uniform ----
  {
    const gp = buildPresent();
    gp.flushRebuild();
    const before = gp.rebuildHistory().length;
    const shape = gp.material.fragmentNode;
    for (const name of TONE_MAP_NAMES) {
      gp.setArtGrade({}, { toneMapping: name });
      gp.flushRebuild();
      ok(`tone map "${name}" picks curve ${TONE_MAP_INDEX[name]}`, gp.toneMapIndex?.() === TONE_MAP_INDEX[name]);
    }
    ok('no tone-map curve rebuilds the present', gp.rebuildHistory().length === before);
    ok('...and the drawn shader is the same node', gp.material.fragmentNode === shape);
    ok('an unknown curve is none', toneMapIndex('nope') === 0 && toneMapIndex('none') === 0);
    ok('every curve has its own index', new Set(Object.values(TONE_MAP_INDEX)).size === TONE_MAP_NAMES.length);

    const curves = new Set();
    for (const look of STARTER_LOOKS) {
      const tone = look.values?.['grade.toneMapping'];
      if (tone === undefined) continue;
      curves.add(tone);
      gp.setArtGrade({}, { toneMapping: tone });
      gp.flushRebuild();
    }
    ok('the starter Looks use more than one film response (Noir: aces)', curves.has('aces') && curves.size >= 2);
    ok('switching through every starter Look never rebuilds the present', gp.rebuildHistory().length === before);
  }

  // ---- 2. a rebuild holds the old shape until the new one has compiled ----
  {
    const gp = buildPresent();
    const { prepare, calls } = manualPrepare();
    // The first shape: nothing compiled yet, so it is built in place (a load must not compile twice).
    gp.setStylize('sepia', 1);
    const first = gp.material;
    gp.flushRebuild(prepare);
    ok('before anything compiled, a rebuild goes into the drawn material', gp.material === first);
    ok('...and is compiled through prepare', calls.length === 1 && calls[0].m === first);
    calls[0].resolve();
    await settle();
    ok('once compiled, the shape is marked ready', gp.holdInfo?.().shownReady === true);

    // A structural change now: built on a second material, the first keeps drawing.
    let firstDisposed = false;
    first.addEventListener('dispose', () => (firstDisposed = true));
    gp.setStylize('invert', 1);
    gp.flushRebuild(prepare);
    ok('a rebuild after the first compile keeps the old material drawing', gp.material === first);
    ok('...while the new one compiles', gp.holdInfo?.().pending === true && calls.length === 2 && calls[1].m !== first);
    const second = calls[1].m;
    gp.flushRebuild(prepare);
    ok('nothing new asked: no new build', calls.length === 2 && gp.material === first);
    calls[1].resolve();
    await settle();
    ok('when its compile settles, the new material is drawn', gp.material === second);
    ok(
      '...and the old shape is kept, compiled, off screen',
      firstDisposed === false && gp.holdInfo?.().kept?.length === 1
    );
    ok('...nothing pending', gp.holdInfo?.().pending === false && gp.holdInfo?.().swapped === 1);

    // Back to a shape that has compiled: swapped in at once, no build, no compile.
    gp.setStylize('sepia', 1);
    gp.flushRebuild(prepare);
    ok('a shape shown before comes back at once', gp.material === first && calls.length === 2);
    ok('...counted as a ready swap', gp.holdInfo?.().cacheHits === 1 && gp.holdInfo?.().pending === false);
    ok('...and the shape it replaced is kept in turn', gp.holdInfo?.().kept?.length === 1);

    // Two rebuilds while one compiles: the older is never shown, and is disposed once its compile settles.
    gp.setLensWarp(true, -0.1);
    gp.flushRebuild(prepare);
    const third = calls[2].m;
    let thirdDisposed = false;
    third.addEventListener('dispose', () => (thirdDisposed = true));
    gp.setStylize('none', 0);
    gp.flushRebuild(prepare);
    const fourth = calls[3].m;
    ok('a newer rebuild supersedes the one compiling', gp.holdInfo?.().superseded === 1 && gp.material === first);
    calls[2].resolve();
    await settle();
    ok('a superseded compile is never swapped in', gp.material === first && thirdDisposed === true);
    calls[3].resolve();
    await settle();
    ok('the newest rebuild is swapped in', gp.material === fourth);

    // THE LOAD'S WARM-UP: other shapes compiled off screen, then shown without a compile.
    const warmCalls = calls.length;
    const warm = gp.warmVariants?.(prepare, [{ style: 'sepia' }, { style: 'invert' }, { style: 'none' }]);
    ok('warming builds only the shapes not already held', calls.length === warmCalls + 2);
    ok('...and never touches what is drawn', gp.material === fourth);
    calls[warmCalls].resolve();
    calls[warmCalls + 1].resolve();
    const warmed = await warm;
    ok('...reports what it built and skipped', warmed?.built?.length === 2 && warmed?.skipped?.length === 1);
    gp.setStylize('invert', 1);
    gp.flushRebuild(prepare);
    ok('a warmed shape is shown at once', gp.material === calls[warmCalls + 1].m && calls.length === warmCalls + 2);

    // A compile that fails still swaps: drawing it (three skips it until ready) is the old behaviour, the floor.
    const warn = console.warn;
    console.warn = () => {};
    gp.setLensWarp(false);
    gp.setPlayerVisionMode('nightVision', 0, 1, null);
    gp.flushRebuild(prepare);
    const failing = calls[calls.length - 1].m;
    calls[calls.length - 1].reject(new Error('device lost'));
    await settle();
    console.warn = warn;
    ok('a failed compile still swaps the new shape in', gp.material === failing && gp.holdInfo?.().failed === 1);
    ok('...and is not counted ready', gp.holdInfo?.().shownReady === false);
    // Not ready: the next rebuild goes in place, as on a load.
    const n = calls.length;
    gp.setStylize('sepia', 1);
    gp.flushRebuild(prepare);
    ok('after a failed compile the next rebuild goes in place', gp.material === failing && calls.length === n + 1);

    // Without prepare (tests, one-shot probes) a rebuild is in place, at once.
    gp.setStylize('invert', 1);
    gp.flushRebuild();
    ok('without prepare a rebuild is in place', gp.material === failing);
  }
}
