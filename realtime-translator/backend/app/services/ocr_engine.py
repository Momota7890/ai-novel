"""CPU/ONNX RapidOCR English text extractor and comic text normalizer."""

from __future__ import annotations

import re
from typing import Any

import numpy as np

_PRESERVED_UPPER_TOKENS = {
    "I",
    "I'M",
    "I'LL",
    "I'VE",
    "I'D",
    "HP",
    "MP",
    "XP",
    "EXP",
    "SP",
    "ATK",
    "DEF",
    "INT",
    "AGI",
    "STR",
    "VIT",
    "LV",
    "LVL",
    "NPC",
    "PVP",
    "PVE",
    "RPG",
    "SSS",
    "SS",
    "OK",
    "ID",
    "AI",
    "UI",
    "VIP",
    "CEO",
    "USA",
    "DNA",
    "KO",
}

_VALID_SHORT_WORDS = {
    "A",
    "I",
    "AH",
    "AM",
    "AN",
    "AS",
    "AT",
    "BE",
    "BY",
    "DO",
    "GO",
    "HA",
    "HE",
    "HI",
    "IF",
    "IN",
    "IS",
    "IT",
    "ME",
    "MY",
    "NO",
    "OF",
    "OH",
    "OK",
    "ON",
    "OR",
    "SO",
    "TO",
    "UH",
    "UM",
    "UP",
    "US",
    "WE",
}

_RANK_HYPHEN_RE = re.compile(r"^([SABCDEF]{1,3})-(RANK|CLASS|GRADE|TIER)$", re.IGNORECASE)
_WORD_RE = re.compile(r"[A-Za-z0-9]+(?:'[A-Za-z]+)?(?:-[A-Za-z0-9]+)*")


def _join_comic_lines(lines: list[str]) -> str:
    """Merge multi-line OCR text, de-hyphenating wrapped English words cleanly."""
    cleaned_lines = [re.sub(r"\s+", " ", line).strip() for line in lines if line and line.strip()]
    if not cleaned_lines:
        return ""

    merged = cleaned_lines[0]
    for nxt in cleaned_lines[1:]:
        if (
            merged.endswith("-")
            and not merged.endswith("--")
            and len(merged) >= 3
            and merged[-2].isalpha()
            and nxt[0].isalpha()
        ):
            # Keep genuine single-letter rank prefixes like "E-" + "RANK".
            tail_word = merged[:-1].split()[-1] if merged[:-1].split() else ""
            if len(tail_word) == 1 and tail_word.upper() in {"S", "A", "B", "C", "D", "E", "F"}:
                merged = f"{merged}{nxt}"
            else:
                merged = f"{merged[:-1]}{nxt}"
        else:
            merged = f"{merged} {nxt}"

    return re.sub(r"\s+", " ", merged).strip()


def _normalize_all_caps_comic(text: str) -> str:
    """Convert ALL-CAPS comic lettering into natural sentence case, preserving acronyms/ranks."""
    alpha_chars = [ch for ch in text if ch.isalpha()]
    if len(alpha_chars) < 4:
        return text

    upper_ratio = sum(1 for ch in alpha_chars if ch.isupper()) / len(alpha_chars)
    if upper_ratio < 0.85:
        return text

    lowered = text.lower()

    # Capitalize start of string and start of each sentence (. ! ? ...).
    chars = list(lowered)
    cap_next = True
    for i, ch in enumerate(chars):
        if cap_next and ch.isalpha():
            chars[i] = ch.upper()
            cap_next = False
        elif ch in ".!?":
            cap_next = True
    sentence = "".join(chars)

    def _restore_token(match: re.Match[str]) -> str:
        tok = match.group(0)
        upper = tok.upper()
        if upper in _PRESERVED_UPPER_TOKENS:
            if upper.startswith("I'"):
                return "I'" + upper[2:].lower()
            return upper
        rank_match = _RANK_HYPHEN_RE.match(tok)
        if rank_match:
            return f"{rank_match.group(1).upper()}-{rank_match.group(2).lower()}"
        return tok

    return _WORD_RE.sub(_restore_token, sentence)


