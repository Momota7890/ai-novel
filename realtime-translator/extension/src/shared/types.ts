/**
 * TypeScript contract strictly synchronized with `docs/API_CONTRACT.md`
 * and `backend/app/schemas/`.
 */

export type ErrorCode =
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "IMAGE_DECODE_ERROR"
  | "MODEL_LOADING"
  | "CUDA_OOM"
  | "TRANSLATION_ERROR"
  | "NETWORK_ERROR";

export interface ErrorDetail {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface ErrorEnvelope {
  error: ErrorDetail;
}

export type ModelState = "unloaded" | "loading" | "loaded" | "unloading" | "error";

export interface HealthResponse {
  status: "ok";
  version: string;
  gpu_name: string;
  cuda_available: boolean;
}

export interface ModelStatusResponse {
  state: ModelState;
  model_id: string;
  quantization: string;
  bubble_detector_loaded: boolean;
  vram_allocated_mb: number;
  vram_total_mb: number;
  idle_seconds: number;
  idle_unload_minutes: number;
  last_error: string | null;
}

export interface ModelLoadRequest {
  model_id?: string | null;
  load_vision?: boolean;
}

export interface ModelUnloadResponse {
  state: ModelState;
  vram_allocated_mb: number;
  vram_total_mb: number;
}

export interface SettingsPatchRequest {
  model_id?: string;
  idle_unload_minutes?: number;
  cache_max_mb?: number;
  cache_ttl_days?: number;
}

export interface SettingsResponse {
  model_id: string;
  idle_unload_minutes: number;
  cache_max_mb: number;
  cache_ttl_days: number;
}

export type PresetId = "modern_manhwa" | "fantasy_murim" | "light_novel" | "literal";

export interface PresetInfo {
  id: PresetId;
  label: string;
  description: string;
}

export interface PresetsResponse {
  presets: PresetInfo[];
}

export interface ParagraphInput {
  id: string;
  text: string;
}

export interface NovelTranslateRequest {
  session_id: string;
  preset: PresetId;
  glossary_id?: string | null;
  bypass_cache?: boolean;
  paragraphs: ParagraphInput[];
}

export interface NovelParagraphResult {
  id: string;
  translated_text: string;
  cached: boolean;
}

export interface NovelTranslateResponse {
  model_id: string;
  preset: PresetId;
  latency_ms: number;
  cache_hits: number;
  cache_misses: number;
  results: NovelParagraphResult[];
}

export interface SessionResetResponse {
  session_id: string;
  cleared: boolean;
}

export interface CacheStatsResponse {
  db_path: string;
  total_entries: number;
  novel_entries: number;
  manhwa_entries: number;
  size_mb: number;
  max_mb: number;
  ttl_days: number;
  session_hits: number;
  session_misses: number;
}

export interface CacheClearResponse {
  cleared_entries: number;
  size_mb: number;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiRequestMessage {
  type: "API_REQUEST";
  requestId: string;
  path: string;
  method: HttpMethod;
  body?: unknown;
}

export interface ApiAbortMessage {
  type: "API_ABORT";
  requestId: string;
}

export interface ApiProxySuccess<T = unknown> {
  ok: true;
  status: number;
  data: T;
}

export interface ApiProxyFailure {
  ok: false;
  status: number;
  error: ErrorDetail;
}

export type ApiProxyResponse<T = unknown> = ApiProxySuccess<T> | ApiProxyFailure;

export type CommandName = "toggle-translate" | "peek-original" | "snip-region";

export interface TabCommandMessage {
  type: "RT_COMMAND";
  command: CommandName;
}

export interface TabGetStateMessage {
  type: "RT_TAB_GET_STATE";
}

export interface TabToggleMessage {
  type: "RT_TAB_TOGGLE";
  enabled?: boolean;
  preset?: PresetId;
}

export interface TabRetryFailedMessage {
  type: "RT_TAB_RETRY_FAILED";
}

export interface TabClearPageMessage {
  type: "RT_TAB_CLEAR_PAGE";
}

export type TabControlMessage =
  | TabCommandMessage
  | TabGetStateMessage
  | TabToggleMessage
  | TabRetryFailedMessage
  | TabClearPageMessage;

export interface TabStateSnapshot {
  enabled: boolean;
  hidden: boolean;
  preset: PresetId;
  sessionId: string;
  totalParagraphs: number;
  translatedCount: number;
  pendingCount: number;
  failedCount: number;
}
