"""End-to-end vertical long-strip manhwa translation pipeline and manual snip fallback."""

from __future__ import annotations

import asyncio
import base64
import binascii
import io
import time
from typing import Any, Protocol

import numpy as np
from PIL import Image, UnidentifiedImageError

from app.errors import AppError
from app.schemas.manhwa import (
    BubbleOverlay,
    ManhwaTimingsMs,
    ManhwaTranslateRequest,
    ManhwaTranslateResponse,
    SnipTranslateRequest,
    SnipTranslateResponse,
)
from app.services.bubble_detector import BubbleStyle, classify_bubble_style
from app.services.cache_store import CacheStore, compute_cache_key, compute_content_hash
from app.services.glossary_store import GlossaryStore
from app.services.model_manager import ModelManager
from app.services.prompt_builder import GlossaryTerm, PromptItem
from app.services.strip_slicer import (
    DetectedBox,
    merge_cross_slice_boxes,
    normalize_bbox,
    slice_vertical_strip,
    sort_manhwa_reading_order,
)
from app.services.translator import TranslatorService


class BubbleDetectorProtocol(Protocol):
    @property
    def is_loaded(self) -> bool: ...
    def load(self) -> None: ...
    def detect_slice(
        self,
        slice_rgb: np.ndarray,
        *,
        y_offset: int,
        slice_index: int,
    ) -> list[DetectedBox]: ...
    def unload(self) -> None: ...


class OcrEngineProtocol(Protocol):
    def extract_text(self, crop_rgb: np.ndarray) -> str: ...


