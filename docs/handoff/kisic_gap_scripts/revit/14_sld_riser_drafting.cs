// KISIC step 14 – single-line diagram DB-1 + power riser as drafting views (scale 1:1, paper mm), from the model's circuit data
// (device Comments "circuit Pn" + the lighting plan's circuit per layer). fmc_diagram can't draw yet: the kit DB refuses any distribution system (kit bug).
// Loads = sum of family Apparent Load (strips = W/m x length). Protective devices / cable sizes = ASSUMED, electrician designs (CA-E-03).
bool dry=(string)parameters[0]=="dry"; var log=new StringBuilder();
double M(double mm)=>FmcScript.Mm(mm);
using(var t=new Transaction(document,"KISIC 14 SLD + riser")){ var fo=t.GetFailureHandlingOptions(); fo.SetFailuresPreprocessor(new FmcFailures()); t.SetFailureHandlingOptions(fo); t.Start();
try{
 var vft=new FilteredElementCollector(document).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>().First(x=>x.ViewFamily==ViewFamily.Drafting);
 View Get(string n){ var ex=new FilteredElementCollector(document).OfClass(typeof(ViewDrafting)).Cast<View>().FirstOrDefault(v=>v.Name==n);
  if(ex!=null){ var own=new FilteredElementCollector(document,ex.Id).WhereElementIsNotElementType().Where(e=>e.OwnerViewId==ex.Id).Select(e=>e.Id).ToList(); document.Delete(own); return ex; }
  var nv=ViewDrafting.Create(document,vft.Id); nv.Name=n; nv.Scale=1; return nv; }
 var tts=new FilteredElementCollector(document).OfClass(typeof(TextNoteType)).Cast<TextNoteType>().ToList();
 var tBold=tts.First(x=>x.Name=="FMC 2.5 Bold"); var tNorm=tts.FirstOrDefault(x=>x.Name.Contains("2.5")&&x.Id!=tBold.Id)??tts.First(x=>x.Id!=tBold.Id);
 TextNoteType Big(){ var b=tts.FirstOrDefault(x=>x.Name=="FMC 5 Bold"); if(b==null){ b=(TextNoteType)tBold.Duplicate("FMC 5 Bold"); b.get_Parameter(BuiltInParameter.TEXT_SIZE).Set(M(5)); } return b; }
 var tBig=Big();
 View V=null; void L(double x1,double y1,double x2,double y2){ document.Create.NewDetailCurve(V,Line.CreateBound(new XYZ(M(x1),M(y1),0),new XYZ(M(x2),M(y2),0))); }
 void Box(double x,double y,double w,double h){ L(x,y,x+w,y); L(x+w,y,x+w,y+h); L(x+w,y+h,x,y+h); L(x,y+h,x,y); }
 void T(double x,double y,string s,TextNoteType tt){ TextNote.Create(document,V.Id,new XYZ(M(x),M(y),0),s,tt.Id); }
 void CB(double x,double y){ L(x-1.5,y-1.5,x+1.5,y+1.5); L(x-1.5,y+1.5,x+1.5,y-1.5); } // IEC breaker cross
 // ---------- SLD
 V=Get("E-SLD-01 Single line diagram DB-1");
 var rows=new (string c,string prot,string cable,string what,double va)[]{
  ("P1","MCB B6","1.5 mm² T&E","Lighting – lobby, reception, entrance, fan + light kit (L1), wall strips, emergency",971),
  ("P2","MCB B6","1.5 mm² T&E","Lighting – X-ray, Control, Scan (1 panel + 2 wall strips, dimmers), X-ray lobby, extract fan",969),
  ("P3","MCB B6","1.5 mm² T&E","Lighting – Laboratory + extract fan",451),
  ("P4","RCBO B6 30 mA","1.5 mm² T&E","Lighting – veranda (IP65 strip + wall lights)",138),
  ("P5","RCBO B20 30 mA","2.5 mm² T&E","Sockets – lobby, TV, X-ray, Scan general (6 twin)",1080),
  ("P6","RCBO B20 30 mA","2.5 mm² T&E","Sockets – Laboratory bench (3 twin)",540),
  ("P7","RCBO B16 30 mA","2.5 mm² T&E","Socket – veranda (IP66)",180),
  ("P8","MCB B6","1.5 mm²","X-ray in-use warning light (interlock from generator)",6),
  ("P9","RCBO B16 30 mA","2.5 mm² T&E","Socket – Scan, ultrasound machine (dedicated)",180),
  ("P10","RCBO B16 30 mA","2.5 mm² T&E","Socket – Lab analyser (dedicated)",180),
  ("P11","RCBO B16 30 mA","2.5 mm² T&E","Socket – Lab fridge (dedicated, non-switched)",180),
  ("P12","RCBO B20 30 mA","2.5 mm² T&E","Sockets – reception desk + control console (IT)",540),
  ("P13","MCB C16 + isolator","2.5 mm²","AC-1 X-ray 5.3 kW split + ACO-1 (roof)",1700),
  ("P14","MCB C20 + isolator","4.0 mm²","AC-2 Control 2.6 kW split + ACO-2 (roof)",2300),
  ("P15","MCB C16 + isolator","2.5 mm²","AC-3 Laboratory 3.5 kW split + ACO-3 (roof)",1100),
  ("P16","—","—","Spare – waiting area uses a ceiling fan + light kit (no AC)",0),
  ("P17","RCBO B20 30 mA","4.0 mm²","Instant water heater WH-1 (3.5 kW)",3500),
  ("P18","RCBO B20 30 mA","4.0 mm²","Instant water heater WH-2 (3.5 kW)",3500),
  ("P19","RCBO B20 30 mA","4.0 mm²","Instant water heater WH-3 (3.5 kW)",3500),
  ("SP","—","—","Spare ×5 (12-way TPN = 36 single-pole ways)",0)};
 double busX=70, top=255, dy=11.5, bot=top-dy*(rows.Length-1);
 T(10,300,"SINGLE LINE DIAGRAM – DB-1 (final distribution board, 12-way TPN, 415/240 V 50 Hz)",tBig);
 // incoming
 Box(8,268,40,14); T(10,279,"UMEME supply",tBold); T(10,274,"415/240 V TPN + N + E",tNorm); T(10,270.5,"meter at boundary (TBC)",tNorm);
 L(48,275,62,275); CB(55,275); T(50,280,"Main switch 63 A TPN (TBC)",tNorm);
 L(62,275,busX,275); L(busX,275,busX,top+4);
 Box(busX-3,bot-4,6,top-bot+8); T(busX-12,bot-10,"DB-1 busbar L1-L2-L3-N",tBold); T(busX-12,bot-14,"SPD type 2 · E bar · N bar",tNorm);
 T(110,top+12,"Circuit  Phase  Protection             Cable               Serves                                                                                   Load",tBold);
 for(int i=0;i<rows.Length;i++){ var r=rows[i]; double y=top-i*dy; string ph=r.c=="SP"?"":(new[]{"L1","L2","L3"})[i%3];
  L(busX+3,y,busX+30,y); if(r.va>0) CB(busX+18,y); L(busX+30,y,busX+34,y+2); L(busX+34,y,busX+36,y);
  T(110,y+2,r.c,tBold); T(126,y+2,ph,tNorm); T(140,y+2,r.prot,tNorm); T(185,y+2,r.cable,tNorm); T(228,y+2,r.what,tNorm); T(372,y+2,r.va>0?Math.Round(r.va)+" VA":"",tNorm); }
 double tot=rows.Sum(r=>r.va);
 T(110,bot-14,"Connected load ≈ "+Math.Round(tot/1000.0,1)+" kVA (sum of the model's fittings; diversity by the electrician).  Phases balanced by rotation L1/L2/L3.",tNorm);
 T(110,bot-19,"X-ray generator: separate sub-main from the main switch via a lockable isolator in the Control room – rating from the maker (TBC). Not on DB-1.",tNorm);
 T(110,bot-24,"All protection, cable sizes and earthing are ASSUMED for coordination; the electrical engineer designs and signs (BS 7671 / UNBS). Water heaters split to one radial each (model had 3 on P17).",tNorm);
 // ---------- Riser
 V=Get("E-RIS-01 Power riser");
 T(10,190,"POWER RISER – single storey + roof plant",tBig);
 L(10,150,250,150); T(212,152,"ROOF  +3.55 m",tBold); L(10,60,250,60); T(212,62,"L00 FFL  ±0.00",tBold); L(10,20,250,20); T(212,22,"SITE / BOUNDARY",tBold);
 Box(15,25,40,14); T(17,35,"UMEME meter",tBold); T(17,30,"415/240 V TPN",tNorm);
 L(55,32,80,32); L(80,32,80,80); Box(65,80,30,14); T(67,90,"Main switch",tBold); T(67,85,"63 A TPN (TBC)",tNorm);
 L(95,87,115,87); Box(115,75,40,24); T(117,94,"DB-1",tBig); T(117,86,"12-way TPN",tNorm); T(117,81,"Lobby west wall, 1.1 m",tNorm);
 L(80,94,80,110); Box(62,110,36,14); T(64,120,"X-ray isolator",tBold); T(64,115,"sub-main (maker TBC)",tNorm);
 string[] aco={"ACO-1","ACO-2","ACO-3"};
 for(int i=0;i<3;i++){ double x=120+i*30; L(135,99,135,105); L(135,105,x+10,105); L(x+10,105,x+10,160); CB(x+10,140); T(x+12,140,"isol.",tNorm); Box(x,160,22,12); T(x+2,168,aco[i],tBold); T(x+2,163,"P1"+(3+i),tNorm); }
 Box(170,70,70,24); T(172,89,"Final circuits P1–P19",tBold); T(172,84,"lighting P1–P4, P8 · sockets P5–P7, P9–P12",tNorm); T(172,79,"AC indoor P13–P15 (lobby: ceiling fan, P1) · heaters P17–P19",tNorm); L(155,87,170,87);
 T(10,8,"Data/ELV: 6 data outlets on Cat6 to a 6U rack beside DB-1 (separate containment). Roof units on 300 mm frames; isolators within sight of each unit.",tNorm);
 log.Append("SLD rows "+rows.Length+", riser drawn; total "+Math.Round(tot)+" VA");
 if(dry){t.RollBack(); log.Insert(0,"DRY: ");} else log.Insert(0,"BUILT "+t.Commit()+": ");
}catch(Exception ex){ if(t.GetStatus()==TransactionStatus.Started) t.RollBack(); return "FAILED "+ex.GetType().Name+": "+ex.Message+" | "+log; }
}
return log.ToString();
