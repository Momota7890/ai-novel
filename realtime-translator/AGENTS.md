# AGENTS.md — Rules for AI Agents Working in `realtime-translator`

This file governs all AI coding agents operating inside `realtime-translator/`. Follow these rules strictly alongside the project's source-of-truth docs.

---

## 1. Project Identity & Source-of-Truth Docs

`realtime-translator` is a **100% free, local, offline-capable English → Thai real-time translator** for Chromium browsers (Chrome / Edge / Brave), tailored to:
- **Web Novels:** Bilingual inline Thai blocks rendered below each English paragraph as the user scrolls.
- **Vertical Long-Strip Manhwa / Webtoons:** Overlapping vertical slicing, YOLOv8 speech-bubble detection (dialogue & narration only, skipping painted SFX), English RapidOCR, auto-colored masks (or translucent pills for floating text), hover/`Alt+O` peek, and `Alt+S` manual snip fallback.

**Read before non-trivial work:**
- `docs/PLAN.md` — Phased milestones (Phase 0 → 3), directory layout, checklists, and risk mitigations.
- `docs/ARCHITECTURE.md` — Pipeline diagrams, vertical slicing/merging, VRAM budget, rolling context/glossary, and SQLite LRU cache design.
- `docs/API_CONTRACT.md` — Single source of truth for local HTTP endpoints (`127.0.0.1:8765`), JSON schemas, and error codes.
- `docs/SETUP.md` — Windows environment setup, `.venv`, `D:\hf_cache`, and daily launch workflow.

---

## 2. Hard Invariants (NEVER Violate)

1. **100% Free & Local Only:**
   - Never introduce paid cloud APIs, external translation services, telemetry, or Ollama dependencies.
   - Always use direct **Hugging Face `transformers`** in the unified Python FastAPI backend (`typhoon-ai/typhoon2.1-gemma3-12b` 4-bit NF4 default; swappable via config).
2. **Loopback Security & MV3 Proxy:**
   - Bind FastAPI strictly to `127.0.0.1:8765` (never `0.0.0.0`).
   - Restrict CORS to `chrome-extension://*` and `http://localhost:*`.
   - Route all extension requests to localhost and cross-origin manhwa image fetches through the **Manifest V3 Background Service Worker** (never assume content scripts can fetch cross-origin CDNs or localhost under strict page CSP).
3. **Target Hardware & Python Environment (Windows):**
   - Verified baseline: **NVIDIA RTX 5060 Ti (16 GB VRAM)**, **Python 3.11.9** with global **`torch 2.10.0+cu128`**, **Node.js v24.13.1**.
   - Always use `backend\.venv` created with `--system-site-packages` so global CUDA 12.8 PyTorch is reused. **Never** overwrite or install a CPU-only `torch` wheel inside `.venv`.
4. **OneDrive & Storage Safety:**
   - The project folder sits under `OneDrive\Desktop`. **Never** store Hugging Face model weights or SQLite databases inside the project folder or OneDrive.
   - Keep `HF_HOME=D:\hf_cache` (configurable via `.env`) and SQLite DB at `%LOCALAPPDATA%\realtime-translator\translator.db` (configurable via `CACHE_DB_PATH`).
   - **Never** store translation caches in browser storage (`chrome.storage` / `IndexedDB`) and **never** store raw image binaries in SQLite—store bounded text & normalized bounding-box JSON only (default 50 MB / 30-day LRU cap).
5. **GPU VRAM Discipline:**
   - Keep active peak VRAM safely within 16 GB (~10–12 GB peak). Keep `RapidOCR` on CPU/ONNX so it does not compete with the 12B LLM for VRAM.
   - Serialize GPU inference calls with a single async lock to prevent concurrent CUDA OOM across tabs.
   - Preserve lazy model startup, manual `/model/unload`, and automatic idle VRAM unload (default 15 minutes).
6. **Domain Behavior Invariants:**
   - **Web novels:** Non-destructive bilingual inline DOM injection (toggleable show/hide without re-translating or breaking host page layout).
   - **Manhwa:** Vertical long-strip reading order is **top-to-bottom, left-to-right** (NOT Japanese RTL). Slice tall strips (`height > 1.8 * width`) with overlap and deduplicate/merge boxes across seams. Skip painted background SFX. Always use normalized `[0.0 .. 1.0]` overlay coordinates.

