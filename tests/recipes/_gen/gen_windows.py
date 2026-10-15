"""Generates the two window recipes (fmc-recipe/0.1), mirroring FMC_A_Door_TimberFanlight's structure.
Coordinates: x across (Left/Right = -W/2..W/2), y depth (exterior is -y), z up from the template Sill plane (z = 0).
Plane positions are computed from type 1's values so every lock_face sits on its plane at the default type."""
import json, sys

SILL_Z = 800.0  # Measured 15 Oct: Metric Window.rft Sill plane at z = Default Sill Height 800. Was ASSUMPTION: the template "Sill" plane is at z = 0 in the Exterior view. Change and rerun if not.
OUT = sys.argv[1]

SHARED = [
    ("FMC_Keynote_Code", "2d089b32-0589-516b-8952-9f6afad95971", "IdentityData"),
    ("FMC_Frame_Spec", "7a163363-b62c-57f9-8d75-66d6b9aad4c6", "Data"),
    ("FMC_Fanlight_Height_mm", "425ed7f1-679a-5ee8-98dc-4fad02fde0ed", "Data"),
    ("FMC_Vent_Type", "cfd77ccf-d77d-53e0-b769-10b62e8aa1d5", "Data"),
    ("FMC_Mosquito_Mesh", "5ec6628e-e5ce-55d7-a8c1-d1737876b897", "Data"),
    ("FMC_Glazed_Area_m2", "c3c61f30-7abb-515e-9902-4cf9a3b72200", "Data"),
    ("FMC_Openable_Area_m2", "6919d4a2-ffd3-5f03-bbd5-4715a375a99d", "Data"),
    ("FMC_Geometry_Stage", "27c3be4d-9757-51ba-aa96-6c7a3a061025", "Data"),
    ("IfcExportAs", "bae7a5f9-3ec7-57e3-ba6b-bcd858fd95f7", "Data"),
]


class R:
    def __init__(self):
        self.ops = []

    def add(self, **o):
        self.ops.append(o)

    def head(self, cat="OST_Windows"):
        self.add(op="set_category", name=cat)
        for n, g, grp in SHARED:
            self.add(op="add_shared_param", name=n, guid=g, group=grp)

    def param(self, name, type_="Length", group=None):
        group = group or {"Length": "Dimensions", "Integer": "Dimensions", "YesNo": "Constraints", "Material": "Materials"}[type_]
        self.add(op="add_family_param", name=name, type=type_, group=group)

    def subcat(self, name, p, c):
        self.add(op="add_subcategory", name=name, line_weight_projection=p, line_weight_cut=c)

    def yplane(self, name, y, ref="WeakReference"):
        self.add(op="add_ref_plane", name=name, from_=[-2000, y], to=[2000, y], is_reference=ref)

    def xplane(self, name, x, ref="WeakReference"):
        self.add(op="add_ref_plane", name=name, from_=[round(x, 10), -1500], to=[round(x, 10), 1500], is_reference=ref)

    def zplane(self, name, z, ref="WeakReference"):
        self.add(op="add_ref_plane", name=name, from_=[-2000, round(SILL_Z + z, 10)], to=[2000, round(SILL_Z + z, 10)],
                 is_reference=ref, view="Exterior")

    def dim(self, name, a, b, label=None, offset=None, view=None):
        o = dict(op="add_dimension", name=name, between=[a, b])
        if label: o["label"] = label
        if view: o["view"] = view
        if offset is not None: o["offset"] = offset
        self.ops.append(o)

    def tv(self, t, p, v):
        self.add(op="set_type_value", name=f"{t}/{p}", type=t, param=p, value=v)

    def f(self, p, formula):
        self.add(op="set_formula", name=p, formula=formula)

    def solid(self, name, rect, start, end, end_plane, subcat, mat, lock=None):
        o = dict(op="extrusion", name=name, rect=rect, start=round(SILL_Z + start, 10), end=round(SILL_Z + end, 10))
        if end_plane: o["end_plane"] = end_plane
        self.ops.append(o)
        self.add(op="set_subcategory", name=name, subcategory=subcat)
        self.add(op="set_material_param", name=name, param=mat)
        if lock:
            self.add(op="lock_face", name=f"{name}/{lock}", solid=name, plane=lock, view="front")

    def dump(self):
        out = []
        for o in self.ops:
            o = {("from" if k == "from_" else k): v for k, v in o.items()}
            out.append(o)
        return out


def r3(v):
    return round(v, 3)


