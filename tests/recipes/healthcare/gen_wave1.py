"""Healthcare pack wave 1 recipes (fmc-recipe/0.1), generated so the conventions stay the same across families.
Conventions: non-hosted templates (Metric Generic Model / Mechanical Equipment) with set_category; plan extrusions,
z up from the placement level; wall-mounted items have their back at y = 0 and project to -y; every type carries
Keynote + FMC_Keynote_Code (kit keynotes, healthcare change request 17 Oct), FMC_Cost_Unit, FMC_Geometry_Stage G4 and
IfcExportAs; Coarse = one envelope box, Medium = outline parts, Fine = details. Sizes are typical and marked assumed.
Run: python gen_wave1.py <healthcare_pack.json>  (writes <family>.recipe.json here)"""
import json, sys, os
HERE = os.path.dirname(os.path.abspath(__file__))
KN = {r['family']: r.get('kn', '') for r in json.load(open(sys.argv[1], encoding='utf-8'))['families']} if len(sys.argv) > 1 else {}
G = {'FMC_Keynote_Code': '2d089b32-0589-516b-8952-9f6afad95971', 'FMC_Cost_Unit': '6f0f6197-4d1e-5601-afd7-98d436c0bd40',
     'FMC_Geometry_Stage': '27c3be4d-9757-51ba-aa96-6c7a3a061025', 'IfcExportAs': 'bae7a5f9-3ec7-57e3-ba6b-bcd858fd95f7'}

def rect(x0, y0, x1, y1): return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
def ext(name, pts, z0, z1, sub, lod): return [{"op": "extrusion", "name": name, "points": pts, "start": z0, "end": z1},
                                             {"op": "set_subcategory", "name": name, "subcategory": sub},
                                             {"op": "set_visibility", "name": name, "coarse": 'c' in lod, "medium": 'm' in lod, "fine": 'f' in lod}]
def rev(name, prof, sub, lod, at=(0, 0)): return [{"op": "revolution", "name": name, "profile": prof, "axis_at": list(at), "subcategory": sub},
                                                  {"op": "set_visibility", "name": name, "coarse": 'c' in lod, "medium": 'm' in lod, "fine": 'f' in lod}]
def subs(*names): return [{"op": "add_subcategory", "name": n, "line_weight_projection": 1} for n in names]
def data(t, family, cost, ifc, desc, extra=None):
    kn = KN.get(family, '')
    ops = [{"op": "add_type", "name": t}] + [{"op": "add_shared_param", "name": n, "guid": g} for n, g in G.items()]
    vals = {"Keynote": kn, "FMC_Keynote_Code": kn, "FMC_Cost_Unit": cost, "FMC_Geometry_Stage": "G4", "IfcExportAs": ifc, "Description": desc}
    vals.update(extra or {})
    ops += [{"op": "set_type_value", "name": f"{t}/{k}", "type": t, "param": k, "value": v} for k, v in vals.items()]
    return ops
def recipe(family, template, cat, about, ops, values):
    seen = set(); ops = [o for o in ops if not (o['op'] == 'add_shared_param' and (o['name'] in seen or seen.add(o['name'])))]
    head = [{"op": "set_category", "name": cat}] if cat else []
    r = {"schema": "fmc-recipe/0.1", "family": family, "template": template, "about": about, "ops": head + ops, "values": values}
    json.dump(r, open(os.path.join(HERE, family + '.recipe.json'), 'w'), indent=1)
    return family

A = lambda src='typical product, to confirm with the supplier', value='see key': {"value": value, "source_status": "assumed", "source": src}
out = []

# 1. Medical vacuum outlet: second gas, same body as O2 (proves system mapping by name)
f = 'FMC_P_MechEq_MedGas_Outlet_Vacuum'
ops = data('BS5682_VAC', f, 'nr', 'IfcFlowTerminal', 'Medical vacuum terminal unit, BS 5682 probe, wall mounted, flush back box', {"Default Elevation": 1400})
ops += subs('Fascia', 'Socket', 'Back Box', 'Coarse Envelope')
ops += ext('Coarse Envelope', rect(-45, -30, 45, 60), 0, 120, 'Coarse Envelope', 'c')
ops += ext('Fascia', rect(-45, -12, 45, 0), 0, 120, 'Fascia', 'mf')
ops += ext('Back Box', rect(-35, 0, 35, 60), 10, 110, 'Back Box', 'mf')
ops += ext('Socket', [[16, -12], [16, -30], [-16, -30], [-16, -12]], 44, 76, 'Socket', 'f')
ops += [{"op": "add_connector", "name": "VAC", "domain": "pipe", "system": "Other", "solid": "Back Box", "side": "back", "diameter": 15, "flow": "Out"}]
out.append(recipe(f, 'Metric Mechanical Equipment.rft', None, 'Wave 1: medical vacuum outlet; plan extrusions (back at y=0); pipe connector Other into the wall.', ops,
                  {"Fascia 90 x 120 mm": A(), "Mounting height 1400 mm": A('bedhead practice; HTM 02-01 basis'), "Connector 15 mm": A()}))

