"""Healthcare pack, detailed product models (photo-to-family pipeline, 17 Oct). Each product: parts with kit materials,
a reference (brand, model, datasheet, photo search) and sourced values. Compile + render with ../../tools/fmc_parts.py.
Run: python make_products.py   (writes <family>.product.json, .recipe.json and .preview.png here)"""
import json, os, sys, math
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'tools'))
import fmc_parts as fp
KN = {r['family']: r.get('kn', '') for r in json.load(open('/home/claude/board/healthcare_pack.json'))['families']}
V = lambda v, src: {"value": v, "source_status": "verified", "source": src}
A = lambda v, src='typical product, to confirm with the supplier': {"value": v, "source_status": "assumed", "source": src}
P = []

def terminal_unit(gas, ring, name, kn_fam, desc):
    parts = [
        {"n": "Back Box", "shape": "box", "at": [-45, 0, 5, 45, 55, 95], "mat": "steel"},
        {"n": "Fascia", "shape": "fbox", "at": [-50, -10, 0, 50, 0, 100], "r": 8, "mat": "white"},
        {"n": "Fascia Face", "shape": "fbox", "at": [-47, -12, 3, 47, -10, 97], "r": 7, "mat": "white", "lod": "f"},
        {"n": "Gas Ring", "shape": "turn", "axis": "y", "c": [0, 55], "profile": [[19, -12], [27, -12], [27, -16], [19, -16]], "mat": ring},
        {"n": "Socket Collar", "shape": "turn", "axis": "y", "c": [0, 55], "profile": [[0, -10], [19, -10], [19, -24], [15, -26], [6, -26], [6, -22], [0, -22]], "mat": "chrome"},
        {"n": "Release Ring", "shape": "turn", "axis": "y", "c": [0, 55], "profile": [[14, -24], [17, -24], [17, -28], [14, -28]], "mat": "chrome", "lod": "f"},
        {"n": "Label Strip", "shape": "fbox", "at": [-30, -12.6, 14, 30, -12, 26], "r": 2, "mat": ring, "lod": "f"},
        {"n": "Screw", "shape": "cyl", "axis": "y", "c": [-40, 90], "r": 2.5, "y": [-12.8, -12], "mat": "chrome", "lod": "f", "repeat": {"n": 2, "d": [80, 0, 0]}},
    ]
    return {"family": name, "template": "Metric Mechanical Equipment.rft", "desc": desc, "ifc": "IfcFlowTerminal", "keynote": KN.get(kn_fam, ''),
            "types": [{"name": f"BS5682_{gas}"}], "type_values": {"Default Elevation": 1400},
            "materials": {"white": "FMC_Plastic_ABS_White", "chrome": "FMC_Metal_Chrome_Polished", "steel": "FMC_Metal_SteelLTZ_Painted", ring: "FMC_Plastic_ABS_Yellow" if ring == 'yellow' else "FMC_Plastic_ABS_White" if ring == 'o2white' else "FMC_Plastic_ABS_Black"},
            "reference": {"brand": "Dräger / BeaconMedaes (typical)", "model": f"BS 5682 terminal unit, {gas}", "url": "https://www.draeger.com/Content/Documents/Products/Terminal-Units-pi-9106572.pdf", "images": f"image search: BS 5682 {gas} terminal unit wall"},
            "parts": parts,
            "connectors": [{"n": gas, "domain": "pipe", "system": "Other", "part": "Back Box", "side": "back", "diameter": 15, "flow": "In" if gas != "VAC" else "Out"}],
            "values": {"Probe to BS 5682": V("BS 5682", "BS 5682:2015 probes and terminal units"), "Fascia 100 x 100 mm": A("100x100", "square wall plate (Dräger lists square plates; size not published)"),
                       "Gas identification colour": V(ring, "HTM 02-01 / BS 1710 gas identification"), "Mounting height 1400 mm": A(1400, "bedhead practice")},
            "about": "Terminal unit redrawn as a product: square fascia, gas identification ring, chrome collar and release ring, label strip, screws, steel back box."}
P.append(terminal_unit("O2", "o2white", "FMC_P_MechEq_MedGas_Outlet_O2", "FMC_P_MechEq_MedGas_Outlet_O2", "Oxygen terminal unit, BS 5682 probe, wall mounted, flush back box"))
P[-1]["materials"]["o2white"] = "FMC_Plastic_ABS_Black"   # O2 label strip shown black on white per common UK practice
P.append(terminal_unit("VAC", "yellow", "FMC_P_MechEq_MedGas_Outlet_Vacuum", "FMC_P_MechEq_MedGas_Outlet_Vacuum", "Medical vacuum terminal unit, BS 5682 probe, wall mounted, flush back box"))

