/**
 * @fileoverview Tweakpane DOM for the shared mask-status row template.
 *
 * @module ui/mask-status-ui
 */

import {
  buildMaskSetupHelpText,
  formatTextureStatusMessage,
  getMaskStatusTemplate,
  resolveEffectMaskStatus,
} from './effect-mask-status.js';

/**
 * @typedef {Object} MaskStatusRowElements
 * @property {HTMLElement} row
 * @property {HTMLElement} value
 * @property {HTMLElement} helpBtn
 * @property {MaskStatusTemplate} template
 */

/** Chip text colours — inline on the value so Tweakpane theme tokens cannot override. */
const MASK_STATUS_VALUE_COLORS = Object.freeze({
  searching: '#c9b458',
  found: '#6fcf8a',
  missing: '#ff7b7b',
  'missing-alert': '#ff7b7b',
  'missing-muted': '#888888',
});

/**
 * @param {string} text
 * @returns {string}
 */
function escHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {MaskStatusTemplate} template
 */
function openMaskSetupHelpDialog(template) {
  const title = `${template.suffix} mask — setup guide`;
  const body = buildMaskSetupHelpText(template);
  const html = body
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t) return '<p style="margin:0.35em 0"></p>';
      if (t.endsWith(':') && !t.startsWith('•')) {
        return `<p style="margin:0.65em 0 0.2em;font-weight:600">${escHtml(t)}</p>`;
      }
      const content = t.startsWith('•') ? t.slice(1).trim() : t;
      return `<p style="margin:0.2em 0 0.2em 1em;text-indent:-1em;padding-left:1em">• ${escHtml(content)}</p>`;
    })
    .join('');

  new Dialog({
    title: escHtml(title),
    content: `<div class="ms-mask-status-dialog" style="font-size:12px;line-height:1.45;max-height:60vh;overflow:auto">${html}</div>`,
    buttons: {
      close: {
        icon: '<i class="fas fa-times"></i>',
        label: 'Close',
        callback: () => true,
      },
    },
    default: 'close',
  }).render(true);
}

/**
 * @param {HTMLElement} folderElement
 * @returns {HTMLElement|null}
 */
export function getEffectFolderContentElement(folderElement) {
  if (!folderElement) return null;
  return folderElement.querySelector('.tp-fldv_c') || folderElement;
}

/**
 * Locate the Enabled checkbox row inside an effect folder content area.
 * @param {HTMLElement} contentElement
 * @param {HTMLElement|null} insertAfterEl
 * @returns {HTMLElement|null}
 */
export function findEnabledBlade(contentElement, insertAfterEl) {
  if (!contentElement) return null;

  const fromAnchor = insertAfterEl?.closest?.('.tp-lblv');
  if (fromAnchor && contentElement.contains(fromAnchor)) return fromAnchor;

  for (const blade of contentElement.querySelectorAll('.tp-lblv')) {
    const label = blade.querySelector('.tp-lblv_l');
    if (label?.textContent?.trim() === 'Enabled') return blade;
  }

  for (const blade of contentElement.querySelectorAll('.tp-lblv')) {
    const text = (blade.textContent || '').replace(/\s+/g, ' ').trim();
    if (!/\bEnabled\b/.test(text)) continue;
    if (blade.querySelector('input[type="checkbox"], .tp-ckbv_i, .tp-ckbv_w')) {
      return blade;
    }
  }

  return null;
}

/**
 * Place (or re-place) the mask status row directly under Enabled.
 * Never detaches the row unless it can be re-inserted.
 * @param {HTMLElement} folderElement
 * @param {HTMLElement|null} insertAfterEl
 * @param {HTMLElement} row
 * @returns {boolean}
 */
export function placeMaskStatusRow(folderElement, insertAfterEl, row) {
  const contentElement = getEffectFolderContentElement(folderElement);
  if (!contentElement || !row) return false;

  const blade = findEnabledBlade(contentElement, insertAfterEl);
  if (blade) {
    blade.insertAdjacentElement('afterend', row);
    return true;
  }

  const firstNestedFolder = contentElement.querySelector(':scope > .tp-fldv');
  if (firstNestedFolder) {
    contentElement.insertBefore(row, firstNestedFolder);
    return true;
  }

  contentElement.appendChild(row);
  return true;
}

