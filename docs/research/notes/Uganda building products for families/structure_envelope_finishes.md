# Uganda building products: structure, envelope and finishes (for parametric Revit families and system types)

Scope note: research run 2026-10-14, about 24 tool calls. Primary sources found: the Roofings Group product catalogue, the Building Control Regulations 2020 (SI 2020 No. 3), the National Building (Structural Design) Code 2019, the Building Control (Accessibility Standards for Persons with Disabilities) Code 2019 (SI 2019 No. 52), and UN-Habitat's ISSB guide (2009). Several needed sources were not reachable or had no numbers: the National Building Code's architectural or general part, the Uganda Baati catalogue, the Steel & Tube size tables, the MoWT road and drainage manuals, and UNBS block and tile standards. Everything under "Inferences" is an assumption based on common East African/BS practice and must be checked against a supplier or BoQ before it becomes kit data (CLAUDE.md rule 7: kit data comes from the kit).

## Walling: blocks, bricks, ISSB, stone, plaster

### Takeaway
Of the walling units, only the burnt clay brick (200x100x100 mm) and the ISSB (265x140x100 mm) have published Uganda-specific sizes. The 450x225 mm concrete block face and the 100/150/200 mm widths are standard local practice, but no Ugandan primary source was found for them, so they are flagged as assumptions.

