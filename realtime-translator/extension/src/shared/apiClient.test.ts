import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  arrayBufferToBase64,
  handleApiAbortMessage,
  handleApiRequestMessage,
  handleFetchImageBase64Message,
} from "../background/serviceWorker";
import { ApiClientError, apiClient } from "./apiClient";
import type {
  ApiAbortMessage,
  ApiRequestMessage,
  FetchImageBase64Message,
} from "./types";

describe("shared/apiClient + background SW proxy", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
        },
      },
      runtime: {
        sendMessage: vi.fn(),
      },
    });
  });

  it("proxies JSON requests through SW and decodes response payload", async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: "ok",
          version: "0.1.0",
          gpu_name: "NVIDIA GeForce RTX 5060 Ti",
          cuda_available: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (msg: unknown) => {
      return handleApiRequestMessage(msg as ApiRequestMessage, fakeFetch);
    });

    const health = await apiClient.getHealth();
    expect(health.status).toBe("ok");
    expect(health.cuda_available).toBe(true);
    expect(fakeFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("surfaces standardized API error envelopes as ApiClientError", async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "MODEL_LOADING",
            message: "Model is loading onto GPU.",
            retryable: true,
          },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      ),
    );

    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (msg: unknown) => {
      return handleApiRequestMessage(msg as ApiRequestMessage, fakeFetch);
    });

    await expect(
      apiClient.translateNovel({
        session_id: "s1",
        preset: "light_novel",
        paragraphs: [{ id: "p-1", text: "Hello" }],
      }),
    ).rejects.toMatchObject({
      name: "ApiClientError",
      code: "MODEL_LOADING",
      status: 503,
      retryable: true,
    });
  });

  it("propagates AbortSignal to SW via API_ABORT and rejects with AbortError", async () => {
    const abortedSignals: boolean[] = [];
    let fetchStartedResolve: (() => void) | null = null;
    const fetchStarted = new Promise<void>((resolve) => {
      fetchStartedResolve = resolve;
    });

    const hangingFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      fetchStartedResolve?.();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          abortedSignals.push(true);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });

    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (msg: unknown) => {
      const m = msg as ApiRequestMessage | ApiAbortMessage;
      if (m.type === "API_ABORT") {
        handleApiAbortMessage(m);
        return { ok: true };
      }
      return handleApiRequestMessage(m, hangingFetch);
    });

    const controller = new AbortController();
    const promise = apiClient.getHealth(controller.signal);
    await fetchStarted;
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(abortedSignals).toEqual([true]);
  });

  it("maps offline fetch failures to retryable NETWORK_ERROR", async () => {
    const failingFetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (msg: unknown) => {
      return handleApiRequestMessage(msg as ApiRequestMessage, failingFetch);
    });

    try {
      await apiClient.getHealth();
      expect.unreachable("Should have thrown ApiClientError");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ApiClientError);
      const apiErr = err as ApiClientError;
      expect(apiErr.code).toBe("NETWORK_ERROR");
      expect(apiErr.retryable).toBe(true);
    }
  });

  it("fetches cross-origin manhwa images via SW and encodes bytes to base64", async () => {
    const sampleBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const fakeFetch = vi.fn(async () =>
      new Response(sampleBytes.buffer, {
        status: 200,
        headers: { "content-type": "image/png; charset=binary" },
      }),
    );

    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (msg: unknown) => {
      return handleFetchImageBase64Message(msg as FetchImageBase64Message, fakeFetch);
    });

    const result = await apiClient.fetchImageBase64("https://cdn.manhwa.test/strip1.png");
    expect(result.image_mime).toBe("image/png");
    expect(result.image_base64).toBe(arrayBufferToBase64(sampleBytes.buffer));
    expect(fakeFetch).toHaveBeenCalledWith(
      "https://cdn.manhwa.test/strip1.png",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});