def decode_base64_bytes(image_base64: str) -> bytes:
    """Decode raw image bytes from base64 (accepting optional data-URL prefix)."""
    raw_str = image_base64.strip()
    if raw_str.startswith("data:") and "," in raw_str:
        raw_str = raw_str.split(",", 1)[1].strip()
    compact = "".join(raw_str.split())
    if not compact:
        raise AppError(
            code="IMAGE_DECODE_ERROR",
            message="Empty base64 image payload.",
            status_code=422,
            retryable=False,
        )
    try:
        decoded = base64.b64decode(compact, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise AppError(
            code="IMAGE_DECODE_ERROR",
            message=f"Invalid base64 image payload: {exc}",
            status_code=422,
            retryable=False,
        ) from exc

    if not decoded:
        raise AppError(
            code="IMAGE_DECODE_ERROR",
            message="Decoded image payload is empty.",
            status_code=422,
            retryable=False,
        )
    return decoded


def decode_rgb_image(raw_bytes: bytes) -> np.ndarray:
    """Decode raw PNG/JPEG/WebP image bytes into an HxWx3 uint8 RGB NumPy array."""
    try:
        with Image.open(io.BytesIO(raw_bytes)) as img:
            rgb = img.convert("RGB")
            return np.asarray(rgb, dtype=np.uint8)
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise AppError(
            code="IMAGE_DECODE_ERROR",
            message=f"Could not decode image bytes: {exc}",
            status_code=422,
            retryable=False,
        ) from exc


def _crop_bubble(rgb: np.ndarray, box: DetectedBox) -> np.ndarray:
    h, w, _ = rgb.shape
    x1 = max(0, min(w - 1, int(round(box.x1))))
    y1 = max(0, min(h - 1, int(round(box.y1))))
    x2 = max(x1 + 1, min(w, int(round(box.x2))))
    y2 = max(y1 + 1, min(h, int(round(box.y2))))
    return rgb[y1:y2, x1:x2]


class ManhwaPipeline:
    """Orchestrates slice -> YOLO detect -> merge -> sort -> color -> CPU OCR -> batched LLM."""

    def __init__(
        self,
        *,
        cache_store: CacheStore,
        model_manager: ModelManager,
        translator: TranslatorService,
        bubble_detector: BubbleDetectorProtocol,
        ocr_engine: OcrEngineProtocol,
        glossary_store: GlossaryStore | None = None,
        slice_height: int = 1400,
        slice_overlap: int = 250,
    ) -> None:
        self._cache_store = cache_store
        self._model_manager = model_manager
        self._translator = translator
        self._bubble_detector = bubble_detector
        self._ocr_engine = ocr_engine
        self._glossary_store = glossary_store
        self._slice_height = slice_height
        self._slice_overlap = slice_overlap

    def _resolve_glossary(self, glossary_id: str | None) -> tuple[list[GlossaryTerm], str]:
        if self._glossary_store is not None:
            return self._glossary_store.get_prompt_terms_and_hash(glossary_id)
        return [], glossary_id or "none"

    async def translate_manhwa(
        self,
        req: ManhwaTranslateRequest,
    ) -> ManhwaTranslateResponse:
        total_start = time.perf_counter()
        raw_bytes = decode_base64_bytes(req.image_base64)
        glossary_terms, glossary_hash = self._resolve_glossary(req.glossary_id)

        # Compute SHA-256 on raw bytes BEFORE image decode so cache hits skip CV/OCR/GPU.
        content_hash = compute_content_hash(raw_bytes)
        cache_key = compute_cache_key(
            mode="manhwa",
            content_hash=content_hash,
            model_id=self._model_manager.active_model_id,
            preset=req.preset,
            glossary_hash=glossary_hash,
        )

        if not req.bypass_cache:
            cached_payload = self._cache_store.get(cache_key)
            if cached_payload is not None:
                total_ms = int((time.perf_counter() - total_start) * 1000)
                bubbles = [
                    BubbleOverlay.model_validate(item)
                    for item in cached_payload.get("bubbles", [])
                ]
                return ManhwaTranslateResponse(
                    image_id=req.image_id,
                    image_width=int(cached_payload["image_width"]),
                    image_height=int(cached_payload["image_height"]),
                    slices_processed=int(cached_payload["slices_processed"]),
                    cached=True,
                    timings_ms=ManhwaTimingsMs(
                        detect=0,
                        ocr=0,
                        translate=0,
                        total=total_ms,
                    ),
                    bubbles=bubbles,
                )

        rgb = decode_rgb_image(raw_bytes)
        image_height, image_width, _ = rgb.shape

        windows = slice_vertical_strip(
            image_width,
            image_height,
            slice_height=self._slice_height,
            overlap=self._slice_overlap,
        )

        # 1. Detect speech/narration bubbles across overlapping vertical slices.
        detect_start = time.perf_counter()
        self._model_manager.set_vision_model(self._bubble_detector)
        raw_boxes: list[DetectedBox] = []
        for win in windows:
            slice_rgb = rgb[win.y_start : win.y_end, :, :]
            slice_boxes = await asyncio.to_thread(
                self._bubble_detector.detect_slice,
                slice_rgb,
                y_offset=win.y_start,
                slice_index=win.index,
            )
            raw_boxes.extend(slice_boxes)

        merged_boxes = merge_cross_slice_boxes(raw_boxes)
        ordered_boxes = sort_manhwa_reading_order(merged_boxes)
        detect_ms = int((time.perf_counter() - detect_start) * 1000)

        # 2. Classify mask/pill color style and run CPU RapidOCR per bubble.
        ocr_start = time.perf_counter()
        candidates: list[tuple[DetectedBox, BubbleStyle, str]] = []
        for box in ordered_boxes:
            crop = _crop_bubble(rgb, box)
            style = classify_bubble_style(crop)
            source_text = await asyncio.to_thread(self._ocr_engine.extract_text, crop)
            if source_text:
                candidates.append((box, style, source_text))
        ocr_ms = int((time.perf_counter() - ocr_start) * 1000)

        # 3. Translate all bubbles in a single batched GPU LLM call in conversational order.
        translate_start = time.perf_counter()
        bubbles_out: list[BubbleOverlay] = []
        if candidates:
            prompt_items = [
                PromptItem(id=f"b-{idx}", text=source_text)
                for idx, (_box, _style, source_text) in enumerate(candidates)
            ]
            translated_map = await self._translator.translate_batch(
                prompt_items,
                preset=req.preset,
                session_id=req.session_id,
                mode="manhwa",
                glossary_terms=glossary_terms or None,
            )

            for idx, (box, style, source_text) in enumerate(candidates):
                bubble_id = f"b-{idx}"
                bubbles_out.append(
                    BubbleOverlay(
                        id=bubble_id,
                        reading_order=idx,
                        bbox=normalize_bbox(box, image_width, image_height),
                        render_mode=style.render_mode,
                        bg_color=style.bg_color,
                        text_color=style.text_color,
                        source_text=source_text,
                        translated_text=translated_map[bubble_id],
                    )
                )
        translate_ms = int((time.perf_counter() - translate_start) * 1000)

        # Persist ONLY compact text + normalized bbox JSON (NEVER raw image binaries).
        cache_payload: dict[str, Any] = {
            "image_width": image_width,
            "image_height": image_height,
            "slices_processed": len(windows),
            "bubbles": [b.model_dump() for b in bubbles_out],
        }
        self._cache_store.put(cache_key, "manhwa", cache_payload)

        total_ms = int((time.perf_counter() - total_start) * 1000)
        return ManhwaTranslateResponse(
            image_id=req.image_id,
            image_width=image_width,
            image_height=image_height,
            slices_processed=len(windows),
            cached=False,
            timings_ms=ManhwaTimingsMs(
                detect=detect_ms,
                ocr=ocr_ms,
                translate=translate_ms,
                total=total_ms,
            ),
            bubbles=bubbles_out,
        )

    async def translate_snip(
        self,
        req: SnipTranslateRequest,
    ) -> SnipTranslateResponse:
        """Direct OCR + translation for manual Alt+S snip crops (skips bubble detector)."""
        started = time.perf_counter()
        raw_bytes = decode_base64_bytes(req.image_base64)
        rgb = decode_rgb_image(raw_bytes)

        source_text = await asyncio.to_thread(self._ocr_engine.extract_text, rgb)
        translated_text = ""
        if source_text:
            glossary_terms, _glossary_hash = self._resolve_glossary(req.glossary_id)
            result = await self._translator.translate_batch(
                [PromptItem(id="snip-0", text=source_text)],
                preset=req.preset,
                session_id=req.session_id,
                mode="snip",
                glossary_terms=glossary_terms or None,
            )
            translated_text = result["snip-0"]

        latency_ms = int((time.perf_counter() - started) * 1000)
        return SnipTranslateResponse(
            source_text=source_text,
            translated_text=translated_text,
            latency_ms=latency_ms,
        )
