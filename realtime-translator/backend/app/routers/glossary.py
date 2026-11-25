"""Per-series glossary CRUD endpoints (/glossaries)."""

from __future__ import annotations

from fastapi import APIRouter, Request

from app.schemas.glossary import (
    GlossaryDeleteResponse,
    GlossaryListResponse,
    GlossaryResponse,
    GlossaryUpsertRequest,
)
from app.services.glossary_store import GlossaryStore

router = APIRouter(prefix="/glossaries", tags=["glossaries"])


def _get_store(request: Request) -> GlossaryStore:
    return request.app.state.glossary_store


@router.get("", response_model=GlossaryListResponse)
async def list_glossaries(request: Request) -> GlossaryListResponse:
    return GlossaryListResponse(glossaries=_get_store(request).list_glossaries())


@router.post("", response_model=GlossaryResponse, status_code=201)
async def create_glossary(
    request: Request,
    body: GlossaryUpsertRequest,
) -> GlossaryResponse:
    return _get_store(request).create_glossary(body)


@router.put("/{glossary_id}", response_model=GlossaryResponse)
async def update_glossary(
    request: Request,
    glossary_id: str,
    body: GlossaryUpsertRequest,
) -> GlossaryResponse:
    return _get_store(request).update_glossary(glossary_id, body)


@router.delete("/{glossary_id}", response_model=GlossaryDeleteResponse)
async def delete_glossary(
    request: Request,
    glossary_id: str,
) -> GlossaryDeleteResponse:
    _get_store(request).delete_glossary(glossary_id)
    return GlossaryDeleteResponse(deleted=True)
