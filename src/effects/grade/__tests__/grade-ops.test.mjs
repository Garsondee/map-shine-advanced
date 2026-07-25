/**
 * THE GRADE PRIMITIVE, asserted. The luminance-preservation block is the star:
 * the whole design rests on the claim that desaturation drains chroma without
 * touching brightness (Grade.md §2), and a claim the tests can MEASURE is worth
 * more than a paragraph. The TSL path is proven to agree with the JS path
 * through a numeric TSL stub, so the shader and a CPU preview cannot diverge.
 */
import {
  applyGrade,
  buildGradeNode,
  resolveEnvGrade,
  scaleGradeToIdentity,
  gradePreset,
  luminance,
  IDENTITY_GRADE,
  GRADE_PRESETS,
  TONE_MAP_FNS,
  TONE_MAP_NAMES,
} from '../grade-ops.js';

export function run(t) {
  const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
  const rgbClose = (a, b, eps = 1e-6) => close(a[0], b[0], eps) && close(a[1], b[1], eps) && close(a[2], b[2], eps);

  // ---- identity is a no-op ---------------------------------------------------
  {
    for (const c of [
      [0.5, 0.5, 0.5],
      [0.8, 0.2, 0.1],
      [0.02, 0.4, 0.9],
      [0, 0, 0],
      [1, 1, 1],
    ]) {
      t.ok(`identity grade leaves ${c} unchanged`, rgbClose(applyGrade(c, {}), c));
      t.ok(`identity params too`, rgbClose(applyGrade(c, IDENTITY_GRADE), c));
    }
    t.ok('undefined params = identity', rgbClose(applyGrade([0.3, 0.6, 0.9]), [0.3, 0.6, 0.9]));
  }

  // ========================================================================
  // THE PROOF — desaturation is LUMINANCE-PRESERVING. If this fails, the grade
  // is changing brightness, which is the lights' job, and the whole
  // "orthogonal axes cannot fight" guarantee is void.
  // ========================================================================
  {
    for (const c of [
      [0.8, 0.2, 0.2],
      [0.1, 0.7, 0.3],
      [0.9, 0.9, 0.1],
      [0.05, 0.05, 0.6],
    ]) {
      for (const sat of [0, 0.25, 0.5, 0.75, 1]) {
        const out = applyGrade(c, { saturation: sat });
        t.ok(`sat=${sat} on ${c} preserves luminance exactly`, close(luminance(out), luminance(c), 1e-9));
      }
      // sat=0 must be pure grey (all channels equal to the luminance).
      const grey = applyGrade(c, { saturation: 0 });
      t.ok(`sat=0 is pure grey`, close(grey[0], grey[1], 1e-9) && close(grey[1], grey[2], 1e-9));
      t.ok(`...at the luminance`, close(grey[0], luminance(c), 1e-9));
    }
  }

  {
    // The negative claim restated at the primitive level: nothing OTHER than
    // saturation is what desaturates. A pure exposure/contrast change must NOT
    // reduce saturation on its own (saturation is (max-min)/max; exposure scales
    // both, contrast around a pivot can shift it but must not be how we grey).
    const c = [0.8, 0.2, 0.2];
    const sat0 = (x) => (Math.max(...x) > 1e-6 ? (Math.max(...x) - Math.min(...x)) / Math.max(...x) : 0);
    const exposed = applyGrade(c, { exposure: 1 });
    t.ok('exposure alone barely moves saturation', Math.abs(sat0(exposed) - sat0(c)) < 0.05);
  }

  // ---- op order and individual knobs ----------------------------------------
  {
    const c = [0.4, 0.4, 0.4];
    t.ok('exposure +1 stop doubles a linear value', rgbClose(applyGrade(c, { exposure: 1 }), [0.8, 0.8, 0.8]));
    t.ok('exposure −1 stop halves it', rgbClose(applyGrade(c, { exposure: -1 }), [0.2, 0.2, 0.2]));

    const warm = applyGrade([0.5, 0.5, 0.5], { temperature: 0.5 });
    t.ok('warm temperature pushes red above blue', warm[0] > warm[2]);
    const cool = applyGrade([0.5, 0.5, 0.5], { temperature: -0.5 });
    t.ok('cool temperature pushes blue above red', cool[2] > cool[0]);

    const contrasty = applyGrade([0.8, 0.8, 0.8], { contrast: 1.5 });
    t.ok('contrast pushes a bright value further from the pivot', contrasty[0] > 0.8);
    const flat = applyGrade([0.8, 0.8, 0.8], { contrast: 0.5 });
    t.ok('low contrast pulls it toward the pivot', flat[0] < 0.8 && flat[0] > 0.18);

    // Split-toning: per-channel gain tints highlights, per-channel lift tints shadows.
    const splitHi = applyGrade([0.9, 0.9, 0.9], { gain: [1.1, 1.0, 0.9] });
    t.ok('per-channel gain warms the highlights', splitHi[0] > splitHi[2]);
    const splitLo = applyGrade([0.05, 0.05, 0.05], { lift: [0.0, 0.0, 0.1] });
    t.ok('per-channel lift cools the shadows', splitLo[2] > splitLo[0]);
  }

  // ---- clamping / robustness ------------------------------------------------
  {
    const out = applyGrade([0.5, 0.5, 0.5], { contrast: 5 });
    t.ok('an extreme contrast never produces NaN', out.every(Number.isFinite));
    const neg = applyGrade([-0.1, 0.5, 2.0], { gamma: [2, 2, 2] });
    t.ok('a negative input clamps before pow, never NaN', neg.every(Number.isFinite));
    t.ok(
      'garbage params fall back to identity per-field',
      rgbClose(applyGrade([0.3, 0.6, 0.9], { saturation: 'x', exposure: null }), [0.3, 0.6, 0.9])
    );
  }

  // ---- the strength lever (ships neutral) -----------------------------------
  {
    const strong = { saturation: 0.2, contrast: 1.4, temperature: -0.5 };
    t.ok(
      'strength 0 is the identity',
      rgbClose(applyGrade([0.7, 0.3, 0.5], scaleGradeToIdentity(strong, 0)), [0.7, 0.3, 0.5])
    );
    const half = scaleGradeToIdentity(strong, 0.5);
    t.ok('strength 0.5 is halfway on saturation', close(half.saturation, 0.6));
    t.ok('...and halfway on contrast', close(half.contrast, 1.2));
    const full = scaleGradeToIdentity(strong, 1);
    t.ok('strength 1 is the full grade', close(full.saturation, 0.2) && close(full.contrast, 1.4));
  }

  // ---- the environmental grade (the cloud fix) ------------------------------
  {
    const clearNoon = resolveEnvGrade({ sun: { dayFactor01: 1 }, weather: { cloudCover01: 0 } });
    const overcast = resolveEnvGrade({ sun: { dayFactor01: 1 }, weather: { cloudCover01: 1 } });
    t.ok('clear midday is a touch vivid', clearNoon.saturation > 1);
    t.ok('overcast drains saturation hard — THE FIX', overcast.saturation < 0.7);
    t.ok('...and flattens contrast', overcast.contrast < 1);
    t.ok('...and cools slightly', overcast.temperature < 0);

    const night = resolveEnvGrade({ sun: { dayFactor01: 0 }, weather: { cloudCover01: 0 } });
    t.ok('night is muted vs day', night.saturation < clearNoon.saturation);

    // The env grade must NOT re-tint hue (the sky light owns that — no double count).
    t.ok('the env grade adds no green/magenta tint', clearNoon.tint === 0 && overcast.tint === 0);

    // Cloud desaturation must actually GREY a real pixel, luminance-preserved.
    const red = [0.8, 0.2, 0.2];
    const sat0 = (x) => (Math.max(...x) - Math.min(...x)) / Math.max(...x);
    const graded = applyGrade(red, scaleGradeToIdentity(overcast, 1));
    t.ok('an overcast-graded red is greyer', sat0(graded) < sat0(red));
  }

  // ---- vibrance: luminance-preserving, unsaturated-first --------------------
  {
    const grey = [0.5, 0.5, 0.5];
    const outGrey = applyGrade(grey, { vibrance: 0.8 });
    t.ok('vibrance leaves a fully-grey pixel grey (nothing to boost)', rgbClose(outGrey, grey, 1e-9));

    const lowSat = [0.55, 0.5, 0.45]; // barely tinted
    const highSat = [0.9, 0.1, 0.1]; // vivid
    const sat0 = (x) => (Math.max(...x) - Math.min(...x)) / Math.max(...x);
    const lowGain = sat0(applyGrade(lowSat, { vibrance: 0.8 })) / sat0(lowSat);
    const highGain = sat0(applyGrade(highSat, { vibrance: 0.8 })) / sat0(highSat);
    t.ok('vibrance boosts a LOW-saturation pixel more than a vivid one', lowGain > highGain);
    for (const c of [lowSat, highSat, [0.2, 0.6, 0.9]]) {
      t.ok(
        `vibrance preserves luminance on ${c}`,
        close(luminance(applyGrade(c, { vibrance: 0.7 })), luminance(c), 1e-6)
      );
    }
  }

  // ---- tone-map selector: enum → three's TSL fn name ------------------------
  {
    t.ok("'none' maps to no fn (skipped)", TONE_MAP_FNS.none === null);
    t.ok('agx is the author-chosen default option', TONE_MAP_FNS.agx === 'agxToneMapping');
    t.ok('aces present', TONE_MAP_FNS.aces === 'acesFilmicToneMapping');
    t.ok('neutral present', TONE_MAP_FNS.neutral === 'neutralToneMapping');
    t.ok(
      'every name resolves to a fn or null',
      TONE_MAP_NAMES.every((n) => n in TONE_MAP_FNS)
    );
    t.ok('none is first (the safe default in an enum list)', TONE_MAP_NAMES[0] === 'none');
  }

  // ---- presets are data -----------------------------------------------------
  {
    t.ok('none is the identity', rgbClose(applyGrade([0.4, 0.6, 0.2], gradePreset('none')), [0.4, 0.6, 0.2]));
    const noir = applyGrade([0.8, 0.2, 0.2], gradePreset('noir'));
    t.ok('noir is greyscale', close(noir[0], noir[1], 1e-9) && close(noir[1], noir[2], 1e-9));
    t.ok(
      'an unknown preset falls back to identity',
      rgbClose(applyGrade([0.4, 0.6, 0.2], gradePreset('nonsense')), [0.4, 0.6, 0.2])
    );
    t.ok(
      'every preset yields finite output',
      Object.keys(GRADE_PRESETS).every((n) => applyGrade([0.5, 0.5, 0.5], gradePreset(n)).every(Number.isFinite))
    );
  }

  // ========================================================================
  // THE TSL PATH agrees with the JS path — through a numeric TSL stub, so the
  // shader and a CPU preview cannot diverge (the wind-access.js discipline).
  // ========================================================================
  {
    const S = makeNumericTsl();
    const evalNode = (c, params) => {
      const p = { ...IDENTITY_GRADE, ...params };
      const u = {
        exposure: S.float(p.exposure),
        contrast: S.float(p.contrast),
        saturation: S.float(p.saturation),
        vibrance: S.float(p.vibrance),
        temperature: S.float(p.temperature),
        tint: S.float(p.tint),
        lift: S.vec3(...p.lift),
        gamma: S.vec3(...p.gamma),
        gain: S.vec3(...p.gain),
      };
      const out = buildGradeNode(S, S.vec3(...c), u);
      return [out.x, out.y, out.z];
    };
    for (const params of [
      {},
      { saturation: 0.3 },
      { exposure: 0.5, contrast: 1.3 },
      { temperature: 0.4, tint: -0.2 },
      { lift: [0.02, 0, 0.03], gamma: [1.1, 1, 0.9], gain: [1.05, 1, 0.95] },
      { saturation: 0.5, contrast: 0.8, temperature: -0.3, exposure: -0.2 },
      { vibrance: 0.5 },
      { vibrance: -0.4, saturation: 1.2 },
      { vibrance: 0.6, contrast: 1.1, temperature: 0.2 },
    ]) {
      for (const c of [
        [0.6, 0.3, 0.2],
        [0.1, 0.5, 0.8],
        [0.9, 0.9, 0.9],
      ]) {
        t.ok(
          `TSL matches JS for ${JSON.stringify(params)} on ${c}`,
          rgbClose(evalNode(c, params), applyGrade(c, params), 1e-5)
        );
      }
    }
  }

  // ========================================================================
  // THE TAIL (tone-map + LUT), Look scope only — regression coverage for a bug
  // that shipped live: `buildGradeNode` called `TSL.texture3D(tail.lutTexture,
  // uv)` on a value that is ALREADY a built texture NODE (grade-present.js
  // builds it once via `TSL.texture3D(lutTexture)`), not a raw THREE.Texture.
  // A node has no `.isTexture`, so three's real NodeBuilder threw "expects a
  // valid instance of THREE.Texture()" on every single compile — present-pass
  // fatal, every session, from the first frame. The numeric stub above never
  // caught it because its old guard was `tail.lutTexture && tail.lutStrength &&
  // TSL.texture3D` — the stub has no `texture3D`, so the whole branch was
  // silently skipped, not exercised. This block gives `lutTexture` a fake node
  // with `.sample()` (what the fixed code actually calls) so a future
  // regression to "wrap it in texture3D again" fails a Node test instead of
  // shipping straight to a live black screen.
  {
    const S = makeNumericTsl();
    const identityLutNode = { sample: (uv) => ({ rgb: uv }) };
    const u = {
      exposure: S.float(IDENTITY_GRADE.exposure),
      contrast: S.float(IDENTITY_GRADE.contrast),
      saturation: S.float(IDENTITY_GRADE.saturation),
      vibrance: S.float(IDENTITY_GRADE.vibrance),
      temperature: S.float(IDENTITY_GRADE.temperature),
      tint: S.float(IDENTITY_GRADE.tint),
      lift: S.vec3(...IDENTITY_GRADE.lift),
      gamma: S.vec3(...IDENTITY_GRADE.gamma),
      gain: S.vec3(...IDENTITY_GRADE.gain),
    };
    for (const c of [
      [0.6, 0.3, 0.2],
      [0.1, 0.5, 0.8],
      [0.9, 0.9, 0.9],
    ]) {
      // identity primaries + toneMapping 'none' + an identity-sampling LUT at
      // full strength must be a total no-op — an OETF/EOTF bracket around an
      // identity sample is a mathematical identity regardless of the curve.
      const out = buildGradeNode(S, S.vec3(...c), u, {
        toneMapping: 'none',
        lutTexture: identityLutNode,
        lutStrength: S.float(1),
      });
      t.ok(`tail with identity LUT is a no-op for ${c}`, rgbClose([out.x, out.y, out.z], c, 1e-5));
    }
    // lutStrength 0 must also be a no-op even with a NON-identity sampler —
    // proves the strength mix actually gates the LUT rather than always
    // applying it.
    const wrongLutNode = { sample: () => ({ rgb: S.vec3(0, 0, 0) }) };
    const out0 = buildGradeNode(S, S.vec3(0.5, 0.4, 0.3), u, {
      toneMapping: 'none',
      lutTexture: wrongLutNode,
      lutStrength: S.float(0),
    });
    t.ok('lutStrength 0 ignores the LUT', rgbClose([out0.x, out0.y, out0.z], [0.5, 0.4, 0.3], 1e-5));
  }
}