# Clinical basin: Armitage Shanks Contour 21 clinical, 500 mm, vitreous china, no tap holes, back outlet; wall-mounted mixer
basin = [
    {"n": "Basin Body", "shape": "box", "at": [-250, -420, 665, 250, 0, 850], "r": 70, "mat": "china"},
    {"n": "Bowl", "shape": "box", "at": [-205, -380, 700, 205, -60, 860], "r": 60, "void": True},
    {"n": "Wall Flange", "shape": "box", "at": [-230, -15, 680, 230, 0, 850], "mat": "china", "lod": "f"},
    {"n": "Waste", "shape": "cyl", "axis": "z", "c": [0, -220], "r": 24, "z": [699, 702], "mat": "chrome", "lod": "f"},
    {"n": "Back Outlet", "shape": "cyl", "axis": "y", "c": [0, 640], "r": 20, "y": [-60, 0], "mat": "chrome"},
    {"n": "Splashback", "shape": "fbox", "at": [-300, -6, 850, 300, 0, 1250], "r": 4, "mat": "hpl"},
    {"n": "Mixer Body", "shape": "cyl", "axis": "y", "c": [0, 1010], "r": 28, "y": [-75, -6], "mat": "chrome"},
    {"n": "Spout", "shape": "turn", "axis": "z", "c": [0, -190], "profile": [[0, 900], [11, 900], [11, 1010], [0, 1010]], "mat": "chrome"},
    {"n": "Spout Arm", "shape": "cyl", "axis": "y", "c": [0, 1000], "r": 11, "y": [-190, -75], "mat": "chrome"},
    {"n": "Elbow Lever", "shape": "box", "at": [28, -60, 1004, 200, -48, 1016], "r": 5, "mat": "chrome", "lod": "f"},
    {"n": "Supply Tails", "shape": "box", "at": [-60, -6, 990, 60, 0, 1030], "mat": "chrome", "lod": "m"},
]
P.append({"family": "FMC_P_PlumbingFixture_Basin_ClinicalHandwash", "category": "Plumbing Fixtures", "desc": "Clinical hand-wash basin 500 mm, vitreous china, no overflow, no tap holes, back outlet; wall-mounted elbow-lever mixer; HPL splashback",
          "ifc": "IfcSanitaryTerminal", "keynote": KN.get("FMC_P_PlumbingFixture_Basin_ClinicalHandwash"), "types": [{"name": "500x420_Clinical"}],
          "materials": {"china": "FMC_Ceramic_VitreousChina_White", "chrome": "FMC_Metal_Chrome_Polished", "hpl": "FMC_Plastic_Laminate_HPL"},
          "reference": {"brand": "Armitage Shanks", "model": "Contour 21 clinical basin 500 mm", "url": "https://cdn.source.thenbs.com/product/contour-21-clinical-basin/gCXqpN7PE9QVdC3iBgmsRN/eZb9Q7m9qzJnfZiF8EU2sR", "images": "image search: Armitage Shanks Contour 21 clinical basin"},
          "parts": basin,
          "connectors": [{"n": "CW", "domain": "pipe", "system": "DomesticColdWater", "part": "Supply Tails", "side": "back", "diameter": 15, "flow": "In"},
                         {"n": "HW", "domain": "pipe", "system": "DomesticHotWater", "part": "Mixer Body", "side": "back", "diameter": 15, "flow": "In"},
                         {"n": "Waste", "domain": "pipe", "system": "Sanitary", "part": "Back Outlet", "side": "back", "diameter": 40, "flow": "Out"}],
          "values": {"Width 500 mm": V(500, "NBS Source, Contour 21 clinical basin"), "Body height 185 mm": V(185, "NBS Source, Contour 21 clinical basin"),
                     "Vitreous china, white, no tap holes, centre waste": V("china", "NBS Source, Contour 21 clinical basin"),
                     "Projection 420 mm": A(420), "Rim height 850 mm": A(850, "HBN 00-10 / accessible basin practice"), "Waste 40 mm": A(40)},
          "about": "Clinical basin redrawn from the Contour 21 datasheet: rounded bowl cut by a void, wall flange, back outlet, HPL splashback, wall mixer with elbow lever."})

