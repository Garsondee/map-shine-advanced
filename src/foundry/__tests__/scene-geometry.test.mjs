/**
 * Node verification for foundry/scene-geometry.js — THE coordinate model.
 *
 * These tests are transcriptions-of-record: each block asserts against the
 * formula as it appears in the vendored v14 source, not against what looks
 * reasonable. A silent error here misplaces every drawable in the renderer by a
 * constant offset — the class of bug that looks like "the art is fine" until a
 * tile lands 3000px from where the author put it.
 */
import {
  computeSceneDimensions,
  computeTextureFit,
  computeQuadCorners,
  computeQuadBounds,
  computeLevelTexturePlacement,
  computeTilePlacement,
} from '../scene-geometry.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

export function run(t) {
  const { ok, throws } = t;

  // --- computeSceneDimensions: the padding default nobody expects -----------
  {
    // Foundry's schema initials: width 4000, height 3000, padding 0.25, grid 100.
    const d = computeSceneDimensions({ width: 4000, height: 3000, padding: 0.25, grid: { size: 100 } });
    // x = ceil(0.25*4000/100)*100 = ceil(10)*100 = 1000
    // y = ceil(0.25*3000/100)*100 = ceil(7.5)*100 = 800   <-- grid-snapped UP, not 750
    ok('dimensions: padding X is grid-snapped (1000)', d.sceneX === 1000);
    ok('dimensions: padding Y snaps UP to a grid multiple (800, not 750)', d.sceneY === 800);
    ok('dimensions: canvas width = sceneWidth + 2x', d.width === 4000 + 2000);
    ok('dimensions: canvas height = sceneHeight + 2y', d.height === 3000 + 1600);
    ok('dimensions: rect origin is 0,0', d.rect.x === 0 && d.rect.y === 0);
    ok('dimensions: sceneRect is INSET inside the canvas', d.sceneRect.x === 1000 && d.sceneRect.y === 800);
    ok(
      'dimensions: sceneRect keeps the authored scene size',
      d.sceneRect.width === 4000 && d.sceneRect.height === 3000
    );
    // The headline: on a DEFAULT scene the canvas is not the art.
    ok(
      'dimensions: default scene canvas is ~1.5x the art (the assumption that was wrong)',
      d.width === 6000 && d.height === 4600
    );
  }

  // --- computeSceneDimensions: padding 0 makes canvas == scene --------------
  {
    // The author's mansion case. This is why the old image-is-the-world model
    // has survived: with zero padding the two spaces coincide exactly.
    const d = computeSceneDimensions({ width: 12000, height: 12000, padding: 0, grid: { size: 100 } });
    ok('padding 0: canvas rect == scene rect', d.width === 12000 && d.height === 12000);
    ok('padding 0: no inset', d.sceneX === 0 && d.sceneY === 0);
  }

  // --- computeSceneDimensions: shiftX/shiftY offset the art -----------------
  {
    const d = computeSceneDimensions({
      width: 4000,
      height: 3000,
      padding: 0.25,
      grid: { size: 100 },
      shiftX: 50,
      shiftY: -25,
    });
    ok('shiftX subtracts from sceneX', d.sceneX === 1000 - 50);
    ok('shiftY subtracts from sceneY', d.sceneY === 800 + 25);
    ok('shift does not change canvas size', d.width === 6000 && d.height === 4600);
  }

  // --- computeSceneDimensions: defaults match the schema --------------------
  {
    const d = computeSceneDimensions({});
    ok(
      'defaults: schema initials (4000x3000, pad .25, grid 100)',
      d.sceneWidth === 4000 && d.sceneHeight === 3000 && d.width === 6000
    );
    ok('defaults: null doc does not throw', computeSceneDimensions(null).width === 6000);
  }

  // --- computeTextureFit: every mode, against Foundry's switch --------------
  {
    const tex = { width: 400, height: 200 }; // 2:1 texture
    const box = { width: 800, height: 800 }; // 1:1 box

    const fill = computeTextureFit(tex, box, { fit: 'fill' });
    ok('fit fill: independent axes (2, 4)', near(fill.scaleX, 2) && near(fill.scaleY, 4));
    ok('fit fill: fills the box exactly', near(fill.width, 800) && near(fill.height, 800));

    const cover = computeTextureFit(tex, box, { fit: 'cover' });
    ok('fit cover: max ratio (4)', near(cover.scaleX, 4) && near(cover.scaleY, 4));
    ok('fit cover: overflows one axis', near(cover.width, 1600) && near(cover.height, 800));

    const contain = computeTextureFit(tex, box, { fit: 'contain' });
    ok('fit contain: min ratio (2)', near(contain.scaleX, 2) && near(contain.scaleY, 2));
    ok('fit contain: letterboxes inside the box', near(contain.width, 800) && near(contain.height, 400));

    const w = computeTextureFit(tex, box, { fit: 'width' });
    ok('fit width: both axes from width ratio (2)', near(w.scaleX, 2) && near(w.scaleY, 2));

    const h = computeTextureFit(tex, box, { fit: 'height' });
    ok('fit height: both axes from height ratio (4)', near(h.scaleX, 4) && near(h.scaleY, 4));

    ok('fit: defaults to fill', near(computeTextureFit(tex, box).scaleX, 2));
    throws(
      'fit: unknown mode throws rather than guessing',
      () => computeTextureFit(tex, box, { fit: 'stretch' }),
      'invalid fit mode'
    );
    throws(
      'fit: zero-size texture throws',
      () => computeTextureFit({ width: 0, height: 10 }, box),
      'invalid textureWidth'
    );
    throws('fit: negative box throws', () => computeTextureFit(tex, { width: -1, height: 10 }), 'invalid baseWidth');
  }

  // --- computeTextureFit: the SIGN of scale must survive (flipping) ---------
  {
    const tex = { width: 100, height: 100 };
    const box = { width: 100, height: 100 };
    const flipped = computeTextureFit(tex, box, { fit: 'fill', scaleX: -1 });
    ok('fit: negative scaleX is preserved (this is how Foundry flips a tile)', flipped.scaleX === -1);
    ok('fit: reported width is absolute, as Foundry reports it', flipped.width === 100);
    const flippedY = computeTextureFit(tex, box, { fit: 'fill', scaleY: -2 });
    ok('fit: negative scaleY preserved', flippedY.scaleY === -2 && flippedY.height === 200);
  }

  // --- computeQuadCorners: anchor semantics --------------------------------
  {
    // Default anchor 0.5/0.5 → (x,y) is the CENTRE, not the top-left. This is
    // the single easiest thing to get wrong about tile placement.
    const c = computeQuadCorners({ x: 100, y: 100, width: 40, height: 20 });
    ok(
      'corners: default anchor centres the quad on x,y',
      c[0].x === 80 && c[0].y === 90 && c[2].x === 120 && c[2].y === 110
    );

    // anchor 0,0 → (x,y) IS the top-left.
    const tl = computeQuadCorners({ x: 100, y: 100, width: 40, height: 20, anchorX: 0, anchorY: 0 });
    ok(
      'corners: anchor 0,0 puts the top-left at x,y',
      tl[0].x === 100 && tl[0].y === 100 && tl[2].x === 140 && tl[2].y === 120
    );

    // anchor 1,1 → (x,y) is the bottom-right.
    const br = computeQuadCorners({ x: 100, y: 100, width: 40, height: 20, anchorX: 1, anchorY: 1 });
    ok('corners: anchor 1,1 puts the bottom-right at x,y', br[2].x === 100 && br[2].y === 100 && br[0].x === 60);

    ok(
      'corners: returns 4 corners in uv order (0,0),(1,0),(1,1),(0,1)',
      c.length === 4 && c[1].x === 120 && c[1].y === 90 && c[3].x === 80 && c[3].y === 110
    );
  }

  // --- computeQuadCorners: rotation, cross-checked vs Foundry's centre ------
  {
    // Foundry's OWN centre formula (RectangleShapeData#_createCenter, shapes.mjs
    // :801), transcribed. Our corners must agree with it at (u,v)=(0.5,0.5) for
    // arbitrary anchors and rotations — that's the proof the rotation pivot is
    // the anchor point and not the centre.
    const foundryCentre = ({ x, y, width, height, anchorX, anchorY, rotation }) => {
      const a = (rotation * Math.PI) / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const dx = (0.5 - anchorX) * width;
      const dy = (0.5 - anchorY) * height;
      return { x: x + (cos * dx - sin * dy), y: y + (sin * dx + cos * dy) };
    };

    let mismatches = 0;
    for (const rotation of [0, 30, 45, 90, 180, 270, 315, -45]) {
      for (const [anchorX, anchorY] of [
        [0.5, 0.5],
        [0, 0],
        [1, 1],
        [0.25, 0.75],
      ]) {
        const p = { x: 500, y: 300, width: 200, height: 80, anchorX, anchorY, rotation };
        const corners = computeQuadCorners(p);
        // Centre of the quad = mean of its 4 corners (exact for a parallelogram).
        const mx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
        const my = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;
        const ref = foundryCentre(p);
        if (!near(mx, ref.x, 1e-9) || !near(my, ref.y, 1e-9)) mismatches++;
      }
    }
    ok("PARITY: corner centroid matches Foundry's _createCenter for 32 anchor/rotation combos", mismatches === 0);
  }

  // --- computeQuadCorners: rotation is around the ANCHOR, not the centre ----
  {
    // anchor 0,0 + 90° → the quad swings around its top-left corner, which must
    // stay pinned at (x,y).
    const c = computeQuadCorners({ x: 100, y: 100, width: 40, height: 20, anchorX: 0, anchorY: 0, rotation: 90 });
    ok('rotation: the anchor point stays pinned', near(c[0].x, 100) && near(c[0].y, 100));
    // (1,0) local (40,0) rotated 90° → (0,40) → world (100,140). Y-down means
    // +90° swings +X toward +Y (clockwise on screen).
    ok('rotation: +90 maps +X to +Y (clockwise on a Y-down screen)', near(c[1].x, 100) && near(c[1].y, 140));
  }

  // --- computeQuadCorners: rotation preserves size --------------------------
  {
    const p = { x: 0, y: 0, width: 300, height: 100, rotation: 37 };
    const c = computeQuadCorners(p);
    const edge = Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y);
    const edge2 = Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y);
    ok('rotation: rigid — top edge keeps its length', near(edge, 300, 1e-9));
    ok('rotation: rigid — left edge keeps its length', near(edge2, 100, 1e-9));
  }

  // --- computeQuadBounds ---------------------------------------------------
  {
    const b = computeQuadBounds({ x: 100, y: 100, width: 40, height: 20 });
    ok('bounds: unrotated matches the quad', b.minX === 80 && b.minY === 90 && b.maxX === 120 && b.maxY === 110);
    // A 90°-rotated 40x20 quad occupies a 20x40 box — bounds must come from the
    // real corners, not from width/height.
    const r = computeQuadBounds({ x: 100, y: 100, width: 40, height: 20, rotation: 90 });
    ok('bounds: rotated 90 swaps the extents', near(r.maxX - r.minX, 20) && near(r.maxY - r.minY, 40));
    // A 45°-rotated square grows its AABB by sqrt(2).
    const d = computeQuadBounds({ x: 0, y: 0, width: 100, height: 100, rotation: 45 });
    ok('bounds: rotated 45 square grows the AABB by sqrt(2)', near(d.maxX - d.minX, 100 * Math.SQRT2, 1e-9));
  }

  // --- computeLevelTexturePlacement: padding-correct level art --------------
  {
    const dims = computeSceneDimensions({ width: 4000, height: 3000, padding: 0.25, grid: { size: 100 } });
    // A 4000x3000 image backing a 4000x3000 scene: 1:1, centred in sceneRect.
    const p = computeLevelTexturePlacement({ width: 4000, height: 3000 }, dims);
    ok('level art: centred on the sceneRect centre', p.x === 1000 + 2000 && p.y === 800 + 1500);
    ok('level art: fills the sceneRect', near(p.width, 4000) && near(p.height, 3000));
    const corners = computeQuadCorners(p);
    // THE payoff: level art lands at the sceneRect, INSET by the padding —
    // not stretched across the padded canvas.
    ok(
      'level art: top-left corner sits at the sceneRect origin, not the canvas origin',
      near(corners[0].x, 1000) && near(corners[0].y, 800)
    );
    ok(
      'level art: bottom-right corner sits at the sceneRect end',
      near(corners[2].x, 5000) && near(corners[2].y, 3800)
    );
  }

  // --- computeLevelTexturePlacement: art at a DIFFERENT native resolution ---
  {
    // scene.width/height are canvas pixels, NOT the image's resolution. A
    // 2000x1500 image backs a 4000x3000 scene: Foundry scales it up 2x.
    const dims = computeSceneDimensions({ width: 4000, height: 3000, padding: 0, grid: { size: 100 } });
    const p = computeLevelTexturePlacement({ width: 2000, height: 1500 }, dims);
    ok(
      'level art: half-res image is scaled to fill the scene',
      near(p.width, 4000) && near(p.height, 3000) && near(p.scaleX, 2)
    );
  }

  // --- computeLevelTexturePlacement: offset + fit ---------------------------
  {
    const dims = computeSceneDimensions({ width: 1000, height: 1000, padding: 0, grid: { size: 100 } });
    const p = computeLevelTexturePlacement({ width: 500, height: 1000 }, dims, {
      offsetX: 25,
      offsetY: -10,
      fit: 'contain',
    });
    ok('level art: offset shifts the anchor', p.x === 500 + 25 && p.y === 500 - 10);
    ok(
      'level art: contain letterboxes (500x1000 into 1000x1000 → 500x1000)',
      near(p.width, 500) && near(p.height, 1000)
    );
  }

  // --- computeTilePlacement -------------------------------------------------
  {
    // A tile whose art is authored at exactly its box size.
    const p = computeTilePlacement({ width: 200, height: 100 }, { x: 1500, y: 900, width: 200, height: 100 });
    ok('tile: position is the document x,y', p.x === 1500 && p.y === 900);
    ok('tile: fill fit gives 1:1', near(p.width, 200) && near(p.height, 100) && near(p.scaleX, 1));
    ok('tile: default anchor is 0.5 (so x,y is the CENTRE)', p.anchorX === 0.5 && p.anchorY === 0.5);
    const c = computeQuadCorners(p);
    ok('tile: default-anchored tile is centred on its x,y', near(c[0].x, 1400) && near(c[0].y, 850));
  }

  // --- computeTilePlacement: art at a different resolution than the box -----
  {
    // The common real case: a 1024x1024 source dropped into a 200x200 tile.
    const p = computeTilePlacement({ width: 1024, height: 1024 }, { x: 0, y: 0, width: 200, height: 200 });
    ok('tile: high-res art is scaled down to the box', near(p.width, 200) && near(p.scaleX, 200 / 1024));
  }

  // --- computeTilePlacement: rotation + explicit anchor ---------------------
  {
    const p = computeTilePlacement(
      { width: 100, height: 100 },
      { x: 500, y: 500, width: 100, height: 100, rotation: 45, texture: { anchorX: 0, anchorY: 0, fit: 'fill' } }
    );
    ok('tile: rotation carries through', p.rotation === 45);
    ok('tile: explicit anchor carries through', p.anchorX === 0 && p.anchorY === 0);
    const c = computeQuadCorners(p);
    ok('tile: rotates around its own anchor', near(c[0].x, 500) && near(c[0].y, 500));
  }

  // --- computeTilePlacement: defaults / missing fields ----------------------
  {
    const p = computeTilePlacement({ width: 10, height: 10 }, { width: 10, height: 10 });
    ok('tile: missing x,y defaults to 0', p.x === 0 && p.y === 0);
    ok('tile: missing texture config defaults to fill/0.5/0.5', p.anchorX === 0.5 && near(p.scaleX, 1));
    ok('tile: missing rotation defaults to 0', p.rotation === 0);
  }
}
