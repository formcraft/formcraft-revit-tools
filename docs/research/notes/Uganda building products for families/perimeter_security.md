# Perimeter and security products used in Uganda (for parametric Revit family types)

Scope note: Uganda-specific primary sources were thin. Most dimensional data comes from South African (Nemtek, Centurion, SANS),
UK (358 mesh, palisade) and Chinese export (razor wire) catalogues, which are the product lines sold through East African
distributors. Each item says where SA/UK/CN practice is assumed. "Inferences" are not verified; treat them as starting
defaults to confirm with a Kampala supplier before they become kit data (kit change request, per CLAUDE.md rule 7).

## Gates (sliding on-track, cantilever, swing double, pedestrian/wicket; widths, heights, infill, posts, motors, rails)

### Takeaway
The only gate data verified is the motor side: the Centurion D5 EVO (the common SA sliding motor also sold in Kenya, Ghana and Nigeria) is rated for 500 kg gates up to 20 m long, with a separately bought 2 m steel or nylon rack. No Uganda source gave gate leaf sizes or infill specs, so gate geometry defaults are inferences.

### Cited Findings
- Centurion D5 EVO Smart: max gate mass 500 kg; max gate length 20 m; speed up to 24 m/min max, 19 m/min rated; 50% duty cycle; max 150 operations/day; 110–240 V AC mains charging a single 12 V 7–7.2 Ah battery (battery-driven motor, solar capable); starting push 30 kgf, rated 17 kgf; packed size 325 × 245 × 395 mm, 7.1 kg; foundation plate needed on new installs — [Stemar (SA retailer)](https://stemar.co.za/?p=6729)
- Rack for Centurion motors sold separately in 2 m lengths: steel rack, or nylon rack with angle iron — [Stemar](https://stemar.co.za/?p=6729)
- The Centurion range also includes D3 Smart (lighter, predecessor), D10 and D20 Smart PLUS (heavier gates); D20 was priced at R11,999 vs R5,850 for the D5 EVO (Oct 2026 listing). No specs were given for these on the page — [Stemar](https://stemar.co.za/?p=6729)
- The D5 EVO is resold in East/West Africa classifieds (Kenya listing labelled "500kgs sliding motor centurion d5 evo"), showing it is distributed in the region — [Jiji Kenya](https://jiji.co.ke/nairobi-central/doors/500kgs-sliding-motor-centurion-d5-evo-ClMeFic269LGfNF8EjWPeWCE.html), [Jiji Ghana](https://jiji.com.gh/odorkor/doors/centurion-domestic-d5-evo-smart-motor-gate-machine-ClA1soO32sHD4TR0W22SMqQS.html)
- A Uganda public project (Kampala Goods Shed fencing, Uganda Railways/MoWT, 2019) specified "palisade access gates" and repair of three existing "see through" gates, showing palisade/see-through gate infill in Ugandan public tenders — [Ministry of Works and Transport Uganda](https://mail.works.go.ug/component/k2/item/47-fencing-of-the-kampala-goods-shed)

### Inferences
- Centurion D-series product steps (D3 ~300 kg / D5 500 kg / D10 ~1000 kg / D20 ~2000 kg gate mass) are from general knowledge of the range, not verified here; only the D5 figure is cited.
- Suggested Revit type parameters for a gate family: Clear_Opening (3000/3600/4000/4500/5000/6000 mm), Leaf_Height (2100/2400/2700/3000 mm), Gate_Type (Slide-Track / Slide-Cantilever / Swing-Double / Swing-Single / Wicket), Infill (Sheet-clad / RHS vertical bars / Palisade pales / Mesh), Frame_Section (e.g. 50×50 or 60×40 RHS), Leaf_Mass (for motor check), Motor (Centurion D5 / BFT / none), Rack_Length (n × 2 m). These ranges match the brief and common SA/Kenya practice; not verified in Uganda sources.
- Sliding gates on track need a leaf length ≈ opening + overlap and a run-back clear zone of the same length behind the wall; cantilever gates need roughly 1.4–1.5× opening of leaf length. This is standard sliding-gate practice (not cited).
- Pillars at gates in Uganda are usually reinforced-concrete or block-encased pillars larger than wall pillars; no dimension source was found.

### Gaps
- No Ugandan installer catalogue with gate leaf widths, heights, frame sections or infill gauges was found.
- BFT, FAAC, ET Nice and Gemini motor specs not researched (search budget).
- Swing gate hinge/post sizes and wicket gate widths (commonly 900–1200 mm) not sourced.

## Boundary walls and fences (block walls with pillars, chain-link, palisade, welded mesh 358/ClearVu, barbed wire, precast posts)

### Takeaway
Ugandan public work uses concrete block walls with hoop-iron reinforcement and precast concrete copings, sometimes as a low plinth under palisade fencing; 358 mesh and W-section palisade dimensions are well defined in UK catalogues and can be used as type defaults (flag as UK practice). Barbed wire in Uganda falls under the Uganda Standard US ISO 7900:2006.

### Cited Findings
- Kampala Goods Shed fence (2019, Uganda Railways Corporation/MoWT): concrete block wall 300 mm wide, average 750 mm high; blocks to BS 3921 at 4 N/mm²; laid in 1:3 cement–sand mortar; 25 mm hoop iron every alternate course; precast concrete copings over 764 m of fence line; palisade fencing and palisade access gates; 2 m vegetation clearance each side — [Ministry of Works and Transport Uganda](https://mail.works.go.ug/component/k2/item/47-fencing-of-the-kampala-goods-shed)
- 358 mesh ("prison mesh"): aperture 76.2 mm (W) × 12.7 mm (H); 4 mm pre-galvanised wires; PPC finish; panel heights 1.8/2.0/2.4/3.0 m; bay width / post centres 2518 mm; 60×60 mm posts; M8 bolts and clips. Post lengths (dig-in / bolt-down) and foundation depth: 1.8 m fence 2400/1800 mm, 600 mm; 2.0 m fence 2600/2000 mm, 600 mm; 2.4 m fence 3000/2400 mm, 600 mm; 3.0 m fence 3800/3000 mm, 800 mm — [First Fence (UK) datasheet](https://media.firstfence.co.uk/products/5f16f3c18b49590d02dead4e/docs/9f443586-a4e1-4968-b44d-214fe51f5b00.pdf)
- 358 panels are also sold as 2400 × 2515 mm and 3000 × 2515 mm (Securifor 358) — [F.H. Brundle](https://www.fhbrundle.co.uk/products/56SE35824G__Green_PPC_Securifor_358_2400_x_2515mm_Maximum_Security)
- Palisade: 2.4 m high W-section pales, 2.0 mm thick, galvanised, bolt-down posts, rails included (sold per metre run). Pale width/depth not stated — [F.H. Brundle](https://www.fhbrundle.co.uk/products/470224BWM__Section_'W'_2.0mm_Comprising:)
- Uganda Standard US ISO 7900:2006 (steel wire and wire products for fences — zinc- and zinc-alloy-coated barbed wire, conventional and reverse twist, two-strand line wire, single-line entanglement) replaced US 193:2001; gazetted Jan 2014, in force 27 Jan 2014. Compulsory status not stated — [TradeBarriers.org (EAC NTM register)](https://tradebarriers.org/ntm/measures/view/6201); [TradeBarriers.org regulation](https://tradebarriers.org/ntm/regulations/view/2012)
- Roofings Group is a major Ugandan steel manufacturer (relevant as a local source of steel sections/wire products) — [Wikipedia](https://en.wikipedia.org/wiki/Roofings_Group), [African Business](https://african.business/2021/07/agribusiness-manufacturing/construction-boom-drives-growth-for-uganda-steel-manufacturer/)

### Inferences
- Typical Ugandan residential boundary wall (not verified in a source): 150 or 200 mm hollow/solid concrete block, ~2.4 m high, pillars 230–300 mm square at about 3.0 m centres, strip footing, cast or precast coping, with razor wire or electric fence on top. Use these as defaults and parameterise Pillar_Spacing, Pillar_Size, Wall_Height, Coping_Type.
- Palisade W-section pale is commonly ~68–70 mm wide; D-section ~65 mm; pales at ~ 70 mm gap; posts 102×68 RSJ or similar at 2.75 m centres (UK BS 1722-12 practice). Not verified in fetched sources; SA practice is similar.
- Chain-link in East Africa is usually galvanised or PVC-coated, 50 or 63 mm diamond mesh, 10–12 gauge (≈3.15–2.5 mm), 1.8–2.4 m high, on angle iron (e.g. 50×50×5) or precast concrete posts at 2.5–3.0 m centres with 3 strands of barbed wire on top. Not verified.
- ClearVu is a South African brand of 358-style mesh; its geometry can share the 358 family with a Brand parameter.

### Gaps
- No Uganda or Kenya BoQ was successfully read for wall pillar spacing, chain-link gauge or precast post sizes (Kenyan TU-K perimeter wall addendum failed to load: [TU-K](https://tukenya.ac.ke/sites/default/files/downloads/ADDENDUM%20TO%20TENDER%20FOR%20CONSTRUCTION%20OF%20THE%20PERIMETER%20WALL.pdf)).
- Palisade pale profile dimensions not confirmed.
- No Uganda standard for chain-link (an equivalent of ISO 7900 for woven mesh) was found.

## Razor wire / concertina (coil diameters, blade types, flat-wrap, mounting)

### Takeaway
Razor blade and coil geometry is well standardised in export catalogues: BTO blades are 0.5 mm strip on 2.5 mm core wire with 10–30 mm barbs; CBT-60/65 are 0.6 mm strip with 60–65 mm barbs; concertina coils come in 450–980 mm outside diameter, roughly 7–16 m extended length per coil.

### Cited Findings
- Blade table (thickness / core wire / barb length / barb width / barb spacing):
  - BTO-10: 0.5 / 2.5 / 12 / 13 / 26 mm
  - BTO-12: 0.5 / 2.5 / 12 / 15 / 26 mm
  - BTO-18: 0.5 / 2.5 / 18 / 15 / 33 mm
  - BTO-22: 0.5 / 2.5 / 22 / 15 / 34 mm
  - BTO-28: 0.5 / 2.5 / 28 / 15 / 34 mm
  - BTO-30: 0.5 / 2.5 / 30 / 18 / 34 mm
  - CBT-60: 0.6 / 2.5 / 60 / 32 / 96 mm
  - CBT-65: 0.6 / 2.5 / 65 / 21 / 100 mm
  — [Chinese manufacturer spec sheet via Global Sources](https://p.globalsources.com/IMAGES/PDT/SPEC/203/K1173060203.pdf)
- Coil table (outside diameter / loops / length per coil / clips / type): single coil (CBT-60/65): 450 mm, 33 loops, 7–8 m; 500 mm, 56, 12–13 m; 700 mm, 56, 13–14 m; 960 mm, 56, 14–15 m. Cross type (BTO): 450 mm, 56, 8–9 m, 3 clips; 500 mm, 9–10 m, 3; 600 mm, 10–11 m (3 clips) or 8–10 m (5 clips); 700 mm, 10–12 m, 5; 800 mm, 11–13 m, 5; 900 mm, 12–14 m, 5; 960 mm, 13–15 m, 5; 980 mm, 14–16 m, 5 — [Global Sources spec sheet](https://p.globalsources.com/IMAGES/PDT/SPEC/203/K1173060203.pdf)
- Another manufacturer lists outside diameters 450–960 mm, 33–52 loops, single and cross types; installation styles straight, concertina, crossed and flat; hot-dip galvanised or stainless strip — [Hebei Five-Star via B2USA](https://b2usa.com/hotsite/manufacturer11/concertina-razor-wire-)
- Razor or barbed wire may not be electrified (SA guidance) — [ProCompare (SA)](https://www.procompare.co.za/articles/pest-control/everything-you-need-to-know-about-electric-fence-installation)

### Inferences
- Wall-top concertina in Uganda is commonly a single 450 or 600 mm coil on a wall-top bracket or directly clipped to tie wires; Y-brackets on fence posts carry two coils (one each arm) or a coil plus barbed strands. Bracket spacing about 2.5–3.0 m to match post/pillar spacing. Not verified.
- Flat-wrap razor (panels ~ 450–900 mm high, flattened coils) suits walls where a low profile is wanted. Not verified for Uganda.
- Revit family: line-based "Razor coil" with type parameters Coil_OD, Blade_Type, Coil_Type (single/cross/flat-wrap), Clips_Per_Loop, Length_Per_Coil (for counting coils in schedules), Mount (wall-top bracket / Y-post / on-ground).

### Gaps
- No Ugandan or Kenyan supplier datasheet confirming which sizes are stocked locally.
- Y-bracket / wall-top bracket dimensions not sourced.

## Electric fence (energizers, brackets, strands, posts, insulators, wire, earthing, signs, legal/standards)

### Takeaway
Nemtek (SA) catalogues give the full component set: 2–7.6 J energizers, wall-top brackets for 5–12 wires, 1.0–2.5 mm wires (2.5 mm only in aluminium alloy), 1.5/2.4/3.0 m posts and 1.0–1.2 m earth spikes. Rules usually quoted (SA Electrical Machinery Regulations / SANS 10222-3) require wall-top fences at least 1.5 m above ground, yellow signs at most 10 m apart and brackets leaning inward at no more than 45°. No Uganda-specific electric fence law was found.

### Cited Findings
- Nemtek energizers: WIZORD 2i single zone 2 J; WIZORD 4i single zone 3.7 J; Merlin 4i single zone 3.7 J; Merlin Stealth M18S 3 J (mapping uncertain); other outputs in range 4.6 J, 7.6 J, 2 × 3.7 J, 2 × 2.4 J — [Nemtek Security Quick Reference (2023)](https://nemtek.co.za/wp-content/uploads/2023/11/18386_Nemtek-Security-Quick-Reference_S.pdf)
- Nemtek wall-top brackets in 5, 6, 8, 10 and 12 wire configurations; black or white powder coat, HDG, or HDG + PC — [Nemtek Quick Reference](https://nemtek.co.za/wp-content/uploads/2023/11/18386_Nemtek-Security-Quick-Reference_S.pdf)
- Wire: galvanised stranded 1.2/1.6/2.0 mm; galvanised solid 1.6/2.0/2.24 mm; stainless 304 stranded 1.2, solid 1.0/1.2 mm; stainless 316 stranded 1.2, solid 1.0/1.2/1.6/2.0 mm; aluminium alloy stranded 1.6/2.0 mm, solid 1.6/2.0/2.5 mm — [Nemtek Quick Reference](https://nemtek.co.za/wp-content/uploads/2023/11/18386_Nemtek-Security-Quick-Reference_S.pdf)
- Posts: intermediate picket posts 1.5/2.4/3.0 m (bitumen or HDG); end/corner strainer posts 1.5/2.4/3.0 m in 76 or 95 mm HDG; stays 38 or 50 mm HDG — [Nemtek Quick Reference](https://nemtek.co.za/wp-content/uploads/2023/11/18386_Nemtek-Security-Quick-Reference_S.pdf)
- Insulators: porcelain types (round bar, flat bar, nail-on, Y-standard, omega, jumbo/ultra strain, picket, shield, busbar, bobbin, strainer) and plastic Modulus slide/system insulators — [Nemtek Quick Reference](https://nemtek.co.za/wp-content/uploads/2023/11/18386_Nemtek-Security-Quick-Reference_S.pdf)
- Earth spikes HDG or copper-clad, 1.0 and 1.2 m; the wall-top diagram labels "30 metre spacing" near earth spikes (unclear if spike spacing) — [Nemtek Quick Reference](https://nemtek.co.za/wp-content/uploads/2023/11/18386_Nemtek-Security-Quick-Reference_S.pdf)
- Warning signs: Nemtek sign EA-WRS2/N and custom EA-WRS2/C — [Nemtek Quick Reference](https://nemtek.co.za/wp-content/uploads/2023/11/18386_Nemtek-Security-Quick-Reference_S.pdf)
- SA rules (summary source, does not quote clause numbers): wall-top electric fence min 1.5 m above ground; freestanding electric fence needs a separate barrier fence at least 1.5 m high; yellow signs min 100 × 200 mm, at access points and gates, max 10 m apart in urban areas; posts max 3 m apart; razor/barbed wire must not be electrified; angled brackets on the inside of the wall, max 45° outward; neighbour consent if overhanging; EFSCoC issued by a registered installer; energizer to SANS 60335-2-76 — [ProCompare (SA)](https://www.procompare.co.za/articles/pest-control/everything-you-need-to-know-about-electric-fence-installation)
- Uganda Standard US EAS 811-1:2014 (code of practice for safety of electrical installations, Part 1) exists in the EAC register; no fence-specific clause was found — [TradeBarriers.org](https://tradebarriers.org/ntm/regulations/view/993)
- Uganda Wildlife Authority uses electric fencing around national parks (agricultural/wildlife use, not urban security) — [Daily Monitor](https://www.monitor.co.ug/uganda/news/national/uwa-installs-electric-fence-around-national-game-parks-1791084)

### Inferences
- Kampala installers commonly follow SANS 10222-3 / IEC 60335-2-76 practice because SA-made energizers (Nemtek, JVA, Stafix/Gallagher) dominate. Assumed SA practice; no Ugandan legal requirement verified.
- Typical wall-top configuration: 6 or 8 strands of 2.5 mm aluminium (or 1.6–2.0 mm stainless) on brackets ~600–1000 mm high at ≤3 m centres, energizer with keypad, siren, strobe, battery, and 3 earth spikes. Bracket height ranges in the brief (600–1200 mm) are not verified.
- Revit family split: line-based "E-fence wall-top" (Strands, Bracket_Height, Bracket_Angle 0–45°, Bracket_Spacing ≤3000, Wire_Type) + point-based Energizer (Joules, Zones), Earth spike, Warning sign (100×200 min), Strainer post, Keypad, Siren.

### Gaps
- JVA and Stafix energizer joule ranges not sourced.
- Strand spacing (wire-to-wire, typically ~100–150 mm) and bracket heights not sourced.
- No Uganda Police, ERA or UNBS rule on urban electric fences found; the SANS 10222-3 text itself was not read (paywalled).

## CCTV, access control, alarm and security lighting

### Takeaway
Only one camera datasheet was verified (Hikvision DS-2CD2043G2-I bullet: Ø70 × 161.7 mm, ~490 g, IP67, 40 m IR, PoE). Access control, intercom, boom barrier, turnstile, PIR and floodlight dimensions were not researched in the budget; a Uganda VMS partner (Logix Uganda) was found.

### Cited Findings
- Hikvision DS-2CD2043G2-I (4 MP bullet): Ø70 × 161.7 mm, approx. 490 g, IP67, IR up to 40 m, PoE or mains; listed as discontinued at that retailer — [LDLC Pro](https://www.ldlc.pro/fiche/PB00544734.html)
- Logix Uganda is listed as an AxxonSoft (video management software) partner in Uganda — [AxxonSoft partner locator](https://fr.axxonsoft.com/partners/partner-locator/uganda/logix-uganda)
- Ugandan business directory categories for this sector include electric fencing, CCTV/IP cameras, access control (badges, biometric readers, intercoms), automatic gates and rising barriers, but it returned no listed companies at fetch time — [GoAfrica Uganda](https://www.goafricaonline.com/ug/directory/safety-security-equipment)
- Uganda security companies with job/company profiles: Hidden Locks Security Ltd, Present Security Technology Company Ltd (product scope not confirmed) — [Fuzu](https://www.fuzu.com/company/hidden-locks-security-ltd), [Fuzu](https://www.fuzu.com/company/present-security-technology-company-ltd)

### Inferences
- Hikvision and Dahua dominate the Ugandan market (per the brief; not verified here). Family defaults: bullet ~Ø70–90 × 160–260 mm; dome ~Ø110–125 × 90 mm; turret ~Ø100 × 90 mm; PTZ ~Ø200–270 × 300–400 mm with wall bracket. Typical mounting height 2.7–4.0 m for perimeter cameras, 6 m+ on poles for PTZ. Not verified.
- Equipment families: NVR in a 6U–12U wall rack, PoE switch (8/16/24 port), monitor, junction box (camera-specific, ~Ø100–130 mm). Access control: card/biometric reader at ~1.1–1.2 m, boom barrier arm 3–6 m, turnstile tripod; alarm PIR at ~2.1–2.4 m, panic button; LED floodlights 50–200 W on wall or pole. Not verified.

### Gaps
- No Dahua, PTZ, dome, turret datasheets; no access control, boom barrier (e.g. Centurion/ FAAC/ ZKTeco), turnstile, PIR, floodlight data.
- Typical Ugandan mounting heights, pole heights and rack sizes are not sourced.

## Local suppliers/installers in Kampala and standards (UNBS, IEC)

### Takeaway
Verified Ugandan sources are limited to the barbed-wire standard US ISO 7900:2006, the electrical installation code US EAS 811-1:2014, steel maker Roofings Group, and a handful of security firms; product ranges are imported from SA (Nemtek, Centurion), China (razor wire, CCTV) and Kenya.

### Cited Findings
- US ISO 7900:2006 barbed wire standard, gazetted Jan 2014, in force 27 Jan 2014 — [TradeBarriers.org](https://tradebarriers.org/ntm/measures/view/6201)
- US EAS 811-1:2014 code of practice for safety of electrical installations — [TradeBarriers.org](https://tradebarriers.org/ntm/regulations/view/993)
- SA references often applied: SANS 10222-3 (electric security fences) and SANS 60335-2-76 / IEC 60335-2-76 (energizers) — [ProCompare (SA)](https://www.procompare.co.za/articles/pest-control/everything-you-need-to-know-about-electric-fence-installation)
- Roofings Group (Kampala, steel products) — [Wikipedia](https://en.wikipedia.org/wiki/Roofings_Group)
- Logix Uganda (VMS partner); Hidden Locks Security Ltd; Present Security Technology Company Ltd — see sources above
- Public perimeter tender example: Kampala Goods Shed, contractor M/s Leading Edge Investments Ltd, 2019 — [MoWT Uganda](https://mail.works.go.ug/component/k2/item/47-fencing-of-the-kampala-goods-shed)

### Inferences
- Supplier names usually cited for Kampala (Nemtek/Centurion dealers, Hikvision distributors) need confirming by phone or a site visit; none were verified online here.
- Kit data should store source + "SA/UK/CN assumed" flags per value, so a Kampala-verified value can replace it later.

### Gaps
- No verified list of Kampala electric fence, gate motor or CCTV distributors with addresses.
- No PPDA (Uganda) BoQ for a security perimeter was read; GPP Uganda tender listings exist but were not fetched ([BidsFactory](https://bidsfactory.com/en/tenders/materials-for-construction-of-fence-gpp_ug-4b44a29cf4f843a3)).
- Prices in UGX not researched.
