import { describe, expect, it } from "vitest";
import { extractNovelParagraphs } from "./extractor";

describe("content/novel/extractor", () => {
  it("extracts main chapter paragraphs and skips nav, footer, comments, and injected blocks", () => {
    document.body.innerHTML = `
      <header>
        <p>Home | Novels | Rankings | Login</p>
      </header>
      <nav class="navbar">
        <p><a href="/prev">Previous Chapter</a> | <a href="/next">Next Chapter</a></p>
      </nav>
      <main>
        <article class="chapter-content">
          <p>Sung Jin-Woo stepped forward into the cold dungeon air.</p>
          <div class="rt-thai-block" data-rt-for="p-1">ซองจินอู...</div>
          <p>"Arise," he whispered, activating Shadow Extraction.</p>
          <p>   </p>
          <p>12345</p>
          <p><a href="/next-ch">Next Chapter</a></p>
        </article>
        <section class="comments">
          <p>First! Great chapter thanks for translating!</p>
        </section>
      </main>
      <footer>
        <p>Copyright 2026 Novel Site Inc.</p>
      </footer>
    `;

    const extracted = extractNovelParagraphs(document);
    expect(extracted.map((p) => p.id)).toEqual(["p-1", "p-2"]);
    expect(extracted.map((p) => p.text)).toEqual([
      "Sung Jin-Woo stepped forward into the cold dungeon air.",
      '"Arise," he whispered, activating Shadow Extraction.',
    ]);

    // Re-running extraction preserves stable data-rt-id attributes.
    const secondPass = extractNovelParagraphs(document);
    expect(secondPass.map((p) => p.id)).toEqual(["p-1", "p-2"]);
  });
});
