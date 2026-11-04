/**
 * THE ALCHEMY (`fluid-alchemy.js`) — reactions, palette, host gate, light anchors and light descriptors. Pure,
 * so every claim the module's header makes is checked here rather than by looking at a screenshot.
 */
import {
  fluidPalette,
  createFluidReactionState,
  fluidReactionAt,
  fluidSlotEvent,
  fluidReactionPersonality,
  forceFluidReaction,
  writeFluidTubeTick,
  computeFluidHostGate,
  fluidLightAnchors,
  createFluidLightTwin,
  stepFluidLightTwin,
  buildFluidLightSources,
  FLUID_REACTION_KINDS,
  FLUID_TUBE_TEXELS,
  FLUID_TRICKLE,
} from '../fluid-alchemy.js';
import { extractTubeNet } from '../fluid-net.js';

function grid(w, h, fill) {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (fill(x, y)) data[y * w + x] = 200;
  return { spec: { x: 0, y: 0, width: w * 10, height: h * 10, w, h, texelW: 10, texelH: 10 }, data };
}

export function run(t) {
  const { ok } = t;

  // ── PALETTE ────────────────────────────────────────────────────────────
  {
    const a = [0.1, 0.9, 0.7];
    const b = [0.6, 0.3, 1];
    ok('variety 0 → one reagent', fluidPalette(a, b, 0).count === 1);
    ok('variety 0.3 → two reagents', fluidPalette(a, b, 0.3).count === 2);
    ok('variety 1 → four reagents', fluidPalette(a, b, 1).count === 4);
    const p = fluidPalette(a, b, 1);
    ok(
      'always four colour slots, all finite 0..1',
      p.colors.length === 4 && p.colors.flat().every((c) => Number.isFinite(c) && c >= 0 && c <= 1)
    );
    ok('slot 0 is the tint, slot 1 the accent', p.colors[0] === a && p.colors[1] === b);
  }

  // ── REACTIONS ──────────────────────────────────────────────────────────
  {
    const calm = createFluidReactionState(1)[0];
    let quiet = true;
    for (let s = 0; s < 120; s += 0.5) {
      const r = fluidReactionAt(s, calm, 0);
      if (r.kind || r.qMul !== 1 || r.reagent !== 0 || r.mood !== 1) quiet = false;
    }
    ok('chaos 0 is a calm, steady flow — no reaction in two minutes', quiet);

    const p = fluidReactionPersonality(3);
    ok(
      'slot events are deterministic',
      JSON.stringify(fluidSlotEvent(17, p, 0.7)) === JSON.stringify(fluidSlotEvent(17, p, 0.7))
    );

    const st = createFluidReactionState(1)[0];
    const kinds = new Set();
    let minQ = Infinity;
    let finite = true;
    let lastReagent = -1;
    let reagentMonotone = true;
    for (let s = 0; s < 600; s += 1 / 30) {
      const r = fluidReactionAt(s, st, 1);
      if (r.kind) kinds.add(r.kind);
      minQ = Math.min(minQ, r.qMul);
      if (![r.qMul, r.reagent, r.energy, r.froth, r.agitation, r.mood].every(Number.isFinite)) finite = false;
      if (r.reagent + 1e-9 < lastReagent && lastReagent < 100) reagentMonotone = false;
      lastReagent = r.reagent;
    }
    ok(
      `chaos 1 shows every kind of reaction in ten minutes (saw ${[...kinds].join(',')})`,
      FLUID_REACTION_KINDS.every((k) => kinds.has(k))
    );
    ok('every output stays finite', finite);
    ok(`the pump is never fully stopped (min qMul ${minQ.toFixed(3)})`, minQ > 0);
    ok('the reagent only ever steps forward (until its wrap)', reagentMonotone);
    ok('ten minutes of chaos transmute many times', lastReagent >= 5);

    // The running count is exactly what a fresh recount gives.
    const fresh = createFluidReactionState(1)[0];
    const a = fluidReactionAt(431.7, st, 1);
    const b = fluidReactionAt(431.7, fresh, 1);
    ok('incremental transmute count == full recount', Math.abs(a.reagent - b.reagent) < 1e-9);
  }

  // ── PHOTOSENSITIVITY: brightness drivers change smoothly frame to frame ─
  {
    const st = createFluidReactionState(4);
    let maxStep = 0;
    for (const s0 of st) {
      let prev = null;
      for (let s = 0; s < 300; s += 1 / 60) {
        const r = fluidReactionAt(s, s0, 1);
        if (prev) maxStep = Math.max(maxStep, Math.abs(r.mood - prev.mood), Math.abs(r.energy - prev.energy) / 3);
        prev = r;
      }
    }
    ok(`no brightness driver jumps between two 60 Hz frames (max step ${maxStep.toFixed(3)})`, maxStep < 0.2);
  }

  // ── FORCED REACTIONS ───────────────────────────────────────────────────
  {
    const st = createFluidReactionState(1)[0];
    const before = fluidReactionAt(10, st, 0).reagent;
    ok('an unknown kind is refused', forceFluidReaction(st, 'explode', 10) === false);
    ok('a known kind is accepted', forceFluidReaction(st, 'transmute', 10) === true);
    const mid = fluidReactionAt(10.4, st, 0).reagent;
    let after = 0;
    for (let s = 10.5; s < 16; s += 0.1) after = fluidReactionAt(s, st, 0).reagent;
    ok(`a forced transmute ramps the reagent (${before} → ${mid.toFixed(2)})`, mid > before && mid < before + 1);
    ok(`... and settles exactly one step on (${after})`, Math.abs(after - (before + 1)) < 1e-9);
    const st2 = createFluidReactionState(1)[0];
    forceFluidReaction(st2, 'stall', 5);
    ok('a forced stall slows the pump', fluidReactionAt(6.2, st2, 0).qMul < 0.3);
  }

  // ── THE PER-TICK UPLOAD ────────────────────────────────────────────────
  {
    const tubes = [{ lengthPx: 1000, crossSectionProfile: new Float64Array(16).fill(20) }];
    const reactions = createFluidReactionState(1);
    const tubeData = new Float32Array(FLUID_TUBE_TEXELS * 4);
    const pumpData = new Float32Array([2000, 0, 1000, 1]);
    writeFluidTubeTick({ tubeData, pumpData, tubes, reactions, tSec: 1, dtSec: 0.5, chaos: 0, flowSpeed: 1.5 });
    ok('Q is scaled by the flow speed', Math.abs(pumpData[0] - 3000) < 1e-6);
    ok(`a gap still carries a trickle (inject ${pumpData[1]})`, Math.abs(pumpData[1] - FLUID_TRICKLE) < 1e-6);
    ok('travel = Q / mean area × dt', Math.abs(tubeData[4] - (3000 / 20) * 0.5) < 1e-3);
    ok('length rides in texel 1', tubeData[5] === 1000);
    ok('mood rides in texel 1 (calm = 1)', tubeData[7] === 1);
  }

  // ── THE HOST GATE ──────────────────────────────────────────────────────
  {
    const w = 9;
    const h = 1;
    const px = [
      [0, 0, 0, 0], // empty
      [0, 0, 0, 0],
      [150, 150, 140, 255], // pale glass paint
      [150, 150, 140, 255],
      [150, 150, 140, 255],
      [150, 150, 140, 255],
      [150, 150, 140, 255],
      [20, 20, 20, 255], // ink
      [200, 150, 40, 255], // brass
    ];
    const rgba = new Uint8ClampedArray(px.flat());
    const g = computeFluidHostGate(rgba, w, h);
    ok('no paint → the goo shows fully', g[0] === 255);
    ok(`pale glass paint lets the goo through (${g[4]})`, g[4] > 200);
    ok(`ink hides it (${g[7]})`, g[7] < 20);
    ok(`brass hides it (${g[8]})`, g[8] < 40);
    ok(`the open area is eroded one texel next to the ink (${g[6]})`, g[6] < 20);
  }

  // ── LIGHT ANCHORS + LIGHTS ─────────────────────────────────────────────
  {
    const net = extractTubeNet({
      grid: grid(200, 20, (x, y) => x >= 5 && x < 195 && y >= 8 && y < 12),
      samplesPerTube: 64,
    });
    const corners = [
      { x: 0, y: 0 },
      { x: 2000, y: 0 },
      { x: 2000, y: 200 },
      { x: 0, y: 200 },
    ];
    const anchors = fluidLightAnchors(net, corners, 6);
    ok(`anchors exist and respect the cap (${anchors.length})`, anchors.length > 0 && anchors.length <= 6);
    ok(
      'anchors sit on the tube, inside the quad',
      anchors.every((a) => a.x > 0 && a.x < 2000 && Math.abs(a.y - 100) < 30)
    );
    const twin = createFluidLightTwin(net);
    const pal = fluidPalette([0.1, 0.9, 0.7], [0.6, 0.3, 1], 0.5);
    ok(
      'no light while the tube is empty',
      buildFluidLightSources({ itemId: 'i', anchors, twin, palette: pal, strength: 1 }).length === 0
    );
    const pump = new Float32Array([5000, 1, net.tubes[0].lengthPx, 1]);
    const tube = new Float32Array([0, 1, 0.5, 1, 0, net.tubes[0].lengthPx, 0, 1]);
    for (let i = 0; i < 600; i++) stepFluidLightTwin(twin, pump, tube, 1 / 30);
    const lights = buildFluidLightSources({ itemId: 'i', anchors, twin, palette: pal, strength: 1 });
    ok(`a full tube lights every anchor (${lights.length})`, lights.length === anchors.length);
    ok(
      'luminosity stays under 0.5 (tints, never whitens)',
      lights.every((l) => l.luminosity01 < 0.5)
    );
    ok(
      'every light is finite and fluid-owned',
      lights.every(
        (l) => l.ownerEffectId === 'fluid' && [l.x, l.y, l.radius, l.alpha01, ...l.color].every(Number.isFinite)
      )
    );
    ok(
      'strength 0 → no lights',
      buildFluidLightSources({ itemId: 'i', anchors, twin, palette: pal, strength: 0 }).length === 0
    );
  }
}
