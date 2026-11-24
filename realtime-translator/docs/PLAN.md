# Working Implementation Plan — Real-Time EN→TH Novel & Manhwa Translator

> **Goal:** Build a 100% free, local, offline-capable real-time English-to-Thai translator for **PC web browsers (Chrome / Edge / Brave)** tailored to **web novels** (bilingual inline paragraphs) and **vertical long-strip manhwa / webtoons** (automatic on-image speech bubble overlays), powered directly by **Hugging Face `transformers`** on your **NVIDIA RTX 5060 Ti (16 GB VRAM)**.

Related docs in this folder:
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — System design, data flows, vertical strip slicing, VRAM budget, SQLite LRU cache, and context/glossary design
- [`API_CONTRACT.md`](./API_CONTRACT.md) — Local FastAPI REST endpoints (`127.0.0.1:8765`), JSON schemas, error codes, and security boundaries
- [`SETUP.md`](./SETUP.md) — Windows environment setup, `.venv --system-site-packages`, `HF_HOME=D:\hf_cache`, `start.bat`, and loading the extension unpacked

---

## 1. Locked-In Decisions Summary

| Area | Decision |
|---|---|
| **Platform** | Chromium Manifest V3 Browser Extension (**TypeScript + Vite**) + Local Python FastAPI server |
| **Runtime & Hardware** | Direct Hugging Face `transformers` on existing **Python 3.11.9 + PyTorch 2.10.0+cu128** (RTX 5060 Ti 16 GB VRAM); no Ollama required |
| **Python Environment** | Local `.venv` with `--system-site-packages` (reuses global CUDA 12.8 PyTorch, isolates project packages) |
| **Model Storage** | `HF_HOME=D:\hf_cache` (keeps ~25 GB weights off `C:` and outside OneDrive) |
| **Default Translation LLM** | `typhoon-ai/typhoon2.1-gemma3-12b` (4-bit NF4 via `bitsandbytes`, ~9–11 GB VRAM; configurable to any HF model ID) |
| **Web Novel UX** | **Bilingual inline** — Thai block injected directly below each English paragraph as you scroll (toggleable + pre-fetching) |
| **Manhwa / Webtoon UX** | **Vertical long-strip only** — overlapping vertical slicing, **top-to-bottom / left-to-right** order, YOLOv8 bubble detector + English OCR (`RapidOCR`), dialogue & narration only (skip painted SFX), auto-colored solid mask (translucent pill for floating text), hover/hotkey peek at original |
| **Quality & Consistency** | Genre tone presets + automatic rolling context + optional editable per-series Glossary (names, skills, pronouns) |
| **Activation & Extras** | Manual toggle/hotkey + per-site "Auto-enable" whitelist (auto-detects Novel vs. Manhwa with 1-click override), manual snip-box fallback, Thai font/size controls |
| **Caching** | Bounded **server-side SQLite LRU cache** (stored outside OneDrive in `%LOCALAPPDATA%\realtime-translator\translator.db`, text & box JSON only — never images; default 50 MB / 30 days + 1-click Clear Cache) |
| **Server & GPU Lifecycle** | One-click `start.bat` + live server/VRAM status & manual Unload button in popup + **auto-unload GPU model after 15 min idle** |
| **Verification** | `pytest` unit/API tests + local latency/VRAM sample benchmark + per-phase Chrome/Edge manual verification checklist |

---

## 2. Target Project Directory Layout

