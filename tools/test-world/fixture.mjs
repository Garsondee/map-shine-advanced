/**
 * tools/test-world/fixture.mjs — the MSA Test World, as data (mmp-f0k.4).
 *
 * Pure: plain objects in, plain objects out, Node-tested. `make-test-world.mjs`
 * turns these into real Foundry documents through a GM client.
 *
 * Every document this fixture creates carries `flags['map-shine-advanced'].testFixtureId`, so seeding is
 * idempotent (an existing id is updated, never duplicated) and nothing else in a
 * world is ever touched.
 *
 * The test users' passwords are FIXTURE values for private local rigs only. They
 * are not secrets and must never be reused anywhere real.
 */

export const FIXTURE_VERSION = 2;

/** Test users: one GM already exists in every world; these are the players. */
export const TEST_USERS = Object.freeze([
  Object.freeze({ id: 'player1', name: 'Player1', role: 1, password: 'msa-test-player1' }),
  Object.freeze({ id: 'player2', name: 'Player2', role: 1, password: 'msa-test-player2' }),
]);

/** The Foundry light animation types MSA ports today (effects/lighting/animations/registry.js). */
export const MSA_PORTED_ANIMATIONS = Object.freeze([
  'torch',
  'pulse',
  'chroma',
  'flame',
  'energy',
  'revolving',
  'siren',
  'wave',
  'fog',
  'sunburst',
  'dome',
  'emanation',
  'hexa',
  'ghost',
  'vortex',
  'witchwave',
  'rainbowswirl',
  'radialrainbow',
  'fairy',
  'grid',
  'starlight',
  'smokepatch',
]);

const GRID = 100;

/** Flat 50% grey floor art (sRGB 128): MSA needs floor art to start its viewer, and a flat
 * neutral floor is exactly what lighting-parity comparisons want. */
export const FLAT_GREY_SRC = 'modules/map-shine-advanced/assets/test-world/flat-grey-50.png';

/** A blank scene: flat grey, no art, a grid. Baseline for parity and lighting tests. */
export function blankScene() {
  return {
    name: 'MSA Test - Blank',
    width: 4000,
    height: 3000,
    padding: 0,
    backgroundColor: '#808080',
    background: { src: FLAT_GREY_SRC },
    grid: { size: GRID, type: 1, distance: 5, units: 'ft' },
    environment: { darknessLevel: 0, globalLight: { enabled: false } },
    flags: { 'map-shine-advanced': { testFixtureId: 'blank', version: FIXTURE_VERSION, enabled: true } },
  };
}

/**
 * The light matrix: one cell per animation type (every type Foundry offers, so
 * unported ones show up too) plus a row of static variants. Cells are spaced so
 * lights never overlap (radius < half the pitch), each labelled by a Drawing
 * text so a screenshot names what it shows.
 * @param {string[]} animationTypes - e.g. Object.keys(CONFIG.Canvas.lightAnimations)
 * @returns {{scene: object, lights: object[], labels: object[]}}
 */
export function lightMatrix(animationTypes) {
  const pitch = 800;
  const cols = 6;
  const statics = [
    { key: 'static-plain', config: { color: null, attenuation: 0.5, luminosity: 0.5 } },
    { key: 'static-warm', config: { color: '#ff9b40', attenuation: 0.5, luminosity: 0.5 } },
    { key: 'static-att0', config: { color: null, attenuation: 0, luminosity: 0.5 } },
    { key: 'static-att1', config: { color: null, attenuation: 1, luminosity: 0.5 } },
    { key: 'static-lum-high', config: { color: null, attenuation: 0.5, luminosity: 0.9 } },
    { key: 'static-negative', config: { color: null, attenuation: 0.5, luminosity: -0.5 } },
    // mmp-ynr.2 (2026-11-07): the light's own adjustments, which Foundry applies to the art under the light too
    // (its per-light background layer, mmp-ynr.7), and the coloration techniques (Foundry's ids, on a warm colour).
    { key: 'static-sat-grey', config: { color: null, attenuation: 0.5, luminosity: 0.5, saturation: -1 } },
    { key: 'static-sat-vivid', config: { color: '#ff9b40', attenuation: 0.5, luminosity: 0.5, saturation: 1 } },
    { key: 'static-contrast-up', config: { color: null, attenuation: 0.5, luminosity: 0.5, contrast: 1 } },
    { key: 'static-contrast-down', config: { color: null, attenuation: 0.5, luminosity: 0.5, contrast: -1 } },
    { key: 'static-shadows', config: { color: null, attenuation: 0.5, luminosity: 0.5, shadows: 1 } },
    { key: 'static-alpha-full', config: { color: '#ff9b40', attenuation: 0.5, luminosity: 0.5, alpha: 1 } },
    ...[0, 2, 3, 4, 7, 10].map((coloration) => ({
      key: `static-coloration-${coloration}`,
      config: { color: '#ff9b40', attenuation: 0.5, luminosity: 0.5, coloration },
    })),
  ];
  const cells = [
    ...statics.map((s) => ({ key: s.key, label: s.key, config: s.config, animation: null })),
    ...animationTypes.map((type) => ({
      key: `anim-${type}`,
      label: type + (MSA_PORTED_ANIMATIONS.includes(type) ? '' : ' (unported)'),
      config: { color: '#7fb2ff', attenuation: 0.5, luminosity: 0.5 },
      animation: { type, speed: 5, intensity: 5, reverse: false },
    })),
  ];
  const rows = Math.ceil(cells.length / cols);
  const width = cols * pitch;
  const height = rows * pitch;
  const lights = [];
  const labels = [];
  cells.forEach((c, i) => {
    const x = (i % cols) * pitch + pitch / 2;
    const y = Math.floor(i / cols) * pitch + pitch / 2;
    lights.push({
      x,
      y,
      config: { dim: 15, bright: 6, alpha: 0.5, ...c.config, ...(c.animation ? { animation: c.animation } : {}) },
      flags: { 'map-shine-advanced': { testFixtureId: c.key } },
    });
    labels.push({
      x: x - pitch / 2 + 20,
      y: y - pitch / 2 + 20,
      shape: { type: 'r', width: pitch - 40, height: 60 },
      text: c.label,
      fontSize: 36,
      textColor: '#ffffff',
      fillAlpha: 0,
      strokeAlpha: 0,
      flags: { 'map-shine-advanced': { testFixtureId: `label-${c.key}` } },
    });
  });
  const scene = {
    name: 'MSA Test - Light Matrix',
    width,
    height,
    padding: 0,
    backgroundColor: '#808080',
    background: { src: FLAT_GREY_SRC },
    grid: { size: GRID, type: 1, distance: 5, units: 'ft' },
    environment: { darknessLevel: 1, globalLight: { enabled: false } },
    flags: { 'map-shine-advanced': { testFixtureId: 'light-matrix', version: FIXTURE_VERSION, enabled: true } },
  };
  return { scene, lights, labels };
}

/**
 * The test maps the regime uses, by scene name in the rig world (they come from the
 * Mythica Machina map packs already installed there). Missing ones are reported.
 */
export const TEST_MAP_SCENES = Object.freeze([
  'Mythica Machina - Big Bank (MSA)',
  'Mythica Machina - Docklands Warehouse',
  'Mythica Machina - Clockwork Dungeon',
  "Mythica Machina - Mad Scientist's Compound",
  'Mythica Machina - Flooded River Prison (MSA)',
  'Mansion - Multifloor',
]);
