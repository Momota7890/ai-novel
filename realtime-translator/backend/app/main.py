"""FastAPI application entrypoint, loopback CORS, lifespan, and idle VRAM watchdog."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import APP_VERSION, Settings
from app.errors import register_exception_handlers
from app.routers import cache as cache_router
from app.routers import health as health_router
from app.routers import translate as translate_router
from app.services.cache_store import CacheStore
from app.services.model_manager import ModelManager
from app.services.prompt_builder import SessionContextStore
from app.services.translator import TranslatorService

_CORS_ORIGIN_REGEX = (
    r"^(chrome-extension://[a-zA-Z0-9_-]+"
    r"|http://localhost(:\d+)?"
    r"|http://127\.0\.0\.1(:\d+)?)$"
)


async def _idle_watchdog_loop(
    model_manager: ModelManager,
    interval_seconds: float,
) -> None:
    while True:
        await asyncio.sleep(interval_seconds)
        await model_manager.unload_if_idle()


def create_app(
    *,
    settings: Settings | None = None,
    cache_store: CacheStore | None = None,
    model_manager: ModelManager | None = None,
    context_store: SessionContextStore | None = None,
    translator: TranslatorService | None = None,
    watchdog_interval_seconds: float = 30.0,
) -> FastAPI:
    """Create and wire the FastAPI backend with injectable services for testing."""
    cfg = settings or Settings()
    if settings is None:
        cfg.apply_runtime_overrides()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        owns_cache = cache_store is None
        active_cache = cache_store or CacheStore(
            db_path=cfg.resolved_cache_db_path(),
            max_mb=cfg.cache_max_mb,
            ttl_days=cfg.cache_ttl_days,
        )
        active_manager = model_manager or ModelManager(cfg)
        active_context = context_store or SessionContextStore()
        active_translator = translator or TranslatorService(
            model_manager=active_manager,
            context_store=active_context,
        )

        app.state.settings = cfg
        app.state.cache_store = active_cache
        app.state.model_manager = active_manager
        app.state.context_store = active_context
        app.state.translator = active_translator

        watchdog_task: asyncio.Task[None] | None = None
        if watchdog_interval_seconds > 0:
            watchdog_task = asyncio.create_task(
                _idle_watchdog_loop(active_manager, watchdog_interval_seconds)
            )

        try:
            yield
        finally:
            if watchdog_task is not None:
                watchdog_task.cancel()
                try:
                    await watchdog_task
                except asyncio.CancelledError:
                    pass
            if owns_cache:
                active_cache.close()

    app = FastAPI(
        title="Realtime EN->TH Novel & Manhwa Translator",
        version=APP_VERSION,
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=_CORS_ORIGIN_REGEX,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )

    register_exception_handlers(app)

    app.include_router(health_router.router)
    app.include_router(cache_router.router)
    app.include_router(translate_router.router)
    return app


app = create_app()