# 2. Twin 13 A socket, 240 V (electrical connector with linked voltage, poles and load)
f = 'FMC_E_ElecFixture_Socket_13A_Twin'
ops = [{"op": "add_family_param", "name": "Voltage", "type": "Voltage", "group": "Electrical"},
       {"op": "add_family_param", "name": "Number of Poles", "type": "NumberOfPoles", "group": "Electrical"},
       {"op": "add_family_param", "name": "Apparent Load", "type": "ApparentPower", "group": "ElectricalLoads"}]
ops += data('13A_TwinSwitched', f, 'nr', 'IfcOutlet', 'Twin 13 A switched socket outlet, BS 1363, white, flush', {"Voltage": 240, "Number of Poles": 1, "Apparent Load": 180, "Default Elevation": 450})
ops += subs('Plate', 'Back Box', 'Switch', 'Coarse Envelope')
ops += ext('Coarse Envelope', rect(-73, -10, 73, 35), 0, 86, 'Coarse Envelope', 'c')
ops += ext('Plate', rect(-73, -10, 73, 0), 0, 86, 'Plate', 'mf')
ops += ext('Back Box', rect(-67, 0, 67, 35), 4, 82, 'Back Box', 'mf')
ops += ext('Switch L', rect(-55, -16, -43, -10), 50, 70, 'Switch', 'f') + ext('Switch R', rect(17, -16, 29, -10), 50, 70, 'Switch', 'f')
ops += [{"op": "add_connector", "name": "Power", "domain": "electrical", "system": "PowerBalanced", "solid": "Back Box", "side": "back"},
        {"op": "link_connector_param", "name": "Power/Voltage", "connector": "Power", "connector_param": "Voltage", "param": "Voltage"},
        {"op": "link_connector_param", "name": "Power/Number of Poles", "connector": "Power", "connector_param": "Number of Poles", "param": "Number of Poles"},
        {"op": "link_connector_param", "name": "Power/Apparent Load", "connector": "Power", "connector_param": "Apparent Load", "param": "Apparent Load"}]
out.append(recipe(f, 'Metric Generic Model.rft', 'Electrical Fixtures', 'Wave 1: twin socket; proves the electrical connector with 240 V, poles and load linked to type parameters.', ops,
                  {"Plate 146 x 86 mm": A('BS 1363 twin plate'), "Load 180 VA": A('design allowance per outlet, engineer confirms'), "Height 450 mm": A('accessible outlet height practice')}))

# 3. Optical smoke detector with fire-alarm connector and a coverage disc (plan only)
f = 'FMC_FP_FireAlarm_Detector_Smoke'
ops = data('Optical_Standard', f, 'nr', 'IfcSensor', 'Optical smoke detector with base, addressable, ceiling mounted')
ops += subs('Base', 'Head', 'Coverage', 'Coarse Envelope')
ops += rev('Coarse Envelope', [[0, 0], [50, 0], [50, 55], [0, 55]], 'Coarse Envelope', 'c')
ops += rev('Base', [[0, 0], [52, 0], [52, 12], [0, 12]], 'Base', 'mf')
ops += rev('Head', [[0, 12], [50, 12], [46, 45], [30, 55], [0, 55]], 'Head', 'mf')
ops += rev('Coverage', [[0, 0], [7500, 0], [7500, 5], [0, 5]], 'Coverage', 'cmf')[:1]
ops += [{"op": "set_visibility", "name": "Coverage", "coarse": True, "medium": True, "fine": True, "plan_rcp": True, "front_back": False, "left_right": False},
        {"op": "add_connector", "name": "Fire Alarm", "domain": "electrical", "system": "FireAlarm", "solid": "Base", "side": "bottom"}]
