/**
 * Content script coordinator (Phase 1 Web Novel + Phase 2 Vertical Manhwa & Alt+S Snip).
 * Compiled as a self-contained IIFE to `dist/content.js`.
 */

import { apiClient } from "../shared/apiClient";
import { getPreferences } from "../shared/storage";
import type {
  PresetId,
  ResolvedPageMode,
  TabControlMessage,
  TabModeOverride,
  TabStateSnapshot,
} from "../shared/types";
import { ManhwaPageController } from "./manhwa/controller";
import { scanManhwaStrips } from "./manhwa/imageScanner";
import { ManhwaSnipTool } from "./manhwa/snipTool";
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

function inferPageMode(doc: Document = document): ResolvedPageMode {
  const strips = scanManhwaStrips(doc);
  const paragraphs = extractNovelParagraphs(doc);
  const totalWords = paragraphs.reduce(
    (sum, p) => sum + p.text.split(/\s+/).filter(Boolean).length,
    0,
  );
  if (strips.length >= 2 && totalWords < 250) {
    return "manhwa";
  }
  if (strips.length >= 1 && paragraphs.length < 3) {
    return "manhwa";
  }
  return "novel";
}

class PageTranslatorCoordinator {
  private readonly novelRenderer = new NovelRenderer(document);
  private novelScheduler: NovelTranslationScheduler | null = null;
  private novelInitialized = false;

  private readonly manhwaController = new ManhwaPageController(document, window);
  private readonly snipTool: ManhwaSnipTool;

  private enabled = false;
  private modeOverride: TabModeOverride = "auto";
  private resolvedMode: ResolvedPageMode = "novel";
  private preset: PresetId = "light_novel";
  private sessionId = buildSessionId();
  private lastUrl = window.location.href;

  constructor() {
    this.snipTool = new ManhwaSnipTool(
      {
        getSessionId: () => this.sessionId,
        getPreset: () => this.preset,
      },
      document,
      window,
    );
  }

  async toggle(
    forceEnabled?: boolean,
    overridePreset?: PresetId,
    overrideMode?: TabModeOverride,
  ): Promise<TabStateSnapshot> {
    if (overridePreset) {
      this.preset = overridePreset;
    }
    if (overrideMode) {
      this.modeOverride = overrideMode;
    }

    const nextEnabled = forceEnabled ?? !this.enabled;
    if (nextEnabled) {
      await this.enable();
    } else {
      this.disable();
    }
    return this.getSnapshot();
  }

  async setModeOverride(nextMode: TabModeOverride): Promise<TabStateSnapshot> {
    this.modeOverride = nextMode;
    const wasEnabled = this.enabled;
    if (wasEnabled) {
      this.disable();
      await this.enable();
    } else {
      this.resolvedMode =
        nextMode === "auto" ? inferPageMode(document) : nextMode;
    }
    return this.getSnapshot();
  }

  async enable(): Promise<void> {
    const prefs = await getPreferences().catch(() => null);
    if (prefs) {
      this.novelRenderer.applyTypography(prefs.typography);
      this.preset = prefs.activePreset;
    }

    this.checkChapterNavigation();
    this.resolvedMode =
      this.modeOverride === "auto" ? inferPageMode(document) : this.modeOverride;

    this.enabled = true;
    this.novelRenderer.setHidden(false);

    if (this.resolvedMode === "manhwa") {
      this.novelScheduler?.stop();
      this.manhwaController.setConfig({
        sessionId: this.sessionId,
        preset: this.preset,
      });
      this.manhwaController.start();
      return;
    }

    this.manhwaController.stop();
    if (this.novelInitialized && this.novelScheduler) {
      this.novelScheduler.setConfig({
        sessionId: this.sessionId,
        preset: this.preset,
      });
      this.novelScheduler.resume();
      return;
    }

    const paragraphs = extractNovelParagraphs(document);
    this.novelScheduler = new NovelTranslationScheduler(this.novelRenderer, {
      sessionId: this.sessionId,
      preset: this.preset,
      batchSize: 4,
    });
    this.novelInitialized = true;
    this.novelScheduler.start(paragraphs);
  }

