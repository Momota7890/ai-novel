"""Shared fixtures and deterministic GPU/LLM fakes for offline backend tests."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import QuantizationMode, Settings
from app.main import create_app
from app.services.cache_store import CacheStore
from app.services.glossary_store import GlossaryStore
from app.services.manhwa_pipeline import ManhwaPipeline
from app.services.model_manager import LoadedLLM, ModelManager
from app.services.prompt_builder import SessionContextStore
from app.services.strip_slicer import DetectedBox
from app.services.translator import TranslatorService


@dataclass
class FakeBubbleDetector:
    boxes_by_slice: dict[int, list[DetectedBox]] = field(default_factory=dict)
    detect_calls: int = 0
    _loaded: bool = False

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    def load(self) -> None:
        self._loaded = True

    def detect_slice(
        self,
        slice_rgb: Any,
        *,
        y_offset: int,
        slice_index: int,
    ) -> list[DetectedBox]:
        _ = slice_rgb, y_offset
        self._loaded = True
        self.detect_calls += 1
        return list(self.boxes_by_slice.get(slice_index, []))

    def unload(self) -> None:
        self._loaded = False


@dataclass
class FakeOcrEngine:
    texts: list[str] = field(default_factory=list)
    ocr_calls: int = 0

    def extract_text(self, crop_rgb: Any) -> str:
        _ = crop_rgb
        idx = self.ocr_calls
        self.ocr_calls += 1
        if idx < len(self.texts):
            return self.texts[idx]
        return f"Sample bubble {idx}"


@dataclass
class FakeCudaOps:
    available: bool = True
    name: str = "NVIDIA GeForce RTX 5060 Ti"
    total_mb: int = 16311
    allocated_mb: int = 0
    empty_cache_calls: int = 0

    def is_available(self) -> bool:
        return self.available

    def device_name(self) -> str:
        return self.name if self.available else "CPU"

    def vram_allocated_mb(self) -> int:
        return self.allocated_mb

    def vram_total_mb(self) -> int:
        return self.total_mb if self.available else 0

    def empty_cache(self) -> None:
        self.empty_cache_calls += 1
        self.allocated_mb = 0


@dataclass
class FakeClock:
    now: float = 1_700_000_000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@dataclass
class MockBackendHarness:
    app: FastAPI
    settings: Settings
    cache_store: CacheStore
    glossary_store: GlossaryStore
    model_manager: ModelManager
    context_store: SessionContextStore
    translator: TranslatorService
    bubble_detector: FakeBubbleDetector
    ocr_engine: FakeOcrEngine
    manhwa_pipeline: ManhwaPipeline
    cuda: FakeCudaOps
    clock: FakeClock
    load_calls: list[tuple[str, QuantizationMode]] = field(default_factory=list)
    generate_calls: list[list[dict[str, str]]] = field(default_factory=list)


def default_fake_generate(
    loaded: LoadedLLM,
    messages: list[dict[str, str]],
    max_new_tokens: int,
) -> str:
    """Deterministic EN->TH JSON responder mirroring the structured batch schema."""
    _ = loaded, max_new_tokens
    user_msg = messages[-1]["content"]
    marker = user_msg.find("{")
    if marker != -1:
        try:
            payload: dict[str, Any] = json.loads(user_msg[marker:])
            items = payload.get("items")
            if isinstance(items, list):
                translations = [
                    {
                        "id": str(item["id"]),
                        "th": f"แปลไทย[{item['id']}]: {item['en']}",
                    }
                    for item in items
                ]
                return json.dumps({"translations": translations}, ensure_ascii=False)
        except json.JSONDecodeError:
            pass
    return f"แปลไทยเดี่ยว: {user_msg.strip()}"


def build_mock_harness(
    tmp_path: Path,
    *,
    generate_fn: Callable[[LoadedLLM, list[dict[str, str]], int], str] | None = None,
    loader_fn: Callable[[str, QuantizationMode, str], LoadedLLM] | None = None,
    max_bytes_override: int | None = None,
) -> MockBackendHarness:
    """Build an isolated FastAPI app + services backed by temp SQLite and fake GPU."""
    db_path = tmp_path / "translator.db"
    runtime_settings = tmp_path / "settings.json"
    clock = FakeClock()
    cuda = FakeCudaOps()

    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        hf_home=str(tmp_path / "hf_cache"),
        model_id="typhoon-ai/typhoon2.1-gemma3-12b",
        quantization_mode="4bit",
        server_host="127.0.0.1",
        server_port=8765,
        idle_unload_minutes=15,
        cache_db_path=str(db_path),
        cache_max_mb=50,
        cache_ttl_days=30,
        runtime_settings_path=str(runtime_settings),
    )

    cache_store = CacheStore(
        db_path=db_path,
        max_mb=settings.cache_max_mb,
        ttl_days=settings.cache_ttl_days,
        max_bytes_override=max_bytes_override,
        clock=clock,
    )
    glossary_store = GlossaryStore(db_path=db_path, clock=clock)

    load_calls: list[tuple[str, QuantizationMode]] = []
    generate_calls: list[list[dict[str, str]]] = []

    def _wrapped_loader(
        model_id: str,
        quantization: QuantizationMode,
        hf_home: str,
    ) -> LoadedLLM:
        load_calls.append((model_id, quantization))
        if loader_fn is not None:
            result = loader_fn(model_id, quantization, hf_home)
        else:
            result = LoadedLLM(
                model=object(),
                tokenizer=object(),
                model_id=model_id,
                quantization=quantization,
            )
        cuda.allocated_mb = 9840
        return result

    active_gen = generate_fn or default_fake_generate

    def _wrapped_generate(
        loaded: LoadedLLM,
        messages: list[dict[str, str]],
        max_new_tokens: int,
    ) -> str:
        generate_calls.append(messages)
        return active_gen(loaded, messages, max_new_tokens)

    model_manager = ModelManager(
        settings=settings,
        loader_fn=_wrapped_loader,
        generate_fn=_wrapped_generate,
        cuda_ops=cuda,
        clock=clock,
    )
    context_store = SessionContextStore()
    translator = TranslatorService(
        model_manager=model_manager,
        context_store=context_store,
    )
    bubble_detector = FakeBubbleDetector()
    ocr_engine = FakeOcrEngine()
    manhwa_pipeline = ManhwaPipeline(
        cache_store=cache_store,
        model_manager=model_manager,
        translator=translator,
        bubble_detector=bubble_detector,
        ocr_engine=ocr_engine,
        glossary_store=glossary_store,
    )
    app = create_app(
        settings=settings,
        cache_store=cache_store,
        glossary_store=glossary_store,
        model_manager=model_manager,
        context_store=context_store,
        translator=translator,
        bubble_detector=bubble_detector,
        ocr_engine=ocr_engine,
        manhwa_pipeline=manhwa_pipeline,
        watchdog_interval_seconds=0.0,
    )

    return MockBackendHarness(
        app=app,
        settings=settings,
        cache_store=cache_store,
        glossary_store=glossary_store,
        model_manager=model_manager,
        context_store=context_store,
        translator=translator,
        bubble_detector=bubble_detector,
        ocr_engine=ocr_engine,
        manhwa_pipeline=manhwa_pipeline,
        cuda=cuda,
        clock=clock,
        load_calls=load_calls,
        generate_calls=generate_calls,
    )


@pytest.fixture
def harness(tmp_path: Path) -> MockBackendHarness:
    h = build_mock_harness(tmp_path)
    yield h
    h.glossary_store.close()
    h.cache_store.close()


@pytest.fixture
def client(harness: MockBackendHarness) -> TestClient:
    with TestClient(harness.app) as test_client:
        yield test_client
