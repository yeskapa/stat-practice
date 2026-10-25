import json
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from db import Database


ROOT = Path(__file__).resolve().parent
EXAM_SECONDS = 7_200
CHOICE_LETTERS = "ABCDEFGH"
CHOICES = set(CHOICE_LETTERS)
CLIENT_EVENT_TYPES = {
    "question_entered", "question_left", "visibility_hidden", "visibility_visible"
}


class AttemptCreate(BaseModel):
    testId: str = Field(min_length=1, max_length=200)


class AnswerUpdate(BaseModel):
    choice: Literal["A", "B", "C", "D", "E", "F", "G", "H"]
    clientAt: int | None = None


class EventInput(BaseModel):
    clientEventId: str = Field(min_length=1, max_length=200)
    type: Literal["question_entered", "question_left", "visibility_hidden", "visibility_visible"]
    questionId: str | None = Field(default=None, max_length=200)
    unitId: str | None = Field(default=None, max_length=200)
    clientAt: int | None = None
    payload: dict = Field(default_factory=dict)


class EventsInput(BaseModel):
    events: list[EventInput] = Field(min_length=1, max_length=50)


class ReviewUpdate(BaseModel):
    note: str = Field(max_length=20_000)


class TimerUpdate(BaseModel):
    elapsedMs: int = Field(ge=0, le=60_000)


class AnswerMutation(BaseModel):
    mutationId: str = Field(min_length=1, max_length=200)
    questionId: str = Field(min_length=1, max_length=200)
    revision: int = Field(ge=1, le=2_147_483_647)
    choice: Literal["A", "B", "C", "D", "E", "F", "G", "H"]
    clientAt: int | None = None


class TimingSample(BaseModel):
    sampleId: str = Field(min_length=1, max_length=200)
    visitId: str = Field(min_length=1, max_length=200)
    questionId: str | None = Field(default=None, max_length=200)
    unitId: str | None = Field(default=None, max_length=200)
    elapsedMs: int = Field(ge=0, le=60_000)
    clientStartAt: int | None = None
    clientEndAt: int | None = None


class SyncInput(BaseModel):
    answers: list[AnswerMutation] = Field(default_factory=list, max_length=100)
    events: list[EventInput] = Field(default_factory=list, max_length=100)
    timingSamples: list[TimingSample] = Field(default_factory=list, max_length=100)
    submit: bool = False


def now_ms():
    return int(time.time() * 1000)


def test_duration(test):
    """Keep every 70-question mock at STAT timing; allow short system checks."""
    if test.get("questionCount") == 70:
        return EXAM_SECONDS
    duration = int(test.get("durationSeconds", EXAM_SECONDS))
    if duration < 60 or duration > 14_400:
        raise ValueError("invalid test duration")
    return duration


class Content:
    def __init__(self, directory: Path):
        self.directory = Path(directory)

    def unfair_questions(self):
        path = self.directory / "unfair-questions.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else []

    def _path(self, test_id):
        if not test_id or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for char in test_id):
            raise KeyError(test_id)
        return self.directory / test_id / "test.json"

    def get(self, test_id):
        path = self._path(test_id)
        if not path.is_file():
            raise KeyError(test_id)
        data = json.loads(path.read_text(encoding="utf-8"))
        self.validate(data, test_id)
        unfair = {entry["questionId"]: entry["reason"] for entry in self.unfair_questions()
                  if entry["testId"] == test_id}
        for unit in data["units"]:
            for question in unit.get("questions", []):
                if question["id"] in unfair:
                    question["unfairReason"] = unfair[question["id"]]
        return data

    def all(self):
        if not self.directory.is_dir():
            return []
        tests = []
        for path in sorted(self.directory.glob("*/test.json")):
            try:
                data = self.get(path.parent.name)
            except (KeyError, ValueError, json.JSONDecodeError):
                continue
            tests.append({key: data.get(key) for key in (
                "id", "title", "questionCount", "durationSeconds", "sourceDurationSeconds", "source"
            ) if key in data})
        return tests

    @staticmethod
    def validate(data, expected_id=None):
        if not isinstance(data, dict) or data.get("id") != expected_id or not isinstance(data.get("units"), list):
            raise ValueError("invalid test metadata")
        seen_units, seen_questions = set(), set()
        count = 0
        for unit in data["units"]:
            if not isinstance(unit, dict) or not unit.get("id") or unit["id"] in seen_units:
                raise ValueError("invalid or duplicate unit id")
            seen_units.add(unit["id"])
            for question in unit.get("questions", []):
                if (not question.get("id") or question["id"] in seen_questions
                        or not 4 <= len(question.get("options", {})) <= len(CHOICE_LETTERS)
                        or set(question["options"]) != set(CHOICE_LETTERS[:len(question["options"])])
                        or question.get("correctAnswer") not in question["options"]):
                    raise ValueError("invalid question")
                seen_questions.add(question["id"])
                count += 1
        if data.get("questionCount") != count:
            raise ValueError("question count mismatch")

    @staticmethod
    def public(data):
        copy = json.loads(json.dumps(data))
        for unit in copy["units"]:
            for question in unit.get("questions", []):
                question.pop("correctAnswer", None)
                question.pop("explanation", None)
        return copy

    @staticmethod
    def index(data):
        result = {}
        for unit in data["units"]:
            for question in unit.get("questions", []):
                result[question["id"]] = (unit, question)
        return result


