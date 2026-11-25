/**
 * Manual region-snip fallback (Alt+S).
 * Draws a translucent crosshair drag overlay, captures the exact viewport rectangle
 * via `captureVisibleTab` scaled by `devicePixelRatio`, posts to `/translate/snip`,
 * and renders a draggable, dismissible Thai result card clamped inside the viewport.
 */

import { apiClient } from "../../shared/apiClient";
import type { PresetId, SnipTranslateResponse } from "../../shared/types";

export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function normalizeDragRect(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): ScreenRect {
  const left = Math.min(startX, endX);
  const top = Math.min(startY, endY);
  return {
    left,
    top,
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  };
}

export function computeDprCropRect(
  rect: ScreenRect,
  dpr: number,
  imageWidth: number,
  imageHeight: number,
): ScreenRect {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const left = Math.max(0, Math.min(imageWidth - 1, Math.round(rect.left * scale)));
  const top = Math.max(0, Math.min(imageHeight - 1, Math.round(rect.top * scale)));
  const right = Math.max(
    left + 1,
    Math.min(imageWidth, Math.round((rect.left + rect.width) * scale)),
  );
  const bottom = Math.max(
    top + 1,
    Math.min(imageHeight, Math.round((rect.top + rect.height) * scale)),
  );
  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

export function clampCardPosition(
  anchor: ScreenRect,
  cardWidth: number,
  cardHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 12,
): { left: number; top: number } {
  const preferredLeft = anchor.left + anchor.width + margin;
  const fallbackLeft = anchor.left - cardWidth - margin;
  let left =
    preferredLeft + cardWidth <= viewportWidth - margin
      ? preferredLeft
      : fallbackLeft >= margin
        ? fallbackLeft
        : anchor.left;

  left = Math.max(margin, Math.min(viewportWidth - cardWidth - margin, left));
  const top = Math.max(
    margin,
    Math.min(viewportHeight - cardHeight - margin, anchor.top),
  );
  return { left, top };
}

export async function cropDataUrlToBase64(
  dataUrl: string,
  rect: ScreenRect,
  dpr: number,
  doc: Document = document,
): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = doc.createElement("img");
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Failed to decode captured tab screenshot."));
    el.src = dataUrl;
  });

  const crop = computeDprCropRect(
    rect,
    dpr,
    img.naturalWidth || img.width,
    img.naturalHeight || img.height,
  );
  const canvas = doc.createElement("canvas");
  canvas.width = crop.width;
  canvas.height = crop.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D canvas context unavailable for snip crop.");
  }
  ctx.drawImage(
    img,
    crop.left,
    crop.top,
    crop.width,
    crop.height,
    0,
    0,
    crop.width,
    crop.height,
  );
  const pngUrl = canvas.toDataURL("image/png");
  const commaIdx = pngUrl.indexOf(",");
  return commaIdx >= 0 ? pngUrl.slice(commaIdx + 1) : pngUrl;
}

export interface SnipToolDeps {
  getSessionId: () => string;
  getPreset: () => PresetId;
  getGlossaryId?: () => string | null;
  captureTab?: () => Promise<{ dataUrl: string }>;
  cropImage?: (dataUrl: string, rect: ScreenRect, dpr: number) => Promise<string>;
  translateSnip?: (
    req: {
      session_id: string;
      preset: PresetId;
      glossary_id: string | null;
      image_base64: string;
      image_mime: string;
    },
    signal?: AbortSignal,
  ) => Promise<SnipTranslateResponse>;
}

export class ManhwaSnipTool {
  private readonly doc: Document;
  private readonly win: Window;
  private readonly deps: SnipToolDeps;

  private backdrop: HTMLDivElement | null = null;
  private selectionBox: HTMLDivElement | null = null;
  private resultCard: HTMLDivElement | null = null;
  private abortController: AbortController | null = null;
  private dragging = false;
  private startX = 0;
  private startY = 0;

