import math
A = "Annotations\\"
out = []
def f(v): return f"{v:.3f}".rstrip('0').rstrip('.')
def circle(r, cls='m', vis=''): return [f"C|0|0|{f(r)}|{cls}|{vis}"]
def poly(pts, cls='m', vis=''):
    return [f"L|{f(a[0])}|{f(a[1])}|{f(b[0])}|{f(b[1])}|{cls}|{vis}" for a, b in zip(pts, pts[1:] + pts[:1])]
def rect(w, h, cx=0, cy=0, cls='m', vis=''):
    return poly([(cx-w/2, cy-h/2), (cx+w/2, cy-h/2), (cx+w/2, cy+h/2), (cx-w/2, cy+h/2)], cls, vis)
def line(a, b, cls='m', vis=''): return [f"L|{f(a[0])}|{f(a[1])}|{f(b[0])}|{f(b[1])}|{cls}|{vis}"]
def hexa(w): r = w/2; return poly([(r*math.cos(math.radians(a)), r*math.sin(math.radians(a))) for a in range(0, 360, 60)])
def diamond(w, h): return poly([(w/2, 0), (0, h/2), (-w/2, 0), (0, -h/2)])
def tri(w):
    h = w*math.sqrt(3)/2; return poly([(-w/2, -h/3), (w/2, -h/3), (0, 2*h/3)])
def lab(p, x, y, size=2.5, al='c', vis='', w=20): return [f"P|{p}|{f(x)}|{f(y)}|{size}|{al}|{vis}|{w}"]
def txt(s, x, y, size=2.5, al='c'): return [f"T|{s}|{f(x)}|{f(y)}|{size}|{al}"]
def fill(pts, vis=''): return ["F|" + ";".join(f"{f(a)},{f(b)}" for a, b in pts) + (f"|vis={vis}" if vis else "")]
def fam(name, tpl, role, cat, types, yesno, body, tparams=None):
    out.append(f"N|{name}|{tpl}|{role}|{cat}")
    out.append("Y|" + ",".join(types))
    if yesno: out.append("B|" + ";".join(f"{p}:{','.join(str(v) for v in vals) if vals else ''}" for p, vals in yesno.items()))
    for k, vals in (tparams or {}).items(): out.append(f"S|{k}|" + ",".join(vals))
    out.extend(body)

# ---- Tags
fam("FMC_TAG_A_Door", A+"Metric Door Tag.rft", "A", "", ["Standard", "Fire"], {"Show_Fire": [0, 1]},
    circle(4.5) + lab("Mark", 0, 0) + lab("FMC_Fire_Resistance_Min", 0, -6.5, 2.5, 'c', 'Show_Fire'))
fam("FMC_TAG_A_Window", A+"Metric Window Tag.rft", "A", "", ["Standard"], None, hexa(10) + lab("Type Mark", 0, 0))
fam("FMC_TAG_A_WallType", A+"Metric Generic Tag.rft", "A", "OST_WallTags", ["Standard"], None,
    diamond(13, 8) + lab("Type Mark", 0, 0) + lab("FMC_Fire_Resistance_Min", 0, -6.5))
fam("FMC_TAG_A_Room", A+"Metric Room Tag.rft", "A", "", ["Name+Number", "With Area", "Finishes"], {"Show_Area": [0, 1, 0], "Show_Finish": [0, 0, 1]},
    lab("Name", 0, 3.2, 3.5, 'c', '', 40) + rect(12, 5, 0, -1.2, 't') + lab("Number", 0, -1.2) + lab("Area", 0, -5.5, 2.5, 'c', 'Show_Area') + lab("FMC_Finish_Set", 0, -5.5, 2.5, 'c', 'Show_Finish', 40))
