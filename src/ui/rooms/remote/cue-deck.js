/**
 * ui/rooms/remote/cue-deck.js — THE REMOTE'S OWN CUE DECK (U3, docs/holy/
 * UI-Testament.md §4.3): next-cue card, GO, jump list. Ported from the
 * mock's `#cueDeck`/`#cueRow`/`#cueCard`/`#goBtn`/`#cueList` (tools/ui-mock/
 * index.html) — CSS classes renamed to this room's own `msa-cue-*` prefix
 * (matching `msa-wx-*` for the weather board), geometry and states ported
 * unchanged.
 *
 * ⚠️ "NEXT" IS POSITIONAL, LOCAL STATE — NOT PERSISTED, NOT SYNCED. Unlike
 * `weatherArchetype` or a fade's own completion, there is no server-side
 * "the active cue is #2" concept: a fired cue leaves no persistent label to
 * restore (Petition P14's own finding while wiring the engine half of this
 * stage). `nextIx` is this file's own in-memory pointer, starting at 0 and
 * clamped back to 0 whenever the stack's own length changes under it (a
 * capture, a scene switch). Two GMs' decks can legitimately disagree about
 * what's "next" — §4.3 says so explicitly: "jumping to any cue is legal,
 * sessions are not linear."
 *
 * @module ui/rooms/remote/cue-deck
 */

import { iconMarkup } from '../../widgets/icon-sprite.js';

function fmtOverMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'instant';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m`;
}

/** A cue's OWN headline duration — the longest of its per-target overMs
 * (today they're always uniform, since captureCueFromLive applies one
 * overMs to every target; the max is still the honest answer if that ever
 * changes, since it's "how long until every target of this cue has
 * arrived"). */
function headlineOverMs(cue) {
  return Math.max(...Object.values(cue.targets).map((t) => t.overMs));
}

/**
 * @param {HTMLElement} container
 * @param {{ listCues: () => Array<object>, fireCue: (id: string) => {ok: boolean, reason: string|null} }} ctx
 * @returns {{ refresh: () => void }}
 */
export function renderCueDeck(container, ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'msa-cue-deck';

  const label = document.createElement('div');
  label.className = 'msa-cue-label';
  label.innerHTML = `${iconMarkup('clap')}<span>Cues</span>`;
  const listBtn = document.createElement('button');
  listBtn.type = 'button';
  listBtn.className = 'msa-cue-listbtn';
  listBtn.textContent = 'show list ▾';
  label.appendChild(listBtn);

  const row = document.createElement('div');
  row.className = 'msa-cue-row';
  const card = document.createElement('div');
  card.className = 'msa-cue-card';
  const cueLine = document.createElement('div');
  cueLine.className = 'msa-cue-line';
  const kSpan = document.createElement('span');
  kSpan.className = 'msa-cue-k';
  kSpan.textContent = 'Next';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'msa-cue-name';
  cueLine.append(kSpan, nameSpan);
  const meta = document.createElement('span');
  meta.className = 'msa-cue-meta';
  card.append(cueLine, meta);

  const goBtn = document.createElement('button');
  goBtn.type = 'button';
  goBtn.className = 'msa-cue-go';
  goBtn.title = 'Fire the next cue';
  goBtn.innerHTML = `<span>GO</span>${iconMarkup('play')}`;

  row.append(card, goBtn);

  const status = document.createElement('div');
  status.className = 'msa-cue-status';

  const list = document.createElement('div');
  list.className = 'msa-cue-list';
  list.setAttribute('role', 'list');

  wrap.append(label, row, status, list);
  container.appendChild(wrap);

  let open = false;
  let nextIx = 0;

  function cues() {
    try {
      return ctx.listCues() ?? [];
    } catch (_) {
      return [];
    }
  }

  function paint() {
    const stack = cues();
    // `nextIx === stack.length` is the LEGITIMATE "just fired the last cue"
    // terminal state (shows "End of cue list", GO disabled) — only an
    // index that's gone STRICTLY past the end (the stack shrank under a
    // stale pointer, e.g. a scene switch) is actually impossible and worth
    // recovering from.
    if (nextIx > stack.length) nextIx = 0;
    const cue = stack[nextIx] ?? null;
    nameSpan.textContent = cue ? cue.name : stack.length === 0 ? 'No cues staged yet' : 'End of cue list';
    meta.innerHTML = cue ? `${iconMarkup('clock')}fades over ${fmtOverMs(headlineOverMs(cue))}` : '';
    goBtn.disabled = !cue;

    list.innerHTML = '';
    stack.forEach((c, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'msa-cue-listrow' + (i < nextIx ? ' done' : i === nextIx ? ' next' : '');
      b.setAttribute('role', 'listitem');
      const nameEl = document.createElement('span');
      nameEl.textContent = c.name;
      const dur = document.createElement('span');
      dur.className = 'msa-cue-dur';
      dur.textContent = fmtOverMs(headlineOverMs(c));
      b.append(nameEl, dur);
      // Matches the mock's own jump-list behaviour exactly: clicking any
      // cue both JUMPS to it and FIRES it — jumping is explicitly legal
      // (§4.3: "sessions are not linear"), never a passive "select only".
      b.addEventListener('click', () => {
        nextIx = i;
        fire();
      });
      list.appendChild(b);
    });
    if (stack.length > 0) {
      const restart = document.createElement('button');
      restart.type = 'button';
      restart.className = 'msa-cue-listrow';
      restart.innerHTML = `${iconMarkup('reset')}<span>Restart cue stack</span>`;
      restart.addEventListener('click', () => {
        nextIx = 0;
        status.textContent = '';
        paint();
      });
      list.appendChild(restart);
    }
  }

  function fire() {
    const stack = cues();
    const cue = stack[nextIx];
    if (!cue) return;
    const result = ctx.fireCue(cue.id);
    if (!result?.ok) {
      // "Invalid cue refuses to arm" (§9's own U3 checklist) — stay on it
      // rather than silently advancing past a cue that never actually
      // fired, and say why.
      status.textContent = result?.reason ? `⚠ ${result.reason}` : '⚠ refused to arm';
      paint();
      return;
    }
    status.textContent = '';
    nextIx = Math.min(nextIx + 1, stack.length);
    paint();
  }

  goBtn.addEventListener('click', fire);
  listBtn.addEventListener('click', () => {
    open = !open;
    list.classList.toggle('open', open);
    listBtn.textContent = open ? 'hide list ▴' : 'show list ▾';
  });

  paint();

  return {
    refresh() {
      paint();
    },
  };
}
