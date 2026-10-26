# Repo index impact (v0, 2026-10-26)

Questions: 56, fixed before the index was built (scripts/index/questions.json). Index: 4441 entries, built in 849 ms.
Reading every doc once would cost about 155,742 tokens (reference only).

| | Index | Grep + read (baseline) |
|---|---|---|
| Answers reached | 49/56 | 56/56 |
| Tokens per question (median) | 700 | 9295 |
| Tokens, all 56 questions | 88,937 | 555,496 (index uses 84% less) |

| Kind | n | Index | Baseline | Median tokens index / baseline |
|---|---|---|---|---|
| finding | 15 | 15 | 15 | 894 / 9575 |
| work | 10 | 10 | 10 | 6580 / 17615 |
| decision | 8 | 8 | 8 | 510 / 13767 |
| tool | 6 | 6 | 6 | 592 / 7627 |
| command | 6 | 6 | 6 | 410 / 1021 |
| topic | 8 | 1 | 8 | 696 / 6661 |
| planted | 3 | 3 | 3 | 9 / 0 |

## Every miss

- topic `ai_modeller section in the guard`: index MISS (top doc:docs/AI_ASSISTED_MODELLER.md, weak), baseline hit
- topic `stop ai switch`: index MISS (top PR-29, weak), baseline hit
- topic `ai involvement bands`: index MISS (top sym:AiBand, weak), baseline hit
- topic `ai approval queue`: index MISS (top sym:AiQueueLine, weak), baseline hit
- topic `live model lock verdict`: index MISS (top sym:liveLockVerdict, weak), baseline hit
- topic `updater installs when revit is closed`: index MISS (top PR-63, weak), baseline hit
- topic `selftest rulebook line`: index MISS (top file:server/src/fmc/selftest.ts, weak), baseline hit
