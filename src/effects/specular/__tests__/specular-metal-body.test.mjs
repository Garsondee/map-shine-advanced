/**
 * specular-metal-body.test.mjs — the METAL BODY round (2026-11-02, mmp-9nb).
 *
 * Author: *"consider two new features that would improve the appearance of
 * metallic surfaces… I only want a single colour mask… consider water
 * specularity… so that both surfaces agree on the correct response curve."*
 *
 * What is pinned here, and why each matters on screen:
 *   1. The five new controls exist, sit in a real Studio category, and their
 *      schema default equals the render module's own default (two copies of one
 *      number; only a test keeps them together).
 *   2. `outdoorGlintResponse` follows the SAME cloud term as water's sun glint,
 *      and never touches night (lamp-lit metal outdoors must keep its glints).
 *   3. The sky handle's new `clear01`/`day01` really are the two factors of
 *      `key.strength` — the number water's glint is driven by.
 *   4. The material builds, exposes every new setter, clamps them, and its
 *      relief taps follow a mask swap.
 *   5. BOTH subsystems (floor and tile) forward every new param and the sky
 *      response — a param missing from a cache key is applied once and then
 *      never again, with no error anywhere.
 *
 * What it does NOT prove: anything about pixels. The look was judged in
 * `tools/shader-lab/specular-lab.html` (real mask, real art) and in a private
 * Foundry; this file keeps the wiring honest.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from '../../../../src/vendor/three/three.webgpu.js';
import { buildWorldSpaceOutdoorsGate } from '../../lighting/environmental-light.js';
import { createSkyHandle } from '../../sky-access.js';
import { CATEGORY_ORDER } from '../../../ui/widgets/param-groups.js';
import { SPECULAR_PARAMS } from '../specular.js';
import {
  buildSpecularSurfaceMaterial,
  SPECULAR_DEFAULT_RELIEF_STRENGTH,
  SPECULAR_DEFAULT_RELIEF_WIDTH_PX,
  SPECULAR_DEFAULT_MIRROR_DEPTH,
  SPECULAR_DEFAULT_GLINT_FOCUS,
  SPECULAR_DEFAULT_HOT_CORE,
  SPECULAR_DEFAULT_COLOUR_RESPONSE,
} from '../specular-render.js';
import { outdoorGlintResponse, SPECULAR_OVERCAST_GLINT } from '../specular-material.js';

const NEW_PARAMS = {
  reliefStrength: SPECULAR_DEFAULT_RELIEF_STRENGTH,
  reliefWidthPx: SPECULAR_DEFAULT_RELIEF_WIDTH_PX,
  mirrorDepth: SPECULAR_DEFAULT_MIRROR_DEPTH,
  glintFocus: SPECULAR_DEFAULT_GLINT_FOCUS,
  hotCore: SPECULAR_DEFAULT_HOT_CORE,
  colourResponse: SPECULAR_DEFAULT_COLOUR_RESPONSE,
};

function stubTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

export function run(t) {
  const { ok } = t;

  // ── 1. THE CONTROLS ──────────────────────────────────────────────────────
  for (const [key, renderDefault] of Object.entries(NEW_PARAMS)) {
    const p = SPECULAR_PARAMS[key];
    ok(`${key}: declared in SPECULAR_PARAMS`, !!p);
    if (!p) continue;
    ok(`${key}: schema default equals the render module default`, p.default === renderDefault);
    ok(`${key}: default sits inside its own range`, p.min <= p.default && p.default <= p.max);
    ok(`${key}: its category is a real Studio group`, CATEGORY_ORDER.includes(p.category));
    ok(`${key}: it has help text a GM can read`, typeof p.help === 'string' && p.help.length > 60);
  }
  // The two features ship ON — the old purely-additive look is mirror 0 /
  // relief 0, and leaving them off by default would ship nothing.
  ok('mirror depth ships on', SPECULAR_PARAMS.mirrorDepth.default > 0);
  ok('edge relief ships on', SPECULAR_PARAMS.reliefStrength.default > 0);
  ok('mirror depth can be turned fully off (the old look)', SPECULAR_PARAMS.mirrorDepth.min === 0);
  ok('edge relief can be turned fully off (the old look)', SPECULAR_PARAMS.reliefStrength.min === 0);
  // 11840 px gave a 1500 px treasure ONE flat blob of shimmer (lab, 2026-11-02).
  ok('the pattern is now smaller than a big treasure tile', SPECULAR_PARAMS.patternScalePx.default <= 4000);

  // ── 2. THE SKY RESPONSE ──────────────────────────────────────────────────
  const clear = outdoorGlintResponse({ clear01: 1, day01: 1 });
  ok('clear day: glints untouched', clear.gain === 1 && clear.broaden === 0);
  const overcast = outdoorGlintResponse({ clear01: 0, day01: 1 });
  ok('overcast day: glints fall to the overcast floor', near(overcast.gain, SPECULAR_OVERCAST_GLINT));
  ok('overcast day: and broaden fully into a satin', overcast.broaden === 1);
  ok(
    'the overcast floor is a real reduction, never a kill',
    SPECULAR_OVERCAST_GLINT > 0 && SPECULAR_OVERCAST_GLINT < 1
  );
  const night = outdoorGlintResponse({ clear01: 0, day01: 0 });
  ok('overcast NIGHT: untouched — lamps light outdoor metal at night', night.gain === 1 && night.broaden === 0);
  const half = outdoorGlintResponse({ clear01: 0.5, day01: 1 });
  ok('half cloud sits between clear and overcast', half.gain < 1 && half.gain > overcast.gain);
  ok('no sky handle at all reads as a clear sky (fail open, never dark)', outdoorGlintResponse(null).gain === 1);
  // Monotone: more cloud never brightens a glint.
  let mono = true;
  let last = 2;
  for (let c = 0; c <= 1.0001; c += 0.05) {
    const g = outdoorGlintResponse({ clear01: 1 - c, day01: 1 }).gain;
    if (g > last + 1e-12) mono = false;
    last = g;
  }
  ok('more cloud never brightens a glint', mono);

  // ── 3. THE SKY HANDLE'S NEW FIELDS ───────────────────────────────────────
  const NOON = { elevationDeg: 70, azimuthDeg: 180, dayFactor01: 1, skyFactor01: 1 };
  const DUSK = { elevationDeg: 4, azimuthDeg: 270, dayFactor01: 0.3, skyFactor01: 0.6 };
  for (const [label, sun] of [
    ['noon', NOON],
    ['dusk', DUSK],
  ]) {
    for (const cloud of [0, 0.4, 1]) {
      const sky = createSkyHandle({ sun, weather: { cloudCover01: cloud } });
      ok(`${label}, cloud ${cloud}: clear01 = 1 − cloud`, near(sky.clear01, 1 - cloud));
      ok(
        `${label}, cloud ${cloud}: key.strength = day01 × clear01 — the SAME term water's glint follows`,
        near(sky.key.strength, sky.day01 * sky.clear01)
      );
    }
  }

  // ── 4. THE MATERIAL ──────────────────────────────────────────────────────
  const { uniform, vec4, float } = THREE.TSL;
  const builtArgs = {
    THREE,
    maskTexture: stubTexture(),
    islandPackTexture: stubTexture(),
    illumTexture: stubTexture(),
    depthTexture: stubTexture(),
    timeMsNode: uniform(float(0)),
    uViewRect: uniform(vec4(0, 0, 100, 100)),
    uOutdoorsRect: uniform(vec4(0, 0, 100, 100)),
    outdoorsTexNode: THREE.TSL.texture(stubTexture()),
    buildOutdoorsGate: buildWorldSpaceOutdoorsGate,
  };
  let built = null;
  let err = null;
  try {
    built = buildSpecularSurfaceMaterial(builtArgs);
  } catch (e) {
    err = e;
  }
  ok(`the material builds with relief + mirror in the graph (${err ? err.message : 'clean'})`, err === null);
  if (!built) return;
  for (const key of Object.keys(NEW_PARAMS)) {
    const setter = `set${key[0].toUpperCase()}${key.slice(1)}`;
    ok(`the material exposes ${setter}`, typeof built[setter] === 'function');
  }
  ok('the material exposes setSkyGlint', typeof built.setSkyGlint === 'function');
  let threw = false;
  try {
    built.setMirrorDepth(5);
    built.setHotCore(-1);
    built.setGlintFocus(0);
    built.setReliefWidthPx(0);
    built.setSkyGlint({ gain: 7, broaden: -3 });
    built.setSkyGlint(null);
  } catch {
    threw = true;
  }
  ok('every new setter tolerates out-of-range input without throwing', !threw);
  ok('relief reads the mask through its own four taps', built.reliefTapNodes.length === 4);
  // Tier 0 has no shimmer, so nothing for the mirror to leave dark between:
  // the whole body must compile OUT there, not darken every metal pixel flat.
  const tier0 = buildSpecularSurfaceMaterial({ ...builtArgs, tier: 0 });
  ok('tier 0: the metal body compiles out (no relief taps at all)', tier0.reliefTapNodes.length === 0);
  const swapped = stubTexture();
  built.setMaskTexture(swapped);
  ok(
    'a mask swap reaches every relief tap, not just the main read',
    built.maskTexNode.value === swapped && built.reliefTapNodes.every((n) => n.value === swapped)
  );
  ok(
    'the shine is premultiplied — the darkening rides in alpha',
    built.specularMaterial.blendDst === THREE.OneMinusSrcAlphaFactor &&
      built.specularMaterial.blendSrc === THREE.OneFactor
  );
  ok('…and destination alpha is still left alone', built.specularMaterial.blendDstAlpha === THREE.OneFactor);

  // ── 5. BOTH SUBSYSTEMS FORWARD IT ALL ────────────────────────────────────
  // Source-level, deliberately: the params cache key is an early-out, and a
  // param pushed but missing from the key (or keyed but never pushed) fails
  // silently after the first frame. Each file must carry BOTH halves.
  for (const file of ['specular-surface-subsystem.js', 'specular-tile-surface-subsystem.js']) {
    const src = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
    for (const key of Object.keys(NEW_PARAMS)) {
      const setter = `set${key[0].toUpperCase()}${key.slice(1)}(p.${key})`;
      ok(`${file}: ${key} is in the params cache key`, new RegExp(`^\\s*p\\.${key},\\s*$`, 'm').test(src));
      ok(`${file}: ${key} is pushed to the material`, src.includes(setter));
    }
    ok(`${file}: pushes the sky response`, src.includes('outdoorGlintResponse(sky)'));
    ok(`${file}: its sky cache key changes with the cloud`, src.includes('${sky.clear01}|${sky.day01}'));
  }
}
