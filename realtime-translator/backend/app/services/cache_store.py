"""Bounded server-side SQLite LRU cache (text & normalized box JSON only)."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Callable, Literal

from app.schemas.system import CacheClearResponse, CacheStatsResponse

CacheMode = Literal["novel", "manhwa", "snip"]

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS translation_cache (
    cache_key       TEXT PRIMARY KEY,
    mode            TEXT NOT NULL,
    payload_json    TEXT NOT NULL,
    byte_size       INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    last_accessed   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_lru ON translation_cache(last_accessed ASC);
CREATE INDEX IF NOT EXISTS idx_cache_created ON translation_cache(created_at ASC);

CREATE TABLE IF NOT EXISTS glossaries (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    url_pattern     TEXT DEFAULT '',
    default_preset  TEXT DEFAULT 'modern_manhwa',
    updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS glossary_entries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    glossary_id     TEXT NOT NULL REFERENCES glossaries(id) ON DELETE CASCADE,
    source_term     TEXT NOT NULL,
    target_term     TEXT NOT NULL,
    category        TEXT NOT NULL DEFAULT 'term',
    note            TEXT DEFAULT ''
);
"""


def normalize_text_for_cache(text: str) -> str:
    """Normalize line endings and surrounding whitespace for stable cache keys."""
    return text.replace("\r\n", "\n").replace("\r", "\n").strip()


def compute_content_hash(content: str | bytes) -> str:
    """Return SHA-256 hex digest of normalized text or raw image bytes."""
    raw = (
        normalize_text_for_cache(content).encode("utf-8")
        if isinstance(content, str)
        else content
    )
    return hashlib.sha256(raw).hexdigest()


def compute_cache_key(
    mode: CacheMode,
    content_hash: str,
    model_id: str,
    preset: str,
    glossary_hash: str = "none",
) -> str:
    """Build deterministic SHA-256 cache key matching ARCHITECTURE.md."""
    composite = f"{mode}|{content_hash}|{model_id}|{preset}|{glossary_hash}"
    return hashlib.sha256(composite.encode("utf-8")).hexdigest()