```text
realtime-translator/
├── docs/
│   ├── PLAN.md                      # This working plan & task tracker
│   ├── ARCHITECTURE.md              # Pipeline diagrams, VRAM & cache design
│   ├── API_CONTRACT.md              # Local HTTP API schemas & contracts
│   └── SETUP.md                     # Windows install, launch & troubleshooting
├── backend/
│   ├── app/
│   │   ├── main.py                  # FastAPI entrypoint, CORS, lifespan & idle watcher
│   │   ├── config.py                # Pydantic settings loaded from .env
│   │   ├── schemas/                 # Request/response Pydantic models
│   │   │   ├── translation.py
│   │   │   ├── manhwa.py
│   │   │   ├── glossary.py
│   │   │   └── system.py
│   │   ├── services/
│   │   │   ├── model_manager.py     # Lazy HF loader, 4-bit config, VRAM stats, idle auto-unload
│   │   │   ├── prompt_builder.py    # Tone presets, rolling context window & glossary injection
│   │   │   ├── translator.py        # Batched EN->TH generation & response parsing
│   │   │   ├── strip_slicer.py      # Vertical long-strip overlapping slicer & box merger
│   │   │   ├── bubble_detector.py   # HF YOLOv8 speech-bubble detection + interior color sampler
│   │   │   ├── ocr_engine.py        # RapidOCR English text extraction & bubble grouping
│   │   │   ├── manhwa_pipeline.py   # End-to-end slice -> detect -> OCR -> translate orchestrator
│   │   │   ├── cache_store.py       # Bounded SQLite LRU cache (TTL + MB cap + stats/clear)
│   │   │   └── glossary_store.py    # SQLite persistence for per-series glossaries & site profiles
│   │   └── routers/
│   │       ├── health.py            # /health, /model/status, /model/load, /model/unload
│   │       ├── translate.py         # /translate/novel, /translate/manhwa, /translate/snip
│   │       ├── glossary.py          # /glossaries CRUD + /presets
│   │       └── cache.py             # /cache/stats, /cache/clear
│   ├── tests/
│   │   ├── test_cache_store.py      # LRU eviction, TTL expiry, size cap, key hashing
│   │   ├── test_strip_slicer.py     # Overlap slicing, cross-tile NMS merge, reading order
│   │   ├── test_prompt_builder.py   # Genre presets, rolling context trimming, glossary rules
│   │   ├── test_api_routes.py       # FastAPI contract tests with mocked model manager
│   │   └── test_model_lifecycle.py  # Lazy load, idle auto-unload, manual unload lock safety
│   ├── benchmarks/
│   │   ├── bench_novel.py           # Novel batch latency, tokens/sec, peak VRAM, Thai output check
│   │   └── bench_manhwa.py          # Manhwa slice detection, OCR, end-to-end latency & VRAM check
│   └── requirements.txt
├── extension/
│   ├── manifest.json                # Chromium Manifest V3
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts               # Multi-entry build -> dist/
│   ├── src/
│   │   ├── shared/
│   │   │   ├── types.ts             # Mirrors API_CONTRACT.md schemas
│   │   │   ├── apiClient.ts         # Background-routed HTTP calls + abort/retry handling
│   │   │   ├── storage.ts           # Per-site auto-enable whitelist & typography settings
│   │   │   └── detector.ts          # Heuristic page mode detector (Novel vs. Manhwa)
│   │   ├── background/
│   │   │   └── serviceWorker.ts     # Fetches cross-origin manhwa images, proxies localhost API, hotkeys
│   │   ├── content/
│   │   │   ├── index.ts             # Mode coordinator, activation toggle, hotkey listener
│   │   │   ├── novel/
│   │   │   │   ├── extractor.ts     # Main article/chapter paragraph extractor
│   │   │   │   ├── renderer.ts      # Bilingual inline Thai block injector & toggle
│   │   │   │   └── scheduler.ts     # IntersectionObserver visible-first + pre-fetch queue
│   │   │   ├── manhwa/
│   │   │   │   ├── imageScanner.ts  # Finds tall vertical strip <img> elements & scroll visibility
│   │   │   │   ├── overlay.ts       # Auto-colored bubble masks, floating pills, Thai auto-fit, peek
│   │   │   │   └── snipTool.ts      # Manual Alt+S drag-box region capture & floating popup
│   │   │   └── styles/
│   │   │       └── overlay.css      # Scoped CSS variables for Thai font, size, opacity, peek
│   │   ├── popup/                   # Toolbar popup: Toggle, Mode switch, Preset, Server/VRAM, Unload
│   │   └── options/                 # Glossary Manager, Site Whitelist, Model ID, Cache & Typography UI
│   └── dist/                        # Built extension output (Load Unpacked in Chrome/Edge)
├── .env.example
├── .gitignore
└── start.bat                        # One-click Windows launcher
```

---

## 3. Phased Implementation Plan

### Phase 0 — Workspace Bootstrap & Environment Verification
**Objective:** Create project scaffolding, verify `.venv --system-site-packages` with PyTorch CUDA 12.8, verify `D:\hf_cache`, and establish clean dev/test tooling.

