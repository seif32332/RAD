// Pure helpers behind <Modal> keyboard handling (no React / DOM globals, so they can be unit-tested).

/** Selector for elements that can receive keyboard focus inside a dialog. */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Where Tab / Shift+Tab should move focus so it never leaves the dialog.
 * Returns the index to focus, or null to let the browser move focus normally.
 *
 * - `current` is the index of the focused element among the focusables (-1 when focus is on the
 *   dialog itself or outside it).
 * - Tab on the last element wraps to the first; Shift+Tab on the first wraps to the last.
 */
export function trapTabIndex(current: number, count: number, shift: boolean): number | null {
  if (count <= 0) return -1; // nothing focusable: keep focus on the dialog container
  if (current < 0 || current >= count) return shift ? count - 1 : 0;
  if (shift && current === 0) return count - 1;
  if (!shift && current === count - 1) return 0;
  return null;
}