class CacheStore:
    """SQLite WAL-backed bounded LRU + TTL translation cache."""

    def __init__(
        self,
        db_path: Path,
        max_mb: int = 50,
        ttl_days: int = 30,
        *,
        max_bytes_override: int | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.db_path = db_path
        self.max_mb = max_mb
        self.ttl_days = ttl_days
        self._max_bytes_override = max_bytes_override
        self._clock = clock
        self._lock = threading.Lock()
        self._session_hits = 0
        self._session_misses = 0
        self._last_ttl_prune = 0.0

        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._initialize()

    @property
    def max_bytes(self) -> int:
        if self._max_bytes_override is not None:
            return self._max_bytes_override
        return self.max_mb * 1024 * 1024

    def _initialize(self) -> None:
        with self._lock:
            self._conn.execute("PRAGMA auto_vacuum = INCREMENTAL;")
            self._conn.execute("PRAGMA journal_mode = WAL;")
            self._conn.execute("PRAGMA synchronous = NORMAL;")
            self._conn.execute("PRAGMA foreign_keys = ON;")
            self._conn.executescript(_SCHEMA_SQL)
            self._prune_expired_locked(force=True)
            self._conn.commit()

    def update_limits(self, max_mb: int, ttl_days: int) -> None:
        """Apply updated runtime cache size/TTL limits and prune immediately."""
        with self._lock:
            self.max_mb = max_mb
            self.ttl_days = ttl_days
            self._prune_expired_locked(force=True)
            self._evict_to_cap_locked()
            self._conn.commit()

    def get(self, cache_key: str) -> dict[str, Any] | None:
        """Fetch a cached JSON payload by key, touching LRU timestamp on hit."""
        now = int(self._clock())
        ttl_seconds = self.ttl_days * 86400

        with self._lock:
            row = self._conn.execute(
                "SELECT payload_json, created_at FROM translation_cache WHERE cache_key = ?",
                (cache_key,),
            ).fetchone()

            if row is None:
                self._session_misses += 1
                return None

            if now - int(row["created_at"]) > ttl_seconds:
                self._conn.execute(
                    "DELETE FROM translation_cache WHERE cache_key = ?",
                    (cache_key,),
                )
                self._conn.commit()
                self._session_misses += 1
                return None

            self._conn.execute(
                "UPDATE translation_cache SET last_accessed = ? WHERE cache_key = ?",
                (now, cache_key),
            )
            self._conn.commit()
            self._session_hits += 1
            return json.loads(str(row["payload_json"]))

    def put(self, cache_key: str, mode: CacheMode, payload: dict[str, Any]) -> None:
        """Store compact JSON payload and enforce TTL + LRU size cap."""
        now = int(self._clock())
        payload_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        byte_size = len(payload_json.encode("utf-8"))

        with self._lock:
            self._conn.execute(
                """
                INSERT INTO translation_cache
                    (cache_key, mode, payload_json, byte_size, created_at, last_accessed)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET
                    mode = excluded.mode,
                    payload_json = excluded.payload_json,
                    byte_size = excluded.byte_size,
                    created_at = excluded.created_at,
                    last_accessed = excluded.last_accessed
                """,
                (cache_key, mode, payload_json, byte_size, now, now),
            )
            self._prune_expired_locked(force=False)
            self._evict_to_cap_locked()
            self._conn.commit()

    def _prune_expired_locked(self, *, force: bool) -> int:
        now_f = self._clock()
        if not force and (now_f - self._last_ttl_prune) < 60.0:
            return 0
        self._last_ttl_prune = now_f
        cutoff = int(now_f) - (self.ttl_days * 86400)
        cursor = self._conn.execute(
            "DELETE FROM translation_cache WHERE created_at < ?",
            (cutoff,),
        )
        return cursor.rowcount

    def _evict_to_cap_locked(self) -> int:
        row = self._conn.execute(
            "SELECT COALESCE(SUM(byte_size), 0) AS total_bytes FROM translation_cache"
        ).fetchone()
        total_bytes = int(row["total_bytes"]) if row is not None else 0
        cap = self.max_bytes
        if total_bytes <= cap:
            return 0

        target_bytes = int(cap * 0.85)
        rows = self._conn.execute(
            """
            SELECT cache_key, byte_size
            FROM translation_cache
            ORDER BY last_accessed ASC, rowid ASC
            """
        ).fetchall()

        keys_to_delete: list[tuple[str]] = []
        running = total_bytes
        for item in rows:
            if running <= target_bytes:
                break
            keys_to_delete.append((str(item["cache_key"]),))
            running -= int(item["byte_size"])

        if keys_to_delete:
            self._conn.executemany(
                "DELETE FROM translation_cache WHERE cache_key = ?",
                keys_to_delete,
            )
            self._conn.execute("PRAGMA incremental_vacuum(64);")

        return len(keys_to_delete)

    def _file_size_mb(self) -> float:
        total = 0
        for candidate in (
            self.db_path,
            Path(f"{self.db_path}-wal"),
            Path(f"{self.db_path}-shm"),
        ):
            if candidate.exists():
                total += candidate.stat().st_size
        return round(total / (1024 * 1024), 2)

    def stats(self) -> CacheStatsResponse:
        """Return cache entry counts, file size, limits, and session hit rate."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT mode, COUNT(*) AS cnt FROM translation_cache GROUP BY mode"
            ).fetchall()
            counts = {str(r["mode"]): int(r["cnt"]) for r in rows}
            novel_entries = counts.get("novel", 0)
            manhwa_entries = counts.get("manhwa", 0)
            total_entries = sum(counts.values())

            return CacheStatsResponse(
                db_path=str(self.db_path),
                total_entries=total_entries,
                novel_entries=novel_entries,
                manhwa_entries=manhwa_entries,
                size_mb=self._file_size_mb(),
                max_mb=self.max_mb,
                ttl_days=self.ttl_days,
                session_hits=self._session_hits,
                session_misses=self._session_misses,
            )

    def clear(self) -> CacheClearResponse:
        """Delete all cached translations and compact SQLite without deleting glossaries."""
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*) AS cnt FROM translation_cache"
            ).fetchone()
            cleared_entries = int(row["cnt"]) if row is not None else 0
            self._conn.execute("DELETE FROM translation_cache")
            self._conn.commit()
            self._conn.execute("VACUUM")
            self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")
            self._session_hits = 0
            self._session_misses = 0
            size_mb = self._file_size_mb()

        return CacheClearResponse(
            cleared_entries=cleared_entries,
            size_mb=size_mb,
        )

    def close(self) -> None:
        """Close underlying SQLite connection."""
        with self._lock:
            self._conn.close()
