"""Genre tone presets, rolling session context, selective glossary matching, and prompts."""

from __future__ import annotations

import json
import re
from collections import OrderedDict, deque
from dataclasses import dataclass
from typing import Literal

from app.schemas.translation import PresetId, PresetInfo

TranslationMode = Literal["novel", "manhwa", "snip"]


@dataclass(frozen=True)
class PromptItem:
    id: str
    text: str


@dataclass(frozen=True)
class ContextPair:
    source: str
    target: str


@dataclass(frozen=True)
class GlossaryTerm:
    source_term: str
    target_term: str
    category: str = "term"
    note: str = ""


PRESET_CATALOG: dict[PresetId, PresetInfo] = {
    "modern_manhwa": PresetInfo(
        id="modern_manhwa",
        label="Modern Manhwa (Casual)",
        description="Natural contemporary Thai dialogue (ฉัน/นาย/เธอ/ผม/แก), concise bubbles",
    ),
    "fantasy_murim": PresetInfo(
        id="fantasy_murim",
        label="Fantasy / Murim / Isekai",
        description="Martial & fantasy Thai register (ข้า/เจ้า/ท่าน/ผู้น้อย) with skill terminology",
    ),
    "light_novel": PresetInfo(
        id="light_novel",
        label="Light Novel Prose",
        description="Smooth literary Thai prose and narrative cadence",
    ),
    "literal": PresetInfo(
        id="literal",
        label="Literal / Reading Aid",
        description="Closer to original English phrasing for checking nuance",
    ),
}

PRESET_GUIDANCE: dict[PresetId, str] = {
    "modern_manhwa": (
        "Style: Contemporary casual Thai webtoon/manhwa dialogue. "
        "Use natural modern pronouns (ฉัน/นาย/เธอ/ผม/แก/พี่/น้อง) matched to character relationships. "
        "Keep lines punchy, colloquial, and concise enough to fit inside speech bubbles."
    ),
    "fantasy_murim": (
        "Style: Fantasy, Isekai, Regression, and Murim register. "
        "Use appropriate classical/martial pronouns (ข้า/เจ้า/ท่าน/ผู้น้อย/ศิษย์พี่/อาจารย์) "
        "and evocative Thai terminology for skills, realms, sects, and system notifications."
    ),
    "light_novel": (
        "Style: Smooth, idiomatic Thai web novel / light novel prose. "
        "Maintain natural Thai narrative cadence, fluid sentence connectors, expressive dialogue, "
        "and faithful internal monologue without stiff translationese."
    ),
    "literal": (
        "Style: Faithful, closer-to-source Thai reading aid. "
        "Preserve sentence structure, clauses, and specific English idioms closely so the reader "
        "can compare directly against the English original."
    ),
}


def list_presets() -> list[PresetInfo]:
    """Return ordered list of built-in genre tone presets."""
    return [
        PRESET_CATALOG["modern_manhwa"],
        PRESET_CATALOG["fantasy_murim"],
        PRESET_CATALOG["light_novel"],
        PRESET_CATALOG["literal"],
    ]


