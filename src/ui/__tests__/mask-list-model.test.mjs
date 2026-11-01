/**
 * ui/mask-list-model.js — the painter's Masks panel says the true thing about
 * every mask: a file that is loaded is green, a file still decoding says so,
 * painting that no effect reads is not shown as working, and a painted
 * `_Outdoors` draft never makes the scene look ready (only a file does).
 */
import { buildMaskList, MASK_LABELS, fileNameOf, labelOf } from '../mask-list-model.js';
import { MASK_KINDS } from '../../scene/mask-catalog.js';

const PAINTABLE = MASK_KINDS.filter((k) => Array.isArray(k.suffixes) && k.suffixes.length > 0);

const facts = (kinds = {}, extra = {}) => ({ checked: true, failed: false, kinds, ...extra });
const rowOf = (list, id) => list.rows.find((r) => r.id === id);

export function run(t) {
  const { ok } = t;

  ok(
    'every paintable kind has a plain-words label',
    PAINTABLE.every((k) => typeof MASK_LABELS[k.id] === 'string' && MASK_LABELS[k.id].length > 0)
  );
  ok('a kind added later still lists, under its suffix', labelOf({ id: 'newThing', suffixes: ['_New'] }) === '_New');
  ok('file names are decoded', fileNameOf('maps/My%20Map_Fire.webp?v=2') === 'My Map_Fire.webp');

  {
    const list = buildMaskList({ kinds: PAINTABLE, facts: facts(), activeKind: 'fire' });
    ok('one row per paintable kind', list.rows.length === PAINTABLE.length);
    ok('the required kind leads', list.rows[0].id === 'outdoors' && list.rows[0].required);
    ok('...and the rest keep catalog order', list.rows[1].id === PAINTABLE.find((k) => !k.required).id);
    ok('the active layer is marked', rowOf(list, 'fire').active && !rowOf(list, 'water').active);
    ok(
      'a missing required mask is red',
      rowOf(list, 'outdoors').status === 'missing' && rowOf(list, 'outdoors').tone === 'bad'
    );
    ok(
      'an unused optional mask is quiet, not an error',
      rowOf(list, 'fire').status === 'none' && rowOf(list, 'fire').tone === 'off'
    );
    ok('the summary names what is still needed', list.tone === 'bad' && list.summary.includes('_Outdoors'));
  }

  {
    const list = buildMaskList({
      kinds: PAINTABLE,
      facts: facts({
        outdoors: { url: 'maps/a_Outdoors.webp', loaded: true },
        fire: { url: 'maps/a_Fire.webp', loaded: false },
        tree: { url: 'maps/a_Tree.webp', loaded: null },
      }),
    });
    ok('a loaded file is green', rowOf(list, 'outdoors').status === 'file' && rowOf(list, 'outdoors').tone === 'ok');
    ok('...and its detail names the file', rowOf(list, 'outdoors').detail.includes('a_Outdoors.webp'));
    ok('a file still decoding says so', rowOf(list, 'fire').status === 'loading');
    ok('a file its effect reads itself counts as connected', rowOf(list, 'tree').status === 'file');
    ok('three in use, nothing needed', list.summary.startsWith('3 of') && !list.summary.includes('needed'));
    ok('...amber while one is still loading', list.tone === 'warn');
  }

  {
    const list = buildMaskList({
      kinds: PAINTABLE,
      facts: facts(),
      paint: {
        outdoors: { painted: true, unsaved: false },
        fire: { painted: true, unsaved: false },
        specular: { painted: true, unsaved: false },
        water: { painted: true, unsaved: true },
      },
    });
    const out = rowOf(list, 'outdoors');
    ok('a painted _Outdoors draft is NOT shown as ready', out.status === 'painted' && out.tone === 'warn');
    ok('...it points at Save next to map', out.text.includes('save it next to the map'));
    ok('...and the scene still reads as needing it', list.tone === 'bad' && list.summary.includes('_Outdoors'));
    ok(
      'only painting an effect draws counts as "in use" (fire, not water/specular/outdoors)',
      list.summary.startsWith('1 of')
    );
    ok(
      'painting that renders is green',
      rowOf(list, 'fire').tone === 'ok' && rowOf(list, 'fire').text === 'Painted — in use'
    );
    ok(
      'painting a file-only mask is never shown as working',
      rowOf(list, 'specular').tone === 'warn' && rowOf(list, 'specular').text.includes('needs a file')
    );
    ok(
      'unsaved painting says so first',
      rowOf(list, 'water').text === 'Painted — not saved yet' && rowOf(list, 'water').unsaved
    );
  }

  {
    const list = buildMaskList({
      kinds: PAINTABLE,
      facts: facts({ fire: { url: 'maps/a_Fire.webp', loaded: true } }),
      paint: { fire: { painted: true, unsaved: true } },
    });
    ok('editing a connected file says you are changing it', rowOf(list, 'fire').text.includes('changing'));
  }

  {
    const unchecked = buildMaskList({ kinds: PAINTABLE, facts: { checked: false, failed: false, kinds: {} } });
    ok('before discovery, nothing claims "missing"', rowOf(unchecked, 'outdoors').status === 'unknown');
    const failed = buildMaskList({ kinds: PAINTABLE, facts: facts({}, { failed: true }) });
    ok("a folder that couldn't be read is said out loud", rowOf(failed, 'outdoors').text.includes('couldn’t look'));
    const none = buildMaskList({ kinds: PAINTABLE, facts: null });
    ok(
      'no scene: a plain summary, no crash',
      none.summary === 'No scene loaded.' && none.rows.length === PAINTABLE.length
    );
  }
}
