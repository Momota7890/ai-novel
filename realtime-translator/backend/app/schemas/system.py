"""Pydantic v2 schemas for health, GPU model lifecycle, settings, and cache."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

ModelState = Literal["unloaded", "loading", "loaded", "unloading", "error"]


class ErrorDetail(BaseModel):
    code: str
    message: str
    retryable: bool


class ErrorEnvelope(BaseModel):
    error: ErrorDetail


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    version: str
    gpu_name: str
    cuda_available: bool


class ModelStatusResponse(BaseModel):
    state: ModelState
    model_id: str
    quantization: str
    bubble_detector_loaded: bool
    vram_allocated_mb: int
    vram_total_mb: int
    idle_seconds: int
    idle_unload_minutes: int
    last_error: str | None = None


class ModelLoadRequest(BaseModel):
    model_id: str | None = None
    load_vision: bool = False

    @field_validator("model_id")
    @classmethod
    def strip_model_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("model_id cannot be blank.")
        return cleaned


class ModelUnloadResponse(BaseModel):
    state: ModelState
    vram_allocated_mb: int
    vram_total_mb: int


class SettingsPatchRequest(BaseModel):
    model_id: str | None = None
    idle_unload_minutes: int | None = Field(default=None, ge=1, le=1440)
    cache_max_mb: int | None = Field(default=None, ge=1, le=2048)
    cache_ttl_days: int | None = Field(default=None, ge=1, le=365)

    @field_validator("model_id")
    @classmethod
    def strip_model_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("model_id cannot be blank.")
        return cleaned


class SettingsResponse(BaseModel):
    model_id: str
    idle_unload_minutes: int
    cache_max_mb: int
    cache_ttl_days: int


class CacheStatsResponse(BaseModel):
    db_path: str
    total_entries: int
    novel_entries: int
    manhwa_entries: int
    size_mb: float
    max_mb: int
    ttl_days: int
    session_hits: int
    session_misses: int


class CacheClearResponse(BaseModel):
    cleared_entries: int
    size_mb: float
