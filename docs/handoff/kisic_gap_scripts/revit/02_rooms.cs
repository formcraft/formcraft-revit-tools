// KISIC step 02 – rooms. transactionMode "auto" (default). Checks areas against the recipe.
var L0=new FilteredElementCollector(document).OfClass(typeof(Level)).Cast<Level>().First(l=>l.Name=="L00 FFL");
var defs=new (string no,string name,double x,double y,double m2)[]{("01","X-ray",2.0,1.7,14.0),("02","Control",4.7,1.1,2.53),("03","Scan (Ultrasound)",7.0,1.2,7.92),("04","X-ray/Control Lobby",4.75,2.9,1.32),("05","Laboratory",2.0,5.2,12.43),("06","Waiting / Reception",7.0,4.6,20.2)};
var res=new List<string>();
foreach(var d in defs){
 var r=document.Create.NewRoom(L0,new UV(FmcScript.Mm(d.x*1000),FmcScript.Mm(-d.y*1000)));
 r.Number=d.no; r.Name=d.name; r.get_Parameter(BuiltInParameter.ROOM_UPPER_OFFSET).Set(FmcScript.Mm(3000)); document.Regenerate();
 double a=Math.Round(r.Area*0.092903,2); res.Add(d.no+" "+d.name+" "+a+" m2"+(Math.Abs(a-d.m2)>0.05?" ≠ "+d.m2+" CHECK":" ok"));}
return string.Join("; ",res);
