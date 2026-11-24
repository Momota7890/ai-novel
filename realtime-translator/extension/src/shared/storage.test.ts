import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PREFERENCES,
  getPreferences,
  getSiteRule,
  normalizeServerBaseUrl,
  savePreferences,
  setSiteRule,
} from "./storage";

describe("shared/storage", () => {
  const backingStore: Record<string, unknown> = {};

  beforeEach(() => {
    for (const key of Object.keys(backingStore)) {
      delete backingStore[key];
    }

    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: backingStore[key] })),
          set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(backingStore, items);
          }),
        },
      },
    });
  });

  it("returns safe defaults and only stores lightweight user preferences", async () => {
    const prefs = await getPreferences();
    expect(prefs.serverBaseUrl).toBe(DEFAULT_PREFERENCES.serverBaseUrl);
    expect(prefs.activePreset).toBe("light_novel");
    expect(Object.keys(backingStore)).toEqual([]);
  });

  it("enforces loopback-only server URLs", () => {
    expect(normalizeServerBaseUrl("http://127.0.0.1:8765/")).toBe(
      "http://127.0.0.1:8765",
    );
    expect(normalizeServerBaseUrl("http://localhost:8765")).toBe(
      "http://localhost:8765",
    );
    expect(() => normalizeServerBaseUrl("https://api.openai.com")).toThrow();
    expect(() => normalizeServerBaseUrl("http://0.0.0.0:8765")).toThrow();
  });

  it("persists active preset, typography, and per-site rules cleanly", async () => {
    await savePreferences({
      activePreset: "fantasy_murim",
      typography: {
        ...DEFAULT_PREFERENCES.typography,
        fontSize: "1.1em",
      },
    });
    await setSiteRule("ExampleNovel.com", {
      autoEnable: true,
      modeOverride: "novel",
      glossaryId: "solo-leveling",
    });

    const prefs = await getPreferences();
    expect(prefs.activePreset).toBe("fantasy_murim");
    expect(prefs.typography.fontSize).toBe("1.1em");

    const rule = await getSiteRule("examplenovel.com");
    expect(rule).toEqual({
      autoEnable: true,
      modeOverride: "novel",
      glossaryId: "solo-leveling",
    });
  });
});
