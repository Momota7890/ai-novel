/**
 * Background-routed HTTP client for http://127.0.0.1:8765.
 * All extension calls go through the MV3 Service Worker so strict page CSP
 * and Mixed Content rules never block localhost requests.
 */

import type {
  ApiAbortMessage,
  ApiProxyResponse,
  ApiRequestMessage,
  CacheClearResponse,
  CacheStatsResponse,
  ErrorCode,
  ErrorDetail,
  HealthResponse,
  HttpMethod,
  ModelLoadRequest,
  ModelStatusResponse,
  ModelUnloadResponse,
  NovelTranslateRequest,
  NovelTranslateResponse,
  PresetsResponse,
  SessionResetResponse,
  SettingsPatchRequest,
  SettingsResponse,
} from "./types";

export class ApiClientError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(detail: ErrorDetail, status: number) {
    super(detail.message);
    this.name = "ApiClientError";
    this.code = detail.code;
    this.status = status;
    this.retryable = detail.retryable;
  }
}

let requestCounter = 0;

function createRequestId(): string {
  requestCounter += 1;
  return `req-${Date.now()}-${requestCounter}`;
}

function createAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("The request was aborted.", "AbortError");
  }
  const err = new Error("The request was aborted.");
  err.name = "AbortError";
  return err;
}

export interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  signal?: AbortSignal;
}

export async function sendApiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = "GET", body, signal } = options;
  if (signal?.aborted) {
    throw createAbortError();
  }

  const requestId = createRequestId();
  const payload: ApiRequestMessage = {
    type: "API_REQUEST",
    requestId,
    path,
    method,
    ...(body !== undefined ? { body } : {}),
  };

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      const abortMsg: ApiAbortMessage = { type: "API_ABORT", requestId };
      void chrome.runtime.sendMessage(abortMsg).catch(() => {
        // Ignore if service worker is asleep.
      });
      reject(createAbortError());
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    chrome.runtime
      .sendMessage(payload)
      .then((rawResponse: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();

        const resp = rawResponse as ApiProxyResponse<T> | undefined;
        if (!resp || typeof resp !== "object" || typeof resp.ok !== "boolean") {
          reject(
            new ApiClientError(
              {
                code: "NETWORK_ERROR",
                message: "No response from extension background service worker.",
                retryable: true,
              },
              0,
            ),
          );
          return;
        }

        if (resp.ok) {
          resolve(resp.data);
          return;
        }

        reject(new ApiClientError(resp.error, resp.status));
      })
      .catch((err: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        const message =
          err instanceof Error ? err.message : "Failed to reach background worker.";
        reject(
          new ApiClientError(
            {
              code: "NETWORK_ERROR",
              message,
              retryable: true,
            },
            0,
          ),
        );
      });
  });
}

export const apiClient = {
  getHealth(signal?: AbortSignal): Promise<HealthResponse> {
    return sendApiRequest<HealthResponse>("/health", { method: "GET", signal });
  },

  getModelStatus(signal?: AbortSignal): Promise<ModelStatusResponse> {
    return sendApiRequest<ModelStatusResponse>("/model/status", {
      method: "GET",
      signal,
    });
  },

  loadModel(
    body: ModelLoadRequest = {},
    signal?: AbortSignal,
  ): Promise<ModelStatusResponse> {
    return sendApiRequest<ModelStatusResponse>("/model/load", {
      method: "POST",
      body,
      signal,
    });
  },

  unloadModel(signal?: AbortSignal): Promise<ModelUnloadResponse> {
    return sendApiRequest<ModelUnloadResponse>("/model/unload", {
      method: "POST",
      signal,
    });
  },

  patchSettings(
    body: SettingsPatchRequest,
    signal?: AbortSignal,
  ): Promise<SettingsResponse> {
    return sendApiRequest<SettingsResponse>("/settings", {
      method: "PATCH",
      body,
      signal,
    });
  },

  getPresets(signal?: AbortSignal): Promise<PresetsResponse> {
    return sendApiRequest<PresetsResponse>("/presets", {
      method: "GET",
      signal,
    });
  },

  translateNovel(
    body: NovelTranslateRequest,
    signal?: AbortSignal,
  ): Promise<NovelTranslateResponse> {
    return sendApiRequest<NovelTranslateResponse>("/translate/novel", {
      method: "POST",
      body,
      signal,
    });
  },

  resetSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<SessionResetResponse> {
    return sendApiRequest<SessionResetResponse>(
      `/session/${encodeURIComponent(sessionId)}/reset`,
      { method: "POST", signal },
    );
  },

  getCacheStats(signal?: AbortSignal): Promise<CacheStatsResponse> {
    return sendApiRequest<CacheStatsResponse>("/cache/stats", {
      method: "GET",
      signal,
    });
  },

  clearCache(signal?: AbortSignal): Promise<CacheClearResponse> {
    return sendApiRequest<CacheClearResponse>("/cache/clear", {
      method: "POST",
      signal,
    });
  },
};
