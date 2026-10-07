/**
 * wind-structure.test.mjs — the wind bake split by what each piece depends on
 * (2026-10-07), and the sealed-side-wins openness reduction. 100% pure: the one
 * THREE-dependent part (texture factories) is driven through a stub.
 *
 * THE SCENARIO THIS FILE EXISTS FOR (author: "I don't want fires and candles
 * and anything else which is indoors reacting to wind as if they were
 * outdoors"): a perfectly sealed room whose wall happens to fall inside the
 * same coarse cell as the outdoors. Measured BEFORE the fix, with every door
 * shut, openness inside that room read 0.5–1.0 at the wall and did not reach 0
 * until ~25–37 px in (a quarter to a third of a grid square). That is where a
 * hearth or a candle on a wall sits.
 */
import { computeWindBakeGridSpec } from '../wind-bake.js';
import {
  downsampleOpennessClasses,
  downsampleMax,
  downsampleDistanceMin,
  opennessFalloffFromDistance,
} from '../wind-enclosure.js';
import {
  bakeWindStructure,
  computeFineConnectivity,
  deriveWindOpenness,
  deriveWindShadow,
  sameWindGrid,
  writeHalfFloatChannel,
  writeSolidMaskData,
  createWindGridState,
  OPENNESS_TEXTURE_CHANNELS,
  WALL_AVOID_TEXTURE_CHANNELS,
  WIND_OPENNESS_REFINE,
} from '../wind-structure.js';

const GRID = 100;
const SCENE_W = 3000;
const SCENE_H = 2400;

function specFor(sceneW = SCENE_W, sceneH = SCENE_H, grid = GRID) {
  return computeWindBakeGridSpec({
    sceneX: 0,
    sceneY: 0,
    sceneWidth: sceneW,
    sceneHeight: sceneH,
    gridSizePixels: grid / 4,
    maxAxisCells: 512,
  });
}

/** A wall in the shape `readSceneWallSegments` produces. Doors are walls with `solid` toggled. */
function wall(x1, y1, x2, y2, { solid = true } = {}) {
  return { x1, y1, x2, y2, solid, blocksExterior: true };
}

/**
 * A rectangular building 1000x800 px with a door on its south wall. `o` shifts
 * the whole building by a sub-cell amount so the walls fall at different phases
 * inside a 25 px coarse cell. `gap` is the door width; `doorOpen` leaves it open.
 */
function building({ o = 0, gap = 100, doorOpen = false, partition = false } = {}) {
  const x0 = 1000 + o;
  const x1 = 2000 + o;
  const y0 = 800 + o;
  const y1 = 1600 + o;
  const dx = x0 + 400;
  const walls = [
    wall(x0, y0, x1, y0), // north
    wall(x1, y0, x1, y1), // east
    wall(x0, y1, dx, y1), // south, west of the door
    wall(dx, y1, dx + gap, y1, { solid: !doorOpen }), // THE DOOR
    wall(dx + gap, y1, x1, y1), // south, east of the door
    wall(x0, y1, x0, y0), // west
  ];
  if (partition) walls.push(wall(x0 + 700, y0, x0 + 700, y1)); // seals a 300 px-wide closet on the east
  return { walls, x0, x1, y0, y1, doorX: dx, gap };
}

/** The nearest-cell lookup every CPU consumer (and now the GPU texture) uses. */
function cellAt(structure, px, py) {
  const { gridSpec, cols, rows } = structure;
  const cx = Math.min(cols - 1, Math.max(0, Math.floor((px - gridSpec.minX) / gridSpec.cellSize)));
  const cy = Math.min(rows - 1, Math.max(0, Math.floor((py - gridSpec.minY) / gridSpec.cellSize)));
  return cy * cols + cx;
}

