/**
 * Content script coordinator (Phase 0 scaffold).
 * Compiled as a self-contained IIFE to `dist/content.js`.
 */

const RT_ROOT_ATTR = "data-rt-ready";

export function markContentReady(root: HTMLElement = document.documentElement): void {
  root.setAttribute(RT_ROOT_ATTR, "1");
}

if (typeof document !== "undefined" && document.documentElement) {
  markContentReady(document.documentElement);
}
