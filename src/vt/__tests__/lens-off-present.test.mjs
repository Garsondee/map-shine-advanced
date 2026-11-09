/**
 * lens-off-present.test.mjs — with Lens off, present reads the live scene again (mmp-78u.7, P0).
 *
 * `grade-present.js#setLitSource` is a persistent redirect. `post.lens` points present at its own output every
 * frame it draws, and `post.taaResolve` re-points present only while TAA is on (off by default). So when Lens was
 * switched off, `runPostLensPass` returned early, nothing re-pointed present, and present went on showing Lens's
 * last frame: the map froze on any pan or change of hour while the grid, fog and tone curve stayed live. Found by
 * the MSA Lab's probe (2026-11-08): a black step that should be lit 0 showed 38, and at 18:00 lit 1.44 showed 228.
 *
 * Both passes are closures inside `startVtPanViewer` (no renderer in Node), so this lifts their REAL source text
 * out of vt-pan-viewer.js and runs their disabled paths against small stand-ins for the closure's state. Any name
 * the code reaches that has no stand-in throws, so the disabled paths are also proven to touch no renderer and no
 * render target: no GPU work while Lens is off.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lensOffLitSource } from '../../effects/lens-render.js';

const VT_PAN_VIEWER_PATH = fileURLToPath(new URL('../vt-pan-viewer.js', import.meta.url));

/**
 * The text of `function <name>() { ... }`, braces balanced. Skips strings, template literals and comments, so a
 * brace inside one cannot end the function early.
 */
function functionText(src, name) {
  const head = `function ${name}() {`;
  const at = src.indexOf(head);
  if (at < 0) return null;
  let depth = 0;
  for (let i = at + head.length - 1; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      i = src.indexOf('\n', i);
      if (i < 0) return null;
    } else if (c === '/' && next === '*') {
      i = src.indexOf('*/', i + 2) + 1;
      if (i <= 0) return null;
    } else if (c === "'" || c === '"' || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
    } else if (c === '{') {
      depth++;
    } else if (c === '}' && --depth === 0) {
      return src.slice(at, i + 1);
    }
  }
  return null;
}

/**
 * Compile a closure function's source against `stubs`, standing in for the closure's variables. A name the code
 * reads that is neither stubbed nor a JS global throws, naming it.
 */
function compileAgainst(text, stubs) {
  const env = new Proxy(stubs, {
    has: (target, key) => typeof key === 'string' && (key in target || !(key in globalThis)),
    get: (target, key) => {
      if (key === Symbol.unscopables) return undefined;
      if (key in target) return target[key];
      throw new ReferenceError(`the disabled path reached \`${String(key)}\`, which has no stand-in here`);
    },
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  });
  // `with` resolves the closure's free names against `env`; a Function body is sloppy code, where it is allowed.
  return new Function('env', `with (env) { return (${text}); }`)(env);
}

/** A stand-in for gradePresent: what present reads, and how often it was re-pointed. */
function fakePresent(initial) {
  return {
    src: initial,
    sets: 0,
    getLitSource() {
      return this.src;
    },
    setLitSource(tex) {
      this.src = tex;
      this.sets++;
    },
  };
}

