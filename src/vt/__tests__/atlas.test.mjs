/**
 * Node verification for vt/atlas.js. computeAtlasLayout/slotToAtlasPosition are
 * pure arithmetic; PageAtlas is verified against a minimal THREE + renderer
 * mock (real WebGL upload behavior was checked by hand against the vendored
 * r170 source — see atlas.js's header comment — this proves PageAtlas calls
 * that API with the right arguments, not that WebGL itself works).
 */
import { computeAtlasLayout, slotToAtlasPosition, PageAtlas, BYTES_PER_TEXEL_RGBA8 } from '../atlas.js';

function makeAtlasTHREE() {
  const calls = { copyTextureToTexture: [] };
  const T = {};
  T.LinearFilter = 'LinearFilter'; // sentinel value — real THREE's is a numeric constant, identity is all that matters here
  T.Vector3 = class {
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }
  };
  T.DataArrayTexture = class {
    constructor(data, width, height, depth) {
      this.isDataArrayTexture = true;
      this.image = { data, width, height, depth };
      this.name = '';
      this.needsUpdate = false;
      this._disposed = false;
    }
    dispose() {
      this._disposed = true;
    }
  };
  calls.resetState = 0;
  const renderer = {
    copyTextureToTexture(src, dst, srcRegion, dstPosition, level) {
      calls.copyTextureToTexture.push({ src, dst, srcRegion, dstPosition, level });
    },
    resetState() {
      calls.resetState++;
    },
  };
  return { T, renderer, calls };
}

