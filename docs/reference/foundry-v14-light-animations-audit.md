# Foundry VTT v14 — Light & Darkness Animation Systems Audit

**Purpose:** a formula-exact companion to `foundry-v14-lighting-audit.md`. That doc covers the *base* light system (radius, falloff, colour channels, occlusion) at file:line rigor; its own §13 summarizes the 29-animation-shaped table as a one-line-per-type map. This doc goes one level deeper: the **exact CPU driver formula and exact fragment-shader body for every registered animation type**, quoted verbatim with citations, so a TSL port is a literal, mechanical translation — never a re-derivation.

**Correction to the existing audit, stated plainly up front:** the base audit's §13 header reads "Full animation catalogue (light — 25)" and its closing summary refers to "29 animation types" (25 light + 4 darkness). Both are off. The actual registered total, verified three independent ways (a full read of the registry, a `grep -c` count of every `label: "LIGHT.ANIMATION...."` line in `client/config.mjs`, and a class-by-class reconciliation against all 26 shader-effect files), is **27 — 23 light + 4 darkness**. The base doc's own *table* beneath that header already lists the correct 23 light rows; only the header's count text (and the "29" framing repeated elsewhere) is wrong. This doc uses 27 throughout and treats that as the corrected figure.

**Source of record:** `foundryvttsourcecode_v14/resources/app/` (vendored). Every claim below is grepped/read from that tree; file paths are given so you can re-open the exact code. Where something could not be confirmed — most notably, one uniform that appears to never be assigned at runtime — that is stated as an open finding, not smoothed into a guess.

**Audience note:** same as the base audit — GLSL/PIXI jargon translated toward plain/Hypershade-ish terms where it helps, formulas kept byte-exact. This doc assumes you've read the base audit's §2–§12 first (particularly §2's `dist`, §5c's `ratio`/`switchColor`, §6's coloration techniques, and §7's `FALLOFF`) — animations build directly on top of that machinery and this doc does not re-explain it.

**Path correction:** the base audit's file index lists the GLSL toolkit at `client/canvas/rendering/shaders/mixins/base-shader-mixin.mjs`. The actual location in the v14 tree is one level up: **`client/canvas/rendering/mixins/base-shader-mixin.mjs`** (no `shaders/` in the path). Confirmed by directory listing — there is no `mixins/` folder under `shaders/` at all.

---

## 1. The animation framework

### 1.1 What an animation *is*

Exactly as the base audit's §13 states: an animation is **a CPU update function** (mutates shader uniforms every frame) **+ optional replacement shader classes** per channel (illumination/coloration/darkness — never background, see §1.3). On source init, the source deep-clones the matching registry entry into `this.animation` (`base-light-source.mjs:127`, quoted below); `RenderedEffectSource#_configureShaders` swaps in the replacement shader classes (falling back to the channel's plain default shader when the entry doesn't specify one); and every frame `RenderedEffectSource#animate(dt)` calls the driver function.

```js
// base-light-source.mjs:124-129
_initialize(data) {
  super._initialize(data);
  const animationConfig = foundry.utils.deepClone(this.constructor.ANIMATIONS[this.data.animation.type] || {});
  this.animation = Object.assign(this.data.animation, animationConfig);
}
```

`ANIMATIONS` is a class getter Foundry uses to pick the right registry per source type — light sources read `CONFIG.Canvas.lightAnimations`, darkness sources read `CONFIG.Canvas.darknessAnimations`:

```js
// base-light-source.mjs:63-65
static get ANIMATIONS() {
  return CONFIG.Canvas.lightAnimations;
}
```
```js
// point-darkness-source.mjs:27-30
static get ANIMATIONS() {
  return CONFIG.Canvas.darknessAnimations;
}
```

Shader swap-in, per layer, falls back to the layer's own default shader class when the animation entry doesn't override that channel:

```js
// rendered-effect-source.mjs:274-281
_configureShaders() {
  const a = this.animation;
  const shaders = {};
  for ( const layer in this.layers ) {
    shaders[layer] = a[`${layer.toLowerCase()}Shader`] || this.layers[layer].defaultShader;
  }
  return shaders;
}
```

And the per-frame driver call:

```js
// rendered-effect-source.mjs:518-526
animate(dt) {
  if ( !this.isAnimated ) return;
  const {animation, ...options} = this.animation;
  return animation?.call(this, dt, options);
}
```

### 1.2 The seed (why identical lights don't pulse in lockstep)

Assigned once, at source initialization, and never touched again:

```js
// rendered-effect-source.mjs:213-214
const seed = this.data.seed ?? this.animation.seed ?? Math.floor(Math.random() * 100000);
this.animation = this.data.animation = {seed, ...this.data.animation};
```

The seed is an **additive offset on the animation clock**, not a multiplier or a hash of anything — see `animateTime` below. A GM-set `LightData.seed` (or a value already present on `animation.seed`, e.g. imported/copied data) wins; otherwise it's `Math.floor(Math.random()*100000)`. Two lights created in the same frame with no explicit seed get independently-random seeds (JS `Math.random()` is called once per source), which is what desyncs otherwise-identical torches. **For a TSL/MSA port:** this is a plain per-light CPU float uniform (`uSeed` or folded straight into a per-light `uTimeOffset`) — no GPU-side randomness needed, and no reason to derive it from anything cleverer than `Math.random()` at light-creation time, matching Foundry exactly.

### 1.3 The four CPU driver functions — exact formulas

All are **prototype methods on `RenderedEffectSource` or `BaseLightSource`**, invoked via `animate(dt)` with the per-light `options` spread from the registry entry (`speed`, `intensity`, `reverse`, defaulting `5`, `5`, `false`). They mutate `layer.mesh.uniforms` (== `layer.shader.uniforms`) directly — there is no batching, every active layer gets its own uniform writes every frame.

#### `animateTime` — the base clock (used by 20 of the 23 light entries + all 4 darkness entries)

```js
// rendered-effect-source.mjs:538-551
animateTime(dt, {speed=5, intensity=5, reverse=false}={}) {

  // Determine the animation timing
  let t = canvas.app.ticker.lastTime;
  if ( reverse ) t *= -1;
  this.animation.time = ( (speed * t) / 5000 ) + this.animation.seed;

  // Update uniforms
  for ( const layer of Object.values(this.layers) ) {
    const u = layer.mesh.uniforms;
    u.time = this.animation.time;
    u.intensity = intensity;
  }
}
```
Formula: **`time = (speed × ticker.lastTime) / 5000 + seed`** (sign of the ticker time flips first if `reverse`), written to `u.time` and `u.intensity` on **every** active layer of the source (not just the ones an animation entry overrides — e.g. a darkness source's single `darkness` layer, or a light source's `background`/`illumination`/`coloration` even where only 1–2 have replacement shaders). `speed` is the raw `[0,10]` LightData animation-speed slider used directly as a linear multiplier; there is no additional easing curve on speed (unlike `attenuation`, §7 of the base audit).

#### `animateTorch` → `animateFlickering` (used by `flame`, `torch`, `siren`)

```js
// base-light-source.mjs:254-256
animateTorch(dt, {speed=5, intensity=5, reverse=false} = {}) {
  this.animateFlickering(dt, {speed, intensity, reverse, amplification: intensity / 5});
}
```
```js
// base-light-source.mjs:269-288
animateFlickering(dt, {speed=5, intensity=5, reverse=false, amplification=1} = {}) {
  this.animateTime(dt, {speed, intensity, reverse});

  // Create the noise object for the first frame
  const amplitude = amplification * 0.45;
  /** @type {SmoothNoise} */
  const noise = this.#animationData.noise ??= new SmoothNoise({amplitude: amplitude, scale: 3, maxReferences: 2048});

  // Update amplitude
  if ( noise.amplitude !== amplitude ) noise.amplitude = amplitude;

  // Create noise from animation time. Range [0.0, 0.45]
  let n = noise.generate(this.animation.time);

  // Update brightnessPulse and ratio with some noise in it
  const co = this.layers.coloration.shader;
  const il = this.layers.illumination.shader;
  co.uniforms.brightnessPulse = il.uniforms.brightnessPulse = 0.55 + n;    // Range [0.55, 1.0 <* amplification>]
  co.uniforms.ratio = il.uniforms.ratio = (this.ratio * 0.9) + (n * 0.222);// Range [ratio * 0.9, ratio * ~1.0 <* amplification>]
}
```
This **calls `animateTime` first** (so `time`/`intensity` are also updated on every layer per §1.3's `animateTime` entry), then layers CPU-side 1D noise on top. `SmoothNoise` (`client/canvas/animation/smooth-noise.mjs`, not read in full for this doc — out of GLSL/TSL scope, it's a pure-JS smoothed-noise generator keyed by amplitude/scale/maxReferences) is sampled once per frame at `this.animation.time`, producing `n ∈ [0, amplitude]` where `amplitude = (intensity/5) × 0.45` for the `torch`/`siren` entries (both call `animateTorch`, i.e. `amplification = intensity/5`). Two uniforms are written **directly on `coloration`+`illumination` shaders only** (not background, not darkness):
- `brightnessPulse = 0.55 + n` — range `[0.55, 1.0]` at default intensity(5)/amplification(1), wider at higher intensity.
- `ratio = ratio₀ × 0.9 + n × 0.222` — jitters the light's own bright/dim ratio (§5c of the base audit) around `0.9×ratio₀`.

**Only `flame` calls `animateFlickering` directly** (`amplification` defaults to `1`, i.e. `amplitude=0.45`, no `intensity/5` scaling) — `torch` and `siren` both go through the `animateTorch` wrapper (`amplification = intensity/5`). This is a real, easy-to-miss distinction: at the schema default `intensity=5`, `torch`/`siren`'s amplification is exactly `1` too (identical numerically to `flame`'s default), but they diverge as soon as a GM changes the intensity slider — `flame`'s flicker amplitude stays fixed at `0.45` regardless of intensity (only `time`'s per-frame `intensity` uniform changes, consumed differently per shader, see §4), while `torch`/`siren`'s amplitude scales with intensity.

#### `animatePulse` (used by `pulse`)

```js
// base-light-source.mjs:300-323
animatePulse(dt, {speed=5, intensity=5, reverse=false}={}) {

  // Determine the animation timing
  let t = canvas.app.ticker.lastTime;
  if ( reverse ) t *= -1;
  this.animation.time = ((speed * t)/5000) + this.animation.seed;

  // Define parameters
  const i = (10 - intensity) * 0.1;
  const w = 0.5 * (Math.cos(this.animation.time * 2.5) + 1);
  const wave = (a, b, w) => ((a - b) * w) + b;

  // Pulse coloration
  const co = this.layers.coloration.shader;
  co.uniforms.intensity = intensity;
  co.uniforms.time = this.animation.time;
  co.uniforms.pulse = wave(1.2, i, w);

  // Pulse illumination
  const il = this.layers.illumination.shader;
  il.uniforms.intensity = intensity;
  il.uniforms.time = this.animation.time;
  il.uniforms.ratio = wave(this.ratio, this.ratio * i, w);
}
```
Note this **duplicates** `animateTime`'s clock formula inline rather than calling it (`time = (speed×t)/5000 + seed`, same formula, same variable name) — and it writes `time`/`intensity` **only to `coloration`+`illumination`** (not `background`), unlike `animateTime` which loops every layer. `i = (10-intensity)×0.1` is the *low* end of the wave (an inverted-intensity floor, range `[0,1]` for `intensity∈[0,10]`); `w` is a `[0,1]` cosine breathing wave at angular rate `2.5`; `wave(a,b,w) = (a-b)×w + b` is a plain lerp from `b` (at `w=0`) to `a` (at `w=1`). Coloration's `pulse` breathes between `i` and `1.2`; illumination's `ratio` breathes between `ratio₀×i` and `ratio₀`.

#### `animateSoundPulse` (used by `reactivepulse`, driving the *same* `Pulse*Shader` classes as `pulse`)

