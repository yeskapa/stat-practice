"""Copy an explicit public allowlist into a new folder; never copy private data."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Every added path needs review for personal information and distribution rights.
PUBLIC_FILES = (
    ".gitignore", ".gitattributes", ".github/workflows/checks.yml",
    "README.md", "LICENSE", "CONTENT_POLICY.md", "CONTRIBUTING.md", "SECURITY.md",
    "VALIDATION.md", "PRACTICE_SOURCES.md",
    "MOCK_SOURCES.md", "CHALLENGE_SELECTION.csv",
    "skills/import-mock/SKILL.md",
    "skills/import-mock/references/format.md",
    "skills/import-mock/references/conversion.md",
    "docs/assets/readme/exam-fc381acbcb.png", "docs/assets/readme/statistics.png",
    "app.py", "db.py", "requirements.txt", "START_MOCK.cmd", "start.ps1",
    "web/index.html", "web/app.js", "web/styles.css", "web/statistics.js",
    "scripts/release_check.py", "scripts/export_public.py",
    "scripts/check_import.py", "tests/test_import.py",
    "content/tests/system-check/test.json",
    "tests/conftest.py", "tests/test_release_check.py", "tests/test_public_export.py",
    "tests/test_installation.py",
    "tests/statistics.test.cjs", "tests/review_practice.test.cjs",
)


def export_public(output: Path, *, root: Path = ROOT) -> list[dict[str, str]]:
    root = root.resolve()
    output = output.absolute()
    if output.exists() or output.is_symlink():
        raise ValueError("Destination already exists; choose a new folder.")
    if not output.parent.is_dir():
        raise ValueError("Destination parent directory must already exist.")
    sources = []
    for name in PUBLIC_FILES:
        source = root / name
        if any(part.is_symlink() for part in (source, *source.parents) if part != root and root in part.parents):
            raise ValueError(f"Public export refuses symbolic links: {name}")
        if not source.is_file() or not source.resolve().is_relative_to(root):
            raise ValueError(f"Missing or unsafe public file: {name}")
        sources.append((name, source))
    output.mkdir()
    manifest = []
    for name, source in sources:
        destination = output / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        data = source.read_bytes()
        if source.suffix.lower() != ".png":
            data = data.replace(b"\r\n", b"\n")
        destination.write_bytes(data)
        manifest.append({"path": name, "sha256": hashlib.sha256(destination.read_bytes()).hexdigest()})
    (output / "PUBLIC_RELEASE_MANIFEST.json").write_text(
        json.dumps({"formatVersion": 1, "files": manifest}, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="new directory to create")
    args = parser.parse_args()
    try:
        files = export_public(args.output)
    except (ValueError, OSError) as exc:
        parser.exit(1, f"Public export failed: {exc}\n")
    print(f"Exported {len(files)} allowlisted files to {args.output.absolute()}")
    print("Only original system-check content is included. Third-party mocks and personal data are excluded.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
