/**
 * effect-controls.test.mjs — routing/sorting for the panel's zone dispatch.
 * `buildEffectCard` itself is DOM and browser-verified live (no DOM mock —
 * CONVENTIONS §4). The type→widget dispatch and the pure category/FOH-ROH/
 * snapshot logic this file tested until U0 (docs/holy/UI-Testament.md §9)
 * moved to `ui/widgets/param-control.js` and `ui/widgets/param-groups.js` —
 * see their own `__tests__/` for that coverage now; `effect-controls.js`
 * re-exports them unchanged, so nothing importing from here broke.
 */
import { routeEntry, sortPanelsForZone } from '../debug-panel-controls.js';

export function run(t) {
  const { ok } = t;

  // --- routeEntry: the line that turned the Lab into a junk drawer ----------
  // `entry.zone ?? ZONES[id] ?? 'lab'` made the Lab the DEFAULT sink, so every
  // diagnostic registered without a zone piled into it — twelve in its catch-all
  // "More" drawer by 2026-07-27, eight of them belonging to a specific effect.
  ok('an entry with no zone still lands somewhere visible', routeEntry('x', {}).zone === 'lab');
  ok('an undefined entry does not throw', routeEntry('x', undefined).zone === 'lab');
  ok('a declared zone wins', routeEntry('x', { zone: 'bridge' }).zone === 'bridge');
  ok('a legacy id→zone override is honoured', routeEntry('x', {}, { x: 'settings' }).zone === 'settings');
  ok(
    'a declared zone beats the legacy table (the call site is the truth)',
    routeEntry('x', { zone: 'bridge' }, { x: 'settings' }).zone === 'bridge'
  );

  // THE SECOND DESTINATION — an effect's own card, not a zone body at all.
  ok('an effect-routed entry is not a zone entry', routeEntry('probe', { effect: 'specular' }).kind === 'effect');
  ok('it names its effect', routeEntry('probe', { effect: 'specular' }).effect === 'specular');
  ok(
    'an effect beats both a declared zone and the legacy table',
    routeEntry('probe', { effect: 'specular', zone: 'lab' }, { probe: 'bridge' }).kind === 'effect'
  );
  ok('an empty effect string is not an effect route', routeEntry('x', { effect: '' }).kind === 'zone');

  // --- sortPanelsForZone: declared order, stable ties -----------------------
  {
    const panels = [
      ['grade', { zone: 'workshop' }],
      ['astrolabe', { zone: 'bridge', order: -1 }],
      ['water', { zone: 'workshop' }],
      ['camera', { zone: 'bridge' }],
      ['probe-card', { effect: 'specular' }],
    ];
    const bridge = sortPanelsForZone(panels, 'bridge').map(([id]) => id);
    ok('a negative order pins to the top of its zone', bridge.join(',') === 'astrolabe,camera');

    const workshop = sortPanelsForZone(panels, 'workshop').map(([id]) => id);
    ok('un-ordered panels keep registration order (stable sort)', workshop.join(',') === 'grade,water');
    ok('an effect-routed panel appears in NO zone body', !workshop.includes('probe-card'));
    ok('a zone with nothing routed to it is empty, not undefined', sortPanelsForZone(panels, 'settings').length === 0);
  }

  // --- REGRESSION (2026-07-28): a panel declaring BOTH zone AND effect -------
  // "the Make rail is broken, there are no effects in there" — every real
  // `registerPanel` call for an actual effect (boot.js: bloom, water, fluid,
  // specular, window, grade, vegetation, candles, sun-shadows, wind) declares
  // BOTH `zone: 'workshop'` (so it renders) AND `effect: '<id>'` (so it can
  // gather its OWN attachments via `attachmentsFor`) — a shape the block above
  // never modelled, because it only ever put `zone` and `effect` on SEPARATE
  // entries. `sortPanelsForZone` used to delegate to `routeEntry`, whose
  // "effect beats zone" rule is correct for controls/actions/reports and wrong
  // here — it silently routed every real effect panel to `kind:'effect'`,
  // which `attachmentsFor` never reads for the `panels` map at all (it only
  // scans controls/actions/reports). Net effect: every effect card in the
  // product UI rendered NOWHERE, with this exact suite fully green throughout.
  {
    const realShapedPanels = [
      ['bloom-panel', { zone: 'workshop', effect: 'bloom', order: 80 }],
      ['water-panel', { zone: 'workshop', effect: 'water', order: 30 }],
      ['astrolabe', { zone: 'bridge', order: -1 }], // the one panel with no `effect` — never broken
    ];
    const workshop = sortPanelsForZone(realShapedPanels, 'workshop').map(([id]) => id);
    ok(
      'a panel declaring BOTH zone and effect still renders in its zone — THE ACTUAL LIVE BUG',
      workshop.join(',') === 'water-panel,bloom-panel'
    );
    ok(
      'declaring `effect` does not evict a panel from its declared zone',
      workshop.includes('bloom-panel') && workshop.includes('water-panel')
    );
    const bridge = sortPanelsForZone(realShapedPanels, 'bridge').map(([id]) => id);
    ok('a panel with no effect at all is unaffected either way', bridge.join(',') === 'astrolabe');
  }
}
