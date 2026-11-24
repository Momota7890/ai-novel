/**
 * Non-destructive bilingual inline renderer for Web Novels.
 * Injects `<div class="rt-thai-block" data-rt-for="p-N">` immediately after each `<p>`
 * and toggles visibility via `.rt-hidden` on `documentElement` without re-translating.
 */

import type { TypographyPrefs } from "../../shared/storage";

export const RT_HIDDEN_CLASS = "rt-hidden";
export const RT_THAI_BLOCK_CLASS = "rt-thai-block";

function escapeAttrSelector(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

export class NovelRenderer {
  private readonly doc: Document;

  constructor(doc: Document = document) {
    this.doc = doc;
  }

  ensureThaiBlock(paragraph: HTMLElement, id: string): HTMLElement {
    const existingSibling = paragraph.nextElementSibling;
    if (
      existingSibling instanceof HTMLElement &&
      existingSibling.classList.contains(RT_THAI_BLOCK_CLASS) &&
      existingSibling.getAttribute("data-rt-for") === id
    ) {
      return existingSibling;
    }

    const existingAnywhere = this.doc.querySelector(
      `.${RT_THAI_BLOCK_CLASS}[data-rt-for="${escapeAttrSelector(id)}"]`,
    );
    if (existingAnywhere instanceof HTMLElement) {
      paragraph.insertAdjacentElement("afterend", existingAnywhere);
      return existingAnywhere;
    }

    const block = this.doc.createElement("div");
    block.className = RT_THAI_BLOCK_CLASS;
    block.setAttribute("data-rt-for", id);
    block.setAttribute("lang", "th");
    paragraph.insertAdjacentElement("afterend", block);
    return block;
  }

  renderLoading(paragraph: HTMLElement, id: string): HTMLElement {
    const block = this.ensureThaiBlock(paragraph, id);
    block.classList.remove("rt-error");
    block.classList.add("rt-loading");
    block.setAttribute("data-rt-state", "loading");
    block.textContent = "กำลังแปล...";
    return block;
  }

  renderTranslation(
    paragraph: HTMLElement,
    id: string,
    thaiText: string,
    cached: boolean,
  ): HTMLElement {
    const block = this.ensureThaiBlock(paragraph, id);
    block.classList.remove("rt-loading", "rt-error");
    block.setAttribute("data-rt-state", "done");
    block.setAttribute("data-rt-cached", cached ? "1" : "0");
    block.textContent = thaiText;
    return block;
  }

  renderError(
    paragraph: HTMLElement,
    id: string,
    message: string,
    onRetry: (paragraphId: string) => void,
  ): HTMLElement {
    const block = this.ensureThaiBlock(paragraph, id);
    block.classList.remove("rt-loading");
    block.classList.add("rt-error");
    block.setAttribute("data-rt-state", "error");
    block.textContent = "";

    const msgSpan = this.doc.createElement("span");
    msgSpan.className = "rt-error-text";
    msgSpan.textContent = message;

    const retryBtn = this.doc.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "rt-retry-btn";
    retryBtn.textContent = "Retry";
    retryBtn.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      onRetry(id);
    });

    block.append(msgSpan, retryBtn);
    return block;
  }

  setHidden(hidden: boolean): void {
    this.doc.documentElement.classList.toggle(RT_HIDDEN_CLASS, hidden);
  }

  isHidden(): boolean {
    return this.doc.documentElement.classList.contains(RT_HIDDEN_CLASS);
  }

  applyTypography(prefs: TypographyPrefs): void {
    const style = this.doc.documentElement.style;
    style.setProperty("--rt-font-family", prefs.fontFamily);
    style.setProperty("--rt-font-size", prefs.fontSize);
    style.setProperty("--rt-line-height", String(prefs.lineHeight));
    style.setProperty("--rt-text-color", prefs.textColor);
  }

  clearAll(): void {
    for (const block of Array.from(
      this.doc.querySelectorAll(`.${RT_THAI_BLOCK_CLASS}`),
    )) {
      block.remove();
    }
    for (const tagged of Array.from(this.doc.querySelectorAll("[data-rt-id]"))) {
      tagged.removeAttribute("data-rt-id");
    }
    this.setHidden(false);
  }
}
