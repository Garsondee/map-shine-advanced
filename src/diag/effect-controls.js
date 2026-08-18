/**
 * EFFECT CONTROLS — the OLD debug-panel's own card shell: the `<details>`/
 * `<summary>` collapsed scan row, the copy-to-clipboard button, and the
 * Advanced disclosure that wraps categorised ROH groups + this effect's own
 * diagnostics. `buildEffectCard` is this module's reason to exist; everything
 * it depends on that is NOT specific to this panel's own visual shape —
 * the type→widget mapping and the pure category/FOH-ROH/snapshot logic — was
 * extracted to `ui/widgets/param-control.js` and `ui/widgets/param-groups.js`
 * at U0 (docs/holy/UI-Testament.md §9) and is re-exported below unchanged, so
 * every existing import of THIS module keeps working without modification.
 *
 * ⚠️ WHY THE SPLIT LANDED WHERE IT DID. The Studio's own EFFECTS department
 * (U1) needs the widgets and the pure logic but does NOT reuse `buildEffectCard`
 * itself — its card shell has real structural differences from this one (pin/
 * popout/paint tool buttons, a mask-found/missing row, health/tier/scope
 * badges — none of which this shell has), matching `tools/ui-mock/index.html`'s
 * own `buildCard`, not this file's `<details>` accordion. Moving
 * `buildEffectCard` "for reuse" would have meant moving code with exactly one
 * caller today and a shape the new shell doesn't actually want.
 *
 * This is deliberately PLAIN DOM, not Tweakpane: Tweakpane isn't vendored yet
 * (`ui/no-handwritten-controls`, tools/verify-structure.mjs, only matches
 * literal Tweakpane call patterns and allows them in `ui/renderers/` — plain
 * `<input>`/`<select>` construction outside that folder is already how
 * `debug-panel.js`'s own `makeControl` works, so this is consistent with
 * existing precedent, not a new exception). Swapping in the real Tweakpane/
 * ApplicationV2 pair later means changing the RENDERER, not the schema.
 *
 * @module diag/effect-controls
 */

// Through the ui/ zone's ONE door (zones/one-door) — diag/ is a different
// zone, so this reaches ui/widgets/* via ../ui/index.js, never the files directly.
import {
  styled,
  buildParamControl,
  buildInheritableRangeRow,
  COMPASS_POINTS,
  COMPASS_SNAP_DEG,
  wrapDeg,
  nearestCompassPoint,
  CATEGORY_ORDER,
  groupParamsByCategory,
  rohGroups,
  createSectionStore,
  collapsedStatusLine,
  buildSettingsSnapshot,
} from '../ui/index.js';

// Re-exported unchanged — every existing import of this module (debug-panel.js,
// debug-panel-controls.js, effect-controls.test.mjs, boot.js's effect panels)
// reaches these through here today, and that keeps working through the U0 move.
export {
  buildParamControl,
  buildInheritableRangeRow,
  COMPASS_POINTS,
  COMPASS_SNAP_DEG,
  wrapDeg,
  nearestCompassPoint,
  CATEGORY_ORDER,
  groupParamsByCategory,
  rohGroups,
  createSectionStore,
  collapsedStatusLine,
  buildSettingsSnapshot,
};

/** The panel's live section state. One per module load, deliberately. */
const sections = createSectionStore();

// ---- shared visual language (this shell's own chrome only — the widgets
// imported above own their OWN theme-aware colours now; these stay exactly
// as they were before the U0 extraction, since re-theming this panel's
// borders/copy-button/section-labels is out of scope for that move) --------
const CYAN = '143,214,255';
const MUTED = '#8fa3c4';

/**
 * Copy text to the clipboard, with the same async-API-then-`execCommand`
 * fallback `debug-panel.js`'s own `copyToClipboard` uses. Duplicated rather
 * than imported: this module's own header states it stays free of any import
 * of `debug-panel.js` (and vice versa) so the two can be read independently —
 * ~15 lines is cheap next to breaking that boundary for one helper.
 * @param {string} text @returns {Promise<boolean>}
 */
async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      /* fall through to the execCommand fallback */
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

/**
 * The 📋 header button — EVERY workshop card gets one, because it is built
 * here rather than per-effect. Author, 2026-08-09: *"add a button that needs
 * to be in every section of the workshop which outputs the current values
 * into the copy paste buffer so that I can give you a text file with settings
 * rather than an image."* One declaration in the shared card generator beats
 * "every effect panel remembers to add its own" the same way every other rule
 * in this file does.
 */
