"""Tests for bubble fill/pill color classification and English comic OCR normalization."""

from __future__ import annotations

import numpy as np

from app.services.bubble_detector import classify_bubble_style
from app.services.ocr_engine import clean_comic_ocr_text


def test_classify_solid_white_bubble_with_black_text_as_mask() -> None:
    crop = np.full((120, 220, 3), 255, dtype=np.uint8)
    # Draw simulated black border + black interior text strokes.
    crop[:4, :, :] = 10
    crop[-4:, :, :] = 10
    crop[45:75, 50:170, :] = 15

    style = classify_bubble_style(crop)
    assert style.render_mode == "mask"
    assert style.bg_color == "#FFFFFF"
    assert style.text_color == "#111111"


def test_classify_solid_dark_bubble_as_mask_with_light_text() -> None:
    crop = np.full((120, 200, 3), 20, dtype=np.uint8)
    crop[50:70, 40:160, :] = 245  # White interior dialogue text.

    style = classify_bubble_style(crop)
    assert style.render_mode == "mask"
    assert style.bg_color == "#141414"
    assert style.text_color == "#FFFFFF"


def test_classify_tinted_pastel_bubble_as_mask() -> None:
    crop = np.zeros((100, 180, 3), dtype=np.uint8)
    crop[:, :, 0] = 250
    crop[:, :, 1] = 230
    crop[:, :, 2] = 240
    crop[40:60, 40:140, :] = 30

    style = classify_bubble_style(crop)
    assert style.render_mode == "mask"
    assert style.bg_color == "#FAE6F0"
    assert style.text_color == "#111111"


def test_classify_high_variance_artwork_as_translucent_pill() -> None:
    rng = np.random.default_rng(42)
    crop = rng.integers(0, 256, size=(120, 220, 3), dtype=np.uint8)

    style = classify_bubble_style(crop)
    assert style.render_mode == "pill"
    assert style.bg_color.startswith("rgba(")
    assert style.text_color in {"#FFFFFF", "#111111"}


def test_ocr_text_dehyphenates_normalizes_all_caps_and_preserves_ranks() -> None:
    lines = ["WAIT... IS THAT", "AN UN-", "BELIEVABLE E-", "RANK HUNTER?!"]
    cleaned = clean_comic_ocr_text(lines)
    assert cleaned == "Wait... Is that an unbelievable E-rank hunter?!"

    lines2 = ["I'M LOW ON HP AND MP!", "NPC ALERT!"]
    cleaned2 = clean_comic_ocr_text(lines2)
    assert cleaned2 == "I'm low on HP and MP! NPC alert!"


def test_ocr_text_filters_empty_and_sfx_symbol_noise() -> None:
    assert clean_comic_ocr_text(["", "   "]) == ""
    assert clean_comic_ocr_text(["!!!", "..."]) == ""
    assert clean_comic_ocr_text(["*#"]) == ""
    assert clean_comic_ocr_text(["zz"]) == ""
    # Valid short English words must survive.
    assert clean_comic_ocr_text(["NO!"]) == "NO!"
    assert clean_comic_ocr_text(["OK"]) == "OK"
