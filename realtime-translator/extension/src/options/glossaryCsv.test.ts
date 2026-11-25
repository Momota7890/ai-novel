import { describe, expect, it } from "vitest";
import type { GlossaryEntryInput, GlossaryUpsertRequest } from "../shared/types";
import {
  exportGlossaryCsv,
  exportGlossaryJson,
  parseGlossaryCsv,
  parseGlossaryJson,
} from "./glossaryCsv";

describe("options/glossaryCsv", () => {
  it("round-trips CSV entries with commas, quotes, and Thai text intact", () => {
    const entries: GlossaryEntryInput[] = [
      {
        source_term: "Sung Jin-Woo",
        target_term: "ซองจินอู",
        category: "name",
        note: 'Protagonist, uses "ฉัน/ผม"',
      },
      {
        source_term: "Shadow Extraction",
        target_term: "สกัดเงา",
        category: "skill",
        note: "",
      },
    ];

    const csv = exportGlossaryCsv(entries);
    expect(csv.startsWith("source_term,target_term,category,note\n")).toBe(true);

    const parsed = parseGlossaryCsv(csv);
    expect(parsed).toEqual(entries);
  });

  it("round-trips glossary JSON and rejects malformed payloads", () => {
    const glossary: GlossaryUpsertRequest = {
      name: "Solo Leveling",
      url_pattern: "*solo-leveling*",
      default_preset: "modern_manhwa",
      entries: [
        {
          source_term: "Arise",
          target_term: "จงตื่น",
          category: "skill",
          note: "Command keyword",
        },
      ],
    };

    const json = exportGlossaryJson(glossary);
    expect(parseGlossaryJson(json)).toEqual(glossary);

    expect(() => parseGlossaryJson("{}")).toThrow(/name/i);
  });
});
