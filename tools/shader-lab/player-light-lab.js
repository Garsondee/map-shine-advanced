/**
 * Shader Lab driver: PLAYER LIGHTS (vision grades, torch fire, flashlight cookie).
 *
 * Imports the REAL production builders from `src/` and renders them on a real
 * WebGPU device against a synthetic scene, saving PNGs under
 * `tools/shader-lab/runs/<run>/` to be looked at. Same doctrine as `candle-lab.js`.
 *
 * ⚠️ WHAT THIS DOES NOT PROVE. The scene is a synthetic painted canvas, not
 * `scene.lit` from a real Foundry frame, and there is no fog-of-war, wall data or
 * light pool behind it. It answers "what does the shader do to a plausible dark
 * scene" and, for the V2 comparison, "how does V2's own GLSL look on the same
 * pixels". Lab-green is BUILT (unverified); only the author on a real scene says LIVE.
 *
 * @module tools/shader-lab/player-light-lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { buildPlayerVisionGradeNode } from '../../src/effects/vision/player-vision-grade-render.js';
import { V2_NIGHT_VISION_FRAGMENT } from './v2-night-vision-reference.js';

/** V2's shipped Night Vision parameters (`PlayerLightEffectV2` `params`), as the author tuned them. */
const V2_NV_DEFAULTS = {
  nightVisionTint: { r: 0, g: 0.5501958510499996, b: 0.17193620345312488 },
  nightVisionTintStrength: 1,
  nightVisionSaturation: 0,
  nightVisionBrightness: 2,
  nightVisionPurkinjeStrength: 0,
  nightVisionPurkinjeDarkStart: 0.021,
  nightVisionPurkinjeBrightEnd: 0.23,
  nightVisionPurkinjeCurve: 1.4,
  nightVisionGain: 10,
  nightVisionGamma: 0.86,
  nightVisionMaxLuma: 4,
  nightVisionDarkLift: 0.016,
  nightVisionEyepieceStyle: 'single',
  nightVisionEyepieceRadius: 0.68,
  nightVisionEyepieceSoftness: 0.22,
  nightVisionEyepieceIntensity: 1.0,
  nightVisionEyepieceColor: { r: 0, g: 0, b: 0 },
  nightVisionEyepieceSeparation: 0.26,
  nightVisionScanlinesEnabled: true,
  nightVisionScanlinesIntensity: 0.3,
  nightVisionScanlinesDensity: 300,
  nightVisionScanlinesSpeed: 1.4,
  nightVisionScanlinesThickness: 0.4,
  nightVisionNoiseAmount: 0.11,
  nightVisionNoiseLowLightBoost: 0.55,
  nightVisionNoiseSpeed: 0.1,
  nightVisionNoiseScale: 6,
  nightVisionPhosphorFlickerAmount: 0.09,
  nightVisionPhosphorFlickerSpeed: 4.1,
  nightVisionPhosphorSize: 1.39,
  nightVisionPhosphorDensity: 0.51,
  nightVisionPhosphorIntensity: 1.05,
  nightVisionDistortionAmount: -0.18,
  nightVisionCAAmount: 6,
  nightVisionCAEdgePower: 4,
};

/** V2's `VISION_PROFILES.lowLightVision`, laid over the defaults above (its later duplicate keys win, as in V2). */
const V2_LOWLIGHT_PROFILE = {
  nightVisionTint: { r: 1, g: 1, b: 1 },
  nightVisionTintStrength: 0.3,
  nightVisionSaturation: 0.4,
  nightVisionGain: 2.5,
  nightVisionGamma: 0.45,
  nightVisionPurkinjeStrength: 0,
  nightVisionScanlinesEnabled: false,
  nightVisionScanlinesIntensity: 0,
  nightVisionPhosphorFlickerAmount: 0,
  nightVisionNoiseAmount: 0,
  nightVisionEyepieceStyle: 'single',
  nightVisionEyepieceRadius: 1.0,
  nightVisionEyepieceIntensity: 0,
  nightVisionCAAmount: 0.8,
  nightVisionDistortionAmount: 0,
};

const W = 1280;
const H = 720;
const statusEl = document.getElementById('status');
const log = (msg) => {
  console.log('[player-light-lab]', msg);
  if (statusEl) {
    statusEl.textContent += `\n${msg}`;
    statusEl.scrollTop = statusEl.scrollHeight;
  }
};

