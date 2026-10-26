/**
 * ui/rooms/remote/extension-sections.js — the registry other modules add Remote sections through.
 *
 * Pure logic, except the kit, which is checked against a minimal stand-in for `document` (the real DOM
 * is exercised live, in the Remote itself).
 */
import {
  registerRemoteSection,
  removeRemoteSection,
  listRemoteSections,
  onRemoteSectionsChanged,
  buildRemoteKit,
} from '../rooms/remote/extension-sections.js';

/** Just enough of an Element for the kit: className, textContent, attributes, children, listeners. */
function fakeDocument() {
  return {
    createElement(tag) {
      const attrs = new Map();
      const handlers = new Map();
      return {
        tag,
        className: '',
        textContent: '',
        type: '',
        title: '',
        children: [],
        append(...nodes) {
          this.children.push(...nodes);
        },
        setAttribute: (k, v) => attrs.set(k, v),
        getAttribute: (k) => attrs.get(k),
        addEventListener: (name, fn) => handlers.set(name, fn),
        click: () => handlers.get('click')?.(),
      };
    },
  };
}

export function run(t) {
  const { ok, throws } = t;
  const ids = () => listRemoteSections({ isGM: true }).map((s) => s.id);
  const noop = () => {};

  // ---- registering ---------------------------------------------------------
  const off = registerRemoteSection({ id: 'footfall.pathing', title: 'Pathing', render: noop });
  ok('a registered section is listed', ids().includes('footfall.pathing'));
  ok(
    'the title is kept, trimmed',
    registerRemoteSection({ id: 'x.trim', title: '  Hello ', render: noop }) &&
      listRemoteSections({ isGM: true }).find((s) => s.id === 'x.trim').title === 'Hello'
  );
  removeRemoteSection('x.trim');
  off();
  ok('the function it returns removes the section again', !ids().includes('footfall.pathing'));

  throws('a section needs an id', () => registerRemoteSection({ title: 'x', render: noop }), 'id');
  throws('an id with spaces is refused', () => registerRemoteSection({ id: 'a b', title: 'x', render: noop }), 'id');
  throws('a section needs a title', () => registerRemoteSection({ id: 'a', title: ' ', render: noop }), 'title');
  throws('a section needs a render function', () => registerRemoteSection({ id: 'a', title: 'x' }), 'render');
  throws('nothing at all is refused', () => registerRemoteSection(null), 'definition');
  ok('a refused registration left nothing behind', !ids().includes('a'));

  // ---- order and who sees what -------------------------------------------------
  registerRemoteSection({ id: 'late', title: 'Late', order: 900, render: noop });
  registerRemoteSection({ id: 'early', title: 'Early', order: 5, render: noop });
  registerRemoteSection({ id: 'tie.b', title: 'B', render: noop });
  registerRemoteSection({ id: 'tie.a', title: 'A', render: noop });
  ok('sections come in `order`, ties by id', ids().join(',') === 'early,tie.a,tie.b,late');
  registerRemoteSection({ id: 'players', title: 'Players', gmOnly: false, render: noop });
  ok('a GM section is hidden from players', !listRemoteSections({ isGM: false }).some((s) => s.id === 'late'));
  ok(
    'a section that opts out of gmOnly is shown to players',
    listRemoteSections({ isGM: false }).some((s) => s.id === 'players')
  );
  registerRemoteSection({ id: 'late', title: 'Replaced', order: 900, render: noop });
  ok(
    'registering an id again replaces the section',
    listRemoteSections({ isGM: true }).filter((s) => s.id === 'late').length === 1 &&
      listRemoteSections({ isGM: true }).find((s) => s.id === 'late').title === 'Replaced'
  );
  for (const id of ['late', 'early', 'tie.a', 'tie.b', 'players']) removeRemoteSection(id);
  ok('every test section is gone', ids().length === 0);
  ok('removing what is not there says so', removeRemoteSection('never-was') === false);

  // ---- being told ---------------------------------------------------------------
  let heard = 0;
  const stop = onRemoteSectionsChanged(() => heard++);
  registerRemoteSection({ id: 'heard', title: 'Heard', render: noop });
  removeRemoteSection('heard');
  removeRemoteSection('heard');
  ok('listeners hear an add and a real removal, not a removal of nothing', heard === 2);
  stop();
  registerRemoteSection({ id: 'unheard', title: 'Unheard', render: noop });
  removeRemoteSection('unheard');
  ok('a stopped listener hears nothing more', heard === 2);

  // ---- the kit ----------------------------------------------------------------------
  const kit = buildRemoteKit(fakeDocument());
  const chip = kit.chip('Stop', { title: 'Halt here', pressed: true });
  ok(
    'a chip is a button with the Remote chip class',
    chip.tag === 'button' && chip.className === 'msa-wx-chip' && chip.type === 'button'
  );
  ok(
    'a chip carries its pressed state in aria-pressed',
    chip.getAttribute('aria-pressed') === 'true' && kit.chip('x').getAttribute('aria-pressed') === 'false'
  );
  let clicks = 0;
  kit.chip('Go', { onClick: () => clicks++ }).click();
  ok('a chip calls its handler', clicks === 1);
  const label = kit.label('Pathing', 'marks');
  ok(
    'a label has its text and a caption',
    label.className === 'msa-wx-blocklabel' &&
      label.children.length === 2 &&
      label.children[1].className === 'msa-wx-hint'
  );
  ok('a label without a caption has one child', kit.label('Only').children.length === 1);
  ok('the kit is frozen: a section cannot swap its tools', Object.isFrozen(kit));
}