export function run(t) {
  const { ok, throws } = t;

  // --- computeAtlasLayout: anchor against Keyhole.md §4.1's worked example --
  {
    const layout = computeAtlasLayout({ budgetBytes: 512 * 1024 * 1024 }); // Keyhole Q2 default
    ok('layout: 4096px atlas (default)', layout.atlasSizePx === 4096);
    ok('layout: 256px pages (default)', layout.pageSizePx === 256);
    ok(
      'layout: 16x16=256 pages/layer, matching Keyhole.md §4.1 exactly',
      layout.pagesPerAxis === 16 && layout.pagesPerLayer === 256
    );
    ok('layout: 64 MB/layer, matching Keyhole.md §4.1 exactly', layout.layerBytes === 64 * 1024 * 1024);
    ok('layout: 8 layers at the 512 MB / 8 GB-tier default, matching Keyhole.md §4.1 exactly', layout.layers === 8);
    ok('layout: 2048 total pages, matching Keyhole.md §4.1 exactly', layout.capacityPages === 2048);
    ok('layout: totalBytes never exceeds the budget (floor, never rounds up)', layout.totalBytes <= 512 * 1024 * 1024);
  }

  // --- computeAtlasLayout: other GPU tiers scale sanely --------------------
  {
    const tier4gb = computeAtlasLayout({ budgetBytes: 256 * 1024 * 1024 });
    ok('layout: 4 GB tier (256 MB) -> 4 layers, 1024 pages', tier4gb.layers === 4 && tier4gb.capacityPages === 1024);
    const tier16gb = computeAtlasLayout({ budgetBytes: 1024 * 1024 * 1024 });
    ok('layout: 16 GB tier (1 GB) -> 16 layers, 4096 pages', tier16gb.layers === 16 && tier16gb.capacityPages === 4096);
  }

  // --- computeAtlasLayout: guards -------------------------------------------
  {
    throws('layout: rejects non-positive budget', () => computeAtlasLayout({ budgetBytes: 0 }));
    throws('layout: rejects atlasSizePx not a multiple of pageSizePx', () =>
      computeAtlasLayout({ budgetBytes: 512 * 1024 * 1024, pageSizePx: 256, atlasSizePx: 4000 })
    );
  }

  // --- slotToAtlasPosition: fills layer 0 row-major before layer 1 --------
  {
    const layout = computeAtlasLayout({ budgetBytes: 512 * 1024 * 1024 });
    ok(
      'slot 0 -> (0,0) layer 0',
      JSON.stringify(slotToAtlasPosition(0, layout)) === JSON.stringify({ x: 0, y: 0, layer: 0 })
    );
    ok(
      'slot 1 -> (256,0) layer 0 (next tile in the row)',
      JSON.stringify(slotToAtlasPosition(1, layout)) === JSON.stringify({ x: 256, y: 0, layer: 0 })
    );
    ok(
      'slot 16 -> (0,256) layer 0 (wraps to next row, 16 tiles/row)',
      JSON.stringify(slotToAtlasPosition(16, layout)) === JSON.stringify({ x: 0, y: 256, layer: 0 })
    );
    ok(
      'slot 256 -> (0,0) layer 1 (first slot of the next layer)',
      JSON.stringify(slotToAtlasPosition(256, layout)) === JSON.stringify({ x: 0, y: 0, layer: 1 })
    );
    ok(
      'slot 2047 (last of 2048) -> last tile of layer 7',
      JSON.stringify(slotToAtlasPosition(2047, layout)) === JSON.stringify({ x: 15 * 256, y: 15 * 256, layer: 7 })
    );
    throws('slotToAtlasPosition rejects negative slots', () => slotToAtlasPosition(-1, layout));
  }

  // --- PageAtlas: allocates once, at the exact layout dims -----------------
  {
    const { T } = makeAtlasTHREE();
    const layout = computeAtlasLayout({ budgetBytes: 512 * 1024 * 1024 });
    const atlas = new PageAtlas({ THREE: T, layout });
    ok(
      'PageAtlas: texture matches layout dims',
      atlas.texture.image.width === 4096 && atlas.texture.image.height === 4096 && atlas.texture.image.depth === 8
    );
    // MUST be real (non-null) data -- confirmed live 2026-07-15: THREE's
    // uploadTexture() unconditionally calls texSubImage3D(..., image.data) on
    // first use, and `null` there produced real GL errors ("no bound
    // PIXEL_UNPACK_BUFFER"), leaving the atlas never properly established.
    const data = atlas.texture.image.data;
    ok('PageAtlas: allocated with a REAL zeroed buffer, not null', data instanceof Uint8Array && data.length > 0);
    ok(
      "PageAtlas: initial buffer is exactly the atlas's own fixed size (never world-scaling)",
      data.length === 4096 * 4096 * 8 * 4
    );
    ok(
      'PageAtlas: initial buffer is zeroed (a clean initial-clear state)',
      data.every((b) => b === 0)
    );
  }

  // --- PageAtlas: NO GPU mipmapping on the atlas (real live bug, 2026-07-16:
  // "zooming out looks pixelated/ugly" — first suspected as missing
  // anisotropic filtering, WRONG diagnosis for a top-down orthographic camera;
  // the real cause was THREE's default minFilter/generateMipmaps letting the
  // GPU pick its OWN mip level of the atlas from meaningless per-page-
  // discontinuous UV derivatives). This is invisible to normal code review
  // (the shader/atlas code LOOKS correct — it's the UNSET properties, silently
  // defaulting to the wrong thing, that were the bug) and invisible to GPU-
  // level rendering tests (Node can't render), so this is the one guardrail
  // that CAN catch a regression here: assert the texture object's own
  // properties directly. ---------------------------------------------------
  {
    const { T } = makeAtlasTHREE();
    const layout = computeAtlasLayout({ budgetBytes: 512 * 1024 * 1024 });
    const atlas = new PageAtlas({ THREE: T, layout });
    ok('PageAtlas: generateMipmaps explicitly disabled on the atlas texture', atlas.texture.generateMipmaps === false);
    ok(
      "PageAtlas: minFilter explicitly set to LinearFilter (never LinearMipmapLinearFilter, THREE's default)",
      atlas.texture.minFilter === T.LinearFilter
    );
    ok('PageAtlas: magFilter explicitly set to LinearFilter', atlas.texture.magFilter === T.LinearFilter);
  }

  // --- PageAtlas: uploadPage computes the right dstPosition + calls the ----
  // --- real (non-deprecated) r170 API with the right shape -----------------
  {
    const { T, renderer, calls } = makeAtlasTHREE();
    const layout = computeAtlasLayout({ budgetBytes: 512 * 1024 * 1024 });
    const atlas = new PageAtlas({ THREE: T, layout, renderer });
    const fakeSrc = { isTexture: true, image: { width: 256, height: 256 } };
    atlas.uploadPage(17, fakeSrc); // slot 17 -> tile (1,1) in layer 0
    ok('uploadPage: called copyTextureToTexture exactly once', calls.copyTextureToTexture.length === 1);
    const call = calls.copyTextureToTexture[0];
    ok('uploadPage: srcRegion is null (whole page)', call.srcRegion === null);
    ok(
      'uploadPage: dstPosition is the correct slot pixel offset',
      call.dstPosition.x === 256 && call.dstPosition.y === 256 && call.dstPosition.z === 0
    );
    ok('uploadPage: dst is the atlas texture itself', call.dst === atlas.texture);
    ok('uploadPage: src is the passed-in decoded page texture', call.src === fakeSrc);

    throws('uploadPage: throws (not silently no-ops) if no renderer was ever set', () => {
      const atlas2 = new PageAtlas({ THREE: T, layout });
      atlas2.uploadPage(0, fakeSrc);
    });
  }

  // --- PageAtlas: prepareForUploadBatch calls renderer.resetState() --------
  // (fixes "texSubImage3D: no texture bound to target" after a render() call
  // touches THREE's texture-unit cache -- confirmed live 2026-07-15)
  {
    const { T, renderer, calls } = makeAtlasTHREE();
    const layout = computeAtlasLayout({ budgetBytes: 512 * 1024 * 1024 });
    const atlas = new PageAtlas({ THREE: T, layout, renderer });
    atlas.prepareForUploadBatch();
    ok('prepareForUploadBatch: calls renderer.resetState() exactly once', calls.resetState === 1);

    const atlasNoRenderer = new PageAtlas({ THREE: T, layout }); // never had setRenderer() called
    atlasNoRenderer.prepareForUploadBatch(); // must not throw even with no renderer set
    ok('prepareForUploadBatch: safe no-op when no renderer is set (optional chaining, not required)', true);
  }

  // --- consistency: PageAtlas layout capacity math matches BYTES_PER_TEXEL --
  {
    const layout = computeAtlasLayout({ budgetBytes: 512 * 1024 * 1024 });
    const expectedPageBytes = layout.pageSizePx * layout.pageSizePx * BYTES_PER_TEXEL_RGBA8;
    ok(
      'layout math is internally consistent with BYTES_PER_TEXEL_RGBA8',
      layout.layerBytes === layout.pagesPerLayer * expectedPageBytes
    );
  }
}
