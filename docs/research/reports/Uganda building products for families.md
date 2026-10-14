# Separate verified Ugandan products from borrowed defaults

Formcraft can build a Uganda-specific family kit today, but only a minority of the values are verified. The parts with Ugandan evidence behind them are the statutory numbers and a few local manufacturer catalogues:

- The Accessibility Code 2019 sets door, stair, ramp and handrail limits.
- The Electrical Installations Code 2019 sets mounting heights, cable and conduit minimums, earthing, and 20×3 mm lightning tape.
- The Structural Design Code 2019 sets concrete grades and foundation cover.
- The Roofings Group catalogues give roof-sheet and uPVC/PPR/HDPE pipe tables.

Most product geometry is not Ugandan. Gate motors, electric-fence parts, razor coils, 358 mesh and palisade, CCTV housings, water-tank sizes, PV modules and fire equipment all come from South African, UK, Chinese or Kenyan catalogues. The local market resells those product lines, but no Ugandan supplier has confirmed the sizes.

The archetypal Ugandan door and window is a mild-steel unit: a casement with burglar bars, mosquito mesh and a fanlight. The current kit (FMC_Family_Specs.json, 193 families) models windows only in aluminium, so this is the biggest product gap. The kit also already holds families for gates, a boundary wall, CCTV, lightning protection, tanks and fire equipment. Several of them now need corrected types:

- solar water heaters come in 160/220/320 L, not 150/300 L;
- there is no 5,000 L tank in any verified range;
- 800 mm hollow doors fail the 900 mm accessible clear opening;
- a 20×3 mm code-minimum lightning tape type is missing.

Under kit rule 7 ("kit data comes from the kit"), every value below is tagged as one of:

- **VERIFIED**: from a Ugandan source;
- **EA**: from an East African source outside Uganda;
- **ASSUMED**: borrowed from another country or from practice.

ASSUMED values can be used to build geometry, but they enter the kit only through a kit change request after a Ugandan supplier or professional confirms them.

## Read every value through three evidence grades

The research notes used three grades, and this report keeps them so each value can go straight into `FMC_Family_Specs.json` or a kit change request with its provenance attached.

| Grade | Meaning | What the kit should do |
|---|---|---|
| **VERIFIED (UG)** | Stated in a Ugandan statute, Ugandan standard, Ugandan manufacturer catalogue or Kampala market listing, with a source | Enter as kit data with the source in the register |
| **EA** | Stated in a published East African source outside Uganda (South Sudan BoQ by IOM, Kentainers Kenya) that follows the same QS conventions | Usable as a type default; confirm with a Ugandan BoQ before release |
| **ASSUMED** (SA / UK / CN / KE / BS practice) | Borrowed from foreign catalogues or general practice, or inferred | Use for geometry only; flag `Source = Assumed-<country>`; raise a kit change request |

One structural finding shapes everything else: **Uganda's statutes set few product dimensions.** The legal framework is the Building Control Act 2013, the Building Control Regulations 2020 and the National Building Code 2019. The Code is a set of sub-codes: Building Standards, Structural Design, Electrical Installations, Accessibility, Mechanical Installations and Post Code ([NBRB Implementation Guide 2020](https://nbrb.go.ug/wp-content/uploads/2020/08/Immpletation-Guide.pdf)). The Regulations themselves contain no room-height, door or stair dimensions ([Building Control Regulations 2020](https://www.kcca.go.ug/media/docs/The%20Buildings%20Control%20Regulations%202020%203.pdf)). Construction specifications still follow the Ministry of Works *Standard Specifications for Building Works* (2012), where "B.S." means British Standard. Its visible clauses cite BS 8110, US 310, BS EN 12620 and BS 812 ([MoWT B4](https://land.igad.int/index.php/documents-1/countries/uganda/urbanization-7/laws-2/1510-standard-specifications-building-works-amended-august-2012/file)). In practice, Uganda is a BS-and-EAS country: statutes set limits, and British or East African product standards fill the gaps.

### Ugandan standards the kit can cite now

