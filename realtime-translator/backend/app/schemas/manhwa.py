"""Pydantic v2 schemas for vertical long-strip manhwa translation and manual snip."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.schemas.translation import PresetId

RenderMode = Literal["mask", "pill"]


class ManhwaTranslateRequest(BaseModel):
    session_id: str = Field(..., min_length=1, max_length=256)
    preset: PresetId = "modern_manhwa"
    glossary_id: str | None = None
    bypass_cache: bool = False
    image_id: str = Field(..., min_length=1, max_length=256)
    image_base64: str = Field(..., min_length=1)
    image_mime: str = Field(default="image/webp", min_length=1, max_length=64)

    @field_validator("session_id", "image_id", "image_base64")
    @classmethod
    def reject_blank(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Field cannot be empty or whitespace-only.")
        return cleaned


class ManhwaTimingsMs(BaseModel):
    detect: int
    ocr: int
    translate: int
    total: int


class BubbleOverlay(BaseModel):
    id: str
    reading_order: int
    bbox: tuple[float, float, float, float]
    render_mode: RenderMode
    bg_color: str
    text_color: str
    source_text: str
    translated_text: str


class ManhwaTranslateResponse(BaseModel):
    image_id: str
    image_width: int
    image_height: int
    slices_processed: int
    cached: bool
    timings_ms: ManhwaTimingsMs
    bubbles: list[BubbleOverlay]


class SnipTranslateRequest(BaseModel):
    session_id: str = Field(..., min_length=1, max_length=256)
    preset: PresetId = "modern_manhwa"
    glossary_id: str | None = None
    image_base64: str = Field(..., min_length=1)
    image_mime: str = Field(default="image/png", min_length=1, max_length=64)

    @field_validator("session_id", "image_base64")
    @classmethod
    def reject_blank(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Field cannot be empty or whitespace-only.")
        return cleaned


class SnipTranslateResponse(BaseModel):
    source_text: str
    translated_text: str
    latency_ms: int
