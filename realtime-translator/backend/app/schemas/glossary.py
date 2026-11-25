"""Pydantic v2 schemas for per-series glossaries (/glossaries CRUD)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.schemas.translation import PresetId

GlossaryCategory = Literal["name", "skill", "place", "pronoun", "term"]


class GlossaryEntryInput(BaseModel):
    source_term: str = Field(..., min_length=1, max_length=256)
    target_term: str = Field(..., min_length=1, max_length=256)
    category: GlossaryCategory = "term"
    note: str = Field(default="", max_length=512)

    @field_validator("source_term", "target_term")
    @classmethod
    def strip_required(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Term cannot be empty or whitespace-only.")
        return cleaned

    @field_validator("note")
    @classmethod
    def strip_note(cls, value: str) -> str:
        return value.strip()


class GlossaryEntryResponse(BaseModel):
    id: int
    source_term: str
    target_term: str
    category: GlossaryCategory
    note: str


class GlossaryUpsertRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    url_pattern: str = Field(default="", max_length=512)
    default_preset: PresetId = "modern_manhwa"
    entries: list[GlossaryEntryInput] = Field(default_factory=list, max_length=500)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Glossary name cannot be blank.")
        return cleaned

    @field_validator("url_pattern")
    @classmethod
    def strip_pattern(cls, value: str) -> str:
        return value.strip()


class GlossaryResponse(BaseModel):
    id: str
    name: str
    url_pattern: str
    default_preset: PresetId
    updated_at: int
    entries: list[GlossaryEntryResponse]


class GlossaryListResponse(BaseModel):
    glossaries: list[GlossaryResponse]


class GlossaryDeleteResponse(BaseModel):
    deleted: bool
