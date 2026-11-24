"""Health, GPU model lifecycle, and runtime settings endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Request

from app.config import APP_VERSION, Settings
from app.schemas.system import (
    HealthResponse,
    ModelLoadRequest,
    ModelStatusResponse,
    ModelUnloadResponse,
    SettingsPatchRequest,
    SettingsResponse,
)
from app.services.cache_store import CacheStore
from app.services.model_manager import ModelManager

router = APIRouter(tags=["system"])


@router.get("/health", response_model=HealthResponse)
async def get_health(request: Request) -> HealthResponse:
    manager: ModelManager = request.app.state.model_manager
    gpu_name, cuda_available = manager.gpu_health()
    return HealthResponse(
        status="ok",
        version=APP_VERSION,
        gpu_name=gpu_name,
        cuda_available=cuda_available,
    )


@router.get("/model/status", response_model=ModelStatusResponse)
async def get_model_status(request: Request) -> ModelStatusResponse:
    manager: ModelManager = request.app.state.model_manager
    return manager.status()


@router.post("/model/load", response_model=ModelStatusResponse)
async def load_model(
    request: Request,
    body: ModelLoadRequest | None = None,
) -> ModelStatusResponse:
    manager: ModelManager = request.app.state.model_manager
    payload = body or ModelLoadRequest()
    return await manager.load(
        model_id=payload.model_id,
        load_vision=payload.load_vision,
    )


@router.post("/model/unload", response_model=ModelUnloadResponse)
async def unload_model(request: Request) -> ModelUnloadResponse:
    manager: ModelManager = request.app.state.model_manager
    return await manager.unload()


@router.patch("/settings", response_model=SettingsResponse)
async def patch_settings(
    request: Request,
    body: SettingsPatchRequest,
) -> SettingsResponse:
    settings: Settings = request.app.state.settings
    manager: ModelManager = request.app.state.model_manager
    cache_store: CacheStore = request.app.state.cache_store

    model_changed = False
    if body.model_id is not None and body.model_id != settings.model_id:
        settings.model_id = body.model_id
        model_changed = True
    if body.idle_unload_minutes is not None:
        settings.idle_unload_minutes = body.idle_unload_minutes
    if body.cache_max_mb is not None:
        settings.cache_max_mb = body.cache_max_mb
    if body.cache_ttl_days is not None:
        settings.cache_ttl_days = body.cache_ttl_days

    settings.save_runtime_overrides()
    cache_store.update_limits(settings.cache_max_mb, settings.cache_ttl_days)

    if model_changed and manager.state == "loaded":
        await manager.unload()

    return SettingsResponse(
        model_id=settings.model_id,
        idle_unload_minutes=settings.idle_unload_minutes,
        cache_max_mb=settings.cache_max_mb,
        cache_ttl_days=settings.cache_ttl_days,
    )
