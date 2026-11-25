/**
 * Phase 3 Full Options Page controller:
 * 1. Per-Series Glossary Manager (CRUD + CSV/JSON import & export)
 * 2. Site Auto-Enable Whitelist & Mode Overrides
 * 3. Thai Typography & Manhwa Overlay Appearance + Live Preview
 * 4. Hugging Face Model ID, Idle Unload Timeout & Bounded SQLite Cache Controls
 */

import { apiClient } from "../shared/apiClient";
import {
  DEFAULT_TYPOGRAPHY,
  type PageModeOverride,
  type TypographyPrefs,
  getPreferences,
  normalizeServerBaseUrl,
  removeSiteRule,
  savePreferences,
  setSiteRule,
} from "../shared/storage";
import type {
  GlossaryCategory,
  GlossaryEntryInput,
  GlossaryResponse,
  GlossaryUpsertRequest,
  PresetId,
} from "../shared/types";
import {
  exportGlossaryCsv,
  exportGlossaryJson,
  parseGlossaryCsv,
  parseGlossaryJson,
} from "./glossaryCsv";

let glossaries: GlossaryResponse[] = [];
let selectedGlossaryId: string | null = null;
let pendingImportMode: "csv" | "json" = "csv";

function setStatus(doc: Document, msg: string, kind: "ok" | "err" | "info" = "info"): void {
  const el = doc.getElementById("options-status");
  if (!el) {
    return;
  }
  el.textContent = msg;
  el.className = kind === "info" ? "toast" : `toast ${kind}`;
}

function downloadTextFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function appendTermRow(
  doc: Document,
  entry: GlossaryEntryInput = {
    source_term: "",
    target_term: "",
    category: "name",
    note: "",
  },
): void {
  const tbody = doc.getElementById("glossary-rows");
  if (!tbody) {
    return;
  }
  const tr = doc.createElement("tr");

  const srcInput = doc.createElement("input");
  srcInput.type = "text";
  srcInput.className = "term-src";
  srcInput.value = entry.source_term;
  srcInput.placeholder = "Sung Jin-Woo";

  const tgtInput = doc.createElement("input");
  tgtInput.type = "text";
  tgtInput.className = "term-tgt";
  tgtInput.value = entry.target_term;
  tgtInput.placeholder = "ซองจินอู";

  const catSelect = doc.createElement("select");
  catSelect.className = "term-cat";
  for (const cat of ["name", "skill", "place", "pronoun", "term"] as GlossaryCategory[]) {
    const opt = doc.createElement("option");
    opt.value = cat;
    opt.textContent = cat;
    catSelect.appendChild(opt);
  }
  catSelect.value = entry.category;

  const noteInput = doc.createElement("input");
  noteInput.type = "text";
  noteInput.className = "term-note";
  noteInput.value = entry.note;
  noteInput.placeholder = "Pronoun / tone note";

  const delBtn = doc.createElement("button");
  delBtn.type = "button";
  delBtn.className = "btn btn-danger";
  delBtn.textContent = "×";
  delBtn.addEventListener("click", () => tr.remove());

  for (const control of [srcInput, tgtInput, catSelect, noteInput, delBtn]) {
    const td = doc.createElement("td");
    td.appendChild(control);
    tr.appendChild(td);
  }
  tbody.appendChild(tr);
}

function collectGlossaryForm(doc: Document): GlossaryUpsertRequest {
  const name = (doc.getElementById("glossary-name") as HTMLInputElement).value.trim();
  const url_pattern = (doc.getElementById("glossary-pattern") as HTMLInputElement).value.trim();
  const default_preset = (doc.getElementById("glossary-preset") as HTMLSelectElement)
    .value as PresetId;

  const rows = Array.from(doc.querySelectorAll("#glossary-rows tr"));
  const entries: GlossaryEntryInput[] = [];
  for (const row of rows) {
    const src = (row.querySelector(".term-src") as HTMLInputElement | null)?.value.trim() ?? "";
    const tgt = (row.querySelector(".term-tgt") as HTMLInputElement | null)?.value.trim() ?? "";
    const cat =
      ((row.querySelector(".term-cat") as HTMLSelectElement | null)
        ?.value as GlossaryCategory | undefined) ?? "term";
    const note = (row.querySelector(".term-note") as HTMLInputElement | null)?.value.trim() ?? "";
    if (src && tgt) {
      entries.push({ source_term: src, target_term: tgt, category: cat, note });
    }
  }

  return { name, url_pattern, default_preset, entries };
}

