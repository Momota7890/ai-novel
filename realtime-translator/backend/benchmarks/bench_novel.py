"""Phase 1 live GPU benchmark: 20 web-novel paragraphs latency, cache speed, and peak VRAM.

Usage (requires prior user approval for initial ~25 GB HF download into D:\\hf_cache):
    .\\realtime-translator\\backend\\.venv\\Scripts\\python.exe realtime-translator\\backend\\benchmarks\\bench_novel.py
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

import torch

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.config import Settings
from app.services.cache_store import CacheStore, compute_cache_key, compute_content_hash
from app.services.model_manager import ModelManager
from app.services.prompt_builder import PromptItem, SessionContextStore
from app.services.translator import TranslatorService

SAMPLE_PARAGRAPHS: list[str] = [
    "The crimson moonlight spilled across the cracked stone floor of the ancient dungeon.",
    "Jin-Woo paused at the threshold, his hand resting lightly on the hilt of his dagger.",
    '"Something is wrong," he muttered under his breath, watching the shadows shift.',
    "Normally, an E-rank gate never felt this heavy—like the air itself was pressing down on his lungs.",
    "A faint blue window flickered open in front of his eyes, chiming with an eerie clarity.",
    "[System Notification: You have entered a Hidden Instance. Survival is not guaranteed.]",
    '"Great. Just my luck," he sighed, stepping forward anyway.',
    "Behind him, the dungeon entrance sealed shut with a deafening rumble of stone grinding against stone.",
    "Footsteps echoed from the darkness ahead—slow, deliberate, and far too heavy to belong to a goblin.",
    "Two glowing amber eyes ignited ten paces away, followed by the metallic scrape of a greatsword.",
    "Jin-Woo exhaled slowly and lowered his center of gravity, letting muscle memory take over.",
    '"If I run, I die. If I hesitate, I die," he reminded himself.',
    "The armored knight lunged without warning, splitting the stale air with a downward cleave.",
    "Sparks erupted as Jin-Woo parried the flat of the blade and spun beneath the monster's guard.",
    "His dagger found the narrow gap between the breastplate and shoulder pauldrons.",
    "Black mist hissed out of the wound, briefly illuminating the carved runes along the hall.",
    '"Not deep enough," Jin-Woo clicked his tongue and leaped back before the gauntleted fist struck.',
    "His stamina gauge was already dipping below forty percent, and the battle had barely begun.",
    "Yet for the first time in months, a quiet thrill burned beneath the fear in his chest.",
    '"Come on, then," he whispered, raising his blade. "Show me what you have."',
]


async def run_benchmark() -> None:
    settings = Settings()
    settings.apply_runtime_overrides()

    print(f"Model: {settings.model_id} ({settings.quantization_mode})")
    print(f"HF_HOME: {settings.hf_home}")

    with tempfile.TemporaryDirectory() as tmpdir:
        cache = CacheStore(db_path=Path(tmpdir) / "bench.db")
        manager = ModelManager(settings)
        context = SessionContextStore()
        translator = TranslatorService(manager, context)

        try:
            if torch.cuda.is_available():
                torch.cuda.init()
                torch.cuda.reset_peak_memory_stats(0)

            t_load_start = time.perf_counter()
            status = await manager.load()
            t_load_s = time.perf_counter() - t_load_start
            print(
                f"Model loaded in {t_load_s:.2f}s | VRAM allocated: {status.vram_allocated_mb} MiB",
                flush=True,
            )

            batch_latencies_ms: list[float] = []
            translated_pairs: list[tuple[str, str]] = []
            batch_size = 4

            for start in range(0, len(SAMPLE_PARAGRAPHS), batch_size):
                chunk = SAMPLE_PARAGRAPHS[start : start + batch_size]
                items = [
                    PromptItem(id=f"p-{start + idx + 1}", text=text)
                    for idx, text in enumerate(chunk)
                ]
                t0 = time.perf_counter()
                out = await translator.translate_batch(
                    items,
                    preset="light_novel",
                    session_id="bench-novel",
                    mode="novel",
                )
                dt_ms = (time.perf_counter() - t0) * 1000.0
                batch_latencies_ms.append(dt_ms)

                for item in items:
                    key = compute_cache_key(
                        "novel",
                        compute_content_hash(item.text),
                        manager.active_model_id,
                        "light_novel",
                    )
                    cache.put(key, "novel", {"translated_text": out[item.id]})
                    translated_pairs.append((item.text, out[item.id]))

                print(
                    f"Batch {start // batch_size + 1}/5 ({len(items)} paragraphs): {dt_ms:.0f} ms",
                    flush=True,
                )

            # Measure SQLite cache lookup speed across all 20 paragraphs.
            t_cache_start = time.perf_counter()
            hits = 0
            for text in SAMPLE_PARAGRAPHS:
                key = compute_cache_key(
                    "novel",
                    compute_content_hash(text),
                    manager.active_model_id,
                    "light_novel",
                )
                if cache.get(key) is not None:
                    hits += 1
            cache_total_ms = (time.perf_counter() - t_cache_start) * 1000.0

            peak_vram_gb = (
                torch.cuda.max_memory_allocated(0) / (1024**3)
                if torch.cuda.is_available()
                else 0.0
            )
            avg_batch_ms = sum(batch_latencies_ms) / len(batch_latencies_ms)
            print("\n=== Phase 1 Novel Benchmark Summary ===")
            print(f"Average 4-paragraph batch latency: {avg_batch_ms:.0f} ms (target < 4000 ms)")
            print(
                f"SQLite cache hits ({hits}/20): {cache_total_ms:.2f} ms total (target < 10 ms/batch)"
            )
            print(f"Peak VRAM allocated: {peak_vram_gb:.2f} GB (target < 12.5 GB)")
            print("\nSample EN -> TH outputs:")
            for en, th in translated_pairs[:4]:
                print(f"  EN: {en}")
                print(f"  TH: {th}\n")
        finally:
            await manager.unload()
            cache.close()


def _preflight_hf_cache(hf_home: str) -> None:
    cache_dir = Path(hf_home)
    cache_dir.mkdir(parents=True, exist_ok=True)
    probe = cache_dir / ".bench_preflight.tmp"
    probe.write_text("ok", encoding="utf-8")
    probe.unlink()
    usage = shutil.disk_usage(cache_dir)
    free_gb = usage.free / (1024**3)
    print(f"HF_HOME verified: {cache_dir} ({free_gb:.1f} GB free)", flush=True)


if __name__ == "__main__":
    cfg = Settings()
    cfg.apply_runtime_overrides()
    os.environ["HF_HOME"] = cfg.hf_home
    _preflight_hf_cache(cfg.hf_home)
    asyncio.run(run_benchmark())