export function run(t) {
  const { ok } = t;

  // ── downsampleOpennessClasses: the rule itself, on a fixture small enough to read ──
  // 4x4 fine -> 2x2 coarse (factor 2). Fine value legend, per array:
  //   solid 1 = wall;  open 1 = reached from outside;  ext 1 = reached without a door.
  {
    const mk = (a) => Uint8Array.from(a);
    //            coarse(0,0)   coarse(1,0)   coarse(0,1)   coarse(1,1)
    // fine rows: [e e | s u]   wall + sealed pocket beside OUTDOOR cells
    //            [e e | s u]
    //            [i i | e e]   indoor-reached (via a door) cells only
    //            [i i | e e]   -> coarse(1,1) is plain outdoors
    const fineSolid = mk([0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const fineOpen = mk([1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1]);
    const fineOpenExterior = mk([1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1]);
    const fineDoorDistance = Int32Array.from([0, 0, -1, -1, 0, 0, -1, -1, 5, 3, 0, 0, 4, 2, 0, 0]);
    // Let coarse(0,0)'s right half be the sealed pocket instead, to build the straddle case:
    // cells (col 1 of coarse(0,0) is fine col 1) -> make fine (1,0) and (1,1) sealed.
    fineOpen[1] = 0;
    fineOpen[5] = 0;
    fineOpenExterior[1] = 0;
    fineOpenExterior[5] = 0;
    const out = downsampleOpennessClasses({ fineSolid, fineOpen, fineOpenExterior, fineDoorDistance }, 2, 2, 2);
    ok(
      'a coarse cell holding BOTH an outdoor cell and a sealed pocket reads SEALED (the straddling-wall leak)',
      out.exterior[0] === 0 && out.doorDistance[0] === -1
    );
    ok(
      'a coarse cell with a wall and a sealed pocket but no outdoor cell also reads sealed',
      out.exterior[1] === 0 && out.doorDistance[1] === -1
    );
    ok(
      'a coarse cell reached only through a door reports the NEAREST threshold distance (generous, as before)',
      out.exterior[2] === 0 && out.doorDistance[2] === 2
    );
    ok('a plain outdoor coarse cell reads exterior 1', out.exterior[3] === 1 && out.doorDistance[3] === -1);
    ok(
      'degenerate / mismatched input fails to all-sealed, never throws',
      downsampleOpennessClasses(null, 2, 2, 2).exterior.every((v) => v === 0) &&
        downsampleOpennessClasses({ fineSolid, fineOpen, fineOpenExterior, fineDoorDistance }, 0, 0, 2).exterior
          .length === 0 &&
        downsampleOpennessClasses(
          { fineSolid: mk([1]), fineOpen, fineOpenExterior, fineDoorDistance },
          2,
          2,
          2
        ).doorDistance.every((v) => v === -1)
    );
  }

  // A wall cell on the FIRST row of its coarse cell, with the whole sealed room in
  // the coarse cell BESIDE it: the wall's own block sees only outdoor cells, yet
  // it is the wall of the sealed space and must read sealed (the eight-phase
  // test's 3 px and 21 px corners leaked exactly here).
  {
    const mk = (a) => Uint8Array.from(a);
    //   row 0:  e e | e e
    //   row 1:  S S | e e     <- wall, first row of coarse(0,0)'s... lower half
    //   row 2:  u u | e e     <- sealed pocket, in the coarse cell BELOW the wall
    //   row 3:  u u | e e
    const fineSolid = mk([0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const fineOpen = mk([1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1]);
    const fineOpenExterior = Uint8Array.from(fineOpen);
    const fineDoorDistance = new Int32Array(16).fill(-1);
    const out = downsampleOpennessClasses({ fineSolid, fineOpen, fineOpenExterior, fineDoorDistance }, 2, 2, 2);
    ok(
      'a wall cell whose pocket lies in the NEIGHBOURING coarse cell still seals its own cell (the corner leak)',
      out.exterior[0] === 0 && out.exterior[2] === 0
    );
    ok('the open column beside it is untouched', out.exterior[1] === 1 && out.exterior[3] === 1);
  }

  // ── no walls: wind everywhere, at every speed ──────────────────────────────
  {
    const s = bakeWindStructure({ walls: [], gridSpec: specFor() });
    const o = deriveWindOpenness(s, 0.4);
    ok(
      'no walls at all -> openness 1 in every cell (the author\'s own "delete every wall" test)',
      o.every((v) => v === 1)
    );
    ok(
      'no walls -> no wall avoidance and no solid cells',
      s.solidMask.every((v) => v === 0) && s.wallProximity.every((v) => v === 0)
    );
  }

  // ── A SEALED BUILDING, DOOR SHUT, AT EIGHT WALL PHASES ─────────────────────
  // Every position inside reads EXACTLY 0 at every speed — including the ones
  // within a few pixels of an outside wall, which used to read 0.5–1.0.
  {
    const phases = [0, 3, 7, 10, 13, 17, 21, 24];
    let worstInterior = 0;
    let interiorChecked = 0;
    let outdoorsMin = 1;
    for (const o of phases) {
      const b = building({ o, doorOpen: false });
      const s = bakeWindStructure({ walls: b.walls, gridSpec: specFor() });
      for (const speed of [0, 0.5, 1]) {
        const open = deriveWindOpenness(s, speed);
        for (let px = b.x0 + 1; px < b.x1; px += 4) {
          for (let py = b.y0 + 1; py < b.y1; py += 4) {
            worstInterior = Math.max(worstInterior, open[cellAt(s, px, py)]);
            interiorChecked++;
          }
        }
        // Open ground comfortably away from the building (>= 40 px from any wall).
        for (let px = 100; px < SCENE_W - 100; px += 50) {
          for (let py = 100; py < SCENE_H - 100; py += 50) {
            const nearBuilding = px > b.x0 - 40 && px < b.x1 + 40 && py > b.y0 - 40 && py < b.y1 + 40;
            if (nearBuilding) continue;
            outdoorsMin = Math.min(outdoorsMin, open[cellAt(s, px, py)]);
          }
        }
      }
    }
    ok(
      `a sealed building reads openness EXACTLY 0 at every interior point, any wall phase, any speed ` +
        `(${interiorChecked} points, worst ${worstInterior})`,
      worstInterior === 0 && interiorChecked > 100000
    );
    ok('open ground away from walls still reads exactly 1', outdoorsMin === 1);
  }

  // ── THE REGRESSION, PROVEN: the OLD reduction leaked on this very data ──────
  // Run the previous rule ("any reached fine cell wins": downsampleMax +
  // downsampleDistanceMin) on the SAME fine connectivity and show it read
  // outdoor air inside a sealed room — so the test above is not vacuous, and
  // would have failed before the fix rather than merely passing beside it.
  {
    let oldWorst = 0;
    let newWorst = 0;
    const spec = specFor();
    for (const o of [0, 10, 17]) {
      const b = building({ o, doorOpen: false });
      const fine = computeFineConnectivity(b.walls, spec);
      const R = WIND_OPENNESS_REFINE;
      const oldExterior = downsampleMax(fine.fineOpenExterior, spec.cols, spec.rows, R);
      const oldDist = downsampleDistanceMin(fine.fineDoorDistance, spec.cols, spec.rows, R);
      const oldOpenness = opennessFalloffFromDistance(oldDist, oldExterior, { reachCells: 120 * R * 0.5 });
      const s = bakeWindStructure({ walls: b.walls, gridSpec: spec });
      const newOpenness = deriveWindOpenness(s, 0.5);
      for (let px = b.x0 + 1; px < b.x1; px += 3) {
        for (let py = b.y0 + 1; py < b.y1; py += 3) {
          const i = cellAt(s, px, py);
          oldWorst = Math.max(oldWorst, oldOpenness[i]);
          newWorst = Math.max(newWorst, newOpenness[i]);
        }
      }
    }
    ok(`the previous "any reached cell wins" rule read ${oldWorst} inside a sealed room (the bug)`, oldWorst === 1);
    ok(`the sealed-side-wins rule reads ${newWorst} on the identical fine data (the fix)`, newWorst === 0);
  }

  // ── AN OPEN DOOR ADMITS WIND, AND THE DIAL ONLY MOVES HOW FAR ──────────────
  {
    const b = building({ doorOpen: true });
    const s = bakeWindStructure({ walls: b.walls, gridSpec: specFor() });
    const calm = deriveWindOpenness(s, 0);
    const breezy = deriveWindOpenness(s, 0.5);
    const gale = deriveWindOpenness(s, 1);
    const nearDoor = cellAt(s, b.doorX + b.gap / 2, b.y1 - 40);
    const deep = cellAt(s, b.doorX + b.gap / 2, b.y0 + 60);
    ok('an open door admits wind just inside it', calm[nearDoor] > 0.5 && gale[nearDoor] > 0.9);
    ok(
      'the same room, deep inside: nothing at a dead calm, something at a gale (the dial moves the REACH)',
      calm[deep] === 0 && gale[deep] > 0
    );
    ok(
      'openness is monotone in wind speed everywhere',
      calm.every((v, i) => v <= breezy[i] + 1e-6 && breezy[i] <= gale[i] + 1e-6)
    );
    let sealedMoved = false;
    let outdoorsMoved = false;
    for (let i = 0; i < calm.length; i++) {
      if (s.exterior[i] === 1 && (calm[i] !== 1 || gale[i] !== 1)) outdoorsMoved = true;
      if (s.exterior[i] === 0 && s.doorDistance[i] < 0 && (calm[i] !== 0 || gale[i] !== 0)) sealedMoved = true;
    }
    ok(
      'outdoors is 1 and sealed cells are 0 at EVERY speed — the dial never touches either',
      !sealedMoved && !outdoorsMoved
    );
    ok(
      'speed changes are a pure function of the cached structure (deriveWindOpenness is deterministic, allocation-only)',
      deriveWindOpenness(s, 0.5).every((v, i) => v === breezy[i])
    );

    // The same building with the door shut again: the whole interior drops back to 0.
    const shut = bakeWindStructure({ walls: building({ doorOpen: false }).walls, gridSpec: specFor() });
    ok(
      'shutting the door drops the whole interior back to 0 (door-responsive by construction)',
      deriveWindOpenness(shut, 1)[deep] === 0 && deriveWindOpenness(shut, 1)[nearDoor] === 0
    );
  }

  // ── A DOORWAY NARROWER THAN A COARSE CELL STILL ADMITS WIND ────────────────
  // (The floor is the FINE cell, 6.25 px at a 100 px grid: both wall endpoints
  // round outward to a whole fine cell, so a gap under ~12 px never existed in
  // the rasterization at all — true before this change too. 20 px is the
  // narrowest "less than one coarse cell" doorway the bake can represent.)
  {
    const b = building({ doorOpen: true, gap: 20 });
    const s = bakeWindStructure({ walls: b.walls, gridSpec: specFor() });
    const open = deriveWindOpenness(s, 1);
    ok(
      'a 20 px gap (less than one 25 px coarse cell) is not fused shut: air still reaches the room behind it',
      open[cellAt(s, b.doorX + 10, b.y1 - 30)] > 0 && open[cellAt(s, b.doorX + 10, b.y1 - 80)] > 0
    );
  }

  // ── A SEALED CLOSET BEHIND AN OPEN DOOR STAYS CALM ─────────────────────────
  {
    const b = building({ doorOpen: true, partition: true });
    const s = bakeWindStructure({ walls: b.walls, gridSpec: specFor() });
    const open = deriveWindOpenness(s, 1);
    const mainRoom = cellAt(s, b.x0 + 400, b.y0 + 400);
    const closet = cellAt(s, b.x0 + 850, b.y0 + 400);
    ok(
      'the connected room reads open and the walled-off closet beside it reads exactly 0',
      open[mainRoom] > 0 && open[closet] === 0
    );
    let closetMax = 0;
    for (let px = b.x0 + 702; px < b.x1; px += 4) {
      for (let py = b.y0 + 2; py < b.y1; py += 4) closetMax = Math.max(closetMax, open[cellAt(s, px, py)]);
    }
    ok(`every point in the closet is 0, right up to the partition (max ${closetMax})`, closetMax === 0);
  }

  // ── A FREE-STANDING WALL IN THE OPEN: both sides stay windy ────────────────
  {
    const s = bakeWindStructure({ walls: [wall(500, 1200, 900, 1200)], gridSpec: specFor() });
    const open = deriveWindOpenness(s, 0.5);
    ok(
      'a wall with outdoors on BOTH sides has no calm band — only a sealed side may veto',
      open[cellAt(s, 700, 1190)] === 1 && open[cellAt(s, 700, 1210)] === 1 && open[cellAt(s, 700, 1200)] === 1
    );
  }

  // ── THE SHADOW: direction in, buildings shelter their lee ──────────────────
  {
    const b = building({ doorOpen: false });
    const s = bakeWindStructure({ walls: b.walls, gridSpec: specFor() });
    // directionDeg names where the wind blows TOWARD: 90 = east, so the LEE is the east side.
    const east = deriveWindShadow(s, 90);
    const west = deriveWindShadow(s, 270);
    const lee = cellAt(s, b.x1 + 40, (b.y0 + b.y1) / 2);
    const windward = cellAt(s, b.x0 - 40, (b.y0 + b.y1) / 2);
    ok(
      'a building shelters the side it blows away from (wind to the east: shadow on the east)',
      east[lee] > 0 && east[windward] === 0
    );
    ok(
      'turning the compass moves the shadow to the other side of the same building',
      west[windward] > 0 && west[lee] === 0
    );
    ok(
      'no walls, no shadow',
      deriveWindShadow(bakeWindStructure({ walls: [], gridSpec: specFor() }), 90).every((v) => v === 0)
    );
  }

  // ── structure bake products are the right shape ────────────────────────────
  {
    const spec = specFor();
    const s = bakeWindStructure({ walls: building().walls, gridSpec: spec });
    const n = spec.cols * spec.rows;
    ok(
      'every structure array is cols x rows',
      s.solidMask.length === n &&
        s.wallAvoidDirX.length === n &&
        s.wallAvoidDirY.length === n &&
        s.wallProximity.length === n &&
        s.exterior.length === n &&
        s.doorDistance.length === n
    );
    ok('the structure carries the grid it was baked on', sameWindGrid(s.gridSpec, spec) && s.cols === spec.cols);
    ok('WIND_OPENNESS_REFINE is the fine/coarse factor the door distance is expressed in', WIND_OPENNESS_REFINE === 4);
  }

  // ── sameWindGrid ───────────────────────────────────────────────────────────
  {
    const a = { minX: 0, minY: 0, cols: 10, rows: 8, cellSize: 25 };
    ok('sameWindGrid: identical specs match', sameWindGrid(a, { ...a }));
    ok('sameWindGrid: a different cell size is a different grid', !sameWindGrid(a, { ...a, cellSize: 20 }));
    ok('sameWindGrid: a different origin is a different grid', !sameWindGrid(a, { ...a, minX: 100 }));
    ok('sameWindGrid: a different size is a different grid', !sameWindGrid(a, { ...a, cols: 11 }));
    ok('sameWindGrid: null never matches', !sameWindGrid(null, a) && !sameWindGrid(a, undefined));
  }

  // ── in-place writers ───────────────────────────────────────────────────────
  {
    const data = new Uint16Array(4 * 3);
    const toHalf = (v) => Math.round(v * 100);
    writeHalfFloatChannel(data, 2, [0.5, 1, NaN], toHalf, 0.25);
    ok(
      'writeHalfFloatChannel writes ONLY its channel, and a non-finite sample takes the fallback',
      data[2] === 50 &&
        data[6] === 100 &&
        data[10] === 25 &&
        data[0] === 0 &&
        data[1] === 0 &&
        data[3] === 0 &&
        data[4] === 0
    );
    writeHalfFloatChannel(data, 2, [0, 0, 0], toHalf);
    ok('rewriting the same array overwrites in place (no reallocation needed)', data[2] === 0 && data[6] === 0);
    const solid = new Uint8Array(4 * 3);
    writeSolidMaskData(solid, [1, 0, 1]);
    ok(
      'writeSolidMaskData expands 0/1 to crisp RGBA 0/255 with opaque alpha',
      solid[0] === 255 && solid[3] === 255 && solid[4] === 0 && solid[7] === 255 && solid[8] === 255
    );
  }

  // ── THE GRID STATE: A REBAKE ON THE SAME GRID REWRITES IN PLACE ────────────
  // The property the whole "no shader rebuild on a wind change" design rests on,
  // and the kind that fails silently and only shows live: a rebake on the same
  // grid must hand back the SAME texture objects, the SAME backing arrays and
  // the SAME openness/shadow arrays — new CONTENTS only. A new texture object is
  // a new shader binding, which is what forced every consumer to rebuild.
  {
    // The three constructors arrive INJECTED (gpu/textures-in-vt-only keeps every
    // `new …Texture(` in vt/); a stub records which factory made which texture, and
    // counts re-uploads (`needsUpdate` -> version) and disposals.
    class StubTexture {
      constructor(kind, data, w, h) {
        Object.assign(this, { kind, data, w, h });
        this.version = 0;
        this.disposed = false;
      }
      set needsUpdate(v) {
        if (v) this.version++;
      }
      dispose() {
        this.disposed = true;
      }
    }
    const textures = {
      createOpennessTexture: (data, w, h) => new StubTexture('openness', data, w, h),
      createWallAvoidTexture: (data, w, h) => new StubTexture('wallAvoid', data, w, h),
      createSolidMaskTexture: (data, w, h) => new StubTexture('solid', data, w, h),
    };
    const toHalf = (v) => Math.round(v * 1000);
    const spec = specFor();
    const bOpen = building({ doorOpen: true });
    const bShut = building({ doorOpen: false });
    const sOpen = bakeWindStructure({ walls: bOpen.walls, gridSpec: spec });
    const sShut = bakeWindStructure({ walls: bShut.walls, gridSpec: spec });
    const GALE = { speed01: 1, directionDeg: 90 };
    const CALM = { speed01: 0, directionDeg: 90 };
    const deepCell = cellAt(sOpen, bOpen.doorX + bOpen.gap / 2, bOpen.y0 + 60);
    const ch = OPENNESS_TEXTURE_CHANNELS;
    const wch = WALL_AVOID_TEXTURE_CHANNELS;

    const g = createWindGridState({ textures, toHalf });
    ok(
      'before any bake the grid state holds nothing',
      g.structure === null && g.cells === null && g.opennessTexture === null
    );
    g.applyAmbient(GALE, { speedChanged: true, directionChanged: true }); // must not throw with no structure
    ok('a dial change before the first bake is a harmless no-op', g.structure === null);

    const first = g.applyStructure(sOpen, GALE);
    const tex = { open: g.opennessTexture, wa: g.wallAvoidTexture, solid: g.solidMaskTexture };
    const arrays = {
      openData: tex.open.data,
      waData: tex.wa.data,
      solidData: tex.solid.data,
      openness: g.cells.openness,
      shadow: g.cells.windShadow,
    };
    ok(
      'the first bake is a (re)grid and creates all three textures',
      first.regrid === true && tex.open && tex.wa && tex.solid
    );
    ok(
      'the openness texture carries the gale-reach openness in B and the exterior flag in A',
      tex.open.data[deepCell * 4 + ch.openness] === Math.round(deriveWindOpenness(sOpen, 1)[deepCell] * 1000) &&
        tex.open.data[deepCell * 4 + ch.openness] > 0 &&
        tex.open.data[deepCell * 4 + 0] === 0 &&
        tex.open.data[deepCell * 4 + 1] === 0 // R/G stay 0 — Tier 2 reads them as a velocity
    );
    ok(
      'each slot is built by its OWN factory (the filters live in vt/wind-grid-textures.js and are pinned there)',
      tex.open.kind === 'openness' && tex.wa.kind === 'wallAvoid' && tex.solid.kind === 'solid'
    );
    ok(
      'a grid state with no way to make textures refuses to exist, loudly (never a default that fails later)',
      (() => {
        try {
          createWindGridState({ toHalf });
          return false;
        } catch (err) {
          return err instanceof TypeError;
        }
      })() &&
        (() => {
          try {
            createWindGridState({ textures });
            return false;
          } catch (err) {
            return err instanceof TypeError;
          }
        })()
    );

    // SAME GRID, DOOR NOW SHUT — a wall/door edit.
    const versionsBefore = { open: tex.open.version, wa: tex.wa.version, solid: tex.solid.version };
    const second = g.applyStructure(sShut, GALE);
    ok('a rebake on the same grid is NOT a regrid', second.regrid === false);
    ok(
      'ALL THREE textures are the SAME objects — a new texture object is a new shader binding',
      g.opennessTexture === tex.open && g.wallAvoidTexture === tex.wa && g.solidMaskTexture === tex.solid
    );
    ok(
      'the backing arrays and the stable openness/shadow arrays are the SAME objects, rewritten in place',
      g.opennessTexture.data === arrays.openData &&
        g.wallAvoidTexture.data === arrays.waData &&
        g.solidMaskTexture.data === arrays.solidData &&
        g.cells.openness === arrays.openness &&
        g.cells.windShadow === arrays.shadow
    );
    ok(
      'the textures were flagged for re-upload (the GPU sees the new contents)',
      tex.open.version > versionsBefore.open &&
        tex.wa.version > versionsBefore.wa &&
        tex.solid.version > versionsBefore.solid
    );
    ok(
      'the contents really changed: shutting the door zeroed the room that the open door had reached',
      g.opennessTexture.data[deepCell * 4 + ch.openness] === 0 && g.cells.openness[deepCell] === 0
    );
    ok('no texture was disposed by a same-grid rebake', !tex.open.disposed && !tex.wa.disposed && !tex.solid.disposed);

    // THE DIAL — only the channel it owns is touched, and only that texture re-uploads.
    g.applyStructure(sOpen, CALM);
    const calmReading = g.cells.openness[deepCell];
    const v0 = { open: tex.open.version, wa: tex.wa.version };
    const shadowBefore = Float32Array.from(g.cells.windShadow);
    g.applyAmbient(GALE, { speedChanged: true, directionChanged: false });
    ok(
      'a SPEED change rewrites openness (deep in the room: calm reads less than gale) and re-uploads only the openness texture',
      g.cells.openness[deepCell] > calmReading &&
        tex.open.version > v0.open &&
        tex.wa.version === v0.wa &&
        g.cells.windShadow.every((v, i) => v === shadowBefore[i])
    );
    const v1 = { open: tex.open.version, wa: tex.wa.version };
    const opennessBefore = Float32Array.from(g.cells.openness);
    g.applyAmbient({ speed01: 1, directionDeg: 270 }, { speedChanged: false, directionChanged: true });
    ok(
      'a DIRECTION change rewrites the shadow and re-uploads only the wall-avoid texture',
      tex.wa.version > v1.wa &&
        tex.open.version === v1.open &&
        g.cells.openness.every((v, i) => v === opennessBefore[i]) &&
        g.cells.windShadow.some((v, i) => v !== shadowBefore[i])
    );
    const v2 = { open: tex.open.version, wa: tex.wa.version };
    g.applyAmbient(GALE, { speedChanged: false, directionChanged: false });
    ok(
      'a dial "change" that changed nothing re-uploads nothing',
      tex.open.version === v2.open && tex.wa.version === v2.wa
    );

    // A DIFFERENT GRID — a different scene.
    const otherSpec = specFor(2000, 1500);
    const sOther = bakeWindStructure({ walls: [], gridSpec: otherSpec });
    const third = g.applyStructure(sOther, GALE);
    ok('a different grid IS a regrid', third.regrid === true);
    ok(
      'a regrid replaces the textures and disposes the old ones',
      g.opennessTexture !== tex.open &&
        g.wallAvoidTexture !== tex.wa &&
        g.solidMaskTexture !== tex.solid &&
        tex.open.disposed &&
        tex.wa.disposed &&
        tex.solid.disposed
    );
    ok(
      'the new textures are sized for the new grid',
      g.opennessTexture.w === otherSpec.cols &&
        g.opennessTexture.h === otherSpec.rows &&
        g.cells.openness.length === otherSpec.cols * otherSpec.rows
    );
    const fresh = { open: g.opennessTexture, wa: g.wallAvoidTexture, solid: g.solidMaskTexture };
    g.dispose();
    ok(
      'dispose frees every texture and forgets the structure',
      fresh.open.disposed && fresh.wa.disposed && fresh.solid.disposed && g.structure === null && g.cells === null
    );
    ok(
      'the wall-avoid channels are the documented ones (so the shader and the writers cannot drift)',
      wch.dirX === 0 &&
        wch.dirY === 1 &&
        wch.proximity === 2 &&
        wch.shadow === 3 &&
        ch.openness === 2 &&
        ch.exterior === 3
    );
  }
}