function loadGlossaryIntoEditor(doc: Document, g: GlossaryResponse | null): void {
  selectedGlossaryId = g?.id ?? null;
  (doc.getElementById("glossary-name") as HTMLInputElement).value = g?.name ?? "";
  (doc.getElementById("glossary-pattern") as HTMLInputElement).value = g?.url_pattern ?? "";
  (doc.getElementById("glossary-preset") as HTMLSelectElement).value =
    g?.default_preset ?? "modern_manhwa";

  const tbody = doc.getElementById("glossary-rows");
  if (tbody) {
    tbody.textContent = "";
    if (g && g.entries.length > 0) {
      for (const e of g.entries) {
        appendTermRow(doc, e);
      }
    } else {
      appendTermRow(doc);
    }
  }

  const delBtn = doc.getElementById("delete-glossary-btn") as HTMLButtonElement | null;
  if (delBtn) {
    delBtn.disabled = selectedGlossaryId === null;
  }
  renderGlossaryList(doc);
}

function renderGlossaryList(doc: Document): void {
  const listEl = doc.getElementById("glossary-list");
  if (!listEl) {
    return;
  }
  listEl.textContent = "";
  if (glossaries.length === 0) {
    const empty = doc.createElement("div");
    empty.style.color = "#94a3b8";
    empty.style.fontSize = "12px";
    empty.textContent = "No glossaries yet. Create one on the right.";
    listEl.appendChild(empty);
    return;
  }

  for (const g of glossaries) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className =
      g.id === selectedGlossaryId ? "glossary-item selected" : "glossary-item";
    btn.textContent = `${g.name} (${g.entries.length})`;
    btn.addEventListener("click", () => loadGlossaryIntoEditor(doc, g));
    listEl.appendChild(btn);
  }
}

async function refreshGlossaries(doc: Document): Promise<void> {
  try {
    const resp = await apiClient.listGlossaries();
    glossaries = resp.glossaries;
    const current =
      glossaries.find((g) => g.id === selectedGlossaryId) ?? glossaries[0] ?? null;
    loadGlossaryIntoEditor(doc, current);
  } catch {
    renderGlossaryList(doc);
  }
}

async function renderWhitelist(doc: Document): Promise<void> {
  const tbody = doc.getElementById("whitelist-rows");
  if (!tbody) {
    return;
  }
  const prefs = await getPreferences();
  tbody.textContent = "";
  const hosts = Object.keys(prefs.siteRules).sort();
  if (hosts.length === 0) {
    const tr = doc.createElement("tr");
    const td = doc.createElement("td");
    td.colSpan = 4;
    td.style.color = "#94a3b8";
    td.textContent = "No site rules configured yet.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const host of hosts) {
    const rule = prefs.siteRules[host]!;
    const tr = doc.createElement("tr");

    const hostTd = doc.createElement("td");
    hostTd.textContent = host;

    const autoTd = doc.createElement("td");
    const autoCheck = doc.createElement("input");
    autoCheck.type = "checkbox";
    autoCheck.checked = rule.autoEnable;
    autoCheck.addEventListener("change", () => {
      void setSiteRule(host, { autoEnable: autoCheck.checked }).then(() =>
        setStatus(doc, `Updated auto-enable for ${host}`, "ok"),
      );
    });
    autoTd.appendChild(autoCheck);

    const modeTd = doc.createElement("td");
    const modeSel = doc.createElement("select");
    for (const m of ["auto", "novel", "manhwa"] as PageModeOverride[]) {
      const opt = doc.createElement("option");
      opt.value = m;
      opt.textContent = m;
      modeSel.appendChild(opt);
    }
    modeSel.value = rule.modeOverride;
    modeSel.addEventListener("change", () => {
      void setSiteRule(host, { modeOverride: modeSel.value as PageModeOverride }).then(
        () => setStatus(doc, `Updated mode override for ${host}`, "ok"),
      );
    });
    modeTd.appendChild(modeSel);

    const actTd = doc.createElement("td");
    const rmBtn = doc.createElement("button");
    rmBtn.type = "button";
    rmBtn.className = "btn btn-danger";
    rmBtn.textContent = "Remove";
    rmBtn.addEventListener("click", () => {
      void removeSiteRule(host).then(() => renderWhitelist(doc));
    });
    actTd.appendChild(rmBtn);

    tr.append(hostTd, autoTd, modeTd, actTd);
    tbody.appendChild(tr);
  }
}

