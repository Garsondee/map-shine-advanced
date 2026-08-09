/**
 * THE LAYER TEXTURE'S PACKING, PINNED IN NODE.
 *
 * `packLayerTexelData` (`sun-shadow-subsystem.js`) is the one place the RGBA
 * bytes every sun-shadow material reads get written. Its predecessor,
 * `packCasterTexelData`, was retired 2026-08-02 with the march/old-smear
 * models it packed for (`docs/planning/Sun-Shadows-Layer-Smear.md` §8) — this
 * file is that same discipline applied to the replacement: a standalone pure
 * function so the packing can be pinned here without standing up the whole
 * subsystem, because a wrong byte in this layout is invisible until someone
 * looks at a real shadow and cannot easily tell "wrong channel" from "wrong
 * shape".
 *
 * The load-bearing tests are the world-sampling ones. `outdoorsGrid` and
 * `coverAboveGrid` both live at the SHARED grid resolution, independent of
 * whatever resolution the output `spec` asks for (`layerSmearTierPlan`'s own
 * tier axis) — exactly the shape of the 2026-07-30 corruption bug
 * `packCasterTexelData`'s own gate-grid test was built to catch: a flat-index
 * read silently reinterprets one row stride as another the moment the two
 * resolutions diverge, producing a *plausible* picture (banding, misplaced
 * cover) rather than an obvious blank.
 */

import { packLayerTexelData } from '../sun-shadow-subsystem.js';

/** A MaskGrid over a world rect: `{spec, data}` (NOT `{w,h,data}` — that is a
 * ContentGrid, a different type in the same neighbourhood). */
function grid(w, h, worldW = 1000, worldH = 1000, fill = 0) {
  const data = new Uint8Array(w * h);
  if (fill) data.fill(fill);
  return {
    spec: { x: 0, y: 0, width: worldW, height: worldH, w, h, texelW: worldW / w, texelH: worldH / h },
    data,
  };
}

/** The one channel `packLayerTexelData` flat-indexes, at the output's own resolution. */
function channelsAt(w, h) {
  return { coverOverhead: grid(w, h) };
}

