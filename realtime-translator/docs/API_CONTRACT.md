# Local API Contract — Real-Time EN→TH Translator

> **Base URL:** `http://127.0.0.1:8765`  
> **Transport:** HTTP/1.1 JSON (and `multipart/form-data` or base64 JSON for images)  
> **Security:** Localhost loopback only (`127.0.0.1`). CORS restricted to `chrome-extension://*` and `http://localhost:*` (dev). Never bound to `0.0.0.0`.

This contract is the single source of truth shared between `backend/app/schemas/` (Pydantic) and `extension/src/shared/types.ts` (TypeScript).

---

## 1. Standard Conventions & Error Format

- **Content-Type:** `application/json; charset=utf-8`
- **Coordinates (Manhwa overlays):** Normalized floating-point values `[0.0 .. 1.0]` relative to full image width/height (`bbox: [x1, y1, x2, y2]`) so overlays scale cleanly across browser zoom and responsive CSS widths.
- **Cancellation:** The extension passes `AbortSignal` on scroll/navigation changes; clients must tolerate aborted requests cleanly.
- **Error Envelope (all 4xx/5xx responses):**

```json
{
  "error": {
    "code": "MODEL_LOADING",
    "message": "Translation model is currently loading onto GPU. Retry shortly.",
    "retryable": true
  }
}
```

| Error Code | HTTP Status | Retryable | Meaning |
|---|---|---|---|
| `INVALID_REQUEST` | `400` | `false` | Malformed payload, empty input, or unsupported image format |
| `NOT_FOUND` | `404` | `false` | Glossary ID or resource does not exist |
| `IMAGE_DECODE_ERROR` | `422` | `false` | Uploaded image bytes could not be decoded by Pillow/OpenCV |
| `MODEL_LOADING` | `503` | `true` | Model is downloading/loading into VRAM (popup displays progress state) |
| `CUDA_OOM` | `503` | `true` | GPU memory exhausted; server clears cache and advises smaller batch or unloading other GPU apps |
| `TRANSLATION_ERROR` | `500` | `true` | Unexpected inference or OCR pipeline error |

---

## 2. Health, Settings & GPU Model Lifecycle

### `GET /health`
Lightweight liveness check used by the extension popup every few seconds while open.

**Response `200 OK`:**
```json
{
  "status": "ok",
  "version": "0.1.0",
  "gpu_name": "NVIDIA GeForce RTX 5060 Ti",
  "cuda_available": true
}
```

### `GET /model/status`
Returns active Hugging Face model state, VRAM usage, and idle auto-unload countdown.

**Response `200 OK`:**
```json
{
  "state": "loaded",
  "model_id": "typhoon-ai/typhoon2.1-gemma3-12b",
  "quantization": "4bit",
  "bubble_detector_loaded": true,
  "vram_allocated_mb": 9840,
  "vram_total_mb": 16311,
  "idle_seconds": 142,
  "idle_unload_minutes": 15,
  "last_error": null
}
```
> `state` enum: `"unloaded" | "loading" | "loaded" | "unloading" | "error"`

### `POST /model/load`
Explicitly pre-loads the configured Hugging Face model onto GPU (optional; translation endpoints also trigger lazy load automatically).

**Request (optional body):**
```json
{
  "model_id": "typhoon-ai/typhoon2.1-gemma3-12b",
  "load_vision": false
}
```

**Response `200 OK`:** Returns updated `/model/status` payload.

### `POST /model/unload`
Immediately unloads LLM + YOLOv8 detector from VRAM (`gc.collect()` + `torch.cuda.empty_cache()`). Triggered by the **Unload GPU** button in the extension popup.

**Response `200 OK`:**
```json
{
  "state": "unloaded",
  "vram_allocated_mb": 0,
  "vram_total_mb": 16311
}
```

### `PATCH /settings`
Updates runtime server settings without restarting `start.bat` (persisted to local runtime config).

