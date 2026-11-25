import { beforeEach, describe, expect, it } from "vitest";
import type { BubbleOverlay } from "../../shared/types";
import {
  ManhwaOverlayManager,
  RT_PEEK_ALL_CLASS,
  computeFittedFontSize,
  segmentThaiText,
} from "./overlay";

describe("content/manhwa/overlay", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    document.body.innerHTML = "";
  });

  it("fits Thai font sizes within [10px, 22px] based on bubble dimensions", () => {
    const bigBox = computeFittedFontSize("เดี๋ยวนะ!", 260, 140);
    const tinyBox = computeFittedFontSize(
      "ประโยคภาษาไทยที่ค่อนข้างยาวมากสำหรับกรอบคำพูดขนาดเล็กในหน้ามังฮวา",
      90,
      46,
    );
    expect(bigBox).toBeGreaterThanOrEqual(16);
    expect(bigBox).toBeLessThanOrEqual(22);
    expect(tinyBox).toBeGreaterThanOrEqual(10);
    expect(tinyBox).toBeLessThan(bigBox);

    const segmented = segmentThaiText("เดี๋ยวนะนายเคลียร์เกตนั่นคนเดียวเลยเหรอ");
    expect(segmented.replace(/\u200B/g, "")).toBe("เดี๋ยวนะนายเคลียร์เกตนั่นคนเดียวเลยเหรอ");
  });

  it("renders normalized [0..1] masks & pills and toggles Alt+O peek class", () => {
    const img = document.createElement("img");
    img.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 200,
        width: 800,
        height: 4000,
        right: 900,
        bottom: 4200,
        x: 100,
        y: 200,
        toJSON: () => ({}),
      }) as DOMRect;
    document.body.appendChild(img);

    const manager = new ManhwaOverlayManager(document, window);
    const bubbles: BubbleOverlay[] = [
      {
        id: "b-0",
        reading_order: 0,
        bbox: [0.1, 0.05, 0.45, 0.1],
        render_mode: "mask",
        bg_color: "#FFFFFF",
        text_color: "#111111",
        source_text: "Wait!",
        translated_text: "เดี๋ยวก่อน!",
      },
      {
        id: "b-1",
        reading_order: 1,
        bbox: [0.5, 0.12, 0.9, 0.16],
        render_mode: "pill",
        bg_color: "rgba(18, 18, 22, 0.84)",
        text_color: "#FFFFFF",
        source_text: "Not ordinary.",
        translated_text: "ไม่ธรรมดาเลย",
      },
    ];

    const container = manager.renderBubbles(img, "img-1", bubbles);
    expect(container.style.width).toBe("800px");
    expect(container.style.height).toBe("4000px");

    const renderedBoxes = Array.from(
      container.querySelectorAll<HTMLElement>(".rt-bubble-box"),
    );
    expect(renderedBoxes.length).toBe(2);
    expect(renderedBoxes[0]?.classList.contains("rt-bubble-mask")).toBe(true);
    expect(Number.parseFloat(renderedBoxes[0]?.style.left ?? "")).toBeCloseTo(10, 2);
    expect(Number.parseFloat(renderedBoxes[0]?.style.width ?? "")).toBeCloseTo(35, 2);
    expect(renderedBoxes[1]?.classList.contains("rt-bubble-pill")).toBe(true);
    expect(Number.parseFloat(renderedBoxes[1]?.style.top ?? "")).toBeCloseTo(12, 2);

    manager.setPeekAll(true);
    expect(document.documentElement.classList.contains(RT_PEEK_ALL_CLASS)).toBe(true);
    expect(manager.isPeekAll()).toBe(true);

    manager.clearAll();
    expect(document.querySelectorAll(".rt-manhwa-overlay").length).toBe(0);
    expect(manager.isPeekAll()).toBe(false);
    manager.destroy();
  });
});
