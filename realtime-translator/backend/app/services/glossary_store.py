"""SQLite persistence for per-series glossaries with cascade deletes and cache-key hashing."""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, cast

from app.errors import AppError
from app.schemas.glossary import (
    GlossaryCategory,
    GlossaryEntryResponse,
    GlossaryResponse,
    GlossaryUpsertRequest,
)
from app.schemas.translation import PresetId
from app.services.prompt_builder import GlossaryTerm

_GLOSSARY_SCHEMA_SQL = """
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
CREATE INDEX IF NOT EXISTS idx_glossary_entries_gid ON glossary_entries(glossary_id);
"""

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(name: str) -> str:
    slug = _SLUG_RE.sub("-", name.lower()).strip("-")
    return slug[:48] if slug else f"series-{uuid.uuid4().hex[:8]}"


class GlossaryStore:
    """Thread-safe SQLite CRUD store for per-series glossaries."""

    def __init__(
        self,
        db_path: Path,
        *,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.db_path = db_path
        self._clock = clock
        self._lock = threading.Lock()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._initialize()

    def _initialize(self) -> None:
        with self._lock:
            self._conn.execute("PRAGMA journal_mode = WAL;")
            self._conn.execute("PRAGMA synchronous = NORMAL;")
            self._conn.execute("PRAGMA foreign_keys = ON;")
            self._conn.executescript(_GLOSSARY_SCHEMA_SQL)
            self._conn.commit()

    def _load_entries_locked(self, glossary_id: str) -> list[GlossaryEntryResponse]:
        rows = self._conn.execute(
            """
            SELECT id, source_term, target_term, category, note
            FROM glossary_entries
            WHERE glossary_id = ?
            ORDER BY id ASC
            """,
            (glossary_id,),
        ).fetchall()
        return [
            GlossaryEntryResponse(
                id=int(r["id"]),
                source_term=str(r["source_term"]),
                target_term=str(r["target_term"]),
                category=cast(GlossaryCategory, str(r["category"])),
                note=str(r["note"] or ""),
            )
            for r in rows
        ]

    def _row_to_response_locked(self, row: sqlite3.Row) -> GlossaryResponse:
        gid = str(row["id"])
        return GlossaryResponse(
            id=gid,
            name=str(row["name"]),
            url_pattern=str(row["url_pattern"] or ""),
            default_preset=cast(PresetId, str(row["default_preset"] or "modern_manhwa")),
            updated_at=int(row["updated_at"]),
            entries=self._load_entries_locked(gid),
        )

    def _generate_unique_id_locked(self, name: str) -> str:
        base = _slugify(name)
        candidate = base
        suffix = 2
        while True:
            exists = self._conn.execute(
                "SELECT 1 FROM glossaries WHERE id = ?",
                (candidate,),
            ).fetchone()
            if exists is None:
                return candidate
            candidate = f"{base}-{suffix}"
            suffix += 1

    def list_glossaries(self) -> list[GlossaryResponse]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT id, name, url_pattern, default_preset, updated_at
                FROM glossaries
                ORDER BY updated_at DESC, name ASC
                """
            ).fetchall()
            return [self._row_to_response_locked(row) for row in rows]

    def get_glossary(self, glossary_id: str) -> GlossaryResponse | None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT id, name, url_pattern, default_preset, updated_at
                FROM glossaries
                WHERE id = ?
                """,
                (glossary_id,),
            ).fetchone()
            if row is None:
                return None
            return self._row_to_response_locked(row)

    def create_glossary(self, req: GlossaryUpsertRequest) -> GlossaryResponse:
        now = int(self._clock())
        with self._lock:
            gid = self._generate_unique_id_locked(req.name)
            self._conn.execute(
                """
                INSERT INTO glossaries (id, name, url_pattern, default_preset, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (gid, req.name, req.url_pattern, req.default_preset, now),
            )
            if req.entries:
                self._conn.executemany(
                    """
                    INSERT INTO glossary_entries
                        (glossary_id, source_term, target_term, category, note)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    [
                        (gid, e.source_term, e.target_term, e.category, e.note)
                        for e in req.entries
                    ],
                )
            self._conn.commit()
            row = self._conn.execute(
                "SELECT id, name, url_pattern, default_preset, updated_at FROM glossaries WHERE id = ?",
                (gid,),
            ).fetchone()
            assert row is not None
            return self._row_to_response_locked(row)

    def update_glossary(
        self,
        glossary_id: str,
        req: GlossaryUpsertRequest,
    ) -> GlossaryResponse:
        now = int(self._clock())
        with self._lock:
            existing = self._conn.execute(
                "SELECT 1 FROM glossaries WHERE id = ?",
                (glossary_id,),
            ).fetchone()
            if existing is None:
                raise AppError(
                    code="NOT_FOUND",
                    message=f"Glossary '{glossary_id}' does not exist.",
                    status_code=404,
                    retryable=False,
                )

            self._conn.execute(
                """
                UPDATE glossaries
                SET name = ?, url_pattern = ?, default_preset = ?, updated_at = ?
                WHERE id = ?
                """,
                (req.name, req.url_pattern, req.default_preset, now, glossary_id),
            )
            self._conn.execute(
                "DELETE FROM glossary_entries WHERE glossary_id = ?",
                (glossary_id,),
            )
            if req.entries:
                self._conn.executemany(
                    """
                    INSERT INTO glossary_entries
                        (glossary_id, source_term, target_term, category, note)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    [
                        (glossary_id, e.source_term, e.target_term, e.category, e.note)
                        for e in req.entries
                    ],
                )
            self._conn.commit()
            row = self._conn.execute(
                "SELECT id, name, url_pattern, default_preset, updated_at FROM glossaries WHERE id = ?",
                (glossary_id,),
            ).fetchone()
            assert row is not None
            return self._row_to_response_locked(row)

    def delete_glossary(self, glossary_id: str) -> bool:
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM glossaries WHERE id = ?",
                (glossary_id,),
            )
            self._conn.commit()
            if cursor.rowcount == 0:
                raise AppError(
                    code="NOT_FOUND",
                    message=f"Glossary '{glossary_id}' does not exist.",
                    status_code=404,
                    retryable=False,
                )
            return True

    def get_prompt_terms_and_hash(
        self,
        glossary_id: str | None,
    ) -> tuple[list[GlossaryTerm], str]:
        """Return prompt terms and a deterministic content hash for cache key invalidation."""
        if not glossary_id or not glossary_id.strip():
            return [], "none"

        glossary = self.get_glossary(glossary_id.strip())
        if glossary is None or not glossary.entries:
            return [], "none"

        terms = [
            GlossaryTerm(
                source_term=e.source_term,
                target_term=e.target_term,
                category=e.category,
                note=e.note,
            )
            for e in glossary.entries
        ]
        canonical = sorted(
            (t.category, t.source_term.lower(), t.target_term, t.note)
            for t in terms
        )
        digest = hashlib.sha256(
            json.dumps(canonical, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        ).hexdigest()[:16]
        return terms, f"{glossary.id}:{digest}"

    def close(self) -> None:
        with self._lock:
            self._conn.close()
