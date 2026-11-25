import { beforeEach, describe, expect, it, vi } from "vitest";
import { ManhwaImageScanner, scanManhwaStrips } from "./imageScanner";

function makeImg(opts: {
  src: string;
  width: number;
  height: number;
  className?: string;
}): HTMLImageElement {
  const img = document.createElement("img");
  img.src = opts.src;
  if (opts.className) {
    img.className = opts.className;
  }
  Object.defineProperty(img, "naturalWidth", { value: opts.width, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: opts.height, configurable: true });
  Object.defineProperty(img, "complete", { value: true, configurable: true });
  return img;
}

describe("content/manhwa/imageScanner", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("selects tall vertical strips (>= 400px wide) and skips icons, avatars, and wide banners", () => {
    const nav = document.createElement("nav");
    nav.appendChild(makeImg({ src: "https://cdn.test/nav.png", width: 800, height: 1200 }));

    const container = document.createElement("div");
    const avatar = makeImg({
      src: "https://cdn.test/avatar.png",
      width: 500,
      height: 500,
      className: "user-avatar",
    });
    const tiny = makeImg({ src: "https://cdn.test/icon.png", width: 120, height: 120 });
    const wideAd = makeImg({ src: "https://cdn.test/ad.jpg", width: 1200, height: 350 });
    const strip1 = makeImg({ src: "https://cdn.test/ch1-01.webp", width: 800, height: 4200 });
    const strip2 = makeImg({ src: "https://cdn.test/ch1-02.webp", width: 800, height: 3800 });

    container.append(avatar, tiny, wideAd, strip1, strip2);
    document.body.append(nav, container);

    const strips = scanManhwaStrips(document);
    expect(strips.map((s) => s.id)).toEqual(["img-1", "img-2"]);
    expect(strips.map((s) => s.src)).toEqual([
      "https://cdn.test/ch1-01.webp",
      "https://cdn.test/ch1-02.webp",
    ]);
  });

  it("uses IntersectionObserver with +1500px rootMargin and notifies visible strips", () => {
    let capturedMargin = "";
    const holder: { cb: IntersectionObserverCallback | null } = { cb: null };

    class MockIO implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin: string;
      readonly thresholds = [0];
      constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
        holder.cb = cb;
        this.rootMargin = opts?.rootMargin ?? "";
        capturedMargin = this.rootMargin;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }

    vi.stubGlobal("IntersectionObserver", MockIO);

    const strip = makeImg({ src: "https://cdn.test/strip1.webp", width: 800, height: 4000 });
    document.body.appendChild(strip);

    const seen: string[] = [];
    const scanner = new ManhwaImageScanner((s) => seen.push(s.id), { doc: document });
    scanner.start();

    expect(capturedMargin).toBe("0px 0px 1500px 0px");
    holder.cb?.(
      [{ target: strip, isIntersecting: true } as unknown as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    expect(seen).toEqual(["img-1"]);

    scanner.stop();
    vi.unstubAllGlobals();
  });
});
