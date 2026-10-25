"""Check one local import without requiring independent-review certification."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile

from release_check import check_test

ROOT = Path(__file__).resolve().parents[1]


def check_import(candidate: Path) -> list[str]:
    errors = check_test(candidate, strict=True)
    if errors:
        return errors
    paper = json.loads(candidate.read_text(encoding="utf-8"))
    test_id = paper.get("id", "")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", test_id) or candidate.parent.name != test_id:
        return ["Test ID must be lowercase-hyphenated and match its directory name"]
    questions = [q for unit in paper["units"] for q in unit["questions"]]
    if not questions:
        return ["Import must contain questions"]
    if any(q.get("category") not in {"verbal", "quantitative"} for q in questions):
        return ["Every question needs a verbal or quantitative category"]

    # Importing app creates a module-level app too; isolate both instances.
    with tempfile.TemporaryDirectory(prefix="stat-import-") as directory:
        temp = Path(directory)
        previous = {key: os.environ.get(key) for key in ("STAT_DB_PATH", "STAT_EXPORT_PATH")}
        os.environ["STAT_DB_PATH"] = str(temp / "module.db")
        os.environ["STAT_EXPORT_PATH"] = str(temp / "module-export.json")
        sys.path.insert(0, str(ROOT))
        try:
            from app import create_app, test_duration
            from fastapi.testclient import TestClient

            if test_duration(paper) != paper["durationSeconds"]:
                return ["Configured duration differs from runtime duration"]
            target = temp / "content" / test_id
            target.mkdir(parents=True)
            shutil.copyfile(candidate, target / "test.json")
            if (candidate.parent / "assets").exists():
                shutil.copytree(candidate.parent / "assets", target / "assets")
            app = create_app(db_path=temp / "check.db", export_path=temp / "export.json",
                             content_dir=temp / "content", web_dir=ROOT / "web",
                             clock=lambda: 1_000_000)
            with TestClient(app) as client:
                response = client.get(f"/api/tests/{test_id}")
                if response.status_code != 200:
                    return [f"Test cannot load: HTTP {response.status_code}"]
                public_questions = [q for u in response.json()["units"] for q in u["questions"]]
                if any("correctAnswer" in q or "explanation" in q for q in public_questions):
                    return ["Pre-submission payload exposes answers"]
                started = client.post("/api/attempts", json={"testId": test_id})
                if started.status_code != 201:
                    return [f"Cannot start sitting: HTTP {started.status_code}"]
                attempt = started.json()
                if attempt["remainingMs"] != paper["durationSeconds"] * 1000:
                    return ["Initial timer differs from configured allowance"]
                url = f"/api/attempts/{attempt['id']}"
                for offset in range(0, len(questions), 100):
                    saved = client.post(url + "/sync", json={"answers": [
                        {"mutationId": q["id"], "questionId": q["id"], "revision": 1,
                         "choice": q["correctAnswer"]} for q in questions[offset:offset + 100]
                    ]})
                    if saved.status_code != 200:
                        return [f"Answer saving failed: HTTP {saved.status_code}"]
                if client.post(url + "/sync", json={"submit": True}).status_code != 200:
                    return ["Submission failed"]
                reviewed = client.get(url + "/review")
                if reviewed.status_code != 200:
                    return ["Review failed"]
                results = reviewed.json()["questions"]
                if len(results) != len(questions) or not all(q["correct"] for q in results):
                    return ["Full-key sitting did not grade every question correctly"]
                for asset in (target / "assets").rglob("*"):
                    if asset.is_file():
                        name = asset.relative_to(target / "assets").as_posix()
                        if client.get(f"/api/tests/{test_id}/assets/{name}").status_code != 200:
                            return [f"Asset cannot be served: {name}"]
        finally:
            sys.path.pop(0)
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
    return []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("candidate", type=Path)
    args = parser.parse_args()
    try:
        errors = check_import(args.candidate.resolve())
    except (ValueError, KeyError, TypeError, OSError) as exc:
        errors = [str(exc)]
    if errors:
        print("IMPORT CHECK FAILED\n" + "\n".join(f"- {error}" for error in errors))
        return 1
    print("IMPORT CHECK PASSED: structure, assets, timer, answer secrecy, saving and full-key grading.")
    print("Not an independent source, transcription, reasoning or rendered-UI review.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
