"""YOLOv8 speech-bubble detector (dialogue & narration only) + interior color classifier."""

from __future__ import annotations

import gc
import os
from dataclasses import dataclass
from typing import Any

import numpy as np

from app.schemas.manhwa import RenderMode
from app.services.strip_slicer import DetectedBox

_EXCLUDED_CLASS_KEYWORDS = ("sfx", "sound", "onomatopoeia")


@dataclass(frozen=True)
class BubbleStyle:
    render_mode: RenderMode
    bg_color: str
    text_color: str


def _relative_luminance(r: float, g: float, b: float) -> float:
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _rgb_to_hex(rgb: np.ndarray) -> str:
    r, g, b = (int(np.clip(round(float(c)), 0, 255)) for c in rgb)
    return f"#{r:02X}{g:02X}{b:02X}"


def classify_bubble_style(
    crop_rgb: np.ndarray,
    *,
    variance_threshold: float = 28.0,
) -> BubbleStyle:
    """Classify bubble interior into auto-colored solid mask vs. translucent floating pill.

    Samples an inset perimeter ring inside the bubble crop (avoiding outer borders and
    interior text strokes by rejecting the 25% furthest RGB outliers from the median).
    """
    if crop_rgb.ndim != 3 or crop_rgb.shape[0] < 4 or crop_rgb.shape[1] < 4:
        return BubbleStyle(
            render_mode="pill",
            bg_color="rgba(18, 18, 22, 0.84)",
            text_color="#FFFFFF",
        )

    h, w, _ = crop_rgb.shape
    outer_y = max(1, int(round(h * 0.08)))
    outer_x = max(1, int(round(w * 0.08)))
    inner_y = max(outer_y + 1, int(round(h * 0.24)))
    inner_x = max(outer_x + 1, int(round(w * 0.24)))

    mask = np.zeros((h, w), dtype=bool)
    mask[outer_y : max(outer_y + 1, h - outer_y), outer_x : max(outer_x + 1, w - outer_x)] = True
    if inner_y < h - inner_y and inner_x < w - inner_x:
        mask[inner_y : h - inner_y, inner_x : w - inner_x] = False

    ring_pixels = crop_rgb[mask].astype(np.float32)
    if ring_pixels.shape[0] < 8:
        ring_pixels = crop_rgb.reshape(-1, 3).astype(np.float32)

    median_rgb = np.median(ring_pixels, axis=0)
    distances = np.linalg.norm(ring_pixels - median_rgb, axis=1)
    cutoff = float(np.quantile(distances, 0.75))
    inliers = ring_pixels[distances <= cutoff]
    if inliers.shape[0] < 4:
        inliers = ring_pixels

    rms_std = float(np.sqrt(np.mean(np.var(inliers, axis=0))))
    dominant_rgb = np.median(inliers, axis=0)
    lum = _relative_luminance(
        float(dominant_rgb[0]),
        float(dominant_rgb[1]),
        float(dominant_rgb[2]),
    )

    if rms_std <= variance_threshold:
        bg_hex = _rgb_to_hex(dominant_rgb)
        text_color = "#111111" if lum >= 135.0 else "#FFFFFF"
        return BubbleStyle(
            render_mode="mask",
            bg_color=bg_hex,
            text_color=text_color,
        )

    # High-variance detailed artwork underneath text -> subtle translucent floating pill.
    if lum < 55.0:
        return BubbleStyle(
            render_mode="pill",
            bg_color="rgba(250, 250, 252, 0.88)",
            text_color="#111111",
        )
    return BubbleStyle(
        render_mode="pill",
        bg_color="rgba(18, 18, 22, 0.84)",
        text_color="#FFFFFF",
    )


def _is_dialogue_or_narration_class(class_name: str) -> bool:
    lowered = class_name.strip().lower()
    return not any(keyword in lowered for keyword in _EXCLUDED_CLASS_KEYWORDS)


class BubbleDetector:
    """Lazy Hugging Face YOLOv8 speech-bubble detector (dialogue & narration only)."""

    def __init__(
        self,
        repo_id: str,
        hf_home: str,
        *,
        conf_threshold: float = 0.28,
        imgsz: int = 1024,
        prefer_cuda: bool = True,
    ) -> None:
        self.repo_id = repo_id
        self.hf_home = hf_home
        self.conf_threshold = conf_threshold
        self.imgsz = imgsz
        self.prefer_cuda = prefer_cuda
        self._model: Any | None = None
        self._device: str = "cpu"

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    def _resolve_weights_path(self) -> str:
        os.environ["HF_HOME"] = self.hf_home
        os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
        from huggingface_hub import hf_hub_download, list_repo_files

        files = list_repo_files(self.repo_id)
        pt_files = [f for f in files if f.lower().endswith(".pt")]
        if not pt_files:
            raise RuntimeError(
                f"No .pt YOLOv8 weights found in Hugging Face repo '{self.repo_id}'."
            )
        preferred = next(
            (f for f in pt_files if "bubble" in f.lower() or "best" in f.lower()),
            pt_files[0],
        )
        return str(hf_hub_download(repo_id=self.repo_id, filename=preferred))

    def load(self) -> None:
        if self._model is not None:
            return
        os.environ.setdefault("YOLO_CONFIG_DIR", os.path.join(self.hf_home, "ultralytics"))
        import torch
        from ultralytics import YOLO

        weights_path = self._resolve_weights_path()
        self._device = "cuda:0" if (self.prefer_cuda and torch.cuda.is_available()) else "cpu"
        self._model = YOLO(weights_path)

    def detect_slice(
        self,
        slice_rgb: np.ndarray,
        *,
        y_offset: int,
        slice_index: int,
    ) -> list[DetectedBox]:
        """Detect speech/narration bubbles in a single slice and map to full-strip coords."""
        if self._model is None:
            self.load()
        assert self._model is not None

        # Ultralytics accepts BGR numpy arrays cleanly when converted from RGB.
        slice_bgr = slice_rgb[:, :, ::-1].copy()
        results = self._model.predict(
            source=slice_bgr,
            conf=self.conf_threshold,
            imgsz=self.imgsz,
            device=self._device,
            half=(self._device.startswith("cuda")),
            verbose=False,
        )

        boxes_out: list[DetectedBox] = []
        for result in results:
            names = getattr(result, "names", {}) or {}
            boxes = getattr(result, "boxes", None)
            if boxes is None or len(boxes) == 0:
                continue

            xyxy_list = boxes.xyxy.cpu().tolist()
            conf_list = boxes.conf.cpu().tolist()
            cls_list = boxes.cls.cpu().tolist()

            for xyxy, conf, cls_idx in zip(xyxy_list, conf_list, cls_list):
                class_name = str(names.get(int(cls_idx), "bubble"))
                if not _is_dialogue_or_narration_class(class_name):
                    continue
                x1, y1, x2, y2 = (float(v) for v in xyxy)
                boxes_out.append(
                    DetectedBox(
                        x1=x1,
                        y1=y1 + y_offset,
                        x2=x2,
                        y2=y2 + y_offset,
                        confidence=float(conf),
                        class_name=class_name,
                        slice_index=slice_index,
                    )
                )
        return boxes_out

    def unload(self) -> None:
        """Release YOLOv8 model weights from VRAM/RAM."""
        self._model = None
        gc.collect()