function readTypographyForm(doc: Document): TypographyPrefs {
  const fontFamily =
    (doc.getElementById("typo-font") as HTMLSelectElement)?.value ||
    DEFAULT_TYPOGRAPHY.fontFamily;
  const fontSize =
    (doc.getElementById("typo-size") as HTMLInputElement)?.value.trim() ||
    DEFAULT_TYPOGRAPHY.fontSize;
  const lineHeight = Number.parseFloat(
    (doc.getElementById("typo-line-height") as HTMLInputElement)?.value || "1.65",
  );
  const textColor =
    (doc.getElementById("typo-color") as HTMLInputElement)?.value.trim() || "inherit";
  const maskOpacity = Number.parseFloat(
    (doc.getElementById("typo-opacity") as HTMLInputElement)?.value || "0.98",
  );
  const manhwaFontScale = Number.parseFloat(
    (doc.getElementById("typo-scale") as HTMLInputElement)?.value || "1.0",
  );

  return {
    fontFamily,
    fontSize,
    lineHeight: Number.isFinite(lineHeight) ? lineHeight : DEFAULT_TYPOGRAPHY.lineHeight,
    textColor,
    maskOpacity: Number.isFinite(maskOpacity) ? maskOpacity : DEFAULT_TYPOGRAPHY.maskOpacity,
    manhwaFontScale: Number.isFinite(manhwaFontScale)
      ? manhwaFontScale
      : DEFAULT_TYPOGRAPHY.manhwaFontScale,
  };
}

function updateTypographyPreview(doc: Document): void {
  const typo = readTypographyForm(doc);
  const opacityVal = doc.getElementById("opacity-val");
  const scaleVal = doc.getElementById("scale-val");
  if (opacityVal) {
    opacityVal.textContent = typo.maskOpacity.toFixed(2);
  }
  if (scaleVal) {
    scaleVal.textContent = typo.manhwaFontScale.toFixed(2);
  }

  const previewThai = doc.getElementById("preview-thai");
  if (previewThai) {
    previewThai.style.fontFamily = typo.fontFamily;
    previewThai.style.fontSize = typo.fontSize;
    previewThai.style.lineHeight = String(typo.lineHeight);
    previewThai.style.color = typo.textColor;
  }

  const previewBubble = doc.getElementById("preview-bubble");
  if (previewBubble) {
    previewBubble.style.fontFamily = typo.fontFamily;
    previewBubble.style.opacity = String(typo.maskOpacity);
    previewBubble.style.fontSize = `${Math.round(14 * typo.manhwaFontScale)}px`;
  }
}

async function refreshServerAndCache(doc: Document): Promise<void> {
  try {
    const [modelStatus, stats] = await Promise.all([
      apiClient.getModelStatus(),
      apiClient.getCacheStats(),
    ]);

    (doc.getElementById("cfg-model-id") as HTMLInputElement).value = modelStatus.model_id;
    (doc.getElementById("cfg-idle-min") as HTMLInputElement).value = String(
      modelStatus.idle_unload_minutes,
    );
    (doc.getElementById("cfg-cache-mb") as HTMLInputElement).value = String(stats.max_mb);
    (doc.getElementById("cfg-cache-ttl") as HTMLInputElement).value = String(stats.ttl_days);

    const entriesEl = doc.getElementById("stat-entries");
    const sizeEl = doc.getElementById("stat-size");
    const hitEl = doc.getElementById("stat-hitrate");
    const pathEl = doc.getElementById("stat-db-path");

    if (entriesEl) {
      entriesEl.textContent = `${stats.total_entries} (${stats.novel_entries} / ${stats.manhwa_entries})`;
    }
    if (sizeEl) {
      sizeEl.textContent = `${stats.size_mb.toFixed(2)} / ${stats.max_mb} MB`;
    }
    const totalLookups = stats.session_hits + stats.session_misses;
    if (hitEl) {
      hitEl.textContent =
        totalLookups > 0
          ? `${Math.round((stats.session_hits / totalLookups) * 100)}% (${stats.session_hits}/${totalLookups})`
          : "0% (0/0)";
    }
    if (pathEl) {
      pathEl.textContent = `SQLite DB: ${stats.db_path}`;
    }
    setStatus(doc, "Connected to local server (127.0.0.1:8765)", "ok");
  } catch {
    setStatus(doc, "Local server offline — start start.bat to edit glossaries/model settings", "err");
  }
}

