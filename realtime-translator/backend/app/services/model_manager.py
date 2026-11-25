"""GPU model lifecycle manager: lazy HF loading, 4-bit NF4, lock safety, idle unload."""

from __future__ import annotations

import asyncio
import gc
import os
import time
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from app.config import QuantizationMode, Settings
from app.errors import AppError
from app.schemas.system import ModelState, ModelStatusResponse, ModelUnloadResponse


@dataclass
class LoadedLLM:
    """Container holding a loaded Hugging Face model and tokenizer pair."""

    model: Any
    tokenizer: Any
    model_id: str
    quantization: QuantizationMode


class CudaOps(Protocol):
    """Abstraction over torch.cuda queries/cleanup for deterministic unit testing."""

    def is_available(self) -> bool: ...
    def device_name(self) -> str: ...
    def vram_allocated_mb(self) -> int: ...
    def vram_total_mb(self) -> int: ...
    def empty_cache(self) -> None: ...


class TorchCudaOps:
    """Production CUDA operations backed by PyTorch."""

    def is_available(self) -> bool:
        try:
            import torch

            return bool(torch.cuda.is_available())
        except Exception:
            return False

    def device_name(self) -> str:
        if not self.is_available():
            return "CPU"
        import torch

        return str(torch.cuda.get_device_name(0))

    def vram_allocated_mb(self) -> int:
        if not self.is_available():
            return 0
        import torch

        return int(torch.cuda.memory_allocated(0) // (1024 * 1024))

    def vram_total_mb(self) -> int:
        if not self.is_available():
            return 0
        import torch

        props = torch.cuda.get_device_properties(0)
        return int(props.total_memory // (1024 * 1024))

    def empty_cache(self) -> None:
        if not self.is_available():
            return
        import torch

        torch.cuda.empty_cache()
        if hasattr(torch.cuda, "ipc_collect"):
            torch.cuda.ipc_collect()


LoaderFn = Callable[[str, QuantizationMode, str], LoadedLLM]
GenerateFn = Callable[[LoadedLLM, list[dict[str, str]], int], str]


def _default_load_llm(
    model_id: str,
    quantization: QuantizationMode,
    hf_home: str,
) -> LoadedLLM:
    """Load a Hugging Face CausalLM with 4-bit NF4 (default), 8-bit, or BF16."""
    os.environ["HF_HOME"] = hf_home
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

    tokenizer = AutoTokenizer.from_pretrained(model_id)
    load_kwargs: dict[str, Any] = {"device_map": "auto"}

    if quantization == "4bit":
        load_kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        )
    elif quantization == "8bit":
        load_kwargs["quantization_config"] = BitsAndBytesConfig(load_in_8bit=True)
    else:
        load_kwargs["dtype"] = torch.bfloat16

    model = AutoModelForCausalLM.from_pretrained(model_id, **load_kwargs)
    model.eval()
    return LoadedLLM(
        model=model,
        tokenizer=tokenizer,
        model_id=model_id,
        quantization=quantization,
    )


def _default_generate(
    loaded: LoadedLLM,
    messages: list[dict[str, str]],
    max_new_tokens: int,
) -> str:
    """Run deterministic chat generation on the loaded Hugging Face model."""
    import torch

    tokenizer = loaded.tokenizer
    model = loaded.model

    if hasattr(tokenizer, "apply_chat_template") and getattr(
        tokenizer, "chat_template", None
    ):
        prompt = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )
    else:
        prompt = "\n\n".join(
            f"{msg['role'].upper()}:\n{msg['content']}" for msg in messages
        ) + "\n\nASSISTANT:\n"

    encoded = tokenizer(prompt, return_tensors="pt")
    device = getattr(model, "device", torch.device("cuda:0" if torch.cuda.is_available() else "cpu"))
    encoded = {k: v.to(device) for k, v in encoded.items()}
    input_len = int(encoded["input_ids"].shape[-1])

    pad_token_id = tokenizer.pad_token_id
    if pad_token_id is None:
        pad_token_id = tokenizer.eos_token_id

    with torch.inference_mode():
        output_ids = model.generate(
            **encoded,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            pad_token_id=pad_token_id,
        )

    generated_ids = output_ids[0][input_len:]
    return str(tokenizer.decode(generated_ids, skip_special_tokens=True)).strip()


def _is_cuda_oom(exc: BaseException) -> bool:
    name = type(exc).__name__.lower()
    if "outofmemory" in name:
        return True
    return "cuda out of memory" in str(exc).lower()


