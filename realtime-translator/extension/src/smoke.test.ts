import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { markContentReady } from "./content/index";

describe("Phase 0 extension scaffold", () => {
  it("marks documentElement with data-rt-ready without polluting globals", () => {
    const el = document.createElement("html");
    markContentReady(el);
    expect(el.getAttribute("data-rt-ready")).toBe("1");
  });

  it("has a valid Manifest V3 source manifest with expected hotkeys", () => {
    const manifestPath = resolve(__dirname, "../public/manifest.json");
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      manifest_version: number;
      background: { service_worker: string; type: string };
      content_scripts: Array<{ js: string[]; css: string[] }>;
      commands: Record<string, { suggested_key?: { default?: string } }>;
    };

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.background.type).toBe("module");
    expect(manifest.content_scripts[0]?.js).toEqual(["content.js"]);
    expect(manifest.content_scripts[0]?.css).toEqual(["overlay.css"]);
    expect(manifest.commands["toggle-translate"]?.suggested_key?.default).toBe("Alt+T");
    expect(manifest.commands["peek-original"]?.suggested_key?.default).toBe("Alt+O");
    expect(manifest.commands["snip-region"]?.suggested_key?.default).toBe("Alt+S");
  });

  it("outputs an MV3-safe dist bundle with a self-contained IIFE content.js", () => {
    const distDir = resolve(__dirname, "../dist");
    const requiredFiles = [
      "manifest.json",
      "background.js",
      "content.js",
      "overlay.css",
      "popup.html",
      "options.html",
    ];

    for (const file of requiredFiles) {
      expect(existsSync(resolve(distDir, file)), `Missing dist/${file}`).toBe(true);
    }

    const contentBundle = readFileSync(resolve(distDir, "content.js"), "utf-8");
    expect(contentBundle).not.toMatch(/^\s*import\s+/m);
  });
});