# Smoke detector: Apollo Soteria optical, 100 dia, 48 high with base (ceiling at z = 0, hangs down)
P.append({"family": "FMC_FP_FireAlarm_Detector_Smoke", "category": "Fire Alarm Devices", "desc": "Optical smoke detector with mounting base, addressable, 100 mm diameter, 48 mm high",
          "ifc": "IfcSensor", "keynote": KN.get("FMC_FP_FireAlarm_Detector_Smoke"), "types": [{"name": "100_OpticalAddressable"}],
          "materials": {"white": "FMC_Plastic_ABS_White", "grey": "FMC_Plastic_ABS_Grey", "led": "FMC_Plastic_LED_Red"},
          "reference": {"brand": "Apollo", "model": "Soteria optical smoke detector SA5100-600APO with XPERT 8 base", "url": "https://cdn.contentspeed.ro/siel.websales.ro/cs-content/cs-docs/Pp2515-Soteria-Optical-Smoke-Detector-Datasheet-Pdf-19590-1716548559.pdf", "images": "image search: Apollo Soteria optical smoke detector"},
          "parts": [
              {"n": "Base", "shape": "turn", "axis": "z", "c": [0, 0], "profile": [[0, -12], [51, -12], [51, 0], [0, 0]], "mat": "white"},
              {"n": "Head", "shape": "turn", "axis": "z", "c": [0, 0], "profile": [[0, -48], [38, -48], [46, -44], [50, -36], [50, -12], [0, -12]], "mat": "white"},
              {"n": "Smoke Inlet Gap", "shape": "turn", "axis": "z", "c": [0, 0], "profile": [[47, -32], [50.5, -32], [50.5, -22], [47, -22]], "mat": "grey", "lod": "f"},
              {"n": "Centre Boss", "shape": "turn", "axis": "z", "c": [0, 0], "profile": [[0, -50], [14, -50], [16, -48], [0, -48]], "mat": "white", "lod": "f"},
              {"n": "LED", "shape": "cyl", "axis": "z", "c": [0, -30], "r": 4, "z": [-49.5, -48], "mat": "led", "lod": "f"}],
          "clearances": [{"n": "Coverage", "shape": "turn", "axis": "z", "c": [0, 0], "profile": [[0, -60], [7500, -60], [7500, -55], [0, -55]], "sub": "Coverage"}],
          "connectors": [{"n": "Fire Alarm", "domain": "electrical", "system": "FireAlarm", "part": "Base", "side": "top"}],
          "values": {"Diameter 100 mm": V(100, "Apollo Soteria datasheet PP2515"), "Height 48 mm with base": V(48, "Apollo Soteria datasheet PP2515"), "Tricolour 360 LED": V("LED", "Apollo Soteria datasheet PP2515"),
                     "Coverage radius 7500 mm": A(7500, "BS 5839-1 point smoke detector, flat ceiling")},
          "about": "Detector redrawn from the Soteria datasheet: base, domed head with smoke-inlet band, centre boss and LED; hangs below the ceiling (z = 0); 7.5 m coverage disc."})

