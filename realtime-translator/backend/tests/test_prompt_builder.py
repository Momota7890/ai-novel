"""Tests for Phase 3 prompt builder: all 4 tone presets, rolling context, and selective glossaries."""

from __future__ import annotations

import pytest

from app.schemas.translation import PresetId
from app.services.prompt_builder import (
    ContextPair,
    GlossaryTerm,
    PromptItem,
    SessionContextStore,
    build_batch_messages,
    build_single_item_messages,
    list_presets,
    select_matching_glossary_terms,
)


@pytest.mark.parametrize(
    ("preset", "expected_marker"),
    [
        ("modern_manhwa", "ฉัน/นาย"),
        ("fantasy_murim", "ข้า/เจ้า"),
        ("light_novel", "narrative cadence"),
        ("literal", "closer-to-source"),
    ],
)
def test_all_four_genre_presets_embed_distinct_guidance(
    preset: PresetId,
    expected_marker: str,
) -> None:
    msgs = build_batch_messages(
        [PromptItem(id="p-1", text="Wait for me!")],
        preset=preset,
        mode="novel",
    )
    assert len(msgs) == 2
    assert expected_marker in msgs[0]["content"]
    assert "Never blend English letters inside Thai words" in msgs[0]["content"]


def test_list_presets_returns_exact_four_presets() -> None:
    presets = list_presets()
    assert [p.id for p in presets] == [
        "modern_manhwa",
        "fantasy_murim",
        "light_novel",
        "literal",
    ]


def test_selective_glossary_matching_injects_only_matched_plus_pronouns() -> None:
    glossary = [
        GlossaryTerm("Sung Jin-Woo", "ซองจินอู", "name", "MC"),
        GlossaryTerm("Shadow Extraction", "สกัดเงา", "skill"),
        GlossaryTerm("MC->Guildmaster", "ผม/คุณ", "pronoun", "polite"),
        GlossaryTerm("Red Gate", "เกตแดง", "place"),
        GlossaryTerm("AI", "เอไอ", "term"),
    ]

    # Case-insensitive match in batch + context; short term "AI" uses word boundary so "wait" won't trigger it!
    matched = select_matching_glossary_terms(
        glossary,
        batch_texts=["Wait! sung jin-woo walked into the dungeon."],
        context_pairs=[ContextPair("He used shadow extraction earlier.", "เขาใช้สกัดเงาก่อนหน้านี้")],
    )
    sources = {term.source_term for term in matched}
    assert sources == {"Sung Jin-Woo", "Shadow Extraction", "MC->Guildmaster"}
    assert "Red Gate" not in sources
    assert "AI" not in sources

    msgs = build_batch_messages(
        [PromptItem("p-1", "Wait! sung jin-woo walked into the dungeon.")],
        preset="modern_manhwa",
        context_pairs=[ContextPair("He used shadow extraction earlier.", "เขาใช้สกัดเงาก่อนหน้านี้")],
        glossary_terms=glossary,
    )
    sys_prompt = msgs[0]["content"]
    assert "ซองจินอู" in sys_prompt
    assert "สกัดเงา" in sys_prompt
    assert "ผม/คุณ" in sys_prompt
    assert "เกตแดง" not in sys_prompt


def test_single_item_fallback_prompt_preserves_glossary_and_recent_context() -> None:
    msgs = build_single_item_messages(
        PromptItem("p-9", "Sung Jin-Woo spoke softly."),
        preset="light_novel",
        context_pairs=[
            ContextPair("Line 1", "ไทย 1"),
            ContextPair("Line 2", "ไทย 2"),
            ContextPair("Line 3", "ไทย 3"),
            ContextPair("Line 4", "ไทย 4"),
        ],
        glossary_terms=[GlossaryTerm("Sung Jin-Woo", "ซองจินอู", "name")],
    )
    assert "ซองจินอู" in msgs[0]["content"]
    assert "Line 4" in msgs[0]["content"]
    assert "Line 1" not in msgs[0]["content"]  # Fallback trims to last 3 pairs.


def test_rolling_context_enforces_max_pairs_token_cap_and_lru_sessions() -> None:
    store = SessionContextStore(max_pairs=8, max_tokens=200, max_sessions=2)
    for i in range(12):
        store.append("s1", [ContextPair(f"English sentence {i} " + "w" * 20, f"ประโยคไทย {i}")])

    pairs = store.get("s1")
    assert 1 <= len(pairs) <= 8
    assert pairs[-1].source.startswith("English sentence 11")

    store.append("s2", [ContextPair("Tab 2", "แท็บ 2")])
    # Touch s1 so s2 becomes least recently used before s3 evicts s2.
    _ = store.get("s1")
    store.append("s3", [ContextPair("Tab 3", "แท็บ 3")])

    assert store.get("s2") == []
    assert len(store.get("s1")) >= 1
    assert len(store.get("s3")) == 1
