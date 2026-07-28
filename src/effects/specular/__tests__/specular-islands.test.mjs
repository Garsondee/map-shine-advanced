/**
 * specular-islands.test.mjs — the per-island parallax pack.
 *
 * This is the one capability V2 never had, so there is no reference behaviour
 * to compare against and no "it looked right before" to fall back on. That
 * makes the pure assertions load-bearing rather than decorative: the failure
 * mode is not a crash, it is every island silently sharing one motion, which on
 * screen is indistinguishable from the old effect working correctly.
 */
import {
  presenceGridFromRgba,
  dilateLabels,
  clusterPresence,
  islandParallax,
  islandHue,
  buildSpecularIslandPack,
  SPECULAR_MIN_ISLAND_TEXELS,
  SPECULAR_ISLAND_DILATE,
  SPECULAR_ISLAND_CLUSTER_RADIUS,
  ISLAND_PARALLAX_RANGE,
} from '../specular-islands.js';

/** Decode a packed parallax byte back to its signed value — the shader's own
 * `rg * 2R - R`, so the test reads what the GPU will read.
 * @param {number} b @returns {number} */
function decodeParallax(b) {
  return (b / 255) * 2 * ISLAND_PARALLAX_RANGE - ISLAND_PARALLAX_RANGE;
}

/**
 * A mask with `blobs` painted rectangles, well separated so they must label
 * apart. @param {number} w @param {number} h @param {number[][]} rects
 * @param {number[]} [rgb] @returns {Uint8Array}
 */
function paint(w, h, rects, rgb = [255, 200, 80]) {
  const data = new Uint8Array(w * h * 4);
  for (const [x0, y0, rw, rh] of rects) {
    for (let y = y0; y < y0 + rh; y++) {
      for (let x = x0; x < x0 + rw; x++) {
        const i = (y * w + x) * 4;
        data[i] = rgb[0];
        data[i + 1] = rgb[1];
        data[i + 2] = rgb[2];
        data[i + 3] = 255;
      }
    }
  }
  return data;
}

