/**
 * Node verification for three-allocator.js + its frame-graph integration, using a
 * minimal THREE mock. Run via ../run-tests.mjs.
 */
import { FrameGraph } from '../frame-graph.js';
import { ThreeAllocator } from '../three-allocator.js';

export function makeTHREE() {
  const T = {
    LinearFilter: 'LINEAR',
    NearestFilter: 'NEAREST',
    RGBAFormat: 'RGBA',
    UnsignedByteType: 'U8',
    HalfFloatType: 'F16',
    FloatType: 'F32',
    NoColorSpace: 'none',
    SRGBColorSpace: 'srgb',
    LinearSRGBColorSpace: 'linear-srgb',
  };
  T.Vector2 = class {
    constructor(x = 0, y = 0) {
      this.x = x;
      this.y = y;
    }
  };
  T.DepthTexture = class {
    constructor(w, h, type) {
      this.width = w;
      this.height = h;
      this.type = type;
      this.isDepthTexture = true;
    }
  };
  T.WebGLRenderTarget = class {
    constructor(w, h, opts = {}) {
      this.width = w;
      this.height = h;
      this.opts = opts;
      this.name = '';
      this.depthTexture = opts.depthTexture ?? null;
      const count = opts.count || 1;
      const mk = (i) => ({
        minFilter: opts.minFilter,
        magFilter: opts.magFilter,
        type: opts.type,
        format: opts.format,
        colorSpace: opts.colorSpace,
        name: '',
        _i: i,
      });
      if (count > 1) {
        this.textures = Array.from({ length: count }, (_, i) => mk(i));
        this.texture = this.textures[0];
      } else {
        this.texture = mk(0);
        this.textures = undefined;
      }
      this._disposed = false;
      this._resizes = [];
    }
    setSize(w, h) {
      this.width = w;
      this.height = h;
      this._resizes.push([w, h]);
    }
    dispose() {
      this._disposed = true;
    }
  };
  return T;
}