---

## 3. Autonomy & Approval Boundaries (Balanced Guardrails)

### Proceed Without Asking
- Create, edit, and refactor code inside `realtime-translator/` following `docs/PLAN.md`.
- Run local verification commands: `pytest`, `npx tsc --noEmit`, `npm run build`, and lightweight unit/mock checks.
- Update completed task checkboxes in `docs/PLAN.md` after verification passes.

### MUST Ask the User First
- Installing heavy new packages or adding/changing entries in `backend/requirements.txt` or `extension/package.json`.
- Triggering downloads larger than ~1 GB (including initial ~25 GB Hugging Face weight download into `D:\hf_cache`).
- Changing endpoints, payload shapes, or error codes in `docs/API_CONTRACT.md`, or changing default `MODEL_ID` / `BUBBLE_DETECTOR_REPO`.
- Running commands that delete user data, glossaries, caches, or files outside `realtime-translator/`.
- Reading or modifying **any** file outside `realtime-translator/` (especially sibling `line-expense-bot/` or `D:\hf_cache`).

---

## 4. Coding Standards

### Backend (`backend/` — Python 3.11 + FastAPI)
- Use explicit Python type annotations on all functions, methods, and Pydantic v2 models.
- Keep architecture cleanly layered: `routers/` (HTTP & validation) → `services/` (business logic, CV/OCR, LLM, cache) → `schemas/` (contracts matching `docs/API_CONTRACT.md`).
- Return the standardized error envelope (`{ "error": { "code", "message", "retryable" } }`) for all expected error conditions (`MODEL_LOADING`, `CUDA_OOM`, `IMAGE_DECODE_ERROR`, etc.).
- Enforce structured ID-aligned JSON output for batched LLM translation so paragraph/bubble alignment never drifts, with graceful per-item fallback on parse failures.
- Preserve all four genre presets (`modern_manhwa`, `fantasy_murim`, `light_novel`, `literal`), bounded rolling context per `session_id`, and selective glossary matching (inject only matched terms + pronoun rules).

### Extension (`extension/` — TypeScript + Vite + Manifest V3)
- Enable strict TypeScript; avoid untyped `any` (use `unknown` + narrowing or explicit interfaces).
- Keep `extension/src/shared/types.ts` strictly synchronized with `docs/API_CONTRACT.md` and `backend/app/schemas/`.
- Prefix all injected DOM classes, attributes, and CSS variables with `rt-` (e.g., `.rt-thai-block`, `.rt-bubble-mask`) to prevent CSS collisions with novel and manhwa websites.
- Always cancel in-flight translation requests via `AbortController` when the user toggles off, changes chapters, or switches modes.
- Keep browser storage (`chrome.storage.local`) strictly limited to lightweight user preferences (site whitelist, typography, hotkeys, active preset).

---

## 5. Verification & Definition of Done

Before declaring any code task complete:
1. **Backend edits:** Run `.\backend\.venv\Scripts\pytest backend\tests -v` (or targeted test files for the changed modules) and verify all tests pass.
2. **Extension edits:** Run `npx tsc --noEmit` and `npm run build` inside `extension/` and verify a clean `dist/` bundle with zero TypeScript or Vite errors.
3. **Contract & Plan sync:**
   - If an API field or endpoint changed (after approval), update `docs/API_CONTRACT.md`, `backend/app/schemas/`, and `extension/src/shared/types.ts` together in the same task.
   - Check off finished items in `docs/PLAN.md` only after running verification.
4. **Honest Reporting:** Never silence, mock away, or hardcode around real CUDA, schema, OCR, or test failures. Report exact commands run and clearly separate mocked/unit checks from live GPU/browser verification.

---

## 6. Communication & Git Hygiene

- **Language:** Write all code, comments, identifiers, and technical docs in **English** (Thai text is expected inside Thai translation prompts, preset examples, and Thai UI labels where appropriate). In chat responses, reply concisely in **whatever language the user uses** (English or Thai).
- **Conciseness:** Keep explanations brief, actionable, and honest about trade-offs or risks before major changes.
- **Git Rules:** **Never** run `git commit`, `git push`, `git reset`, `git checkout --`, or any history-altering Git command unless the user explicitly asks for it.