# ---------------------------------------------------------------------------------------------------------------
def steel():
    r = R()
    r.head()
    T1 = "1200x1600_2Leaf-Louvre400"
    W, H, FH, LC = 1200, 1600, 400, 2
    FW, BS, BTP, HO, HW, SD, BH, MW = 40, 12, 150, 5, 30, 140, 20, 30
    FD = TD = FW  # equal 40x40 angle: frame depth and transom use Frame Width
    GBS = MW      # glazing bar is the same 30 T as the mullions
    lengths = ["Frame Width", "Fanlight Height", "Mullion Width",
               "Bar Size", "Bar Target Pitch", "Bar Pitch", "Bar Y Offset", "Blade Height",
               "Sill Depth", "Hide Offset", "Hide Width",
               "Mullion 1 Offset", "Mullion 2 Offset", "Mullion 3 Offset",
               "Louvre L Offset", "Louvre R Offset", "Glass L Offset", "Glass R Offset",
               "Mesh L Offset", "Mesh R Offset"]
    lengths += [f"Bar {i} Offset" for i in range(1, 9)]
    for p in lengths: r.param(p)
    r.param("Leaf Count", "Integer"); r.param("Bar Count", "Integer")
    r.param("Vent Louvred", "YesNo"); r.param("Show Burglar Bars", "YesNo")
    for m in ["Frame Material", "Glass Material", "Mesh Material", "Sill Material"]: r.param(m, "Material")
    for n, p, c in [("Frame", 2, 4), ("Glass", 1, 2), ("Louvre", 1, 2), ("Mesh", 1, 1), ("Burglar Bars", 1, 2),
                    ("Sill", 2, 3), ("Elevation Swing", 1, 1)]:
        r.subcat(n, p, c)

    # type-1 values computed as Revit will (formulas below)
    L = -W / 2
    clear = W - 2 * FW
    leafw = (clear - (LC - 1) * MW) / LC
    m_off = [FW + leafw if LC > 1 else HO, FW + 2 * leafw + MW if LC > 2 else HO, FW + 3 * leafw + 2 * MW if LC > 3 else HO]
    import math
    bc = min(8, math.ceil(clear / BTP) - 1)
    bp = clear / (bc + 1)
    bar_off = [FW + i * bp - BS / 2 if bc > i - 1 else HO for i in range(1, 9)]
    zone = FH - TD - FW
    blade_off = [i * zone / 6 for i in range(1, 6)]
    leaf_top, tr_top, head_in = H - FH, H - FH + TD, H - FW
    gb = (FW + H - FH) / 2

    # y planes (exterior -y)
    r.yplane("Wall Centre", 0, "CenterFrontBack")
    r.yplane("Frame Ext", -FD / 2, "StrongReference")
    r.yplane("Frame Int", FD / 2, "StrongReference")
    r.yplane("Glass Front", -8); r.yplane("Glass Back", -4)
    r.yplane("Mesh Front", 17); r.yplane("Mesh Back", 18)
    r.yplane("Bar Front", FD / 2); r.yplane("Bar Back", FD / 2 + BS)
    r.yplane("Sill Front", -FD / 2 - SD)
    # x planes
    r.xplane("Frame L In", L + FW); r.xplane("Frame R In", -L - FW)
    for i in range(3):
        r.xplane(f"Mullion {i+1} L", L + m_off[i]); r.xplane(f"Mullion {i+1} R", L + m_off[i] + MW)
    r.xplane("Louvre L", L + FW); r.xplane("Louvre R", -L - FW)
    r.xplane("Glass L", L + HO); r.xplane("Glass R", L + HO + HW)
    r.xplane("Mesh L", L + FW); r.xplane("Mesh R", -L - FW)
    for i in range(8):
        r.xplane(f"Bar {i+1} L", L + bar_off[i]); r.xplane(f"Bar {i+1} R", L + bar_off[i] + BS)
    # level planes (Exterior elevation)
    r.zplane("Sill Inner", FW); r.zplane("Leaf Top", leaf_top); r.zplane("Transom Top", tr_top)
    r.zplane("Head Inner", head_in)
    r.zplane("Glazing Bar Bot", gb); r.zplane("Glazing Bar Top", gb + GBS)
    for i in range(5):
        r.zplane(f"Blade {i+1} Bot", tr_top + blade_off[i]); r.zplane(f"Blade {i+1} Top", tr_top + blade_off[i] + BH)

    # dimensions: plan
    r.dim("Frame Width L", "Left", "Frame L In", "Frame Width")
    r.dim("Frame Width R", "Frame R In", "Right", "Frame Width")
    r.dim("Frame Depth", "Frame Ext", "Frame Int", "Frame Width", 600)
    r.add(op="add_eq_dimension", name="EQ frame depth", planes=["Frame Ext", "Wall Centre", "Frame Int"], offset=700)
    r.dim("Sill Depth", "Sill Front", "Frame Ext", "Sill Depth", 800)
    r.dim("Bar Y Offset", "Frame Ext", "Bar Front", "Bar Y Offset", -700)
    r.dim("Bar Size Y", "Bar Front", "Bar Back", "Bar Size", -750)
    for i in range(3):
        r.dim(f"Mullion {i+1} Offset", "Left", f"Mullion {i+1} L", f"Mullion {i+1} Offset", -400 - 50 * i)
        r.dim(f"Mullion {i+1} Width", f"Mullion {i+1} L", f"Mullion {i+1} R", "Mullion Width", -400 - 50 * i)
    for a, off in [("Louvre", -600), ("Glass", -650), ("Mesh", -700)]:
        r.dim(f"{a} L Offset", "Left", f"{a} L", f"{a} L Offset", off)
        r.dim(f"{a} R Offset", "Left", f"{a} R", f"{a} R Offset", off - 25)
    for i in range(8):
        r.dim(f"Bar {i+1} Offset", "Left", f"Bar {i+1} L", f"Bar {i+1} Offset", -800 - 20 * i)
        r.dim(f"Bar {i+1} Size", f"Bar {i+1} L", f"Bar {i+1} R", "Bar Size", -800 - 20 * i)
    # dimensions: Exterior elevation
    E = "Exterior"
    r.dim("Frame Width Sill", "Sill", "Sill Inner", "Frame Width", 700, E)
    r.dim("Frame Width Head", "Head Inner", "Head", "Frame Width", 700, E)
    r.dim("Fanlight Height", "Leaf Top", "Head", "Fanlight Height", -600, E)
    r.dim("Transom Depth", "Leaf Top", "Transom Top", "Frame Width", 750, E)
    r.add(op="add_eq_dimension", name="EQ glazing bar", planes=["Sill Inner", "Glazing Bar Bot", "Leaf Top"], view=E, offset=800)
    r.dim("Glazing Bar Size", "Glazing Bar Bot", "Glazing Bar Top", "Mullion Width", 800, E)
    r.add(op="add_eq_dimension", name="EQ louvre blades", planes=["Transom Top"] + [f"Blade {i} Bot" for i in range(1, 6)] + ["Head Inner"], view=E, offset=850)
    for i in range(5):
        r.dim(f"Blade {i+1} Height", f"Blade {i+1} Bot", f"Blade {i+1} Top", "Blade Height", 850 + 20 * i, E)

    # type 1
    r.add(op="add_type", name=T1)
    spec = ("LTZ steel casement, frame 40x40x2 angle (IOM BoQ W1), 30 mm T mullions and glazing bar, 4 mm clear "
            "glass in putty; louvred or top-hung glass vent over; 12 mm sq burglar bars; precast sill")
    for p, v in [("Width", W), ("Height", H), ("Fanlight Height", FH), ("FMC_Fanlight_Height_mm", FH), ("Leaf Count", LC),
                 ("Vent Louvred", True), ("FMC_Mosquito_Mesh", True),
                 ("Show Burglar Bars", True), ("FMC_Frame_Spec", spec), ("Frame Width", FW),
                 ("Mullion Width", MW), ("Bar Size", BS),
                 ("Bar Target Pitch", BTP), ("Blade Height", BH), ("Sill Depth", SD), ("Hide Offset", HO),
                 ("Hide Width", HW), ("FMC_Geometry_Stage", "G4"), ("IfcExportAs", "IfcWindow")]:
        r.tv(T1, p, v)

    # formulas
    LWf = "(Width - 2 * Frame Width - (Leaf Count - 1) * Mullion Width) / Leaf Count"
    r.f("Mullion 1 Offset", f"if(Leaf Count > 1, Frame Width + {LWf}, Hide Offset)")
    r.f("Mullion 2 Offset", f"if(Leaf Count > 2, Frame Width + 2 * {LWf} + Mullion Width, Hide Offset)")
    r.f("Mullion 3 Offset", f"if(Leaf Count > 3, Frame Width + 3 * {LWf} + 2 * Mullion Width, Hide Offset)")
    r.f("Louvre L Offset", "if(Vent Louvred, Frame Width, Hide Offset)")
    r.f("Louvre R Offset", "if(Vent Louvred, Width - Frame Width, Hide Offset + Hide Width)")
    r.f("Glass L Offset", "if(Vent Louvred, Hide Offset, Frame Width)")
    r.f("Glass R Offset", "if(Vent Louvred, Hide Offset + Hide Width, Width - Frame Width)")
    r.f("Mesh L Offset", "if(FMC_Mosquito_Mesh, Frame Width, Hide Offset)")
    r.f("Mesh R Offset", "if(FMC_Mosquito_Mesh, Width - Frame Width, Hide Offset + Hide Width)")
    r.f("FMC_Vent_Type", 'if(Vent Louvred, "Louvre", "Top-hung glass fanlight")')
    r.f("Bar Y Offset", "if(Show Burglar Bars, Frame Width, Hide Offset)")
    r.f("Bar Count", "if(roundup((Width - 2 * Frame Width) / Bar Target Pitch) - 1 > 8, 8, "
                     "roundup((Width - 2 * Frame Width) / Bar Target Pitch) - 1)")
    r.f("Bar Pitch", "(Width - 2 * Frame Width) / (Bar Count + 1)")
    for i in range(1, 9):
        r.f(f"Bar {i} Offset", f"if(and(Show Burglar Bars, Bar Count > {i-1}), Frame Width + {i} * Bar Pitch - Bar Size / 2, Hide Offset)")
    r.f("FMC_Glazed_Area_m2", "(Width - 2 * Frame Width) * (Height - Fanlight Height - Frame Width) + "
                              "if(Vent Louvred, 0, (Width - 2 * Frame Width) * (Fanlight Height - 2 * Frame Width))")
    r.f("FMC_Openable_Area_m2", "(Width - 2 * Frame Width - (Leaf Count - 1) * Mullion Width) * (Height - Fanlight Height - Frame Width) + "
                                "if(Vent Louvred, 0, (Width - 2 * Frame Width) * (Fanlight Height - 2 * Frame Width))")

    # solids
    FR, FMAT = "Frame", "Frame Material"
    ext, inn = "Frame Ext", "Frame Int"
    r.solid("Jamb L", ["Left", "Frame L In", ext, inn], 0, H, "Head", FR, FMAT)
    r.solid("Jamb R", ["Frame R In", "Right", ext, inn], 0, H, "Head", FR, FMAT)
    r.solid("Sill Rail", ["Frame L In", "Frame R In", ext, inn], 0, FW, "Sill Inner", FR, FMAT)
    r.solid("Head", ["Frame L In", "Frame R In", ext, inn], head_in, H, "Head", FR, FMAT, "Head Inner")
    r.solid("Transom", ["Frame L In", "Frame R In", ext, inn], leaf_top, tr_top, "Transom Top", FR, FMAT, "Leaf Top")
    for i in range(3):
        r.solid(f"Mullion {i+1}", [f"Mullion {i+1} L", f"Mullion {i+1} R", "Glass Front", "Mesh Front"], FW, leaf_top,
                "Leaf Top", FR, FMAT)
    r.solid("Glazing Bar", ["Frame L In", "Frame R In", ext, "Wall Centre"], gb, gb + GBS, "Glazing Bar Top",
            FR, FMAT, "Glazing Bar Bot")
    r.solid("Glass", ["Frame L In", "Frame R In", "Glass Front", "Glass Back"], FW, leaf_top, "Leaf Top", "Glass",
            "Glass Material")
    for i in range(5):
        z0 = tr_top + blade_off[i]
        r.solid(f"Louvre {i+1}", ["Louvre L", "Louvre R", "Glass Front", "Mesh Front"], z0, z0 + BH, f"Blade {i+1} Top",
                "Louvre", FMAT, f"Blade {i+1} Bot")
    r.solid("Fanlight Glass", ["Glass L", "Glass R", "Glass Front", "Glass Back"], tr_top, head_in, "Head Inner", "Glass",
            "Glass Material", "Transom Top")
    r.solid("Mosquito Mesh", ["Mesh L", "Mesh R", "Mesh Front", "Mesh Back"], FW, head_in, "Head Inner", "Mesh",
            "Mesh Material")
    r.add(op="set_visibility", name="Mosquito Mesh", coarse=False, medium=True, fine=True)
    for i in range(8):
        r.solid(f"Bar {i+1}", [f"Bar {i+1} L", f"Bar {i+1} R", "Bar Front", "Bar Back"], FW, head_in, "Head Inner",
                "Burglar Bars", FMAT)
    r.solid("Bar Rail Mid", ["Frame L In", "Frame R In", "Bar Front", "Bar Back"], gb, gb + GBS, "Glazing Bar Top",
            "Burglar Bars", FMAT, "Glazing Bar Bot")
    r.solid("Bar Rail Transom", ["Frame L In", "Frame R In", "Bar Front", "Bar Back"], leaf_top, tr_top, "Transom Top",
            "Burglar Bars", FMAT, "Leaf Top")
    r.solid("Sill", ["Left", "Right", "Sill Front", inn], -50, 0, "Sill", "Sill", "Sill Material")

    # symbolic: BS convention, apex on the hinge side (outer jambs); drawn for the default 2-leaf type
    xi, m1l, m1r = L + FW, L + m_off[0], L + m_off[0] + MW
    zm = (FW + leaf_top) / 2
    r.add(op="symbolic_lines", name="Casement L", view="front",
          points=[[r3(m1l), FW], [r3(xi), r3(zm)], [r3(m1l), leaf_top]], subcategory="Elevation Swing", coarse=False)
    r.add(op="symbolic_lines", name="Casement R", view="front",
          points=[[r3(m1r), FW], [r3(-xi), r3(zm)], [r3(m1r), leaf_top]], subcategory="Elevation Swing", coarse=False)
    r.add(op="symbolic_lines", name="Sill line", view="plan",
          points=[[L, -FD / 2 - SD], [-L, -FD / 2 - SD]], subcategory="Sill")

    # other types (each copies the current type, so only differences are set)
    def T(name, **kv):
        r.add(op="add_type", name=name)
        for p, v in kv.items():
            r.tv(name, p.replace("_", " ") if p not in ("FMC_Fanlight_Height_mm", "FMC_Vent_Type") else p, v)
    T("2400x1600_4Leaf-Louvre400", Width=2400, Leaf_Count=4)
    T("0600x1500_1Leaf-Louvre300", Width=600, Height=1500, Fanlight_Height=300, FMC_Fanlight_Height_mm=300, Leaf_Count=1)
    T("0600x0900_WC-Louvre300", Height=900)
    T("1200x1500_2Leaf-Fanlight300", Width=1200, Height=1500, Leaf_Count=2, Vent_Louvred=False)
    T("1500x1500_2Leaf-Fanlight300", Width=1500)
    T("1800x1500_3Leaf-Fanlight300", Width=1800, Leaf_Count=3)

    return {
        "schema": "fmc-recipe/0.1",
        "family": "FMC_A_Window_SteelCasementVent",
        "template": "Metric Window.rft",
        "about": ("LOD 400 Ugandan steel casement window (LTZ 40x40x2 angle) with a transom and a louvred vent or top-hung "
                  "glass fanlight over, mid-height glazing bar, mosquito mesh and 12 mm burglar bars, on a precast sill "
                  "projecting 30 mm. Height runs from the template Sill plane (z = 0) to Head; leaf top = Height - Fanlight "
                  "Height. Leaf Count (1-4) places up to three fixed mullions; unused mullions, louvres vs fanlight glass, "
                  "mesh and burglar bars (Show Burglar Bars) are switched by Yes/No- and count-driven offset formulas that "
                  "collapse the part into the left jamb (Hide Offset / Hide Width) until the engine has a visibility op. "
                  "Burglar bars: up to 8 verticals at <= 150 centres (Bar Count = roundup(clear / 150) - 1, max 8, so "
                  "widths over ~1.3 m clear space them wider) plus flat rails at the glazing bar and transom; when off "
                  "they also move inside the frame depth (Bar Y Offset). Exterior is -y; frame centred on the wall. "
                  "Elevation opening triangles are symbolic lines drawn for the default 2-leaf type and do not flex."),
        "ops": r.dump(),
        "values": {
            "Frame LTZ steel 40x40x2 angle (Frame Width / Frame Depth 40)": {"value": "40x40x2", "source_status": "EA", "source": "IOM BoQ W1 1200x1600, LTZ 40x40x2 (register)"},
            "Overall size W1 1200x1600 with 400 louvred vent": {"value": "1200x1600", "source_status": "EA", "source": "IOM BoQ W1"},
            "Glass 4 mm clear in putty": {"value": 4, "source_status": "EA", "source": "register: glass 4/5 mm in putty; IOM BoQ"},
            "Other type sizes and leaf counts": {"value": "register type names", "source_status": "assumed", "source": "FMC_Family_Register.csv"},
            "Fanlight / vent height 300 / 400": {"value": "300/400", "source_status": "assumed", "source": "register type names"},
            "Transom and frame depth 40 (same equal angle, Frame Width)": {"value": 40, "source_status": "assumed"},
            "Mullion and glazing bar T 30x30 (Mullion Width); glazing bar just above mid leaf height": {"value": 30, "source_status": "assumed"},
            "Louvre blades: 5 pressed steel, 20 mm projected height": {"value": "5 x 20", "source_status": "assumed"},
            "Burglar bars 12 mm sq at <= 150 centres, max 8, rails at glazing bar and transom": {"value": "12 @ 150", "source_status": "assumed", "source": "owner brief; pattern to confirm with fabricator"},
            "Mosquito mesh on the interior, full opening": {"value": "full opening", "source_status": "assumed"},
            "Sill: precast 50 thick, depth 140 from frame face (230 brick + 15 plaster, 30 projection)": {"value": 140, "source_status": "assumed"},
            "Keynote": {"value": "", "source_status": "pending", "source": "FMC_Keynotes.txt has no steel casement code (G.CAS_00/01 are aluminium double glazed): kit change request"},
        },
        "checks": {"clear_opening_min_mm": 600, "clear_opening_param": "Width"},
    }


