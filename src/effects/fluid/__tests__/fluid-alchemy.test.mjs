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
  FLUID_REAGENT_WRAP,
  FLUID_PALETTE_SLOTS,
  FLUID_CATALYST_STAGES,
  FLUID_DROUGHT_CHANCE,
  fluidReagentJump,
  fluidDroughtAt,
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
    ok('variety 0.15 → two reagents', fluidPalette(a, b, 0.15).count === 2);
    ok('variety 0.75 (default) → six reagents', fluidPalette(a, b, 0.75).count === 6);
    ok('variety 1 → eight reagents', fluidPalette(a, b, 1).count === 8);
    let wrapSafe = true;
    let monotone = true;
    let prev = 0;
    for (let v = 0; v <= 1.0001; v += 0.01) {
      const n = fluidPalette(a, b, v).count;
      if (FLUID_REAGENT_WRAP % n !== 0) wrapSafe = false;
      if (n < prev) monotone = false;
      prev = n;
    }
    ok('every palette size divides the reagent wrap (no seam at the wrap)', wrapSafe);
    ok('more variety never means fewer reagents', monotone);
    const p = fluidPalette(a, b, 1);
    ok(
      `always ${FLUID_PALETTE_SLOTS} colour slots, all finite 0..1`,
      p.colors.length === FLUID_PALETTE_SLOTS && p.colors.flat().every((c) => Number.isFinite(c) && c >= 0 && c <= 1)
    );
    ok('slot 0 is the tint, slot 1 the accent', p.colors[0] === a && p.colors[1] === b);
    // Round 3: the wild reagents are saturated (never pastel — a pale one clipped a flask white under the night
    // exposure) and spread round the wheel (a real range, not shades of the tint).
    const sat = (c) => (Math.max(...c) - Math.min(...c)) / Math.max(1e-6, Math.max(...c));
    const wild = p.colors.slice(2);
    ok(
      `wild reagents are saturated (min ${Math.min(...wild.map(sat)).toFixed(2)})`,
      wild.every((c) => sat(c) >= 0.8)
    );
    ok(
      `wild reagents are never near white (max channel peak ${Math.max(...wild.flat()).toFixed(2)})`,
      wild.every((c) => Math.max(...c) <= 0.87)
    );
    const hue = ([r, g, bb]) => {
      const mx = Math.max(r, g, bb);
      const d = mx - Math.min(r, g, bb);
      if (d < 1e-6) return 0;
      const h = mx === r ? ((g - bb) / d + 6) % 6 : mx === g ? (bb - r) / d + 2 : (r - g) / d + 4;
      return h / 6;
    };
    const sextants = new Set(wild.map((c) => Math.floor(hue(c) * 6)));
    ok(`wild reagents span the wheel (${sextants.size} of 6 hue sextants)`, sextants.size >= 4);
    ok(
      'the same authored colours always brew the same palette',
      JSON.stringify(fluidPalette(a, b, 1)) === JSON.stringify(fluidPalette([...a], [...b], 1))
    );
    ok(
      'different authored colours brew a different wild set',
      JSON.stringify(fluidPalette(a, b, 1).colors.slice(2)) !==
        JSON.stringify(fluidPalette([0.9, 0.2, 0.1], b, 1).colors.slice(2))
    );
  }

  // ── COLOUR JUMPS (round 3: "more unpredictable colour range") ──────────
  {
    let neverNull = true;
    const seen = new Set();
    for (let s = 0; s < 400; s++) {
      for (const n of [3, 4, 5, 6, 8]) {
        const j = fluidReagentJump(s * 7.3 + 1, n);
        if (j % n === 0 || j < 1 || j > 3) neverNull = false;
        if (n === 6) seen.add(j);
      }
    }
    ok('a jump is 1..3 and never a whole lap (every jump changes the colour)', neverNull);
    ok(`jumps vary (saw ${[...seen].sort().join(',')} with six reagents)`, seen.size === 3);
    ok('two reagents always jump by one (the only change there is)', fluidReagentJump(5, 2) === 1);
    // The sequence of colours is no longer a fixed cycle.
    const st = createFluidReactionState(1)[0];
    const seq = [];
    let last = -1;
    for (let s = 0; s < 900; s += 0.25) {
      const g = Math.round(fluidReactionAt(s, st, 1, 6).reagent);
      if (g !== last && Number.isInteger(fluidReactionAt(s, st, 1, 6).reagent)) {
        seq.push(g % 6);
        last = g;
      }
    }
    const steps = new Set();
    for (let i = 1; i < seq.length; i++) steps.add((seq[i] - seq[i - 1] + 6) % 6);
    ok(`colour changes take different-sized steps (${[...steps].sort().join(',')})`, steps.size >= 2);
  }

  // ── CATALYST: a cascade of colour fronts, then an aftershock ───────────
  {
    const st = createFluidReactionState(1)[0];
    const before = fluidReactionAt(20, st, 0, 6).reagent;
    ok('a catalyst can be forced', forceFluidReaction(st, 'catalyst', 20) === true);
    const total = st.forced.jumps.reduce((s, j) => s + j, 0);
    ok(`it carries ${FLUID_CATALYST_STAGES} jumps`, st.forced.jumps.length === FLUID_CATALYST_STAGES);
    // The reagent climbs in stages, not one ramp: sample between stages.
    const r1 = fluidReactionAt(20.5, st, 0, 6).reagent - before;
    const r2 = fluidReactionAt(21.05, st, 0, 6).reagent - before;
    const r3 = fluidReactionAt(21.6, st, 0, 6).reagent - before;
    ok(
      `the cascade climbs stage by stage (${r1.toFixed(2)} → ${r2.toFixed(2)} → ${r3.toFixed(2)} of ${total})`,
      r1 > 0 && r2 > r1 && r3 > r2
    );
    let peakE = 0;
    for (let s = 20; s < 22; s += 1 / 60) peakE = Math.max(peakE, fluidReactionAt(s, st, 0, 6).energy);
    ok(`each stage kicks a wave of energy (peak ${peakE.toFixed(2)})`, peakE > 1);
    let agEnd = 0;
    for (let s = 22; s < 26; s += 0.1) {
      const r = fluidReactionAt(s, st, 0, 6);
      if (s > st.forced?.end || !st.forced) agEnd = Math.max(agEnd, r.agitation);
    }
    ok(`the tube stays agitated after the dose (aftershock agitation ${agEnd.toFixed(2)})`, agEnd > 0.4);
    let after = 0;
    for (let s = 26; s < 34; s += 0.1) after = fluidReactionAt(s, st, 0, 6).reagent;
    ok(
      `... and settles exactly the cascade's steps on (${before} → ${after}, ${total})`,
      Math.abs(after - (before + total)) < 1e-9
    );
    ok(
      'chaos 1 schedules catalysts by itself',
      (() => {
        const p = fluidReactionPersonality(0);
        for (let k = 0; k < 400; k++) if (fluidSlotEvent(k, p, 1, 6)?.kind === 'catalyst') return true;
        return false;
      })()
    );
  }

  // ── DROUGHTS (round 3: "more gaps in the fluid pipe") ──────────────────
  {
    let dry = 0;
    let n = 0;
    let maxStep = 0;
    let longest = 0;
    let run = 0;
    for (const tube of [0, 1, 2, 3]) {
      let prev = fluidDroughtAt(0, tube);
      for (let s = 0; s < 1200; s += 1 / 30) {
        const d = fluidDroughtAt(s, tube);
        if (!(d >= 0 && d <= 1)) maxStep = Infinity;
        maxStep = Math.max(maxStep, Math.abs(d - prev));
        prev = d;
        n++;
        if (d > 0.99) {
          dry++;
          run += 1 / 30;
          longest = Math.max(longest, run);
        } else run = 0;
      }
    }
    const share = dry / n;
    ok(
      `about ${Math.round(FLUID_DROUGHT_CHANCE * 100)}% of the time a tube runs dry (${(share * 100).toFixed(1)}%)`,
      share > 0.15 && share < 0.4
    );
    ok(`droughts ease in and out, never a step (max ${maxStep.toFixed(3)} per 30 Hz tick)`, maxStep < 0.15);
    ok(`some droughts are long (longest ${longest.toFixed(1)} s)`, longest > 6);
    ok('droughts are deterministic', fluidDroughtAt(123.4, 2) === fluidDroughtAt(123.4, 2));
    ok(
      'tubes keep their own droughts',
      [0, 1, 2, 3].some((t) => fluidDroughtAt(50, t) !== fluidDroughtAt(50, 0)) ||
        [0, 1, 2, 3].some((t) => fluidDroughtAt(80, t) !== fluidDroughtAt(80, 0))
    );
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
    const jump = st.forced.jumps[0];
    ok(`a forced transmute picks a jump of 1..3 (${jump})`, jump >= 1 && jump <= 3);
    const mid = fluidReactionAt(10.4, st, 0).reagent;
    let after = 0;
    for (let s = 10.5; s < 16; s += 0.1) after = fluidReactionAt(s, st, 0).reagent;
    ok(`a forced transmute ramps the reagent (${before} → ${mid.toFixed(2)})`, mid > before && mid < before + jump);
    ok(`... and settles exactly its jump on (${after})`, Math.abs(after - (before + jump)) < 1e-9);
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
    ok(
      `a gap is empty glass now (inject ${pumpData[1]}, trickle ${FLUID_TRICKLE})`,
      FLUID_TRICKLE === 0 && pumpData[1] === 0
    );
    // A drought cuts a pumping root to nothing; a surge's solid stream breaks through it.
    let dryT = -1;
    for (let s = 0; s < 200 && dryT < 0; s += 0.1) if (fluidDroughtAt(s, 0) > 0.999) dryT = s;
    ok(`a drought exists to test against (t=${dryT.toFixed(1)})`, dryT >= 0);
    const pd2 = new Float32Array([2000, 1, 1000, 1]);
    writeFluidTubeTick({
      tubeData: new Float32Array(FLUID_TUBE_TEXELS * 4),
      pumpData: pd2,
      tubes,
      reactions: createFluidReactionState(1),
      tSec: dryT,
      dtSec: 0,
      chaos: 0,
      flowSpeed: 1,
    });
    ok(`a drought stops the supply (inject ${pd2[1]})`, pd2[1] < 0.01);
    const pd3 = new Float32Array([2000, 1, 1000, 1]);
    writeFluidTubeTick({
      tubeData: new Float32Array(FLUID_TUBE_TEXELS * 4),
      pumpData: pd3,
      tubes,
      reactions: createFluidReactionState(1),
      tSec: dryT,
      dtSec: 0,
      chaos: 0,
      flowSpeed: 1,
      droughts: false,
    });
    ok('droughts: false keeps the supply on', pd3[1] === 1);
    const surged = createFluidReactionState(1);
    forceFluidReaction(surged[0], 'surge', dryT - 1);
    const pd4 = new Float32Array([2000, 1, 1000, 1]);
    writeFluidTubeTick({
      tubeData: new Float32Array(FLUID_TUBE_TEXELS * 4),
      pumpData: pd4,
      tubes,
      reactions: surged,
      tSec: dryT,
      dtSec: 0,
      chaos: 0,
      flowSpeed: 1,
    });
    ok(`a surge pours through a drought (inject ${pd4[1].toFixed(2)})`, pd4[1] > 0.9);
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
