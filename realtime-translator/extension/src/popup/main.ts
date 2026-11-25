/**
 * Phase 1 Popup UI controller.
 * Controls active tab translation, displays live local server & GPU VRAM state,
 * and allows quick Load/Unload Model, Retry Failed, and Clear Page actions.
 */

import { apiClient } from "../shared/apiClient";
import { getPreferences, savePreferences } from "../shared/storage";
import type {
  ModelStatusResponse,
  PresetId,
  TabControlMessage,
  TabModeOverride,
  TabStateSnapshot,
} from "../shared/types";

async function getActiveTabId(): Promise<number | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id ?? null;
}

async function sendTabMessage(
  msg: TabControlMessage,
): Promise<TabStateSnapshot | null> {
  const tabId = await getActiveTabId();
  if (tabId === null) {
    return null;
  }
  try {
    const resp: unknown = await chrome.tabs.sendMessage(tabId, msg);
    if (resp && typeof resp === "object" && "enabled" in resp) {
      return resp as TabStateSnapshot;
    }
    return null;
  } catch {
    return null;
  }
}

function renderTabSnapshot(doc: Document, snapshot: TabStateSnapshot | null): void {
  const toggleBtn = doc.getElementById("toggle-btn") as HTMLButtonElement | null;
  const pageStats = doc.getElementById("page-stats");
  const modeSelect = doc.getElementById("mode-select") as HTMLSelectElement | null;
  const peekBtn = doc.getElementById("peek-btn") as HTMLButtonElement | null;
  if (!toggleBtn || !pageStats) {
    return;
  }

  if (!snapshot) {
    toggleBtn.textContent = "Unavailable on this page";
    toggleBtn.disabled = true;
    toggleBtn.classList.remove("active");
    pageStats.textContent = "Open an English web novel or manhwa page to translate.";
    return;
  }

  toggleBtn.disabled = false;
  toggleBtn.classList.toggle("active", snapshot.enabled);
  toggleBtn.textContent = snapshot.enabled
    ? `Translation ON (${snapshot.resolvedMode})`
    : "Translate Page (Alt+T)";

  if (modeSelect) {
    modeSelect.value = snapshot.modeOverride;
  }
  if (peekBtn) {
    peekBtn.textContent = snapshot.peekActive ? "Unpeek (Alt+O)" : "Peek (Alt+O)";
  }

  if (snapshot.resolvedMode === "manhwa") {
    pageStats.textContent =
      snapshot.totalImages === 0
        ? snapshot.enabled
          ? "Scanning vertical strips..."
          : "Manhwa mode ready (Alt+T translate, Alt+S snip)."
        : `Translated ${snapshot.translatedImages}/${snapshot.totalImages} strips` +
          (snapshot.pendingCount > 0 ? ` • ${snapshot.pendingCount} queued` : "") +
          (snapshot.failedCount > 0 ? ` • ${snapshot.failedCount} failed` : "");
    return;
  }

  if (snapshot.totalParagraphs === 0) {
    pageStats.textContent = snapshot.enabled
      ? "Scanning paragraphs..."
      : "Press Alt+T or click above to start bilingual translation.";
    return;
  }

  pageStats.textContent =
    `Translated ${snapshot.translatedCount}/${snapshot.totalParagraphs} paragraphs` +
    (snapshot.pendingCount > 0 ? ` • ${snapshot.pendingCount} queued` : "") +
    (snapshot.failedCount > 0 ? ` • ${snapshot.failedCount} failed` : "");
}

function renderModelStatus(doc: Document, status: ModelStatusResponse): void {
  const badge = doc.getElementById("model-state-badge");
  const meta = doc.getElementById("model-meta");
  const loadBtn = doc.getElementById("load-model-btn") as HTMLButtonElement | null;
  const unloadBtn = doc.getElementById("unload-model-btn") as HTMLButtonElement | null;

  if (badge) {
    badge.textContent = status.state;
  }
  if (meta) {
    const vramLine =
      status.vram_total_mb > 0
        ? `VRAM: ${status.vram_allocated_mb.toLocaleString()} / ${status.vram_total_mb.toLocaleString()} MiB`
        : "CUDA unavailable (CPU mode)";
    const idleLine =
      status.state === "loaded"
        ? ` • Auto-unload: ${status.idle_unload_minutes}m`
        : "";
    const errLine = status.last_error ? ` • Error: ${status.last_error}` : "";
    meta.textContent = `${status.model_id} (${status.quantization}) — ${vramLine}${idleLine}${errLine}`;
  }
  if (loadBtn) {
    loadBtn.disabled = status.state === "loading" || status.state === "loaded";
  }
  if (unloadBtn) {
    unloadBtn.disabled = status.state === "unloaded" || status.state === "unloading";
  }
}

