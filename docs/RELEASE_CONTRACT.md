# Release contract: design side → website (client portal)

The design side (this repo, `scripts/project/release.py`) builds a numbered release of a project. The website side
(formcraft-web-27) receives it, stores it, shows it to the client and the professionals, and emails the client.
This file is the agreement between the two sides. Change it only together.

## What a release is

A folder `<project>/01_WIP/_Release/R<nn>/`:

| Path | What |
|---|---|
| `manifest.json` | everything the website needs (below) |
| `changes.md` | the same change list, as text for the client email |
| `docs/*.html` | self-contained pages (reports, review packs); no external files except the CDN scripts they name |
| `data/*.json`, `data/*.xlsx` | the data behind the reports (internal or professional) |

## manifest.json (schema `formcraft.release/1`)

```json
{
  "schema": "formcraft.release/1",
  "project": "The Ogala Residence",
  "code": "OGL",
  "release": 1,
  "label": "R01",
  "date": "2026-10-28T14:40:00",
  "prepared_by": "Emlyn Atochon, Formcraft",
  "status": "preliminary",
  "note": "why this release was made",
  "changes": ["Updated: Structural design report", "Structure cost: UGX 238M → 247M"],
  "summary": {
    "cost_full_likely_ugx": {"architecture": 543000000, "structure": 277000000},
    "total_full_likely_ugx": 1290000000,
    "disciplines": {"structure": {"status": "designed", "checks_done": 4, "checks": 6}},
    "structure": {"steel_kg": 16278, "drift_mm": ["11.1", "41", "10.4", "34"], "checks": {"ties": "done"}, "redundant": true}
  },
  "documents": [
    {"key": "RPT-PROJECT", "title": "Project report", "discipline": "project", "kind": "client_report",
     "audience": "client", "file": "docs/OGL-FMC-RPT-PROJECT.html", "sha256": "…", "bytes": 3300000, "url": null}
  ]
}
```

- `audience`: `client` (the client sees it), `professional` (only the invited professional for that `discipline`),
  `internal` (Formcraft only, never shown to the client).
- `kind`: `client_report`, `design_report`, `review_pack`, `data`.
- `key` is stable across releases: the website shows "updated" when a key's `sha256` changes.
- `url` is an optional existing link; the website should serve its own copy of `file`.

## Sending

`release.py --send` POSTs `manifest.json` to `FMC_RELEASE_ENDPOINT` with `Authorization: Bearer FMC_RELEASE_TOKEN`.
Both live only in the sender's environment, never in a repository. Files are uploaded by the endpoint's instructions
(planned: the endpoint answers with upload URLs per `file`; until the website side defines that, files stay local).

## Review packs on the website

Review packs today keep marks and sign-offs in the published page's own database (collections `reviews`: one document
per section `{verdict: ok|fix|q, note, rows: {rowId: ok|fix}, by, at}`; `signoff/<person id>`: `{name, reg, date,
summary, at}`, written once by that person). The website side will provide the same two collections per project and
discipline (Firestore), with the same shapes, so packs move over unchanged.

## What the website side owns

Client accounts, project membership, the visibility switch per project and document, professional invitations per
discipline, storage, the release timeline, and the email to the client when a release arrives.
