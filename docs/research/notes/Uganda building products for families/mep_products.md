# MEP and Services Products in Ugandan Buildings (for parametric Revit family types)

Scope note: research run 2026-10-14, about 20 tool calls. Primary sources verified: the National Building (Standards for Electrical Installations in Buildings) Code 2019 (KCCA copy), the Roofings Group PVC catalogue (Uganda), the Dayliff/Davis & Shirtliff SWH datasheet, the Kentainers 2023/24 price list (Kenya), KCCA's onsite sanitation minimum standards, UNBS gazetted standards on tradebarriers.org, and press reports on the UEDCL handover. Many supplier sites (Crestanks, Gentex, Uganda Police fire requirements) gave no usable spec pages. **"Inferences"** in each section are marked as practice knowledge or assumptions and need a check against a supplier datasheet before they become kit data (CLAUDE.md rule 7: kit data comes from the kit).

## Electrical: accessories, distribution, metering, cables, conduit, luminaires, mounting heights, regulations

### Takeaway
Uganda's National Building (Standards for Electrical Installations in Buildings) Code 2019 is the governing document. It is written on IEE/BS 7671 lines and adopts IEC standards as "US IEC". It gives firm values for 240/415 V gear, BS 1363 shuttered switched sockets, mounting heights (DB lower edge 2000 mm, switches 1400 mm, sockets 300 mm), a 1.5 mm² minimum cable, 20 mm minimum conduit, a 4 mm² minimum earth conductor and earth electrode resistance below 8 Ω. UEDCL replaced Umeme on 31 March 2025, and the prepaid "Yaka" system became "UEDCL Light" with meters unchanged.