- [ ] **0.1** Initialize `realtime-translator/` directory layout, `.gitignore` (excluding `.venv/`, `node_modules/`, `dist/`, `.env`, `*.db`), and `.env.example`.
- [ ] **0.2** Create Python virtual environment with `python -m venv --system-site-packages backend\.venv` and confirm `torch.cuda.is_available() == True` on RTX 5060 Ti.
- [ ] **0.3** Install backend dependencies (`fastapi`, `uvicorn`, `pydantic-settings`, `transformers`, `accelerate`, `bitsandbytes`, `huggingface-hub`, `pillow`, `numpy`, `pytest`, `httpx`).
- [ ] **0.4** Verify `D:\hf_cache` write access and test `bitsandbytes` 4-bit NF4 load compatibility on CUDA 12.8 (with documented fallback check if a wheel version pin is needed).
- [ ] **0.5** Initialize `extension/` with `package.json`, `tsconfig.json`, `vite.config.ts`, and `manifest.json` producing a minimal loadable `dist/`.

**Phase 0 Definition of Done:**
- `backend\.venv\Scripts\python.exe` imports `torch` (CUDA True), `transformers`, `bitsandbytes`, and `fastapi` with zero errors.
- `npm run build` in `extension/` outputs a valid Manifest V3 `dist/` that loads cleanly in Chrome/Edge.

---

### Phase 1 — Backend Core + Web Novel Bilingual MVP
**Objective:** Deliver a working end-to-end **Web Novel bilingual inline translator** backed by `typhoon-ai/typhoon2.1-gemma3-12b` (4-bit) and the bounded SQLite LRU cache.

#### Backend Tasks
- [ ] **1.1** Implement `config.py` (`HF_HOME`, `MODEL_ID`, `SERVER_HOST=127.0.0.1`, `SERVER_PORT=8765`, `CACHE_DB_PATH`, `CACHE_MAX_MB=50`, `CACHE_TTL_DAYS=30`, `IDLE_UNLOAD_MINUTES=15`).
- [ ] **1.2** Implement `cache_store.py`: SQLite (WAL mode) keyed by SHA-256 of `(mode, normalized_input, model_id, preset, glossary_hash)` with automatic LRU eviction when DB exceeds `CACHE_MAX_MB` or entry exceeds `CACHE_TTL_DAYS`, plus `/cache/stats` and `/cache/clear`.
- [ ] **1.3** Implement `model_manager.py`: lazy-loading `typhoon-ai/typhoon2.1-gemma3-12b` in 4-bit NF4 (`bnb_4bit_compute_dtype=torch.bfloat16`), async request serialization lock (prevents GPU OOM on concurrent tabs), VRAM reporting (`torch.cuda.memory_allocated` / `nvidia-smi`), and `/health`, `/model/status`, `/model/load`, `/model/unload`.
- [ ] **1.4** Implement `translator.py` + basic `prompt_builder.py`: batch 3–6 novel paragraphs per GPU forward pass using structured numbered JSON output so paragraph alignment never drifts, with graceful per-paragraph fallback if JSON parsing fails.
- [ ] **1.5** Implement `/translate/novel` endpoint with cache lookup → GPU batch translation → cache write.

#### Extension Tasks
- [ ] **1.6** Implement `background/serviceWorker.ts`: localhost API proxy (avoids Mixed Content / site CSP blocks on HTTPS novel sites), extension state messaging, and `Alt+T` toggle command.
- [ ] **1.7** Implement `content/novel/extractor.ts`: detect primary chapter text container (filters navbars, sidebars, comments, ads) and tag translatable paragraphs cleanly.
- [ ] **1.8** Implement `content/novel/scheduler.ts`: `IntersectionObserver` translating visible paragraphs immediately, queuing the next 1–2 viewport heights as background pre-fetch, cancelling stale requests on navigation.
- [ ] **1.9** Implement `content/novel/renderer.ts`: inject bilingual Thai blocks directly beneath each English paragraph with subtle loading shimmer, error retry pill, and instant toggle on/off (`show/hide` without re-translating).
- [ ] **1.10** Implement minimal `popup/` UI: On/Off toggle, server connection indicator, model loaded/unloaded status, and quick Clear Page / Retry actions.