fam("FMC_TAG_I_Finish", A+"Metric Room Tag.rft", "I", "", ["F-W-C-SK"], None, rect(26, 6) + lab("FMC_Finish_Set", 0, 0, 2.5, 'c', '', 25))
fam("FMC_TAG_I_FFE", A+"Metric Generic Tag.rft", "I", "OST_FurnitureTags", ["Standard"], None, poly([(-6,-2.5),(6,-2.5),(6,2.5),(-6,2.5)]) + lab("Type Mark", 0, 0) + lab("FMC_Keynote_Code", 0, -4.5))
fam("FMC_TAG_S_Column", A+"Metric Generic Tag.rft", "S", "OST_StructuralColumnTags", ["Standard"], None, rect(10, 5) + lab("FMC_Member_Mark", 0, 0))
fam("FMC_TAG_S_Beam", A+"Metric Generic Tag.rft", "S", "OST_StructuralFramingTags", ["Standard"], None, lab("FMC_Member_Mark", 0, 1.8) + line((-8, 0), (8, 0), 't') + lab("Type", 0, -1.8, 2.5, 'c', '', 25))
fam("FMC_TAG_S_Foundation", A+"Metric Generic Tag.rft", "S", "OST_StructuralFoundationTags", ["Standard"], None, rect(12, 5) + lab("FMC_Member_Mark", 0, 0) + lab("FMC_Founding_Depth_mm", 0, -4.5))
fam("FMC_TAG_S_Rebar", A+"Metric Generic Tag.rft", "S", "OST_RebarTags", ["Standard"], None, lab("Type", 0, 0, 2.5, 'c', '', 30))
fam("FMC_TAG_E_Device", A+"Metric Electrical Device Tag.rft", "E", "OST_ElectricalFixtureTags", ["Standard"], None, circle(3.5) + lab("Type Mark", 0, 0) + lab("Circuit Number", 0, -5.5))
fam("FMC_TAG_E_Circuit", A+"Metric Generic Tag.rft", "E", "OST_WireTags", ["Standard"], None, lab("Panel", -1, 0, 2.5, 'r', '', 15) + txt("/", 0, 0) + lab("Circuit Number", 1, 0, 2.5, 'l', '', 15))
fam("FMC_TAG_E_Panel", A+"Metric Electrical Equipment Tag.rft", "E", "", ["Standard"], None, rect(18, 9) + line((-9, 0), (9, 0), 't') + lab("Panel Name", 0, 2.2, 2.5, 'c', '', 17) + lab("FMC_Ways", 0, -2.2, 2.5, 'c', '', 17))
fam("FMC_TAG_E_Light", A+"Metric Generic Tag.rft", "E", "OST_LightingFixtureTags", ["Standard"], None, circle(3.5) + lab("Type Mark", 0, 0) + lab("Circuit Number", 0, -5.5))
fam("FMC_TAG_M_Equipment", A+"Metric Generic Tag.rft", "M", "OST_MechanicalEquipmentTags", ["Standard"], None, rect(18, 9) + line((-9, 0), (9, 0), 't') + lab("Mark", 0, 2.2, 2.5, 'c', '', 17) + lab("FMC_Cooling_Capacity_kW", 0, -2.2, 2.5, 'c', '', 17))
fam("FMC_TAG_M_AirTerminal", A+"Metric Generic Tag.rft", "M", "OST_DuctTerminalTags", ["Standard"], None, rect(14, 9) + line((-7, 0), (7, 0), 't') + lab("Type Mark", 0, 2.2, 2.5, 'c', '', 13) + lab("Flow", 0, -2.2, 2.5, 'c', '', 13))
fam("FMC_TAG_P_Fixture", A+"Metric Generic Tag.rft", "P", "OST_PlumbingFixtureTags", ["Standard"], None, circle(4) + lab("Type Mark", 0, 0))
fam("FMC_TAG_P_Pipe", A+"Metric Generic Tag.rft", "P", "OST_PipeTags", ["Standard", "With Slope"], {"Show_Slope": [0, 1]},
    lab("Size", -1, 0, 2.5, 'r', '', 12) + lab("System Abbreviation", 1, 0, 2.5, 'l', '', 12) + lab("Slope", 0, -3.5, 2.5, 'c', 'Show_Slope', 12))
fam("FMC_TAG_P_Manhole", A+"Metric Generic Tag.rft", "P", "OST_PlumbingEquipmentTags", ["Standard"], None,
    rect(22, 13) + line((-11, 2.2), (11, 2.2), 't') + lab("Mark", 0, 4.3, 2.5, 'c', '', 20) + txt("CL", -9.5, 0, 2.5, 'l') + lab("FMC_Cover_Level_m", 2, 0, 2.5, 'c', '', 14) + txt("IL", -9.5, -4, 2.5, 'l') + lab("FMC_Invert_Out_m", 2, -4, 2.5, 'c', '', 14))
