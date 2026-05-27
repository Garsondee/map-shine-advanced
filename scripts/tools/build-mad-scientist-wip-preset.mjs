#!/usr/bin/env node
/**
 * One-off builder: Mad Scientist Work in Progress preset from the-mad-scientists-lair.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const src = path.join(root, 'data/presets/the-mad-scientists-lair.json');
const dst = path.join(root, 'data/presets/mad-scientist-work-in-progress.json');

const preset = JSON.parse(fs.readFileSync(src, 'utf8'));

preset.id = 'mad-scientist-work-in-progress';
preset.name = 'Mad Scientist Work in Progress';
preset.description =
  "WIP lair preset (Gamma): v2-calibrated. Sepia off, toned lighting coloration + grade. Re-apply preset then v2 workflow scan.";

const mm = preset.settings.mapMaker.effects;
const lit = mm.lighting;

// v2 Beta scan: bus mapping solid (11/12). bus→lit +36, lit→grade +16. Green worst final lift.
lit.globalIllumination = 0.28;
lit.colorationStrength = 1.05;
lit.colorationSaturation = 1.15;
lit.colorationReflectivity = 1.02;
lit.colorationChromaCurve = 0.15;
lit.colorationAchromaticMix = 0.82;
lit.lightIntensity = 1.6;
lit.negativeDarknessStrength = 1.25;
lit.combinedShadowEffectStrength = 2.5;

const sky = mm['sky-color'];
sky.goldenStrength = 2.2;
sky.goldenPower = 2.25;
sky.goldenOutdoorRecolorStrength = 2;
sky.saturationBoost = 0.12;

const cc = mm.colorCorrection;
cc.masterGamma = 1.48;
cc.exposure = 0.8;
cc.saturation = 0.9;
cc.localWarmLightPreserve = 0.4;
cc.localTodOverrideExposure = 0.62;
cc.localTodOverrideSaturation = 1;
cc.localWarmEmissiveAdd = 0.18;

const capTint = (v) => (typeof v === 'number' ? Math.min(1.85, Math.max(0.55, v)) : v);
for (let i = 0; i <= 7; i++) {
  for (const ch of ['GlobalTintR', 'GlobalTintG', 'GlobalTintB']) {
    const key = `tod${i}${ch}`;
    if (cc[key] != null) cc[key] = capTint(cc[key]);
  }
}
cc.tod0GlobalTintB = 1.75;
cc.tod2GlobalTintR = 1.85;
cc.tod6GlobalTintR = 1.85;
cc.tod7GlobalTintB = 1.75;

mm.sepia.enabled = false;
mm.sepia.strength = 0;

fs.writeFileSync(dst, `${JSON.stringify(preset, null, 2)}\n`);
console.log(`Wrote ${path.relative(root, dst)}`);
