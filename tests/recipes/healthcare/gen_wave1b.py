"""Healthcare pack wave 1, batch 2: service points (Revit QE4 result, 17 Oct), theatre AHU, IT power panel, beam
seating (array op), the turning-circle clearance and an ICU bed that nests a service point (nested shared, QE3).
Same conventions as gen_wave1.py. Run: python gen_wave1b.py <healthcare_pack.json> <staging root>"""
import sys, os
sys.argv = sys.argv[:2] + sys.argv[3:] if len(sys.argv) > 2 else sys.argv
STAGING = r"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\04_Families\_Staging"
exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'gen_wave1.py')).read().split("out = []")[0])
out = []

def sp(family, desc, conns, kn_note, tname):
    ops = [{"op": "set_family_params", "name": "family", "shared": True}]
    ops += data(tname, family, 'nr', 'IfcFlowTerminal', desc)
    ops = [o for o in ops if not (o.get('param') in ('Keynote', 'FMC_Keynote_Code'))]
    ops += subs('Service Point')
    ops += ext('Point', rect(-30, -30, 30, 30), 0, 60, 'Service Point', 'cmf')
    ops += [dict(op="add_connector", name=n, domain=d, system=s, solid="Point", side=side, **({"diameter": dia} if dia else {}), **({"flow": f} if f else {}))
            for n, d, s, side, dia, f in conns]
    r = recipe(family, 'Metric Generic Model.rft', 'Plumbing Equipment', 'Nested shared service point: carries the pipe connectors a Medical Equipment host cannot (Revit QE4 test, 17 Oct). Placed inside the host at the real outlet position.', ops,
               {"Point 60 mm cube": A('symbolic connection point')})
    import json
    p = os.path.join(HERE, r + '.recipe.json'); j = json.load(open(p)); j['checks'] = {"keynote_exempt": kn_note}; json.dump(j, open(p, 'w'), indent=1)
    return r

out.append(sp('FMC_P_PlumbingEq_ServicePoint_MedGas', 'Medical gas service point (O2, vacuum, medical air) inside a Medical Equipment host',
              [("O2", "pipe", "Other", "back", 15, "In"), ("VAC", "pipe", "Other", "left", 15, "Out"), ("MA4", "pipe", "Other", "right", 15, "In")],
              'nested service point, never scheduled; the host carries the keynote', '60_MedGas'))
out.append(sp('FMC_P_PlumbingEq_ServicePoint_Water', 'Water and drainage service point (CW, HW, waste) inside a Medical Equipment host',
              [("CW", "pipe", "DomesticColdWater", "back", 15, "In"), ("HW", "pipe", "DomesticHotWater", "left", 15, "In"), ("Waste", "pipe", "Sanitary", "bottom", 40, "Out")],
              'nested service point, never scheduled; the host carries the keynote', '60_Water'))

# Theatre AHU: four duct connectors, condensate and power
f = 'FMC_M_MechEq_AHU_Theatre_HEPA'
ops = [{"op": "add_family_param", "name": "Voltage", "type": "Voltage", "group": "Electrical"},
       {"op": "add_family_param", "name": "Number of Poles", "type": "NumberOfPoles", "group": "Electrical"},
       {"op": "add_family_param", "name": "Apparent Load", "type": "ApparentPower", "group": "ElectricalLoads"}]
ops += data('2500ls_HEPA', f, 'nr', 'IfcUnitaryEquipment', 'Theatre air handling unit 2.5 m3/s, F7 + HEPA H14, cooling coil, humidifier, EC fans', {"Voltage": 415, "Number of Poles": 3, "Apparent Load": 15000})
ops += subs('Casing', 'Base', 'Coarse Envelope', 'Clearance Maintenance')
ops += ext('Coarse Envelope', rect(-2500, -800, 2500, 800), 0, 2100, 'Coarse Envelope', 'c')
ops += ext('Base', rect(-2500, -800, 2500, 800), 0, 150, 'Base', 'mf')
ops += ext('Casing', rect(-2500, -800, 2500, 800), 150, 2100, 'Casing', 'mf')
for n, x0, x1 in (('Panel Line 1', -1510, -1490), ('Panel Line 2', -10, 10), ('Panel Line 3', 1490, 1510)):
    ops += ext(n, rect(x0, -820, x1, -800), 150, 2100, 'Base', 'f')
