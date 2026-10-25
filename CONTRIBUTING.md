# Contributing

Focused fixes and original reasoning questions are welcome. Keep the interface quiet and functional; use existing components and avoid decorative labels or containers.

## Report a problem

Open a repository issue with the commit/version, operating system, browser, reproduction steps, expected result, and actual result. For question errors include the test ID, original question number, option involved, and reasoning or a permitted source link. Flag missing context, ambiguity, broken diagrams, and questionable keys. Do not post third-party passages or images without permission.

Never upload `data/`, databases, attempt exports, private notes, browser storage, or real candidate details. Redact screenshots. Report security issues privately as described in [SECURITY.md](SECURITY.md).

## Develop

Install `requirements.txt`; run `python -m pytest -q` and, with Node.js available, `node --test tests/*.test.cjs`. Python 3.10+ is required. Add focused tests for changed logic and describe verification limits in the pull request.

Packs contributed to this public repository require original or explicitly permitted content and independent question review. Personal local imports use the single-agent [import skill](skills/import-mock/SKILL.md) and do not require that independent-review stage. Follow [CONTENT_POLICY.md](CONTENT_POLICY.md). Write explanations that justify the correct answer and reject plausible alternatives. Preserve complete unit stimuli.

Permissions and correctness are separate reviews. Do not call a structurally validated paper fully verified until source, semantic, and visual reviews are complete.

## Prepare a source-only distribution

Run `python scripts/export_public.py --output ../stat-practice-export` with a new destination folder. The explicit allowlist includes the app, documentation, skill, tests and original demo. Downloaded papers, local imports, databases and notes are excluded. The export includes a SHA-256 file manifest. Verify the exported folder with the commands in [Validation](VALIDATION.md) before distributing it.

## Project layout

- `app.py`: HTTP API, content loading and attempt coordination.
- `db.py`: SQLite storage and transactional answer/timing updates.
- `web/`: the test interface and results analysis, using plain HTML, CSS and JavaScript.
- `content/tests/`: the original demo and ignored local imports.
- `skills/import-mock/`: import instructions, format and source conversion notes.
- `scripts/`: import validation, release checks and source-only export.
- `tests/`: API, persistence, import/export and frontend-logic regression tests.
- `docs/assets/readme/`: product screenshots; never include real attempt data or uncleared question material.

Keep changes focused on the existing modules. New application layers, build tools or dependencies should solve a concrete problem. Exam-interface changes should preserve the STAT reference layout; results analysis can evolve independently.