# Pendent sprinkler: Tyco TY3231 (5.6K, K80), brass; deflector 89 mm; with chrome escutcheon (ceiling at z = 0)
P.append({"family": "FMC_FP_Sprinkler_Pendent_Standard", "category": "Sprinklers", "desc": "Pendent sprinkler K80 (5.6K), 3 mm 68 C bulb, 1/2 in thread, natural brass, recessed chrome escutcheon",
          "ifc": "IfcFireSuppressionTerminal", "keynote": KN.get("FMC_FP_Sprinkler_Pendent_Standard"), "types": [{"name": "K80_68C"}],
          "materials": {"brass": "FMC_Metal_Brass_Polished", "chrome": "FMC_Metal_Chrome_Polished", "bulb": "FMC_Plastic_LED_Red"},
          "reference": {"brand": "Tyco", "model": "TY3231 / TY-FRB pendent 5.6K", "url": "https://cdn.shopify.com/s/files/1/2233/5109/files/Ty4133_Spec_Sheet.pdf", "images": "image search: Tyco TY3231 pendent sprinkler brass"},
          "parts": [
              {"n": "Escutcheon", "shape": "turn", "axis": "z", "c": [0, 0], "profile": [[11, -6], [36, -2], [36, 0], [11, 0]], "mat": "chrome"},
              {"n": "Body", "shape": "turn", "axis": "z", "c": [0, 0], "profile": [[0, -14], [11, -14], [11, 11], [0, 11]], "mat": "brass"},
              {"n": "Wrench Boss", "shape": "box", "at": [-13, -8, -20, 13, 8, -14], "mat": "brass", "lod": "f"},
              {"n": "Frame Arm", "shape": "box", "at": [-11, -2.5, -52, -7, 2.5, -20], "mat": "brass", "repeat": {"n": 2, "d": [18, 0, 0]}},
              {"n": "Frame Head", "shape": "box", "at": [-11, -2.5, -56, 11, 2.5, -52], "mat": "brass"},
              {"n": "Bulb", "shape": "turn", "axis": "z", "c": [0, 0], "profile": [[0, -52], [1.5, -50], [1.5, -24], [0, -22]], "mat": "bulb", "lod": "f"},
              {"n": "Deflector", "shape": "turn", "axis": "z", "c": [0, 0], "profile": [[0, -60], [44.5, -59], [44.5, -57], [0, -57]], "mat": "brass"}],
          "connectors": [{"n": "Inlet", "domain": "pipe", "system": "FireProtectWet", "part": "Body", "side": "top", "diameter": 15, "flow": "In"}],
          "values": {"Deflector 89 mm": V(89, "Tyco TY3231 spec sheet"), "K-factor 5.6 (K80)": V("5.6K", "Tyco TY3231 spec sheet"), "Bulb 3 mm": V(3, "Tyco TY3231 spec sheet"),
                     "1/2 in NPT thread": V("1/2 NPT", "Tyco TY3231 spec sheet"), "Length 60 mm": A(60, "5.6K pendent figure callout 55.6/60.3 mm")},
          "about": "Sprinkler redrawn from the Tyco spec sheet: body, wrench boss, frame arms, glass bulb, 89 mm deflector, chrome escutcheon at the ceiling (z = 0)."})

# Sanitiser dispenser: Purell ES8, 5.25 x 8.56 x 12.13 in (133 x 217 x 308 mm)
P.append({"family": "FMC_A_SpecEq_Dispenser_Sanitiser_Auto", "category": "Specialty Equipment", "desc": "Touch-free hand sanitiser dispenser 1200 ml, 133 x 217 x 308 mm, window, drip shield",
          "ifc": "IfcDiscreteAccessory", "keynote": KN.get("FMC_A_SpecEq_Dispenser_Sanitiser_Auto"), "types": [{"name": "1200ml_TouchFree"}],
          "type_values": {"Voltage": 240, "Apparent Load": 10, "Default Elevation": 950},
          "materials": {"white": "FMC_Plastic_ABS_White", "grey": "FMC_Plastic_ABS_Grey", "window": "FMC_Plastic_Polycarbonate_Clear", "black": "FMC_Plastic_ABS_Black"},
          "reference": {"brand": "GOJO", "model": "PURELL ES8 touch-free 7720-01 (white)", "url": "https://www.webstaurantstore.com/purell-7724-01-es8-1200-ml-graphite-automatic-hand-sanitizer-dispenser/381P772401.html", "images": "image search: Purell ES8 dispenser white"},
          "parts": [
              {"n": "Back Plate", "shape": "fbox", "at": [-66, -15, 0, 66, 0, 308], "r": 18, "mat": "grey"},
              {"n": "Cover", "shape": "box", "at": [-64, -217, 40, 64, -15, 300], "r": 30, "mat": "white"},
              {"n": "Cover Top", "shape": "box", "at": [-60, -205, 300, 60, -15, 306], "r": 26, "mat": "white", "lod": "f"},
              {"n": "Window", "shape": "fbox", "at": [-30, -218, 190, 30, -210, 270], "r": 10, "mat": "window", "lod": "f"},
              {"n": "Logo Band", "shape": "fbox", "at": [-45, -218, 120, 45, -216, 132], "r": 3, "mat": "grey", "lod": "f"},
              {"n": "Nozzle Shroud", "shape": "box", "at": [-25, -150, 28, 25, -60, 40], "r": 10, "mat": "black"},
              {"n": "Sensor Eye", "shape": "cyl", "axis": "z", "c": [0, -180], "r": 6, "z": [37, 40], "mat": "black", "lod": "f"},
              {"n": "Drip Shield", "shape": "box", "at": [-55, -200, 0, 55, -20, 12], "r": 25, "mat": "grey"}],
          "connectors": [{"n": "Power", "domain": "electrical", "system": "PowerBalanced", "part": "Back Plate", "side": "back"}],
          "values": {"Width 133 mm": V(133, "PURELL ES8 listing: 5 1/4 in"), "Depth 217 mm": V(217, "PURELL ES8 listing: 8 9/16 in"), "Height 308 mm": V(308, "PURELL ES8 listing: 12 1/8 in"),
                     "Capacity 1200 ml": V(1200, "PURELL ES8 listing"), "Mains option 10 VA": A(10, "standard ES8 runs on the refill's coin cell; mains only where specified")},
          "about": "Dispenser redrawn from the PURELL ES8 listing: back plate, rounded cover, fill window, drip shield, nozzle shroud with sensor."})

