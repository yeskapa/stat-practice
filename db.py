import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path


SCHEMA = """
CREATE TABLE IF NOT EXISTS installation (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    id TEXT NOT NULL,
    legacy_storage_allowed INTEGER NOT NULL CHECK (legacy_storage_allowed IN (0, 1))
);
CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY,
    test_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'submitted', 'expired')),
    started_at INTEGER NOT NULL,
    deadline_at INTEGER NOT NULL,
    remaining_ms INTEGER,
    submitted_at INTEGER,
    submission_reason TEXT CHECK (submission_reason IN ('user', 'timeout', 'recovery')),
    configured_ms INTEGER,
    consumed_active_ms INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_attempt_per_test
    ON attempts(test_id) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS answers (
    attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,
    choice TEXT NOT NULL CHECK (choice IN ('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H')),
    updated_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    mutation_id TEXT,
    client_at INTEGER,
    PRIMARY KEY (attempt_id, question_id)
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    question_id TEXT,
    unit_id TEXT,
    type TEXT NOT NULL,
    client_at INTEGER,
    server_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    client_event_id TEXT,
    UNIQUE (attempt_id, client_event_id)
);
CREATE TABLE IF NOT EXISTS reviews (
    attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,
    note TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (attempt_id, question_id)
);
CREATE TABLE IF NOT EXISTS answer_mutations (
    attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    mutation_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    choice TEXT NOT NULL CHECK (choice IN ('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H')),
    client_at INTEGER,
    server_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('accepted', 'stale')),
    previous_choice TEXT,
    PRIMARY KEY (attempt_id, mutation_id)
);
CREATE TABLE IF NOT EXISTS timing_samples (
    attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    sample_id TEXT NOT NULL,
    visit_id TEXT NOT NULL,
    question_id TEXT,
    unit_id TEXT,
    elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms >= 0 AND elapsed_ms <= 60000),
    client_start_at INTEGER,
    client_end_at INTEGER,
    server_at INTEGER NOT NULL,
    provenance TEXT NOT NULL CHECK (provenance IN ('recorded', 'reconstructed')),
    quality TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (attempt_id, sample_id)
);
CREATE TABLE IF NOT EXISTS blind_reviews (
    original_attempt_id INTEGER PRIMARY KEY REFERENCES attempts(id),
    duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
    review_attempt_id INTEGER UNIQUE REFERENCES attempts(id)
);
"""


