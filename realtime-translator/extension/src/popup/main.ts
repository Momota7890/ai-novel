/** Popup entrypoint (Phase 0 scaffold). */

export function initPopup(doc: Document = document): void {
  const statusEl = doc.getElementById("status-text");
  if (statusEl) {
    statusEl.textContent = "Extension loaded — waiting for Phase 1 backend";
  }
}

initPopup();