/**
 * A tiny numeric TSL stub — enough of the node API `buildGradeNode` uses to
 * evaluate it as plain arithmetic. Each "node" is a {x,y,z} (or scalar via .x)
 * carrying real numbers; the chainable methods do the maths immediately.
 */
function makeNumericTsl() {
  const asVec = (v) => (typeof v === 'number' ? { x: v, y: v, z: v } : v);
  const mk = (x, y, z) => {
    const self = {
      x,
      y,
      z,
      add: (o) => vecOp(self, o, (a, b) => a + b),
      sub: (o) => vecOp(self, o, (a, b) => a - b),
      mul: (o) => vecOp(self, o, (a, b) => a * b),
      div: (o) => vecOp(self, o, (a, b) => a / b),
      length: () => {
        const len = Math.hypot(self.x, self.y, self.z);
        return mk(len, len, len);
      },
      clamp: (lo, hi) => mk(clampN(self.x, lo, hi), clampN(self.y, lo, hi), clampN(self.z, lo, hi)),
    };
    return self;
  };
  const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const vecOp = (a, b, f) => {
    const bv = asVec(typeof b === 'object' && 'x' in b ? b : { x: b, y: b, z: b });
    return mk(f(a.x, bv.x), f(a.y, bv.y), f(a.z, bv.z));
  };
  // vec3() may be built from plain numbers OR from scalar NODES (e.g.
  // `vec3(float(1).add(...), ...)`); a scalar node carries its value in `.x`,
  // so pull that out — the bug the first cut of this stub had.
  const scalarOf = (v) => (typeof v === 'number' ? v : v.x);
  return {
    float: (v) => mk(v, v, v),
    vec3: (a, b, c) =>
      b === undefined ? mk(scalarOf(a), scalarOf(a), scalarOf(a)) : mk(scalarOf(a), scalarOf(b), scalarOf(c)),
    max: (a, b) => {
      const av = asVec(a);
      const bv = asVec(b);
      return mk(Math.max(av.x, bv.x), Math.max(av.y, bv.y), Math.max(av.z, bv.z));
    },
    pow: (a, b) => {
      const av = asVec(a);
      const bv = asVec(b);
      return mk(Math.pow(av.x, bv.x), Math.pow(av.y, bv.y), Math.pow(av.z, bv.z));
    },
    mix: (a, b, tt) => {
      const av = asVec(a);
      const bv = asVec(b);
      const tv = asVec(tt);
      return mk(av.x + (bv.x - av.x) * tv.x, av.y + (bv.y - av.y) * tv.y, av.z + (bv.z - av.z) * tv.z);
    },
    dot: (a, b) => {
      const av = asVec(a);
      const bv = asVec(b);
      const d = av.x * bv.x + av.y * bv.y + av.z * bv.z;
      return mk(d, d, d);
    },
    // Exact inverses (a real gamma curve, not identity) — enough to prove the
    // LUT tail's OETF→sample→EOTF bracket round-trips correctly around an
    // identity sample, without needing the real sRGB piecewise curve.
    sRGBTransferOETF: (v) => {
      const av = asVec(v);
      return mk(Math.pow(av.x, 1 / 2.2), Math.pow(av.y, 1 / 2.2), Math.pow(av.z, 1 / 2.2));
    },
    sRGBTransferEOTF: (v) => {
      const av = asVec(v);
      return mk(Math.pow(av.x, 2.2), Math.pow(av.y, 2.2), Math.pow(av.z, 2.2));
    },
  };
}