out.append(recipe(f, 'Metric Generic Model.rft', 'Fire Alarm Devices', 'Wave 1: smoke detector; fire-alarm connector and a 7.5 m coverage disc shown in plan only (BS 5839-1 basis).', ops,
                  {"Coverage radius 7500 mm": A('BS 5839-1 point smoke detector, flat ceiling'), "Body 104 dia x 55 mm": A()}))

# 4. Pendent sprinkler K80 with a wet fire-protection pipe connector
f = 'FMC_FP_Sprinkler_Pendent_Standard'
ops = data('K80_68C', f, 'nr', 'IfcFireSuppressionTerminal', 'Pendent sprinkler K80, 68 C glass bulb, chrome')
ops += subs('Body', 'Deflector', 'Coarse Envelope')
ops += rev('Coarse Envelope', [[0, -60], [30, -60], [30, 0], [0, 0]], 'Coarse Envelope', 'c')
ops += rev('Body', [[0, -10], [12, -10], [12, 0], [0, 0]], 'Body', 'mf')
ops += rev('Frame', [[6, -45], [10, -45], [10, -10], [6, -10]], 'Body', 'f')
ops += rev('Deflector', [[0, -50], [28, -50], [28, -47], [0, -47]], 'Deflector', 'mf')
ops += [{"op": "add_connector", "name": "Inlet", "domain": "pipe", "system": "FireProtectWet", "solid": "Body", "side": "top", "diameter": 15, "flow": "In"}]
out.append(recipe(f, 'Metric Generic Model.rft', 'Sprinklers', 'Wave 1: pendent sprinkler; wet fire-protection pipe connector, turned parts by revolution.', ops,
                  {"K-factor 80": A('BS EN 12259-1 standard response'), "15 mm inlet": A()}))

# 5. Clinical hand-wash basin: CW, HW and sanitary connectors at their real heights
f = 'FMC_P_PlumbingFixture_Basin_ClinicalHandwash'
ops = data('500x400_Clinical', f, 'nr', 'IfcSanitaryTerminal', 'Clinical hand-wash basin, no overflow, no plug, back outlet, wall hung, elbow mixer')
ops += subs('Basin', 'Splashback', 'Tap', 'Coarse Envelope')
ops += ext('Coarse Envelope', rect(-250, -400, 250, 0), 650, 850, 'Coarse Envelope', 'c')
ops += ext('Basin', rect(-250, -400, 250, 0), 650, 850, 'Basin', 'mf')
ops += [{"op": "void_extrusion", "name": "Bowl", "points": rect(-210, -360, 210, -60), "start": 700, "end": 860}]
ops += ext('Splashback', rect(-300, -10, 300, 0), 850, 1250, 'Splashback', 'mf')
ops += ext('Tap Body', rect(-25, -60, 25, -10), 900, 960, 'Tap', 'f') + ext('Tap Spout', rect(-12, -200, 12, -60), 930, 950, 'Tap', 'f')
ops += ext('Waste Tail', rect(-25, -25, 25, 0), 600, 650, 'Basin', 'mf')
ops += ext('Supply Tails', rect(-60, -10, 60, 0), 960, 990, 'Tap', 'mf')
ops += [{"op": "add_connector", "name": "CW", "domain": "pipe", "system": "DomesticColdWater", "solid": "Supply Tails", "side": "back", "diameter": 15, "flow": "In"},
        {"op": "add_connector", "name": "HW", "domain": "pipe", "system": "DomesticHotWater", "solid": "Tap Body", "side": "top", "diameter": 15, "flow": "In"},
        {"op": "add_connector", "name": "Waste", "domain": "pipe", "system": "Sanitary", "solid": "Waste Tail", "side": "back", "diameter": 40, "flow": "Out"}]
out.append(recipe(f, 'Metric Generic Model.rft', 'Plumbing Fixtures', 'Wave 1: clinical basin (HBN 00-10 basis); CW, HW and sanitary connectors; bowl cut by a void; rim at 850.', ops,
                  {"Basin 500 x 400 mm": A(), "Rim height 850 mm": A('accessible basin practice'), "Waste 40 mm": A()}))

