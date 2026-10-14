# Doors and Windows in Ugandan Buildings (for parametric Revit families)

Research date: 2026-10-14. Labels used: **[V]** = verified in a cited source; **[EA]** = verified, but the source is from East Africa outside Uganda (flagged); **[I]** = inference or common-practice knowledge that was not verified online in this run (treat it as a starting default to confirm with a Ugandan QS or fabricator).

Source access limits in this run: the Kamuli District Local Government BoQ (kamuli.go.ug) was blocked by the egress proxy. The Ministry of Works & Transport (MoWT) *Standard Specifications for Building Works* (B4, amended Aug 2012) and the MoES Shimoni CPTC technical specification were reachable, but only their tables of contents could be read (the body text was truncated). Scribd BoQs are behind a JavaScript wall. The clause numbers in those documents are useful pointers for a manual read.

---

## 1. Doors: types, sizes, frames, materials

### Takeaway
Ugandan practice centres on three door families. (a) Mild-steel doors: sheet-clad or with a glazed/louvred top, often with an integral burglar grille and a fanlight, used on external doors, schools and health centres. (b) Timber doors in hardwood frames: flush or panelled, in mahogany, mvule or musizi, used internally and on residential fronts. (c) Aluminium and glass doors on commercial frontages and balconies. The structural opening heights in public BoQs can exceed 2100 mm. One East African school BoQ uses 950 x 2700 mm, which implies a door with an integral fanlight or louvre. So the family needs a parametric fanlight/vent zone rather than a fixed 2100 mm leaf.

