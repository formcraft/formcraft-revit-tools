# PDF self-check (`fmc_pdf_review`)

Rasterize an exported PDF and check the pages. This does not change a Revit model, so it does not take a batch lease.

PNGs are written only under the Formcraft image folder: `%LOCALAPPDATA%\Formcraft\images`, or the `image_dir` in `fmc_guard.json` when that folder is not on `D:`. A path on `D:` is refused. A path beside the PDF or beside a model is refused. The code is `FMC-PDF-PATH`.

The renderer is the first one found: `pdftoppm`, `pdftocairo`, Ghostscript (`gswin64c`, `gswin32c` or `gs`), or the executable in `FMC_PDFIUM`. `FMC_PDFIUM` is called as `pdfium --png --dpi 110 --page N --out file.png input.pdf`. None of those is `FMC-PDF-NO-RENDERER`. No PNG is written, and the text checks are still returned.

`dpi` defaults to 110. `pages` is optional and 1-based. `dry_run` defaults to true: the checks run and the PNG paths are named, and nothing is written. `dry_run` false writes the PNGs.

Checks:

- `blank` when the page has no text.
- `page_size` is A0, A1, A2, A3 or A4, portrait or landscape, within 2 percent. Anything else is null.
- `missing_titleblock_text` when no text sits in the bottom 18 percent or the right 22 percent of the page. Without positions, a page with no sheet number (`A-101`) is treated as missing the title block.

## Check one export

```json
{
  "pdf_path": "C:\\Jobs\\_Staging\\A-101.pdf",
  "pages": [1],
  "dpi": 110,
  "dry_run": true
}
```

## API limits

- pdf.js reads the text and the page size. It does not rasterize. Rasterizing needs Poppler, Ghostscript or pdfium.
- A PDF that cannot be opened is `FMC-PDF-READ`. A renderer that exits with an error is `FMC-PDF-RENDER` and no PNG is kept.
- The check does not compare the drawing to the model. It does not decide that a title block is the Formcraft title block. It only looks for text in the title-block band.
