"""Phase 2 live benchmark: vertical manhwa strip slicing, YOLOv8 bubble detection, CPU RapidOCR & LLM.

Usage:
    .\\realtime-translator\\backend\\.venv\\Scripts\\python.exe realtime-translator\\backend\\benchmarks\\bench_manhwa.py --image path\\to\\strip.jpg
    (Omit --image to run against a generated synthetic 800x3600 test strip.)
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import io
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.config import Settings
from app.schemas.manhwa import ManhwaTranslateRequest
from app.services.bubble_detector import BubbleDetector
from app.services.cache_store import CacheStore
from app.services.manhwa_pipeline import ManhwaPipeline
from app.services.model_manager import ModelManager
from app.services.ocr_engine import OcrEngine
from app.services.prompt_builder import SessionContextStore
from app.services.translator import TranslatorService


def _build_synthetic_strip_bytes() -> bytes:
    img = Image.new("RGB", (800, 3600), color=(42, 46, 58))
    draw = ImageDraw.Draw(img)
    bubbles = [
        ((80, 180, 420, 380), "WAIT... DID YOU CLEAR\nTHAT GATE ALONE?"),
        ((380, 1280, 740, 1480), "HE IS NOT AN ORDINARY\nE-RANK HUNTER!"),
        ((100, 2600, 520, 2820), "LET'S FINISH THIS\nBEFORE NIGHTFALL."),
    ]
    for (x1, y1, x2, y2), text in bubbles:
        draw.rounded_rectangle([x1, y1, x2, y2], radius=36, fill=(255, 255, 255), outline=(15, 15, 15), width=4)
        draw.multiline_text((x1 + 28, y1 + 52), text, fill=(15, 15, 15))

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


async def run_benchmark(image_path: str | None) -> None:
    settings = Settings()
    settings.apply_runtime_overrides()
    os.environ["HF_HOME"] = settings.hf_home

    if image_path:
        raw_bytes = Path(image_path).read_bytes()
        mime = "image/jpeg" if image_path.lower().endswith((".jpg", ".jpeg")) else "image/png"
    else:
        raw_bytes = _build_synthetic_strip_bytes()
        mime = "image/png"

    b64 = base64.b64encode(raw_bytes).decode("ascii")

    with tempfile.TemporaryDirectory() as tmpdir:
        cache = CacheStore(db_path=Path(tmpdir) / "bench_manhwa.db")
        manager = ModelManager(settings)
        context = SessionContextStore()
        translator = TranslatorService(manager, context)
        detector = BubbleDetector(repo_id=settings.bubble_detector_repo, hf_home=settings.hf_home)
        ocr = OcrEngine()
        pipeline = ManhwaPipeline(
            cache_store=cache,
            model_manager=manager,
            translator=translator,
            bubble_detector=detector,
            ocr_engine=ocr,
        )

        try:
            if torch.cuda.is_available():
                torch.cuda.init()
                torch.cuda.reset_peak_memory_stats(0)

            req = ManhwaTranslateRequest(
                session_id="bench-manhwa",
                preset="modern_manhwa",
                image_id="sample-strip",
                image_base64=b64,
                image_mime=mime,
            )
            resp = await pipeline.translate_manhwa(req)
            cached_resp = await pipeline.translate_manhwa(req)

            peak_vram_gb = (
                torch.cuda.max_memory_allocated(0) / (1024**3)
                if torch.cuda.is_available()
                else 0.0
            )

            print("=== Phase 2 Manhwa Benchmark Summary ===")
            print(f"Image size: {resp.image_width}x{resp.image_height} | Slices: {resp.slices_processed}")
            print(f"Bubbles translated: {len(resp.bubbles)}")
            print(
                f"Cold timings (ms): detect={resp.timings_ms.detect}, "
                f"ocr={resp.timings_ms.ocr}, translate={resp.timings_ms.translate}, "
                f"total={resp.timings_ms.total}"
            )
            print(f"Cache hit total: {cached_resp.timings_ms.total} ms (cached={cached_resp.cached})")
            print(f"Peak VRAM allocated: {peak_vram_gb:.2f} GB (target < 13.5 GB)")
            for bubble in resp.bubbles:
                print(
                    f"  [{bubble.id} #{bubble.reading_order} {bubble.render_mode} {bubble.bg_color}] "
                    f"{bubble.source_text} -> {bubble.translated_text}"
                )
        finally:
            await manager.unload()
            cache.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Benchmark vertical manhwa strip translation.")
    parser.add_argument("--image", default=None, help="Optional path to a vertical manhwa strip image.")
    args = parser.parse_args()
    asyncio.run(run_benchmark(args.image))