### Cited Findings
- **[EA] Steel classroom door, typical public-works spec (IOM school BoQ, Wau, South Sudan):** "Steel doors to fit structural opening size 950mm x 2700mm high". Frame: "RHS steel frame 40mm x 40mm x 2mm". Burglar proofing: "RHS 25mm x 25mm x 2mm vertical steel bars at equal intervals welded to frames" on the interior side. Ventilation: "0.5mm thick steel louvers at top welded to RHS frame", covered with mosquito net. Panel: 0.5 mm metal sheet. Ironmongery: "stainless steel pull-push bar handle". Finish: two coats of anti-rust paint plus one coat of enamel; in the painting bill, two coats of brown rust-inhibiting primer plus two coats of white matt oil paint — [IOM Tender 09 BoQ](https://www.iom.int/sites/g/files/tmzbdl486/files/inline-files/annex1-boq_tender-no.09_wau.pdf)
- **[V] Casements (Africa) Ltd (Kampala) steel product range:** "doors, windows, grilles, gates, rolling shutters, expandable grill doors, and unit ports". Aluminium range: doors, windows, curtain walls, cladding, skylights, solar shading, louvre systems. The firm is also an agent for Trellidor (retractable security grilles) — [Construction Review](https://constructionreviewonline.com/company-reviews/casements-africa-limited-2)
- **[V] Timber door frames on the Kampala market (Jiji.ug):** frames are sold "ready made" in "all sizes" and "standard sizes". The listed species are mahogany and "local hardwoods (musizi, nkuzanyana, muvule)". One listing gives "90x240cm, 10 inches, non-vented". Another gives "Mahogany Door Frames 8inches", where 8 or 10 inches is the frame depth that matches the wall thickness. There is also a "Door Frame Ventilator" (a fanlight vent over the frame). Indicative prices are UGX 100,000–375,000 per frame — [Jiji.ug door frames](https://jiji.ug/263-door-frames)
- **[V] Door market mix (Jiji.ug "Doors & Security" filter counts):** Steel 281 ads, Aluminium 365, Wood 128, Glass 11, "Security Door" 48. Mahogany panel doors are listed as "made to order" (UGX 600,000–1,200,000) — [Jiji.ug doors](https://jiji.ug/doors)
- **[V] Mahogany doors and wooden flush doors are sold in Kampala** — [Jiji mahogany](https://jiji.ug/doors/mahogany); [furniture.ug wooden flush door](https://furniture.ug/product/wooden-flush-door/)
- **[V] Accessibility code (Uganda, 2019) door widths:** "A clear opening shall be at least nine hundred millimetres" (cl. 10(2)). In two-leaf doors, the leading leaf must give at least 900 mm (10(3)). A 450 mm nib is required on the handle side where a wheelchair user pulls the door (10(5)). Lever handles must be at least 150 mm long and mounted at most 1000 mm above the floor (11(1)). Thresholds must be at most 5 mm (9(8)). Glass doors need manifestation markings between 1250 and 1600 mm (10(11)). Accessible toilet and bathroom doors need a clear opening of at least 900 mm (16(2), 30(3)). Doorway headroom is 1980 mm minimum (8(2)). Doors and windows "shall not open across a walkway, corridor stair or ramp" (8(3)) — [Building Control (Accessibility Standards for PWDs) Code 2019, KCCA](https://www.kcca.go.ug/media/docs/The%20Building%20Control%20(Accessibilty%20Standards%20For%20Persons%20with%20Disabilities)%20Code,%202019.pdf)
- **[V] MoWT Standard Specification clause map for joinery (for a manual read):** 8.2 Species of Timber for Joinery Works; 8.17 Fixing or Building in Frames; 8.21 Flush Doors; 8.27 Ironmongery; 8.29 Mosquito Gauze; Tables 1-12 and 1-13 "Hardwoods for High Class Joinery Work". Clause 1.7 states that "B.S." means British Standard — [MoWT Std Specs B4 (IGAD mirror)](https://land.igad.int/index.php/documents-1/countries/uganda/urbanization-7/laws-2/1510-standard-specifications-building-works-amended-august-2012/file); [MoES Shimoni CPTC Tech Spec](https://www.education.go.ug/wp-content/uploads/2021/12/TECHNICAL-SPECIFICATIONS-SHIMONI-CPTC.pdf)

### Inferences
- [I] Typical leaf widths for Revit types: 900 mm for main and external doors, 800 mm for bedrooms and offices, 700 mm (sometimes 600 mm) for WC and shower doors. Double doors are 1200, 1500 or 1800 mm. Leaf height is 2100 mm. Adding a 300–600 mm fanlight gives a total frame height of about 2400–2700 mm. The Jiji "90x240cm" frame and the 950x2700 structural opening support this. Note that 700 and 800 mm leaves **fail** the 900 mm accessible clear opening, so accessible WCs, public entrances and school/health doors need a door of 1000 mm or more (giving a clear opening of 900 mm or more).
- [I] Timber frame section: residential hardwood frames are commonly 4"x2" or 6"x2" nominal (about 100x50 or 150x50 mm). The "8 inch / 10 inch" frame listings suggest full-wall-depth box frames for 200–250 mm walls (Uganda's common 9"/230 mm brick wall, or 150/200 mm block). Parameterise frame depth to match wall thickness.
- [I] Steel door frames: pressed-steel or angle/RHS frames (for example 40x40x2 RHS, as in the cited BoQ) built into masonry with lugs. Leaf: 1.0–1.5 mm (18–16 gauge) sheet on an RHS or angle framework. The thickness was not verified for Uganda.
- [I] Flush doors: hollow-core (internal) or solid-core (external or fire), faced with plywood or hardboard and often veneered with mahogany. Leaf thickness is about 35–45 mm. Panel doors are solid mahogany or mvule, with cypress (a plantation softwood) as the low-cost option.
- [I] Fire doors (FD30/FD60, BS 476-22 / BS EN 1634) appear mainly in high-rise commercial buildings in Kampala and are usually imported. No Ugandan fire-door product or code clause was verified.
- [I] uPVC doors and windows exist but are a small share of the market; aluminium dominates the "modern" segment.

### Gaps
- No Uganda-specific BoQ door schedule (D1/D2...) was read: the Kamuli BoQ was blocked and Scribd BoQs were inaccessible. Next step: get an MoES, MoH (HC II/III/IV standard designs) or KCCA BoQ PDF directly.
- MoWT clause 8.2 species list and 8.21 flush door construction (core type, facing thickness) were not read; they need a manual read of pages 51–57.
- Steel door sheet gauge and Ugandan frame section sizes were not verified.
- No verified source was found for fire door requirements in the National Building Code 2019 (Building Standards Code).

---

## 2. Windows: steel casement, aluminium, louvres, burglar bars, mesh, sizes

### Takeaway
The archetypal Ugandan window is a mild-steel casement. Public buildings use frames with opening and fixed lights, 4–5 mm clear glass in putty, an internal or external burglar grille of 12 mm bar, and mosquito mesh. The urban residential market has largely moved to aluminium sliding and "projected" (top-hung) windows, often sold as burglar-proof units. Use one family per system (steel casement, aluminium sliding, aluminium projected/top-hung, glass louvre), with burglar-bar pattern and mesh as type parameters.

### Cited Findings
- **[EA] Steel casement window, public school spec:** "W1 1200x1600mm" steel casement. Frame: "LTZ steel frame 40mm x 40mm x 2mm" (L, T and Z sections). Glazing: 5 mm clear glass in one item and 4 mm glass "in metal casement panes with tropical glazing putty" in another. Burglar bars: RHS 25x25x2 mm on the interior side behind the glass. Vent: 0.5 mm steel louvres with mosquito net. Each window has its own ironmongery, fasteners and stays (BoQ counts them per window, Nr). Windows receive "one coat of red oxide primer before delivery" — [IOM Tender 09 BoQ](https://www.iom.int/sites/g/files/tmzbdl486/files/inline-files/annex1-boq_tender-no.09_wau.pdf)
- **[EA] Separate burglar grille item:** "12mm high-yield tensile bars at 150mm vertical and 300mm horizontal centres, cobweb pattern, one coat of red oxide primer", measured in linear metres — same source.
- **[V] Kampala window market (Jiji.ug, 246 ads; "124 sliding-window ads" by filter):** listing types include "Metallic Windows… burglar-proof", "Windows Pj" (projected), "Projected Bathroom Window", "Windows Sliding 4 x 5 ft stainless steel pipe", "Metalic Windows 5by4fts… sliding, security bars", "Burglar Proof Windows… double sliding, double-glazed", and "Aluminium Sliding Window". Glass-type filters list standard, laminated, tempered and tinted. Indicative prices are UGX 250,000 (bathroom projected) to UGX 1,530,000 per unit — [Jiji.ug windows](https://jiji.ug/windows)
- **[V] Casements (Africa) Ltd:** aluminium doors and windows, curtain wall, facade, louvre systems, glass products (ground, bevelled, laminated, reflective, etched/sandblasted), steel grilles and burglar-proofing, and door hardware. Claims "ISO Certified" (no standard number given) and "Every profile we use is certified genuine". A testimonial mentions double-glazed aluminium units — [casements.co.ug](https://www.casements.co.ug/); [Construction Review](https://constructionreviewonline.com/company-reviews/casements-africa-limited-2)
- **[EA] Steel casement window with built-in burglar-proof grille is a stock product in the region** (Nairobi, about KSh 7,500) — [Jiji.co.ke](https://jiji.co.ke/umoja/windows/steel-casement-window-built-in-burglar-proof-grill-uAmdL1gcIionXnsdCSamOFBU.html)
- **[V] MoWT Std Spec clause map:** 9.5 Metal Windows and Doors; 9.11 Protective Finish; 9.12 Flyscreens; 12.1 Glass; 12.3 Glazing; 13.4 Paint; 13.10 Preparation — [MoWT Std Specs B4](https://land.igad.int/index.php/documents-1/countries/uganda/urbanization-7/laws-2/1510-standard-specifications-building-works-amended-august-2012/file)
- **[V] Accessibility code for windows:** no numeric sill height is given. A window "shall not open across a walkway, corridor stair or ramp" (8(3)) and "shall not open onto a ramp" (12(5)). Window openers and locks count as operating controls; 900–1200 mm applies to "other fixtures", and it is unclear whether that includes windows (47(3)) — [Accessibility Code 2019](https://www.kcca.go.ug/media/docs/The%20Building%20Control%20(Accessibilty%20Standards%20For%20Persons%20with%20Disabilities)%20Code,%202019.pdf)

### Inferences
- [I] Steel casement modules: frames are commonly built from a grid of about 400–600 mm lights. Typical overall sizes are 600x600 / 600x900 (WC/bath high-level), 1200x1200, 1200x1500, 1500x1200, 1800x1500 and 2400x1500 (living room). Sill height is about 900 mm for habitable rooms, 1500–1800 mm for WCs, and about 1050 mm in classrooms. These are not verified against a Ugandan schedule.
- [I] Section types: Z-section (opening sash), T-section (mullion/transom), L/angle (outer frame), and flat bar for beads. They are locally rolled or imported (similar to the South African "T6"/Z sections), then welded on site or in Katwe/Ndeeba workshops. There is no verified named supplier list for Katwe fabricators.
- [I] Burglar bars: 12 mm or 16 mm square/twisted/high-yield bar, or 25x6 / 30x6 flat bar, at about 100–150 mm centres. Pattern options are straight vertical, grid, diamond, "cobweb" (verified in the [EA] BoQ), and decorative scroll. They are fitted internally behind casements and externally on aluminium sliders. Use a type parameter for the pattern and an instance parameter for the side (int/ext).
- [I] Glass louvre windows (Naco-type blades, 150 mm wide in about 6 mm glass on aluminium clip carriers) are common in older or low-cost buildings and in WCs/kitchens. Treat them as a separate family with a blade-count parameter.
- [I] Aluminium systems: mostly imported profiles (Kenya, China, UAE/Turkey) assembled by local fabricators. Common sliders use about 50–75 mm frame depth, a 2- or 3-track frame, 5–6 mm clear/tinted (bronze, grey, green) or reflective glass, mohair seals, and powder-coated or anodised finishes (white, bronze, black, champagne).
- [I] Mosquito mesh: aluminium or fibreglass gauze, either fixed to the casement or as a sliding/removable screen on aluminium windows.

### Gaps
- No Ugandan schedule with W1/W2 sizes was read. The [EA] W1 1200x1600 comes from a South Sudan BoQ that uses Ugandan/East African QS conventions.
- Ugandan aluminium system names were not verified. "Alu-Mtego" could not be verified and should not be used. Alamdar Aluminium & Glass Ltd appears on a Uganda jobs directory (https://www.fuzu.com/uganda/company/alamdar-aluminium-glass-limited), but its product range was not verified.
- The specific steel window section sizes (Z/T dimensions, gauge) supplied in Uganda were not verified.

---

## 3. Schedule naming, glazing thickness, finishes

### Takeaway
East African BoQs use simple type marks (D1, D2…, W1, W2…). Each item gives the overall size in mm (W x H) and names the frame material, glazing, burglar proofing, mesh, ironmongery and finishes. The finish system on steel is red-oxide primer plus gloss/oil enamel. Aluminium is powder-coated. Use these as Revit Type Mark and type-parameter fields.

### Cited Findings
- **[EA] Type mark convention:** "W1 1200x1600mm" (type mark plus W x H in mm) — [IOM Tender 09 BoQ](https://www.iom.int/sites/g/files/tmzbdl486/files/inline-files/annex1-boq_tender-no.09_wau.pdf)
- **[EA] Glazing:** 4 mm clear in metal casements with tropical glazing putty; 5 mm clear in a W1 item — same source.
- **[EA] Steel finishes:** "one coat of red oxide primer" (grilles, windows before delivery); "two coats of antirust paint and one coat of enamel"; "two coats of brown rust-inhibiting primer… two coats of white matt oil paint on metal" — same source.
- **[V] National Building Code plan checks rely on door/window schedules:** plans must show the "location, width and purpose" of openings, and door/window schedules are used to check lighting and ventilation — [NBRB Building Control Act Implementation Guide (June 2020)](https://nbrb.go.ug/wp-content/uploads/2020/08/Immpletation-Guide.pdf)
- **[V] Market glass types:** standard, laminated, tempered, tinted; single/double glazing — [Jiji.ug windows](https://jiji.ug/windows)

### Inferences
- [I] Recommended Revit parameters for the FMC kit (they must come from the kit, not code, per CLAUDE.md rule 7): Type Mark (D#/W#), Width, Height, Fanlight Height, Frame Material (Steel RHS / Steel LTZ / Hardwood-Mahogany / Mvule / Musizi / Cypress / Aluminium / uPVC), Frame Depth, Leaf Construction (Flush-Hollow / Flush-Solid / Panel / Steel Sheet / Steel Glazed / Louvred), Glazing (4/5/6 mm clear/tinted/laminated/tempered), Burglar Bar Pattern, Burglar Bar Side, Bar Size, Mosquito Mesh (Y/N), Finish (Red Oxide + Gloss Enamel / Powder Coat RAL / Varnish), Ironmongery Set, Sill Height. Any new value should go into a kit change request.
- [I] Also common in Uganda: "PJ" (projected) as a shorthand for top-hung aluminium windows in fabricator speech (the Jiji "Windows Pj" listing supports this).

### Gaps
- No Ugandan QS schedule was found to confirm the D/W mark ranges or the BoQ (SMM7 / CESMM-style) wording.
- Ironmongery standards were not verified (e.g. BS EN 1906 lever handles, BS EN 12209 locks, Union/Yale lock brands sold in Kampala).

---

## 4. Manufacturers, fabricators and suppliers

### Takeaway
Only Casements (Africa) Ltd is verified here as a large, established Ugandan steel and aluminium door/window fabricator (Industrial Area, Kampala, since 1965). Most supply comes from many small metal workshops and joinery shops, plus aluminium fabricators that use imported profiles.

### Cited Findings
- **[V] Casements (Africa) Ltd:** Plot 86/90, 5th Street, Industrial Area, Kampala. Established 1965 "to manufacture steel fabrications". Has a Rwanda branch (2002). Products: steel doors, windows, grilles, gates, rolling shutters, expandable grill doors; aluminium doors, windows, curtain walls, louvres. Agent for Trellidor, Hilti and Karcher — [Construction Review](https://constructionreviewonline.com/company-reviews/casements-africa-limited-2); [casements.co.ug](https://www.casements.co.ug/). The company's own site gives the plot number as "Plot 86" in the footer and "86/90" in the metadata.
- **[V] Alamdar Aluminium & Glass Ltd** is listed as a Ugandan company — [Fuzu](https://www.fuzu.com/uganda/company/alamdar-aluminium-glass-limited) (products not verified).
- **[V] Roofings Ltd / Roofings Rolling Mills** and **Steel Tube Industries** are Ugandan steel manufacturers listed on Fuzu — [Roofings](https://www.fuzu.com/uganda/company/roofings-ltd-uganda); [Steel Tube Industries](https://www.fuzu.com/uganda/company/steel-tube-industries). Their role as suppliers of the RHS/hollow sections used by door and window fabricators is [I], not verified.
- **[V] Small fabricators trading online:** "Vicentz Metal Works" (burglar proofing, Nakawa) and "Frank Systems LTD" (sliding windows) — [Jiji.ug windows](https://jiji.ug/windows)
- **[V] Rosewood Furniture (Kampala)** shows doors among its joinery projects — [rosewood.store](https://www.rosewood.store/project3.html)

### Inferences
- [I] Katwe and Ndeeba (Kampala) are the well-known informal metal-fabrication clusters for steel doors, windows and grilles ([Wikipedia: Katwe](https://en.wikipedia.org/wiki/Katwe) describes Katwe; this run did not verify the door/window specialisation).

### Gaps
- "Alu-Mtego" was not found and is unverified. No verified Ugandan uPVC manufacturer or fire-door supplier was found.
- No UNBS certification list for door or window products was found.

---

## 5. Standards and code requirements

### Takeaway
The governing law is the Building Control Act 2013, with the Building Control Regulations 2020 and the National Building Code 2019. The Code is a family of sub-codes: Building Standards, Structural, Electrical, Accessibility, Mechanical and Post Code. Door widths are fixed numerically by the Accessibility Code (900 mm clear minimum). Natural light and ventilation set window sizes: net glazing of at least 10% of floor area and openable area of at least 5%. Construction specs follow the MoWT Standard Specifications, which reference British Standards. No UNBS or EAS product standard for doors or windows was found.

### Cited Findings
- **[V] Codes named:** Building Control Act 2013; Building Control Regulations 2020; National Building Code 2019 (Building Standards Code, Structural Design Code, Electrical Installations Code, Accessibility Standards for PWDs Code, Mechanical Installations Code, Post Code Numbering Code) — [NBRB Implementation Guide 2020](https://nbrb.go.ug/wp-content/uploads/2020/08/Immpletation-Guide.pdf); [Building Control Act 2013 (ULII)](https://media.ulii.org/media/legislation/18427/source_file/9a7b6cecd0b00663/2013-10.pdf)
- **[V] Light and ventilation (as summarised in the NBRB guide):** habitable rooms need a net glazed area of at least 10% of floor area, plus another 5% where overhangs exceed 900 mm. Openable ventilation of at least 5% of floor area, including permanent vents. Cross-ventilation ratio as set by the Code. Public buildings: ventilation opening area per occupant. Windows obstructed by facing structures must be corrected — [NBRB Implementation Guide](https://nbrb.go.ug/wp-content/uploads/2020/08/Immpletation-Guide.pdf)
- **[V] Escape:** "adequate number of alternative exits", with location, distribution and width set by the Code. Large multi-storey buildings must be fire-protected with alternative escape routes. No numeric exit-door width appears in the guide — same source.
- **[V] Accessibility Code 2019:** the numbers in section 1 (900 mm clear, 450 mm nib, handle at most 1000 mm, threshold at most 5 mm, manifestation 1250–1600 mm, 1200 mm corridors, 1980 mm doorway headroom); a non-waterborne sanitary closet needs a ventilation opening of at least 0.2 m² (45(3)(b)) — [Accessibility Code 2019](https://www.kcca.go.ug/media/docs/The%20Building%20Control%20(Accessibilty%20Standards%20For%20Persons%20with%20Disabilities)%20Code,%202019.pdf)
- **[V] MoWT Standard Specifications for Building Works (B4, amended Aug 2012):** they refer to "the most recent and up to date editions of Ugandan Codes of Practices", and "B.S." means British Standard. The visible sections cite BS 8110, US 310 (cement), BS EN 12620 and BS 812 — [MoWT B4](https://land.igad.int/index.php/documents-1/countries/uganda/urbanization-7/laws-2/1510-standard-specifications-building-works-amended-august-2012/file); [MoES Shimoni spec](https://www.education.go.ug/wp-content/uploads/2021/12/TECHNICAL-SPECIFICATIONS-SHIMONI-CPTC.pdf)

### Inferences
- [I] BS references likely relevant to Ugandan door and window specs (not verified in a Ugandan document): BS 6510 (steel windows), BS 4787 / BS EN 14351-1 (doors and windows), BS 476-22 / BS EN 1634-1 (fire resistance), BS 6262 (glazing), BS 1186 (joinery timber quality), BS 8214 (fire door installation).
- [I] Using 900 mm as the default external and public door leaf, and 1000 mm where a 900 mm *clear* opening is required, matches the Accessibility Code.
- [I] Schedule check for Revit: the FMC QA could compute glazed area ≥ 10% and openable area ≥ 5% of room area from the door/window families' glazed and openable area parameters. This needs "Glazed Area" and "Openable Area" calculated parameters in each family.

### Gaps
- The National Building (Building Standards) Code 2019 text itself was not read. Numeric egress widths, fire-door ratings and the cross-ventilation ratio are still unconfirmed and need the KCCA/NBRB PDF.
- No UNBS (US) or EAS product standard for steel/timber doors or windows was found in this run. One may exist, so check the UNBS catalogue directly.
