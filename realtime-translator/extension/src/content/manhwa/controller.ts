/**
 * Vertical long-strip Manhwa translation coordinator.
 * Connects ManhwaImageScanner -> SW image fetch (with viewport capture fallback)
 * -> POST /translate/manhwa -> ManhwaOverlayManager with AbortController cancellation.
 */

import { apiClient } from "../../shared/apiClient";
import type { PresetId } from "../../shared/types";
import { ManhwaImageScanner, type ScannedStrip } from "./imageScanner";
import { ManhwaOverlayManager } from "./overlay";
import { cropDataUrlToBase64 } from "./snipTool";

type StripStatus = "queued" | "inflight" | "done" | "error";

interface TrackedStrip {
  strip: ScannedStrip;
  status: StripStatus;
  bypassCache: boolean;
}

export class ManhwaPageController {
  private readonly overlay: ManhwaOverlayManager;
  private readonly scanner: ManhwaImageScanner;
  private readonly tracked = new Map<HTMLImageElement, TrackedStrip>();

  private active = false;
  private draining = false;
  private sessionId = "page-manhwa";
  private preset: PresetId = "modern_manhwa";
  private glossaryId: string | null = null;
  private currentAbort: AbortController | null = null;

  constructor(doc: Document = document, win: Window = window) {
    this.overlay = new ManhwaOverlayManager(doc, win);
    this.scanner = new ManhwaImageScanner(
      (strip) => this.enqueueStrip(strip, false),
      { doc, rootMargin: "0px 0px 1500px 0px" },
    );
  }

  setConfig(config: {
    sessionId?: string;
    preset?: PresetId;
    glossaryId?: string | null;
  }): void {
    if (config.sessionId !== undefined) {
      this.sessionId = config.sessionId;
    }
    if (config.preset !== undefined) {
      this.preset = config.preset;
    }
    if (config.glossaryId !== undefined) {
      this.glossaryId = config.glossaryId;
    }
  }

  start(): void {
    this.active = true;
    this.scanner.start();
    this.overlay.repositionAll();
  }

  stop(): void {
    this.active = false;
    this.currentAbort?.abort();
    this.currentAbort = null;
    this.scanner.stop();
    for (const item of this.tracked.values()) {
      if (item.status === "queued" || item.status === "inflight") {
        this.tracked.delete(item.strip.element);
      }
    }
  }

  clearAll(): void {
    this.stop();
    this.tracked.clear();
    this.overlay.clearAll();
  }

  togglePeek(forceActive?: boolean): boolean {
    const next = forceActive ?? !this.overlay.isPeekAll();
    this.overlay.setPeekAll(next);
    return next;
  }

  isPeekActive(): boolean {
    return this.overlay.isPeekAll();
  }

  retryAllFailed(): void {
    if (!this.active) {
      return;
    }
    for (const record of this.tracked.values()) {
      if (record.status === "error") {
        record.status = "queued";
        record.bypassCache = true;
      }
    }
    void this.drainQueue();
  }

  getStats(): {
    totalImages: number;
    translatedImages: number;
    pendingCount: number;
    failedCount: number;
  } {
    let translatedImages = 0;
    let pendingCount = 0;
    let failedCount = 0;
    for (const item of this.tracked.values()) {
      if (item.status === "done") {
        translatedImages += 1;
      } else if (item.status === "queued" || item.status === "inflight") {
        pendingCount += 1;
      } else if (item.status === "error") {
        failedCount += 1;
      }
    }
    return {
      totalImages: Math.max(this.scanner.getTrackedCount(), this.tracked.size),
      translatedImages,
      pendingCount,
      failedCount,
    };
  }

  private enqueueStrip(strip: ScannedStrip, bypassCache: boolean): void {
    if (!this.active) {
      return;
    }
    const existing = this.tracked.get(strip.element);
    if (
      existing &&
      !bypassCache &&
      existing.strip.src === strip.src &&
      (existing.status === "done" ||
        existing.status === "inflight" ||
        existing.status === "queued")
    ) {
      return;
    }
    this.tracked.set(strip.element, {
      strip,
      status: "queued",
      bypassCache,
    });
    void this.drainQueue();
  }

  private async fetchStripPayload(
    strip: ScannedStrip,
    signal: AbortSignal,
  ): Promise<{ image_base64: string; image_mime: string }> {
    const src = strip.src;
    if (src.startsWith("data:")) {
      const commaIdx = src.indexOf(",");
      const mimeMatch = /^data:([^;,]+)/i.exec(src);
      return {
        image_base64: commaIdx >= 0 ? src.slice(commaIdx + 1) : src,
        image_mime: mimeMatch?.[1] ?? "image/png",
      };
    }

    try {
      return await apiClient.fetchImageBase64(src, signal);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw err;
      }
      // Fallback for blob-protected or hotlink-blocked strips visible in the viewport.
      const rect = strip.element.getBoundingClientRect();
      const visTop = Math.max(0, rect.top);
      const visLeft = Math.max(0, rect.left);
      const visRight = Math.min(window.innerWidth, rect.right);
      const visBottom = Math.min(window.innerHeight, rect.bottom);
      if (visRight - visLeft < 60 || visBottom - visTop < 60) {
        throw err;
      }
      const { dataUrl } = await apiClient.captureVisibleTab();
      const b64 = await cropDataUrlToBase64(
        dataUrl,
        {
          left: visLeft,
          top: visTop,
          width: visRight - visLeft,
          height: visBottom - visTop,
        },
        window.devicePixelRatio || 1,
      );
      return { image_base64: b64, image_mime: "image/png" };
    }
  }

  private async drainQueue(): Promise<void> {
    if (this.draining || !this.active) {
      return;
    }
    this.draining = true;

    try {
      while (this.active) {
        const nextRecord = Array.from(this.tracked.values())
          .filter((item) => item.status === "queued")
          .sort((a, b) => a.strip.order - b.strip.order)[0];

        if (!nextRecord) {
          break;
        }

        const { strip } = nextRecord;
        const bypassCache = nextRecord.bypassCache;
        nextRecord.status = "inflight";
        nextRecord.bypassCache = false;
        this.overlay.renderLoadingBadge(strip.element, strip.id);

        const controller = new AbortController();
        this.currentAbort = controller;

        try {
          const { image_base64, image_mime } = await this.fetchStripPayload(
            strip,
            controller.signal,
          );
          if (!this.active || controller.signal.aborted) {
            break;
          }

          const resp = await apiClient.translateManhwa(
            {
              session_id: this.sessionId,
              preset: this.preset,
              glossary_id: this.glossaryId,
              bypass_cache: bypassCache,
              image_id: strip.id,
              image_base64,
              image_mime,
            },
            controller.signal,
          );

          if (!this.active || controller.signal.aborted) {
            break;
          }

          nextRecord.status = "done";
          this.overlay.renderBubbles(strip.element, strip.id, resp.bubbles);
        } catch (err: unknown) {
          if (err instanceof Error && err.name === "AbortError") {
            nextRecord.status = "queued";
            break;
          }
          nextRecord.status = "error";
          const msg =
            err instanceof Error ? err.message : "Failed to translate strip.";
          this.overlay.renderErrorBadge(strip.element, strip.id, msg, () => {
            this.enqueueStrip(strip, true);
          });
        } finally {
          if (this.currentAbort === controller) {
            this.currentAbort = null;
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
