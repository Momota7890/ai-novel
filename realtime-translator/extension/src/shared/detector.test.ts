import { beforeEach, describe, expect, it } from "vitest";
import { detectPageMode, findMatchingGlossary, matchUrlPattern } from "./detector";
import type { GlossaryResponse } from "./types";

function makeStripImg(src: string, width: number, height: number): HTMLImageElement {
  const img = document.createElement("img");
  img.src = src;
  Object.defineProperty(img, "naturalWidth", { value: width, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: height, configurable: true });
  Object.defineProperty(img, "complete", { value: true, configurable: true });
  return img;
}

describe("shared/detector", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("detects web novel pages with dense chapter paragraphs", () => {
    document.body.innerHTML = `
      <article class="chapter-content">
        <p>The crimson moonlight spilled across the cracked stone floor of the ancient dungeon.</p>
        <p>Jin-Woo paused at the threshold, his hand resting lightly on the hilt of his dagger.</p>
        <p>"Something is wrong," he muttered under his breath, watching the shadows shift.</p>
        <p>Normally, an E-rank gate never felt this heavy against his lungs.</p>
      </article>
    `;
    expect(detectPageMode(document)).toBe("novel");
  });

  it("detects vertical long-strip manhwa pages with stacked tall images", () => {
    const reader = document.createElement("div");
    reader.append(
      makeStripImg("https://cdn.test/ch10-01.webp", 800, 4200),
      makeStripImg("https://cdn.test/ch10-02.webp", 800, 4500),
    );
    document.body.appendChild(reader);
    expect(detectPageMode(document)).toBe("manhwa");
  });

  it("matches wildcard URL patterns and selects the most specific glossary", () => {
    expect(
      matchUrlPattern(
        "https://asuracomic.net/series/solo-leveling/chapter-105",
        "*asuracomic.net/*solo-leveling*",
      ),
    ).toBe(true);
    expect(
      matchUrlPattern(
        "https://asuracomic.net/series/solo-leveling/chapter-105",
        "asuracomic.net/series/solo-leveling/*",
      ),
    ).toBe(true);
    expect(
      matchUrlPattern("https://other.site/chapter-1", "*asuracomic.net/*"),
    ).toBe(false);

    const glossaries: GlossaryResponse[] = [
      {
        id: "generic-asura",
        name: "Asura Generic",
        url_pattern: "*asuracomic.net/*",
        default_preset: "modern_manhwa",
        updated_at: 1,
        entries: [],
      },
      {
        id: "solo-leveling",
        name: "Solo Leveling",
        url_pattern: "*asuracomic.net/*solo-leveling*",
        default_preset: "fantasy_murim",
        updated_at: 2,
        entries: [],
      },
    ];

    const matched = findMatchingGlossary(
      "https://asuracomic.net/series/solo-leveling/chapter-105",
      glossaries,
    );
    expect(matched?.id).toBe("solo-leveling");
  });
});
