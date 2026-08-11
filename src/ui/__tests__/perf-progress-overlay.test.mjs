/**
 * ui/perf-progress-overlay.js — the pure text-formatting core, plus the
 * environment-safety guarantee: importing and calling this module under
 * plain Node (no `document`) must never throw and must never fake visibility.
 */
import {
  formatPerfProgressText,
  showPerfProgress,
  updatePerfProgress,
  hidePerfProgress,
  isPerfProgressVisible,
} from '../perf-progress-overlay.js';

export function run(t) {
  // ---- text formatting -------------------------------------------------
  t.ok('a known phase gets its friendly label', formatPerfProgressText('settling') === 'Profiling: settling');
  t.ok(
    'a detail string is appended after an em dash',
    formatPerfProgressText('measuring', '231 frames · 24.6s elapsed') ===
      'Profiling: measuring — 231 frames · 24.6s elapsed'
  );
  t.ok(
    'measuring-tick uses the same label as measuring',
    formatPerfProgressText('measuring-tick', '5 frames · 1.0s elapsed') ===
      'Profiling: measuring — 5 frames · 1.0s elapsed'
  );
  t.ok(
    'an unrecognised phase falls back to its own name',
    formatPerfProgressText('sweeping') === 'Profiling: sweeping'
  );
  t.ok('a phase with no detail carries no dash', !formatPerfProgressText('building').includes('—'));
  t.ok('an unknown phase name is not swallowed', formatPerfProgressText('mystery-phase') === 'mystery-phase');

  // ---- environment safety: no DOM here, so every call must be a safe no-op
  t.ok('not visible before show', isPerfProgressVisible() === false);
  showPerfProgress(formatPerfProgressText('settling'));
  t.ok(
    'showPerfProgress does not throw, and does not fake visibility without a DOM',
    isPerfProgressVisible() === false
  );
  updatePerfProgress(formatPerfProgressText('measuring', '1 frame'));
  hidePerfProgress();
  t.ok('hidePerfProgress is safe to call with nothing shown', isPerfProgressVisible() === false);
}