# Examination couch, 2-section, fixed height 700 (assumed product sizes; parts like a typical steel-frame couch)
couch = [
    {"n": "Leg", "shape": "box", "at": [-900, -290, 0, -860, -250, 640], "r": 6, "mat": "frame", "repeat": {"n": 2, "d": [1760, 0, 0]}},
    {"n": "Leg Back", "shape": "box", "at": [-900, 250, 0, -860, 290, 640], "r": 6, "mat": "frame", "repeat": {"n": 2, "d": [1760, 0, 0]}},
    {"n": "Foot", "shape": "cyl", "axis": "z", "c": [-880, -270], "r": 22, "z": [0, 15], "mat": "rubber", "lod": "f", "repeat": {"n": 2, "d": [1760, 0, 0]}},
    {"n": "Foot Back", "shape": "cyl", "axis": "z", "c": [-880, 270], "r": 22, "z": [0, 15], "mat": "rubber", "lod": "f", "repeat": {"n": 2, "d": [1760, 0, 0]}},
    {"n": "Low Rail", "shape": "box", "at": [-880, -280, 180, 880, -260, 200], "mat": "frame", "repeat": {"n": 2, "d": [0, 530, 0]}},
    {"n": "Top Frame", "shape": "box", "at": [-950, -310, 620, 950, 310, 650], "r": 10, "mat": "frame"},
    {"n": "Seat Cushion", "shape": "fbox", "at": [-950, -325, 650, 300, 325, 720], "r": 25, "mat": "vinyl"},
    {"n": "Back Rest", "shape": "right", "x": [300, 950], "pts": [[-325, 650], [325, 650], [325, 720], [-325, 720]], "mat": "vinyl", "lod": "m"},
    {"n": "Back Rest Raised", "shape": "front", "y": [-325, 325], "pts": [[300, 650], [360, 650], [950, 1000], [890, 1040]], "mat": "vinyl", "lod": "f"},
    {"n": "Paper Roll", "shape": "cyl", "axis": "x", "c": [0, 760], "r": 45, "x": [-1000, -960], "mat": "white", "lod": "f"},
    {"n": "Roll Bracket", "shape": "box", "at": [-990, -260, 620, -950, 260, 650], "mat": "frame", "lod": "f"},
]
P.append({"family": "FMC_I_MedEq_Couch_Examination", "category": "Medical Equipment", "desc": "Examination couch, 2 sections, 1900 x 650, fixed height 700, raised backrest, blue vinyl, white epoxy steel frame, paper-roll holder",
          "ifc": "IfcMedicalDevice", "keynote": KN.get("FMC_I_MedEq_Couch_Examination"), "types": [{"name": "1900x650_2Section"}],
          "materials": {"frame": "FMC_Metal_Steel_EpoxyCoated_White", "vinyl": "FMC_Fabric_Vinyl_Upholstery_Blue", "rubber": "FMC_Rubber_Black", "white": "FMC_Plastic_ABS_White"},
          "reference": {"brand": "typical (Plinth 2000 / Akron class)", "model": "2-section fixed-height examination couch", "images": "image search: two section examination couch blue vinyl"},
          "parts": couch,
          "clearances": [{"n": "Side Clearance", "shape": "box", "at": [-950, -1225, 0, 950, -325, 10], "sub": "Clearance Accessibility"}],
          "values": {"Top 1900 x 650 mm, 700 high": A("1900x650x700"), "Side clearance 900 mm": A(900, "HBN 00-03 basis")},
          "about": "Couch redrawn as a product: four legs with rubber feet, low rails, top frame, upholstered seat, raised backrest (Fine) or flat (Medium), paper-roll holder."})