```js
// base-light-source.mjs:339-371
animateSoundPulse(dt, {speed=5, intensity=5, reverse=false}={}) {
  this.#animationData.reactiveSoundAmplitude ??= 0;

  // Capture bass, mid, treble
  let bassVal = Math.pow(game.audio.getMaxBandLevel("bass", {ignoreVolume: true}), 1.5);
  let midVal  = Math.pow(game.audio.getMaxBandLevel("mid",  {ignoreVolume: true}), 1.5);
  let trebVal = Math.pow(game.audio.getMaxBandLevel("treble",{ignoreVolume: true}), 1.5);

  // Blend frequencies: 0 => bass, 5 => mid, 10 => treble (approximatly)
  const i = Math.clamp(intensity, 0, 10) / 10;
  const finalVal = (i <= 0.5)
    ? Math.mix(bassVal, midVal, i * 2)
    : Math.mix(midVal, trebVal, (i - 0.5) * 2);

  // Apply exponential smoothing with dt to ensure consistent animation speed across different frame rates
  const smoothing = 1 - Math.exp(-speed * dt * 0.085);

  // Smooth amplitude toward finalVal
  this.#animationData.reactiveSoundAmplitude += (finalVal - this.#animationData.reactiveSoundAmplitude) * smoothing;

  // Optionally invert amplitude
  let amplitude = reverse ? 1 - this.#animationData.reactiveSoundAmplitude : this.#animationData.reactiveSoundAmplitude;
  amplitude = amplitude * this.ratio;

  // Update your shader uniforms
  const co = this.layers.coloration.shader;
  co.uniforms.intensity = intensity;
  co.uniforms.pulse = amplitude;

  const il = this.layers.illumination.shader;
  il.uniforms.intensity = intensity;
  il.uniforms.ratio = Math.clamp(amplitude * 1.11, 0, 1);
}
```
No `time`/`ratio`-breathing-wave here at all — **this driver never touches `u.time`**, so `reactivepulse` lights render `PulseColorationShader`/`PulseIlluminationShader` (§4's `pulse` entry) with a frozen `time` uniform (whatever it last held) and instead drives `pulse`/`ratio` from live audio: bass/mid/treble band levels (`game.audio.getMaxBandLevel`, `^1.5` power curve) blended by `intensity` (0=bass, 10=treble, crossfading through mid at 5), exponentially smoothed toward that target at a `dt`-and-`speed`-scaled rate (`smoothing = 1-exp(-speed×dt×0.085)`), optionally inverted (`reverse`), then scaled by `this.ratio` before feeding `pulse` (coloration) and `ratio×1.11` clamped `[0,1]` (illumination). **For a TSL/MSA port:** this is the one driver that cannot be reduced to a pure-GPU time function — it needs a live audio-analysis input (Web Audio `AnalyserNode` bands) on the CPU/JS side feeding a per-light uniform, exactly like Foundry's own `game.audio` dependency. Worth keeping as an explicit "needs an audio source" TODO rather than silently dropping to `animateTime`-style behavior.

### 1.4 The registry — all 27, verified against `client/config.mjs:828-980`

Light animations at `client/config.mjs:828-956` (23 entries); darkness animations at `client/config.mjs:959-980` (4 entries). `ill`/`col`/`dark` = channel replaced. `fDC` = `forceDefaultColor` set true on the coloration class (see §3.4 for what this gates) — n/a for entries with no coloration shader.

| key | label | CPU driver | ill | col | dark | fDC | shader source file |
|---|---|---|:-:|:-:|:-:|:-:|---|
| `flame` | LIGHT.ANIMATION.Flame | `animateFlickering` | ✓ | ✓ | | | `effects/flame.mjs` |
| `torch` | LIGHT.ANIMATION.Torch | `animateTorch` | ✓ | ✓ | | | `effects/torch.mjs` |
| `revolving` | LIGHT.ANIMATION.Revolving | `animateTime` | | ✓ | | ✓ | `effects/revolving-light.mjs` |
| `siren` | LIGHT.ANIMATION.Siren | `animateTorch` | ✓ | ✓ | | | `effects/siren-light.mjs` |
| `pulse` | LIGHT.ANIMATION.Pulse | `animatePulse` | ✓ | ✓ | | | `effects/pulse.mjs` |
| `reactivepulse` | LIGHT.ANIMATION.ReactivePulse | `animateSoundPulse` | ✓ | ✓ | | | `effects/pulse.mjs` (shared class) |
| `chroma` | LIGHT.ANIMATION.Chroma | `animateTime` | | ✓ | | ✓ | `effects/chroma.mjs` |
| `wave` | LIGHT.ANIMATION.Wave | `animateTime` | ✓ | ✓ | | | `effects/wave.mjs` |
| `fog` | LIGHT.ANIMATION.Fog | `animateTime` | | ✓ | | ✓ | `effects/fog.mjs` |
| `sunburst` | LIGHT.ANIMATION.Sunburst | `animateTime` | ✓ | ✓ | | | `effects/sunburst.mjs` |
| `dome` | LIGHT.ANIMATION.LightDome | `animateTime` | | ✓ | | ✓ | `effects/light-dome.mjs` |
| `emanation` | LIGHT.ANIMATION.Emanation | `animateTime` | | ✓ | | ✓ | `effects/emanation.mjs` |
| `hexa` | LIGHT.ANIMATION.HexaDome | `animateTime` | | ✓ | | ✓ | `effects/hexa-dome.mjs` |
| `ghost` | LIGHT.ANIMATION.GhostLight | `animateTime` | ✓ | ✓ | | | `effects/ghost-light.mjs` |
| `energy` | LIGHT.ANIMATION.EnergyField | `animateTime` | | ✓ | | ✓ | `effects/energy-field.mjs` |
| `vortex` | LIGHT.ANIMATION.Vortex | `animateTime` | ✓* | ✓ | | | `effects/vortex.mjs` |
| `witchwave` | LIGHT.ANIMATION.BewitchingWave | `animateTime` | ✓ | ✓ | | | `effects/bewitching-wave.mjs` |
| `rainbowswirl` | LIGHT.ANIMATION.SwirlingRainbow | `animateTime` | | ✓ | | ✓ | `effects/swirling-rainbow.mjs` |
| `radialrainbow` | LIGHT.ANIMATION.RadialRainbow | `animateTime` | | ✓ | | ✓ | `effects/radial-rainbow.mjs` |
| `fairy` | LIGHT.ANIMATION.FairyLight | `animateTime` | ✓ | ✓ | | ✓ | `effects/fairy-light.mjs` |
| `grid` | LIGHT.ANIMATION.ForceGrid | `animateTime` | | ✓ | | ✓ | `effects/force-grid.mjs` |
| `starlight` | LIGHT.ANIMATION.StarLight | `animateTime` | | ✓ | | ✓ | `effects/star-light.mjs` |
| `smokepatch` | LIGHT.ANIMATION.SmokePatch | `animateTime` | ✓ | ✓ | | | `effects/smoke-patch.mjs` |
| `magicalGloom` | LIGHT.ANIMATION.MagicalGloom | `animateTime` | | | ✓ | — | `effects/magical-gloom.mjs` |
| `roiling` | LIGHT.ANIMATION.RoilingMass | `animateTime` | | | ✓ | — | `effects/roiling-mass.mjs` |
| `hole` | LIGHT.ANIMATION.BlackHole | `animateTime` | | | ✓ | — | `effects/black-hole.mjs` |
| `denseSmoke` | LIGHT.ANIMATION.DenseSmoke | `animateTime` | | | ✓ | — | `effects/dense-smoke.mjs` |

\* `vortex`'s illumination shader class exists and is registered, but its fragment body is textually the unmodified default scaffold — see its §4 entry, this is flagged, not an error in this table.

**Confirmed negative:** no registry entry, anywhere, specifies a `backgroundShader` key (`grep -n "backgroundShader" client/config.mjs` → no matches), and none of the 26 effect files export a class extending `AdaptiveBackgroundShader`. **No animation, light or darkness, ever touches the background channel.** Every animated light still runs the plain `AdaptiveBackgroundShader` for contrast/saturation/shadow, exactly as an unanimated light would (base audit §8).

**The one file→registry many-to-one case:** `effects/pulse.mjs` exports `PulseIlluminationShader`/`PulseColorationShader`, reused verbatim by both `pulse` (driven by `animatePulse`) and `reactivepulse` (driven by `animateSoundPulse`) — same shader classes, different CPU driver swapped underneath. Every other registry entry maps 1:1 to its own file. This is why 26 shader-effect files produce 27 registry rows.

---

## 2. The shared GLSL toolkit (quoted once)

All of the following live on `BaseShaderMixin` (`client/canvas/rendering/mixins/base-shader-mixin.mjs`) as static string/function members, mixed into every shader class via `AbstractBaseShader extends BaseShaderMixin(PIXI.Shader)` (`base-shader.mjs:11`). Per-animation sections below reference these by name ("uses `FBM(4,1.0)`") rather than re-quoting the body each time.

### `CONSTANTS` (base-shader-mixin.mjs:65-75, extended by `AdaptiveLightingShader.CONSTANTS` at base-lighting.mjs:170-175)
```glsl
const float PI = 3.141592653589793;
const float TWOPI = 6.283185307179586;
const float INVPI = 0.3183098861837907;
const float INVTWOPI = 0.15915494309189535;
const float SQRT2 = 1.4142135623730951;
const float SQRT1_2 = 0.7071067811865476;
const float SQRT3 = 1.7320508075688772;
const float SQRT1_3 = 0.5773502691896257;
const vec3 BT709 = vec3(0.2126, 0.7152, 0.0722);
```
Lighting shaders additionally get (`base-lighting.mjs:170-175`):
```glsl
const float INVTHREE = 1.0 / 3.0;
const vec2 PIVOT = vec2(0.5);
const vec4 ALLONES = vec4(1.0);
```

### `PERCEIVED_BRIGHTNESS` (base-shader-mixin.mjs:84-89) — used by nearly every animation
```glsl
float perceivedBrightness(in vec3 color) { return sqrt(dot(BT709, color * color)); }
float perceivedBrightness(in vec4 color) { return perceivedBrightness(color.rgb); }
float reversePerceivedBrightness(in vec3 color) { return 1.0 - perceivedBrightness(color); }
float reversePerceivedBrightness(in vec4 color) { return 1.0 - perceivedBrightness(color.rgb); }
```

### `SIMPLEX_3D` (`snoise`, base-shader-mixin.mjs:97-156) — used only by `dense-smoke.mjs`
The classic Ashima/McEwan simplex-noise-3D GLSL (permute/taylorInvSqrt gradient hash, `snoise(vec3 v) -> float`). Quoted in full since it's the one primitive only one animation needs (not worth re-deriving from memory for a port — copy verbatim):
```glsl
vec4 permute(in vec4 x) {
  return mod(((x * 34.0) + 1.0) * x, 289.0);
}

vec4 taylorInvSqrt(in vec4 r) {
  return 1.79284291400159 - 0.85373472095314 * r;
}

float snoise(in vec3 v) {
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + 2.0*C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0*C.xxx;
  i = mod(i, 289.0);

  vec4 p = permute(
             permute(
               permute(i.z + vec4(0.0, i1.z, i2.z, 1.0))
             + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 1.0 / 7.0;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 xx = x_ * ns.x + ns.yyyy;
  vec4 yy = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(xx) - abs(yy);
  vec4 b0 = vec4(xx.xy, yy.xy);
  vec4 b1 = vec4(xx.zw, yy.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m *= m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
```

### `PRNG` families (base-shader-mixin.mjs:273-317) — hash-based pseudo-random, no trig-driver dependency
```glsl
// PRNG_LEGACY (uses cos — some drivers have precision bugs here; PRNG below replaced it as the default)
float random(in vec2 uv) {
  return fract(cos(dot(uv, vec2(12.9898, 4.1414))) * 43758.5453);
}
```
```glsl
// PRNG — the one actually used by every 2D-noise animation in this doc
float random(in vec2 uv) {
  uv = mod(uv, 1000.0);
  return fract( dot(uv, vec2(5.23, 2.89)
                    * fract((2.41 * uv.x + 2.27 * uv.y)
                             * 251.19)) * 551.83);
}
```
```glsl
// PRNG2D
vec2 random(in vec2 uv) {
  vec2 uvf = fract(uv * vec2(0.1031, 0.1030));
  uvf += dot(uvf, uvf.yx + 19.19);
  return fract((uvf.x + uvf.y) * uvf);
}
```
```glsl
// PRNG3D — used by energy-field.mjs's hand-rolled voronoi3d
vec3 random(in vec3 uv) {
  return vec3(fract(cos(dot(uv, vec3(12.9898,  234.1418,    152.01))) * 43758.5453),
              fract(sin(dot(uv, vec3(80.9898,  545.8937, 151515.12))) * 23411.1789),
              fract(cos(dot(uv, vec3(01.9898, 1568.5439,    154.78))) * 31256.8817));
}
```

### `NOISE` (base-shader-mixin.mjs:325-335) — 2D value noise, built on `PRNG`'s `random(vec2)`
```glsl
float noise(in vec2 uv) {
  const vec2 d = vec2(0.0, 1.0);
  vec2 b = floor(uv);
  vec2 f = smoothstep(vec2(0.), vec2(1.0), fract(uv));
  return mix(
    mix(random(b), random(b + d.yx), f.x),
    mix(random(b + d.xy), random(b + d.yy), f.x),
    f.y
  );
}
```

### `FBM(octaves=4, amp=1.0)` (base-shader-mixin.mjs:211-221) — a **function**, not a fixed string; per-call octave/amplitude baked into the generated GLSL text
```glsl
float fbm(in vec2 uv) {
  float total = 0.0, amp = ${amp};
  for (int i = 0; i < ${octaves}; i++) {
    total += noise(uv) * amp;
    uv += uv;
    amp *= 0.5;
  }
  return total;
}
```
Requires `NOISE` (hence `PRNG`) already declared. Called across the 27 animations with varying `(octaves, amp)`: `FBM(4,1.0)` (bewitching-wave, fog, vortex), `FBM(3,1.0)` (fairy-light, ghost-light, star-light uses `FBM(2,1.0)`), `FBM(2)` (light-dome, default amp 1.0), `FBM(3)` (roiling-mass, default amp 1.0). **Port note:** since this is octave-parametrized at shader-*build* time (a JS template literal producing a fixed unrolled `for`), a TSL port needs either a fixed-octave `Loop` per call site (matching each animation's own chosen octave count) or a single generic `Fn` taking octaves as a JS-side constant baked at material-build time — not a runtime-variable loop bound.

### `FBMHQ(octaves=3, fbmFuncName="fbm", noiseFuncName="noise", vecType="vec2")` (base-shader-mixin.mjs:233-246) — the higher-quality variant, also parametrized, and **reusable over `vec3` inputs** (this is how `dense-smoke.mjs` builds a 3D fbm over `snoise` instead of 2D `noise`)
```glsl
float ${fbmFuncName}(in ${vecType} uv, in float smoothness) {
  float s = exp2(-smoothness);
  float f = 1.0;
  float a = 1.0;
  float t = 0.0;
  for( int i = 0; i < ${octaves}; i++ ) {
      t += a * ${noiseFuncName}(f * uv);
      f *= 2.0;
      a *= s;
  }
  return t;
}
```
Note the **call signature differs from `FBM`'s**: `FBMHQ`'s generated `fbm(uv, smoothness)` takes a *second runtime argument* (`smoothness`, consumed per-call, not baked at generation time) — every call site passes its own `smoothness` float (e.g. flame.mjs passes `1.0` and `2.0` at different call sites of the *same* generated function). Used by: `black-hole` (`FBMHQ()` — all defaults, 2D), `dense-smoke` (`FBMHQ(5,"fbm","snoise","vec3")` — 3D, keyed to simplex not value-noise), `flame` (`FBMHQ(3)`), `magical-gloom` (`FBMHQ()`), `smoke-patch` (`FBMHQ(3)`, ×2 call sites, illumination+coloration).

### `PIE` (base-shader-mixin.mjs:258-265) — used by `revolving-light.mjs`, `siren-light.mjs`
```glsl
float pie(in vec2 coord, in float angle, in float smoothness, in float l) {
  coord.x = abs(coord.x);
  vec2 va = vec2(sin(angle), cos(angle));
  float lg = length(coord) - l;
  float clg = length(coord - va * clamp(dot(coord, va) , 0.0, l));
  return smoothstep(0.0, smoothness, max(lg, clg * sign(va.y * coord.x - va.x * coord.y)));
}
```
An angular-wedge SDF-ish mask: `coord` in `[-1,1]` space, `angle` = half-aperture in radians, `l` = beam length, `smoothness` = edge softness. Returns ~0 inside the wedge, ~1 outside.

### `ROTATION` (base-shader-mixin.mjs:372-378) — used by `revolving-light.mjs`, `siren-light.mjs`
```glsl
mat2 rot(in float a) {
  float s = sin(a);
  float c = cos(a);
  return mat2(c, -s, s, c);
}
```

### `HSB2RGB` (base-shader-mixin.mjs:343-348) — used by `chroma`, `fairy-light`, `radial-rainbow`, `swirling-rainbow`
```glsl
vec3 hsb2rgb(in vec3 c) {
  vec3 rgb = clamp(abs(mod(c.x*6.0+vec3(0.0,4.0,2.0), 6.0)-3.0)-1.0, 0.0, 1.0 );
  rgb = rgb*rgb*(3.0-2.0*rgb);
  return c.z * mix(vec3(1.0), rgb, c.y);
}
```
Standard polar HSB→RGB (`c.x`=hue `[0,1]`, `c.y`=saturation, `c.z`=brightness). All four call sites use `hsb2rgb(vec3(hueExpr, 1.0, 1.0))` — full saturation/brightness, only hue animated.

### `WAVE(func="cos")` (base-shader-mixin.mjs:358-364) — **declared in the toolkit but not called by name in any of the 27 animation files** (each animation that wants a sine/cosine wave hand-writes its own `0.5*(sin(...)+1.0)` inline instead — see e.g. `sunburst.mjs`'s `cosTime`, `force-grid.mjs`'s `wave()`, both hand-rolled, not this primitive). Quoted for completeness since the base audit's §13 table lists it as toolkit; flagged here as **effectively unused** by the shipped animation set.
```glsl
float w${func}(in float v1, in float v2, in float a, in float speed) {
  float w = ${func}( speed + a ) + 1.0;
  return (v1 - v2) * (w * 0.5) + v2;
}
```

### `VORONOI` (base-shader-mixin.mjs:388-432) — **declared in the toolkit but not called by name in any of the 27 animation files either.** `energy-field.mjs` (the one animation that visibly does cellular/Worley-style noise) hand-rolls its own `voronoi3d()` using `PRNG3D`'s `random(vec3)` directly (see §4's `energy` entry) rather than calling this shared 2D `voronoi(uv,t,zd)`. Quoted here since it's real, shipped, toolkit-declared GLSL a port might reasonably assume is load-bearing — it is not, for the current 27 animations.
```glsl
vec3 voronoi(in vec2 uv, in float t, in float zd) {
  vec2 uvi = floor(uv);
  vec2 uvf = fract(uv);
  vec3 vor = vec3(0.0, 0.0, zd);
  float bestDist2 = zd * zd;

  vec2 OFFSETS[9];
  OFFSETS[0] = vec2(-1.0, -1.0);
  OFFSETS[1] = vec2( 0.0, -1.0);
  OFFSETS[2] = vec2( 1.0, -1.0);
  OFFSETS[3] = vec2(-1.0,  0.0);
  OFFSETS[4] = vec2( 0.0,  0.0);
  OFFSETS[5] = vec2( 1.0,  0.0);
  OFFSETS[6] = vec2(-1.0,  1.0);
  OFFSETS[7] = vec2( 0.0,  1.0);
  OFFSETS[8] = vec2( 1.0,  1.0);

  for ( int k = 0; k < 9; k++ ) {
    vec2 uvn = OFFSETS[k];
    float rnd = random(uvi + uvn);

    float r1 = 0.5 * sin(TWOPI * rnd + t) + 0.5;
    float r2 = 0.5 * sin(TWOPI * r1  + t) + 0.5;
    vec2 uvr = vec2(r2, r2);
    vec2 diff = (uvn + uvr - uvf);
    float dist2 = dot(diff, diff);
    if ( dist2 < bestDist2 ) {
      float dist = sqrt(dist2);
      vor.xy   = uvr;
      vor.z    = dist;
      bestDist2 = dist2;
    }
  }
  return vor;
}

vec3 voronoi(vec2 vuv, float zd) { return voronoi(vuv, 0.0, zd); }
vec3 voronoi(vec3 vuv, float zd) { return voronoi(vuv.xy, vuv.z, zd); }
```

### `COLOR_SPACES` (base-shader-mixin.mjs:164-201) — bonus, not called by any of the 27 animations, but load-bearing elsewhere in Foundry's pipeline and worth having on hand for the port (sRGB⇄linear, `tintColor`):
```glsl
float luminance(in vec3 c) { return dot(BT709, c); }
vec3 linear2grey(in vec3 c) { return vec3(luminance(c)); }

vec3 linear2srgb(in vec3 c) {
  vec3 a = 12.92 * c;
  vec3 b = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  vec3 s = step(vec3(0.0031308), c);
  return mix(a, b, s);
}

vec3 srgb2linear(in vec3 c) {
  vec3 a = c / 12.92;
  vec3 b = pow((c + 0.055) / 1.055, vec3(2.4));
  vec3 s = step(vec3(0.04045), c);
  return mix(a, b, s);
}

vec3 srgb2linearFast(in vec3 c) { return c * c; }
vec3 linear2srgbFast(in vec3 c) { return sqrt(c); }
```

---

## 3. The four-channel scaffold, exact text

Every channel shader assembles as **`SHADER_HEADER` + toolkit primitives it needs + `main()`**, where `main()` is `FRAGMENT_BEGIN` + (an animated or default body) + `FRAGMENT_END`, per `AdaptiveLightingShader`'s architecture (`base-lighting.mjs`). This section quotes the parts every one of the 27 animations either inherits unchanged or overrides — §4 then shows, per animation, only the delta.

### 3.1 `SHADER_HEADER` (identical shape for illumination/coloration/background; darkness omits `SWITCH_COLOR`)
```js
// illumination-lighting.mjs:49-55 (coloration-lighting.mjs:41-47, background-lighting.mjs:14-20 — identical shape)
static SHADER_HEADER = `
${this.FRAGMENT_UNIFORMS}
${this.VERTEX_FRAGMENT_VARYINGS}
${this.FRAGMENT_FUNCTIONS}
${this.CONSTANTS}
${this.SWITCH_COLOR}
`;
```
```js
// darkness-lighting.mjs:101-106 — no SWITCH_COLOR (darkness never cross-fades bright/dim; there is no ratio concept for darkness, base audit §12)
static SHADER_HEADER = `
${this.FRAGMENT_UNIFORMS}
${this.VERTEX_FRAGMENT_VARYINGS}
${this.FRAGMENT_FUNCTIONS}
${this.CONSTANTS}
`;
```

`FRAGMENT_UNIFORMS` (base-lighting.mjs:79-135) — full text, since every animation's extra uniforms (`brightnessPulse`, `pulse`, `angle`, `gradientFade`, `beamLength`) either draw from this list or extend it:
```glsl
uniform int technique;
uniform bool useSampler;
uniform bool hasColor;
uniform bool computeIllumination;
uniform bool linkedToDarknessLevel;
uniform bool enableVisionMasking;
uniform bool globalLight;
uniform float attenuation;
uniform float borderDistance;
uniform float contrast;
uniform float shadows;
uniform float exposure;
uniform float saturation;
uniform float intensity;
uniform float brightness;
uniform float luminosity;
uniform float pulse;
uniform float brightnessPulse;
uniform float backgroundAlpha;
uniform float illuminationAlpha;
uniform float colorationAlpha;
uniform float ratio;
uniform float time;
uniform float darknessLevel;
uniform float darknessPenalty;
uniform vec2 globalLightThresholds;
uniform vec3 color;
uniform vec3 colorBackground;
uniform vec3 colorVision;
uniform vec3 colorTint;
uniform vec3 colorEffect;
uniform vec3 colorDim;
uniform vec3 colorBright;
uniform vec3 ambientDaylight;
uniform vec3 ambientDarkness;
uniform vec3 ambientBrightest;
uniform int dimLevelCorrection;
uniform int brightLevelCorrection;
uniform vec4 weights;
uniform sampler2D primaryTexture;
uniform sampler2D depthTexture;
uniform sampler2D darknessLevelTexture;
uniform sampler2D visionTexture;

// Shared uniforms with vertex shader
uniform float rotation;
uniform float angle;
uniform float radius;
uniform float depthElevation;
uniform vec2 resolution;
uniform vec2 screenDimensions;
uniform vec3 origin;
uniform vec3 dimensions;
uniform mat3 translationMatrix;
uniform mat3 projectionMatrix;
```
Note `brightnessPulse`, `pulse`, `intensity`, `ratio`, `time` are **already declared here, in the shared block, at their generic default** (`0.0` for floats not otherwise set) — animation shaders never need to `uniform float pulse;` themselves; they only add genuinely *new* names not already in this list (`gradientFade`, `beamLength` — both `revolving`/`siren` only).

### 3.2 `FRAGMENT_BEGIN` / `FRAGMENT_END` — light channels (illumination/coloration/background share the base; darkness overrides both)

Base (`base-lighting.mjs:392-407`), used verbatim by illumination and coloration (background too — none of the 26 files override `FRAGMENT_BEGIN`/`FRAGMENT_END` on the background channel since no animation touches background at all):
```glsl
// FRAGMENT_BEGIN
${this.COMPUTE_ILLUMINATION}
float dist = distance(vUvs, vec2(0.5)) * 2.0;
vec4 depthColor = texture2D(depthTexture, vSamplerUvs);
float depth = smoothstep(0.0, 1.0, vDepth) * (globalLight ? 1.0 : step(depthColor.g, depthElevation) * step(depthElevation, (254.5 / 255.0) - depthColor.r));
vec4 baseColor = useSampler ? texture2D(primaryTexture, vSamplerUvs) : vec4(1.0);
vec3 finalColor = baseColor.rgb;
```
```glsl
// FRAGMENT_END (base — used by coloration verbatim via its own identical override, and by background which never overrides it)
gl_FragColor = vec4(finalColor, 1.0) * depth;
```

Illumination overrides `FRAGMENT_END` only (`illumination-lighting.mjs:11-13`):
```glsl
gl_FragColor = vec4(mix(computedBackgroundColor, finalColor, depth), 1.0);
```
**Alpha-channel asymmetry, worth stating plainly for a TSL port:** illumination's alpha is **hardcoded to `1.0`**, independent of `depth`/falloff. Coloration's (and background's, and the base default's) alpha is **`1.0 * depth`** — i.e. `depth` *is* the alpha, so it fades toward 0 at the light's edge and wherever `FALLOFF` shrinks `depth`. This matters for any downstream compositor reading the alpha channel of these render targets. (MSA's own `point-light-illumination.js` already matches this — `vec4(outputColor, float(1))`, alpha hardcoded 1. MSA's `point-light-coloration.js` currently also hardcodes alpha to `1` — `vec4(outputColor, float(1))` — which is a **pre-existing, animation-independent deviation** from Foundry's coloration alpha-equals-depth contract; noted here since it surfaced while cross-referencing, see §5.)

Coloration overrides `FRAGMENT_END` (identically to the base — `coloration-lighting.mjs:11-13`, textually the same as §3.2's base block above, re-declared rather than inherited).

### 3.3 `FRAGMENT_BEGIN` / `FRAGMENT_END` — darkness channel (both overridden, `darkness-lighting.mjs:72-93`)
```glsl
// FRAGMENT_END — textually identical to the base default (redeclared, not substantively different)
gl_FragColor = vec4(finalColor, 1.0) * depth;
```
```glsl
// FRAGMENT_BEGIN — genuinely different from the light-channel version
${this.COMPUTE_ILLUMINATION}
float dist = distance(vUvs, vec2(0.5)) * 2.0;
vec4 depthColor = texture2D(depthTexture, vSamplerUvs);
float depth = smoothstep(0.0, 1.0, vDepth) *
              step(depthColor.g, depthElevation) *
              step(depthElevation, (254.5 / 255.0) - depthColor.r) *
              (enableVisionMasking ? 1.0 - step(texture2D(visionTexture, vSamplerUvs).r, 0.0) : 1.0) *
              (1.0 - smoothstep(borderDistance, 1.0, dist));
vec4 baseColor = texture2D(primaryTexture, vSamplerUvs);
vec3 finalColor = baseColor.rgb;
```
Differences from the light-channel `FRAGMENT_BEGIN`: no `globalLight` bypass (darkness sources are never global), elevation `step()` tests always apply, an extra vision-masking factor, and an extra `borderDistance` radial fade (the visual-padding mechanic, base audit §12) baked directly into `depth` rather than left to a separate `FALLOFF` block. **Darkness has no `FALLOFF`/`ADJUSTMENTS`/`COLORATION_TECHNIQUES` concept at all** — none of the 4 darkness animation files call any of those three macros; the entire look is `FRAGMENT_BEGIN` → one-or-more hand-written `finalColor` lines → `FRAGMENT_END`.

### 3.4 Per-channel `main()` assembly (the exact scaffold each of §4's animations patches)

**Illumination** (`illumination-lighting.mjs:58-70`):
```glsl
void main() {
  ${this.FRAGMENT_BEGIN}
  ${this.TRANSITION}
  ${this.ILLUMINATION_TECHNIQUES}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
where `TRANSITION` (base-lighting.mjs:342-343) is exactly `finalColor = switchColor(computedBrightColor, computedDimColor, dist);` and `ILLUMINATION_TECHNIQUES` is near-always empty text — of the 13 coloration techniques (base audit §6), only **100 (Natural Attenuation)** and **101 (Adaptive Attenuation)** contribute an `illumination:` fragment at all (the exponential-falloff `depth *= max(0.095, fall)` block, base audit §7c); every other technique id contributes nothing to the illumination channel, so at the LightData-schema default (technique 1) this macro expands to an empty string.

**Coloration** (`coloration-lighting.mjs:50-62`):
```glsl
void main() {
  ${this.FRAGMENT_BEGIN}
  finalColor = color * colorationAlpha;
  ${this.COLORATION_TECHNIQUES}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
**This is the scaffold every one of the 22 unique coloration-animation classes patches — and every single one of them keeps `${this.COLORATION_TECHNIQUES}` running immediately after its own custom `finalColor =` line.** None of the 27 animation shaders skip or replace the technique block; they only replace the *seed* value technique reads. At the schema default (technique 1, "Adaptive Luminance"), `COLORATION_TECHNIQUES` expands to exactly:
```glsl
if ( technique == 1 ) {
  float reflection = perceivedBrightness(baseColor);
  finalColor *= reflection;
}
```
So e.g. Torch's animated line `finalColor = color * brightnessPulse * colorationAlpha;` is **still followed by `finalColor *= reflection`** at default settings — the animated seed and the technique compose, they don't compete. **This is the single most important fact for the MSA port**: `point-light-coloration.js`'s existing `reflection` term (its own technique-1 implementation) should be **reused unchanged** by every animated coloration port; only the `finalColor = ...` seed line before it needs replacing per animation.

`forceDefaultColor` (declared `false` on the base `AdaptiveLightingShader`, base-lighting.mjs:21) is read only by `AdaptiveColorationShader#isRequired` (coloration-lighting.mjs:101-112):
```js
get isRequired() {
  const vs = canvas.visibility.lightingVisibility;
  if ( vs.coloration === VisionMode.LIGHTING_VISIBILITY.REQUIRED ) return true;
  if ( vs.coloration === VisionMode.LIGHTING_VISIBILITY.DISABLED ) return false;
  return this.constructor.forceDefaultColor || this.uniforms.hasColor;
}
```
i.e. a coloration **layer** (the whole mesh, CPU-side, per `RenderedEffectSource#hasActiveLayer`/`#updateVisibleLayers`) is skipped entirely for a colourless light (`LightData.color === null`) **unless** the animation's coloration class sets `forceDefaultColor = true` — meaning that animation invents its own colour (a rainbow hue cycle, a white-default force-field) and must render even with no author-picked tint. §1.4's table carries this per-row; the full roster, reconciled class-by-class:

- **`forceDefaultColor = true`** (13): Chroma, Emanation, EnergyField, FairyLight, ForceGrid, Fog, HexaDome, LightDome, RadialRainbow, Revolving, StarLight, SwirlingRainbow, Vortex.
- **left `false`/unset** (9): BewitchingWave, Flame, GhostLight, Pulse (governs both `pulse`+`reactivepulse`), Siren, SmokePatch, Sunburst, Torch, Wave.

For MSA: `point-light-coloration.js` currently sets `uColorationAlpha = 0` for a colourless light as its equivalent gate (per that file's own header comment). **Any of the 13 `forceDefaultColor` animations must bypass that gate** — the coloration mesh needs to draw (and needs its own colour value, defaulting to white `[1,1,1]` the way Foundry's `color` uniform default does, base-lighting default `color: [1,1,1]`) even when the light itself carries no author colour.

**Background** (`background-lighting.mjs:23-34`) — quoted for completeness; **no animation ever reaches this scaffold**:
```glsl
void main() {
  ${this.FRAGMENT_BEGIN}
  ${this.ADJUSTMENTS}
  ${this.BACKGROUND_TECHNIQUES}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```

**Darkness** (`darkness-lighting.mjs:111-120`) — the default (unanimated) body, which `roiling-mass.mjs` extends almost verbatim and the other three darkness animations replace wholesale:
```glsl
void main() {
  ${this.FRAGMENT_BEGIN}
  finalColor *= (mix(color, color * 0.33, darknessLevel) * colorationAlpha);
  ${this.FRAGMENT_END}
}
```

### 3.5 The reusable operator blocks (already fully quoted in the base audit §5c/§7/§8/§10 — cited, not re-quoted here)
`SWITCH_COLOR`, `FALLOFF`, `CONTRAST`, `SATURATION`, `EXPOSURE` (illumination has its own ¼-strength override, `illumination-lighting.mjs:29-43`; coloration has none — coloration's `ADJUSTMENTS` is SATURATION+SHADOW only, no EXPOSURE, `coloration-lighting.mjs:19-25`), `SHADOW` (coloration's own override samples `baseColor.rgb` at a `[0.25,0.35]` band instead of the base's `changedColor` at `[0.50,0.80]`, `coloration-lighting.mjs:28-35`) — see base audit §5c, §7, §8, §10 for exact text; nothing about any of these operator blocks is animation-specific, they run identically whether or not an animation is active.

---

## 4. The 27 animations

Each entry: what it demonstrates, the exact channel body/bodies (only the lines that differ from §3.4's scaffold — everything else is the scaffold, unchanged), toolkit primitives it calls into, and an MSA port note keyed to the actual current variable/uniform names in `point-light-illumination.js`/`point-light-coloration.js`. Light animations first (registry order), then the 4 darkness animations.

### `flame` — Flame
**Demonstrates:** FBM-driven flame "tongues" radiating from center, layered on top of the standard flicker (this is the richer, harder-to-port sibling of `torch`, which uses the same CPU driver but a flat unshaped pulse).

*Illumination* (`effects/flame.mjs:7-27`) — toolkit: `PERCEIVED_BRIGHTNESS` only.
```glsl
void main() {
  ${this.FRAGMENT_BEGIN}
  ${this.TRANSITION}
  finalColor *= brightnessPulse;
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
`defaultUniforms` adds `brightnessPulse: 1` (flame.mjs:26).

*Coloration* (`effects/flame.mjs:34-93`) — toolkit: `PRNG`, `NOISE`, `FBMHQ(3)`, `PERCEIVED_BRIGHTNESS`.
```glsl
vec2 scale(in vec2 uv, in float scale) {
  mat2 scalemat = mat2(scale, 0.0, 0.0, scale);
  uv -= PIVOT;
  uv *= scalemat;
  uv += PIVOT;
  return uv;
}

void main() {
  ${this.FRAGMENT_BEGIN}
  vec2 uv = scale(vUvs, 10.0 * ratio);

  float intens = pow(0.1 * intensity, 2.0);
  float fratioInner = ratio * (intens * 0.5) -
                 (0.005 *
                      fbm( vec2(
                           uv.x + time * 8.01,
                           uv.y + time * 10.72), 1.0));
  float fratioOuter = ratio - (0.007 *
                      fbm( vec2(
                           uv.x + time * 7.04,
                           uv.y + time * 9.51), 2.0));

  float fdist = max(dist - fratioInner * intens, 0.0);

  float flameDist = smoothstep(clamp(0.97 - fratioInner, 0.0, 1.0),
                               clamp(1.03 - fratioInner, 0.0, 1.0),
                               1.0 - fdist);
  float flameDistInner = smoothstep(clamp(0.95 - fratioOuter, 0.0, 1.0),
                                    clamp(1.05 - fratioOuter, 0.0, 1.0),
                                    1.0 - fdist);

  vec3 flameColor = color * 8.0;
  vec3 flameFlickerColor = color * 1.2;

  finalColor = mix(mix(color, flameFlickerColor, flameDistInner),
                   flameColor,
                   flameDist) * brightnessPulse * colorationAlpha;
  ${this.COLORATION_TECHNIQUES}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
`defaultUniforms` adds `brightnessPulse: 1` (flame.mjs:92). Note `color * 8.0` — the flame's hot core deliberately blows past `[0,1]`, relying on downstream clamping/blend to tame it; keep this over-bright core if HDR is available (see §5's "where MSA can do better" note).

**MSA port:** illumination — insert `.mul(uBrightnessPulse)` between the existing `finalColor` (switchColor result) and the `EXPOSURE` block in `point-light-illumination.js`; needs a new `uBrightnessPulse` uniform (CPU-fed from `animateFlickering`'s formula, §1.3). Coloration — replace the `finalColor = uLightColor.mul(uColorationAlpha).mul(reflection)` line's *seed* (keep `reflection`, multiply the whole flame expression by it exactly as Foundry's `COLORATION_TECHNIQUES` does); the `fbm`/`scale`/flame-distance math is new TSL, `ratio`/`time`/`intensity`/`color` are all already-available uniforms on the coloration material.

---

### `torch` — Torch
**Demonstrates:** the "pure CPU-uniform" animation case — same driver family as `flame` (`animateTorch`→`animateFlickering`), but the **illumination shader body is textually the unmodified default scaffold**. The flicker still visibly animates illumination because `animateFlickering` jitters the shared `ratio` uniform that `TRANSITION`/`switchColor` already reads — no shader-side change needed. Contrast this with `vortex` below, which *looks* similarly "default" but for a different, more concerning reason (dead code, not CPU-sufficiency).

*Illumination* (`effects/torch.mjs:7-23`) — toolkit: `PERCEIVED_BRIGHTNESS` (unused by name in the body, declared per the shared header pattern).
```glsl
void main() {
  ${this.FRAGMENT_BEGIN}
  ${this.TRANSITION}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
Textually identical to §3.4's illumination scaffold — zero lines added.

*Coloration* (`effects/torch.mjs:30-51`) — toolkit: `PERCEIVED_BRIGHTNESS`.
```glsl
void main() {
  ${this.FRAGMENT_BEGIN}
  finalColor = color * brightnessPulse * colorationAlpha;
  ${this.COLORATION_TECHNIQUES}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
`defaultUniforms` adds `ratio: 0, brightnessPulse: 1` (torch.mjs:50) — note `ratio` defaults to `0` here specifically (unlike Flame's coloration, which doesn't override `ratio`'s shared default of `0.5`); harmless since this shader's own body never reads `ratio`.

**MSA port:** illumination needs **no new shader code at all** — reusing `point-light-illumination.js`'s existing `uRatio` uniform and feeding it the CPU-jittered value from `animateFlickering` (§1.3's `ratio = ratio₀×0.9 + n×0.222`) reproduces Torch's illumination animation exactly, because the existing `switchColor`-equivalent block already consumes `uRatio` every frame. Coloration: same pattern as `flame` — replace the seed line with `uLightColor.mul(uBrightnessPulse).mul(uColorationAlpha)`, still followed by `.mul(reflection)`.

---

### `revolving` — Revolving
**Demonstrates:** a rotating beam, coloration-only, via the `PIE`/`ROTATION` toolkit. **The one animation whose rotation-driving `angle` uniform could not be confirmed as ever being assigned from live light data — see the flagged finding below.**

*Coloration* (`effects/revolving-light.mjs:6-44`) — toolkit: `PERCEIVED_BRIGHTNESS`, `PIE`, `ROTATION`. `forceDefaultColor = true`.
```glsl
uniform float gradientFade;
uniform float beamLength;

void main() {
  ${this.FRAGMENT_BEGIN}
  vec2 ncoord = vUvs * 2.0 - 1.0;
  float angularIntensity = mix(PI, PI * 0.5, intensity * 0.1);
  ncoord *= rot(angle + time);
  float angularCorrection = pie(ncoord, angularIntensity, gradientFade, beamLength);
  finalColor = color * colorationAlpha * angularCorrection;
  ${this.COLORATION_TECHNIQUES}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
`defaultUniforms` adds `angle: 0, gradientFade: 0.15, beamLength: 1` (revolving-light.mjs:38-43).

**Flagged finding — the `angle` uniform appears to be dead/always-0 at runtime.** `angle`/`rotation` are declared in the shared `FRAGMENT_UNIFORMS`/`VERTEX_UNIFORMS` block (§3.1, "shared uniforms with vertex shader") and this shader's own `defaultUniforms` sets `angle: 0`. I traced every plausible place `mesh.shader.uniforms.angle` could be written from the light's actual `LightData.rotation`/cone `angle` fields and found none:
- `point-effect-source.mjs:137` sets `angle: this.data.angle` — but that's the **polygon-shape config** object passed to `_createShapes()`, never a shader uniform.
- `rendered-effect-source.mjs` (`_updateCommonUniforms`'s caller chain, `#updateUniforms`) — no `u.angle =` anywhere.
- `base-light-source.mjs`'s `_updateCommonUniforms` override (base audit §5d/§7's `exposure`/`attenuation` wiring) — no `u.angle =`.
- `point-light-source.mjs`, `point-darkness-source.mjs` — grepped and read, no `u.angle =`.
- `point-source-mesh.mjs` — a thin `PIXI.Mesh` bounds-calculation subclass, no uniform sync logic at all.
- `base-shader.mjs`'s `AbstractBaseShader.create(uniforms, options)` — merges `defaultUniforms` with a caller-supplied `uniforms` override via `insertKeys:false`; the only `options` ever passed at creation is `{primaryTexture: canvas.primary.renderTexture}` (`rendered-effect-source.mjs:319-321`), nothing angle-related.
- `base-effect-source.mjs` — grepped for `angle`, zero hits.

If this trace is complete, `angle` sits fixed at its `defaultUniforms` value (`0`) for the lifetime of the shader, meaning `rot(angle + time)` reduces to `rot(time)` in practice — the beam still visibly rotates (driven by `time` alone), just never offset by the light's actual facing/cone data. **This is stated as an open finding, not a confirmed bug**: it's possible a mechanism outside the files read here (a hook, a `Placeable`-level sync, or something in `light.mjs`'s placeable-to-source data flow not covered by this doc's scope) sets it. Recommend the porting team verify live (place a Revolving-animated light, rotate it in the Foundry UI, see if the beam's phase visibly shifts) before deciding whether MSA's port needs an `angle` input at all.

**MSA port:** new coloration-only material. `dist`/`falloff` reuse `point-light-coloration.js`'s existing terms unchanged; `reflection`/technique-1 still applies after (§3.4). Everything else (`pie`, `rot`, `ncoord`, `angularIntensity`) is new TSL — `PIE`/`ROTATION` have no existing MSA equivalent (§5). Per the flagged finding, `rot(time)` alone (no `angle` term) is the defensible default unless live-testing says otherwise.

---

### `siren` — Siren
**Demonstrates:** the same rotating-beam idea as Revolving, but on the `animateTorch` driver (so it *also* gets `brightnessPulse`/jittered `ratio`) and touching **both** illumination and coloration. Shares Revolving's `angle`-uniform ambiguity.

*Coloration* (`effects/siren-light.mjs:7-44`) — toolkit: `PERCEIVED_BRIGHTNESS`, `PIE`, `ROTATION`. `forceDefaultColor` **not set** (false) — unlike Revolving, a Siren light with no author colour renders no coloration mesh at all.
```glsl
uniform float gradientFade;
uniform float beamLength;

void main() {
  ${this.FRAGMENT_BEGIN}
  vec2 ncoord = vUvs * 2.0 - 1.0;
  float angularIntensity = mix(PI, 0.0, intensity * 0.1);
  ncoord *= rot(time * 50.0 + angle);
  float angularCorrection = pie(ncoord, angularIntensity, clamp(gradientFade * dist, 0.05, 1.0), beamLength);
  finalColor = color * brightnessPulse * colorationAlpha * angularCorrection;
  ${this.COLORATION_TECHNIQUES}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
`defaultUniforms` adds `ratio: 0, brightnessPulse: 1, angle: 0, gradientFade: 0.15, beamLength: 1` (siren-light.mjs:36-43). Note the rotation rate is `time * 50.0` — much faster than Revolving's bare `time` — and `gradientFade` is applied as `gradientFade * dist` (distance-scaled) here, vs. Revolving's flat `gradientFade`.

*Illumination* (`effects/siren-light.mjs:51-85`) — toolkit: `PERCEIVED_BRIGHTNESS`, `PIE`, `ROTATION`.
```glsl
uniform float gradientFade;
uniform float beamLength;

void main() {
  ${this.FRAGMENT_BEGIN}
  ${this.TRANSITION}
  vec2 ncoord = vUvs * 2.0 - 1.0;
  float angularIntensity = mix(PI, 0.0, intensity * 0.1);
  ncoord *= rot(time * 50.0 + angle);
  float angularCorrection = mix(1.0, pie(ncoord, angularIntensity, clamp(gradientFade * dist, 0.05, 1.0), beamLength), 0.5);
  finalColor *= angularCorrection;
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
`defaultUniforms` adds `angle: 0, gradientFade: 0.45, beamLength: 1` (siren-light.mjs:79-84) — note illumination's own `gradientFade` default (`0.45`) differs from coloration's (`0.15`); these are two independently-configured uniforms on two separate shader instances despite sharing a name, not a shared value. Also note illumination's `angularCorrection` is **half-strength** (`mix(1.0, pie(...), 0.5)` — blends 50/50 with "no beam at all"), so the illumination beam is always a softer wash than the coloration beam even at identical angular math.

**MSA port:** illumination — insert the `angularCorrection` multiply between `TRANSITION`'s result and `EXPOSURE`, reusing `uRatio`-driven switchColor unchanged underneath, plus the CPU-jittered `ratio`/`brightnessPulse` from `animateTorch` (same driver as Torch/Flame — this needs those two uniforms wired regardless of the beam). Coloration — same pattern as Revolving, plus the `brightnessPulse` multiply. Same open `angle`-uniform question as Revolving.

---

### `pulse` — Pulse
**Demonstrates:** a plain radial breathing pulse, cosine-driven entirely on the CPU (`animatePulse`, §1.3) — the shader side barely does anything beyond consuming `pulse`/`ratio`. **Illumination skips `${this.ADJUSTMENTS}` entirely** — the one animation, of all 27, whose illumination channel is immune to the light's contrast/saturation/shadow/exposure sliders.

*Illumination* (`effects/pulse.mjs:7-24`) — toolkit: `PERCEIVED_BRIGHTNESS`.
```glsl
void main() {
  ${this.FRAGMENT_BEGIN}
  float fading = pow(abs(1.0 - dist * dist), 1.01 - ratio);
  ${this.TRANSITION}
  finalColor *= fading;
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
Note: **no `${this.ADJUSTMENTS}` call** — confirmed by direct comparison against every other illumination body in this doc, all of which include it.

*Coloration* (`effects/pulse.mjs:31-55`) — toolkit: `PERCEIVED_BRIGHTNESS`.
```glsl
float pfade(in float dist, in float pulse) {
    return 1.0 - smoothstep(pulse * 0.5, 1.0, dist);
}

void main() {
  ${this.FRAGMENT_BEGIN}
  finalColor = color * pfade(dist, pulse) * colorationAlpha;
  ${this.COLORATION_TECHNIQUES}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
(Coloration *does* include `ADJUSTMENTS` — only the illumination twin skips it.) `defaultUniforms` adds `pulse: 0` (pulse.mjs:54).

**MSA port:** illumination — a genuinely different assembly order than every other animated illumination material: `fading` computed from `dist`/`ratio` BEFORE the switchColor-equivalent runs, then multiplied in, then **no** exposure/saturation/shadow stage, straight to falloff. If porting via a shared "insert here" hook point in `point-light-illumination.js`, this one needs the hook to also suppress the EXPOSURE block, not just add a term. Coloration — standard seed-replacement pattern, needs a `uPulse` uniform (CPU-fed from `animatePulse`'s cosine-wave formula).

---

### `reactivepulse` — Reactive Pulse
**Demonstrates:** identical shaders to `pulse` (same `PulseIlluminationShader`/`PulseColorationShader` classes, §1.4) — the only difference is the CPU driver, `animateSoundPulse` (§1.3), which feeds `pulse`/`ratio` from live audio bands instead of a cosine wave, and **never writes `u.time`**. Fragment bodies: identical to `pulse` above, not re-quoted.

**MSA port:** same shader as `pulse` — the only new work is the CPU-side audio-reactive driver (Web Audio `AnalyserNode` bass/mid/treble band extraction + the `^1.5` power curve + the `intensity`-blended crossfade + the `1-exp(-speed·dt·0.085)` exponential smoothing, §1.3). No new GLSL/TSL beyond what `pulse` already needs.

---

### `chroma` — Chroma
**Demonstrates:** a straightforward hue-cycling coloration, `HSB2RGB`-driven. Simplest coloration-only animation in the set (no fbm/noise/prng at all).

*Coloration* (`effects/chroma.mjs:6-29`) — toolkit: `HSB2RGB`, `PERCEIVED_BRIGHTNESS`. `forceDefaultColor = true`.
```glsl
void main() {
  ${this.FRAGMENT_BEGIN}
  finalColor = mix( color,
                    hsb2rgb(vec3(time * 0.25, 1.0, 1.0)),
                    intensity * 0.1 ) * colorationAlpha;
  ${this.COLORATION_TECHNIQUES}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
Standard order (`FRAGMENT_BEGIN → finalColor(hue mix) → COLORATION_TECHNIQUES → ADJUSTMENTS → FALLOFF → FRAGMENT_END`), single `FALLOFF` call. `intensity*0.1` (`∈[0,1]` for the `[0,10]` slider) is a **linear blend weight** between the light's own `color` and the cycling hue — at `intensity=0` Chroma renders as a plain static-coloured light (technique still applies afterward).

**MSA port:** replace the coloration seed line with `mix(uLightColor, hsb2rgbTsl(vec3(uTime.mul(0.25), 1, 1)), uIntensity.mul(0.1))`, still `.mul(uColorationAlpha)`, still followed by `.mul(reflection)`. `HSB2RGB` has no existing MSA equivalent — needs a fresh `Fn()`, trivial to port (4 lines, no loops, no branches beyond `clamp`/`abs`/`mod`).

---

### `wave` — Wave
**Demonstrates:** a simple radial sine-ring pulse, both channels, no fbm/noise.

*Illumination* (`effects/wave.mjs:7-29`) — toolkit: `PERCEIVED_BRIGHTNESS`.
```glsl
float wave(in float dist) {
  float sinWave = 0.5 * (sin(-time * 6.0 + dist * 10.0 * intensity) + 1.0);
  return 0.3 * sinWave + 0.8;
}

void main() {
  ${this.FRAGMENT_BEGIN}
  ${this.TRANSITION}
  finalColor *= wave(dist);
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
Output range of the multiplier: `[0.8, 1.1]` (a gentle ±15%-ish pulse around 1).

*Coloration* (`effects/wave.mjs:36-58`) — toolkit: `PERCEIVED_BRIGHTNESS`.
```glsl
float wave(in float dist) {
  float sinWave = 0.5 * (sin(-time * 6.0 + dist * 10.0 * intensity) + 1.0);
  return 0.55 * sinWave + 0.8;
}

void main() {
  ${this.FRAGMENT_BEGIN}
  finalColor = color * wave(dist) * colorationAlpha;
  ${this.COLORATION_TECHNIQUES}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
Coloration's `wave()` uses coefficient `0.55` (not illumination's `0.3`) — output range `[0.8, 1.35]`, a stronger pulse. **The two `wave()` functions are near-identical but genuinely different constants** — a port that shares one function between channels needs a coefficient parameter, not a single hardcoded copy.

**MSA port:** both channels need a small `wave(dist)` `Fn()` (pure arithmetic, no loop, trivial). Illumination inserts `.mul(waveIll(dist))` before `EXPOSURE`; coloration replaces the seed with `uLightColor.mul(waveCol(dist)).mul(uColorationAlpha)`, still `.mul(reflection)` after.

---

### `fog` — Fog
**Demonstrates:** drifting FBM-warped colour-palette fog, coloration-only, the first of several "palette + domain-warp" animations in this set (compare `light-dome`, `vortex`'s coloration — same structural idea: a hand-built ramp of `color`-derived swatches mixed by two layers of fbm-warp).

*Coloration* (`effects/fog.mjs:6-57`) — toolkit: `PRNG`, `NOISE`, `FBM(4,1.0)`, `PERCEIVED_BRIGHTNESS`. `forceDefaultColor = true`.
```glsl
vec3 fog() {
  // constructing the palette
  vec3 c1 = color * 0.60;
  vec3 c2 = color * 0.95;
  vec3 c3 = color * 0.50;
  vec3 c4 = color * 0.75;
  vec3 c5 = vec3(0.3);
  vec3 c6 = color;

  // creating the deformation
  vec2 uv = vUvs;
  vec2 p = uv.xy * 8.0;

  // time motion fbm and palette mixing
  float q = fbm(p - time * 0.1);
  vec2 r = vec2(fbm(p + q - time * 0.5 - p.x - p.y),
                fbm(p + q - time * 0.3));
  vec3 c = clamp(mix(c1,
                     c2,
                     fbm(p + r)) + mix(c3, c4, r.x)
                                 - mix(c5, c6, r.y),
                                   vec3(0.0), vec3(1.0));
  return c;
}

void main() {
  ${this.FRAGMENT_BEGIN}
  float intens = intensity * 0.2;
  finalColor = fog() * intens * colorationAlpha;
  ${this.COLORATION_TECHNIQUES}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
This "domain-warped palette" pattern (`q = fbm(p - t)`, `r = vec2(fbm(p+q-...), fbm(p+q-...))`, final `mix` chain against a `color`-derived swatch set) is the classic Inigo-Quilez-style FBM palette technique — recurs, with different constants, in `light-dome` and `vortex`'s coloration below; worth building **one** generic TSL helper (`domainWarpPalette(uv, time, swatches[6])`) rather than three near-duplicate ports.

**MSA port:** entirely new coloration seed (`fog()`), 3 fbm calls per pixel (`q`, `r.x`, `r.y`, plus the final `fbm(p+r)` — 4 total). Needs `FBM`'s `Loop`-wrapped TSL equivalent (§5) at 4 octaves.

---

### `sunburst` — Sunburst
**Demonstrates:** angular ray-burst (the `fract(angle*16+time)` beam pattern also seen conceptually in `emanation`/`revolving`, but radial-ray-count-based here rather than wedge-based) plus a central pulsing core. **The one illumination body in this set that runs `${this.ADJUSTMENTS}` *before* its animated multiply — every other illumination animation with both a multiply and ADJUSTMENTS does the multiply first.**

*Illumination* (`effects/sunburst.mjs:7-50`) — toolkit: `PERCEIVED_BRIGHTNESS`.
```glsl
float cosTime(in float a, in float b) {
  return (a - b) * ((cos(time) + 1.0) * 0.5) + b;
}

vec3 sunBurst(in vec3 color, in vec2 uv, in float dist) {
  float intensityMod = 1.0 + (intensity * 0.05);
  float lpulse = cosTime(1.3 * intensityMod, 0.85 * intensityMod);
  float angle = atan(uv.x, uv.y) * INVTWOPI;
  float beam = fract(angle * 16.0 + time);
  float light = lpulse * pow(abs(1.0 - dist), 0.65);
  float sunburst = max(light, max(beam, 1.0 - beam));
  return color * pow(sunburst, 3.0);
}

void main() {
  ${this.FRAGMENT_BEGIN}
  vec2 uv = (2.0 * vUvs) - 1.0;
  finalColor = switchColor(computedBrightColor, computedDimColor, dist);
  ${this.ADJUSTMENTS}
  finalColor = sunBurst(finalColor, uv, dist);
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
Note `finalColor = switchColor(computedBrightColor, computedDimColor, dist);` is the `${this.TRANSITION}` macro's exact text, inlined by hand rather than referencing the macro — functionally identical either way, but the **order is real**: `ADJUSTMENTS` (saturation/exposure/shadow) applies to the plain bright/dim value, then `sunBurst()` multiplies the ray pattern in *afterward*. A mechanical "insert the animated line where `${TRANSITION}` normally sits, before ADJUSTMENTS" port template — the pattern every other illumination animation in this set follows — would get Sunburst's visual result subtly wrong (adjustments would apply to the rayed result instead of the plain transition result).

*Coloration* (`effects/sunburst.mjs:55-98`) — toolkit: `PERCEIVED_BRIGHTNESS`. Standard order here (unlike its illumination twin):
```glsl
float cosTime(in float a, in float b) {
  return (a - b) * ((cos(time) + 1.0) * 0.5) + b;
}

vec3 sunBurst(in vec2 uv, in float dist) {
  float intensityMod = 1.0 + (intensity * 0.05);
  float lpulse = cosTime(1.1 * intensityMod, 0.85 * intensityMod);
  float angle = atan(uv.x, uv.y) * INVTWOPI;
  float beam = fract(angle * 16.0 + time);
  float light = lpulse * pow(abs(1.0 - dist), 0.65);
  float sunburst = max(light, max(beam, 1.0 - beam));
  return color * pow(sunburst, 3.0);
}

void main() {
  ${this.FRAGMENT_BEGIN}
  vec2 uvs = (2.0 * vUvs) - 1.0;
  finalColor = sunBurst(uvs, dist) * colorationAlpha;
  ${this.COLORATION_TECHNIQUES}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
Note the illumination and coloration `sunBurst()` functions are near-identical but not byte-identical: illumination's `cosTime(1.3*intensityMod, ...)` vs coloration's `cosTime(1.1*intensityMod, ...)`, and coloration's takes `color` as an external uniform rather than a parameter (illumination's takes the already-transitioned colour as its first arg since it needs to multiply the ray pattern onto the bright/dim result, not the raw light colour).

**MSA port:** illumination needs a genuinely different insertion point than the "standard" template (ADJUSTMENTS before the animated term, not after) — flag this explicitly in whatever shared builder function/parameter scheme replaces Foundry's string-concatenation scaffold, so it doesn't get silently normalized to the common order. Coloration follows the standard pattern.

---

### `dome` — Light Dome
**Demonstrates:** a hemispherized (`(1-sqrt(1-dist))/dist` fisheye remap), rotating, FBM-palette ripple pattern — coloration only. Second occurrence of the "domain-warped palette" technique (compare `fog` above).

*Coloration* (`effects/light-dome.mjs:6-61`) — toolkit: `PRNG`, `NOISE`, `FBM(2)` (2 octaves, default amp 1.0), `PERCEIVED_BRIGHTNESS`. `forceDefaultColor = true`.
```glsl
vec2 transform(in vec2 uv, in float dist) {
  float hspherize = (1.0 - sqrt(1.0 - dist)) / dist;
  float t = time * 0.02;
  mat2 rotmat = mat2(cos(t), -sin(t), sin(t), cos(t));
  mat2 scalemat = mat2(8.0 * intensity, 0.0, 0.0, 8.0 * intensity);
  uv -= PIVOT;
  uv *= rotmat * scalemat * hspherize;
  uv += PIVOT;
  return uv;
}

vec3 ripples(in vec2 uv) {
  vec3 c1 = color * 0.550;
  vec3 c2 = color * 0.020;
  vec3 c3 = color * 0.3;
  vec3 c4 = color;
  vec3 c5 = color * 0.025;
  vec3 c6 = color * 0.200;

  vec2 p = uv + vec2(5.0);
  float q = 2.0 * fbm(p + time * 0.2);
  vec2 r = vec2(fbm(p + q + ( time  ) - p.x - p.y), fbm(p * 2.0 + ( time )));

  return clamp( mix( c1, c2, abs(fbm(p + r)) ) + mix( c3, c4, abs(r.x * r.x * r.x) ) - mix( c5, c6, abs(r.y * r.y)), vec3(0.0), vec3(1.0));
}

void main() {
  ${this.FRAGMENT_BEGIN}
  vec2 uv = transform(vUvs, dist);
  finalColor = ripples(uv) * pow(1.0 - dist, 0.25) * colorationAlpha;
  ${this.COLORATION_TECHNIQUES}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
The `hspherize = (1-sqrt(1-dist))/dist` remap recurs verbatim in `force-grid` and `hexa-dome` below — a shared "make the radial falloff read as a dome/hemisphere" trick, worth its own named TSL helper.

**MSA port:** new coloration seed; needs the `hspherize` helper (trivial, no loop) + `FBM(2)` (2-octave `Loop`) × 3 call sites.

---

### `emanation` — Emanation
**Demonstrates:** radiating angular beams via `atan`-based angle + `fract`, no fbm at all — the simplest of the three angular-beam animations (compare `revolving`'s wedge-based `PIE` and `black-hole`'s fbm-warped version of the same idea).

*Coloration* (`effects/emanation.mjs:6-42`) — toolkit: `PERCEIVED_BRIGHTNESS`. `forceDefaultColor = true`.
```glsl
vec3 beamsEmanation(in vec2 uv, in float dist) {
  float angle = atan(uv.x, uv.y) * INVTWOPI;
  float beams = fract( angle * intensity + sin(dist * 10.0 - time));
  beams = max(beams, 1.0 - beams);
  return smoothstep( 0.0, 1.0, beams * color);
}

void main() {
  ${this.FRAGMENT_BEGIN}
  vec2 uvs = (2.0 * vUvs) - 1.0;
  finalColor = beamsEmanation(uvs, dist) * colorationAlpha;
  ${this.COLORATION_TECHNIQUES}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
`intensity` here directly sets **beam count** (not a 0-1 blend weight like most other animations' use of `intensity`) — `angle * intensity` means higher intensity literally packs more beam cycles around the circle. `beams = max(beams, 1-beams)` is the standard "mirror a sawtooth into a symmetric triangle wave" trick used by every angular-beam animation in this set (also in `black-hole`, `sunburst`) — worth one shared helper.

**MSA port:** trivial, no loops — `atan`, `fract`, `sin`, `smoothstep` only. Good first animation to port as a smoke-test of the "replace the seed line" pattern before tackling the fbm-heavy ones.

---

### `hexa` — Hexa Dome
**Demonstrates:** a hex-grid tiling pattern (adapted classic hex-distance-field algorithm), hemispherized/rotated like `dome`. No fbm/noise/prng — purely analytic.

*Coloration* (`effects/hexa-dome.mjs:6-87`) — toolkit: `PERCEIVED_BRIGHTNESS` only. `forceDefaultColor = true`.
```glsl
vec2 transform(in vec2 uv, in float dist) {
  float hspherize = (1.0 - sqrt(1.0 - dist)) / dist;
  float t = -time * 0.20;
  float scale = 10.0 / (11.0 - intensity);
  float cost = cos(t);
  float sint = sin(t);

  mat2 rotmat = mat2(cost, -sint, sint, cost);
  mat2 scalemat = mat2(scale, 0.0, 0.0, scale);
  uv -= PIVOT;
  uv *= rotmat * scalemat * hspherize;
  uv += PIVOT;
  return uv;
}

float hexDist(in vec2 uv) {
  vec2 p = abs(uv);
  float c = dot(p, normalize(vec2(1.0, 1.73)));
  c = max(c, p.x);
  return c;
}

vec4 hexUvs(in vec2 uv) {
  const vec2 r = vec2(1.0, 1.73);
  const vec2 h = r*0.5;

  vec2 a = mod(uv, r) - h;
  vec2 b = mod(uv - h, r) - h;
  vec2 gv = dot(a, a) < dot(b,b) ? a : b;

  float x = atan(gv.x, gv.y);
  float y = 0.55 - hexDist(gv);
  vec2 id = uv - gv;
  return vec4(x, y, id.x, id.y);
}

vec3 hexa(in vec2 uv) {
  float t = time;
  vec2 uv1 = uv + vec2(0.0, sin(uv.y) * 0.25);
  vec2 uv2 = 0.5 * uv1 + 0.5 * uv + vec2(0.55, 0);
  float a = 0.2;
  float c = 0.5;
  float s = -1.0;
  uv2 *= mat2(c, -s, s, c);

  vec3 col = color;
  float hexy = hexUvs(uv2 * 10.0).y;
  float hexa = smoothstep( 3.0 * (cos(t)) + 4.5, 12.0, hexy * 20.0) * 3.0;

  col *= mix(hexa, 1.0 - hexa, min(hexy, 1.0 - hexy));
  col += color * fract(smoothstep(1.0, 2.0, hexy * 20.0)) * 0.65;
  return col;
}

void main() {
  ${this.FRAGMENT_BEGIN}
  vec2 uv = transform(vUvs, dist);
  finalColor = hexa(uv) * pow(1.0 - dist, 0.18) * colorationAlpha;
  ${this.COLORATION_TECHNIQUES}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
`hexUvs` uses GLSL's ternary (`? :`) operator on a `vec2` condition (`dot(a,a) < dot(b,b) ? a : b`) — a plain scalar-boolean ternary, no TSL translation surprise expected (TSL's `select()` is the function-form equivalent).

**MSA port:** entirely analytic, no loops — straightforward `Fn()` translation once `hspherize` (shared with `dome`) exists. `mat2(c,-s,s,c)` 2D-rotation-matrix construction recurs across many animations — worth one shared `rotMat2(angle)` TSL helper alongside the toolkit's own `ROTATION`/`rot()`.

---

### `ghost` — Ghost Light
**Demonstrates:** a wandering, fbm-distorted glow — both channels, no fixed shape (unlike the angular/hex/dome animations, this one just warps a soft blob).

*Illumination* (`effects/ghost-light.mjs:7-43`) — toolkit: `PERCEIVED_BRIGHTNESS`, `PRNG`, `NOISE`, `FBM(3,1.0)`.
```glsl
void main() {
  ${this.FRAGMENT_BEGIN}
  float distortion1 = fbm(vec2(
                      fbm(vUvs * 5.0 - time * 0.50),
                      fbm((-vUvs - vec2(0.01)) * 5.0 + time * INVTHREE)));

  float distortion2 = fbm(vec2(
                      fbm(-vUvs * 5.0 - time * 0.50),
                      fbm((-vUvs + vec2(0.01)) * 5.0 + time * INVTHREE)));
  vec2 uv = vUvs;

  float t = time * 0.5;
  float tcos = 0.5 * (0.5 * (cos(t)+1.0)) + 0.25;

  ${this.TRANSITION}
  finalColor *= mix( distortion1 * 1.5 * (intensity * 0.2),
                     distortion2 * 1.5 * (intensity * 0.2), tcos);
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```

*Coloration* (`effects/ghost-light.mjs:50-97`) — toolkit: `PRNG`, `NOISE`, `FBM(3,1.0)`, `PERCEIVED_BRIGHTNESS`.
```glsl
void main() {
  ${this.FRAGMENT_BEGIN}
  float distortion1 = fbm(vec2(
                      fbm(vUvs * 3.0 + time * 0.50),
                      fbm((-vUvs + vec2(1.)) * 5.0 + time * INVTHREE)));

  float distortion2 = fbm(vec2(
                      fbm(-vUvs * 3.0 + time * 0.50),
                      fbm((-vUvs + vec2(1.)) * 5.0 - time * INVTHREE)));
  vec2 uv = vUvs;

  float t = time * 0.5;
  float tcos = 0.5 * (0.5 * (cos(t)+1.0)) + 0.25;
  float tsin = 0.5 * (0.5 * (sin(t)+1.0)) + 0.25;

  uv -= PIVOT;
  uv *= tcos * distortion1;
  uv *= tsin * distortion2;
  uv *= fbm(vec2(time + distortion1, time + distortion2));
  uv += PIVOT;

  finalColor = distortion1 * distortion1 *
               distortion2 * distortion2 *
               color * pow(1.0 - dist, dist)
               * colorationAlpha * mix( uv.x + distortion1 * 4.5 * (intensity * 0.2),
                                        uv.y + distortion2 * 4.5 * (intensity * 0.2), tcos);
  ${this.COLORATION_TECHNIQUES}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
Note illumination and coloration use **different `fbm` domain-warp constants** for `distortion1`/`distortion2` (illumination: `×5.0`/`-time*0.5`; coloration: `×3.0`/`+time*0.5`) — despite the near-identical code shape, they're independently tuned, not shared logic factored into one function. Coloration's `uv` variable is computed but its `x`/`y` components only feed the final `mix(...)` term — worth double-checking against a live render when porting since `uv` is mutated through 4 sequential `*=`/`+=` steps that are easy to mis-transcribe. `fbm` is called **7 times per pixel** in coloration alone (2× for `distortion1`, 2× for `distortion2`, 1× for the final `uv` scale term = 5, plus each outer `fbm(vec2(inner_fbm, inner_fbm))` counts its two inner calls — total nested calls: `distortion1`=2 inner+1 outer=3, `distortion2`=3, final uv-scale fbm=1 → 7) — one of the more expensive animations in the set.

**MSA port:** straightforward but call-count-heavy `FBM(3,1.0)` port (3-octave `Loop`), 7 calls/pixel for coloration, 6 for illumination (same structure minus the final uv-scale fbm). Both channels: insert before `EXPOSURE`(ill)/keep technique after(col), standard hook points.

---

### `energy` — Energy Field
**Demonstrates:** a 3D Worley/cellular ("voronoi") sphere, hemispherized, coloration-only. **Does not use the shared toolkit `VORONOI` primitive** — hand-rolls its own classic 3×3×3 3D-voronoi search using `PRNG3D`.

*Coloration* (`effects/energy-field.mjs:6-81`) — toolkit: `PRNG3D`, `PERCEIVED_BRIGHTNESS` (explicitly **not** the shared `VORONOI` block — see §2's note). `forceDefaultColor = true`.
```glsl
// classic 3d voronoi (with some bug fixes)
vec3 voronoi3d(const in vec3 x) {
  vec3 p = floor(x);
  vec3 f = fract(x);

  float id = 0.0;
  vec2 res = vec2(100.0);

  for (int k = -1; k <= 1; k++) {
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec3 b = vec3(float(i), float(j), float(k));
        vec3 r = vec3(b) - f + random(p + b);

        float d = dot(r, r);
        float cond = max(sign(res.x - d), 0.0);
        float nCond = 1.0 - cond;
        float cond2 = nCond * max(sign(res.y - d), 0.0);
        float nCond2 = 1.0 - cond2;

        id = (dot(p + b, vec3(1.0, 67.0, 142.0)) * cond) + (id * nCond);
        res = vec2(d, res.x) * cond + res * nCond;

        res.y = cond2 * d + nCond2 * res.y;
      }
    }
  }
  // replaced abs(id) by pow( abs(id + 10.0), 0.01)
  // needed to remove artifacts in some specific configuration
  return vec3( sqrt(res), pow( abs(id + 10.0), 0.01) );
}

void main() {
  ${this.FRAGMENT_BEGIN}
  vec2 uv = vUvs;

  float f = (1.0 - sqrt(1.0 - dist)) / dist;
  uv -= vec2(0.5);
  uv *= f * 4.0 * intensity;
  uv += vec2(0.5);

  float t = time * 0.4;
  float uvx = cos(uv.x - t);
  float uvy = cos(uv.y + t);
  float uvxt = cos(uv.x + sin(t));
  float uvyt = sin(uv.y + cos(t));

  vec3 c = voronoi3d(vec3(uv.x - uvx + uvyt,
                          mix(uv.x, uv.y, 0.5) + uvxt - uvyt + uvx,
                          uv.y + uvxt - uvx));

  finalColor = c.x * c.x * c.x * color * colorationAlpha;

  ${this.COLORATION_TECHNIQUES}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
The `max(sign(...), 0.0)`/`cond`/`nCond` branchless-min pattern is a deliberate GPU-friendly way to track "closest" and "second-closest" cell distances without an `if`; note the comment at the return line ("bug fixes... artifacts") — this is Foundry's own author acknowledging a numerical workaround, not something to "clean up" during a port; keep `pow(abs(id+10.0), 0.01)` exactly, don't simplify it to `abs(id)`.

**MSA port:** the highest structural-complexity animation in the set — a 27-iteration (3×3×3) triple-nested loop per pixel. Per `point-light-illumination.js`'s own established precedent (`makeSdPolygonEdgeDistance`'s single `Loop`), this needs either three nested `Loop`s or one flattened 27-iteration `Loop` with `i/9`, `(i/3)%3`, `i%3` index decomposition — flatten it; TSL's `Loop` is verified in-project to work for loop-carried mutable state (`.toVar()`/`.assign()`) but nested `Loop`s specifically haven't been proven in this codebase yet (only `point-light-illumination.js`'s single-level polygon-edge loop is proven), so flattening to one loop is the lower-risk port path. `PRNG3D`'s `random(vec3)` is a new, trivial (no-loop) `Fn()`.

---

### `vortex` — Vortex
**Demonstrates:** an FBM-palette swirl (third occurrence of the domain-warp-palette technique) with an actual pixel-space vortex-twist pre-warp. **Its illumination shader is the most significant dead-code finding in this entire audit — see below.**

*Coloration* (`effects/vortex.mjs:7-91`) — toolkit: `PRNG`, `NOISE`, `FBM(4,1.0)`, `PERCEIVED_BRIGHTNESS`. `forceDefaultColor = true`.
```glsl
vec2 vortex(in vec2 uv, in float dist, in float radius, in mat2 rotmat) {
  float intens = intensity * 0.2;
  vec2 uvs = uv - PIVOT;
  uv *= rotmat;

  if ( dist < radius ) {
    float sigma = (radius - dist) / radius;
    float theta = sigma * sigma * TWOPI * intens;
    float st = sin(theta);
    float ct = cos(theta);
    uvs = vec2(dot(uvs, vec2(ct, -st)), dot(uvs, vec2(st, ct)));
  }
  uvs += PIVOT;
  return uvs;
}

vec3 spice(in vec2 iuv, in mat2 rotmat) {
  vec3 c1 = color * 0.55;
  vec3 c2 = color * 0.95;
  vec3 c3 = color * 0.45;
  vec3 c4 = color * 0.75;
  vec3 c5 = vec3(0.20);
  vec3 c6 = color * 1.2;

  vec2 uv = iuv;
  uv -= PIVOT;
  uv *= rotmat;
  vec2 p = uv.xy * 6.0;
  uv += PIVOT;

  float q = fbm(p + time);
  vec2 r = vec2(fbm(p + q + time * 0.9 - p.x - p.y),
                fbm(p + q + time * 0.6));
  vec3 c = mix(c1,
               c2,
               fbm(p + r)) + mix(c3, c4, r.x)
                           - mix(c5, c6, r.y);
  return c;
}

void main() {
  ${this.FRAGMENT_BEGIN}

  float t = time * 0.5;
  float cost = cos(t);
  float sint = sin(t);

  mat2 vortexRotMat = mat2(cost, -sint, sint, cost);
  mat2 spiceRotMat = mat2(cost * 2.0, -sint * 2.0, sint * 2.0, cost * 2.0);

  vec2 vuv = vortex(vUvs, dist, 1.0, vortexRotMat);

  finalColor = spice(vuv, spiceRotMat) * colorationAlpha;
  ${this.COLORATION_TECHNIQUES}
  ${this.ADJUSTMENTS}

  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```

*Illumination* (`effects/vortex.mjs:97-163`) — **defines but never calls its helper functions**:
```glsl
vec2 vortex(in vec2 uv, in float dist, in float radius, in float angle, in mat2 rotmat) {
  vec2 uvs = uv - PIVOT;
  uv *= rotmat;

  if ( dist < radius ) {
    float sigma = (radius - dist) / radius;
    float theta = sigma * sigma * angle;
    float st = sin(theta);
    float ct = cos(theta);
    uvs = vec2(dot(uvs, vec2(ct, -st)), dot(uvs, vec2(st, ct)));
  }
  uvs += PIVOT;
  return uvs;
}

vec3 spice(in vec2 iuv, in mat2 rotmat) {
  vec3 c1 = vec3(0.20);
  vec3 c2 = vec3(0.80);
  vec3 c3 = vec3(0.15);
  vec3 c4 = vec3(0.85);
  vec3 c5 = c3;
  vec3 c6 = vec3(0.9);

  vec2 uv = iuv;
  uv -= PIVOT;
  uv *= rotmat;
  vec2 p = uv.xy * 6.0;
  uv += PIVOT;

  float q = fbm(p + time);
  vec2 r = vec2(fbm(p + q + time * 0.9 - p.x - p.y), fbm(p + q + time * 0.6));

  return mix(c1, c2, fbm(p + r)) + mix(c3, c4, r.x) - mix(c5, c6, r.y);
}

vec3 convertToDarknessColors(in vec3 col, in float dist) {
  float intens = intensity * 0.20;
  float lum = (col.r * 2.0 + col.g * 3.0 + col.b) * 0.5 * INVTHREE;
  float colorMod = smoothstep(ratio * 0.99, ratio * 1.01, dist);
  return mix(computedDimColor, computedBrightColor * colorMod, 1.0 - smoothstep( 0.80, 1.00, lum)) *
              smoothstep( 0.25 * intens, 0.85 * intens, lum);
}

void main() {
  ${this.FRAGMENT_BEGIN}
  ${this.TRANSITION}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
**Flagged finding, the most significant in this doc: `VortexIlluminationShader.main()` is byte-for-byte the unmodified default illumination scaffold** (§3.4) — `FRAGMENT_BEGIN → TRANSITION → ADJUSTMENTS → FALLOFF → FRAGMENT_END`, nothing else. The three helper functions declared above it — `vortex(vec2,float,float,float,mat2)`, `spice(vec2,mat2)`, and `convertToDarknessColors(vec3,float)` (this last one's very name/signature suggests it was written for a coloration-under-darkness use case that doesn't exist in the current architecture — darkness sources have their own separate, unrelated shader family entirely, §3.3) — are **compiled into the shader program but never invoked from `main()`**. This is confirmed dead code in Foundry v14's shipped source, not a porting gap: **`vortex`'s illumination channel does not animate at all**; it behaves exactly like an unanimated light's illumination channel, full stop. Contrast this with `torch`'s illumination (also textually close to the default scaffold, §4's `torch` entry) — Torch's case is different in kind: Torch's illumination *does* animate, entirely via the CPU-jittered `ratio` uniform that the (unmodified) `TRANSITION` macro consumes; Vortex's `ratio` is never touched by `animateTime` (§1.3 — `animateTime` only ever writes `u.time`/`u.intensity`), so there is no hidden CPU-side animation either. **Recommendation for the port: implement `vortex`'s illumination channel as a plain, unanimated `AdaptiveIlluminationShader` instance — do not port the dead `vortex()`/`spice()`/`convertToDarknessColors()` functions at all**, unless the porting team specifically wants to *improve* on Foundry here (a legitimate Type-B, MSA-native option — see the project's own two-light-type doctrine — since this is clearly unfinished/abandoned functionality in the source, not an intentional design).

**MSA port:** coloration — standard palette-swirl seed replacement (shares the domain-warp-palette pattern with `fog`/`dome`, plus its own pre-warp `vortex()` twist function, a genuine `if (dist<radius)` branch — TSL's function-form `select()`/conditional node, not a GLSL `if`). Illumination — **do nothing beyond the existing unanimated default** (see finding above).

---

### `witchwave` — Bewitching Wave
**Demonstrates:** an FBM-distorted version of the plain sine-ring pulse (`wave`'s more elaborate sibling) — both channels, same `bwave()` shape function with different coefficients per channel (matching `wave`'s own illumination/coloration coefficient split).

*Illumination* (`effects/bewitching-wave.mjs:7-46`) — toolkit: `PRNG`, `NOISE`, `FBM(4,1.0)`, `PERCEIVED_BRIGHTNESS`.
```glsl
vec2 transform(in vec2 uv, in float dist) {
  float t = time * 0.25;
  mat2 rotmat = mat2(cos(t), -sin(t), sin(t), cos(t));
  mat2 scalemat = mat2(2.5, 0.0, 0.0, 2.5);
  uv -= vec2(0.5);
  uv *= rotmat * scalemat;
  uv += vec2(0.5);
  return uv;
}

float bwave(in float dist) {
  vec2 uv = transform(vUvs, dist);
  float motion = fbm(uv + time * 0.25);
  float distortion = mix(1.0, motion, clamp(1.0 - dist, 0.0, 1.0));
  float sinWave = 0.5 * (sin(-time * 6.0 + dist * 10.0 * intensity * distortion) + 1.0);
  return 0.3 * sinWave + 0.8;
}

void main() {
  ${this.FRAGMENT_BEGIN}
  ${this.TRANSITION}
  finalColor *= bwave(dist);
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```

*Coloration* (`effects/bewitching-wave.mjs:53-92`) — same toolkit set. `bwave()`'s final line uses `0.55` (matching `wave`'s own illumination-`0.3`/coloration-`0.55` split exactly):
```glsl
float bwave(in float dist) {
  vec2 uv = transform(vUvs, dist);
  float motion = fbm(uv + time * 0.25);
  float distortion = mix(1.0, motion, clamp(1.0 - dist, 0.0, 1.0));
  float sinWave = 0.5 * (sin(-time * 6.0 + dist * 10.0 * intensity * distortion) + 1.0);
  return 0.55 * sinWave + 0.8;
}

void main() {
  ${this.FRAGMENT_BEGIN}
  finalColor = color * bwave(dist) * colorationAlpha;
  ${this.COLORATION_TECHNIQUES}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
Effectively `wave` plus one extra `fbm`-driven `distortion` term modulating the sine's phase — the two animations are directly comparable, and a port could reasonably build `witchwave` as `wave` + a distortion multiply rather than as a fully separate implementation.

**MSA port:** needs `FBM(4,1.0)` (4-octave `Loop`), one call per pixel per channel. Standard hook points both channels.

---

### `rainbowswirl` — Swirling Rainbow
**Demonstrates:** a polar-coordinate rainbow (angle+radius → hue), coloration-only. **Skips the `colorationAlpha` multiply** — one of only two animations in the set that do (see `radialrainbow` below, nearly identical code).

*Coloration* (`effects/swirling-rainbow.mjs:6-33`) — toolkit: `HSB2RGB`, `PERCEIVED_BRIGHTNESS`. `forceDefaultColor = true`.
```glsl
void main() {
  ${this.FRAGMENT_BEGIN}

  float intens = intensity * 0.1;
  vec2 nuv = vUvs * 2.0 - 1.0;
  vec2 puv = vec2(atan(nuv.x, nuv.y) * INVTWOPI + 0.5, length(nuv));
  vec3 rainbow = hsb2rgb(vec3(puv.x + puv.y - time * 0.2, 1.0, 1.0));
  finalColor = mix(color, rainbow, smoothstep(0.0, 1.5 - intens, dist))
                   * (1.0 - dist * dist * dist);
  ${this.COLORATION_TECHNIQUES}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
**Flagged finding: no `* colorationAlpha` anywhere in the `finalColor` line.** Confirmed by direct re-inspection — every other coloration animation in this set multiplies its seed by `colorationAlpha` (`base-lighting.mjs`'s per-technique alpha remap, base audit §6); this one and `radialrainbow` do not, meaning the LightData `alpha` slider has **zero effect** on SwirlingRainbow's/RadialRainbow's brightness (though `alpha` still affects `useSampler`'s technique gating elsewhere and, of course, the illumination channel independently). This is either a deliberate design choice (a rainbow effect that always reads at full strength regardless of the alpha slider) or an oversight in Foundry's own source — either way, a port that assumes "every coloration animation multiplies by `colorationAlpha`" as a universal rule would silently introduce a behavior Foundry itself doesn't have for these two.

`puv.x + puv.y` — hue is driven by **both** angle (`puv.x`) and radius (`puv.y`), producing a spiral rainbow (hence "swirling"), vs. `radialrainbow` below which uses radius only.

**MSA port:** trivial (`atan`/`length`/`hsb2rgb`, no loops). Omit the `colorationAlpha` multiply to match Foundry exactly — don't "fix" this into consistency with the other 20 coloration animations.

---

### `radialrainbow` — Radial Rainbow
**Demonstrates:** the same polar-rainbow idea as `rainbowswirl`, with hue driven by radius only (no angle term) — a plain concentric rainbow-ring pattern. Shares the `colorationAlpha`-omission finding above.

*Coloration* (`effects/radial-rainbow.mjs:6-34`) — toolkit: `HSB2RGB`, `PERCEIVED_BRIGHTNESS`. `forceDefaultColor = true`.
```glsl
void main() {
  ${this.FRAGMENT_BEGIN}

  float intens = intensity * 0.1;
  vec2 nuv = vUvs * 2.0 - 1.0;
  vec2 puv = vec2(atan(nuv.x, nuv.y) * INVTWOPI + 0.5, length(nuv));
  vec3 rainbow = hsb2rgb(vec3(puv.y - time * 0.2, 1.0, 1.0));
  finalColor = mix(color, rainbow, smoothstep(0.0, 1.5 - intens, dist))
                * (1.0 - dist * dist * dist);

  ${this.COLORATION_TECHNIQUES}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
Note `puv.x` (the angle term) is computed but **unused** in the final `hsb2rgb(vec3(puv.y - time*0.2, ...))` call — a harmless dead local read (the `atan`/`+0.5` work still executes on the GPU even though only `puv.y` feeds the result). Not worth porting the wasted `puv.x` computation at all if hue truly only needs radius — but flagged rather than silently "optimized away" in case there's a reason (there doesn't appear to be one from the code alone).

**MSA port:** same as `rainbowswirl`, drop the angle term entirely (it's provably unused), omit `colorationAlpha`.

---

### `fairy` — Fairy Light
**Demonstrates:** the most visually complex coloration animation in the set — layered FBM domain-warp distortion **plus** a polar rainbow blended on top, both channels (illumination is the FBM-distortion-only half, without the rainbow).

*Coloration* (`effects/fairy-light.mjs:7-65`) — toolkit: `HSB2RGB`, `PRNG`, `NOISE`, `FBM(3,1.0)`, `PERCEIVED_BRIGHTNESS`. `forceDefaultColor = true`.
```glsl
void main() {
  ${this.FRAGMENT_BEGIN}

  float distortion1 = fbm(vec2(
                      fbm(vUvs * 3.0 + time * 0.50),
                      fbm((-vUvs + vec2(1.)) * 5.0 + time * INVTHREE)));

  float distortion2 = fbm(vec2(
                      fbm(-vUvs * 3.0 + time * 0.50),
                      fbm((-vUvs + vec2(1.)) * 5.0 - time * INVTHREE)));
  vec2 uv = vUvs;

  float t = time * 0.5;
  float tcos = 0.5 * (0.5 * (cos(t)+1.0)) + 0.25;
  float tsin = 0.5 * (0.5 * (sin(t)+1.0)) + 0.25;

  uv -= PIVOT;
  uv *= tcos * distortion1;
  uv *= tsin * distortion2;
  uv *= fbm(vec2(time + distortion1, time + distortion2));
  uv += PIVOT;

  float intens = intensity * 0.1;
  vec2 nuv = vUvs * 2.0 - 1.0;
  vec2 puv = vec2(atan(nuv.x, nuv.y) * INVTWOPI + 0.5, length(nuv));
  vec3 rainbow = hsb2rgb(vec3(puv.x + puv.y - time * 0.2, 1.0, 1.0));
  vec3 mixedColor = mix(color, rainbow, smoothstep(0.0, 1.5 - intens, dist));

  finalColor = distortion1 * distortion1 *
               distortion2 * distortion2 *
               mixedColor * colorationAlpha * (1.0 - dist * dist * dist) *
               mix( uv.x + distortion1 * 4.5 * (intensity * 0.4),
                    uv.y + distortion2 * 4.5 * (intensity * 0.4), tcos);
  ${this.COLORATION_TECHNIQUES}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
This is textually `ghost-light`'s coloration body (same `distortion1`/`distortion2`/`uv` warp sequence, same constants) **plus** `rainbowswirl`'s rainbow block, fused together — worth treating as "GhostLight-coloration ⊕ SwirlingRainbow" when porting rather than a wholly new derivation, but note FairyLight's version **does** include `colorationAlpha` (unlike the two pure-rainbow animations above) — the omission is specific to `rainbowswirl`/`radialrainbow`, not a general "rainbow animations skip alpha" rule.

*Illumination* (`effects/fairy-light.mjs:72-104`) — toolkit: `PERCEIVED_BRIGHTNESS`, `PRNG`, `NOISE`, `FBM(3,1.0)`. This half is exactly `ghost-light`'s illumination shape (own distortion constants, not shared):
```glsl
void main() {
  ${this.FRAGMENT_BEGIN}

  float distortion1 = fbm(vec2(
                      fbm(vUvs * 3.0 - time * 0.50),
                      fbm((-vUvs + vec2(1.)) * 5.0 + time * INVTHREE)));

  float distortion2 = fbm(vec2(
                      fbm(-vUvs * 3.0 - time * 0.50),
                      fbm((-vUvs + vec2(1.)) * 5.0 - time * INVTHREE)));

  float motionWave = 0.5 * (0.5 * (cos(time * 0.5) + 1.0)) + 0.25;
  ${this.TRANSITION}
  finalColor *= mix(distortion1, distortion2, motionWave);
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```

**MSA port:** coloration is the single most expensive coloration animation to port (FBM×7 plus a full HSB rainbow plus multi-stage `uv` warp) — budget accordingly if the porting team is tracking per-effect GPU cost (per this project's own perf-lab discipline). Illumination is comparatively cheap (FBM×6, standard hook point).

---

### `grid` — Force Grid
**Demonstrates:** a "futuristic" repeating grid-line pattern via a hand-rolled iterative fold (5-iteration `for` loop doing a fractal-subdivision-style grid), no fbm/noise. Coloration-only.

*Coloration* (`effects/force-grid.mjs:6-91`) — toolkit: `PERCEIVED_BRIGHTNESS` only. `forceDefaultColor = true`.
```glsl
const float MAX_INTENSITY = 1.2;
const float MIN_INTENSITY = 0.8;

vec2 hspherize(in vec2 uv, in float dist) {
  float f = (1.0 - sqrt(1.0 - dist)) / dist;
  uv -= vec2(0.50);
  uv *= f * 5.0;
  uv += vec2(0.5);
  return uv;
}

float wave(in float dist) {
  float sinWave = 0.5 * (sin(time * 6.0 + pow(1.0 - dist, 0.10) * 35.0 * intensity) + 1.0);
  return ((MAX_INTENSITY - MIN_INTENSITY) * sinWave) + MIN_INTENSITY;
}

float fpert(in float d, in float p) {
  return max(0.3 -
             mod(p + time + d * 0.3, 3.5),
             0.0) * intensity * 2.0;
}

float pert(in vec2 uv, in float dist, in float d, in float w) {
  uv -= vec2(0.5);
  float f = fpert(d, min( uv.y,  uv.x)) +
            fpert(d, min(-uv.y,  uv.x)) +
            fpert(d, min(-uv.y, -uv.x)) +
            fpert(d, min( uv.y, -uv.x));
  f *= f;
  return max(f, 3.0 - f) * w;
}

vec3 forcegrid(vec2 suv, in float dist) {
  vec2 uv = suv - vec2(0.2075, 0.2075);
  vec2 cid2 = floor(uv);
  float cid = (cid2.y + cid2.x);
  uv = fract(uv);
  float r = 0.3;
  float d = 1.0;
  float e;
  float c;

  for( int i = 0; i < 5; i++ ) {
    e = uv.x - r;
    c = clamp(1.0 - abs(e * 0.75), 0.0, 1.0);
    d += pow(c, 200.0) * (1.0 - dist);
    if ( e > 0.0 ) {
      uv.x = (uv.x - r) / (2.0 - r);
    }
    uv = uv.yx;
  }

  float w = wave(dist);
  vec3 col = vec3(max(d - 1.0, 0.0)) * 1.8;
  col *= pert(suv, dist * intensity * 4.0, d, w);
  col += color * 0.30 * w;
  return col * color;
}

void main() {
  ${this.FRAGMENT_BEGIN}
  vec2 uvs = vUvs;
  uvs -= PIVOT;
  uvs *= intensity * 0.2;
  uvs += PIVOT;
  vec2 suvs = hspherize(uvs, dist);
  finalColor = forcegrid(suvs, dist) * colorationAlpha;
  ${this.COLORATION_TECHNIQUES}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
`forcegrid()`'s 5-iteration loop **swaps `uv.x`/`uv.y` every iteration** (`uv = uv.yx`) and **conditionally rescales** `uv.x` (`if (e>0.0) uv.x = (uv.x-r)/(2.0-r)`) — a genuine loop-carried, data-dependent mutation (not just an accumulator), structurally the same *shape* of problem `point-light-illumination.js`'s `makeSdPolygonEdgeDistance` already solves in this codebase (loop-carried `.toVar()`/`.assign()` state, plus a conditional `select()` inside the loop body for the `if`). This is the cleanest in-project precedent to copy for this specific animation.

**MSA port:** a fixed 5-iteration `Loop`, `select()` for the conditional rescale, swizzle-swap via reassigning a `.toVar()` pair each iteration. No fbm/noise dependency at all — self-contained once the loop pattern is right.

---

### `starlight` — Star Light
**Demonstrates:** rotating "disco" light-ray pattern via `tan(fbm(...))` (an unusual choice — `tan` rather than the more common `sin`/`fract` ray techniques used elsewhere in this set). Coloration-only.

*Coloration* (`effects/star-light.mjs:6-53`) — toolkit: `PRNG`, `NOISE`, `FBM(2,1.0)`, `PERCEIVED_BRIGHTNESS`. `forceDefaultColor = true`.
```glsl
vec2 transform(in vec2 uv, in float dist) {
  float t = time * 0.20;
  float cost = cos(t);
  float sint = sin(t);

  mat2 rotmat = mat2(cost, -sint, sint, cost);
  uv *= rotmat;
  return uv;
}

float makerays(in vec2 uv, in float t) {
  vec2 uvn = normalize(uv * (uv + t)) * (5.0 + intensity);
  return max(clamp(0.5 * tan(fbm(uvn - t)), 0.0, 2.25),
             clamp(3.0 - tan(fbm(uvn + t * 2.0)), 0.0, 2.25));
}

float starlight(in float dist) {
  vec2 uv = (vUvs - 0.5);
  uv = transform(uv, dist);
  float rays = makerays(uv, time * 0.5);
  return pow(1.0 - dist, rays) * pow(1.0 - dist, 0.25);
}

void main() {
  ${this.FRAGMENT_BEGIN}
  finalColor = clamp(color * starlight(dist) * colorationAlpha, 0.0, 1.0);
  ${this.COLORATION_TECHNIQUES}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
`normalize(uv * (uv + t))` — componentwise multiply, *then* normalize the resulting 2-vector; easy to mis-port as `normalize(uv) * (uv+t)` (a different, wrong expression) — flagged explicitly since operator precedence/parenthesization traps are exactly the kind of thing a mechanical line-by-line port can silently invert. The outer `clamp(..., 0.0, 1.0)` around the whole `finalColor` expression is unique to this animation among the ones surveyed.

**MSA port:** `FBM(2,1.0)` (2-octave `Loop`), 2 calls per pixel. `tan()` is unbounded near `π/2` — the `clamp(...,0.0,2.25)` calls exist specifically to tame that, keep them.

---

### `smokepatch` — Smoke Patch
**Demonstrates:** drifting FBM smoke via a rotate+shear transform (note the `scalemat` below is **not** a pure scale — it has off-diagonal terms derived from `uv` itself, a shear coupled to position), both channels, identical `smokefading()` function shared verbatim between illumination and coloration (the only animation in this set where the two channels' helper function bodies are byte-identical, not just structurally similar).

*Coloration* (`effects/smoke-patch.mjs:7-51`) — toolkit: `PRNG`, `NOISE`, `FBMHQ(3)`, `PERCEIVED_BRIGHTNESS`.
```glsl
vec2 transform(in vec2 uv, in float dist) {
  float t = time * 0.1;
  float cost = cos(t);
  float sint = sin(t);

  mat2 rotmat = mat2(cost, -sint, sint, cost);
  mat2 scalemat = mat2(10.0, uv.x, uv.y, 10.0);
  uv -= PIVOT;
  uv *= (rotmat * scalemat);
  uv += PIVOT;
  return uv;
}

float smokefading(in float dist) {
  float t = time * 0.4;
  vec2 uv = transform(vUvs, dist);
  return pow(1.0 - dist,
    mix(fbm(uv, 1.0 + intensity * 0.4),
      max(fbm(uv + t, 1.0),
          fbm(uv - t, 1.0)),
        pow(dist, intensity * 0.5)));
}

void main() {
  ${this.FRAGMENT_BEGIN}
  finalColor = color * smokefading(dist) * colorationAlpha;
  ${this.COLORATION_TECHNIQUES}
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```
Note `mat2(10.0, uv.x, uv.y, 10.0)` — column-major GLSL `mat2` construction, so this matrix is `[[10, uv.y], [uv.x, 10]]` in row terms (`mat2(m00,m01,m10,m11)` fills column-major: column0=(m00,m01), column1=(m10,m11)) — worth being precise about GLSL's column-major `matN()` constructor convention specifically here since `uv.x`/`uv.y` land in the *off-diagonal* slots, i.e. this is genuinely a position-coupled shear, not a typo-for-scale.

*Illumination* (`effects/smoke-patch.mjs:58-102`) — same toolkit, **byte-identical `transform()`/`smokefading()`** to the coloration version above (re-quoted in full in source, not re-quoted here — literally the same text):
```glsl
void main() {
  ${this.FRAGMENT_BEGIN}
  ${this.TRANSITION}
  finalColor *= smokefading(dist);
  ${this.ADJUSTMENTS}
  ${this.FALLOFF}
  ${this.FRAGMENT_END}
}
```

**MSA port:** since `smokefading`/`transform` are identical across channels here (unlike every other dual-channel animation in this set, which all vary constants between channels), this is the one animation where a single shared TSL `Fn()` can genuinely serve both materials without parameterizing per-channel differences — build it once, call it from both. `FBMHQ(3)` needed (its 2-argument call form, §2).

---

### `magicalGloom` — Magical Gloom (darkness)
**Demonstrates:** a radial-projection interference ring — the most analytically elaborate of the 4 darkness animations. Single channel (`darkness`), no `COLORATION_TECHNIQUES`/`ADJUSTMENTS`/`FALLOFF` concept at all (§3.3).

*Darkness* (`effects/magical-gloom.mjs:6-101`) — toolkit: `PERCEIVED_BRIGHTNESS`, `PRNG`, `NOISE`, `FBMHQ()` (all defaults: 3 octaves, `fbm`/`noise`/`vec2`).
```glsl
vec3 colorScale(in float t) {
  return vec3(1.0 + 0.8 * t) * t;
}

vec2 radialProjection(in vec2 uv, in float s, in float i) {
  uv = vec2(0.5) - uv;
  float px = 1.0 - fract(atan(uv.y, uv.x) / TWOPI + 0.25) + s;
  float py = (length(uv) * (1.0 + i * 2.0) - i) * 2.0;
  return vec2(px, py);
}

float interference(in vec2 n) {
  float noise1 = noise(n);
  float noise2 = noise(n * 2.1) * 0.6;
  float noise3 = noise(n * 5.4) * 0.42;
  return noise1 + noise2 + noise3;
}

float illuminate(in vec2 uv) {
  float t = time;
  float xOffset = uv.y < 0.5
                  ? 23.0 + t * 0.035
                  : -11.0 + t * 0.03;
  uv.x += xOffset;
  uv.y = abs(uv.y - 0.5);
  uv.x *= (10.0 + 80.0 * intensity * 0.2);
  float q = interference(uv - t * 0.013) * 0.5;
  vec2 r = vec2(interference(uv + q * 0.5 + t - uv.x - uv.y), interference(uv + q - t));
  float sh = (r.y + r.y) * max(0.0, uv.y) + 0.1;
  return sh * sh * sh;
}

vec3 voidHalf(in float intensity) {
  float minThreshold = 0.35;
  intensity = pow(intensity, 0.75);
  vec3 color = colorScale(intensity);
  color /= (1.0 + max(vec3(0), color));
  return color;
}

vec3 voidRing(in vec2 uvs) {
  vec2 uv = (uvs - 0.5) / (borderDistance * 1.06) + 0.5;
  float r = 3.6;
  float ff = 1.0 - uv.y;
  vec2 uv2 = uv;
  uv2.y = 1.0 - uv2.y;
  vec3 colorUpper = voidHalf(illuminate(radialProjection(uv, 1.0, r))) * ff;
  vec3 colorLower = voidHalf(illuminate(radialProjection(uv2, 1.9, r))) * (1.0 - ff);
  return colorUpper + colorLower;
}

void main() {
  ${this.FRAGMENT_BEGIN}
  float lumBase = perceivedBrightness(finalColor);
  lumBase = mix(lumBase, lumBase * 0.33, darknessLevel);
  vec3 voidRingColor = voidRing(vUvs);
  float lum = pow(perceivedBrightness(voidRingColor), 4.0);
  vec3 voidRingFinal = vec3(perceivedBrightness(voidRingColor)) * color;
  finalColor = voidRingFinal * lumBase * colorationAlpha;
  ${this.FRAGMENT_END}
}
```
Note `voidHalf`'s parameter `intensity` **shadows** the shared `intensity` uniform (a local-scope float parameter with the same name as the global) — GLSL allows this and it's unambiguous within `voidHalf`'s body, but a mechanical name-preserving port into a single-scope TSL graph (where node names are typically hoisted/shared, not block-scoped the way GLSL locals are) needs to rename one of them to avoid an actual collision. `minThreshold` (line inside `voidHalf`) is declared and **never used** — confirmed dead local, safe to drop when porting. `lum` (in `main()`) is computed and **also never used** afterward — a second dead-local instance in the same file; `finalColor`'s actual formula only reads `voidRingFinal`/`lumBase`/`colorationAlpha`, never `lum`.

**MSA port:** `0.33` darkness-level-mix coefficient here matches the *default* `AdaptiveDarknessShader` body's own constant (`base-lighting.mjs`'s darkness default, §3.4's last block) — contrast with `hole` below, which uses a different constant. No loops beyond `FBMHQ`'s internal 3-octave one; otherwise pure analytic trig/noise composition.

---

### `roiling` — Roiling Mass (darkness)
**Demonstrates:** an FBM-domain-warped "membrane" boundary — the darkness-channel sibling of the illumination/coloration distortion animations (`ghost`, `fairy`), built the same way (`fbm(vec2(fbm(...), fbm(...)))` nested warp) but shaped into a hard-edged membrane rather than a soft glow.

*Darkness* (`effects/roiling-mass.mjs:6-70`) — toolkit: `PERCEIVED_BRIGHTNESS`, `PRNG`, `NOISE`, `FBM(3)` (default amp 1.0).
```glsl
void main() {
  ${this.FRAGMENT_BEGIN}
  float distortion1 = fbm( vec2(
                      fbm( vUvs * 2.5 + time * 0.5),
                      fbm( (-vUvs - vec2(0.01)) * 5.0 + time * INVTHREE)));

  float distortion2 = fbm( vec2(
                      fbm( -vUvs * 5.0 + time * 0.5),
                      fbm( (vUvs + vec2(0.01)) * 2.5 + time * INVTHREE)));

  float t = -time * 0.5;
  float cost = cos(t);
  float sint = sin(t);

  mat2 rotmat = mat2(cost, -sint, sint, cost);
  vec2 uv = vUvs;

  uv -= vec2(0.5);
  uv *= rotmat;
  uv += vec2(0.5);

  vec2 dstpivot = vec2( sin(min(distortion1 * 0.1, distortion2 * 0.1)),
                        cos(min(distortion1 * 0.1, distortion2 * 0.1)) ) * INVTHREE
                - vec2( cos(max(distortion1 * 0.1, distortion2 * 0.1)),
                        sin(max(distortion1 * 0.1, distortion2 * 0.1)) ) * INVTHREE ;
  vec2 apivot = PIVOT - dstpivot;
  uv -= apivot;
  uv *= 1.13 + 1.33 * (cos(sqrt(max(distortion1, distortion2)) + 1.0) * 0.5);
  uv += apivot;

  float ddist = clamp(distance(uv, PIVOT) * 2.0, 0.0, 1.0);

  float smooth = smoothstep(borderDistance, borderDistance * 1.2, ddist);
  float inSmooth = min(smooth, 1.0 - smooth) * 2.0;

  vec3 membraneColor = vec3(1.0 - inSmooth);

  finalColor *= (mix(color, color * 0.33, darknessLevel) * colorationAlpha);
  finalColor = mix(finalColor,
                   vec3(0.0),
                   1.0 - smoothstep(0.25, 0.30 + (intensity * 0.2), ddist));
  finalColor *= membraneColor;
  ${this.FRAGMENT_END}
}
```
`smooth` as a GLSL identifier — legal in GLSL (not a reserved word there), but **is** a reserved TSL/JS function name (`THREE.TSL.smoothstep`, and `smooth` itself may collide with local scope conventions) — rename on port (e.g. `smoothT`/`edgeT`). This body keeps the base `AdaptiveDarknessShader`'s own default line (`finalColor *= (mix(color, color * 0.33, darknessLevel) * colorationAlpha);`, §3.4) verbatim as its *first* darkness-mix step, then layers two more transformations on top — of the 4 darkness animations, this is the only one that visibly *extends* the default line rather than replacing it outright.

**MSA port:** `FBM(3)` × 4 calls (2 nested pairs for `distortion1`/`distortion2`). Confirm the `0.33` coefficient (matches the shared default, unlike `hole`'s `0.66`, see next entry) — worth a shared constant/uniform rather than a hardcoded literal duplicated per animation, precisely because `hole` needs a *different* value.

---

### `hole` — Black Hole (darkness)
**Demonstrates:** a beam-emanation swallowing-beams effect (structurally the darkness-channel cousin of `emanation`'s angular-beam technique) radially compressed toward the center (`pow(1-dist, 3.0)`). **Uses a different darkness-mix coefficient than the shared default.**

*Darkness* (`effects/black-hole.mjs:6-41`) — toolkit: `PRNG`, `NOISE`, `FBMHQ()` (defaults), `PERCEIVED_BRIGHTNESS`.
```glsl
vec3 beamsEmanation(in vec2 uv, in float dist, in vec3 pCol) {
  float angle = atan(uv.x, uv.y) * INVTWOPI;
  float dad = mix(0.33, 5.0, dist);
  float beams = fract(angle + sin(dist * 30.0 * (intensity * 0.2) - time + fbm(uv * 10.0 + time * 0.25, 1.0) * dad));
  beams = max(beams, 1.0 - beams);
  return smoothstep(0.0, 1.1 + (intensity * 0.1), beams * pCol);
}

void main() {
  ${this.FRAGMENT_BEGIN}
  vec2 uvs = (2.0 * vUvs) - 1.0;
  finalColor *= (mix(color, color * 0.66, darknessLevel) * colorationAlpha);
  float rd = pow(1.0 - dist, 3.0);
  finalColor = beamsEmanation(uvs, rd, finalColor);
  ${this.FRAGMENT_END}
}
```
**Flagged finding: `0.66`, not `0.33`.** Every other darkness body that includes the "mix toward a dimmed colour by darkness level" line (the default scaffold itself, plus `roiling`'s extension of it) uses `mix(color, color * 0.33, darknessLevel)`. Black Hole's is `mix(color, color * 0.66, darknessLevel)` — a **deliberate, doubled** dim-floor (at full scene darkness, Black Hole's colour only dims to 66% of itself, vs. the default/Roiling's 33%), making Black Hole read noticeably less "swallowed by ambient darkness" than the other three. This is exactly the kind of single-constant deviation a copy-paste port (working from the "default darkness body" template) would silently miss. `beamsEmanation` here takes a third argument (`pCol`, the already-dimmed `finalColor`) and multiplies it into the beam pattern, unlike `emanation.mjs`'s 2-argument version which multiplies the *raw* `color` uniform — same function name, genuinely different signature and role, confirmed not a copy-paste duplicate to dedupe.

**MSA port:** `FBMHQ()` (3-octave default) × 1 call. Keep the `0.66` constant distinct from `roiling`'s `0.33` — do not factor them into one "the" darkness-dim constant.

---

### `denseSmoke` — Dense Smoke (darkness)
**Demonstrates:** volumetric-looking layered-fbm smoke. **The one animation in this entire set of 27 that bypasses `${this.FRAGMENT_END}` and writes `gl_FragColor` directly**, producing a non-constant alpha channel (smoke density) instead of the `depth`-derived alpha every other shader in this doc emits.

*Darkness* (`effects/dense-smoke.mjs:6-45`) — toolkit: `SIMPLEX_3D` (`snoise`, the *only* animation using 3D simplex rather than 2D value-noise), `FBMHQ(5,"fbm","snoise","vec3")`.
```glsl
void main() {
  ${this.FRAGMENT_BEGIN}
  float i = (intensity * 0.2);
  vec2 uv = vUvs * 2.5;

  float fn1 = i * 0.33 + 0.67 * fbm(vec3(uv, time * 0.25), 1.70);
  float fn2 = i * 0.33 + 0.67 * fbm(vec3(uv + 0.5, time * 0.25), 1.40);
  float fn3 = i * 0.33 + 0.67 * fbm(vec3(uv - 0.5, time * 0.25), 1.65);

  float m1 = fbm(vec3(uv - 1.301, time * 0.16), 1.66);
  float m2 = fbm(vec3(uv + 1.187, time * 0.21), 1.54);

  float t = mix(fn1, fn2, m1);
  t = mix(t, fn3, m2);
  t = mix(t, fn1, 0.5);
  t = mix(t, fn2, 0.5);
  t = mix(t, fn3, 0.5);
  finalColor = vec3(t);

  float bda = 1.0 - smoothstep(borderDistance, 1.0, dist);

  gl_FragColor = vec4(finalColor * color, t) * depth * bda * colorationAlpha;
}
```
**Flagged finding: no `${this.FRAGMENT_END}` call at all** — confirmed by direct re-inspection of the file, the closing `}` of `main()` follows the manual `gl_FragColor` line directly. Consequences for a port:
1. **Alpha is `t` (the smoke-density scalar), not `1.0`.** Every other darkness/coloration shader's output alpha is `1.0 × depth[× falloff]` (§3.2's alpha-asymmetry note); DenseSmoke's is `t × depth × bda × colorationAlpha` — a genuinely different alpha contract. Since darkness sources blend `MAX_COLOR` on **both** RGB and alpha (base audit §3, §18.2), overlapping DenseSmoke sources (or DenseSmoke overlapping a differently-alpha'd darkness type, though only one darkness animation applies per source) will MAX-blend on this density-driven alpha too — almost certainly intentional (denser smoke patches "win" the alpha channel the same way they'd visually dominate), but worth confirming live before assuming it's incidental.
2. **`bda` (a second, independent border-fade term) is folded in on top of `depth`**, which *already* includes darkness's own `borderDistance` fade inside `FRAGMENT_BEGIN` (§3.3) — meaning DenseSmoke applies the `borderDistance` falloff **twice**, once via the inherited `depth` and once explicitly via `bda` using the identical formula (`1.0 - smoothstep(borderDistance, 1.0, dist)` vs. `FRAGMENT_BEGIN`'s `(1.0 - smoothstep(borderDistance, 1.0, dist))` — textually the same expression, computed twice). Whether this doubled fade (effectively squaring the border falloff curve) is deliberate (a tighter, more contained smoke edge than other darkness types) or an oversight, it's a real, verifiable, reproducible behavior — port it as-is (`depth × bda`, both terms present) rather than "deduplicating" it to a single fade.
3. `fbm(vec3(...), smoothness)` here is the **3D `FBMHQ` variant keyed to `snoise`** (`FBMHQ(5,"fbm","snoise","vec3")` — 5 octaves, 3D input, simplex-hashed) — genuinely different both in dimensionality and hash family from every other `fbm`/`noise` call in this doc (all 2D, value-noise/`PRNG`-hashed). A TSL port needs a **separate** 3D-fractal-noise `Fn()` (or `THREE.TSL.mx_fractal_noise_float(vec3, octaves, lacunarity, diminish)`, §5, keyed to Perlin rather than simplex — a real hash-family mismatch to weigh) distinct from the 2D one every other animation in this set shares.

**MSA port:** the highest-friction single animation to port cleanly, purely because of point 1 above — whatever "insert the animated line" scaffold hook the porting team builds for the other 26 animations needs an escape hatch for this one (a full custom `fragmentNode` output, not a slot-in seed replacement), since it changes the alpha formula, not just the RGB formula.

---

## 5. TSL port considerations

### 5.1 Existing MSA TSL primitives — reuse, don't rebuild
Grepped `src/` for `simplex`, `voronoi`, `fbm`, `noise`, `hsb`/`hsv2rgb`: **zero hand-written matches** — none of these primitives currently exist anywhere in this codebase (the incidental "noise" hits in `src/diag/flight-recorder.js`, `src/diag/perf-lab.js`, `src/effects/particles/particle-system-schema.js`, `src/foundry/__tests__/scene-tokens.test.mjs` are unrelated uses of the word, not shader noise). **`src/effects/candle-flame.js`'s `deferredRungs` explicitly lists `animated-flicker` ("TSL-noise flicker driven by the frame clock") as unbuilt** — confirmed by reading both `candle-flame.js` and `candle-flame-render.js` in full; Tier 0 is a static teardrop marker with zero noise code. No prior-art collision; this doc is the natural reference when that rung is picked up.

However, the **vendored Three build already ships MaterialX noise nodes on the public `THREE.TSL` surface** — confirmed by tracing the export chain in `src/vendor/three/three.webgpu.js` (e.g. `mx_fractal_noise_float: () => mx_fractal_noise_float2` / `var mx_fractal_noise_float2 = TSL.mx_fractal_noise_float`, same pattern for the others):
- `mx_perlin_noise_float(position, ...)` / `mx_perlin_noise_vec3(...)` — Perlin gradient noise.
- `mx_cell_noise_float(...)` / `mx_cell_noise_vec3(...)` — cellular/Worley-style noise (a plausible stand-in for the toolkit's `VORONOI`/energy-field's hand-rolled `voronoi3d`, though not the same hash).
- `mx_fractal_noise_float(position, octaves=3, lacunarity=2, diminish=0.5, amplitude=1)` / `..._vec2`/`..._vec3`/`..._vec4` — an FBM analog, already octave-parametrized much like Foundry's own `FBM(octaves,amp)`.

All reachable via this project's existing `const { ... } = THREE.TSL` destructuring convention (the same pattern `point-light-illumination.js`/`point-light-coloration.js` already use). **The caveat that must not be silently dropped:** these are **Perlin/cell noise, not Foundry's specific value-noise (`PRNG`+`NOISE`) or simplex (`SIMPLEX_3D`/`snoise`) hash** — visually similar in character, but not pixel-identical. For a Type-B (MSA-native, non-parity) animated light, `mx_*` is the pragmatic, already-available choice. For a Type-A (Foundry-parity) light where an animation's exact noise pattern matters for an A/B comparison against real Foundry, the porting team should hand-translate Foundry's literal `random`/`noise`/`snoise`/`fbm`/`voronoi3d` GLSL (all quoted in full in §2 and per-animation in §4) into `Fn()` form instead — both paths are legitimate, the doc deliberately does not pick one for you.

**Primitives with no Three equivalent, needing fresh TSL either way:** `HSB2RGB` (4 animations depend on it: `chroma`, `fairy`, `radialrainbow`, `swirlingrainbow` — trivial, ~4 lines, no loop), `PIE`/`ROTATION` (2 animations: `revolving`, `siren` — trivial, no loop), and Foundry's own exact `PRNG`/`PRNG2D`/`PRNG3D`/`NOISE`/`snoise` hash functions (only needed if pixel-parity with Foundry's specific noise pattern is a goal, per the caveat above).

### 5.2 The `Loop`/`.toVar()`/`.assign()` convention — already proven in this codebase, extend it, don't reinvent it
`point-light-illumination.js`'s `makeSdPolygonEdgeDistance` (that file's own header, lines 260-264) is this project's **only existing precedent** for a TSL `Loop` with loop-carried mutable state, and it's a single-level loop. Animations needing this pattern, ranked by loop complexity:
- **Single-level, fixed-count:** every `FBM(octaves,...)`/`FBMHQ(...)` call (14 of the 27 animations use one or both) — octave count is known at JS/material-build time, so a fixed-bound `Loop` per call site (matching `makeSdPolygonEdgeDistance`'s own shape) is a direct, low-risk translation.
- **Single-level, fixed-count, with a data-dependent conditional inside:** `grid` (Force Grid)'s 5-iteration fold, which swaps `uv.x`/`uv.y` and conditionally rescales — needs `select()` inside the loop body, same combination of primitives `makeSdPolygonEdgeDistance` already uses (`Loop` + `select` + `.assign()`), just applied to a different problem shape.
- **Triple-nested, fixed-count (27 total iterations):** `energy` (Energy Field)'s hand-rolled 3D voronoi — the one animation in this set with a genuinely untested-in-this-codebase loop shape. Recommend flattening to one 27-iteration `Loop` with index decomposition (`i/9`, `(i/3)%3`, `i%3`) rather than three nested `Loop`s, since only single-level loops are proven working here so far.

### 5.3 The `.mix()`-as-method trap — directly relevant, repeat it
Both existing lighting files self-document `reference_tsl_method_chaining_trap`: `.mix()` (and `.smoothstep()`, `.clamp()`, etc.) called as a **method** takes the receiver as the interpolant/last argument, not the first — silently produces the wrong blend. **Every one of the 27 animations is `mix()`-heavy** (the domain-warp-palette animations — `fog`, `dome`, `vortex` — alone average 4-6 `mix()` calls each). Use the **function form** throughout (`mix(a, b, t)`, matching how `point-light-illumination.js`/`point-light-coloration.js` already call `mix`/`clamp`/`smoothstep`/`length`/`dot`/`max` as functions, never methods) — this is the single highest-frequency translation trap across the whole animation set, purely by volume of `mix()` call sites.

### 5.4 `forceDefaultColor` needs a new per-animation gate in MSA
`point-light-coloration.js` currently sets `uColorationAlpha = 0` for any light with no author-picked colour, as its equivalent of Foundry's `hasColor` gate (that file's own header). Per §3.4's roster, **13 of the 22 unique coloration animations must render regardless of `hasColor`**, inventing their own colour (rainbow hue, forced white default, etc.) exactly the way `forceDefaultColor=true` makes Foundry's own `AdaptiveColorationShader#isRequired` ignore `hasColor`. Porting any of those 13 needs this gate threaded through explicitly — a colourless-light early-out that's correct for the 9 non-forcing animations (and every unanimated default light) will silently blank out Chroma/Emanation/EnergyField/FairyLight/ForceGrid/Fog/HexaDome/LightDome/RadialRainbow/Revolving/StarLight/SwirlingRainbow/Vortex on a colourless light where real Foundry would still show them.

### 5.5 The `angle`-uniform open question (§4's `revolving`/`siren` entries)
Restated here since it's a cross-cutting port decision, not just a curiosity: if the porting team cannot independently confirm Foundry ever assigns `u.angle` from live light data (this doc's own exhaustive trace found nothing across 7 files), the defensible port is `rot(time × k)` with no `angle` term, for both `revolving` and `siren`. If a live Foundry test later shows the beam's phase does track the light's placed rotation, that finding should get folded back into this doc before the port ships.

### 5.6 Two pre-existing (animation-independent) observations surfaced while cross-referencing
Neither is an animation-specific finding, both are worth a look since precision was the ask:
- **`point-light-coloration.js` currently hardcodes output alpha to `1`** (`vec4(outputColor, float(1))`) where real Foundry's coloration alpha is `depth`-after-falloff, not a constant (§3.2). This predates any animation work — flagged here because §4's per-animation alpha notes (especially `denseSmoke`'s) only make sense against the correct baseline.
- **Foundry's illumination alpha is unconditionally `1.0`** (§3.2) — MSA's `point-light-illumination.js` already matches this correctly; noted as a confirmation, not a gap.

### 5.7 Naming/testing conventions to follow for new port files (`src/CONVENTIONS.md`)
kebab-case filenames (`effects/lighting/animations/torch.js`, not `Torch.js`), camelCase functions, `UPPER_SNAKE_CASE` for true module-level constants (e.g. per-animation magic numbers worth naming, like Black Hole's `0.66` vs the shared `0.33`), one `__tests__/` per module directory. Per CONVENTIONS.md §4's own split: the **pure math** (CPU driver formulas — `easeAttenuation`-style functions, the `animateFlickering`/`animatePulse`/`animateSoundPulse` formulas of §1.3) should get real Node tests exactly like `point-light-illumination.js`'s `easeAttenuation`/`computeExposure` already do; the **GPU/TSL material bodies** should get verified live via the debug panel, matching how this project already treats `buildPointLightIlluminationMaterial` itself (not Node-tested, browser-verified).

### 5.8 Where MSA can go further than Foundry (per the base audit's own closing note, §15)
Two animation-specific opportunities beyond the base audit's general list: (a) Flame's coloration deliberately writes `color * 8.0` at its hottest point (§4's `flame` entry) — in Foundry's clamped SDR pipeline this just blows to white; in MSA's HDR-capable stack (per the two-light-type doctrine's Type-B track) this over-bright core could feed bloom directly instead of clipping. (b) `vortex`'s illumination channel is confirmed dead in Foundry (§4's `vortex` entry, the `convertToDarknessColors` dead function in particular) — a legitimate, clearly-scoped Type-B opportunity to build something Foundry itself never finished, rather than porting nothing.

---

## 6. File index

**Sources** `client/canvas/sources/`
- `rendered-effect-source.mjs` — `animate`, `animateTime`, `seed` assignment, shader-swap machinery (`_configureShaders`, `#initializeShaders`)
- `base-light-source.mjs` — `animateTorch`, `animateFlickering`, `animatePulse`, `animateSoundPulse`, `ANIMATIONS` getter, `_updateCommonUniforms`
- `point-light-source.mjs` — `ratio` computation, light-specific `ANIMATIONS` parentage
- `point-darkness-source.mjs` — darkness `ANIMATIONS` getter, `colorationAlpha` assignment (`_updateDarknessUniforms`), no-`ratio` confirmation
- `point-effect-source.mjs` — polygon/angle/rotation data flow (read in full while tracing the `angle`-uniform question, §4's `revolving` entry)
- `base-effect-source.mjs` — grepped for `angle` (no hits, part of the same trace)

**Containers** `client/canvas/containers/elements/`
- `point-source-mesh.mjs` — read in full, ruled out as an angle-uniform source

**Registry**
- `client/config.mjs:828-980` — `lightAnimations` (828-956, 23 entries), `darknessAnimations` (959-980, 4 entries)

**GLSL toolkit**
- `client/canvas/rendering/mixins/base-shader-mixin.mjs` — **path-corrected** from the base audit's file index (no `shaders/` segment); every primitive in this doc's §2
- `client/canvas/rendering/shaders/base-shader.mjs` — `AbstractBaseShader`, `create()` factory (ruled out as an angle-uniform source)

**Channel scaffolds** `client/canvas/rendering/shaders/lighting/`
- `base-lighting.mjs` — `FRAGMENT_BEGIN`/`FRAGMENT_END`/`TRANSITION`/`FALLOFF`/`SWITCH_COLOR`/`COMPUTE_ILLUMINATION`/`ADJUSTMENTS`, all 13 `SHADER_TECHNIQUES`, full `FRAGMENT_UNIFORMS`
- `illumination-lighting.mjs`, `coloration-lighting.mjs`, `background-lighting.mjs`, `darkness-lighting.mjs` — each channel's `_createFragmentShader()` assembly, `FRAGMENT_END`/`ADJUSTMENTS`/`EXPOSURE`/`SHADOW` overrides, `defaultUniforms`, `isRequired`

**All 26 animation shader files** `client/canvas/rendering/shaders/lighting/effects/` — every one read and quoted in full: `bewitching-wave.mjs`, `black-hole.mjs`, `chroma.mjs`, `dense-smoke.mjs`, `emanation.mjs`, `energy-field.mjs`, `fairy-light.mjs`, `flame.mjs`, `fog.mjs`, `force-grid.mjs`, `ghost-light.mjs`, `hexa-dome.mjs`, `light-dome.mjs`, `magical-gloom.mjs`, `pulse.mjs`, `radial-rainbow.mjs`, `revolving-light.mjs`, `roiling-mass.mjs`, `siren-light.mjs`, `smoke-patch.mjs`, `star-light.mjs`, `sunburst.mjs`, `swirling-rainbow.mjs`, `torch.mjs`, `vortex.mjs`, `wave.mjs`

**This project (`map-shine-advanced/src/`)**
- `src/effects/lighting/point-light-illumination.js` — read in full; current TSL terms (`uRatio`, `uAttenuationEased`, `uExposure`, `dist`, switchColor-equivalent, `falloff`, `combinedFalloff`, `outputColor`) every illumination animation's port note is keyed to
- `src/effects/lighting/point-light-coloration.js` — read in full; current TSL terms (`uAttenuationEased`, `uColorationAlpha`, `uLightColor`, `dist`, `falloff`, `mapColor`, `reflection`, `finalColor`, `outputColor`) every coloration animation's port note is keyed to; also the source of the §5.6 alpha=1 observation
- `src/effects/candle-flame.js`, `src/effects/candle-flame-render.js` — read in full; confirms the "animated-flicker" rung is deferred, unbuilt, no prior-art collision
- `src/CONVENTIONS.md` — read in full; naming/testing conventions referenced in §5.7
- `src/vendor/three/three.webgpu.js` — grepped for `mx_perlin_noise`/`mx_cell_noise`/`mx_fractal_noise` export chain, §5.1's primitive tally
- `docs/reference/foundry-v14-lighting-audit.md` — the companion base audit this doc extends; its §13 header count is the "29" this doc corrects to 27 (see opening)

---

*Audit performed against the vendored v14 tree. Cross-reference the base `foundry-v14-lighting-audit.md` for the non-animated mechanics (radius, falloff, colour channels, occlusion, the parity contract §17-19) every animation in this doc builds on top of. All 27 registered animation types (23 light + 4 darkness) are documented above with exact fragment bodies and file:line citations; six distinct source-level irregularities were found and flagged rather than smoothed over (Vortex's dead illumination code, Pulse's ADJUSTMENTS-skip, Sunburst's adjustment-order inversion, the RadialRainbow/SwirlingRainbow colorationAlpha omission, DenseSmoke's manual FRAGMENT_END/alpha contract, and Black Hole's divergent darkness-mix constant) plus one open, unresolved question (the `angle` uniform's apparent dead assignment for Revolving/Siren).*
