"""Tests for ModelManager lazy load, async GPU lock serialization, OOM recovery, and idle unload."""

from __future__ import annotations

import asyncio
import threading
import time
from pathlib import Path

import pytest

from app.errors import AppError
from app.services.model_manager import LoadedLLM
from tests.conftest import build_mock_harness


async def test_lazy_load_manual_unload_and_idle_watchdog(tmp_path: Path) -> None:
    harness = build_mock_harness(tmp_path)
    try:
        # Lazy startup: unloaded, 0 VRAM.
        assert harness.model_manager.state == "unloaded"
        assert harness.model_manager.status().vram_allocated_mb == 0

        # First generation triggers lazy load automatically.
        out = await harness.model_manager.generate([{"role": "user", "content": "Hi"}])
        assert out
        assert harness.model_manager.state == "loaded"
        assert len(harness.load_calls) == 1
        assert harness.model_manager.status().vram_allocated_mb == 9840

        # Attach dummy vision detector and verify idle watchdog unloads both after 15 min.
        unloaded_vision = {"called": False}

        class DummyVision:
            def unload(self) -> None:
                unloaded_vision["called"] = True

        harness.model_manager.set_vision_model(DummyVision())
        assert harness.model_manager.bubble_detector_loaded is True

        harness.clock.advance(14 * 60)
        assert await harness.model_manager.unload_if_idle() is False
        assert harness.model_manager.state == "loaded"

        harness.clock.advance(61)
        assert await harness.model_manager.unload_if_idle() is True
        assert harness.model_manager.state == "unloaded"
        assert unloaded_vision["called"] is True
        assert harness.model_manager.bubble_detector_loaded is False
        assert harness.cuda.empty_cache_calls >= 1

        # Next request transparently reloads.
        await harness.model_manager.generate([{"role": "user", "content": "Again"}])
        assert harness.model_manager.state == "loaded"
        assert len(harness.load_calls) == 2

        # Manual unload frees VRAM immediately.
        unload_resp = await harness.model_manager.unload()
        assert unload_resp.state == "unloaded"
        assert unload_resp.vram_allocated_mb == 0
    finally:
        harness.cache_store.close()


async def test_gpu_lock_serializes_concurrent_generations(tmp_path: Path) -> None:
    active_workers = 0
    max_concurrent = 0
    guard = threading.Lock()

    def slow_gen(loaded: LoadedLLM, messages: list[dict[str, str]], max_new_tokens: int) -> str:
        nonlocal active_workers, max_concurrent
        _ = loaded, messages, max_new_tokens
        with guard:
            active_workers += 1
            max_concurrent = max(max_concurrent, active_workers)
        time.sleep(0.04)
        with guard:
            active_workers -= 1
        return "ok"

    harness = build_mock_harness(tmp_path, generate_fn=slow_gen)
    try:
        await harness.model_manager.load()
        results = await asyncio.gather(
            harness.model_manager.generate([{"role": "user", "content": "A"}]),
            harness.model_manager.generate([{"role": "user", "content": "B"}]),
            harness.model_manager.generate([{"role": "user", "content": "C"}]),
        )
        assert results == ["ok", "ok", "ok"]
        assert max_concurrent == 1, "GPU lock must serialize concurrent inference calls"
    finally:
        harness.cache_store.close()


async def test_request_during_loading_returns_model_loading_503(tmp_path: Path) -> None:
    load_started = threading.Event()
    allow_finish = threading.Event()

    def blocking_loader(model_id: str, quantization: str, hf_home: str) -> LoadedLLM:
        _ = hf_home
        load_started.set()
        allow_finish.wait(timeout=3.0)
        return LoadedLLM(object(), object(), model_id, quantization)  # type: ignore[arg-type]

    harness = build_mock_harness(tmp_path, loader_fn=blocking_loader)
    try:
        load_task = asyncio.create_task(harness.model_manager.load())
        await asyncio.to_thread(load_started.wait, 2.0)

        with pytest.raises(AppError) as exc_info:
            await harness.model_manager.generate([{"role": "user", "content": "While loading"}])

        assert exc_info.value.code == "MODEL_LOADING"
        assert exc_info.value.status_code == 503
        assert exc_info.value.retryable is True

        allow_finish.set()
        status = await load_task
        assert status.state == "loaded"
    finally:
        allow_finish.set()
        harness.cache_store.close()


async def test_cuda_oom_clears_cache_and_returns_503(tmp_path: Path) -> None:
    def oom_gen(loaded: LoadedLLM, messages: list[dict[str, str]], max_new_tokens: int) -> str:
        _ = loaded, messages, max_new_tokens
        raise RuntimeError("CUDA out of memory. Tried to allocate 2.00 GiB")

    harness = build_mock_harness(tmp_path, generate_fn=oom_gen)
    try:
        with pytest.raises(AppError) as exc_info:
            await harness.model_manager.generate([{"role": "user", "content": "Boom"}])
        assert exc_info.value.code == "CUDA_OOM"
        assert exc_info.value.status_code == 503
        assert exc_info.value.retryable is True
        assert harness.cuda.empty_cache_calls >= 1
    finally:
        harness.cache_store.close()
