// @addon export_png_pdf  @version 1.0  @writes none  @dryrun yes
// @does PNG check images of views or sheets, and PDFs of sheets, into a WIP folder (from KISIC 03_check_views and 24_export_png_pdf).
// @params {"views":[],"out_dir":"","mode":"png","prefix":"chk","px":3000,"pdf_combine":false}
// @required views,out_dir
// @paths out_dir
// @returns {"dry_run":bool,"exported":n,"files":[{"file":"...","bytes":n}],"views":[{"id":n,"name":"...","kind":"..."}],"missing":["..."]}
// @usings System.IO, Newtonsoft.Json.Linq
//
// views: element ids, sheet numbers or view names. mode: png | pdf | both. px: the PNG's long side in pixels.
// A dry run lists the views it found and the files it would write; a real run writes them. It changes nothing in
// the model, so it opens no transaction (an export can't run inside one). A long export answers with a job id (fmc_job).
var args = FmcScript.Params(parameters);
bool dryRun = FmcScript.IsDryRun(parameters);
string outDir = ((string)args["out_dir"] ?? "").Trim();
string mode = ((string)args["mode"] ?? "png").Trim().ToLowerInvariant();
string prefix = ((string)args["prefix"] ?? "chk").Trim();
int pixels = (int?)args["px"] ?? 3000;
bool combine = (bool?)args["pdf_combine"] ?? false;
if (outDir.Length == 0) throw new ArgumentException("out_dir is required: a WIP folder for the files");
if (mode != "png" && mode != "pdf" && mode != "both") throw new ArgumentException($"mode is png, pdf or both, not \"{mode}\"");
if (pixels < 500 || pixels > 15000) throw new ArgumentException($"px is 500 to 15000, not {pixels}");

string SafeName(string raw)
{
    var sbName = new StringBuilder();
    foreach (char ch in raw) sbName.Append(Path.GetInvalidFileNameChars().Contains(ch) || ch == ' ' || ch == ',' ? '_' : ch == '&' ? '+' : ch);
    return sbName.ToString();
}

// Each key: an element id, then a sheet number, then a view name (templates never).
var allViews = new FilteredElementCollector(document).OfClass(typeof(View)).Cast<View>().Where(v => !v.IsTemplate).ToList();
var found = new List<View>();
var missing = new List<string>();
foreach (var token in (args["views"] as JArray) ?? new JArray())
{
    string key = ((string)token ?? "").Trim();
    View hit = null;
    if (long.TryParse(key, out long idValue)) hit = document.GetElement(new ElementId(idValue)) as View;
    if (hit == null) hit = allViews.OfType<ViewSheet>().FirstOrDefault(s => string.Equals(s.SheetNumber, key, StringComparison.OrdinalIgnoreCase));
    if (hit == null) hit = allViews.FirstOrDefault(v => string.Equals(v.Name, key, StringComparison.OrdinalIgnoreCase));
    if (hit == null || hit.IsTemplate || !hit.CanBePrinted) missing.Add(key);
    else if (!found.Any(f => f.Id == hit.Id)) found.Add(hit);
}
if (found.Count == 0) throw new ArgumentException("None of the views was found or can be printed: " + string.Join(", ", missing));

string Label(View view) => view is ViewSheet sheet ? $"{sheet.SheetNumber} - {sheet.Name}" : view.Name;
var plan = found.Select(v => new { id = v.Id.Value, name = Label(v), kind = v.ViewType.ToString() }).ToList();
bool png = mode == "png" || mode == "both";
bool pdf = mode == "pdf" || mode == "both";
var willWrite = new List<string>();
if (png) willWrite.AddRange(found.Select(v => Path.Combine(outDir, $"{prefix} - {v.ViewType} - {Label(v)}.png")));
if (pdf) willWrite.AddRange(combine ? new[] { Path.Combine(outDir, SafeName($"{prefix}_combined") + ".pdf") }
                                    : found.Select(v => Path.Combine(outDir, SafeName($"{prefix}_{Label(v)}") + ".pdf")));
if (dryRun)
    return new { dry_run = true, exported = 0, would_write = willWrite, views = plan, missing,
                 note = "Dry run: nothing exported. Run with dry_run false to write the files." };

Directory.CreateDirectory(outDir);
DateTime started = DateTime.Now.AddSeconds(-2);
var ids = found.Select(v => v.Id).ToList();
if (png)
{
    var image = new ImageExportOptions
    {
        ExportRange = ExportRange.SetOfViews,
        FilePath = Path.Combine(outDir, prefix),
        ImageResolution = ImageResolution.DPI_150,
        PixelSize = pixels,
        FitDirection = FitDirectionType.Horizontal,
        HLRandWFViewsFileType = ImageFileType.PNG,
        ShadowViewsFileType = ImageFileType.PNG,
        ZoomType = ZoomFitType.FitToPage,
    };
    image.SetViewsAndSheets(ids);
    document.ExportImage(image);
}
if (pdf)
{
    PDFExportOptions PdfOptions(string fileName) => new PDFExportOptions
    {
        FileName = fileName, Combine = true, PaperFormat = ExportPaperFormat.Default, ZoomType = ZoomType.Zoom, ZoomPercentage = 100,
        HideCropBoundaries = true, HideScopeBoxes = true, HideReferencePlane = true, HideUnreferencedViewTags = true,
    };
    if (combine) document.Export(outDir, ids, PdfOptions(SafeName($"{prefix}_combined")));
    else foreach (var view in found) document.Export(outDir, new List<ElementId> { view.Id }, PdfOptions(SafeName($"{prefix}_{Label(view)}")));
}
var files = Directory.GetFiles(outDir)
    .Where(f => File.GetLastWriteTime(f) >= started && (f.EndsWith(".png", StringComparison.OrdinalIgnoreCase) || f.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase)))
    .Select(f => new { file = f, bytes = new FileInfo(f).Length })
    .ToList();
return new { dry_run = false, exported = files.Count, files, views = plan, missing };
