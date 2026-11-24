# Windows Setup & Daily Usage Guide

This guide is tailored to your verified PC environment:
- **OS:** Windows (PowerShell)
- **GPU:** NVIDIA GeForce RTX 5060 Ti (16 GB VRAM, Driver 610.88)
- **Python:** `3.11.9` with global `torch 2.10.0+cu128` (`cuda_available=True`)
- **Node.js:** `v24.13.1` + `npm`
- **Model Cache Drive:** `D:\hf_cache` (outside `C:` and outside OneDrive)

---

## 1. One-Time Backend Setup (Python + Hugging Face)

All commands assume you are inside `c:\Users\Momota.k\OneDrive\Desktop\line_bot\realtime-translator`.

### Step 1: Create the Hugging Face cache directory on `D:`
Keeping model weights on `D:\hf_cache` prevents ~25 GB of safetensors from filling `C:` or syncing to OneDrive.

```powershell
New-Item -ItemType Directory -Force -Path "D:\hf_cache"
```

### Step 2: Create `.env` from `.env.example`
```powershell
Copy-Item .env.example .env
```

Recommended default `.env` values:
```env
# Model storage (outside C: and OneDrive)
HF_HOME=D:\hf_cache

# Default Hugging Face translation model (swappable to any HF model ID)
MODEL_ID=typhoon-ai/typhoon2.1-gemma3-12b
QUANTIZATION_MODE=4bit

# Manhwa speech-bubble detector (Hugging Face YOLOv8)
BUBBLE_DETECTOR_REPO=ogkalu/comic-speech-bubble-detector-yolov8m

# Localhost server binding (never expose externally)
SERVER_HOST=127.0.0.1
SERVER_PORT=8765

# GPU lifecycle (auto-free all 16 GB VRAM after inactivity)
IDLE_UNLOAD_MINUTES=15

# Server-side SQLite cache (stored outside OneDrive to avoid WAL lock errors)
# Leave blank to default to %LOCALAPPDATA%\realtime-translator\translator.db
CACHE_DB_PATH=
CACHE_MAX_MB=50
CACHE_TTL_DAYS=30
```

### Step 3: Create `.venv` reusing your existing PyTorch CUDA 12.8
Using `--system-site-packages` reuses your already-working `torch 2.10.0+cu128` (saving ~2.5 GB download) while isolating project libraries:

```powershell
python -m venv --system-site-packages backend\.venv
.\backend\.venv\Scripts\Activate.ps1
```

Verify PyTorch CUDA inside `.venv`:
```powershell
python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
# Expected: 2.10.0+cu128 True NVIDIA GeForce RTX 5060 Ti
```

### Step 4: Install Python dependencies
```powershell
pip install -r backend\requirements.txt
```

> **Note on `bitsandbytes` (4-bit quantization):** We verify 4-bit NF4 loading on your RTX 5060 Ti in Phase 0.4. If `bitsandbytes` ever has a CUDA 12.8 wheel mismatch, you can switch `QUANTIZATION_MODE=bf16` with `MODEL_ID=typhoon-ai/typhoon2.1-gemma3-4b` (~8.5 GB VRAM, zero quantization library required) while we pin the right wheel.

---

## 2. One-Time Extension Build (TypeScript + Vite)

```powershell
cd extension
npm install
npm run build
```

This outputs the ready-to-load Chromium Manifest V3 bundle into `extension\dist\`.

### Load Unpacked in Chrome / Edge / Brave
1. Open `chrome://extensions` (or `edge://extensions` / `brave://extensions`).
2. Turn ON **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select `c:\Users\Momota.k\OneDrive\Desktop\line_bot\realtime-translator\extension\dist`.
5. Pin the extension icon to your browser toolbar for quick access.

*(After editing extension code during development, run `npm run build` in `extension/` and click the Reload icon on the extension card.)*

---

## 3. Daily Usage (`start.bat`)

