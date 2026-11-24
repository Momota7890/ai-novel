"""Pydantic v2 schemas for web novel translation, presets, and session control."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

PresetId = Literal["modern_manhwa", "fantasy_murim", "light_novel", "literal"]


class PresetInfo(BaseModel):
    id: PresetId
    label: str
    description: str


class PresetsResponse(BaseModel):
    presets: list[PresetInfo]


class ParagraphInput(BaseModel):
    id: str = Field(..., min_length=1, max_length=128)
    text: str = Field(..., min_length=1, max_length=8000)

    @field_validator("id", "text")
    @classmethod
    def reject_blank(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Field cannot be empty or whitespace-only.")
        return cleaned


class NovelTranslateRequest(BaseModel):
    session_id: str = Field(..., min_length=1, max_length=256)
    preset: PresetId = "light_novel"
    glossary_id: str | None = None
    bypass_cache: bool = False
    paragraphs: list[ParagraphInput] = Field(..., min_length=1, max_length=10)

    @field_validator("session_id")
    @classmethod
    def strip_session_id(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("session_id cannot be blank.")
        return cleaned

    @field_validator("paragraphs")
    @classmethod
    def ensure_unique_ids(cls, value: list[ParagraphInput]) -> list[ParagraphInput]:
        seen: set[str] = set()
        for item in value:
            if item.id in seen:
                raise ValueError(f"Duplicate paragraph id in batch: {item.id!r}")
            seen.add(item.id)
        return value


class NovelParagraphResult(BaseModel):
    id: str
    translated_text: str
    cached: bool


class NovelTranslateResponse(BaseModel):
    model_id: str
    preset: PresetId
    latency_ms: int
    cache_hits: int
    cache_misses: int
    results: list[NovelParagraphResult]


class SessionResetResponse(BaseModel):
    session_id: str
    cleared: bool
