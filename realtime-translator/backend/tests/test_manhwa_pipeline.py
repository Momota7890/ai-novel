"""End-to-end mocked tests for ManhwaPipeline, /translate/manhwa, and /translate/snip."""

from __future__ import annotations

import base64
import io
import sqlite3

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from app.services.strip_slicer import DetectedBox
from tests.conftest import MockBackendHarness


def _make_strip_base64(width: int = 800, height: int = 2400) -> str:
    arr = np.full((height, width, 3), 180, dtype=np.uint8)
    # Bubble 0 (solid white box in slice 0)
    arr[120:260, 100:380, :] = 255
    # Bubble 1 (solid dark box in slice 1)
    arr[1500:1660, 420:720, :] = 18
    img = Image.fromarray(arr, mode="RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def test_translate_manhwa_pipeline_batches_caches_and_never_stores_images(
    client: TestClient,
    harness: MockBackendHarness,
) -> None:
    strip_b64 = _make_strip_base64(width=800, height=2400)
    harness.bubble_detector.boxes_by_slice = {
        0: [DetectedBox(100, 120, 380, 260, confidence=0.92, slice_index=0)],
        1: [DetectedBox(420, 1500, 720, 1660, confidence=0.89, slice_index=1)],
    }
    harness.ocr_engine.texts = [
        "Wait... did you clear that gate alone?",
        "He's not an ordinary E-rank.",
    ]

    payload = {
        "session_id": "tab-manhwa-1",
        "preset": "modern_manhwa",
        "glossary_id": None,
        "bypass_cache": False,
        "image_id": "img-004",
        "image_base64": strip_b64,
        "image_mime": "image/png",
    }

    # 1. Cold run: slices vertical strip, runs detect + OCR + single batched LLM call.
    r1 = client.post("/translate/manhwa", json=payload)
    assert r1.status_code == 200
    d1 = r1.json()
    assert d1["image_id"] == "img-004"
    assert d1["image_width"] == 800
    assert d1["image_height"] == 2400
    assert d1["slices_processed"] == 2
    assert d1["cached"] is False
    assert len(d1["bubbles"]) == 2
    assert d1["bubbles"][0]["reading_order"] == 0
    assert d1["bubbles"][0]["render_mode"] == "mask"
    assert d1["bubbles"][0]["bg_color"] == "#FFFFFF"
    assert d1["bubbles"][0]["text_color"] == "#111111"
    assert d1["bubbles"][1]["reading_order"] == 1
    assert d1["bubbles"][1]["bg_color"] == "#121212"
    assert d1["bubbles"][1]["text_color"] == "#FFFFFF"
    assert len(harness.generate_calls) == 1
    assert harness.bubble_detector.detect_calls == 2

    # 2. Second request with identical raw image bytes hits SQLite cache (0 detect, 0 OCR, 0 GPU).
    r2 = client.post("/translate/manhwa", json=payload)
    assert r2.status_code == 200
    d2 = r2.json()
    assert d2["cached"] is True
    assert d2["timings_ms"]["detect"] == 0
    assert d2["timings_ms"]["ocr"] == 0
    assert d2["timings_ms"]["translate"] == 0
    assert len(d2["bubbles"]) == 2
    assert len(harness.generate_calls) == 1
    assert harness.bubble_detector.detect_calls == 2

    # 3. Verify SQLite stored ONLY compact JSON (never raw base64 image data).
    conn = sqlite3.connect(str(harness.cache_store.db_path))
    row = conn.execute(
        "SELECT payload_json, byte_size FROM translation_cache WHERE mode = 'manhwa'"
    ).fetchone()
    conn.close()
    assert row is not None
    assert int(row[1]) < 4096
    assert strip_b64[:40] not in str(row[0])


def test_translate_manhwa_empty_bubbles_skips_llm_and_handles_invalid_image(
    client: TestClient,
    harness: MockBackendHarness,
) -> None:
    strip_b64 = _make_strip_base64(width=800, height=900)
    harness.bubble_detector.boxes_by_slice = {}

    resp = client.post(
        "/translate/manhwa",
        json={
            "session_id": "tab-art",
            "preset": "modern_manhwa",
            "image_id": "img-art",
            "image_base64": strip_b64,
            "image_mime": "image/png",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["bubbles"] == []
    assert len(harness.generate_calls) == 0

    # Invalid image bytes -> standardized 422 IMAGE_DECODE_ERROR.
    bad_resp = client.post(
        "/translate/manhwa",
        json={
            "session_id": "tab-bad",
            "preset": "modern_manhwa",
            "image_id": "img-bad",
            "image_base64": "not-valid-base64!!!",
            "image_mime": "image/png",
        },
    )
    assert bad_resp.status_code == 422
    assert bad_resp.json()["error"]["code"] == "IMAGE_DECODE_ERROR"
    assert bad_resp.json()["error"]["retryable"] is False


def test_translate_snip_bypasses_bubble_detector(
    client: TestClient,
    harness: MockBackendHarness,
) -> None:
    crop_b64 = _make_strip_base64(width=300, height=120)
    harness.ocr_engine.texts = ["SYSTEM NOTIFICATION: Quest Completed."]

    resp = client.post(
        "/translate/snip",
        json={
            "session_id": "tab-snip",
            "preset": "modern_manhwa",
            "image_base64": crop_b64,
            "image_mime": "image/png",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["source_text"] == "SYSTEM NOTIFICATION: Quest Completed."
    assert "แปลไทย[snip-0]" in body["translated_text"]
    assert harness.bubble_detector.detect_calls == 0

    # Non-image bytes inside valid base64 -> 422 IMAGE_DECODE_ERROR.
    corrupt = base64.b64encode(b"this is not a png").decode("ascii")
    bad_snip = client.post(
        "/translate/snip",
        json={
            "session_id": "tab-snip",
            "preset": "modern_manhwa",
            "image_base64": corrupt,
            "image_mime": "image/png",
        },
    )
    assert bad_snip.status_code == 422
    assert bad_snip.json()["error"]["code"] == "IMAGE_DECODE_ERROR"
