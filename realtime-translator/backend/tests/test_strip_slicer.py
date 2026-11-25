"""Tests for overlapping vertical strip slicing, cross-seam merging, and LTR reading order."""

from __future__ import annotations

import pytest

from app.services.strip_slicer import (
    DetectedBox,
    merge_cross_slice_boxes,
    normalize_bbox,
    slice_vertical_strip,
    sort_manhwa_reading_order,
)


def test_non_tall_image_stays_single_slice() -> None:
    windows = slice_vertical_strip(width=800, height=1200)
    assert len(windows) == 1
    assert (windows[0].y_start, windows[0].y_end) == (0, 1200)


def test_tall_strip_slices_with_exact_overlap_and_full_coverage() -> None:
    windows = slice_vertical_strip(width=800, height=6400, slice_height=1400, overlap=250)
    assert len(windows) >= 5
    assert windows[0].y_start == 0
    assert windows[-1].y_end == 6400

    # Verify consecutive slices overlap by at least 250px with zero gaps.
    for prev, nxt in zip(windows, windows[1:]):
        assert nxt.y_start < prev.y_end
        assert (prev.y_end - nxt.y_start) >= 250
        assert prev.height <= 1400


def test_cross_slice_merge_deduplicates_seam_straddling_bubbles() -> None:
    # Bubble A straddles seam around y=1350: clipped in slice 0, full in slice 1.
    clipped_slice0 = DetectedBox(100, 1280, 360, 1400, confidence=0.72, slice_index=0)
    full_slice1 = DetectedBox(98, 1275, 365, 1490, confidence=0.91, slice_index=1)
    # Bubble B is a separate bubble lower down in slice 1.
    separate = DetectedBox(420, 1520, 720, 1700, confidence=0.88, slice_index=1)

    merged = merge_cross_slice_boxes([clipped_slice0, full_slice1, separate])
    assert len(merged) == 2

    top_box = min(merged, key=lambda b: b.y1)
    assert top_box.y1 == pytest.approx(1275, abs=5)
    assert top_box.y2 == pytest.approx(1490, abs=5)
    assert top_box.confidence == pytest.approx(0.91)


def test_manhwa_reading_order_is_top_to_bottom_then_left_to_right() -> None:
    # Row 1: two bubbles roughly at the same y (~100), right one appears first in input.
    row1_right = DetectedBox(460, 108, 720, 240)
    row1_left = DetectedBox(80, 100, 340, 230)
    # Row 2: centered lower bubble.
    row2_mid = DetectedBox(240, 420, 560, 560)
    # Row 3: two side-by-side bubbles.
    row3_right = DetectedBox(500, 755, 760, 880)
    row3_left = DetectedBox(60, 740, 320, 870)

    ordered = sort_manhwa_reading_order(
        [row3_right, row1_right, row2_mid, row3_left, row1_left]
    )
    assert ordered == [row1_left, row1_right, row2_mid, row3_left, row3_right]


def test_normalize_bbox_clamps_to_unit_interval() -> None:
    box = DetectedBox(-12.0, 50.0, 820.0, 2100.0)
    norm = normalize_bbox(box, image_width=800, image_height=2000)
    assert norm == (0.0, 0.025, 1.0, 1.0)
    assert all(0.0 <= coord <= 1.0 for coord in norm)
