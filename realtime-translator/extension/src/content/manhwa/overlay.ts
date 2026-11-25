/**
 * Manhwa bubble overlay renderer:
 * - Normalized [0..1] coordinates synced to each strip <img> via ResizeObserver
 * - Auto-colored solid masks (.rt-bubble-mask) and translucent pills (.rt-bubble-pill)
 * - Thai word-boundary wrapping (Intl.Segmenter("th")) + binary-search font auto-fit (10px..22px)
 * - Instant hover peek and Alt+O peek-all toggle
 */

import type { BubbleOverlay } from "../../shared/types";

export const RT_PEEK_ALL_CLASS = "rt-peek-all";
export const RT_OVERLAY_CLASS = "rt-manhwa-overlay";

interface SegmenterLike {
  segment(input: string): Iterable<{ segment: string }>;
}

interface IntlWithSegmenter {
  Segmenter?: new (
    locale: string,
    options: { granularity: "word" | "grapheme" | "sentence" },
  ) => SegmenterLike;
}

/**
 * Inserts zero-width break opportunities between Thai words using Intl.Segmenter("th")
 * so narrow speech bubbles wrap cleanly at word boundaries.
 */
export function segmentThaiText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  const intlObj = Intl as unknown as IntlWithSegmenter;
  if (typeof intlObj.Segmenter !== "function") {
    return trimmed;
  }
  try {
    const segmenter = new intlObj.Segmenter("th", { granularity: "word" });
    const parts: string[] = [];
    for (const seg of segmenter.segment(trimmed)) {
      parts.push(seg.segment);
    }
    return parts.join("\u200B");
  } catch {
    return trimmed;
  }
}

function estimateWrappedLines(text: string, charsPerLine: number): number {
  const safeCap = Math.max(1, charsPerLine);
  let totalLines = 0;
  for (const rawLine of text.split("\n")) {
    const len = rawLine.replace(/\u200B/g, "").length;
    totalLines += Math.max(1, Math.ceil(len / safeCap));
  }
  return totalLines;
}

/**
 * Binary-searches the largest readable font size in [minPx, maxPx] that fits
 * cleanly inside a padded speech bubble box without overflowing height.
 */