function buildCopyButton({ id, title, schema, getValue, enabled, getEnabled }) {
  const idleGlyph = '📋';
  const btn = styled('button', {
    pointerEvents: 'auto',
    background: 'rgba(143,214,255,0.1)',
    border: `1px solid rgba(${CYAN},0.3)`,
    borderRadius: '6px',
    color: MUTED,
    font: '11px/1.2 Signika, sans-serif',
    padding: '3px 7px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  });
  btn.type = 'button';
  btn.textContent = idleGlyph;
  btn.title = 'Copy every current setting for this effect as text — paste it to Claude instead of a screenshot.';
  shieldFromSummary(btn);
  let resetTimer = null;
  btn.addEventListener('click', async () => {
    // ⚠️ READ AT CLICK TIME, NEVER AT BUILD TIME. `getValue` is the card's own
    // live accessor, so it is already correct AS LONG AS the caller did not
    // capture its source — the 2026-08-17 bug was exactly that capture, one
    // level up in `boot.js`. `getEnabled` exists so the one value that is NOT
    // routed through `getValue` cannot go stale on its own either; the static
    // `enabled` remains the fallback for a caller that has no live getter.
    const liveEnabled = typeof getEnabled === 'function' ? getEnabled() : enabled;
    const snapshot = buildSettingsSnapshot({ id, title, enabled: liveEnabled, schema, getValue });
    const ok = await copyTextToClipboard(JSON.stringify(snapshot, null, 2));
    clearTimeout(resetTimer);
    btn.textContent = ok ? '✓ Copied' : '✗ Failed';
    btn.style.color = ok ? '#a7ffc4' : '#ff9a9a';
    resetTimer = setTimeout(() => {
      btn.textContent = idleGlyph;
      btn.style.color = MUTED;
    }, 1400);
  });
  return btn;
}

function sectionLabel(text) {
  const el = styled('div', {
    fontSize: '9px',
    letterSpacing: '1.2px',
    textTransform: 'uppercase',
    color: '#7f97ba',
    fontWeight: '600',
    margin: '7px 0 2px',
  });
  el.textContent = text;
  return el;
}

/**
 * Stop a click inside a `<summary>` from ALSO toggling the disclosure.
 *
 * ⚠️ THE TRAP THIS EXISTS FOR. A `<summary>` toggles its parent `<details>` on
 * any click that reaches it — including one that started on a checkbox or button
 * nested inside. Once the card header became a summary, turning an effect off
 * folded its card shut, and pressing ＋ folded the card shut on the way to the
 * brush. Both read as the control being broken.
 *
 * Belt AND braces, because the two mechanisms fail differently: stopping
 * propagation keeps the event from reaching the summary at all, and the
 * `data-msa-nontoggle` marker lets the summary refuse the default action even if
 * some future browser routes activation another way. `debug-panel.js` applies the
 * same doubled guard to its own header buttons for the drag-capture equivalent.
 * @param {HTMLElement} el
 */
function shieldFromSummary(el) {
  el.dataset.msaNontoggle = '1';
  el.addEventListener('click', (e) => e.stopPropagation());
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
}

/**
 * Build one effect's card — the reusable unit every registered effect gets by
 * declaring a params schema + a curated FOH key list, nothing else.
 *
 * COLLAPSED BY DEFAULT (2026-07-27). The card is a `<details>`; its `<summary>`
 * is a one-line scan row — chevron · icon · title · derived status · ＋ · On —
 * identical in shape for every effect, so ten effects can be read at a glance and
 * the ＋ that adds one to the map is always in the same place. Open state
 * survives the panel's full rebuild via the module-level {@link createSectionStore}.
 *
 * Inside, unchanged: a short plain-language FOH strip (`fohKeys`, hand-picked,
 * ≤6 per Effects-UI.md §3.2) → an "Advanced" disclosure holding EVERYTHING FOH
 * DID NOT PROMOTE, categorised (`groupParamsByCategory`), plus this effect's own
 * diagnostics. The two halves partition the schema; they do not overlap. A key
 * appears in exactly one of them, so there is exactly one live control per param
 * and the halves cannot show different values for the same thing — see the note
 * at the ROH loop for the bug that established this.
 *
 * `getValue`/`onChange` are keyed by param id and are the ONLY write path — this
 * module never touches an effect's state directly, so a caller can route writes
 * through whatever cascade/persistence it needs (boot.js wires candles' through
 * `MapShine.setCandle`-style transient overrides).
 *
 * @param {object} args
 * @param {string} args.id - REQUIRED stable slug; the open-state key and the
 *   card's `data-msa-effect` attribute. Throws when absent, because two cards
 *   silently sharing one open-state key is a far worse failure than a loud one —
 *   and `buildRoutedPanels` already try/catches, so a throw costs one skipped
 *   card and a logged error, never a blank zone.
 * @param {string} [args.icon] - one glyph, shown in the collapsed header.
 * @param {string} args.title
 * @param {string} [args.subtitle] - the card's hover tooltip. It was a rendered
 *   line until 2026-07-27; these are developer notes ("tiers 0–5 — placement ·
 *   tube · flow · film · fill · structure") and they were occupying the row that
 *   now carries the status readout a GM actually needs.
 * @param {string|(() => string)} [args.status] - the derived scan line; see
 *   {@link collapsedStatusLine}. A function is called at build time.
 * @param {Record<string, object>} args.schema - the effect's params schema.
 * @param {string[]} args.fohKeys - a short, curated subset of `schema`'s keys.
 * @param {(paramId: string) => unknown} args.getValue
 * @param {(paramId: string, value: unknown) => void} args.onChange
 * @param {boolean} [args.enabled] - omit to hide the enable toggle entirely.
 * @param {(next: boolean) => void} [args.onToggleEnabled]
 * @param {{label: string, title?: string, onAdd: () => void}} [args.add] - the ＋
 *   affordance: how you put this effect ON the map (paint its mask, place an
 *   instance). Rendered in the collapsed header so it is reachable without
 *   opening anything.
 * @param {HTMLElement[]} [args.extra] - additional elements after the FOH strip.
 * @param {HTMLElement[]} [args.extraAdvanced] - additional STRUCTURED content
 *   mounted inside Advanced, after the categorised ROH groups and before
 *   Diagnostics. Opaque elements — this module never inspects them, the same
 *   contract `diagnostics` has. For content that is a real param (any
 *   `schema` key) this is the WRONG door — it belongs in `schema`/`fohKeys`
 *   like everything else, so it gets one live control rather than a
 *   hand-built second one. This exists for content a flat params schema
 *   cannot express at all — a REPEATED per-instance strip (specular's three
 *   shimmer layers, `SPECULAR_LAYER_PARAMS` — one schema, three independent
 *   sets of live values, which is not what one flat `schema` object holds).
 * @param {HTMLElement[]} [args.diagnostics] - this effect's probes and status
 *   reports, mounted inside Advanced. Opaque elements — this module never
 *   inspects them, the same contract `extra` has. The panel builds them and
 *   passes them in, which is what keeps `debug-panel.js` and this module free of
 *   any import of each other.
 * @returns {HTMLElement}
 */
export function buildEffectCard({
  id,
  icon,
  title,
  subtitle,
  status,
  schema,
  fohKeys,
  getValue,
  onChange,
  enabled,
  getEnabled,
  onToggleEnabled,
  add,
  extra,
  extraAdvanced,
  diagnostics,
}) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(
      'buildEffectCard: `id` is required — it is the open-state key, and two cards silently sharing one is a far worse failure than a loud one.'
    );
  }

  const card = document.createElement('details');
  card.dataset.msaEffect = id;
  card.open = sections.isOpen(id);
  Object.assign(card.style, {
    border: `1px solid rgba(${CYAN},0.18)`,
    borderRadius: '9px',
    background: `rgba(${CYAN},0.045)`,
    flexBasis: '100%',
  });
  if (subtitle) card.title = subtitle;
  card.addEventListener('toggle', () => sections.setOpen(id, card.open));

  // ---- the collapsed scan row ----------------------------------------------
  const head = styled('summary', {
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    cursor: 'pointer',
    listStyle: 'none',
    padding: '8px 10px',
    userSelect: 'none',
  });
  head.addEventListener('click', (e) => {
    // The second half of the summary guard — see shieldFromSummary.
    if (e.target instanceof Element && e.target.closest('[data-msa-nontoggle]')) e.preventDefault();
  });

  const chev = styled('span', { display: 'inline-block', opacity: '0.55', fontSize: '10px' });
  chev.className = 'msa-chev';
  chev.textContent = '▸';
  head.append(chev);

  if (icon) {
    const ic = styled('span', { fontSize: '12px' });
    ic.textContent = icon;
    head.append(ic);
  }

  const titleEl = styled('span', { fontWeight: '700', fontSize: '11.5px', color: '#eaf4ff' });
  titleEl.textContent = title;
  head.append(titleEl);

  const statusText = typeof status === 'function' ? status() : status;
  if (typeof statusText === 'string' && statusText.length > 0) {
    const st = styled('span', {
      fontSize: '9.5px',
      color: MUTED,
      flex: '1 1 auto',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    });
    st.textContent = statusText;
    head.append(st);
  } else {
    head.append(styled('span', { flex: '1 1 auto' })); // the spacer that pushes ＋/On right
  }

  if (add && typeof add.onAdd === 'function') {
    const addBtn = styled('button', {
      pointerEvents: 'auto',
      background: 'rgba(167,255,196,0.16)',
      border: '1px solid rgba(167,255,196,0.42)',
      borderRadius: '6px',
      color: '#eaf4ff',
      font: '10px/1.2 Signika, sans-serif',
      padding: '3px 8px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    });
    addBtn.type = 'button';
    addBtn.textContent = add.label;
    if (add.title) addBtn.title = add.title;
    shieldFromSummary(addBtn);
    addBtn.addEventListener('click', () => add.onAdd());
    head.append(addBtn);
  }

  if (typeof onToggleEnabled === 'function') {
    const toggleWrap = styled('label', {
      display: 'flex',
      alignItems: 'center',
      gap: '5px',
      fontSize: '10px',
      color: MUTED,
      pointerEvents: 'auto',
    });
    const cb = styled('input', { pointerEvents: 'auto' });
    cb.type = 'checkbox';
    cb.checked = enabled === true;
    cb.addEventListener('change', () => onToggleEnabled(cb.checked));
    toggleWrap.append('On', cb);
    shieldFromSummary(toggleWrap);
    head.append(toggleWrap);
  }

  // The copy button — see `buildCopyButton`'s own note. Skipped only for the
  // degenerate case of a card with no params at all, the same "never render
  // an empty thing" rule Advanced already follows below.
  if (schema && Object.keys(schema).length > 0) {
    head.append(buildCopyButton({ id, title, schema, getValue, enabled, getEnabled }));
  }
  card.append(head);

  // ---- the body ------------------------------------------------------------
  const body = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: '5px',
    padding: '0 11px 10px',
  });

  const foh = styled('div', { display: 'flex', flexWrap: 'wrap', gap: '4px' });
  for (const key of fohKeys ?? []) {
    const decl = schema?.[key];
    if (!decl) continue; // a curated key that no longer exists in the schema silently drops — never a throw over a rename
    foh.append(buildParamControl(key, decl, { value: getValue(key), onChange: (v) => onChange(key, v) }));
  }
  body.append(foh);

  for (const el of extra ?? []) body.append(el);

  const roh = rohGroups(schema, fohKeys);
  const diags = diagnostics ?? [];
  const extraAdv = extraAdvanced ?? [];
  // An effect whose every param was promoted to FOH and which has no diagnostics
  // has nothing to disclose — window light rendered an EMPTY "Advanced ▾" for
  // exactly that reason from the day its 2-key schema landed.
  if (roh.length > 0 || diags.length > 0 || extraAdv.length > 0) {
    const advKey = `${id}:advanced`;
    const details = document.createElement('details');
    details.open = sections.isOpen(advKey);
    details.addEventListener('toggle', () => sections.setOpen(advKey, details.open));
    Object.assign(details.style, {
      border: `1px solid rgba(${CYAN},0.12)`,
      borderRadius: '7px',
      background: `rgba(${CYAN},0.03)`,
    });
    const summary = styled('summary', {
      cursor: 'pointer',
      listStyle: 'none',
      padding: '5px 8px',
      fontSize: '10px',
      fontWeight: '600',
      color: MUTED,
    });
    summary.innerHTML = '<span class="msa-chev">▸</span> Advanced';
    details.append(summary);

    const rohBody = styled('div', { display: 'flex', flexDirection: 'column', padding: '2px 8px 8px' });
    for (const { category, keys } of roh) {
      rohBody.append(sectionLabel(category));
      const groupWrap = styled('div', { display: 'flex', flexWrap: 'wrap', gap: '4px' });
      for (const key of keys) {
        const decl = schema[key];
        groupWrap.append(buildParamControl(key, decl, { value: getValue(key), onChange: (v) => onChange(key, v) }));
      }
      rohBody.append(groupWrap);
    }

    // STRUCTURED CONTENT NO FLAT SCHEMA CAN HOLD — see this prop's own JSDoc.
    // Appended as-is, one per element: unlike `roh`/`diags` this is not a
    // uniform list of same-shaped controls, so there is no single wrapping
    // row to build here — each element is responsible for its own layout.
    for (const el of extraAdv) rohBody.append(el);

    // THIS EFFECT'S OWN INSTRUMENTS, in the effect's own card. They lived in the
    // Lab's catch-all "More" drawer until 2026-07-27 — a rail click away from the
    // card they describe — because a report had no way to declare which effect it
    // belonged to. The author's question was the whole brief: "why do I have to go
    // elsewhere to find the specular probe when I should find it under advanced
    // for the specular effect".
    if (diags.length > 0) {
      rohBody.append(sectionLabel('Diagnostics'));
      const diagWrap = styled('div', { display: 'flex', flexWrap: 'wrap', gap: '4px' });
      for (const el of diags) diagWrap.append(el);
      rohBody.append(diagWrap);
    }

    details.append(rohBody);
    body.append(details);
  }

  card.append(body);
  return card;
}
