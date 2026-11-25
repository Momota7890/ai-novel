/**
 * Pure RFC-4180 CSV and JSON import/export helpers for per-series glossaries.
 */

import type {
  GlossaryCategory,
  GlossaryEntryInput,
  GlossaryUpsertRequest,
  PresetId,
} from "../shared/types";

const VALID_CATEGORIES = new Set<GlossaryCategory>([
  "name",
  "skill",
  "place",
  "pronoun",
  "term",
]);

const VALID_PRESETS = new Set<PresetId>([
  "modern_manhwa",
  "fantasy_murim",
  "light_novel",
  "literal",
]);

function normalizeCategory(raw: string | undefined): GlossaryCategory {
  const cleaned = (raw ?? "").trim().toLowerCase() as GlossaryCategory;
  return VALID_CATEGORIES.has(cleaned) ? cleaned : "term";
}

function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function exportGlossaryCsv(entries: GlossaryEntryInput[]): string {
  const lines = ["source_term,target_term,category,note"];
  for (const entry of entries) {
    lines.push(
      [
        escapeCsvCell(entry.source_term),
        escapeCsvCell(entry.target_term),
        escapeCsvCell(entry.category),
        escapeCsvCell(entry.note),
      ].join(","),
    );
  }
  return lines.join("\n");
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") {
        i += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function parseGlossaryCsv(csvText: string): GlossaryEntryInput[] {
  const rows = parseCsvRows(csvText.replace(/^\uFEFF/, ""));
  const entries: GlossaryEntryInput[] = [];

  for (let i = 0; i < rows.length; i++) {
    const cols = rows[i];
    if (!cols || cols.every((c) => c.trim() === "")) {
      continue;
    }
    const source = (cols[0] ?? "").trim();
    const target = (cols[1] ?? "").trim();
    // Skip standard header row if present.
    if (
      i === 0 &&
      source.toLowerCase().includes("source") &&
      target.toLowerCase().includes("target")
    ) {
      continue;
    }
    if (!source || !target) {
      continue;
    }
    entries.push({
      source_term: source,
      target_term: target,
      category: normalizeCategory(cols[2]),
      note: (cols[3] ?? "").trim(),
    });
  }

  return entries;
}

export function exportGlossaryJson(glossary: GlossaryUpsertRequest): string {
  return JSON.stringify(glossary, null, 2);
}

export function parseGlossaryJson(jsonText: string): GlossaryUpsertRequest {
  const parsed: unknown = JSON.parse(jsonText);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Glossary JSON must be an object.");
  }
  const obj = parsed as Partial<GlossaryUpsertRequest>;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!name) {
    throw new Error("Glossary JSON requires a non-empty 'name' field.");
  }
  const preset =
    typeof obj.default_preset === "string" &&
    VALID_PRESETS.has(obj.default_preset as PresetId)
      ? (obj.default_preset as PresetId)
      : "modern_manhwa";

  const rawEntries = Array.isArray(obj.entries) ? obj.entries : [];
  const entries: GlossaryEntryInput[] = [];
  for (const item of rawEntries) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const rec = item as Partial<GlossaryEntryInput>;
    const source = typeof rec.source_term === "string" ? rec.source_term.trim() : "";
    const target = typeof rec.target_term === "string" ? rec.target_term.trim() : "";
    if (!source || !target) {
      continue;
    }
    entries.push({
      source_term: source,
      target_term: target,
      category: normalizeCategory(rec.category),
      note: typeof rec.note === "string" ? rec.note.trim() : "",
    });
  }

  return {
    name,
    url_pattern: typeof obj.url_pattern === "string" ? obj.url_pattern.trim() : "",
    default_preset: preset,
    entries,
  };
}