ops += ext('Supply Spigot', rect(2500, -400, 2700, 400), 1200, 1800, 'Casing', 'mf') + ext('Fresh Spigot', rect(-2700, -400, -2500, 400), 1200, 1800, 'Casing', 'mf')
ops += ext('Return Spigot', rect(-1800, -300, -1000, 300), 2100, 2300, 'Casing', 'mf') + ext('Exhaust Spigot', rect(-2700, -400, -2500, 400), 400, 1000, 'Casing', 'mf')
ops += ext('Drain Stub', rect(800, -830, 860, -800), 150, 210, 'Base', 'mf')
ops += ext('Service Zone', rect(-2500, -1800, 2500, -800), 0, 10, 'Clearance Maintenance', 'cmf')
ops += [{"op": "add_connector", "name": "Supply", "domain": "duct", "system": "SupplyAir", "solid": "Supply Spigot", "side": "right", "width": 800, "height": 600, "flow": "Out"},
        {"op": "add_connector", "name": "Fresh Air", "domain": "duct", "system": "OtherAir", "solid": "Fresh Spigot", "side": "left", "width": 800, "height": 600, "flow": "In"},
        {"op": "add_connector", "name": "Return", "domain": "duct", "system": "ReturnAir", "solid": "Return Spigot", "side": "top", "width": 800, "height": 600, "flow": "In"},
        {"op": "add_connector", "name": "Exhaust", "domain": "duct", "system": "ExhaustAir", "solid": "Exhaust Spigot", "side": "left", "width": 800, "height": 600, "flow": "Out"},
        {"op": "add_connector", "name": "Condensate", "domain": "pipe", "system": "Sanitary", "solid": "Drain Stub", "side": "front", "diameter": 32, "flow": "Out"},
        {"op": "add_connector", "name": "Power", "domain": "electrical", "system": "PowerBalanced", "solid": "Casing", "side": "back"},
        {"op": "link_connector_param", "name": "Power/Voltage", "connector": "Power", "connector_param": "Voltage", "param": "Voltage"},
        {"op": "link_connector_param", "name": "Power/Number of Poles", "connector": "Power", "connector_param": "Number of Poles", "param": "Number of Poles"},
        {"op": "link_connector_param", "name": "Power/Apparent Load", "connector": "Power", "connector_param": "Apparent Load", "param": "Apparent Load"}]
out.append(recipe(f, 'Metric Mechanical Equipment.rft', None, 'Wave 1: theatre AHU; four rectangular duct connectors (supply, return, fresh, exhaust), condensate pipe, 415 V power; 1 m service zone (HTM 03-01 basis).', ops,
                  {"Casing 5000 x 1600 x 2100 mm": A('typical 2.5 m3/s theatre AHU'), "Load 15 kVA": A('engineer confirms'), "Spigots 800 x 600 mm": A()}))

# Medical IT (isolated power) panel for theatres
f = 'FMC_E_EQ_IPS_Theatre_IT'
ops = [{"op": "add_family_param", "name": "Voltage", "type": "Voltage", "group": "Electrical"},
       {"op": "add_family_param", "name": "Apparent Load", "type": "ApparentPower", "group": "ElectricalLoads"}]
ops += data('8kVA_IT', f, 'nr', 'IfcElectricDistributionBoard', 'Medical IT isolated power panel 8 kVA, isolating transformer, insulation monitor, remote alarm (HTM 06-01 group 2)', {"Voltage": 240, "Apparent Load": 8000, "Default Elevation": 300})
ops += subs('Enclosure', 'Door', 'Coarse Envelope', 'Clearance Maintenance')
ops += ext('Coarse Envelope', rect(-400, -300, 400, 0), 0, 1200, 'Coarse Envelope', 'c')
ops += ext('Enclosure', rect(-400, -290, 400, 0), 0, 1200, 'Enclosure', 'mf') + ext('Door', rect(-395, -300, 395, -290), 10, 1190, 'Door', 'f')
ops += ext('Working Space', rect(-400, -1300, 400, -300), -300, 1700, 'Clearance Maintenance', 'cmf')
ops += [{"op": "add_connector", "name": "Supply", "domain": "electrical", "system": "PowerBalanced", "solid": "Enclosure", "side": "top"},
        {"op": "link_connector_param", "name": "Supply/Voltage", "connector": "Supply", "connector_param": "Voltage", "param": "Voltage"},
        {"op": "link_connector_param", "name": "Supply/Apparent Load", "connector": "Supply", "connector_param": "Apparent Load", "param": "Apparent Load"}]
out.append(recipe(f, 'Metric Generic Model.rft', 'Electrical Equipment', 'Wave 1: medical IT panel (group 2 locations); electrical equipment with load; 1 m working space.', ops,
                  {"Enclosure 800 x 1200 x 300 mm": A(), "8 kVA": A('per theatre, engineer confirms')}))

