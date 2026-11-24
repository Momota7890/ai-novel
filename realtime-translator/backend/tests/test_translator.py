"""Tests for structured JSON translation parsing, ID alignment fallback, and rolling context."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.errors import AppError
from app.services.model_manager import LoadedLLM
from app.services.prompt_builder import (
    ContextPair,
    GlossaryTerm,
    PromptItem,
    SessionContextStore,
    build_batch_messages,
    select_matching_glossary_terms,
)
from app.services.translator import parse_batch_translations
from tests.conftest import build_mock_harness


def test_parse_batch_translations_handles_fences_and_shuffled_order() -> None:
    raw = (
        "Here is the translation:\n"
        "```json\n"
        '{"translations": [{"id": "p-2", "th": "ประโยคสอง"}, {"id": "p-1", "th": "ประโยคหนึ่ง"}, {"id": "p-extra", "th": "ส่วนเกิน"}]}\n'
        "```"
    )
    parsed = parse_batch_translations(raw, ["p-1", "p-2"])
    assert parsed == {"p-1": "ประโยคหนึ่ง", "p-2": "ประโยคสอง"}


async def test_translator_falls_back_only_for_missing_ids(tmp_path: Path) -> None:
    call_count = 0

    def partial_generator(
        loaded: LoadedLLM,
        messages: list[dict[str, str]],
        max_new_tokens: int,
    ) -> str:
        nonlocal call_count
        _ = loaded, max_new_tokens
        call_count += 1
        if call_count == 1:
            # Deliberately drop p-2 from batch response to trigger fallback.
            return json.dumps(
                {"translations": [{"id": "p-1", "th": "ซองจินอูก้าวไปข้างหน้า"}]},
                ensure_ascii=False,
            )
        return '"จงตื่น" เขากระซิบ'

    harness = build_mock_harness(tmp_path, generate_fn=partial_generator)
    try:
        items = [
            PromptItem(id="p-1", text="Sung Jin-Woo stepped forward."),
            PromptItem(id="p-2", text='"Arise," he whispered.'),
        ]
        result = await harness.translator.translate_batch(
            items,
            preset="light_novel",
            session_id="tab-1",
        )
        assert result == {
            "p-1": "ซองจินอูก้าวไปข้างหน้า",
            "p-2": '"จงตื่น" เขากระซิบ',
        }
        # 1 batch call + 1 targeted single-item retry for p-2 ONLY.
        assert call_count == 2
        # Rolling context should now contain both pairs in input order.
        ctx = harness.context_store.get("tab-1")
        assert len(ctx) == 2
        assert ctx[0].source == "Sung Jin-Woo stepped forward."
        assert ctx[1].target == '"จงตื่น" เขากระซิบ'
    finally:
        harness.cache_store.close()


async def test_translator_raises_when_fallback_returns_empty(tmp_path: Path) -> None:
    def empty_generator(
        loaded: LoadedLLM,
        messages: list[dict[str, str]],
        max_new_tokens: int,
    ) -> str:
        _ = loaded, messages, max_new_tokens
        return "   "

    harness = build_mock_harness(tmp_path, generate_fn=empty_generator)
    try:
        with pytest.raises(AppError) as exc_info:
            await harness.translator.translate_batch(
                [PromptItem(id="p-1", text="Hello")],
                preset="literal",
                session_id="tab-empty",
            )
        assert exc_info.value.code == "TRANSLATION_ERROR"
        assert exc_info.value.status_code == 500
    finally:
        harness.cache_store.close()


def test_session_context_caps_pairs_tokens_and_isolates_sessions() -> None:
    store = SessionContextStore(max_pairs=8, max_tokens=120, max_sessions=2)
    for i in range(10):
        store.append("s1", [ContextPair(source=f"Line {i} " + "a" * 30, target=f"บรรทัด {i}")])

    s1_pairs = store.get("s1")
    assert 1 <= len(s1_pairs) <= 8
    assert s1_pairs[-1].source.startswith("Line 9")

    store.append("s2", [ContextPair(source="Other tab", target="แท็บอื่น")])
    assert len(store.get("s2")) == 1
    assert store.reset("s1") is True
    assert store.get("s1") == []
    assert len(store.get("s2")) == 1


def test_selective_glossary_and_preset_guidance() -> None:
    terms = [
        GlossaryTerm("Sung Jin-Woo", "ซองจินอู", "name"),
        GlossaryTerm("Shadow Extraction", "สกัดเงา", "skill"),
        GlossaryTerm("MC->Sister", "พี่/เธอ", "pronoun", "casual sibling tone"),
        GlossaryTerm("Unrelated Boss", "บอสอื่น", "name"),
    ]
    matched = select_matching_glossary_terms(
        terms,
        batch_texts=["Sung Jin-Woo activated his skill."],
        context_pairs=[ContextPair("Shadow Extraction succeeded.", "สกัดเงาสำเร็จ")],
    )
    matched_sources = [t.source_term for t in matched]
    assert "Sung Jin-Woo" in matched_sources
    assert "Shadow Extraction" in matched_sources
    assert "MC->Sister" in matched_sources
    assert "Unrelated Boss" not in matched_sources

    msgs_murim = build_batch_messages(
        [PromptItem("p-1", "You dare challenge this sect?")],
        preset="fantasy_murim",
    )
    assert "ข้า/เจ้า" in msgs_murim[0]["content"]
    msgs_modern = build_batch_messages(
        [PromptItem("p-1", "Wait up!")],
        preset="modern_manhwa",
    )
    assert "ฉัน/นาย" in msgs_modern[0]["content"]
