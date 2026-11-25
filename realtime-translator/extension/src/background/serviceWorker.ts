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
  CaptureVisibleTabData,
  CaptureVisibleTabMessage,
  CommandName,
  ErrorDetail,
  ErrorEnvelope,
  FetchImageBase64Data,
  FetchImageBase64Message,
  TabCommandMessage,
} from "../shared/types";

const inFlightRequests = new Map<string, AbortController>();

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    parts.push(String.fromCharCode(...slice));
  }
  return btoa(parts.join(""));
}

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

export async function handleFetchImageBase64Message(
  msg: FetchImageBase64Message,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiProxyResponse<FetchImageBase64Data>> {
  const controller = new AbortController();
  inFlightRequests.set(msg.requestId, controller);

  try {
    const response = await fetchImpl(msg.url, {
      method: "GET",
      credentials: "include",
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: {
          code: "IMAGE_DECODE_ERROR",
          message: `Failed to fetch strip image (HTTP ${response.status}).`,
          retryable: response.status >= 500,
        },
      };
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) {
      return {
        ok: false,
        status: 422,
        error: {
          code: "IMAGE_DECODE_ERROR",
          message: "Fetched image was empty.",
          retryable: false,
        },
      };
    }

    const rawMime = response.headers.get("content-type") ?? "image/webp";
    const imageMime = rawMime.split(";")[0]?.trim() || "image/webp";
    return {
      ok: true,
      status: 200,
      data: {
        image_base64: arrayBufferToBase64(buffer),
        image_mime: imageMime,
      },
    };
  } catch (err: unknown) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      status: 0,
      error: {
        code: "NETWORK_ERROR",
        message: isAbort
          ? "Image fetch cancelled."
          : "Could not download cross-origin strip image.",
        retryable: !isAbort,
      },
    };
  } finally {
    inFlightRequests.delete(msg.requestId);
  }
}

export async function handleCaptureVisibleTabMessage(
  windowId?: number,
): Promise<ApiProxyResponse<CaptureVisibleTabData>> {
  try {
    const dataUrl =
      windowId !== undefined
        ? await chrome.tabs.captureVisibleTab(windowId, { format: "png" })
        : await chrome.tabs.captureVisibleTab({ format: "png" });
    return {
      ok: true,
      status: 200,
      data: { dataUrl },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      status: 500,
      error: {
        code: "IMAGE_DECODE_ERROR",
        message:
          err instanceof Error
            ? err.message
            : "Failed to capture visible browser tab.",
        retryable: false,
      },
    };
  }
}

type BackgroundMessage =
  | ApiRequestMessage
  | ApiAbortMessage
  | FetchImageBase64Message
  | CaptureVisibleTabMessage;

function isRuntimeMessage(value: unknown): value is BackgroundMessage {
  if (!value || typeof value !== "object" || !("type" in value)) {
    return false;
  }
  const kind = (value as { type: unknown }).type;
  return (
    kind === "API_REQUEST" ||
    kind === "API_ABORT" ||
    kind === "FETCH_IMAGE_BASE64" ||
    kind === "CAPTURE_VISIBLE_TAB"
  );
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isRuntimeMessage(message)) {
      return false;
    }

    if (message.type === "API_ABORT") {
      handleApiAbortMessage(message);
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "FETCH_IMAGE_BASE64") {
      void handleFetchImageBase64Message(message).then(sendResponse);
      return true;
    }

    if (message.type === "CAPTURE_VISIBLE_TAB") {
      void handleCaptureVisibleTabMessage(sender.tab?.windowId).then(sendResponse);
      return true;
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