  constructor(deps: SnipToolDeps, doc: Document = document, win: Window = window) {
    this.deps = deps;
    this.doc = doc;
    this.win = win;
  }

  isOpen(): boolean {
    return this.backdrop !== null;
  }

  activate(): void {
    this.cancelSelection();
    this.dismissCard();

    const backdrop = this.doc.createElement("div");
    backdrop.className = "rt-snip-backdrop";

    const hint = this.doc.createElement("div");
    hint.className = "rt-snip-hint";
    hint.textContent = "Drag a box over text to translate (Esc to cancel)";
    backdrop.appendChild(hint);

    const box = this.doc.createElement("div");
    box.className = "rt-snip-box";
    box.style.display = "none";
    backdrop.appendChild(box);

    backdrop.addEventListener("mousedown", this.onMouseDown);
    this.win.addEventListener("mousemove", this.onMouseMove);
    this.win.addEventListener("mouseup", this.onMouseUp);
    this.win.addEventListener("keydown", this.onKeyDown);

    this.doc.body.appendChild(backdrop);
    this.backdrop = backdrop;
    this.selectionBox = box;
  }

  cancelSelection(): void {
    this.dragging = false;
    this.backdrop?.removeEventListener("mousedown", this.onMouseDown);
    this.win.removeEventListener("mousemove", this.onMouseMove);
    this.win.removeEventListener("mouseup", this.onMouseUp);
    this.win.removeEventListener("keydown", this.onKeyDown);
    this.backdrop?.remove();
    this.backdrop = null;
    this.selectionBox = null;
  }

  dismissCard(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.resultCard?.remove();
    this.resultCard = null;
  }

  destroy(): void {
    this.cancelSelection();
    this.dismissCard();
  }

  private readonly onKeyDown = (evt: KeyboardEvent): void => {
    if (evt.key === "Escape") {
      evt.preventDefault();
      this.cancelSelection();
    }
  };

  private readonly onMouseDown = (evt: MouseEvent): void => {
    if (evt.button !== 0 || !this.selectionBox) {
      return;
    }
    evt.preventDefault();
    this.dragging = true;
    this.startX = evt.clientX;
    this.startY = evt.clientY;
    this.selectionBox.style.display = "block";
    this.updateSelectionVisual(this.startX, this.startY, this.startX, this.startY);
  };

  private readonly onMouseMove = (evt: MouseEvent): void => {
    if (!this.dragging) {
      return;
    }
    evt.preventDefault();
    this.updateSelectionVisual(this.startX, this.startY, evt.clientX, evt.clientY);
  };

  private readonly onMouseUp = (evt: MouseEvent): void => {
    if (!this.dragging) {
      return;
    }
    evt.preventDefault();
    const rect = normalizeDragRect(this.startX, this.startY, evt.clientX, evt.clientY);
    this.cancelSelection();
    if (rect.width < 12 || rect.height < 12) {
      return;
    }
    void this.processSelection(rect);
  };

  private updateSelectionVisual(x1: number, y1: number, x2: number, y2: number): void {
    if (!this.selectionBox) {
      return;
    }
    const rect = normalizeDragRect(x1, y1, x2, y2);
    this.selectionBox.style.left = `${rect.left}px`;
    this.selectionBox.style.top = `${rect.top}px`;
    this.selectionBox.style.width = `${rect.width}px`;
    this.selectionBox.style.height = `${rect.height}px`;
  }

