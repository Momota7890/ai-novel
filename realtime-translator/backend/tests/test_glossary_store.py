"""Tests for SQLite GlossaryStore CRUD, cascade deletes, 404s, and translation cache invalidation."""

from __future__ import annotations

import sqlite3

from fastapi.testclient import TestClient

from tests.conftest import MockBackendHarness


def test_glossary_crud_and_cascade_delete(
    client: TestClient,
    harness: MockBackendHarness,
) -> None:
    # Initially empty.
    r_list0 = client.get("/glossaries")
    assert r_list0.status_code == 200
    assert r_list0.json() == {"glossaries": []}

    # Create glossary.
    create_payload = {
        "name": "Solo Leveling",
        "url_pattern": "*asuracomic.net/*solo-leveling*",
        "default_preset": "modern_manhwa",
        "entries": [
            {
                "source_term": "Sung Jin-Woo",
                "target_term": "ซองจินอู",
                "category": "name",
                "note": "Protagonist",
            },
            {
                "source_term": "Shadow Extraction",
                "target_term": "สกัดเงา",
                "category": "skill",
                "note": "",
            },
        ],
    }
    r_create = client.post("/glossaries", json=create_payload)
    assert r_create.status_code == 201
    created = r_create.json()
    assert created["id"] == "solo-leveling"
    assert created["name"] == "Solo Leveling"
    assert len(created["entries"]) == 2

    # Update glossary entries.
    update_payload = {
        **create_payload,
        "default_preset": "fantasy_murim",
        "entries": [
            {
                "source_term": "Sung Jin-Woo",
                "target_term": "ซองจินอู (ราชาเงา)",
                "category": "name",
                "note": "Updated",
            }
        ],
    }
    r_put = client.put(f"/glossaries/{created['id']}", json=update_payload)
    assert r_put.status_code == 200
    updated = r_put.json()
    assert updated["default_preset"] == "fantasy_murim"
    assert len(updated["entries"]) == 1
    assert updated["entries"][0]["target_term"] == "ซองจินอู (ราชาเงา)"

    # Delete glossary and confirm SQLite ON DELETE CASCADE removed entries.
    r_del = client.delete(f"/glossaries/{created['id']}")
    assert r_del.status_code == 200
    assert r_del.json() == {"deleted": True}

    conn = sqlite3.connect(str(harness.glossary_store.db_path))
    remaining_entries = conn.execute(
        "SELECT COUNT(*) FROM glossary_entries WHERE glossary_id = ?",
        (created["id"],),
    ).fetchone()[0]
    conn.close()
    assert remaining_entries == 0

    # Updating or deleting missing glossary returns 404 NOT_FOUND envelope.
    r_404_put = client.put("/glossaries/missing-id", json=update_payload)
    assert r_404_put.status_code == 404
    assert r_404_put.json()["error"]["code"] == "NOT_FOUND"

    r_404_del = client.delete("/glossaries/missing-id")
    assert r_404_del.status_code == 404
    assert r_404_del.json()["error"]["code"] == "NOT_FOUND"


def test_glossary_edit_injects_terms_and_busts_translation_cache(
    client: TestClient,
    harness: MockBackendHarness,
) -> None:
    created = client.post(
        "/glossaries",
        json={
            "name": "Omniscient Reader",
            "url_pattern": "*orv*",
            "default_preset": "light_novel",
            "entries": [
                {
                    "source_term": "Kim Dokja",
                    "target_term": "คิมดกจา",
                    "category": "name",
                    "note": "",
                }
            ],
        },
    ).json()
    gid = created["id"]

    req = {
        "session_id": "orv-ch-1",
        "preset": "light_novel",
        "glossary_id": gid,
        "bypass_cache": False,
        "paragraphs": [{"id": "p-1", "text": "Kim Dokja opened his smartphone."}],
    }

    # 1. Cold call injects "คิมดกจา" into system prompt.
    r1 = client.post("/translate/novel", json=req)
    assert r1.status_code == 200
    assert r1.json()["cache_misses"] == 1
    assert "คิมดกจา" in harness.generate_calls[0][0]["content"]

    # 2. Identical call hits cache (no second LLM call).
    r2 = client.post("/translate/novel", json=req)
    assert r2.status_code == 200
    assert r2.json()["cache_hits"] == 1
    assert len(harness.generate_calls) == 1

    # 3. Editing glossary target term changes glossary_hash -> automatically misses cache!
    client.put(
        f"/glossaries/{gid}",
        json={
            "name": "Omniscient Reader",
            "url_pattern": "*orv*",
            "default_preset": "light_novel",
            "entries": [
                {
                    "source_term": "Kim Dokja",
                    "target_term": "คิมด็อกจา",
                    "category": "name",
                    "note": "Updated spelling",
                }
            ],
        },
    )

    r3 = client.post("/translate/novel", json=req)
    assert r3.status_code == 200
    assert r3.json()["cache_misses"] == 1
    assert len(harness.generate_calls) == 2
    assert "คิมด็อกจา" in harness.generate_calls[1][0]["content"]
