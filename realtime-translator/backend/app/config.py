"""Application configuration loaded from .env with persisted runtime overrides."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

APP_VERSION = "0.1.0"
PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ENV_FILE = PROJECT_ROOT / ".env"

QuantizationMode = Literal["4bit", "8bit", "bf16"]
_ALLOWED_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
_PERSISTED_SETTING_KEYS = (
    "model_id",
    "idle_unload_minutes",
    "cache_max_mb",
    "cache_ttl_days",
)


class Settings(BaseSettings):
    """Server configuration sourced from environment variables and .env."""

    model_config = SettingsConfigDict(
        env_file=str(DEFAULT_ENV_FILE),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    hf_home: str = Field(default=r"D:\hf_cache")
    model_id: str = Field(default="typhoon-ai/typhoon2.1-gemma3-12b")
    quantization_mode: QuantizationMode = Field(default="4bit")
    bubble_detector_repo: str = Field(
        default="ogkalu/comic-speech-bubble-detector-yolov8m"
    )
    server_host: str = Field(default="127.0.0.1")
    server_port: int = Field(default=8765, ge=1024, le=65535)
    idle_unload_minutes: int = Field(default=15, ge=1, le=1440)
    cache_db_path: str = Field(default="")
    cache_max_mb: int = Field(default=50, ge=1, le=2048)
    cache_ttl_days: int = Field(default=30, ge=1, le=365)
    runtime_settings_path: str = Field(default="")

    @field_validator("server_host")
    @classmethod
    def validate_loopback_host(cls, value: str) -> str:
        """Enforce loopback-only binding per security invariant."""
        cleaned = value.strip().lower()
        if cleaned not in _ALLOWED_LOOPBACK_HOSTS:
            raise ValueError(
                f"SERVER_HOST must be a loopback address ({sorted(_ALLOWED_LOOPBACK_HOSTS)}), "
                f"got {value!r}."
            )
        return cleaned

    @field_validator("model_id")
    @classmethod
    def validate_model_id(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("MODEL_ID cannot be empty.")
        return cleaned

    def resolved_cache_db_path(self) -> Path:
        """Return SQLite DB path outside OneDrive (default %LOCALAPPDATA%)."""
        if self.cache_db_path.strip():
            return Path(self.cache_db_path).expanduser().resolve()

        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            base_dir = Path(local_app_data)
        else:
            base_dir = Path.home() / "AppData" / "Local"
        return (base_dir / "realtime-translator" / "translator.db").resolve()

    def resolved_runtime_settings_path(self) -> Path:
        """Return path for persisted runtime PATCH /settings overrides."""
        if self.runtime_settings_path.strip():
            return Path(self.runtime_settings_path).expanduser().resolve()
        return self.resolved_cache_db_path().parent / "settings.json"

    def apply_runtime_overrides(self) -> None:
        """Overlay persisted PATCH /settings values if settings.json exists."""
        settings_path = self.resolved_runtime_settings_path()
        if not settings_path.exists():
            return

        try:
            raw: dict[str, Any] = json.loads(settings_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return

        for key in _PERSISTED_SETTING_KEYS:
            if key in raw and raw[key] is not None:
                setattr(self, key, raw[key])

    def save_runtime_overrides(self) -> Path:
        """Persist mutable runtime settings to JSON outside OneDrive."""
        settings_path = self.resolved_runtime_settings_path()
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {key: getattr(self, key) for key in _PERSISTED_SETTING_KEYS}
        settings_path.write_text(
            json.dumps(payload, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        return settings_path