export function run(t) {
  const { ok } = t;
  const src = readFileSync(VT_PAN_VIEWER_PATH, 'utf8').replace(/\r\n/g, '\n');
  const lensText = functionText(src, 'runPostLensPass');
  const taaText = functionText(src, 'runPostTaaResolvePass');
  ok('runPostLensPass is found in vt-pan-viewer.js', !!lensText);
  ok('runPostTaaResolvePass is found in vt-pan-viewer.js', !!taaText);
  if (!lensText || !taaText) return;

  const sceneLitTex = { name: 'scene.lit' };
  const outA = { name: 'lens.outputA' };
  const outB = { name: 'lens.outputB' };
  const taaTex = { name: 'taa.historyA' };

  /** One frame's post chain with Lens OFF: post.taaResolve then post.lens, the frame order (graph/passes.js). */
  function frameSetup({ present, taaOn = false, taaWasActive = false, lensAllocated = true }) {
    const gradePresent = fakePresent(present);
    const stubs = {
      gradePresent,
      sceneLit: { texture: sceneLitTex },
      lensOutputA: lensAllocated ? { texture: outA } : null,
      lensOutputB: lensAllocated ? { texture: outB } : null,
      lensOffLitSource,
      getLensRenderState: () => ({ enabled: false, params: {} }),
      taaJitterEnabled: taaOn,
      taaWasActiveLastFrame: taaWasActive,
    };
    let err = null;
    let lens = null;
    let taa = null;
    try {
      lens = compileAgainst(lensText, stubs);
      taa = compileAgainst(taaText, stubs);
    } catch (e) {
      err = e;
    }
    const frame = () => {
      try {
        // TAA ON is stood in by its effect (present re-pointed at its resolved image), not by running its draw.
        if (taaOn) gradePresent.setLitSource(taaTex);
        else taa();
        lens();
        return null;
      } catch (e) {
        return e;
      }
    };
    return { gradePresent, frame, err };
  }

  // ── THE BUG: Lens drew last frame (present on its output B), now off, TAA off ─────────────────────────────
  {
    const f = frameSetup({ present: outB });
    ok(`both passes compile against the stand-ins (${f.err ? f.err.message : 'clean'})`, f.err === null);
    const e1 = f.frame();
    ok(`the first Lens-off frame runs without reaching any GPU state (${e1 ? e1.message : 'clean'})`, e1 === null);
    ok(
      "Lens off, TAA off: present reads scene.lit again, not Lens's last frame (the freeze, mmp-78u.7)",
      f.gradePresent.getLitSource() === sceneLitTex
    );
    ok('…with exactly one re-point', f.gradePresent.sets === 1);
    // The pan that showed the freeze: more frames with Lens off.
    const e2 = f.frame();
    const e3 = f.frame();
    ok(
      'the frames after it (a pan, a change of hour) keep reading scene.lit',
      e2 === null && e3 === null && f.gradePresent.getLitSource() === sceneLitTex
    );
    ok('…and re-point nothing (a true no-op while Lens stays off)', f.gradePresent.sets === 1);
  }

  // The other half of the ping-pong pair.
  {
    const f = frameSetup({ present: outA });
    f.frame();
    ok('present on output A: back to scene.lit too', f.gradePresent.getLitSource() === sceneLitTex);
  }

  // ── TAA ON: it re-points present at its resolved image every frame; Lens off must keep that ─────────────
  {
    const f = frameSetup({ present: outB, taaOn: true });
    const e = f.frame();
    ok(
      "Lens off, TAA on: present keeps TAA's resolved image (scene.lit would skip the resolve)",
      e === null && f.gradePresent.getLitSource() === taaTex
    );
    ok("…Lens re-points nothing on top of TAA's own swap", f.gradePresent.sets === 1);
  }

  // ── TAA turning off on the same frame: TAA's own un-redirect lands, Lens adds nothing ──────────────────
  {
    const f = frameSetup({ present: taaTex, taaWasActive: true });
    const e = f.frame();
    ok(
      "TAA's own off-frame hands present to scene.lit, and Lens off leaves it there",
      e === null && f.gradePresent.getLitSource() === sceneLitTex && f.gradePresent.sets === 1
    );
  }

  // ── Lens never on: nothing allocated, present on scene.lit: untouched ─────────────────────────────────────
  {
    const f = frameSetup({ present: sceneLitTex, lensAllocated: false });
    const e = f.frame();
    ok(
      'Lens never on: present untouched, nothing re-pointed, nothing reached',
      e === null && f.gradePresent.getLitSource() === sceneLitTex && f.gradePresent.sets === 0
    );
  }
}
