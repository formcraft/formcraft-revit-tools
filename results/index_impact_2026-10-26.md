# Repo index impact (current, 2026-10-26)

Questions: 56, fixed before the index was built (scripts/index/questions.json). Index: 4892 entries, built in 940 ms.
Reading every doc once would cost about 155,742 tokens (reference only).

| | Index | Grep + read (baseline) |
|---|---|---|
| Answers reached | 54/56 | 56/56 |
| Tokens per question (median) | 780 | 9295 |
| Tokens, all 56 questions | 99,035 | 555,505 (index uses 82% less) |

| Kind | n | Index | Baseline | Median tokens index / baseline |
|---|---|---|---|---|
| finding | 15 | 15 | 15 | 917 / 9575 |
| work | 10 | 10 | 10 | 6641 / 17615 |
| decision | 8 | 8 | 8 | 536 / 13767 |
| tool | 6 | 6 | 6 | 616 / 7627 |
| command | 6 | 6 | 6 | 414 / 1021 |
| topic | 8 | 6 | 8 | 822 / 6661 |
| planted | 3 | 3 | 3 | 9 / 0 |

## Every miss

- topic `ai_modeller section in the guard`: index MISS (top sec:docs/AI_ASSISTED_MODELLER.md#how-the-plugin-will-enforce-it-after-approval, strong), baseline hit
- topic `updater installs when revit is closed`: index MISS (top sec:docs/TEST_FEEDBACK.md#run-4-2026-10-14-later-pilot-pc-revit-2025-4-new-unsaved-models, strong), baseline hit