# 6. Straight grab rail: one length parameter drives the rail between locked planes (types 300-900)
f = 'FMC_A_SpecEq_GrabRail_Straight'
ops = [{"op": "add_family_param", "name": "Rail Length", "type": "Length"},
       {"op": "add_ref_plane", "name": "Rail Left", "from": [-300, -500], "to": [-300, 500], "is_reference": "Left"},
       {"op": "add_ref_plane", "name": "Rail Right", "from": [300, -500], "to": [300, 500], "is_reference": "Right"},
       {"op": "add_ref_plane", "name": "Rail Front", "from": [-800, -80], "to": [800, -80], "is_reference": "Front"},
       {"op": "add_ref_plane", "name": "Wall Face", "from": [-800, 0], "to": [800, 0], "is_reference": "Back"},
       {"op": "add_dimension", "name": "Rail Length", "between": ["Rail Left", "Rail Right"], "label": "Rail Length"},
       {"op": "add_eq_dimension", "name": "Rail EQ", "planes": ["Rail Left", "Center (Left/Right)", "Rail Right"]}]
for L in (300, 450, 600, 900):
    ops += data(f'{L}_SS', f, 'nr', 'IfcDiscreteAccessory', f'Straight grab rail {L} mm, 32 mm stainless steel, concealed fixings', {"Rail Length": L, "Default Elevation": 800})
ops += subs('Rail', 'Fixing')
ops += [{"op": "extrusion", "name": "Rail", "rect": ["Rail Left", "Rail Right", "Rail Front", "Wall Face"], "start": 784, "end": 816},
        {"op": "set_subcategory", "name": "Rail", "subcategory": "Rail"}]
ops += ext('Fixing L', rect(-310, -80, -250, 0), 770, 830, 'Fixing', 'mf')
out.append(recipe(f, 'Metric Generic Model.rft', 'Specialty Equipment', 'Wave 1: grab rail; one length parameter flexes the rail between locked planes; 4 types.', ops,
                  {"32 mm diameter, 50 mm clear of wall": A('BS 8300-2 basis'), "Mounting height 800 mm": A('BS 8300-2 basis')}))

# 7. Automatic sanitiser dispenser with a small power connector
f = 'FMC_A_SpecEq_Dispenser_Sanitiser_Auto'
ops = [{"op": "add_family_param", "name": "Voltage", "type": "Voltage", "group": "Electrical"},
       {"op": "add_family_param", "name": "Apparent Load", "type": "ApparentPower", "group": "ElectricalLoads"}]
ops += data('1200ml_Auto', f, 'nr', 'IfcDiscreteAccessory', 'Automatic alcohol gel dispenser, 1.2 L, touch-free, wall mounted', {"Voltage": 240, "Apparent Load": 10, "Default Elevation": 1100})
ops += subs('Body', 'Drip Tray', 'Coarse Envelope')
ops += ext('Coarse Envelope', rect(-60, -110, 60, 0), 0, 260, 'Coarse Envelope', 'c')
ops += ext('Body', rect(-60, -110, 60, 0), 40, 260, 'Body', 'mf')
ops += ext('Drip Tray', rect(-50, -100, 50, -10), 0, 15, 'Drip Tray', 'f')
ops += [{"op": "add_connector", "name": "Power", "domain": "electrical", "system": "PowerBalanced", "solid": "Body", "side": "back"},
        {"op": "link_connector_param", "name": "Power/Voltage", "connector": "Power", "connector_param": "Voltage", "param": "Voltage"},
        {"op": "link_connector_param", "name": "Power/Apparent Load", "connector": "Power", "connector_param": "Apparent Load", "param": "Apparent Load"}]
out.append(recipe(f, 'Metric Generic Model.rft', 'Specialty Equipment', 'Wave 1: sanitiser dispenser; architectural family with a power connector (owner rule 17 Oct).', ops,
                  {"Body 120 x 110 x 260 mm": A(), "Mains option, 10 VA": A('battery models need no connector')}))

# 8. Examination couch in the Medical Equipment category (no connectors, by rule)
f = 'FMC_I_MedEq_Couch_Examination'
ops = data('1900x650_2Section', f, 'nr', 'IfcMedicalDevice', 'Examination couch, 2 sections, fixed height 700 mm, vinyl top, steel frame')
ops += subs('Frame', 'Top', 'Coarse Envelope', 'Clearance Accessibility')
ops += ext('Coarse Envelope', rect(-950, -325, 950, 325), 0, 750, 'Coarse Envelope', 'c')
for i, (x, y) in enumerate([(-900, -280), (850, -280), (-900, 230), (850, 230)]):
    ops += ext(f'Leg {i + 1}', rect(x, y, x + 50, y + 50), 0, 640, 'Frame', 'mf')