/** Deterministic PRNG so every capture of a scene is pixel-identical. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A plausible 1280x720 night map, painted in sRGB the way an author's art would be, then
 * lit: cobbles, grass, a stone hall with warm windows, a torch pool, a cold moon patch,
 * a token, and a true-black strip (unexplored: must stay black under any amplifier).
 * `level` scales the whole scene (1 = night as lit by the module; ~3.5 = a bright day).
 */
function paintScene(level = 1) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const r = rng(7);
  const k = (v) => Math.max(0, Math.min(255, Math.round(v * level)));
  const rgb = (R, G, B, a = 1) => `rgba(${k(R)},${k(G)},${k(B)},${a})`;

  g.fillStyle = rgb(11, 13, 20);
  g.fillRect(0, 0, W, H);
  // Cobbles.
  for (let y = 0; y < H; y += 26) {
    for (let x = 0; x < W; x += 34) {
      const o = (Math.floor(y / 26) % 2) * 17;
      const v = 9 + r() * 12;
      g.fillStyle = rgb(v, v + 1, v + 6);
      g.fillRect(x + o + 1, y + 1, 31, 23);
    }
  }
  // Grass.
  for (let i = 0; i < 2600; i++) {
    const x = 140 + r() * 520;
    const y = 470 + r() * 240;
    g.fillStyle = rgb(8 + r() * 6, 18 + r() * 16, 9 + r() * 5);
    g.fillRect(x, y, 3, 5);
  }
  // Stone hall + roof shadow.
  g.fillStyle = rgb(26, 23, 30);
  g.fillRect(790, 90, 400, 300);
  g.fillStyle = rgb(15, 14, 20);
  g.fillRect(790, 90, 400, 46);
  // Windows (warm light spilling out).
  for (const wx of [840, 960, 1080]) {
    const gr = g.createRadialGradient(wx + 25, 250, 4, wx + 25, 250, 90);
    gr.addColorStop(0, rgb(250, 180, 100, 0.85));
    gr.addColorStop(1, rgb(250, 180, 100, 0));
    g.fillStyle = gr;
    g.fillRect(wx - 70, 160, 190, 200);
    g.fillStyle = rgb(255, 205, 130);
    g.fillRect(wx, 220, 50, 60);
  }
  // Torch pool.
  const tp = g.createRadialGradient(380, 440, 6, 380, 440, 260);
  tp.addColorStop(0, rgb(255, 190, 100, 0.95));
  tp.addColorStop(0.35, rgb(240, 120, 40, 0.5));
  tp.addColorStop(1, rgb(200, 80, 20, 0));
  g.fillStyle = tp;
  g.fillRect(100, 180, 560, 520);
  // Cold moon patch.
  const mp = g.createRadialGradient(930, 560, 10, 930, 560, 200);
  mp.addColorStop(0, rgb(90, 120, 190, 0.55));
  mp.addColorStop(1, rgb(90, 120, 190, 0));
  g.fillStyle = mp;
  g.fillRect(700, 380, 460, 340);
  // Trees (near-black blobs).
  for (const [tx, ty, tr] of [
    [700, 560, 60],
    [220, 150, 70],
    [1180, 540, 55],
  ]) {
    g.fillStyle = rgb(6, 9, 8);
    g.beginPath();
    g.arc(tx, ty, tr, 0, Math.PI * 2);
    g.fill();
  }
  // A token — an 80x80 Foundry-style box (the shape `pushPlayerVisionTokens`
  // actually hands the recolour over as): a border ring, a mid-tone body and
  // both DARK and BRIGHT interior detail, so an infravision shot can be judged
  // on whether the recolour follows the box AND whether it keeps the art's own
  // detail instead of washing it into a blob.
  g.fillStyle = rgb(40, 46, 78);
  g.fillRect(520, 360, 80, 80);
  g.fillStyle = rgb(96, 112, 176);
  g.beginPath();
  g.arc(560, 400, 30, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = rgb(18, 20, 30);
  g.fillRect(548, 388, 10, 24);
  g.fillStyle = rgb(230, 236, 250);
  g.fillRect(562, 384, 8, 8);
  g.strokeStyle = rgb(200, 200, 220);
  g.lineWidth = 3;
  g.strokeRect(521.5, 361.5, 77, 77);
  // Unexplored: true black strip on the left, plus a hole.
  g.fillStyle = '#000';
  g.fillRect(0, 0, 90, H);
  g.fillRect(560, 40, 140, 70);
  return c;
}

