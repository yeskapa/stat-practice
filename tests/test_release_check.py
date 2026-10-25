import json
import hashlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from release_check import check_review, check_test


def write_candidate(tmp_path):
    candidate = tmp_path / "DRAFT-test.json"
    questions = [
        {
            "id": f"q{number}",
            "originalNumber": number,
            "sourcePage": 1,
            "promptHtml": (
                '<p>What does <a href="#line-8" data-source-ref="line-8">the highlighted text</a> mean?</p>'
                if number == 1 else "<p>Question?</p>"
            ),
            "options": {letter: letter for letter in "ABCD"},
            "correctAnswer": "A",
        }
        for number in range(1, 5)
    ]
    data = {
        "id": "candidate",
        "qualityGateVersion": 2,
        "questionCount": 4,
        "durationSeconds": 300,
        "units": [{
            "id": "u1",
            "originalUnit": 1,
            "sourcePages": [1],
            "stimulusHtml": '<p><span id="line-8">Pertinent sentence.</span></p>',
            "assets": [],
            "questions": questions,
        }],
    }
    candidate.write_text(json.dumps(data), encoding="utf-8")
    review = {
        "testId": "candidate",
        "reviewer": "independent pass",
        "candidateSha256": hashlib.sha256(candidate.read_bytes()).hexdigest(),
        "assetSha256": {},
        "units": {"u1": {
            "contentExact": True,
            "answerKeyExact": True,
            "layoutLegible": True,
            "cropComplete": True,
            "noVisibleDuplication": True,
        }},
    }
    (tmp_path / "QA-review.json").write_text(json.dumps(review), encoding="utf-8")
    return candidate


def test_strict_candidate_and_review_gate(tmp_path):
    candidate = write_candidate(tmp_path)
    assert check_test(candidate, strict=True) == []
    assert check_review(candidate) == []

    data = json.loads(candidate.read_text(encoding="utf-8"))
    data["units"][0]["questions"][0]["promptHtml"] = (
        '<p><a data-source-ref="missing">the highlighted text</a></p>'
    )
    candidate.write_text(json.dumps(data), encoding="utf-8")
    assert any("has no stimulus target" in error for error in check_test(candidate, strict=True))


def test_question_specific_source_is_checked(tmp_path):
    candidate = write_candidate(tmp_path)
    data = json.loads(candidate.read_text(encoding="utf-8"))
    question = data["units"][0]["questions"][0]
    question["promptHtml"] = '<p><a data-source-ref="extra-line">This line</a>?</p>'
    question["stimulusSupplementHtml"] = '<p id="extra-line">Additional source.</p>'
    candidate.write_text(json.dumps(data), encoding="utf-8")
    assert check_test(candidate, strict=True) == []
    question["stimulusSupplementHtml"] += '<img src="/api/tests/candidate/assets/missing.png">'
    candidate.write_text(json.dumps(data), encoding="utf-8")
    errors = check_test(candidate, strict=True)
    assert any("without concise alt" in error for error in errors)
    assert any("missing asset" in error for error in errors)


def test_review_hash_rejects_changed_content(tmp_path):
    candidate = write_candidate(tmp_path)
    review_path = tmp_path / "QA-review.json"
    review = json.loads(review_path.read_text(encoding="utf-8"))
    review["candidateSha256"] = hashlib.sha256(candidate.read_bytes()).hexdigest()
    review_path.write_text(json.dumps(review), encoding="utf-8")
    assert check_review(candidate) == []
    candidate.write_text(candidate.read_text(encoding="utf-8") + "\n", encoding="utf-8")
    assert any("changed after independent review" in error for error in check_review(candidate))


def test_review_hash_rejects_changed_figure(tmp_path):
    candidate = write_candidate(tmp_path)
    assets = tmp_path / "assets"
    assets.mkdir()
    figure = assets / "diagram.png"
    figure.write_bytes(b"reviewed figure")
    review_path = tmp_path / "QA-review.json"
    review = json.loads(review_path.read_text(encoding="utf-8"))
    review["assetSha256"] = {figure.name: hashlib.sha256(figure.read_bytes()).hexdigest()}
    review_path.write_text(json.dumps(review), encoding="utf-8")
    assert check_review(candidate) == []
    figure.write_bytes(b"cropped differently")
    assert any("reviewed asset changed" in error for error in check_review(candidate))


def test_native_option_counts_and_key_membership(tmp_path):
    candidate = write_candidate(tmp_path)
    data = json.loads(candidate.read_text(encoding="utf-8"))
    question = data["units"][0]["questions"][0]
    for letters in ("ABCDE", "ABCDEF", "ABCDEFG", "ABCDEFGH"):
        question["options"] = {letter: letter for letter in letters}
        question["correctAnswer"] = letters[-1]
        candidate.write_text(json.dumps(data), encoding="utf-8")
        assert check_test(candidate, strict=True) == []
    question["options"].pop("E")
    candidate.write_text(json.dumps(data), encoding="utf-8")
    assert any("consecutive" in error for error in check_test(candidate, strict=True))


def test_review_requires_candidate_and_complete_asset_hashes(tmp_path):
    candidate = write_candidate(tmp_path)
    review_path = tmp_path / "QA-review.json"
    review = json.loads(review_path.read_text(encoding="utf-8"))
    review.pop("candidateSha256")
    review.pop("assetSha256")
    review_path.write_text(json.dumps(review), encoding="utf-8")
    errors = check_review(candidate)
    assert any("candidate SHA-256 is missing" in error for error in errors)
    assert any("asset SHA-256 mapping is missing" in error for error in errors)
    review["candidateSha256"] = hashlib.sha256(candidate.read_bytes()).hexdigest()
    review["assetSha256"] = {}
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "unreviewed.png").write_bytes(b"unreviewed")
    review_path.write_text(json.dumps(review), encoding="utf-8")
    assert any("coverage does not exactly match" in error for error in check_review(candidate))
