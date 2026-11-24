"""FastAPI contract tests covering Phase 1 endpoints, CORS, caching, and error envelopes."""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import MockBackendHarness


def test_health_and_model_lifecycle_endpoints(client: TestClient) -> None:
    health = client.get("/health")
    assert health.status_code == 200
    assert health.json() == {
        "status": "ok",
        "version": "0.1.0",
        "gpu_name": "NVIDIA GeForce RTX 5060 Ti",
        "cuda_available": True,
    }

    status = client.get("/model/status")
    assert status.status_code == 200
    body = status.json()
    assert body["state"] == "unloaded"
    assert body["model_id"] == "typhoon-ai/typhoon2.1-gemma3-12b"
    assert body["quantization"] == "4bit"
    assert body["vram_allocated_mb"] == 0
    assert body["vram_total_mb"] == 16311

    loaded = client.post("/model/load", json={"load_vision": False})
    assert loaded.status_code == 200
    assert loaded.json()["state"] == "loaded"
    assert loaded.json()["vram_allocated_mb"] == 9840

    unloaded = client.post("/model/unload")
    assert unloaded.status_code == 200
    assert unloaded.json() == {
        "state": "unloaded",
        "vram_allocated_mb": 0,
        "vram_total_mb": 16311,
    }


def test_presets_and_session_reset_endpoints(client: TestClient) -> None:
    presets = client.get("/presets")
    assert presets.status_code == 200
    ids = [p["id"] for p in presets.json()["presets"]]
    assert ids == ["modern_manhwa", "fantasy_murim", "light_novel", "literal"]

    reset = client.post("/session/tab-42-ch-105/reset")
    assert reset.status_code == 200
    assert reset.json() == {"session_id": "tab-42-ch-105", "cleared": True}


def test_translate_novel_caching_partial_hits_and_bypass(
    client: TestClient,
    harness: MockBackendHarness,
) -> None:
    payload = {
        "session_id": "tab-42-ch-105",
        "preset": "light_novel",
        "glossary_id": None,
        "bypass_cache": False,
        "paragraphs": [
            {"id": "p-1", "text": "Sung Jin-Woo stepped into the cold dungeon."},
            {"id": "p-2", "text": '"Arise," he whispered.'},
        ],
    }

    # 1. Cold call: 2 misses -> 1 batched GPU call.
    r1 = client.post("/translate/novel", json=payload)
    assert r1.status_code == 200
    d1 = r1.json()
    assert d1["cache_hits"] == 0
    assert d1["cache_misses"] == 2
    assert [item["id"] for item in d1["results"]] == ["p-1", "p-2"]
    assert all(item["cached"] is False for item in d1["results"])
    assert len(harness.generate_calls) == 1

    # 2. Unload model, then re-request exact same paragraphs -> 100% cache hit, 0 GPU calls!
    client.post("/model/unload")
    assert harness.model_manager.state == "unloaded"

    r2 = client.post("/translate/novel", json=payload)
    assert r2.status_code == 200
    d2 = r2.json()
    assert d2["cache_hits"] == 2
    assert d2["cache_misses"] == 0
    assert all(item["cached"] is True for item in d2["results"])
    assert len(harness.generate_calls) == 1
    assert harness.model_manager.state == "unloaded"

    # 3. Partial cache hit: p-1 cached, p-3 fresh -> exact input ordering preserved.
    partial_payload = {
        **payload,
        "paragraphs": [
            {"id": "p-1", "text": "Sung Jin-Woo stepped into the cold dungeon."},
            {"id": "p-3", "text": "Black smoke rose from the floor."},
        ],
    }
    r3 = client.post("/translate/novel", json=partial_payload)
    assert r3.status_code == 200
    d3 = r3.json()
    assert d3["cache_hits"] == 1
    assert d3["cache_misses"] == 1
    assert d3["results"][0]["id"] == "p-1" and d3["results"][0]["cached"] is True
    assert d3["results"][1]["id"] == "p-3" and d3["results"][1]["cached"] is False
    assert len(harness.generate_calls) == 2

    # 4. bypass_cache=True skips cache and invokes LLM.
    r4 = client.post("/translate/novel", json={**payload, "bypass_cache": True})
    assert r4.status_code == 200
    assert r4.json()["cache_hits"] == 0
    assert r4.json()["cache_misses"] == 2
    assert len(harness.generate_calls) == 3

    # 5. Cache stats & clear endpoints.
    stats = client.get("/cache/stats")
    assert stats.status_code == 200
    assert stats.json()["novel_entries"] == 3
    cleared = client.post("/cache/clear")
    assert cleared.status_code == 200
    assert cleared.json()["cleared_entries"] == 3


def test_validation_errors_use_standardized_error_envelope(client: TestClient) -> None:
    # Empty paragraphs list -> 400 INVALID_REQUEST.
    r_empty = client.post(
        "/translate/novel",
        json={"session_id": "s1", "preset": "light_novel", "paragraphs": []},
    )
    assert r_empty.status_code == 400
    err = r_empty.json()["error"]
    assert err["code"] == "INVALID_REQUEST"
    assert err["retryable"] is False

    # More than 10 paragraphs -> 400 INVALID_REQUEST.
    too_many = [{"id": f"p-{i}", "text": f"Paragraph {i}"} for i in range(11)]
    r_many = client.post(
        "/translate/novel",
        json={"session_id": "s1", "preset": "light_novel", "paragraphs": too_many},
    )
    assert r_many.status_code == 400
    assert r_many.json()["error"]["code"] == "INVALID_REQUEST"

    # Duplicate paragraph IDs -> 400 INVALID_REQUEST.
    r_dup = client.post(
        "/translate/novel",
        json={
            "session_id": "s1",
            "preset": "light_novel",
            "paragraphs": [
                {"id": "p-1", "text": "One"},
                {"id": "p-1", "text": "Two"},
            ],
        },
    )
    assert r_dup.status_code == 400
    assert r_dup.json()["error"]["code"] == "INVALID_REQUEST"

    # Unknown route -> 404 NOT_FOUND envelope.
    r_404 = client.get("/does-not-exist")
    assert r_404.status_code == 404
    assert r_404.json()["error"]["code"] == "NOT_FOUND"


def test_cors_allows_extension_and_localhost_only(client: TestClient) -> None:
    ok_ext = client.get("/health", headers={"Origin": "chrome-extension://abcdefghijklmnop"})
    assert ok_ext.headers.get("access-control-allow-origin") == "chrome-extension://abcdefghijklmnop"

    ok_local = client.get("/health", headers={"Origin": "http://localhost:5173"})
    assert ok_local.headers.get("access-control-allow-origin") == "http://localhost:5173"

    blocked = client.get("/health", headers={"Origin": "https://untrusted.example.com"})
    assert "access-control-allow-origin" not in blocked.headers