class Database:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Keep a recoverable SQLite snapshot before widening legacy answer constraints.
        if self.path.is_file():
            with sqlite3.connect(self.path) as source:
                old = source.execute("SELECT sql FROM sqlite_master WHERE name = 'answers'").fetchone()
                if old and "'E'" not in old[0]:
                    backup_path = self.path.with_name(f'{self.path.stem}-before-extra-choices-{time.time_ns()}.db')
                    with sqlite3.connect(backup_path) as backup:
                        source.backup(backup)
        with self.connect() as connection:
            connection.executescript(SCHEMA)
            attempt_columns = {row["name"] for row in connection.execute("PRAGMA table_info(attempts)")}
            for name, definition in (
                ("remaining_ms", "INTEGER"),
                ("configured_ms", "INTEGER"),
                ("consumed_active_ms", "INTEGER NOT NULL DEFAULT 0"),
            ):
                if name not in attempt_columns:
                    connection.execute(f"ALTER TABLE attempts ADD COLUMN {name} {definition}")
            answer_columns = {row["name"] for row in connection.execute("PRAGMA table_info(answers)")}
            for name, definition in (
                ("revision", "INTEGER NOT NULL DEFAULT 0"),
                ("mutation_id", "TEXT"),
                ("client_at", "INTEGER"),
            ):
                if name not in answer_columns:
                    connection.execute(f"ALTER TABLE answers ADD COLUMN {name} {definition}")
            # SQLite cannot alter a CHECK constraint; copy every column transactionally.
            connection.execute('BEGIN IMMEDIATE')
            connection.execute(
                """INSERT OR IGNORE INTO installation (singleton, id, legacy_storage_allowed)
                   VALUES (1, ?, EXISTS (SELECT 1 FROM attempts))""", (str(uuid.uuid4()),)
            )
            installation = connection.execute("SELECT id, legacy_storage_allowed FROM installation WHERE singleton = 1").fetchone()
            self.installation = {"id": installation["id"],
                                 "legacyStorageAllowed": bool(installation["legacy_storage_allowed"])}
            for table in ('answers', 'answer_mutations'):
                sql = connection.execute('SELECT sql FROM sqlite_master WHERE name = ?', (table,)).fetchone()[0]
                if "'E'" in sql:
                    continue
                new_sql = sql.replace(f'CREATE TABLE {table}', f'CREATE TABLE {table}_expanded', 1)
                new_sql = new_sql.replace("'A', 'B', 'C', 'D'", "'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'")
                connection.execute(new_sql)
                columns = ', '.join(row['name'] for row in connection.execute(f'PRAGMA table_info({table})'))
                connection.execute(f'INSERT INTO {table}_expanded ({columns}) SELECT {columns} FROM {table}')
                connection.execute(f'DROP TABLE {table}')
                connection.execute(f'ALTER TABLE {table}_expanded RENAME TO {table}')
            now = int(time.time() * 1000)
            connection.execute(
                """UPDATE attempts SET remaining_ms = CASE
                       WHEN status = 'active' THEN MAX(0, deadline_at - ?) ELSE 0 END
                   WHERE remaining_ms IS NULL""", (now,)
            )
            connection.execute(
                "UPDATE attempts SET configured_ms = MAX(0, deadline_at - started_at) WHERE configured_ms IS NULL"
            )
            connection.execute(
                """UPDATE attempts SET consumed_active_ms = MAX(0, configured_ms - remaining_ms)
                   WHERE consumed_active_ms = 0 AND remaining_ms IS NOT NULL"""
            )
            connection.execute("PRAGMA user_version = 5")

    @contextmanager
    def connect(self, *, immediate=False):
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        try:
            if immediate:
                connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    @staticmethod
    def event_dict(row):
        item = dict(row)
        item["payload"] = json.loads(item.pop("payload_json"))
        return item

    def attempt(self, attempt_id, connection=None):
        if connection is not None:
            row = connection.execute("SELECT * FROM attempts WHERE id = ?", (attempt_id,)).fetchone()
            return dict(row) if row else None
        with self.connect() as own_connection:
            return self.attempt(attempt_id, own_connection)

    def active_attempt(self, test_id):
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM attempts WHERE test_id = ? AND status = 'active'", (test_id,)
            ).fetchone()
            return dict(row) if row else None

    def latest_attempt(self, test_id, connection=None):
        if connection is None:
            with self.connect() as own_connection:
                return self.latest_attempt(test_id, own_connection)
        row = connection.execute(
            "SELECT * FROM attempts WHERE test_id = ? ORDER BY id DESC LIMIT 1", (test_id,)
        ).fetchone()
        return dict(row) if row else None

    def create_attempt(self, test_id, now, duration_ms):
        deadline = now + duration_ms
        with self.connect() as connection:
            cursor = connection.execute(
                """INSERT INTO attempts
                   (test_id, status, started_at, deadline_at, remaining_ms, configured_ms, consumed_active_ms)
                   VALUES (?, 'active', ?, ?, ?, ?, 0)""",
                (test_id, now, deadline, duration_ms, duration_ms),
            )
            attempt_id = cursor.lastrowid
            self.insert_event(connection, attempt_id, "attempt_started", now, payload={})
            return self.attempt(attempt_id, connection)

    def answers(self, attempt_id, connection=None):
        if connection is None:
            with self.connect() as own_connection:
                return self.answers(attempt_id, own_connection)
        rows = connection.execute(
            """SELECT question_id, choice, updated_at, revision, mutation_id, client_at
               FROM answers WHERE attempt_id = ?""", (attempt_id,)
        ).fetchall()
        return {row["question_id"]: {
            "choice": row["choice"], "updatedAt": row["updated_at"],
            "revision": row["revision"], "mutationId": row["mutation_id"],
            "clientAt": row["client_at"], "persistenceStatus": "recorded",
        } for row in rows}

    def events(self, attempt_id, connection=None):
        if connection is None:
            with self.connect() as own_connection:
                return self.events(attempt_id, own_connection)
        return [self.event_dict(row) for row in connection.execute(
            "SELECT * FROM events WHERE attempt_id = ? ORDER BY id", (attempt_id,)
        )]

    def timing_samples(self, attempt_id, connection=None):
        if connection is None:
            with self.connect() as own_connection:
                return self.timing_samples(attempt_id, own_connection)
        result = []
        for row in connection.execute(
            "SELECT * FROM timing_samples WHERE attempt_id = ? ORDER BY server_at, sample_id", (attempt_id,)
        ):
            item = dict(row)
            item["detail"] = json.loads(item.pop("detail_json"))
            result.append(item)
        return result

    def reviews(self, attempt_id, connection=None):
        if connection is None:
            with self.connect() as own_connection:
                return self.reviews(attempt_id, own_connection)
        return {row["question_id"]: row["note"] for row in connection.execute(
            "SELECT question_id, note FROM reviews WHERE attempt_id = ?", (attempt_id,)
        )}

    def insert_event(self, connection, attempt_id, event_type, server_at, *, question_id=None,
                     unit_id=None, client_at=None, payload=None, client_event_id=None):
        try:
            cursor = connection.execute(
                """INSERT INTO events
                   (attempt_id, question_id, unit_id, type, client_at, server_at, payload_json, client_event_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (attempt_id, question_id, unit_id, event_type, client_at, server_at,
                 json.dumps(payload or {}, separators=(",", ":")), client_event_id),
            )
            return cursor.lastrowid, True
        except sqlite3.IntegrityError:
            if not client_event_id:
                raise
            row = connection.execute(
                "SELECT id FROM events WHERE attempt_id = ? AND client_event_id = ?",
                (attempt_id, client_event_id),
            ).fetchone()
            if not row:
                raise
            return row["id"], False

    def prepare_attempt(self, connection, attempt_id, now):
        attempt = self.attempt(attempt_id, connection)
        if not attempt or attempt["status"] != "active" or attempt["remaining_ms"] > 0:
            return attempt, False
        return self.close_attempt(attempt_id, now, "timeout", connection), True

    def consume_time(self, connection, attempt_id, elapsed_ms, now):
        attempt, timed_out = self.prepare_attempt(connection, attempt_id, now)
        if not attempt or attempt["status"] != "active":
            return attempt, timed_out
        previous = int(attempt["remaining_ms"])
        remaining = max(0, previous - max(0, int(elapsed_ms)))
        connection.execute(
            """UPDATE attempts SET remaining_ms = ?, deadline_at = ?,
               consumed_active_ms = consumed_active_ms + ? WHERE id = ?""",
            (remaining, now + remaining, previous - remaining, attempt_id),
        )
        if remaining == 0:
            return self.close_attempt(attempt_id, now, "timeout", connection), True
        return self.attempt(attempt_id, connection), False

    def accept_answer(self, connection, attempt_id, question_id, choice, revision,
                      mutation_id, client_at, server_at):
        duplicate = connection.execute(
            "SELECT status FROM answer_mutations WHERE attempt_id = ? AND mutation_id = ?",
            (attempt_id, mutation_id),
        ).fetchone()
        if duplicate:
            return duplicate["status"], False, None
        current = connection.execute(
            "SELECT choice, revision FROM answers WHERE attempt_id = ? AND question_id = ?",
            (attempt_id, question_id),
        ).fetchone()
        old_choice = current["choice"] if current else None
        old_revision = int(current["revision"] if current else 0)
        status = "accepted" if revision > old_revision else "stale"
        connection.execute(
            """INSERT INTO answer_mutations
               (attempt_id, mutation_id, question_id, revision, choice, client_at,
                server_at, status, previous_choice) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (attempt_id, mutation_id, question_id, revision, choice, client_at,
             server_at, status, old_choice),
        )
        if status == "accepted":
            connection.execute(
                """INSERT INTO answers
                   (attempt_id, question_id, choice, updated_at, revision, mutation_id, client_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(attempt_id, question_id) DO UPDATE SET
                     choice=excluded.choice, updated_at=excluded.updated_at,
                     revision=excluded.revision, mutation_id=excluded.mutation_id,
                     client_at=excluded.client_at""",
                (attempt_id, question_id, choice, server_at, revision, mutation_id, client_at),
            )
            self.insert_event(
                connection, attempt_id, "answer_changed" if old_choice else "answer_selected", server_at,
                question_id=question_id, client_at=client_at,
                payload={"from": old_choice, "to": choice, "revision": revision,
                         "mutationId": mutation_id},
            )
        return status, True, old_choice

    def accept_timing_sample(self, connection, attempt_id, sample, server_at):
        duplicate = connection.execute(
            "SELECT elapsed_ms FROM timing_samples WHERE attempt_id = ? AND sample_id = ?",
            (attempt_id, sample["sample_id"]),
        ).fetchone()
        if duplicate:
            return False, int(duplicate["elapsed_ms"]), False
        attempt, timed_out = self.prepare_attempt(connection, attempt_id, server_at)
        if not attempt or attempt["status"] != "active":
            return False, 0, timed_out
        accepted_ms = min(int(sample["elapsed_ms"]), int(attempt["remaining_ms"]))
        detail = dict(sample.get("detail") or {})
        if accepted_ms != int(sample["elapsed_ms"]):
            detail.update(reportedElapsedMs=int(sample["elapsed_ms"]), boundedByRemainingTime=True)
        connection.execute(
            """INSERT INTO timing_samples
               (attempt_id, sample_id, visit_id, question_id, unit_id, elapsed_ms,
                client_start_at, client_end_at, server_at, provenance, quality, detail_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded', ?, ?)""",
            (attempt_id, sample["sample_id"], sample["visit_id"], sample.get("question_id"),
             sample.get("unit_id"), accepted_ms, sample.get("client_start_at"),
             sample.get("client_end_at"), server_at, sample.get("quality", "bounded"),
             json.dumps(detail, separators=(",", ":"))),
        )
        _, timed_out = self.consume_time(connection, attempt_id, accepted_ms, server_at)
        return True, accepted_ms, timed_out

    def close_attempt(self, attempt_id, now, reason, connection=None):
        if connection is None:
            with self.connect(immediate=True) as own_connection:
                return self.close_attempt(attempt_id, now, reason, own_connection)
        status = "expired" if reason == "timeout" else "submitted"
        attempt = self.attempt(attempt_id, connection)
        if not attempt or attempt["status"] != "active":
            return attempt
        connection.execute(
            "UPDATE attempts SET status = ?, submitted_at = ?, submission_reason = ? WHERE id = ?",
            (status, now, reason, attempt_id),
        )
        self.insert_event(connection, attempt_id, "attempt_submitted", now, payload={"reason": reason})
        plan = connection.execute(
            "SELECT * FROM blind_reviews WHERE original_attempt_id = ?", (attempt_id,)
        ).fetchone()
        if plan and plan["review_attempt_id"] is None:
            duration = plan["duration_ms"]
            cursor = connection.execute(
                """INSERT INTO attempts(test_id, status, started_at, deadline_at, remaining_ms,
                       configured_ms, consumed_active_ms) VALUES (?, 'active', ?, ?, ?, ?, 0)""",
                (attempt["test_id"], now, now + duration, duration, duration),
            )
            review_id = cursor.lastrowid
            connection.execute(
                """INSERT INTO answers(attempt_id, question_id, choice, updated_at, revision,
                       mutation_id, client_at)
                   SELECT ?, question_id, choice, updated_at, revision, mutation_id, client_at
                   FROM answers WHERE attempt_id = ?""", (review_id, attempt_id),
            )
            connection.execute(
                "UPDATE blind_reviews SET review_attempt_id = ? WHERE original_attempt_id = ?",
                (review_id, attempt_id),
            )
            self.insert_event(connection, review_id, "attempt_started", now,
                              payload={"blindReviewOf": attempt_id})
        return self.attempt(attempt_id, connection)
