/**
 * Node verification for THE SOFT FOG FIELD (2026-11-02, `vision-mask-render.js`).
 *
 * The author asked for a fog that is beautiful: soft edges, fades, slow motion. Law 7 asks that none
 * of it ever shows a player more than the hard rule allows. The numbers half of this file pins the
 * blur kernel; the source half pins the few lines that make every softening a DARKENING of what is
 * already revealed (a TSL graph cannot run in Node, so the guards read the shader source, the same way
 * other render modules here are guarded).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fogSoftWeights, fogSoftStepUv, FOG_SOFT_TAPS } from '../vision-mask-render.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8').replace(/\r\n/g, '\n');
const renderSrc = read('../vision-mask-render.js');
const presentSrc = read('../../grade/grade-present.js');
const viewerSrc = read('../../../vt/vt-pan-viewer.js');

/** The body of `export function <name>(` up to the next top-level `\n}\n`. */
function fnBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end < 0 ? undefined : end);
}

export function run(t) {
  const { ok } = t;

  // ── The kernel ─────────────────────────────────────────────────────────
  const w = fogSoftWeights();
  ok('kernel: one weight per tap from the centre out', w.length === FOG_SOFT_TAPS + 1);
  const total = w[0] + 2 * w.slice(1).reduce((a, b) => a + b, 0);
  ok('kernel: the 2*TAPS+1 weights sum to 1 (a blurred full field stays exactly 1)', Math.abs(total - 1) < 1e-9);
  ok(
    'kernel: weights fall away from the centre',
    w.every((x, i) => i === 0 || x < w[i - 1])
  );
  ok('step: a wider band spaces the taps further apart', fogSoftStepUv(40, 1600) > fogSoftStepUv(10, 1600));
  ok('step: the same band is a smaller UV step on a wider frame', fogSoftStepUv(20, 3200) < fogSoftStepUv(20, 1600));
  ok('step: never zero or negative, even for a zero-wide band', fogSoftStepUv(0, 1600) > 0);

  // ── Law 7: softening only ever darkens what is revealed ─────────────────
  const vis = fnBody(renderSrc, 'sampleFogVisibility');
  ok('visibility: the hard rule is evaluated (buildRevealedNode)', vis.includes('buildRevealedNode('));
  ok('visibility: the inked v is multiplied by the hard rule', /let v = [^;]*\.mul\(hard\);/.test(vis));
  ok(
    'visibility: the plain v (what memory records) is multiplied by the hard rule',
    /const vPlain = [^;]*\.mul\(hard\);/.test(vis)
  );
  ok('visibility: the reveal fade can only lower v (min)', /v = TSL\.min\(v, history\)/.test(vis));
  ok(
    'band: only the part of the field ABOVE 0.5 is used (a straight edge reads 0.5 exactly at the polygon)',
    /soft\.sub\(0\.5\)\.mul\(2\)\.clamp\(0, 1\)/.test(fnBody(renderSrc, 'fogBandT'))
  );
  ok(
    'ink: erodes by raising the threshold (t - bite), never lowering it',
    /return t\s*\.sub\(bite\)/.test(fnBody(renderSrc, 'inkErode')) &&
      !/return t\s*\.add\(/.test(fnBody(renderSrc, 'inkErode'))
  );
  const hist = fnBody(renderSrc, 'buildVisionRevealHistoryMaterial');
  ok(
    'reveal fade: history never rises above current sight (min with vPlain)',
    /min\(prev\.add\([^;]*, vPlain\)/.test(hist)
  );
  ok('reveal fade: off screen the history is left as it was', /select\(onScreen, eased, prev\)/.test(hist));
  const gate = fnBody(renderSrc, 'buildVisionGateMaterial');
  ok(
    'gate: the multiply factor is the soft visibility times the door fade',
    /const factor = visible\.mul\(revealFactor\)/.test(gate)
  );
  ok('gate: without a field it is the old boolean, unchanged', /select\(revealed, float\(1\), float\(0\)\)/.test(gate));
  const cover = fnBody(renderSrc, 'buildVisionCoveragePublishMaterial');
  ok(
    'coverage: memory records the plain visibility, faded at the frame edge',
    /const cover = vPlain\.mul\(onScreen\)/.test(cover)
  );
  ok('coverage: MAX blending, so memory only grows', /blendEquation = THREE\.MaxEquation/.test(cover));

  // ── The grey sawtooth's cause stays gone ────────────────────────────────
  ok(
    'viewer: the sight fans are no longer rasterised into the explored buffer (their staircase was the grey fringe)',
    !viewerSrc.includes('renderer.render(visionDraw.scene, exploredDraw.camera)')
  );
  ok(
    'viewer: the field is built at the head of the gate pass',
    /renderFogField\(\);\n\s*renderer\.setRenderTarget\(sceneLit\);/.test(viewerSrc)
  );
  ok(
    'viewer: the reveal fade runs on real time, not the game clock (a paused game still finishes a reveal)',
    /const now = perfNowMs\(\);\s*const dt = fogRevealLastMs/.test(viewerSrc)
  );

  // ── The present ─────────────────────────────────────────────────────────
  ok(
    'present: live mixes into memory x remembered by the same field',
    presentSrc.includes('mix(memoryShot.mul(fog.e), shot, fog.v)')
  );
  ok(
    'present: grid lines fade with the fog (never over the unknown)',
    /gridAlpha = gridAlpha\.mul\(keep\)/.test(presentSrc) &&
      /fog\.v\.add\(float\(1\)\.sub\(fog\.v\)\.mul\(fog\.e\)/.test(presentSrc)
  );
}
