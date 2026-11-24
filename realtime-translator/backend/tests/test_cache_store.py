"""Tests for bounded SQLite LRU cache: keys, hits/misses, TTL, size cap, clear safety."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from app.services.cache_store import (
    CacheStore,
    compute_cache_key,
    compute_content_hash,
)
from tests.conftest import FakeClock


def test_cache_key_determinism_and_sensitivity() -> None:
    h1 = compute_content_hash("Hello world!\r\n")
    h2 = compute_content_hash("  Hello world!  ")
    assert h1 == h2

    k_base = compute_cache_key("novel", h1, "model-a", "light_novel", "g1")
    assert k_base == compute_cache_key("novel", h2, "model-a", "light_novel", "g1")
    assert k_base != compute_cache_key("manhwa", h1, "model-a", "light_novel", "g1")
    assert k_base != compute_cache_key("novel", h1, "model-b", "light_novel", "g1")
    assert k_base != compute_cache_key("novel", h1, "model-a", "fantasy_murim", "g1")
    assert k_base != compute_cache_key("novel", h1, "model-a", "light_novel", "g2")


def test_wal_mode_hit_miss_and_ttl_expiry(tmp_path: Path) -> None:
    clock = FakeClock(now=1_700_000_000.0)
    db_path = tmp_path / "cache.db"
    store = CacheStore(db_path=db_path, max_mb=10, ttl_days=2, clock=clock)
    try:
        conn = sqlite3.connect(str(db_path))
        journal_mode = conn.execute("PRAGMA journal_mode;").fetchone()[0]
        conn.close()
        assert str(journal_mode).lower() == "wal"

        key = compute_cache_key("novel", compute_content_hash("Test paragraph"), "m1", "light_novel")
        assert store.get(key) is None

        store.put(key, "novel", {"translated_text": "ย่อหน้าทดสอบ"})
        assert store.get(key) == {"translated_text": "ย่อหน้าทดสอบ"}

        stats = store.stats()
        assert stats.total_entries == 1
        assert stats.novel_entries == 1
        assert stats.manhwa_entries == 0
        assert stats.session_hits == 1
        assert stats.session_misses == 1

        # Advance beyond 2-day TTL.
        clock.advance(2 * 86400 + 10)
        assert store.get(key) is None
        assert store.stats().total_entries == 0
    finally:
        store.close()


def test_lru_eviction_respects_size_cap_and_recent_access(tmp_path: Path) -> None:
    clock = FakeClock(now=1_700_000_000.0)
    db_path = tmp_path / "lru.db"
    # Tight cap so 4 entries (108 bytes each = 432 > 400) evict down to <= 85% (<= 340 bytes).
    store = CacheStore(db_path=db_path, max_mb=1, ttl_days=30, max_bytes_override=400, clock=clock)
    try:
        payload_text = "x" * 100
        store.put("k1", "novel", {"t": payload_text})
        clock.advance(10)
        store.put("k2", "novel", {"t": payload_text})
        clock.advance(10)
        store.put("k3", "novel", {"t": payload_text})
        clock.advance(10)

        # Touch k1 so k2 becomes the least recently used entry.
        assert store.get("k1") is not None
        clock.advance(10)

        # Adding k4 pushes total > 400 bytes -> evicts oldest LRU (k2, then k3 if needed).
        store.put("k4", "novel", {"t": payload_text})

        assert store.get("k2") is None, "LRU entry k2 should have been evicted"
        assert store.get("k1") is not None, "Recently accessed k1 should survive"
        assert store.get("k4") is not None, "Newly written k4 should survive"
    finally:
        store.close()


def test_clear_wipes_cache_without_deleting_glossaries(tmp_path: Path) -> None:
    db_path = tmp_path / "clear_safe.db"
    store = CacheStore(db_path=db_path, max_mb=10, ttl_days=30)
    try:
        store.put("k1", "novel", {"translated_text": "สวัสดี"})
        store.put("k2", "manhwa", {"bubbles": []})

        # Insert a glossary record into the shared SQLite database.
        conn = sqlite3.connect(str(db_path))
        conn.execute(
            "INSERT INTO glossaries (id, name, url_pattern, default_preset, updated_at) "
            "VALUES ('solo', 'Solo Leveling', '*asura*', 'modern_manhwa', 123456)"
        )
        conn.commit()
        conn.close()

        cleared = store.clear()
        assert cleared.cleared_entries == 2
        assert store.stats().total_entries == 0

        # Confirm saved glossary survived cache clear untouched.
        conn = sqlite3.connect(str(db_path))
        row = conn.execute("SELECT name FROM glossaries WHERE id = 'solo'").fetchone()
        conn.close()
        assert row == ("Solo Leveling",)
    finally:
        store.close()