fam("FMC_TAG_FP_Equipment", A+"Metric Generic Tag.rft", "FP", "OST_SpecialityEquipmentTags", ["Standard"], None, rect(18, 9) + line((-9, 0), (9, 0), 't') + lab("FMC_Asset_Tag", 0, 2.2, 2.5, 'c', '', 17) + lab("FMC_Extinguisher_Rating", 0, -2.2, 2.5, 'c', '', 17))
fam("FMC_TAG_LP_Component", A+"Metric Generic Tag.rft", "LP", "OST_SpecialityEquipmentTags", ["Standard"], None, rect(16, 5) + lab("FMC_LP_Part", 0, 0, 2.5, 'c', '', 15))
fam("FMC_TAG_C_ControlPoint", A+"Metric Generic Tag.rft", "C", "OST_GenericModelTags", ["Standard"], None, tri(6) + lab("FMC_Control_Point_ID", 0, -4.5, 2.5, 'c', '', 20))
fam("FMC_TAG_L_Plant", A+"Metric Generic Tag.rft", "L", "OST_PlantingTags", ["Standard"], None, line((0, 0), (6, 4), 't') + lab("FMC_Botanical_Name", 7, 4, 2.5, 'l', '', 40))
fam("FMC_TAG_W_Logistics", A+"Metric Generic Tag.rft", "W", "OST_GenericModelTags", ["Standard"], None, rect(22, 9) + line((-11, 0), (11, 0), 't') + lab("FMC_Zone", 0, 2.2, 2.5, 'c', '', 20) + lab("FMC_Laydown_Area", 0, -2.2, 2.5, 'c', '', 20))
fam("FMC_TAG_Keynote", A+"Metric Generic Tag.rft", "Z", "OST_KeynoteTags", ["Key", "Text"], {"Show_Key": [1, 0], "Show_Text": [0, 1]},
    rect(10, 5, 0, 0, 'm', 'Show_Key') + lab("Key Value", 0, 0, 2.5, 'c', 'Show_Key', 9) + lab("Keynote Text", 0, 0, 2.5, 'l', 'Show_Text', 60))
# ---- Heads and view annotations
fam("FMC_GridHead", A+"Metric Grid Head.rft", "Z", "", ["8 mm circle"], None, circle(4) + lab("Name", 0, 0, 3.5))
fam("FMC_LevelHead", A+"Metric Level Head.rft", "Z", "", ["FFL", "SSL", "MSL"], None,
    circle(1.5, 'm') + fill([(0, 0), (1.5, 0)] + [(1.5*math.cos(math.radians(a)), 1.5*math.sin(math.radians(a))) for a in range(15, 91, 15)]) + fill([(0, 0), (-1.5, 0)] + [(1.5*math.cos(math.radians(a)), 1.5*math.sin(math.radians(a))) for a in range(195, 271, 15)])
    + lab("Name", 3, 2, 2.5, 'l', '', 30) + lab("Level_Prefix", 3, -2, 2.5, 'l', '', 8) + lab("Elevation", 11, -2, 2.5, 'l', '', 25), {"Level_Prefix": ["FFL", "SSL", "MSL"]})
fam("FMC_SectionHead", A+"Metric Section Head.rft", "Z", "", ["Standard"], None,
    circle(5) + line((-5, 0), (5, 0), 't') + fill([(5, 0), (0, 5), (0, 0)]) + lab("Detail Number", 0, 2.2, 2.5) + lab("Sheet Number", 0, -2.2, 2.5))
fam("FMC_CalloutHead", A+"Metric Callout Head.rft", "Z", "", ["Standard"], None,
    circle(5) + line((-5, 0), (5, 0), 't') + lab("Detail Number", 0, 2.2, 2.5) + lab("Sheet Number", 0, -2.2, 2.5))
fam("FMC_ElevationMark", A+"Metric Elevation Mark Body.rft", "Z", "", ["Exterior", "Interior"], None, circle(5))
fam("FMC_ElevationMark_Pointer", A+"Metric Elevation Mark Pointer.rft", "Z", "", ["Standard"], None,
    fill([(-5, 0), (0, 7.5), (5, 0)]) + lab("Detail Number", 0, 2.2, 2.5) + lab("Sheet Number", 0, -2.2, 2.5))