def metrics(attempt, events, answers, test, samples=None):
    question_index = Content.index(test)
    result = {question_id: {
        "activeTimeMs": None, "visits": 0, "skips": 0, "answerHistory": [],
        "visitDurations": [], "timingProvenance": "unavailable",
    } for question_id in question_index}
    samples = samples or []

    for event in events:
        question_id = event["question_id"]
        if question_id not in result:
            continue
        if event["type"] == "question_entered":
            result[question_id]["visits"] += 1
        elif event["type"] == "question_left":
            result[question_id]["visits"] = max(1, result[question_id]["visits"])
            if event["payload"].get("unanswered"):
                result[question_id]["skips"] += 1
        elif event["type"] in ("answer_selected", "answer_changed"):
            result[question_id]["answerHistory"].append({
                "from": event["payload"].get("from"), "to": event["payload"].get("to"),
                "at": event["client_at"] or event["server_at"],
                "revision": event["payload"].get("revision"),
            })

    gap_questions = set()
    if samples:
        visits = {}
        for sample in samples:
            gap_questions.update(sample["detail"].get("questionCandidates", []))
            question_id = sample["question_id"]
            if question_id not in result:
                continue
            item = result[question_id]
            item["activeTimeMs"] = (item["activeTimeMs"] or 0) + sample["elapsed_ms"]
            key = (question_id, sample["visit_id"])
            visit = visits.setdefault(key, {
                "visitId": sample["visit_id"], "durationMs": 0,
                "provenance": sample["provenance"], "quality": sample["quality"],
            })
            visit["durationMs"] += sample["elapsed_ms"]
            if sample["provenance"] == "reconstructed":
                visit["provenance"] = "reconstructed"
        for (question_id, _), visit in visits.items():
            result[question_id]["visitDurations"].append(visit)
        for question_id, item in result.items():
            provenance = {visit["provenance"] for visit in item["visitDurations"]}
            if question_id in gap_questions:
                item["timingProvenance"] = "incomplete"
            elif "reconstructed" in provenance:
                item["timingProvenance"] = "reconstructed"
            elif provenance:
                item["timingProvenance"] = "recorded"
            elif item["visits"] or item["skips"]:
                item["timingProvenance"] = "incomplete"
    else:
        # Compatibility for pre-v3 test fixtures; repaired real attempts use timing_samples.
        legacy = _legacy_metrics(events, result)
        for question_id, elapsed in legacy.items():
            result[question_id]["activeTimeMs"] = elapsed
            result[question_id]["timingProvenance"] = "reconstructed"

    unit_times = {}
    for question_id, item in result.items():
        unit_id = question_index[question_id][0]["id"]
        if item["activeTimeMs"] is not None:
            unit_times[unit_id] = unit_times.get(unit_id, 0) + item["activeTimeMs"]
    uncertain_units = {question_index[q][0]["id"] for q in gap_questions if q in question_index}
    threshold = test_duration(test) * 1000 / max(1, test["questionCount"])
    for question_id, item in result.items():
        unit_id = question_index[question_id][0]["id"]
        item["unitActiveTimeMs"] = None if unit_id in uncertain_units else unit_times.get(unit_id)
        item["slow"] = item["activeTimeMs"] is not None and item["activeTimeMs"] > threshold
        item["answerChanges"] = sum(1 for change in item["answerHistory"] if change["from"] is not None)

    event_times = [value for event in events for value in (event["client_at"], event["server_at"]) if value]
    wall_start = min([attempt["started_at"], *event_times]) if event_times else attempt["started_at"]
    wall_end = max([attempt.get("submitted_at") or wall_start, *event_times]) if event_times else (attempt.get("submitted_at") or wall_start)
    known_paused = _known_hidden_ms(events)
    accepted_ms = sum(sample["elapsed_ms"] for sample in samples)
    consumed_ms = int(attempt.get("consumed_active_ms") or 0)
    summary = {
        "activeTimeMs": consumed_ms if samples else sum(item["activeTimeMs"] or 0 for item in result.values()),
        "acceptedTimingMs": accepted_ms,
        "knownPausedTimeMs": known_paused,
        "wallSpanMs": max(0, wall_end - wall_start),
        "provenance": "recorded" if samples and all(s["provenance"] == "recorded" for s in samples) else "reconstructed",
        "incomplete": bool(gap_questions) or (bool(samples) and accepted_ms != consumed_ms),
        "integrity": {"reconciles": bool(samples) and accepted_ms == consumed_ms,
                      "consumedActiveMs": consumed_ms, "acceptedTimingMs": accepted_ms},
    }
    return result, summary


