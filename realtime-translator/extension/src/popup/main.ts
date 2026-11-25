/**
 * Phase 3 Toolbar Popup UI controller.
 * - Master Enable (Alt+T), Per-site Auto-enable Whitelist, Mode override
 * - Tone Preset & Active Series Glossary selector (with URL auto-match)
 * - Quick Snip (Alt+S), Peek (Alt+O), Retry Failed, Clear Page
 * - Live Server/GPU/VRAM progress bar + idle auto-unload countdown + Unload GPU Now
 */

import { apiClient } from "../shared/apiClient";
import { findMatchingGlossary } from "../shared/detector";
import {
  getPreferences,
  getSiteRule,
  savePreferences,
  setSiteRule,
} from "../shared/storage";
import type {
  GlossaryResponse,
  ModelStatusResponse,
  PresetId,
  TabControlMessage,
  TabModeOverride,
  TabStateSnapshot,
} from "../shared/types";

let currentHostname = "";
let currentUrl = "";
let cachedGlossaries: GlossaryResponse[] = [];

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

async function sendTabMessage(
  msg: TabControlMessage,
): Promise<TabStateSnapshot | null> {
  const tab = await getActiveTab();
  if (tab?.id === undefined) {
    return null;
  }
  try {
    const resp: unknown = await chrome.tabs.sendMessage(tab.id, msg);
    if (resp && typeof resp === "object" && "enabled" in resp) {
      return resp as TabStateSnapshot;
    }
    return null;
  } catch {
    return null;
  }
}

function formatIdleCountdown(status: ModelStatusResponse): string {
  if (status.state !== "loaded") {
    return "";
  }
  const totalSec = status.idle_unload_minutes * 60;
  const remaining = Math.max(0, totalSec - status.idle_seconds);
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  return ` • Auto-unload in ${mins}m ${String(secs).padStart(2, "0")}s`;
}

function populateGlossarySelect(
  doc: Document,
  glossaries: GlossaryResponse[],
  activeGlossaryId: string | null,
  pageUrl: string,
): void {
  const select = doc.getElementById("glossary-select") as HTMLSelectElement | null;
  if (!select) {
    return;
  }
  const autoMatch = findMatchingGlossary(pageUrl, glossaries);
  select.textContent = "";

  const noneOpt = doc.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "None (No Glossary)";
  select.appendChild(noneOpt);

  for (const g of glossaries) {
    const opt = doc.createElement("option");
    opt.value = g.id;
    const tag = autoMatch?.id === g.id ? " [Auto]" : "";
    opt.textContent = `${g.name} (${g.entries.length})${tag}`;
    select.appendChild(opt);
  }

  select.value = activeGlossaryId ?? "";
}