#### Phase 1 Verification
- [ ] **Automated (`pytest`):** `test_cache_store.py` (hit/miss, LRU cap enforcement, TTL expiry, clear) and `test_api_routes.py` (`/health`, `/translate/novel` mocked + batch alignment).
- [ ] **Benchmark (`benchmarks/bench_novel.py`):** Translate 20 real English web-novel paragraphs; verify Thai naturalness, steady-state latency (< 4s per 4-paragraph batch), cache hit (< 10ms), and peak VRAM (< 12.5 GB).
- [ ] **Chrome/Edge Manual Checklist:**
  - Load `extension/dist` unpacked; open an English web novel chapter.
  - Press `Alt+T` → visible paragraphs render Thai below English without shifting/breaking site CSS.
  - Scroll down → pre-fetched paragraphs appear with minimal wait; scroll back up → instant from SQLite cache.
  - Toggle off/on → Thai blocks hide/show cleanly without duplicate injection.

---

### Phase 2 — Vertical Long-Strip Manhwa Pipeline, Bubble Overlay & Manual Snip
**Objective:** Deliver real-time **on-image bubble translation** optimized specifically for **vertical long-strip manhwa / webtoons**, plus the **manual region-snip fallback**.

#### Backend Tasks
- [ ] **2.1** Install Phase 2 CV/OCR packages into `.venv` (`ultralytics`, `rapidocr-onnxruntime`, `opencv-python-headless`) and verify Hugging Face download of `ogkalu/comic-speech-bubble-detector-yolov8m` into `D:\hf_cache`.
- [ ] **2.2** Implement `strip_slicer.py`:
  - Detect tall vertical strips (`height > 1.8 * width`) and split into overlapping horizontal slices (default slice height `1400px`, overlap `250px`).
  - Run cross-tile deduplication / IoU merging so bubbles straddling a slice boundary are never duplicated or cut in half.
  - Sort final bubbles in **manhwa reading order: top-to-bottom, then left-to-right** (grouping vertically proximate bubbles into rows).
- [ ] **2.3** Implement `bubble_detector.py`:
  - Run YOLOv8 speech-bubble detector (dialogue bubbles + narration boxes only; naturally skips painted background SFX).
  - Compute each bubble's **mask style**: sample perimeter/interior pixel variance to classify clean solid-fill bubbles (white/black/tinted — return exact `bg_color` + high-contrast `text_color`) vs. high-variance/floating text (return `render_mode: "pill"` for subtle semi-transparent badge).
- [ ] **2.4** Implement `ocr_engine.py`:
  - Run `RapidOCR` (English ONNX on CPU/ORT — 0 GPU VRAM contention with Typhoon 12B) on padded bubble crops.
  - Merge multi-line OCR segments within each bubble into clean single English sentences (de-hyphenating wrapped words, normalizing ALL-CAPS comic lettering cleanly so the LLM translates tone naturally instead of shouting everything).
  - Drop empty/noise/SFX-only false positives (e.g., 1–2 non-word symbols).
- [ ] **2.5** Implement `manhwa_pipeline.py` & `/translate/manhwa` + `/translate/snip`:
  - Hash image bytes/slice region for SQLite cache lookup (stores ONLY tiny bubble bounding boxes + English/Thai JSON — never image binaries).
  - Batch all bubbles in a strip/viewport slice into a single Typhoon 12B call with conversational order so replies match previous bubbles.
  - `/translate/snip`: accept a cropped region PNG/WebP from the manual snip tool, run OCR directly (skipping bubble filter so even stylized/canvas/outside-bubble text always translates!) + translate to Thai.

#### Extension Tasks
- [ ] **2.6** Implement `background/serviceWorker.ts` image fetcher: download `<img>` bytes via background fetch with page cookies/Referer (bypassing canvas taint / CDN CORS restrictions), falling back to `chrome.tabs.captureVisibleTab` crop when an image is rendered inside `<canvas>` or blob-protected readers.
- [ ] **2.7** Implement `content/manhwa/imageScanner.ts`:
  - Detect tall vertical strip images (`naturalWidth >= 400`, vertical stack container).
  - Use `IntersectionObserver` with generous rootMargin (`+1500px` below viewport) to pre-fetch the next 1–2 vertical panels/slices ahead of scroll.
  - Handle responsive resize / zoom seamlessly using normalized `[0..1]` overlay coordinates relative to each image's rendered bounding box.
- [ ] **2.8** Implement `content/manhwa/overlay.ts`:
  - Attach a lightweight pointer-pass-through overlay container anchored to each strip image.
  - Render **auto-colored rounded masks** for dialogue/narration bubbles and **subtle translucent pills** for floating text.
  - Implement binary-search Thai typography auto-fit (`word-break: keep-all` / Thai line-break friendly wrapping with `Intl.Segmenter('th')` support where helpful) so Thai text never overflows bubble edges.
  - Implement **instant peek**: hover over any bubble (or hold configurable hotkey `Alt+O`) to fade the mask to `opacity: 0` and reveal original English immediately.