def _known_hidden_ms(events):
    total = 0
    pending = None
    for event in events:
        if event["type"] == "visibility_hidden":
            pending = event
        elif event["type"] == "visibility_visible":
            if pending and pending["question_id"] == event["question_id"]:
                start = pending["client_at"] or pending["server_at"]
                end = event["client_at"] or event["server_at"]
                total += max(0, end - start)
            pending = None
        elif event["type"] in ("question_entered", "question_left") and pending:
            pending = None
    return total


def _legacy_metrics(events, result):
    elapsed = {question_id: 0 for question_id in result}
    active_question = None
    active_since = None

    def stop(at):
        nonlocal active_since
        if active_question in elapsed and active_since is not None:
            elapsed[active_question] += max(0, at - active_since)
        active_since = None

    for event in events:
        event_type = event["type"]
        at = event["client_at"] or event["server_at"]
        question_id = event["question_id"]
        if event_type == "question_entered" and question_id in result:
            stop(at)
            active_question = question_id
            active_since = at
        elif event_type == "question_left":
            stop(at)
            if not question_id or question_id == active_question:
                active_question = None
        elif event_type == "attempt_submitted":
            stop(at)
    return elapsed


def create_app(*, db_path=None, content_dir=None, export_path=None, web_dir=None, clock=now_ms):
    database = Database(Path(db_path or os.getenv("STAT_DB_PATH", ROOT / "data" / "stat.db")))
    content = Content(Path(content_dir or os.getenv("STAT_CONTENT_DIR", ROOT / "content" / "tests")))
    export = Path(export_path or os.getenv("STAT_EXPORT_PATH", ROOT / "data" / "latest-attempt.json"))
    web = Path(web_dir or ROOT / "web")
    api = FastAPI(title="STAT Mock Test", docs_url=None, redoc_url=None)
    api.state.database = database
    api.state.content = content

    @api.middleware("http")
    async def revalidate_frontend(request, call_next):
        response = await call_next(request)
        if request.url.path in {"/", "/index.html", "/app.js", "/statistics.js", "/styles.css"}:
            response.headers["Cache-Control"] = "no-cache"
        return response

    # ponytail: this app is single-process; use DB-backed export versioning before adding workers.
    export_lock = threading.Lock()

    def get_test(test_id):
        try:
            return content.get(test_id)
        except KeyError:
            raise HTTPException(404, "test not found")
        except (ValueError, json.JSONDecodeError) as error:
            raise HTTPException(500, f"invalid test content: {error}")

    def get_attempt(attempt_id):
        with database.connect(immediate=True) as connection:
            attempt, timed_out = database.prepare_attempt(connection, attempt_id, clock())
        if not attempt:
            raise HTTPException(404, "attempt not found")
        if timed_out:
            write_export(attempt_id)
        return attempt

    def ensure_question(test, question_id):
        item = Content.index(test).get(question_id)
        if not item:
            raise HTTPException(404, "question not found")
        return item

    def attempt_state(attempt):
        with database.connect() as connection:
            plan = connection.execute(
                "SELECT * FROM blind_reviews WHERE original_attempt_id = ? OR review_attempt_id = ?",
                (attempt["id"], attempt["id"]),
            ).fetchone()
            if plan and plan["review_attempt_id"]:
                continuation = database.attempt(plan["review_attempt_id"], connection)
                if continuation["status"] == "active":
                    attempt = continuation
        events = database.events(attempt["id"])
        current = None
        for event in events:
            if event["type"] == "question_entered":
                current = event["question_id"]
            elif event["type"] == "question_left" and (not event["question_id"] or event["question_id"] == current):
                current = None
        now = clock()
        remaining_ms = max(0, int(attempt.get("remaining_ms") or 0))
        return {
            **attempt,
            "blindReview": bool(plan and plan["review_attempt_id"] == attempt["id"]),
            "blindReviewPlanned": bool(plan and plan["original_attempt_id"] == attempt["id"]),
            "answers": database.answers(attempt["id"]),
            "currentQuestionId": current,
            "serverNow": now,
            "deadline_at": now + remaining_ms,
            "remainingMs": remaining_ms,
            "remainingSeconds": remaining_ms // 1000,
        }

    def review_data(attempt_id):
        attempt = database.attempt(attempt_id)
        if not attempt:
            raise HTTPException(404, "attempt not found")
        if attempt["status"] == "active":
            raise HTTPException(409, "review is available only after submission")
        with database.connect() as connection:
            plan = connection.execute(
                "SELECT * FROM blind_reviews WHERE original_attempt_id = ? OR review_attempt_id = ?",
                (attempt_id, attempt_id),
            ).fetchone()
            if plan and (not plan["review_attempt_id"] or
                         database.attempt(plan["review_attempt_id"], connection)["status"] == "active"):
                raise HTTPException(409, "feedback is locked until blind review is complete")
        test = get_test(attempt["test_id"])
        answers = database.answers(attempt_id)
        events = database.events(attempt_id)
        samples = database.timing_samples(attempt_id)
        notes = database.reviews(attempt_id)
        measured, timing = metrics(attempt, events, answers, test, samples)
        totals = {"raw": 0, "verbal": 0, "quantitative": 0}
        questions = []
        for unit in test["units"]:
            for question in unit.get("questions", []):
                chosen = answers.get(question["id"], {}).get("choice")
                auto_credit = bool(question.get("unfairReason"))
                correct = auto_credit or chosen == question["correctAnswer"]
                question_metrics = measured[question["id"]]
                if chosen:
                    persistence = "recorded"
                    recovery = "authoritative"
                elif question_metrics["timingProvenance"] == "incomplete":
                    persistence = "not_recorded"
                    recovery = "not_recovered"
                elif question_metrics["skips"]:
                    persistence = "explicitly_unanswered"
                    recovery = "not_applicable"
                else:
                    persistence = "no_answer_recorded"
                    recovery = "unavailable"
                if correct:
                    totals["raw"] += 1
                    if question.get("category") in ("verbal", "quantitative"):
                        totals[question["category"]] += 1
                questions.append({
                    **question, "unitId": unit["id"], "unitQuestionCount": len(unit.get("questions", [])),
                    "stimulusHtml": unit.get("stimulusHtml"),
                    "assets": unit.get("assets", []), "sourcePages": unit.get("sourcePages", []),
                    "selectedAnswer": chosen, "correct": correct, "autoCredit": auto_credit,
                    "unanswered": chosen is None, "note": notes.get(question["id"], ""),
                    "answerPersistenceStatus": persistence, "recoveredDataStatus": recovery,
                    **question_metrics,
                })
        configured_ms = int(attempt.get("configured_ms") or test_duration(test) * 1000)
        remaining_ms = max(0, int(attempt.get("remaining_ms") or 0))
        attempt = {**attempt, "durationMs": configured_ms - remaining_ms, "timing": timing}
        return {"attempt": attempt,
                "linkedAttempts": dict(plan) if plan else None, "test": {
            **{key: test.get(key) for key in ("id", "title", "source", "questionCount") if key in test},
            "durationSeconds": configured_ms // 1000,
        }, "totals": totals, "questions": questions, "events": events}

    def write_export(attempt_id):
        # The timed record stays in SQLite; never generate feedback during blind review.
        if attempt_state(database.attempt(attempt_id))["status"] == "active":
            return
        with export_lock:
            payload = review_data(attempt_id)
            payload["schemaVersion"] = 2
            export.parent.mkdir(parents=True, exist_ok=True)
            temporary = None
            try:
                with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=export.parent,
                                                 prefix=export.name + ".", suffix=".tmp", delete=False) as handle:
                    temporary = Path(handle.name)
                    json.dump(payload, handle, indent=2, ensure_ascii=False)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, export)
            finally:
                if temporary and temporary.exists():
                    temporary.unlink()

    api.state.write_export = write_export

    @api.get("/api/installation")
    def installation_identity():
        return JSONResponse(database.installation, headers={"Cache-Control": "no-store"})

    @api.get("/api/unfair-questions")
    def list_unfair_questions():
        return content.unfair_questions()

    @api.get("/api/tests")
    def list_tests():
        tests = content.all()
        for test in tests:
            test["durationSeconds"] = test_duration(test)
            latest = database.latest_attempt(test["id"])
            if not latest:
                test["attempt"] = None
                continue
            if latest["status"] == "active":
                state = attempt_state(latest)
                test["attempt"] = {
                    "id": state["id"],
                    "status": state["status"],
                    "answeredCount": len(state["answers"]),
                    "remainingSeconds": state["remainingSeconds"],
                }
            else:
                completed = review_data(latest["id"])
                test["attempt"] = {
                    "id": latest["id"],
                    "status": latest["status"],
                    "submittedAt": latest["submitted_at"],
                    "answeredCount": sum(not question["unanswered"] for question in completed["questions"]),
                    "totals": completed["totals"],
                }
        tests.sort(key=lambda test: (
            test["attempt"] is not None and test["attempt"]["status"] in ("submitted", "expired"),
            (test["attempt"] or {}).get("submittedAt") or 0,
        ), reverse=True)
        return tests

    @api.get("/api/tests/{test_id}")
    def test_content(test_id: str):
        test = Content.public(get_test(test_id))
        test["durationSeconds"] = test_duration(test)
        return test

    @api.get("/api/tests/{test_id}/assets/{asset_path:path}")
    def test_asset(test_id: str, asset_path: str):
        get_test(test_id)
        base = (content.directory / test_id / "assets").resolve()
        path = (base / asset_path).resolve()
        if base not in path.parents or not path.is_file():
            raise HTTPException(404, "asset not found")
        return FileResponse(path)

    @api.post("/api/attempts", status_code=201)
    def create_attempt(body: AttemptCreate):
        get_test(body.testId)
        active = database.active_attempt(body.testId)
        if active:
            active = get_attempt(active["id"])
            if active["status"] == "active":
                return attempt_state(active)
        latest = database.latest_attempt(body.testId)
        if latest and latest["status"] in ("submitted", "expired"):
            raise HTTPException(409, "This test is already completed. Open its review instead.")
        now = clock()
        duration = test_duration(get_test(body.testId))
        return attempt_state(database.create_attempt(body.testId, now, duration * 1000))

    @api.get("/api/attempts/{attempt_id}")
    def resume_attempt(attempt_id: int):
        return attempt_state(get_attempt(attempt_id))

    @api.post("/api/attempts/{attempt_id}/sync")
    def synchronize(attempt_id: int, body: SyncInput):
        answer_acks, event_acks, timing_acks = [], [], []
        changed = False
        with database.connect(immediate=True) as connection:
            now = clock()
            attempt, timed_out = database.prepare_attempt(connection, attempt_id, now)
            changed = timed_out
            if not attempt:
                raise HTTPException(404, "attempt not found")
            test = get_test(attempt["test_id"])
            if attempt["status"] != "active":
                duplicate_answers = all(connection.execute(
                    "SELECT 1 FROM answer_mutations WHERE attempt_id = ? AND mutation_id = ?",
                    (attempt_id, item.mutationId),
                ).fetchone() for item in body.answers)
                duplicate_samples = all(connection.execute(
                    "SELECT 1 FROM timing_samples WHERE attempt_id = ? AND sample_id = ?",
                    (attempt_id, item.sampleId),
                ).fetchone() for item in body.timingSamples)
                duplicate_events = all(connection.execute(
                    "SELECT 1 FROM events WHERE attempt_id = ? AND client_event_id = ?",
                    (attempt_id, item.clientEventId),
                ).fetchone() for item in body.events)
                if not (body.submit and duplicate_answers and duplicate_samples and duplicate_events):
                    raise HTTPException(409, "attempt is closed")
            else:
                for item in body.answers:
                    unit, question = ensure_question(test, item.questionId)
                    if item.choice not in question["options"]:
                        raise HTTPException(422, "choice is not an option for this question")
                    status, inserted, old = database.accept_answer(
                        connection, attempt_id, item.questionId, item.choice, item.revision,
                        item.mutationId, item.clientAt, now,
                    )
                    if inserted and status == "accepted":
                        connection.execute(
                            "UPDATE events SET unit_id = ? WHERE id = last_insert_rowid()", (unit["id"],)
                        )
                    answer_acks.append({"mutationId": item.mutationId, "status": status,
                                        "inserted": inserted, "previousChoice": old})
                for item in body.events:
                    if item.type in ("question_entered", "question_left") and not item.questionId:
                        raise HTTPException(422, "questionId is required for question events")
                    if item.questionId:
                        unit, _ = ensure_question(test, item.questionId)
                        if item.unitId and item.unitId != unit["id"]:
                            raise HTTPException(422, "unit does not contain question")
                    payload = dict(item.payload)
                    if item.type == "question_left" and item.questionId:
                        payload["unanswered"] = item.questionId not in database.answers(attempt_id, connection)
                    event_id, inserted = database.insert_event(
                        connection, attempt_id, item.type, now, question_id=item.questionId,
                        unit_id=item.unitId, client_at=item.clientAt, payload=payload,
                        client_event_id=item.clientEventId,
                    )
                    event_acks.append({"clientEventId": item.clientEventId, "id": event_id,
                                       "inserted": inserted})
                for item in body.timingSamples:
                    if item.clientStartAt is not None and item.clientEndAt is not None:
                        if item.clientEndAt < item.clientStartAt:
                            raise HTTPException(422, "timing interval ends before it starts")
                        if item.elapsedMs > item.clientEndAt - item.clientStartAt + 2_000:
                            raise HTTPException(422, "timing sample exceeds its client interval")
                    if item.questionId:
                        unit, _ = ensure_question(test, item.questionId)
                        if item.unitId and item.unitId != unit["id"]:
                            raise HTTPException(422, "unit does not contain question")
                    inserted, accepted_ms, sample_timeout = database.accept_timing_sample(
                        connection, attempt_id, {
                            "sample_id": item.sampleId, "visit_id": item.visitId,
                            "question_id": item.questionId, "unit_id": item.unitId,
                            "elapsed_ms": item.elapsedMs, "client_start_at": item.clientStartAt,
                            "client_end_at": item.clientEndAt,
                        }, now,
                    )
                    timing_acks.append({"sampleId": item.sampleId, "inserted": inserted,
                                        "acceptedElapsedMs": accepted_ms})
                    changed = changed or sample_timeout
                    if sample_timeout:
                        break
                attempt = database.attempt(attempt_id, connection)
                if body.submit and attempt["status"] == "active":
                    attempt = database.close_attempt(attempt_id, now, "user", connection)
                    changed = True
        if changed:
            write_export(attempt_id)
        state = attempt_state(database.attempt(attempt_id))
        return {**state, "acknowledged": {
            "answers": answer_acks, "events": event_acks, "timingSamples": timing_acks,
        }}

    @api.post("/api/attempts/{attempt_id}/timer")
    def update_timer(attempt_id: int, body: TimerUpdate):
        with database.connect(immediate=True) as connection:
            now = clock()
            attempt, timed_out = database.consume_time(connection, attempt_id, body.elapsedMs, now)
        if not attempt:
            raise HTTPException(404, "attempt not found")
        if timed_out:
            write_export(attempt_id)
        return attempt_state(attempt)

    @api.post("/api/attempts/{attempt_id}/events")
    def add_events(attempt_id: int, body: EventsInput):
        accepted = []
        with database.connect(immediate=True) as connection:
            now = clock()
            attempt, timed_out = database.prepare_attempt(connection, attempt_id, now)
            if attempt and attempt["status"] == "active":
                test = get_test(attempt["test_id"])
                for event in body.events:
                    if event.type in ("question_entered", "question_left") and not event.questionId:
                        raise HTTPException(422, "questionId is required for question events")
                    if event.questionId:
                        unit, _ = ensure_question(test, event.questionId)
                        if event.unitId and event.unitId != unit["id"]:
                            raise HTTPException(422, "unit does not contain question")
                    payload = dict(event.payload)
                    if event.type == "question_left" and event.questionId:
                        payload["unanswered"] = event.questionId not in database.answers(attempt_id, connection)
                    event_id, inserted = database.insert_event(
                        connection, attempt_id, event.type, now, question_id=event.questionId,
                        unit_id=event.unitId, client_at=event.clientAt, payload=payload,
                        client_event_id=event.clientEventId,
                    )
                    accepted.append({"id": event_id, "inserted": inserted})
        if not attempt:
            raise HTTPException(404, "attempt not found")
        if timed_out:
            write_export(attempt_id)
        if attempt["status"] != "active":
            raise HTTPException(409, "attempt is closed")
        return {"events": accepted}

    @api.put("/api/attempts/{attempt_id}/answers/{question_id}")
    def update_answer(attempt_id: int, question_id: str, body: AnswerUpdate):
        old = None
        with database.connect(immediate=True) as connection:
            now = clock()
            attempt, timed_out = database.prepare_attempt(connection, attempt_id, now)
            if attempt and attempt["status"] == "active":
                unit, question = ensure_question(get_test(attempt["test_id"]), question_id)
                if body.choice not in question["options"]:
                    raise HTTPException(422, "choice is not an option for this question")
                old = database.answers(attempt_id, connection).get(question_id, {}).get("choice")
                if old != body.choice:
                    connection.execute(
                        """INSERT INTO answers(attempt_id, question_id, choice, updated_at) VALUES (?, ?, ?, ?)
                           ON CONFLICT(attempt_id, question_id) DO UPDATE SET choice=excluded.choice, updated_at=excluded.updated_at""",
                        (attempt_id, question_id, body.choice, now),
                    )
                    database.insert_event(
                        connection, attempt_id, "answer_changed" if old else "answer_selected", now,
                        question_id=question_id, unit_id=unit["id"], client_at=body.clientAt,
                        payload={"from": old, "to": body.choice},
                    )
        if not attempt:
            raise HTTPException(404, "attempt not found")
        if timed_out:
            write_export(attempt_id)
        if attempt["status"] != "active":
            raise HTTPException(409, "attempt is closed")
        return {"questionId": question_id, "choice": body.choice, "updatedAt": now, "changed": old != body.choice}

    @api.post("/api/attempts/{attempt_id}/submit")
    def submit(attempt_id: int):
        with database.connect(immediate=True) as connection:
            now = clock()
            attempt, timed_out = database.prepare_attempt(connection, attempt_id, now)
            changed = timed_out
            if attempt and attempt["status"] == "active":
                attempt = database.close_attempt(attempt_id, now, "user", connection)
                changed = True
        if not attempt:
            raise HTTPException(404, "attempt not found")
        if changed:
            write_export(attempt_id)
        state = attempt_state(attempt)
        if state["status"] == "active":
            return state
        return review_data(attempt_id)

    @api.get("/api/attempts/{attempt_id}/review")
    def review(attempt_id: int):
        get_attempt(attempt_id)
        return review_data(attempt_id)

    @api.put("/api/attempts/{attempt_id}/reviews/{question_id}")
    def update_review(attempt_id: int, question_id: str, body: ReviewUpdate):
        attempt = get_attempt(attempt_id)
        if attempt["status"] == "active":
            raise HTTPException(409, "review is available only after submission")
        review_data(attempt_id)
        ensure_question(get_test(attempt["test_id"]), question_id)
        now = clock()
        with database.connect(immediate=True) as connection:
            connection.execute(
                """INSERT INTO reviews(attempt_id, question_id, note, updated_at) VALUES (?, ?, ?, ?)
                   ON CONFLICT(attempt_id, question_id) DO UPDATE SET note=excluded.note, updated_at=excluded.updated_at""",
                (attempt_id, question_id, body.note, now),
            )
        write_export(attempt_id)
        return {"questionId": question_id, "note": body.note, "updatedAt": now}

    if web.is_dir():
        api.mount("/", StaticFiles(directory=web, html=True), name="web")
    else:
        @api.get("/")
        def missing_frontend():
            return JSONResponse({"detail": "frontend is not installed"}, status_code=503)
    return api


app = create_app()
