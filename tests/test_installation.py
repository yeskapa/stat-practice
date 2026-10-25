"""Database identities prevent browser drafts crossing independent local installs."""

import sqlite3
from uuid import UUID

from fastapi.testclient import TestClient

from app import create_app
from db import Database


def client_for(path, tmp_path):
    return TestClient(create_app(db_path=path, content_dir=tmp_path / 'content',
                                 export_path=tmp_path / 'export.json', web_dir=tmp_path / 'web'))


def test_new_installations_have_distinct_stable_identities(tmp_path):
    path = tmp_path / 'first.db'
    with client_for(path, tmp_path) as client:
        response = client.get('/api/installation')
        assert response.status_code == 200
        assert response.headers['cache-control'] == 'no-store'
        first = response.json()
        assert set(first) == {'id', 'legacyStorageAllowed'}
        assert str(UUID(first['id'])) == first['id']
        assert first['legacyStorageAllowed'] is False
        assert client.get('/api/installation').json() == first
    with client_for(path, tmp_path) as restarted:
        assert restarted.get('/api/installation').json() == first
    with client_for(tmp_path / 'second.db', tmp_path) as other:
        second = other.get('/api/installation').json()
        assert second['id'] != first['id']
        assert second['legacyStorageAllowed'] is False


def test_existing_attempts_allow_legacy_migration_without_changes(tmp_path):
    path = tmp_path / 'existing.db'
    Database(path)
    with sqlite3.connect(path) as connection:
        # Model a pre-identity database with a fully migrated, paused sitting.
        connection.execute('DROP TABLE installation')
        connection.execute("""INSERT INTO attempts
            (id, test_id, status, started_at, deadline_at, remaining_ms, configured_ms, consumed_active_ms)
            VALUES (17, 'private-test', 'active', 1000, 61000, 45000, 60000, 15000)""")
        connection.execute("INSERT INTO answers (attempt_id, question_id, choice, updated_at) VALUES (17, 'q1', 'C', 2000)")
        before_attempts = connection.execute('SELECT * FROM attempts').fetchall()
        before_answers = connection.execute('SELECT * FROM answers').fetchall()
    with client_for(path, tmp_path) as client:
        identity = client.get('/api/installation').json()
        assert identity['legacyStorageAllowed'] is True
    with sqlite3.connect(path) as connection:
        assert connection.execute('SELECT * FROM attempts').fetchall() == before_attempts
        assert connection.execute('SELECT * FROM answers').fetchall() == before_answers
        connection.execute('DELETE FROM answers')
        connection.execute('DELETE FROM attempts')
    with client_for(path, tmp_path) as restarted:
        assert restarted.get('/api/installation').json() == identity


def test_new_database_never_enables_legacy_storage_after_first_attempt(tmp_path):
    path = tmp_path / 'new.db'
    original = Database(path).installation
    with sqlite3.connect(path) as connection:
        connection.execute("""INSERT INTO attempts
            (test_id, status, started_at, deadline_at, remaining_ms, configured_ms, consumed_active_ms)
            VALUES ('sample', 'submitted', 1000, 61000, 0, 60000, 60000)""")
    assert Database(path).installation == original
    assert original['legacyStorageAllowed'] is False