- [ ] **2.9** Implement `content/manhwa/snipTool.ts`:
  - Press `Alt+S` (or click "Snip Region" in popup) → translucent crosshair overlay → drag rectangle over any missed bubble or `<canvas>` → captures exact crop via `captureVisibleTab` → calls `/translate/snip` → displays draggable/dismissible Thai result card right next to the selection.

#### Phase 2 Verification
- [ ] **Automated (`pytest`):** `test_strip_slicer.py` (overlap split, cross-boundary box merge, LTR top-to-bottom sorting) and `test_api_routes.py` (`/translate/manhwa` and `/translate/snip` contracts).
- [ ] **Benchmark (`benchmarks/bench_manhwa.py`):** Run against a sample vertical manhwa strip (e.g., 800×4000px); verify slice count, bubble detection recall, English OCR accuracy, total latency (< 5s per viewport slice), and combined peak VRAM (< 13.5 GB).
- [ ] **Chrome/Edge Manual Checklist:**
  - Open a vertical long-strip manhwa chapter in Chrome/Edge and toggle on.
  - Verify dialogue/narration bubbles are cleanly masked with matching fill color and readable auto-fitted Thai; verify painted background SFX is untouched.
  - Hover a bubble and hold `Alt+O` → original English peeks cleanly.
  - Scroll quickly → upcoming strips pre-fetch smoothly; scroll back → instant cache hit.
  - Press `Alt+S` and drag over a missed/canvas bubble → floating Thai card appears accurately.

---

### Phase 3 — Tone Presets, Rolling Context, Glossary, Whitelist, Typography & VRAM Lifecycle
**Objective:** Elevate Thai translation consistency to chapter-grade quality and add all daily-driver ergonomics.

#### Backend Tasks
- [ ] **3.1** Implement full `prompt_builder.py` with 4 built-in **Genre Tone Presets**:
  - `modern_manhwa` — Casual contemporary Thai dialogue (*ฉัน/นาย/เธอ/ผม/แก/พี่/น้อง*), punchy short bubbles.
  - `fantasy_murim` — Fantasy / Isekai / Murim / Regression register (*ข้า/เจ้า/ท่าน/ผู้น้อย/ศิษย์พี่/วิชายุทธ์*).
  - `light_novel` — Smooth literary Thai novel prose with natural narrative cadence.
  - `literal` — Faithful closer-to-source Thai for checking English phrasing.
- [ ] **3.2** Implement **automatic rolling context**: in-memory per-`session_id` ring buffer storing the last 6–10 translated EN/TH pairs (bounded by token budget ~600 tokens) passed as prior context so character pronouns and ongoing conversations stay consistent across scrolls and consecutive strips. Include `/session/{session_id}/reset` when changing chapters.
- [ ] **3.3** Implement `glossary_store.py` + `/glossaries` CRUD endpoints:
  - Per-series / per-URL-pattern glossary records (`series_key`, `default_preset`, `entries: [{source, target, category, note}]`).
  - Smart prompt filtering: only inject glossary entries whose `source` term actually appears (case-insensitive) in the current batch or recent context, saving prompt tokens and preventing hallucinated overrides.
- [ ] **3.4** Implement **automatic idle GPU unload** in `model_manager.py`:
  - Background async watchdog checks `last_used_at` every 30s.
  - After `IDLE_UNLOAD_MINUTES` (default 15, configurable), deletes model references, runs `gc.collect()` + `torch.cuda.empty_cache()`, freeing all ~10–11 GB VRAM for games/apps.
  - Next translation request transparently reloads the model (extension shows "Loading model onto GPU..." toast during cold reload).
- [ ] **3.5** Write `start.bat`: checks `.venv`, sets `HF_HOME=D:\hf_cache` (or `.env`), starts `uvicorn app.main:app --host 127.0.0.1 --port 8765`, prints clear status URL and troubleshooting hints.

#### Extension Tasks
- [ ] **3.6** Implement `shared/detector.ts` + **Per-site Auto-enable Whitelist**:
  - Auto-detects page mode (`novel` vs. `manhwa`) via DOM heuristics (tall stacked images vs. high paragraph word-density).
  - Popup includes **"Always enable on this site"** toggle + **1-click Novel / Manhwa mode override** persisted per hostname.
