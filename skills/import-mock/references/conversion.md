# Conversion notes from previous imports

Read the shared rules and only the selected paper's notes. These are historical implementation lessons, not certification of a new download.

## Shared

Preserve paragraphs, dialogue, poem lines, stanzas, superscripts, subscripts and meaningful indentation. Never flatten poetry into slash-separated text. Keep tables' row/column associations. Do not duplicate prose both in a crop and in HTML. Intentional repetition in the source stays intact. Crop from the full source figure, with a small margin, rather than estimating from extracted text bounds. Include axes, legends, arrowheads, endpoint boxes, captions, footnotes and every visual option. Never stretch images or hide tiny labels behind a restrictive height cap.

## GAT 2002

Prior import: 26 units, 24 assets, 70 questions. Its key supplied letters without category rows: the prior 32 verbal / 38 quantitative split was editorial, not official. Do not force every GAT into a 35/35 split.

## GAT 2004

Prior import: 24 units. Physical PDF page 2 is a writing spread; MCQ physical pages 5–38 correspond to printed pages 6–39. Do not offset page references using printed numbers. The previous optional 36/34-question halves preserved complete units and overlap the full paper; import the full MCQ paper by default.

## GAT 2010

PDF span joining previously detached punctuation, variable names and footnotes. Check italic boundaries and adjacent spans against the raster. Some diagram glyphs were mis-encoded, including an outlined-heart operator: retain the original diagram rather than guessing a symbol. Previous crop errors affected answer strips, a triangle, filter diagram, terminal flowchart boxes, a loop and the top of a painting. Check those complete figures during conversion.

## GAT 2011

Prior import: 22 units, 70 questions. Historical reviews disputed Q19's universal-versus-trend interpretation and Q69's distinction between the painting's emotional character and its subject's detachment. Preserve the published keys; flag those question numbers for the learner without changing the published key.

## GAT 2019 / 2021

Prior imports: 22 / 21 units respectively, 70 questions each. Preserve poem lines and numbered sentence references. Older official download URLs may return HTML or disappear; use the documented archive fallback and confirm PDF identity. The 120-minute MCQ simulation is adapted from the full GAT booklet's combined writing/MCQ schedule, not a claim that the whole source exam takes two hours.

## AST Sample 2005

80 questions in 23 units, 150 minutes. Preserve the native paper and its original Q/V labels (map Q to quantitative and V to verbal); do not truncate to 70. Its title says adapted from 2004. Prior checks covered keys and unit ranges, not comprehensive fresh crop/text verification.

## TSA / BMAT / SAT and Challenge 1

Preserve native option counts (including E–H where present). BMAT 2019 Q19–22 share one complete unit: retain all paragraphs, both figures and Q20's separate graph. Avoid table detectors mistaking graphs for tables. Preserve tick/cross symbols, numbered claims, superscripts, SAT underlining and answer blanks.

Challenge 1 is a custom 70-question selection, not a publisher paper. Use `CHALLENGE_SELECTION.csv` only when reproducing it. It maps source question numbers and modules without reproducing text or answers. Preserve row order and shared units; original full selection allowance was 120 minutes. TSA 2021 Q31 (selection position 21) had a historical ambiguity concerning hotel supplements/discount wording; flag it. The final selection replaced BMAT 2022 Q22 with Q1; use the published CSV, not an older selection. Classification and difficulty labels are editorial; no STAT score equivalence is established.
