/**
 * Web Novel DOM paragraph extractor.
 * Scores candidate reading containers by English text density and skips
 * navigation, sidebars, comments, forms, ads, and injected `.rt-*` elements.
 */

export interface ExtractedParagraph {
  id: string;
  order: number;
  text: string;
  element: HTMLElement;
}

const EXCLUDED_ANCESTOR_SELECTOR = [
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "button",
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  ".rt-thai-block",
  ".rt-toast",
].join(",");

const NOISE_CLASS_OR_ID_RE =
  /\b(comment|comments|disqus|reply|sidebar|widget|menu|navbar|nav|footer|header|breadcrumb|pagination|pager|social|share|related|recommend|advert|banner|popup|modal|cookie|login|signup)\b/i;

const PREFERRED_CONTAINER_SELECTORS = [
  "article",
  "main",
  "[class*='chapter-content']",
  "[class*='chapter_content']",
  "[id*='chapter-content']",
  "[class*='reading-content']",
  "[class*='entry-content']",
  "[class*='novel-content']",
  "[class*='post-content']",
];

const HAS_LATIN_LETTER_RE = /[A-Za-z]/;

function hasNoiseAncestor(el: Element, stopAt: Element | null): boolean {
  if (el.closest(EXCLUDED_ANCESTOR_SELECTOR)) {
    return true;
  }
  let current: Element | null = el;
  while (current && current !== stopAt && current.tagName !== "BODY") {
    const tokens = `${current.id} ${typeof current.className === "string" ? current.className : ""}`;
    if (tokens.trim() && NOISE_CLASS_OR_ID_RE.test(tokens)) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function normalizeParagraphText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function isTranslatableParagraph(el: HTMLElement, container: Element | null): boolean {
  if (el.classList.contains("rt-thai-block")) {
    return false;
  }
  if (hasNoiseAncestor(el, container)) {
    return false;
  }
  const text = normalizeParagraphText(el.textContent ?? "");
  if (text.length < 4) {
    return false;
  }
  if (!HAS_LATIN_LETTER_RE.test(text)) {
    return false;
  }
  // Skip paragraphs that are solely links/buttons (e.g. "Previous Chapter | Next Chapter").
  const linkChars = Array.from(el.querySelectorAll("a, button")).reduce(
    (sum, node) => sum + normalizeParagraphText(node.textContent ?? "").length,
    0,
  );
  if (linkChars > 0 && linkChars >= text.length * 0.8) {
    return false;
  }
  return true;
}

function scoreContainer(container: Element): number {
  if (hasNoiseAncestor(container, null)) {
    return 0;
  }
  const paragraphs = Array.from(container.querySelectorAll("p"));
  let charScore = 0;
  let validCount = 0;
  for (const p of paragraphs) {
    if (!(p instanceof HTMLElement)) {
      continue;
    }
    if (!isTranslatableParagraph(p, container)) {
      continue;
    }
    const len = normalizeParagraphText(p.textContent ?? "").length;
    charScore += len;
    validCount += 1;
  }
  if (validCount === 0) {
    return 0;
  }
  return charScore + validCount * 25;
}

export function findPrimaryReadingContainer(doc: Document = document): Element | null {
  const candidates = new Set<Element>();

  for (const selector of PREFERRED_CONTAINER_SELECTORS) {
    for (const el of Array.from(doc.querySelectorAll(selector))) {
      candidates.add(el);
    }
  }

  // Also inspect parent containers of long paragraphs for custom novel sites.
  for (const p of Array.from(doc.querySelectorAll("p"))) {
    const parent = p.parentElement;
    if (parent && parent.tagName !== "BODY" && parent.tagName !== "HTML") {
      candidates.add(parent);
    }
  }

  let bestEl: Element | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const score = scoreContainer(candidate);
    if (score > bestScore) {
      bestScore = score;
      bestEl = candidate;
    }
  }

  if (bestEl && bestScore >= 40) {
    return bestEl;
  }
  return doc.body;
}

export function extractNovelParagraphs(
  doc: Document = document,
): ExtractedParagraph[] {
  const container = findPrimaryReadingContainer(doc);
  if (!container) {
    return [];
  }

  const rawParagraphs = Array.from(container.querySelectorAll("p"));
  const results: ExtractedParagraph[] = [];
  let nextIndex = 1;

  for (const node of rawParagraphs) {
    if (!(node instanceof HTMLElement)) {
      continue;
    }
    if (!isTranslatableParagraph(node, container)) {
      continue;
    }
    const text = normalizeParagraphText(node.textContent ?? "");
    const existingId = node.getAttribute("data-rt-id");
    const id = existingId && existingId.trim() ? existingId : `p-${nextIndex}`;
    node.setAttribute("data-rt-id", id);

    results.push({
      id,
      order: nextIndex - 1,
      text,
      element: node,
    });
    nextIndex += 1;
  }

  return results;
}
