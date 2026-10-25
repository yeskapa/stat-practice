"""Exercise the first-pass path without independent-review records."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from check_import import check_import


def make_paper(tmp_path):
    folder = tmp_path / "sample-paper"
    folder.mkdir()
    path = folder / "DRAFT-test.json"
    paper = {
        "id": "sample-paper", "title": "Sample", "qualityGateVersion": 2,
        "simulationType": "adapted-practice", "questionCount": 1,
        "durationSeconds": 600, "sourceDurationSeconds": 1200,
        "units": [{"id": "u1", "sourcePages": [1], "stimulusHtml": "<p>Two plus two.</p>",
                   "questions": [{"id": "q1", "originalNumber": 1, "sourcePage": 1,
                                  "category": "quantitative", "promptHtml": "<p>Sum?</p>",
                                  "options": {"A": "1", "B": "2", "C": "3", "D": "4"},
                                  "correctAnswer": "D"}]}],
    }
    path.write_text(json.dumps(paper), encoding="utf-8")
    return path, paper


def test_import_grades_adapted_subset_without_qa_record(tmp_path):
    path, _ = make_paper(tmp_path)
    assert check_import(path) == []
    assert not (path.parent / "test.json").exists()
    assert not (path.parent / "QA-review.json").exists()


def test_import_rejects_incomplete_source_and_invalid_runtime_timer(tmp_path):
    path, paper = make_paper(tmp_path)
    paper["units"][0]["questions"][0]["sourcePage"] = 2
    path.write_text(json.dumps(paper), encoding="utf-8")
    assert any("sourcePage" in error for error in check_import(path))
    paper["units"][0]["questions"][0]["sourcePage"] = 1
    paper["durationSeconds"] = 30
    path.write_text(json.dumps(paper), encoding="utf-8")
    import pytest
    with pytest.raises(ValueError, match="invalid test duration"):
        check_import(path)