# ---------------------------------------------------------------------------------------------------------------
def alu():
    r = R()
    r.head()
    T1 = "1200x1500_Casement-TopHung300"
    W, H, FH, LC = 1200, 1500, 300, 2
    FW, FD, TD, MW, OV, SW, HO, HW, SD = 50, 100, 50, 40, 60, 40, 5, 40, 110
    lengths = ["Frame Width", "Frame Depth", "Fanlight Height", "Transom Depth", "Mullion Width", "Sash Overlap",
               "Interlock Width", "Sill Depth", "Hide Offset", "Hide Width", "Mullion Offset",
               "Casement Glass L Offset", "Casement Glass R Offset", "Slide Ext L Offset", "Slide Ext R Offset",
               "Slide Int L Offset", "Slide Int R Offset", "Interlock Ext Offset", "Interlock Int Offset",
               "Mesh L Offset", "Mesh R Offset"]
    for p in lengths: r.param(p)
    r.param("Leaf Count", "Integer")
    r.param("Leaves Sliding", "YesNo")
    for m in ["Frame Material", "Glass Material", "Mesh Material", "Sill Material"]: r.param(m, "Material")
    for n, p, c in [("Frame", 2, 4), ("Glass", 1, 2), ("Mesh", 1, 1), ("Sill", 2, 3), ("Elevation Swing", 1, 1)]:
        r.subcat(n, p, c)

    L = -W / 2
    sliding = False
    mull = FW + (W - 2 * FW - MW) / 2 if (not sliding and LC > 1) else HO
    leaf_top, tr_top, head_in = H - FH, H - FH + TD, H - FW

    r.yplane("Wall Centre", 0, "CenterFrontBack")
    r.yplane("Frame Ext", -FD / 2, "StrongReference")
    r.yplane("Frame Int", FD / 2, "StrongReference")
    r.yplane("Inset Front", -48); r.yplane("Inset Back", 48)
    r.yplane("Glass Front", -3); r.yplane("Glass Back", 2)
    r.yplane("Track Ext Front", -40); r.yplane("Track Ext Back", -10)
    r.yplane("Track Int Front", 10); r.yplane("Track Int Back", 40)
    r.yplane("Slide Glass Ext F", -27); r.yplane("Slide Glass Ext B", -22)
    r.yplane("Slide Glass Int F", 22); r.yplane("Slide Glass Int B", 27)
    r.yplane("Mesh Front", 44); r.yplane("Mesh Back", 46)
    r.yplane("Sill Front", -FD / 2 - SD)
    r.xplane("Frame L In", L + FW); r.xplane("Frame R In", -L - FW)
    r.xplane("Mullion L", L + mull); r.xplane("Mullion R", L + mull + MW)
    r.xplane("Case Glass L", L + FW); r.xplane("Case Glass R", -L - FW)
    r.xplane("Slide Ext L", L + HO); r.xplane("Slide Ext R", L + HO + HW)
    r.xplane("Slide Int L", L + HO); r.xplane("Slide Int R", L + HO + HW)
    r.xplane("Interlock Ext L", L + HO); r.xplane("Interlock Ext R", L + HO + SW)
    r.xplane("Interlock Int L", L + HO); r.xplane("Interlock Int R", L + HO + SW)
    r.xplane("Mesh L", L + HO); r.xplane("Mesh R", L + HO + HW)
    r.zplane("Sill Inner", FW); r.zplane("Leaf Top", leaf_top); r.zplane("Transom Top", tr_top)
    r.zplane("Head Inner", head_in)

    r.dim("Frame Width L", "Left", "Frame L In", "Frame Width")
    r.dim("Frame Width R", "Frame R In", "Right", "Frame Width")
    r.dim("Frame Depth", "Frame Ext", "Frame Int", "Frame Depth", 600)
    r.add(op="add_eq_dimension", name="EQ frame depth", planes=["Frame Ext", "Wall Centre", "Frame Int"], offset=700)
    r.dim("Sill Depth", "Sill Front", "Frame Ext", "Sill Depth", 800)
    r.dim("Mullion Offset", "Left", "Mullion L", "Mullion Offset", -400)
    r.dim("Mullion Width", "Mullion L", "Mullion R", "Mullion Width", -400)
    for a, pl, off in [("Casement Glass", "Case Glass", -500), ("Slide Ext", "Slide Ext", -550), ("Slide Int", "Slide Int", -600),
                       ("Mesh", "Mesh", -650)]:
        r.dim(f"{a} L Offset", "Left", f"{pl} L", f"{a} L Offset", off)
        r.dim(f"{a} R Offset", "Left", f"{pl} R", f"{a} R Offset", off - 25)
    for a, off in [("Ext", -700), ("Int", -750)]:
        r.dim(f"Interlock {a} Offset", "Left", f"Interlock {a} L", f"Interlock {a} Offset", off)
        r.dim(f"Interlock {a} Width", f"Interlock {a} L", f"Interlock {a} R", "Interlock Width", off)
    E = "Exterior"
    r.dim("Frame Width Sill", "Sill", "Sill Inner", "Frame Width", 700, E)
    r.dim("Frame Width Head", "Head Inner", "Head", "Frame Width", 700, E)
    r.dim("Fanlight Height", "Leaf Top", "Head", "Fanlight Height", -600, E)
    r.dim("Transom Depth", "Leaf Top", "Transom Top", "Transom Depth", 750, E)

    r.add(op="add_type", name=T1)
    spec = ("Aluminium window, frame 50x100 (series to confirm), 5 mm clear glass; casement or 2-track sliding leaves; "
            "top-hung projected (PJ) vent over; precast sill")
    for p, v in [("Width", W), ("Height", H), ("Fanlight Height", FH), ("FMC_Fanlight_Height_mm", FH), ("Leaf Count", LC),
                 ("Leaves Sliding", False), ("FMC_Vent_Type", "Top-hung (PJ)"), ("FMC_Mosquito_Mesh", False),
                 ("FMC_Frame_Spec", spec), ("Frame Width", FW), ("Frame Depth", FD), ("Transom Depth", TD),
                 ("Mullion Width", MW), ("Sash Overlap", OV), ("Interlock Width", SW), ("Sill Depth", SD),
                 ("Hide Offset", HO), ("Hide Width", HW), ("FMC_Geometry_Stage", "G4"), ("IfcExportAs", "IfcWindow")]:
        r.tv(T1, p, v)

    r.f("Mullion Offset", "if(and(not(Leaves Sliding), Leaf Count > 1), Frame Width + (Width - 2 * Frame Width - Mullion Width) / 2, Hide Offset)")
    r.f("Casement Glass L Offset", "if(Leaves Sliding, Hide Offset, Frame Width)")
    r.f("Casement Glass R Offset", "if(Leaves Sliding, Hide Offset + Hide Width, Width - Frame Width)")
    r.f("Slide Ext L Offset", "if(Leaves Sliding, Frame Width, Hide Offset)")
    r.f("Slide Ext R Offset", "if(Leaves Sliding, Width / 2 + Sash Overlap / 2, Hide Offset + Hide Width)")
    r.f("Slide Int L Offset", "if(Leaves Sliding, Width / 2 - Sash Overlap / 2, Hide Offset)")
    r.f("Slide Int R Offset", "if(Leaves Sliding, Width - Frame Width, Hide Offset + Hide Width)")
    r.f("Interlock Ext Offset", "if(Leaves Sliding, Width / 2 + Sash Overlap / 2 - Interlock Width, Hide Offset)")
    r.f("Interlock Int Offset", "if(Leaves Sliding, Width / 2 - Sash Overlap / 2, Hide Offset)")
    r.f("Mesh L Offset", "if(FMC_Mosquito_Mesh, Frame Width, Hide Offset)")
    r.f("Mesh R Offset", "if(FMC_Mosquito_Mesh, Width - Frame Width, Hide Offset + Hide Width)")
    r.f("FMC_Glazed_Area_m2", "(Width - 2 * Frame Width) * (Height - Fanlight Height - Frame Width) + "
                              "(Width - 2 * Frame Width) * (Fanlight Height - Transom Depth - Frame Width)")
    r.f("FMC_Openable_Area_m2", "(Width - 2 * Frame Width) * (Height - Fanlight Height - Frame Width) * if(Leaves Sliding, 0.5, 1) + "
                                "(Width - 2 * Frame Width) * (Fanlight Height - Transom Depth - Frame Width)")

    FR, FMAT, ext, inn = "Frame", "Frame Material", "Frame Ext", "Frame Int"
    r.solid("Jamb L", ["Left", "Frame L In", ext, inn], 0, H, "Head", FR, FMAT, "Sill")
    r.solid("Jamb R", ["Frame R In", "Right", ext, inn], 0, H, "Head", FR, FMAT, "Sill")
    r.solid("Sill Rail", ["Frame L In", "Frame R In", ext, inn], 0, FW, "Sill Inner", FR, FMAT, "Sill")
    r.solid("Head", ["Frame L In", "Frame R In", ext, inn], head_in, H, "Head", FR, FMAT, "Head Inner")
    r.solid("Transom", ["Frame L In", "Frame R In", ext, inn], leaf_top, tr_top, "Transom Top", FR, FMAT, "Leaf Top")
    r.solid("Mullion", ["Mullion L", "Mullion R", "Inset Front", "Inset Back"], FW, leaf_top, "Leaf Top", FR, FMAT, "Sill Inner")
    r.solid("Casement Glass", ["Case Glass L", "Case Glass R", "Glass Front", "Glass Back"], FW, leaf_top, "Leaf Top",
            "Glass", "Glass Material", "Sill Inner")
    r.solid("Sliding Glass Ext", ["Slide Ext L", "Slide Ext R", "Slide Glass Ext F", "Slide Glass Ext B"], FW, leaf_top,
            "Leaf Top", "Glass", "Glass Material", "Sill Inner")
    r.solid("Sliding Glass Int", ["Slide Int L", "Slide Int R", "Slide Glass Int F", "Slide Glass Int B"], FW, leaf_top,
            "Leaf Top", "Glass", "Glass Material", "Sill Inner")
    r.solid("Interlock Ext", ["Interlock Ext L", "Interlock Ext R", "Track Ext Front", "Track Ext Back"], FW, leaf_top,
            "Leaf Top", FR, FMAT, "Sill Inner")
    r.solid("Interlock Int", ["Interlock Int L", "Interlock Int R", "Track Int Front", "Track Int Back"], FW, leaf_top,
            "Leaf Top", FR, FMAT, "Sill Inner")
    r.solid("Vent Glass", ["Frame L In", "Frame R In", "Glass Front", "Glass Back"], tr_top, head_in, "Head Inner",
            "Glass", "Glass Material", "Transom Top")
    r.solid("Mosquito Mesh", ["Mesh L", "Mesh R", "Mesh Front", "Mesh Back"], FW, head_in, "Head Inner", "Mesh",
            "Mesh Material", "Sill Inner")
    r.add(op="set_visibility", name="Mosquito Mesh", coarse=False, medium=True, fine=True)
    r.solid("Sill", ["Left", "Right", "Sill Front", inn], -50, 0, "Sill", "Sill", "Sill Material")

    xi = -L - FW
    r.add(op="symbolic_lines", name="Top-hung vent", view="front",
          points=[[r3(-xi), tr_top], [0, head_in], [r3(xi), tr_top]], subcategory="Elevation Swing", coarse=False)
    r.add(op="symbolic_lines", name="Sill line", view="plan",
          points=[[L, -FD / 2 - SD], [-L, -FD / 2 - SD]], subcategory="Sill")

    def T(name, **kv):
        r.add(op="add_type", name=name)
        for p, v in kv.items():
            r.tv(name, p if p.startswith("FMC_") else p.replace("_", " "), v)
    T("1500x1500_Sliding-TopHung300", Width=1500, Leaves_Sliding=True)
    T("1800x1500_Sliding-TopHung300", Width=1800)
    T("0600x1200_Casement-Projected300", Width=600, Height=1200, Leaf_Count=1, Leaves_Sliding=False)
    T("0600x0900_WC-PJ", Height=900)

    return {
        "schema": "fmc-recipe/0.1",
        "family": "FMC_A_Window_AluVent",
        "template": "Metric Window.rft",
        "about": ("LOD 400 Kampala aluminium window: 50x100 frame, casement (1 or 2 leaves, mullion by Leaf Count) or "
                  "2-track sliding leaves that overlap at the centre with interlock stiles, and a top-hung projected (PJ) "
                  "vent over the transom. Height runs from the template Sill plane (z = 0) to Head; leaf top = Height - "
                  "Fanlight Height. Casement vs sliding parts and the mesh are switched by Yes/No-driven offset formulas "
                  "that collapse the part into the left jamb (Hide Offset / Hide Width). Exterior is -y; frame centred on "
                  "the wall. The vent's opening triangle is a symbolic line drawn for the default type and does not flex."),
        "ops": r.dump(),
        "values": {
            "Frame 50x100 aluminium (series not identified)": {"value": "50x100", "source_status": "assumed"},
            "Glass 5 mm clear": {"value": 5, "source_status": "assumed"},
            "Type sizes 1200/1500/1800 x 1500, 600 x 1200 / 900": {"value": "register type names", "source_status": "assumed", "source": "register: Jiji 'Windows Pj', Casements Africa; sizes PRACTICE"},
            "PJ vent height 300 over a 50 transom": {"value": 300, "source_status": "assumed"},
            "Sliding overlap 60, interlock stile 40": {"value": "60/40", "source_status": "assumed"},
            "Mullion 40": {"value": 40, "source_status": "assumed"},
            "0600x0900_WC-PJ modelled as a casement leaf under a 300 PJ vent": {"value": "1 leaf + PJ 300", "source_status": "assumed", "source": "type name; confirm whether the whole unit is one projected leaf"},
            "Mosquito mesh off by default": {"value": "No", "source_status": "assumed"},
            "Sill: precast 50 thick, depth 110 from frame face": {"value": 110, "source_status": "assumed"},
            "Keynote": {"value": "", "source_status": "pending", "source": "G.CAS_00 / G.SLD_00 describe double-glazed units; no single-glazed PJ code: kit change request"},
        },
        "checks": {"clear_opening_min_mm": 600, "clear_opening_param": "Width"},
    }


def size_first(ops):
    """Make type 1 current at its real size before any reference plane or dimension (F-026): labelled
    dimensions take their value from where the planes sit, so the template's default size must not be current."""
    t1 = next(o for o in ops if o["op"] == "add_type")["name"]
    early = [o for o in ops if o["op"] == "add_type" and o["name"] == t1]
    early += [o for o in ops if o["op"] == "set_type_value" and o["type"] == t1 and o["param"] in ("Width", "Height")]
    rest = [o for o in ops if not any(o is e for e in early)]
    i = next(k for k, o in enumerate(rest) if o["op"] == "add_ref_plane")
    return rest[:i] + early + rest[i:]


for rec in (steel(), alu()):
    rec["ops"] = size_first(rec["ops"])
    for o in rec["ops"]:
        if o["op"] == "symbolic_lines" and o.get("view") == "front":
            o["points"] = [[p[0], round(p[1] + SILL_Z, 3)] for p in o["points"]]
    path = f"{OUT}/{rec['family']}.recipe.json"
    with open(path, "w") as fh:
        json.dump(rec, fh, indent=1)
    print(rec["family"], len(rec["ops"]))