class PlayerLightLab {
  constructor() {
    this.renderer = null;
    this.camera = null;
    this.timeMs = THREE.TSL.uniform(THREE.TSL.float(0));
    this.darkness = THREE.TSL.uniform(THREE.TSL.float(1));
    this.sceneTex = null;
    this.sceneKey = null;
  }

  async init(canvas) {
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: false, alpha: false });
    await this.renderer.init();
    log(`renderer backend: ${this.renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL'}`);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  /** A canvas painted by `paintScene`, as a sampled SRGB texture (so the shader sees LINEAR, like `scene.lit`). */
  _sceneTexture(level) {
    const key = `night:${level}`;
    if (this.sceneKey === key && this.sceneTex) return this.sceneTex;
    this.sceneTex?.dispose();
    const tex = new THREE.CanvasTexture(paintScene(level));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = true;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.sceneTex = tex;
    this.sceneKey = key;
    return tex;
  }

  /**
   * Render the REAL production vision grade for `mode` over the painted scene and POST a PNG.
   * `mode: 'none'` is the ungraded scene.
   *
   * `tokens` are `{x, y, radiusX, radiusY}`, or `{x, y, radiusPx}` for a square body, in the SAME world
   * pixels the production producer (`vt-pan-viewer.js#pushPlayerVisionTokens`) hands over — the painted
   * scene's own token sits at (560, 400) r40, so passing exactly that is what proves the infravision
   * hot-body mask lines up with the art it is supposed to repaint. `viewRect`/`anchorWorld` default to
   * "the whole painted canvas, anchored at its centre", which is the lab's stand-in for a camera rect.
   */
  async visionShot({
    mode = 'nightVision',
    darkness = 1,
    level = 1,
    timeMs = 4000,
    tokens = null,
    viewRect = null,
    anchorWorld = null,
    file,
    run = 'player-light',
  } = {}) {
    const TSL = THREE.TSL;
    const tex = this._sceneTexture(level);
    this.timeMs.value = timeMs;
    this.darkness.value = darkness;
    const lit = TSL.texture(tex).rgb;
    const rect = viewRect ?? [0, 0, W, H];
    const rectNode = TSL.vec4(rect[0], rect[1], rect[2], rect[3]);
    const slotNodes = (tokens ?? []).map((t) =>
      TSL.uniform(TSL.vec4(t.x, t.y, t.radiusX ?? t.radiusPx ?? 40, t.radiusY ?? t.radiusPx ?? t.radiusX ?? 40))
    );
    // ⚠️ THE UV ORIENTATION ADAPTER — do not "simplify" this back to a bare `uv()`.
    // The grade reads world-Y as `mix(uViewRect.y, uViewRect.w, uv.y)`
    // (`environmental-light.js`'s own cloud-shadow / outdoors-gate mapping, and
    // `grade-present.js`'s vision anchor), so in PRODUCTION `uv.y = 0` is the camera's world
    // minY — the TOP of the frame. This lab draws a plain fullscreen quad, whose uv.y = 0 sits at
    // the BOTTOM, and the flipped CanvasTexture makes the art display upright — so a bare `uv()`
    // here runs world-Y UP the screen and every world-anchored feature lands mirrored
    // (caught by `runs/player-light/chk3-flip-test.png`: a token at world y=400 glowed at y≈320).
    // `oneMinus()` restores production's "y = 0 at the top" reading without flipping the art.
    const uvNode = TSL.vec2(TSL.uv().x, TSL.uv().y.oneMinus());
    // Same world→UV mapping grade-present.js does, so the lab's falloff is the production one.
    const spanX = TSL.max(rectNode.z.sub(rectNode.x), TSL.float(1e-5));
    const spanY = TSL.max(rectNode.w.sub(rectNode.y), TSL.float(1e-5));
    const anchor = anchorWorld ?? { x: (rect[0] + rect[2]) / 2, y: (rect[1] + rect[3]) / 2, tokenSizePx: 80 };
    const visionCenter = TSL.vec2(
      TSL.float(anchor.x).sub(rectNode.x).div(spanX),
      TSL.float(anchor.y).sub(rectNode.y).div(spanY)
    );
    const graded = buildPlayerVisionGradeNode({
      THREE,
      rgb: lit,
      uv: uvNode,
      mode,
      timeMs: this.timeMs,
      darkness01: this.darkness,
      viewRect: rectNode,
      tokenSlots: slotNodes,
      visionCenter,
      visionWorldSize: TSL.vec2(spanX, spanY),
      visionTokenSize: TSL.float(anchor.tokenSizePx ?? 80),
    });
    const material = new THREE.NodeMaterial();
    material.depthTest = false;
    material.fragmentNode = TSL.vec4(graded ?? lit, 1);
    return this._shoot(material, file ?? `vision-${mode}-d${darkness}-l${level}.png`, run);
  }

  /**
   * V2's OWN night-vision GLSL (verbatim, `v2-night-vision-reference.js`) run with raw WebGL over the SAME
   * painted pixels, with V2's shipped parameters for `mode` ('nightVision' | 'lowLight'). The ground truth the
   * V3 port is judged against. The scene bytes ARE display values here, exactly what V2's `tDiffuse` held.
   */
  async v2Shot({ mode = 'nightVision', level = 1, timeMs = 4000, power = 1, file, run = 'player-light' } = {}) {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const gl = c.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error('no webgl2');
    const vs = `attribute vec2 position; attribute vec2 uv; varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, V2_NIGHT_VISION_FRAGMENT));
    gl.bindAttribLocation(prog, 0, 'position');
    gl.bindAttribLocation(prog, 1, 'uv');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // position.xy, uv.xy
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1]),
      gl.STATIC_DRAW
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);

    const tex = (src, unit) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    };
    tex(paintScene(level), 0);
    const black = document.createElement('canvas');
    black.width = black.height = 2;
    black.getContext('2d').fillRect(0, 0, 2, 2);
    tex(black, 1);

    // V2's shipped defaults (PlayerLightEffectV2 `params`), with the profile for the mode laid over them.
    const P = { ...V2_NV_DEFAULTS, ...(mode === 'lowLight' ? V2_LOWLIGHT_PROFILE : {}) };
    const u = (name) => gl.getUniformLocation(prog, name);
    const f = (n, v) => gl.uniform1f(u(n), v);
    const v3 = (n, c) => gl.uniform3f(u(n), c.r, c.g, c.b);
    gl.uniform1i(u('tDiffuse'), 0);
    gl.uniform1i(u('tBloomBurnMap'), 1);
    gl.uniform2f(u('uResolution'), W, H);
    f('uTime', timeMs / 1000);
    v3('uTint', P.nightVisionTint);
    f('uTintStrength', P.nightVisionTintStrength);
    f('uSaturation', P.nightVisionSaturation);
    f('uBrightness', P.nightVisionBrightness);
    f('uPurkinjeStrength', P.nightVisionPurkinjeStrength);
    f('uPurkinjeDarkStart', P.nightVisionPurkinjeDarkStart);
    f('uPurkinjeBrightEnd', P.nightVisionPurkinjeBrightEnd);
    f('uPurkinjeCurve', P.nightVisionPurkinjeCurve);
    f('uGain', P.nightVisionGain);
    f('uGamma', P.nightVisionGamma);
    f('uMaxLuma', P.nightVisionMaxLuma);
    f('uDarkLift', P.nightVisionDarkLift);
    f('uDistortionAmount', P.nightVisionDistortionAmount);
    gl.uniform2f(u('uDistortionCenter'), 0.5, 0.5);
    f('uCAAmountPx', P.nightVisionCAAmount);
    f('uCAEdgePower', P.nightVisionCAEdgePower);
    f('uScanlinesEnabled', P.nightVisionScanlinesEnabled ? 1 : 0);
    f('uScanIntensity', P.nightVisionScanlinesIntensity);
    f('uScanDensity', P.nightVisionScanlinesDensity);
    f('uScanSpeed', P.nightVisionScanlinesSpeed);
    f('uScanThickness', P.nightVisionScanlinesThickness);
    f('uNoiseAmount', P.nightVisionNoiseAmount);
    f('uNoiseLowLightBoost', P.nightVisionNoiseLowLightBoost);
    f('uNoiseSpeed', P.nightVisionNoiseSpeed);
    f('uNoiseScale', P.nightVisionNoiseScale);
    f('uPhosphorFlickerAmount', P.nightVisionPhosphorFlickerAmount);
    f('uPhosphorFlickerSpeed', P.nightVisionPhosphorFlickerSpeed);
    f('uPhosphorSize', P.nightVisionPhosphorSize);
    f('uPhosphorDensity', P.nightVisionPhosphorDensity);
    f('uPhosphorIntensity', P.nightVisionPhosphorIntensity);
    f('uBloomEnabled', 0);
    f('uBloomIntensity', 0);
    f('uBloomBlurPx', 0);
    f('uEyepieceStyle', P.nightVisionEyepieceStyle === 'single' ? 0 : 1);
    f('uEyepieceRadius', P.nightVisionEyepieceRadius);
    f('uEyepieceSoftness', P.nightVisionEyepieceSoftness);
    f('uEyepieceIntensity', P.nightVisionEyepieceIntensity);
    v3('uEyepieceColor', P.nightVisionEyepieceColor);
    f('uEyepieceSeparation', P.nightVisionEyepieceSeparation);
    f('uPower', power);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const out = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      out.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    }
    const c2 = document.createElement('canvas');
    c2.width = W;
    c2.height = H;
    c2.getContext('2d').putImageData(new ImageData(out, W, H), 0, 0);
    const blob = await new Promise((r) => c2.toBlob(r, 'image/png'));
    const name = file ?? `v2-${mode}-l${level}.png`;
    const res = await fetch(`/__lab/artifact?run=${run}&file=${name}`, { method: 'POST', body: blob });
    return { ...(await res.json()), mean: meanLuma(out) };
  }

  /**
   * The REAL torch fire (`player-torch-fire-*`) over the painted backdrop. The fire is drawn additively into a
   * linear HDR target like `scene.lit`, then a Reinhard pass stands in for the grade's tone map, then sRGB.
   * `burns` places one torch per entry (1 = full burn, lower = guttering).
   */
  async fireShot({
    burns = [1, 0.6, 0.3],
    timeMs = 3000,
    level = 1,
    file = 'fire.png',
    run = 'player-light',
    zoom = 1,
    tonemap = true,
    flameGain = null,
    sparkGain = null,
    archetype = null,
  } = {}) {
    const TSL = THREE.TSL;
    const { buildTorchFireFlameMaterial, buildTorchFireSparkMaterial, buildTorchFireBatchGeometry } = await import(
      '../../src/effects/player-torch-fire-render.js?v=' + Date.now()
    );
    const { createTorchFireSimulation, computeTorchParticleArrays } = await import(
      '../../src/effects/player-torch-fire-geometry.js?v=' + Date.now()
    );
    const uTime = TSL.uniform(TSL.float(timeMs));
    const anchors = burns.map((b, i) => ({
      x: 640 + ((i - (burns.length - 1) / 2) * 380) / zoom,
      y: 380,
      id: `lab${i}`,
      burn01: b,
    }));
    // The real world-space particle simulation, stepped at a steady frame dt like the game
    // clock, so the plume has genuinely detached particles alive (not a static mock).
    const simulation = createTorchFireSimulation();
    let simMs = 0;
    for (let step = 0; step < 20; step++) {
      simMs += 1000 / 60;
      simulation.update(anchors, simMs);
    }
    const live = simulation.update(anchors, simMs + 1000 / 60);
    const arrays = computeTorchParticleArrays(live.flames, live.sparks);

    // World scene: ortho camera framed like production (top < bottom, y down), zoomed about the centre.
    const hw = W / 2 / zoom;
    const hh = H / 2 / zoom;
    const cam = new THREE.OrthographicCamera(640 - hw, 640 + hw, 360 - hh, 360 + hh, 0.1, 1000);
    cam.position.set(0, 0, 100);
    cam.updateProjectionMatrix();
    const world = new THREE.Scene();
    const tex = this._sceneTexture(level);
    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(W, H),
      (() => {
        const m = new THREE.NodeMaterial();
        m.depthTest = false;
        m.side = THREE.DoubleSide;
        m.fragmentNode = TSL.vec4(TSL.texture(tex).rgb, 1);
        return m;
      })()
    );
    bg.position.set(640, 360, 0);
    bg.scale.y = -1; // production's y-down world
    bg.frustumCulled = false;
    bg.renderOrder = -10;
    world.add(bg);
    const spark = buildTorchFireSparkMaterial({ THREE, uGlobalTimeMs: uTime });
    if (sparkGain !== null) spark.uIntensity.value = sparkGain;
    const flameMeshes = arrays.flames.map(({ variant, batch }, i) => {
      const m = buildTorchFireFlameMaterial({
        THREE,
        uGlobalTimeMs: uTime,
        archetype: archetype ?? variant.archetype,
        sizeScale: variant.sizeScale,
        gain: variant.gain * (flameGain ?? 1),
      });
      const mesh = new THREE.Mesh(buildTorchFireBatchGeometry(THREE, batch), m.material);
      mesh.renderOrder = 1 + i * 0.1;
      return mesh;
    });
    const sparkMesh = new THREE.Mesh(buildTorchFireBatchGeometry(THREE, arrays.spark), spark.material);
    for (const m of [...flameMeshes, sparkMesh]) {
      m.frustumCulled = false;
      world.add(m);
    }
    sparkMesh.renderOrder = 2;

    // Pass 1: linear HDR.
    const hdr = new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType, format: THREE.RGBAFormat });
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(hdr);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.render(world, cam);
    this.renderer.setRenderTarget(prev);

    // Pass 2: tone map + present.
    const post = new THREE.NodeMaterial();
    post.depthTest = false;
    const hdrRgb = TSL.texture(hdr.texture).rgb;
    post.fragmentNode = TSL.vec4(tonemap ? hdrRgb.div(hdrRgb.add(TSL.vec3(1, 1, 1))).mul(1.8) : hdrRgb, 1);
    const out = await this._shoot(post, file, run);
    hdr.dispose();
    return out;
  }

  /** Tile previously saved PNGs (same run) into one labelled sheet, so variants compare in one look. */
  async montage({ files, cols = 2, cell = [640, 360], file = 'montage.png', run = 'player-light', crop = null }) {
    const rows = Math.ceil(files.length / cols);
    const c = document.createElement('canvas');
    c.width = cols * cell[0];
    c.height = rows * cell[1];
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < files.length; i++) {
      // createImageBitmap, not Image.decode(): decode() never settles while the Browser pane is hidden.
      const img = await createImageBitmap(
        await (await fetch(`/tools/shader-lab/runs/${run}/${files[i]}?t=${Date.now()}`)).blob()
      );
      const x = (i % cols) * cell[0];
      const y = Math.floor(i / cols) * cell[1];
      if (crop) g.drawImage(img, crop[0], crop[1], crop[2], crop[3], x, y, cell[0], cell[1]);
      else g.drawImage(img, 0, 0, img.width, img.height, x, y, cell[0], cell[1]);
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(x, y, 14 + files[i].length * 7, 20);
      g.fillStyle = '#fff';
      g.font = '12px monospace';
      g.fillText(files[i], x + 6, y + 14);
    }
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const res = await fetch(`/__lab/artifact?run=${run}&file=${file}`, { method: 'POST', body: blob });
    return res.json();
  }

  async _shoot(material, file, run) {
    const scene = new THREE.Scene();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    scene.add(quad);
    const out = await this.capture(scene, file, run);
    quad.geometry.dispose();
    material.dispose();
    return out;
  }

  /** Render `scene` offscreen as sRGB and POST it to the artifact endpoint as a PNG. */
  async capture(scene, file, run = 'player-light', camera = this.camera) {
    const rt = new THREE.RenderTarget(W, H, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat });
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(rt);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(prev);
    const raw = await this.renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H);
    const src = ArrayBuffer.isView(raw) ? raw : new Uint8Array(raw);
    const px = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const si = (y * W + x) * 4; // WebGPU read-back is already top-down (a flip here shipped an upside-down lab)
        const di = (y * W + x) * 4;
        px[di] = src[si];
        px[di + 1] = src[si + 1];
        px[di + 2] = src[si + 2];
        px[di + 3] = 255;
      }
    }
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    c.getContext('2d').putImageData(new ImageData(px, W, H), 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    rt.dispose();
    const res = await fetch(`/__lab/artifact?run=${run}&file=${file}`, { method: 'POST', body: blob });
    return { ...(await res.json()), mean: meanLuma(px) };
  }
}

function meanLuma(px) {
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  return +(sum / (px.length / 4) / 255).toFixed(4);
}

const lab = new PlayerLightLab();
window.plLab = lab;
window.plLab.THREE = THREE;
lab
  .init(document.getElementById('view'))
  .then(() => log('ready: plLab.visionShot({mode, darkness, level})'))
  .catch((err) => log(`init failed: ${err?.stack ?? err}`));