def estimate_tokens(text: str) -> int:
    """Rough token count heuristic safe for English + Thai mixed strings."""
    return max(1, len(text) // 3)


class SessionContextStore:
    """Bounded in-memory rolling EN->TH context buffer per session_id."""

    def __init__(
        self,
        *,
        max_pairs: int = 8,
        max_tokens: int = 600,
        max_sessions: int = 64,
    ) -> None:
        self._max_pairs = max_pairs
        self._max_tokens = max_tokens
        self._max_sessions = max_sessions
        self._sessions: OrderedDict[str, deque[ContextPair]] = OrderedDict()

    def get(self, session_id: str) -> list[ContextPair]:
        buf = self._sessions.get(session_id)
        if buf is None:
            return []
        self._sessions.move_to_end(session_id)
        return list(buf)

    def append(self, session_id: str, pairs: list[ContextPair]) -> None:
        if not pairs:
            return
        buf = self._sessions.get(session_id)
        if buf is None:
            buf = deque(maxlen=self._max_pairs)
            self._sessions[session_id] = buf
        else:
            self._sessions.move_to_end(session_id)

        for pair in pairs:
            buf.append(pair)

        # Trim oldest pairs until within rolling token budget.
        while len(buf) > 1 and self._buffer_tokens(buf) > self._max_tokens:
            buf.popleft()

        while len(self._sessions) > self._max_sessions:
            self._sessions.popitem(last=False)

    def reset(self, session_id: str) -> bool:
        existed = session_id in self._sessions
        self._sessions.pop(session_id, None)
        return existed

    @staticmethod
    def _buffer_tokens(buf: deque[ContextPair]) -> int:
        return sum(estimate_tokens(p.source) + estimate_tokens(p.target) for p in buf)


def select_matching_glossary_terms(
    terms: list[GlossaryTerm],
    batch_texts: list[str],
    context_pairs: list[ContextPair],
) -> list[GlossaryTerm]:
    """Select only glossary terms appearing in current batch/context plus pronoun rules."""
    if not terms:
        return []

    haystack = "\n".join(
        [*batch_texts, *(pair.source for pair in context_pairs)]
    ).lower()

    selected: list[GlossaryTerm] = []
    for term in terms:
        if term.category.strip().lower() == "pronoun":
            selected.append(term)
            continue
        needle = term.source_term.strip().lower()
        if not needle:
            continue
        if len(needle) <= 3 and needle.isalnum():
            if re.search(rf"\b{re.escape(needle)}\b", haystack):
                selected.append(term)
        elif needle in haystack:
            selected.append(term)
    return selected


def build_batch_messages(
    items: list[PromptItem],
    *,
    preset: PresetId,
    mode: TranslationMode = "novel",
    context_pairs: list[ContextPair] | None = None,
    glossary_terms: list[GlossaryTerm] | None = None,
) -> list[dict[str, str]]:
    """Build chat messages enforcing strict ID-aligned JSON translation output."""
    guidance = PRESET_GUIDANCE[preset]
    mode_rule = (
        "Each item is a web novel paragraph."
        if mode == "novel"
        else "Each item is a manhwa/webtoon speech bubble or narration box in reading order; keep Thai phrasing concise."
    )

    system_lines = [
        "You are an expert English-to-Thai literary and manhwa translator.",
        guidance,
        mode_rule,
        "Rules:",
        "1. Translate every input item accurately into natural Thai. Do not omit, merge, split, or add items.",
        "2. Keep character names, pronouns, and speaker tone consistent with any provided context or glossary.",
        "3. Return ONLY valid JSON matching exactly this schema with no markdown fences or extra commentary:",
        '{"translations":[{"id":"<exact input id>","th":"<Thai translation>"}]}',
    ]

    context_list = context_pairs or []
    matched_terms = select_matching_glossary_terms(
        glossary_terms or [],
        [item.text for item in items],
        context_list,
    )

    if matched_terms:
        system_lines.append("\nGlossary (follow these exact Thai terms and pronoun rules):")
        for term in matched_terms:
            note_suffix = f" ({term.note})" if term.note.strip() else ""
            system_lines.append(
                f"- [{term.category}] {term.source_term} => {term.target_term}{note_suffix}"
            )

    if context_list:
        system_lines.append(
            "\nRecent translated context (read-only reference for pronouns and continuity; do NOT re-translate):"
        )
        for pair in context_list:
            system_lines.append(f"- EN: {pair.source}\n  TH: {pair.target}")

    payload = {
        "items": [{"id": item.id, "en": item.text} for item in items],
    }

    return [
        {"role": "system", "content": "\n".join(system_lines)},
        {
            "role": "user",
            "content": (
                "Translate the following JSON items from English to Thai and return ONLY the JSON object:\n"
                + json.dumps(payload, ensure_ascii=False)
            ),
        },
    ]


def build_single_item_messages(
    item: PromptItem,
    *,
    preset: PresetId,
    mode: TranslationMode = "novel",
    context_pairs: list[ContextPair] | None = None,
    glossary_terms: list[GlossaryTerm] | None = None,
) -> list[dict[str, str]]:
    """Build a minimal single-item fallback prompt when batch JSON parsing fails."""
    guidance = PRESET_GUIDANCE[preset]
    system_lines = [
        "You are an expert English-to-Thai translator.",
        guidance,
        "Translate the user's English text into natural Thai.",
        "Output ONLY the Thai translation text with no explanation, labels, or quotes.",
    ]

    context_list = context_pairs or []
    matched_terms = select_matching_glossary_terms(
        glossary_terms or [],
        [item.text],
        context_list,
    )
    if matched_terms:
        system_lines.append("\nGlossary:")
        for term in matched_terms:
            note_suffix = f" ({term.note})" if term.note.strip() else ""
            system_lines.append(
                f"- [{term.category}] {term.source_term} => {term.target_term}{note_suffix}"
            )

    if context_list:
        system_lines.append("\nRecent context (read-only):")
        for pair in context_list[-3:]:
            system_lines.append(f"- EN: {pair.source} | TH: {pair.target}")

    return [
        {"role": "system", "content": "\n".join(system_lines)},
        {"role": "user", "content": item.text},
    ]