export function run(t) {
  // ── R = WALLS (1 − outdoors), WORLD-SAMPLED ──────────────────────────
  {
    const channels = channelsAt(2, 2);
    const outdoorsGrid = grid(2, 2, 1000, 1000, 200);
    const { data } = packLayerTexelData({
      channels,
      outdoorsGrid,
      coverAboveGrid: null,
      spec: channels.coverOverhead.spec,
    });
    t.ok(
      'R is 255 − outdoors everywhere (the wall byte, not the raw outdoors reading)',
      [0, 1, 2, 3].every((i) => data[i * 4] === 255 - 200)
    );
  }

  // ── G = OVERHEAD COVERAGE, FLAT-INDEXED AT THE OUTPUT'S OWN RESOLUTION ──
  {
    const channels = channelsAt(2, 2);
    channels.coverOverhead.data.set([10, 90, 0, 255]);
    const outdoorsGrid = grid(2, 2, 1000, 1000, 255);
    const { data } = packLayerTexelData({
      channels,
      outdoorsGrid,
      coverAboveGrid: null,
      spec: channels.coverOverhead.spec,
    });
    t.ok(
      'G carries coverOverhead directly, texel for texel — no merge with any other producer',
      data[1] === 10 && data[5] === 90 && data[9] === 0 && data[13] === 255
    );
  }

  // ── B = COVERABOVE, WORLD-SAMPLED, NULL-SAFE ─────────────────────────
  {
    const channels = channelsAt(2, 2);
    const outdoorsGrid = grid(2, 2, 1000, 1000, 255);
    const coverAboveGrid = grid(2, 2, 1000, 1000, 140);
    const withAbove = packLayerTexelData({ channels, outdoorsGrid, coverAboveGrid, spec: channels.coverOverhead.spec });
    t.ok(
      'B carries coverAbove when a grid is supplied',
      [0, 1, 2, 3].every((i) => withAbove.data[i * 4 + 2] === 140)
    );

    const withoutAbove = packLayerTexelData({
      channels,
      outdoorsGrid,
      coverAboveGrid: null,
      spec: channels.coverOverhead.spec,
    });
    t.ok(
      'coverAboveGrid: null reads as "nothing above" (B=0), not a throw — a roof floor genuinely has none',
      [0, 1, 2, 3].every((i) => withoutAbove.data[i * 4 + 2] === 0)
    );
  }

  // ── A CARRIES BAND 1 (2026-08-05, the shadow cascade) ────────────────
  // A held the CASCADE's blend factor from 2026-08-02 until the shadow cascade
  // moved that publication into each slot's own baked FIELD alpha
  // (`layer-smear-render.js#uCascade`), freeing this channel for the second
  // real band: the floor ABOVE's own `coverAbove`, i.e. every floor two or more
  // storeys up. The polarity FLIPPED with the meaning, and that is the whole
  // point of these cases: an absent BLOCKAGE had to read 255 (fully blocked,
  // cascade a no-op), an absent SILHOUETTE must read 0 (nothing there, casts
  // nothing). Same channel, opposite safe default, because they are opposite
  // questions.
  {
    const channels = channelsAt(2, 2);
    channels.coverOverhead.data.fill(255);
    const outdoorsGrid = grid(2, 2, 1000, 1000, 0);
    const coverAboveGrid = grid(2, 2, 1000, 1000, 255);

    const noBand = packLayerTexelData({ channels, outdoorsGrid, coverAboveGrid, spec: channels.coverOverhead.spec });
    t.ok(
      'with no floor two storeys up, A is 0 — an absent silhouette casts nothing',
      [0, 1, 2, 3].every((i) => noBand.data[i * 4 + 3] === 0)
    );

    const bandAboveGrid = grid(2, 2, 1000, 1000, 200);
    const withBand = packLayerTexelData({
      channels,
      outdoorsGrid,
      coverAboveGrid,
      bandAboveGrid,
      spec: channels.coverOverhead.spec,
    });
    t.ok(
      'A carries the floor-above coverAbove when a grid is supplied',
      [0, 1, 2, 3].every((i) => withBand.data[i * 4 + 3] === 200)
    );

    // Partial coverage must survive as a real gradient, not a threshold — a
    // half-transparent walkway two storeys up casts a half-strength shadow.
    const halfBand = grid(2, 2, 1000, 1000, 128);
    const half = packLayerTexelData({
      channels,
      outdoorsGrid,
      coverAboveGrid,
      bandAboveGrid: halfBand,
      spec: channels.coverOverhead.spec,
    });
    t.ok(
      'partial band-1 coverage survives as a gradient rather than snapping to 0/255',
      [0, 1, 2, 3].every((i) => Math.abs(half.data[i * 4 + 3] - 128) <= 1)
    );

    // ⚠️ THE BANDS ARE READ AT DIFFERENT FLOOR INDICES AND MUST NOT ALIAS. B is
    // `coverAbove(F)`, A is `coverAbove(F+1)`; packing one must never write the
    // other, or a two-band decomposition would silently be one band smeared at
    // two heights — which looks exactly like a working cascade.
    t.ok(
      'band 0 and band 1 stay independent, and neither disturbs walls/overhead',
      withBand.data[2] === 255 &&
        withBand.data[3] === 200 &&
        withBand.data[0] === noBand.data[0] &&
        withBand.data[1] === noBand.data[1]
    );

    // `coveredTexels` must count a texel whose ONLY content is band 1 — it is
    // the enable check for the whole effect (`casterHasCoverage`), and a floor
    // whose only occluder is two storeys up would otherwise bake nothing.
    const bandOnlyChannels = channelsAt(2, 2);
    const bandOnly = packLayerTexelData({
      channels: bandOnlyChannels,
      outdoorsGrid: grid(2, 2, 1000, 1000, 255),
      coverAboveGrid: null,
      bandAboveGrid,
      spec: bandOnlyChannels.coverOverhead.spec,
    });
    t.ok('a texel covered ONLY by band 1 still counts as coverage', bandOnly.coveredTexels === 4);
  }

  // ── A MISSING channels.coverOverhead READS 0, NOT A CRASH ────────────
  {
    const outdoorsGrid = grid(2, 2, 1000, 1000, 255);
    const spec = grid(2, 2).spec;
    const { data } = packLayerTexelData({ channels: {}, outdoorsGrid, coverAboveGrid: null, spec });
    t.ok('absent coverOverhead reads 0 rather than throwing', data[1] === 0 && data[5] === 0);
  }

  // ── COVERED-TEXEL COUNT REFLECTS ANY OF THE THREE REAL CHANNELS ──────
  {
    const outdoorsFullyOpen = grid(2, 2, 1000, 1000, 255); // wallByte 0 everywhere
    const bare = packLayerTexelData({
      channels: channelsAt(2, 2),
      outdoorsGrid: outdoorsFullyOpen,
      coverAboveGrid: null,
      spec: grid(2, 2).spec,
    });
    t.ok('nothing set anywhere → nothing counted as covered', bare.coveredTexels === 0);

    const oneOverheadChannels = channelsAt(2, 2);
    oneOverheadChannels.coverOverhead.data[0] = 1;
    const oneOverhead = packLayerTexelData({
      channels: oneOverheadChannels,
      outdoorsGrid: outdoorsFullyOpen,
      coverAboveGrid: null,
      spec: grid(2, 2).spec,
    });
    t.ok('one texel of overhead coverage is counted once', oneOverhead.coveredTexels === 1);

    const coverAboveGrid = grid(2, 2, 1000, 1000, 0);
    coverAboveGrid.data[3] = 1; // matches output texel (gx=1,gy=1) at this shared resolution
    const oneAbove = packLayerTexelData({
      channels: channelsAt(2, 2),
      outdoorsGrid: outdoorsFullyOpen,
      coverAboveGrid,
      spec: grid(2, 2).spec,
    });
    t.ok('a texel covered ONLY by coverAbove (no overhead, no wall) still counts', oneAbove.coveredTexels === 1);

    const outdoorsFullyIndoors = grid(2, 2, 1000, 1000, 0); // wallByte 255 everywhere
    const allWall = packLayerTexelData({
      channels: channelsAt(2, 2),
      outdoorsGrid: outdoorsFullyIndoors,
      coverAboveGrid: null,
      spec: grid(2, 2).spec,
    });
    t.ok('every texel behind a wall counts as covered', allWall.coveredTexels === 4);
  }

  // ── ⚠️ THE 2026-07-30 REGRESSION CLASS: outdoorsGrid IS WORLD-SAMPLED,
  // NEVER FLAT-INDEXED ─────────────────────────────────────────────────
  // The grid sits at the SHARED resolution while the output spec is 4×4, 6×6
  // and 8×8 in turn — the shape of the real (shared vs per-tier) split. A
  // flat-index read walks off the end of the small buffer and returns
  // `undefined` for most texels; a world-sample must land on the correct
  // quadrant every time, at every output resolution.
  {
    const outdoorsGrid = grid(2, 2, 1000, 1000);
    // Quadrants: TL=10, TR=20, BL=30, BR=40 (row 0 is world minY).
    outdoorsGrid.data.set([10, 20, 30, 40]);

    /** The outdoors byte a caster texel's world centre should land on. */
    const quadrantOf = (gx, gy, w, h) => {
      const wx = (gx + 0.5) * (1000 / w);
      const wy = (gy + 0.5) * (1000 / h);
      const left = wx < 500;
      const top = wy < 500;
      if (top) return left ? 10 : 20;
      return left ? 30 : 40;
    };

    let allOk = true;
    let sawEveryQuadrant = true;
    for (const dim of [4, 6, 8]) {
      const channels = channelsAt(dim, dim);
      const { data } = packLayerTexelData({
        channels,
        outdoorsGrid,
        coverAboveGrid: null,
        spec: channels.coverOverhead.spec,
      });
      const seen = new Set();
      for (let gy = 0; gy < dim; gy++) {
        for (let gx = 0; gx < dim; gx++) {
          const gotOutdoors = 255 - data[(gy * dim + gx) * 4 + 0]; // wallByte = 255 − outdoors
          seen.add(gotOutdoors);
          if (gotOutdoors !== quadrantOf(gx, gy, dim, dim)) allOk = false;
        }
      }
      if (seen.size !== 4) sawEveryQuadrant = false;
    }
    t.ok('outdoorsGrid is world-sampled, correct at every output resolution', allOk);
    t.ok('all four quadrants are reached at every output resolution', sawEveryQuadrant);

    // AND THE DETECTOR IS NOT VACUOUS: the same read done with the caster's
    // own flat index — the actual bug — must produce a DIFFERENT answer, or
    // this test proves nothing.
    const dim = 8;
    const channels = channelsAt(dim, dim);
    const { data } = packLayerTexelData({
      channels,
      outdoorsGrid,
      coverAboveGrid: null,
      spec: channels.coverOverhead.spec,
    });
    let buggyDiffers = false;
    for (let i = 0; i < dim * dim; i++) {
      const flat = outdoorsGrid.data[i]; // the bug: 4-entry buffer, 64 reads
      const wallFromFlat = 255 - (flat ?? 0);
      if (wallFromFlat !== data[i * 4 + 0]) buggyDiffers = true;
    }
    t.ok('a flat-index read would disagree — so the check above can see the bug', buggyDiffers);
  }

  // ── OUT-OF-RANGE FALLS OPEN — BOTH CHANNELS, EACH IN ITS OWN POLARITY ──
  // feedback_gate_polarity_must_fail_open: a texel outside a world-sampled
  // grid must default to "no shadow here", never "fully shadowed". Outdoors
  // and coverAbove encode OPPOSITE polarities (255=open vs 0=nothing-there),
  // so their safe defaults are different numbers pointing the same direction.
  {
    const channels = channelsAt(2, 2);
    // Both grids cover only the top-left 100×100 of the caster's 1000×1000
    // rect — every one of the 2×2 output texel centres (250/750, 250/750)
    // falls outside both.
    const outdoorsGrid = grid(1, 1, 100, 100, 7); // if reached: mostly indoors
    const coverAboveGrid = grid(1, 1, 100, 100, 200); // if reached: mostly covered
    const { data } = packLayerTexelData({ channels, outdoorsGrid, coverAboveGrid, spec: channels.coverOverhead.spec });
    t.ok(
      'outdoors falls OPEN outside its grid (wallByte 0 everywhere), never shut',
      [0, 1, 2, 3].every((i) => data[i * 4 + 0] === 0)
    );
    t.ok(
      'coverAbove falls to NOTHING outside its grid (0 everywhere), never phantom coverage',
      [0, 1, 2, 3].every((i) => data[i * 4 + 2] === 0)
    );
  }
}
