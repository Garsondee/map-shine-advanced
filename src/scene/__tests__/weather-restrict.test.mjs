/**
 * weather-restrict.test.mjs — a Tile's "Restrict Weather" box as a sky occluder:
 * the derive stage that emits restrictors and the pure compose that lays them
 * back over the sky with their live fade.
 */
import { computeMaskGridSpec, deriveFloorProducts, makeUniformContent } from '../mask-derive.js';
import { createMaskAuthority } from '../mask-authority.js';
import {
  composeWeatherGate,
  composeDripCover,
  dripRoofKey,
  quantizeOpacity,
  tileOpacity,
  OPACITY_STEP,
} from '../weather-restrict.js';

// 10x10 grid over a 100x100 world: texel (gx, gy) is world [10gx, 10gx+10) x [10gy, 10gy+10).
const gspec = computeMaskGridSpec({ x: 0, y: 0, width: 100, height: 100 }, 10);
const at = (grid, gx, gy) => grid.data[gy * 10 + gx];
// A tile whose centre is (cx, cy) and whose size is (w, h) in world px.
const place = (cx, cy, w, h) => ({ x: cx, y: cy, width: w, height: h });

export async function run(t) {
  const floors = [{ index: 0, ceilingElevation: 10, bottomElevation: 0, outdoors: [] }];
  const base = (id, elevation, extra = {}) => ({
    id,
    kind: 'tile',
    elevation,
    hidden: false,
    placement: place(25, 50, 50, 100), // left half: columns 0-4
    alpha: makeUniformContent(1, 255),
    ...extra,
  });
  const derive = (items, fl = floors) =>
    deriveFloorProducts({ gridSpec: gspec, items, floors: fl, outdoorsAbsentValue: 1 });

  // --- no restrictor: nothing changes, no weather product ----------------------
  {
    const [f0] = derive([base('roof', 10)]);
    t.ok('weather: a floor with no restrictor has no weather product', f0.weather === null);
    t.ok(
      'weather: that roof is still ordinary static cover',
      at(f0.skyReach, 2, 5) === 0 && at(f0.skyReach, 7, 5) === 255
    );
  }

  // --- a roof-band restrictor: still cover in coverAbove, but out of the dynamic sky ---
  {
    const [f0] = derive([base('roof', 10, { restrictsWeather: true })]);
    const w = f0.weather;
    t.ok('weather: a flagged roof tile produces a weather product', !!w && w.restrictors.length === 1);
    t.ok('weather: the restrictor is classed as above the floor', w.restrictors[0].above === true);
    t.ok('weather: coverAbove still counts it (shadows, lighting unchanged)', at(f0.coverAbove, 2, 5) === 255);
    t.ok('weather: skyReach still counts it (static default)', at(f0.skyReach, 2, 5) === 0);
    t.ok('weather: the dynamic sky does NOT — it is the restrictor to put back', at(w.sky, 2, 5) === 255);
    t.ok('weather: nor does the dynamic cover', at(w.cover, 2, 5) === 0);
    const gate = composeWeatherGate({ sky: w.sky, restrictors: w.restrictors });
    t.ok(
      'weather: composed at full opacity it equals the old permanent cover',
      gate[(5 * 10 + 2) * 4] === 0 && gate[(5 * 10 + 7) * 4] === 255
    );
    const faded = composeWeatherGate({ sky: w.sky, restrictors: w.restrictors, opacityOf: () => 0 });
    t.ok('weather: composed at opacity 0 the weather is back under the roof', faded[(5 * 10 + 2) * 4] === 255);
  }

  // --- a non-flagged roof next to a flagged one stays permanent -----------------
  {
    const items = [
      base('plain', 10, { placement: place(25, 50, 50, 100) }),
      base('flagged', 10, { placement: place(75, 50, 50, 100), restrictsWeather: true }),
    ];
    const [f0] = derive(items);
    const faded = composeWeatherGate({ sky: f0.weather.sky, restrictors: f0.weather.restrictors, opacityOf: () => 0 });
    t.ok('weather: a plain roof stays covered while the flagged one is faded', faded[(5 * 10 + 2) * 4] === 0);
    t.ok('weather: the faded flagged roof lets the weather in', faded[(5 * 10 + 7) * 4] === 255);
  }

  // --- a restrictor in the OVERHEAD band (an awning) is cover it never was -------
  {
    const [f0] = derive([base('awning', 5, { restrictsWeather: true })]);
    t.ok('weather: an awning below the ceiling is a restrictor', f0.weather?.restrictors.length === 1);
    t.ok('weather: not above', f0.weather.restrictors[0].above === false);
    t.ok('weather: ordinary skyReach never saw it', at(f0.skyReach, 2, 5) === 255);
    const gate = composeWeatherGate({ sky: f0.weather.sky, restrictors: f0.weather.restrictors });
    t.ok('weather: the composed gate keeps the weather off what is under it', gate[(5 * 10 + 2) * 4] === 0);
    t.ok('weather: and leaves the rest of the sky alone', gate[(5 * 10 + 7) * 4] === 255);
  }

  // --- a rug-height tile ON the ground counts; one wholly BELOW the floor does not ---
  {
    const upper = [
      { index: 0, ceilingElevation: 10, bottomElevation: 0, outdoors: [] },
      { index: 1, ceilingElevation: 20, bottomElevation: 10, outdoors: [] },
    ];
    const items = [base('rug', 0, { restrictsWeather: true })];
    const [f0, f1] = derive(items, upper);
    t.ok('weather: a flagged ground-level tile restricts its own floor', f0.weather?.restrictors.length === 1);
    t.ok('weather: a flagged tile wholly BELOW the floor does not — the weather is above it', f1.weather === null);
    const drawnUp = derive([base('rug', 0, { restrictsWeather: true, visibleFloorIndices: [0, 1] })], upper);
    t.ok('weather: unless it is actually drawn on that floor', drawnUp[1].weather?.restrictors.length === 1);
  }

  // --- only TILES carry the flag: a level background's restrictsWeather is its default ---
  {
    const bg = {
      id: 'bg',
      kind: 'levelBackground',
      restrictsWeather: true,
      elevation: 0,
      hidden: false,
      placement: place(50, 50, 100, 100),
      alpha: makeUniformContent(1, 255),
      ownerFloorIndex: 1,
    };
    const upper = [
      { index: 0, ceilingElevation: 10, bottomElevation: 0, outdoors: [] },
      { index: 1, ceilingElevation: 20, bottomElevation: 10, outdoors: [] },
    ];
    const [f0] = derive([bg], upper);
    t.ok('weather: a level background is never a restrictor', f0.weather === null);
  }

  // --- hidden / un-ingested tiles are not restrictors ------------------------------
  {
    const [f0] = derive([
      base('hid', 10, { restrictsWeather: true, hidden: true }),
      base('pending', 10, { restrictsWeather: true, alpha: null }),
    ]);
    t.ok('weather: hidden and un-ingested tiles contribute nothing', f0.weather === null);
  }

  // --- the product is reused when nothing changed ---------------------------------
  {
    const cache = (await import('../mask-derive.js')).createDeriveCache();
    const items = [base('roof', 10, { restrictsWeather: true })];
    const a = deriveFloorProducts({ gridSpec: gspec, items, floors, outdoorsAbsentValue: 1, cache });
    const b = deriveFloorProducts({ gridSpec: gspec, items, floors, outdoorsAbsentValue: 1, cache });
    t.ok('weather: an identical derive returns the SAME product object', a[0] === b[0]);
    const c = deriveFloorProducts({
      gridSpec: gspec,
      items: [base('roof', 10, { restrictsWeather: false })],
      floors,
      outdoorsAbsentValue: 1,
      cache,
    });
    t.ok('weather: clearing the box drops the weather product', c[0].weather === null);
  }

  // --- fractional fade composes proportionally --------------------------------------
  {
    const [f0] = derive([base('roof', 10, { restrictsWeather: true })]);
    const half = composeWeatherGate({ sky: f0.weather.sky, restrictors: f0.weather.restrictors, opacityOf: () => 0.5 });
    const v = half[(5 * 10 + 2) * 4];
    t.ok(`weather: half-faded roof lets about half the weather through (got ${v})`, Math.abs(v - 128) <= 2);
  }

  // --- the in-place buffer is reused -------------------------------------------------
  {
    const [f0] = derive([base('roof', 10, { restrictsWeather: true })]);
    const out = new Uint8Array(10 * 10 * 4);
    const ret = composeWeatherGate({ sky: f0.weather.sky, restrictors: f0.weather.restrictors, out });
    t.ok('weather: compose fills the supplied buffer in place', ret === out && out[(5 * 10 + 2) * 4 + 3] === 255);
  }

  // --- drips: a restrictor gets edges; a faded one loses them -------------------------
  {
    const [f0] = derive([base('awning', 5, { restrictsWeather: true })]);
    const solid = composeDripCover({ cover: f0.weather.cover, restrictors: f0.weather.restrictors });
    t.ok('drips: an awning that was never coverAbove is cover for the roofline', at(solid, 2, 5) === 255);
    const faded = composeDripCover({
      cover: f0.weather.cover,
      restrictors: f0.weather.restrictors,
      opacityOf: () => 0.2,
    });
    t.ok('drips: a mostly-faded tile stops being a roof', at(faded, 2, 5) === 0);
    t.ok(
      'drips: the roof key flips exactly when the threshold is crossed',
      dripRoofKey(f0.weather.restrictors, () => 0.8) === '1' && dripRoofKey(f0.weather.restrictors, () => 0.2) === '0'
    );
  }

  // --- through the mask authority: the flag on the item reaches the derive ---------------
  {
    const log = { info() {}, warn() {}, error() {}, debug() {} };
    const items = [
      { id: 'level:W0:background', kind: 'levelBackground', levelId: 'W0', hidden: false, key: { elevation: 0 } },
      { id: 'tile:awn', kind: 'tile', levelId: '', hidden: false, key: { elevation: 5 }, restrictsWeather: true },
      { id: 'tile:rug', kind: 'tile', levelId: '', hidden: false, key: { elevation: 5 } },
    ];
    const placements = {
      'level:W0:background': { x: 50, y: 50, width: 100, height: 100 },
      'tile:awn': { x: 25, y: 50, width: 50, height: 100 },
      'tile:rug': { x: 75, y: 50, width: 50, height: 100 },
    };
    const authority = createMaskAuthority({ readPageImageData: (bitmap) => bitmap, log });
    authority.reset({
      sceneKey: 'weather-scene',
      dimensions: { width: 200, height: 200, sceneRect: { x: 0, y: 0, width: 100, height: 100 } },
      floors: [{ index: 0, id: 'W0', name: 'Ground', ceilingElevation: 10, bottomElevation: 0 }],
      items,
      resolvePlacement: (item) => placements[item.id],
    });
    const solid = { w: 4, h: 4, data: new Uint8Array(16).fill(255) };
    for (const ownerId of ['tile:awn', 'tile:rug']) {
      authority.ingestItemAlpha({ ownerId, grid: solid, imageWidth: 100, imageHeight: 100 });
    }
    const wx = authority.getWeatherRestrictors(0);
    t.ok(
      'authority: only the flagged tile is a restrictor',
      !!wx && wx.restrictors.length === 1 && wx.restrictors[0].id === 'tile:awn'
    );
    t.ok('authority: an unknown floor has none', authority.getWeatherRestrictors(7) === null);
  }

  // --- opacity math ---------------------------------------------------------------
  t.ok('opacity: unfaded is fully there', tileOpacity(0, 0) === 1);
  t.ok('opacity: fully faded is the tile occluded alpha', tileOpacity(1, 0) === 0 && tileOpacity(1, 0.25) === 0.25);
  t.ok('opacity: a missing occluded alpha means Foundry default 0', tileOpacity(1, undefined) === 0);
  t.ok('opacity: quantised to the step, ends exact', quantizeOpacity(1) === 1 && quantizeOpacity(0) === 0);
  t.ok(
    'opacity: a tiny change does not move the quantised value',
    quantizeOpacity(0.5) === quantizeOpacity(0.5 + OPACITY_STEP / 4)
  );
}
