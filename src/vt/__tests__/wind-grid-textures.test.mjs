/**
 * wind-grid-textures.test.mjs — the filter each wind texture uses, pinned.
 *
 * The OPENNESS texture is sampled NEAREST and that is the second half of the
 * 2026-10-07 "indoors reacts to wind like outdoors" fix (`downsampleOpennessClasses`
 * is the first): even with a wall's own cell reading sealed, a bilinear fetch
 * within half a cell of an outside wall averaged the OUTSIDE neighbour's centre
 * texel into a sealed room — measured 0.46 openness at the wall face. These tests
 * exist so nobody "smooths it" back, with the reason in the failure message.
 */
import { createWindGridTextureFactory } from '../wind-grid-textures.js';

export function run(t) {
  class DataTexture {
    constructor(data, w, h, format, type) {
      Object.assign(this, { data, w, h, format, type });
      this.needsUpdate = false;
    }
  }
  const THREE = {
    DataTexture,
    RGBAFormat: 'rgba',
    HalfFloatType: 'half',
    UnsignedByteType: 'u8',
    NearestFilter: 'nearest',
    LinearFilter: 'linear',
    ClampToEdgeWrapping: 'clamp',
  };
  const f = createWindGridTextureFactory(THREE);
  const open = f.createOpennessTexture(new Uint16Array(16), 2, 2);
  const wa = f.createWallAvoidTexture(new Uint16Array(16), 2, 2);
  const sm = f.createSolidMaskTexture(new Uint8Array(16), 2, 2);

  t.ok(
    'the OPENNESS texture is sampled NEAREST: bilinear averaged the outside neighbour into a sealed room',
    open.minFilter === 'nearest' && open.magFilter === 'nearest' && open.type === 'half'
  );
  t.ok(
    'the wall-avoidance texture stays LINEAR (a smooth direction field)',
    wa.minFilter === 'linear' && wa.magFilter === 'linear' && wa.type === 'half'
  );
  t.ok('the solid mask is NEAREST RGBA8', sm.minFilter === 'nearest' && sm.magFilter === 'nearest' && sm.type === 'u8');
  t.ok(
    'all three clamp to the edge and are uploaded on creation',
    [open, wa, sm].every((x) => x.wrapS === 'clamp' && x.wrapT === 'clamp' && x.needsUpdate === true)
  );
  t.ok(
    'each texture wraps the array it was given (rewritten in place later, never copied)',
    open.data.length === 16 && open.w === 2 && open.h === 2 && sm.data instanceof Uint8Array
  );
}
