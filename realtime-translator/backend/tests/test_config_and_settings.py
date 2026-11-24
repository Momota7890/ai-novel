"""Tests for backend config defaults, loopback guardrails, and PATCH /settings."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import Settings
from tests.conftest import MockBackendHarness


def test_default_cache_db_path_uses_localappdata(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "LocalAppData"))
    cfg = Settings(_env_file=None, cache_db_path="")  # type: ignore[call-arg]
    resolved = cfg.resolved_cache_db_path()
    assert resolved == (tmp_path / "LocalAppData" / "realtime-translator" / "translator.db").resolve()
    assert "OneDrive" not in str(resolved)


@pytest.mark.parametrize("bad_host", ["0.0.0.0", "192.168.1.5", "example.com"])
def test_non_loopback_server_host_rejected(bad_host: str) -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None, server_host=bad_host)  # type: ignore[call-arg]


@pytest.mark.parametrize("ok_host", ["127.0.0.1", "localhost", "::1"])
def test_loopback_server_host_accepted(ok_host: str) -> None:
    cfg = Settings(_env_file=None, server_host=ok_host)  # type: ignore[call-arg]
    assert cfg.server_host == ok_host


def test_runtime_settings_round_trip(tmp_path: Path) -> None:
    settings_file = tmp_path / "settings.json"
    cfg = Settings(
        _env_file=None,  # type: ignore[call-arg]
        runtime_settings_path=str(settings_file),
        model_id="typhoon-ai/typhoon2.1-gemma3-4b",
        idle_unload_minutes=5,
        cache_max_mb=80,
        cache_ttl_days=14,
    )
    cfg.save_runtime_overrides()
    assert settings_file.exists()

    reloaded = Settings(
        _env_file=None,  # type: ignore[call-arg]
        runtime_settings_path=str(settings_file),
    )
    reloaded.apply_runtime_overrides()
    assert reloaded.model_id == "typhoon-ai/typhoon2.1-gemma3-4b"
    assert reloaded.idle_unload_minutes == 5
    assert reloaded.cache_max_mb == 80
    assert reloaded.cache_ttl_days == 14


def test_patch_settings_persists_and_unloads_when_model_changes(
    client: TestClient,
    harness: MockBackendHarness,
) -> None:
    load_resp = client.post("/model/load", json={})
    assert load_resp.status_code == 200
    assert load_resp.json()["state"] == "loaded"

    patch_resp = client.patch(
        "/settings",
        json={
            "model_id": "typhoon-ai/typhoon2.1-gemma3-4b",
            "idle_unload_minutes": 10,
            "cache_max_mb": 64,
            "cache_ttl_days": 21,
        },
    )
    assert patch_resp.status_code == 200
    assert patch_resp.json() == {
        "model_id": "typhoon-ai/typhoon2.1-gemma3-4b",
        "idle_unload_minutes": 10,
        "cache_max_mb": 64,
        "cache_ttl_days": 21,
    }

    # Changing model_id unloads previous model cleanly so next request loads new one.
    status_resp = client.get("/model/status")
    assert status_resp.json()["state"] == "unloaded"
    assert status_resp.json()["model_id"] == "typhoon-ai/typhoon2.1-gemma3-4b"
    assert status_resp.json()["idle_unload_minutes"] == 10

    stats_resp = client.get("/cache/stats")
    assert stats_resp.json()["max_mb"] == 64
    assert stats_resp.json()["ttl_days"] == 21

    persisted = json.loads(
        harness.settings.resolved_runtime_settings_path().read_text(encoding="utf-8")
    )
    assert persisted["model_id"] == "typhoon-ai/typhoon2.1-gemma3-4b"