function renderTabSnapshot(doc: Document, snapshot: TabStateSnapshot | null): void {
  const toggleBtn = doc.getElementById("toggle-btn") as HTMLButtonElement | null;
  const pageStats = doc.getElementById("page-stats");
  const modeSelect = doc.getElementById("mode-select") as HTMLSelectElement | null;
  const peekBtn = doc.getElementById("peek-btn") as HTMLButtonElement | null;
  const autoCheck = doc.getElementById("auto-enable-check") as HTMLInputElement | null;
  const autoLabel = doc.getElementById("auto-enable-label");
  if (!toggleBtn || !pageStats) {
    return;
  }

  if (!snapshot) {
    toggleBtn.textContent = "Unavailable on this page";
    toggleBtn.disabled = true;
    toggleBtn.classList.remove("active");
    if (autoCheck) {
      autoCheck.disabled = true;
      autoCheck.checked = false;
    }
    pageStats.textContent = "Open an English web novel or manhwa page to translate.";
    return;
  }

  currentHostname = snapshot.hostname;
  currentUrl = snapshot.url;

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
  if (autoCheck && currentHostname) {
    autoCheck.disabled = false;
    autoCheck.checked = snapshot.autoEnabledSite;
  }
  if (autoLabel && currentHostname) {
    autoLabel.textContent = `Always enable on ${currentHostname}`;
  }

  populateGlossarySelect(doc, cachedGlossaries, snapshot.glossaryId, currentUrl);

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
  const vramBar = doc.getElementById("vram-bar-fill");
  const loadBtn = doc.getElementById("load-model-btn") as HTMLButtonElement | null;
  const unloadBtn = doc.getElementById("unload-model-btn") as HTMLButtonElement | null;

  if (badge) {
    badge.textContent = status.state;
  }

  if (vramBar) {
    const pct =
      status.vram_total_mb > 0
        ? Math.min(100, Math.round((status.vram_allocated_mb / status.vram_total_mb) * 100))
        : 0;
    vramBar.style.width = `${pct}%`;
    vramBar.classList.toggle("warn", pct >= 85);
  }

  if (meta) {
    const vramLine =
      status.vram_total_mb > 0
        ? `VRAM: ${status.vram_allocated_mb.toLocaleString()} / ${status.vram_total_mb.toLocaleString()} MiB`
        : "CUDA unavailable (CPU mode)";
    const visionTag = status.bubble_detector_loaded ? " • YOLO active" : "";
    const idleLine = formatIdleCountdown(status);
    const errLine = status.last_error ? ` • Error: ${status.last_error}` : "";
    meta.textContent = `${status.model_id} (${status.quantization}) — ${vramLine}${visionTag}${idleLine}${errLine}`;
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
  const vramBar = doc.getElementById("vram-bar-fill");
  const loadBtn = doc.getElementById("load-model-btn") as HTMLButtonElement | null;
  const unloadBtn = doc.getElementById("unload-model-btn") as HTMLButtonElement | null;

  try {
    const [health, modelStatus, glossaryList] = await Promise.all([
      apiClient.getHealth(),
      apiClient.getModelStatus(),
      apiClient.listGlossaries().catch(() => ({ glossaries: cachedGlossaries })),
    ]);
    cachedGlossaries = glossaryList.glossaries;
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
    if (vramBar) {
      vramBar.style.width = "0%";
    }
    if (modelMeta) {
      modelMeta.textContent = "Start local backend via start.bat (http://127.0.0.1:8765).";
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
  const autoCheck = doc.getElementById("auto-enable-check") as HTMLInputElement | null;
  const snipBtn = doc.getElementById("snip-btn") as HTMLButtonElement | null;
  const peekBtn = doc.getElementById("peek-btn") as HTMLButtonElement | null;
  const retryBtn = doc.getElementById("retry-btn") as HTMLButtonElement | null;
  const clearBtn = doc.getElementById("clear-btn") as HTMLButtonElement | null;
  const modeSelect = doc.getElementById("mode-select") as HTMLSelectElement | null;
  const presetSelect = doc.getElementById("preset-select") as HTMLSelectElement | null;
  const glossarySelect = doc.getElementById("glossary-select") as HTMLSelectElement | null;
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
    const glossaryId = glossarySelect?.value ? glossarySelect.value : null;
    void sendTabMessage({
      type: "RT_TAB_TOGGLE",
      preset,
      modeOverride,
      glossaryId,
    }).then((snap) => {
      renderTabSnapshot(doc, snap);
    });
  });

  autoCheck?.addEventListener("change", () => {
    if (!currentHostname) {
      return;
    }
    const autoEnable = autoCheck.checked;
    const modeOverride = (modeSelect?.value as TabModeOverride | undefined) ?? "auto";
    void setSiteRule(currentHostname, { autoEnable, modeOverride }).then(() => {
      if (autoEnable) {
        return sendTabMessage({ type: "RT_TAB_TOGGLE", enabled: true, modeOverride });
      }
      return sendTabMessage({ type: "RT_TAB_APPLY_PREFS" });
    }).then((snap) => {
      renderTabSnapshot(doc, snap);
    });
  });

  modeSelect?.addEventListener("change", () => {
    const modeOverride = modeSelect.value as TabModeOverride;
    const updateSite = currentHostname
      ? setSiteRule(currentHostname, { modeOverride })
      : Promise.resolve(null);
    void updateSite
      .then(() => sendTabMessage({ type: "RT_TAB_SET_MODE", modeOverride }))
      .then((snap) => {
        renderTabSnapshot(doc, snap);
      });
  });

  presetSelect?.addEventListener("change", () => {
    const nextPreset = presetSelect.value as PresetId;
    void savePreferences({ activePreset: nextPreset }).then(() =>
      sendTabMessage({ type: "RT_TAB_APPLY_PREFS" }),
    );
  });

  glossarySelect?.addEventListener("change", () => {
    const glossaryId = glossarySelect.value ? glossarySelect.value : null;
    const saveRule = currentHostname
      ? getSiteRule(currentHostname).then((existing) =>
          setSiteRule(currentHostname, { ...existing, glossaryId }),
        )
      : Promise.resolve(null);
    void saveRule
      .then(() => sendTabMessage({ type: "RT_TAB_SET_GLOSSARY", glossaryId }))
      .then((snap) => {
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
