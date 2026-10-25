"""Fail fast if enabled or candidate mock content is incomplete or unsafe."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from html import unescape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEST_ROOT = ROOT / "content" / "tests"
CHOICE_LETTERS = "ABCDEFGH"
ASSET_RE = re.compile(r'src=["\'](/api/tests/([^/]+)/assets/([^"\']+))["\']')
TAG_RE = re.compile(r"<[^>]+>")
IMG_RE = re.compile(r"<img\b[^>]*>", re.I)
ALT_RE = re.compile(r"\balt=[\"\']([^\"\']*)[\"\']", re.I)
PARAGRAPH_RE = re.compile(r"<p\b[^>]*>(.*?)</p>", re.I | re.S)
ID_RE = re.compile(r"\bid=[\"\']([^\"\']+)[\"\']", re.I)
SOURCE_REF_RE = re.compile(r"\bdata-source-ref=[\"\']([^\"\']+)[\"\']", re.I)
QA_FIELDS = {
    "contentExact", "answerKeyExact", "layoutLegible", "cropComplete", "noVisibleDuplication"
}


def visible_text(value: object) -> str:
    return re.sub(r"\s+", " ", unescape(TAG_RE.sub(" ", str(value or "")))).strip()


def check_test(path: Path, *, strict: bool = False) -> list[str]:
    errors: list[str] = []
    try:
        test = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return [f"{path}: invalid JSON: {exc}"]

    test_id = test.get("id")
    units = test.get("units", [])
    questions = [question for unit in units for question in unit.get("questions", [])]
    expected = test.get("questionCount")
    if expected != len(questions):
        errors.append(f"{test_id}: questionCount is {expected}, found {len(questions)}")
    if len(questions) == 70 and test.get("durationSeconds") != 7200:
        errors.append(f"{test_id}: a 70-question mock must be exactly 7,200 seconds")
    native_paper = test.get("simulationType") == "native-source-paper"
    split_practice = test.get("simulationType") == "split-practice"
    challenge_part = test.get("simulationType") == "challenge-part"
    if challenge_part:
        source_id = test.get("sourceTestId", "")
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", source_id):
            errors.append(f"{test_id}: invalid challenge source")
        else:
            source_path = path.parent.parent / source_id / "full-source.json"
            if not source_path.is_file():
                errors.append(f"{test_id}: missing original challenge snapshot")
            else:
                source = json.loads(source_path.read_text(encoding="utf-8"))
                first, last = (1, 50) if test.get("partNumber") == 1 else (51, 70)
                expected_units = [u for u in source["units"]
                                  if all(first <= q["originalNumber"] <= last for q in u["questions"])]
                restored = json.loads(json.dumps(units).replace(
                    f"/api/tests/{test_id}/assets/", f"/api/tests/{source_id}/assets/"))
                if restored != expected_units or len(questions) != last - first + 1:
                    errors.append(f"{test_id}: challenge part must preserve its complete original units")
                expected_duration = 3600 if test_id == "stat-challenge-01-part-2" else len(questions) * 120
                if test.get("durationSeconds") != expected_duration:
                    errors.append(f"{test_id}: challenge part must allow {expected_duration} seconds")
    if split_practice:
        source_id = test.get("sourceTestId", "")
        source_path = path.parent.parent / source_id / "test.json"
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", source_id) or source_id == test_id or not source_path.is_file():
            errors.append(f"{test_id}: split practice has no valid source test")
        else:
            source = json.loads(source_path.read_text(encoding="utf-8"))
            source_units = {unit["id"]: unit for unit in source["units"]}
            restored = json.loads(json.dumps(units).replace(
                f"/api/tests/{test_id}/assets/", f"/api/tests/{source_id}/assets/"
            ))
            if any(unit != source_units.get(unit.get("id")) for unit in restored):
                errors.append(f"{test_id}: split practice must preserve complete source units")
        counts = [sum(q.get("category") == category for q in questions)
                  for category in ("verbal", "quantitative")]
        if len(questions) not in {34, 36} or counts[0] != counts[1] or sum(counts) != len(questions):
            errors.append(f"{test_id}: split practice must have 34 or 36 equally balanced questions")
        if test.get("durationSeconds") != 3600:
            errors.append(f"{test_id}: split practice must be exactly 3,600 seconds")
    adapted_practice = test.get("simulationType") == "adapted-practice"
    if len(questions) not in {4, 70} and not native_paper and not adapted_practice and not split_practice and not challenge_part:
        errors.append(f"{test_id}: enabled test has unexpected length {len(questions)}")
    if native_paper and test.get("durationSeconds") != test.get("sourceDurationSeconds"):
        errors.append(f"{test_id}: native source paper must retain its source duration")

    ids: set[str] = set()
    unit_ids: set[str] = set()
    if strict and test.get("qualityGateVersion") != 2:
        errors.append(f"{test_id}: candidate must declare qualityGateVersion 2")
    for unit_number, unit in enumerate(units, 1):
        unit_id = unit.get("id")
        if not unit_id or unit_id in unit_ids:
            errors.append(f"{test_id}: missing or duplicate unit id at position {unit_number}")
        unit_ids.add(unit_id)
        if strict:
            pages = unit.get("sourcePages")
            if not isinstance(pages, list) or not pages or not all(isinstance(page, int) and page > 0 for page in pages):
                errors.append(f"{test_id}: {unit_id} has no valid sourcePages")
            stimulus = unit.get("stimulusHtml", "") + "".join(
                question.get("stimulusSupplementHtml", "") for question in unit.get("questions", [])
            )
            if not visible_text(stimulus) and not IMG_RE.search(stimulus):
                errors.append(f"{test_id}: {unit_id} has no usable stimulus")
            for image in IMG_RE.findall(stimulus):
                alt = ALT_RE.search(image)
                if not alt or not alt.group(1).strip():
                    errors.append(f"{test_id}: {unit_id} has an image without concise alt text")
            for paragraph in PARAGRAPH_RE.findall(stimulus):
                text = visible_text(paragraph)
                if len(text) >= 120 and text.count(" / ") >= 3:
                    errors.append(f"{test_id}: {unit_id} appears to flatten line-based text with slashes")
            targets = set(ID_RE.findall(stimulus))
            refs = {
                ref
                for question in unit.get("questions", [])
                for ref in SOURCE_REF_RE.findall(str(question.get("promptHtml", "")))
            }
            for ref in sorted(refs - targets):
                errors.append(f"{test_id}: {unit_id} source reference {ref!r} has no stimulus target")

    for number, question in enumerate(questions, 1):
        question_id = question.get("id")
        if not question_id or question_id in ids:
            errors.append(f"{test_id}: missing or duplicate question id at position {number}")
        ids.add(question_id)
        if not split_practice and not challenge_part and question.get("originalNumber") != number:
            errors.append(f"{test_id}: question {question_id} is not numbered {number}")
        options = question.get("options", {})
        if not 4 <= len(options) <= len(CHOICE_LETTERS) or set(options) != set(CHOICE_LETTERS[:len(options)]):
            errors.append(f"{test_id}: question {question_id} must have 4-8 consecutive options starting at A")
        if question.get("correctAnswer") not in options:
            errors.append(f"{test_id}: question {question_id} has no valid answer key")
        if strict:
            if not visible_text(question.get("promptHtml")) and not IMG_RE.search(str(question.get("promptHtml", ""))):
                errors.append(f"{test_id}: question {question_id} has no usable prompt")
            parent = next((unit for unit in units if question in unit.get("questions", [])), {})
            if question.get("sourcePage") not in parent.get("sourcePages", []):
                errors.append(f"{test_id}: question {question_id} sourcePage is outside its unit sourcePages")
            for letter, option in question.get("options", {}).items():
                if not visible_text(option) and not IMG_RE.search(str(option)):
                    errors.append(f"{test_id}: question {question_id} option {letter} is empty")

    raw = path.read_text(encoding="utf-8")
    for forbidden in ("TODO", "PLACEHOLDER", "&lt;img"):
        if forbidden.lower() in raw.lower():
            errors.append(f"{test_id}: contains unfinished marker {forbidden!r}")
    content_html = "\n".join(
        fragment
        for unit in units
        for fragment in [unit.get("stimulusHtml", ""), *(
            value for question in unit.get("questions", [])
            for value in [question.get("promptHtml", ""), question.get("stimulusSupplementHtml", ""),
                          *question.get("options", {}).values()]
        )]
    )
    for route, route_test_id, asset_name in ASSET_RE.findall(content_html):
        if route_test_id != test_id:
            errors.append(f"{test_id}: asset route points at {route_test_id}: {route}")
        asset = path.parent / "assets" / asset_name
        if not asset.is_file() or asset.stat().st_size == 0:
            errors.append(f"{test_id}: missing asset {asset_name}")
    return errors


def check_review(test_path: Path) -> list[str]:
    review_path = test_path.with_name("QA-review.json")
    if not review_path.is_file():
        return [f"{test_path}: missing independent QA-review.json"]
    try:
        test = json.loads(test_path.read_text(encoding="utf-8"))
        review = json.loads(review_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return [f"{review_path}: invalid review data: {exc}"]
    errors: list[str] = []
    if review.get("testId") != test.get("id"):
        errors.append(f"{review_path}: testId does not match candidate")
    if not str(review.get("reviewer", "")).strip():
        errors.append(f"{review_path}: reviewer is missing")
    reviewed_hash = review.get("candidateSha256", review.get("draftSha256"))
    if not reviewed_hash:
        errors.append(f"{review_path}: candidate SHA-256 is missing")
    elif reviewed_hash != hashlib.sha256(test_path.read_bytes()).hexdigest():
        errors.append(f"{review_path}: content changed after independent review")
    asset_hashes = review.get("assetSha256")
    expected_assets = {asset.relative_to(test_path.parent / "assets").as_posix()
                       for asset in (test_path.parent / "assets").rglob("*") if asset.is_file()}
    if not isinstance(asset_hashes, dict):
        errors.append(f"{review_path}: asset SHA-256 mapping is missing")
        asset_hashes = {}
    if set(asset_hashes) != expected_assets:
        errors.append(f"{review_path}: asset SHA-256 coverage does not exactly match candidate assets")
    for name, reviewed_asset_hash in asset_hashes.items():
        asset = test_path.parent / "assets" / name
        if not asset.is_file() or hashlib.sha256(asset.read_bytes()).hexdigest() != reviewed_asset_hash:
            errors.append(f"{review_path}: reviewed asset changed or missing: {name}")
    expected = {unit.get("id") for unit in test.get("units", [])}
    reviewed = set(review.get("units", {}))
    if reviewed != expected:
        errors.append(f"{review_path}: reviewed unit ids do not exactly match the candidate")
    for unit_id, result in review.get("units", {}).items():
        failed = sorted(field for field in QA_FIELDS if result.get(field) is not True)
        if failed:
            errors.append(f"{review_path}: {unit_id} has incomplete checks: {', '.join(failed)}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", type=Path, help="strictly check one invisible DRAFT-test.json")
    parser.add_argument("--allow-demo-only", action="store_true", help="allow the public package with only the original system check")
    args = parser.parse_args()
    enabled = [args.candidate.resolve()] if args.candidate else sorted(TEST_ROOT.glob("*/test.json"))
    errors: list[str] = []
    enabled_ids = {path.parent.name for path in enabled}
    if not args.candidate and "system-check" not in enabled_ids:
        errors.append("the temporary system check is not enabled")
    for path in enabled:
        errors.extend(check_test(path, strict=bool(args.candidate)))
        if args.candidate:
            errors.extend(check_review(path))
    full_mocks = []
    for path in enabled:
        test = json.loads(path.read_text(encoding="utf-8"))
        if test.get("questionCount") == 70:
            full_mocks.append(path)
    if not args.candidate and not full_mocks and not args.allow_demo_only:
        errors.append("no complete 70-question mock is enabled")

    if errors:
        print("READINESS CHECK FAILED")
        for error in errors:
            print(f"- {error}")
        return 1
    if args.candidate:
        print(f"CANDIDATE READY: {enabled[0]} passed strict content and independent-review checks.")
    else:
        print(f"READY: {len(enabled)} test(s) structurally validated; {len(full_mocks)} complete 70-question / 2h mock(s). Content correctness and publication rights require separate review.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
