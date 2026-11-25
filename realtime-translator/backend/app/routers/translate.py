"""Translation, preset, and session context endpoints."""

from __future__ import annotations

import time

from fastapi import APIRouter, Request

from app.schemas.manhwa import (
    ManhwaTranslateRequest,
    ManhwaTranslateResponse,
    SnipTranslateRequest,
    SnipTranslateResponse,
)
from app.schemas.translation import (
    NovelParagraphResult,
    NovelTranslateRequest,
    NovelTranslateResponse,
    PresetsResponse,
    SessionResetResponse,
)
from app.services.cache_store import CacheStore, compute_cache_key, compute_content_hash
from app.services.glossary_store import GlossaryStore
from app.services.manhwa_pipeline import ManhwaPipeline
from app.services.model_manager import ModelManager
from app.services.prompt_builder import (
    PromptItem,
    SessionContextStore,
    list_presets,
)
from app.services.translator import TranslatorService

router = APIRouter(tags=["translation"])


@router.get("/presets", response_model=PresetsResponse)
async def get_presets() -> PresetsResponse:
    return PresetsResponse(presets=list_presets())


@router.post("/session/{session_id}/reset", response_model=SessionResetResponse)
async def reset_session(request: Request, session_id: str) -> SessionResetResponse:
    context_store: SessionContextStore = request.app.state.context_store
    context_store.reset(session_id)
    return SessionResetResponse(session_id=session_id, cleared=True)


@router.post("/translate/novel", response_model=NovelTranslateResponse)
async def translate_novel(
    request: Request,
    body: NovelTranslateRequest,
) -> NovelTranslateResponse:
    started = time.perf_counter()
    cache_store: CacheStore = request.app.state.cache_store
    model_manager: ModelManager = request.app.state.model_manager
    translator: TranslatorService = request.app.state.translator
    glossary_store: GlossaryStore | None = getattr(request.app.state, "glossary_store", None)

    model_id = model_manager.active_model_id
    if glossary_store is not None:
        glossary_terms, glossary_hash = glossary_store.get_prompt_terms_and_hash(
            body.glossary_id
        )
    else:
        glossary_terms, glossary_hash = [], body.glossary_id or "none"

    cached_by_id: dict[str, str] = {}
    cache_keys: dict[str, str] = {}
    misses: list[PromptItem] = []

    for paragraph in body.paragraphs:
        content_hash = compute_content_hash(paragraph.text)
        key = compute_cache_key(
            mode="novel",
            content_hash=content_hash,
            model_id=model_id,
            preset=body.preset,
            glossary_hash=glossary_hash,
        )
        cache_keys[paragraph.id] = key

        if not body.bypass_cache:
            hit = cache_store.get(key)
            if hit is not None and isinstance(hit.get("translated_text"), str):
                cached_by_id[paragraph.id] = hit["translated_text"]
                continue

        misses.append(PromptItem(id=paragraph.id, text=paragraph.text))

    fresh_by_id: dict[str, str] = {}
    if misses:
        fresh_by_id = await translator.translate_batch(
            misses,
            preset=body.preset,
            session_id=body.session_id,
            mode="novel",
            glossary_terms=glossary_terms or None,
        )
        for item in misses:
            cache_store.put(
                cache_keys[item.id],
                "novel",
                {"translated_text": fresh_by_id[item.id]},
            )

    results: list[NovelParagraphResult] = []
    for paragraph in body.paragraphs:
        if paragraph.id in cached_by_id:
            results.append(
                NovelParagraphResult(
                    id=paragraph.id,
                    translated_text=cached_by_id[paragraph.id],
                    cached=True,
                )
            )
        else:
            results.append(
                NovelParagraphResult(
                    id=paragraph.id,
                    translated_text=fresh_by_id[paragraph.id],
                    cached=False,
                )
            )

    latency_ms = int((time.perf_counter() - started) * 1000)
    return NovelTranslateResponse(
        model_id=model_manager.active_model_id,
        preset=body.preset,
        latency_ms=latency_ms,
        cache_hits=len(cached_by_id),
        cache_misses=len(misses),
        results=results,
    )


@router.post("/translate/manhwa", response_model=ManhwaTranslateResponse)
async def translate_manhwa(
    request: Request,
    body: ManhwaTranslateRequest,
) -> ManhwaTranslateResponse:
    pipeline: ManhwaPipeline = request.app.state.manhwa_pipeline
    return await pipeline.translate_manhwa(body)


@router.post("/translate/snip", response_model=SnipTranslateResponse)
async def translate_snip(
    request: Request,
    body: SnipTranslateRequest,
) -> SnipTranslateResponse:
    pipeline: ManhwaPipeline = request.app.state.manhwa_pipeline
    return await pipeline.translate_snip(body)