fam("FMC_ViewTitle", A+"Metric View Title.rft", "Z", "", ["Standard", "Detail"], {"Show_Circle": [0, 1]},
    circle(5, 'm', 'Show_Circle') + line((-5, 0), (5, 0), 't', 'Show_Circle') + lab("Detail Number", 0, 2.2, 2.5, 'c', 'Show_Circle') + lab("Sheet Number", 0, -2.2, 2.5, 'c', 'Show_Circle')
    + line((6, -1), (90, -1), 'h') + lab("View Name", 7, 2.2, 3.5, 'l', '', 80) + lab("Sheet Scale", 7, -3.5, 2.5, 'l', '', 40))
fam("FMC_NorthArrow", A+"Metric Generic Annotation.rft", "Z", "", ["Project", "True"], {"Show_True": [0, 1]},
    circle(6, 't') + fill([(0, 7), (-2.5, -4), (0, -2)]) + poly([(0, 7), (2.5, -4), (0, -2)], 'm') + txt("N", 0, 11, 3.5) + txt("TN", 0, -9, 2.5) * 0
    + line((-1.5, 13), (1.5, 13), 't', 'Show_True'))
fam("FMC_ScaleBar", A+"Metric Generic Annotation.rft", "Z", "", ["1:50", "1:100", "1:200", "1:500"], None,
    [x for i in range(5) for x in (fill([(i*10, 0), (i*10+10, 0), (i*10+10, 2), (i*10, 2)]) if i % 2 == 0 else rect(10, 2, i*10+5, 1, 't'))]
    + txt("0", 0, 4.5, 2.5) + lab("Bar_End", 50, 4.5, 2.5, 'c', '', 15) + lab("Scale_Text", 0, -3.5, 2.5, 'l', '', 30),
    {"Bar_End": ["5 m", "10 m", "20 m", "50 m"], "Scale_Text": ["SCALE 1:50", "SCALE 1:100", "SCALE 1:200", "SCALE 1:500"]})
fam("FMC_GA_SheetNote", A+"Metric Generic Annotation.rft", "Z", "", ["Standard"], None,
    circle(2.5) + lab("Note_Number", 0, 0, 2.5, 'c', '', 5) + lab("Note_Text", 4, 0, 2.5, 'l', '', 120), {"#inst": ["Note_Number", "Note_Text"]})
fam("FMC_TB_KeyPlan", A+"Metric Generic Annotation.rft", "Z", "", ["Standard"], {"FMC_KeyPlan_Zone_A": None, "KeyPlan_Zone_B": None, "KeyPlan_Zone_C": None, "KeyPlan_Zone_D": None},
    rect(40, 24, 0, 0, 'm') + line((0, -12), (0, 12), 't') + line((-20, 0), (20, 0), 't')
    + fill([(-20, 0), (0, 0), (0, 12), (-20, 12)], 'FMC_KeyPlan_Zone_A') + fill([(0, 0), (20, 0), (20, 12), (0, 12)], 'KeyPlan_Zone_B')
    + fill([(-20, -12), (0, -12), (0, 0), (-20, 0)], 'KeyPlan_Zone_C') + fill([(0, -12), (20, -12), (20, 0), (0, 0)], 'KeyPlan_Zone_D')
    + txt("A", -10, 2, 3.5) + txt("B", 10, 2, 3.5) + txt("C", -10, -10, 3.5) + txt("D", 10, -10, 3.5) + txt("KEY PLAN", -20, 16, 2.5, 'l'))
fam("FMC_A_GenericModel_FloorFall", A+"Metric Generic Annotation.rft", "A", "", ["Arrow"], None,
    line((-10, 0), (8, 0), 'm') + fill([(10, 0), (6, 1.5), (6, -1.5)]) + lab("Fall_Text", 0, 2.5, 2.5, 'c', '', 20), {"#inst": ["Fall_Text"]})
open('/mnt/user-data/outputs/symbuild/FMC_TAG_build.txt', 'w').write("\n".join(out) + "\n")
print(len(out), sum(1 for l in out if l[0] == 'N'), sum(1 for l in out if l[0] == 'P'))