| Standard | Covers | Source |
|---|---|---|
| US EAS 412-1 / 412-2:2013 | Plain and ribbed reinforcing bars | [Structural Design Code 2019](https://nbrb.go.ug/wp-content/uploads/2022/01/Buidling-Structural-Design.pdf) |
| US 310-1:2016 | Cement | same |
| US ISO 630-2:2011 | Structural steel (grades 43, 50, 55) | same |
| US EAS 11:2013 | Galvanised plain and corrugated sheets | [TradeBarriers](https://tradebarriers.org/ntm/regulations/view/2001) |
| US 540:2006, US EAS 468:2013, EAS 410 | AZ-coated and pre-painted sheets | [Roofings catalogue](https://roofingsgroup.com/documents/Roofings-Product-Catalogue.pdf) |
| US 264:2001, US 264-2, US 482:2002 | uPVC pipes, uPVC conduit, HDPE pipes | [Roofings PVC catalogue](https://roofingsgroup.com/documents/Roofings-PVC-Catalogue.pdf) |
| US ISO 7900:2006 (replaced US 193:2001; in force 27 Jan 2014) | Barbed wire and fence wire | [TradeBarriers](https://tradebarriers.org/ntm/measures/view/6201) |
| US EAS 811-1:2014 | Safety of electrical installations | [TradeBarriers](https://tradebarriers.org/ntm/regulations/view/993) |
| US IEC 60884-2-5 / BS 1363, US IEC 60669-1, US IEC 60898, US IEC 61386 | Sockets, switches, MCBs, conduit | [Electrical Code 2019](https://www.kcca.go.ug/media/docs/The%20National%20Building%20(Standards%20for%20Electrical%20Installations%20In%20Buildings)%20Code,%202019.pdf) |
| US ISO 4642-1:2009 (gazetted 21 Apr 2015) | Semi-rigid hose-reel hose, 19/25/33 mm | [TradeBarriers](https://www.tradebarriers.org/ntm/measures/view/5436) |
| US ISO 14557:2002 | Fire-fighting suction hose | [TradeBarriers](https://tradebarriers.org/ntm/regulations/view/1326) |

No UNBS or EAS product standard was found for steel or timber doors and windows, concrete blocks, clay bricks, tiles, chain-link mesh, PV modules or electric fences. Whether IEC 62305 has been gazetted as a Uganda Standard is unconfirmed. For each of these, the kit should cite the BS/EN reference and mark it **ASSUMED-BS** until UNBS confirms.

## Steel casements and fanlit doors are the missing Ugandan archetype

### Doors

The Kampala market sells three door lines, and the classified-ad counts show the mix: **aluminium 365 ads, steel 281, wood 128, "security door" 48 and glass 11** ([Jiji.ug doors](https://jiji.ug/doors)). Casements (Africa) Ltd is the one verified large local fabricator. It has been in Industrial Area, Kampala since 1965 and makes steel doors, windows, grilles, gates, **rolling shutters and expandable grille doors**, plus aluminium doors, windows, curtain walls and louvres. It is also the agent for Trellidor retractable grilles ([Construction Review](https://constructionreviewonline.com/company-reviews/casements-africa-limited-2); [casements.co.ug](https://www.casements.co.ug/)). Timber door frames are sold ready-made in mahogany and local hardwoods (musizi, nkuzanyana, mvule). Listings give sizes such as **"90x240cm, 10 inches"** and frame depths of **8 and 10 inches**, which match the wall thickness. A separate "door frame ventilator", a fanlight over the frame, is also sold. Frames cost UGX 100,000–375,000 ([Jiji.ug door frames](https://jiji.ug/263-door-frames)).

The 240 cm frame height matters for family design. An East African public-works BoQ prepared to the same QS conventions specifies steel doors for a **950 × 2700 mm structural opening**. Its other items are:

- a 40×40×2 mm RHS frame and 0.5 mm sheet panel;
- 25×25×2 mm RHS burglar bars on the inside;
- 0.5 mm steel louvres at the top with mosquito net;
- a stainless pull-push handle;
- anti-rust primer plus enamel ([IOM Tender 09 BoQ, South Sudan, EA](https://www.iom.int/sites/g/files/tmzbdl486/files/inline-files/annex1-boq_tender-no.09_wau.pdf)).

A fixed 2100 mm door family therefore misdescribes the typical Ugandan public door. **Every door family needs a parametric fanlight or vent zone** above a 2100 mm leaf, with total frame heights of about 2400–2700 mm.

The Accessibility Code 2019 sets the following limits ([KCCA](https://www.kcca.go.ug/media/docs/The%20Building%20Control%20(Accessibilty%20Standards%20For%20Persons%20with%20Disabilities)%20Code,%202019.pdf)):

- **clear opening ≥ 900 mm** (cl. 10(2)), with the leading leaf of a pair also giving ≥ 900 mm;
- **450 mm nib** on the handle side;
- lever handles ≥ 150 mm long, **≤ 1000 mm** above the floor;
- thresholds **≤ 5 mm**;
- glass-door manifestation between **1250 and 1600 mm**;
- doorway headroom **≥ 1980 mm**;
- accessible WC **≥ 1900 × 2300 mm**;
- doors and windows must not open across a walkway, corridor, stair or ramp.

A 900 mm leaf gives roughly 850 mm clear (an inference), so the kit's `0900x2100_SolidCore` type does not by itself meet the code. Accessible and public doors need a **1000 mm leaf**. The existing `0800x2100_Hollow` type should carry an `FMC_Accessible = No` flag.

| Door item | VERIFIED / EA | ASSUMED (confirm) |
|---|---|---|
| Steel door (sheet / louvred / glazed + grille) | 950×2700 opening, 40×40×2 RHS frame, 25×25×2 RHS bars, 0.5 mm louvres, primer + enamel (EA, IOM); product exists locally (UG, Casements) | Sheet 1.0–1.5 mm (16–18 gauge); pressed-steel frame option (practice) |
| Timber frame | Mahogany, musizi, nkuzanyana, mvule; 90×240 cm; 8"/10" frame depth; fanlight ventilator (UG, Jiji) | 100×50 / 150×50 mm frame sections; cypress as low-cost species |
| Flush / panel leaf | Flush and mahogany panel doors sold (UG, [Jiji](https://jiji.ug/doors/mahogany), [furniture.ug](https://furniture.ug/product/wooden-flush-door/)) | 35–45 mm leaf; hollow core internal, solid core external; leaf widths 700/800/900 mm, doubles 1200/1500/1800 mm |
| Rolling shutter, expandable grille door | Products exist (UG, Casements) | All dimensions |
| Fire door | None found in Uganda | FD30/FD60 to BS 476-22 / BS EN 1634-1, imported (ASSUMED-BS) |
| Accessibility limits | All values in the list above (UG, Accessibility Code 2019) | — |

### Windows

The window market has 246 ads. Its vocabulary is local: "Windows Pj" (projected, i.e. top-hung), "Projected Bathroom Window", "Metallic Windows… burglar-proof", "5by4fts sliding, security bars" and "Aluminium Sliding Window". Glass is offered as standard, laminated, tempered or tinted. Prices run from **UGX 250,000 for a bathroom projected unit to UGX 1,530,000** ([Jiji.ug windows](https://jiji.ug/windows)).

The public-works steel casement in the EA BoQ is a **"W1 1200x1600mm"** unit with these parts:

- LTZ frame 40×40×2 mm;
- 4 mm glass in tropical putty (5 mm in another item);
- interior burglar bars;
- a louvred vent with mosquito net;
- red-oxide primer before delivery.

A separate grille item is **12 mm high-yield bar at 150 mm vertical and 300 mm horizontal centres, "cobweb pattern"**, measured in linear metres ([IOM BoQ, EA](https://www.iom.int/sites/g/files/tmzbdl486/files/inline-files/annex1-boq_tender-no.09_wau.pdf)). The MoWT specification gives clause pointers (9.5 Metal Windows and Doors, 9.12 Flyscreens, 12.3 Glazing), but the clause bodies were not readable ([MoWT B4](https://land.igad.int/index.php/documents-1/countries/uganda/urbanization-7/laws-2/1510-standard-specifications-building-works-amended-august-2012/file)).

The NBRB guide sets the statutory sizing rule for windows ([NBRB guide](https://nbrb.go.ug/wp-content/uploads/2020/08/Immpletation-Guide.pdf)):

- **net glazed area ≥ 10% of floor area**, plus 5% where overhangs exceed 900 mm;
- **openable area ≥ 5%**;
- plans must show door and window schedules, which inspectors use to check light and ventilation.

The kit already has `FMC_Glazed_Area_m2` and `FMC_Openable_Area_m2` on `FMC_A_Window_Casement`, so an automatic QA rule (glazed ≥ 10%, openable ≥ 5% of room area) can be built with no new parameters.

| Window item | VERIFIED / EA | ASSUMED (confirm) |
|---|---|---|
| Steel casement | W1 1200×1600, LTZ 40×40×2, 4–5 mm glass in putty, red-oxide primer (EA); burglar-proof metallic windows sold in Kampala (UG) | Sizes 600×600, 600×900, 1200×1200, 1200×1500, 1500×1200, 1800×1500, 2400×1500; sills 900 (habitable), 1050 (classroom), 1500–1800 (WC); Z/T/L section sizes |
| Burglar bars | 12 mm HY bar, 150/300 mm centres, cobweb pattern (EA) | 16 mm bar or 25×6 / 30×6 flat; straight, grid, diamond and scroll patterns |
| Aluminium sliding / projected (PJ) | Products and glass options sold (UG, Jiji, Casements) | 50–75 mm frames, 2–3 tracks, 5–6 mm clear or tinted glass, imported profiles |
| Glass louvre | — | 150 mm blades in 6 mm glass, clip carriers |
| Glazing rule | ≥10% glazed, ≥5% openable (UG, NBRB) | — |

## Perimeter security rests on South African and Chinese catalogues

Only two items in this section are verified in Uganda: the public-tender wall specification and the barbed-wire standard. Every other dimension comes from catalogues for imported product lines. That is still useful, because the families model the same Centurion motors, Nemtek parts and Chinese razor coils that Kampala installers fit. But **each value must carry a `Source = Assumed-SA/UK/CN` flag** until a Kampala dealer confirms which variants are stocked.

**Boundary walls.** The only Ugandan specification found is the Kampala Goods Shed fence (Uganda Railways / MoWT, 2019). It specifies:

- a **300 mm wide concrete block plinth, average 750 mm high**;
- blocks to **BS 3921 at 4 N/mm²**, in 1:3 cement-sand mortar;
- **25 mm hoop iron in alternate courses**;
- precast copings over 764 m;
- palisade fencing above, with palisade access gates;
- 2 m vegetation clearance on each side ([MoWT](https://mail.works.go.ug/component/k2/item/47-fencing-of-the-kampala-goods-shed)).

The kit's existing `FMC_Profile_Coping` type `300` matches this wall width. The typical residential wall (150/200 mm block, about 2.4 m high, pillars at about 3 m centres, topped with razor wire or an electric fence) is **ASSUMED** and needs a Ugandan BoQ.

**Fences.** For 358 mesh, the UK datasheet gives a 76.2 × 12.7 mm aperture and 4 mm wire. Heights are 1.8/2.0/2.4/3.0 m on **60×60 mm posts at 2518 mm centres**, with post lengths of 2400/2600/3000/3800 mm and 600 mm foundations (800 mm for the 3.0 m fence) ([First Fence datasheet](https://media.firstfence.co.uk/products/5f16f3c18b49590d02dead4e/docs/9f443586-a4e1-4968-b44d-214fe51f5b00.pdf)). This is ASSUMED-UK; ClearVu is the South African equivalent. UK palisade is 2.4 m high with 2.0 mm galvanised W-section pales ([F.H. Brundle](https://www.fhbrundle.co.uk/products/470224BWM__Section_'W'_2.0mm_Comprising:)). The pale width, the chain-link mesh and gauge, and the posts are all ASSUMED practice. Barbed wire is the one fence product with a Ugandan standard, **US ISO 7900:2006** ([TradeBarriers](https://tradebarriers.org/ntm/measures/view/6201)).

**Razor wire.** Chinese export tables give exact blade geometry. BTO-10 to BTO-30 blades are 0.5 mm strip on a 2.5 mm core with 12–30 mm barbs. CBT-60/65 are 0.6 mm strip with 60–65 mm barbs. Coil diameters and lengths per coil are ([Global Sources spec sheet](https://p.globalsources.com/IMAGES/PDT/SPEC/203/K1173060203.pdf)):

| Coil type | Outside diameter | Length per coil |
|---|---|---|
| Single coil | 450 mm | 7–8 m |
| Single coil | 960 mm | 14–15 m |
| Cross coil | 450 mm | 8–9 m |
| Cross coil | 980 mm | 14–16 m |

Another maker confirms the 450–960 mm diameters and the straight, concertina, crossed and flat-wrap installation styles ([Hebei Five-Star](https://b2usa.com/hotsite/manufacturer11/concertina-razor-wire-)). Each coil type should carry a `Length_Per_Coil` type parameter so schedules count coils, not metres. The geometry is ASSUMED-CN. Which sizes Kampala stocks is unknown, and wall-top 450/600 mm single coils are only practice.

**Gates.** The verified gate data is all on the motor side. The Centurion D5 EVO is rated for **500 kg / 20 m gates**, a 12 V 7.2 Ah battery, a 50% duty cycle and 150 operations a day. It needs racks bought separately in **2 m lengths** ([Stemar, SA](https://stemar.co.za/?p=6729)), and it is resold in Kenya and Ghana ([Jiji Kenya](https://jiji.co.ke/nairobi-central/doors/500kgs-sliding-motor-centurion-d5-evo-ClMeFic269LGfNF8EjWPeWCE.html)). No Ugandan source gives leaf widths, heights or frame sections. Clear openings of 3.0–6.0 m, heights of 2.1–3.0 m, RHS frames, and cantilever leaves about 1.4–1.5 times the opening are ASSUMED practice. The Goods Shed tender does confirm palisade and "see-through" gate infill in Ugandan public work.

**Electric fences.** Nemtek's 2023 quick reference covers the component set ([Nemtek](https://nemtek.co.za/wp-content/uploads/2023/11/18386_Nemtek-Security-Quick-Reference_S.pdf)):

- energizers of 2–7.6 J;
- wall-top brackets for **5, 6, 8, 10 and 12 wires**;
- galvanised, stainless and aluminium wire of 1.0–2.5 mm (2.5 mm in aluminium alloy only);
- posts of 1.5/2.4/3.0 m, with 76/95 mm strainers;
- earth spikes of 1.0/1.2 m;
- porcelain and plastic insulators.

The rules commonly quoted come from South Africa (SANS 10222-3, IEC 60335-2-76) ([ProCompare](https://www.procompare.co.za/articles/pest-control/everything-you-need-to-know-about-electric-fence-installation)):

- the fence is ≥ 1.5 m above ground;
- signs are ≥ 100×200 mm and ≤ 10 m apart;
- posts are ≤ 3 m apart;
- brackets lean ≤ 45° outward;
- razor or barbed wire is never electrified.

**No Ugandan electric-fence law was found.** The only Ugandan electrical reference is US EAS 811-1 ([TradeBarriers](https://tradebarriers.org/ntm/regulations/view/993)). These rules belong in the kit as ASSUMED-SA defaults and must not appear as code-compliance checks.

**CCTV.** One datasheet was verified: the Hikvision DS-2CD2043G2-I bullet is **Ø70 × 161.7 mm, about 490 g, IP67, IR 40 m, PoE** ([LDLC Pro](https://www.ldlc.pro/fiche/PB00544734.html)). Logix Uganda is an AxxonSoft VMS partner ([AxxonSoft](https://fr.axxonsoft.com/partners/partner-locator/uganda/logix-uganda)). Dome, turret and PTZ sizes, mounting heights, NVR racks, access readers, boom barriers and PIRs are all ASSUMED. The kit's `FMC_E_SecurityDevice_CCTV` is still priority P3 with only Dome and Bullet types.

## Roofings Group's catalogues are the strongest local dataset

### Roofing

Roofings publishes cover width, pitch, depth and thickness for every profile. That is enough to build **ROOF system types that schedule sheet counts correctly** ([Roofings Product Catalogue](https://roofingsgroup.com/documents/Roofings-Product-Catalogue.pdf)):

| Profile | Cover width | Pitch | Depth | Thickness | Lengths |
|---|---|---|---|---|---|
| Super Eco | 814 mm | 203.5 mm | 22 mm | 0.25–0.60 mm | 1.2–12 m |
| Super V | 700 mm (784 mm overall) | 175 mm | 37 mm | 0.40–0.60 mm | — |
| Super VI | 830 mm | 171.5 mm | 37 mm | 0.32–0.60 mm | — |
| Super VII | 1045 mm | 209 mm | 22.5 mm | 0.25–0.60 mm | — |
| Super Tile | 925 mm | tile step 300 mm | — | 0.32 mm (G28) or 0.40 mm (G26) | 1.2–8 m |
| Round corrugation | 765 mm | 76.2 mm | 16.5 mm | 0.20–0.50 mm | — |

The same catalogue gives self-weights of 2.15–5.02 kg/m for 0.25–0.60 mm sheet, AZ coatings of 70–150 g/m², **100×50×2 mm steel purlins for tiles**, and 1250 mm × 40 m foil sarking. Only two gauge-to-thickness pairs are verified: **G28 = 0.32 mm and G26 = 0.40 mm**. The G30 and G32 equivalents are ASSUMED.

Uganda Baati (Safal Group) offers **Orientile, 1130 mm overall**, described as the widest steel profile in Uganda, in five colours ([Pulse Uganda](https://www.pulse.ug/story/uganda-baati-launches-crown-your-home-with-orientile-campaign-2025082010571385043)), and the stone-coated "Lifestile" ([SteelRadar](https://steelradar.com/en/haber/uganda-baati-limited-has-unveiled-cutting-edge-stone-coated-steel-roof-tiles-under-the-brand-name-lifestile)). Its other profile names and cover widths were not found. "IT4/IT5" are Kenyan Mabati names and should not appear in a Ugandan kit. Gutters, downpipes, ridges, fascias, clay tiles and timber truss sections are all ASSUMED.

### Walling

Only two walling units have Ugandan published sizes ([UN-Habitat 2009](https://unhabitat.org/interlocking-stabilised-soil-blocks-appropriate-earth-technologies-in-uganda)):

- **burnt clay brick 200×100×100 mm**, 4–5 kg, 0.5–6 MPa wet, laid with joints of up to 3 cm;
- **ISSB 265×140×100 mm**, 8–10 kg, 1–4 MPa, giving a 140 mm wall; about 130 blocks per 50 kg bag of cement.

The everyday concrete block (450×225 mm face in 100/150/200 mm widths) has **no Ugandan primary source** and is ASSUMED. So are plaster thicknesses (12–15 mm internal, 15–20 mm render). The Structural Code's masonry part (cl. 70–74) exists, but its text was missing from the copy online ([Structural Design Code 2019](https://nbrb.go.ug/wp-content/uploads/2022/01/Buidling-Structural-Design.pdf)).

### Structure

The Structural Design Code supplies the kit's firmest structural values ([Structural Design Code 2019](https://nbrb.go.ug/wp-content/uploads/2022/01/Buidling-Structural-Design.pdf)):

- foundation concrete **C20/25 reinforced, C12/15 plain**;
- **50 mm cover** to foundation steel;
- foundations at least **1.0 m deep**, and unreinforced footings at least 300 mm thick;
- column steel of 0.4–6%;
- deflection limited to span/360 or 20 mm.

Excavations deeper than 2 m need a permit and an engineer's design ([Regulations 2020, reg. 14](https://www.kcca.go.ug/media/docs/The%20Buildings%20Control%20Regulations%202020%203.pdf)). Market Y10 and Y12 bars all exceeded **500 MPa yield** under US EAS 412-2, although some failed the 1.15 tensile/yield ratio ([Kyambogo University 2024](https://kyuspace.kyu.ac.ug/items/4db8932b-1fac-4377-82a5-a4751f8953f1/full)). The kit can therefore name bars Y-prefix B500 class, but a ductility check belongs in the structural notes. Roofings rolls square hollow sections from **16×16 to 60×60 mm, 1.2–3.0 mm wall**, and Steel & Tube Industries makes Z-purlins, hollow sections and BRC mesh ([Construction Review](https://constructionreviewonline.com/company-reviews/steel-and-tube-industries-limited)). Member sizes (230×230 columns, 230×450 beams, 150 mm slabs) remain ASSUMED type-catalogue starting values. Kit rule 5 also keeps sizing with the engineer.

### Finishes, stairs and civil

Ceilings are the one finish with Ugandan evidence. Soft board (celotex) is the most common because it is cheap. Gypsum is the most expensive. Papyrus, reed, bamboo and sisal mats are also used ([Daily Monitor](https://www.monitor.co.ug/uganda/magazines/homes-and-property/alternatives-to-concrete-ceilings-1696432)). Tile, screed, terrazzo, PVC strip and cabro sizes are all ASSUMED.

The Accessibility Code sets the following stair and ramp limits ([Accessibility Code 2019](https://www.kcca.go.ug/media/docs/The%20Building%20Control%20(Accessibilty%20Standards%20For%20Persons%20with%20Disabilities)%20Code,%202019.pdf)):

- riser **≤ 170 mm**, stair width **≥ 900 mm**, flight rise **≤ 1530 mm**, nosing ≥ 40×40 mm;
- handrail grip 30–50 mm round, with 300 mm extensions;
- ramps 1:20–1:12, ≥ 1100 mm wide, with 1500 mm landings.

The handrail height prints as "170–1000 mm", almost certainly a typo for 870–1000 mm. Read the gazetted original before encoding it. No going minimum or guard height was found, so 250 mm going and 900/1100 mm guarding are ASSUMED-UK. For civil works, the law defines a manhole as a chamber deeper than 750 mm ([Regulations 2020](https://www.kcca.go.ug/media/docs/The%20Buildings%20Control%20Regulations%202020%203.pdf)). Culvert, kerb and U-drain sizes await the MoWT standard-design manuals ([MoWT RIC](https://ric.works.go.ug/rc/files/5.16-Standard-designs-for-rural-transport-infrastructure.html)).

## The Electrical Code anchors services; fire and HVAC have no local data

### Electrical

Of the services, the electrical work has the most Ugandan data. The 2019 Electrical Code fixes these values ([Electrical Code 2019](https://www.kcca.go.ug/media/docs/The%20National%20Building%20(Standards%20for%20Electrical%20Installations%20In%20Buildings)%20Code,%202019.pdf)):

- **240/415 V** gear;
- **shuttered, switched BS 1363 sockets**;
- distribution boards with their **lower edge at 2000 mm AFFL**;
- switches with their **centre at 1400 mm**, and isolators at 1400 mm to the underside;
- office and corridor sockets at **300 mm to the underside**;
- a **1.5 mm²** minimum cable (2.5 mm² for multicore and DC sockets);
- **20 mm** minimum steel conduit;
- a **4 mm²** minimum earth conductor and ≤ 1 Ω earth continuity;
- an earth-electrode result **below 8 Ω**.

The Code does not state the 50 Hz frequency, so it is ASSUMED.

Locally made uPVC conduit comes in 20–50 mm OD, 4 and 6 m lengths, light and heavy gauge, to US 264-2 ([Roofings PVC](https://roofingsgroup.com/documents/Roofings-PVC-Catalogue.pdf)). UEDCL replaced Umeme on **31 March 2025**, and "Yaka" became **"UEDCL Light"** with the meters unchanged ([Pulse Uganda](https://www.pulse.ug/story/uecdl-renames-yaka-to-light-what-you-need-to-know-2025033109575781651)). The kit's `FMC_E_EQ_Meter_Prepaid_1Ph` description should be updated to match.

**Two codes disagree on switch height.** The Electrical Code puts switches at 1400 mm, while the Accessibility Code sets switches at **900–1200 mm** ([Accessibility Code](https://www.kcca.go.ug/media/docs/The%20Building%20Control%20(Accessibilty%20Standards%20For%20Persons%20with%20Disabilities)%20Code,%202019.pdf)). The kit cannot hard-code one value. `FMC_Mounting_Height_mm` should default to 1400 mm, and a project-level accessibility flag should switch it to 1200 mm. Where the two codes conflict, a professional decides, not the kit (rule 5).

### Solar

Evidence for solar is mostly commercial, with no datasheets. Felicitysolar opened a Kampala Road store in 2025 selling inverters, lithium and gel batteries and panels ([pv magazine](https://pv-magazine.com/press-releases/felicitysolar-lights-up-uganda-new-kampala-road-store-opens-to-empower-communities)). Davis & Shirtliff partnered with Huawei for inverters and storage in Uganda ([Eagle Online](https://eagle.co.ug/2024/02/23/davis-shirtliff-huawei-partner-to-provide-affordable-high-end-solar-products-in-uganda-for-clean-energy-transition)).

Dayliff solar water heaters come in **160, 220 and 320 L** flat-plate thermosyphon units with ¾" BSP connections, 3.5 bar working pressure and a **standard 3 kW electric booster** ([Dayliff datasheet](https://www.dayliff.com/media/com_hikashop/upload/safe/dayliff_solar_water_heaters_800146681.pdf)). That answers the kit's open item on `FMC_P_MechEq_SolarWaterHeater`: add the 240 V 3 kW load connector, and change the types from 150/300 L to 160/220/320 L.

Any building with PV must have a lightning rod at its highest point (Electrical Code para 42(2)). PV module sizes (about 1722×1134 mm for 450 W, 2278×1134 mm for 550 W), 48 V LiFePO4 batteries and hybrid inverter ratings are ASSUMED market knowledge.

### Lightning protection

Lightning protection is **mandatory for all buildings**, and the Code names schools, churches, mosques, halls, hospitals and theatres (para 35). It requires:

- copper or aluminium tape **of at least 20×3 mm**;
- copper-bonded earth rods;
- earth resistance that "in no circumstances" exceeds **10 Ω** ([Electrical Code 2019](https://www.kcca.go.ug/media/docs/The%20National%20Building%20(Standards%20for%20Electrical%20Installations%20In%20Buildings)%20Code,%202019.pdf)).

ACLENet is pushing IEC 62305 and standard school templates in Uganda ([ACLENet](https://aclenet.org/programs/lightning-protection-of-schools/)). The kit's conductor types are all Cu 25×3. These comply, but the code-minimum 20×3 type and aluminium variants are missing. The kit should also store two separate limits: ≤ 10 Ω for lightning protection and < 8 Ω (recommended) for the installation earth.

### Plumbing and sanitation

Roofings publishes complete pipe tables to UNBS standards ([Roofings PVC](https://roofingsgroup.com/documents/Roofings-PVC-Catalogue.pdf)):

- **uPVC PN 2.5–16, OD 25–400 mm** in 6 m lengths;
- **HDPE PE100 OD 20–200 mm** at PN 6–20;
- **PPR OD 20–50 mm** at PN 10–25, e.g. 20 mm pipe with 1.9/2.8/3.4/4.1 mm walls.

These belong in the templates as **pipe segments and sizes, not families**.

Crestanks (Uganda) makes tanks from 50 to 24,000 L. They include **wide-and-short 3,000/6,000/10,000 L** models and **2–4.3 m³ "Septank"** septic tanks ([Construction Review](https://constructionreviewonline.com/crestanks/)), but Crestanks publishes no dimensions. The best verified proxy is the Kenyan Kentainers table ([Kentainers, KE](https://www.unsacco.org/wp-content/uploads/2022/10/KENTAINERS-ZONAL-KENTANK-PRICELIST-MARCH-2024.pdf)):

| Capacity | Height × diameter |
|---|---|
| 1,000 L | 127×107 cm |
| 3,000 L | 195×155 cm |
| 6,000 L | 223×198 cm |
| 10,000 L | 255×232 cm |

This is EA data. Neither source has a 5,000 L tank, so the kit's `5000` types should become 3,000/6,000. KCCA's onsite sanitation standards set user ratios: **1 stance per 40 users** in institutions, 1 shower per 20 boarders, 1 handwash point per 40 students within 5 m, basins ≥ 500×400 mm, and a **raised tank ≥ 2,500 L** for public toilets ([KCCA](https://www.kcca.go.ug/media/docs/FINAL-%20MINIMUM%20STANDARDS%20-%20SECOND%20EDITION.pdf)). Schools still pair classroom blocks with VIP latrines ([AllAfrica](https://allafrica.com/stories/202602260066.html)). That argues for a squat-pan family and a VIP latrine block, neither of which the kit has. WC, basin, sink, urinal, pump, heater and NWSC meter dimensions are ASSUMED.

### Fire, HVAC and landscape

Fire, HVAC and landscape have almost no Ugandan data. For fire, the only verified items are the hose standards (US ISO 4642-1 at 19/25/33 mm; US ISO 14557). The Uganda Police Fire Prevention and Rescue Services requirements and extinguisher scales were not found. Press reports on the Budo and Makerere fires describe weak enforcement ([The Independent](https://independent.co.ug/budo-fire-what-are-the-lessons)). Extinguisher sizes, hose-reel cabinets and BS 5839-1 alarm practice are ASSUMED-BS.

No Ugandan HVAC source was found. Split AC capacities, ceiling-fan sweeps and extract-fan sizes are market assumptions. For landscape, only Kenyan cabro suppliers surfaced ([Capital Blocks, KE](https://capitalblocks.com/cabro-blocks/)). The Kampala plant list (Paspalum, Markhamia lutea, Terminalia mantaly, Spathodea and others) is unverified and needs KCCA or a horticulturist.

## Proposed family list per discipline

The names below follow NAM-014 (`FMC_[Role]_[CategoryToken]_[Description].rfa`, using only the approved tokens), NAM-016 for type names (`[KeySize]_[Variant]`) and NAM-017 for system types. The approved token list has no Fence, Gate or Railing token, so perimeter items use `GenericModel` and `SecurityDevice`. Adding a dedicated token would be a kit change via `FMC_Revit_Kit.xlsx Family_Name_Tokens`.

The Master Manual defines **W as the Contractor (construction team) role** for temporary works (Manual 4.3). Permanent security therefore goes under **C** (walls, fences, gates, razor wire) and **E** (CCTV, electric fence, motors, access control). The temporary site families `FMC_W_GenericModel_Hoarding` and `FMC_W_GenericModel_SiteGate` stay with W.

In the tables, "Ext" means extend an existing family and "New" means add one. The evidence column summarises each family's sources.

### A: Architecture

| Family | Status | Suggested types | Key parameters | Evidence |
|---|---|---|---|---|
| FMC_A_Door_SteelSecurity | Ext | `0950x2700_SteelLouvred`, `0900x2100_SteelSheet`, `1000x2400_SteelGlazed-Grille` | FMC_Fanlight_Height, Infill (Sheet/Louvre/Glazed), Grille pattern, Sheet thickness | EA (IOM) + UG (Casements); sheet gauge ASSUMED |
| FMC_A_Door_FlushSingleLeaf | Ext | add `1000x2100_SolidCore-Accessible`, `0700x2100_Hollow-WC`; flag `0800x2100_Hollow` not accessible | FMC_Fanlight_Height, Frame depth (8"/10"), FMC_Accessible | UG (Accessibility Code, Jiji); leaf widths ASSUMED |
| FMC_A_Door_TimberPanel | New | `0900x2100_Mahogany-Panel`, `0900x2400_Mvule-Fanlight` | Species, Panels, Fanlight | UG (Jiji species, 90×240 frame) |
| FMC_A_Door_RollingShutter | New | `3000x3000_Steel`, `2400x2700_Steel` | Motorised Y/N, coil box size | UG product (Casements); sizes ASSUMED |
| FMC_A_Door_ExpandableGrille | New | `1200x2100_Steel`, `0900x2100_Trellidor` | Brand, track | UG product (Casements); sizes ASSUMED |
| FMC_A_Window_SteelCasement | New | `1200x1600_SteelCasement`, `1200x1200_SteelCasement`, `1500x1200_SteelCasement`, `0600x0600_SteelHighLevel` | FMC_Glazed_Area_m2, FMC_Openable_Area_m2, glass 4/5 mm, Mesh Y/N, Sill height | EA (W1, LTZ 40×40×2); other sizes ASSUMED |
| FMC_A_Window_Projected | New | `0600x0600_AluPJ`, `0600x0900_AluPJ` | Glazing spec, Opening area | UG (Jiji "PJ"); sizes ASSUMED |
| FMC_A_Window_Sliding / Casement / Louvre | Ext | add `1500x1200_Alu-Grille`, `0600x0900_GlassLouvre` | Burglar bar side (int/ext), Blade count | UG market; sizes ASSUMED |
| FMC_A_GenericModel_BurglarBar | New (shared nested) | `Y12_Cobweb-150x300`, `Y12_Vertical-150`, `Flat30x6_Grid-150` | Bar size, centres, pattern, side | EA (cobweb 12 mm @150/300); others ASSUMED |
| Wall system types (NAM-017) | New | `EXT_Blk200_Pls20-Pls15`, `EXT_Blk150_Pls20-Pls15`, `INT_Blk100_Pls15-Pls15`, `EXT_Brk230_Pls15-Pls15`, `EXT_ISSB140_FairFace` | Core material, plaster | UG (brick, ISSB sizes); block and plaster ASSUMED |
| Roof system types | New | `ROOF_Stl032_SuperTile`, `ROOF_Stl040_SuperV`, `ROOF_Stl030_SuperEco`, `ROOF_Stl040_Orientile`, `ROOF_Stl030_RoundCorr` | Cover width, Pitch, Depth, Gauge text, Coating | UG (Roofings, Baati); G30/G32 mm ASSUMED |
| FMC_Profile_Gutter / Fascia | New | `FMC_Profile_Gutter_HalfRound125`, `FMC_Profile_Fascia_25x225` | — | ASSUMED |
| Ceiling system types | New | `CLG_Celotex12_Paint`, `CLG_Gyp12_Paint`, `CLG_PVC8_Strip`, `CLG_Papyrus10_Natural` | Batten layer 25–50 | UG (types used); sizes ASSUMED |
| Railing / stair types | New | `RAIL_SS50_H900`, `RAIL_SS50_H1100`; stair rule riser ≤ 170 | Handrail height, extension 300 | UG (Accessibility Code); guard heights ASSUMED-UK |

### S: Structure

| Family | Status | Suggested types | Evidence |
|---|---|---|---|
| Materials (NAM-019) | New | `FMC_Concrete_C12-15`, `FMC_Concrete_C20-25`, `FMC_Concrete_C25-30` | C12/15 and C20/25 UG (Structural Code); C25/30 ASSUMED |
| Rebar bar types (system) | New | Y8, Y10, Y12, Y16, Y20, Y25, Y32 (B500); R6, R8 | Y10/Y12 ≥ 500 MPa UG (Kyambogo); others ASSUMED |
| FMC_S_StrColumn_RC_Rect / StrFraming_RC_Rect | Ext | keep 230×230, 300×300, 230×450; cover param 50 mm for foundations | Cover UG; sizes ASSUMED (rule 5) |
| FMC_S_StrFoundation_Pad | Ext | add FMC_Founding_Depth_mm ≥ 1000 check | UG (cl. 17(2)) |
| FMC_S_StrFraming_Steel_SHS | New | `50x50x2`, `60x60x3`, `40x40x2` | UG (Roofings 16–60, 1.2–3.0) |
| FMC_S_StrFraming_Purlin_Z | Ext | add `100x50x2_Purlin` | UG (Roofings) |

### E: Electrical, solar and security

| Family | Status | Suggested types | Evidence |
|---|---|---|---|
| FMC_E_ElecFixture_Socket_Twin13A, LightDevice_Switch | Ext | default FMC_Mounting_Height_mm 300 (socket) / 1400 (switch), accessible override 900–1200 | UG (both codes) |
| FMC_E_EQ_ConsumerUnit_1Ph, DB_SPN, DB_TPN | Ext | mounting lower edge 2000 AFFL; RCD flag | UG (Electrical Code) |
| FMC_E_EQ_Meter_Prepaid_1Ph | Ext | rename description "UEDCL Light (ex-Yaka)" | UG (Pulse) |
| FMC_E_EQ_PVModule | New | `1722x1134_450W`, `2278x1134_550W`, `2382x1134_610W` | ASSUMED (market) |
| FMC_E_EQ_Battery_LiFePO4 | New | `48V100Ah_5kWh`, `48V200Ah_10kWh` | ASSUMED |
| FMC_E_EQ_SolarInverter_Hybrid | Ext | add `3kW_1Ph`, `8kW_1Ph` | Retail exists UG; ratings ASSUMED |
| FMC_E_SecurityDevice_CCTV | Ext (P3→P2) | `Bullet4MP_IR40` (Ø70×161.7), `Dome4MP_IR30`, `Turret4MP_IR30`, `PTZ_25x` | Bullet VERIFIED datasheet; others ASSUMED |
| FMC_E_SecurityDevice_EFenceEnergizer | New | `2J_1Zone`, `3J7_1Zone`, `7J6_1Zone`, `2x3J7_2Zone` | ASSUMED-SA (Nemtek) |
| FMC_E_GenericModel_EFenceWallTop (line) | New | `6Strand_Al25`, `8Strand_Al25`, `12Strand_SS16` | Bracket height, angle ≤ 45°, spacing ≤ 3000; ASSUMED-SA |
| FMC_E_GenericModel_EFenceSign | New | `100x200_Yellow` | ASSUMED-SA |
| FMC_E_SecurityDevice_GateMotor | New | `D5EVO_500kg`, `D10_1000kg`, `Swing_Double` | D5 VERIFIED (SA datasheet); others ASSUMED |
| FMC_E_SecurityDevice_AccessReader, _Intercom, _PIR, _BoomBarrier | New | `Card_1100`, `Bio_1100`, `PIR_2200`, `Boom_4500` | ASSUMED |
| FMC_E_LightFixture_Floodlight | New | `50W_IP65`, `100W_IP65`, `200W_IP65` | ASSUMED |

### LP, P, FP and M

| Family | Status | Suggested types | Evidence |
|---|---|---|---|
| FMC_LP_GenericModel_Conductor | Ext | add `Air_Cu20x3`, `Down_Cu20x3`, `Down_Al20x3` (code minimum) | UG (para 35) |
| FMC_LP_SpecEq_EarthPit | Ext | FMC_Earth_Resistance_Ohm limit 10 (LP) vs < 8 (installation) | UG |
| FMC_LP_SpecEq_AirTerminal_Rod | Ext | `500_Cu16`, `1000_Cu16`; PV-roof rule | Rule UG (para 42(2)); rod size ASSUMED |
| FMC_P_MechEq_WaterTank | Ext | replace `5000` with `3000_WideShort`, `6000_WideShort`, `10000_WideShort`, `1000_Vertical` | Range UG (Crestanks); dims EA (Kentainers) |
| FMC_P_GenericModel_TankStand | New | `3m_Steel`, `6m_Steel`, `3m_Masonry` | ASSUMED |
| FMC_P_PlumbingEq_SepticTank | Ext | `2m3_Septank`, `4m3_Septank` | UG (Crestanks range) |
| FMC_P_PlumbingFixture_SquatPan | New | `600x450_PourFlush`, `600x450_Cistern` | ASSUMED |
| FMC_P_GenericModel_VIPLatrine | New | `2Stance`, `5Stance` | Need UG (KCCA 1:40; MoES WASH) |
| FMC_P_PlumbingFixture_HandwashStation | New | `500x400_Basin` | UG (KCCA ≥ 500×400) |
| FMC_P_MechEq_SolarWaterHeater | Ext | `160L_FlatPlate`, `220L_FlatPlate`, `320L_FlatPlate`, `200L_EvacTube` + 3 kW 240 V connector | Flat-plate VERIFIED (Dayliff); evac-tube ASSUMED |
| Pipe types (template) | New | uPVC PN6/10/16, PPR PN20, HDPE PE100 PN10 segments | UG (Roofings, US 264/482) |
| FMC_FP_SpecEq_HoseReel | Ext | `25x30m_Swinging`, `19x30m_Recessed` | Hose UG (US ISO 4642-1); cabinet ASSUMED |
| FMC_FP_SpecEq_Extinguisher | Ext | rename to NAM-016, e.g. `9kg_DCP-ABC`, `5kg_CO2`, `9L_Foam` | ASSUMED-BS |
| FMC_M_MechEq_CeilingFan | New | `1200_Sweep`, `1400_Sweep` | ASSUMED |

### C and L: Civil, perimeter and landscape

| Family | Status | Suggested types | Evidence |
|---|---|---|---|
| FMC_C_GenericModel_BoundaryWall | Ext | `300x750_BlkPlinth-Palisade`, `200x2400_Blk-Pillars3000`, `150x2400_Blk-Pillars3000` | Plinth UG (MoWT 2019); residential ASSUMED |
| FMC_C_GenericModel_Pillar | New | `300x300_RC`, `450x450_GatePillar` | ASSUMED |
| FMC_C_GenericModel_Gate | Ext | `4500x2400_SlideTrack-RHS`, `4000x2100_SlideCantilever-Palisade`, `3600x2100_SwingDouble-Sheet`, `1000x2100_Wicket` | Palisade infill UG; sizes ASSUMED |
| FMC_C_GenericModel_RazorWire (line) | New | `OD450_BTO22-Cross`, `OD600_BTO22-Cross`, `OD960_CBT65-Single`, `H600_FlatWrap` | FMC_Length_Per_Coil; ASSUMED-CN |
| FMC_C_GenericModel_Fence358 (line) | New | `1800_PPC-Green`, `2400_PPC-Green`, `3000_PPC-Green` | ASSUMED-UK (First Fence) |
| FMC_C_GenericModel_FencePalisade (line) | New | `2400_W-Section`, `1800_D-Section` | Use UG (MoWT); pale size ASSUMED-UK |
| FMC_C_GenericModel_FenceChainLink (line) | New | `1800_50mm-Galv`, `2400_63mm-PVC` | ASSUMED |
| FMC_C_GenericModel_BarbedWire (line) | New | `3Strand_ISO7900` | Standard UG (US ISO 7900) |
| FMC_C_PlumbingEq_Culvert | Ext | add `1200` | ASSUMED (MoWT manual pending) |
| Paving floor types | New | `SLAB_Cabro60_Sand30`, `SLAB_Cabro80_Sand30` | ASSUMED-KE |
| FMC_L_Planting_Tree | Ext | type catalogue: Markhamia lutea, Terminalia mantaly, Spathodea campanulata, Delonix regia | Unverified; KCCA source needed |

Two housekeeping issues surfaced. Several existing type names, such as `Water 9 L 13A`, `8 m 22.5 deg` and `Type catalogue 2-24 ways`, contain spaces and so fail the NAM-016 regex (`^[0-9A-Za-z]+(x[0-9]+)?_[A-Za-z0-9-]+$`). And `FMC_FP_MechEq_FirePumpSet` still waits on `FMC_Power_W_2`.

## Documents and suppliers to obtain

| # | Document or supplier | Closes which gaps |
|---|---|---|
| 1 | **National Building (Building Standards) Code 2019**, full gazetted text (NBRB/KCCA) | Room heights, egress widths, fire-door ratings, cross-ventilation ratio, guard heights, stair going |
| 2 | **Accessibility Code 2019** gazetted original | Confirms handrail height (870 vs "170"–1000 mm) |
| 3 | **MoWT Standard Specifications for Building Works B4 (2012)**, clauses 8.2, 8.21, 8.27, 9.5, 9.12, 12.3 | Joinery species, flush-door construction, steel window and door sections, glazing thickness |
| 4 | **MoES / MoH standard designs and BoQs** (school blocks, HC II–IV), plus a district BoQ such as Kamuli | Ugandan D/W mark schedules, door and window sizes, sills, VIP latrine geometry |
| 5 | **MoWT Manual B / B1, Standard Designs for Rural Transport Infrastructure**; UNRA drainage manual | Culvert, kerb, U-drain, murram and chamber sizes |
| 6 | **UNBS catalogue search** | Standards for blocks, bricks, tiles, doors/windows, chain-link, PV (US IEC 61215/61730), IEC 62305 adoption, electric fences |
| 7 | **Uganda Police FPRS** fire safety requirements and inspection checklist | Extinguisher scale, hose reels, hydrants, alarm categories |
| 8 | **MoES WASH in Schools Standards (2016)**; NWSC connection and meter-box rules; UEDCL meter enclosure and position rules | Stance ratios, water meter boxes, meter positions |
| 9 | **National Physical Planning Standards and Guidelines 2011** ([MLHUD](https://mlhud.go.ug/wp-content/uploads/2015/10/National-Physical-Planning-Standards-and-Guidelines_-2011.pdf)) | Plot, boundary and setback rules affecting walls and gates |
| 10 | **Casements (Africa) Ltd**, Industrial Area | Steel and aluminium section sizes, standard D/W sizes, rolling-shutter and Trellidor dimensions, sheet gauges |
| 11 | **Roofings Group** (rebar and open-profile pages, which are image-only online); **Uganda Baati** full catalogue; **Steel & Tube Industries** section tables | Rebar sizes stocked, gutter/ridge/fascia sizes, Baati profile names and cover widths, G30/G32 thickness |
| 12 | **Hima, Tororo and Kampala Cement** product sheets; **Uganda Clays (Kajjansi)** catalogue; a Kampala block maker | Cement classes; clay tile and brick sizes; concrete block face and widths |
| 13 | **Crestanks / Gentex** dimension tables; **Davis & Shirtliff Uganda** (SWH dimensions, Pedrollo/Grundfos pumps, Huawei); **Felicitysolar Kampala** datasheets | Tank H×Ø, Septank sizes, SWH footprint, pump sets, inverter and battery dimensions |
| 14 | **Kampala Nemtek and Centurion dealers**; **Hikvision/Dahua distributors** and **Logix Uganda**; Hidden Locks Security; Present Security Technology | Stocked energizers, bracket heights, strand spacing, gate motors, razor coil sizes, camera models, mounting heights, NVR racks |
| 15 | **Katwe/Ndeeba fabricators**, e.g. Vicentz Metal Works (Nakawa); Alamdar Aluminium & Glass | Burglar-bar patterns and bar sizes in actual use; aluminium system names |
| 16 | A **Ugandan QS** and a **registered electrical engineer** | BoQ wording (SMM7 style), the switch-height conflict, earth-resistance targets, sign-off on every ASSUMED value |

## Conclusion

The Ugandan statutes and local catalogues set limits rather than products. They fix clear widths, heights, resistances, minimum sections and concrete grades, but leave almost all product geometry to imported catalogues. A kit that treats ASSUMED values as data would quietly turn South African electric-fence practice or UK fence spacing into "Formcraft standard", and it would break rule 7.

The safer architecture uses the verified limits and the borrowed geometry differently:

- **Verified limits become QA rules.** Examples: clear opening ≥ 900, riser ≤ 170, glazing ≥ 10% and openable ≥ 5%, earth ≤ 10 Ω, foundation cover 50 mm, depth ≥ 1.0 m.
- **Borrowed geometry stays editable type data**, each value tagged `Source` and `Confidence`.

The verified items can enter the kit now: the statutory numbers, the Roofings profiles and pipe tables, and the Dayliff water-heater sizes. Priority should then go to the steel casement, the fanlit steel door and the burglar-bar nested family, which are the products Ugandan schedules are full of and the kit lacks.

The quickest way to close most remaining gaps is a single fieldwork week. One visit each to Casements, Roofings, Crestanks, Davis & Shirtliff and a Nemtek/Centurion dealer, plus one government BoQ set, would convert about two-thirds of the ASSUMED rows above into verified kit data.
