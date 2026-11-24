/**
 * Priority scroll-ahead scheduler for Web Novel bilingual translation.
 * - Tier 0: Currently visible viewport paragraphs
 * - Tier 1: Next ~1.5 viewports below scroll position (silent pre-fetch)
 * - Batches 4-6 paragraphs per request and cancels cleanly via AbortController
 */

import { ApiClientError, apiClient } from "../../shared/apiClient";
import type {
  NovelTranslateRequest,
  NovelTranslateResponse,
  PresetId,
} from "../../shared/types";
import type { ExtractedParagraph } from "./extractor";
import type { NovelRenderer } from "./renderer";

type ItemStatus = "idle" | "queued" | "inflight" | "done" | "error";

interface TrackedParagraph {
  item: ExtractedParagraph;
  status: ItemStatus;
  tier: number; // 0 = visible, 1 = prefetch, 2 = unprioritized
  bypassCache: boolean;
}

export type TranslateNovelFn = (
  req: NovelTranslateRequest,
  signal?: AbortSignal,
) => Promise<NovelTranslateResponse>;

export interface SchedulerOptions {
  sessionId: string;
  preset: PresetId;
  glossaryId?: string | null;
  batchSize?: number;
  translateFn?: TranslateNovelFn;
}

export interface SchedulerStats {
  totalParagraphs: number;
  translatedCount: number;
  pendingCount: number;
  failedCount: number;
}

export class NovelTranslationScheduler {
  private readonly renderer: NovelRenderer;
  private readonly translateFn: TranslateNovelFn;
  private readonly batchSize: number;
  private sessionId: string;
  private preset: PresetId;
  private glossaryId: string | null;

  private readonly itemsById = new Map<string, TrackedParagraph>();
  private readonly itemsByElement = new Map<Element, TrackedParagraph>();
  private visibleObserver: IntersectionObserver | null = null;
  private prefetchObserver: IntersectionObserver | null = null;

  private active = false;
  private draining = false;
  private drainScheduled = false;
  private currentAbort: AbortController | null = null;

  constructor(renderer: NovelRenderer, options: SchedulerOptions) {
    this.renderer = renderer;
    this.sessionId = options.sessionId;
    this.preset = options.preset;
    this.glossaryId = options.glossaryId ?? null;
    this.batchSize = Math.max(1, Math.min(6, options.batchSize ?? 4));
    this.translateFn = options.translateFn ?? apiClient.translateNovel;
  }

  start(paragraphs: ExtractedParagraph[]): void {
    this.stop();
    this.active = true;
    this.itemsById.clear();
    this.itemsByElement.clear();

    for (const item of paragraphs) {
      const tracked: TrackedParagraph = {
        item,
        status: "idle",
        tier: 2,
        bypassCache: false,
      };
      this.itemsById.set(item.id, tracked);
      this.itemsByElement.set(item.element, tracked);
    }

    this.attachObservers();
  }

  resume(): void {
    if (this.active) {
      return;
    }
    this.active = true;
    this.attachObservers();
  }

