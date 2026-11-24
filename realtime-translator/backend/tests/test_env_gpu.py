"""Phase 0 environment, CUDA PyTorch, and bitsandbytes 4-bit smoke tests."""

from __future__ import annotations

import importlib
import os
import uuid
from pathlib import Path

import pytest


def test_core_imports() -> None:
    """Verify all Phase 0/1 core backend dependencies import cleanly."""
    modules = [
        "fastapi",
        "uvicorn",
        "pydantic",
        "pydantic_settings",
        "transformers",
        "accelerate",
        "huggingface_hub",
        "PIL",
        "numpy",
        "httpx",
    ]
    for module_name in modules:
        importlib.import_module(module_name)

    import transformers

    major, minor = (int(part) for part in transformers.__version__.split(".")[:2])
    assert (major, minor) >= (4, 50), (
        f"transformers>=4.50.0 is required for gemma3; found {transformers.__version__}"
    )


@pytest.mark.gpu
def test_cuda_torch_inherited() -> None:
    """Confirm .venv inherits global CUDA 12.8 PyTorch without shadowing it."""
    import torch

    assert torch.cuda.is_available(), "CUDA is not available in backend\\.venv"
    assert "+cu128" in torch.__version__, f"Expected CUDA 12.8 torch, got {torch.__version__}"
    device_name = torch.cuda.get_device_name(0)
    assert device_name, "No CUDA GPU device name reported"

    torch_path = Path(torch.__file__).resolve()
    venv_root = Path(__file__).resolve().parents[1] / ".venv"
    assert venv_root not in torch_path.parents, (
        f"torch appears installed inside .venv ({torch_path}); "
        "it must inherit global CUDA PyTorch via --system-site-packages."
    )


@pytest.mark.gpu
def test_bitsandbytes_nf4_cuda() -> None:
    """Verify 4-bit NF4 Linear4bit forward pass runs cleanly on local CUDA GPU."""
    import bitsandbytes as bnb
    import torch

    assert torch.cuda.is_available(), "CUDA required for bitsandbytes NF4 smoke test"

    layer = bnb.nn.Linear4bit(
        64,
        64,
        bias=False,
        compute_dtype=torch.bfloat16,
        compress_statistics=True,
        quant_type="nf4",
    ).to("cuda:0")

    x = torch.randn(2, 64, device="cuda:0", dtype=torch.bfloat16)
    with torch.no_grad():
        y = layer(x)

    assert y.shape == (2, 64)
    assert y.device.type == "cuda"
    assert torch.isfinite(y).all(), "Non-finite output from Linear4bit NF4 forward pass"

    del layer, x, y
    torch.cuda.empty_cache()


@pytest.mark.gpu
def test_hf_cache_writable() -> None:
    """Verify HF_HOME directory exists and allows writing/removing a temp probe file."""
    hf_home = Path(os.environ.get("HF_HOME", r"D:\hf_cache"))
    assert hf_home.exists() and hf_home.is_dir(), (
        f"HF_HOME directory does not exist: {hf_home}"
    )

    probe = hf_home / f".rt_write_probe_{uuid.uuid4().hex}.tmp"
    try:
        probe.write_text("ok", encoding="utf-8")
        assert probe.read_text(encoding="utf-8") == "ok"
    finally:
        if probe.exists():
            probe.unlink()
