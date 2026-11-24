"""Cache management endpoints (/cache/stats, /cache/clear)."""

from __future__ import annotations

from fastapi import APIRouter, Request

from app.schemas.system import CacheClearResponse, CacheStatsResponse
from app.services.cache_store import CacheStore

router = APIRouter(prefix="/cache", tags=["cache"])


def _get_cache_store(request: Request) -> CacheStore:
    return request.app.state.cache_store


@router.get("/stats", response_model=CacheStatsResponse)
async def get_cache_stats(request: Request) -> CacheStatsResponse:
    return _get_cache_store(request).stats()


@router.post("/clear", response_model=CacheClearResponse)
async def clear_cache(request: Request) -> CacheClearResponse:
    return _get_cache_store(request).clear()