def clean_comic_ocr_text(lines: list[str]) -> str:
    """Merge lines, de-hyphenate, normalize ALL-CAPS lettering, and filter noise artifacts."""
    joined = _join_comic_lines(lines)
    if not joined:
        return ""

    # Filter pure punctuation / stray symbol SFX artifacts.
    alnum = re.sub(r"[^A-Za-z0-9]", "", joined)
    if not alnum:
        return ""
    if len(alnum) <= 2 and alnum.isalpha() and alnum.upper() not in _VALID_SHORT_WORDS:
        return ""

    return _normalize_all_caps_comic(joined)


def _sort_ocr_results(raw_results: list[Any]) -> list[str]:
    """Order RapidOCR polygon tuples top-to-bottom, left-to-right."""
    parsed: list[tuple[float, float, float, str]] = []
    for entry in raw_results:
        if not isinstance(entry, (list, tuple)) or len(entry) < 2:
            continue
        box = entry[0]
        text = str(entry[1]).strip()
        if not text:
            continue
        try:
            xs = [float(pt[0]) for pt in box]
            ys = [float(pt[1]) for pt in box]
            x1, y1, y2 = min(xs), min(ys), max(ys)
            h = max(1.0, y2 - y1)
        except Exception:
            x1, y1, h = 0.0, 0.0, 10.0
        parsed.append((y1, x1, h, text))

    if len(parsed) <= 1:
        return [item[3] for item in parsed]

    parsed.sort(key=lambda item: (item[0], item[1]))
    rows: list[list[tuple[float, float, float, str]]] = []
    for item in parsed:
        placed = False
        for row in rows:
            if any(abs(item[0] - peer[0]) < 0.5 * min(item[2], peer[2]) for peer in row):
                row.append(item)
                placed = True
                break
        if not placed:
            rows.append([item])

    rows.sort(key=lambda r: min(item[0] for item in r))
    ordered_lines: list[str] = []
    for row in rows:
        row.sort(key=lambda item: item[1])
        ordered_lines.append(" ".join(item[3] for item in row))
    return ordered_lines


class OcrEngine:
    """English OCR engine backed by RapidOCR ONNX Runtime strictly on CPU (0 GB VRAM)."""

    def __init__(self, *, padding_px: int = 8) -> None:
        self.padding_px = padding_px
        self._engine: Any | None = None

    def _ensure_loaded(self) -> Any:
        if self._engine is not None:
            return self._engine
        from rapidocr_onnxruntime import RapidOCR

        # Force CPU ONNX ExecutionProvider so OCR never competes with Typhoon 12B for GPU VRAM.
        self._engine = RapidOCR(
            det_use_cuda=False,
            cls_use_cuda=False,
            rec_use_cuda=False,
        )
        return self._engine

    def extract_text(self, crop_rgb: np.ndarray) -> str:
        """Run CPU RapidOCR on an RGB crop and return normalized English text."""
        if crop_rgb.ndim != 3 or crop_rgb.shape[0] < 2 or crop_rgb.shape[1] < 2:
            return ""

        pad = self.padding_px
        if pad > 0:
            border_color = np.median(crop_rgb[0, :, :], axis=0).astype(np.uint8)
            padded = np.full(
                (crop_rgb.shape[0] + 2 * pad, crop_rgb.shape[1] + 2 * pad, 3),
                border_color,
                dtype=np.uint8,
            )
            padded[pad : pad + crop_rgb.shape[0], pad : pad + crop_rgb.shape[1]] = crop_rgb
        else:
            padded = crop_rgb

        engine = self._ensure_loaded()
        bgr = padded[:, :, ::-1].copy()
        result, _elapse = engine(bgr)
        if not result:
            return ""

        lines = _sort_ocr_results(list(result))
        return clean_comic_ocr_text(lines)
