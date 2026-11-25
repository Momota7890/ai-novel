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

export type RenderMode = "mask" | "pill";

export interface ManhwaTranslateRequest {
  session_id: string;
  preset: PresetId;
  glossary_id?: string | null;
  bypass_cache?: boolean;
  image_id: string;
  image_base64: string;
  image_mime: string;
}

export interface ManhwaTimingsMs {
  detect: number;
  ocr: number;
  translate: number;
  total: number;
}

export interface BubbleOverlay {
  id: string;
  reading_order: number;
  bbox: [number, number, number, number];
  render_mode: RenderMode;
  bg_color: string;
  text_color: string;
  source_text: string;
  translated_text: string;
}

export interface ManhwaTranslateResponse {
  image_id: string;
  image_width: number;
  image_height: number;
  slices_processed: number;
  cached: boolean;
  timings_ms: ManhwaTimingsMs;
  bubbles: BubbleOverlay[];
}

export interface SnipTranslateRequest {
  session_id: string;
  preset: PresetId;
  glossary_id?: string | null;
  image_base64: string;
  image_mime: string;
}

export interface SnipTranslateResponse {
  source_text: string;
  translated_text: string;
  latency_ms: number;
}

export type GlossaryCategory = "name" | "skill" | "place" | "pronoun" | "term";

export interface GlossaryEntryInput {
  source_term: string;
  target_term: string;
  category: GlossaryCategory;
  note: string;
}

export interface GlossaryEntryResponse extends GlossaryEntryInput {
  id: number;
}

export interface GlossaryUpsertRequest {
  name: string;
  url_pattern: string;
  default_preset: PresetId;
  entries: GlossaryEntryInput[];
}

export interface GlossaryResponse {
  id: string;
  name: string;
  url_pattern: string;
  default_preset: PresetId;
  updated_at: number;
  entries: GlossaryEntryResponse[];
}

export interface GlossaryListResponse {
  glossaries: GlossaryResponse[];
}

export interface GlossaryDeleteResponse {
  deleted: boolean;
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

export interface FetchImageBase64Message {
  type: "FETCH_IMAGE_BASE64";
  requestId: string;
  url: string;
}

export interface FetchImageBase64Data {
  image_base64: string;
  image_mime: string;
}

export interface CaptureVisibleTabMessage {
  type: "CAPTURE_VISIBLE_TAB";
}

export interface CaptureVisibleTabData {
  dataUrl: string;
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

export type TabModeOverride = "auto" | "novel" | "manhwa";
export type ResolvedPageMode = "novel" | "manhwa";

export interface TabToggleMessage {
  type: "RT_TAB_TOGGLE";
  enabled?: boolean;
  preset?: PresetId;
  modeOverride?: TabModeOverride;
  glossaryId?: string | null;
}

export interface TabSetModeMessage {
  type: "RT_TAB_SET_MODE";
  modeOverride: TabModeOverride;
}

export interface TabSetGlossaryMessage {
  type: "RT_TAB_SET_GLOSSARY";
  glossaryId: string | null;
}

export interface TabApplyPrefsMessage {
  type: "RT_TAB_APPLY_PREFS";
}

export interface TabPeekMessage {
  type: "RT_TAB_PEEK";
  active?: boolean;
}

export interface TabSnipMessage {
  type: "RT_TAB_SNIP";
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
  | TabSetModeMessage
  | TabSetGlossaryMessage
  | TabApplyPrefsMessage
  | TabPeekMessage
  | TabSnipMessage
  | TabRetryFailedMessage
  | TabClearPageMessage;

export interface TabStateSnapshot {
  enabled: boolean;
  hidden: boolean;
  peekActive: boolean;
  hostname: string;
  url: string;
  autoEnabledSite: boolean;
  modeOverride: TabModeOverride;
  resolvedMode: ResolvedPageMode;
  preset: PresetId;
  glossaryId: string | null;
  sessionId: string;
  totalParagraphs: number;
  translatedCount: number;
  pendingCount: number;
  failedCount: number;
  totalImages: number;
  translatedImages: number;
}
