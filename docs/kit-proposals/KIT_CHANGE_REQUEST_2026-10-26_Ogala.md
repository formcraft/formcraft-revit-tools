# Kit change request: from the Ogala Residence AI session (26 Oct 2026)

For the BIM Manager. Each item came from a real fault on THE OGALA RESIDENCE; none is in the kit yet.

| # | Change | Why (from the session) |
|---|---|---|
| 1 | Sweep-free variants of the OGL external wall types, for short walls and gable walls | 49 "Could not create integral wall sweep" warnings until the AI swapped types (batch d66e9180) |
| 2 | Rule in FMC_Rulebook_Families or Templates: integral sweeps only on wall types meant for full-length runs | Same warnings will come back on the next project otherwise |
| 3 | An OGL FF slab type in the template: 50 screed + 200 RC, set -20 mm in wet rooms | The AI built type 1672703 in code because the template had only a 250 placeholder |
| 4 | Steel and monolithic stair types in the template, with and without their own railings | create_stair failed on a type that adds its own railings; the BQ steel stair was made in code |
| 5 | Clay-tile roof type in the template | Roofs started as Generic 225 and were all changed to clay tile |
| 6 | Review the proposed values in FMC_Standards_Building.json and mark approved ones | Every value is "proposed" until you sign it off; the AI says so when it relies on one |
