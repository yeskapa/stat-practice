"""Public distribution boundaries and a disposable system-check sitting."""

import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("public_export", ROOT / "scripts/export_public.py")
public_export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(public_export)


def test_allowlist_excludes_private_material_and_preserves_source(tmp_path):
    root = tmp_path / "private"
    root.mkdir()
    for name in public_export.PUBLIC_FILES:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"public fixture: {name}", encoding="utf-8")
    private_names = (
        "data/stat.db", "data/backups/secret.db", "LOCAL_HISTORY.md",
        "content/tests/vcaa-gat-2002/test.json", "content/tests/system-check/private-notes.txt",
        "reference/source.pdf", "web/secret.env", "tests/private-attempt.json",
    )
    for name in private_names:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("personal or uncleared", encoding="utf-8")
    output = tmp_path / "public"
    records = public_export.export_public(output, root=root)
    exported = {path.relative_to(output).as_posix() for path in output.rglob("*") if path.is_file()}
    assert exported == set(public_export.PUBLIC_FILES) | {"PUBLIC_RELEASE_MANIFEST.json"}
    assert all((root / name).read_text() == "personal or uncleared" for name in private_names)
    manifest = json.loads((output / "PUBLIC_RELEASE_MANIFEST.json").read_text())
    assert manifest["files"] == records
    for entry in records:
        assert hashlib.sha256((output / entry["path"]).read_bytes()).hexdigest() == entry["sha256"]
    with pytest.raises(ValueError, match="already exists"):
        public_export.export_public(output, root=root)


def test_missing_source_fails_before_creating_destination(tmp_path):
    output = tmp_path / "public"
    with pytest.raises(ValueError, match="Missing or unsafe"):
        public_export.export_public(output, root=tmp_path)
    assert not output.exists()


def test_export_normalizes_text_without_changing_the_source(tmp_path):
    root = tmp_path / "private"
    for name in public_export.PUBLIC_FILES:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"first\r\nsecond\r\n")
    output = tmp_path / "public"
    public_export.export_public(output, root=root)
    assert (output / "README.md").read_bytes() == b"first\nsecond\n"
    assert (root / "README.md").read_bytes() == b"first\r\nsecond\r\n"


def test_export_preserves_binary_screenshot_bytes(tmp_path):
    root = tmp_path / "source"
    for name in public_export.PUBLIC_FILES:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"text\r\n")
    screenshot = "docs/assets/readme/exam.png"
    payload = b"\x89PNG\r\n\x1a\n\x00\xff\r\n"
    (root / screenshot).write_bytes(payload)
    output = tmp_path / "export"
    public_export.export_public(output, root=root)
    assert (output / screenshot).read_bytes() == payload


def test_allowlisted_symlink_is_rejected_before_copy(tmp_path):
    root = tmp_path / "private"
    root.mkdir()
    for name in public_export.PUBLIC_FILES:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("fixture", encoding="utf-8")
    linked = root / "README.md"
    linked.unlink()
    private = tmp_path / "private-notes.txt"
    private.write_text("must not publish", encoding="utf-8")
    try:
        linked.symlink_to(private)
    except OSError:
        pytest.skip("Creating symlinks requires OS permission on this machine")
    output = tmp_path / "public"
    with pytest.raises(ValueError, match="symbolic links"):
        public_export.export_public(output, root=root)
    assert not output.exists()


def test_public_export_is_self_contained_and_demo_ready(tmp_path):
    output = tmp_path / "public"
    public_export.export_public(output)
    result = subprocess.run(
        [sys.executable, "scripts/release_check.py", "--allow-demo-only"],
        cwd=output, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    strict = subprocess.run(
        [sys.executable, "scripts/release_check.py"], cwd=output, capture_output=True, text=True,
    )
    assert strict.returncode != 0
    assert "no complete 70-question mock" in strict.stdout


def test_original_system_check_attempt_round_trip(tmp_path):
    from app import create_app

    app = create_app(
        db_path=tmp_path / "practice.db", export_path=tmp_path / "attempt.json",
        content_dir=ROOT / "content/tests", web_dir=ROOT / "web",
    )
    with TestClient(app) as client:
        response = client.get("/api/tests/system-check")
        assert response.status_code == 200
        paper = response.json()
        assert "correctAnswer" not in paper["units"][0]["questions"][0]
        attempt = client.post("/api/attempts", json={"testId": "system-check"})
        assert attempt.status_code == 201
        attempt_id = attempt.json()["id"]
        saved = client.put(f"/api/attempts/{attempt_id}/answers/system-check-q001", json={"choice": "C"})
        assert saved.status_code == 200
        submitted = client.post(f"/api/attempts/{attempt_id}/submit")
        assert submitted.status_code == 200
        reviewed = client.get(f"/api/attempts/{attempt_id}/review")
        assert reviewed.status_code == 200
        assert reviewed.json()["totals"]["raw"] == 1
        assert all(question["unitQuestionCount"] == 2 for question in reviewed.json()["questions"])
