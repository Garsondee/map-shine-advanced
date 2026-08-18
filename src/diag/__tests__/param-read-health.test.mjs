/**
 * THE READ-TRACKING PROXY — verification (docs/holy/UI-Testament.md §9, U6).
 * "A deliberately orphaned param shows up wearing its badge within one
 * session" (U6's own exit gate) is the load-bearing claim this suite proves.
 */
import { wrapForReadTracking, getParamHealth, resetParamReadTracking } from '../param-read-health.js';

const SCHEMA = {
  depth: { type: 'float' },
  pollution: { type: 'float' },
  opacity: { type: 'float' },
};

export function run(t) {
  resetParamReadTracking();

  // ---- a fresh effect, before any read, is honestly 0/N --------------------
  {
    const health = getParamHealth('fresh-effect', SCHEMA);
    t.ok('a never-wrapped effect declares the full schema', health.declared === 3);
    t.ok('a never-wrapped effect has read 0 — not an error state, just true', health.read === 0);
    t.ok('every declared key is orphaned before any read', health.orphaned.length === 3);
  }

  // ---- the proxy is lazy: only ACCESSED keys count as read ------------------
  {
    resetParamReadTracking('water');
    const raw = { depth: 0.5, pollution: 0.6, opacity: 1 };
    const tracked = wrapForReadTracking('water', raw);
    // Touch exactly one key.
    void tracked.depth;
    const health = getParamHealth('water', SCHEMA);
    t.ok('exactly the touched key is read', health.read === 1);
    t.ok(
      'the untouched keys are orphaned',
      health.orphaned.includes('pollution') && health.orphaned.includes('opacity')
    );
    t.ok('the touched key is NOT orphaned', !health.orphaned.includes('depth'));
  }

  // ---- reads accumulate across multiple frames/wraps -----------------------
  {
    resetParamReadTracking('water');
    const raw = { depth: 0.5, pollution: 0.6, opacity: 1 };
    // Frame 1: only depth read.
    void wrapForReadTracking('water', raw).depth;
    // Frame 2: a FRESH wrap (a new resolve), pollution read.
    void wrapForReadTracking('water', raw).pollution;
    const health = getParamHealth('water', SCHEMA);
    t.ok('reads accumulate across separate wrap calls (separate frames)', health.read === 2);
    t.ok('a read is never "un-read" by a later frame that does not touch it', health.orphaned.length === 1);
    t.ok('the never-touched key is the one still orphaned', health.orphaned[0] === 'opacity');
  }

  // ---- THE EXIT GATE: a deliberately orphaned param shows up ---------------
  {
    resetParamReadTracking('water');
    const raw = { depth: 0.5, pollution: 0.6 };
    const tracked = wrapForReadTracking('water', raw);
    void tracked.depth;
    void tracked.pollution;
    // A schema with a param the render path above never touches at all —
    // exactly "an effect declared a new param and forgot to wire the read".
    const schemaWithOrphan = { ...SCHEMA, foamTrail: { type: 'float' } };
    const health = getParamHealth('water', schemaWithOrphan);
    t.ok('the deliberately-unread param shows up in orphaned', health.orphaned.includes('foamTrail'));
    t.ok('declared - read matches the orphan count', health.declared - health.read === health.orphaned.length);
  }

  // ---- spread-safety: a spread over the tracked proxy marks every key read -
  // (documents the exact hazard the module's own header warns about — the
  // FIX is "wrap after any spread, not before", proven at the wiring site,
  // not here; this just proves the underlying JS mechanics the header relies on.)
  {
    resetParamReadTracking('spread-effect');
    const raw = { depth: 0.5, pollution: 0.6, opacity: 1 };
    const tracked = wrapForReadTracking('spread-effect', raw);
    const spread = { ...tracked };
    void spread; // silence unused-var lints; the spread itself is the point
    const health = getParamHealth('spread-effect', SCHEMA);
    t.ok(
      'a spread over a tracked proxy touches every own key — this is WHY the wrap must sit after any spread',
      health.read === 3
    );
  }

  // ---- non-object input passes through, does not throw ---------------------
  {
    t.ok('null passes through unwrapped', wrapForReadTracking('x', null) === null);
    t.ok('undefined passes through unwrapped', wrapForReadTracking('x', undefined) === undefined);
  }

  // ---- resetParamReadTracking ------------------------------------------------
  {
    resetParamReadTracking('water');
    void wrapForReadTracking('water', { depth: 1 }).depth;
    t.ok('a read is recorded before reset', getParamHealth('water', SCHEMA).read === 1);
    resetParamReadTracking('water');
    t.ok('reset clears the named effect only', getParamHealth('water', SCHEMA).read === 0);
  }
  {
    resetParamReadTracking('a');
    resetParamReadTracking('b');
    void wrapForReadTracking('a', { depth: 1 }).depth;
    void wrapForReadTracking('b', { depth: 1 }).depth;
    resetParamReadTracking(); // no argument -> clears everything
    t.ok('reset with no argument clears every effect (a)', getParamHealth('a', SCHEMA).read === 0);
    t.ok('reset with no argument clears every effect (b)', getParamHealth('b', SCHEMA).read === 0);
  }
}
