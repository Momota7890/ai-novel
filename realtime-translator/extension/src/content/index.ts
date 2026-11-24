/**
 * Content script coordinator (Phase 1: Web Novel Bilingual Inline MVP).
 * Compiled as a self-contained IIFE to `dist/content.js`.
 */

import { apiClient } from "../shared/apiClient";
import { getPreferences } from "../shared/storage";
import type {
  PresetId,
  TabControlMessage,
  TabStateSnapshot,
} from "../shared/types";
import { extractNovelParagraphs } from "./novel/extractor";
import { NovelRenderer } from "./novel/renderer";
import { NovelTranslationScheduler } from "./novel/scheduler";

const RT_ROOT_ATTR = "data-rt-ready";

export function markContentReady(root: HTMLElement = document.documentElement): void {
  root.setAttribute(RT_ROOT_ATTR, "1");
}

function buildSessionId(loc: Location = window.location): string {
  const cleanPath = loc.pathname.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 64);
  return `page-${loc.hostname}-${cleanPath || "root"}`;
}

class NovelPageController {
  private readonly renderer = new NovelRenderer(document);
  private scheduler: NovelTranslationScheduler | null = null;
  private enabled = false;
  private initialized = false;
  private preset: PresetId = "light_novel";
  private sessionId = buildSessionId();
  private lastUrl = window.location.href;

  async toggle(forceEnabled?: boolean, overridePreset?: PresetId): Promise<TabStateSnapshot> {
    if (overridePreset) {
      this.preset = overridePreset;
    }

    const nextEnabled = forceEnabled ?? !this.enabled;
    if (nextEnabled) {
      await this.enable();
    } else {
      this.disable();
    }
    return this.getSnapshot();
  }

  async enable(): Promise<void> {
    const prefs = await getPreferences().catch(() => null);
    if (prefs) {
      this.renderer.applyTypography(prefs.typography);
      this.preset = prefs.activePreset;
    }

    this.checkChapterNavigation();

    if (this.initialized && this.scheduler) {
      // Non-destructive instant show without re-translating already-rendered paragraphs.
      this.enabled = true;
      this.renderer.setHidden(false);
      this.scheduler.setConfig({
        sessionId: this.sessionId,
        preset: this.preset,
      });
      this.scheduler.resume();
      return;
    }

    const paragraphs = extractNovelParagraphs(document);
    this.scheduler = new NovelTranslationScheduler(this.renderer, {
      sessionId: this.sessionId,
      preset: this.preset,
      batchSize: 4,
    });
    this.enabled = true;
    this.initialized = true;
    this.renderer.setHidden(false);
    this.scheduler.start(paragraphs);
  }

  disable(): void {
    this.enabled = false;
    this.scheduler?.stop();
    this.renderer.setHidden(true);
  }

  retryFailed(): TabStateSnapshot {
    if (this.enabled && this.scheduler) {
      this.scheduler.retryAllFailed();
    }
    return this.getSnapshot();
  }

  clearPage(): TabStateSnapshot {
    this.enabled = false;
    this.initialized = false;
    this.scheduler?.stop();
    this.scheduler = null;
    this.renderer.clearAll();
    void apiClient.resetSession(this.sessionId).catch(() => {
      // Ignore if backend is offline.
    });
    return this.getSnapshot();
  }

  getSnapshot(): TabStateSnapshot {
    const stats = this.scheduler?.getStats() ?? {
      totalParagraphs: 0,
      translatedCount: 0,
      pendingCount: 0,
      failedCount: 0,
    };
    return {
      enabled: this.enabled,
      hidden: this.renderer.isHidden(),
      preset: this.preset,
      sessionId: this.sessionId,
      ...stats,
    };
  }

  private checkChapterNavigation(): void {
    if (window.location.href === this.lastUrl) {
      return;
    }
    const previousSession = this.sessionId;
    this.lastUrl = window.location.href;
    this.sessionId = buildSessionId();
    this.initialized = false;
    this.scheduler?.stop();
    this.scheduler = null;
    this.renderer.clearAll();
    void apiClient.resetSession(previousSession).catch(() => {
      // Ignore if backend is offline.
    });
  }
}

function isTabControlMessage(value: unknown): value is TabControlMessage {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    "type" in (value as Record<string, unknown>) &&
    typeof (value as { type: unknown }).type === "string" &&
    (value as { type: string }).type.startsWith("RT_")
  );
}

if (typeof document !== "undefined" && document.documentElement) {
  markContentReady(document.documentElement);

  const controller = new NovelPageController();

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      if (!isTabControlMessage(message)) {
        return false;
      }

      if (message.type === "RT_COMMAND") {
        if (message.command === "toggle-translate") {
          void controller.toggle().then(sendResponse);
          return true;
        }
        return false;
      }

      if (message.type === "RT_TAB_GET_STATE") {
        sendResponse(controller.getSnapshot());
        return false;
      }

      if (message.type === "RT_TAB_TOGGLE") {
        void controller
          .toggle(message.enabled, message.preset)
          .then(sendResponse);
        return true;
      }

      if (message.type === "RT_TAB_RETRY_FAILED") {
        sendResponse(controller.retryFailed());
        return false;
      }

      if (message.type === "RT_TAB_CLEAR_PAGE") {
        sendResponse(controller.clearPage());
        return false;
      }

      return false;
    });
  }
}