/**
 * @param {HTMLElement} folderElement
 * @param {import('./effect-mask-status.js').MaskStatusGroupConfig} group
 * @param {HTMLElement|null} [insertAfterEl]
 * @returns {MaskStatusRowElements|null}
 */
export function createMaskStatusRow(folderElement, group, insertAfterEl = null) {
  const contentElement = getEffectFolderContentElement(folderElement);
  if (!contentElement) return null;

  const template = getMaskStatusTemplate(group?.maskId || group?.templateId, group);
  const helpText = buildMaskSetupHelpText(template);

  const row = document.createElement('div');
  row.className = 'ms-mask-status-row ms-mask-status-row--missing-muted';
  row.setAttribute('role', 'status');
  row.setAttribute('aria-live', 'polite');

  const labelEl = document.createElement('span');
  labelEl.className = 'ms-mask-status-label';
  labelEl.textContent = template.label || 'Texture';

  const valueEl = document.createElement('span');
  valueEl.className = 'ms-mask-status-value';
  valueEl.textContent = formatTextureStatusMessage(template, 'missing');

  const helpBtn = document.createElement('button');
  helpBtn.type = 'button';
  helpBtn.className = 'ms-mask-status-help-btn';
  helpBtn.setAttribute('aria-label', `${template.suffix} mask setup help`);
  helpBtn.title = helpText.length > 240 ? `${helpText.slice(0, 237)}…` : helpText;
  helpBtn.textContent = '?';

  helpBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openMaskSetupHelpDialog(template);
  });

  row.appendChild(labelEl);
  row.appendChild(valueEl);
  row.appendChild(helpBtn);

  placeMaskStatusRow(folderElement, insertAfterEl, row);

  return { row, label: labelEl, value: valueEl, helpBtn, template };
}

/**
 * @param {MaskStatusRowElements} elements
 * @param {import('./effect-mask-status.js').MaskStatusResult|null} status
 */
export function applyMaskStatusPresentation(elements, status) {
  if (!elements?.row || !elements?.value) return;
  const phase = status?.phase || 'missing-muted';
  const color = MASK_STATUS_VALUE_COLORS[phase] ?? MASK_STATUS_VALUE_COLORS['missing-muted'];

  if (status?.helpMaskId) {
    elements.template = getMaskStatusTemplate(status.helpMaskId);
    const helpText = buildMaskSetupHelpText(elements.template);
    if (elements.helpBtn) {
      elements.helpBtn.setAttribute('aria-label', `${elements.template.suffix} mask setup help`);
      elements.helpBtn.title = helpText.length > 240 ? `${helpText.slice(0, 237)}…` : helpText;
    }
  }
  if (status?.label && elements.label) {
    elements.label.textContent = status.label;
  }

  elements.row.classList.remove(
    'ms-mask-status-row--searching',
    'ms-mask-status-row--found',
    'ms-mask-status-row--missing',
    'ms-mask-status-row--missing-muted',
    'ms-mask-status-row--missing-alert',
  );
  elements.row.classList.add(`ms-mask-status-row--${phase}`);
  elements.row.dataset.msMaskPhase = phase;
  elements.value.dataset.msMaskPhase = phase;
  elements.value.style.color = color;
  elements.value.textContent = status?.message || formatTextureStatusMessage(elements.template, 'missing');
}

/**
 * @param {string} effectId
 * @param {import('./effect-mask-status.js').MaskStatusGroupConfig} config
 * @param {MaskStatusRowElements|null} elements
 */
export function refreshMaskStatusRow(effectId, config, elements) {
  if (!elements) return;
  const status = resolveEffectMaskStatus(effectId, config);
  if (!status) return;
  applyMaskStatusPresentation(elements, status);
}