  private attachObservers(): void {
    if (typeof IntersectionObserver !== "undefined") {
      this.visibleObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) {
              continue;
            }
            const tracked = this.itemsByElement.get(entry.target);
            if (tracked) {
              this.enqueue(tracked.item.id, 0);
            }
          }
        },
        { rootMargin: "0px" },
      );

      this.prefetchObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) {
              continue;
            }
            const tracked = this.itemsByElement.get(entry.target);
            if (tracked) {
              this.enqueue(tracked.item.id, 1);
            }
          }
        },
        { rootMargin: "0px 0px 150% 0px" },
      );

      for (const tracked of this.itemsById.values()) {
        if (tracked.status !== "done") {
          this.visibleObserver.observe(tracked.item.element);
          this.prefetchObserver.observe(tracked.item.element);
        }
      }
    } else {
      for (const tracked of this.itemsById.values()) {
        if (tracked.status !== "done") {
          this.enqueue(tracked.item.id, 0);
        }
      }
    }
  }

  stop(): void {
    this.active = false;
    this.drainScheduled = false;
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
    this.visibleObserver?.disconnect();
    this.visibleObserver = null;
    this.prefetchObserver?.disconnect();
    this.prefetchObserver = null;

    for (const tracked of this.itemsById.values()) {
      if (tracked.status === "queued" || tracked.status === "inflight") {
        tracked.status = "idle";
      }
    }
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

  enqueue(paragraphId: string, tier: number, bypassCache = false): void {
    if (!this.active) {
      return;
    }
    const tracked = this.itemsById.get(paragraphId);
    if (!tracked) {
      return;
    }
    if (!bypassCache && (tracked.status === "done" || tracked.status === "inflight")) {
      return;
    }

    if (bypassCache) {
      tracked.bypassCache = true;
      tracked.tier = 0;
      tracked.status = "queued";
    } else if (tracked.status === "queued") {
      tracked.tier = Math.min(tracked.tier, tier);
    } else if (tracked.status === "idle") {
      tracked.tier = tier;
      tracked.status = "queued";
    } else {
      return;
    }

    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.draining || !this.active) {
      return;
    }
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      void this.drainQueue();
    });
  }

  retryItem(paragraphId: string): void {
    const tracked = this.itemsById.get(paragraphId);
    if (!tracked) {
      return;
    }
    tracked.status = "idle";
    this.enqueue(paragraphId, 0, true);
  }

  retryAllFailed(): void {
    for (const tracked of this.itemsById.values()) {
      if (tracked.status === "error") {
        tracked.status = "idle";
        this.enqueue(tracked.item.id, 0, true);
      }
    }
  }

  getStats(): SchedulerStats {
    let translatedCount = 0;
    let pendingCount = 0;
    let failedCount = 0;

    for (const tracked of this.itemsById.values()) {
      if (tracked.status === "done") {
        translatedCount += 1;
      } else if (tracked.status === "queued" || tracked.status === "inflight") {
        pendingCount += 1;
      } else if (tracked.status === "error") {
        failedCount += 1;
      }
    }

    return {
      totalParagraphs: this.itemsById.size,
      translatedCount,
      pendingCount,
      failedCount,
    };
  }

  private nextBatch(): TrackedParagraph[] {
    const queued = Array.from(this.itemsById.values()).filter(
      (entry) => entry.status === "queued",
    );
    if (queued.length === 0) {
      return [];
    }

    queued.sort((a, b) => {
      if (a.tier !== b.tier) {
        return a.tier - b.tier;
      }
      return a.item.order - b.item.order;
    });

    const first = queued[0];
    if (!first) {
      return [];
    }
    const wantBypass = first.bypassCache;
    return queued
      .filter((entry) => entry.bypassCache === wantBypass)
      .slice(0, this.batchSize);
  }

  private async drainQueue(): Promise<void> {
    if (this.draining || !this.active) {
      return;
    }
    this.draining = true;

    try {
      while (this.active) {
        const batch = this.nextBatch();
        if (batch.length === 0) {
          break;
        }

        const bypassCache = batch[0]?.bypassCache ?? false;
        for (const entry of batch) {
          entry.status = "inflight";
          entry.bypassCache = false;
          this.renderer.renderLoading(entry.item.element, entry.item.id);
        }

        const controller = new AbortController();
        this.currentAbort = controller;

        try {
          const response = await this.translateFn(
            {
              session_id: this.sessionId,
              preset: this.preset,
              glossary_id: this.glossaryId,
              bypass_cache: bypassCache,
              paragraphs: batch.map((entry) => ({
                id: entry.item.id,
                text: entry.item.text,
              })),
            },
            controller.signal,
          );

          if (!this.active || controller.signal.aborted) {
            break;
          }

          const byId = new Map(response.results.map((r) => [r.id, r]));
          for (const entry of batch) {
            const match = byId.get(entry.item.id);
            if (match) {
              entry.status = "done";
              this.renderer.renderTranslation(
                entry.item.element,
                entry.item.id,
                match.translated_text,
                match.cached,
              );
            } else {
              entry.status = "error";
              this.renderer.renderError(
                entry.item.element,
                entry.item.id,
                "Missing translated paragraph.",
                (id) => this.retryItem(id),
              );
            }
          }
        } catch (err: unknown) {
          if (err instanceof Error && err.name === "AbortError") {
            for (const entry of batch) {
              if (entry.status === "inflight") {
                entry.status = "idle";
              }
            }
            break;
          }

          const message =
            err instanceof ApiClientError
              ? err.code === "MODEL_LOADING"
                ? "Model is loading onto GPU... click Retry shortly."
                : err.message
              : err instanceof Error
                ? err.message
                : "Translation failed.";

          for (const entry of batch) {
            entry.status = "error";
            this.renderer.renderError(
              entry.item.element,
              entry.item.id,
              message,
              (id) => this.retryItem(id),
            );
          }
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