export async function refreshPopup(doc: Document = document): Promise<void> {
  const dot = doc.getElementById("server-dot");
  const serverLabel = doc.getElementById("server-label");
  const modelBadge = doc.getElementById("model-state-badge");
  const modelMeta = doc.getElementById("model-meta");
  const loadBtn = doc.getElementById("load-model-btn") as HTMLButtonElement | null;
  const unloadBtn = doc.getElementById("unload-model-btn") as HTMLButtonElement | null;

  try {
    const [health, modelStatus] = await Promise.all([
      apiClient.getHealth(),
      apiClient.getModelStatus(),
    ]);
    if (dot) {
      dot.className = "dot online";
    }
    if (serverLabel) {
      serverLabel.textContent = health.cuda_available ? "Online (GPU)" : "Online (CPU)";
    }
    renderModelStatus(doc, modelStatus);
  } catch {
    if (dot) {
      dot.className = "dot offline";
    }
    if (serverLabel) {
      serverLabel.textContent = "Server Offline";
    }
    if (modelBadge) {
      modelBadge.textContent = "offline";
    }
    if (modelMeta) {
      modelMeta.textContent = "Start local backend on http://127.0.0.1:8765.";
    }
    if (loadBtn) {
      loadBtn.disabled = true;
    }
    if (unloadBtn) {
      unloadBtn.disabled = true;
    }
  }

  const snapshot = await sendTabMessage({ type: "RT_TAB_GET_STATE" });
  renderTabSnapshot(doc, snapshot);
}

export async function initPopup(doc: Document = document): Promise<void> {
  const toggleBtn = doc.getElementById("toggle-btn") as HTMLButtonElement | null;
  const snipBtn = doc.getElementById("snip-btn") as HTMLButtonElement | null;
  const peekBtn = doc.getElementById("peek-btn") as HTMLButtonElement | null;
  const retryBtn = doc.getElementById("retry-btn") as HTMLButtonElement | null;
  const clearBtn = doc.getElementById("clear-btn") as HTMLButtonElement | null;
  const modeSelect = doc.getElementById("mode-select") as HTMLSelectElement | null;
  const presetSelect = doc.getElementById("preset-select") as HTMLSelectElement | null;
  const loadBtn = doc.getElementById("load-model-btn") as HTMLButtonElement | null;
  const unloadBtn = doc.getElementById("unload-model-btn") as HTMLButtonElement | null;
  const optionsBtn = doc.getElementById("options-btn") as HTMLButtonElement | null;
  const statusText = doc.getElementById("status-text");

  const prefs = await getPreferences().catch(() => null);
  if (prefs) {
    if (presetSelect) {
      presetSelect.value = prefs.activePreset;
    }
    if (statusText) {
      statusText.textContent = prefs.serverBaseUrl;
    }
  }

  toggleBtn?.addEventListener("click", () => {
    const preset = (presetSelect?.value as PresetId | undefined) ?? "light_novel";
    const modeOverride = (modeSelect?.value as TabModeOverride | undefined) ?? "auto";
    void sendTabMessage({ type: "RT_TAB_TOGGLE", preset, modeOverride }).then((snap) => {
      renderTabSnapshot(doc, snap);
    });
  });

  modeSelect?.addEventListener("change", () => {
    const modeOverride = modeSelect.value as TabModeOverride;
    void sendTabMessage({ type: "RT_TAB_SET_MODE", modeOverride }).then((snap) => {
      renderTabSnapshot(doc, snap);
    });
  });

  snipBtn?.addEventListener("click", () => {
    void sendTabMessage({ type: "RT_TAB_SNIP" }).then(() => {
      window.close();
    });
  });

  peekBtn?.addEventListener("click", () => {
    void sendTabMessage({ type: "RT_TAB_PEEK" }).then((snap) => {
      renderTabSnapshot(doc, snap);
    });
  });

  retryBtn?.addEventListener("click", () => {
    void sendTabMessage({ type: "RT_TAB_RETRY_FAILED" }).then((snap) => {
      renderTabSnapshot(doc, snap);
    });
  });

  clearBtn?.addEventListener("click", () => {
    void sendTabMessage({ type: "RT_TAB_CLEAR_PAGE" }).then((snap) => {
      renderTabSnapshot(doc, snap);
    });
  });

  presetSelect?.addEventListener("change", () => {
    const nextPreset = presetSelect.value as PresetId;
    void savePreferences({ activePreset: nextPreset });
  });

  loadBtn?.addEventListener("click", () => {
    if (loadBtn) {
      loadBtn.disabled = true;
      loadBtn.textContent = "Loading...";
    }
    void apiClient
      .loadModel({ load_vision: false })
      .then((status) => renderModelStatus(doc, status))
      .catch(() => refreshPopup(doc))
      .finally(() => {
        if (loadBtn) {
          loadBtn.textContent = "Load Model";
        }
      });
  });

  unloadBtn?.addEventListener("click", () => {
    if (unloadBtn) {
      unloadBtn.disabled = true;
    }
    void apiClient.unloadModel().finally(() => {
      void refreshPopup(doc);
    });
  });

  optionsBtn?.addEventListener("click", () => {
    void chrome.runtime.openOptionsPage();
  });

  await refreshPopup(doc);
  const pollTimer = window.setInterval(() => {
    void refreshPopup(doc);
  }, 3000);
  window.addEventListener(
    "unload",
    () => {
      window.clearInterval(pollTimer);
    },
    { once: true },
  );
}

if (typeof chrome !== "undefined" && chrome.tabs && document.getElementById("toggle-btn")) {
  void initPopup(document);
}
