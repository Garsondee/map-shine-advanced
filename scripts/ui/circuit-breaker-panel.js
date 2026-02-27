/**
 * @fileoverview Circuit Breaker Panel — GM debugging tool.
 *
 * Provides a single place to disable effects before they are instantiated.
 * Stored client-local (localStorage).
 *
 * @module ui/circuit-breaker-panel
 */

import { getCircuitBreaker, CIRCUIT_BREAKER_EFFECTS } from '../core/circuit-breaker.js';

function _escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function _renderPanelHtml(state) {
  const rows = [];
  for (const def of CIRCUIT_BREAKER_EFFECTS) {
    const id = def.id;
    const label = def.label;
    const desc = def.description || '';
    const checked = state.disabled?.[id] === true;
    rows.push(`
      <div class="form-group" style="display:flex; gap:12px; align-items:flex-start;">
        <div style="padding-top:2px;">
          <input type="checkbox" name="cb_${_escapeHtml(id)}" ${checked ? 'checked' : ''} />
        </div>
        <div style="flex:1;">
          <label style="display:block; font-weight:600;">${_escapeHtml(label)}</label>
          <div style="font-size:12px; opacity:0.85;">${_escapeHtml(id)}</div>
          ${desc ? `<div style="font-size:12px; opacity:0.85; margin-top:2px;">${_escapeHtml(desc)}</div>` : ''}
        </div>
      </div>
    `);
  }

  return `
    <form>
      <p style="margin-top:0; opacity:0.9;">
        Disable effects here to isolate crashes/freezes. Changes are client-local.
        Reload the page after changes for a clean test.
      </p>
      <hr/>
      ${rows.join('\n')}
    </form>
  `;
}

export async function openCircuitBreakerPanel() {
  const isGM = globalThis.game?.user?.isGM ?? false;
  if (!isGM) {
    globalThis.ui?.notifications?.warn?.('Circuit Breaker Panel is GM-only.');
    return;
  }

  const cb = getCircuitBreaker();
  cb.ensureKnown(CIRCUIT_BREAKER_EFFECTS);

  const state = cb.getState();
  const content = _renderPanelHtml(state);

  const dlg = new Dialog({
    title: 'Map Shine: Circuit Breaker Panel',
    content,
    buttons: {
      disableAll: {
        icon: '<i class="fas fa-ban"></i>',
        label: 'Disable All',
        callback: () => {
          try {
            for (const def of CIRCUIT_BREAKER_EFFECTS) {
              cb.setDisabled(def.id, true);
            }
            globalThis.ui?.notifications?.info?.('All effects disabled in circuit breaker. Reload Foundry to take effect.');
          } catch (e) {
            console.error('Circuit Breaker disableAll failed', e);
          }
        },
      },
      enableAll: {
        icon: '<i class="fas fa-play"></i>',
        label: 'Enable All',
        callback: () => {
          try {
            for (const def of CIRCUIT_BREAKER_EFFECTS) {
              cb.setDisabled(def.id, false);
            }
            globalThis.ui?.notifications?.info?.('All effects enabled in circuit breaker. Reload Foundry to take effect.');
          } catch (e) {
            console.error('Circuit Breaker enableAll failed', e);
          }
        },
      },
      apply: {
        icon: '<i class="fas fa-check"></i>',
        label: 'Apply',
        callback: (html) => {
          try {
            const form = html?.[0]?.querySelector?.('form') ?? html?.find?.('form')?.[0];
            if (!form) return;

            for (const def of CIRCUIT_BREAKER_EFFECTS) {
              const id = def.id;
              const input = form.querySelector(`input[name="cb_${CSS.escape(id)}"]`);
              const on = !!input?.checked;
              cb.setDisabled(id, on);
            }

            globalThis.ui?.notifications?.info?.('Circuit breaker updated. Reload Foundry to take effect.');
          } catch (e) {
            console.error('Circuit Breaker apply failed', e);
            globalThis.ui?.notifications?.warn?.('Failed to apply circuit breaker settings.');
          }
        },
      },
      reset: {
        icon: '<i class="fas fa-undo"></i>',
        label: 'Reset All',
        callback: () => {
          cb.clearAll();
          globalThis.ui?.notifications?.info?.('Circuit breaker reset. Reload Foundry to take effect.');
        },
      },
      close: {
        icon: '<i class="fas fa-times"></i>',
        label: 'Close',
      },
    },
    default: 'apply',
  });

  dlg.render(true);
}