export function computeFittedFontSize(
  text: string,
  boxWidthPx: number,
  boxHeightPx: number,
  minPx = 10,
  maxPx = 22,
): number {
  const usableW = Math.max(16, boxWidthPx - 10);
  const usableH = Math.max(16, boxHeightPx - 8);
  const cleanLen = text.replace(/\u200B/g, "").trim().length;
  if (cleanLen === 0) {
    return minPx;
  }

  let lo = minPx;
  let hi = maxPx;
  let best = minPx;

  for (let iter = 0; iter < 12; iter++) {
    const mid = (lo + hi) / 2;
    // Average Thai glyph advance ~0.58em; line-height ~1.30em.
    const charsPerLine = Math.max(1, Math.floor(usableW / (mid * 0.58)));
    const lines = estimateWrappedLines(text, charsPerLine);
    const requiredH = lines * mid * 1.3;

    if (requiredH <= usableH) {
      best = mid;
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return Math.round(best * 2) / 2;
}

interface OverlayRecord {
  img: HTMLImageElement;
  container: HTMLDivElement;
  bubbles: BubbleOverlay[];
}

export class ManhwaOverlayManager {
  private readonly doc: Document;
  private readonly win: Window;
  private readonly records = new Map<HTMLImageElement, OverlayRecord>();
  private resizeObserver: ResizeObserver | null = null;
  private readonly onWindowResize: () => void;
  private fontScale = 1.0;

  constructor(doc: Document = document, win: Window = window) {
    this.doc = doc;
    this.win = win;
    this.onWindowResize = () => this.repositionAll();

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const img = entry.target as HTMLImageElement;
          this.syncContainerGeometry(img);
        }
      });
    }
    this.win.addEventListener("resize", this.onWindowResize, { passive: true });
  }

  private ensureOverlayRoot(): HTMLElement {
    let root = this.doc.getElementById("rt-manhwa-overlay-root");
    if (!root) {
      root = this.doc.createElement("div");
      root.id = "rt-manhwa-overlay-root";
      root.className = "rt-manhwa-overlay-root";
      this.doc.body.appendChild(root);
    }
    return root;
  }

  renderLoadingBadge(img: HTMLImageElement, imageId: string): HTMLDivElement {
    const container = this.ensureContainer(img, imageId);
    container.setAttribute("data-rt-state", "loading");
    container.textContent = "";

    const badge = this.doc.createElement("div");
    badge.className = "rt-strip-status rt-loading";
    badge.textContent = "กำลังแปลภาพ...";
    container.appendChild(badge);
    this.syncContainerGeometry(img);
    return container;
  }

  renderErrorBadge(
    img: HTMLImageElement,
    imageId: string,
    message: string,
    onRetry: () => void,
  ): HTMLDivElement {
    const container = this.ensureContainer(img, imageId);
    container.setAttribute("data-rt-state", "error");
    container.textContent = "";

    const badge = this.doc.createElement("div");
    badge.className = "rt-strip-status rt-error";

    const textSpan = this.doc.createElement("span");
    textSpan.textContent = message;

    const retryBtn = this.doc.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "rt-retry-btn";
    retryBtn.textContent = "Retry";
    retryBtn.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      onRetry();
    });

    badge.append(textSpan, retryBtn);
    container.appendChild(badge);
    this.syncContainerGeometry(img);
    return container;
  }

  renderBubbles(
    img: HTMLImageElement,
    imageId: string,
    bubbles: BubbleOverlay[],
  ): HTMLDivElement {
    const container = this.ensureContainer(img, imageId);
    const record = this.records.get(img);
    if (record) {
      record.bubbles = bubbles;
    }

    container.setAttribute("data-rt-state", "done");
    container.textContent = "";
    this.syncContainerGeometry(img);

    const rect = img.getBoundingClientRect();
    const imgW = rect.width || img.clientWidth || img.naturalWidth || 800;
    const imgH = rect.height || img.clientHeight || img.naturalHeight || 1200;

    for (const bubble of bubbles) {
      const [x1, y1, x2, y2] = bubble.bbox;
      const boxWFrac = Math.max(0.01, x2 - x1);
      const boxHFrac = Math.max(0.005, y2 - y1);

      const el = this.doc.createElement("div");
      el.className =
        bubble.render_mode === "pill"
          ? "rt-bubble-box rt-bubble-pill"
          : "rt-bubble-box rt-bubble-mask";
      el.setAttribute("data-rt-bubble-id", bubble.id);
      el.setAttribute("data-rt-order", String(bubble.reading_order));
      el.setAttribute("data-rt-mode", bubble.render_mode);
      el.setAttribute("lang", "th");
      el.title = bubble.source_text;

      el.style.left = `${(x1 * 100).toFixed(3)}%`;
      el.style.top = `${(y1 * 100).toFixed(3)}%`;
      el.style.width = `${(boxWFrac * 100).toFixed(3)}%`;
      el.style.height = `${(boxHFrac * 100).toFixed(3)}%`;
      el.style.backgroundColor = bubble.bg_color;
      el.style.color = bubble.text_color;

      const segmented = segmentThaiText(bubble.translated_text);
      const baseFontSize = computeFittedFontSize(
        segmented,
        boxWFrac * imgW,
        boxHFrac * imgH,
      );
      const fontSize = Math.max(9, Math.min(28, Math.round(baseFontSize * this.fontScale * 2) / 2));
      el.style.fontSize = `${fontSize}px`;

      const textNode = this.doc.createElement("span");
      textNode.className = "rt-bubble-text";
      textNode.textContent = segmented;
      el.appendChild(textNode);

      container.appendChild(el);
    }

    return container;
  }

  private ensureContainer(img: HTMLImageElement, imageId: string): HTMLDivElement {
    const existing = this.records.get(img);
    if (existing) {
      existing.container.setAttribute("data-rt-img-for", imageId);
      return existing.container;
    }

    const container = this.doc.createElement("div");
    container.className = RT_OVERLAY_CLASS;
    container.setAttribute("data-rt-img-for", imageId);
    this.ensureOverlayRoot().appendChild(container);

    this.records.set(img, { img, container, bubbles: [] });
    this.resizeObserver?.observe(img);
    return container;
  }

  syncContainerGeometry(img: HTMLImageElement): void {
    const record = this.records.get(img);
    if (!record) {
      return;
    }
    const rect = img.getBoundingClientRect();
    const width = rect.width || img.clientWidth;
    const height = rect.height || img.clientHeight;
    const left = rect.left + this.win.scrollX;
    const top = rect.top + this.win.scrollY;

    const { style } = record.container;
    style.left = `${left}px`;
    style.top = `${top}px`;
    style.width = `${width}px`;
    style.height = `${height}px`;

    // Re-fit bubble font sizes if rendered image width/height changed on zoom/resize.
    if (record.bubbles.length > 0 && width > 0 && height > 0) {
      const boxEls = record.container.querySelectorAll<HTMLElement>(".rt-bubble-box");
      for (const boxEl of Array.from(boxEls)) {
        const bubbleId = boxEl.getAttribute("data-rt-bubble-id");
        const bubble = record.bubbles.find((b) => b.id === bubbleId);
        if (!bubble) {
          continue;
        }
        const [x1, y1, x2, y2] = bubble.bbox;
        const baseFitted = computeFittedFontSize(
          bubble.translated_text,
          Math.max(0.01, x2 - x1) * width,
          Math.max(0.005, y2 - y1) * height,
        );
        const fitted = Math.max(9, Math.min(28, Math.round(baseFitted * this.fontScale * 2) / 2));
        boxEl.style.fontSize = `${fitted}px`;
      }
    }
  }

  setFontScale(scale: number): void {
    const clamped = Math.max(0.7, Math.min(1.4, scale));
    if (clamped === this.fontScale) {
      return;
    }
    this.fontScale = clamped;
    this.repositionAll();
  }

  repositionAll(): void {
    for (const img of this.records.keys()) {
      this.syncContainerGeometry(img);
    }
  }

  setPeekAll(active: boolean): void {
    this.doc.documentElement.classList.toggle(RT_PEEK_ALL_CLASS, active);
  }

  isPeekAll(): boolean {
    return this.doc.documentElement.classList.contains(RT_PEEK_ALL_CLASS);
  }

  clearAll(): void {
    for (const [img, record] of this.records.entries()) {
      this.resizeObserver?.unobserve(img);
      record.container.remove();
      img.removeAttribute("data-rt-img-id");
    }
    this.records.clear();
    this.doc.getElementById("rt-manhwa-overlay-root")?.remove();
    this.setPeekAll(false);
  }

  destroy(): void {
    this.clearAll();
    this.resizeObserver?.disconnect();
    this.win.removeEventListener("resize", this.onWindowResize);
  }
}
