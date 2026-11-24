import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NovelTranslateRequest, NovelTranslateResponse } from "../../shared/types";
import { extractNovelParagraphs } from "./extractor";
import { NovelRenderer } from "./renderer";
import { NovelTranslationScheduler } from "./scheduler";

interface FakeObserverInstance {
  callback: IntersectionObserverCallback;
  options: IntersectionObserverInit | undefined;
  observed: Set<Element>;
  trigger: (elements: Element[]) => void;
}

describe("content/novel/scheduler", () => {
  let observers: FakeObserverInstance[] = [];

  beforeEach(() => {
    observers = [];
    document.body.innerHTML = `
      <article class="chapter-content">
        <p>Paragraph one text here.</p>
        <p>Paragraph two text here.</p>
        <p>Paragraph three text here.</p>
        <p>Paragraph four text here.</p>
        <p>Paragraph five text here.</p>
      </article>
    `;

    class MockIntersectionObserver implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin: string;
      readonly thresholds = [0];
      private readonly record: FakeObserverInstance;

      constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        this.rootMargin = options?.rootMargin ?? "0px";
        this.record = {
          callback,
          options,
          observed: new Set(),
          trigger: (elements: Element[]) => {
            const entries = elements.map(
              (target) =>
                ({
                  target,
                  isIntersecting: true,
                }) as IntersectionObserverEntry,
            );
            callback(entries, this);
          },
        };
        observers.push(this.record);
      }

      observe(target: Element): void {
        this.record.observed.add(target);
      }
      unobserve(target: Element): void {
        this.record.observed.delete(target);
      }
      disconnect(): void {
        this.record.observed.clear();
      }
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }

    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prioritizes Tier 0 visible paragraphs ahead of Tier 1 prefetch and batches <= 4", async () => {
    const renderer = new NovelRenderer(document);
    const paragraphs = extractNovelParagraphs(document);
    const sentBatches: string[][] = [];

    const translateFn = vi.fn(
      async (req: NovelTranslateRequest): Promise<NovelTranslateResponse> => {
        sentBatches.push(req.paragraphs.map((p) => p.id));
        return {
          model_id: "typhoon-ai/typhoon2.1-gemma3-12b",
          preset: req.preset,
          latency_ms: 10,
          cache_hits: 0,
          cache_misses: req.paragraphs.length,
          results: req.paragraphs.map((p) => ({
            id: p.id,
            translated_text: `ไทย:${p.id}`,
            cached: false,
          })),
        };
      },
    );

    const scheduler = new NovelTranslationScheduler(renderer, {
      sessionId: "tab-1",
      preset: "light_novel",
      batchSize: 2,
      translateFn,
    });
    scheduler.start(paragraphs);

    const visibleObs = observers.find((o) => o.options?.rootMargin === "0px");
    const prefetchObs = observers.find((o) =>
      o.options?.rootMargin?.includes("150%"),
    );
    expect(visibleObs).toBeDefined();
    expect(prefetchObs).toBeDefined();

    // Queue Tier 1 first (p-1, p-2), then immediately queue Tier 0 visible (p-4, p-5)
    // while batch 1 is running so batch 2 picks Tier 0 ahead of remaining Tier 1.
    prefetchObs?.trigger([paragraphs[0]!.element, paragraphs[1]!.element, paragraphs[2]!.element]);
    visibleObs?.trigger([paragraphs[3]!.element, paragraphs[4]!.element]);

    await vi.waitFor(() => {
      expect(scheduler.getStats().translatedCount).toBe(5);
    });

    // Microtask coalescing ensures Tier 0 visible paragraphs (p-4, p-5) batch FIRST ahead of Tier 1 prefetch!
    expect(sentBatches).toEqual([
      ["p-4", "p-5"],
      ["p-1", "p-2"],
      ["p-3"],
    ]);
  });

  it("aborts in-flight translation on stop() and sends bypass_cache on retry", async () => {
    const renderer = new NovelRenderer(document);
    const paragraphs = extractNovelParagraphs(document);
    let aborted = false;
    let startedResolve: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });

    const hangingTranslate = vi.fn(
      (_req: NovelTranslateRequest, signal?: AbortSignal) => {
        startedResolve?.();
        return new Promise<NovelTranslateResponse>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      },
    );

    const scheduler = new NovelTranslationScheduler(renderer, {
      sessionId: "tab-abort",
      preset: "light_novel",
      translateFn: hangingTranslate,
    });
    scheduler.start(paragraphs.slice(0, 1));
    observers[0]?.trigger([paragraphs[0]!.element]);
    await started;

    scheduler.stop();
    expect(aborted).toBe(true);

    // Verify retry uses bypass_cache: true.
    const calls: NovelTranslateRequest[] = [];
    const flakyTranslate = vi.fn(
      async (req: NovelTranslateRequest): Promise<NovelTranslateResponse> => {
        calls.push(req);
        if (calls.length === 1) {
          throw new Error("Temporary failure");
        }
        return {
          model_id: "m",
          preset: req.preset,
          latency_ms: 5,
          cache_hits: 0,
          cache_misses: 1,
          results: [{ id: "p-1", translated_text: "แปลใหม่", cached: false }],
        };
      },
    );

    const retryScheduler = new NovelTranslationScheduler(renderer, {
      sessionId: "tab-retry",
      preset: "light_novel",
      translateFn: flakyTranslate,
    });
    retryScheduler.start(paragraphs.slice(0, 1));
    observers[observers.length - 2]?.trigger([paragraphs[0]!.element]);

    await vi.waitFor(() => {
      expect(retryScheduler.getStats().failedCount).toBe(1);
    });

    retryScheduler.retryAllFailed();
    await vi.waitFor(() => {
      expect(retryScheduler.getStats().translatedCount).toBe(1);
    });

    expect(calls[0]?.bypass_cache).toBe(false);
    expect(calls[1]?.bypass_cache).toBe(true);
  });
});