ops += ext('Rails', rect(-950, -325, 950, 325), 640, 680, 'Frame', 'mf')
ops += ext('Top', rect(-950, -325, 350, 325), 680, 750, 'Top', 'mf')
ops += [{"op": "blend", "name": "Back Rest", "base": rect(350, -325, 950, 325), "top": rect(500, -325, 950, 325), "start": 680, "end": 900, "subcategory": "Top"},
        {"op": "set_visibility", "name": "Back Rest", "coarse": False, "medium": True, "fine": True}]
ops += ext('Side Clearance', rect(-950, -1225, 950, -325), 0, 10, 'Clearance Accessibility', 'cmf')
out.append(recipe(f, 'Metric Generic Model.rft', 'Medical Equipment', 'Wave 1: exam couch in Medical Equipment (no connectors); 900 mm side clearance solid; raised back by blend.', ops,
                  {"Top 1900 x 650 mm, 700 high": A(), "Side clearance 900 mm": A('HBN 00-03 basis')}))

# 9. Theatre laminar-flow canopy: rectangular supply-air duct connector
f = 'FMC_M_AirTerminal_Diffuser_LaminarFlow_Theatre'
ops = data('2400x2400_UCV', f, 'nr', 'IfcAirTerminal', 'Ultra-clean ventilation canopy over the operating zone, HEPA, 2400 x 2400 mm')
ops += subs('Plenum', 'Diffuser Face', 'Coarse Envelope', 'Clearance Operation')
ops += ext('Coarse Envelope', rect(-1200, -1200, 1200, 1200), -350, 0, 'Coarse Envelope', 'c')
ops += ext('Plenum', rect(-1200, -1200, 1200, 1200), -330, 0, 'Plenum', 'mf')
ops += ext('Diffuser Face', rect(-1150, -1150, 1150, 1150), -350, -330, 'Diffuser Face', 'f')
ops += ext('Spigot', rect(-300, -200, 300, 200), 0, 150, 'Plenum', 'mf')
ops += ext('Clean Zone', rect(-1200, -1200, 1200, 1200), -2350, -2340, 'Clearance Operation', 'cmf')
ops += [{"op": "add_connector", "name": "Supply", "domain": "duct", "system": "SupplyAir", "solid": "Spigot", "side": "top", "width": 600, "height": 400, "flow": "In"}]
out.append(recipe(f, 'Metric Generic Model.rft', 'Air Terminals', 'Wave 1: UCV canopy; rectangular supply-air duct connector; clean-zone outline at table height (HTM 03-01 basis).', ops,
                  {"Canopy 2400 x 2400 mm": A('HTM 03-01 UCV practice'), "Spigot 600 x 400 mm": A()}))

# 10. TPN distribution board, 415 V three-phase
f = 'FMC_E_EQ_DB_Final_TPN'
ops = [{"op": "add_family_param", "name": "Voltage", "type": "Voltage", "group": "Electrical"},
       {"op": "add_family_param", "name": "Number of Poles", "type": "NumberOfPoles", "group": "Electrical"}]
ops += data('12Way_TPN', f, 'nr', 'IfcElectricDistributionBoard', 'TPN distribution board, 12 ways per phase, 415 V, surface mounted, lockable door', {"Voltage": 415, "Number of Poles": 3, "Default Elevation": 1400})
ops += subs('Enclosure', 'Door', 'Coarse Envelope', 'Clearance Maintenance')
ops += ext('Coarse Envelope', rect(-225, -150, 225, 0), 0, 650, 'Coarse Envelope', 'c')
ops += ext('Enclosure', rect(-225, -140, 225, 0), 0, 650, 'Enclosure', 'mf')
ops += ext('Door', rect(-220, -150, 220, -140), 5, 645, 'Door', 'f')
ops += ext('Working Space', rect(-225, -1150, 225, -150), -1400, 600, 'Clearance Maintenance', 'cmf')
ops += [{"op": "add_connector", "name": "Supply", "domain": "electrical", "system": "PowerBalanced", "solid": "Enclosure", "side": "top"},
        {"op": "link_connector_param", "name": "Supply/Voltage", "connector": "Supply", "connector_param": "Voltage", "param": "Voltage"},
        {"op": "link_connector_param", "name": "Supply/Number of Poles", "connector": "Supply", "connector_param": "Number of Poles", "param": "Number of Poles"}]
out.append(recipe(f, 'Metric Generic Model.rft', 'Electrical Equipment', 'Wave 1: TPN board 415 V; electrical equipment connector; 1 m working space in front (maintenance clearance).', ops,
                  {"Enclosure 450 x 650 x 150 mm": A(), "Working space 1000 mm": A('BS 7671 / practice')}))

print('\n'.join(out))
