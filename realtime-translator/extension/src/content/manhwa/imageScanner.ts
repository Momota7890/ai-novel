/**
 * Vertical long-strip Manhwa/Webtoon image scanner & scroll-ahead IntersectionObserver.
 * Detects qualifying strip `<img>` panels (`naturalWidth >= 400`), ignores thumbnails/ads,
 * watches lazy-load `src` swaps, and prefetches +1500px ahead of the viewport.
 */

export interface ScannedStrip {
  id: string;
  order: number;
  src: string;
  element: HTMLImageElement;
}

const EXCLUDED_IMAGE_ANCESTOR_SELECTOR = [
  "nav",
  "header",
  "footer",
  "aside",
  ".rt-manhwa-overlay",
  ".rt-snip-card",
].join(",");

const NOISE_IMG_RE =
  /\b(avatar|logo|icon|emoji|badge|banner|advert|ad-|sponsor|thumb|thumbnail|cover|profile|comment)\b/i;

export function getImageSourceUrl(img: HTMLImageElement): string {
  const raw = img.currentSrc || img.getAttribute("src") || "";
  return raw.trim();
}

export function isQualifyingManhwaStrip(img: HTMLImageElement): boolean {
  if (img.closest(EXCLUDED_IMAGE_ANCESTOR_SELECTOR)) {
    return false;
  }

  const src = getImageSourceUrl(img);
  if (!src || src.startsWith("data:image/svg")) {
    return false;
  }

  const tokens = `${img.id} ${img.className} ${img.alt}`;
  if (tokens.trim() && NOISE_IMG_RE.test(tokens)) {
    return false;
  }

  const width = img.naturalWidth || img.width || img.clientWidth;
  const height = img.naturalHeight || img.height || img.clientHeight;
  if (width < 400 || height < 300) {
    return false;
  }

  // Skip ultra-wide horizontal ad banners (aspect ratio width > 2.2 * height).
  if (width > height * 2.2) {
    return false;
  }

  return true;
}

export function scanManhwaStrips(doc: Document = document): ScannedStrip[] {
  const images = Array.from(doc.querySelectorAll("img"));
  const strips: ScannedStrip[] = [];
  let idx = 1;

  for (const img of images) {
    if (!isQualifyingManhwaStrip(img)) {
      continue;
    }
    const existingId = img.getAttribute("data-rt-img-id");
    const id = existingId && existingId.trim() ? existingId : `img-${idx}`;
    img.setAttribute("data-rt-img-id", id);
    strips.push({
      id,
      order: idx - 1,
      src: getImageSourceUrl(img),
      element: img,
    });
    idx += 1;
  }

  return strips;
}

export type OnStripReadyCallback = (strip: ScannedStrip) => void;

export class ManhwaImageScanner {
  private readonly doc: Document;
  private readonly onStripVisible: OnStripReadyCallback;
  private readonly rootMargin: string;

  private observer: IntersectionObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private readonly trackedByElement = new Map<HTMLImageElement, ScannedStrip>();
  private readonly observedElements = new Set<HTMLImageElement>();
  private readonly loadHandlers = new Map<HTMLImageElement, () => void>();
  private nextIdCounter = 1;
  private active = false;

  constructor(
    onStripVisible: OnStripReadyCallback,
    options: { doc?: Document; rootMargin?: string } = {},
  ) {
    this.doc = options.doc ?? document;
    this.onStripVisible = onStripVisible;
    this.rootMargin = options.rootMargin ?? "0px 0px 1500px 0px";
  }

  start(): ScannedStrip[] {
    this.stop();
    this.active = true;

    if (typeof IntersectionObserver !== "undefined") {
      this.observer = new IntersectionObserver(
        (entries) => {
          if (!this.active) {
            return;
          }
          for (const entry of entries) {
            if (!entry.isIntersecting) {
              continue;
            }
            const img = entry.target as HTMLImageElement;
            const strip = this.trackedByElement.get(img);
            if (strip) {
              this.onStripVisible(strip);
            }
          }
        },
        { rootMargin: this.rootMargin },
      );
    }

    const initial = this.rescan();

    if (typeof MutationObserver !== "undefined" && this.doc.body) {
      this.mutationObserver = new MutationObserver(() => {
        if (this.active) {
          this.rescan();
        }
      });
      this.mutationObserver.observe(this.doc.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "data-src"],
      });
    }

    return initial;
  }

  rescan(): ScannedStrip[] {
    const images = Array.from(this.doc.querySelectorAll("img"));
    const strips: ScannedStrip[] = [];

    for (const img of images) {
      if (!img.complete && !this.loadHandlers.has(img)) {
        const onLoad = (): void => {
          if (this.active) {
            this.rescan();
          }
        };
        this.loadHandlers.set(img, onLoad);
        img.addEventListener("load", onLoad, { once: true });
      }

      if (!isQualifyingManhwaStrip(img)) {
        continue;
      }

      const src = getImageSourceUrl(img);
      const prev = this.trackedByElement.get(img);
      const id =
        prev?.id ??
        img.getAttribute("data-rt-img-id") ??
        `img-${this.nextIdCounter++}`;
      img.setAttribute("data-rt-img-id", id);

      const strip: ScannedStrip = {
        id,
        order: prev?.order ?? strips.length,
        src,
        element: img,
      };
      this.trackedByElement.set(img, strip);
      strips.push(strip);

      if (!this.observedElements.has(img) || (prev && prev.src !== src)) {
        this.observedElements.add(img);
        if (this.observer) {
          this.observer.unobserve(img);
          this.observer.observe(img);
        } else {
          this.onStripVisible(strip);
        }
      }
    }

    return strips;
  }

  stop(): void {
    this.active = false;
    this.observer?.disconnect();
    this.observer = null;
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    for (const [img, handler] of this.loadHandlers.entries()) {
      img.removeEventListener("load", handler);
    }
    this.loadHandlers.clear();
    this.observedElements.clear();
    this.trackedByElement.clear();
  }

  getTrackedCount(): number {
    return this.trackedByElement.size;
  }
}
