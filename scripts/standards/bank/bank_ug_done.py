# Uganda library (27 Oct): rows now in the bank, by words in the title; and the rows still to get by hand
GOT = ["Physical Planning (Amendment) Act 2020", "Public Health Act Cap 281", "Condominium Property Act", "Land Act, Registration of Titles", "Local Governments Act",
       "Roads Act / UNRA Act", "Civil Aviation Authority obstacle", "Historical Monuments Act", "Uganda Communications Commission", "Local physical development plans",
       "Wetlands, River Banks", "Environmental and Social Assessment Regulations", "Noise Standards", "Uganda energy efficiency law", "Water Act Cap 152",
       "Electricity (Installation Permits)", "MoES Basic Requirements", "EAC criteria for classification", "Architects Registration Act", "Engineers Registration Act",
       "NSSF Act", "Uganda PPDA Regulations", "MoH health facility", "MoWT Standard Specifications", "Building Control fee schedule",
       "MoWT Road Design Manual", "MoWT Drainage Design Manual", "Geological map of Uganda", "Water Supply Design Manual"]
def mark(D):
    out = []
    for d in D:
        if d[0] in ("Uganda", "Planning and site", "Environment and sustainability", "Electrical and lighting", "Plumbing, drainage and water", "Building types", "Cost, measurement and contracts", "Practice and business", "Specification and construction", "Geotechnical") and any(g.lower() in d[1].lower() for g in GOT):
            d = d[:6] + (True,)
        out.append(d)
    return out