**Request:**
```json
{
  "model_id": "typhoon-ai/typhoon2.1-gemma3-12b",
  "idle_unload_minutes": 15,
  "cache_max_mb": 50,
  "cache_ttl_days": 30
}
```
*(Changing `model_id` unloads the old model cleanly so the new model loads on next use.)*

---

## 3. Translation Endpoints

### `POST /translate/novel`
Translates a batch of English web-novel paragraphs into Thai with optional rolling context, tone preset, and per-series glossary.

**Request:**
```json
{
  "session_id": "tab-42-ch-105",
  "preset": "light_novel",
  "glossary_id": "solo-leveling",
  "bypass_cache": false,
  "paragraphs": [
    {
      "id": "p-12",
      "text": "Sung Jin-Woo stepped forward into the cold dungeon air."
    },
    {
      "id": "p-13",
      "text": "\"Arise,\" he whispered, activating Shadow Extraction."
    }
  ]
}
```
- `paragraphs`: 1 to 10 items per batch (recommended 4–6 for optimal latency/throughput).
- `glossary_id`: nullable string; if omitted, no glossary is applied.
- `bypass_cache`: when `true`, skips cache lookup (used by the user's "Retry / Re-translate" button) and updates the cache with the fresh result.

**Response `200 OK`:**
```json
{
  "model_id": "typhoon-ai/typhoon2.1-gemma3-12b",
  "preset": "light_novel",
  "latency_ms": 1840,
  "cache_hits": 1,
  "cache_misses": 1,
  "results": [
    {
      "id": "p-12",
      "translated_text": "ซองจินอูก้าวเท้าออกไปท่ามกลางอากาศหนาวเย็นภายในดันเจี้ยน",
      "cached": true
    },
    {
      "id": "p-13",
      "translated_text": "\"จงตื่น\" เขากระซิบพลางเปิดใช้งานทักษะสกัดเงา",
      "cached": false
    }
  ]
}
```

---

### `POST /translate/manhwa`
Processes a vertical long-strip manhwa/webtoon image: slices tall strips with overlap, detects dialogue & narration bubbles (skipping painted SFX), runs English OCR, classifies mask fill color vs. floating pill, and translates all bubbles in reading order (top-to-bottom, left-to-right).

**Request:**
```json
{
  "session_id": "tab-42-ch-105",
  "preset": "modern_manhwa",
  "glossary_id": "solo-leveling",
  "bypass_cache": false,
  "image_id": "img-004",
  "image_base64": "<base64-encoded PNG/JPEG/WebP>",
  "image_mime": "image/webp"
}
```
*(Note: Background service worker sends raw image bytes encoded as base64—or we may optionally accept `multipart/form-data` if preferred—and backend computes SHA-256 on raw image bytes before decoding so cache hits skip slicing, YOLO, OCR, and LLM entirely!)*

**Response `200 OK`:**
```json
{
  "image_id": "img-004",
  "image_width": 800,
  "image_height": 6400,
  "slices_processed": 5,
  "cached": false,
  "timings_ms": {
    "detect": 210,
    "ocr": 340,
    "translate": 2150,
    "total": 2740
  },
  "bubbles": [
    {
      "id": "b-0",
      "reading_order": 0,
      "bbox": [0.142, 0.031, 0.468, 0.089],
      "render_mode": "mask",
      "bg_color": "#FFFFFF",
      "text_color": "#111111",
      "source_text": "Wait... did you just clear that gate alone?",
      "translated_text": "เดี๋ยวนะ... นายเคลียร์เกตนั่นคนเดียวเลยเหรอ?"
    },
    {
      "id": "b-1",
      "reading_order": 1,
      "bbox": [0.510, 0.112, 0.890, 0.155],
      "render_mode": "pill",
      "bg_color": "rgba(18, 18, 22, 0.84)",
      "text_color": "#FFFFFF",
      "source_text": "He's not an ordinary E-rank.",
      "translated_text": "หมอนี่ไม่ใช่แรงก์ E ธรรมดาแน่ๆ"
    }
  ]
}
```
- `render_mode`:
  - `"mask"` — Clean solid-fill speech bubble or narration box (`bg_color` auto-sampled from bubble interior).
  - `"pill"` — Text sitting over detailed/high-variance colored art (rendered with subtle translucent badge).

---

### `POST /translate/snip`
Manual region-snip fallback (`Alt+S`). Accepts a cropped viewport image, skips speech-bubble filtering so any text (missed stylized bubble, `<canvas>` reader, small caption) is extracted directly via RapidOCR and translated.

**Request:**
```json
{
  "session_id": "tab-42-ch-105",
  "preset": "modern_manhwa",
  "glossary_id": "solo-leveling",
  "image_base64": "<base64-encoded PNG crop>",
  "image_mime": "image/png"
}
```

**Response `200 OK`:**
```json
{
  "source_text": "SYSTEM NOTIFICATION: Quest Completed.",
  "translated_text": "แจ้งเตือนระบบ: ภารกิจสำเร็จแล้ว",
  "latency_ms": 820
}
```

---

### `POST /session/{session_id}/reset`
Clears the in-memory rolling context buffer for a tab/chapter (called automatically by the extension when navigating to a new chapter or switching series).

**Response `200 OK`:**
```json
{
  "session_id": "tab-42-ch-105",
  "cleared": true
}
```

---

## 4. Tone Presets & Per-Series Glossaries

### `GET /presets`
Returns available built-in genre tone presets.

**Response `200 OK`:**
```json
{
  "presets": [
    {
      "id": "modern_manhwa",
      "label": "Modern Manhwa (Casual)",
      "description": "Natural contemporary Thai dialogue (ฉัน/นาย/เธอ/ผม/แก), concise bubbles"
    },
    {
      "id": "fantasy_murim",
      "label": "Fantasy / Murim / Isekai",
      "description": "Martial & fantasy Thai register (ข้า/เจ้า/ท่าน/ผู้น้อย) with skill terminology"
    },
    {
      "id": "light_novel",
      "label": "Light Novel Prose",
      "description": "Smooth literary Thai prose and narrative cadence"
    },
    {
      "id": "literal",
      "label": "Literal / Reading Aid",
      "description": "Closer to original English phrasing for checking nuance"
    }
  ]
}
```

### `GET /glossaries`
Lists all saved series glossaries.

### `POST /glossaries` & `PUT /glossaries/{id}`
Creates or updates a series glossary.

**Request:**
```json
{
  "name": "Solo Leveling",
  "url_pattern": "*asuracomic.net/*solo-leveling*",
  "default_preset": "modern_manhwa",
  "entries": [
    {
      "source_term": "Sung Jin-Woo",
      "target_term": "ซองจินอู",
      "category": "name",
      "note": "Protagonist, uses ฉัน/ผม depending on speaker"
    },
    {
      "source_term": "Shadow Extraction",
      "target_term": "สกัดเงา",
      "category": "skill",
      "note": ""
    }
  ]
}
```

### `DELETE /glossaries/{id}`
Deletes a glossary and cascades its entries. Returns `{ "deleted": true }`.

---

## 5. Server-Side SQLite LRU Cache Management

### `GET /cache/stats`
Displayed in the extension Options page so you can monitor cache usage and hit rate.

**Response `200 OK`:**
```json
{
  "db_path": "C:\\Users\\Momota.k\\AppData\\Local\\realtime-translator\\translator.db",
  "total_entries": 1420,
  "novel_entries": 1180,
  "manhwa_entries": 240,
  "size_mb": 3.42,
  "max_mb": 50,
  "ttl_days": 30,
  "session_hits": 86,
  "session_misses": 14
}
```

### `POST /cache/clear`
Clears all cached translations and compacts SQLite (`VACUUM`). Does **not** delete your saved glossaries.

**Response `200 OK`:**
```json
{
  "cleared_entries": 1420,
  "size_mb": 0.04
}
```
