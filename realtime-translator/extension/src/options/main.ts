/** Options page entrypoint (Phase 0 scaffold). */

export function initOptions(doc: Document = document): void {
  const statusEl = doc.getElementById("options-status");
  if (statusEl) {
    statusEl.textContent = "Options page loaded — full settings arrive in Phase 3";
  }
}

initOptions();