# Beam seating: seat count drives the beam length and the array of seats
f = 'FMC_I_Furniture_Seating_Waiting_Beam'
ops = [{"op": "add_family_param", "name": "Seat Count", "type": "Integer"},
       {"op": "add_family_param", "name": "Beam Length", "type": "Length"},
       {"op": "add_ref_plane", "name": "Beam Start", "from": [0, -800], "to": [0, 800], "is_reference": "Left"},
       {"op": "add_ref_plane", "name": "Beam End", "from": [1800, -800], "to": [1800, 800], "is_reference": "Right"},
       {"op": "add_ref_plane", "name": "Seat Front", "from": [-200, -560], "to": [3200, -560], "is_reference": "Front"},
       {"op": "add_ref_plane", "name": "Seat Back", "from": [-200, 0], "to": [3200, 0], "is_reference": "Back"},
       {"op": "add_dimension", "name": "Beam Length", "between": ["Beam Start", "Beam End"], "label": "Beam Length"},
       {"op": "set_formula", "name": "Beam Length", "formula": "Seat Count * 600 mm"}]
for n in (3, 4, 5):
    ops += data(f'{n}Seat', f, 'nr', 'IfcFurniture', f'Beam seating, {n} seats, antimicrobial vinyl, steel beam on 2 legs', {"Seat Count": n})
ops += subs('Frame', 'Seat', 'Coarse Envelope')
ops += [{"op": "extrusion", "name": "Beam", "rect": ["Beam Start", "Beam End", "Seat Front", "Seat Back"], "start": 330, "end": 380},
        {"op": "set_subcategory", "name": "Beam", "subcategory": "Frame"}]
ops += ext('Leg Left', rect(50, -500, 110, -60), 0, 330, 'Frame', 'mf')
ops += ext('Seat', rect(20, -540, 580, -20), 400, 460, 'Seat', 'mf') + ext('Back', rect(20, -60, 580, -20), 460, 820, 'Seat', 'mf')
ops += [{"op": "array", "name": "Seats", "solid": "Seat", "direction": "x", "count_param": "Seat Count", "spacing_mm": 600, "max": 5},
        {"op": "array", "name": "Backs", "solid": "Back", "direction": "x", "count_param": "Seat Count", "spacing_mm": 600, "max": 5}]
out.append(recipe(f, 'Metric Generic Model.rft', 'Furniture', 'Wave 1: beam seating; Seat Count drives the beam length by formula and the seats and backs by the array op (copies); 3 types.', ops,
                  {"Seat pitch 600 mm": A(), "Seat height 460 mm": A()}))

# Turning circle: the shared clearance every accessible family nests
f = 'FMC_A_GenericModel_Clearance_TurningCircle'
ops = [{"op": "set_family_params", "name": "family", "shared": True}]
ops += [o for o in data('1500_TurningCircle', f, 'nr', 'IfcBuildingElementProxy', 'Wheelchair turning circle 1500 mm, clearance solid (never printed)') if o.get('param') not in ('Keynote', 'FMC_Keynote_Code')]
ops += subs('Clearance Accessibility')
ops += rev('Turning Circle', [[0, 0], [750, 0], [750, 10], [0, 10]], 'Clearance Accessibility', 'cmf')
r = recipe(f, 'Metric Generic Model.rft', None, 'Wave 1: the shared turning-circle clearance (BS 8300); nested by toilets, wards and rooms; its subcategory is hidden in printed sets.', ops,
           {"Diameter 1500 mm": A('BS 8300-2')})
import json
p = os.path.join(HERE, r + '.recipe.json'); j = json.load(open(p)); j['checks'] = {"keynote_exempt": "clearance solid, never scheduled or printed"}; json.dump(j, open(p, 'w'), indent=1)
out.append(r)

# ICU bed, redrawn from a real datasheet (reference step, 17 Oct): GeM catalogue ICU bed, 4-section electric
SRC = "datasheet: GeM catalogue item 764126 (https://org.gem.gov.in/cart/cart_global/describe_items/764126); photos: image search 'ICU electric hospital bed side rails'"
V = lambda v, what: {"value": v, "source_status": "verified", "source": SRC + " · " + what}
f = 'FMC_I_MedEq_Bed_ICU_Electric'
ops = [{"op": "add_family_param", "name": "Voltage", "type": "Voltage", "group": "Electrical"},
       {"op": "add_family_param", "name": "Apparent Load", "type": "ApparentPower", "group": "ElectricalLoads"}]