export async function initOptions(doc: Document = document): Promise<void> {
  const prefs = await getPreferences();
  (doc.getElementById("cfg-server-url") as HTMLInputElement).value = prefs.serverBaseUrl;
  (doc.getElementById("typo-font") as HTMLSelectElement).value = prefs.typography.fontFamily;
  (doc.getElementById("typo-size") as HTMLInputElement).value = prefs.typography.fontSize;
  (doc.getElementById("typo-line-height") as HTMLInputElement).value = String(
    prefs.typography.lineHeight,
  );
  (doc.getElementById("typo-color") as HTMLInputElement).value = prefs.typography.textColor;
  (doc.getElementById("typo-opacity") as HTMLInputElement).value = String(
    prefs.typography.maskOpacity,
  );
  (doc.getElementById("typo-scale") as HTMLInputElement).value = String(
    prefs.typography.manhwaFontScale,
  );
  updateTypographyPreview(doc);

  // Glossary controls
  doc.getElementById("new-glossary-btn")?.addEventListener("click", () => {
    loadGlossaryIntoEditor(doc, null);
  });
  doc.getElementById("add-term-btn")?.addEventListener("click", () => {
    appendTermRow(doc);
  });
  doc.getElementById("save-glossary-btn")?.addEventListener("click", () => {
    const payload = collectGlossaryForm(doc);
    if (!payload.name) {
      setStatus(doc, "Glossary name is required.", "err");
      return;
    }
    const op = selectedGlossaryId
      ? apiClient.updateGlossary(selectedGlossaryId, payload)
      : apiClient.createGlossary(payload);
    void op
      .then((saved) => {
        selectedGlossaryId = saved.id;
        setStatus(doc, `Saved glossary "${saved.name}" (${saved.entries.length} terms)`, "ok");
        return refreshGlossaries(doc);
      })
      .catch((err: unknown) => {
        setStatus(
          doc,
          err instanceof Error ? err.message : "Failed to save glossary.",
          "err",
        );
      });
  });

  doc.getElementById("delete-glossary-btn")?.addEventListener("click", () => {
    if (!selectedGlossaryId) {
      return;
    }
    const idToDelete = selectedGlossaryId;
    void apiClient
      .deleteGlossary(idToDelete)
      .then(() => {
        selectedGlossaryId = null;
        setStatus(doc, `Deleted glossary "${idToDelete}"`, "ok");
        return refreshGlossaries(doc);
      })
      .catch((err: unknown) => {
        setStatus(
          doc,
          err instanceof Error ? err.message : "Failed to delete glossary.",
          "err",
        );
      });
  });

  const fileInput = doc.getElementById("import-file-input") as HTMLInputElement | null;
  doc.getElementById("export-csv-btn")?.addEventListener("click", () => {
    const payload = collectGlossaryForm(doc);
    downloadTextFile(
      `${payload.name || "glossary"}.csv`,
      exportGlossaryCsv(payload.entries),
      "text/csv;charset=utf-8",
    );
  });
  doc.getElementById("export-json-btn")?.addEventListener("click", () => {
    const payload = collectGlossaryForm(doc);
    downloadTextFile(
      `${payload.name || "glossary"}.json`,
      exportGlossaryJson(payload),
      "application/json;charset=utf-8",
    );
  });
  doc.getElementById("import-csv-btn")?.addEventListener("click", () => {
    pendingImportMode = "csv";
    fileInput?.click();
  });
  doc.getElementById("import-json-btn")?.addEventListener("click", () => {
    pendingImportMode = "json";
    fileInput?.click();
  });
  fileInput?.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) {
      return;
    }
    void file
      .text()
      .then((text) => {
        if (pendingImportMode === "csv") {
          const imported = parseGlossaryCsv(text);
          const tbody = doc.getElementById("glossary-rows");
          if (tbody) {
            tbody.textContent = "";
            for (const entry of imported) {
              appendTermRow(doc, entry);
            }
          }
          setStatus(doc, `Imported ${imported.length} CSV terms (click Save Glossary)`, "ok");
        } else {
          const parsed = parseGlossaryJson(text);
          (doc.getElementById("glossary-name") as HTMLInputElement).value = parsed.name;
          (doc.getElementById("glossary-pattern") as HTMLInputElement).value =
            parsed.url_pattern;
          (doc.getElementById("glossary-preset") as HTMLSelectElement).value =
            parsed.default_preset;
          const tbody = doc.getElementById("glossary-rows");
          if (tbody) {
            tbody.textContent = "";
            for (const entry of parsed.entries) {
              appendTermRow(doc, entry);
            }
          }
          setStatus(
            doc,
            `Imported JSON glossary "${parsed.name}" (${parsed.entries.length} terms)`,
            "ok",
          );
        }
      })
      .catch((err: unknown) => {
        setStatus(doc, err instanceof Error ? err.message : "Import failed.", "err");
      })
      .finally(() => {
        fileInput.value = "";
      });
  });

  // Site whitelist controls
  doc.getElementById("add-site-btn")?.addEventListener("click", () => {
    const hostInput = doc.getElementById("new-site-host") as HTMLInputElement;
    const modeSelect = doc.getElementById("new-site-mode") as HTMLSelectElement;
    const host = hostInput.value.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? "";
    if (!host) {
      return;
    }
    void setSiteRule(host, {
      autoEnable: true,
      modeOverride: modeSelect.value as PageModeOverride,
    }).then(() => {
      hostInput.value = "";
      setStatus(doc, `Added ${host} to auto-enable whitelist`, "ok");
      return renderWhitelist(doc);
    });
  });

  // Typography live preview + save
  for (const id of [
    "typo-font",
    "typo-size",
    "typo-line-height",
    "typo-color",
    "typo-opacity",
    "typo-scale",
  ]) {
    doc.getElementById(id)?.addEventListener("input", () => updateTypographyPreview(doc));
    doc.getElementById(id)?.addEventListener("change", () => updateTypographyPreview(doc));
  }

  doc.getElementById("save-typo-btn")?.addEventListener("click", () => {
    const typography = readTypographyForm(doc);
    void savePreferences({ typography }).then(() => {
      setStatus(doc, "Typography & overlay appearance saved", "ok");
    });
  });

  // Model & cache settings
  doc.getElementById("save-server-btn")?.addEventListener("click", () => {
    const rawUrl = (doc.getElementById("cfg-server-url") as HTMLInputElement).value;
    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeServerBaseUrl(rawUrl);
    } catch (err: unknown) {
      setStatus(doc, err instanceof Error ? err.message : "Invalid localhost URL", "err");
      return;
    }

    const model_id = (doc.getElementById("cfg-model-id") as HTMLInputElement).value.trim();
    const idle_unload_minutes = Number.parseInt(
      (doc.getElementById("cfg-idle-min") as HTMLInputElement).value,
      10,
    );
    const cache_max_mb = Number.parseInt(
      (doc.getElementById("cfg-cache-mb") as HTMLInputElement).value,
      10,
    );
    const cache_ttl_days = Number.parseInt(
      (doc.getElementById("cfg-cache-ttl") as HTMLInputElement).value,
      10,
    );

    void savePreferences({ serverBaseUrl: normalizedUrl })
      .then(() =>
        apiClient.patchSettings({
          model_id,
          idle_unload_minutes,
          cache_max_mb,
          cache_ttl_days,
        }),
      )
      .then(() => {
        setStatus(doc, "Model & cache settings saved", "ok");
        return refreshServerAndCache(doc);
      })
      .catch((err: unknown) => {
        setStatus(
          doc,
          err instanceof Error ? err.message : "Failed to save server settings.",
          "err",
        );
      });
  });

  doc.getElementById("refresh-cache-btn")?.addEventListener("click", () => {
    void refreshServerAndCache(doc);
  });

  doc.getElementById("clear-cache-btn")?.addEventListener("click", () => {
    void apiClient
      .clearCache()
      .then((res) => {
        setStatus(
          doc,
          `Cleared ${res.cleared_entries} cached translations (glossaries preserved)`,
          "ok",
        );
        return refreshServerAndCache(doc);
      })
      .catch((err: unknown) => {
        setStatus(
          doc,
          err instanceof Error ? err.message : "Failed to clear cache.",
          "err",
        );
      });
  });

  await Promise.all([
    renderWhitelist(doc),
    refreshGlossaries(doc),
    refreshServerAndCache(doc),
  ]);
}

if (typeof chrome !== "undefined" && chrome.storage && document.getElementById("glossary-list")) {
  void initOptions(document);
}
