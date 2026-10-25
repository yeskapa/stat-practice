# Test format

Paths below are relative to the repository. Start from this minimal shape (replace all example content):

```json
{
  "id": "example-paper",
  "title": "Example paper — Reasoning practice",
  "qualityGateVersion": 2,
  "simulationType": "native-source-paper",
  "source": "Publisher, edition, section",
  "questionCount": 1,
  "durationSeconds": 3600,
  "sourceDurationSeconds": 3600,
  "units": [{
    "id": "example-paper-u01",
    "sourcePages": [2],
    "stimulusHtml": "<p>Complete shared stimulus.</p>",
    "assets": [],
    "questions": [{
      "id": "example-paper-q001",
      "originalNumber": 1,
      "sourceQuestionNumber": 1,
      "sourcePage": 2,
      "category": "verbal",
      "promptHtml": "<p>Exact source prompt?</p>",
      "options": {"A": "First", "B": "Second", "C": "Third", "D": "Fourth"},
      "correctAnswer": "B",
      "explanation": null
    }]
  }]
}
```

- `originalNumber` is consecutive app numbering from 1. `sourceQuestionNumber` preserves the paper number; add `sourcePaper` and `sourceModule` for mixed selections. Pages are physical PDF pages, starting at 1. Each question's page belongs in its unit's `sourcePages`.
- Native papers use `simulationType: native-source-paper` and equal source/configured duration. For a custom subset or adapted timing, use `simulationType: adapted-practice`, preserving the source duration and explaining the choice. The runtime currently fixes **every 70-question test at 7,200 seconds**. A differently timed native 70-question paper needs an explicitly agreed app change; do not mislabel the timing. Other durations must be 60–14,400 seconds.
- Use four to eight consecutive option letters A–H; preserve native order. Categories are `verbal` or `quantitative`; label inferred classifications editorial in the notes. Do not invent explanations: `null` is valid.
- Image HTML: `<img src="/api/tests/example-paper/assets/figure-01.png" alt="Chart of annual output">`. Use local relative asset names in `assets`, never remote scripts or dependencies. Content is trusted HTML; exclude scripts, event handlers, remote embeds and executable markup copied from websites.
- No shared stimulus? Put the complete item's source context in its own unit. Source line references can use `<span id="example-line-8">...</span>` and `<a href="#example-line-8" data-source-ref="example-line-8">line 8</a>`. Target IDs must exist in that unit.
- Files named `test.json` are enabled immediately. Keep new content named `DRAFT-test.json` until checks pass. Avoid reserved split/challenge simulation types: they require existing source snapshots and special invariants.