- [ ] **3.7** Upgrade `popup/` UI:
  - Master Enable toggle (`Alt+T`), Mode selector (`Auto / Novel / Manhwa`), Active Tone Preset dropdown, Active Series Glossary selector, Manual Snip (`Alt+S`), Peek Original (`Alt+O`), live Server/GPU/VRAM badge, and **Unload GPU Now** button.
- [ ] **3.8** Build `options/` full settings page:
  - **Glossary Manager:** create/edit/delete series glossaries, bind URL pattern/domain, add/import/export CSV/JSON term rows (`source`, `target`, `pronoun/name/skill` note).
  - **Typography & Overlay Controls:** Thai font picker (`Sarabun`, `Prompt`, `Noto Sans Thai`, system default), novel font size/color/line-height, manhwa mask opacity & font scale, peek hotkey config.
  - **Model & Cache Controls:** view/change Hugging Face `MODEL_ID`, set idle unload timeout (minutes), view SQLite cache size/hit rate, configure max MB / TTL days, **Clear Cache** button.

#### Phase 3 Verification
- [ ] **Automated (`pytest`):** `test_prompt_builder.py` (all 4 presets, selective glossary matching, context truncation) and `test_model_lifecycle.py` (idle timeout triggers unload + CUDA cache clear; concurrent request during reload waits cleanly).
- [ ] **Chrome/Edge Manual Checklist:**
  - Switch preset from `modern_manhwa` to `fantasy_murim` and re-translate → pronouns shift cleanly (*ฉัน/นาย* → *ข้า/เจ้า*).
  - Add a character name & skill to a series glossary → verify exact Thai rendering across both novel paragraphs and manhwa bubbles.
  - Enable "Always on this site", navigate to next chapter → translates automatically with zero clicks.
  - Click **Unload GPU Now** (and test short 1-min idle timeout) → confirm via `nvidia-smi` that VRAM drops back to baseline, then translate a paragraph and confirm seamless auto-reload.
  - Double-click `start.bat` from Explorer → server launches cleanly and popup turns green.

---

## 4. Key Engineering Risks & Mitigations

| Risk | Impact | Planned Mitigation |
|---|---|---|
| **Windows + CUDA 12.8 `bitsandbytes` wheel mismatch** | 4-bit quantization fails on RTX 5060 Ti (`sm_120`) | Test `bitsandbytes` in Phase 0.4 before writing full code. Keep `QUANTIZATION_MODE` configurable (`4bit` default, `8bit` / `bf16` fallback for 4B models like `typhoon2.1-gemma3-4b` if needed). |
| **OneDrive sync locks on SQLite / `.venv`** | SQLite `database is locked` errors or slow OneDrive syncing | Store SQLite DB outside OneDrive (`%LOCALAPPDATA%\realtime-translator\translator.db`), store HF weights at `D:\hf_cache`, and document excluding `.venv/` & `node_modules/` from OneDrive sync if lag occurs. |
| **Manhwa CDN CORS / Hotlink / `<canvas>` protection** | Content script cannot read image pixels directly | Fetch image bytes via Manifest V3 Background Service Worker with site cookies/Referer first; fall back to `captureVisibleTab` viewport crop or `Alt+S` manual snip. |
| **Speech bubbles split across vertical slice boundaries** | Duplicate or half-read bubbles in tall webtoons | Use 250px vertical overlap between slices + IoU/containment box merging before OCR. |
| **Thai text overflowing small speech bubbles** | Clipped or unreadable overlays | Binary-search font sizing (`10px–22px`) inside padded bubble box + Thai-aware wrapping (`Intl.Segmenter`) + hover expand/peek fallback for tiny bubbles. |
| **LLM outputs drifted JSON / wrong paragraph count** | Misaligned bilingual paragraphs or bubbles | Enforce strict numbered-ID JSON schema in prompt, validate exact ID match on backend, and automatically retry/split only mismatched items. |
| **First-run 25 GB Hugging Face download surprise** | User thinks server froze during startup | Stream download progress clearly in `start.bat` console and show `"Downloading / Loading model..."` state in extension popup `/model/status`. |

---

## 5. Immediate Next Step

Once you review these 4 working docs and confirm you're ready, we start **Phase 0** (bootstrap `realtime-translator/`, create `.venv --system-site-packages`, verify `bitsandbytes` 4-bit on your RTX 5060 Ti, and scaffold the Vite TypeScript extension).