class ModelManager:
    """Coordinates lazy loading, serialized GPU inference, and VRAM unloading."""

    def __init__(
        self,
        settings: Settings,
        *,
        loader_fn: LoaderFn = _default_load_llm,
        generate_fn: GenerateFn = _default_generate,
        cuda_ops: CudaOps | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.settings = settings
        self._loader_fn = loader_fn
        self._generate_fn = generate_fn
        self._cuda = cuda_ops or TorchCudaOps()
        self._clock = clock

        self._gpu_lock = asyncio.Lock()
        self._state: ModelState = "unloaded"
        self._llm: LoadedLLM | None = None
        self._vision_model: Any | None = None
        self._last_used_at: float | None = None
        self._last_error: str | None = None

    @property
    def state(self) -> ModelState:
        return self._state

    @property
    def active_model_id(self) -> str:
        if self._llm is not None:
            return self._llm.model_id
        return self.settings.model_id

    @property
    def bubble_detector_loaded(self) -> bool:
        if self._vision_model is None:
            return False
        if hasattr(self._vision_model, "is_loaded"):
            return bool(self._vision_model.is_loaded)
        return True

    def set_vision_model(self, vision_model: Any | None) -> None:
        """Register or clear Phase 2 vision detector so unload frees it cleanly."""
        self._vision_model = vision_model

    def gpu_health(self) -> tuple[str, bool]:
        """Return (gpu_name, cuda_available) for GET /health."""
        return self._cuda.device_name(), self._cuda.is_available()

    def idle_seconds(self) -> int:
        if self._state != "loaded" or self._last_used_at is None:
            return 0
        return max(0, int(self._clock() - self._last_used_at))

    def status(self) -> ModelStatusResponse:
        return ModelStatusResponse(
            state=self._state,
            model_id=self.active_model_id,
            quantization=self.settings.quantization_mode,
            bubble_detector_loaded=self.bubble_detector_loaded,
            vram_allocated_mb=self._cuda.vram_allocated_mb(),
            vram_total_mb=self._cuda.vram_total_mb(),
            idle_seconds=self.idle_seconds(),
            idle_unload_minutes=self.settings.idle_unload_minutes,
            last_error=self._last_error,
        )

    async def load(
        self,
        model_id: str | None = None,
        *,
        load_vision: bool = False,
    ) -> ModelStatusResponse:
        """Explicitly load (or reload with a new model_id) the LLM onto GPU."""
        target_model_id = model_id or self.settings.model_id
        if self._state == "loading":
            raise AppError(
                code="MODEL_LOADING",
                message="Translation model is currently loading onto GPU. Retry shortly.",
                status_code=503,
                retryable=True,
            )

        async with self._gpu_lock:
            if self._llm is not None and self._llm.model_id == target_model_id:
                self._last_used_at = self._clock()
                self._state = "loaded"
                if load_vision and self._vision_model is not None and hasattr(self._vision_model, "load"):
                    await asyncio.to_thread(self._vision_model.load)
                return self.status()

            if self._llm is not None:
                self._unload_locked()

            self.settings.model_id = target_model_id
            await self._load_llm_locked(target_model_id)
            if load_vision and self._vision_model is not None and hasattr(self._vision_model, "load"):
                await asyncio.to_thread(self._vision_model.load)
            return self.status()

    async def _load_llm_locked(self, target_model_id: str) -> None:
        self._state = "loading"
        self._last_error = None
        try:
            loaded = await asyncio.to_thread(
                self._loader_fn,
                target_model_id,
                self.settings.quantization_mode,
                self.settings.hf_home,
            )
        except Exception as exc:
            self._llm = None
            self._state = "error"
            self._last_error = str(exc)
            if _is_cuda_oom(exc):
                gc.collect()
                self._cuda.empty_cache()
                raise AppError(
                    code="CUDA_OOM",
                    message=(
                        "GPU memory exhausted while loading model. "
                        "Close other GPU apps or try a smaller model."
                    ),
                    status_code=503,
                    retryable=True,
                ) from exc
            raise AppError(
                code="TRANSLATION_ERROR",
                message=f"Failed to load model '{target_model_id}': {exc}",
                status_code=500,
                retryable=True,
            ) from exc

        self._llm = loaded
        self._state = "loaded"
        self._last_used_at = self._clock()

    async def generate(
        self,
        messages: list[dict[str, str]],
        *,
        max_new_tokens: int = 1024,
    ) -> str:
        """Run serialized GPU text generation, lazy-loading the LLM if needed."""
        if self._state == "loading":
            raise AppError(
                code="MODEL_LOADING",
                message="Translation model is currently loading onto GPU. Retry shortly.",
                status_code=503,
                retryable=True,
            )

        async with self._gpu_lock:
            if self._llm is None:
                await self._load_llm_locked(self.settings.model_id)

            assert self._llm is not None
            try:
                output = await asyncio.to_thread(
                    self._generate_fn,
                    self._llm,
                    messages,
                    max_new_tokens,
                )
            except Exception as exc:
                if _is_cuda_oom(exc):
                    gc.collect()
                    self._cuda.empty_cache()
                    self._last_error = str(exc)
                    raise AppError(
                        code="CUDA_OOM",
                        message=(
                            "GPU memory exhausted during translation. "
                            "Cache cleared; retry with a smaller batch or unload other GPU apps."
                        ),
                        status_code=503,
                        retryable=True,
                    ) from exc
                self._last_error = str(exc)
                raise AppError(
                    code="TRANSLATION_ERROR",
                    message=f"Translation inference error: {exc}",
                    status_code=500,
                    retryable=True,
                ) from exc

            self._last_used_at = self._clock()
            self._last_error = None
            return output

    def _unload_locked(self) -> None:
        self._state = "unloading"
        self._llm = None
        if self._vision_model is not None and hasattr(self._vision_model, "unload"):
            self._vision_model.unload()
        self._vision_model = None
        gc.collect()
        self._cuda.empty_cache()
        self._last_used_at = None
        self._state = "unloaded"

    async def unload(self) -> ModelUnloadResponse:
        """Immediately free LLM and vision weights from GPU VRAM."""
        async with self._gpu_lock:
            self._unload_locked()
            return ModelUnloadResponse(
                state=self._state,
                vram_allocated_mb=self._cuda.vram_allocated_mb(),
                vram_total_mb=self._cuda.vram_total_mb(),
            )

    async def unload_if_idle(self) -> bool:
        """Unload GPU models if idle duration reached IDLE_UNLOAD_MINUTES."""
        if self._state != "loaded" or self._last_used_at is None:
            return False
        threshold_sec = self.settings.idle_unload_minutes * 60
        if (self._clock() - self._last_used_at) < threshold_sec:
            return False

        async with self._gpu_lock:
            if self._state != "loaded" or self._last_used_at is None:
                return False
            if (self._clock() - self._last_used_at) < threshold_sec:
                return False
            self._unload_locked()
            return True
