"""Batched EN->TH LLM translator with strict ID alignment and per-item fallback."""

from __future__ import annotations

import json
import re
from typing import Any

from app.errors import AppError
from app.schemas.translation import PresetId
from app.services.model_manager import ModelManager
from app.services.prompt_builder import (
    ContextPair,
    GlossaryTerm,
    PromptItem,
    SessionContextStore,
    TranslationMode,
    build_batch_messages,
    build_single_item_messages,
    estimate_tokens,
)

_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)


def _extract_json_candidates(raw_output: str) -> list[str]:
    text = raw_output.strip()
    candidates: list[str] = []

    for match in _FENCE_RE.finditer(text):
        fenced = match.group(1).strip()
        if fenced:
            candidates.append(fenced)

    candidates.append(text)

    first_brace = text.find("{")
    last_brace = text.rfind("}")
    if first_brace != -1 and last_brace > first_brace:
        candidates.append(text[first_brace : last_brace + 1])

    first_bracket = text.find("[")
    last_bracket = text.rfind("]")
    if first_bracket != -1 and last_bracket > first_bracket:
        candidates.append(text[first_bracket : last_bracket + 1])

    return candidates


def parse_batch_translations(
    raw_output: str,
    expected_ids: list[str],
) -> dict[str, str]:
    """Parse ID-aligned JSON translations from LLM output, returning matched IDs only."""
    expected_set = set(expected_ids)

    for candidate in _extract_json_candidates(raw_output):
        try:
            parsed: Any = json.loads(candidate)
        except json.JSONDecodeError:
            continue

        extracted: dict[str, str] = {}
        entries: Any = None
        if isinstance(parsed, dict):
            if isinstance(parsed.get("translations"), list):
                entries = parsed["translations"]
            elif isinstance(parsed.get("results"), list):
                entries = parsed["results"]
            else:
                for key, value in parsed.items():
                    if key in expected_set and isinstance(value, str) and value.strip():
                        extracted[key] = value.strip()
        elif isinstance(parsed, list):
            entries = parsed

        if isinstance(entries, list):
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                item_id = entry.get("id")
                th_val = entry.get("th") or entry.get("translated_text") or entry.get("text")
                if (
                    isinstance(item_id, str)
                    and item_id in expected_set
                    and isinstance(th_val, str)
                    and th_val.strip()
                ):
                    extracted[item_id] = th_val.strip()

        if extracted:
            return extracted

    return {}


def _clean_single_fallback_output(raw_output: str) -> str:
    text = raw_output.strip()
    fence_match = _FENCE_RE.search(text)
    if fence_match:
        text = fence_match.group(1).strip()

    # If the model still responded with a tiny JSON object, extract the value cleanly.
    if text.startswith("{") and text.endswith("}"):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                for key in ("th", "translated_text", "translation", "text"):
                    val = parsed.get(key)
                    if isinstance(val, str) and val.strip():
                        return val.strip()
        except json.JSONDecodeError:
            pass

    return text


class TranslatorService:
    """Orchestrates batched LLM translation, ID alignment verification, and context updates."""

    def __init__(
        self,
        model_manager: ModelManager,
        context_store: SessionContextStore,
    ) -> None:
        self._model_manager = model_manager
        self._context_store = context_store

    async def translate_batch(
        self,
        items: list[PromptItem],
        *,
        preset: PresetId,
        session_id: str,
        mode: TranslationMode = "novel",
        glossary_terms: list[GlossaryTerm] | None = None,
    ) -> dict[str, str]:
        """Translate a batch of items with exact ID alignment and per-item fallback."""
        if not items:
            return {}

        context_pairs = self._context_store.get(session_id)
        messages = build_batch_messages(
            items,
            preset=preset,
            mode=mode,
            context_pairs=context_pairs,
            glossary_terms=glossary_terms,
        )
        input_tokens = sum(estimate_tokens(item.text) for item in items)
        max_new_tokens = min(2048, max(256, int(input_tokens * 2.5) + 128))

        raw_output = await self._model_manager.generate(
            messages,
            max_new_tokens=max_new_tokens,
        )
        expected_ids = [item.id for item in items]
        translated = parse_batch_translations(raw_output, expected_ids)

        # Graceful per-item fallback for any missing or malformed IDs.
        missing_items = [item for item in items if item.id not in translated]
        for item in missing_items:
            single_messages = build_single_item_messages(
                item,
                preset=preset,
                mode=mode,
                context_pairs=context_pairs,
                glossary_terms=glossary_terms,
            )
            single_max_tokens = min(1024, max(128, int(estimate_tokens(item.text) * 2.5) + 64))
            single_raw = await self._model_manager.generate(
                single_messages,
                max_new_tokens=single_max_tokens,
            )
            cleaned = _clean_single_fallback_output(single_raw)
            if not cleaned:
                raise AppError(
                    code="TRANSLATION_ERROR",
                    message=f"Model returned empty translation for item '{item.id}'.",
                    status_code=500,
                    retryable=True,
                )
            translated[item.id] = cleaned

        self._context_store.append(
            session_id,
            [ContextPair(source=item.text, target=translated[item.id]) for item in items],
        )
        return translated