### Cited Findings
- Burned clay brick in Uganda: 20 x 10 x 10 cm, 4-5 kg, wet compressive strength 0.5-6 (stated as "mps", most likely MPa). — [UN-Habitat, ISSB: Appropriate earth technologies in Uganda, 2009, p.10](https://unhabitat.org/interlocking-stabilised-soil-blocks-appropriate-earth-technologies-in-uganda)
- ISSB: 26.5 x 14 x 10 cm, 8-10 kg, 1-4 MPa wet. A "stabilised soil block" is 29 x 14 x 11.5 cm. A concrete masonry unit is quoted as 40 x 20 x 20 cm (a generic figure, not Uganda-specific). — [UN-Habitat 2009, p.10](https://unhabitat.org/interlocking-stabilised-soil-blocks-appropriate-earth-technologies-in-uganda)
- ISSB production: a manual machine made in Kenya, about 140 kg, produces 400-600 blocks per day. One 50 kg bag of cement yields about 130 blocks. The cement ratio is set by a shrinkage test, not a fixed figure. A "No.2 type" machine makes wider blocks. — [UN-Habitat 2009, pp.6-9, 19](https://unhabitat.org/interlocking-stabilised-soil-blocks-appropriate-earth-technologies-in-uganda)
- Burnt brick walls use mortar joints of up to 3 cm plus plaster. Kilns fire about 20,000 bricks with about 20% waste. — [UN-Habitat 2009, p.12](https://unhabitat.org/interlocking-stabilised-soil-blocks-appropriate-earth-technologies-in-uganda)
- The Structural Design Code 2019 has a Part VII on masonry (cl.70-74: clay bricks, concrete blocks, stabilised soil blocks, natural stone), but that body text was missing from the copy fetched. It defines a "block" as larger than a brick. — [National Building (Structural Design) Code 2019, NBRB](https://nbrb.go.ug/wp-content/uploads/2022/01/Buidling-Structural-Design.pdf)
- Regulatory definitions: a wall is longer than 4x its thickness, and a column's width is at most 4x its thickness. — [Building Control Regulations 2020, reg.2](https://www.kcca.go.ug/media/docs/The%20Buildings%20Control%20Regulations%202020%203.pdf)

### Inferences
- ASSUMPTION (common Ugandan/East African BoQ practice, not verified here): concrete blocks have a 450 x 225 mm face (440 x 215 mm actual plus a 10 mm joint) in thicknesses of 100, 150 and 200 mm, solid or hollow, with 225/230 mm also seen. Proposed Revit wall types are 100/150/200 block, each plus a plaster finish.
- ASSUMPTION: burnt brick walls are built as half-brick (about 100 mm) and one-brick (about 200-230 mm, often called "9-inch"). Hand-made bricks vary a lot, so model the nominal size and expect field variation.
- ASSUMPTION: internal plaster is 12-15 mm and external render 15-20 mm, usually cement:sand 1:4 to 1:6. Model the plaster as a finish layer (for example "Plaster 15") rather than baking it into the core.
- ISSB walls are about 140 mm thick (one block width), based on the 14 cm block width above.
- Stone: dressed local stone (for example from the Mubende and Masaka areas) is used for plinths and feature walls. No sizes were found.

### Gaps
- No UNBS (US) standard number or size table was found for concrete blocks or clay bricks. Candidates are the US/EAS standards for precast concrete masonry units; check the UNBS catalogue.
- No Ugandan manufacturer catalogue for blocks was found, and no source gave standard plaster thicknesses.
- No curved or half ISSB sizes were found.

## Roofing: sheets, tiles, rainwater goods, trusses, insulation

### Takeaway
The Roofings Group catalogue gives precise profile geometry (cover width, pitch, depth, thickness 0.20-0.60 mm), which is enough to build roof types. Uganda Baati (Safal Group) profiles are only partly documented; the one confirmed is Orientile, 1130 mm overall. Sources sell by thickness in mm, while the market still speaks in gauges (28 = 0.32 mm, 26 = 0.40 mm, per Roofings).

### Cited Findings
- Roofings profiles (cover width / pitch / depth / thickness / length):
  - Super Eco: 814 mm / 203.5 / 22 mm / 0.25-0.60 mm / 1.2-12 m.
  - Super V: 700 mm cover (784 overall) / 175 / 37 mm / 0.40-0.60 mm.
  - Super VI: 830 mm / 171.5 / 37 mm / 0.32-0.60 mm.
  - Super VII: 1045 mm / 209 / 22.5 mm / 0.25-0.60 mm.
  - Super Tile: 925 mm cover, tile step 300 mm (the drawing also shows 185), 0.32 mm (G28) or 0.40 mm (G26), lengths 1.2-8 m.
  - Eco Tile: 940/925 mm cover.
  - Ordinary/round corrugation: 765 mm cover, 76.2 mm pitch, 16.5 mm depth, 0.20-0.50 mm.
  - A 7-corrugation version: 918 mm cover, 153 pitch, 32 mm depth.
  — [Roofings Product Catalogue](https://roofingsgroup.com/documents/Roofings-Product-Catalogue.pdf)
- Self-weight is 2.15 / 2.76 / 3.38 / 4.54 / 5.02 kg/m at 0.25 / 0.32 / 0.40 / 0.50 / 0.60 mm (Super Eco and Round Corrugation). Load tables cover spans of 1.25-3.5 m. — [Roofings Catalogue](https://roofingsgroup.com/documents/Roofings-Product-Catalogue.pdf)
- Coatings: AZ (55% Al-Zn) 70-150 g/m², AZ85 class. Standards cited: EAS 410, US 540:2006, US EAS 468:2013 (pre-painted). The catalogue also mentions 100x50x2 mm steel purlins for tiles. — [Roofings Catalogue](https://roofingsgroup.com/documents/Roofings-Product-Catalogue.pdf)
- US EAS 11:2013 (galvanized plain and corrugated steel sheets) is a notified Uganda standard. — [TradeBarriers.org](https://tradebarriers.org/ntm/regulations/view/2001)
- Uganda Baati's Orientile is 1130 mm overall, which the source calls the widest steel roof profile in Uganda. It has a Zn-Al coating and comes in Brick Red, Charcoal, Potters Clay, Chocolate and Tile Red (2025). — [Pulse Uganda, Aug 2025](https://www.pulse.ug/story/uganda-baati-launches-crown-your-home-with-orientile-campaign-2025082010571385043)
- Uganda Baati launched a stone-coated steel tile called "Lifestile". — [SteelRadar](https://steelradar.com/en/haber/uganda-baati-limited-has-unveiled-cutting-edge-stone-coated-steel-roof-tiles-under-the-brand-name-lifestile)
- Uganda Baati is a member of the Safal Group. — [Publicist East Africa](https://publicisteastafrica.com/tag/ian-rumanyika/)
- Steel & Tube Industries (STIL) makes GI sheets, tile sheets, pre-painted sheets, ridges, valleys and end covers, fascia boards, Z-purlins, hollow sections and wire products. No sizes were published. — [Construction Review](https://constructionreviewonline.com/company-reviews/steel-and-tube-industries-limited)
- Aggregator figures (low reliability): CGI sheets are 750-900 mm wide, in 8/10/12 ft lengths, gauge 26/28 typical, with trusses at about 1.2 m. The source contradicts itself. — [autodesk "exchange" aggregator page](https://origin-exchange.autodesk.com/standard-size-of-iron-sheets-in-uganda)
- Roofings accessories: aluminium foil 1250 mm x 40 m (reflective insulation/sarking). — [Roofings Catalogue](https://roofingsgroup.com/documents/Roofings-Product-Catalogue.pdf)

### Inferences
- Revit roof types: one type per profile and thickness, plus a type parameter for cover width so that sheet counts schedule correctly. Name the gauge as text (G28/G30/G32) but drive it from the mm thickness. The gauge-to-mm map for G30 and G32 is an ASSUMPTION (about 0.28-0.30 mm and 0.22-0.25 mm in local trade usage); only G28 and G26 are verified.
- "IT4"/"IT5" box-rib profile names are Kenyan/Mabati trade names. Roofings uses "Super V/VI/VII" instead; Uganda Baati names were not verified. Use the manufacturer's own names.
- ASSUMPTION: timber trusses use treated pine or cypress at 50x100 and 50x150 mm (rafters, ties) and 50x75 mm (battens/purlins), at about 900-1200 mm centres. Steel options are Z/C purlins (the Roofings 100x50x2 is verified) and light hollow-section trusses.
- ASSUMPTION: PVC/steel gutters are about 100-150 mm half-round or box, with downpipes of about 75-100 mm. Fascia boards are about 25x200-250 mm timber or a steel fascia.
- ASSUMPTION: clay roof tiles (for example from Uganda Clays Ltd, Kajjansi) are used at higher-end sites. No size data was found.

### Gaps
- No Uganda Baati full catalogue (profile names, cover widths) was found; the site could not be fetched.
- No ridge cap, gutter or downpipe sizes were found. The Roofings catalogue pages were image-only.
- No sourced timber truss sizes or treatment standard (for example a US standard for treated timber) was found.
- Clay tile sizes from Uganda Clays were not researched within the call budget.

## Structure: RC sizes, rebar, steel sections, concrete grades, foundations

### Takeaway
The Structural Design Code 2019 sets these values:
- foundation concrete C20/25 if reinforced (C12/15 if plain)
- 50 mm cover to foundation steel
- foundations at least 1.0 m deep
- rebar to US EAS 412-1/-2, with yield at or above 500 MPa now the market norm.

Typical low-rise member sizes are practice assumptions; the code leaves member sizing to design.

### Cited Findings
- Foundations: C12/15 unreinforced and C20/25 reinforced (cl.17(6)); minimum cover to foundation reinforcement 50 mm (cl.17(7)); minimum foundation depth 1.0 m (cl.17(2)); unreinforced footing depth at least 300 mm (cl.18(1)). Clauses cover isolated, strip, raft and pile foundations (cl.17-21). — [National Building (Structural Design) Code 2019](https://nbrb.go.ug/wp-content/uploads/2022/01/Buidling-Structural-Design.pdf)
- Material standards: cement US 310-1:2016; ribbed bars US EAS 412-2:2013; plain bars US EAS 412-1:2013; structural steel US ISO 630-2:2011; steel grades 43, 50 and 55 (cl.22, 30). — [Structural Design Code 2019](https://nbrb.go.ug/wp-content/uploads/2022/01/Buidling-Structural-Design.pdf)
- Columns: steel 0.4-6% of gross area (cl.27(9)). Beams: minimum tension steel 0.0020bh at fy460 (cl.26(9)). Deflection at most span/360 or 20 mm (cl.26(6)). Reinforced walls: 0.4-4% vertical steel. Rib spacing at most 1.5 m. — [Structural Design Code 2019](https://nbrb.go.ug/wp-content/uploads/2022/01/Buidling-Structural-Design.pdf)
- The code text is internally inconsistent: the title says 2019 while clause 1 says "2018", and its schedules (loads, mixes) were not in the fetched copy. — [Structural Design Code 2019](https://nbrb.go.ug/wp-content/uploads/2022/01/Buidling-Structural-Design.pdf)
- Market rebar: Y10/Y12 samples from Ugandan hardware stores all exceeded 500 MPa yield under US EAS 412-2:2022. Some failed the 1.15 tensile-to-yield ratio. — [Agaba, Kyambogo Univ. 2024](https://kyuspace.kyu.ac.ug/items/4db8932b-1fac-4377-82a5-a4751f8953f1/full)
- Roofings hollow sections: square 16x16 up to 60x60 mm, walls 1.2-3.0 mm. Coils are 0.15-0.80 mm with yield 250-700 MPa. — [Roofings Catalogue](https://roofingsgroup.com/documents/Roofings-Product-Catalogue.pdf)
- STIL: round, square and rectangular hollow sections, mild steel plates, Z-purlins, ribbed BRC mesh. — [Construction Review](https://constructionreviewonline.com/company-reviews/steel-and-tube-industries-limited)
- Excavations deeper than 2 m need a permit and an engineer's design. Foundations in rock go at least 300 mm into rock, or the footing thickness if greater. — [Building Control Regulations 2020, reg.14](https://www.kcca.go.ug/media/docs/The%20Buildings%20Control%20Regulations%202020%203.pdf)

### Inferences
- ASSUMPTION (low-rise practice): columns 200x200 to 230x230 mm (one storey) and 230x300 to 300x300 mm (2-4 storeys); ring/lintel beams 200x200 to 230x230 mm; floor beams 230x450 mm; slabs 150 mm; strip footings 600 wide x 200-250 deep. These are suitable as type-catalog starting values only. Professionals size members (CLAUDE.md rule 5).
- Rebar family/type list: Y8, Y10, Y12, Y16, Y20, Y25, Y32 high-yield (B500 class) and R6/R8 plain for links. This is an ASSUMPTION drawn from BS 4449/EAS practice; only Y10 and Y12 market presence is verified here.
- Concrete grades for materials: C20/25 (code minimum for reinforced foundations) and C25/30 (common for frames, ASSUMPTION). The "Class 20/25" naming suggests EN 206/Eurocode notation.
- Steel sections: imported hot-rolled UB/UC/PFC/angles to BS/EN sizes dominate (ASSUMPTION). Local mills make light hollow sections and cold-formed purlins.

### Gaps
- Cement producers: Hima Cement (plants at Kasese and Tororo, 2018) is owned by Sarrai Group (70%) and Rwimi Holdings (30%) since March 2024 ([Wikipedia](https://en.wikipedia.org/wiki/Hima_Cement_Limited)). No product strength classes (32.5/42.5) were sourced, and Tororo Cement and Kampala Cement (KCCL) were not checked.
- Kiboko (Kiboko Enterprises, steel/rebar/roofing) was not verified in this run.
- Steel section tables (channels, I-beams) from Ugandan mills were not found; Roofings' rebar and open-profile pages were image-only.

## Floors, finishes and ceilings

### Takeaway
Little sourced data was found. Ceiling types in Ugandan use are documented (soft board/celotex said to be "most common", plus gypsum, papyrus, reed, bamboo and sisal), but no tile, terrazzo, screed or PVC panel sizes come from Ugandan sources.

### Cited Findings
- The ceiling types used in Uganda are reed, papyrus mat, bamboo, sisal mat, soft board and gypsum. Soft board is described as the most commonly used because it is affordable. Gypsum is the most expensive (2017 prices). — [Daily Monitor, Homes & Property](https://www.monitor.co.ug/uganda/magazines/homes-and-property/alternatives-to-concrete-ceilings-1696432)
- Knauf (via its Tanzania site) markets PVC-laminated gypsum ceiling tiles in East Africa. — [Knauf TZ](https://knauf.com/en-TZ/p/product/pvc-laminated-gypsum-tile-25004_0731)
- Accessibility code: level changes at thresholds at most 5 mm; floor openings at most 13 mm. — [Accessibility Code 2019, cl.9](https://www.kcca.go.ug/media/docs/The%20Building%20Control%20(Accessibilty%20Standards%20For%20Persons%20with%20Disabilities)%20Code,%202019.pdf)

### Inferences
- ASSUMPTION (market practice): ceramic/porcelain floor tiles are 300x300, 400x400, 600x600 and 600x1200 mm, with wall tiles 250x400 and 300x600 mm; sand-cement screed is 25-50 mm; terrazzo is about 15-20 mm on screed; skirtings are 100 mm tile or 100-150 mm timber/PVC.
- ASSUMPTION: PVC ceiling strips are about 200-250 mm wide x 5.95/6 m long x 7-9 mm thick on timber or steel brandering. Gypsum board is 9-12.5 mm, 1200x2400 mm. Celotex/soft board is 12 mm, 1200x2400 mm. T&G timber is about 12-19 x 100 mm. Model each as a ceiling type with a 25-50 mm batten layer.
- ASSUMPTION: cabro (interlocking) pavers are 60 mm (pedestrian) and 80 mm (vehicular) on a 25-50 mm sand bed.

### Gaps
- No supplier data was found for tiles (local importers, plus Twyford Uganda as a possible manufacturer, not verified), PVC ceilings or cabro in Uganda.
- No floor finish standards were found.

## Stairs and balustrades: National Building Code 2019 rules

### Takeaway
The "National Building Code 2019" is a set of statutory instrument codes under s.46 of the Building Control Act 2013. The Accessibility Code 2019 gives the hard stair and handrail figures found here: riser at most 170 mm, width at least 900 mm, flight rise at most 1530 mm, and handrails at about 870/900-1000 mm. No going minimum or general balustrade height (for example 900/1100 mm) was found.

### Cited Findings
- Building Control Regulations 2020 define the "Code" as the "National Building Code, 2019 issued under Section 46 of the Act". The regulations themselves contain no room-height, door or stair dimensions. — [Building Control Regulations 2020](https://www.kcca.go.ug/media/docs/The%20Buildings%20Control%20Regulations%202020%203.pdf)
- Stairs: width at least 900 mm (13(1)(a)); landing between flights in line at least 1100 mm (13(1)(b)); riser at most 170 mm and uniform per flight (13(1)(c)); maximum flight rise 1530 mm (13(1)(f)); nosing at least 40x40 mm (13(2)); tactile marking at top and bottom. Going is not specified. — [Accessibility Code 2019 (SI 2019 No.52)](https://www.kcca.go.ug/media/docs/The%20Building%20Control%20(Accessibilty%20Standards%20For%20Persons%20with%20Disabilities)%20Code,%202019.pdf)
- Handrails:
  - grip elliptical 50x40 or round 30-50 mm (14(1)(b))
  - height above the nosing given as "170-1000 mm" (14(1)(c))
  - wall clearance at least 50 mm (14(1)(h))
  - 300 mm extensions top and bottom
  - intermediate rails on stairs wider than 2400 mm
  - a balustrade higher than the handrail requires both
  — [Accessibility Code 2019](https://www.kcca.go.ug/media/docs/The%20Building%20Control%20(Accessibilty%20Standards%20For%20Persons%20with%20Disabilities)%20Code,%202019.pdf)
- Ramps: 1:20-1:12, clear width at least 1100 mm, landings at least 1500 mm, total rise at most 3600 mm. Kerb cuts at most 1:10. — [Accessibility Code 2019](https://www.kcca.go.ug/media/docs/The%20Building%20Control%20(Accessibilty%20Standards%20For%20Persons%20with%20Disabilities)%20Code,%202019.pdf)
- Doors and circulation: door clear opening at least 900 mm; accessible route at least 1200 mm; turning circle 1500 mm; headroom at least 2000 mm (1980 mm in doorways); handles at most 1000 mm. — [Accessibility Code 2019](https://www.kcca.go.ug/media/docs/The%20Building%20Control%20(Accessibilty%20Standards%20For%20Persons%20with%20Disabilities)%20Code,%202019.pdf)
- Other: accessible WC at least 1900x2300 mm; lift car at least 1100x1400 mm; switches 900-1200 mm above the floor. — [Accessibility Code 2019](https://www.kcca.go.ug/media/docs/The%20Building%20Control%20(Accessibilty%20Standards%20For%20Persons%20with%20Disabilities)%20Code,%202019.pdf)
- The Structural Design Code treats stairs as floor slabs for imposed load (cl.24(2)). — [Structural Design Code 2019](https://nbrb.go.ug/wp-content/uploads/2022/01/Buidling-Structural-Design.pdf)
- A companion National Building (Standards for Electrical Installations in Buildings) Code 2019 exists. — [KCCA](https://www.kcca.go.ug/media/docs/The%20National%20Building%20(Standards%20for%20Electrical%20Installations%20In%20Buildings)%20Code,%202019.pdf)

### Inferences
- The "170-1000 mm" handrail height is almost certainly an OCR or drafting error for 870-1000 mm (lift handrails in the same code are 870-1000 mm). Read the original before encoding it.
- The 900 mm door width in the Accessibility Code applies to accessible doors, not every door. Domestic internal doors in practice are 750-900 mm leaves (ASSUMPTION).
- ASSUMPTION (BS 5395/Approved Document K practice, widely used in Uganda): going at least 250 mm, 2R+G 550-700 mm, guarding 900 mm (dwellings) and 1100 mm (public/balconies), and no 100 mm sphere passing through. Stainless/MS balustrades are typically 900-1100 mm high with 50 mm round handrails.

### Gaps
- No general National Building Code part (room heights, minimum room areas, ventilation/window percentages, guard heights, going) was found online. It may exist as a separate SI, for example a "Building Code (General Requirements)", or within schedules not online. Ask NBRB/KCCA or the user for the PDF.
- The National Physical Planning Standards and Guidelines 2011 (MLHUD) may contain room and plot standards but was not read: [link](https://mlhud.go.ug/wp-content/uploads/2015/10/National-Physical-Planning-Standards-and-Guidelines_-2011.pdf).

## Civil and external works: kerbs, drains, culverts, murram, manholes

### Takeaway
No civil product dimensions were obtained. The Ministry of Works standard-design manuals exist, for example Manual B1, "Standard Designs for Rural Transport Infrastructure", 2006, but the summary page carries no numbers.

### Cited Findings
- MoWT Volume 6 "Community Access", Manual B1, gives standard designs for cross-drainage, culverts and access roads (2006, 98 pp). The dimensions are in the PDF only. — [MoWT RIC](https://ric.works.go.ug/rc/files/5.16-Standard-designs-for-rural-transport-infrastructure.html); related [Manual B](https://www.ric.works.go.ug/rc/files/5.23.2_Manual_B.pdf)
- A manhole is legally defined as a chamber deeper than 750 mm. — [Building Control Regulations 2020, reg.2](https://www.kcca.go.ug/media/docs/The%20Buildings%20Control%20Regulations%202020%203.pdf)
- Polypipes: Roofings makes PVC and HDPE pipes (sizes not given). — [Roofings Catalogue](https://roofingsgroup.com/documents/Roofings-Product-Catalogue.pdf)

### Inferences
- ASSUMPTION (Uganda and Kenya practice): precast concrete culverts are 600, 900 and 1200 mm diameter (900 mm minimum is commonly cited for roads, 600 mm for access). Kerbs are about 125x250 mm (road) and 50x150/100x200 mm (edging). U-drains are about 300-600 mm wide, open or covered. Murram (gravel) wearing course is 150-200 mm with about 4-5% camber. Inspection chambers are 450x600 mm (shallow) and 600x900 mm. Covers are cast iron or precast concrete, rated light/medium/heavy duty.

### Gaps
- No UNRA Road Design Manual or MoWT drainage manual numbers were extracted. Fetch the Manual B PDF in a follow-up.
- No local precast suppliers were identified (for example Kiboko, or Pan African precast).

## Local manufacturers and standards (cross-cutting)

### Takeaway
Verified:
- Roofings Group (sheets, coils, hollow sections, pipes)
- Uganda Baati, Safal Group (roof sheets, including Orientile and Lifestile)
- Steel & Tube Industries (sheets, hollow sections, Z-purlins, mesh)
- Hima Cement (Sarrai/Rwimi, Kasese and Tororo plants)

Uganda standards are largely adopted East African Standards (US EAS) or ISO, with Eurocode-style concrete grades.

### Cited Findings
- Uganda Baati is in the Safal Group and is expanding showrooms, with its 14th in Luwero. — [Business Times UG](https://businesstimesug.com/uganda-baati-expands-its-presence-with-14th-showroom-in-luwero/amp)
- Adopted standards seen: US EAS 11:2013 (galvanised sheets), US EAS 412-1/-2 (rebar), US EAS 468 (pre-painted sheets), US 540 (AZ sheets), US 310-1 (cement), US ISO 630-2 (structural steel). — [TradeBarriers](https://tradebarriers.org/ntm/regulations/view/2001); [Structural Code](https://nbrb.go.ug/wp-content/uploads/2022/01/Buidling-Structural-Design.pdf); [Roofings](https://roofingsgroup.com/documents/Roofings-Product-Catalogue.pdf)

### Inferences
- Use US/EAS references in the kit, with BS/EN equivalents in brackets, since professionals still design to BS 8110 and EN 1992 in practice (ASSUMPTION).

### Gaps
- Tororo Cement, Kiboko, Uganda Clays and Twyford were not verified in this run.
- The UNBS catalogue was not searched for block or tile standards.