  async processSelection(rect: ScreenRect): Promise<void> {
    this.dismissCard();
    const card = this.showCard(rect, "กำลังอ่านและแปลข้อความ...", "");
    const controller = new AbortController();
    this.abortController = controller;

    try {
      // Yield 1 animation frame so the snip backdrop is fully hidden before captureVisibleTab.
      await new Promise<void>((resolve) => {
        if (typeof this.win.requestAnimationFrame === "function") {
          this.win.requestAnimationFrame(() => resolve());
        } else {
          setTimeout(resolve, 0);
        }
      });

      const captureFn = this.deps.captureTab ?? apiClient.captureVisibleTab;
      const cropFn =
        this.deps.cropImage ??
        ((url, r, dpr) => cropDataUrlToBase64(url, r, dpr, this.doc));
      const translateFn = this.deps.translateSnip ?? apiClient.translateSnip;

      const { dataUrl } = await captureFn();
      if (controller.signal.aborted) {
        return;
      }

      const imageBase64 = await cropFn(dataUrl, rect, this.win.devicePixelRatio || 1);
      if (controller.signal.aborted) {
        return;
      }

      const result = await translateFn(
        {
          session_id: this.deps.getSessionId(),
          preset: this.deps.getPreset(),
          glossary_id: this.deps.getGlossaryId?.() ?? null,
          image_base64: imageBase64,
          image_mime: "image/png",
        },
        controller.signal,
      );

      if (controller.signal.aborted) {
        return;
      }

      const thaiBody = result.translated_text.trim()
        ? result.translated_text
        : "ไม่พบข้อความภาษาอังกฤษในกรอบที่เลือก";
      this.updateCardContent(card, thaiBody, result.source_text);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      const message =
        err instanceof Error ? err.message : "Failed to translate snipped region.";
      this.updateCardContent(card, `Error: ${message}`, "");
    }
  }

  private showCard(
    anchor: ScreenRect,
    thaiText: string,
    sourceText: string,
  ): HTMLDivElement {
    const card = this.doc.createElement("div");
    card.className = "rt-snip-card";

    const header = this.doc.createElement("div");
    header.className = "rt-snip-card-header";
    const title = this.doc.createElement("span");
    title.textContent = "Snip Translation";
    const closeBtn = this.doc.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "rt-snip-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => this.dismissCard());
    header.append(title, closeBtn);

    const body = this.doc.createElement("div");
    body.className = "rt-snip-card-body";
    body.setAttribute("lang", "th");
    body.textContent = thaiText;

    const source = this.doc.createElement("div");
    source.className = "rt-snip-card-source";
    source.textContent = sourceText;
    source.style.display = sourceText ? "block" : "none";

    card.append(header, body, source);

    const cardW = 300;
    const cardH = 140;
    const pos = clampCardPosition(
      anchor,
      cardW,
      cardH,
      this.win.innerWidth || 1280,
      this.win.innerHeight || 720,
    );
    card.style.left = `${pos.left}px`;
    card.style.top = `${pos.top}px`;

    // Make card draggable via its header bar.
    header.addEventListener("mousedown", (downEvt) => {
      if ((downEvt.target as HTMLElement).closest("button")) {
        return;
      }
      downEvt.preventDefault();
      const offsetX = downEvt.clientX - card.offsetLeft;
      const offsetY = downEvt.clientY - card.offsetTop;
      const onDrag = (moveEvt: MouseEvent): void => {
        card.style.left = `${Math.max(8, moveEvt.clientX - offsetX)}px`;
        card.style.top = `${Math.max(8, moveEvt.clientY - offsetY)}px`;
      };
      const onEnd = (): void => {
        this.win.removeEventListener("mousemove", onDrag);
        this.win.removeEventListener("mouseup", onEnd);
      };
      this.win.addEventListener("mousemove", onDrag);
      this.win.addEventListener("mouseup", onEnd);
    });

    this.doc.body.appendChild(card);
    this.resultCard = card;
    return card;
  }

  private updateCardContent(
    card: HTMLDivElement,
    thaiText: string,
    sourceText: string,
  ): void {
    const body = card.querySelector(".rt-snip-card-body");
    const source = card.querySelector(".rt-snip-card-source") as HTMLElement | null;
    if (body) {
      body.textContent = thaiText;
    }
    if (source) {
      source.textContent = sourceText;
      source.style.display = sourceText ? "block" : "none";
    }
  }
}
