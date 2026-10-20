"""Likeness round (owner 20 Oct; kit FMC_Rulebook_Rhino.json RHN-022): compare each reference view with the same view of
the model and append a round to <family>.likeness.json.

  python compare.py <family>.reference.json --from rhino|revit --render front=front.png --render side=side.png
                    [--review review.json] [--out <family>.likeness.json]

Per view: the product's outline is cut from its background (the background colour is read from the image's border), both
outlines are cropped to their bounding boxes, and the script reports
  aspect_diff  the model's width/height ratio against the reference's, as a fraction (0.05 = 5 % wider);
  iou          the overlap of the two outlines once both are scaled to the same box (1.0 = the same outline).
A reference whose border isn't one plain colour (a room photo) gets iou null with the reason: its view is judged by the
reviewer only. review.json, written by a reviewer who did not build the family: {"reviewer": {"who", "blind": true},
"features": [{"name", "present", "note"}]}. Needs Pillow and numpy."""
import argparse, json, os, sys
from datetime import datetime, timezone
import numpy as np
from PIL import Image

def mask(path, tol=28, border_max_std=18.0):
    a = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
    b = np.concatenate([a[:4].reshape(-1, 3), a[-4:].reshape(-1, 3), a[:, :4].reshape(-1, 3), a[:, -4:].reshape(-1, 3)])
    if b.std(axis=0).max() > border_max_std:
        return None, "background not one plain colour (a room photo)"
    m = np.abs(a - b.mean(axis=0)).max(axis=2) > tol
    if m.sum() < 50:
        return None, "no product found against the background"
    ys, xs = np.nonzero(m)
    return m[ys.min():ys.max() + 1, xs.min():xs.max() + 1], ""

def compare(ref_img, model_img, size=256):
    r, why = mask(ref_img)
    m, why2 = mask(model_img)
    if m is None:
        return {"iou": None, "aspect_diff": None, "note": f"model render: {why2}"}
    if r is None:
        return {"iou": None, "aspect_diff": None, "note": why}
    ar, am = r.shape[1] / r.shape[0], m.shape[1] / m.shape[0]
    rs = np.asarray(Image.fromarray(r.astype(np.uint8) * 255).resize((size, size))) > 127
    ms = np.asarray(Image.fromarray(m.astype(np.uint8) * 255).resize((size, size))) > 127
    iou = float((rs & ms).sum() / max(1, (rs | ms).sum()))
    return {"iou": round(iou, 3), "aspect_diff": round(am / ar - 1, 3)}

def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("reference"); p.add_argument("--from", dest="source", choices=["rhino", "revit"], required=True)
    p.add_argument("--render", action="append", default=[], help="view=image of the model from that view")
    p.add_argument("--review"); p.add_argument("--out")
    a = p.parse_args(argv)
    ref = json.load(open(a.reference, encoding="utf-8-sig"))
    base = os.path.dirname(os.path.abspath(a.reference))
    renders = dict(r.split("=", 1) for r in a.render)
    views = []
    for v in ref.get("views", []):
        if v.get("kind") == "generated" or v["view"] not in renders:
            continue
        res = compare(os.path.join(base, v["image"]), renders[v["view"]])
        views.append({"view": v["view"], **res})
    out = a.out or a.reference.replace(".reference.json", ".likeness.json")
    like = json.load(open(out, encoding="utf-8-sig")) if os.path.exists(out) else {"family": ref["family"], "rounds": []}
    rnd = {"round": len(like["rounds"]) + 1, "at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "from": a.source, "views": views}
    if a.review:
        rv = json.load(open(a.review, encoding="utf-8-sig"))
        rnd["features"], rnd["reviewer"] = rv.get("features", []), rv.get("reviewer")
    like["rounds"].append(rnd)
    json.dump(like, open(out, "w", encoding="utf-8"), indent=1)
    print(json.dumps(rnd, indent=1))

if __name__ == "__main__":
    sys.exit(main())
