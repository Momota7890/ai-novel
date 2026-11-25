import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ManhwaSnipTool,
  clampCardPosition,
  computeDprCropRect,
  normalizeDragRect,
} from "./snipTool";

describe("content/manhwa/snipTool", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("normalizes reverse-direction drag rectangles and scales crops by devicePixelRatio", () => {
    const rect = normalizeDragRect(300, 260, 120, 80);
    expect(rect).toEqual({ left: 120, top: 80, width: 180, height: 180 });

    const dprCrop = computeDprCropRect(rect, 1.5, 1920, 1080);
    expect(dprCrop).toEqual({ left: 180, top: 120, width: 270, height: 270 });

    // Clamps cleanly to image boundaries.
    const clampedCrop = computeDprCropRect(
      { left: 950, top: 500, width: 200, height: 200 },
      2,
      1920,
      1080,
    );
    expect(clampedCrop.left + clampedCrop.width).toBeLessThanOrEqual(1920);
    expect(clampedCrop.top + clampedCrop.height).toBeLessThanOrEqual(1080);
  });

  it("clamps floating snip result card within viewport bounds", () => {
    const nearRight = clampCardPosition(
      { left: 1100, top: 680, width: 150, height: 80 },
      300,
      140,
      1280,
      720,
    );
    expect(nearRight.left + 300).toBeLessThanOrEqual(1280);
    expect(nearRight.top + 140).toBeLessThanOrEqual(720);
    expect(nearRight.left).toBeGreaterThanOrEqual(12);
    expect(nearRight.top).toBeGreaterThanOrEqual(12);
  });

  it("cancels on Escape and renders translated card on selection completion", async () => {
    const translateSnip = vi.fn(async () => ({
      source_text: "QUEST COMPLETED",
      translated_text: "ภารกิจสำเร็จแล้ว",
      latency_ms: 420,
    }));

    const tool = new ManhwaSnipTool(
      {
        getSessionId: () => "tab-1",
        getPreset: () => "modern_manhwa",
        captureTab: async () => ({ dataUrl: "data:image/png;base64,AAAA" }),
        cropImage: async () => "BBBB",
        translateSnip,
      },
      document,
      window,
    );

    tool.activate();
    expect(tool.isOpen()).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(tool.isOpen()).toBe(false);

    await tool.processSelection({ left: 50, top: 60, width: 160, height: 90 });
    expect(translateSnip).toHaveBeenCalledTimes(1);

    const cardBody = document.querySelector(".rt-snip-card-body");
    const cardSource = document.querySelector(".rt-snip-card-source");
    expect(cardBody?.textContent).toBe("ภารกิจสำเร็จแล้ว");
    expect(cardSource?.textContent).toBe("QUEST COMPLETED");

    tool.destroy();
    expect(document.querySelector(".rt-snip-card")).toBeNull();
  });
});
