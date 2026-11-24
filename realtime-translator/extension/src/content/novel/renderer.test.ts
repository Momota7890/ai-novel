import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TYPOGRAPHY } from "../../shared/storage";
import { NovelRenderer, RT_HIDDEN_CLASS } from "./renderer";

describe("content/novel/renderer", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    document.body.innerHTML = `<article><p id="src-1" data-rt-id="p-1">Hello world.</p></article>`;
  });

  it("injects a single sibling .rt-thai-block without duplicates on repeat updates", () => {
    const renderer = new NovelRenderer(document);
    const p = document.getElementById("src-1") as HTMLElement;

    renderer.renderLoading(p, "p-1");
    expect(p.nextElementSibling?.classList.contains("rt-thai-block")).toBe(true);
    expect(p.nextElementSibling?.classList.contains("rt-loading")).toBe(true);

    renderer.renderTranslation(p, "p-1", "สวัสดีชาวโลก", true);
    expect(document.querySelectorAll(".rt-thai-block").length).toBe(1);
    expect(p.nextElementSibling?.textContent).toBe("สวัสดีชาวโลก");
    expect(p.nextElementSibling?.getAttribute("data-rt-cached")).toBe("1");
  });

  it("toggles visibility non-destructively via .rt-hidden and wires Retry button", () => {
    const renderer = new NovelRenderer(document);
    const p = document.getElementById("src-1") as HTMLElement;
    const onRetry = vi.fn();

    renderer.renderError(p, "p-1", "Server busy", onRetry);
    const retryBtn = document.querySelector(".rt-retry-btn") as HTMLButtonElement;
    expect(retryBtn).not.toBeNull();
    retryBtn.click();
    expect(onRetry).toHaveBeenCalledWith("p-1");

    renderer.setHidden(true);
    expect(document.documentElement.classList.contains(RT_HIDDEN_CLASS)).toBe(true);
    expect(document.querySelectorAll(".rt-thai-block").length).toBe(1);

    renderer.applyTypography({ ...DEFAULT_TYPOGRAPHY, fontSize: "1.05em" });
    expect(
      document.documentElement.style.getPropertyValue("--rt-font-size"),
    ).toBe("1.05em");

    renderer.clearAll();
    expect(document.querySelectorAll(".rt-thai-block").length).toBe(0);
    expect(p.hasAttribute("data-rt-id")).toBe(false);
  });
});