  disable(): void {
    this.enabled = false;
    this.novelScheduler?.stop();
    this.manhwaController.stop();
    this.novelRenderer.setHidden(true);
  }

  togglePeek(forceActive?: boolean): TabStateSnapshot {
    this.manhwaController.togglePeek(forceActive);
    return this.getSnapshot();
  }

  activateSnip(): TabStateSnapshot {
    this.snipTool.activate();
    return this.getSnapshot();
  }

  retryFailed(): TabStateSnapshot {
    if (this.enabled) {
      if (this.resolvedMode === "manhwa") {
        this.manhwaController.retryAllFailed();
      } else {
        this.novelScheduler?.retryAllFailed();
      }
    }
    return this.getSnapshot();
  }

  clearPage(): TabStateSnapshot {
    this.enabled = false;
    this.novelInitialized = false;
    this.novelScheduler?.stop();
    this.novelScheduler = null;
    this.novelRenderer.clearAll();
    this.manhwaController.clearAll();
    this.snipTool.dismissCard();
    void apiClient.resetSession(this.sessionId).catch(() => {
      // Ignore if backend is offline.
    });
    return this.getSnapshot();
  }

  getSnapshot(): TabStateSnapshot {
    const novelStats = this.novelScheduler?.getStats() ?? {
      totalParagraphs: 0,
      translatedCount: 0,
      pendingCount: 0,
      failedCount: 0,
    };
    const manhwaStats = this.manhwaController.getStats();

    return {
      enabled: this.enabled,
      hidden: this.novelRenderer.isHidden(),
      peekActive: this.manhwaController.isPeekActive(),
      modeOverride: this.modeOverride,
      resolvedMode: this.resolvedMode,
      preset: this.preset,
      sessionId: this.sessionId,
      totalParagraphs: novelStats.totalParagraphs,
      translatedCount: novelStats.translatedCount,
      pendingCount:
        this.resolvedMode === "manhwa"
          ? manhwaStats.pendingCount
          : novelStats.pendingCount,
      failedCount:
        this.resolvedMode === "manhwa"
          ? manhwaStats.failedCount
          : novelStats.failedCount,
      totalImages: manhwaStats.totalImages,
      translatedImages: manhwaStats.translatedImages,
    };
  }

  private checkChapterNavigation(): void {
    if (window.location.href === this.lastUrl) {
      return;
    }
    const previousSession = this.sessionId;
    this.lastUrl = window.location.href;
    this.sessionId = buildSessionId();
    this.novelInitialized = false;
    this.novelScheduler?.stop();
    this.novelScheduler = null;
    this.novelRenderer.clearAll();
    this.manhwaController.clearAll();
    this.snipTool.dismissCard();
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

  const coordinator = new PageTranslatorCoordinator();

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      if (!isTabControlMessage(message)) {
        return false;
      }

      if (message.type === "RT_COMMAND") {
        if (message.command === "toggle-translate") {
          void coordinator.toggle().then(sendResponse);
          return true;
        }
        if (message.command === "peek-original") {
          sendResponse(coordinator.togglePeek());
          return false;
        }
        if (message.command === "snip-region") {
          sendResponse(coordinator.activateSnip());
          return false;
        }
        return false;
      }

      if (message.type === "RT_TAB_GET_STATE") {
        sendResponse(coordinator.getSnapshot());
        return false;
      }

      if (message.type === "RT_TAB_TOGGLE") {
        void coordinator
          .toggle(message.enabled, message.preset, message.modeOverride)
          .then(sendResponse);
        return true;
      }

      if (message.type === "RT_TAB_SET_MODE") {
        void coordinator.setModeOverride(message.modeOverride).then(sendResponse);
        return true;
      }

      if (message.type === "RT_TAB_PEEK") {
        sendResponse(coordinator.togglePeek(message.active));
        return false;
      }

      if (message.type === "RT_TAB_SNIP") {
        sendResponse(coordinator.activateSnip());
        return false;
      }

      if (message.type === "RT_TAB_RETRY_FAILED") {
        sendResponse(coordinator.retryFailed());
        return false;
      }

      if (message.type === "RT_TAB_CLEAR_PAGE") {
        sendResponse(coordinator.clearPage());
        return false;
      }

      return false;
    });
  }
}
