/**
 * Lightweight user preferences stored in `chrome.storage.local`.
 * Invariant: NEVER store translation caches or image binaries in browser storage.
 */

import type { PresetId } from "./types";

export type PageModeOverride = "auto" | "novel" | "manhwa";

export interface TypographyPrefs {
  fontFamily: string;
  fontSize: string;
  lineHeight: number;
  textColor: string;
}

export interface SiteRule {
  autoEnable: boolean;
  modeOverride: PageModeOverride;
  glossaryId: string | null;
}

export interface UserPreferences {
  serverBaseUrl: string;
  activePreset: PresetId;
  typography: TypographyPrefs;
  siteRules: Record<string, SiteRule>;
}

const STORAGE_KEY = "rt_user_preferences_v1";

export const DEFAULT_TYPOGRAPHY: TypographyPrefs = {
  fontFamily: '"Sarabun", "Noto Sans Thai", "Tahoma", sans-serif',
  fontSize: "0.95em",
  lineHeight: 1.65,
  textColor: "inherit",
};

export const DEFAULT_PREFERENCES: UserPreferences = {
  serverBaseUrl: "http://127.0.0.1:8765",
  activePreset: "light_novel",
  typography: { ...DEFAULT_TYPOGRAPHY },
  siteRules: {},
};

const LOOPBACK_URL_RE = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{2,5})?\/?$/i;

export function normalizeServerBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!LOOPBACK_URL_RE.test(trimmed)) {
    throw new Error(
      `Server URL must target localhost or 127.0.0.1 (received: ${url})`,
    );
  }
  return trimmed;
}

function mergePreferences(raw: unknown): UserPreferences {
  if (!raw || typeof raw !== "object") {
    return {
      ...DEFAULT_PREFERENCES,
      typography: { ...DEFAULT_TYPOGRAPHY },
      siteRules: {},
    };
  }
  const record = raw as Partial<UserPreferences>;
  let serverBaseUrl = DEFAULT_PREFERENCES.serverBaseUrl;
  if (typeof record.serverBaseUrl === "string") {
    try {
      serverBaseUrl = normalizeServerBaseUrl(record.serverBaseUrl);
    } catch {
      serverBaseUrl = DEFAULT_PREFERENCES.serverBaseUrl;
    }
  }

  const preset: PresetId =
    record.activePreset === "modern_manhwa" ||
    record.activePreset === "fantasy_murim" ||
    record.activePreset === "light_novel" ||
    record.activePreset === "literal"
      ? record.activePreset
      : DEFAULT_PREFERENCES.activePreset;

  const typography: TypographyPrefs = {
    fontFamily:
      typeof record.typography?.fontFamily === "string"
        ? record.typography.fontFamily
        : DEFAULT_TYPOGRAPHY.fontFamily,
    fontSize:
      typeof record.typography?.fontSize === "string"
        ? record.typography.fontSize
        : DEFAULT_TYPOGRAPHY.fontSize,
    lineHeight:
      typeof record.typography?.lineHeight === "number" &&
      record.typography.lineHeight >= 1.0 &&
      record.typography.lineHeight <= 3.0
        ? record.typography.lineHeight
        : DEFAULT_TYPOGRAPHY.lineHeight,
    textColor:
      typeof record.typography?.textColor === "string"
        ? record.typography.textColor
        : DEFAULT_TYPOGRAPHY.textColor,
  };

  const siteRules: Record<string, SiteRule> = {};
  if (record.siteRules && typeof record.siteRules === "object") {
    for (const [host, rule] of Object.entries(record.siteRules)) {
      if (!rule || typeof rule !== "object") {
        continue;
      }
      const r = rule as Partial<SiteRule>;
      siteRules[host.toLowerCase()] = {
        autoEnable: Boolean(r.autoEnable),
        modeOverride:
          r.modeOverride === "novel" || r.modeOverride === "manhwa"
            ? r.modeOverride
            : "auto",
        glossaryId: typeof r.glossaryId === "string" ? r.glossaryId : null,
      };
    }
  }

  return {
    serverBaseUrl,
    activePreset: preset,
    typography,
    siteRules,
  };
}

export async function getPreferences(): Promise<UserPreferences> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return mergePreferences(stored[STORAGE_KEY]);
}

export async function savePreferences(
  patch: Partial<UserPreferences>,
): Promise<UserPreferences> {
  const current = await getPreferences();
  const next: UserPreferences = {
    serverBaseUrl:
      patch.serverBaseUrl !== undefined
        ? normalizeServerBaseUrl(patch.serverBaseUrl)
        : current.serverBaseUrl,
    activePreset: patch.activePreset ?? current.activePreset,
    typography: patch.typography
      ? { ...current.typography, ...patch.typography }
      : current.typography,
    siteRules: patch.siteRules
      ? { ...patch.siteRules }
      : { ...current.siteRules },
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

export async function getSiteRule(hostname: string): Promise<SiteRule> {
  const prefs = await getPreferences();
  const key = hostname.trim().toLowerCase();
  return (
    prefs.siteRules[key] ?? {
      autoEnable: false,
      modeOverride: "auto",
      glossaryId: null,
    }
  );
}

export async function setSiteRule(
  hostname: string,
  rule: Partial<SiteRule>,
): Promise<SiteRule> {
  const prefs = await getPreferences();
  const key = hostname.trim().toLowerCase();
  const merged: SiteRule = {
    ...(prefs.siteRules[key] ?? {
      autoEnable: false,
      modeOverride: "auto",
      glossaryId: null,
    }),
    ...rule,
  };
  const updatedRules = { ...prefs.siteRules, [key]: merged };
  await savePreferences({ siteRules: updatedRules });
  return merged;
}