/** @param {{ok: Function}} t */
export function run(t) {
  const { ok } = t;

  // ── PRESENCE ────────────────────────────────────────────────────────────
  // ⚠️ MAX of RGB, never red. A blue-painted steel object has `r = 0`, and
  // measuring presence by red would delete it from the island map while it
  // still RENDERED — its parallax would silently fall back to global, on one
  // object, which is unfindable by eye.
  const blue = paint(16, 16, [[2, 2, 6, 6]], [0, 0, 255]);
  const bluePresence = presenceGridFromRgba(blue, 16, 16, 16);
  ok(
    'a BLUE-painted object is present — max of RGB, not red',
    bluePresence.present.some((v) => v === 1)
  );

  // The alpha-missing fallback, matching the render-side strength decode: a
  // greyscale file with no alpha is the common authoring case, not an empty one.
  const noAlpha = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < 8 * 8; i++) noAlpha[i * 4] = 200; // red only, alpha 0
  const naPresence = presenceGridFromRgba(noAlpha, 8, 8, 8);
  ok(
    'a mask with no alpha channel still reads as present',
    naPresence.present.every((v) => v === 1)
  );

  ok(
    'an empty mask is empty',
    presenceGridFromRgba(new Uint8Array(8 * 8 * 4), 8, 8, 8).present.every((v) => v === 0)
  );

  // Box-MAX, not mean: one bright texel in a dark block IS metal and must
  // survive to the label grid. A mean would erase the coin-scatter case that
  // this whole feature is for.
  const speck = paint(32, 32, [[10, 10, 1, 1]]);
  ok(
    'a single bright texel survives downsampling',
    presenceGridFromRgba(speck, 32, 32, 8).present.some((v) => v === 1)
  );

  // ── CLUSTERING — the merge-before-labelling step ────────────────────────
  // Two lone texels, 3 apart on one axis: within reach of the default radius.
  const twoNear = new Uint8Array(20 * 20);
  twoNear[5 * 20 + 5] = 1;
  twoNear[5 * 20 + 8] = 1;
  const clusteredNear = clusterPresence(twoNear, 20, 20, SPECULAR_ISLAND_CLUSTER_RADIUS);
  // The gap between them (x=6,7 at y=5) must now be filled — that IS the merge.
  ok(
    'clustering fills the gap between two nearby specks',
    clusteredNear[5 * 20 + 6] === 1 && clusteredNear[5 * 20 + 7] === 1
  );
  ok('clusterPresence does not modify its input', twoNear[5 * 20 + 6] === 0);
  ok(
    'growth strictly extends presence, never removes it',
    clusteredNear[5 * 20 + 5] === 1 && clusteredNear[5 * 20 + 8] === 1
  );

  // Two lone texels, far apart: must NOT merge, or every object on a map
  // collapses toward one shared island.
  const twoFar = new Uint8Array(40 * 40);
  twoFar[5 * 40 + 5] = 1;
  twoFar[5 * 40 + 35] = 1;
  const clusteredFar = clusterPresence(twoFar, 40, 40, SPECULAR_ISLAND_CLUSTER_RADIUS);
  ok('clustering leaves distant specks distant', clusteredFar[5 * 40 + 20] === 0);

  // ⚠️ RADIUS 0 IS A NO-OP, NOT A CRASH — a caller that passes 0 (e.g. author
  // sets `islandSpread`-adjacent tuning to its floor someday) must get back
  // exactly the input, not an empty or corrupted grid.
  const untouched = clusterPresence(twoFar, 40, 40, 0);
  ok(
    'radius 0 changes nothing',
    untouched.every((v, i) => v === twoFar[i])
  );

  // ── DILATION ────────────────────────────────────────────────────────────
  const labels = new Uint16Array(25);
  labels[12] = 3; // centre of a 5×5
  const grown = dilateLabels(labels, 5, 5, 1);
  ok('dilation grows a label into its neighbours', grown[7] === 3 && grown[11] === 3 && grown[13] === 3);
  ok('…and does not modify the input', labels[7] === 0);
  // ⚠️ THE BUG THIS GUARDS. An in-place dilation reads texels it has already
  // written and floods the label across the entire grid in one pass — every
  // island becomes one island, per-object motion silently dies, and the effect
  // still renders perfectly.
  const wide = dilateLabels(labels, 5, 5, 1);
  ok('one round grows exactly one ring, never floods the grid', wide.filter((v) => v === 3).length === 9);
  ok('two rounds grow two rings', dilateLabels(labels, 5, 5, 2).filter((v) => v === 3).length === 25);

  // ── THE HASH ────────────────────────────────────────────────────────────
  ok(
    'island parallax is deterministic — a map does not reshuffle between sessions',
    islandParallax(7).x === islandParallax(7).x
  );
  const a = islandParallax(3);
  const b = islandParallax(4);
  ok('neighbouring labels get different motion', a.x !== b.x || a.y !== b.y);
  // At spread 0 every island must move IDENTICALLY, and at exactly the global
  // rate — this is the "give me V2's behaviour back" setting and it has to be
  // exact, not approximately 1.
  const z1 = islandParallax(1, 0);
  const z2 = islandParallax(999, 0);
  ok('spread 0 makes every island move identically', z1.x === z2.x && z1.y === z2.y);
  ok('…and at exactly the global 1:1 rate', Math.abs(z1.x - 1) < 1e-9 && Math.abs(z1.y) < 1e-9);
  // Bounded: a free direction would let an island slide sideways to a pan,
  // which reads as a bug rather than as depth.
  let maxLean = 0;
  for (let i = 1; i < 500; i++) {
    const p = islandParallax(i, 1);
    maxLean = Math.max(maxLean, Math.abs(Math.atan2(p.y, p.x)));
    ok(`island ${i} keeps a forward-ish direction`, p.x > 0);
  }
  ok('the lean stays well under a right angle', maxLean < Math.PI / 4);

  // ── THE PACK ────────────────────────────────────────────────────────────
  // Three well-separated squares, each comfortably over the size threshold.
  const three = paint(64, 64, [
    [4, 4, 12, 12],
    [40, 6, 12, 12],
    [20, 40, 12, 12],
  ]);
  const pack = buildSpecularIslandPack({ rgba: three, width: 64, height: 64, maxDim: 64 });
  ok('the pack labels three separate objects as three islands', pack.islandCount === 3);
  ok('the pack is RGBA over the label grid', pack.data.length === pack.w * pack.h * 4);
  ok('some texels are labelled', pack.labelledTexels > 0);

  // The three squares must genuinely differ, or the feature is decorative.
  const at = (x, y) => {
    const o = (y * pack.w + x) * 4;
    return [pack.data[o], pack.data[o + 1]];
  };
  // ⚠️ BYTES, not floats — a live read-zero bug on `rgba32float`. The encoding
  // must round-trip through the shader's own decode, or the parallax the GPU
  // applies is not the parallax that was baked.
  ok('the pack is a BYTE array, the format that samples everywhere', pack.data instanceof Uint8Array);
  const roundTrip = decodeParallax(at(10, 10)[0]);
  ok('a packed parallax decodes back into its hashed range', roundTrip > 0.2 && roundTrip < 2);
  const [p1, p2, p3] = [at(10, 10), at(46, 12), at(26, 46)];
  ok('three separate objects get three different motions', p1[0] !== p2[0] && p2[0] !== p3[0] && p1[0] !== p3[0]);

  // ⚠️ THE UNLABELLED DEFAULT IS THE GLOBAL PARALLAX, NOT ZERO. A zero would
  // freeze the pattern solid wherever no island claimed a texel, which looks
  // exactly like the effect having died and would be read as one.
  const empty = buildSpecularIslandPack({ rgba: new Uint8Array(32 * 32 * 4), width: 32, height: 32, maxDim: 32 });
  ok('an unpainted mask still packs', empty.data.length === empty.w * empty.h * 4);
  // Decoded, not raw: the byte is 191, and asserting on 191 would pin the
  // encoding rather than the MEANING, which is "unlabelled metal moves exactly
  // as V2's did".
  ok(
    '…with the GLOBAL parallax everywhere, never a frozen zero',
    Math.abs(decodeParallax(empty.data[0]) - 1) < 0.02 && Math.abs(decodeParallax(empty.data[1])) < 0.02
  );
  ok('…and unlabelled texels carry no coverage', empty.data[3] === 0);
  ok('…and reports zero islands, so a silent degrade is visible in the status', empty.islandCount === 0);

  // Two specks close enough to cluster, plus one real object far away. Their
  // COMBINED true area (2 texels) is still under the floor, so they merge into
  // ONE dropped group rather than two — `dropped: 1`, not 2. The real object,
  // untouched by clustering (it is nowhere near them), survives on its own.
  const specks = paint(64, 64, [
    [5, 5, 1, 1],
    [9, 9, 1, 1],
    [30, 30, 12, 12],
  ]);
  const speckPack = buildSpecularIslandPack({ rgba: specks, width: 64, height: 64, maxDim: 64 });
  ok('preClusterComponents sees the raw, unmerged count (3)', speckPack.preClusterComponents === 3);
  ok('clustering merges the two close specks into ONE dropped group', speckPack.droppedSmall === 1);
  ok(`…and the real object survives (min ${SPECULAR_MIN_ISLAND_TEXELS} true texels)`, speckPack.islandCount === 1);

  // ── THE FIX ITSELF: A REALISTIC COIN PILE NOW SURVIVES ──────────────────
  // ⚠️ THIS IS WHAT THE CLUSTERING STEP EXISTS FOR — live-diagnosed 2026-07-27
  // as the reason the island channel showed nothing on a real scene. Eight
  // 2×2-texel coins, scattered a few texels apart (never touching), used to
  // ALL be dropped individually; clustered, they read as one coherent surface.
  const coinPositions = [
    [4, 4],
    [8, 5],
    [6, 9],
    [11, 10],
    [3, 10],
    [9, 3],
    [13, 7],
    [5, 13],
  ];
  const coins = paint(
    64,
    64,
    coinPositions.map(([x, y]) => [x, y, 2, 2])
  );
  const coinPack = buildSpecularIslandPack({ rgba: coins, width: 64, height: 64, maxDim: 64 });
  ok('a scattered pile of realistic-sized coins clusters into ONE island', coinPack.islandCount === 1);
  ok('…none of it dropped', coinPack.droppedSmall === 0);

  // ⚠️ AND A TRULY ISOLATED SPECK MUST STILL DROP — the assertion that would
  // have caught the bug this whole section guards: an EARLY DRAFT filtered by
  // the DILATED blob size rather than the true painted area, and a single
  // isolated texel dilated by the cluster radius alone already covers
  // `(2·radius+1)²` texels — comfortably over the floor regardless of what was
  // actually painted, which would have made the size floor filter NOTHING.
  const dust = paint(64, 64, [[50, 50, 1, 1]]);
  const dustPack = buildSpecularIslandPack({ rgba: dust, width: 64, height: 64, maxDim: 64 });
  ok('a lone, genuinely isolated texel still drops — clustering did not defeat the floor', dustPack.islandCount === 0);
  ok('…reported as a raw component that never had anywhere to merge to', dustPack.preClusterComponents === 1);

  // ── CLUSTERING NEVER MERGES GENUINELY SEPARATE OBJECTS ──────────────────
  // The three-square fixture's objects are far apart — clustering at radius 3
  // must not touch them, or "per-object variety" degrades back toward one
  // shared motion for everything, defeating the whole feature.
  ok('well-separated real objects stay distinct through clustering', pack.islandCount === 3);

  // Determinism end to end: the same file must always produce the same motion.
  const again = buildSpecularIslandPack({ rgba: three, width: 64, height: 64, maxDim: 64 });
  ok(
    'the whole bake is deterministic',
    again.data.every((v, i) => v === pack.data[i])
  );

  // Spread 0 collapses to V2's behaviour exactly — one motion for the whole map.
  const flat = buildSpecularIslandPack({ rgba: three, width: 64, height: 64, maxDim: 64, spread: 0 });
  const flatAt = (x, y) => flat.data[(y * flat.w + x) * 4];
  ok(
    'spread 0 gives every island the same motion (V2 parity)',
    flatAt(10, 10) === flatAt(46, 12) && flatAt(46, 12) === flatAt(26, 46)
  );

  // Dilation reached the pack: the labelled area must exceed the painted area,
  // or every metal edge grows a rim sliding at a different rate from its own
  // interior — the artefact `SPECULAR_ISLAND_DILATE` exists to prevent.
  ok(
    `the pack is dilated past the painted silhouette (${SPECULAR_ISLAND_DILATE} texels)`,
    pack.labelledTexels > 3 * 12 * 12
  );

  // ── THE DEBUG HUE ───────────────────────────────────────────────────────
  // ⚠️ THE FIX FOR AN UNREADABLE CHANNEL. This used to be `label / 255`, and
  // with forty islands every value landed under 0.16 — so every object rendered
  // the same near-black blue and "are the islands distinct?", the one question
  // the channel exists to answer, could not be answered from it.
  ok('the hue is deterministic', islandHue(9) === islandHue(9));
  const hues = [];
  for (let i = 1; i <= 40; i++) hues.push(islandHue(i));
  ok(
    'every hue is in 0..1',
    hues.every((h) => h >= 0 && h < 1)
  );
  // Spread right around the wheel: with forty islands each sixth of the circle
  // should hold at least one, or adjacent objects still look alike.
  const sextants = new Set(hues.map((h) => Math.floor(h * 6)));
  ok(`forty islands spread across the hue circle (${sextants.size}/6 sextants)`, sextants.size >= 5);
}