# TPN distribution board, surface, white steel with glazed door (assumed sizes; Acti9 Isobar P class)
db = [
    {"n": "Enclosure", "shape": "box", "at": [-225, -140, 0, 225, 0, 650], "r": 6, "mat": "steel"},
    {"n": "Door", "shape": "fbox", "at": [-215, -150, 15, 215, -140, 635], "r": 6, "mat": "steel"},
    {"n": "Door Window", "shape": "fbox", "at": [-170, -151, 300, 170, -149, 560], "r": 4, "mat": "window", "lod": "f"},
    {"n": "Breaker Row", "shape": "fbox", "at": [-160, -152, 330 + 0, 160, -150, 380], "mat": "white", "lod": "f", "repeat": {"n": 3, "d": [0, 0, 70]}},
    {"n": "Main Switch", "shape": "fbox", "at": [-60, -153, 200, 60, -150, 280], "r": 4, "mat": "grey", "lod": "f"},
    {"n": "Main Switch Handle", "shape": "fbox", "at": [-15, -165, 225, 15, -153, 255], "r": 3, "mat": "red", "lod": "f"},
    {"n": "Handle", "shape": "fbox", "at": [185, -165, 290, 200, -150, 360], "r": 4, "mat": "black", "lod": "f"},
    {"n": "Gland Plate", "shape": "box", "at": [-180, -120, 650, 180, -20, 660], "mat": "grey"},
]
P.append({"family": "FMC_E_EQ_DB_Final_TPN", "category": "Electrical Equipment", "desc": "TPN distribution board, 12 ways per phase, 415 V, surface, white steel, glazed door, 100 A main switch",
          "ifc": "IfcElectricDistributionBoard", "keynote": KN.get("FMC_E_EQ_DB_Final_TPN"), "types": [{"name": "12Way_TPN"}],
          "type_values": {"Voltage": 415, "Number of Poles": 3, "Default Elevation": 1400},
          "materials": {"steel": "FMC_Metal_Steel_EpoxyCoated_White", "window": "FMC_Plastic_Polycarbonate_Clear", "white": "FMC_Plastic_ABS_White", "grey": "FMC_Plastic_ABS_Grey", "red": "FMC_Plastic_LED_Red", "black": "FMC_Plastic_ABS_Black"},
          "reference": {"brand": "Schneider Electric", "model": "Acti9 Isobar P SEA9BPN12 (12 way TPN, 100 A incomer)", "url": "https://sparksdirect.co.uk/schneider-12-way-250a-tpn-distribution-board-for-surface-mounting-ip3x-ik05-schneider-sea9bpn12-acti-9-isobar-p-b-no-incomer", "images": "image search: Schneider Acti9 Isobar P TPN 12 way"},
          "parts": db,
          "clearances": [{"n": "Working Space", "shape": "box", "at": [-225, -1150, -1400, 225, -150, 600], "sub": "Clearance Maintenance"}],
          "connectors": [{"n": "Supply", "domain": "electrical", "system": "PowerBalanced", "part": "Enclosure", "side": "top"}],
          "values": {"12 ways TPN, 100 A main switch": V("12way 100A", "Sparks Direct listing SEA9BPN12"), "Enclosure 450 x 650 x 150 mm": A("450x650x150", "size not published on the listing"),
                     "Working space 1000 mm": A(1000, "BS 7671 / practice")},
          "about": "Board redrawn as a product: steel enclosure, door with window, three rows of breakers, red main switch handle, door handle, gland plate."})

REFS = json.load(open(os.path.join(HERE, '..', 'hc_refs.json')))
def generic(prod):  # owner 17 Oct: no brand; reference photo + open brand/model; a datasheet stays only as the source of sizes
    old = prod.get('reference', {}); r = dict(REFS.get(prod['family'], {}))
    if old.get('url'): r['datasheet'] = old['url']
    prod['reference'] = r
    prod['about'] = prod['about'].replace(' redrawn from the', ' sized from a').replace(' redrawn as a product', ' modelled as a generic product')
    return prod
sock = json.load(open(os.path.join(HERE, 'FMC_E_ElecFixture_Socket_13A_Twin.product.json')))
P.append(sock)
out = []
for prod in map(generic, P):
    json.dump(prod, open(os.path.join(HERE, prod['family'] + '.product.json'), 'w'), indent=1)
    r = fp.compile_product(prod)
    json.dump(r, open(os.path.join(HERE, prod['family'] + '.recipe.json'), 'w'), indent=1)
    fp.render(prod, os.path.join(HERE, prod['family'] + '.preview.png'))
    out.append((prod['family'], len(r['ops'])))
print(out)