1. Double-click **`start.bat`** in `realtime-translator\`.
   - Activates `backend\.venv`.
   - Loads `.env` (`HF_HOME=D:\hf_cache`).
   - Starts FastAPI on `http://127.0.0.1:8765` in ~2 seconds (0 GB VRAM until your first translation).
2. Open any English web novel or vertical long-strip manhwa site.
3. Click the extension icon or press **`Alt+T`** to start translating (or toggle **"Always enable on this site"** so future chapters translate automatically).

### First-Run Model Download Notice
- The **very first time** you trigger a translation (or click **Load Model**), Hugging Face will download `typhoon-ai/typhoon2.1-gemma3-12b` (~24–25 GB) plus the YOLOv8 bubble detector (~50 MB) and RapidOCR English weights (~15 MB) into `D:\hf_cache`.
- Download progress prints live in the `start.bat` console window.
- Every launch after that is **100% offline** and loads directly from `D:\hf_cache` in ~10–20 seconds.

### Default Keyboard Shortcuts
| Shortcut | Action |
|---|---|
| `Alt + T` | Toggle translation On / Off for the current tab |
| `Alt + O` (hold or toggle) | Peek at original English text underneath manhwa bubble masks |
| `Alt + S` | Activate manual region-snip box (drag over any missed bubble or `<canvas>` panel) |

*(Shortcuts can be customized anytime at `chrome://extensions/shortcuts`.)*

### Freeing GPU VRAM for Games / Other Apps
- **Automatic:** After **15 minutes** without a translation request (configurable in Options), the server automatically unloads the model and calls `torch.cuda.empty_cache()`, returning all 16 GB VRAM.
- **Manual:** Click **Unload GPU Now** inside the extension popup at any time—or simply close the `start.bat` window.

---

## 4. Verification & Benchmarks

### Run Automated Backend Tests (`pytest`)
```powershell
.\backend\.venv\Scripts\pytest backend\tests -v
```

### Run Local Latency & VRAM Benchmarks
```powershell
# Phase 1: Web novel batch latency, Thai output quality, cache speed & peak VRAM
.\backend\.venv\Scripts\python backend\benchmarks\bench_novel.py

# Phase 2: Vertical manhwa strip slicing, bubble detection, RapidOCR & end-to-end latency
.\backend\.venv\Scripts\python backend\benchmarks\bench_manhwa.py --image path\to\sample_strip.jpg
```

---

## 5. Windows Troubleshooting

| Issue | Likely Cause | Fix |
|---|---|---|
| **Popup says "Server Offline"** | `start.bat` isn't running or port `8765` is in use | Run `start.bat`; check if another app uses port `8765` and update `SERVER_PORT` in `.env` + Options |
| **SQLite `database is locked`** | DB path accidentally placed inside OneDrive | Keep `CACHE_DB_PATH` outside OneDrive (default `%LOCALAPPDATA%\realtime-translator\translator.db`) |
| **Slow OneDrive sync notifications** | `.venv/` or `extension/node_modules/` syncing thousands of small files | Pause/exclude `.venv` and `node_modules` or move project folder outside OneDrive if desired later |
| **Gated Hugging Face model error (`401` / `403`)** | You switched `MODEL_ID` to a gated repo (e.g., official `google/gemma-3-*`) | Default `typhoon-ai/typhoon2.1-gemma3-12b` works without gating; for gated models, add `HF_TOKEN=hf_...` in `.env` |
| **Manhwa site renders panels in `<canvas>` or blocks image fetch** | Site anti-scraping/DRM prevents direct `<img>` pixel reads | Extension falls back to viewport capture; for stubborn panels, press `Alt+S` and drag the snip box directly over the bubble |
| **Out of VRAM (`CUDA_OOM`)** | Another GPU-heavy app/game is using VRAM simultaneously | Close GPU-heavy apps, click **Unload GPU Now**, or switch `MODEL_ID` to `typhoon-ai/typhoon2.1-gemma3-4b` (~8.5 GB BF16 or ~4 GB 4-bit) |
