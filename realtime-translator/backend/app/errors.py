"""Standardized API error codes, exception type, and FastAPI error handlers."""

from __future__ import annotations

from typing import Literal

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

ErrorCode = Literal[
    "INVALID_REQUEST",
    "NOT_FOUND",
    "IMAGE_DECODE_ERROR",
    "MODEL_LOADING",
    "CUDA_OOM",
    "TRANSLATION_ERROR",
]


class AppError(Exception):
    """Domain error mapped directly to the API_CONTRACT.md error envelope."""

    def __init__(
        self,
        code: ErrorCode,
        message: str,
        status_code: int,
        retryable: bool,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.retryable = retryable


def _envelope(code: ErrorCode, message: str, retryable: bool) -> dict[str, dict[str, object]]:
    return {
        "error": {
            "code": code,
            "message": message,
            "retryable": retryable,
        }
    }


def register_exception_handlers(app: FastAPI) -> None:
    """Attach standardized JSON error envelope handlers to a FastAPI app."""

    @app.exception_handler(AppError)
    async def handle_app_error(_request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=_envelope(exc.code, exc.message, exc.retryable),
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        parts: list[str] = []
        for err in exc.errors():
            loc = ".".join(str(item) for item in err.get("loc", ()) if item != "body")
            msg = str(err.get("msg", "Invalid value"))
            parts.append(f"{loc}: {msg}" if loc else msg)
        summary = "; ".join(parts) or "Malformed request payload."
        return JSONResponse(
            status_code=400,
            content=_envelope("INVALID_REQUEST", summary, False),
        )

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_exception(
        _request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        code: ErrorCode
        retryable = False
        if exc.status_code == 404:
            code = "NOT_FOUND"
        elif exc.status_code == 422:
            code = "IMAGE_DECODE_ERROR"
        elif exc.status_code == 503:
            code = "MODEL_LOADING"
            retryable = True
        elif exc.status_code >= 500:
            code = "TRANSLATION_ERROR"
            retryable = True
        else:
            code = "INVALID_REQUEST"
        return JSONResponse(
            status_code=exc.status_code,
            content=_envelope(code, str(exc.detail), retryable),
        )

    @app.exception_handler(Exception)
    async def handle_unexpected_error(_request: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content=_envelope(
                "TRANSLATION_ERROR",
                f"Unexpected server error: {exc}",
                True,
            ),
        )
