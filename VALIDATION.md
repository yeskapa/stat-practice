# Validation

## Application checks

```sh
python -m pytest -q
node --test tests/*.test.cjs
python scripts/release_check.py --allow-demo-only
```

The Python tests cover installation isolation, content validation, export boundaries and API behaviour. JavaScript tests cover frontend logic. The release checker validates enabled content; `--allow-demo-only` permits an installation without a full mock.

## Imported papers

Run `python scripts/check_import.py content/tests/<id>/DRAFT-test.json` before enabling a new paper. It checks strict structure, source-page references, assets, initial timing, answer secrecy, saving and full-key grading in disposable databases. It does not change existing attempts.

The importing agent compares text and figures with the source during conversion. Automated checks cannot establish exact transcription, legibility, a uniquely defensible answer or equivalence to STAT difficulty. New imports still need their own source checks; the README's desktop screenshots do not certify every paper or viewport. Report questionable items using their source question numbers.

## Documentation screenshots

The exam screenshot was captured at 1412 × 956 from an isolated local GAT sitting. It shows the whole desktop viewport with unit material, one question, navigation, timer and Back/Next controls. Original sample content replaces third-party question material in the published image. The statistics report uses synthetic answers and timing in a disposable database. No personal attempt records or browser profile were used.

Both screenshots were inspected for legibility, missing content and overflow; the capture reported no page errors. Footer geometry was checked at 1412 × 956, 1440 × 1200, 1024 × 768 and 390 × 844, including tall stimulus and question content. It follows all question content and reaches the viewport bottom when the content is shorter. These checks do not establish pixel-perfect equivalence to official exam software, accessibility conformance or difficulty calibration. The interface reference date is 25 October 2026; official software may change.

For an optional independent source review, `scripts/release_check.py --candidate` additionally requires a hash-bound `QA-review.json`. This is separate from the default single-agent import path.