export function run(t) {
  const { ok } = t;

  // describe(): single attachment defaults.
  {
    const T = makeTHREE();
    const d = ThreeAllocator.describe(T, { resolvedW: 800, resolvedH: 600 });
    ok('single: size', d.width === 800 && d.height === 600);
    ok('single: default linear', d.options.minFilter === 'LINEAR');
    ok('single: default u8 rgba', d.options.type === 'U8' && d.options.format === 'RGBA');
    ok('single: no count key', d.options.count === undefined);
    ok('single: no depth', d.options.depthBuffer === false);
    ok('single: no depth texture wanted by default', d.wantsDepthTexture === false);
  }

  // describe(): `depthTexture` is a DIFFERENT field from `depth`, and
  // `depthTextureType` is a DIFFERENT field from the colour attachment's own
  // `type` — docs/planning/Depth-Buffer.md §11's named gap, closed here.
  {
    const T = makeTHREE();
    const d = ThreeAllocator.describe(T, {
      resolvedW: 512,
      resolvedH: 512,
      type: T.UnsignedByteType, // the COLOUR attachment's type
      depthTexture: true,
      depthTextureType: T.FloatType, // a DIFFERENT, independent type
    });
    ok('depthTexture: requested', d.wantsDepthTexture === true);
    ok('depthTexture: its own type field, not the colour attachment´s', d.depthTextureType === 'F32');
    ok('depthTexture: colour attachment´s own type is untouched', d.options.type === 'U8');
    // Omitted entirely -> false, never a truthy default that would silently
    // start allocating a depth texture for every existing screen target.
    const dOff = ThreeAllocator.describe(T, { resolvedW: 10, resolvedH: 10 });
    ok('depthTexture: opt-in only, never on by accident', dOff.wantsDepthTexture === false);
  }

  // describe(): the attribute-buffer MRT shape.
  {
    const T = makeTHREE();
    const d = ThreeAllocator.describe(T, {
      resolvedW: 1920,
      resolvedH: 1080,
      mrtCount: 2,
      depth: true,
      type: T.HalfFloatType,
      colorSpace: T.LinearSRGBColorSpace,
      attachments: [null, { filter: 'nearest', type: T.UnsignedByteType, colorSpace: T.NoColorSpace }],
    });
    ok('mrt: count 2', d.options.count === 2);
    ok('mrt: depth on', d.options.depthBuffer === true);
    ok('mrt: base half-float', d.options.type === 'F16');
    ok('mrt: attachment[1] nearest', d.attachments[1].minFilter === 'NEAREST');
    ok('mrt: attachment[1] u8', d.attachments[1].type === 'U8');
    ok('mrt: attachment[1] no-colorspace', d.attachments[1].colorSpace === 'none');
  }

  // create(): applies per-attachment plan.
  {
    const T = makeTHREE();
    const alloc = new ThreeAllocator({ THREE: T });
    const rt = alloc.create('attr', {
      resolvedW: 100,
      resolvedH: 100,
      mrtCount: 2,
      attachments: [null, { filter: 'nearest', colorSpace: T.NoColorSpace }],
    });
    ok('create: two textures', rt.textures.length === 2);
    ok('create: color stays linear', rt.textures[0].minFilter === 'LINEAR');
    ok('create: attr nearest', rt.textures[1].minFilter === 'NEAREST');
    ok('create: name tagged', rt.name === 'v3:attr' && rt.textures[1].name === 'v3:attr:1');
    ok('create: no depth texture unless requested', rt.depthTexture === null);
  }

  // create(): a REAL, samplable depth texture, wired into the render
  // target's own `depthTexture` slot — the mechanism `bench-scene-depth.js`
  // proved in the lab (scenario 5) before this landed. Built HERE, never at a
  // call site (`gpu/allocator-only`, tools/verify-structure.mjs).
  {
    const T = makeTHREE();
    const alloc = new ThreeAllocator({ THREE: T });
    const rt = alloc.create('scene.depth', {
      resolvedW: 256,
      resolvedH: 128,
      depthTexture: true,
      depthTextureType: T.FloatType,
    });
    ok('depthTexture: a real DepthTexture instance is attached', rt.depthTexture instanceof T.DepthTexture);
    ok(
      'depthTexture: sized to match the colour attachment',
      rt.depthTexture.width === 256 && rt.depthTexture.height === 128
    );
    ok('depthTexture: the requested type, not a hard-coded one', rt.depthTexture.type === 'F32');
    ok('depthTexture: depthBuffer is forced on alongside it', rt.opts.depthBuffer === true);

    // Omitted `depthTextureType` -> FloatType (depth32float), the format
    // the design doc's own §4 specifies, not an implicit narrower default.
    const rtDefaultType = alloc.create('scene.depth2', { resolvedW: 8, resolvedH: 8, depthTexture: true });
    ok('depthTexture: default type is FloatType when omitted', rtDefaultType.depthTexture.type === 'F32');

    // Not requested -> completely unaffected, same as every existing caller.
    const rtPlain = alloc.create('plain2', { resolvedW: 8, resolvedH: 8 });
    ok('depthTexture: not requested -> null, and depthBuffer left at its own default', rtPlain.depthTexture === null);
  }

  // create(): outputName wins outright — the exact string an `mrt({...})`
  // TSL call's keys must match, never the `v3:` debug tag (B0-1's
  // buf:scene.attr build; see three-allocator.js's own header).
  {
    const T = makeTHREE();
    const alloc = new ThreeAllocator({ THREE: T });
    const rt = alloc.create('scene.color', {
      resolvedW: 100,
      resolvedH: 100,
      mrtCount: 2,
      attachments: [{ outputName: 'output' }, { outputName: 'attr', filter: 'nearest', colorSpace: T.NoColorSpace }],
    });
    ok('outputName: attachment 0 named exactly "output"', rt.textures[0].name === 'output');
    ok('outputName: attachment 1 named exactly "attr"', rt.textures[1].name === 'attr');
    ok('outputName: other params still applied', rt.textures[1].minFilter === 'NEAREST');
    // No outputName given -> unchanged debug-tag behavior (back-compat).
    const rt2 = alloc.create('plain', {
      resolvedW: 10,
      resolvedH: 10,
      mrtCount: 2,
      attachments: [null, { filter: 'nearest' }],
    });
    ok('outputName: absent falls back to debug tag', rt2.textures[1].name === 'v3:plain:1');
  }

  // resize()/dispose().
  {
    const T = makeTHREE();
    const alloc = new ThreeAllocator({ THREE: T });
    const rt = alloc.create('x', { resolvedW: 10, resolvedH: 10 });
    alloc.resize(rt, 20, 30);
    ok('resize applied', rt.width === 20 && rt.height === 30);
    alloc.dispose(rt);
    ok('dispose applied', rt._disposed === true);
  }

  // Integration with FrameGraph.
  {
    const T = makeTHREE();
    const g = new FrameGraph({ allocator: new ThreeAllocator({ THREE: T }) });
    g.declareResource('albedo', {
      size: 'screen',
      mrtCount: 2,
      depth: true,
      type: T.HalfFloatType,
      attachments: [{ filter: 'linear' }, { filter: 'nearest', type: T.UnsignedByteType, colorSpace: T.NoColorSpace }],
    });
    g.declareResource('hdr', { size: 'screen', type: T.HalfFloatType });
    let albedo = null,
      hdr = null;
    g.addPass({
      name: 'geometry',
      writes: ['albedo'],
      execute: (c) => {
        albedo = c.target('albedo');
      },
    });
    g.addPass({
      name: 'lighting',
      reads: ['albedo'],
      writes: ['hdr'],
      execute: (c) => {
        c.get('albedo');
        hdr = c.target('hdr');
      },
    });
    g.execute({ width: 1600, height: 900 });
    ok('integ: albedo MRT', albedo?.textures?.length === 2);
    ok('integ: albedo screen-sized', albedo.width === 1600 && albedo.height === 900);
    ok('integ: albedo attr nearest', albedo.textures[1].minFilter === 'NEAREST');
    ok('integ: hdr single', hdr.textures === undefined && !!hdr.texture);
    g.execute({ width: 1280, height: 720 });
    ok('integ: albedo resized in place', albedo.width === 1280 && albedo._resizes.length === 1);
  }
}