ops += data('2190x1080_ICU', f, 'nr', 'IfcMedicalDevice', 'ICU bed, electric, 4-section perforated platform 2060 x 910, height 450-780, backrest 80 deg, knee 35 deg, Trendelenburg 30/15 deg, 125 mm castors (2 braked), 250 kg', {"Voltage": 240, "Apparent Load": 400})
ops += subs('Frame', 'Mattress', 'Rails', 'Castors', 'Coarse Envelope', 'Clearance Operation')
ops += ext('Coarse Envelope', rect(-1095, -540, 1095, 540), 0, 900, 'Coarse Envelope', 'c')
# chassis: two longitudinal tubes and two lifting columns
ops += ext('Chassis Tube L', rect(-1000, -430, 1000, -380), 180, 230, 'Frame', 'mf') + ext('Chassis Tube R', rect(-1000, 380, 1000, 430), 180, 230, 'Frame', 'mf')
ops += ext('Chassis Cross H', rect(-1000, -430, -950, 430), 180, 230, 'Frame', 'mf') + ext('Chassis Cross F', rect(950, -430, 1000, 430), 180, 230, 'Frame', 'mf')
ops += ext('Column H', rect(-760, -60, -640, 60), 230, 450, 'Frame', 'mf') + ext('Column F', rect(640, -60, 760, 60), 230, 450, 'Frame', 'mf')
# castors 125 mm with forks
for i, (x, y) in enumerate([(-975, -405), (975, -405), (-975, 405), (975, 405)]):
    ops += ext(f'Fork {i + 1}', rect(x - 20, y - 20, x + 20, y + 20), 125, 180, 'Castors', 'mf')
    ops += rev(f'Castor {i + 1}', [[0, 0], [62, 0], [62, 125], [0, 125]], 'Castors', 'mf', at=(x, y))
# platform frame 2060 x 910 and four sections (head 700, seat 250, thigh 450, leg 660)
ops += ext('Platform Frame', rect(-1030, -455, 1030, 455), 450, 480, 'Frame', 'mf')
for n, x0, x1 in (('Back Section', -1020, -320), ('Seat Section', -310, -60), ('Thigh Section', -50, 400), ('Leg Section', 410, 1020)):
    ops += ext(n, rect(x0, -445, x1, 445), 480, 490, 'Frame', 'f')
ops += ext('Mattress', rect(-1020, -445, 1020, 445), 490, 590, 'Mattress', 'mf')
# head and foot bows: 950 long, 400 high above the platform, 32 thick
ops += ext('Head Bow', rect(-1095, -475, -1063, 475), 450, 890, 'Frame', 'mf') + ext('Foot Bow', rect(1063, -475, 1095, 475), 450, 890, 'Frame', 'mf')
# side rails: 4 supports, 400 high over the platform
for n, x0, x1, y0, y1 in (('Rail Head L', -1000, -120, -490, -470), ('Rail Foot L', -80, 800, -490, -470), ('Rail Head R', -1000, -120, 470, 490), ('Rail Foot R', -80, 800, 470, 490)):
    ops += ext(n, rect(x0, y0, x1, y1), 520, 880, 'Rails', 'f')
# IV pole and net-pole sockets at the four corners
for i, (x, y) in enumerate([(-1045, -465), (-1045, 465), (1045, -465), (1045, 465)]):
    ops += rev(f'IV Socket {i + 1}', [[0, 0], [12, 0], [12, 60], [0, 60]], 'Frame', 'f', at=(x, y))
ops += ext('Bed Space', rect(-2295, -1740, 2295, 1740), 0, 10, 'Clearance Operation', 'cmf')
ops += [{"op": "add_connector", "name": "Power", "domain": "electrical", "system": "PowerBalanced", "solid": "Chassis Cross H", "side": "left"},
        {"op": "link_connector_param", "name": "Power/Voltage", "connector": "Power", "connector_param": "Voltage", "param": "Voltage"},
        {"op": "link_connector_param", "name": "Power/Apparent Load", "connector": "Power", "connector_param": "Apparent Load", "param": "Apparent Load"},
        {"op": "load_family", "name": "FMC_P_PlumbingEq_ServicePoint_MedGas", "path": STAGING + r"\P\FMC_P_PlumbingEq_ServicePoint_MedGas.rfa", "shared": True},
        {"op": "place_nested", "name": "Gas Point", "family": "FMC_P_PlumbingEq_ServicePoint_MedGas", "type": "60_MedGas", "at": [-1150, 0, 1400]}]
out.append(recipe(f, 'Metric Generic Model.rft', 'Medical Equipment', 'Wave 1, redrawn from a datasheet (reference step): ICU bed in Medical Equipment with its own power connector (works, QE4) and the shared medical-gas service point nested at the bedhead (pipes refuse MedEq, QE4); 1200 mm clear bed space. ' + SRC, ops,
                  {"Overall 2190 x 1080 mm": V("2190x1080", "overall length and width"), "Platform 2060 x 910 mm, 4 sections": V("2060x910", "bed frame and sections"),
                   "Height 450-780 mm": V("450-780", "height adjustment range"), "Bows 950 x 400 x 32 mm": V("950x400x32", "head and foot bows"),
                   "Side rails 400 mm high": V(400, "side rail height"), "Castors 125 mm": V(125, "castor diameter"), "Mattress 100 mm": V(100, "mattress thickness"),
                   "Load 400 VA": A('engineer confirms'), "Bed space 1200 mm": A('HBN 04-02 basis')}))
print('\n'.join(out))
