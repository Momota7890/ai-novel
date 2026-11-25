"""Overlapping vertical strip slicing, cross-seam box merging, and LTR reading order."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SliceWindow:
    """Horizontal band [y_start, y_end) extracted from a tall vertical strip."""

    index: int
    y_start: int
    y_end: int

    @property
    def height(self) -> int:
        return self.y_end - self.y_start


@dataclass(frozen=True)
class DetectedBox:
    """Pixel-space speech bubble or narration bounding box on the full strip."""

    x1: float
    y1: float
    x2: float
    y2: float
    confidence: float = 1.0
    class_name: str = "bubble"
    slice_index: int = 0

    @property
    def width(self) -> float:
        return max(0.0, self.x2 - self.x1)

    @property
    def height(self) -> float:
        return max(0.0, self.y2 - self.y1)

    @property
    def area(self) -> float:
        return self.width * self.height


def slice_vertical_strip(
    width: int,
    height: int,
    *,
    slice_height: int = 1400,
    overlap: int = 250,
    aspect_ratio_threshold: float = 1.8,
) -> list[SliceWindow]:
    """Split tall vertical webtoon strips (height > 1.8 * width) into overlapping bands."""
    if width <= 0 or height <= 0:
        raise ValueError(f"Invalid image dimensions: {width}x{height}")
    if slice_height <= overlap:
        raise ValueError("slice_height must be strictly greater than overlap")

    if height <= int(width * aspect_ratio_threshold) or height <= slice_height:
        return [SliceWindow(index=0, y_start=0, y_end=height)]

    step = slice_height - overlap
    windows: list[SliceWindow] = []
    y_start = 0
    idx = 0

    while y_start < height:
        y_end = min(height, y_start + slice_height)
        if y_end == height:
            clamped_start = max(0, height - slice_height)
            if windows and clamped_start == windows[-1].y_start:
                break
            windows.append(SliceWindow(index=idx, y_start=clamped_start, y_end=height))
            break

        windows.append(SliceWindow(index=idx, y_start=y_start, y_end=y_end))
        idx += 1
        y_start += step

    return windows


def intersection_area(a: DetectedBox, b: DetectedBox) -> float:
    ix1 = max(a.x1, b.x1)
    iy1 = max(a.y1, b.y1)
    ix2 = min(a.x2, b.x2)
    iy2 = min(a.y2, b.y2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    return (ix2 - ix1) * (iy2 - iy1)


def compute_iou(a: DetectedBox, b: DetectedBox) -> float:
    inter = intersection_area(a, b)
    if inter <= 0.0:
        return 0.0
    union = a.area + b.area - inter
    return inter / union if union > 0.0 else 0.0


def compute_max_containment(a: DetectedBox, b: DetectedBox) -> float:
    """Fraction of the smaller box enclosed by the larger box."""
    min_area = min(a.area, b.area)
    if min_area <= 0.0:
        return 0.0
    return intersection_area(a, b) / min_area


def _is_cross_slice_seam_pair(a: DetectedBox, b: DetectedBox) -> bool:
    """Detect two boxes from adjacent slices that represent the same bubble across a seam."""
    if abs(a.slice_index - b.slice_index) != 1:
        return False
    x_overlap = max(0.0, min(a.x2, b.x2) - max(a.x1, b.x1))
    min_w = min(a.width, b.width)
    if min_w <= 0.0 or (x_overlap / min_w) < 0.70:
        return False
    y_overlap = max(0.0, min(a.y2, b.y2) - max(a.y1, b.y1))
    min_h = min(a.height, b.height)
    return min_h > 0.0 and (y_overlap / min_h) >= 0.25


def _merge_two_boxes(a: DetectedBox, b: DetectedBox) -> DetectedBox:
    containment = compute_max_containment(a, b)
    larger, smaller = (a, b) if a.area >= b.area else (b, a)

    # If the larger detection almost wholly contains a seam-clipped fragment, keep the clean box.
    if containment >= 0.85 and smaller.area > 0 and (larger.area / smaller.area) >= 1.2:
        return DetectedBox(
            x1=larger.x1,
            y1=larger.y1,
            x2=larger.x2,
            y2=larger.y2,
            confidence=max(a.confidence, b.confidence),
            class_name=larger.class_name,
            slice_index=larger.slice_index,
        )

    return DetectedBox(
        x1=min(a.x1, b.x1),
        y1=min(a.y1, b.y1),
        x2=max(a.x2, b.x2),
        y2=max(a.y2, b.y2),
        confidence=max(a.confidence, b.confidence),
        class_name=larger.class_name,
        slice_index=min(a.slice_index, b.slice_index),
    )


def merge_cross_slice_boxes(
    boxes: list[DetectedBox],
    *,
    iou_threshold: float = 0.45,
    containment_threshold: float = 0.70,
) -> list[DetectedBox]:
    """Deduplicate and merge overlapping or seam-straddling bubble detections across slices."""
    valid = [b for b in boxes if b.width > 1.0 and b.height > 1.0]
    if len(valid) <= 1:
        return valid

    # Anchor merges on larger, higher-confidence detections first.
    current = sorted(
        valid,
        key=lambda b: b.area * (0.5 + 0.5 * b.confidence),
        reverse=True,
    )

    changed = True
    while changed:
        changed = False
        merged: list[DetectedBox] = []
        used = [False] * len(current)

        for i, box_i in enumerate(current):
            if used[i]:
                continue
            acc = box_i
            used[i] = True
            for j in range(i + 1, len(current)):
                if used[j]:
                    continue
                box_j = current[j]
                if (
                    compute_iou(acc, box_j) >= iou_threshold
                    or compute_max_containment(acc, box_j) >= containment_threshold
                    or _is_cross_slice_seam_pair(acc, box_j)
                ):
                    acc = _merge_two_boxes(acc, box_j)
                    used[j] = True
                    changed = True
            merged.append(acc)

        current = merged

    return current


def sort_manhwa_reading_order(boxes: list[DetectedBox]) -> list[DetectedBox]:
    """Sort bubbles in vertical manhwa reading order: top-to-bottom, then left-to-right."""
    if len(boxes) <= 1:
        return list(boxes)

    by_top = sorted(boxes, key=lambda b: (b.y1, b.x1))
    rows: list[list[DetectedBox]] = []

    for box in by_top:
        placed = False
        for row in rows:
            # ARCHITECTURE.md rule: boxes share a row if abs(y1_a - y1_b) < 0.4 * min(h_a, h_b).
            if any(
                abs(box.y1 - peer.y1) < 0.4 * min(box.height, peer.height)
                for peer in row
            ):
                row.append(box)
                placed = True
                break
        if not placed:
            rows.append([box])

    rows.sort(key=lambda row: min(b.y1 for b in row))
    ordered: list[DetectedBox] = []
    for row in rows:
        row.sort(key=lambda b: (b.x1, b.y1))
        ordered.extend(row)
    return ordered


def normalize_bbox(
    box: DetectedBox,
    image_width: int,
    image_height: int,
) -> tuple[float, float, float, float]:
    """Convert pixel bbox into normalized [0.0 .. 1.0] coordinates."""
    if image_width <= 0 or image_height <= 0:
        raise ValueError(f"Invalid image dimensions: {image_width}x{image_height}")

    x1 = max(0.0, min(1.0, box.x1 / image_width))
    y1 = max(0.0, min(1.0, box.y1 / image_height))
    x2 = max(x1, min(1.0, box.x2 / image_width))
    y2 = max(y1, min(1.0, box.y2 / image_height))
    return (round(x1, 4), round(y1, 4), round(x2, 4), round(y2, 4))
