/**
 * Page mode detector (Novel vs. Vertical Manhwa) and wildcard URL glossary matcher.
 */

import { scanManhwaStrips } from "../content/manhwa/imageScanner";
import { extractNovelParagraphs } from "../content/novel/extractor";
import type { GlossaryResponse, ResolvedPageMode } from "./types";

/**
 * Classifies a DOM page into "manhwa" or "novel" by comparing vertical strip
 * image density against main-article paragraph word density.
 */
export function detectPageMode(doc: Document = document): ResolvedPageMode {
  const strips = scanManhwaStrips(doc);
  const paragraphs = extractNovelParagraphs(doc);
  const totalWords = paragraphs.reduce(
    (sum, p) => sum + p.text.split(/\s+/).filter(Boolean).length,
    0,
  );

  // Tall vertical comic strips dominate when >= 2 strips and sparse prose.
  if (strips.length >= 2 && totalWords < 250) {
    return "manhwa";
  }
  if (strips.length >= 1 && paragraphs.length < 3) {
    return "manhwa";
  }
  return "novel";
}

function escapeRegexChars(raw: string): string {
  return raw.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches a page URL against a user-friendly wildcard pattern such as:
 *   "*asuracomic.net/*solo-leveling*"
 *   "asuracomic.net/series/solo-leveling/*"
 *   "solo-leveling" (plain substring match if no '*' wildcard)
 */
export function matchUrlPattern(url: string, pattern: string): boolean {
  const trimmedUrl = url.trim().toLowerCase();
  const trimmedPattern = pattern.trim().toLowerCase();
  if (!trimmedUrl || !trimmedPattern) {
    return false;
  }

  if (!trimmedPattern.includes("*")) {
    return trimmedUrl.includes(trimmedPattern);
  }

  // Allow patterns without scheme (e.g. "asuracomic.net/*") to match full URLs.
  const normalizedPattern =
    trimmedPattern.startsWith("*") || trimmedPattern.includes("://")
      ? trimmedPattern
      : `*${trimmedPattern}`;

  const regexBody = normalizedPattern
    .split("*")
    .map((part) => escapeRegexChars(part))
    .join(".*");

  return new RegExp(`^${regexBody}$`, "i").test(trimmedUrl);
}

/**
 * Returns the most specific matching series glossary for a page URL.
 */
export function findMatchingGlossary(
  url: string,
  glossaries: GlossaryResponse[],
): GlossaryResponse | null {
  let best: GlossaryResponse | null = null;
  let bestScore = -1;

  for (const glossary of glossaries) {
    const pattern = glossary.url_pattern.trim();
    if (!pattern || !matchUrlPattern(url, pattern)) {
      continue;
    }
    const specificity = pattern.replace(/\*/g, "").length;
    if (specificity > bestScore) {
      bestScore = specificity;
      best = glossary;
    }
  }

  return best;
}
