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
  T.WebGLRenderTarget = class {
    constructor(w, h, opts = {}) {
      this.width = w;
      this.height = h;
      this.opts = opts;
      this.name = '';
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
