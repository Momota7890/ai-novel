/**
 * Manifest V3 Background Service Worker.
 * - Proxies localhost FastAPI HTTP calls with per-request AbortController support
 * - Routes Alt+T / Alt+O / Alt+S keyboard commands to the active tab
 */

import { getPreferences } from "../shared/storage";
import type {
  ApiAbortMessage,
  ApiProxyResponse,
  ApiRequestMessage,
  CommandName,
  ErrorDetail,
  ErrorEnvelope,
  TabCommandMessage,
} from "../shared/types";

const inFlightRequests = new Map<string, AbortController>();

function extractErrorDetail(payload: unknown, status: number): ErrorDetail {
  if (payload && typeof payload === "object" && "error" in payload) {
    const maybe = (payload as Partial<ErrorEnvelope>).error;
    if (
      maybe &&
      typeof maybe.code === "string" &&
      typeof maybe.message === "string" &&
      typeof maybe.retryable === "boolean"
    ) {
      return maybe;
    }
  }
  return {
    code: status >= 500 ? "TRANSLATION_ERROR" : "INVALID_REQUEST",
    message: `Local server returned HTTP ${status}.`,
    retryable: status >= 500,
  };
}

export async function handleApiRequestMessage(
  msg: ApiRequestMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiProxyResponse> {
  const controller = new AbortController();
  inFlightRequests.set(msg.requestId, controller);

  try {
    const prefs = await getPreferences();
    if (controller.signal.aborted) {
      const abortErr = new Error("Request aborted before fetch.");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    const url = `${prefs.serverBaseUrl}${msg.path.startsWith("/") ? msg.path : `/${msg.path}`}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    const init: RequestInit = {
      method: msg.method,
      headers,
      signal: controller.signal,
    };

    if (msg.body !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      init.body = JSON.stringify(msg.body);
    }

    const response = await fetchImpl(url, init);
    const contentType = response.headers.get("content-type") ?? "";
    const parsed: unknown = contentType.includes("application/json")
      ? await response.json().catch(() => null)
      : await response.text().catch(() => null);

    if (response.ok) {
      return {
        ok: true,
        status: response.status,
        data: parsed,
      };
    }

    return {
      ok: false,
      status: response.status,
      error: extractErrorDetail(parsed, response.status),
    };
  } catch (err: unknown) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      status: 0,
      error: {
        code: "NETWORK_ERROR",
        message: isAbort
          ? "Request cancelled."
          : "Cannot reach local server at 127.0.0.1:8765. Is start.bat running?",
        retryable: !isAbort,
      },
    };
  } finally {
    inFlightRequests.delete(msg.requestId);
  }
}

export function handleApiAbortMessage(msg: ApiAbortMessage): void {
  const controller = inFlightRequests.get(msg.requestId);
  if (controller) {
    controller.abort();
    inFlightRequests.delete(msg.requestId);
  }
}

function isRuntimeMessage(
  value: unknown,
): value is ApiRequestMessage | ApiAbortMessage {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    "type" in (value as Record<string, unknown>) &&
    ((value as { type: unknown }).type === "API_REQUEST" ||
      (value as { type: unknown }).type === "API_ABORT")
  );
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isRuntimeMessage(message)) {
      return false;
    }

    if (message.type === "API_ABORT") {
      handleApiAbortMessage(message);
      sendResponse({ ok: true });
      return false;
    }

    void handleApiRequestMessage(message).then((result) => {
      sendResponse(result);
    });
    return true;
  });
}

if (typeof chrome !== "undefined" && chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    const cmd = command as CommandName;
    if (
      cmd !== "toggle-translate" &&
      cmd !== "peek-original" &&
      cmd !== "snip-region"
    ) {
      return;
    }
    void chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const activeTabId = tabs[0]?.id;
      if (activeTabId === undefined) {
        return;
      }
      const payload: TabCommandMessage = { type: "RT_COMMAND", command: cmd };
      void chrome.tabs.sendMessage(activeTabId, payload).catch(() => {
        // Ignore restricted chrome:// or unloaded pages.
      });
    });
  });
}