### Cited Findings
- The Code applies to installations up to 11,000 V a.c. from the public supply or private generation (para 2(a)). LV switchboards and control gear are rated 240 V/415 V (paras 10(1), 10(33)). The Code does not state the frequency. — [Electrical Code 2019, KCCA](https://www.kcca.go.ug/media/docs/The%20National%20Building%20(Standards%20for%20Electrical%20Installations%20In%20Buildings)%20Code,%202019.pdf)
- Single-phase socket outlets: "3 pin rectangular, shuttered" per US IEC 60884-2-5 / BS 1363 (para 19(4)). They must be the switched type unless approved otherwise (19(6)), and the earth pin must be effectively earthed (19(7)). Three-phase sockets are 4- or 5-pin "scraping earth" (19(5)). Switches follow US IEC 60669-1 (19(1)), ceiling roses US IEC 60423 (18(1)) and lampholders US IEC 61184 (18(2)). — [Electrical Code 2019](https://www.kcca.go.ug/media/docs/The%20National%20Building%20(Standards%20for%20Electrical%20Installations%20In%20Buildings)%20Code,%202019.pdf)
- Mounting heights (para 17):
  - switchgear, DBs and consumer units: **lower edge 2000 mm AFFL** (17(3));
  - light switches: **centre 1400 mm AFFL** (17(4));
  - isolators and switch-fuses: **1400 mm to underside** (17(5));
  - socket outlets in offices and corridors: **300 mm AFFL to underside** (17(6)).
  — [Electrical Code 2019](https://www.kcca.go.ug/media/docs/The%20National%20Building%20(Standards%20for%20Electrical%20Installations%20In%20Buildings)%20Code,%202019.pdf)
- Consumer unit definition: a DB with double-pole isolation of incoming circuits, complying with US IEC 60439 and US IEC 60898. RCD earth-fault protection is required, and MCBs/RCBOs follow US IEC 60898 (paras 3, 10(34)). Commercial buildings must provide for sub-metering to UNBS and ERA requirements (paras 5(9), 5(10)). — [Electrical Code 2019](https://www.kcca.go.ug/media/docs/The%20National%20Building%20(Standards%20for%20Electrical%20Installations%20In%20Buildings)%20Code,%202019.pdf)
- Cables:
  - minimum 1.5 mm², rated at least 240 V (14(3)); DC sockets minimum 2.5 mm² (22(1)); multicore minimum 2.5 mm² copper (23(5)); flex minimum 0.75 mm² (14(23));
  - cable standards: US 602/605, US IEC 60227, US IEC 60245, US IEC 60502-1 and US IEC 60228;
  - voltage drop to "IEE Wiring Regulations, current edition" (14(4)), meaning BS 7671.
  — [Electrical Code 2019](https://www.kcca.go.ug/media/docs/The%20National%20Building%20(Standards%20for%20Electrical%20Installations%20In%20Buildings)%20Code,%202019.pdf)
- Conduit: steel and under-floor conduit not less than 20 mm (16(1)(a), 59(3)); US IEC 61386; no more than two right-angle bends without a draw box (16(7)); at least 150 mm clear of gas pipes (16(9)). — [Electrical Code 2019](https://www.kcca.go.ug/media/docs/The%20National%20Building%20(Standards%20for%20Electrical%20Installations%20In%20Buildings)%20Code,%202019.pdf)
- Locally made uPVC conduit (Roofings): OD 20, 25, 32, 40 and 50 mm, in 4 m and 6 m lengths. Wall thickness is 0.8–0.9 mm light gauge and 1.2–1.3 mm heavy gauge for 20 mm, and 1.8–2.0 mm for 32–50 mm. Standard: UNBS US 264-2. — [Roofings PVC Catalogue](https://roofingsgroup.com/documents/Roofings-PVC-Catalogue.pdf)
- Earthing: earthing point next to the supply terminals (34(1)); earth continuity at most 1 Ω (34(6)); earth conductor at least 4 mm² (34(8)); earth electrode test result recommended "less than 8 ohms" (Schedule 2). — [Electrical Code 2019](https://www.kcca.go.ug/media/docs/The%20National%20Building%20(Standards%20for%20Electrical%20Installations%20In%20Buildings)%20Code,%202019.pdf)
- Street lighting follows BS 5649 (36(1)), and light fittings follow US IEC 60364 (65(1)). — [Electrical Code 2019](https://www.kcca.go.ug/media/docs/The%20National%20Building%20(Standards%20for%20Electrical%20Installations%20In%20Buildings)%20Code,%202019.pdf)
- ERA licensing: the Electricity (Installation Permits) Regulations 2003 govern installation permits, so wiremen must hold ERA permits. — [World Bank PPP library: Installation Permits Regulations 2003](https://ppp.worldbank.org/public-private-partnership/sites/default/files/2024-08/Uganda_THE%20ELECTRICITY%20%28INSTALLATION%20PERMITS%29%20REGULATIONS_2003_EN.pdf); [ERA Installation Permit Guidelines](https://ppp.worldbank.org/index.php/library/uganda-era-installation-permit-guidelines)
- UEDCL took over distribution from Umeme on 31 March 2025. Yaka was renamed **"UEDCL Light"**, with meter numbers and infrastructure unchanged and units still bought via MTN and Airtel. — [Pulse Uganda, 31 Mar 2025](https://www.pulse.ug/story/uecdl-renames-yaka-to-light-what-you-need-to-know-2025033109575781651); [Pulse Uganda, 26 Mar 2025](https://www.pulse.ug/story/heres-what-will-happen-to-your-yaka-when-umeme-hands-over-to-uedcl-2025032606110210319)
- About 2.2 million customers have upgraded Yaka meters, per a minister. — [Daily Monitor](https://www.monitor.co.ug/uganda/news/national/2-2m-customers-have-upgraded-yaka-metres-says-minister--4834634)

### Inferences
These are practice knowledge. They are not verified in this run and must be checked before they go into the kit.
- Supply: 240 V single-phase / 415 V three-phase at **50 Hz** (East African standard frequency; the Code does not state it).
- Accessory family types needed:
  - 13 A sockets (BS 1363): 1G and 2G, switched/unswitched, with or without neon, with USB (A/C);
  - switches (BS EN 60669-1): 1–4 gang, 1-way and 2-way, plus intermediate;
  - 45 A DP cooker control unit, with or without a 13 A socket;
  - 13 A switched/unswitched fused connection unit (FCU);
  - 20 A DP switch for water heaters; 32/63 A rotary isolators for AC and pumps.
  - All accessories use a standard UK single box (86×86 mm plate, 25–35 mm box depth) or a 146×86 mm twin box.
- Common brands in Kampala electrical shops (Nasser Road, Kikuubo area): Schneider (Clipsal), Legrand, MK (Honeywell), Hager, Chint, Tronic and Tenby. Treat this as market observation; I found no source.
- Distribution boards:
  - SPN consumer units of 4, 6, 8, 12 and 16 ways;
  - TPN DBs of 4, 6, 8 and 12 ways per phase;
  - MCB ratings 6, 10, 16, 20, 32, 40 and 63 A; 30 mA RCCB/RCBO.
- Typical BS 7671 circuit sizes:
  - lighting: 1.5 mm², 6/10 A;
  - socket radial: 2.5 mm² on 20 A, or 4 mm² on 32 A;
  - ring: 2.5 mm² on 32 A;
  - cooker: 6 mm² on 32/45 A;
  - water heater: 2.5 mm² on 20 A.
  - Cable is typically PVC single-core in conduit, or PVC/SWA/PVC for submains.
  - Local cable makers (Uganda Cables, Kenwest) are unverified here.
- Socket heights beyond the Code's office and corridor rule (300 mm): kitchen worktop sockets at about 1100–1200 mm, and accessible sockets at 450–1200 mm. The Code is silent on these, so they are assumptions.
- Luminaire family types:
  - 600×600 LED panel (36–48 W, recessed or surface);
  - LED batten 1200/1500 mm (18–40 W);
  - IP65 bulkhead (12–20 W);
  - round downlights (6–18 W, cut-out 75–200 mm);
  - LED floodlight (50–200 W);
  - LED street light (30–150 W on 6–10 m poles);
  - emergency bulkhead or exit sign (3 h).

### Gaps
- No Ugandan supplier datasheet confirmed which DB and accessory brands are sold locally.
- No UEDCL document giving meter enclosure dimensions or the required meter position. The Code does not specify a meter position. Single-phase Yaka/Light meters look like Conlog/Hexing/Inhemeter keypad units, but this is unverified.
- The Code gives no cable sizes for lighting, socket or cooker circuits beyond the minimums.
- The Code dates from 2019, so check whether it has been revised since.

## Solar: PV modules, hybrid inverters, LiFePO4 batteries, mounting, solar water heaters

### Takeaway
Davis & Shirtliff (Dayliff) sells flat-plate thermosyphon SWHs in 160/220/320 L sizes in East Africa, with 3 kW electric backup. Hybrid inverter and lithium battery retail in Kampala is established (Felicitysolar opened a Kampala Road store in 2025). I found no verified local module or inverter datasheets.

### Cited Findings
- Dayliff SWH range:
  - models SWD160S/L, SWD220S/L and SWD320S/L (160, 220 and 320 L tanks for about 5, 7 and 10 people);
  - open-loop thermosyphon with a copper full-area absorber (flat plate), tempered glass, a galvanised high-pressure tank with a magnesium anode, and PU/mineral-wool insulation;
  - 3/4" BSP inlet and outlet, max operating pressure 3.5 bar, tank test 5 bar, collector test 14 bar;
  - standard 3 kW electric booster; diverter limits water to 60 °C; 5-year guarantee.
  - The datasheet table was too garbled to extract dimensions.
  — [Dayliff SWH datasheet](https://www.dayliff.com/media/com_hikashop/upload/safe/dayliff_solar_water_heaters_800146681.pdf)
- Davis & Shirtliff partnered with Huawei to supply solar products (inverters, storage) in Uganda (Feb 2024). — [Eagle Online](https://eagle.co.ug/2024/02/23/davis-shirtliff-huawei-partner-to-provide-affordable-high-end-solar-products-in-uganda-for-clean-energy-transition)
- Felicitysolar's Kampala Road store sells inverters, lithium/gel batteries, panels and controllers (press release, 17 Mar 2025). No ratings were given. — [pv magazine](https://pv-magazine.com/press-releases/felicitysolar-lights-up-uganda-new-kampala-road-store-opens-to-empower-communities)
- The Electrical Code requires a short lightning rod at the highest point of a building that has PV (para 42(2)). — [Electrical Code 2019](https://www.kcca.go.ug/media/docs/The%20National%20Building%20(Standards%20for%20Electrical%20Installations%20In%20Buildings)%20Code,%202019.pdf)

### Inferences
These are market knowledge and assumptions. Verify each before use.
- PV module family types:
  - 400–460 W mono PERC/TOPCon, about 1722×1134×30 mm (108 half-cell);
  - 540–580 W, about 2278×1134×35 mm (144 half-cell);
  - 600–620 W, about 2382×1134×30 mm.
  - Brands seen in East Africa: Jinko, Longi, JA, Canadian Solar.
- Hybrid inverter types of 3, 5, 6, 8 and 10 kW (single phase, 48 V) and 12–30 kW (three phase). Brands: Deye, Growatt, Felicity, Must, Victron, Huawei SUN2000.
- Battery types: LiFePO4 48 V 100 Ah (5.12 kWh) and 200 Ah (10 kWh), wall-mount or rack 3U/4U, about 440×600×190 mm for 5 kWh (assumed).
- Mounting: aluminium rails 2.1/4.2 m on tin-roof L-feet or hooks (IBR/corrugated "mabati" or Roofings sheets), with mid/end clamps and 30–40 mm ground-mount tilt-frame steel. A tilt of 0–15° suits Uganda's latitude of about 0–4°.
- SWH sizes: evacuated-tube 150/200/250/300 L units (15–30 tubes, 58×1800 mm), mostly low-pressure Chinese imports, are common alongside flat-plate units.

### Gaps
- No Ugandan supplier datasheet with module or battery dimensions was retrieved.
- No UNBS PV standards list was obtained. They are likely US IEC 61215 / 61730 / 62109, but this is unverified.
- No D&S Uganda evacuated-tube product page was found.

## Lightning protection: air terminals, conductors, earth rods, test clamps, pits, SPDs; BS EN 62305 use

### Takeaway
The 2019 Electrical Code makes lightning protection mandatory for all buildings and names public types such as schools, churches, mosques, halls, hospitals and theatres. It specifies 20×3 mm copper or aluminium tape, copper-bonded earth rods and a maximum earth resistance of 10 Ω. NGOs (ACLENet) push IEC 62305-1 to -4 for school designs in Uganda. The 25×3 mm tape that is common under BS EN 62305 is larger than the Code's minimum, which is 20×3 mm.

### Cited Findings
- Lightning protection is required for all buildings, including schools, churches, mosques, halls, hospitals and theatres (para 35(1)):
  - conductors: copper or aluminium tape **20 mm × 3 mm** (35(2));
  - electrode: copper-bonded rod as close as possible to the installation (35(5));
  - resistance must "in no circumstances exceed **10 ohms**" (35(6)).
  — [Electrical Code 2019](https://www.kcca.go.ug/media/docs/The%20National%20Building%20(Standards%20for%20Electrical%20Installations%20In%20Buildings)%20Code,%202019.pdf)
- ACLENet works to get IEC 62305-1 to -4 adopted and enforced. It protects model Ugandan schools (a $99,908 grant for three schools), uses MoES standard school plans and is building standard design "templates" with locally sourced materials. — [ACLENet: lightning protection of schools](https://aclenet.org/programs/lightning-protection-of-schools/)
- A paper presented the Ugandan experience with lightning protection standards. — [VDE proceedings: "The power of standards… Uganda experience"](https://www.vde-verlag.de/proceedings-en/456416184.html)
- BS EN 62305 design context (UK reference): copper tape down conductors, test joints and earth termination. — [Power & Cables: BS EN 62305](https://www.powerandcables.com/bs-en-62305/)

### Inferences
- Family types needed:
  - air terminal (copper or aluminium rod, 16 mm Ø × 500–1000 mm, on a saddle or base);
  - roof conductor and down conductor tape. Use a **20×3 mm minimum (Code)** and a 25×3 mm option, since many specs follow BS EN 62305 at 25×3 mm.
  - DC tape clips and a test clamp (oblong, about 1.5 m above ground);
  - copper-bonded earth rod 16 mm Ø × 1.2/1.5/2.4 m;
  - rod-to-tape clamp;
  - inspection pit (concrete or polymer, about 300×300 mm, or a 250 mm round pit);
  - bonding to the main earthing terminal;
  - SPDs: Type 1+2 at the main DB and Type 2 at sub-DBs and the PV DC side.
  - All of these are assumptions from BS EN 62305 practice.
- Whether US IEC 62305 is formally gazetted by UNBS is unconfirmed (flag).

### Gaps
- No Ugandan supplier catalogue (for example Furse or local copper fabricators) was found.
- No UNBS confirmation of US IEC 62305 adoption.
- The SPD requirement is not in the parts of the Code extracted.

## Plumbing and water: tanks and stands, pipes, sanitary ware, pumps, heaters, septic and soakaways, manholes, rainwater harvesting, NWSC

### Takeaway
Crestanks, a Ugandan company in the AquaSanTec group, makes rotomoulded tanks from 50 to 24,000 L, including "wide and short" 3,000/6,000/10,000 L models, loft tanks and 2–4.3 m³ "Septank" septic tanks. Its dimensions are not published online, so the Kentainers (Kenya) dimension table is the best verified proxy. Roofings (Uganda) publishes full uPVC, HDPE PE100 and PPR size tables to UNBS US 264/US 482.

### Cited Findings
- Crestanks:
  - tanks 50–24,000 L for on-ground or tower use; "wide and short" 3,000, 6,000 and 10,000 L models;
  - loft tanks; Septanks (vertical or horizontal, 2–4.3 m³); Permawell LLDPE well liners; gutters;
  - roto-moulded virgin food-grade PE with 2.3% carbon black, claimed 30-year life;
  - in the AquaSanTec group since 1991/1994.
  — [Construction Review: Crestanks](https://constructionreviewonline.com/crestanks/)
- Uganda Baati partnered with Crestanks to promote rainwater harvesting. — [Publicist East Africa](https://publicisteastafrica.com/?p=9520)
- Kentainers CCV vertical tanks (Kenya, effective 1 Mar 2023, H × Ø in cm) are a **proxy for Ugandan tank dimensions**:

  | Capacity | H × Ø (cm) |
  |---|---|
  | 1,000 L | 127×107 |
  | 1,500 L | 142×124 |
  | 2,000 L | 161×135 |
  | 2,300 L | 165×144 |
  | 2,500 L | 169×148 |
  | 3,000 L | 195×155 |
  | 6,000 L | 223×198 |
  | 8,000 L | 248×214 |
  | 10,000 L | 255×232 |
  | 16,000 L | 280×285 |

  Also: NST 1,000 L at 106×113; loft tank LR 920 L at 74 high; underground BKT 2,000 L at 141×150 and BKT 6,000 L at 265×179. Septic SPT 2,000–6,000 L also exist, but their data was garbled.
  — [Kentainers price list (Kenya)](https://www.unsacco.org/wp-content/uploads/2022/10/KENTAINERS-ZONAL-KENTANK-PRICELIST-MARCH-2024.pdf)
- Roofings uPVC pipe:
  - pressure and SWR pipe PN 2.5, 4, 6, 10 and 16; OD 25–400 mm (25, 32, 40, 50, 63, 75, 82, 90, 110, 125, 160, 200, 250, 315, 400 among others); 6 m lengths;
  - Schedule 40 uPVC ½"–2" (OD 21.34–60.32 mm);
  - borehole casing OD 114, 140 and 168 mm.
  — [Roofings PVC Catalogue](https://roofingsgroup.com/documents/Roofings-PVC-Catalogue.pdf)
- Roofings HDPE PE100: OD 20–200 mm at PN 6/10/16/20. Coils of 100 m for 20–110 mm; 6/12 m lengths for 125–200 mm. Fittings 20–110 mm. — [Roofings PVC Catalogue](https://roofingsgroup.com/documents/Roofings-PVC-Catalogue.pdf)
- Roofings PPR: OD 20, 25, 32, 40 and 50 mm at PN 10/16/20/25 in 4 m lengths. Example walls: 20 mm is 1.9/2.8/3.4/4.1 mm and 50 mm is 4.6/6.9/8.3/10.1 mm. Adaptors 20 mm × ½" to 50 mm × 1½". — [Roofings PVC Catalogue](https://roofingsgroup.com/documents/Roofings-PVC-Catalogue.pdf)
- Standards: UNBS US 264:2001 (uPVC pipes), US 264-2 (conduit), US 482:2002 (HDPE); ISO 161/1, DIN 8061/8062/8074 and ASTM D1785. — [Roofings PVC Catalogue](https://roofingsgroup.com/documents/Roofings-PVC-Catalogue.pdf)
- KCCA onsite sanitation minimum standards (Kampala):
  - 1 stance per 40 users for institutional bio-latrines; 1 per 100 daily users in public places;
  - 1 shower per 20 boarders;
  - handwashing 1 point per 40 students, under 5 m from toilets, basin at least 500×400 mm;
  - a raised water tank of at least 2,500 L for public toilets;
  - flush water 10 L/person/day (pour-flush 1.5);
  - a separate washroom for adolescent girls;
  - a school incinerator with a chimney at least 1.5 m high, at least 600 °C, at least 30 m from buildings.
  — [KCCA Minimum Standards for Onsite Sanitation, 2nd ed.](https://www.kcca.go.ug/media/docs/FINAL-%20MINIMUM%20STANDARDS%20-%20SECOND%20EDITION.pdf)
- New Ugandan school projects still pair classroom blocks with VIP latrines (for example, Ntungamo: 35 classroom blocks and 50 VIP latrines, Feb 2026). — [AllAfrica](https://allafrica.com/stories/202602260066.html)
- Hot water: the Dayliff SWH 3 kW booster is above. — [Dayliff](https://www.dayliff.com/media/com_hikashop/upload/safe/dayliff_solar_water_heaters_800146681.pdf)

### Inferences
These are practice knowledge and assumptions.
- Tank family: make it parametric on capacity → H/Ø, using the Kentainers table until the Crestanks/Gentex/Polytanks datasheets are obtained. Stands: steel or masonry towers at 3, 6 and 9 m, with a platform about 300 mm larger than Ø.
- Sanitary ware:
  - close-coupled WC (about 650–700 L × 360 W × 780 H mm, 80–110 mm outlet);
  - ceramic squat pan (about 600×450 mm) in schools and public toilets, often with a pour-flush trap;
  - wall-hung or pedestal basin (500–600 mm);
  - single or double stainless sink (1000/1200 × 500 mm);
  - bowl or slab urinal (urinal channels in schools);
  - shower tray or floor trap.
  - Brands: Twyford, Roca, Vitra and Chinese imports.
- Pumps: Pedrollo PKm60 (0.37 kW) and CPm (0.5–0.75 kW); DAB booster sets; Grundfos SCALA2 (0.55 kW) and CM; pressure vessels 24–100 L. Davis & Shirtliff is the main Grundfos/Pedrollo/Dayliff distributor in Uganda (unverified here).
- Electric water heaters: 50/80/100 L horizontal or vertical, 1.5–3 kW.
- Drainage:
  - uPVC 110 mm soil, 50 mm waste, 160 mm sewer;
  - inspection chambers 450×450/600×450 mm brick or concrete with a cast-iron or concrete cover; 600×600 mm and deeper manholes;
  - septic tank sized from users (or a Crestanks Septank 2–4.3 m³), discharging to a soakaway pit of about 2–3 m Ø × 3 m.
- NWSC connection: a ½"–¾" meter in a meter box at the plot boundary is typical (unverified).

### Gaps
- No Crestanks or Gentex dimension tables online. Ask the suppliers directly.
- NWSC connection, meter box and backflow requirements were not found.
- MoES WASH in Schools Standards (2016) not retrieved. It would give pupil-to-stance ratios. A common figure of 1:40 boys and 1:25 girls is unverified.
- No sanitary-ware supplier catalogue specific to Uganda was retrieved.

## Fire: extinguishers, hose reels, fire alarm, signage, Uganda Police Fire Prevention requirements

### Takeaway
UNBS has gazetted fire-hose standards (for example US ISO 4642-1:2009 semi-rigid reel hose, 19/25/33 mm, gazetted 2015). I found no accessible primary text of Uganda Police Fire Prevention and Rescue Services (FPRS) building requirements or of a national fire code with extinguisher scales.

### Cited Findings
- US ISO 4642-1:2009 (semi-rigid hoses for fixed systems, i.e. hose reels) was gazetted on 21 April 2015. Max working pressure is 1.2 MPa for 19 and 25 mm ID and 0.7 MPa for 33 mm; use range −20 to +60 °C. — [Tradebarriers.org NTM 5436](https://www.tradebarriers.org/ntm/measures/view/5436)
- UNBS also lists US ISO 14557:2002 (fire-fighting suction hoses). — [Tradebarriers.org](https://tradebarriers.org/ntm/regulations/view/1326)
- Media reports after school fires (Budo, Makerere) describe weak enforcement and gaps in hydrant coverage. — [The Independent: Budo fire lessons](https://independent.co.ug/budo-fire-what-are-the-lessons); [Daily Monitor: Mak fire](https://www.monitor.co.ug/uganda/special-reports/mak-fire-casts-doubt-on-uganda-s-rescue-services-2441240)

### Inferences
These are practice knowledge and assumptions.
- Extinguisher types: DCP (ABC) 1, 2, 6 and 9 kg (6 kg is about 500 H × 160 Ø mm, 9 kg about 580 H × 180 Ø mm); CO₂ 2 and 5 kg near DBs and server rooms; AFFF foam 6/9 L; wet chemical for kitchens; fire blanket. Wall bracket with the handle at about 1000–1100 mm; 1 per about 200 m² and travel distance of 30 m or less (BS 5306-8 practice).
- Hose reel: 19 or 25 mm × 30 m, swinging or recessed cabinet (about 800×800×250 mm), on a 25 mm riser or tank-fed booster.
- Fire alarm (BS 5839-1 practice): break-glass MCP at 1400 mm, optical smoke and heat detectors, sounder/beacon, conventional or addressable panel.
- Signage: photoluminescent BS 5499 / ISO 7010 signs.
- Uganda FPRS inspects and issues fire safety certificates for occupancy. The detailed scales are unverified.

### Gaps
- Uganda Police FPRS building requirements were not found online.
- Whether the National Building Code 2019 suite includes a fire code is unconfirmed. KCCA hosts the electrical code, but no fire code was found in this run.

## HVAC: split AC, ceiling fans, extract fans

### Takeaway
No Uganda-specific primary sources were found in this run. The family sizes below rest on general market knowledge only.

### Cited Findings
- None retrieved in this run.

### Inferences
- Split AC types: 9k, 12k, 18k, 24k and 36k BTU/h (2.6, 3.5, 5.3, 7.0 and 10.6 kW) wall-mounted; cassette and ducted units of 36–60k. Brands: LG, Samsung, Midea, Hisense, Gree, Daikin. Indoor wall unit about 800–1100 W × 290–330 H mm, mounted at 2100–2400 mm.
- Ceiling fans: 48"/56" (1200/1400 mm) sweep, 60–75 W.
- Extract fans: 100/150 mm axial, wall or window type, for toilets and kitchens.

### Gaps
- No local distributor datasheets.
- No Uganda energy-efficiency labelling requirement was found.

## Landscape: Kampala plant species, cabro paving 60/80 mm, kerbs

### Takeaway
Searches returned Kenyan cabro suppliers only. No Ugandan paving or plant sources were verified in this run.

### Cited Findings
- Kenyan "cabro" paving terminology and suppliers (Capital Blocks, Nairobi). These are East African, not Ugandan. — [Capital Blocks: cabro blocks](https://capitalblocks.com/cabro-blocks/)

### Inferences
- Paving: interlocking concrete blocks (cabro) 200×100 mm or zig-zag, 60 mm for pedestrian areas and 80 mm for vehicles (100 mm for heavy traffic), on 30–50 mm sand over hardcore.
- Kerbs: precast 125×250(300)×1000 mm road kerb, 50×150×1000 mm edging and channel kerbs. Uganda suppliers are said to include Tororo Cement and local block makers (unverified).
- Common Kampala landscaping plants (unverified): Paspalum and Kikuyu grass; bougainvillea; Duranta; Ixora; Croton; Dracaena; Ficus benjamina; Royal and Christmas palms; Terminalia mantaly and Markhamia lutea (Nsambya) as street trees; Delonix regia; Jacaranda; Spathodea (Nile tulip).

### Gaps
- No Ugandan paving supplier datasheet was found.
- KCCA street-tree and landscaping specs were not found.
- The plant list needs a local horticulture or KCCA source.
